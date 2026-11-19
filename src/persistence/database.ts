// Tide persistence: database open + DC-07 transactional operations T1/T2.

import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { DDL, SCHEMA_VERSION } from "./schema.ts";
import { announcedNameFromPeer } from "../domain/device_names.ts";
import { revokedCutoffs } from "../security/revocation_store.ts";
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
    db.transaction(() => ensureReminderColumnsV7(db))();
    // DC-27 v9 repair (idempotent): a DB stamped v9 must carry the
    // revocation cutoff column and the ACK store.
    db.transaction(() => ensureRevocationSchemaV9(db))();
    // DC-28 v10 repair (idempotent): a DB stamped v10 without the column
    // gets it, and only THEN its one-time name move (the column is absent,
    // so no nickname can have been set through it yet).
    db.transaction(() => ensurePeerNamesSchemaV10(db))();
    // held_changes (hold counter): additive, idempotent repair.
    db.transaction(() => ensureHeldChangesSchema(db))();
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
        ensureReminderColumnsV7(db);
      }
      if (row!.version < 8) {
        // GATE-2026-09-22 all-day end_date repair (data-only, no DDL).
        // derivedScheduleColumns derived the INCLUSIVE end_date column
        // (DC-07: "inclusive, when all_day=1") from the EXCLUSIVE endMs
        // instant (wholeDay stores next local midnight), writing the day
        // AFTER the real last covered day. A 1-day all-day event stored
        // start=Oct1/end=Oct2 and exported as a 2-day DTEND range into
        // Google. The write seam is fixed (inclusiveEndDateFromExclusiveMs);
        // this migration re-derives existing rows from the authoritative
        // utc_end_ms (ms convention unchanged: exclusive endMs, and the
        // importer's 23:59:59.999 form is idempotent under -1ms).
        // Guarded: minimal hand-built test DBs may not carry the events
        // table at all (early-version migration tests).
        const hasEvents = db
          .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='events'")
          .get() !== undefined;
        if (hasEvents) {
          db.exec(`
            UPDATE events SET
              end_date = strftime('%Y-%m-%d', (utc_end_ms - 1) / 1000, 'unixepoch', 'localtime')
            WHERE all_day = 1
              AND utc_end_ms IS NOT NULL
              AND utc_end_ms > 0
              AND end_date IS NOT NULL
              AND end_date != strftime('%Y-%m-%d', (utc_end_ms - 1) / 1000, 'unixepoch', 'localtime')
              -- Safety: never let the re-derivation move end_date BEFORE
              -- start_date (legacy shell-store rows carry utc_* = 0 and their
              -- truth lives in the date columns themselves).
              AND strftime('%Y-%m-%d', (utc_end_ms - 1) / 1000, 'unixepoch', 'localtime') >= start_date;
          `);
        }
      }
      // Drift repairs for EVERY stamp below the current version (review
      // m-1): before v10 a v8/v9-stamped DB got the v7 column repair from
      // the == SCHEMA_VERSION branch on its first open; since v10 it takes
      // this branch instead, so the guarded, idempotent repair runs here
      // too, and the FIRST open repairs it.
      ensureReminderColumnsV7(db);
      if (row!.version <= 9) {
        // DC-27 P5/P12 (DC-07 Appendix X.1, DC-05 Appendix A): additive.
        // "<= 9", not "< 9": since v10 a v9-stamped DB no longer takes the
        // == SCHEMA_VERSION repair branch, so the idempotent v9 repair runs
        // here for it (DDL/migration drift, smoke round 5 lesson).
        ensureRevocationSchemaV9(db);
      }
      if (row!.version < 10) {
        // DC-28 §4.9 (DC-07 amendment O1): announced_name + one-time move.
        ensurePeerNamesSchemaV10(db);
      }
      if (row!.version < 11) {
        // v11: held_changes (hold counter for the waiting notice): additive.
        ensureHeldChangesSchema(db);
      }
      db.prepare("UPDATE schema_version SET version = ?").run(SCHEMA_VERSION);
    });
    tx();
  }
}

