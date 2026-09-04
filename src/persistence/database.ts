// Tide persistence: database open + DC-07 transactional operations T1/T2.

import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { DDL, SCHEMA_VERSION } from "./schema.ts";
import {
  changeId,
  type ChangeRecord,
  type VectorClock,
} from "../sync/change_record.ts";
import { detect } from "../sync/conflict_detection.ts";
import {
  classifyArrival,
  advanceApplied,
  emptyKnowledge,
  type KnowledgeState,
} from "../sync/knowledge_state.ts";

export interface OpenOptions {
  path: string;
  /** SQLCipher key when an encrypted build is available (see report note). */
  encryptionKey?: string;
}

export function openDatabase(opts: OpenOptions): Database.Database {
  const db = new Database(opts.path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  // NOTE (encryption-at-rest, DC-07 owner decision): SQLCipher requires a
  // custom better-sqlite3 build. Dev phase runs plaintext; production build
  // MUST wire opts.encryptionKey into the pragma before shipping.
  initializeSchema(db);
  return db;
}

function initializeSchema(db: Database.Database): void {
  let row: { version: number } | undefined;
  try {
    row = db
      .prepare<[], { version: number }>("SELECT version FROM schema_version")
      .get();
  } catch {
    // Fresh database: table does not exist yet -> initialize below.
    row = undefined;
  }
  if (row === undefined) {
    const tx = db.transaction(() => {
      db.exec(DDL);
      db.prepare(
        "INSERT INTO schema_version (version, applied_at_hlc) VALUES (?, ?)",
      ).run(SCHEMA_VERSION, Date.now());
    });
    tx();
  } else if (row.version > SCHEMA_VERSION) {
    throw new Error(
      `database schema_version ${row.version} newer than supported ${SCHEMA_VERSION}`,
    );
  } else if (row.version === SCHEMA_VERSION) {
    // Repair path (smoke round 5): the v7 migration shipped BEFORE the
    // reminder/all-day columns were added to it, so some DBs are stamped v7
    // but lack the columns. Re-run the v7 column-adds (guarded, idempotent)
    // when they are missing. A v8 stamp would not fix DBs already at 7.
    const remCols = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='reminders'")
      .get() !== undefined
      ? (db.prepare("PRAGMA table_info(reminders)").all() as Array<{ name: string }>).map((c) => c.name)
      : [];
    if (remCols.length > 0 && !remCols.includes("enabled")) {
      const tx = db.transaction(() => {
        db.exec("ALTER TABLE reminders ADD COLUMN enabled INTEGER CHECK (enabled IN (0, 1))");
      });
      tx();
    }
    const evCols = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='events'")
      .get() !== undefined
      ? (db.prepare("PRAGMA table_info(events)").all() as Array<{ name: string }>).map((c) => c.name)
      : [];
    if (evCols.length > 0 && !evCols.includes("all_day_reminder_time")) {
      const tx = db.transaction(() => {
        db.exec("ALTER TABLE events ADD COLUMN all_day_reminder_time TEXT");
      });
      tx();
    }
  } else if (row.version < SCHEMA_VERSION) {
    // Forward migrations (run oldest-first, inside one transaction).
    const tx = db.transaction(() => {
      if (row!.version < 2) {
        // TD-001: skipped_seqs (quarantine-and-skip progress resolution).
        db.exec(`CREATE TABLE IF NOT EXISTS skipped_seqs (
          producer_device_id TEXT NOT NULL,
          local_seq          INTEGER NOT NULL CHECK (local_seq > 0),
          PRIMARY KEY (producer_device_id, local_seq))`);
      }
      if (row!.version < 3) {
        // TD-005: quarantine lifecycle — durable resolved/active distinction.
        // NULL columns = row still active. Rows are NEVER deleted. Column
        // guards keep this safe if a sibling v3 migration already applied
        // overlapping changes (collision coordination).
        const cols = (
          db.prepare("PRAGMA table_info(quarantine)").all() as Array<
            { name: string }
          >
        ).map((c) => c.name);
        if (!cols.includes("resolved_at_hlc")) {
          db.exec("ALTER TABLE quarantine ADD COLUMN resolved_at_hlc INTEGER");
        }
        if (!cols.includes("resolved_reason")) {
          db.exec("ALTER TABLE quarantine ADD COLUMN resolved_reason TEXT");
        }
      }
      if (row!.version < 4) {
        // TD-006 / DC-16: Tier-2 durable hard_blocks + §2.3 durable tally.
        // CREATE TABLE IF NOT EXISTS keeps this safe if a sibling migration
        // already created the tables (collision coordination).
        db.exec(`CREATE TABLE IF NOT EXISTS hard_blocks (
          producer_device_id TEXT PRIMARY KEY,
          first_triggered_at INTEGER NOT NULL,
          last_triggered_at  INTEGER NOT NULL,
          trigger_count      INTEGER NOT NULL CHECK (trigger_count > 0))`);
        db.exec(`CREATE TABLE IF NOT EXISTS peer_invalid_tally (
          producer_device_id TEXT PRIMARY KEY,
          total_invalid      INTEGER NOT NULL CHECK (total_invalid >= 0),
          last_invalid_at    INTEGER NOT NULL)`);
      }
      if (row!.version < 5) {
        // TD-005 remainder: durable cumulative prune counter for the
        // resolved-row retention cap (TD-008). Silent by design; count is
        // exposed via listQuarantineStats. IF NOT EXISTS keeps this safe if
        // a sibling migration already created it (collision coordination).
        db.exec(`CREATE TABLE IF NOT EXISTS quarantine_prune_stats (
          id            INTEGER PRIMARY KEY CHECK (id = 1),
          total_pruned  INTEGER NOT NULL DEFAULT 0)`);
      }
      if (row!.version < 6) {
        // Pkg1 (QA C-1): durable per-entity version state, so DC-06 compaction
        // can delete change records without collapsing live entities to an
        // empty version clock in the DC-09 snapshot pipeline (INV-1a.3 of
        // docs/qa/remediation/pkg1-diagnosis.md). Backfill from surviving
        // change history; entities with no remaining records keep no version
        // row (pre-release wipe is the accepted data-safety decision).
        db.exec(`CREATE TABLE IF NOT EXISTS entity_versions (
          entity_id          TEXT PRIMARY KEY,
          entity_type        TEXT NOT NULL,
          version            TEXT NOT NULL,
          latest_producer    TEXT NOT NULL,
          latest_seq         INTEGER NOT NULL,
          latest_hlc         INTEGER NOT NULL,
          updated_hlc        INTEGER NOT NULL)`);
        backfillEntityVersions(db);
      }
      if (row!.version < 7) {
        // DC-21 §4.1/D5: last-known endpoints on peers (nullable, additive,
        // non-authoritative, device-local, never replicated). Written ONLY
        // after a successful authenticated session (D6). Column guards keep
        // this safe if a sibling migration already applied them.
        const cols = (
          db.prepare("PRAGMA table_info(peers)").all() as Array<
            { name: string }
          >
        ).map((c) => c.name);
        if (!cols.includes("last_endpoint_host")) {
          db.exec("ALTER TABLE peers ADD COLUMN last_endpoint_host TEXT");
        }
        if (!cols.includes("last_endpoint_port")) {
          db.exec("ALTER TABLE peers ADD COLUMN last_endpoint_port INTEGER");
        }
        if (!cols.includes("last_endpoint_seen")) {
          db.exec("ALTER TABLE peers ADD COLUMN last_endpoint_seen INTEGER");
        }
        // DC-22 §2.4/D5: reminder enable/disable state (stored-but-inactive,
        // NULL/1 = active, 0 = disabled). Smoke-test round 5 runtime evidence:
        // these columns were added to the fresh-install DDL (schema.ts) but
        // NOT to this migration path, so existing DBs hit
        // "table reminders has no column named enabled" on the first
        // set_reminder. Guards keep re-runs safe.
        const remCols = db
          .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='reminders'")
          .get() !== undefined
          ? (
              db.prepare("PRAGMA table_info(reminders)").all() as Array<
                { name: string }
              >
            ).map((c) => c.name)
          : [];
        if (remCols.length > 0 && !remCols.includes("enabled")) {
          db.exec("ALTER TABLE reminders ADD COLUMN enabled INTEGER CHECK (enabled IN (0, 1))");
        }
        const evCols = db
          .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='events'")
          .get() !== undefined
          ? (
              db.prepare("PRAGMA table_info(events)").all() as Array<
                { name: string }
              >
            ).map((c) => c.name)
          : [];
        if (evCols.length > 0 && !evCols.includes("all_day_reminder_time")) {
          db.exec("ALTER TABLE events ADD COLUMN all_day_reminder_time TEXT");
        }
      }
      db.prepare("UPDATE schema_version SET version = ?").run(SCHEMA_VERSION);
    });
    tx();
  }
}

// ---------------------------------------------------------------------------
// Pkg1 (QA C-1) — durable per-entity version state (`entity_versions`)
// ---------------------------------------------------------------------------

/**
 * Backfill entity_versions from surviving change history during the v6
 * migration. Mirrors the DC-02 §2 normative derivation: element-wise max of
 * causality_clocks over the entity's change records; latest producer by
 * (hlc_timestamp, local_seq).
 */
function backfillEntityVersions(db: Database.Database): void {
  const rows = db
    .prepare<
      [],
      {
        entity_id: string;
        entity_type: string;
        causality_clock: string;
        device_id: string;
        local_seq: number;
        hlc_timestamp: number;
      }
    >(
      "SELECT entity_id, entity_type, causality_clock, device_id, local_seq, hlc_timestamp FROM changes ORDER BY hlc_timestamp ASC, local_seq ASC",
    )
    .all();
  for (const r of rows) {
    recordEntityVersion(db, {
      change_id: changeId(r.device_id, r.local_seq),
      device_id: r.device_id,
      local_seq: r.local_seq,
      entity_id: r.entity_id,
      entity_type: r.entity_type as ChangeRecord["entity_type"],
      field_path: "",
      operation: "set",
      payload: {},
      hlc_timestamp: r.hlc_timestamp,
      causality_clock: JSON.parse(r.causality_clock) as VectorClock,
      schema_version: 1,
    });
  }
}

/**
 * Merge one change record's causality into the entity's durable version
 * vector and advance its latest-producer identity. MUST run inside the same
 * transaction as the entity mutation + change-record insert (T1/T2), so
 * state and history can never diverge.
 *
 * This is the compaction-proof substrate for DC-09 (INV-1a of
 * pkg1-diagnosis.md): after sweep() deletes change records, the version
 * vector they represented survives here.
 */
export function recordEntityVersion(
  db: Database.Database,
  record: ChangeRecord,
): void {
  const get = db.prepare<[string], { version: string; latest_hlc: number; latest_seq: number; latest_producer: string }>(
    "SELECT version, latest_hlc, latest_seq, latest_producer FROM entity_versions WHERE entity_id = ?",
  );
  const existing = get.get(record.entity_id);
  let version: VectorClock = existing
    ? (JSON.parse(existing.version) as VectorClock)
    : {};
  version = mergeClocks(version, record.causality_clock);

  // Latest-producer identity: newer (hlc, local_seq) wins — the same
  // ordering latestProducer() used against the change log.
  let producer = existing?.latest_producer ?? record.device_id;
  let seq = existing?.latest_seq ?? record.local_seq;
  let hlc = existing?.latest_hlc ?? record.hlc_timestamp;
  if (
    record.hlc_timestamp > hlc ||
    (record.hlc_timestamp === hlc && record.local_seq > seq)
  ) {
    producer = record.device_id;
    seq = record.local_seq;
    hlc = record.hlc_timestamp;
  }

  db.prepare(`
    INSERT INTO entity_versions (entity_id, entity_type, version, latest_producer, latest_seq, latest_hlc, updated_hlc)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(entity_id) DO UPDATE SET
      entity_type = excluded.entity_type,
      version = excluded.version,
      latest_producer = excluded.latest_producer,
      latest_seq = excluded.latest_seq,
      latest_hlc = excluded.latest_hlc,
      updated_hlc = excluded.updated_hlc`).run(
    record.entity_id,
    record.entity_type,
    JSON.stringify(version),
    producer,
    seq,
    hlc,
    record.hlc_timestamp,
  );
}

function mergeClocks(a: VectorClock, b: VectorClock): VectorClock {
  const out: VectorClock = { ...a };
  for (const [d, s] of Object.entries(b)) {
    out[d] = Math.max(out[d] ?? 0, s);
  }
  return out;
}

// ---------------------------------------------------------------------------
// DC-07 §7 T1 — CREATE LOCAL CHANGE (atomic)
// ---------------------------------------------------------------------------

export interface LocalChangeInput {
  entity_id: string;
  entity_type: ChangeRecord["entity_type"];
  field_path: string;
  operation: ChangeRecord["operation"];
  payload: ChangeRecord["payload"];
  hlc_now: () => number;
}

/**
 * T1: persist a locally created change atomically with the device_clock
 * advance. Entity-row mutation runs inside the same transaction via
 * `mutate` so a crash can never strand one without the other (DC-07 §7 T1).
 */
export function createLocalChange(
  db: Database.Database,
  selfDeviceId: string,
  input: LocalChangeInput,
  mutate?: (db: Database.Database, record: ChangeRecord) => void,
): ChangeRecord {
  const insertChange = db.prepare(`
    INSERT INTO changes (change_id, device_id, local_seq, entity_id,
      entity_type, field_path, operation, payload, hlc_timestamp,
      causality_clock, schema_version)
    VALUES (@change_id, @device_id, @local_seq, @entity_id, @entity_type,
      @field_path, @operation, @payload, @hlc_timestamp, @causality_clock,
      @schema_version)`);

  // C3 (Review 2): element-wise MAX on conflict so a stale/compacted view
  // can never lower another writer's clock entry.
  const upsertClock = db.prepare(`
    INSERT INTO device_clock (peer_device_id, max_seq) VALUES (@d, @s)
    ON CONFLICT(peer_device_id) DO UPDATE SET
      max_seq = MAX(max_seq, excluded.max_seq)`);

  let record!: ChangeRecord;
  const tx = db.transaction(() => {
    // C3 (Review 2): allocate from BOTH sources of truth. MAX(changes.local_seq)
    // alone regresses after compaction deletes own old rows; device_clock alone
    // could drift if rows exist above it. Take the max of both.
    const storedClock = getDeviceClock(db);
    const nextSeq =
      Math.max(storedClock[selfDeviceId] ?? 0, getNextLocalSeq(db, selfDeviceId)) + 1;
    const clock: VectorClock = { ...storedClock, [selfDeviceId]: nextSeq };

    record = {
      change_id: changeId(selfDeviceId, nextSeq),
      device_id: selfDeviceId,
      local_seq: nextSeq,
      entity_id: input.entity_id,
      entity_type: input.entity_type,
      field_path: input.field_path,
      operation: input.operation,
      payload: input.payload as ChangeRecord["payload"],
      hlc_timestamp: input.hlc_now(),
      causality_clock: clock,
      schema_version: 1,
    };

    mutate?.(db, record);
    insertChange.run(serializeChange(record));
    // Pkg1: durable version state rides the same T1 transaction (INV-1a).
    recordEntityVersion(db, record);
    upsertClock.run({ d: selfDeviceId, s: nextSeq });
  });
  tx();

  return record;
}

function serializeChange(r: ChangeRecord) {
  return {
    ...r,
    payload: JSON.stringify(r.payload),
    causality_clock: JSON.stringify(r.causality_clock),
  };
}

function getNextLocalSeq(db: Database.Database, deviceId: string): number {
  const row = db
    .prepare<[string], { m: number | null }>(
      "SELECT MAX(local_seq) AS m FROM changes WHERE device_id = ?",
    )
    .get(deviceId);
  return row?.m ?? 0;
}

export function getDeviceClock(db: Database.Database): VectorClock {
  const rows = db
    .prepare<[], { peer_device_id: string; max_seq: number }>(
      "SELECT peer_device_id, max_seq FROM device_clock",
    )
    .all();
  const clock: VectorClock = {};
  for (const r of rows) clock[r.peer_device_id] = r.max_seq;
  return clock;
}

// ---------------------------------------------------------------------------
// Pkg5 (QA M-2 / QA-1 F2) — DC-03 conflict detection wired into T2
// ---------------------------------------------------------------------------

/**
 * Local current value of one conflict entity (entity_id, field_path) of an
 * EVENT entity, derived from the live `events` row (DC-03 §2.4 effective
 * value semantics). A missing row = DELETED. The payload value shapes mirror
 * exactly what EventCore/makeEntityMutator write:
 *   'title'/'description' -> scalar string; 'schedule' ->
 *   {startMs,endMs,allDay}; 'event' -> the eventFields() object; '*' and any
 *   unknown path -> the whole event object (a live row means not-deleted).
 */
function eventRowLocalValue(
  db: Database.Database,
  entityId: string,
  fieldPath: string,
): { deleted: boolean; value: unknown } {
  const row = db
    .prepare<
      [string],
      {
        title: string;
        description: string;
        all_day: number;
        utc_start_ms: number | null;
        utc_end_ms: number | null;
      }
    >(
      "SELECT title, description, all_day, utc_start_ms, utc_end_ms FROM events WHERE event_id = ?",
    )
    .get(entityId);
  if (!row) return { deleted: true, value: undefined };
  switch (fieldPath) {
    case "title":
      return { deleted: false, value: row.title };
    case "description":
      return { deleted: false, value: row.description };
    case "schedule":
      return {
        deleted: false,
        value: {
          startMs: row.utc_start_ms,
          endMs: row.utc_end_ms,
          allDay: row.all_day === 1,
        },
      };
    default:
      return {
        deleted: false,
        value: {
          title: row.title,
          description: row.description,
          startMs: row.utc_start_ms,
          endMs: row.utc_end_ms,
          allDay: row.all_day === 1,
        },
      };
  }
}

/**
 * Un-compacted local participants (DC-03 §2.2) for one conflict entity:
 * already-applied change records touching (entity_id, field_path). A '*'
 * whole-entity remove touches EVERY conflict entity of that entity_id
 * (DC-03 §3.4 delete-vs-edit); distinct field paths never match each other
 * (§2.1 / §3.6 different fields never conflict).
 */
function loadConflictLocals(
  db: Database.Database,
  entityId: string,
  fieldPath: string,
): ChangeRecord[] {
  const rows = (
    fieldPath === "*"
      ? db
          .prepare<
            [string],
            ChangeRow
          >(
            `SELECT change_id, device_id, local_seq, entity_id, entity_type,
                    field_path, operation, payload, hlc_timestamp,
                    causality_clock, schema_version
             FROM changes WHERE entity_id = ?`,
          )
          .all(entityId)
      : db
          .prepare<
            [string, string],
            ChangeRow
          >(
            `SELECT change_id, device_id, local_seq, entity_id, entity_type,
                    field_path, operation, payload, hlc_timestamp,
                    causality_clock, schema_version
             FROM changes
             WHERE entity_id = ? AND (field_path = ? OR field_path = '*')`,
          )
          .all(entityId, fieldPath)
  ).map(deserializeChangeRow);
  return rows;
}

interface ChangeRow {
  change_id: string;
  device_id: string;
  local_seq: number;
  entity_id: string;
  entity_type: string;
  field_path: string;
  operation: string;
  payload: string;
  hlc_timestamp: number;
  causality_clock: string;
  schema_version: number;
}

function deserializeChangeRow(r: ChangeRow): ChangeRecord {
  return {
    change_id: r.change_id,
    device_id: r.device_id,
    local_seq: r.local_seq,
    entity_id: r.entity_id,
    entity_type: r.entity_type as ChangeRecord["entity_type"],
    field_path: r.field_path,
    operation: r.operation as ChangeRecord["operation"],
    payload: JSON.parse(r.payload) as ChangeRecord["payload"],
    hlc_timestamp: r.hlc_timestamp,
    causality_clock: JSON.parse(r.causality_clock) as VectorClock,
    schema_version: r.schema_version,
  };
}

/**
 * DC-03 §3 detection for one remotely applied record, evaluated BEFORE the
 * entity-row mutation. Persists the conflict record on CONFLICT (§3.3/§4,
 * inside the caller's T2 transaction) and returns the outcome:
 *   "apply"    — no conflict: run the entity-row mutation (§3.2 causal-after,
 *                §3.3 with no concurrent differing participant, §3.6)
 *   "noop"     — §3.1 identical-value convergence: no row write at all
 *   "conflict" — §3.3: entity row NOT overwritten; both values preserved in
 *                the conflict record; the pre-conflict local value stays
 *                visible until resolution (§3.4)
 *
 * Scope: EVENT entities only — the only type the live pipeline mutates
 * (makeEntityMutator); other entity types have no row write to protect
 * (see docs/qa/remediation/pkg5-diagnosis.md §4).
 */
function detectAndRecordConflict(
  db: Database.Database,
  record: ChangeRecord,
): "apply" | "noop" | "conflict" | "stale" {
  if (record.entity_type !== "event") return "apply";
  const localCurrent = eventRowLocalValue(db, record.entity_id, record.field_path);
  const locals = loadConflictLocals(db, record.entity_id, record.field_path);
  const outcome = detect(record, localCurrent, locals);
  if (outcome.kind === "conflict") {
    recordConflictRow(db, record, outcome.conflicting);
    return "conflict";
  }
  return outcome.kind; // "apply" | "noop" | "stale"
}

/**
 * Persist (or extend) the DC-03 §4 conflict record for one detection, per
 * DC-07's `conflicts` / `conflict_participants` tables:
 *   - §3.5 / TR-9: all participants of a conflict entity join ONE record —
 *     an existing UNRESOLVED record for the same (entity_id, field_path) is
 *     extended with any participants not yet present (participants are
 *     immutable once added, §4).
 *   - §4: conflict_id is a UUIDv4 generated once at detection; detected_at_hlc
 *     is the detecting device's wall clock (presentation-only, §5).
 *   - §4.3: detection NEVER sets a resolved_* status — resolution is an
 *     explicit user action only (DC-14). A RESOLVED record for the entity is
 *     never reopened; a genuinely new concurrent pair gets a fresh record.
 */
function recordConflictRow(
  db: Database.Database,
  incoming: ChangeRecord,
  conflicting: ChangeRecord[],
): void {
  const insertParticipant = db.prepare(`
    INSERT OR IGNORE INTO conflict_participants
      (conflict_id, change_id, device_id, local_seq, causality_clock, payload)
    VALUES (?, ?, ?, ?, ?, ?)`);

  db.transaction(() => {
    // Nested transaction = SAVEPOINT inside T2 (better-sqlite3), matching
    // the ConflictsViewModel write path pattern.
    const existing = db
      .prepare<[string, string], { conflict_id: string }>(
        `SELECT conflict_id FROM conflicts
         WHERE entity_id = ? AND field_path = ? AND status = 'unresolved'`,
      )
      .get(incoming.entity_id, incoming.field_path);
    let conflictId: string;
    if (existing) {
      conflictId = existing.conflict_id;
    } else {
      conflictId = randomUUID();
      db.prepare(
        `INSERT INTO conflicts (conflict_id, entity_id, field_path, status,
                                detected_at_hlc)
         VALUES (?, ?, ?, 'unresolved', ?)`,
      ).run(conflictId, incoming.entity_id, incoming.field_path, Date.now());
    }
    // §4 participants: the incoming C plus every concurrent differing local L.
    for (const p of [...conflicting, incoming]) {
      insertParticipant.run(
        conflictId,
        p.change_id,
        p.device_id,
        p.local_seq,
        JSON.stringify(p.causality_clock),
        JSON.stringify(p.payload),
      );
    }
  })();
}

// ---------------------------------------------------------------------------
// DC-07 §7 T2 — APPLY REMOTE CHANGE (atomic per DC-02 §7)
// ---------------------------------------------------------------------------

export type ApplyOutcome = "applied" | "buffered" | "duplicate";

/**
 * T2: dedupe / apply / buffer an incoming change atomically with
 * knowledge-state updates and element-wise-max clock merge.
 * Entity mutation callback runs inside the same transaction only for
 * records actually applied (including drained pending records).
 */
export function applyRemoteChange(
  db: Database.Database,
  incoming: ChangeRecord,
  knowledge: KnowledgeState,
  mutate?: (db: Database.Database, record: ChangeRecord) => void,
): ApplyOutcome {
  const insertPending = db.prepare(`
    INSERT INTO pending_changes (device_id, local_seq, record_payload, received_at_hlc)
    VALUES (?, ?, ?, ?)`);

  const insertChange = db.prepare(`
    INSERT INTO changes (change_id, device_id, local_seq, entity_id,
      entity_type, field_path, operation, payload, hlc_timestamp,
      causality_clock, schema_version)
    VALUES (@change_id, @device_id, @local_seq, @entity_id, @entity_type,
      @field_path, @operation, @payload, @hlc_timestamp, @causality_clock,
      @schema_version)`);

  // C1 (Review 2): applied_upto is monotone per producer; still use MAX so a
  // stale caller can never lower the stored frontier.
  const setAppliedUpto = db.prepare(`
    INSERT INTO applied_upto (producer_device_id, applied_through) VALUES (?, ?)
    ON CONFLICT(producer_device_id) DO UPDATE SET
      applied_through = MAX(applied_through, excluded.applied_through)`);

  const deletePending = db.prepare(
    "DELETE FROM pending_changes WHERE device_id = ? AND local_seq = ?",
  );

  const loadAllPending = db.prepare<
    [string],
    { device_id: string; local_seq: number; record_payload: string }
  >(
    "SELECT device_id, local_seq, record_payload FROM pending_changes WHERE device_id = ?",
  );

  // C3 (Review 2): element-wise MAX upsert — clock merge is a join, never an
  // overwrite.
  const upsertClockStmt = db.prepare(`
    INSERT INTO device_clock (peer_device_id, max_seq) VALUES (?, ?)
    ON CONFLICT(peer_device_id) DO UPDATE SET
      max_seq = MAX(max_seq, excluded.max_seq)`);

  function mergeClocks(clock: VectorClock): void {
    for (const [d, s] of Object.entries(clock)) {
      upsertClockStmt.run(d, s);
    }
  }

  let dbKnowledge!: KnowledgeState;
  try {
    const outcome = db.transaction(() => {
      // C2/C1 (Review 2): classification is derived from DB state INSIDE the
      // transaction (DB is source of truth). A stale in-memory knowledge
      // object can no longer misclassify (e.g. after restart).
      dbKnowledge = loadKnowledgeFromDb(db);
      const cls = classifyArrival(
        dbKnowledge,
        incoming.device_id,
        incoming.local_seq,
      );

      if (cls === "duplicate") {
        mergeClocks(incoming.causality_clock);
        return "duplicate" as const;
      }

      if (cls === "buffer") {
        insertPending.run(
          incoming.device_id,
          incoming.local_seq,
          JSON.stringify(incoming),
          Date.now(),
        );
        mergeClocks(incoming.causality_clock);
        return "buffered" as const;
      }

      // apply + drain consecutive pending in order
      const drained = advanceApplied(
        dbKnowledge,
        incoming.device_id,
        incoming.local_seq,
      );
      for (const step of drained) {
        let record: ChangeRecord;
        if (
          step.device_id === incoming.device_id &&
          step.local_seq === incoming.local_seq
        ) {
          record = incoming;
        } else {
          const rows = loadAllPending.all(step.device_id);
          const match = rows.find((r) => r.local_seq === step.local_seq);
          if (!match) {
            throw new Error(
              `pending payload missing for ${step.device_id}:${step.local_seq}`,
            );
          }
          record = JSON.parse(match.record_payload) as ChangeRecord;
        }
        // Pkg5 (QA M-2): DC-03 §3 detection BEFORE mutating local state.
        //   "apply"    -> entity-row mutation runs (§3.2/§3.6, no conflict)
        //   "noop"     -> §3.1 identical-value convergence: no row write
        //   "stale"    -> §3.2a (v2): C is causally dominated by a local
        //                 participant — history + clocks advance but the
        //                 materialized row is NOT regressed
        //   "conflict" -> §3.3/§3.4: entity row NOT overwritten; the conflict
        //                 record was persisted above; history + clocks below
        //                 still advance (application gating per DC-02 §7 is
        //                 unaffected, so sync progress and future detections
        //                 keep working).
        const det = detectAndRecordConflict(db, record);
        if (det === "apply") {
          mutate?.(db, record);
        }
        insertChange.run(serializeChange(record));
        // Pkg1: durable version state rides the same T2 transaction (INV-1a).
        recordEntityVersion(db, record);
        deletePending.run(step.device_id, step.local_seq);
      }
      setAppliedUpto.run(
        incoming.device_id,
        drained[drained.length - 1]!.local_seq,
      );
      // TD-001 (4): the frontier advanced — skip rows at/below it are
      // resolved (quarantine diagnostic rows are NEVER touched).
      db.prepare(
        "DELETE FROM skipped_seqs WHERE producer_device_id = ? AND local_seq <= ?",
      ).run(incoming.device_id, drained[drained.length - 1]!.local_seq);
      mergeClocks(incoming.causality_clock);
      return "applied" as const;
    })();

    // C2 (Review 2): transaction committed -> now mirror the DB-derived state
    // onto the caller's object. If anything above threw, we never get here and
    // the caller-visible knowledge stays at pre-call values.
    knowledge.appliedUpto = dbKnowledge.appliedUpto;
    knowledge.pending = dbKnowledge.pending;
    knowledge.skipped = dbKnowledge.skipped;
    return outcome;
  } catch (err) {
    // C1 safety net (DC-02 §7.1 / DC-03 TR-8): a UNIQUE violation from the
    // changes/pending_changes inserts means this is a redelivery our in-memory
    // view missed — idempotently reclassify as duplicate instead of crashing.
    if (isUniqueViolation(err)) {
      db.transaction(() => mergeClocks(incoming.causality_clock))();
      const fresh = loadKnowledgeFromDb(db);
      knowledge.appliedUpto = fresh.appliedUpto;
      knowledge.pending = fresh.pending;
      knowledge.skipped = fresh.skipped;
      return "duplicate";
    }
    throw err;
  }
}

/**
 * C1 (Review 2): rebuild KnowledgeState from durable tables after restart.
 * appliedUpto comes from applied_upto; pending from pending_changes;
 * TD-001: skipped seqs from skipped_seqs.
 */
export function loadKnowledgeFromDb(db: Database.Database): KnowledgeState {
  const k = emptyKnowledge();
  k.skipped = new Map();
  for (const r of db
    .prepare<[], { producer_device_id: string; applied_through: number }>(
      "SELECT producer_device_id, applied_through FROM applied_upto",
    )
    .all()) {
    k.appliedUpto[r.producer_device_id] = r.applied_through;
  }
  for (const r of db
    .prepare<[], { device_id: string; local_seq: number }>(
      "SELECT device_id, local_seq FROM pending_changes",
    )
    .all()) {
    let set = k.pending.get(r.device_id);
    if (!set) {
      set = new Set();
      k.pending.set(r.device_id, set);
    }
    set.add(r.local_seq);
  }
  for (const r of db
    .prepare<[], { producer_device_id: string; local_seq: number }>(
      "SELECT producer_device_id, local_seq FROM skipped_seqs",
    )
    .all()) {
    let set = k.skipped.get(r.producer_device_id);
    if (!set) {
      set = new Set();
      k.skipped.set(r.producer_device_id, set);
    }
    set.add(r.local_seq);
  }
  return k;
}

function isUniqueViolation(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes("UNIQUE constraint failed");
}

// ---------------------------------------------------------------------------
// DC-04 §4.3 / DC-08 §5 Stage 2 — DURABLE QUARANTINE
// ---------------------------------------------------------------------------

export interface QuarantineOptions {
  /** Machine-readable reason code, e.g. "invalid_member_id" (DC-04 §4.3b). */
  reason: string;
  /** Noise peer that sent the record (DC-08 §5 Stage 2). */
  senderDeviceId: string;
  /** The offending record, stored JSON.stringify-verbatim for inspection. */
  rawRecord: unknown;
}

/**
 * H-3: persist an invalid incoming record durably before dropping it from
 * processing. Quarantine is a diagnostic surface (DC-04 §4.3c): countable,
 * inspectable, never user-resolvable, never blocking the session.
 *
 * Pkg6 (QA-1 F-5): TD-001's "never create a second quarantine row" guarantee
 * extended across frontier advance. Previously the only dedupe guard was the
 * skipped_seqs row (engine intake), which is GC'd once the frontier advances
 * past the seq (TD-001 (4)/(8)) — so a re-delivery of an already-quarantined
 * record AFTER the frontier advanced re-quarantined it as a second row
 * (QA MINOR F-5, SC6 "expected 2 to be 1"). Before inserting, the durable
 * quarantine table is consulted for an existing row with the same
 * (device_id, local_seq) extracted from its verbatim raw_record; a match
 * suppresses the duplicate row. The (device_id, local_seq) pair uniquely
 * identifies a record (change_id = (device, seq)), so two DIFFERENT invalid
 * records can never collide on it. Diagnostic-only: callers keep their
 * skip-row/misbehavior/stat bookkeeping unchanged.
 */
export function quarantineRecord(
  db: Database.Database,
  opts: QuarantineOptions,
): void {
  const raw = opts.rawRecord;
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
    const deviceId = (raw as { device_id?: unknown }).device_id;
    const seq = (raw as { local_seq?: unknown }).local_seq;
    if (
      typeof deviceId === "string" &&
      deviceId.length > 0 &&
      typeof seq === "number" &&
      Number.isInteger(seq) &&
      seq > 0
    ) {
      const existing = db
        .prepare(
          `SELECT 1 FROM quarantine
           WHERE json_extract(raw_record, '$.device_id') = ?
             AND json_extract(raw_record, '$.local_seq') = ?
           LIMIT 1`,
        )
        .get(deviceId, seq);
      if (existing !== undefined) return; // already quarantined: exactly one row
    }
  }
  db.prepare(`
    INSERT INTO quarantine
      (quarantine_reason, received_at_hlc, sender_device_id, raw_record)
    VALUES (?, ?, ?, ?)`).run(
    opts.reason,
    Date.now(),
    opts.senderDeviceId,
    JSON.stringify(opts.rawRecord),
  );
}

