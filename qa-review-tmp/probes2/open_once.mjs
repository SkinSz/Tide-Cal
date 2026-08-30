// src/persistence/database.ts
import Database from "better-sqlite3";

// src/persistence/schema.ts
var SCHEMA_VERSION = 6;
var DDL = `
CREATE TABLE calendars (
    calendar_id   TEXT PRIMARY KEY,
    title         TEXT NOT NULL,
    color         TEXT,
    created_hlc   INTEGER NOT NULL,
    updated_hlc   INTEGER NOT NULL
);

CREATE TABLE events (
    event_id      TEXT PRIMARY KEY,
    calendar_id   TEXT NOT NULL REFERENCES calendars(calendar_id),
    title         TEXT NOT NULL,
    description   TEXT NOT NULL DEFAULT '',
    all_day       INTEGER NOT NULL CHECK (all_day IN (0, 1)),
    start_date    TEXT,
    end_date      TEXT,
    start_wall    TEXT,
    end_wall      TEXT,
    tz_id         TEXT,
    utc_start_ms  INTEGER,
    utc_end_ms    INTEGER,
    created_hlc   INTEGER NOT NULL,
    updated_hlc   INTEGER NOT NULL,
    CHECK ((all_day = 1 AND start_date IS NOT NULL AND end_date IS NOT NULL
               AND start_wall IS NULL AND end_wall IS NULL AND tz_id IS NULL)
        OR (all_day = 0 AND start_wall IS NOT NULL AND end_wall IS NOT NULL
               AND tz_id IS NOT NULL AND start_date IS NULL
               AND end_date IS NULL))
);

CREATE TABLE series (
    series_id         TEXT PRIMARY KEY,
    base_event_id     TEXT NOT NULL UNIQUE REFERENCES events(event_id),
    recurrence_rule   TEXT NOT NULL,
    created_hlc       INTEGER NOT NULL,
    updated_hlc       INTEGER NOT NULL
);

CREATE TABLE occurrence_overrides (
    series_id     TEXT NOT NULL REFERENCES series(series_id),
    recurrence_id TEXT NOT NULL,
    cancelled     INTEGER NOT NULL DEFAULT 0 CHECK (cancelled IN (0,1)),
    title         TEXT,
    start_wall    TEXT,
    end_wall      TEXT,
    tz_id         TEXT,
    utc_start_ms  INTEGER,
    utc_end_ms    INTEGER,
    updated_hlc   INTEGER NOT NULL,
    PRIMARY KEY (series_id, recurrence_id)
);

CREATE TABLE reminders (
    member_id       TEXT PRIMARY KEY,
    entity_id       TEXT NOT NULL,
    collection_path TEXT NOT NULL DEFAULT 'reminders',
    minutes_before  INTEGER NOT NULL CHECK (minutes_before >= 0),
    updated_hlc     INTEGER NOT NULL,
    UNIQUE (entity_id, collection_path, member_id)
);

CREATE TABLE attendees (
    member_id       TEXT PRIMARY KEY,
    entity_id       TEXT NOT NULL,
    collection_path TEXT NOT NULL DEFAULT 'attendees',
    display_name    TEXT,
    role            TEXT,
    updated_hlc     INTEGER NOT NULL,
    UNIQUE (entity_id, collection_path, member_id)
);

CREATE TABLE entities_tombstones (
    entity_id          TEXT NOT NULL,
    entity_type        TEXT NOT NULL CHECK (entity_type IN
                           ('calendar','event','series','occurrence_override')),
    producer_device_id TEXT NOT NULL,
    seq                INTEGER NOT NULL,
    causality_clock    TEXT NOT NULL,
    deleted_at_hlc     INTEGER NOT NULL,
    PRIMARY KEY (entity_id, producer_device_id, seq)
);

CREATE TABLE member_tombstones (
    entity_id          TEXT NOT NULL,
    collection_path    TEXT NOT NULL,
    member_id          TEXT NOT NULL,
    producer_device_id TEXT NOT NULL,
    seq                INTEGER NOT NULL,
    causality_clock    TEXT NOT NULL,
    PRIMARY KEY (entity_id, collection_path, member_id, producer_device_id, seq)
);

CREATE TABLE changes (
    change_id       TEXT PRIMARY KEY,
    device_id       TEXT NOT NULL,
    local_seq       INTEGER NOT NULL CHECK (local_seq > 0),
    entity_id       TEXT NOT NULL,
    entity_type     TEXT NOT NULL CHECK (entity_type IN
                        ('calendar','event','series','occurrence_override',
                         'reminder','tombstone-marker')),
    field_path      TEXT NOT NULL,
    operation       TEXT NOT NULL CHECK (operation IN
                        ('set','remove','member_add','member_update',
                         'member_remove')),
    payload         TEXT NOT NULL,
    hlc_timestamp   INTEGER NOT NULL,
    causality_clock TEXT NOT NULL,
    schema_version  INTEGER NOT NULL DEFAULT 1,
    UNIQUE (device_id, local_seq)
);

CREATE TABLE entity_versions (
    -- Pkg1 (QA C-1): durable per-entity version state. The entity's version
    -- vector and latest-producer identity were previously derivable ONLY by
    -- aggregating the changes log; DC-06 compaction deletes those records,
    -- which collapsed live entities to an empty version clock and made the DC-09
    -- snapshot pipeline omit / absence-tombstone them. This table is STATE
    -- (mirrors what the deleted history represented), not history: sweep()
    -- never touches it.
    entity_id          TEXT PRIMARY KEY,
    entity_type        TEXT NOT NULL,
    version            TEXT NOT NULL, -- JSON VectorClock: element-wise max of causality_clocks over all changes applied to the entity
    latest_producer    TEXT NOT NULL, -- producer of the latest contributing change
    latest_seq         INTEGER NOT NULL,
    latest_hlc         INTEGER NOT NULL,
    updated_hlc        INTEGER NOT NULL
);

CREATE TABLE device_clock (
    peer_device_id TEXT PRIMARY KEY,
    max_seq        INTEGER NOT NULL CHECK (max_seq > 0)
);

CREATE TABLE applied_upto (
    producer_device_id TEXT PRIMARY KEY,
    applied_through    INTEGER NOT NULL CHECK (applied_through >= 0)
);

CREATE TABLE pending_changes (
    device_id       TEXT NOT NULL,
    local_seq       INTEGER NOT NULL CHECK (local_seq > 0),
    record_payload  TEXT NOT NULL,
    received_at_hlc INTEGER NOT NULL,
    PRIMARY KEY (device_id, local_seq)
);

CREATE TABLE conflicts (
    conflict_id      TEXT PRIMARY KEY,
    entity_id        TEXT NOT NULL,
    field_path       TEXT NOT NULL,
    status           TEXT NOT NULL CHECK (status IN
                         ('unresolved','resolved_keep_local',
                          'resolved_keep_incoming','resolved_custom',
                          'obsolete')),
    detected_at_hlc  INTEGER NOT NULL,
    resolved_value   TEXT,
    resolved_at_hlc  INTEGER,
    CHECK ((status = 'unresolved' AND resolved_value IS NULL AND resolved_at_hlc IS NULL)
        OR (status LIKE 'resolved_%')
        OR (status = 'obsolete'))
);

CREATE TABLE conflict_participants (
    conflict_id     TEXT NOT NULL REFERENCES conflicts(conflict_id),
    change_id       TEXT NOT NULL,
    device_id       TEXT NOT NULL,
    local_seq       INTEGER NOT NULL,
    causality_clock TEXT NOT NULL,
    payload         TEXT NOT NULL,
    PRIMARY KEY (conflict_id, change_id)
);

CREATE TABLE peers (
    device_id        TEXT PRIMARY KEY,
    public_key       BLOB NOT NULL,
    display_name     TEXT NOT NULL,
    paired_at        INTEGER NOT NULL,
    status           TEXT NOT NULL CHECK (status IN ('trusted','revoked')),
    last_known_clock TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE revocation_records (
    revoked_device_id    TEXT NOT NULL,
    revoked_by_device_id TEXT NOT NULL,
    revoked_at_hlc       INTEGER NOT NULL,
    reason               TEXT,
    record_bytes         BLOB NOT NULL,
    signature            BLOB NOT NULL,
    verification_state   TEXT NOT NULL CHECK
                         (verification_state IN ('pending','valid','invalid')),
    received_at_hlc      INTEGER NOT NULL,
    PRIMARY KEY (revoked_device_id, revoked_by_device_id, revoked_at_hlc)
);

CREATE TABLE quarantine (
    quarantine_id     INTEGER PRIMARY KEY AUTOINCREMENT,
    quarantine_reason TEXT NOT NULL,
    received_at_hlc   INTEGER NOT NULL,
    sender_device_id  TEXT NOT NULL,
    raw_record        TEXT NOT NULL,
    -- TD-005 lifecycle: NULL = still active. Rows are NEVER deleted;
    -- resolution is archival, written only when the record applies.
    resolved_at_hlc   INTEGER,
    resolved_reason   TEXT
);

-- TD-001: producer seqs that were quarantined and are thereby resolved for
-- sequence progress. One row per (producer, seq); compaction: rows <= the
-- producer's applied_upto are GC'd on frontier advance.
CREATE TABLE skipped_seqs (
    producer_device_id TEXT NOT NULL,
    local_seq          INTEGER NOT NULL CHECK (local_seq > 0),
    PRIMARY KEY (producer_device_id, local_seq)
);

-- TD-006 / DC-16 \xA72.4 Tier 2: DURABLE hard block (NOT self-clearing).
-- Survives restart; removed ONLY by explicit user Unblock (\xA74.2) or
-- unpair/revocation. While a row exists, intake drops everything from that
-- producer before validation/parsing.
CREATE TABLE hard_blocks (
    producer_device_id TEXT PRIMARY KEY,
    first_triggered_at INTEGER NOT NULL,
    last_triggered_at  INTEGER NOT NULL,
    trigger_count      INTEGER NOT NULL CHECK (trigger_count > 0)
);

-- TD-006 / DC-16 \xA72.3: small durable per-producer tally (total invalid +
-- last-seen). Informs UI history across restarts ONLY; it NEVER triggers
-- blocking on its own \u2014 thresholds on the live in-memory window decide.
CREATE TABLE peer_invalid_tally (
    producer_device_id TEXT PRIMARY KEY,
    total_invalid      INTEGER NOT NULL CHECK (total_invalid >= 0),
    last_invalid_at    INTEGER NOT NULL
);

CREATE TABLE quarantine_prune_stats (
    id            INTEGER PRIMARY KEY CHECK (id = 1),
    total_pruned  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE identity (
    singleton  INTEGER PRIMARY KEY CHECK (singleton = 1),
    device_id  TEXT NOT NULL,
    public_key BLOB NOT NULL
);

CREATE TABLE schema_version (
    version        INTEGER PRIMARY KEY CHECK (version > 0),
    applied_at_hlc INTEGER NOT NULL
);

CREATE INDEX idx_changes_device_seq ON changes(device_id, local_seq);
CREATE INDEX idx_changes_entity ON changes(entity_id, field_path);
CREATE INDEX idx_etomb_producer_seq ON entities_tombstones(producer_device_id, seq);
CREATE INDEX idx_mtomb_producer_seq ON member_tombstones(producer_device_id, seq);
CREATE INDEX idx_conflicts_status ON conflicts(status, detected_at_hlc);
CREATE INDEX idx_cparticipants_change ON conflict_participants(change_id);
CREATE INDEX idx_events_calendar ON events(calendar_id, utc_start_ms);
CREATE INDEX idx_overrides_series ON occurrence_overrides(series_id);
`;

