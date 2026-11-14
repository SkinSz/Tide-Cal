// Tide DC-09: Full-state synchronization — snapshot construction and
// transactional application, with the dominated-merge clock exchange of
// DC-06 §3.4 and the concurrent-edit rule (§7.1): local survives iff its
// causality is NOT dominated by snapshot_clock.

import type Database from "better-sqlite3";
import { merge, dominates } from "../sync/vector_clock.ts";
import type { VectorClock } from "../sync/change_record.ts";
import type { KnowledgeState } from "../sync/knowledge_state.ts";
import { revokedCutoffs } from "../security/revocation_store.ts";

export interface SnapshotEntry {
  entity_id: string;
  entity_type: "calendar" | "event" | "series" | "occurrence_override";
  /** serialized current state of the entity (opaque to this module) */
  data: string;
  /** producer identity of the latest contributing change */
  producer_device_id: string;
  producer_seq: number;
  causality_clock: VectorClock;
}

export interface Snapshot {
  snapshot_clock: VectorClock;
  /**
   * DC-08 Appendix B: the sender's applied frontier (applied_upto table,
   * never device_clock). Optional on the wire: older senders omit it.
   */
  applied_upto?: VectorClock;
  entities: SnapshotEntry[];
  /** non-compactable tombstones ride along (DC-09 §4.3) */
  tombstones: Array<{
    entity_id: string;
    entity_type: string;
    producer_device_id: string;
    seq: number;
    causality_clock: VectorClock;
    deleted_at_hlc: number;
  }>;
}

// ---------------------------------------------------------------------------
// Local DB helpers (defined here rather than imported from persistence/: the
// full-state module owns its own version-vector queries per DC-09 §7.1).
// ---------------------------------------------------------------------------

/**
 * Element-wise max of causality_clocks over every `changes` row recorded for
 * an entity — its true version vector (DC-02 §2; DC-09 §7.1 normative form).
 *
 * Pkg1 (QA C-1): the PRIMARY source is the durable `entity_versions` table
 * (schema v6), maintained transactionally at every change application. DC-06
 * compaction deletes change records; the version vector they represented
 * must survive independently (INV-1a.3 of pkg1-diagnosis.md). The change-log
 * derivation remains only as a fallback for entities never rewritten since
 * the v6 migration.
 */
function localVersionClock(
  db: Database.Database,
  entityId: string,
): VectorClock {
  const row = db
    .prepare<[string], { version: string }>(
      "SELECT version FROM entity_versions WHERE entity_id = ?",
    )
    .get(entityId);
  if (row) return JSON.parse(row.version) as VectorClock;
  const rows = db
    .prepare<[string], { causality_clock: string }>(
      "SELECT causality_clock FROM changes WHERE entity_id = ?",
    )
    .all(entityId);
  let v: VectorClock = {};
  for (const r of rows) {
    v = merge(v, JSON.parse(r.causality_clock) as VectorClock);
  }
  return v;
}

/** Producer identity of the latest contributing change for an entity. */
function latestProducer(
  db: Database.Database,
  entityId: string,
): { device_id: string; local_seq: number } | undefined {
  const row = db
    .prepare<[string], { latest_producer: string; latest_seq: number }>(
      "SELECT latest_producer, latest_seq FROM entity_versions WHERE entity_id = ?",
    )
    .get(entityId);
  if (row) return { device_id: row.latest_producer, local_seq: row.latest_seq };
  const change = db
    .prepare<[string], { device_id: string; local_seq: number }>(
      `SELECT device_id, local_seq FROM changes WHERE entity_id = ?
       ORDER BY hlc_timestamp DESC, local_seq DESC LIMIT 1`,
    )
    .get(entityId);
  return change;
}

/**
 * Pkg1: merge a snapshot entry's causality into the receiver's durable
 * version state for the entity (element-wise max — never regresses), so the
 * entity stays fully versioned even though snapshot application does not
 * produce change records. Without this, snapshot-received entities would
 * carry an empty version clock and be absence-tombstoned by the next
 * snapshot that omits them.
 */