/**
 * Count quarantined records — all, or filtered by reason code so a test can
 * assert "exactly one record quarantined with reason X" (DC-04 §4.3c).
 */
export function countQuarantined(db: Database.Database, reason?: string): number {
  if (reason === undefined) {
    const row = db
      .prepare<[], { c: number }>("SELECT COUNT(*) AS c FROM quarantine")
      .get();
    return row?.c ?? 0;
  }
  const row = db
    .prepare<[string], { c: number }>(
      "SELECT COUNT(*) AS c FROM quarantine WHERE quarantine_reason = ?",
    )
    .get(reason);
  return row?.c ?? 0;
}

// ---------------------------------------------------------------------------
// TD-001 — skipped_seqs (quarantine-and-skip) + quarantine listing surface
// ---------------------------------------------------------------------------

/**
 * TD-001 (3): mark a quarantined producer seq as resolved for sequence
 * progress. Idempotent; the quarantine diagnostic row itself is unchanged.
 */
export function markSeqSkipped(
  db: Database.Database,
  producerDeviceId: string,
  localSeq: number,
): void {
  db.prepare(
    "INSERT OR IGNORE INTO skipped_seqs (producer_device_id, local_seq) VALUES (?, ?)",
  ).run(producerDeviceId, localSeq);
}

