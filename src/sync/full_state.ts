// Tide DC-09: Full-state synchronization — snapshot construction and
// transactional application, with the dominated-merge clock exchange of
// DC-06 §3.4 and the concurrent-edit rule (§7.1): local survives iff its
// causality is NOT dominated by snapshot_clock.

import type Database from "better-sqlite3";
import { merge, dominates } from "../sync/vector_clock.ts";
import type { VectorClock } from "../sync/change_record.ts";
import type { KnowledgeState } from "../sync/knowledge_state.ts";

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
    emit({ snapshot_clock, entities: [...buffer], tombstones: [] });
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
      entities: [],
      tombstones: tombs.map((t) => ({
        ...t,
        causality_clock: JSON.parse(t.causality_clock) as VectorClock,
      })),
    });
  }
  flush();
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
}

export function applySnapshot(
  db: Database.Database,
  snapshot: Snapshot,
  knowledge: KnowledgeState,
): ApplyResult {
  const result: ApplyResult = {
    appliedEntities: 0,
    inheritedTombstones: 0,
    survivedLocal: 0,
    absenceTombstones: 0,
    conflictPreserved: 0,
  };

  const insertTombstone = db.prepare(`
    INSERT INTO entities_tombstones (entity_id, entity_type, producer_device_id, seq, causality_clock, deleted_at_hlc)
    VALUES (@entity_id, @entity_type, @producer_device_id, @seq, @causality_clock, @deleted_at_hlc)
    ON CONFLICT(entity_id, producer_device_id, seq) DO NOTHING`);

  const deleteEvent = db.prepare("DELETE FROM events WHERE event_id = ?");

  // Stage in a temp table, then commit atomically (DC-07 T-boundary style).
  const tx = db.transaction(() => {
    db.exec(`
      CREATE TEMP TABLE IF NOT EXISTS stage_entities (
        entity_id TEXT PRIMARY KEY, entity_type TEXT, data TEXT)`);

    // Concurrent-edit rule (DC-09 §7.1, normative form): an entity's local
    // state survives the snapshot iff its version vector is NOT dominated by
    // snapshot_clock; otherwise the snapshot replaces it.
    for (const entry of snapshot.entities) {
      const localVersion = localVersionClock(db, entry.entity_id);
      if (!dominates(snapshot.snapshot_clock, localVersion)) {
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

    // Materialize staged event rows
    const staged = db
      .prepare<[], { entity_id: string; entity_type: string; data: string }>(
        "SELECT entity_id, entity_type, data FROM stage_entities",
      )
      .all();
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

    for (const s of staged) {
      if (s.entity_type === "calendar") {
        const data = JSON.parse(s.data) as {
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
      }
    }
    for (const s of staged) {
      if (s.entity_type === "event") {
        const data = JSON.parse(s.data);
        upsertEvent.run(data);
      }
    }
    db.exec("DELETE FROM temp.stage_entities");

    // Absence handling (deletion by omission, DC-09 §5.2 / §7.1): a live
    // local entity ABSENT from the snapshot is tombstoned only if its local
    // version is dominated by snapshot_clock. Runs after materializing the
    // staged entities, over local events not present in the snapshot.
    const snapshotIds = new Set(snapshot.entities.map((e) => e.entity_id));
    const localEvents = db
      .prepare<[], { event_id: string }>("SELECT event_id FROM events")
      .all();
    for (const le of localEvents) {
      if (snapshotIds.has(le.event_id)) continue;
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
      if (!dominates(snapshot.snapshot_clock, localVersion)) continue;
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
        causality_clock: JSON.stringify(
          merge(localVersion, snapshot.snapshot_clock),
        ),
        deleted_at_hlc: Date.now(),
      });
      deleteEvent.run(le.event_id);
      // Pkg1: the entity is gone — drop its version state with it so no
      // stale clock outlives the row.
      clearEntityVersion(db, le.event_id);
      result.absenceTombstones++;
    }

    // Inherit tombstones
    for (const t of snapshot.tombstones) {
      insertTombstone.run({
        ...t,
        causality_clock: JSON.stringify(t.causality_clock),
      });
      result.inheritedTombstones++;
    }

    // DC-06 §3.4 step 2: applied_upto := dominated merge with snapshot_clock
    for (const [d, s] of Object.entries(snapshot.snapshot_clock)) {
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
      // Mirror the durable advance into in-memory knowledge (DC-06 §3.4).
      // The Math.max write above is the single durable persistence point —
      // never overwritten by raw `s`, so applied_upto is monotone.
      advanceAppliedIfContiguous(knowledge, d, s);
    }

    // Merge device_clock too so next HELLO advertises correctly.
    // Element-wise MAX (H-1): never regress a component we already have.
    for (const [d, s] of Object.entries(snapshot.snapshot_clock)) {
      db.prepare(`
        INSERT INTO device_clock (peer_device_id, max_seq) VALUES (?, ?)
        ON CONFLICT(peer_device_id) DO UPDATE SET max_seq = MAX(max_seq, excluded.max_seq)`).run(d, s);
    }
  });

  tx();
  return result;
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