function recordSnapshotEntityVersion(
  db: Database.Database,
  entityId: string,
  entityType: string,
  clock: VectorClock,
  producer: string,
  seq: number,
): void {
  const before = localVersionClock(db, entityId);
  const merged = merge(before, clock);
  const prev = db
    .prepare<[string], { latest_producer: string; latest_seq: number }>(
      "SELECT latest_producer, latest_seq FROM entity_versions WHERE entity_id = ?",
    )
    .get(entityId);
  // Keep the existing latest-producer identity unless the incoming entry
  // contributes a strictly newer seq from its own producer than the current
  // version vector records for that producer (latest identity is used for
  // snapshot-entry provenance and absence tombstone naming only).
  let out = prev ?? { latest_producer: producer, latest_seq: seq };
  if (
    prev === undefined ||
    (clock[producer] ?? 0) > (before[prev.latest_producer] ?? 0)
  ) {
    out = { latest_producer: producer, latest_seq: seq };
  }
  db.prepare(`
    INSERT INTO entity_versions (entity_id, entity_type, version, latest_producer, latest_seq, latest_hlc, updated_hlc)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(entity_id) DO UPDATE SET
      entity_type = excluded.entity_type,
      version = excluded.version,
      latest_producer = excluded.latest_producer,
      latest_seq = excluded.latest_seq,
      updated_hlc = excluded.updated_hlc`).run(
    entityId,
    entityType,
    JSON.stringify(merged),
    out.latest_producer,
    out.latest_seq,
    0,
    Date.now(),
  );
}

/** Pkg1: drop version state together with the entity row (absence path). */
function clearEntityVersion(db: Database.Database, entityId: string): void {
  db.prepare("DELETE FROM entity_versions WHERE entity_id = ?").run(entityId);
}

/**
 * Pkg5b (DC-03 §3.3 continuation / Pkg5-review P9 residual): does this
 * entity carry an UNRESOLVED conflict row (Pkg5's DC-07 conflicts table)?
 *
 * While a conflict is unresolved, DC-03 §3.3/§3.4/TR-2 ("local state is NOT
 * overwritten … the stored pre-conflict local value remains visible until
 * resolution") governs the materialized row value. DC-09 §7.1's domination
 * rule may still decide the anti-entropy EXCHANGE, but it must not silently
 * rewrite the row VALUE behind an unresolved conflict — that would be an
 * implicit winner selection (defeating the user-resolution contract) with
 * the conflict record left showing a row that reflects neither the local
 * nor a user-chosen value. Non-conflicted entities keep §7.1 unchanged.
 */
function hasUnresolvedConflict(
  db: Database.Database,
  entityId: string,
): boolean {
  return (
    db
      .prepare<[string], unknown>(
        `SELECT 1 FROM conflicts
         WHERE entity_id = ? AND status = 'unresolved' LIMIT 1`,
      )
      .get(entityId) !== undefined
  );
}

/**
 * Pkg1: replay idempotence check — does the local live row already equal the
 * snapshot entry's data byte-for-byte (canonical JSON comparison, so key
 * order can never cause a false difference)?
 */
function localRowMatchesEntry(
  db: Database.Database,
  entry: SnapshotEntry,
): boolean {
  const table =
    entry.entity_type === "event"
      ? "events"
      : entry.entity_type === "calendar"
        ? "calendars"
        : null; // series/occurrence_override snapshots not carried in v1
  if (table === null) return false;
  const idColumn = entry.entity_type === "event" ? "event_id" : "calendar_id";
  const row = db
    .prepare<[string], Record<string, unknown>>(
      `SELECT * FROM ${table} WHERE ${idColumn} = ?`,
    )
    .get(entry.entity_id);
  if (row === undefined) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(entry.data);
  } catch {
    return false;
  }
  // Calendars: ignore the bootstrap bookkeeping columns. Each device
  // bootstraps the default calendar independently (QA-2 F-1, Pkg6 will fix
  // the root), so created_hlc/updated_hlc legitimately differ between peers
  // while the semantic fields (title/color) are identical; staging would
  // write identical semantics — treat it as the no-op it is.
  if (entry.entity_type === "calendar") {
    const a = row as Record<string, unknown>;
    const b = parsed as Record<string, unknown>;
    return a["title"] === b["title"] && a["color"] === b["color"];
  }
  return canonicalJson(row) === canonicalJson(parsed);
}