/** TD-001: does this (producer, seq) currently carry a skip row? */
export function isSeqSkipped(
  db: Database.Database,
  producerDeviceId: string,
  localSeq: number,
): boolean {
  return (
    !!db
      .prepare(
        "SELECT 1 FROM skipped_seqs WHERE producer_device_id = ? AND local_seq = ?",
      )
      .get(producerDeviceId, localSeq)
  );
}

/** TD-001: durable skip rows for a producer, ascending by seq. */
export function listSkippedSeqs(
  db: Database.Database,
  producerDeviceId: string,
): number[] {
  return (
    db
      .prepare<[string], { local_seq: number }>(
        "SELECT local_seq FROM skipped_seqs WHERE producer_device_id = ? ORDER BY local_seq",
      )
      .all(producerDeviceId)
      .map((r) => r.local_seq)
  );
}

export interface QuarantineRow {
  quarantine_id: number;
  quarantine_reason: string;
  received_at_hlc: number;
  sender_device_id: string;
  /** raw record, stored JSON.stringify-verbatim (DC-04 TR-7) */
  raw_record: string;
  /** TD-005 lifecycle: epoch-ms when the record applied successfully; NULL = active */
  resolved_at_hlc: number | null;
  /** TD-005: why the row was resolved (e.g. "revalidated_on_restart"); NULL = active */
  resolved_reason: string | null;
}