/** held_changes (hold counter for the "waiting" notice): additive, idempotent. */
function ensureHeldChangesSchema(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS held_changes (
    producer_device_id TEXT NOT NULL,
    local_seq          INTEGER NOT NULL CHECK (local_seq > 0),
    sessions_held      INTEGER NOT NULL CHECK (sessions_held > 0),
    first_held_at      INTEGER NOT NULL,
    PRIMARY KEY (producer_device_id, local_seq))`);
}

/**
 * One more session in which (origin, seq) was still held at session end.
 * Persisted, so the count survives a restart. Returns the new count.
 */
export function bumpHeldSessions(
  db: Database.Database,
  origin: string,
  seq: number,
): number {
  db.prepare(
    `INSERT INTO held_changes (producer_device_id, local_seq, sessions_held, first_held_at)
     VALUES (?, ?, 1, ?)
     ON CONFLICT(producer_device_id, local_seq) DO UPDATE SET sessions_held = sessions_held + 1`,
  ).run(origin, seq, Date.now());
  return (
    db
      .prepare("SELECT sessions_held AS n FROM held_changes WHERE producer_device_id = ? AND local_seq = ?")
      .get(origin, seq) as { n: number }
  ).n;
}

/** Forget the hold counter of (origin, seq) (applied, counted done, quarantined or skipped). */
export function clearHeld(db: Database.Database, origin: string, seq: number): void {
  db.prepare("DELETE FROM held_changes WHERE producer_device_id = ? AND local_seq = ?").run(origin, seq);
}

/** Drop hold counters the applied frontier has passed (no stale entries). */
export function gcHeldChanges(db: Database.Database): void {
  db.prepare(
    `DELETE FROM held_changes WHERE EXISTS (
       SELECT 1 FROM applied_upto a
       WHERE a.producer_device_id = held_changes.producer_device_id
         AND a.applied_through >= held_changes.local_seq)`,
  ).run();
}

/**
 * Smoke round 5 v7 pieces, guarded and idempotent: reminders.enabled and
 * events.all_day_reminder_time, added only when the table exists and the
 * column is missing (minimal hand-built test DBs may lack the tables).
 */
function ensureReminderColumnsV7(db: Database.Database): void {
  const colsOf = (table: string): string[] =>
    db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table) !== undefined
      ? (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name)
      : [];
  const remCols = colsOf("reminders");
  if (remCols.length > 0 && !remCols.includes("enabled")) {
    db.exec("ALTER TABLE reminders ADD COLUMN enabled INTEGER CHECK (enabled IN (0, 1))");
  }
  const evCols = colsOf("events");
  if (evCols.length > 0 && !evCols.includes("all_day_reminder_time")) {
    db.exec("ALTER TABLE events ADD COLUMN all_day_reminder_time TEXT");
  }
}

/**
 * DC-27 v9 schema pieces, guarded so the migration and the == v9 repair can
 * both run it: revocation_records (created if a hand-built DB lacks it) with
 * the revoked_after_seq cutoff column, and the persisted revocation ACK
 * store. Additive only: no existing row is changed.
 */
function ensureRevocationSchemaV9(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS revocation_records (
    revoked_device_id    TEXT NOT NULL,
    revoked_by_device_id TEXT NOT NULL,
    revoked_at_hlc       INTEGER NOT NULL,
    reason               TEXT,
    record_bytes         BLOB NOT NULL,
    signature            BLOB NOT NULL,
    verification_state   TEXT NOT NULL CHECK
                         (verification_state IN ('pending','valid','invalid')),
    received_at_hlc      INTEGER NOT NULL,
    revoked_after_seq    INTEGER,
    PRIMARY KEY (revoked_device_id, revoked_by_device_id, revoked_at_hlc))`);
  const cols = (
    db.prepare("PRAGMA table_info(revocation_records)").all() as Array<{ name: string }>
  ).map((c) => c.name);
  if (!cols.includes("revoked_after_seq")) {
    db.exec("ALTER TABLE revocation_records ADD COLUMN revoked_after_seq INTEGER");
  }
  db.exec(`CREATE TABLE IF NOT EXISTS revocation_acks (
    peer_device_id       TEXT NOT NULL,
    revoked_device_id    TEXT NOT NULL,
    revoked_by_device_id TEXT NOT NULL,
    revoked_at_hlc       INTEGER NOT NULL,
    acked_at             INTEGER NOT NULL,
    PRIMARY KEY (peer_device_id, revoked_device_id, revoked_by_device_id,
                 revoked_at_hlc))`);
}

/**
 * DC-28 §4.9 (P9) v10 schema piece + one-time data migration, shared by the
 * < 10 migration and the == v10 repair. Before DC-28 every display_name
 * held what PAIRING stored (S3: the peer's suggestion or the 12-character
 * id placeholder), never a user choice. So, only in the open that ADDS the
 * column:
 *   announced_name = display_name, when it passes §4.8 and is not a prefix
 *                    of the device id (the placeholder; §4.5 rule), else NULL
 *   display_name   = ""  (no nickname yet)
 * Idempotent: once the column exists this is a no-op, so a nickname set
 * after the migration is never moved or wiped by a later open. Returns
 * true when it migrated.
 */