/** Deterministic JSON: object keys sorted recursively. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

// ---------------------------------------------------------------------------
// Construction (sender side). Streams via callback under DC-08 §6.3 bounds.
// ---------------------------------------------------------------------------

export function buildSnapshot(
  db: Database.Database,
  emit: (snapshot: Snapshot) => void,
  batchSize = 256,
): void {
  const clockRows = db
    .prepare<[], { peer_device_id: string; max_seq: number }>(
      "SELECT peer_device_id, max_seq FROM device_clock",
    )
    .all();
  const snapshot_clock: VectorClock = {};
  for (const r of clockRows) snapshot_clock[r.peer_device_id] = r.max_seq;
  // DC-08 Appendix B: declare the applied frontier, captured with the clock.
  const applied_upto = readAppliedUpto(db);

  const events = db
    .prepare<[], { event_id: string }>(
      "SELECT * FROM events ORDER BY event_id ASC",
    )
    .all();

  // Calendars are semantic state too (DC-09 §4): a receiver whose
  // applied_upto advances past a peer's calendar bootstrap record must be able
  // to materialize it, else later incremental pulls classify as duplicate and
  // the row can never land.
  const calendars = db
    .prepare<[], Record<string, unknown>>(
      "SELECT * FROM calendars ORDER BY calendar_id ASC",
    )
    .all();

  const buffer: SnapshotEntry[] = [];
  const flush = () => {
    if (buffer.length === 0) return;
    emit({ snapshot_clock, applied_upto, entities: [...buffer], tombstones: [] });
    buffer.length = 0;
  };

  for (const c of calendars) {
    const entityId = String(c.calendar_id);
    const version = localVersionClock(db, entityId);
    const winner = latestProducer(db, entityId);
    // Pkg6 (pkg1-review H1 residual): over-inclusive like the events loop.
    // A calendar row with no version state (e.g. created before the v6
    // entity_versions migration, or version state lost) must still ride the
    // snapshot with an _unversioned placeholder — `continue`-ing here let a
    // migrated-after-compaction DB strand a fresh peer without its calendar,
    // and the receiver could then never materialize it incrementally
    // (later pulls classify as duplicate once applied_upto advances).
    // Over-inclusion is benign (the receiver's §7.1 rule reconciles);
    // under-inclusion silently strands data.
    buffer.push({
      entity_id: entityId,
      entity_type: "calendar",
      data: JSON.stringify(c),
      producer_device_id: winner?.device_id ?? "_unversioned",
      producer_seq: winner?.local_seq ?? 0,
      causality_clock: version,
    });
    if (buffer.length >= batchSize) flush();
  }

  for (const e of events) {
    const entityId = e.event_id;
    // DC-09 §4.2: each entry carries the real version vector of the entity
    // (element-wise max across its change history) plus the producer identity
    // of the latest contributing record, so the receiver can apply §7.1.
    // Pkg1 (QA C-1): versions come from durable entity_versions, so this is
    // exact EVEN AFTER compaction deleted the change history. A live row is
    // NEVER omitted: omission is what let the absence rule destroy live
    // events downstream (over-inclusion is benign — the receiver's §7.1
    // rule reconciles; under-inclusion silently strands data).
    const version = localVersionClock(db, entityId);
    const winner = latestProducer(db, entityId);
    buffer.push({
      entity_id: entityId,
      entity_type: "event",
      data: JSON.stringify(e),
      producer_device_id: winner?.device_id ?? "_unversioned",
      producer_seq: winner?.local_seq ?? 0,
      causality_clock: version,
    });
    if (buffer.length >= batchSize) flush();
  }

  // Non-compactable tombstones ride along: here we include ALL retained ones
  // (conservative superset — including compactable ones is harmless per DC-09 §4.3).
  const tombs = db
    .prepare<
      [],
      {
        entity_id: string;
        entity_type: string;
        producer_device_id: string;
        seq: number;
        causality_clock: string;
        deleted_at_hlc: number;
      }
    >("SELECT entity_id, entity_type, producer_device_id, seq, causality_clock, deleted_at_hlc FROM entities_tombstones")
    .all();
  if (tombs.length > 0) {
    emit({
      snapshot_clock,
      applied_upto,
      entities: [],
      tombstones: tombs.map((t) => ({
        ...t,
        causality_clock: JSON.parse(t.causality_clock) as VectorClock,
      })),
    });
  }
  flush();
}

/** This device's applied frontier per producer (the applied_upto table). */
export function readAppliedUpto(db: Database.Database): VectorClock {
  const rows = db
    .prepare<[], { d: string; a: number }>(
      "SELECT producer_device_id AS d, applied_through AS a FROM applied_upto",
    )
    .all();
  const out: VectorClock = {};
  for (const r of rows) out[r.d] = r.a;
  return out;
}

/**
 * DC-27 Appendix B / DC-09 Appendix A: the revocation cutoffs this device
 * holds. A database without the revocation_records table cannot hold a
 * record, so it holds no cutoff.
 */
export function heldCutoffs(db: Database.Database): Map<string, number> {
  const hasTable = db
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'revocation_records'",
    )
    .get();
  return hasTable === undefined ? new Map() : revokedCutoffs(db);
}