/**
 * Option A "Sync Errors" surface (TD-001 §2): flat read-only list of
 * quarantine rows, newest first. Diagnostics only — no retry/delete.
 * TD-005: rows additionally carry the lifecycle flag (resolved_at_hlc /
 * resolved_reason); the list itself remains unfiltered (active + resolved).
 */
export function listQuarantine(
  db: Database.Database,
  opts?: { limit?: number },
): QuarantineRow[] {
  return db
    .prepare<[number], QuarantineRow>(
      `SELECT quarantine_id, quarantine_reason, received_at_hlc,
              sender_device_id, raw_record,
              resolved_at_hlc, resolved_reason
       FROM quarantine ORDER BY quarantine_id DESC LIMIT ?`,
    )
    .all(opts?.limit ?? 200);
}

// ---------------------------------------------------------------------------
// TD-005 — quarantine lifecycle: durable resolved/active distinction
// ---------------------------------------------------------------------------

/**
 * TD-005: mark a quarantine row resolved (archive, never delete). Idempotent:
 * an already-resolved row keeps its ORIGINAL resolution timestamp/reason.
 * Call from wherever an apply of a formerly-quarantined record succeeds —
 * the restart-time revalidation pass (revalidateQuarantine) is the primary
 * integration point (see reconcileQuarantineResolutions below).
 */