// src/sync/change_record.ts
function changeId(deviceId, localSeq) {
  return `${deviceId}:${localSeq}`;
}

// src/persistence/database.ts
function openDatabase(opts) {
  const db = new Database(opts.path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  initializeSchema(db);
  return db;
}
function initializeSchema(db) {
  let row;
  try {
    row = db.prepare("SELECT version FROM schema_version").get();
  } catch {
    row = void 0;
  }
  if (row === void 0) {
    const tx = db.transaction(() => {
      db.exec(DDL);
      db.prepare(
        "INSERT INTO schema_version (version, applied_at_hlc) VALUES (?, ?)"
      ).run(SCHEMA_VERSION, Date.now());
    });
    tx();
  } else if (row.version > SCHEMA_VERSION) {
    throw new Error(
      `database schema_version ${row.version} newer than supported ${SCHEMA_VERSION}`
    );
  } else if (row.version < SCHEMA_VERSION) {
    const tx = db.transaction(() => {
      if (row.version < 2) {
        db.exec(`CREATE TABLE IF NOT EXISTS skipped_seqs (
          producer_device_id TEXT NOT NULL,
          local_seq          INTEGER NOT NULL CHECK (local_seq > 0),
          PRIMARY KEY (producer_device_id, local_seq))`);
      }
      if (row.version < 3) {
        const cols = db.prepare("PRAGMA table_info(quarantine)").all().map((c) => c.name);
        if (!cols.includes("resolved_at_hlc")) {
          db.exec("ALTER TABLE quarantine ADD COLUMN resolved_at_hlc INTEGER");
        }
        if (!cols.includes("resolved_reason")) {
          db.exec("ALTER TABLE quarantine ADD COLUMN resolved_reason TEXT");
        }
      }
      if (row.version < 4) {
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
      if (row.version < 5) {
        db.exec(`CREATE TABLE IF NOT EXISTS quarantine_prune_stats (
          id            INTEGER PRIMARY KEY CHECK (id = 1),
          total_pruned  INTEGER NOT NULL DEFAULT 0)`);
      }
      if (row.version < 6) {
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
      db.prepare("UPDATE schema_version SET version = ?").run(SCHEMA_VERSION);
    });
    tx();
  }
}
function backfillEntityVersions(db) {
  const rows = db.prepare(
    "SELECT entity_id, entity_type, causality_clock, device_id, local_seq, hlc_timestamp FROM changes ORDER BY hlc_timestamp ASC, local_seq ASC"
  ).all();
  for (const r of rows) {
    recordEntityVersion(db, {
      change_id: changeId(r.device_id, r.local_seq),
      device_id: r.device_id,
      local_seq: r.local_seq,
      entity_id: r.entity_id,
      entity_type: r.entity_type,
      field_path: "",
      operation: "set",
      payload: {},
      hlc_timestamp: r.hlc_timestamp,
      causality_clock: JSON.parse(r.causality_clock),
      schema_version: 1
    });
  }
}
function recordEntityVersion(db, record) {
  const get = db.prepare(
    "SELECT version, latest_hlc, latest_seq, latest_producer FROM entity_versions WHERE entity_id = ?"
  );
  const existing = get.get(record.entity_id);
  let version = existing ? JSON.parse(existing.version) : {};
  version = mergeClocks(version, record.causality_clock);
  let producer = existing?.latest_producer ?? record.device_id;
  let seq = existing?.latest_seq ?? record.local_seq;
  let hlc = existing?.latest_hlc ?? record.hlc_timestamp;
  if (record.hlc_timestamp > hlc || record.hlc_timestamp === hlc && record.local_seq > seq) {
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
    record.hlc_timestamp
  );
}
function mergeClocks(a, b) {
  const out = { ...a };
  for (const [d, s] of Object.entries(b)) {
    out[d] = Math.max(out[d] ?? 0, s);
  }
  return out;
}

// qa-review-tmp/probes2/open_once.ts
var path = process.argv[2];
console.log(`READY ${process.pid}`);
if (process.platform !== "win32") process.stdin.resume();
var buf = "";
process.stdin.on("data", (d) => {
  buf += d.toString();
  if (buf.includes("go")) {
    const db = openDatabase({ path });
    const v = db.prepare("SELECT version v FROM schema_version").get().v;
    console.log(`MIGRATED v=${v}`);
    db.close();
    process.exit(0);
  }
});