/**
 * DC-09 Appendix A.2: true when a receiver holding `cutoffs` must decline a
 * full-state offer or snapshot with this declared applied frontier. Fails
 * closed: a missing or malformed declaration is refused; a producer missing
 * from the declaration counts as 0 (DC-02 §2.4 comparison, §5 applied_upto).
 */
export function refusesDeclaredFrontier(
  declared: unknown,
  cutoffs: Map<string, number>,
): boolean {
  if (cutoffs.size === 0) return false;
  if (typeof declared !== "object" || declared === null || Array.isArray(declared)) {
    return true;
  }
  for (const [producer, cutoff] of cutoffs) {
    if (!Object.prototype.hasOwnProperty.call(declared, producer)) continue;
    const v = (declared as Record<string, unknown>)[producer];
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0) return true;
    if (v > cutoff) return true;
  }
  return false;
}

/**
 * DC-09 Appendix A.3: the sender's declared applied frontier for one
 * producer; a producer missing from the declaration counts as 0. Only
 * called after refusesDeclaredFrontier() accepted the declaration.
 */
function declaredFrontier(declared: VectorClock | undefined, producer: string): number {
  if (declared === undefined) return 0;
  if (!Object.prototype.hasOwnProperty.call(declared, producer)) return 0;
  return declared[producer] ?? 0;
}

// ---------------------------------------------------------------------------
// Application (receiver side). Staged-then-committed atomically.
// ---------------------------------------------------------------------------

export interface ApplyResult {
  appliedEntities: number;
  inheritedTombstones: number;
  survivedLocal: number;
  /** live local events deleted-by-omission under the §7.1 absence rule */
  absenceTombstones: number;
  /**
   * Pkg5b: snapshot entries whose local row holds an UNRESOLVED conflict —
   * the materialized local value was kept (DC-03 §3.3) instead of being
   * replaced by the §7.1 domination winner. Resolution lifts the guard.
   */
  conflictPreserved: number;
  /**
   * DC-09 Appendix A.2: the snapshot was declined as a whole (nothing
   * written) because its declared applied frontier is missing, malformed
   * or above a held revocation cutoff.
   */
  declined: boolean;
}

/**
 * DC-09 §5.1 / §7.2 / TR-7 (TD-047): the FULL_STATE_SNAPSHOT messages of
 * one stream are ONE snapshot. Each message is checked (DC-09 Appendix A.2)
 * and staged in connection-scoped TEMP tables (DC-08 §6.3: SQLite is the
 * only staging area; memory holds one message at a time). Nothing reaches
 * the live tables until commit(), which applies the union of all staged
 * messages in one transaction: entity merges, the absence rule over the
 * whole stream, inherited tombstones, applied_upto/device_clock and the
 * pending/skipped clean-up. A stream that is never committed (no `final`,
 * session end, process death) writes nothing; discard() drops its rows and
 * TEMP tables die with the connection.
 */
export type StageOutcome =
  /** staged; more messages or commit() may follow */
  | "staged"
  /** DC-09 Appendix A.2: declined; the stream was discarded */
  | "declined"
  /**
   * The message disagrees with the stream's first message on snapshot_clock
   * (DC-09 §4.4, TR-11) or applied_upto (DC-08 Appendix B.1); the stream
   * was discarded (DC-09 §5.1: abort cleanly, nothing written).
   */
  | "malformed";

/** Rows read per page while committing (DC-08 §6.1 batch limit). */
const COMMIT_PAGE = 256;
let nextStreamId = 1;

export class SnapshotStream {
  private readonly id = nextStreamId++;
  private head:
    | { clockKey: string; declaredKey: string; snapshot_clock: VectorClock; applied_upto?: VectorClock }
    | undefined;

  constructor(private readonly db: Database.Database) {
    db.exec(`
      CREATE TEMP TABLE IF NOT EXISTS snapshot_stream_entities (
        stream_id INTEGER NOT NULL, entity_id TEXT NOT NULL,
        entity_type TEXT NOT NULL, data TEXT NOT NULL,
        producer_device_id TEXT NOT NULL, producer_seq INTEGER NOT NULL,
        causality_clock TEXT NOT NULL,
        PRIMARY KEY (stream_id, entity_id));
      CREATE TEMP TABLE IF NOT EXISTS snapshot_stream_tombstones (
        stream_id INTEGER NOT NULL, entity_id TEXT NOT NULL,
        entity_type TEXT NOT NULL, producer_device_id TEXT NOT NULL,
        seq INTEGER NOT NULL, causality_clock TEXT NOT NULL,
        deleted_at_hlc INTEGER NOT NULL,
        PRIMARY KEY (stream_id, entity_id, producer_device_id, seq))`);
  }