export function markQuarantineResolved(
  db: Database.Database,
  quarantineId: number,
  reason: string,
): boolean {
  const info = db
    .prepare(
      `UPDATE quarantine
       SET resolved_at_hlc = ?, resolved_reason = ?
       WHERE quarantine_id = ? AND resolved_at_hlc IS NULL`,
    )
    .run(Date.now(), reason, quarantineId);
  return info.changes > 0;
}

/**
 * TD-005: derive resolution flags for ACTIVE quarantine rows by checking
 * whether each quarantined record's change now exists in the durable changes
 * table (i.e. it was applied — e.g. by revalidateQuarantine at restart).
 * Idempotent: resolved rows are skipped, so double-running is a no-op.
 * Returns { examined, marked }.
 *
 * INTEGRATION NOTE: `revalidateQuarantine` lives in src/sync/sync_engine.ts
 * (owned by the TD-006 agent in this window). After a revalidation pass that
 * reports revalidated > 0, sync_engine should call:
 *   reconcileQuarantineResolutions(db)
 * — a one-line hook — so newly-applied quarantine rows are marked resolved.
 */
export function reconcileQuarantineResolutions(
  db: Database.Database,
): { examined: number; marked: number } {
  const rows = db
    .prepare<
      [],
      { quarantine_id: number; raw_record: string }
    >(
      "SELECT quarantine_id, raw_record FROM quarantine WHERE resolved_at_hlc IS NULL",
    )
    .all();
  const exists = db.prepare("SELECT 1 FROM changes WHERE change_id = ?");
  let marked = 0;
  for (const row of rows) {
    let deviceId: unknown;
    let localSeq: unknown;
    try {
      const raw = JSON.parse(row.raw_record) as {
        device_id?: unknown;
        local_seq?: unknown;
      };
      deviceId = raw.device_id;
      localSeq = raw.local_seq;
    } catch {
      continue; // unparsable raw record: cannot derive a change_id
    }
    if (typeof deviceId !== "string") continue;
    if (typeof localSeq !== "number" || !Number.isInteger(localSeq)) continue;
    const changeIdStr = `${deviceId}:${localSeq}`; // matches change_record.ts changeId()
    if (exists.get(changeIdStr)) {
      if (markQuarantineResolved(db, row.quarantine_id, "revalidated_on_restart")) {
        marked++;
      }
    }
  }
  return { examined: rows.length, marked };
}