export function ensurePeerNamesSchemaV10(db: Database.Database): boolean {
  const hasPeers =
    db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='peers'").get() !== undefined;
  if (!hasPeers) return false;
  const cols = (db.prepare("PRAGMA table_info(peers)").all() as Array<{ name: string }>).map(
    (c) => c.name,
  );
  if (cols.includes("announced_name")) return false;
  db.exec("ALTER TABLE peers ADD COLUMN announced_name TEXT");
  const rows = db.prepare("SELECT device_id, display_name FROM peers").all() as Array<{
    device_id: string;
    display_name: string | null;
  }>;
  const upd = db.prepare("UPDATE peers SET announced_name = ?, display_name = '' WHERE device_id = ?");
  for (const r of rows) {
    upd.run(announcedNameFromPeer(r.display_name, r.device_id).name, r.device_id);
  }
  return true;
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

export interface ChangeRow {
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

export function deserializeChangeRow(r: ChangeRow): ChangeRecord {
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
 * DC-03 §3.2a "stale": true when a change already stored here for the same
 * (entity_id, field_path) happened AFTER `record` (its causality clock covers
 * record's origin sequence). Applying `record` would roll the materialized row
 * back to an older value, which happens when a dependent change reaches this
 * device before the change it builds on. Causal order only; no timestamp is
 * compared (DC-03 §5). The record's own stored copy is excluded, so the same
 * rule serves live sync and the reminder history replay.
 */
export function isCausallyStale(db: Database.Database, record: ChangeRecord): boolean {
  const rows = db
    .prepare(
      "SELECT causality_clock FROM changes WHERE entity_id = ? AND field_path = ? AND change_id != ?",
    )
    .all(record.entity_id, record.field_path, record.change_id) as Array<{ causality_clock: string }>;
  for (const r of rows) {
    const clock = JSON.parse(r.causality_clock) as Record<string, number>;
    if ((clock[record.device_id] ?? 0) >= record.local_seq) return true;
  }
  return false;
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
  // Reminder members: only the causal stale rule (DC-03 §3.2a), nothing else.
  // Concurrent reminder edits are NOT detected (last arrival wins, TD-070).
  if (record.entity_type === "reminder") {
    return isCausallyStale(db, record) ? "stale" : "apply";
  }
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

/**
 * Result signal of an entity mutator. "target_absent": the change is an edit
 * or remove of an entity row that does not exist here. applyRemoteChangeDetailed
 * then decides by causal readiness (prerequisiteState): a prerequisite is not
 * applied yet -> hold (not applicable yet); one was skipped or quarantined ->
 * quarantine the change ("depends_on_quarantined_change"); otherwise count it
 * as done (history row, read position advances, no row write). Returning
 * nothing means the change was applied. A change that CREATES its target never
 * returns "target_absent".
 */
export type MutateResult = "target_absent" | void;
export type EntityMutator = (
  db: Database.Database,
  record: ChangeRecord,
) => MutateResult;

class NotApplicableYet extends Error {}
class QuarantineRequest extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

/** Quarantine reason for a duplicate (origin, seq) whose content differs from the stored copy. */
export const DUPLICATE_DIFFERENT_CONTENT_REASON = "duplicate_seq_different_content";
/** Quarantine reason: the change's target is gone and a prerequisite was skipped/quarantined here. */
export const DEPENDS_ON_QUARANTINED_REASON = "depends_on_quarantined_change";
/**
 * Visible notice (not a rejection): a change has been held for several
 * sessions because a prerequisite from another device never arrives. The
 * sequence number is NOT skipped; the change keeps being held and re-requested.
 */
export const WAITING_ON_CHANGE_REASON = "waiting_on_change";

export type ApplyOutcome = "applied" | "buffered" | "duplicate";
/**
 * ApplyOutcome plus: "not_applicable" (held: a prerequisite is not applied),
 * "quarantined" (the incoming record itself was quarantined),
 * "target_gone" (counted done: its target is absent, history stored, no row
 * write) and
 * "duplicate_different_content" (a duplicate (origin, seq) whose content
 * differs from the stored copy: detected and recorded, stored copy untouched).
 */
export type ApplyOutcomeDetailed =
  | ApplyOutcome
  | "not_applicable"
  | "quarantined"
  | "target_gone"
  | "duplicate_different_content";

/**
 * Compatibility wrapper: same as applyRemoteChangeDetailed, but a
 * not-applicable-yet result (only possible with a mutator that signals it)
 * throws, because this signature cannot express it. The sync engine and the
 * quarantine retry use applyRemoteChangeDetailed.
 */
export function applyRemoteChange(
  db: Database.Database,
  incoming: ChangeRecord,
  knowledge: KnowledgeState,
  mutate?: EntityMutator,
): ApplyOutcome {
  const out = applyRemoteChangeDetailed(db, incoming, knowledge, mutate);
  if (out === "not_applicable" || out === "quarantined") {
    throw new Error(
      `change ${incoming.device_id}#${incoming.local_seq} not applied (${out})`,
    );
  }
  if (out === "duplicate_different_content") return "duplicate";
  return out === "target_gone" ? "applied" : out;
}

/**
 * T2: dedupe / apply / buffer an incoming change atomically with
 * knowledge-state updates and element-wise-max clock merge.
 * Entity mutation callback runs inside the same transaction only for
 * records actually applied (including drained pending records).
 */
// ---------------------------------------------------------------------------
// Causal readiness (DC-02) — one rule for every entity type.
// ---------------------------------------------------------------------------

export interface PrerequisiteState {
  /** First origin whose needed seq is not applied/skipped here; null = all in. */
  missingOrigin: string | null;
  /** A needed seq of some origin is skipped or quarantined (not applied) here. */
  rejectedPrerequisite: boolean;
}

/**
 * What the change's causality clock covers: need[d] = clock[d] (for the
 * change's own origin: seq - 1); a removed device (accepted unpairing record
 * on THIS device) is only needed up to min(clock[d], its effective cutoff).
 * A seq counts as in when applied, or skipped (quarantined). Decided from
 * local state only.
 */
export function prerequisiteState(
  db: Database.Database,
  record: ChangeRecord,
  opts: { rejectionIgnoresOwnOrigin?: boolean } = {},
): PrerequisiteState {
  const cutoffs = revokedCutoffs(db);
  const appliedRow = db.prepare(
    "SELECT applied_through AS v FROM applied_upto WHERE producer_device_id = ?",
  );
  const heldRow = db.prepare("SELECT MAX(local_seq) AS v FROM changes WHERE device_id = ?");
  const skippedRow = db.prepare(
    "SELECT 1 FROM skipped_seqs WHERE producer_device_id = ? AND local_seq = ?",
  );
  let missingOrigin: string | null = null;
  const need = new Map<string, number>();
  for (const [origin, seq] of Object.entries(record.causality_clock)) {
    let n = origin === record.device_id ? record.local_seq - 1 : seq;
    const cutoff = cutoffs.get(origin);
    if (cutoff !== undefined) n = Math.min(n, cutoff);
    if (n > 0) need.set(origin, n);
  }
  if (!need.has(record.device_id) && record.local_seq > 1) {
    need.set(record.device_id, record.local_seq - 1);
  }
  for (const [origin, n] of need) {
    let covered = Math.max(
      (appliedRow.get(origin) as { v: number } | undefined)?.v ?? 0,
      (heldRow.get(origin) as { v: number | null }).v ?? 0,
    );
    while (covered < n && skippedRow.get(origin, covered + 1) !== undefined) covered++;
    if (covered < n && missingOrigin === null) missingOrigin = origin;
  }
  let rejected = false;
  if (missingOrigin === null) {
    for (const [origin, n] of need) {
      if (opts.rejectionIgnoresOwnOrigin && origin === record.device_id) continue;
      if (hasUnappliedRejectedSeq(db, origin, n)) {
        rejected = true;
        break;
      }
    }
  }
  return { missingOrigin, rejectedPrerequisite: rejected };
}

/** A seq of `origin` up to `upTo` is skipped or quarantined and not applied here. */
function hasUnappliedRejectedSeq(db: Database.Database, origin: string, upTo: number): boolean {
  if (
    db
      .prepare("SELECT 1 FROM skipped_seqs WHERE producer_device_id = ? AND local_seq <= ? LIMIT 1")
      .get(origin, upTo) !== undefined
  ) {
    return true;
  }
  const rows = db
    .prepare(
      `SELECT raw_record FROM quarantine
       WHERE quarantine_reason NOT IN (?, ?)
         AND CASE WHEN json_valid(raw_record)
                  THEN json_extract(raw_record, '$.device_id') END = ?`,
    )
    .all(DUPLICATE_DIFFERENT_CONTENT_REASON, WAITING_ON_CHANGE_REASON, origin) as Array<{
    raw_record: string;
  }>;
  for (const r of rows) {
    try {
      const raw = JSON.parse(r.raw_record) as { change_id?: unknown; local_seq?: unknown };
      if (typeof raw.local_seq !== "number" || raw.local_seq > upTo) continue;
      const cid = typeof raw.change_id === "string" ? raw.change_id : `${origin}:${raw.local_seq}`;
      if (db.prepare("SELECT 1 FROM changes WHERE change_id = ?").get(cid) === undefined) return true;
    } catch {
      /* unparsable: ignore */
    }
  }
  return false;
}

/** The origin whose change this record is waiting for (null when ready). */
export function missingPrerequisiteOrigin(
  db: Database.Database,
  record: ChangeRecord,
): string | null {
  return prerequisiteState(db, record).missingOrigin;
}

/** Resolve the visible "waiting" notice of (origin, seq), if any (it applied or was quarantined). */
function resolveWaitingNotice(
  db: Database.Database,
  origin: string,
  seq: number,
  why: string,
): void {
  db.prepare(
    `UPDATE quarantine SET resolved_at_hlc = ?, resolved_reason = ?
     WHERE quarantine_reason = ? AND resolved_at_hlc IS NULL
       AND json_extract(raw_record, '$.device_id') = ?
       AND json_extract(raw_record, '$.local_seq') = ?`,
  ).run(Date.now(), why, WAITING_ON_CHANGE_REASON, origin, seq);
}

/**
 * Create the visible "waiting on a change from device X" notice for a held
 * change (once per held (origin, seq) while unresolved). Does NOT skip the
 * seq and does not touch the held change.
 */
export function recordWaitingNotice(
  db: Database.Database,
  record: ChangeRecord,
  missingOrigin: string,
): void {
  const exists = db
    .prepare(
      `SELECT 1 FROM quarantine
       WHERE quarantine_reason = ? AND resolved_at_hlc IS NULL
         AND json_extract(raw_record, '$.device_id') = ?
         AND json_extract(raw_record, '$.local_seq') = ? LIMIT 1`,
    )
    .get(WAITING_ON_CHANGE_REASON, record.device_id, record.local_seq);
  if (exists !== undefined) return;
  db.prepare(
    `INSERT INTO quarantine (quarantine_reason, received_at_hlc, sender_device_id, raw_record)
     VALUES (?, ?, ?, ?)`,
  ).run(WAITING_ON_CHANGE_REASON, Date.now(), missingOrigin, JSON.stringify(record));
}

// ---------------------------------------------------------------------------
// Duplicate (origin, seq) with DIFFERENT content: detection only.
// ---------------------------------------------------------------------------

function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
    .join(",")}}`;
}

function contentKey(r: ChangeRecord): string {
  return canonicalJson([
    r.change_id,
    r.entity_id,
    r.entity_type,
    r.field_path,
    r.operation,
    r.payload,
    r.hlc_timestamp,
    r.causality_clock,
    r.schema_version,
  ]);
}

/**
 * True (and a quarantine row with its own reason code is written) when a
 * stored copy of the same (origin device, seq) exists with different content.
 * The stored copy is looked up in `changes` (applied) and `pending_changes`
 * (buffered). Where NO stored copy exists (skipped/quarantined seqs,
 * user-deleted rows, compacted history, snapshot-delivered state) nothing can
 * be compared and nothing is reported. The stored version is never touched.
 */
function recordIfDifferentDuplicate(
  db: Database.Database,
  incoming: ChangeRecord,
): boolean {
  let stored: ChangeRecord | undefined;
  const row = db
    .prepare(
      `SELECT change_id, device_id, local_seq, entity_id, entity_type,
              field_path, operation, payload, hlc_timestamp, causality_clock,
              schema_version
       FROM changes WHERE device_id = ? AND local_seq = ?`,
    )
    .get(incoming.device_id, incoming.local_seq) as
    | (Omit<ChangeRecord, "payload" | "causality_clock"> & {
        payload: string;
        causality_clock: string;
      })
    | undefined;
  if (row !== undefined) {
    stored = {
      ...row,
      payload: JSON.parse(row.payload),
      causality_clock: JSON.parse(row.causality_clock),
    } as ChangeRecord;
  } else {
    const pend = db
      .prepare(
        "SELECT record_payload FROM pending_changes WHERE device_id = ? AND local_seq = ?",
      )
      .get(incoming.device_id, incoming.local_seq) as
      | { record_payload: string }
      | undefined;
    if (pend !== undefined) stored = JSON.parse(pend.record_payload) as ChangeRecord;
  }
  if (stored === undefined) return false;
  if (contentKey(stored) === contentKey(incoming)) return false;
  quarantineRecord(db, {
    reason: DUPLICATE_DIFFERENT_CONTENT_REASON,
    senderDeviceId: incoming.device_id,
    rawRecord: incoming,
  });
  return true;
}

/** The origin's applied frontier (applied_upto), 0 when none. */
export function appliedFrontierOf(db: Database.Database, origin: string): number {
  return (
    (
      db
        .prepare("SELECT applied_through AS v FROM applied_upto WHERE producer_device_id = ?")
        .get(origin) as { v: number } | undefined
    )?.v ?? 0
  );
}

/**
 * Quarantine Retry of a change that was quarantined because a prerequisite
 * was rejected: the read position already passed its seq, so the normal
 * arrival path would call it a duplicate. Re-run the rule for real instead:
 * "applied" = history row + entity row written (or counted done) and the
 * skip row removed; "blocked" = still not applicable (nothing written);
 * "duplicate" = it is already stored.
 */
export function reapplyQuarantinedInPlace(
  db: Database.Database,
  record: ChangeRecord,
  mutate?: EntityMutator,
): "applied" | "blocked" | "duplicate" {
  class Blocked extends Error {}
  try {
    return db.transaction(() => {
      if (
        db.prepare("SELECT 1 FROM changes WHERE device_id = ? AND local_seq = ?").get(
          record.device_id,
          record.local_seq,
        ) !== undefined
      ) {
        return "duplicate" as const;
      }
      const det = detectAndRecordConflict(db, record);
      if (det === "apply") {
        const res = mutate?.(db, record);
        if (res === "target_absent") {
          const pre = prerequisiteState(db, record);
          if (pre.missingOrigin !== null || pre.rejectedPrerequisite) throw new Blocked();
        }
      }
      db.prepare(`
        INSERT INTO changes (change_id, device_id, local_seq, entity_id,
          entity_type, field_path, operation, payload, hlc_timestamp,
          causality_clock, schema_version)
        VALUES (@change_id, @device_id, @local_seq, @entity_id, @entity_type,
          @field_path, @operation, @payload, @hlc_timestamp, @causality_clock,
          @schema_version)`).run(serializeChange(record));
      recordEntityVersion(db, record);
      db.prepare("DELETE FROM skipped_seqs WHERE producer_device_id = ? AND local_seq = ?").run(
        record.device_id,
        record.local_seq,
      );
      for (const [d, sq] of Object.entries(record.causality_clock)) {
        db.prepare(
          `INSERT INTO device_clock (peer_device_id, max_seq) VALUES (?, ?)
           ON CONFLICT(peer_device_id) DO UPDATE SET max_seq = MAX(max_seq, excluded.max_seq)`,
        ).run(d, sq);
      }
      return "applied" as const;
    })();
  } catch (e) {
    if (e instanceof Blocked) return "blocked";
    throw e;
  }
}

export function applyRemoteChangeDetailed(
  db: Database.Database,
  incoming: ChangeRecord,
  knowledge: KnowledgeState,
  mutate?: EntityMutator,
): ApplyOutcomeDetailed {
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
        return recordIfDifferentDuplicate(db, incoming)
          ? ("duplicate_different_content" as const)
          : ("duplicate" as const);
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
      // Highest seq of `drained` that was really applied; null = none.
      let lastApplied: number | null = null;
      let quarantinedIncoming = false;
      let targetGone = false;
      let appliedAny = false;
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
        // Per-step savepoint: a change that cannot be applied yet rolls back
        // completely (conflict record, row write, history) and stops the
        // drain, so the frontier never passes it (DC-02 §4.4).
        try {
          db.transaction(() => {
            // Pkg5 (QA M-2): DC-03 §3 detection BEFORE mutating local state.
            //   "apply"    -> entity-row mutation runs (§3.2/§3.6, no conflict)
            //   "noop"     -> §3.1 identical-value convergence: no row write
            //   "stale"    -> §3.2a (v2): C is causally dominated by a local
            //                 participant — history + clocks advance but the
            //                 materialized row is NOT regressed
            //   "conflict" -> §3.3/§3.4: entity row NOT overwritten; the
            //                 conflict record was persisted above; history +
            //                 clocks below still advance.
            const det = detectAndRecordConflict(db, record);
            if (det === "apply") {
              const res = mutate?.(db, record);
              if (res === "target_absent") {
                // Target row missing: decide by causal readiness (DC-02).
                const pre = prerequisiteState(db, record);
                if (pre.missingOrigin !== null) throw new NotApplicableYet();
                if (pre.rejectedPrerequisite) {
                  throw new QuarantineRequest(DEPENDS_ON_QUARANTINED_REASON);
                }
                if (step === drained[0]) targetGone = true;
              }
            }
            insertChange.run(serializeChange(record));
            // Pkg1: durable version state rides the same T2 transaction (INV-1a).
            recordEntityVersion(db, record);
            deletePending.run(step.device_id, step.local_seq);
            resolveWaitingNotice(db, record.device_id, record.local_seq, "applied");
            clearHeld(db, record.device_id, record.local_seq);
          })();
        } catch (e) {
          if (e instanceof QuarantineRequest) {
            // Never applicable: quarantine (one row per origin+seq) and treat
            // the seq as resolved so the read position moves on. The savepoint
            // rolled back any row write; no history row exists for it.
            resolveWaitingNotice(db, record.device_id, record.local_seq, "quarantined");
            quarantineRecord(db, {
              reason: e.reason,
              senderDeviceId: record.device_id,
              rawRecord: record,
            });
            markSeqSkipped(db, record.device_id, record.local_seq);
            deletePending.run(step.device_id, step.local_seq);
            if (step === drained[0]) quarantinedIncoming = true;
            lastApplied = step.local_seq;
            continue;
          }
          if (!(e instanceof NotApplicableYet)) throw e;
          // The pending row of a blocked drained step is dropped so that the
          // seq is re-requested from the peer (neededRanges skips pending
          // seqs); later pending seqs stay buffered behind it.
          deletePending.run(step.device_id, step.local_seq);
          break;
        }
        lastApplied = step.local_seq;
        appliedAny = true;
      }
      if (lastApplied === null) {
        // Nothing applied: no history, no frontier move, no clock merge.
        dbKnowledge = loadKnowledgeFromDb(db);
        return "not_applicable" as const;
      }
      if (lastApplied !== drained[drained.length - 1]!.local_seq) {
        // Blocked part-way through a drained run: mirror the real DB state.
        dbKnowledge = loadKnowledgeFromDb(db);
      }
      setAppliedUpto.run(incoming.device_id, lastApplied);
      // TD-001 (4): the frontier advanced — skip rows at/below it are
      // resolved (quarantine diagnostic rows are NEVER touched).
      db.prepare(
        "DELETE FROM skipped_seqs WHERE producer_device_id = ? AND local_seq <= ?",
      ).run(incoming.device_id, lastApplied);
      if (!appliedAny) return "quarantined" as const; // no clock merge for a quarantined record
      mergeClocks(incoming.causality_clock);
      if (quarantinedIncoming) return "quarantined" as const;
      return targetGone ? ("target_gone" as const) : ("applied" as const);
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
      const different = db.transaction(() => {
        mergeClocks(incoming.causality_clock);
        return recordIfDifferentDuplicate(db, incoming);
      })();
      const fresh = loadKnowledgeFromDb(db);
      knowledge.appliedUpto = fresh.appliedUpto;
      knowledge.pending = fresh.pending;
      knowledge.skipped = fresh.skipped;
      return different ? "duplicate_different_content" : "duplicate";
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
      // A duplicate-different-content warning is deduped only against its own
      // kind (an earlier row of another reason for the same (origin, seq)
      // must not hide it); other reasons keep the one-row-per-seq rule, and
      // the visible "waiting" notice never counts as a quarantine of the seq.
      const sameKindOnly = opts.reason === DUPLICATE_DIFFERENT_CONTENT_REASON;
      const existing = db
        .prepare(
          `SELECT 1 FROM quarantine
           WHERE json_extract(raw_record, '$.device_id') = ?
             AND json_extract(raw_record, '$.local_seq') = ?
             AND quarantine_reason != ?
             AND (? = 0 OR quarantine_reason = ?)
           LIMIT 1`,
        )
        .get(deviceId, seq, WAITING_ON_CHANGE_REASON, sameKindOnly ? 1 : 0, DUPLICATE_DIFFERENT_CONTENT_REASON);
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
  clearHeld(db, producerDeviceId, localSeq); // a skipped seq is no longer held
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
/**
 * TD-007 (3), documented mismatch: despite its name, `resolved_at_hlc` stores
 * WALL-CLOCK epoch milliseconds (`Date.now()`), not an HLC timestamp. The
 * same holds for `quarantine.received_at_hlc` (see quarantineRecord). Both
 * values are informational (shown to the user, NULL-ness is the lifecycle
 * flag); nothing compares them with HLC values, and retention pruning orders
 * by quarantine_id, not by these timestamps. The column is deliberately NOT
 * renamed: a rename needs a schema migration for a purely cosmetic gain.
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
      [string],
      { quarantine_id: number; raw_record: string }
    >(
      // A duplicate-with-different-content warning is about a record whose
      // change_id IS in `changes` (the stored copy); it must not auto-resolve.
      "SELECT quarantine_id, raw_record FROM quarantine WHERE resolved_at_hlc IS NULL AND quarantine_reason != ?",
    )
    .all(DUPLICATE_DIFFERENT_CONTENT_REASON);
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
    // Exempt from the cap: the visible record of a user skip ("user_deleted"),
    // every row whose raw record cannot be read, and every row that is still a
    // rejection proof for the prerequisite rule: a record marked retried whose
    // change was never applied (its seq stays skipped), so removing it would
    // flip a quarantine decision to "counted done". Active rows are never
    // pruned. Rows resolved because their change was applied, and
    // warnings/notices, are prunable.
    const prunable = `resolved_at_hlc IS NOT NULL
           AND COALESCE(resolved_reason, '') != 'user_deleted'
           AND json_valid(raw_record)
           AND NOT (COALESCE(resolved_reason, '') = 'retried_by_user'
                    AND quarantine_reason NOT IN (?, ?)
                    AND NOT EXISTS (SELECT 1 FROM changes c
                                    WHERE c.change_id = json_extract(raw_record, '$.change_id')))`;
    const info = db
      .prepare(
        `DELETE FROM quarantine
         WHERE ${prunable}
           AND quarantine_id NOT IN (
             SELECT quarantine_id FROM quarantine
             WHERE ${prunable}
             ORDER BY quarantine_id DESC LIMIT ?)`,
      )
      .run(DUPLICATE_DIFFERENT_CONTENT_REASON, WAITING_ON_CHANGE_REASON, DUPLICATE_DIFFERENT_CONTENT_REASON, WAITING_ON_CHANGE_REASON, cap);
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

/**
 * Dismiss a duplicate-content warning: hide the warning row and nothing else.
 * No skip row is written and no change, pending row, applied position or hold
 * counter is touched. Only warning rows are accepted.
 */
export function dismissQuarantineWarning(
  db: Database.Database,
  quarantineId: number,
): { ok: boolean } {
  const row = db
    .prepare("SELECT quarantine_reason FROM quarantine WHERE quarantine_id = ?")
    .get(quarantineId) as { quarantine_reason: string } | undefined;
  if (!row) throw new Error(`quarantine row ${quarantineId} not found`);
  if (row.quarantine_reason !== DUPLICATE_DIFFERENT_CONTENT_REASON) {
    throw new Error("only a duplicate-content warning can be dismissed");
  }
  markQuarantineResolved(db, quarantineId, "dismissed_by_user"); // idempotent
  return { ok: true };
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
      { raw_record: string; resolved_at_hlc: number | null; quarantine_reason: string }
    >(
      "SELECT raw_record, resolved_at_hlc, quarantine_reason FROM quarantine WHERE quarantine_id = ?",
    )
    .get(quarantineId);
  if (!row) throw new Error(`quarantine row ${quarantineId} not found`);
  if (row.quarantine_reason === DUPLICATE_DIFFERENT_CONTENT_REASON) {
    // A warning row never reaches the skip path: skipping would drop the
    // stored copy it is about. Warnings are only dismissed.
    throw new Error("a warning cannot be skipped; use dismiss_quarantine_warning");
  }

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
        // The user skipped a change: this device now deliberately differs.
        // The row stays as resolved "user_deleted" (visible in the list).
        console.warn(
          `[tide][sync] change ${producer}#${seq} skipped on this device by the user; it will not be applied here`,
        );
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

const HARD_BLOCK_LOOKUP_SQL =
  "SELECT 1 FROM hard_blocks WHERE producer_device_id = ?";

/** Is this producer currently hard-blocked (durable, NOT self-clearing)? */
export function isHardBlocked(
  db: Database.Database,
  producerDeviceId: string,
): boolean {
  return !!db.prepare(HARD_BLOCK_LOOKUP_SQL).get(producerDeviceId);
}

/**
 * TD-007 (1): same lookup as {@link isHardBlocked}, with the statement
 * prepared ONCE. The sync engine's intake gate runs this for every arriving
 * record, so it keeps one checker per engine instead of re-preparing the SQL
 * per record. The query still runs against the durable table on every call,
 * so a block or an unblock is seen by the very next record.
 */
export function makeHardBlockCheck(
  db: Database.Database,
): (producerDeviceId: string) => boolean {
  const stmt = db.prepare(HARD_BLOCK_LOOKUP_SQL);
  return (producerDeviceId) => !!stmt.get(producerDeviceId);
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