  /** Check and stage one message of the stream. */
  add(snapshot: Snapshot): StageOutcome {
    // DC-09 Appendix A.2: judged per message with the cutoffs held now.
    if (refusesDeclaredFrontier(snapshot.applied_upto, heldCutoffs(this.db))) {
      this.discard();
      return "declined";
    }
    const clockKey = canonicalJson(snapshot.snapshot_clock);
    const declaredKey =
      snapshot.applied_upto === undefined ? "" : canonicalJson(snapshot.applied_upto);
    if (this.head === undefined) {
      this.head = {
        clockKey,
        declaredKey,
        snapshot_clock: snapshot.snapshot_clock,
        applied_upto: snapshot.applied_upto,
      };
    } else if (this.head.clockKey !== clockKey || this.head.declaredKey !== declaredKey) {
      this.discard();
      return "malformed";
    }
    const putEntity = this.db.prepare(`
      INSERT INTO temp.snapshot_stream_entities (stream_id, entity_id, entity_type,
        data, producer_device_id, producer_seq, causality_clock)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(stream_id, entity_id) DO UPDATE SET
        entity_type = excluded.entity_type, data = excluded.data,
        producer_device_id = excluded.producer_device_id,
        producer_seq = excluded.producer_seq,
        causality_clock = excluded.causality_clock`);
    const putTombstone = this.db.prepare(`
      INSERT INTO temp.snapshot_stream_tombstones (stream_id, entity_id, entity_type,
        producer_device_id, seq, causality_clock, deleted_at_hlc)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(stream_id, entity_id, producer_device_id, seq) DO NOTHING`);
    this.db.transaction(() => {
      for (const e of snapshot.entities) {
        putEntity.run(
          this.id, e.entity_id, e.entity_type, e.data,
          e.producer_device_id, e.producer_seq, JSON.stringify(e.causality_clock),
        );
      }
      for (const t of snapshot.tombstones) {
        putTombstone.run(
          this.id, t.entity_id, t.entity_type, t.producer_device_id, t.seq,
          JSON.stringify(t.causality_clock), t.deleted_at_hlc,
        );
      }
    })();
    return "staged";
  }

  /** Drop this stream's staged rows (never touches live tables). */
  discard(): void {
    this.db
      .prepare("DELETE FROM temp.snapshot_stream_entities WHERE stream_id = ?")
      .run(this.id);
    this.db
      .prepare("DELETE FROM temp.snapshot_stream_tombstones WHERE stream_id = ?")
      .run(this.id);
  }

  /** Apply the whole staged stream as one unit (DC-09 §5.1), then discard it. */
  commit(knowledge: KnowledgeState): ApplyResult {
    try {
      return this.commitStaged(knowledge);
    } finally {
      this.head = undefined;
      this.discard();
    }
  }

  /** Staged entity rows in pages (keyset on rowid; bounded memory). */
  private *stagedEntities(): Generator<SnapshotEntry> {
    const page = this.db.prepare<
      [number, number, number],
      {
        rowid: number; entity_id: string; entity_type: SnapshotEntry["entity_type"]; data: string;
        producer_device_id: string; producer_seq: number; causality_clock: string;
      }
    >(`SELECT rowid, entity_id, entity_type, data, producer_device_id, producer_seq,
         causality_clock FROM temp.snapshot_stream_entities
       WHERE stream_id = ? AND rowid > ? ORDER BY rowid LIMIT ?`);
    let after = 0;
    for (;;) {
      const rows = page.all(this.id, after, COMMIT_PAGE);
      if (rows.length === 0) return;
      for (const r of rows) {
        yield {
          entity_id: r.entity_id,
          entity_type: r.entity_type,
          data: r.data,
          producer_device_id: r.producer_device_id,
          producer_seq: r.producer_seq,
          causality_clock: JSON.parse(r.causality_clock) as VectorClock,
        };
      }
      after = rows[rows.length - 1]!.rowid;
    }
  }