/**
 * TD-005: badge/dialog stats. The badge counts ACTIVE rows only — resolved
 * rows are archived diagnostics, not pending problems. total_pruned is the
 * durable cumulative count of resolved rows removed by the retention cap
 * (TD-008): pruning is silent by design, but never invisible in aggregate.
 */
export function listQuarantineStats(
  db: Database.Database,
): {
  active: number;
  resolved: number;
  total: number;
  total_pruned: number;
} {
  const row = db
    .prepare<
      [],
      { active: number; resolved: number; total: number }
    >(
      `SELECT SUM(CASE WHEN resolved_at_hlc IS NULL THEN 1 ELSE 0 END) AS active,
              SUM(CASE WHEN resolved_at_hlc IS NOT NULL THEN 1 ELSE 0 END) AS resolved,
              COUNT(*) AS total
       FROM quarantine`,
    )
    .get();
  const pruned = db
    .prepare<[], { total_pruned: number } | undefined>(
      "SELECT total_pruned FROM quarantine_prune_stats WHERE id = 1",
    )
    .get();
  return {
    active: row?.active ?? 0,
    resolved: row?.resolved ?? 0,
    total: row?.total ?? 0,
    total_pruned: pruned?.total_pruned ?? 0,
  };
}

// ---------------------------------------------------------------------------
// TD-005 remainder — user resolution actions + resolved-row retention (TD-008)
// ---------------------------------------------------------------------------

/**
 * TD-008 retention cap on RESOLVED quarantine rows only. No runtime config
 * mechanism exists yet (TIDE_* env vars are boot-only), so this is a
 * constant here: keep the newest 1,000 resolved rows; ACTIVE rows are NEVER
 * pruned (product rule: quarantined records are never deleted silently).
 */
export const QUARANTINE_RESOLVED_RETENTION_CAP = 1000;

/**
 * TD-008: prune the OLDEST resolved rows beyond `cap`. Silent by design
 * (resolved rows are non-actionable); returns the number pruned this run
 * and accumulates it durably in quarantine_prune_stats so
 * listQuarantineStats can expose the lifetime total. Never touches active
 * rows. Deterministic ordering: newest = highest quarantine_id.
 */
export function pruneResolvedQuarantine(
  db: Database.Database,
  cap: number = QUARANTINE_RESOLVED_RETENTION_CAP,
): number {
  if (!Number.isInteger(cap) || cap < 0) {
    throw new Error(`invalid retention cap: ${cap}`);
  }
  let pruned = 0;
  db.transaction(() => {
    const info = db
      .prepare(
        `DELETE FROM quarantine
         WHERE resolved_at_hlc IS NOT NULL
           AND quarantine_id NOT IN (
             SELECT quarantine_id FROM quarantine
             WHERE resolved_at_hlc IS NOT NULL
             ORDER BY quarantine_id DESC LIMIT ?)`,
      )
      .run(cap);
    pruned = info.changes;
    if (pruned > 0) {
      db.prepare(
        `INSERT INTO quarantine_prune_stats (id, total_pruned) VALUES (1, ?)
         ON CONFLICT(id) DO UPDATE SET
           total_pruned = total_pruned + excluded.total_pruned`,
      ).run(pruned);
    }
  })();
  return pruned;
}

export interface UserDeleteResult {
  ok: boolean;
  /** true when the skipped_seqs row existed; false when it was re-created */
  skip_row_present: boolean;
  /** true when a missing skipped_seqs row had to be re-created */
  skip_row_recreated: boolean;
}