  private commitStaged(knowledge: KnowledgeState): ApplyResult {
    const db = this.db;
    const result: ApplyResult = {
      appliedEntities: 0,
      inheritedTombstones: 0,
      survivedLocal: 0,
      absenceTombstones: 0,
      conflictPreserved: 0,
      declined: false,
    };
    const head = this.head;
    if (head === undefined) return result; // nothing was staged
    const snapshotClock = head.snapshot_clock;

    const insertTombstone = db.prepare(`
      INSERT INTO entities_tombstones (entity_id, entity_type, producer_device_id, seq, causality_clock, deleted_at_hlc)
      VALUES (@entity_id, @entity_type, @producer_device_id, @seq, @causality_clock, @deleted_at_hlc)
      ON CONFLICT(entity_id, producer_device_id, seq) DO NOTHING`);

    const deleteEvent = db.prepare("DELETE FROM events WHERE event_id = ?");
    /** In-memory knowledge mirrors the durable advance only after COMMIT. */
    const advances: Array<[string, number]> = [];

    // Stage in a temp table, then commit atomically (DC-07 T-boundary style).
    const tx = db.transaction(() => {
      // DC-09 Appendix A.3 with the cutoffs held at commit time: a cutoff
      // that arrived after earlier messages were staged clamps the whole
      // stream. (A.2 needs no second check here: add() judged the `final`
      // message against these same cutoffs just before commit(), and every
      // message carries the same declaration.)
      const cutoffs = heldCutoffs(db);

      db.exec(`
        CREATE TEMP TABLE IF NOT EXISTS stage_entities (
          entity_id TEXT PRIMARY KEY, entity_type TEXT, data TEXT)`);

      // Concurrent-edit rule (DC-09 §7.1, normative form): an entity's local
      // state survives the snapshot iff its version vector is NOT dominated by
      // snapshot_clock; otherwise the snapshot replaces it.
      for (const entry of this.stagedEntities()) {
        const localVersion = localVersionClock(db, entry.entity_id);
        if (!dominates(snapshotClock, localVersion)) {
          result.survivedLocal++;
          continue; // local survives; next anti-entropy round reconciles
        }
        // Pkg5b (DC-03 §3.3 continuation, Pkg5-review P9): the local value of
        // an entity with an UNRESOLVED conflict row is NOT replaced by the
        // §7.1 domination winner — it stays until explicit user resolution.
        // Skipping the entry entirely also keeps the local entity version
        // anchored to local history; the conflict row itself is untouched
        // (full_state never reads or writes conflicts/…_participants rows).
        if (hasUnresolvedConflict(db, entry.entity_id)) {
          result.conflictPreserved++;
          continue;
        }
        // Pkg1: replay idempotence — if the entry's data is already identical
        // locally, staging + upsert would write identical bytes (a literal
        // no-op); skip it. This also keeps the local entity version anchored
        // to the locally-applied change history (the DC-02 normative form)
        // instead of absorbing the sender's view of causality.
        if (localRowMatchesEntry(db, entry)) {
          continue;
        }
        db.prepare(
          `INSERT INTO temp.stage_entities (entity_id, entity_type, data) VALUES (?, ?, ?)
           ON CONFLICT(entity_id) DO UPDATE SET data = excluded.data`,
        ).run(entry.entity_id, entry.entity_type, entry.data);
        // Pkg1 (QA C-1): snapshot application produces no change records, so
        // record the entry's causality in the receiver's durable version state
        // (merge — element-wise max, never regresses). Without this the
        // received entity would carry an empty version clock and be
        // absence-tombstoned by the next snapshot that omits it.
        recordSnapshotEntityVersion(
          db,
          entry.entity_id,
          entry.entity_type,
          entry.causality_clock,
          entry.producer_device_id,
          entry.producer_seq,
        );
        result.appliedEntities++;
      }

      // Materialize staged rows: calendars first, then events, in pages.
      const stagedPage = db.prepare<
        [string, number, number],
        { rowid: number; data: string }
      >(`SELECT rowid, data FROM temp.stage_entities
         WHERE entity_type = ? AND rowid > ? ORDER BY rowid LIMIT ?`);
      const eachStaged = (type: string, apply: (data: string) => void): void => {
        let after = 0;
        for (;;) {
          const rows = stagedPage.all(type, after, COMMIT_PAGE);
          if (rows.length === 0) return;
          for (const r of rows) apply(r.data);
          after = rows[rows.length - 1]!.rowid;
        }
      };
      const upsertEvent = db.prepare(`
        INSERT INTO events (event_id, calendar_id, title, description, all_day,
          start_date, end_date, start_wall, end_wall, tz_id, utc_start_ms,
          utc_end_ms, created_hlc, updated_hlc)
        VALUES (@event_id, @calendar_id, @title, @description, @all_day,
          @start_date, @end_date, @start_wall, @end_wall, @tz_id, @utc_start_ms,
          @utc_end_ms, @created_hlc, @updated_hlc)
        ON CONFLICT(event_id) DO UPDATE SET
          title=excluded.title, description=excluded.description,
          all_day=excluded.all_day, start_date=excluded.start_date,
          end_date=excluded.end_date, start_wall=excluded.start_wall,
          end_wall=excluded.end_wall, tz_id=excluded.tz_id,
          utc_start_ms=excluded.utc_start_ms, utc_end_ms=excluded.utc_end_ms,
          updated_hlc=excluded.updated_hlc`);

      const upsertCalendar = db.prepare(`
        INSERT INTO calendars (calendar_id, title, color, created_hlc, updated_hlc)
        VALUES (@calendar_id, @title, @color, @created_hlc, @updated_hlc)
        ON CONFLICT(calendar_id) DO UPDATE SET
          title=excluded.title, color=excluded.color,
          updated_hlc=MAX(calendars.updated_hlc, excluded.updated_hlc)`);

      eachStaged("calendar", (raw) => {
        const data = JSON.parse(raw) as {
          calendar_id: string; title: string | null;
          color: string | null; created_hlc: number; updated_hlc: number;
        };
        upsertCalendar.run({
          calendar_id: data.calendar_id,
          title: data.title ?? "",
          color: data.color ?? null,
          created_hlc: data.created_hlc ?? 0,
          updated_hlc: data.updated_hlc ?? 0,
        });
      });
      eachStaged("event", (raw) => {
        upsertEvent.run(JSON.parse(raw));
      });
      db.exec("DELETE FROM temp.stage_entities");

      // Absence handling (deletion by omission, DC-09 §5.2 / §7.1): a live
      // local entity ABSENT from the snapshot is tombstoned only if its local
      // version is dominated by snapshot_clock. Runs after materializing the
      // staged entities, over local events absent from EVERY message of the
      // stream (TD-047: never from one message alone).
      const absentEvents = db
        .prepare<[number], { event_id: string }>(
          `SELECT event_id FROM events WHERE event_id NOT IN (
             SELECT entity_id FROM temp.snapshot_stream_entities WHERE stream_id = ?)`,
        )
        .all(this.id);
      for (const le of absentEvents) {
        // Pkg5b (DC-03 §3.3 continuation): same guard as the replacement path —
        // an entity with an unresolved conflict must not have its materialized
        // state (here: the live row itself) destroyed by snapshot inference
        // while the user has not yet resolved. Deleting via the absence rule
        // would be the same silent winner selection this package fixes.
        if (hasUnresolvedConflict(db, le.event_id)) {
          result.conflictPreserved++;
          continue;
        }
        const localVersion = localVersionClock(db, le.event_id);
        if (!dominates(snapshotClock, localVersion)) continue;
        // Pkg1 (QA C-1): an EMPTY local version proves nothing. dominates()
        // over an empty clock is vacuously true for ANY snapshot_clock — it is
        // a missing version state, not a dominated state (INV-1b of
        // pkg1-diagnosis.md). Without real version state we cannot run the
        // absence inference; keep the live row (DC-06's own principle: never
        // fabricate knowledge). Legitimate deletions always leave real version
        // evidence (entity_versions >= creation clock + sender's advanced
        // frontier), so this guard does not weaken deletion propagation.
        if (Object.keys(localVersion).length === 0) continue;
        const winner = latestProducer(db, le.event_id);
        insertTombstone.run({
          entity_id: le.event_id,
          entity_type: "event",
          producer_device_id: winner?.device_id ?? "_absence",
          seq: winner?.local_seq ?? 0,
          causality_clock: JSON.stringify(merge(localVersion, snapshotClock)),
          deleted_at_hlc: Date.now(),
        });
        deleteEvent.run(le.event_id);
        // Pkg1: the entity is gone — drop its version state with it so no
        // stale clock outlives the row.
        clearEntityVersion(db, le.event_id);
        result.absenceTombstones++;
      }

      // Inherit tombstones (every message of the stream)
      const tombPage = db.prepare<
        [number, number, number],
        {
          rowid: number; entity_id: string; entity_type: string; producer_device_id: string;
          seq: number; causality_clock: string; deleted_at_hlc: number;
        }
      >(`SELECT rowid, entity_id, entity_type, producer_device_id, seq, causality_clock,
           deleted_at_hlc FROM temp.snapshot_stream_tombstones
         WHERE stream_id = ? AND rowid > ? ORDER BY rowid LIMIT ?`);
      for (let after = 0; ; ) {
        const rows = tombPage.all(this.id, after, COMMIT_PAGE);
        if (rows.length === 0) break;
        for (const { rowid: _rowid, ...t } of rows) {
          insertTombstone.run(t);
          result.inheritedTombstones++;
        }
        after = rows[rows.length - 1]!.rowid;
      }

      // DC-06 §3.4 step 2: applied_upto := dominated merge with snapshot_clock
      for (const [d, raw] of Object.entries(snapshotClock)) {
        // DC-09 Appendix A.3: never raise applied_upto above a held cutoff
        // from a snapshot (snapshot_clock may cite causal context only), nor
        // above the sender's declared frontier for that producer (absent
        // counts as 0): seqs the sender never applied stay pullable.
        const cutoff = cutoffs.get(d);
        const s =
          cutoff === undefined
            ? raw
            : Math.min(raw, cutoff, declaredFrontier(head.applied_upto, d));
        const current =
          (
            db
              .prepare("SELECT applied_through FROM applied_upto WHERE producer_device_id = ?")
              .get(d) as { applied_through: number } | undefined
          )?.applied_through ?? 0;
        db.prepare(`
          INSERT INTO applied_upto (producer_device_id, applied_through) VALUES (?, ?)
          ON CONFLICT(producer_device_id) DO UPDATE SET applied_through = excluded.applied_through`).run(
          d,
          Math.max(current, s),
        );
        // F3 fix: the snapshot frontier covers seqs <= s; any DURABLE pending
        // rows at or below it are zombies (in-memory pending was already
        // dropped by advanceAppliedIfContiguous — delete their persisted twins
        // so they neither leak into post-restart knowledge nor re-drain).
        db.prepare(
          "DELETE FROM pending_changes WHERE device_id = ? AND local_seq <= ?",
        ).run(d, Math.max(current, s));
        // TD-001 (8): a snapshot frontier legitimately jumps past skipped seqs
        // (snapshot replaces incremental reconstruction). GC skip rows <= the
        // new frontier; quarantine diagnostic rows survive (DC-08 §3.6).
        db.prepare(
          "DELETE FROM skipped_seqs WHERE producer_device_id = ? AND local_seq <= ?",
        ).run(d, Math.max(current, s));
        // Mirrored into in-memory knowledge after COMMIT (DC-06 §3.4). The
        // Math.max write above is the single durable persistence point —
        // never overwritten by raw `s`, so applied_upto is monotone.
        advances.push([d, s]);
      }

      // Merge device_clock too so next HELLO advertises correctly.
      // Element-wise MAX (H-1): never regress a component we already have.
      for (const [d, s] of Object.entries(snapshotClock)) {
        db.prepare(`
          INSERT INTO device_clock (peer_device_id, max_seq) VALUES (?, ?)
          ON CONFLICT(peer_device_id) DO UPDATE SET max_seq = MAX(max_seq, excluded.max_seq)`).run(d, s);
      }
    });

    tx();
    for (const [d, s] of advances) advanceAppliedIfContiguous(knowledge, d, s);
    return result;
  }
}

/** Apply one complete snapshot (a one-message stream). */
export function applySnapshot(
  db: Database.Database,
  snapshot: Snapshot,
  knowledge: KnowledgeState,
): ApplyResult {
  const stream = new SnapshotStream(db);
  if (stream.add(snapshot) !== "staged") {
    return {
      appliedEntities: 0,
      inheritedTombstones: 0,
      survivedLocal: 0,
      absenceTombstones: 0,
      conflictPreserved: 0,
      declined: true,
    };
  }
  return stream.commit(knowledge);
}

function advanceAppliedIfContiguous(
  k: KnowledgeState,
  deviceId: string,
  target: number,
): void {
  const current = k.appliedUpto[deviceId] ?? 0;
  if (target > current) {
    k.appliedUpto[deviceId] = target;
    const pend = k.pending.get(deviceId);
    if (pend) {
      for (const s of [...pend]) {
        if (s <= target) pend.delete(s);
      }
      if (pend.size === 0) k.pending.delete(deviceId);
    }
    // TD-001 (8): in-memory skipped mirror mirrors the durable GC.
    if (k.skipped?.has(deviceId)) {
      const set = k.skipped.get(deviceId)!;
      for (const s of [...set]) {
        if (s <= target) set.delete(s);
      }
      if (set.size === 0) k.skipped.delete(deviceId);
    }
  }
}