/**
 * TD-005 remainder: user "give up on this record" action. The quarantine
 * row is RETAINED (never physically deleted) and marked
 * resolved_reason='user_deleted' — retaining the row preserves the durable
 * audit trail at negligible cost while fully carrying the give-up semantics.
 *
 * CRITICAL INVARIANT: the producer's skipped_seqs entry for this seq MUST
 * exist afterwards so the sync stream stays unblocked (the seq counts as
 * processed). If the skip row is missing it is re-created here — UNLESS the
 * record was actually applied (its change exists), in which case the skip
 * row was legitimately removed and must NOT come back.
 *
 * Two-step confirmation lives in the UI (DC-15 §3.5); the RPC additionally
 * requires `confirm === true` — a defense-in-depth gate at the op level.
 */
export function deleteQuarantineByUser(
  db: Database.Database,
  quarantineId: number,
  opts: { confirm: boolean },
): UserDeleteResult {
  if (opts?.confirm !== true) {
    throw new Error(
      "delete_quarantine requires explicit confirm: true (destructive action, DC-15 §3.5)",
    );
  }
  const row = db
    .prepare<
      [number],
      { raw_record: string; resolved_at_hlc: number | null }
    >(
      "SELECT raw_record, resolved_at_hlc FROM quarantine WHERE quarantine_id = ?",
    )
    .get(quarantineId);
  if (!row) throw new Error(`quarantine row ${quarantineId} not found`);

  // Derive (producer, seq) when the raw record is shape-compatible.
  let producer: string | null = null;
  let seq: number | null = null;
  try {
    const raw = JSON.parse(row.raw_record) as {
      device_id?: unknown;
      local_seq?: unknown;
    };
    if (typeof raw.device_id === "string" && raw.device_id.length > 0) {
      producer = raw.device_id;
    }
    if (
      typeof raw.local_seq === "number" &&
      Number.isInteger(raw.local_seq) &&
      raw.local_seq > 0
    ) {
      seq = raw.local_seq;
    }
  } catch {
    /* unparsable: nothing to guarantee beyond resolving the row */
  }

  let skipRowPresent = false;
  let recreated = false;
  db.transaction(() => {
    // Idempotent: an already-resolved row keeps its original resolution.
    if (row.resolved_at_hlc === null) {
      markQuarantineResolved(db, quarantineId, "user_deleted");
    }
    if (producer !== null && seq !== null) {
      const applied = !!db
        .prepare("SELECT 1 FROM changes WHERE change_id = ?")
        .get(`${producer}:${seq}`);
      if (!applied) {
        // The record was never applied: the seq must count as processed so
        // later seqs of this producer keep flowing (stream unblocked).
        skipRowPresent = isSeqSkipped(db, producer, seq);
        if (!skipRowPresent) {
          markSeqSkipped(db, producer, seq);
          recreated = true;
        }
      } else {
        skipRowPresent = true; // applied: skip row legitimately absent
      }
    }
  })();
  return {
    ok: true,
    skip_row_present: skipRowPresent,
    skip_row_recreated: recreated,
  };
}

// ---------------------------------------------------------------------------
// TD-006 / DC-16 — Tier-2 durable hard blocks + §2.3 durable invalid tally
// ---------------------------------------------------------------------------

export interface HardBlockRow {
  producer_device_id: string;
  first_triggered_at: number;
  last_triggered_at: number;
  trigger_count: number;
}

/** Is this producer currently hard-blocked (durable, NOT self-clearing)? */
export function isHardBlocked(
  db: Database.Database,
  producerDeviceId: string,
): boolean {
  return !!db
    .prepare("SELECT 1 FROM hard_blocks WHERE producer_device_id = ?")
    .get(producerDeviceId);
}

/**
 * Record/refresh a Tier-2 hard block. Idempotent upsert: the FIRST trigger
 * timestamp and the cumulative trigger_count are preserved across re-triggers
 * so the UI can state why/when the block happened (DC-16 §4.2).
 */
export function hardBlockProducer(
  db: Database.Database,
  producerDeviceId: string,
): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO hard_blocks
       (producer_device_id, first_triggered_at, last_triggered_at, trigger_count)
     VALUES (?, ?, ?, 1)
     ON CONFLICT(producer_device_id) DO UPDATE SET
       last_triggered_at = excluded.last_triggered_at,
       trigger_count = trigger_count + 1`,
  ).run(producerDeviceId, now, now);
}

/** §4.2 Unblock: explicit user action ONLY — clears the durable row. */
export function unhardBlockProducer(
  db: Database.Database,
  producerDeviceId: string,
): boolean {
  const info = db
    .prepare("DELETE FROM hard_blocks WHERE producer_device_id = ?")
    .run(producerDeviceId);
  return info.changes > 0;
}

/** All durable hard blocks (Paired Devices / peer-state surface). */
export function listHardBlocks(db: Database.Database): HardBlockRow[] {
  return db
    .prepare<
      [],
      HardBlockRow
    >(`SELECT producer_device_id, first_triggered_at, last_triggered_at,
              trigger_count
       FROM hard_blocks ORDER BY last_triggered_at DESC`)
    .all();
}

export interface PeerInvalidTallyRow {
  producer_device_id: string;
  total_invalid: number;
  last_invalid_at: number;
}

/**
 * §2.3 durable tally: appended at the same time quarantine rows are written.
 * Informs UI history across restarts ONLY — it NEVER triggers blocking.
 */
export function appendInvalidTally(
  db: Database.Database,
  producerDeviceId: string,
): void {
  db.prepare(
    `INSERT INTO peer_invalid_tally
       (producer_device_id, total_invalid, last_invalid_at)
     VALUES (?, 1, ?)
     ON CONFLICT(producer_device_id) DO UPDATE SET
       total_invalid = total_invalid + 1,
       last_invalid_at = excluded.last_invalid_at`,
  ).run(producerDeviceId, Date.now());
}

/** Durable tally rows (one per producer that ever sent an invalid record). */
export function listPeerInvalidTally(
  db: Database.Database,
): PeerInvalidTallyRow[] {
  return db
    .prepare<
      [],
      PeerInvalidTallyRow
    >(`SELECT producer_device_id, total_invalid, last_invalid_at
       FROM peer_invalid_tally ORDER BY last_invalid_at DESC`)
    .all();
}
