// src/persistence/bridges/sidecar_server.ts
import { createInterface } from "node:readline";

// src/persistence/bridges/event_core.ts
import { randomUUID as randomUUID2 } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

// src/persistence/database.ts
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

// src/persistence/schema.ts
var SCHEMA_VERSION = 7;
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
-- DC-22 \xA72.4/D5: disabled reminders are STORED but INACTIVE (replicate,
-- merge, show in UI; never scheduled). NULL/1 = active; 0 = disabled.
ALTER TABLE reminders ADD COLUMN enabled INTEGER CHECK (enabled IN (0, 1));

-- DC-22 \xA75.4/D2: per-event day-before reminder time for all-day events
-- ("HH:MM"). NULL = reminder not configured (opt-in per event, no default).
ALTER TABLE events ADD COLUMN all_day_reminder_time TEXT;

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
    last_known_clock TEXT NOT NULL DEFAULT '{}',
    last_endpoint_host TEXT,
    last_endpoint_port INTEGER,
    last_endpoint_seen INTEGER
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
var ChangeRecordError = class extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = "ChangeRecordError";
  }
  code;
};
var OPERATIONS = [
  "set",
  "remove",
  "member_add",
  "member_update",
  "member_remove"
];
var ENTITY_TYPES = [
  "calendar",
  "event",
  "series",
  "occurrence_override",
  "reminder",
  "tombstone-marker"
];
function validateChangeRecord(r) {
  if (typeof r !== "object" || r === null) {
    throw new ChangeRecordError("missing_field", "record is not an object");
  }
  const rec = r;
  for (const key of [
    "change_id",
    "device_id",
    "entity_id",
    "field_path"
  ]) {
    if (typeof rec[key] !== "string" || rec[key].length === 0) {
      throw new ChangeRecordError("missing_field", `invalid ${key}`);
    }
  }
  if (typeof rec.local_seq !== "number" || !Number.isInteger(rec.local_seq) || rec.local_seq <= 0) {
    throw new ChangeRecordError("bad_seq", "local_seq must be a positive integer");
  }
  if (typeof rec.operation !== "string" || !OPERATIONS.includes(rec.operation)) {
    throw new ChangeRecordError("bad_operation", `invalid operation ${String(rec.operation)}`);
  }
  if (typeof rec.entity_type !== "string" || !ENTITY_TYPES.includes(rec.entity_type)) {
    throw new ChangeRecordError("bad_entity_type", `invalid entity_type ${String(rec.entity_type)}`);
  }
  const cc = rec.causality_clock;
  if (typeof cc !== "object" || cc === null || Array.isArray(cc)) {
    throw new ChangeRecordError("missing_field", "causality_clock must be an object");
  }
  for (const [k, v] of Object.entries(cc)) {
    if (typeof k !== "string" || typeof v !== "number" || !Number.isInteger(v) || v < 0) {
      throw new ChangeRecordError("missing_field", `causality_clock[${k}] invalid`);
    }
  }
  if (typeof rec.hlc_timestamp !== "number" || !Number.isFinite(rec.hlc_timestamp)) {
    throw new ChangeRecordError("missing_field", "hlc_timestamp must be a finite number");
  }
  {
    const stack = [rec.payload];
    while (stack.length > 0) {
      const cur = stack.pop();
      if (typeof cur === "number" && !Number.isFinite(cur)) {
        throw new ChangeRecordError(
          "missing_field",
          "payload contains a non-finite number (NaN/Infinity from 1e999-style JSON overflow)"
        );
      }
      if (Array.isArray(cur)) {
        stack.push(...cur);
      } else if (typeof cur === "object" && cur !== null) {
        stack.push(...Object.values(cur));
      }
    }
  }
  const expected = changeId(rec.device_id, rec.local_seq);
  if (rec.change_id !== expected) {
    throw new ChangeRecordError("id_mismatch", `change_id ${rec.change_id} != ${expected}`);
  }
  return Object.freeze({ ...rec });
}

// src/sync/vector_clock.ts
function get(clock, deviceId) {
  return clock[deviceId] ?? 0;
}
function dominates(a, b) {
  for (const d of Object.keys(b)) {
    if (get(a, d) < b[d]) return false;
  }
  return true;
}
function equalClocks(a, b) {
  const keys = /* @__PURE__ */ new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const d of keys) {
    if (get(a, d) !== get(b, d)) return false;
  }
  return true;
}
function sameOrDescendant(xClock, xProducer, yClock, yProducer) {
  return dominates(xClock, yClock) && get(xClock, yProducer.device_id) >= yProducer.local_seq;
}
function concurrent(a, b) {
  return !dominates(a, b) && !dominates(b, a);
}
function merge(a, b) {
  const out = { ...a };
  for (const [d, s] of Object.entries(b)) {
    out[d] = Math.max(get(out, d), s);
  }
  return out;
}
function advanceByMerge(target, incoming) {
  for (const [d, s] of Object.entries(incoming)) {
    target[d] = Math.max(get(target, d), s);
  }
}

// src/sync/conflict_detection.ts
function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) {
    return false;
  }
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every(
    (k) => deepEqual(a[k], b[k])
  );
}
function effectiveValue(c) {
  switch (c.operation) {
    case "set":
      return { deleted: false, value: c.payload.value };
    case "remove":
      return { deleted: true, value: void 0 };
    case "member_add":
    case "member_update":
      return { deleted: false, value: c.payload };
    case "member_remove":
      return { deleted: true, value: void 0 };
  }
}
function valuesDiffer(a, b) {
  const va = effectiveValue(a);
  const vb = effectiveValue(b);
  if (va.deleted !== vb.deleted) return true;
  return !deepEqual(va.value, vb.value);
}
function detect(incoming, localCurrent, locals) {
  const v = effectiveValue(incoming);
  if (v.deleted && localCurrent.deleted || !v.deleted && !localCurrent.deleted && deepEqual(v.value, localCurrent.value)) {
    return { kind: "noop" };
  }
  const dominated = locals.some(
    (l) => sameOrDescendant(
      l.causality_clock,
      { device_id: l.device_id, local_seq: l.local_seq },
      incoming.causality_clock,
      { device_id: incoming.device_id, local_seq: incoming.local_seq }
    ) && !equalClocks(l.causality_clock, incoming.causality_clock)
  );
  if (dominated) {
    return { kind: "stale" };
  }
  const conflicting = locals.filter((l) => concurrent(incoming.causality_clock, l.causality_clock));
  if (conflicting.length === 0) {
    return { kind: "apply" };
  }
  const differing = conflicting.filter((l) => valuesDiffer(incoming, l));
  if (differing.length === 0) {
    return { kind: "apply" };
  }
  return { kind: "conflict", conflicting: differing };
}

// src/sync/knowledge_state.ts
function emptyKnowledge() {
  return { appliedUpto: {}, pending: /* @__PURE__ */ new Map() };
}
function appliedThrough(k, deviceId) {
  return k.appliedUpto[deviceId] ?? 0;
}
function skippedOf(k, deviceId) {
  return k.skipped?.get(deviceId) ?? /* @__PURE__ */ new Set();
}
function nextExpected(k, deviceId) {
  let s = appliedThrough(k, deviceId) + 1;
  const skipped = skippedOf(k, deviceId);
  while (skipped.has(s)) s += 1;
  return s;
}
function classifyArrival(k, deviceId, localSeq) {
  const through = appliedThrough(k, deviceId);
  if (skippedOf(k, deviceId).has(localSeq)) return "duplicate";
  if (localSeq <= through) return "duplicate";
  if (localSeq === nextExpected(k, deviceId)) return "apply";
  return k.pending.get(deviceId)?.has(localSeq) === true ? "duplicate" : "buffer";
}
function advanceApplied(k, deviceId, localSeq) {
  const drained = [];
  if (localSeq !== nextExpected(k, deviceId)) return drained;
  let next = localSeq;
  const skipped = skippedOf(k, deviceId);
  drained.push({ device_id: deviceId, local_seq: localSeq });
  const pend = k.pending.get(deviceId);
  while (pend?.has(next + 1) && !skipped.has(next + 1)) {
    next += 1;
    pend.delete(next);
    drained.push({ device_id: deviceId, local_seq: next });
  }
  if (pend && pend.size === 0) k.pending.delete(deviceId);
  k.appliedUpto[deviceId] = next;
  if (k.skipped?.has(deviceId)) {
    const set = k.skipped.get(deviceId);
    for (const s of [...set]) {
      if (s <= next) set.delete(s);
    }
    if (set.size === 0) k.skipped.delete(deviceId);
  }
  return drained;
}
function neededRanges(k, advertised, selfDeviceId) {
  const need = [];
  for (const [d, advSeq] of Object.entries(advertised)) {
    if (selfDeviceId !== void 0 && d === selfDeviceId) continue;
    const have = appliedThrough(k, d);
    if (advSeq <= have) continue;
    const havePending = k.pending.get(d) ?? /* @__PURE__ */ new Set();
    const haveSkipped = skippedOf(k, d);
    let lo = have + 1;
    for (let s = have + 1; s <= advSeq + 1; s++) {
      if (s === advSeq + 1 || havePending.has(s) || haveSkipped.has(s)) {
        if (lo < s) need.push({ device_id: d, lo, hi: s - 1 });
        lo = s + 1;
      }
    }
  }
  return need;
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
  } else if (row.version === SCHEMA_VERSION) {
    const remCols = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='reminders'").get() !== void 0 ? db.prepare("PRAGMA table_info(reminders)").all().map((c) => c.name) : [];
    if (remCols.length > 0 && !remCols.includes("enabled")) {
      const tx = db.transaction(() => {
        db.exec("ALTER TABLE reminders ADD COLUMN enabled INTEGER CHECK (enabled IN (0, 1))");
      });
      tx();
    }
    const evCols = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='events'").get() !== void 0 ? db.prepare("PRAGMA table_info(events)").all().map((c) => c.name) : [];
    if (evCols.length > 0 && !evCols.includes("all_day_reminder_time")) {
      const tx = db.transaction(() => {
        db.exec("ALTER TABLE events ADD COLUMN all_day_reminder_time TEXT");
      });
      tx();
    }
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
      if (row.version < 7) {
        const cols = db.prepare("PRAGMA table_info(peers)").all().map((c) => c.name);
        if (!cols.includes("last_endpoint_host")) {
          db.exec("ALTER TABLE peers ADD COLUMN last_endpoint_host TEXT");
        }
        if (!cols.includes("last_endpoint_port")) {
          db.exec("ALTER TABLE peers ADD COLUMN last_endpoint_port INTEGER");
        }
        if (!cols.includes("last_endpoint_seen")) {
          db.exec("ALTER TABLE peers ADD COLUMN last_endpoint_seen INTEGER");
        }
        const remCols = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='reminders'").get() !== void 0 ? db.prepare("PRAGMA table_info(reminders)").all().map((c) => c.name) : [];
        if (remCols.length > 0 && !remCols.includes("enabled")) {
          db.exec("ALTER TABLE reminders ADD COLUMN enabled INTEGER CHECK (enabled IN (0, 1))");
        }
        const evCols = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='events'").get() !== void 0 ? db.prepare("PRAGMA table_info(events)").all().map((c) => c.name) : [];
        if (evCols.length > 0 && !evCols.includes("all_day_reminder_time")) {
          db.exec("ALTER TABLE events ADD COLUMN all_day_reminder_time TEXT");
        }
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
  const get2 = db.prepare(
    "SELECT version, latest_hlc, latest_seq, latest_producer FROM entity_versions WHERE entity_id = ?"
  );
  const existing = get2.get(record.entity_id);
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
function createLocalChange(db, selfDeviceId, input, mutate) {
  const insertChange = db.prepare(`
    INSERT INTO changes (change_id, device_id, local_seq, entity_id,
      entity_type, field_path, operation, payload, hlc_timestamp,
      causality_clock, schema_version)
    VALUES (@change_id, @device_id, @local_seq, @entity_id, @entity_type,
      @field_path, @operation, @payload, @hlc_timestamp, @causality_clock,
      @schema_version)`);
  const upsertClock = db.prepare(`
    INSERT INTO device_clock (peer_device_id, max_seq) VALUES (@d, @s)
    ON CONFLICT(peer_device_id) DO UPDATE SET
      max_seq = MAX(max_seq, excluded.max_seq)`);
  let record;
  const tx = db.transaction(() => {
    const storedClock = getDeviceClock(db);
    const nextSeq = Math.max(storedClock[selfDeviceId] ?? 0, getNextLocalSeq(db, selfDeviceId)) + 1;
    const clock = { ...storedClock, [selfDeviceId]: nextSeq };
    record = {
      change_id: changeId(selfDeviceId, nextSeq),
      device_id: selfDeviceId,
      local_seq: nextSeq,
      entity_id: input.entity_id,
      entity_type: input.entity_type,
      field_path: input.field_path,
      operation: input.operation,
      payload: input.payload,
      hlc_timestamp: input.hlc_now(),
      causality_clock: clock,
      schema_version: 1
    };
    mutate?.(db, record);
    insertChange.run(serializeChange(record));
    recordEntityVersion(db, record);
    upsertClock.run({ d: selfDeviceId, s: nextSeq });
  });
  tx();
  return record;
}
function serializeChange(r) {
  return {
    ...r,
    payload: JSON.stringify(r.payload),
    causality_clock: JSON.stringify(r.causality_clock)
  };
}
function getNextLocalSeq(db, deviceId) {
  const row = db.prepare(
    "SELECT MAX(local_seq) AS m FROM changes WHERE device_id = ?"
  ).get(deviceId);
  return row?.m ?? 0;
}
function getDeviceClock(db) {
  const rows = db.prepare(
    "SELECT peer_device_id, max_seq FROM device_clock"
  ).all();
  const clock = {};
  for (const r of rows) clock[r.peer_device_id] = r.max_seq;
  return clock;
}
function eventRowLocalValue(db, entityId, fieldPath) {
  const row = db.prepare(
    "SELECT title, description, all_day, utc_start_ms, utc_end_ms FROM events WHERE event_id = ?"
  ).get(entityId);
  if (!row) return { deleted: true, value: void 0 };
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
          allDay: row.all_day === 1
        }
      };
    default:
      return {
        deleted: false,
        value: {
          title: row.title,
          description: row.description,
          startMs: row.utc_start_ms,
          endMs: row.utc_end_ms,
          allDay: row.all_day === 1
        }
      };
  }
}
function loadConflictLocals(db, entityId, fieldPath) {
  const rows = (fieldPath === "*" ? db.prepare(
    `SELECT change_id, device_id, local_seq, entity_id, entity_type,
                    field_path, operation, payload, hlc_timestamp,
                    causality_clock, schema_version
             FROM changes WHERE entity_id = ?`
  ).all(entityId) : db.prepare(
    `SELECT change_id, device_id, local_seq, entity_id, entity_type,
                    field_path, operation, payload, hlc_timestamp,
                    causality_clock, schema_version
             FROM changes
             WHERE entity_id = ? AND (field_path = ? OR field_path = '*')`
  ).all(entityId, fieldPath)).map(deserializeChangeRow);
  return rows;
}
function deserializeChangeRow(r) {
  return {
    change_id: r.change_id,
    device_id: r.device_id,
    local_seq: r.local_seq,
    entity_id: r.entity_id,
    entity_type: r.entity_type,
    field_path: r.field_path,
    operation: r.operation,
    payload: JSON.parse(r.payload),
    hlc_timestamp: r.hlc_timestamp,
    causality_clock: JSON.parse(r.causality_clock),
    schema_version: r.schema_version
  };
}
function detectAndRecordConflict(db, record) {
  if (record.entity_type !== "event") return "apply";
  const localCurrent = eventRowLocalValue(db, record.entity_id, record.field_path);
  const locals = loadConflictLocals(db, record.entity_id, record.field_path);
  const outcome = detect(record, localCurrent, locals);
  if (outcome.kind === "conflict") {
    recordConflictRow(db, record, outcome.conflicting);
    return "conflict";
  }
  return outcome.kind;
}
function recordConflictRow(db, incoming, conflicting) {
  const insertParticipant = db.prepare(`
    INSERT OR IGNORE INTO conflict_participants
      (conflict_id, change_id, device_id, local_seq, causality_clock, payload)
    VALUES (?, ?, ?, ?, ?, ?)`);
  db.transaction(() => {
    const existing = db.prepare(
      `SELECT conflict_id FROM conflicts
         WHERE entity_id = ? AND field_path = ? AND status = 'unresolved'`
    ).get(incoming.entity_id, incoming.field_path);
    let conflictId;
    if (existing) {
      conflictId = existing.conflict_id;
    } else {
      conflictId = randomUUID();
      db.prepare(
        `INSERT INTO conflicts (conflict_id, entity_id, field_path, status,
                                detected_at_hlc)
         VALUES (?, ?, ?, 'unresolved', ?)`
      ).run(conflictId, incoming.entity_id, incoming.field_path, Date.now());
    }
    for (const p of [...conflicting, incoming]) {
      insertParticipant.run(
        conflictId,
        p.change_id,
        p.device_id,
        p.local_seq,
        JSON.stringify(p.causality_clock),
        JSON.stringify(p.payload)
      );
    }
  })();
}
function applyRemoteChange(db, incoming, knowledge, mutate) {
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
  const setAppliedUpto = db.prepare(`
    INSERT INTO applied_upto (producer_device_id, applied_through) VALUES (?, ?)
    ON CONFLICT(producer_device_id) DO UPDATE SET
      applied_through = MAX(applied_through, excluded.applied_through)`);
  const deletePending = db.prepare(
    "DELETE FROM pending_changes WHERE device_id = ? AND local_seq = ?"
  );
  const loadAllPending = db.prepare(
    "SELECT device_id, local_seq, record_payload FROM pending_changes WHERE device_id = ?"
  );
  const upsertClockStmt = db.prepare(`
    INSERT INTO device_clock (peer_device_id, max_seq) VALUES (?, ?)
    ON CONFLICT(peer_device_id) DO UPDATE SET
      max_seq = MAX(max_seq, excluded.max_seq)`);
  function mergeClocks2(clock) {
    for (const [d, s] of Object.entries(clock)) {
      upsertClockStmt.run(d, s);
    }
  }
  let dbKnowledge;
  try {
    const outcome = db.transaction(() => {
      dbKnowledge = loadKnowledgeFromDb(db);
      const cls = classifyArrival(
        dbKnowledge,
        incoming.device_id,
        incoming.local_seq
      );
      if (cls === "duplicate") {
        mergeClocks2(incoming.causality_clock);
        return "duplicate";
      }
      if (cls === "buffer") {
        insertPending.run(
          incoming.device_id,
          incoming.local_seq,
          JSON.stringify(incoming),
          Date.now()
        );
        mergeClocks2(incoming.causality_clock);
        return "buffered";
      }
      const drained = advanceApplied(
        dbKnowledge,
        incoming.device_id,
        incoming.local_seq
      );
      for (const step of drained) {
        let record;
        if (step.device_id === incoming.device_id && step.local_seq === incoming.local_seq) {
          record = incoming;
        } else {
          const rows = loadAllPending.all(step.device_id);
          const match = rows.find((r) => r.local_seq === step.local_seq);
          if (!match) {
            throw new Error(
              `pending payload missing for ${step.device_id}:${step.local_seq}`
            );
          }
          record = JSON.parse(match.record_payload);
        }
        const det = detectAndRecordConflict(db, record);
        if (det === "apply") {
          mutate?.(db, record);
        }
        insertChange.run(serializeChange(record));
        recordEntityVersion(db, record);
        deletePending.run(step.device_id, step.local_seq);
      }
      setAppliedUpto.run(
        incoming.device_id,
        drained[drained.length - 1].local_seq
      );
      db.prepare(
        "DELETE FROM skipped_seqs WHERE producer_device_id = ? AND local_seq <= ?"
      ).run(incoming.device_id, drained[drained.length - 1].local_seq);
      mergeClocks2(incoming.causality_clock);
      return "applied";
    })();
    knowledge.appliedUpto = dbKnowledge.appliedUpto;
    knowledge.pending = dbKnowledge.pending;
    knowledge.skipped = dbKnowledge.skipped;
    return outcome;
  } catch (err2) {
    if (isUniqueViolation(err2)) {
      db.transaction(() => mergeClocks2(incoming.causality_clock))();
      const fresh = loadKnowledgeFromDb(db);
      knowledge.appliedUpto = fresh.appliedUpto;
      knowledge.pending = fresh.pending;
      knowledge.skipped = fresh.skipped;
      return "duplicate";
    }
    throw err2;
  }
}
function loadKnowledgeFromDb(db) {
  const k = emptyKnowledge();
  k.skipped = /* @__PURE__ */ new Map();
  for (const r of db.prepare(
    "SELECT producer_device_id, applied_through FROM applied_upto"
  ).all()) {
    k.appliedUpto[r.producer_device_id] = r.applied_through;
  }
  for (const r of db.prepare(
    "SELECT device_id, local_seq FROM pending_changes"
  ).all()) {
    let set = k.pending.get(r.device_id);
    if (!set) {
      set = /* @__PURE__ */ new Set();
      k.pending.set(r.device_id, set);
    }
    set.add(r.local_seq);
  }
  for (const r of db.prepare(
    "SELECT producer_device_id, local_seq FROM skipped_seqs"
  ).all()) {
    let set = k.skipped.get(r.producer_device_id);
    if (!set) {
      set = /* @__PURE__ */ new Set();
      k.skipped.set(r.producer_device_id, set);
    }
    set.add(r.local_seq);
  }
  return k;
}
function isUniqueViolation(err2) {
  const msg = err2 instanceof Error ? err2.message : String(err2);
  return msg.includes("UNIQUE constraint failed");
}
function quarantineRecord(db, opts) {
  const raw = opts.rawRecord;
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
    const deviceId = raw.device_id;
    const seq = raw.local_seq;
    if (typeof deviceId === "string" && deviceId.length > 0 && typeof seq === "number" && Number.isInteger(seq) && seq > 0) {
      const existing = db.prepare(
        `SELECT 1 FROM quarantine
           WHERE json_extract(raw_record, '$.device_id') = ?
             AND json_extract(raw_record, '$.local_seq') = ?
           LIMIT 1`
      ).get(deviceId, seq);
      if (existing !== void 0) return;
    }
  }
  db.prepare(`
    INSERT INTO quarantine
      (quarantine_reason, received_at_hlc, sender_device_id, raw_record)
    VALUES (?, ?, ?, ?)`).run(
    opts.reason,
    Date.now(),
    opts.senderDeviceId,
    JSON.stringify(opts.rawRecord)
  );
}
function countQuarantined(db, reason) {
  if (reason === void 0) {
    const row2 = db.prepare("SELECT COUNT(*) AS c FROM quarantine").get();
    return row2?.c ?? 0;
  }
  const row = db.prepare(
    "SELECT COUNT(*) AS c FROM quarantine WHERE quarantine_reason = ?"
  ).get(reason);
  return row?.c ?? 0;
}
function markSeqSkipped(db, producerDeviceId, localSeq) {
  db.prepare(
    "INSERT OR IGNORE INTO skipped_seqs (producer_device_id, local_seq) VALUES (?, ?)"
  ).run(producerDeviceId, localSeq);
}
function isSeqSkipped(db, producerDeviceId, localSeq) {
  return !!db.prepare(
    "SELECT 1 FROM skipped_seqs WHERE producer_device_id = ? AND local_seq = ?"
  ).get(producerDeviceId, localSeq);
}
function listQuarantine(db, opts) {
  return db.prepare(
    `SELECT quarantine_id, quarantine_reason, received_at_hlc,
              sender_device_id, raw_record,
              resolved_at_hlc, resolved_reason
       FROM quarantine ORDER BY quarantine_id DESC LIMIT ?`
  ).all(opts?.limit ?? 200);
}
function markQuarantineResolved(db, quarantineId, reason) {
  const info = db.prepare(
    `UPDATE quarantine
       SET resolved_at_hlc = ?, resolved_reason = ?
       WHERE quarantine_id = ? AND resolved_at_hlc IS NULL`
  ).run(Date.now(), reason, quarantineId);
  return info.changes > 0;
}
function reconcileQuarantineResolutions(db) {
  const rows = db.prepare(
    "SELECT quarantine_id, raw_record FROM quarantine WHERE resolved_at_hlc IS NULL"
  ).all();
  const exists = db.prepare("SELECT 1 FROM changes WHERE change_id = ?");
  let marked = 0;
  for (const row of rows) {
    let deviceId;
    let localSeq;
    try {
      const raw = JSON.parse(row.raw_record);
      deviceId = raw.device_id;
      localSeq = raw.local_seq;
    } catch {
      continue;
    }
    if (typeof deviceId !== "string") continue;
    if (typeof localSeq !== "number" || !Number.isInteger(localSeq)) continue;
    const changeIdStr = `${deviceId}:${localSeq}`;
    if (exists.get(changeIdStr)) {
      if (markQuarantineResolved(db, row.quarantine_id, "revalidated_on_restart")) {
        marked++;
      }
    }
  }
  return { examined: rows.length, marked };
}
function listQuarantineStats(db) {
  const row = db.prepare(
    `SELECT SUM(CASE WHEN resolved_at_hlc IS NULL THEN 1 ELSE 0 END) AS active,
              SUM(CASE WHEN resolved_at_hlc IS NOT NULL THEN 1 ELSE 0 END) AS resolved,
              COUNT(*) AS total
       FROM quarantine`
  ).get();
  const pruned = db.prepare(
    "SELECT total_pruned FROM quarantine_prune_stats WHERE id = 1"
  ).get();
  return {
    active: row?.active ?? 0,
    resolved: row?.resolved ?? 0,
    total: row?.total ?? 0,
    total_pruned: pruned?.total_pruned ?? 0
  };
}
var QUARANTINE_RESOLVED_RETENTION_CAP = 1e3;
function pruneResolvedQuarantine(db, cap = QUARANTINE_RESOLVED_RETENTION_CAP) {
  if (!Number.isInteger(cap) || cap < 0) {
    throw new Error(`invalid retention cap: ${cap}`);
  }
  let pruned = 0;
  db.transaction(() => {
    const info = db.prepare(
      `DELETE FROM quarantine
         WHERE resolved_at_hlc IS NOT NULL
           AND quarantine_id NOT IN (
             SELECT quarantine_id FROM quarantine
             WHERE resolved_at_hlc IS NOT NULL
             ORDER BY quarantine_id DESC LIMIT ?)`
    ).run(cap);
    pruned = info.changes;
    if (pruned > 0) {
      db.prepare(
        `INSERT INTO quarantine_prune_stats (id, total_pruned) VALUES (1, ?)
         ON CONFLICT(id) DO UPDATE SET
           total_pruned = total_pruned + excluded.total_pruned`
      ).run(pruned);
    }
  })();
  return pruned;
}
function deleteQuarantineByUser(db, quarantineId, opts) {
  if (opts?.confirm !== true) {
    throw new Error(
      "delete_quarantine requires explicit confirm: true (destructive action, DC-15 \xA73.5)"
    );
  }
  const row = db.prepare(
    "SELECT raw_record, resolved_at_hlc FROM quarantine WHERE quarantine_id = ?"
  ).get(quarantineId);
  if (!row) throw new Error(`quarantine row ${quarantineId} not found`);
  let producer = null;
  let seq = null;
  try {
    const raw = JSON.parse(row.raw_record);
    if (typeof raw.device_id === "string" && raw.device_id.length > 0) {
      producer = raw.device_id;
    }
    if (typeof raw.local_seq === "number" && Number.isInteger(raw.local_seq) && raw.local_seq > 0) {
      seq = raw.local_seq;
    }
  } catch {
  }
  let skipRowPresent = false;
  let recreated = false;
  db.transaction(() => {
    if (row.resolved_at_hlc === null) {
      markQuarantineResolved(db, quarantineId, "user_deleted");
    }
    if (producer !== null && seq !== null) {
      const applied = !!db.prepare("SELECT 1 FROM changes WHERE change_id = ?").get(`${producer}:${seq}`);
      if (!applied) {
        skipRowPresent = isSeqSkipped(db, producer, seq);
        if (!skipRowPresent) {
          markSeqSkipped(db, producer, seq);
          recreated = true;
        }
      } else {
        skipRowPresent = true;
      }
    }
  })();
  return {
    ok: true,
    skip_row_present: skipRowPresent,
    skip_row_recreated: recreated
  };
}
function isHardBlocked(db, producerDeviceId) {
  return !!db.prepare("SELECT 1 FROM hard_blocks WHERE producer_device_id = ?").get(producerDeviceId);
}
function hardBlockProducer(db, producerDeviceId) {
  const now = Date.now();
  db.prepare(
    `INSERT INTO hard_blocks
       (producer_device_id, first_triggered_at, last_triggered_at, trigger_count)
     VALUES (?, ?, ?, 1)
     ON CONFLICT(producer_device_id) DO UPDATE SET
       last_triggered_at = excluded.last_triggered_at,
       trigger_count = trigger_count + 1`
  ).run(producerDeviceId, now, now);
}
function unhardBlockProducer(db, producerDeviceId) {
  const info = db.prepare("DELETE FROM hard_blocks WHERE producer_device_id = ?").run(producerDeviceId);
  return info.changes > 0;
}
function listHardBlocks(db) {
  return db.prepare(`SELECT producer_device_id, first_triggered_at, last_triggered_at,
              trigger_count
       FROM hard_blocks ORDER BY last_triggered_at DESC`).all();
}
function appendInvalidTally(db, producerDeviceId) {
  db.prepare(
    `INSERT INTO peer_invalid_tally
       (producer_device_id, total_invalid, last_invalid_at)
     VALUES (?, 1, ?)
     ON CONFLICT(producer_device_id) DO UPDATE SET
       total_invalid = total_invalid + 1,
       last_invalid_at = excluded.last_invalid_at`
  ).run(producerDeviceId, Date.now());
}
function listPeerInvalidTally(db) {
  return db.prepare(`SELECT producer_device_id, total_invalid, last_invalid_at
       FROM peer_invalid_tally ORDER BY last_invalid_at DESC`).all();
}

// src/persistence/bridges/event_core.ts
var DEFAULT_CALENDAR_ID = "local";
var HlcTicker = class {
  last = 0;
  now() {
    const wall = Date.now();
    this.last = wall > this.last ? wall : this.last + 1;
    return this.last;
  }
};
function loadOrCreateDeviceId(dbPath) {
  const marker = `${dbPath}.device_id`;
  if (existsSync(marker)) {
    return readFileSync(marker, "utf8").trim();
  }
  const id = `dev-${randomUUID2()}`;
  writeFileSync(marker, id, "utf8");
  return id;
}
function localDateStr(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function localWallStr(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function timezoneId() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}
function assertNoInjectedId(input, op) {
  if (input !== null && typeof input === "object" && "id" in input) {
    throw new Error(
      `${op}_event: input.id is not accepted \u2014 event ids are assigned by the sidecar (update targets come from the op's id argument) and a client-injected id is rejected without any state change`
    );
  }
}
var MAX_EVENT_MS = 864e13;
function validateEventValues(input, op) {
  for (const k of ["startMs", "endMs"]) {
    const v = input[k];
    if (typeof v !== "number" || !Number.isInteger(v)) {
      throw new Error(
        `${op}: input.${k} must be an integer number of epoch milliseconds (fractional/non-numeric values are rejected, never coerced)`
      );
    }
    if (Math.abs(v) > MAX_EVENT_MS) {
      throw new Error(
        `${op}: input.${k} ${v} is outside the epoch-ms domain (+/-${MAX_EVENT_MS}); values beyond it are rejected because Date-derived columns and exact JSON round-trips cannot represent them`
      );
    }
  }
  if (input.endMs < input.startMs) {
    throw new Error(
      `${op}: input.endMs (${input.endMs}) must be >= input.startMs (${input.startMs}) \u2014 inverted ranges are rejected without any state change`
    );
  }
}
var RRULE_FREQS = /* @__PURE__ */ new Set(["DAILY", "WEEKLY", "MONTHLY", "YEARLY"]);
var RRULE_KEYS = /* @__PURE__ */ new Set(["FREQ", "INTERVAL", "BYDAY", "COUNT", "UNTIL"]);
var RRULE_DAYS = /* @__PURE__ */ new Set(["MO", "TU", "WE", "TH", "FR", "SA", "SU"]);
var RECURRENCE_ID_RE = /^\d{8}T\d{6}$/;
function validateRRule(rule, op) {
  if (typeof rule !== "string" || rule.trim().length === 0) {
    throw new Error(`${op}: recurrence_rule must be a non-empty RRULE string`);
  }
  const segments = rule.split(";");
  let sawFreq = false;
  for (const seg of segments) {
    const eq = seg.indexOf("=");
    if (eq <= 0) {
      throw new Error(
        `${op}: recurrence_rule segment "${seg}" is not KEY=VALUE \u2014 the rule must be a semicolon-separated RFC 5545 RRULE`
      );
    }
    const key = seg.slice(0, eq).trim().toUpperCase();
    const value = seg.slice(eq + 1).trim();
    if (!RRULE_KEYS.has(key)) {
      throw new Error(
        `${op}: recurrence_rule key "${key}" is not supported \u2014 allowed: FREQ, INTERVAL, BYDAY, COUNT, UNTIL`
      );
    }
    if (value.length === 0) {
      throw new Error(`${op}: recurrence_rule key "${key}" has an empty value`);
    }
    switch (key) {
      case "FREQ": {
        const f = value.toUpperCase();
        if (!RRULE_FREQS.has(f)) {
          throw new Error(
            `${op}: recurrence_rule FREQ "${value}" is not supported \u2014 allowed: DAILY, WEEKLY, MONTHLY, YEARLY`
          );
        }
        sawFreq = true;
        break;
      }
      case "INTERVAL": {
        const n = Number(value);
        if (!Number.isInteger(n) || n < 1) {
          throw new Error(
            `${op}: recurrence_rule INTERVAL "${value}" must be an integer >= 1`
          );
        }
        break;
      }
      case "COUNT": {
        const n = Number(value);
        if (!Number.isInteger(n) || n < 1) {
          throw new Error(
            `${op}: recurrence_rule COUNT "${value}" must be an integer >= 1`
          );
        }
        break;
      }
      case "UNTIL": {
        if (!/^\d{8}$/.test(value)) {
          throw new Error(
            `${op}: recurrence_rule UNTIL "${value}" must be the form YYYYMMDD`
          );
        }
        break;
      }
      case "BYDAY": {
        for (const d of value.split(",")) {
          if (!RRULE_DAYS.has(d.trim().toUpperCase())) {
            throw new Error(
              `${op}: recurrence_rule BYDAY value "${d}" is not a weekday (MO TU WE TH FR SA SU)`
            );
          }
        }
        break;
      }
    }
  }
  if (!sawFreq) {
    throw new Error(`${op}: recurrence_rule is missing required FREQ`);
  }
  return rule;
}
function validateRecurrenceId(rid, op) {
  if (typeof rid !== "string" || !RECURRENCE_ID_RE.test(rid)) {
    throw new Error(
      `${op}: recurrence_id must be the canonical wall-clock form "YYYYMMDDTHHMMSS" (DC-12 \xA72.3), got: ${JSON.stringify(rid)}`
    );
  }
  return rid;
}
var OVERRIDE_FIELDS = [
  "cancelled",
  "title",
  "start_wall",
  "end_wall",
  "tz_id"
];
var EventCore = class {
  db;
  dbPath;
  deviceId;
  hlc = new HlcTicker();
  constructor(dbPath, deviceId) {
    this.dbPath = dbPath;
    this.db = openDatabase({ path: dbPath });
    this.deviceId = deviceId ?? loadOrCreateDeviceId(dbPath);
    this.ensureDefaultCalendar();
  }
  get selfDeviceId() {
    return this.deviceId;
  }
  // -------------------------------------------------------------------------
  // DC-22: reminder members (collection members; replicate per D5).
  // -------------------------------------------------------------------------
  /** Read one event's reminder member, or null. */
  reminderFor(eventId) {
    const row = this.db.prepare(
      "SELECT minutes_before, enabled FROM reminders WHERE entity_id = ?"
    ).get(eventId);
    if (row === void 0) return null;
    return { minutesBefore: row.minutes_before, enabled: row.enabled !== 0 };
  }
  /**
   * Create-or-update this event's reminder member (v1 UI: one member per
   * event). Replicates as member_add / member_update (D5: disabled members
   * are stored-but-inactive AND still replicate).
   */
  setReminder(eventId, reminder) {
    if (!Number.isInteger(reminder.minutesBefore) || reminder.minutesBefore < 0) {
      throw new Error("setReminder: minutes_before must be a non-negative integer");
    }
    if (this.getEventRow(eventId) === void 0) {
      throw new Error(`setReminder: event not found: ${eventId}`);
    }
    const existing = this.db.prepare(
      "SELECT member_id FROM reminders WHERE entity_id = ?"
    ).get(eventId);
    const hlc = this.hlc.now();
    if (existing !== void 0) {
      createLocalChange(
        this.db,
        this.deviceId,
        {
          entity_id: eventId,
          entity_type: "reminder",
          field_path: `reminders.${existing.member_id}`,
          operation: "member_update",
          payload: {
            value: { minutes_before: reminder.minutesBefore, enabled: reminder.enabled ? 1 : 0 }
          },
          hlc_now: () => hlc
        },
        (db) => {
          db.prepare(
            "UPDATE reminders SET minutes_before = ?, enabled = ?, updated_hlc = ? WHERE member_id = ?"
          ).run(reminder.minutesBefore, reminder.enabled ? 1 : 0, hlc, existing.member_id);
        }
      );
      return;
    }
    const memberId = `rem-${randomUUID2()}`;
    createLocalChange(
      this.db,
      this.deviceId,
      {
        entity_id: eventId,
        entity_type: "reminder",
        field_path: `reminders.${memberId}`,
        operation: "member_add",
        payload: {
          value: { minutes_before: reminder.minutesBefore, enabled: reminder.enabled ? 1 : 0 }
        },
        hlc_now: () => hlc
      },
      (db) => {
        db.prepare(
          `INSERT INTO reminders (member_id, entity_id, collection_path, minutes_before, enabled, updated_hlc)
           VALUES (?, ?, 'reminders', ?, ?, ?)`
        ).run(memberId, eventId, reminder.minutesBefore, reminder.enabled ? 1 : 0, hlc);
      }
    );
  }
  /** Remove the event's reminder member (member_remove). Idempotent. */
  clearReminder(eventId) {
    const existing = this.db.prepare(
      "SELECT member_id FROM reminders WHERE entity_id = ?"
    ).get(eventId);
    if (existing === void 0) return;
    const hlc = this.hlc.now();
    createLocalChange(
      this.db,
      this.deviceId,
      {
        entity_id: eventId,
        entity_type: "reminder",
        field_path: `reminders.${existing.member_id}`,
        operation: "member_remove",
        payload: { value: null },
        hlc_now: () => hlc
      },
      (db) => {
        db.prepare("DELETE FROM reminders WHERE member_id = ?").run(existing.member_id);
      }
    );
  }
  /**
   * Bootstrap the shell-local calendar through the same T1 path so even
   * this bootstrap produces an auditable change record.
   *
   * Pkg6 (QA-2 F-1): the bootstrap change is emitted ONLY when the calendar
   * row is MISSING. Previously the T1 ran unconditionally, so every
   * sidecar restart emitted a fresh authoritative "title='My Calendar'"
   * change for an entity that already existed — a spurious change per
   * restart (QA-2 s5_cycles.json: changes_delta=1 x N). Beyond noise, that
   * is a latent LWW data-loss trap: once calendar rename ships, a restart
   * would re-assert the DEFAULT title over a peer-renamed calendar. An
   * existing row (local or synced) is left completely untouched — no
   * change record, no device_clock advance, no updated_hlc churn.
   */
  ensureDefaultCalendar() {
    const exists = this.db.prepare(
      "SELECT 1 FROM calendars WHERE calendar_id = ?"
    ).get(DEFAULT_CALENDAR_ID);
    if (exists !== void 0) return;
    const hlc = this.hlc.now();
    createLocalChange(
      this.db,
      this.deviceId,
      {
        entity_id: DEFAULT_CALENDAR_ID,
        entity_type: "calendar",
        field_path: "title",
        operation: "set",
        payload: { value: "My Calendar" },
        hlc_now: () => hlc
      },
      (db) => {
        db.prepare(
          `INSERT INTO calendars (calendar_id, title, color, created_hlc, updated_hlc)
           VALUES (?, ?, NULL, ?, ?)
           ON CONFLICT(calendar_id) DO NOTHING`
        ).run(DEFAULT_CALENDAR_ID, "My Calendar", hlc, hlc);
      }
    );
  }
  listEvents(range) {
    let rows;
    if (range?.fromMs != null && range?.toMs != null) {
      rows = this.db.prepare(
        `SELECT event_id, title, description, all_day, start_date, end_date,
                  start_wall, end_wall, utc_start_ms, utc_end_ms
           FROM events WHERE utc_start_ms IS NOT NULL
             AND utc_start_ms < ? AND utc_end_ms > ?
           ORDER BY utc_start_ms`
      ).all(range.toMs, range.fromMs);
    } else {
      rows = this.db.prepare(
        `SELECT event_id, title, description, all_day, start_date, end_date,
                  start_wall, end_wall, utc_start_ms, utc_end_ms
           FROM events ORDER BY utc_start_ms`
      ).all();
    }
    return rows.map(rowToEvent).sort(byStart);
  }
  createEvent(input) {
    assertNoInjectedId(input, "create");
    const rule = input.recurrenceRule !== void 0 ? validateRRule(input.recurrenceRule, "create_event") : void 0;
    const event = {
      id: `evt-${randomUUID2()}`,
      title: input.title,
      description: input.description,
      startMs: input.startMs,
      endMs: input.endMs,
      allDay: input.allDay
    };
    validateEventValues(event, "create_event");
    const hlc = this.hlc.now();
    createLocalChange(
      this.db,
      this.deviceId,
      {
        entity_id: event.id,
        entity_type: "event",
        field_path: "event",
        operation: "set",
        payload: { value: eventFields(event) },
        hlc_now: () => hlc
      },
      (db, _record) => {
        insertEventRow(db, event, hlc);
      }
    );
    if (rule !== void 0) {
      const seriesId = `ser-${randomUUID2()}`;
      const seriesHlc = this.hlc.now();
      createLocalChange(
        this.db,
        this.deviceId,
        {
          entity_id: seriesId,
          entity_type: "series",
          field_path: "recurrence_rule",
          operation: "set",
          payload: { value: rule },
          hlc_now: () => seriesHlc
        },
        (db) => {
          db.prepare(
            `INSERT INTO series (series_id, base_event_id, recurrence_rule, created_hlc, updated_hlc)
             VALUES (?, ?, ?, ?, ?)`
          ).run(seriesId, event.id, rule, seriesHlc, seriesHlc);
        }
      );
    }
    return event;
  }
  updateEvent(id, input) {
    assertNoInjectedId(input, "update");
    const existing = this.getEventRow(id);
    if (!existing) throw new Error(`event not found: ${id}`);
    const before = rowToEvent(existing);
    const updated = {
      id,
      title: input.title,
      description: input.description,
      startMs: input.startMs,
      endMs: input.endMs,
      allDay: input.allDay
    };
    validateEventValues(updated, "update_event");
    const groups = [
      {
        field_path: "title",
        value: input.title,
        changed: before.title !== input.title
      },
      {
        field_path: "description",
        value: input.description,
        changed: before.description !== input.description
      },
      {
        field_path: "schedule",
        value: { startMs: input.startMs, endMs: input.endMs, allDay: input.allDay },
        changed: before.startMs !== input.startMs || before.endMs !== input.endMs || before.allDay !== input.allDay
      }
    ];
    for (const g of groups.filter((g2) => g2.changed)) {
      const hlc = this.hlc.now();
      createLocalChange(
        this.db,
        this.deviceId,
        {
          entity_id: id,
          entity_type: "event",
          field_path: g.field_path,
          operation: "set",
          payload: { value: g.value },
          hlc_now: () => hlc
        },
        (db) => {
          insertEventRow(db, updated, hlc, true);
        }
      );
    }
    return updated;
  }
  deleteEvent(id) {
    const existing = this.getEventRow(id);
    if (!existing) return;
    const series = this.seriesForBaseEvent(id);
    const hlc = this.hlc.now();
    createLocalChange(
      this.db,
      this.deviceId,
      {
        entity_id: id,
        entity_type: "event",
        field_path: "*",
        operation: "remove",
        payload: {},
        hlc_now: () => hlc
      },
      (db) => {
        if (series) {
          db.prepare("DELETE FROM occurrence_overrides WHERE series_id = ?").run(
            series.series_id
          );
          db.prepare("DELETE FROM series WHERE series_id = ?").run(
            series.series_id
          );
        }
        db.prepare("DELETE FROM events WHERE event_id = ?").run(id);
      }
    );
    if (series) {
      const seriesHlc = this.hlc.now();
      createLocalChange(
        this.db,
        this.deviceId,
        {
          entity_id: series.series_id,
          entity_type: "series",
          field_path: "*",
          operation: "remove",
          payload: {},
          hlc_now: () => seriesHlc
        }
      );
    }
  }
  getEventRow(id) {
    return this.db.prepare(
      `SELECT event_id, title, description, all_day, start_date, end_date,
                start_wall, end_wall, utc_start_ms, utc_end_ms
         FROM events WHERE event_id = ?`
    ).get(id);
  }
  seriesForBaseEvent(baseEventId) {
    return this.db.prepare(
      `SELECT series_id, recurrence_rule FROM series WHERE base_event_id = ?`
    ).get(baseEventId);
  }
  /**
   * DC-12 §2.1 / §3: edit the series' recurrence rule. Its own conflict
   * entity (series_id, "recurrence_rule"); stored VERBATIM (validated first).
   * No-op (no change record) when the rule is byte-identical.
   */
  updateSeriesRule(seriesId, rule) {
    if (typeof seriesId !== "string" || seriesId.length === 0) {
      throw new Error("update_series_rule: series_id must be a non-empty string");
    }
    const validated = validateRRule(rule, "update_series_rule");
    const row = this.db.prepare(
      `SELECT series_id, recurrence_rule FROM series WHERE series_id = ?`
    ).get(seriesId);
    if (!row) throw new Error(`series not found: ${seriesId}`);
    if (row.recurrence_rule === validated) {
      return { seriesId, recurrenceRule: validated };
    }
    const hlc = this.hlc.now();
    createLocalChange(
      this.db,
      this.deviceId,
      {
        entity_id: seriesId,
        entity_type: "series",
        field_path: "recurrence_rule",
        operation: "set",
        payload: { value: validated },
        hlc_now: () => hlc
      },
      (db) => {
        db.prepare(
          `UPDATE series SET recurrence_rule = ?, updated_hlc = ? WHERE series_id = ?`
        ).run(validated, hlc, seriesId);
      }
    );
    return { seriesId, recurrenceRule: validated };
  }
  /**
   * DC-12 §2.2/§2.3/§4.1: create or edit ONE occurrence override, keyed
   * (series_id, recurrence_id). recurrence_id is the canonical wall-clock
   * form of the ORIGINAL occurrence start (never rewritten — R2). Each
   * changed field is its own DC-03 conflict entity
   * (series_id, "overrides.<rid>.<field>") — exactly one change record per
   * field per DC-01 §3.1. Unchanged fields produce nothing (TR-8 idempotence).
   */
  updateOccurrence(seriesId, recurrenceId, patch) {
    if (typeof seriesId !== "string" || seriesId.length === 0) {
      throw new Error("update_occurrence: series_id must be a non-empty string");
    }
    const rid = validateRecurrenceId(recurrenceId, "update_occurrence");
    if (patch === null || typeof patch !== "object" || Array.isArray(patch)) {
      throw new Error("update_occurrence: patch must be an object");
    }
    const unknown = Object.keys(patch).filter(
      (k) => !OVERRIDE_FIELDS.includes(k)
    );
    if (unknown.length > 0) {
      throw new Error(
        `update_occurrence: unknown patch field(s): ${unknown.join(", ")} \u2014 allowed: ${OVERRIDE_FIELDS.join(", ")}`
      );
    }
    if (Object.keys(patch).length === 0) {
      throw new Error("update_occurrence: patch must set at least one field");
    }
    for (const k of ["title", "start_wall", "end_wall", "tz_id"]) {
      const v = patch[k];
      if (v !== void 0 && typeof v !== "string") {
        throw new Error(`update_occurrence: patch.${k} must be a string`);
      }
      if (typeof v === "string" && v.trim().length === 0) {
        throw new Error(`update_occurrence: patch.${k} must be a non-empty string`);
      }
    }
    if (patch.cancelled !== void 0 && typeof patch.cancelled !== "boolean") {
      throw new Error("update_occurrence: patch.cancelled must be a boolean");
    }
    const series = this.db.prepare(
      `SELECT series_id FROM series WHERE series_id = ?`
    ).get(seriesId);
    if (!series) throw new Error(`series not found: ${seriesId}`);
    const existing = this.db.prepare(
      `SELECT series_id, recurrence_id, cancelled, title, start_wall,
                end_wall, tz_id, updated_hlc
         FROM occurrence_overrides WHERE series_id = ? AND recurrence_id = ?`
    ).get(seriesId, rid);
    const wanted = {};
    if (patch.cancelled !== void 0 && (existing?.cancelled ?? 0) !== (patch.cancelled ? 1 : 0)) {
      wanted.cancelled = patch.cancelled;
    }
    for (const k of ["title", "start_wall", "end_wall", "tz_id"]) {
      if (patch[k] !== void 0 && (existing?.[k] ?? null) !== patch[k]) {
        wanted[k] = patch[k];
      }
    }
    if (Object.keys(wanted).length === 0) {
      return { seriesId, recurrenceId: rid, changed: [] };
    }
    const merged = {
      series_id: seriesId,
      recurrence_id: rid,
      cancelled: wanted.cancelled !== void 0 ? wanted.cancelled ? 1 : 0 : existing?.cancelled ?? 0,
      title: wanted.title ?? existing?.title ?? null,
      start_wall: wanted.start_wall ?? existing?.start_wall ?? null,
      end_wall: wanted.end_wall ?? existing?.end_wall ?? null,
      tz_id: wanted.tz_id ?? existing?.tz_id ?? null
    };
    for (const field of OVERRIDE_FIELDS) {
      if (!(field in wanted)) continue;
      const fieldHlc = this.hlc.now();
      const value = field === "cancelled" ? wanted.cancelled : wanted[field];
      createLocalChange(
        this.db,
        this.deviceId,
        {
          entity_id: seriesId,
          entity_type: "occurrence_override",
          field_path: `overrides.${rid}.${field}`,
          operation: "set",
          payload: { value },
          hlc_now: () => fieldHlc
        },
        (db) => {
          db.prepare(
            `INSERT INTO occurrence_overrides (series_id, recurrence_id, cancelled,
                title, start_wall, end_wall, tz_id, updated_hlc)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(series_id, recurrence_id) DO UPDATE SET
                cancelled = excluded.cancelled,
                title = excluded.title,
                start_wall = excluded.start_wall,
                end_wall = excluded.end_wall,
                tz_id = excluded.tz_id,
                updated_hlc = excluded.updated_hlc`
          ).run(
            seriesId,
            rid,
            merged.cancelled,
            merged.title,
            merged.start_wall,
            merged.end_wall,
            merged.tz_id,
            fieldHlc
          );
        }
      );
    }
    return {
      seriesId,
      recurrenceId: rid,
      changed: Object.keys(wanted)
    };
  }
  /**
   * READ-ONLY series listing for recurrence surfacing (DC-12 §2): every
   * series row with its verbatim RRULE joined to its occurrence_overrides.
   * No change records, no mutation — pure SELECT over stored state.
   */
  listSeries() {
    const rows = this.db.prepare(`SELECT series_id, base_event_id, recurrence_rule FROM series`).all();
    const overrides = this.db.prepare(
      `SELECT series_id, recurrence_id, cancelled, title, start_wall,
                end_wall, tz_id
         FROM occurrence_overrides ORDER BY recurrence_id`
    ).all();
    const bySeries = /* @__PURE__ */ new Map();
    for (const o of overrides) {
      let list = bySeries.get(o.series_id);
      if (!list) bySeries.set(o.series_id, list = []);
      list.push({
        recurrenceId: o.recurrence_id,
        cancelled: o.cancelled !== 0,
        title: o.title,
        startWall: o.start_wall,
        endWall: o.end_wall,
        tzId: o.tz_id
      });
    }
    return rows.map((r) => ({
      seriesId: r.series_id,
      baseEventId: r.base_event_id,
      recurrenceRule: r.recurrence_rule,
      overrides: bySeries.get(r.series_id) ?? []
    }));
  }
};
function eventFields(e) {
  return {
    title: e.title,
    description: e.description,
    startMs: e.startMs,
    endMs: e.endMs,
    allDay: e.allDay
  };
}
function insertEventRow(db, e, hlc, upsert = false) {
  const derived = derivedScheduleColumns(e);
  if (upsert) {
    const exists = !!db.prepare("SELECT 1 FROM events WHERE event_id = ?").get(e.id);
    if (!exists) {
      insertNewEventRow(db, e, hlc, derived);
    } else {
      updateEventRowDerived(db, e.id, e, hlc, derived);
    }
    return;
  }
  insertNewEventRow(db, e, hlc, derived);
}
function derivedScheduleColumns(e) {
  return {
    all_day: e.allDay ? 1 : 0,
    start_date: e.allDay ? localDateStr(e.startMs) : null,
    end_date: e.allDay ? localDateStr(Math.max(e.endMs, e.startMs)) : null,
    start_wall: e.allDay ? null : localWallStr(e.startMs),
    end_wall: e.allDay ? null : localWallStr(e.endMs),
    tz_id: e.allDay ? null : timezoneId(),
    utc_start_ms: e.startMs,
    utc_end_ms: Math.max(e.endMs, e.startMs)
  };
}
function insertNewEventRow(db, e, hlc, d) {
  db.prepare(`INSERT INTO events (event_id, calendar_id, title, description,
      all_day, start_date, end_date, start_wall, end_wall, tz_id,
      utc_start_ms, utc_end_ms, created_hlc, updated_hlc)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    e.id,
    DEFAULT_CALENDAR_ID,
    e.title,
    e.description,
    d.all_day,
    d.start_date,
    d.end_date,
    d.start_wall,
    d.end_wall,
    d.tz_id,
    d.utc_start_ms,
    d.utc_end_ms,
    hlc,
    hlc
  );
}
function updateEventRowDerived(db, eventId, e, hlc, d) {
  const info = db.prepare(`
    UPDATE events SET title = ?, description = ?, all_day = ?, start_date = ?,
      end_date = ?, start_wall = ?, end_wall = ?, tz_id = ?,
      utc_start_ms = ?, utc_end_ms = ?, updated_hlc = ?
    WHERE event_id = ?`).run(
    e.title,
    e.description,
    d.all_day,
    d.start_date,
    d.end_date,
    d.start_wall,
    d.end_wall,
    d.tz_id,
    d.utc_start_ms,
    d.utc_end_ms,
    hlc,
    eventId
  );
  return info.changes > 0;
}
function rowToEvent(r) {
  let startMs = r.utc_start_ms;
  let endMs = r.utc_end_ms;
  if (startMs == null || endMs == null) {
    if (r.all_day && r.start_date && r.end_date) {
      startMs = (/* @__PURE__ */ new Date(`${r.start_date}T00:00:00`)).getTime();
      endMs = (/* @__PURE__ */ new Date(`${r.end_date}T23:59:59.999`)).getTime();
    } else if (r.start_wall && r.end_wall && r.start_date) {
      startMs = (/* @__PURE__ */ new Date(`${r.start_date}T${r.start_wall}`)).getTime();
      endMs = (/* @__PURE__ */ new Date(`${r.start_date}T${r.end_wall}`)).getTime();
    } else {
      startMs = 0;
      endMs = 0;
    }
  }
  return {
    id: r.event_id,
    title: r.title,
    description: r.description,
    startMs,
    endMs,
    allDay: r.all_day !== 0
  };
}
function byStart(a, b) {
  return a.startMs - b.startMs || a.title.localeCompare(b.title);
}

// src/network/sync_runtime.ts
import { createServer, connect } from "node:net";
import { existsSync as existsSync2, readFileSync as readFileSync2, writeFileSync as writeFileSync2 } from "node:fs";
import { join } from "node:path";
import { networkInterfaces } from "node:os";

// src/security/identity.ts
import { randomBytes as randomBytes2 } from "node:crypto";

// node_modules/@noble/ed25519/index.js
var ed25519_CURVE = Object.freeze({
  p: 0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffedn,
  n: 0x1000000000000000000000000000000014def9dea2f79cd65812631a5cf5d3edn,
  h: 8n,
  a: 0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffecn,
  d: 0x52036cee2b6ffe738cc740797779e89800700a4d4141d8ab75eb4dca135978a3n,
  Gx: 0x216936d3cd6e53fec0a4e231fdd6dc5c692cc7609525a7b2c9562d608f25d51an,
  Gy: 0x6666666666666666666666666666666666666666666666666666666666666658n
});
var { p: P, n: N, Gx, Gy, a: _a, d: _d, h } = ed25519_CURVE;
var L = 32;
var captureTrace = (...args) => {
  if ("captureStackTrace" in Error && typeof Error.captureStackTrace === "function") {
    Error.captureStackTrace(...args);
  }
};
var err = (message = "") => {
  const e = new Error(message);
  captureTrace(e, err);
  throw e;
};
var isBig = (n) => typeof n === "bigint";
var isStr = (s) => typeof s === "string";
var isBytes = (a) => a instanceof Uint8Array || ArrayBuffer.isView(a) && a.constructor.name === "Uint8Array" && "BYTES_PER_ELEMENT" in a && a.BYTES_PER_ELEMENT === 1;
var abytes = (value, length, title = "") => {
  const bytes = isBytes(value);
  const len = value?.length;
  const needsLen = length !== void 0;
  if (!bytes || needsLen && len !== length) {
    const prefix = title && `"${title}" `;
    const ofLen = needsLen ? ` of length ${length}` : "";
    const got = bytes ? `length=${len}` : `type=${typeof value}`;
    const msg = prefix + "expected Uint8Array" + ofLen + ", got " + got;
    throw bytes ? new RangeError(msg) : new TypeError(msg);
  }
  return value;
};
var u8n = (len) => new Uint8Array(len);
var u8fr = (buf) => Uint8Array.from(buf);
var padh = (n, pad2) => n.toString(16).padStart(pad2, "0");
var bytesToHex = (b) => Array.from(abytes(b)).map((e) => padh(e, 2)).join("");
var C = { _0: 48, _9: 57, A: 65, F: 70, a: 97, f: 102 };
var _ch = (ch) => {
  if (ch >= C._0 && ch <= C._9)
    return ch - C._0;
  if (ch >= C.A && ch <= C.F)
    return ch - (C.A - 10);
  if (ch >= C.a && ch <= C.f)
    return ch - (C.a - 10);
  return;
};
var hexToBytes = (hex) => {
  const e = "hex invalid";
  if (!isStr(hex))
    return err(e);
  const hl = hex.length;
  const al = hl / 2;
  if (hl % 2)
    return err(e);
  const array = u8n(al);
  for (let ai = 0, hi = 0; ai < al; ai++, hi += 2) {
    const n1 = _ch(hex.charCodeAt(hi));
    const n2 = _ch(hex.charCodeAt(hi + 1));
    if (n1 === void 0 || n2 === void 0)
      return err(e);
    array[ai] = n1 * 16 + n2;
  }
  return array;
};
var cr = () => globalThis?.crypto;
var subtle = () => cr()?.subtle ?? err("crypto.subtle must be defined, consider polyfill");
var concatBytes = (...arrs) => {
  let len = 0;
  for (const a of arrs)
    len += abytes(a).length;
  const r = u8n(len);
  let pad2 = 0;
  arrs.forEach((a) => {
    r.set(a, pad2);
    pad2 += a.length;
  });
  return r;
};
var big = BigInt;
var assertRange = (n, min, max, msg = "bad number: out of range") => {
  if (!isBig(n))
    throw new TypeError(msg);
  if (min <= n && n < max)
    return n;
  throw new RangeError(msg);
};
var M = (a, b = P) => {
  const r = a % b;
  return r >= 0n ? r : b + r;
};
var P_MASK = (1n << 255n) - 1n;
var modP = (num) => {
  if (num < 0n)
    err("negative coordinate");
  let r = (num >> 255n) * 19n + (num & P_MASK);
  r = (r >> 255n) * 19n + (r & P_MASK);
  return r % P;
};
var modN = (a) => M(a, N);
var invert = (num, md) => {
  if (num === 0n || md <= 0n)
    err("no inverse n=" + num + " mod=" + md);
  let a = M(num, md), b = md, x = 0n, y = 1n, u = 1n, v = 0n;
  while (a !== 0n) {
    const q = b / a, r = b % a;
    const m = x - u * q, n = y - v * q;
    b = a, a = r, x = u, y = v, u = m, v = n;
  }
  return b === 1n ? M(x, md) : err("no inverse");
};
var callHash = (name) => {
  const fn = hashes[name];
  if (typeof fn !== "function")
    err("hashes." + name + " not set");
  return fn;
};
var checkDigest = (value) => abytes(value, 64, "digest");
var apoint = (p) => p instanceof Point ? p : err("Point expected");
var B256 = 2n ** 256n;
var Point = class _Point {
  static BASE;
  static ZERO;
  X;
  Y;
  Z;
  T;
  // Constructor only bounds-checks and freezes XYZT coordinates; it does not prove the point is
  // on-curve or that T matches X*Y/Z.
  constructor(X, Y, Z, T) {
    const max = B256;
    this.X = assertRange(X, 0n, max);
    this.Y = assertRange(Y, 0n, max);
    this.Z = assertRange(Z, 1n, max);
    this.T = assertRange(T, 0n, max);
    Object.freeze(this);
  }
  static CURVE() {
    return ed25519_CURVE;
  }
  static fromAffine(p) {
    return new _Point(p.x, p.y, 1n, modP(p.x * p.y));
  }
  /** RFC8032 5.1.3: Bytes to Point. */
  static fromBytes(hex, zip215 = false) {
    const d = _d;
    const normed = u8fr(abytes(hex, L));
    const lastByte = hex[31];
    normed[31] = lastByte & ~128;
    const y = bytesToNumberLE(normed);
    const max = zip215 ? B256 : P;
    assertRange(y, 0n, max);
    const y2 = modP(y * y);
    const u = M(y2 - 1n);
    const v = modP(d * y2 + 1n);
    let { isValid, value: x } = uvRatio(u, v);
    if (!isValid)
      err("bad point: y not sqrt");
    const isXOdd = (x & 1n) === 1n;
    const isLastByteOdd = (lastByte & 128) !== 0;
    if (!zip215 && x === 0n && isLastByteOdd)
      err("bad point: x==0, isLastByteOdd");
    if (isLastByteOdd !== isXOdd)
      x = M(-x);
    return new _Point(x, y, 1n, modP(x * y));
  }
  static fromHex(hex, zip215) {
    return _Point.fromBytes(hexToBytes(hex), zip215);
  }
  get x() {
    return this.toAffine().x;
  }
  get y() {
    return this.toAffine().y;
  }
  /** Checks if the point is valid and on-curve. */
  assertValidity() {
    const a = _a;
    const d = _d;
    const p = this;
    if (p.is0())
      return err("bad point: ZERO");
    const { X, Y, Z, T } = p;
    const X2 = modP(X * X);
    const Y2 = modP(Y * Y);
    const Z2 = modP(Z * Z);
    const Z4 = modP(Z2 * Z2);
    const aX2 = modP(X2 * a);
    const left = modP(Z2 * (aX2 + Y2));
    const right = M(Z4 + modP(d * modP(X2 * Y2)));
    if (left !== right)
      return err("bad point: equation left != right (1)");
    const XY = modP(X * Y);
    const ZT = modP(Z * T);
    if (XY !== ZT)
      return err("bad point: equation left != right (2)");
    return this;
  }
  /** Equality check: compare points P&Q. */
  equals(other) {
    const { X: X1, Y: Y1, Z: Z1 } = this;
    const { X: X2, Y: Y2, Z: Z2 } = apoint(other);
    const X1Z2 = modP(X1 * Z2);
    const X2Z1 = modP(X2 * Z1);
    const Y1Z2 = modP(Y1 * Z2);
    const Y2Z1 = modP(Y2 * Z1);
    return X1Z2 === X2Z1 && Y1Z2 === Y2Z1;
  }
  is0() {
    return this.equals(I);
  }
  /** Flip point over y coordinate. */
  negate() {
    return new _Point(M(-this.X), this.Y, this.Z, M(-this.T));
  }
  /** Point doubling. Complete formula. Cost: `4M + 4S + 1*a + 6add + 1*2`. */
  double() {
    const { X: X1, Y: Y1, Z: Z1 } = this;
    const a = _a;
    const A = modP(X1 * X1);
    const B = modP(Y1 * Y1);
    const C2 = modP(2n * Z1 * Z1);
    const D = modP(a * A);
    const x1y1 = M(X1 + Y1);
    const E = M(modP(x1y1 * x1y1) - A - B);
    const G2 = M(D + B);
    const F = M(G2 - C2);
    const H = M(D - B);
    const X3 = modP(E * F);
    const Y3 = modP(G2 * H);
    const T3 = modP(E * H);
    const Z3 = modP(F * G2);
    return new _Point(X3, Y3, Z3, T3);
  }
  /** Point addition. Complete formula. Cost: `8M + 1*k + 8add + 1*2`. */
  add(other) {
    const { X: X1, Y: Y1, Z: Z1, T: T1 } = this;
    const { X: X2, Y: Y2, Z: Z2, T: T2 } = apoint(other);
    const a = _a;
    const d = _d;
    const A = modP(X1 * X2);
    const B = modP(Y1 * Y2);
    const C2 = modP(modP(T1 * d) * T2);
    const D = modP(Z1 * Z2);
    const E = M(modP(M(X1 + Y1) * M(X2 + Y2)) - A - B);
    const F = M(D - C2);
    const G2 = M(D + C2);
    const H = M(B - modP(a * A));
    const X3 = modP(E * F);
    const Y3 = modP(G2 * H);
    const T3 = modP(E * H);
    const Z3 = modP(F * G2);
    return new _Point(X3, Y3, Z3, T3);
  }
  subtract(other) {
    return this.add(apoint(other).negate());
  }
  /**
   * Point-by-scalar multiplication. Safe mode requires `1 <= n < CURVE.n`.
   * Unsafe mode additionally permits `n = 0` and returns the identity point for that case.
   * Uses {@link wNAF} for base point.
   * Uses fake point to mitigate side-channel leakage.
   * @param n - scalar by which point is multiplied
   * @param safe - safe mode guards against timing attacks; unsafe mode is faster
   */
  multiply(n, safe = true) {
    if (!safe && n === 0n)
      return I;
    assertRange(n, 1n, N);
    if (!safe && this.is0())
      return I;
    if (n === 1n)
      return this;
    if (this.equals(G))
      return wNAF(n).p;
    let p = I;
    let f = G;
    for (let d = this; n > 0n; d = d.double(), n >>= 1n) {
      if (n & 1n)
        p = p.add(d);
      else if (safe)
        f = f.add(d);
    }
    return p;
  }
  multiplyUnsafe(scalar) {
    return this.multiply(scalar, false);
  }
  /** Convert point to 2d xy affine point. (X, Y, Z) ∋ (x=X/Z, y=Y/Z) */
  toAffine() {
    const { X, Y, Z } = this;
    if (this.equals(I))
      return { x: 0n, y: 1n };
    const iz = invert(Z, P);
    if (modP(Z * iz) !== 1n)
      err("invalid inverse");
    const x = modP(X * iz);
    const y = modP(Y * iz);
    return { x, y };
  }
  toBytes() {
    const { x, y } = this.toAffine();
    const b = numTo32bLE(y);
    b[31] |= x & 1n ? 128 : 0;
    return b;
  }
  toHex() {
    return bytesToHex(this.toBytes());
  }
  clearCofactor() {
    return this.multiply(big(h), false);
  }
  isSmallOrder() {
    return this.clearCofactor().is0();
  }
  isTorsionFree() {
    let p = this.multiply(N / 2n, false).double();
    if (N % 2n)
      p = p.add(this);
    return p.is0();
  }
};
var G = new Point(Gx, Gy, 1n, M(Gx * Gy));
var I = new Point(0n, 1n, 1n, 0n);
Point.BASE = G;
Point.ZERO = I;
var numTo32bLE = (num) => hexToBytes(padh(assertRange(num, 0n, B256), 64)).reverse();
var bytesToNumberLE = (b) => big("0x" + bytesToHex(u8fr(abytes(b)).reverse()));
var pow2 = (x, power) => {
  let r = x;
  while (power-- > 0n) {
    r = modP(r * r);
  }
  return r;
};
var pow_2_252_3 = (x) => {
  const x2 = modP(x * x);
  const b2 = modP(x2 * x);
  const b4 = modP(pow2(b2, 2n) * b2);
  const b5 = modP(pow2(b4, 1n) * x);
  const b10 = modP(pow2(b5, 5n) * b5);
  const b20 = modP(pow2(b10, 10n) * b10);
  const b40 = modP(pow2(b20, 20n) * b20);
  const b80 = modP(pow2(b40, 40n) * b40);
  const b160 = modP(pow2(b80, 80n) * b80);
  const b240 = modP(pow2(b160, 80n) * b80);
  const b250 = modP(pow2(b240, 10n) * b10);
  const pow_p_5_8 = modP(pow2(b250, 2n) * x);
  return { pow_p_5_8, b2 };
};
var RM1 = 0x2b8324804fc1df0b2b4d00993dfbd7a72f431806ad2fe478c4ee1b274a0ea0b0n;
var uvRatio = (u, v) => {
  const v3 = modP(v * modP(v * v));
  const v7 = modP(modP(v3 * v3) * v);
  const pow3 = pow_2_252_3(modP(u * v7)).pow_p_5_8;
  let x = modP(u * modP(v3 * pow3));
  const vx2 = modP(v * modP(x * x));
  const root1 = x;
  const root2 = modP(x * RM1);
  const useRoot1 = vx2 === u;
  const useRoot2 = vx2 === M(-u);
  const noRoot = vx2 === M(-u * RM1);
  if (useRoot1)
    x = root1;
  if (useRoot2 || noRoot)
    x = root2;
  if ((M(x) & 1n) === 1n)
    x = M(-x);
  return { isValid: useRoot1 || useRoot2, value: x };
};
var modL_LE = (hash) => modN(bytesToNumberLE(hash));
var sha512s = (...m) => checkDigest(callHash("sha512")(concatBytes(...m)));
var hash2extK = (hashed) => {
  const copy = u8fr(hashed);
  const head = copy.slice(0, 32);
  head[0] &= 248;
  head[31] &= 127;
  head[31] |= 64;
  const prefix = copy.slice(32, 64);
  const scalar = modL_LE(head);
  const point = G.multiply(scalar);
  const pointBytes = point.toBytes();
  return { head, prefix, scalar, point, pointBytes };
};
var getExtendedPublicKey = (secretKey) => hash2extK(sha512s(abytes(secretKey, L)));
var getPublicKey = (priv) => getExtendedPublicKey(priv).pointBytes;
var hashes = {
  sha512Async: async (message) => {
    const s = subtle();
    const m = concatBytes(message);
    return u8n(await s.digest("SHA-512", m.buffer));
  },
  sha512: void 0
};
var W = 8;
var scalarBits = 256;
var pwindows = Math.ceil(scalarBits / W) + 1;
var pwindowSize = 2 ** (W - 1);
var precompute = () => {
  const points = [];
  let p = G;
  let b = p;
  for (let w = 0; w < pwindows; w++) {
    b = p;
    points.push(b);
    for (let i = 1; i < pwindowSize; i++) {
      b = b.add(p);
      points.push(b);
    }
    p = b.double();
  }
  return points;
};
var Gpows = void 0;
var ctneg = (cnd, p) => {
  const n = p.negate();
  return cnd ? n : p;
};
var wNAF = (n) => {
  const comp = Gpows || (Gpows = precompute());
  let p = I;
  let f = G;
  const pow_2_w = 2 ** W;
  const maxNum = pow_2_w;
  const mask = big(pow_2_w - 1);
  const shiftBy = big(W);
  for (let w = 0; w < pwindows; w++) {
    let wbits = Number(n & mask);
    n >>= shiftBy;
    if (wbits > pwindowSize) {
      wbits -= maxNum;
      n += 1n;
    }
    const off = w * pwindowSize;
    const offF = off;
    const offP = off + Math.abs(wbits) - 1;
    const isEven = w % 2 !== 0;
    const isNeg = wbits < 0;
    if (wbits === 0) {
      f = f.add(ctneg(isEven, comp[offF]));
    } else {
      p = p.add(ctneg(isNeg, comp[offP]));
    }
  }
  if (n !== 0n)
    err("invalid wnaf");
  return { p, f };
};

// node_modules/@noble/hashes/_u64.js
var U32_MASK64 = /* @__PURE__ */ (() => BigInt(2 ** 32 - 1))();
var _32n = /* @__PURE__ */ BigInt(32);
function fromBig(n, le = false) {
  if (le)
    return { h: Number(n & U32_MASK64), l: Number(n >> _32n & U32_MASK64) };
  return { h: Number(n >> _32n & U32_MASK64) | 0, l: Number(n & U32_MASK64) | 0 };
}
function split(lst, le = false) {
  const len = lst.length;
  let Ah = new Uint32Array(len);
  let Al = new Uint32Array(len);
  for (let i = 0; i < len; i++) {
    const { h: h2, l } = fromBig(lst[i], le);
    [Ah[i], Al[i]] = [h2, l];
  }
  return [Ah, Al];
}
var fromNumH = (n) => n / 2 ** 32 | 0;
var fromNumL = (n) => n >>> 0;
function setU64FromNum(view, byteOffset, n, isLE) {
  const h2 = fromNumH(n);
  const l = fromNumL(n);
  view.setUint32(byteOffset, isLE ? l : h2, isLE);
  view.setUint32(byteOffset + 4, isLE ? h2 : l, isLE);
}
var shrSH = (h2, _l, s) => h2 >>> s;
var shrSL = (h2, l, s) => h2 << 32 - s | l >>> s;
var rotrSH = (h2, l, s) => h2 >>> s | l << 32 - s;
var rotrSL = (h2, l, s) => h2 << 32 - s | l >>> s;
var rotrBH = (h2, l, s) => h2 << 64 - s | l >>> s - 32;
var rotrBL = (h2, l, s) => h2 >>> s - 32 | l << 64 - s;
function add(Ah, Al, Bh, Bl) {
  const l = (Al >>> 0) + (Bl >>> 0);
  return { h: Ah + Bh + (l / 2 ** 32 | 0) | 0, l: l | 0 };
}
var add3L = (Al, Bl, Cl) => (Al >>> 0) + (Bl >>> 0) + (Cl >>> 0);
var add3H = (low, Ah, Bh, Ch) => Ah + Bh + Ch + (low / 2 ** 32 | 0) | 0;
var add4L = (Al, Bl, Cl, Dl) => (Al >>> 0) + (Bl >>> 0) + (Cl >>> 0) + (Dl >>> 0);
var add4H = (low, Ah, Bh, Ch, Dh) => Ah + Bh + Ch + Dh + (low / 2 ** 32 | 0) | 0;
var add5L = (Al, Bl, Cl, Dl, El) => (Al >>> 0) + (Bl >>> 0) + (Cl >>> 0) + (Dl >>> 0) + (El >>> 0);
var add5H = (low, Ah, Bh, Ch, Dh, Eh) => Ah + Bh + Ch + Dh + Eh + (low / 2 ** 32 | 0) | 0;

// node_modules/@noble/hashes/utils.js
function isBytes2(a) {
  return a instanceof Uint8Array || ArrayBuffer.isView(a) && a.constructor.name === "Uint8Array" && "BYTES_PER_ELEMENT" in a && a.BYTES_PER_ELEMENT === 1;
}
var atitle = (title) => title ? `"${title}" ` : "";
function anumber(n, title = "") {
  if (typeof n !== "number")
    throw new TypeError(atitle(title) + "expected number, got " + typeof n);
  if (!Number.isSafeInteger(n) || n < 0)
    throw new RangeError(atitle(title) + "expected integer >= 0, got " + n);
  return n;
}
function abytes2(value, length, title = "") {
  if (isBytes2(value) && (length === void 0 || value.length === length))
    return value;
  if (length !== void 0)
    anumber(length, "length");
  const bytes = isBytes2(value);
  const ofLen = length !== void 0 ? ` of length ${length}` : "";
  const got = bytes ? `length=${value.length}` : `type=${typeof value}`;
  const message = atitle(title) + "expected Uint8Array" + ofLen + ", got " + got;
  if (!bytes)
    throw new TypeError(message);
  throw new RangeError(message);
}
var aobject = (value, label) => {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError((label === "object" ? "" : `"${label}" `) + "expected object, got type=" + typeof value);
};
function aexists(instance, checkFinished = true) {
  if (instance.destroyed)
    throw new Error("hash was destroyed");
  if (checkFinished && instance.finished)
    throw new Error("digest() was already called");
}
function aoutput(out, instance) {
  abytes2(out, void 0, "output");
  const min = instance.outputLen;
  if (!(out.length >= min)) {
    throw new RangeError('"output" expected length >= ' + min);
  }
}
function clean(...arrays) {
  for (let i = 0; i < arrays.length; i++) {
    arrays[i].fill(0);
  }
}
function createView(arr) {
  return new DataView(arr.buffer, arr.byteOffset, arr.byteLength);
}
function rotr(word, shift) {
  return word << 32 - shift | word >>> shift;
}
var hasHexBuiltin = /* @__PURE__ */ (() => (
  // @ts-ignore
  typeof Uint8Array.from([]).toHex === "function" && typeof Uint8Array.fromHex === "function"
))();
var hexes = /* @__PURE__ */ Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));
function bytesToHex2(bytes) {
  abytes2(bytes);
  if (hasHexBuiltin)
    return bytes.toHex();
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += hexes[bytes[i]];
  }
  return hex;
}
function asciiToBase16(ch) {
  return ch >= 48 && ch <= 57 ? ch - 48 : ch >= 65 && ch <= 70 ? ch - (65 - 10) : ch >= 97 && ch <= 102 ? ch - (97 - 10) : void 0;
}
function hexToBytes2(hex) {
  if (typeof hex !== "string")
    throw new TypeError("hex string expected, got " + typeof hex);
  if (hasHexBuiltin) {
    try {
      return Uint8Array.fromHex(hex);
    } catch (error) {
      if (error instanceof SyntaxError)
        throw new RangeError(error.message);
      throw error;
    }
  }
  const hl = hex.length;
  const al = hl / 2;
  if (hl % 2)
    throw new RangeError("hex string expected, got unpadded hex of length " + hl);
  const array = new Uint8Array(al);
  for (let ai = 0, hi = 0; ai < al; ai++, hi += 2) {
    const n1 = asciiToBase16(hex.charCodeAt(hi));
    const n2 = asciiToBase16(hex.charCodeAt(hi + 1));
    if (n1 === void 0 || n2 === void 0) {
      const char = hex[hi] + hex[hi + 1];
      throw new RangeError('hex string expected, got non-hex character "' + char + '" at index ' + hi);
    }
    array[ai] = n1 * 16 + n2;
  }
  return array;
}
function concatBytes2(...arrays) {
  let sum = 0;
  for (let i = 0; i < arrays.length; i++) {
    const a = arrays[i];
    abytes2(a);
    sum += a.length;
  }
  const res = new Uint8Array(sum);
  for (let i = 0, pad2 = 0; i < arrays.length; i++) {
    const a = arrays[i];
    res.set(a, pad2);
    pad2 += a.length;
  }
  return res;
}
function checkOpts(defaults, opts, title = "opts") {
  aobject(defaults, "defaults");
  if (opts !== void 0)
    aobject(opts, title);
  const merged = Object.assign(defaults, opts);
  return merged;
}
function createHasher(hashCons, info = {}) {
  if (typeof hashCons !== "function")
    throw new TypeError('"hashCons" expected function, got type=' + typeof hashCons);
  info = checkOpts({}, info, "info");
  const hashC = (msg, opts) => hashCons(opts).update(msg).digest();
  const tmp = hashCons(void 0);
  hashC.outputLen = tmp.outputLen;
  hashC.blockLen = tmp.blockLen;
  hashC.canXOF = tmp.canXOF;
  hashC.create = (opts) => hashCons(opts);
  Object.assign(hashC, info);
  return Object.freeze(hashC);
}
function randomBytes(bytesLength = 32) {
  anumber(bytesLength, "bytesLength");
  const cr2 = typeof globalThis === "object" ? globalThis.crypto : null;
  if (typeof cr2?.getRandomValues !== "function")
    throw new Error("crypto.getRandomValues must be defined");
  if (bytesLength > 65536)
    throw new RangeError(`"bytesLength" expected <= 65536, got ${bytesLength}`);
  return cr2.getRandomValues(new Uint8Array(bytesLength));
}
var oidNist = (suffix) => ({
  // Current NIST hashAlgs suffixes used here fit in one DER subidentifier octet.
  // Larger suffix values would need base-128 OID encoding and a different length byte.
  oid: Uint8Array.from([6, 9, 96, 134, 72, 1, 101, 3, 4, 2, suffix])
});

// node_modules/@noble/hashes/_md.js
function Chi(a, b, c) {
  return a & b ^ ~a & c;
}
function Maj(a, b, c) {
  return a & b ^ a & c ^ b & c;
}
var HashMD = class {
  blockLen;
  outputLen;
  canXOF = false;
  padOffset;
  isLE;
  // For partial updates less than block size
  buffer;
  view;
  finished = false;
  length = 0;
  pos = 0;
  destroyed = false;
  constructor(blockLen, outputLen, padOffset, isLE) {
    this.blockLen = blockLen;
    this.outputLen = outputLen;
    this.padOffset = padOffset;
    this.isLE = isLE;
    this.buffer = new Uint8Array(blockLen);
    this.view = createView(this.buffer);
  }
  update(data) {
    aexists(this);
    abytes2(data);
    const { view, buffer, blockLen } = this;
    const len = data.length;
    let processed = false;
    for (let pos = 0; pos < len; ) {
      const take = Math.min(blockLen - this.pos, len - pos);
      if (take === blockLen) {
        const dataView = createView(data);
        for (; blockLen <= len - pos; pos += blockLen)
          this.process(dataView, pos);
        processed = true;
        continue;
      }
      buffer.set(pos === 0 && take === len ? data : data.subarray(pos, pos + take), this.pos);
      this.pos += take;
      pos += take;
      if (this.pos === blockLen) {
        this.process(view, 0);
        this.pos = 0;
        processed = true;
      }
    }
    this.length += data.length;
    if (processed)
      this.roundClean();
    return this;
  }
  digestInto(out) {
    aexists(this);
    aoutput(out, this);
    this.finished = true;
    const { buffer, view, blockLen, isLE } = this;
    let { pos } = this;
    buffer[pos++] = 128;
    buffer.fill(0, pos);
    if (this.padOffset > blockLen - pos) {
      this.process(view, 0);
      buffer.fill(0);
    }
    setU64FromNum(view, blockLen - 8, this.length * 8, isLE);
    this.process(view, 0);
    this.roundClean();
    const oview = out === buffer ? view : createView(out);
    const len = this.outputLen;
    const outLen = len / 4;
    const state = this.get();
    if (len % 4 || outLen > state.length)
      throw new Error("invalid outputLen");
    for (let i = 0; i < outLen; i++)
      oview.setUint32(4 * i, state[i], isLE);
  }
  digest() {
    const { buffer, outputLen } = this;
    this.digestInto(buffer);
    const res = buffer.slice(0, outputLen);
    this.destroy();
    return res;
  }
  _cloneIntoMeta(to) {
    const { buffer, length, finished, destroyed, pos } = this;
    to.destroyed = destroyed;
    to.finished = finished;
    to.length = length;
    to.pos = pos;
    if (pos)
      to.buffer.set(buffer);
    return to;
  }
  clone() {
    return this._cloneInto();
  }
};
var SHA256_IV = /* @__PURE__ */ Uint32Array.from([
  1779033703,
  3144134277,
  1013904242,
  2773480762,
  1359893119,
  2600822924,
  528734635,
  1541459225
]);
var SHA512_IV = /* @__PURE__ */ Uint32Array.from([
  1779033703,
  4089235720,
  3144134277,
  2227873595,
  1013904242,
  4271175723,
  2773480762,
  1595750129,
  1359893119,
  2917565137,
  2600822924,
  725511199,
  528734635,
  4215389547,
  1541459225,
  327033209
]);

// node_modules/@noble/hashes/sha2.js
var SHA256_K = /* @__PURE__ */ Uint32Array.from([
  1116352408,
  1899447441,
  3049323471,
  3921009573,
  961987163,
  1508970993,
  2453635748,
  2870763221,
  3624381080,
  310598401,
  607225278,
  1426881987,
  1925078388,
  2162078206,
  2614888103,
  3248222580,
  3835390401,
  4022224774,
  264347078,
  604807628,
  770255983,
  1249150122,
  1555081692,
  1996064986,
  2554220882,
  2821834349,
  2952996808,
  3210313671,
  3336571891,
  3584528711,
  113926993,
  338241895,
  666307205,
  773529912,
  1294757372,
  1396182291,
  1695183700,
  1986661051,
  2177026350,
  2456956037,
  2730485921,
  2820302411,
  3259730800,
  3345764771,
  3516065817,
  3600352804,
  4094571909,
  275423344,
  430227734,
  506948616,
  659060556,
  883997877,
  958139571,
  1322822218,
  1537002063,
  1747873779,
  1955562222,
  2024104815,
  2227730452,
  2361852424,
  2428436474,
  2756734187,
  3204031479,
  3329325298
]);
var SHA256_W = /* @__PURE__ */ new Uint32Array(64);
var SHA2_32B = class extends HashMD {
  // We cannot use array here since array allows indexing by variable
  // which means optimizer/compiler cannot use registers.
  // Numeric initializers matter: starting the fields as `undefined` changes
  // V8's field representation and makes sha256 3x slower (measured).
  A = 0;
  B = 0;
  C = 0;
  D = 0;
  E = 0;
  F = 0;
  G = 0;
  H = 0;
  constructor(outputLen, IV) {
    super(64, outputLen, 8, false);
    this.A = IV[0] | 0;
    this.B = IV[1] | 0;
    this.C = IV[2] | 0;
    this.D = IV[3] | 0;
    this.E = IV[4] | 0;
    this.F = IV[5] | 0;
    this.G = IV[6] | 0;
    this.H = IV[7] | 0;
  }
  get() {
    const { A, B, C: C2, D, E, F, G: G2, H } = this;
    return [A, B, C2, D, E, F, G2, H];
  }
  // prettier-ignore
  set(A, B, C2, D, E, F, G2, H) {
    this.A = A | 0;
    this.B = B | 0;
    this.C = C2 | 0;
    this.D = D | 0;
    this.E = E | 0;
    this.F = F | 0;
    this.G = G2 | 0;
    this.H = H | 0;
  }
  _cloneInto(to) {
    (to ||= new this.constructor()).set(...this.get());
    return this._cloneIntoMeta(to);
  }
  process(view, offset) {
    for (let i = 0; i < 16; i++, offset += 4)
      SHA256_W[i] = view.getUint32(offset, false);
    for (let i = 16; i < 64; i++) {
      const W15 = SHA256_W[i - 15];
      const W2 = SHA256_W[i - 2];
      const s0 = rotr(W15, 7) ^ rotr(W15, 18) ^ W15 >>> 3;
      const s1 = rotr(W2, 17) ^ rotr(W2, 19) ^ W2 >>> 10;
      SHA256_W[i] = s1 + SHA256_W[i - 7] + s0 + SHA256_W[i - 16] | 0;
    }
    let { A, B, C: C2, D, E, F, G: G2, H } = this;
    for (let i = 0; i < 64; i++) {
      const sigma1 = rotr(E, 6) ^ rotr(E, 11) ^ rotr(E, 25);
      const T1 = H + sigma1 + Chi(E, F, G2) + SHA256_K[i] + SHA256_W[i] | 0;
      const sigma0 = rotr(A, 2) ^ rotr(A, 13) ^ rotr(A, 22);
      const T2 = sigma0 + Maj(A, B, C2) | 0;
      H = G2;
      G2 = F;
      F = E;
      E = D + T1 | 0;
      D = C2;
      C2 = B;
      B = A;
      A = T1 + T2 | 0;
    }
    A = A + this.A | 0;
    B = B + this.B | 0;
    C2 = C2 + this.C | 0;
    D = D + this.D | 0;
    E = E + this.E | 0;
    F = F + this.F | 0;
    G2 = G2 + this.G | 0;
    H = H + this.H | 0;
    this.set(A, B, C2, D, E, F, G2, H);
  }
  roundClean() {
    clean(SHA256_W);
  }
  destroy() {
    this.destroyed = true;
    this.set(0, 0, 0, 0, 0, 0, 0, 0);
    clean(this.buffer);
  }
};
var _SHA256 = class extends SHA2_32B {
  constructor() {
    super(32, SHA256_IV);
  }
};
var K512 = /* @__PURE__ */ (() => split([
  "0x428a2f98d728ae22",
  "0x7137449123ef65cd",
  "0xb5c0fbcfec4d3b2f",
  "0xe9b5dba58189dbbc",
  "0x3956c25bf348b538",
  "0x59f111f1b605d019",
  "0x923f82a4af194f9b",
  "0xab1c5ed5da6d8118",
  "0xd807aa98a3030242",
  "0x12835b0145706fbe",
  "0x243185be4ee4b28c",
  "0x550c7dc3d5ffb4e2",
  "0x72be5d74f27b896f",
  "0x80deb1fe3b1696b1",
  "0x9bdc06a725c71235",
  "0xc19bf174cf692694",
  "0xe49b69c19ef14ad2",
  "0xefbe4786384f25e3",
  "0x0fc19dc68b8cd5b5",
  "0x240ca1cc77ac9c65",
  "0x2de92c6f592b0275",
  "0x4a7484aa6ea6e483",
  "0x5cb0a9dcbd41fbd4",
  "0x76f988da831153b5",
  "0x983e5152ee66dfab",
  "0xa831c66d2db43210",
  "0xb00327c898fb213f",
  "0xbf597fc7beef0ee4",
  "0xc6e00bf33da88fc2",
  "0xd5a79147930aa725",
  "0x06ca6351e003826f",
  "0x142929670a0e6e70",
  "0x27b70a8546d22ffc",
  "0x2e1b21385c26c926",
  "0x4d2c6dfc5ac42aed",
  "0x53380d139d95b3df",
  "0x650a73548baf63de",
  "0x766a0abb3c77b2a8",
  "0x81c2c92e47edaee6",
  "0x92722c851482353b",
  "0xa2bfe8a14cf10364",
  "0xa81a664bbc423001",
  "0xc24b8b70d0f89791",
  "0xc76c51a30654be30",
  "0xd192e819d6ef5218",
  "0xd69906245565a910",
  "0xf40e35855771202a",
  "0x106aa07032bbd1b8",
  "0x19a4c116b8d2d0c8",
  "0x1e376c085141ab53",
  "0x2748774cdf8eeb99",
  "0x34b0bcb5e19b48a8",
  "0x391c0cb3c5c95a63",
  "0x4ed8aa4ae3418acb",
  "0x5b9cca4f7763e373",
  "0x682e6ff3d6b2b8a3",
  "0x748f82ee5defb2fc",
  "0x78a5636f43172f60",
  "0x84c87814a1f0ab72",
  "0x8cc702081a6439ec",
  "0x90befffa23631e28",
  "0xa4506cebde82bde9",
  "0xbef9a3f7b2c67915",
  "0xc67178f2e372532b",
  "0xca273eceea26619c",
  "0xd186b8c721c0c207",
  "0xeada7dd6cde0eb1e",
  "0xf57d4f7fee6ed178",
  "0x06f067aa72176fba",
  "0x0a637dc5a2c898a6",
  "0x113f9804bef90dae",
  "0x1b710b35131c471b",
  "0x28db77f523047d84",
  "0x32caab7b40c72493",
  "0x3c9ebe0a15c9bebc",
  "0x431d67c49c100d4c",
  "0x4cc5d4becb3e42b6",
  "0x597f299cfc657e2a",
  "0x5fcb6fab3ad6faec",
  "0x6c44198c4a475817"
].map((n) => BigInt(n))))();
var SHA512_Kh = /* @__PURE__ */ (() => K512[0])();
var SHA512_Kl = /* @__PURE__ */ (() => K512[1])();
var SHA512_W_H = /* @__PURE__ */ new Uint32Array(80);
var SHA512_W_L = /* @__PURE__ */ new Uint32Array(80);
var SHA2_64B = class extends HashMD {
  // We cannot use array here since array allows indexing by variable
  // which means optimizer/compiler cannot use registers.
  // h -- high 32 bits, l -- low 32 bits
  // Numeric initializers matter: starting the fields as `undefined` changes
  // V8's field representation and slows hashing down (measured on sha256).
  Ah = 0;
  Al = 0;
  Bh = 0;
  Bl = 0;
  Ch = 0;
  Cl = 0;
  Dh = 0;
  Dl = 0;
  Eh = 0;
  El = 0;
  Fh = 0;
  Fl = 0;
  Gh = 0;
  Gl = 0;
  Hh = 0;
  Hl = 0;
  constructor(outputLen, IV) {
    super(128, outputLen, 16, false);
    this.Ah = IV[0] | 0;
    this.Al = IV[1] | 0;
    this.Bh = IV[2] | 0;
    this.Bl = IV[3] | 0;
    this.Ch = IV[4] | 0;
    this.Cl = IV[5] | 0;
    this.Dh = IV[6] | 0;
    this.Dl = IV[7] | 0;
    this.Eh = IV[8] | 0;
    this.El = IV[9] | 0;
    this.Fh = IV[10] | 0;
    this.Fl = IV[11] | 0;
    this.Gh = IV[12] | 0;
    this.Gl = IV[13] | 0;
    this.Hh = IV[14] | 0;
    this.Hl = IV[15] | 0;
  }
  // prettier-ignore
  get() {
    const { Ah, Al, Bh, Bl, Ch, Cl, Dh, Dl, Eh, El, Fh, Fl, Gh, Gl, Hh, Hl } = this;
    return [Ah, Al, Bh, Bl, Ch, Cl, Dh, Dl, Eh, El, Fh, Fl, Gh, Gl, Hh, Hl];
  }
  // prettier-ignore
  set(Ah, Al, Bh, Bl, Ch, Cl, Dh, Dl, Eh, El, Fh, Fl, Gh, Gl, Hh, Hl) {
    this.Ah = Ah | 0;
    this.Al = Al | 0;
    this.Bh = Bh | 0;
    this.Bl = Bl | 0;
    this.Ch = Ch | 0;
    this.Cl = Cl | 0;
    this.Dh = Dh | 0;
    this.Dl = Dl | 0;
    this.Eh = Eh | 0;
    this.El = El | 0;
    this.Fh = Fh | 0;
    this.Fl = Fl | 0;
    this.Gh = Gh | 0;
    this.Gl = Gl | 0;
    this.Hh = Hh | 0;
    this.Hl = Hl | 0;
  }
  _cloneInto(to) {
    (to ||= new this.constructor()).set(...this.get());
    return this._cloneIntoMeta(to);
  }
  process(view, offset) {
    for (let i = 0; i < 16; i++, offset += 4) {
      SHA512_W_H[i] = view.getUint32(offset);
      SHA512_W_L[i] = view.getUint32(offset += 4);
    }
    for (let i = 16; i < 80; i++) {
      const W15h = SHA512_W_H[i - 15] | 0;
      const W15l = SHA512_W_L[i - 15] | 0;
      const s0h = rotrSH(W15h, W15l, 1) ^ rotrSH(W15h, W15l, 8) ^ shrSH(W15h, W15l, 7);
      const s0l = rotrSL(W15h, W15l, 1) ^ rotrSL(W15h, W15l, 8) ^ shrSL(W15h, W15l, 7);
      const W2h = SHA512_W_H[i - 2] | 0;
      const W2l = SHA512_W_L[i - 2] | 0;
      const s1h = rotrSH(W2h, W2l, 19) ^ rotrBH(W2h, W2l, 61) ^ shrSH(W2h, W2l, 6);
      const s1l = rotrSL(W2h, W2l, 19) ^ rotrBL(W2h, W2l, 61) ^ shrSL(W2h, W2l, 6);
      const SUMl = add4L(s0l, s1l, SHA512_W_L[i - 7], SHA512_W_L[i - 16]);
      const SUMh = add4H(SUMl, s0h, s1h, SHA512_W_H[i - 7], SHA512_W_H[i - 16]);
      SHA512_W_H[i] = SUMh | 0;
      SHA512_W_L[i] = SUMl | 0;
    }
    let { Ah, Al, Bh, Bl, Ch, Cl, Dh, Dl, Eh, El, Fh, Fl, Gh, Gl, Hh, Hl } = this;
    for (let i = 0; i < 80; i++) {
      const sigma1h = rotrSH(Eh, El, 14) ^ rotrSH(Eh, El, 18) ^ rotrBH(Eh, El, 41);
      const sigma1l = rotrSL(Eh, El, 14) ^ rotrSL(Eh, El, 18) ^ rotrBL(Eh, El, 41);
      const CHIh = Eh & Fh ^ ~Eh & Gh;
      const CHIl = El & Fl ^ ~El & Gl;
      const T1ll = add5L(Hl, sigma1l, CHIl, SHA512_Kl[i], SHA512_W_L[i]);
      const T1h = add5H(T1ll, Hh, sigma1h, CHIh, SHA512_Kh[i], SHA512_W_H[i]);
      const T1l = T1ll | 0;
      const sigma0h = rotrSH(Ah, Al, 28) ^ rotrBH(Ah, Al, 34) ^ rotrBH(Ah, Al, 39);
      const sigma0l = rotrSL(Ah, Al, 28) ^ rotrBL(Ah, Al, 34) ^ rotrBL(Ah, Al, 39);
      const MAJh = Ah & Bh ^ Ah & Ch ^ Bh & Ch;
      const MAJl = Al & Bl ^ Al & Cl ^ Bl & Cl;
      Hh = Gh | 0;
      Hl = Gl | 0;
      Gh = Fh | 0;
      Gl = Fl | 0;
      Fh = Eh | 0;
      Fl = El | 0;
      ({ h: Eh, l: El } = add(Dh | 0, Dl | 0, T1h | 0, T1l | 0));
      Dh = Ch | 0;
      Dl = Cl | 0;
      Ch = Bh | 0;
      Cl = Bl | 0;
      Bh = Ah | 0;
      Bl = Al | 0;
      const All = add3L(T1l, sigma0l, MAJl);
      Ah = add3H(All, T1h, sigma0h, MAJh);
      Al = All | 0;
    }
    ({ h: Ah, l: Al } = add(this.Ah | 0, this.Al | 0, Ah | 0, Al | 0));
    ({ h: Bh, l: Bl } = add(this.Bh | 0, this.Bl | 0, Bh | 0, Bl | 0));
    ({ h: Ch, l: Cl } = add(this.Ch | 0, this.Cl | 0, Ch | 0, Cl | 0));
    ({ h: Dh, l: Dl } = add(this.Dh | 0, this.Dl | 0, Dh | 0, Dl | 0));
    ({ h: Eh, l: El } = add(this.Eh | 0, this.El | 0, Eh | 0, El | 0));
    ({ h: Fh, l: Fl } = add(this.Fh | 0, this.Fl | 0, Fh | 0, Fl | 0));
    ({ h: Gh, l: Gl } = add(this.Gh | 0, this.Gl | 0, Gh | 0, Gl | 0));
    ({ h: Hh, l: Hl } = add(this.Hh | 0, this.Hl | 0, Hh | 0, Hl | 0));
    this.set(Ah, Al, Bh, Bl, Ch, Cl, Dh, Dl, Eh, El, Fh, Fl, Gh, Gl, Hh, Hl);
  }
  roundClean() {
    clean(SHA512_W_H, SHA512_W_L);
  }
  destroy() {
    this.destroyed = true;
    clean(this.buffer);
    this.set(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
  }
};
var _SHA512 = class extends SHA2_64B {
  constructor() {
    super(64, SHA512_IV);
  }
};
var sha256 = /* @__PURE__ */ createHasher(
  () => new _SHA256(),
  /* @__PURE__ */ oidNist(1)
);
var sha512 = /* @__PURE__ */ createHasher(
  () => new _SHA512(),
  /* @__PURE__ */ oidNist(3)
);

// src/security/identity.ts
function concat(...arrs) {
  const total = arrs.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrs) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}
function toHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
function deriveDeviceId(publicKey) {
  return "d-" + toHex(sha256(publicKey));
}
hashes.sha512 = sha512;
function generateIdentity() {
  const privateKey = randomBytes2(32);
  const publicKey = getPublicKey(privateKey);
  return { deviceId: deriveDeviceId(publicKey), publicKey, privateKey };
}
function identityFromPrivateKey(privateKey) {
  const publicKey = getPublicKey(privateKey);
  return { deviceId: deriveDeviceId(publicKey), publicKey, privateKey };
}

// src/network/noise_transport.ts
import { createRequire } from "node:module";

// node_modules/@noble/curves/utils.js
function aarray(item, title, inner = () => {
}) {
  if (!Array.isArray(item))
    throw new TypeError(`"${title}" expected array, got type=${typeof item}`);
  for (let i = 0; i < item.length; i++)
    inner(item[i], `${title}[${i}]`);
  return item;
}
var abytes3 = (value, length, title) => abytes2(value, length, title);
var anumber2 = anumber;
function aobject2(value, title = "object") {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError(title === "object" ? "expected valid options object" : `"${title}" expected object, got type=${typeof value}`);
  return value;
}
function afunction(value, title) {
  if (typeof value !== "function")
    throw new TypeError(`"${title}" is invalid: expected function, got ${typeof value}`);
  return value;
}
var bytesToHex3 = bytesToHex2;
var concatBytes3 = (...arrays) => concatBytes2(...arrays);
var hexToBytes3 = (hex) => hexToBytes2(hex);
var isBytes3 = isBytes2;
var randomBytes3 = (bytesLength) => randomBytes(bytesLength);
var _0n = /* @__PURE__ */ BigInt(0);
var _1n = /* @__PURE__ */ BigInt(1);
var atitle2 = (title) => title ? `"${title}" ` : "";
function abool(value, title = "") {
  if (typeof value !== "boolean")
    throw new TypeError(atitle2(title) + "expected boolean, got type=" + typeof value);
  return value;
}
function abignumber(n) {
  if (typeof n === "bigint") {
    if (!isPosBig(n))
      throw new RangeError("positive bigint expected, got " + n);
  } else
    anumber2(n);
  return n;
}
function asafenumber(value, title = "") {
  if (typeof value !== "number") {
    const prefix = title && `"${title}" `;
    throw new TypeError(prefix + "expected number, got type=" + typeof value);
  }
  if (!Number.isSafeInteger(value)) {
    const prefix = title && `"${title}" `;
    throw new RangeError(prefix + "expected safe integer, got " + value);
  }
}
function hexToNumber(hex) {
  if (typeof hex !== "string")
    throw new TypeError("hex string expected, got " + typeof hex);
  return hex === "" ? _0n : BigInt("0x" + hex);
}
function bytesToNumberBE(bytes) {
  return hexToNumber(bytesToHex2(bytes));
}
function bytesToNumberLE2(bytes) {
  return hexToNumber(bytesToHex2(copyBytes(abytes2(bytes)).reverse()));
}
function numberToBytesBE(n, len) {
  anumber(len);
  if (len === 0)
    throw new Error("zero output length is invalid");
  n = abignumber(n);
  const expectedLen = len * 2;
  const hex = n.toString(16);
  if (hex.length > expectedLen)
    throw new RangeError("number is too large");
  return hexToBytes2(hex.padStart(expectedLen, "0"));
}
function numberToBytesLE(n, len) {
  return numberToBytesBE(n, len).reverse();
}
function copyBytes(bytes) {
  return Uint8Array.from(abytes3(bytes));
}
function isPosBig(n) {
  return typeof n === "bigint" && _0n <= n;
}
function inRange(n, min, max) {
  return isPosBig(n) && isPosBig(min) && isPosBig(max) && min <= n && n < max;
}
function aInRange(title, n, min, max) {
  if (!inRange(n, min, max))
    throw new RangeError("expected valid " + title + ": " + min + " <= n < " + max + ", got " + n);
}
function bitLen(n) {
  if (n < _0n)
    throw new Error("expected non-negative bigint, got " + n);
  return n === _0n ? 0 : n.toString(2).length;
}
var bitMask = (n) => {
  asafenumber(n, "n");
  return (_1n << BigInt(n)) - _1n;
};
function validateObject(object, fields = {}, optFields = {}, title = "object") {
  aobject2(object, title);
  aobject2(fields, "fields");
  aobject2(optFields, "optFields");
  function checkField(fieldName, expectedType, isOpt) {
    const label = title === "object" ? `param "${String(fieldName)}"` : `"${title}.${String(fieldName)}"`;
    const val = object[fieldName];
    if (!Object.hasOwn(object, fieldName) && (isOpt ? val !== void 0 : expectedType !== "function")) {
      throw new TypeError(`${label} is invalid: expected own property`);
    }
    if (isOpt && val === void 0)
      return;
    const current = typeof val;
    if (current !== expectedType || val === null)
      throw new TypeError(`${label} is invalid: expected ${expectedType}, got ${current}`);
  }
  const iter = (f, isOpt) => Object.entries(f).forEach(([k, v]) => checkField(k, v, isOpt));
  iter(fields, false);
  iter(optFields, true);
}

// node_modules/@noble/curves/abstract/modular.js
var _0n2 = /* @__PURE__ */ BigInt(0);
var _1n2 = /* @__PURE__ */ BigInt(1);
var _2n = /* @__PURE__ */ BigInt(2);
var _3n = /* @__PURE__ */ BigInt(3);
var _4n = /* @__PURE__ */ BigInt(4);
var _5n = /* @__PURE__ */ BigInt(5);
var _7n = /* @__PURE__ */ BigInt(7);
var _8n = /* @__PURE__ */ BigInt(8);
var _9n = /* @__PURE__ */ BigInt(9);
var _15n = /* @__PURE__ */ BigInt(15);
var _16n = /* @__PURE__ */ BigInt(16);
var POW_WINDOWED_MIN = /* @__PURE__ */ BigInt("0x10000000000000000");
function mod(a, b) {
  if (b <= _0n2)
    throw new Error("mod: expected positive modulus, got " + b);
  const result = a % b;
  return result >= _0n2 ? result : b + result;
}
function pow(num, power, modulo) {
  if (modulo <= _1n2)
    throw new Error("pow: expected modulus > 1, got " + modulo);
  if (typeof power !== "bigint")
    throw new TypeError("invalid exponent: expected bigint, got " + typeof power);
  if (power < _0n2)
    throw new Error("invalid exponent, negatives unsupported");
  if (power === _0n2)
    return _1n2;
  if (power === _1n2)
    return num;
  let d = num % modulo;
  if (d < _0n2)
    d += modulo;
  if (power < POW_WINDOWED_MIN) {
    let p2 = _1n2;
    while (power > _0n2) {
      if (power & _1n2)
        p2 = p2 * d % modulo;
      d = d * d % modulo;
      power >>= _1n2;
    }
    return p2;
  }
  const digits = [];
  while (power > _0n2) {
    digits.push(Number(power & _15n));
    power >>= _4n;
  }
  const table = new Array(16);
  table[0] = _1n2;
  table[1] = d;
  for (let i = 2; i < 16; i++)
    table[i] = table[i - 1] * d % modulo;
  let p = table[digits[digits.length - 1]];
  for (let w = digits.length - 2; w >= 0; w--) {
    p = p * p % modulo;
    p = p * p % modulo;
    p = p * p % modulo;
    p = p * p % modulo;
    const digit = digits[w];
    if (digit !== 0)
      p = p * table[digit] % modulo;
  }
  return p;
}
function pow22(x, power, modulo) {
  if (modulo <= _1n2)
    throw new Error("pow2: expected modulus > 1, got " + modulo);
  if (power < _0n2)
    throw new Error("pow2: expected non-negative exponent, got " + power);
  let res = x;
  while (power-- > _0n2) {
    res *= res;
    res %= modulo;
  }
  return res;
}
function invert2(number, modulo) {
  if (number === _0n2)
    throw new Error("invert: expected non-zero number");
  if (modulo <= _1n2)
    throw new Error("invert: expected modulus > 1, got " + modulo);
  let a = mod(number, modulo);
  let b = modulo;
  let x = _0n2, u = _1n2;
  while (a !== _0n2) {
    const q = b / a;
    const r = b - a * q;
    const m = x - u * q;
    b = a, a = r, x = u, u = m;
  }
  const gcd = b;
  if (gcd !== _1n2)
    throw new Error("invert: does not exist");
  return mod(x, modulo);
}
function assertIsSquare(Fp2, root, n) {
  const F = Fp2;
  if (!F.eql(F.sqr(root), n))
    throw new Error("Cannot find square root");
}
function aoddModulus(order, fnName) {
  if ((order & _1n2) === _0n2)
    throw new Error(fnName + ": expected odd modulus, got " + order);
}
function sqrt3mod4(Fp2, n) {
  const F = Fp2;
  const p1div4 = (F.ORDER + _1n2) / _4n;
  const root = F.pow(n, p1div4);
  assertIsSquare(F, root, n);
  return root;
}
function sqrt5mod8(Fp2, n) {
  const F = Fp2;
  const p5div8 = (F.ORDER - _5n) / _8n;
  const n2 = F.mul(n, _2n);
  const v = F.pow(n2, p5div8);
  const nv = F.mul(n, v);
  const i = F.mul(F.mul(nv, _2n), v);
  const root = F.mul(nv, F.sub(i, F.ONE));
  assertIsSquare(F, root, n);
  return root;
}
function sqrt9mod16(P2) {
  const Fp_ = Field(P2);
  const tn = tonelliShanks(P2);
  const c1 = tn(Fp_, Fp_.neg(Fp_.ONE));
  const c2 = tn(Fp_, c1);
  const c3 = tn(Fp_, Fp_.neg(c1));
  const c4 = (P2 + _7n) / _16n;
  return ((Fp2, n) => {
    const F = Fp2;
    let tv1 = F.pow(n, c4);
    let tv2 = F.mul(tv1, c1);
    const tv3 = F.mul(tv1, c2);
    const tv4 = F.mul(tv1, c3);
    const e1 = F.eql(F.sqr(tv2), n);
    const e2 = F.eql(F.sqr(tv3), n);
    tv1 = F.cmov(tv1, tv2, e1);
    tv2 = F.cmov(tv4, tv3, e2);
    const e3 = F.eql(F.sqr(tv2), n);
    const root = F.cmov(tv1, tv2, e3);
    assertIsSquare(F, root, n);
    return root;
  });
}
function tonelliShanks(P2) {
  if (P2 < _3n)
    throw new Error("sqrt is not defined for small field");
  aoddModulus(P2, "tonelliShanks");
  let Q = P2 - _1n2;
  let S = 0;
  while (Q % _2n === _0n2) {
    Q /= _2n;
    S++;
  }
  let Z = _2n;
  const _Fp = Field(P2);
  while (FpLegendre(_Fp, Z) === 1) {
    if (Z++ > 1e3)
      throw new Error("Cannot find square root: probably non-prime P");
  }
  if (S === 1)
    return sqrt3mod4;
  let cc = _Fp.pow(Z, Q);
  const Q1div2 = (Q + _1n2) / _2n;
  return function tonelliSlow(Fp2, n) {
    const F = Fp2;
    if (F.is0(n))
      return n;
    if (FpLegendre(F, n) !== 1)
      throw new Error("Cannot find square root");
    let M2 = S;
    let c = F.mul(F.ONE, cc);
    let t = F.pow(n, Q);
    let R = F.pow(n, Q1div2);
    while (!F.eql(t, F.ONE)) {
      if (F.is0(t))
        throw new Error("Cannot find square root: probably non-prime P");
      let i = 1;
      let t_tmp = F.sqr(t);
      while (!F.eql(t_tmp, F.ONE)) {
        i++;
        t_tmp = F.sqr(t_tmp);
        if (i === M2)
          throw new Error("Cannot find square root");
      }
      const exponent = _1n2 << BigInt(M2 - i - 1);
      const b = F.pow(c, exponent);
      M2 = i;
      c = F.sqr(b);
      t = F.mul(t, c);
      R = F.mul(R, b);
    }
    return R;
  };
}
function FpSqrt(P2) {
  aoddModulus(P2, "Fp.sqrt");
  if (P2 % _4n === _3n)
    return sqrt3mod4;
  if (P2 % _8n === _5n)
    return sqrt5mod8;
  if (P2 % _16n === _9n)
    return sqrt9mod16(P2);
  return tonelliShanks(P2);
}
var isNegativeLE = (num, modulo) => (mod(num, modulo) & _1n2) === _1n2;
var FIELD_FIELDS = [
  "create",
  "isValid",
  "is0",
  "neg",
  "inv",
  "sqrt",
  "sqr",
  "eql",
  "add",
  "sub",
  "mul",
  "pow",
  "div",
  "addN",
  "subN",
  "mulN",
  "sqrN"
];
function validateField(field) {
  aobject2(field, "field");
  if (typeof field.ORDER !== "bigint")
    throw new TypeError('param "ORDER" is invalid: expected bigint, got ' + typeof field.ORDER);
  asafenumber(field.BYTES, "BYTES");
  asafenumber(field.BITS, "BITS");
  for (const name of FIELD_FIELDS)
    afunction(field[name], "field." + name);
  if (field.BYTES < 1 || field.BITS < 1)
    throw new Error("invalid field: expected BYTES/BITS > 0");
  if (field.ORDER <= _1n2)
    throw new Error("invalid field: expected ORDER > 1, got " + field.ORDER);
  return field;
}
function FpInvertBatch(Fp2, nums, passZero = false) {
  validateField(Fp2);
  aarray(nums, "nums");
  abool(passZero, "passZero");
  const F = Fp2;
  const inverted = new Array(nums.length).fill(passZero ? F.ZERO : void 0);
  const multipliedAcc = nums.reduce((acc, num, i) => {
    if (F.is0(num))
      return acc;
    inverted[i] = acc;
    return F.mul(acc, num);
  }, F.ONE);
  const invertedAcc = F.inv(multipliedAcc);
  nums.reduceRight((acc, num, i) => {
    if (F.is0(num))
      return acc;
    inverted[i] = F.mul(acc, inverted[i]);
    return F.mul(acc, num);
  }, invertedAcc);
  return inverted;
}
function FpLegendre(Fp2, n) {
  validateField(Fp2);
  const F = Fp2;
  aoddModulus(F.ORDER, "FpLegendre");
  const p1mod2 = (F.ORDER - _1n2) / _2n;
  const powered = F.pow(n, p1mod2);
  const yes = F.eql(powered, F.ONE);
  const zero = F.eql(powered, F.ZERO);
  const no = F.eql(powered, F.neg(F.ONE));
  if (!yes && !zero && !no)
    throw new Error("invalid Legendre symbol result");
  return yes ? 1 : zero ? 0 : -1;
}
function nLength(n, nBitLength) {
  if (nBitLength !== void 0)
    anumber2(nBitLength);
  if (n <= _0n2)
    throw new Error("invalid n length: expected positive n, got " + n);
  if (nBitLength !== void 0 && nBitLength < 1)
    throw new Error("invalid n length: expected positive bit length, got " + nBitLength);
  const bits = bitLen(n);
  if (nBitLength !== void 0 && nBitLength < bits)
    throw new Error(`invalid n length: expected nBitLength (${nBitLength}) >= bitLen(n) (${bits})`);
  const _nBitLength = nBitLength !== void 0 ? nBitLength : bits;
  const nByteLength = Math.ceil(_nBitLength / 8);
  return { nBitLength: _nBitLength, nByteLength };
}
var FIELD_SQRT = /* @__PURE__ */ new WeakMap();
var _Field = class {
  ORDER;
  BITS;
  BYTES;
  isLE;
  ZERO = _0n2;
  ONE = _1n2;
  _lengths;
  _mod;
  constructor(ORDER, opts = {}) {
    if (ORDER <= _1n2)
      throw new Error("invalid field: expected ORDER > 1, got " + ORDER);
    let _nbitLength = void 0;
    this.isLE = false;
    if (opts != null && typeof opts === "object") {
      if (typeof opts.BITS === "number")
        _nbitLength = opts.BITS;
      if (typeof opts.sqrt === "function")
        Object.defineProperty(this, "sqrt", { value: opts.sqrt, enumerable: true });
      if (typeof opts.isLE === "boolean")
        this.isLE = opts.isLE;
      if (opts.allowedLengths)
        this._lengths = Object.freeze(opts.allowedLengths.slice());
      if (typeof opts.modFromBytes === "boolean")
        this._mod = opts.modFromBytes;
    }
    const { nBitLength, nByteLength } = nLength(ORDER, _nbitLength);
    if (nByteLength > 2048)
      throw new Error("invalid field: expected ORDER of <= 2048 bytes");
    this.ORDER = ORDER;
    this.BITS = nBitLength;
    this.BYTES = nByteLength;
    Object.freeze(this);
  }
  create(num) {
    return mod(num, this.ORDER);
  }
  isValid(num) {
    if (typeof num !== "bigint")
      throw new TypeError("invalid field element: expected bigint, got " + typeof num);
    return _0n2 <= num && num < this.ORDER;
  }
  is0(num) {
    return num === _0n2;
  }
  // is valid and invertible
  isValidNot0(num) {
    return !this.is0(num) && this.isValid(num);
  }
  isOdd(num) {
    return (num & _1n2) === _1n2;
  }
  neg(num) {
    return mod(-num, this.ORDER);
  }
  eql(lhs, rhs) {
    return lhs === rhs;
  }
  sqr(num) {
    return mod(num * num, this.ORDER);
  }
  add(lhs, rhs) {
    return mod(lhs + rhs, this.ORDER);
  }
  sub(lhs, rhs) {
    return mod(lhs - rhs, this.ORDER);
  }
  mul(lhs, rhs) {
    return mod(lhs * rhs, this.ORDER);
  }
  pow(num, power) {
    return pow(num, power, this.ORDER);
  }
  div(lhs, rhs) {
    return mod(lhs * invert2(rhs, this.ORDER), this.ORDER);
  }
  // Same as above, but doesn't normalize
  sqrN(num) {
    return num * num;
  }
  addN(lhs, rhs) {
    return lhs + rhs;
  }
  subN(lhs, rhs) {
    return lhs - rhs;
  }
  mulN(lhs, rhs) {
    return lhs * rhs;
  }
  inv(num) {
    return invert2(num, this.ORDER);
  }
  sqrt(num) {
    let sqrt = FIELD_SQRT.get(this);
    if (!sqrt)
      FIELD_SQRT.set(this, sqrt = FpSqrt(this.ORDER));
    return sqrt(this, num);
  }
  toBytes(num) {
    return this.isLE ? numberToBytesLE(num, this.BYTES) : numberToBytesBE(num, this.BYTES);
  }
  fromBytes(bytes, skipValidation = false) {
    abytes3(bytes);
    const { _lengths: allowedLengths, BYTES, isLE, ORDER, _mod: modFromBytes } = this;
    if (allowedLengths) {
      if (bytes.length < 1 || !allowedLengths.includes(bytes.length) || bytes.length > BYTES) {
        throw new Error("Field.fromBytes: expected " + allowedLengths + " bytes, got " + bytes.length);
      }
      const padded = new Uint8Array(BYTES);
      padded.set(bytes, isLE ? 0 : padded.length - bytes.length);
      bytes = padded;
    }
    if (bytes.length !== BYTES)
      throw new Error("Field.fromBytes: expected " + BYTES + " bytes, got " + bytes.length);
    let scalar = isLE ? bytesToNumberLE2(bytes) : bytesToNumberBE(bytes);
    if (modFromBytes)
      scalar = mod(scalar, ORDER);
    if (!skipValidation) {
      if (!this.isValid(scalar))
        throw new Error("invalid field element: outside of range 0..ORDER");
    }
    return scalar;
  }
  // TODO: we don't need it here, move out to separate fn
  invertBatch(lst) {
    return FpInvertBatch(this, lst, true);
  }
  // We can't move this out because Fp6, Fp12 implement it
  // and it's unclear what to return in there.
  cmov(a, b, condition) {
    abool(condition, "condition");
    return condition ? b : a;
  }
};
function Field(ORDER, opts = {}) {
  Object.freeze(_Field.prototype);
  return new _Field(ORDER, opts);
}

// node_modules/@noble/curves/abstract/curve.js
var _0n3 = /* @__PURE__ */ BigInt(0);
var _1n3 = /* @__PURE__ */ BigInt(1);
var _4n2 = /* @__PURE__ */ BigInt(4);
var BLIND_BYTES = 16;
var BLIND_BITS = 128;
var FW_WINDOW = 5;
var TABLE_BYTES_MAX = /* @__PURE__ */ (() => 2 ** 31)();
function validatePointCons(Point2) {
  const pc = Point2;
  if (typeof pc !== "function")
    throw new TypeError('"Point" expected constructor, got type=' + typeof Point2);
  afunction(pc.fromAffine, "Point.fromAffine");
  afunction(pc.fromBytes, "Point.fromBytes");
  afunction(pc.fromHex, "Point.fromHex");
  aobject2(pc.BASE, "Point.BASE");
  aobject2(pc.ZERO, "Point.ZERO");
  validateField(pc.Fp);
  validateField(pc.Fn);
}
function normalizeZ(c, points) {
  validatePointCons(c);
  validateMSMPoints(points, c);
  const invertedZs = FpInvertBatch(c.Fp, points.map((p) => p.Z));
  return points.map((p, i) => c.fromAffine(p.toAffine(invertedZs[i])));
}
function validateW(W2, bits, min = 1) {
  if (!Number.isSafeInteger(W2) || W2 < min || W2 > bits)
    throw new Error("invalid window size, expected [" + min + ".." + bits + "], got W=" + W2);
}
function validateTableBytes(numPoints, fpBytes) {
  const bytes = numPoints * (4 * fpBytes + 128);
  if (bytes > TABLE_BYTES_MAX)
    throw new Error("invalid window size: table would need ~" + Math.ceil(bytes / 2 ** 20) + " MiB, max " + TABLE_BYTES_MAX / 2 ** 20 + " MiB");
}
function probeRandomBytes(randomBytes7, length) {
  if (randomBytes7 === void 0)
    return void 0;
  afunction(randomBytes7, "randomBytes");
  try {
    const probe = randomBytes7(length);
    if (!isBytes3(probe) || probe.length !== length)
      return void 0;
  } catch {
    return void 0;
  }
  return randomBytes7;
}
function validateMSMPoints(points, c) {
  aarray(points, "points");
  points.forEach((p, i) => {
    if (!(p instanceof c))
      throw new Error("invalid point at index " + i);
  });
}
function validateMSMScalars(scalars, field, maxScalar) {
  if (!Array.isArray(scalars))
    throw new Error("array of scalars expected");
  scalars.forEach((s, i) => {
    const ok = maxScalar === void 0 ? field.isValid(s) : isPosBig(s) && s < maxScalar;
    if (!ok)
      throw new Error("invalid scalar at index " + i);
  });
}
var pointWindowSizes = /* @__PURE__ */ new WeakMap();
function getWindowSize(P2) {
  return pointWindowSizes.get(P2) || 1;
}
function oddMultiples(p, size) {
  const dbl = p.double();
  const t = [p];
  for (let j = 1; j < size; j++)
    t.push(t[j - 1].add(dbl));
  return t;
}
function wnafDigits(n, W2) {
  const size = 2 ** W2;
  const half = size / 2;
  const mask = BigInt(size - 1);
  const d = [];
  while (n > _0n3) {
    let w = 0;
    if (n & _1n3) {
      w = Number(n & mask);
      if (w >= half)
        w -= size;
      n -= BigInt(w);
    }
    d.push(w);
    n >>= _1n3;
  }
  return d;
}
function signedWindowDigits(n, W2, windows) {
  const size = 2 ** W2;
  const half = size / 2;
  const mask = BigInt(size - 1);
  const shiftBy = BigInt(W2);
  const d = [];
  for (let w = 0; w < windows; w++) {
    let v = Number(n & mask);
    n >>= shiftBy;
    if (v > half) {
      v -= size;
      n += _1n3;
    }
    d.push(v);
  }
  if (n !== _0n3)
    throw new Error("invalid wnaf");
  return d;
}
function wnafWalk(zero, tables, digits) {
  let max = 0;
  for (const d of digits)
    max = Math.max(max, d.length);
  let acc = zero;
  for (let bit = max - 1; bit >= 0; bit--) {
    if (bit !== max - 1)
      acc = acc.double();
    for (let i = 0; i < digits.length; i++) {
      const w = digits[i][bit];
      if (w) {
        const item = tables[i][Math.abs(w) - 1 >> 1];
        acc = acc.add(w < 0 ? item.negate() : item);
      }
    }
  }
  return acc;
}
var ScalarMultiplier = class {
  Point;
  BASE;
  ZERO;
  randomBytes;
  wnafPrecomputes = /* @__PURE__ */ new WeakMap();
  baseCanBeBlinded;
  bits;
  // Parametrized with a given Point class (not individual point)
  constructor(Point2, randomBytes7) {
    validatePointCons(Point2);
    this.randomBytes = probeRandomBytes(randomBytes7, BLIND_BYTES);
    this.Point = Point2;
    this.BASE = Point2.BASE;
    this.ZERO = Point2.ZERO;
    this.bits = Point2.Fn.BITS;
  }
  /**
   * Creates a signed fixed-window wNAF precomputation table: for every window w, the
   * multiples `[1..2^(W−1)]⋅2^(w⋅W)⋅P`, flattened. All doublings are baked into the table,
   * so cached multiplication is additions-only. `windows = ceil(bits/W) + 1`: the extra
   * window absorbs the final carry of signed-digit recoding.
   * For a 256-bit curve and W=6, the table is 44⋅32 = 1408 points.
   * @param point - Point instance
   * @param W - window size
   * @param bits - scalar bitlength the table must cover
   */
  buildWnafTable(point, W2, bits) {
    const windows = Math.ceil(bits / W2) + 1;
    const half = 2 ** (W2 - 1);
    const comp = [];
    let base = point;
    for (let w = 0; w < windows; w++) {
      let acc = base;
      for (let i = 0; i < half; i++) {
        comp.push(acc);
        acc = acc.add(base);
      }
      base = comp[comp.length - 1].double();
    }
    return { W: W2, bits, windows, comp };
  }
  /**
   * Implements ec multiplication using precomputed signed fixed-window wNAF tables.
   * Constant-time: fixed window count with one table addition per window — zero digits feed
   * the fake accumulator — and no doublings; the lookup scans the whole window slice.
   * Scalar bounds are validated by the public entry points ({@link ScalarMultiplier.mulCT},
   * {@link ScalarMultiplier.mulCTBlinded}, {@link ScalarMultiplier.mulUnsafe});
   * signedWindowDigits throws if `n` exceeds the table.
   * @returns real and fake (for const-time) points
   */
  wnafCachedCT(precomputes, n) {
    const { W: W2, windows, comp } = precomputes;
    const half = 2 ** (W2 - 1);
    const digits = signedWindowDigits(n, W2, windows);
    let p = this.ZERO;
    let f = this.BASE;
    for (let w = 0; w < windows; w++) {
      const digit = digits[w];
      const start = w * half;
      const idx = Math.abs(digit) - 1;
      let sel = comp[start];
      for (let i = 1; i < half; i++)
        sel = i === idx ? comp[start + i] : sel;
      const neg = sel.negate();
      if (digit === 0)
        f = f.add(comp[start]);
      else
        p = p.add(digit < 0 ? neg : sel);
    }
    return { p, f };
  }
  // Cache key is point identity plus (W, bits); at most two entries exist per point (public-width
  // `Fn.BITS` and blinded `Fn.BITS + BLIND_BITS`). Callers must not reuse the same point with
  // incompatible `transform(...)` layouts and expect a separate cache entry.
  getWnafPrecomputes(W2, point, bits, transform) {
    let entries = this.wnafPrecomputes.get(point);
    let comp = entries?.find((entry) => entry.W === W2 && entry.bits === bits);
    if (!comp) {
      comp = this.buildWnafTable(point, W2, bits);
      if (typeof transform === "function")
        comp = { ...comp, comp: transform(comp.comp) };
      if (!entries) {
        entries = [];
        this.wnafPrecomputes.set(point, entries);
      }
      entries.push(comp);
    }
    return comp;
  }
  assertPoint(point) {
    if (!(point instanceof this.Point))
      throw new TypeError('"point" expected Point instance, got type=' + typeof point);
  }
  // Shared prologue of the constant-time entry points. Rejects scalar 0: in key/signature-style
  // callers a zero scalar means broken upstream plumbing, and concrete Points already reject it.
  // Uses inRange instead of Fn.isValidNot0: validateField() only certifies the arithmetic subset.
  validateMulInput(point, scalar) {
    this.assertPoint(point);
    if (!inRange(scalar, _1n3, this.Point.Fn.ORDER))
      throw new Error("invalid scalar");
  }
  // Constant-time dispatch shared by mulCT / mulCTBlinded. Un-precomputed points (W===1, e.g.
  // ECDH peer keys) skip building a throwaway cached table in favor of a small fixed-window
  // multiply. `n` must be < 2^bits.
  runCT(point, n, bits, transform) {
    const W2 = getWindowSize(point);
    if (W2 === 1)
      return this.fixedWindowCT(point, n, bits);
    return this.wnafCachedCT(this.getWnafPrecomputes(W2, point, bits, transform), n);
  }
  mulCT(point, scalar, transform) {
    this.validateMulInput(point, scalar);
    return this.runCT(point, scalar, this.bits, transform);
  }
  mulCTBlinded(point, scalar, transform) {
    this.validateMulInput(point, scalar);
    if (this.randomBytes === void 0)
      throw new Error("randomBytes is required for scalar blinding");
    const bits = this.Point.Fn.BITS + BLIND_BITS;
    const blind = this.randomBytes(BLIND_BYTES);
    if (!isBytes3(blind) || blind.length !== BLIND_BYTES)
      throw new Error("randomBytes returned invalid byte array");
    blind[0] = blind[0] & 63 | 128;
    const n = scalar + bytesToNumberBE(blind) * this.Point.Fn.ORDER;
    return this.runCT(point, n, bits, transform);
  }
  /**
   * Constant-time multiplication `n*point` for an un-precomputed point, via a small fixed window.
   * A cached wNAF table only pays off when reused; a flat 2^FW_WINDOW table (`size-1` adds) is
   * far cheaper to build for a single use. The point-operation sequence is independent of `n`:
   * build the table, then per window exactly FW_WINDOW doublings, a data-oblivious scan over
   * every table entry, and one addition (adds the identity when the window digit is 0 — never
   * skipped).
   *
   * `n` must be `< 2^bits`. Assumes complete addition (adding the identity costs the same as any
   * add), which holds for the Weierstrass/Edwards point types used here. The table is left in
   * projective form (no normalizeZ): normalizing this small a table costs more than the
   * mixed-add savings it would buy for a single multiply.
   * @returns real point `p`; `f` duplicates it only to match {@link wnafCachedCT}'s return shape
   * (this path needs no fake accumulator — its op-count is already scalar-independent).
   */
  fixedWindowCT(point, n, bits) {
    const W2 = FW_WINDOW;
    const size = 1 << W2;
    const mask = bitMask(W2);
    const table = new Array(size);
    table[0] = this.ZERO;
    for (let i = 1; i < size; i++)
      table[i] = table[i - 1].add(point);
    const windows = Math.ceil(bits / W2);
    let acc = this.ZERO;
    for (let window = windows - 1; window >= 0; window--) {
      if (window !== windows - 1)
        for (let d = 0; d < W2; d++)
          acc = acc.double();
      const digit = Number(n >> BigInt(window * W2) & mask);
      let sel = table[0];
      for (let i = 1; i < size; i++)
        sel = i === digit ? table[i] : sel;
      acc = acc.add(sel);
    }
    return { p: acc, f: acc };
  }
  shouldBlind(point, cofactor) {
    if (this.randomBytes === void 0)
      return false;
    if (cofactor === _1n3)
      return true;
    if (point !== this.BASE)
      return false;
    if (this.baseCanBeBlinded === void 0)
      this.baseCanBeBlinded = this.mulUnsafe(this.BASE, this.Point.Fn.ORDER).is0();
    return this.baseCanBeBlinded;
  }
  mulSecret(point, scalar, cofactor, transform) {
    return this.shouldBlind(point, cofactor) ? this.mulCTBlinded(point, scalar, transform) : this.mulCT(point, scalar, transform);
  }
  mulUnsafe(point, scalar, transform) {
    this.assertPoint(point);
    if (!isPosBig(scalar))
      throw new Error("invalid scalar");
    const W2 = getWindowSize(point);
    if (W2 === 1 || scalar >= this.Point.Fn.ORDER)
      return mulAddUnsafe(this.Point, [point], [scalar], true);
    const precomputes = this.getWnafPrecomputes(W2, point, this.bits, transform);
    return this.wnafCachedCT(precomputes, scalar).p;
  }
  // Remembers the window size used for precomputed wNAF multiplication of the given point
  // and drops any previously built tables. Usually only the base point is precomputed.
  // W=1 resets the point to the un-precomputed (table-less) paths.
  // W is additionally capped so tables stay under ~2 GiB ({@link TABLE_BYTES_MAX}).
  setWindowSize(point, W2) {
    this.assertPoint(point);
    validateW(W2, this.bits);
    const windows = Math.ceil((this.bits + BLIND_BITS) / W2) + 1;
    validateTableBytes(windows * 2 ** (W2 - 1), this.Point.Fp.BYTES);
    pointWindowSizes.set(point, W2);
    this.wnafPrecomputes.delete(point);
  }
  // True when a window size is set: tables themselves are built lazily on first multiply.
  hasWindowSize(point) {
    return getWindowSize(point) !== 1;
  }
};
function mulAddUnsafe(c, points, scalars, allowOversized = false) {
  validatePointCons(c);
  validateMSMPoints(points, c);
  abool(allowOversized, "allowOversized");
  validateMSMScalars(scalars, c.Fn, allowOversized ? c.Fn.ORDER ** _4n2 : void 0);
  if (points.length !== scalars.length)
    throw new Error("arrays of points and scalars must have equal length");
  const tables = points.map((p) => oddMultiples(p, 4));
  const digits = scalars.map((n) => wnafDigits(n, 4));
  return wnafWalk(c.ZERO, tables, digits);
}
function createField(order, field, isLE) {
  if (field) {
    if (field.ORDER !== order)
      throw new Error("Field.ORDER must match order: Fp == p, Fn == n");
    validateField(field);
    return field;
  } else {
    return Field(order, { isLE });
  }
}
function createCurveFields(type, CURVE, curveOpts = {}, FpFnLE) {
  if (type !== "weierstrass" && type !== "edwards")
    throw new Error('expected curve type "weierstrass" or "edwards"');
  if (FpFnLE === void 0)
    FpFnLE = type === "edwards";
  if (!CURVE || typeof CURVE !== "object")
    throw new Error(`expected valid ${type} CURVE object`);
  validateObject(curveOpts);
  for (const p of ["p", "n", "h"]) {
    const val = CURVE[p];
    if (!(isPosBig(val) && val !== _0n3))
      throw new Error(`CURVE.${p} must be positive bigint`);
  }
  const Fp2 = createField(CURVE.p, curveOpts.Fp, FpFnLE);
  const Fn = createField(CURVE.n, curveOpts.Fn, FpFnLE);
  const _b = type === "weierstrass" ? "b" : "d";
  const params = ["Gx", "Gy", "a", _b];
  for (const p of params) {
    if (!Fp2.isValid(CURVE[p]))
      throw new Error(`CURVE.${p} must be valid field element of CURVE.Fp`);
  }
  CURVE = Object.freeze(Object.assign({}, CURVE));
  return { CURVE, Fp: Fp2, Fn };
}
function createKeygen(randomSecretKey, getPublicKey2) {
  return function keygen(seed) {
    const secretKey = randomSecretKey(seed);
    return { secretKey, publicKey: getPublicKey2(secretKey) };
  };
}

// node_modules/@noble/curves/abstract/edwards.js
var _0n4 = /* @__PURE__ */ BigInt(0);
var _1n4 = /* @__PURE__ */ BigInt(1);
var _2n2 = /* @__PURE__ */ BigInt(2);
var _4n3 = /* @__PURE__ */ BigInt(4);
var _8n2 = /* @__PURE__ */ BigInt(8);
function isEdValidXY(Fp2, CURVE, x, y) {
  const x2 = Fp2.sqr(x);
  const y2 = Fp2.sqr(y);
  const left = Fp2.add(Fp2.mul(CURVE.a, x2), y2);
  const right = Fp2.add(Fp2.ONE, Fp2.mul(CURVE.d, Fp2.mul(x2, y2)));
  return Fp2.eql(left, right);
}
function edwards(params, extraOpts = {}) {
  validateObject(extraOpts, {}, {}, "extraOpts");
  const opts = extraOpts;
  const validated = createCurveFields("edwards", params, opts, opts.FpFnLE);
  const { Fp: Fp2, Fn } = validated;
  let CURVE = validated.CURVE;
  const { h: cofactor } = CURVE;
  if (FpLegendre(Fp2, CURVE.a) !== 1)
    throw new Error("edwards: CURVE.a must be a square in Fp for complete addition formulas");
  if (FpLegendre(Fp2, CURVE.d) !== -1)
    throw new Error("edwards: CURVE.d must be a non-square in Fp for complete addition formulas");
  validateObject(opts, {}, { uvRatio: "function", randomBytes: "function" });
  const randomBytes7 = opts.randomBytes === void 0 ? randomBytes3 : opts.randomBytes;
  const MASK = _2n2 << BigInt(Fp2.BYTES * 8) - _1n4;
  function isOdd(n) {
    if (!Fp2.isOdd)
      throw new Error("Field does not have .isOdd()");
    return Fp2.isOdd(n);
  }
  const uvRatio3 = opts.uvRatio === void 0 ? (u, v) => {
    try {
      return { isValid: true, value: Fp2.sqrt(Fp2.div(u, v)) };
    } catch (e) {
      return { isValid: false, value: _0n4 };
    }
  } : opts.uvRatio;
  if (!isEdValidXY(Fp2, CURVE, CURVE.Gx, CURVE.Gy))
    throw new Error("bad curve params: generator point");
  const mulA = Fp2.eql(CURVE.a, Fp2.neg(Fp2.ONE)) ? (x) => Fp2.neg(x) : Fp2.eql(CURVE.a, Fp2.ONE) ? (x) => x : (x) => Fp2.mul(CURVE.a, x);
  function acoord(title, n, banZero = false) {
    const min = banZero ? _1n4 : _0n4;
    aInRange("coordinate " + title, n, min, MASK);
    return n;
  }
  function aedpoint(other) {
    if (!(other instanceof Point2))
      throw new Error("EdwardsPoint expected");
  }
  class Point2 {
    static BASE = new Point2(CURVE.Gx, CURVE.Gy, Fp2.ONE, Fp2.mul(CURVE.Gx, CURVE.Gy));
    static ZERO = new Point2(Fp2.ZERO, Fp2.ONE, Fp2.ONE, Fp2.ZERO);
    static Fp = Fp2;
    static Fn = Fn;
    X;
    Y;
    Z;
    T;
    constructor(X, Y, Z, T) {
      this.X = acoord("x", X);
      this.Y = acoord("y", Y);
      this.Z = acoord("z", Z, true);
      this.T = acoord("t", T);
      Object.freeze(this);
    }
    static CURVE() {
      return CURVE;
    }
    /**
     * Create one extended Edwards point from affine coordinates.
     * Does NOT validate that the point is on-curve or torsion-free.
     * Use `.assertValidity()` on adversarial inputs.
     */
    static fromAffine(p) {
      if (p instanceof Point2)
        throw new Error("extended point not allowed");
      const { x, y } = p || {};
      acoord("x", x);
      acoord("y", y);
      return new Point2(x, y, Fp2.ONE, Fp2.mul(x, y));
    }
    // Uses algo from RFC8032 5.1.3.
    static fromBytes(bytes, zip215 = false) {
      const len = Fp2.BYTES;
      const { a, d } = CURVE;
      bytes = copyBytes(abytes3(bytes, len, "point"));
      abool(zip215, "zip215");
      const normed = copyBytes(bytes);
      const lastByte = bytes[len - 1];
      normed[len - 1] = lastByte & ~128;
      const y = bytesToNumberLE2(normed);
      const max = zip215 ? MASK : Fp2.ORDER;
      aInRange("point.y", y, _0n4, max);
      const y2 = Fp2.sqr(y);
      const u = Fp2.sub(y2, Fp2.ONE);
      const v = Fp2.sub(Fp2.mulN(d, y2), a);
      let { isValid, value: x } = uvRatio3(u, v);
      if (!isValid)
        throw new Error("bad point: invalid y coordinate");
      const isXOdd = isOdd(x);
      const isLastByteOdd = (lastByte & 128) !== 0;
      if (!zip215 && Fp2.is0(x) && isLastByteOdd)
        throw new Error("bad point: x=0 and x_0=1");
      if (isLastByteOdd !== isXOdd)
        x = Fp2.neg(x);
      return Point2.fromAffine({ x, y });
    }
    static fromHex(hex, zip215 = false) {
      return Point2.fromBytes(hexToBytes3(hex), zip215);
    }
    get x() {
      return this.toAffine().x;
    }
    get y() {
      return this.toAffine().y;
    }
    precompute(windowSize = 6, isLazy = true) {
      wnaf.setWindowSize(this, windowSize);
      if (!isLazy)
        this.multiply(_2n2);
      return this;
    }
    // Useful in fromAffine() - not for fromBytes(), which always created valid points.
    assertValidity() {
      const p = this;
      const { a, d } = CURVE;
      if (p.is0())
        throw new Error("bad point: ZERO");
      const { X, Y, Z, T } = p;
      const X2 = Fp2.sqr(X);
      const Y2 = Fp2.sqr(Y);
      const Z2 = Fp2.sqr(Z);
      const Z4 = Fp2.sqr(Z2);
      const aX2 = Fp2.mul(X2, a);
      const left = Fp2.mul(Fp2.add(aX2, Y2), Z2);
      const right = Fp2.add(Z4, Fp2.mul(d, Fp2.mul(X2, Y2)));
      if (!Fp2.eql(left, right))
        throw new Error("bad point: equation left != right (1)");
      const XY = Fp2.mul(X, Y);
      const ZT = Fp2.mul(Z, T);
      if (!Fp2.eql(XY, ZT))
        throw new Error("bad point: equation left != right (2)");
    }
    // Compare one point to another.
    equals(other) {
      aedpoint(other);
      const { X: X1, Y: Y1, Z: Z1 } = this;
      const { X: X2, Y: Y2, Z: Z2 } = other;
      const X1Z2 = Fp2.mul(X1, Z2);
      const X2Z1 = Fp2.mul(X2, Z1);
      const Y1Z2 = Fp2.mul(Y1, Z2);
      const Y2Z1 = Fp2.mul(Y2, Z1);
      return Fp2.eql(X1Z2, X2Z1) && Fp2.eql(Y1Z2, Y2Z1);
    }
    is0() {
      return this.equals(Point2.ZERO);
    }
    negate() {
      return new Point2(Fp2.neg(this.X), this.Y, this.Z, Fp2.neg(this.T));
    }
    // Fast algo for doubling Extended Point.
    // https://hyperelliptic.org/EFD/g1p/auto-twisted-extended.html#doubling-dbl-2008-hwcd
    // Cost: 4M + 4S + 1*a + 6add + 1*2.
    double() {
      const { X: X1, Y: Y1, Z: Z1 } = this;
      const A = Fp2.sqr(X1);
      const B = Fp2.sqr(Y1);
      const C2 = Fp2.mul(Fp2.sqr(Z1), _2n2);
      const D = mulA(A);
      const x1y1 = Fp2.addN(X1, Y1);
      const E = Fp2.sub(Fp2.subN(Fp2.sqr(x1y1), A), B);
      const G2 = Fp2.addN(D, B);
      const F = Fp2.subN(G2, C2);
      const H = Fp2.subN(D, B);
      const X3 = Fp2.mul(E, F);
      const Y3 = Fp2.mul(G2, H);
      const T3 = Fp2.mul(E, H);
      const Z3 = Fp2.mul(F, G2);
      return new Point2(X3, Y3, Z3, T3);
    }
    // Fast algo for adding 2 Extended Points.
    // https://hyperelliptic.org/EFD/g1p/auto-twisted-extended.html#addition-add-2008-hwcd
    // Cost: 9M + 1*a + 1*d + 7add.
    add(other) {
      aedpoint(other);
      const { d } = CURVE;
      const { X: X1, Y: Y1, Z: Z1, T: T1 } = this;
      const { X: X2, Y: Y2, Z: Z2, T: T2 } = other;
      const A = Fp2.mul(X1, X2);
      const B = Fp2.mul(Y1, Y2);
      const C2 = Fp2.mul(Fp2.mulN(T1, d), T2);
      const D = Fp2.mul(Z1, Z2);
      const E = Fp2.sub(Fp2.subN(Fp2.mulN(Fp2.addN(X1, Y1), Fp2.addN(X2, Y2)), A), B);
      const F = Fp2.subN(D, C2);
      const G2 = Fp2.addN(D, C2);
      const H = Fp2.sub(B, mulA(A));
      const X3 = Fp2.mul(E, F);
      const Y3 = Fp2.mul(G2, H);
      const T3 = Fp2.mul(E, H);
      const Z3 = Fp2.mul(F, G2);
      return new Point2(X3, Y3, Z3, T3);
    }
    subtract(other) {
      aedpoint(other);
      return this.add(other.negate());
    }
    // Constant-time multiplication.
    multiply(scalar) {
      if (!Fn.isValidNot0(scalar))
        throw new RangeError("invalid scalar: expected 1 <= sc < curve.n");
      const { p, f } = wnaf.mulSecret(this, scalar, cofactor, normalize);
      return normalize([p, f])[0];
    }
    // Non-constant-time multiplication. Uses double-and-add algorithm.
    // It's faster, but should only be used when you don't care about
    // an exposed private key e.g. sig verification.
    // Keeps the same subgroup-scalar contract: 0 is allowed for public-scalar callers, but
    // n and larger values are rejected instead of being reduced mod n to the identity point.
    multiplyUnsafe(scalar) {
      if (!Fn.isValid(scalar))
        throw new RangeError("invalid scalar: expected 0 <= sc < curve.n");
      if (scalar === _0n4)
        return Point2.ZERO;
      if (this.is0() || scalar === _1n4)
        return this;
      return wnaf.mulUnsafe(this, scalar, normalize);
    }
    // Checks if point is of small order.
    // If you add something to small order point, you will have "dirty"
    // point with torsion component.
    // Clears cofactor and checks if the result is 0.
    isSmallOrder() {
      return this.clearCofactor().is0();
    }
    // Multiplies point by curve order and checks if the result is 0.
    // Returns `false` is the point is dirty.
    isTorsionFree() {
      return wnaf.mulUnsafe(this, CURVE.n).is0();
    }
    // Converts Extended point to default (x, y) coordinates.
    // Can accept precomputed Z^-1 - for example, from invertBatch.
    toAffine(invertedZ) {
      const p = this;
      let iz = invertedZ;
      if (iz != null && typeof iz !== "bigint")
        throw new TypeError('"invertedZ" expected bigint, got type=' + typeof iz);
      const { X, Y, Z } = p;
      const is0 = p.is0();
      if (iz == null)
        iz = is0 ? Fp2.create(_8n2) : Fp2.inv(Z);
      const x = Fp2.mul(X, iz);
      const y = Fp2.mul(Y, iz);
      const zz = Fp2.mul(Z, iz);
      if (is0)
        return { x: Fp2.ZERO, y: Fp2.ONE };
      if (!Fp2.eql(zz, Fp2.ONE))
        throw new Error("invZ was invalid");
      return { x, y };
    }
    clearCofactor() {
      if (cofactor === _1n4)
        return this;
      if (cofactor === _2n2)
        return this.double();
      if (cofactor === _4n3)
        return this.double().double();
      if (cofactor === _8n2)
        return this.double().double().double();
      return this.multiplyUnsafe(cofactor);
    }
    toBytes() {
      const { x, y } = this.toAffine();
      const bytes = Fp2.toBytes(y);
      bytes[bytes.length - 1] |= isOdd(x) ? 128 : 0;
      return bytes;
    }
    toHex() {
      return bytesToHex3(this.toBytes());
    }
    toString() {
      return `<Point ${this.is0() ? "ZERO" : this.toHex()}>`;
    }
  }
  const normalize = (points) => normalizeZ(Point2, points);
  const wnaf = new ScalarMultiplier(Point2, randomBytes7);
  if (wnaf.bits >= 6)
    Point2.BASE.precompute(6);
  Object.freeze(Point2.prototype);
  Object.freeze(Point2);
  return Point2;
}
function eddsa(Point2, cHash, eddsaOpts = {}) {
  validatePointCons(Point2);
  if (typeof cHash !== "function")
    throw new Error('"hash" function param is required');
  const hash = cHash;
  const opts = eddsaOpts;
  validateObject(opts, {}, {
    adjustScalarBytes: "function",
    randomBytes: "function",
    domain: "function",
    prehash: "function",
    zip215: "boolean",
    mapToCurve: "function",
    toMontgomery: "function",
    toMontgomerySecret: "function"
  });
  const { prehash } = opts;
  const { BASE, Fp: Fp2, Fn } = Point2;
  const outputLen = hash.outputLen;
  const expectedLen = 2 * Fp2.BYTES;
  if (outputLen !== void 0) {
    asafenumber(outputLen, "hash.outputLen");
    if (outputLen !== expectedLen)
      throw new Error(`hash.outputLen must be ${expectedLen}, got ${outputLen}`);
  }
  const randomBytes7 = opts.randomBytes === void 0 ? randomBytes3 : opts.randomBytes;
  const toMontgomery2 = opts.toMontgomery;
  const toMontgomerySecret2 = opts.toMontgomerySecret;
  const adjustScalarBytes2 = opts.adjustScalarBytes === void 0 ? (bytes) => bytes : opts.adjustScalarBytes;
  const domain = opts.domain === void 0 ? (data, ctx, phflag) => {
    abool(phflag, "phflag");
    if (ctx.length || phflag)
      throw new Error("Contexts/pre-hash are not supported");
    return data;
  } : opts.domain;
  function modN_LE(hash2) {
    return Fn.create(bytesToNumberLE2(hash2));
  }
  function getPrivateScalar(key) {
    const len = lengths.secretKey;
    abytes3(key, lengths.secretKey, "secretKey");
    const hashed = abytes3(hash(key), 2 * len, "hashedSecretKey");
    const head = adjustScalarBytes2(hashed.slice(0, len));
    const prefix = hashed.slice(len, 2 * len);
    const scalar = modN_LE(head);
    return { head, prefix, scalar };
  }
  function getExtendedPublicKey2(secretKey) {
    const { head, prefix, scalar } = getPrivateScalar(secretKey);
    const point = BASE.multiply(scalar);
    const pointBytes = point.toBytes();
    return { head, prefix, scalar, point, pointBytes };
  }
  function getPublicKey2(secretKey) {
    return getExtendedPublicKey2(secretKey).pointBytes;
  }
  function hashDomainToScalar(context = Uint8Array.of(), ...msgs) {
    const msg = concatBytes3(...msgs);
    return modN_LE(hash(domain(msg, abytes3(context, void 0, "context"), !!prehash)));
  }
  function sign(msg, secretKey, options = {}) {
    validateObject(options, {}, {}, "options");
    msg = abytes3(msg, void 0, "message");
    if (prehash)
      msg = prehash(msg);
    const { prefix, scalar, pointBytes } = getExtendedPublicKey2(secretKey);
    const r = hashDomainToScalar(options.context, prefix, msg);
    const R = BASE.multiply(r).toBytes();
    const k = hashDomainToScalar(options.context, R, pointBytes, msg);
    const s = Fn.create(r + k * scalar);
    if (!Fn.isValid(s))
      throw new Error("sign failed: invalid s");
    const rs = concatBytes3(R, Fn.toBytes(s));
    return abytes3(rs, lengths.signature, "result");
  }
  const verifyOpts = {
    zip215: opts.zip215
  };
  function verify(sig, msg, publicKey, options = verifyOpts) {
    validateObject(options);
    const { context } = options;
    const zip215 = options.zip215 === void 0 ? !!verifyOpts.zip215 : options.zip215;
    const len = lengths.signature;
    sig = abytes3(sig, len, "signature");
    msg = abytes3(msg, void 0, "message");
    publicKey = abytes3(publicKey, lengths.publicKey, "publicKey");
    if (zip215 !== void 0)
      abool(zip215, "zip215");
    if (prehash)
      msg = prehash(msg);
    const mid = len / 2;
    const r = sig.subarray(0, mid);
    const s = bytesToNumberLE2(sig.subarray(mid, len));
    let A, R, SB;
    try {
      A = Point2.fromBytes(publicKey, zip215);
      R = Point2.fromBytes(r, zip215);
      SB = BASE.multiplyUnsafe(s);
    } catch (error) {
      return false;
    }
    if (!zip215 && A.isSmallOrder())
      return false;
    const k = hashDomainToScalar(context, r, publicKey, msg);
    const RkA = R.add(A.multiplyUnsafe(k));
    return RkA.subtract(SB).clearCofactor().is0();
  }
  const _size = Fp2.BYTES;
  const lengths = {
    secretKey: _size,
    publicKey: _size,
    signature: 2 * _size,
    seed: _size
  };
  function randomSecretKey(seed) {
    seed = seed === void 0 ? randomBytes7(lengths.seed) : seed;
    return abytes3(seed, lengths.seed, "seed");
  }
  function isValidSecretKey(key) {
    return isBytes3(key) && key.length === lengths.secretKey;
  }
  function isValidPublicKey(key, zip215) {
    try {
      return !!Point2.fromBytes(key, zip215 === void 0 ? verifyOpts.zip215 : zip215);
    } catch (error) {
      return false;
    }
  }
  const utils = {
    getExtendedPublicKey: getExtendedPublicKey2,
    randomSecretKey,
    isValidSecretKey,
    isValidPublicKey,
    /** Converts an Edwards public key to a companion Montgomery public key. */
    toMontgomery(publicKey) {
      if (toMontgomery2 === void 0)
        throw new Error("Montgomery conversion is not supported for this curve");
      return toMontgomery2(Point2.fromBytes(publicKey));
    },
    toMontgomerySecret(secretKey) {
      if (toMontgomerySecret2 === void 0)
        throw new Error("Montgomery conversion is not supported for this curve");
      return toMontgomerySecret2(secretKey);
    }
  };
  Object.freeze(lengths);
  Object.freeze(utils);
  return Object.freeze({
    keygen: createKeygen(randomSecretKey, getPublicKey2),
    getPublicKey: getPublicKey2,
    sign,
    verify,
    utils,
    Point: Point2,
    lengths
  });
}

// node_modules/@noble/curves/abstract/montgomery.js
var _0n5 = /* @__PURE__ */ BigInt(0);
var _1n5 = /* @__PURE__ */ BigInt(1);
var _2n3 = /* @__PURE__ */ BigInt(2);
function cmask(P2, swap) {
  return P2 + swap - (swap >> _1n5 << _1n5);
}
function cswap(P2) {
  const offset = BigInt(6) * P2;
  return (mask, x_2, x_3) => {
    const sum = x_2 + x_3;
    const d = offset + x_3 - x_2;
    const a = (d * mask + x_2) % P2;
    return { x_2: a, x_3: sum - a };
  };
}
function validateOpts(curve) {
  validateObject(curve, {
    P: "bigint",
    type: "string",
    adjustScalarBytes: "function",
    powPminus2: "function"
  }, {
    randomBytes: "function",
    scalarMultBase: "function"
  });
  return Object.freeze({ ...curve });
}
function montgomery(curveDef) {
  const CURVE = validateOpts(curveDef);
  const { P: P2, type, adjustScalarBytes: adjustScalarBytes2, powPminus2, randomBytes: rand } = CURVE;
  const mulBaseHook = CURVE.scalarMultBase;
  const is25519 = type === "x25519";
  if (!is25519 && type !== "x448")
    throw new Error("invalid type");
  const randomBytes_ = rand === void 0 ? randomBytes3 : rand;
  const montgomeryBits = is25519 ? 255 : 448;
  const swap = cswap(P2);
  const fieldLen = is25519 ? 32 : 56;
  const Gu = is25519 ? BigInt(9) : BigInt(5);
  const a24 = is25519 ? BigInt(121665) : BigInt(39081);
  const minScalar = is25519 ? _2n3 ** BigInt(254) : _2n3 ** BigInt(447);
  const maxAdded = is25519 ? BigInt(8) * (_2n3 ** BigInt(251) - _1n5) : BigInt(4) * (_2n3 ** BigInt(445) - _1n5);
  const maxScalar = minScalar + maxAdded + _1n5;
  const modP2 = (n) => mod(n, P2);
  const GuBytes = encodeU(Gu);
  function encodeU(u) {
    return numberToBytesLE(modP2(u), fieldLen);
  }
  function decodeU(u) {
    const _u = copyBytes(abytes3(u, fieldLen, "uCoordinate"));
    if (is25519)
      _u[31] &= 127;
    return modP2(bytesToNumberLE2(_u));
  }
  function decodeScalar(scalar) {
    return bytesToNumberLE2(adjustScalarBytes2(copyBytes(abytes3(scalar, fieldLen, "scalar"))));
  }
  const lowOrderU = new Set(is25519 ? [
    _0n5,
    _1n5,
    P2 - _1n5,
    BigInt("325606250916557431795983626356110631294008115727848805560023387167927233504"),
    BigInt("39382357235489614581723060781553021112529911719440698176882885853963445705823")
  ] : [_0n5, _1n5, P2 - _1n5]);
  function scalarMult(scalar, u) {
    const pointU = decodeU(u);
    if (lowOrderU.has(pointU))
      throw new Error("invalid private or public key received");
    const pu = montgomeryLadder(pointU, decodeScalar(scalar));
    if (pu === _0n5)
      throw new Error("invalid private or public key received");
    return encodeU(pu);
  }
  function scalarMultBase(scalar) {
    if (mulBaseHook === void 0)
      return scalarMult(scalar, GuBytes);
    const k = decodeScalar(scalar);
    aInRange("scalar", k, minScalar, maxScalar);
    const pu = modP2(mulBaseHook(k));
    if (pu === _0n5)
      throw new Error("invalid private or public key received");
    return encodeU(pu);
  }
  const getPublicKey2 = scalarMultBase;
  const getSharedSecret = scalarMult;
  function montgomeryLadder(u, scalar) {
    aInRange("u", u, _0n5, P2);
    aInRange("scalar", scalar, minScalar, maxScalar);
    const k = scalar;
    const x_1 = u;
    let x_2 = _1n5;
    let z_2 = _0n5;
    let x_3 = u;
    let z_3 = _1n5;
    const kx = k ^ k >> _1n5;
    for (let t = BigInt(montgomeryBits - 1); t >= _0n5; t--) {
      const mask2 = cmask(P2, kx >> t);
      ({ x_2, x_3 } = swap(mask2, x_2, x_3));
      ({ x_2: z_2, x_3: z_3 } = swap(mask2, z_2, z_3));
      const A = x_2 + z_2;
      const AA = modP2(A * A);
      const B = x_2 - z_2;
      const BB = modP2(B * B);
      const E = AA - BB;
      const C2 = x_3 + z_3;
      const D = x_3 - z_3;
      const DA = modP2(D * A);
      const CB = modP2(C2 * B);
      const dacb = DA + CB;
      const da_cb = DA - CB;
      x_3 = modP2(dacb * dacb);
      z_3 = modP2(x_1 * modP2(da_cb * da_cb));
      x_2 = modP2(AA * BB);
      z_2 = modP2(E * (AA + modP2(a24 * E)));
    }
    const mask = cmask(P2, k);
    ({ x_2, x_3 } = swap(mask, x_2, x_3));
    ({ x_2: z_2, x_3: z_3 } = swap(mask, z_2, z_3));
    const z2 = powPminus2(z_2);
    return modP2(x_2 * z2);
  }
  const lengths = {
    secretKey: fieldLen,
    publicKey: fieldLen,
    seed: fieldLen
  };
  const randomSecretKey = (seed) => {
    seed = seed === void 0 ? randomBytes_(fieldLen) : seed;
    abytes3(seed, lengths.seed, "seed");
    return seed;
  };
  const utils = { randomSecretKey };
  Object.freeze(lengths);
  Object.freeze(utils);
  return Object.freeze({
    keygen: createKeygen(randomSecretKey, getPublicKey2),
    getSharedSecret,
    getPublicKey: getPublicKey2,
    scalarMult,
    scalarMultBase,
    utils,
    GuBytes: GuBytes.slice(),
    lengths
  });
}

// node_modules/@noble/curves/ed25519.js
var _0n6 = /* @__PURE__ */ BigInt(0);
var _1n6 = /* @__PURE__ */ BigInt(1);
var _2n4 = /* @__PURE__ */ BigInt(2);
var _3n2 = /* @__PURE__ */ BigInt(3);
var _5n2 = /* @__PURE__ */ BigInt(5);
var _8n3 = /* @__PURE__ */ BigInt(8);
var ed25519_CURVE_p = /* @__PURE__ */ BigInt("0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffed");
var ed25519_CURVE2 = /* @__PURE__ */ (() => ({
  p: ed25519_CURVE_p,
  n: BigInt("0x1000000000000000000000000000000014def9dea2f79cd65812631a5cf5d3ed"),
  h: _8n3,
  a: BigInt("0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffec"),
  d: BigInt("0x52036cee2b6ffe738cc740797779e89800700a4d4141d8ab75eb4dca135978a3"),
  Gx: BigInt("0x216936d3cd6e53fec0a4e231fdd6dc5c692cc7609525a7b2c9562d608f25d51a"),
  Gy: BigInt("0x6666666666666666666666666666666666666666666666666666666666666658")
}))();
function ed25519_pow_2_252_3(x) {
  const _10n = BigInt(10), _20n = BigInt(20), _40n = BigInt(40), _80n = BigInt(80);
  const P2 = ed25519_CURVE_p;
  const x2 = x * x % P2;
  const b2 = x2 * x % P2;
  const b4 = pow22(b2, _2n4, P2) * b2 % P2;
  const b5 = pow22(b4, _1n6, P2) * x % P2;
  const b10 = pow22(b5, _5n2, P2) * b5 % P2;
  const b20 = pow22(b10, _10n, P2) * b10 % P2;
  const b40 = pow22(b20, _20n, P2) * b20 % P2;
  const b80 = pow22(b40, _40n, P2) * b40 % P2;
  const b160 = pow22(b80, _80n, P2) * b80 % P2;
  const b240 = pow22(b160, _80n, P2) * b80 % P2;
  const b250 = pow22(b240, _10n, P2) * b10 % P2;
  const pow_p_5_8 = pow22(b250, _2n4, P2) * x % P2;
  return { pow_p_5_8, b2 };
}
function adjustScalarBytes(bytes) {
  bytes[0] &= 248;
  bytes[31] &= 127;
  bytes[31] |= 64;
  return bytes;
}
var ED25519_SQRT_M1 = /* @__PURE__ */ BigInt("19681161376707505956807079304988542015446066515923890162744021073123829784752");
function uvRatio2(u, v) {
  const P2 = ed25519_CURVE_p;
  const v3 = mod(v * v * v, P2);
  const v7 = mod(v3 * v3 * v, P2);
  const pow3 = ed25519_pow_2_252_3(u * v7).pow_p_5_8;
  let x = mod(u * v3 * pow3, P2);
  const vx2 = mod(v * x * x, P2);
  const root1 = x;
  const root2 = mod(x * ED25519_SQRT_M1, P2);
  const useRoot1 = vx2 === u;
  const useRoot2 = vx2 === mod(-u, P2);
  const noRoot = vx2 === mod(-u * ED25519_SQRT_M1, P2);
  if (useRoot1)
    x = root1;
  if (useRoot2 || noRoot)
    x = root2;
  if (isNegativeLE(x, P2))
    x = mod(-x, P2);
  return { isValid: useRoot1 || useRoot2, value: x };
}
var ed25519_Point = /* @__PURE__ */ edwards(ed25519_CURVE2, { uvRatio: uvRatio2 });
var Fp = /* @__PURE__ */ (() => ed25519_Point.Fp)();
function toMontgomery(point) {
  const { y } = point;
  return Fp.toBytes(Fp.div(_1n6 + y, _1n6 - y));
}
function toMontgomerySecret(secretKey) {
  const size = ed25519_Point.Fp.BYTES;
  abytes2(secretKey, size);
  return adjustScalarBytes(sha512(secretKey.subarray(0, size))).subarray(0, size);
}
function ed(opts) {
  return eddsa(ed25519_Point, sha512, Object.assign({ adjustScalarBytes, toMontgomery, toMontgomerySecret, zip215: true }, opts));
}
var ed25519 = /* @__PURE__ */ ed({});
var x25519 = /* @__PURE__ */ (() => {
  const P2 = ed25519_CURVE_p;
  const powPminus2 = (x) => {
    const { pow_p_5_8, b2 } = ed25519_pow_2_252_3(x);
    return mod(pow22(pow_p_5_8, _3n2, P2) * b2, P2);
  };
  return montgomery({
    P: P2,
    type: "x25519",
    powPminus2,
    adjustScalarBytes,
    // ~3x faster fixed-base: [k]B on the birationally-equivalent Edwards curve using cached
    // base tables, mapped back via u = (1+y)/(1-y) = (Z+Y)/(Z-Y) with one Fermat inversion.
    // Same construction as libsodium's crypto_scalarmult_curve25519_base.
    scalarMultBase: (k) => {
      const kn = mod(k, ed25519_Point.Fn.ORDER);
      if (kn === _0n6)
        return _0n6;
      const p = ed25519_Point.BASE.multiply(kn);
      return mod((p.Z + p.Y) * powPminus2(mod(p.Z - p.Y, P2)), P2);
    }
  });
})();

// src/network/noise_transport.ts
var NOISE_PROTOCOL_NAME = "Noise_XX_25519_ChaChaPoly_SHA256";
var SessionError = class extends Error {
  constructor(message, options) {
    super(message);
    this.name = "SessionError";
    if (options && options.cause !== void 0) {
      this.cause = options.cause;
    }
  }
};
var libraryPromise = null;
function loadNoiseLibrary() {
  if (libraryPromise === null) {
    libraryPromise = new Promise((resolve, reject) => {
      try {
        const requireCjs = createRequire(import.meta.url);
        const factory = requireCjs("noise-c.wasm");
        factory((lib) => resolve(lib));
      } catch (err2) {
        reject(new SessionError("failed to load noise-c.wasm", { cause: err2 }));
      }
    });
  }
  return libraryPromise;
}
var EMPTY_AD = new Uint8Array(0);
var TEXT_ENCODER = new TextEncoder();
var TEXT_DECODER = new TextDecoder();
function ed25519ToX25519PrivateKey(edPrivateKey) {
  if (edPrivateKey.length !== 32) {
    throw new SessionError(
      `ed25519 private key must be 32 bytes (got ${edPrivateKey.length})`
    );
  }
  const digest = sha512(edPrivateKey);
  const scalar = digest.slice(0, 32);
  scalar[0] &= 248;
  scalar[31] &= 127;
  scalar[31] |= 64;
  return scalar;
}
function ed25519ToX25519PublicKey(edPublicKey) {
  if (edPublicKey.length !== 32) {
    throw new SessionError(
      `ed25519 public key must be 32 bytes (got ${edPublicKey.length})`
    );
  }
  return ed25519.utils.toMontgomery(edPublicKey);
}
function noiseStaticsFromIdentity(identitySeed) {
  const privateKey = ed25519ToX25519PrivateKey(identitySeed);
  return { privateKey, publicKey: x25519.getPublicKey(privateKey) };
}
var FrameQueue = class {
  queue = [];
  waiter = null;
  closed = false;
  push(frame) {
    if (this.closed) return;
    if (this.waiter !== null) {
      const w = this.waiter;
      this.waiter = null;
      w(frame);
      return;
    }
    this.queue.push(frame);
  }
  receive() {
    const next = this.queue.shift();
    if (next !== void 0) return Promise.resolve(next);
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve) => {
      this.waiter = resolve;
    });
  }
  close() {
    this.closed = true;
    if (this.waiter !== null) {
      const w = this.waiter;
      this.waiter = null;
      w(null);
    }
  }
};
async function runXxHandshake(lib, roleConstant, inbound, outbound, staticKeys, tap, tapFrom) {
  const hs = new lib.HandshakeState(NOISE_PROTOCOL_NAME, roleConstant);
  const send = (frame) => {
    tap?.(tapFrom, frame);
    outbound.push(frame);
  };
  const recv = async () => {
    const frame = await inbound.receive();
    if (frame === null) {
      throw new SessionError("peer closed during handshake");
    }
    return frame;
  };
  try {
    hs.Initialize(EMPTY_AD, staticKeys.privateKey, null, null);
    if (roleConstant === lib.constants.NOISE_ROLE_INITIATOR) {
      send(hs.WriteMessage(null));
      hs.ReadMessage(await recv());
      send(hs.WriteMessage(null));
    } else {
      hs.ReadMessage(await recv());
      send(hs.WriteMessage(null));
      hs.ReadMessage(await recv(), true);
    }
    if (hs.GetAction() !== lib.constants.NOISE_ACTION_SPLIT) {
      throw new SessionError(
        `handshake did not complete (action=${hs.GetAction()})`
      );
    }
    const handshakeHash = new Uint8Array(hs.GetHandshakeHash());
    const remoteStaticKey = new Uint8Array(hs.GetRemotePublicKey());
    const [sendCipher, receiveCipher] = hs.Split();
    return { sendCipher, receiveCipher, handshakeHash, remoteStaticKey };
  } catch (err2) {
    try {
      if (hs.GetAction() !== lib.constants.NOISE_ACTION_SPLIT) hs.free();
    } catch {
    }
    throw err2;
  }
}
var NoiseSessionTransport = class {
  constructor(sendCipher, receiveCipher, transcriptHash, peerStaticKey, inbound, outbound, label, tap) {
    this.sendCipher = sendCipher;
    this.receiveCipher = receiveCipher;
    this.transcriptHash = transcriptHash;
    this.peerStaticKey = peerStaticKey;
    this.inbound = inbound;
    this.outbound = outbound;
    this.label = label;
    this.tap = tap;
  }
  sendCipher;
  receiveCipher;
  transcriptHash;
  peerStaticKey;
  inbound;
  outbound;
  label;
  tap;
  dead = false;
  async send(msg) {
    this.assertAlive("send");
    const plaintext = TEXT_ENCODER.encode(JSON.stringify(msg));
    let frame;
    try {
      frame = this.sendCipher.EncryptWithAd(EMPTY_AD, plaintext);
    } catch (err2) {
      this.markDead(err2);
      throw new SessionError(`${this.label}: encrypt failed`, { cause: err2 });
    }
    this.tap?.("session", frame);
    this.outbound.push(frame);
  }
  async receive() {
    this.assertAlive("receive");
    const frame = await this.inbound.receive();
    if (frame === null) return null;
    let plaintextBytes;
    try {
      plaintextBytes = this.receiveCipher.DecryptWithAd(EMPTY_AD, frame);
    } catch (err2) {
      this.markDead(err2);
      throw new SessionError(`${this.label}: decryption failed`, {
        cause: err2
      });
    }
    let msg;
    try {
      msg = JSON.parse(TEXT_DECODER.decode(plaintextBytes));
    } catch (err2) {
      this.markDead(err2);
      throw new SessionError(`${this.label}: decrypted frame is not JSON`, {
        cause: err2
      });
    }
    if (typeof msg !== "object" || msg === null || typeof msg.type !== "string") {
      this.markDead(new Error("bad message shape"));
      throw new SessionError(`${this.label}: decrypted frame is not a SyncMessage`);
    }
    return msg;
  }
  handshakeHash() {
    return new Uint8Array(this.transcriptHash);
  }
  remoteStaticKey() {
    return new Uint8Array(this.peerStaticKey);
  }
  isDead() {
    return this.dead;
  }
  injectInboundFrame(frame) {
    this.inbound.push(frame);
  }
  assertAlive(op) {
    if (this.dead) {
      throw new SessionError(
        `${this.label}: ${op} on dead session (DC-05 \xA76.3 fail-closed)`
      );
    }
  }
  markDead(_cause) {
    this.dead = true;
    try {
      this.sendCipher.free();
      this.receiveCipher.free();
    } catch {
    }
  }
};
async function handshakeOverTransport(role, inner, identitySeed) {
  const lib = await loadNoiseLibrary();
  const statics = noiseStaticsFromIdentity(identitySeed);
  const isInitiator = role === "initiator";
  const roleConstant = isInitiator ? lib.constants.NOISE_ROLE_INITIATOR : lib.constants.NOISE_ROLE_RESPONDER;
  const inbound = new FrameQueue();
  const outQ = [];
  let waiting = null;
  const pushOut = (frame) => {
    if (waiting) {
      const w = waiting;
      waiting = null;
      w(frame);
    } else {
      outQ.push(frame);
    }
  };
  const pump = (async () => {
    for (; ; ) {
      const frame = outQ.length > 0 ? outQ.shift() : await new Promise((resolve) => {
        waiting = resolve;
      });
      await inner.send(frame);
    }
  })();
  pump.catch((err2) => {
    console.warn(
      "[tide] sync outbound pump failed (carrier error, session fails closed):",
      err2 instanceof Error ? err2.message : String(err2)
    );
  });
  void (async () => {
    try {
      for (; ; ) {
        let frame;
        try {
          frame = await inner.receive();
        } catch (err2) {
          if (err2 instanceof FramingError) {
            inbound.push(SESSION_KILL_FRAME);
            break;
          }
          throw err2;
        }
        if (frame === null) break;
        inbound.push(frame);
      }
    } finally {
      inbound.close();
    }
  })().catch(() => {
  });
  const fakeQueue = { push: pushOut };
  const result = await runXxHandshake(
    lib,
    roleConstant,
    inbound,
    fakeQueue,
    statics,
    void 0,
    isInitiator ? "initiator" : "responder"
  );
  return {
    sendCipher: result.sendCipher,
    receiveCipher: result.receiveCipher,
    handshakeHash: () => new Uint8Array(result.handshakeHash),
    remoteStaticKey: () => new Uint8Array(result.remoteStaticKey),
    isDead: () => false,
    // cipher states throw once freed/exhausted
    outbound: fakeQueue,
    inbound
  };
}
var FramingError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "FramingError";
  }
};
var SESSION_KILL_FRAME = new TextEncoder().encode(
  "__TIDE_CARRIER_FAILED__"
);

// src/network/sync_runtime.ts
var KEY_FILE = "device_identity.key";
var SYNC_DEFAULT_PORT = 47471;
var MAX_FRAME = 4 * 1024 * 1024;
function loadOrCreateIdentity(dataDir) {
  const path = join(dataDir, KEY_FILE);
  if (existsSync2(path)) {
    return identityFromPrivateKey(new Uint8Array(readFileSync2(path)));
  }
  const id = generateIdentity();
  writeFileSync2(path, Buffer.from(id.privateKey), { mode: 384 });
  return id;
}
function socketFraming(sock) {
  let buffer = Buffer.alloc(0);
  const queue = [];
  let notify = null;
  let closed = false;
  const wake = () => {
    if (notify && (queue.length > 0 || closed)) {
      const n = notify;
      notify = null;
      n();
    }
  };
  let failed = false;
  const fail2 = (err2) => {
    closed = true;
    if (err2) failed = true;
    wake();
  };
  sock.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4 && !closed) {
      const len = buffer.readUInt32BE(0);
      if (len > MAX_FRAME) {
        failed = true;
        sock.destroy();
        return;
      }
      if (buffer.length < 4 + len) break;
      queue.push(Buffer.from(buffer.subarray(4, 4 + len)));
      buffer = Buffer.from(buffer.subarray(4 + len));
    }
    wake();
  });
  sock.on("close", () => fail2());
  sock.on("error", () => fail2(true));
  sock.on("end", () => fail2());
  let pendingWrites = 0;
  return {
    /** Resolves when the frame is handed to the kernel AND flushed. */
    async send(frame) {
      if (closed || sock.destroyed) throw new Error("socket closed");
      const head = Buffer.alloc(4);
      head.writeUInt32BE(frame.length, 0);
      pendingWrites++;
      await new Promise((resolve, reject) => {
        sock.write(head, (e1) => {
          if (e1) {
            pendingWrites--;
            reject(e1);
            return;
          }
          sock.write(Buffer.from(frame), (e2) => {
            pendingWrites--;
            if (e2) reject(e2);
            else resolve();
          });
        });
      });
      await new Promise((resolve) => {
        if (pendingWrites > 0 || sock.writableLength > 0) {
          const check = () => {
            if (sock.writableLength === 0 || sock.destroyed) resolve();
            else sock.once("drain", check);
          };
          check();
        } else resolve();
      });
    },
    /** True while frames are still being flushed to the kernel. */
    get flushing() {
      return pendingWrites > 0 || sock.writableLength > 0;
    },
    async receive() {
      if (queue.length > 0) return new Uint8Array(queue.shift());
      if (closed && failed) throw new FramingError("sync carrier failed (RST/socket error/oversize frame)");
      if (closed) return null;
      await new Promise((resolve) => {
        notify = resolve;
      });
      if (queue.length > 0) return new Uint8Array(queue.shift());
      if (failed) throw new FramingError("sync carrier failed (RST/socket error/oversize frame)");
      return null;
    }
  };
}
function serveSync(identitySeed, port, onSession) {
  const server = createServer((sock) => {
    void (async () => {
      try {
        const inner = socketFraming(sock);
        const raw = await handshakeOverTransport(
          "responder",
          inner,
          identitySeed
        );
        const framing = inner;
        const doneOnce = /* @__PURE__ */ (() => {
          let called = false;
          return () => {
            if (called) return;
            called = true;
            const finish = () => {
              sock.end();
            };
            if (framing.flushing) setTimeout(finish, 50);
            else finish();
          };
        })();
        onSession({
          raw,
          transport: new NoiseSessionTransport(
            raw.sendCipher,
            raw.receiveCipher,
            raw.handshakeHash(),
            raw.remoteStaticKey(),
            raw.inbound,
            raw.outbound,
            "responder"
          ),
          json: makeJsonChannel(raw),
          done: doneOnce
        });
      } catch {
        sock.destroy();
      }
    })();
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, () => {
      const addr = server.address();
      const actualPort = typeof addr === "object" && addr !== null ? addr.port : port;
      resolve({ actualPort, close: () => server.close() });
    });
  });
}
async function connectSync(identitySeed, host, port) {
  const sock = await new Promise((resolve, reject) => {
    const s = connect({ host, port }, () => resolve(s));
    s.once("error", reject);
  });
  const inner = socketFraming(sock);
  const raw = await handshakeOverTransport("initiator", inner, identitySeed);
  return {
    raw,
    transport: new NoiseSessionTransport(
      raw.sendCipher,
      raw.receiveCipher,
      raw.handshakeHash(),
      raw.remoteStaticKey(),
      raw.inbound,
      raw.outbound,
      "initiator"
    ),
    json: makeJsonChannel(raw),
    done: () => {
      const framing = inner;
      if (framing.flushing) setTimeout(() => sock.end(), 50);
      else sock.end();
    }
  };
}
function jdbg(m) {
  if (globalThis.__TIDE_JDBG)
    console.error("[json]", m);
}
function makeJsonChannel(raw) {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  let dead = false;
  return {
    async send(obj) {
      jdbg("send " + JSON.stringify(obj).slice(0, 60));
      if (dead) throw new Error("json channel dead");
      const frame = raw.sendCipher.EncryptWithAd(
        new Uint8Array(0),
        enc.encode(JSON.stringify(obj))
      );
      raw.outbound.push(frame);
    },
    async receive() {
      if (dead) {
        jdbg("receive on dead");
        throw new Error("json channel dead");
      }
      const frame = await raw.inbound.receive();
      if (frame === null) {
        jdbg("receive -> null (closed)");
        return null;
      }
      let plain;
      try {
        plain = raw.receiveCipher.DecryptWithAd(new Uint8Array(0), frame);
      } catch (err2) {
        dead = true;
        try {
          raw.sendCipher.free();
          raw.receiveCipher.free();
        } catch {
        }
        throw new Error(`json channel decrypt failed (fail-closed): ${String(err2)}`);
      }
      const obj = JSON.parse(dec.decode(plain));
      jdbg("receive ok " + JSON.stringify(obj).slice(0, 60));
      return obj;
    }
  };
}
function makePairingPayload(identity, port, name) {
  return {
    v: 1,
    device_id: identity.deviceId,
    public_key: Buffer.from(identity.publicKey).toString("base64"),
    connect: { ip: localIpHint(), port },
    ...name !== void 0 ? { name } : {}
  };
}
function localIpHint() {
  for (const list of Object.values(networkInterfaces())) {
    for (const net of list ?? []) {
      if (net.family === "IPv4" && !net.internal) return net.address;
    }
  }
  return "127.0.0.1";
}

// src/network/discovery.ts
import { createHash, randomBytes as randomBytes4 } from "node:crypto";
function instancePrefix(deviceId) {
  return createHash("sha256").update(deviceId, "utf8").digest("hex").slice(0, 8);
}

// src/network/endpoint_bridge.ts
var EndpointCache = class {
  constructor(now = Date.now) {
    this.now = now;
  }
  now;
  entries = /* @__PURE__ */ new Map();
  /**
   * Apply one mdns_event after the instance-prefix prefilter has already
   * attributed it to a device_id. "removed" deletes the entry (the last-known
   * DB row is untouched — §4.2).
   */
  applyEvent(event, deviceId) {
    if (event.kind === "removed") {
      this.entries.delete(event.instance_name);
      return;
    }
    this.entries.set(event.instance_name, {
      deviceId,
      host: event.host,
      port: event.port,
      expiresAt: this.now() + Math.max(0, event.ttl_ms)
    });
  }
  /**
   * Seed the cache from an mdns_snapshot response (sidecar restart path,
   * §6.3 — idempotent: keyed by instance_name, re-seeding cannot duplicate).
   * Only entries whose instance prefix belongs to a paired peer are applied.
   */
  applySnapshot(entries, expectedPrefixes) {
    let applied = 0;
    for (const e of entries) {
      const deviceId = expectedPrefixes.get(prefixOf(e.instance_name));
      if (deviceId === void 0) continue;
      this.applyEvent({ ...e, kind: "added" }, deviceId);
      applied++;
    }
    return applied;
  }
  /** Live (TTL-valid) entry for a device, if any. Stale entries never resolve. */
  getForDevice(deviceId) {
    const ts = this.now();
    for (const entry of this.entries.values()) {
      if (entry.deviceId !== deviceId) continue;
      if (entry.expiresAt <= ts) continue;
      return { host: entry.host, port: entry.port };
    }
    return void 0;
  }
  size() {
    return this.entries.size;
  }
};
function prefixOf(instanceName) {
  const dash = instanceName.indexOf("-");
  return dash > 0 ? instanceName.slice(0, dash) : instanceName.slice(0, 8);
}
function matchInstanceToPeer(instanceName, pairedDeviceIds) {
  const prefix = prefixOf(instanceName);
  for (const deviceId of pairedDeviceIds) {
    if (instancePrefix(deviceId) === prefix) return deviceId;
  }
  return void 0;
}
function resolveEndpoint(cache, source, deviceId) {
  const live = cache.getForDevice(deviceId);
  if (live !== void 0) return { deviceId, endpoint: live };
  const last = source.lastKnown(deviceId);
  if (last !== null) return { deviceId, endpoint: { host: last.host, port: last.port } };
  return void 0;
}

// src/network/pairing_manager.ts
import { randomBytes as randomBytes6 } from "node:crypto";

// src/security/pairing.ts
import { createHash as createHash2, createHmac, randomBytes as randomBytes5 } from "node:crypto";
var ERROR_MESSAGES = {
  MALFORMED_JSON: "payload is not valid JSON",
  BAD_VERSION: "unsupported payload version (expected v===1)",
  MISSING_FIELD: "required field absent",
  EXTRA_FIELD: "field outside the DC-05 \xA75.1 schema",
  BAD_TYPE: "field has wrong JSON type",
  BAD_DEVICE_ID: "device_id does not match d-<64 hex>",
  BAD_BASE64: "field is not well-formed base64",
  BAD_PUBLIC_KEY: "public_key is not a 32-byte Ed25519 key",
  SHORT_NONCE: "nonce shorter than 128 bits",
  NONCE_REUSE: "nonce was already seen in a recent pairing ceremony (TR-10)",
  BAD_CONNECT: "connect hint malformed (ip/port invalid)"
};
var PairingError = class extends Error {
  code;
  /** Offending field name, when applicable. */
  field;
  constructor(code, field) {
    super(`pairing:${code}${field ? ` (${field}): ${ERROR_MESSAGES[code]}` : `: ${ERROR_MESSAGES[code]}`}`);
    this.name = "PairingError";
    this.code = code;
    this.field = field;
  }
};
function freshNonce() {
  return randomBytes5(16).toString("base64");
}
var PAIRING_NONCE_LRU_LIMIT = 1024;
function createNonceStore() {
  return /* @__PURE__ */ new Map();
}
function isKnownNonce(nonce, store) {
  return store.has(nonce);
}
function recordNonce(nonce, store) {
  if (store.has(nonce)) {
    store.delete(nonce);
    store.set(nonce, true);
    return;
  }
  store.set(nonce, true);
  while (store.size > PAIRING_NONCE_LRU_LIMIT) {
    const oldest = store.keys().next();
    if (oldest.done) break;
    store.delete(oldest.value);
  }
}
function encodePairingPayload(payload) {
  const canonical = {
    v: payload.v,
    device_id: payload.device_id,
    public_key: payload.public_key,
    nonce: payload.nonce
  };
  if (payload.connect !== void 0) {
    canonical.connect = { ip: payload.connect.ip, port: payload.connect.port };
  }
  if (payload.name !== void 0) {
    canonical.name = payload.name;
  }
  return JSON.stringify(canonical);
}
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
var BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
var DEVICE_ID_RE = /^d-[0-9a-f]{64}$/;
function decodeBase64Strict(value, field) {
  if (value !== "" && !BASE64_RE.test(value)) throw new PairingError("BAD_BASE64", field);
  const buf = Buffer.from(value, "base64");
  if (buf.toString("base64") !== value) throw new PairingError("BAD_BASE64", field);
  return buf;
}
function decodePairingPayload(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new PairingError("MALFORMED_JSON");
  }
  if (!isPlainObject(parsed)) throw new PairingError("BAD_TYPE", "<root>");
  const allowed = /* @__PURE__ */ new Set(["v", "device_id", "public_key", "nonce", "connect", "name"]);
  for (const key of Object.keys(parsed)) {
    if (!allowed.has(key)) throw new PairingError("EXTRA_FIELD", key);
  }
  if (!("v" in parsed)) throw new PairingError("MISSING_FIELD", "v");
  if (parsed.v !== 1 || typeof parsed.v !== "number") throw new PairingError("BAD_VERSION", "v");
  for (const required of ["device_id", "public_key", "nonce"]) {
    if (!(required in parsed)) throw new PairingError("MISSING_FIELD", required);
  }
  if (typeof parsed.device_id !== "string") throw new PairingError("BAD_TYPE", "device_id");
  if (!DEVICE_ID_RE.test(parsed.device_id)) throw new PairingError("BAD_DEVICE_ID", "device_id");
  if (typeof parsed.public_key !== "string") throw new PairingError("BAD_TYPE", "public_key");
  const pkBytes = decodeBase64Strict(parsed.public_key, "public_key");
  if (pkBytes.length !== 32) throw new PairingError("BAD_PUBLIC_KEY", "public_key");
  if (typeof parsed.nonce !== "string") throw new PairingError("BAD_TYPE", "nonce");
  const nonceBytes = decodeBase64Strict(parsed.nonce, "nonce");
  if (nonceBytes.length * 8 < 128) throw new PairingError("SHORT_NONCE", "nonce");
  let connect2;
  if ("connect" in parsed && parsed.connect !== void 0) {
    if (!isPlainObject(parsed.connect)) throw new PairingError("BAD_TYPE", "connect");
    for (const key of Object.keys(parsed.connect)) {
      if (key !== "ip" && key !== "port") throw new PairingError("EXTRA_FIELD", `connect.${key}`);
    }
    if (!("ip" in parsed.connect) || !("port" in parsed.connect)) {
      throw new PairingError("MISSING_FIELD", "connect.ip|port");
    }
    const { ip, port } = parsed.connect;
    if (typeof ip !== "string" || ip.length === 0) throw new PairingError("BAD_CONNECT", "connect.ip");
    if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
      throw new PairingError("BAD_CONNECT", "connect.port");
    }
    connect2 = { ip, port };
  }
  let name;
  if ("name" in parsed && parsed.name !== void 0) {
    if (typeof parsed.name !== "string") throw new PairingError("BAD_TYPE", "name");
    name = parsed.name;
  }
  return { v: 1, device_id: parsed.device_id, public_key: parsed.public_key, nonce: parsed.nonce, connect: connect2, name };
}
function digestToDigits(digest, digits) {
  const decimal = BigInt("0x" + digest.toString("hex")).toString();
  if (decimal.length >= digits) return decimal.slice(0, digits);
  return decimal.padStart(digits, "0");
}
function safetyNumber(pkA, pkB, transcriptHash) {
  const sorted = [Buffer.from(pkA), Buffer.from(pkB)].sort((a, b) => a.compare(b));
  const [lo, hi] = sorted;
  const base = createHash2("sha256").update(concat(lo, hi)).digest();
  const effective = transcriptHash !== void 0 ? createHmac("sha256", Buffer.from(transcriptHash)).update(base).digest() : base;
  const digits = digestToDigits(effective, 40);
  return [0, 8, 16, 24, 32].map((i) => digits.slice(i, i + 8)).join("-");
}
var PairingSession = class _PairingSession {
  /**
   * Process-wide memory of nonces seen by ANY pairing ceremony on this
   * device (TR-10 second clause, Review-3 M-4). Bounded LRU of
   * {@link PAIRING_NONCE_LRU_LIMIT} entries.
   */
  static recentNonces = createNonceStore();
  #state = "idle";
  #local;
  #remote;
  #transcriptHash;
  #remoteVerified = false;
  #confirmed = false;
  get state() {
    return this.#state;
  }
  /**
   * §5.1/§5.2: both payloads seen. `remote` comes from scanning the QR
   * (decodePairingPayload); `local` is our own announcement.
   *
   * TR-10 (Review-3 M-4): a remote payload whose nonce was already seen in
   * a recent ceremony is rejected outright (fail-closed: session aborted).
   */
  exchangePayloads(local, remote) {
    this.#requireState("idle");
    if (isKnownNonce(remote.nonce, _PairingSession.recentNonces)) {
      this.#state = "aborted";
      throw new PairingError("NONCE_REUSE", "nonce");
    }
    recordNonce(remote.nonce, _PairingSession.recentNonces);
    this.#local = local;
    this.#remote = remote;
    this.#state = "payload_exchanged";
  }
  /** Feed the Noise handshake hash (snow `get_handshake_hash`) for V3 mixing. */
  bindTranscript(handshakeHash) {
    this.#requireState("payload_exchanged");
    if (this.#transcriptHash !== void 0) throw new PairingError("BAD_TYPE", "transcript already bound");
    this.#transcriptHash = handshakeHash;
  }
  /**
   * §6.1 V1/V2: byte-compare the remote static identity against the key
   * announced in the QR (scanner side authoritative OOB binding; displayer
   * side self-check). Mismatch => abort, zero partial state retained.
   *
   * BOTH sides are compared in the SAME key space (DC-05 §4/§6.1 V1):
   * the QR's Ed25519 identity key is first converted to its bound X25519
   * form via the deterministic §4 conversion, then compared against
   * `actualRemoteStatic` — which is an X25519 key because it comes from the
   * Noise_XX handshake over Curve25519 statics derived from identities.
   * Comparing raw Ed25519 bytes against Noise static can never match and
   * was exactly the Review-3 H-1 defect.
   */
  verifyRemoteStatic(actualRemoteStatic) {
    this.#requireState("payload_exchanged");
    if (this.#remoteVerified) throw new PairingError("BAD_TYPE", "already verified");
    const announcedEd = decodeBase64Strict(this.#remote?.public_key ?? "", "public_key");
    let announcedX25519;
    try {
      announcedX25519 = Buffer.from(ed25519ToX25519PublicKey(announcedEd));
    } catch {
      this.abort();
      throw new PairingError("BAD_PUBLIC_KEY", "QR public_key not convertible to X25519");
    }
    if (!announcedX25519.equals(Buffer.from(actualRemoteStatic))) {
      this.abort();
      throw new PairingError("BAD_PUBLIC_KEY", "remote_static != X25519(QR public_key)");
    }
    this.#remoteVerified = true;
  }
  /** §6.1 V3: the safety number displayed to the user on THIS side. */
  displaySafetyNumber() {
    this.#requireReadyToConfirm();
    return safetyNumber(
      Buffer.from(decodeBase64Strict(this.#local.public_key, "public_key")),
      Buffer.from(decodeBase64Strict(this.#remote.public_key, "public_key")),
      this.#transcriptHash
    );
  }
  /**
   * §5.4/V3: humans compared both screens; pass the programmatic comparison
   * result here. Match => verified; mismatch => abort (no trust entry).
   */
  confirmSafetyNumber(localDisplayed, remoteReported) {
    this.#requireReadyToConfirm();
    if (localDisplayed.replaceAll("-", "") !== remoteReported.replaceAll("-", "")) {
      this.abort();
      throw new PairingError("BAD_PUBLIC_KEY", "safety number mismatch");
    }
    this.#confirmed = true;
    this.#state = "verified";
  }
  /**
   * Final transition: persist the trusted-peer entry through `store` (which
   * MUST itself run the canSynchronize-style checks, §6.1 V4). Invoked at
   * most once, only from `verified`. Returns store()'s result.
   */
  storeTrust(store) {
    this.#requireState("verified");
    this.#state = "trusted_stored";
    return store();
  }
  /**
   * §6.3 fail-closed: clear ALL partial state from any reachable point.
   * After abort() nothing about the attempt survives (zero trust mutation —
   * this class never touches the trust store directly anyway; storeTrust is
   * the only bridge and it requires full verification first).
   */
  abort() {
    this.#local = void 0;
    this.#remote = void 0;
    this.#transcriptHash = void 0;
    this.#remoteVerified = false;
    this.#confirmed = false;
    if (this.#state !== "trusted_stored") this.#state = "aborted";
  }
  /** Internal guard: raw-state checks for early-phase methods. */
  #requireState(expected) {
    if (this.#state !== expected) {
      throw new PairingError("BAD_TYPE", `illegal transition request from state "${this.#state}"`);
    }
  }
  /** Internal guard: full preconditions before user confirmation steps (V3). */
  #requireReadyToConfirm() {
    if (this.#state !== "payload_exchanged" || this.#transcriptHash === void 0 || !this.#remoteVerified) {
      throw new PairingError(
        "BAD_TYPE",
        `verification order violated (state "${this.#state}", bound=${this.#transcriptHash !== void 0}, v2=${this.#remoteVerified})`
      );
    }
  }
  /** Test/debug introspection: true when no partial material remains. */
  get isCleared() {
    return this.#local === void 0 && this.#remote === void 0 && this.#transcriptHash === void 0 && !this.#remoteVerified && !this.#confirmed;
  }
};

// src/network/pairing_manager.ts
function sqlPeerStore(db) {
  return {
    store({ deviceId, publicKey, displayName, pairedAtMs }) {
      const info = db.prepare(
        `INSERT INTO peers (device_id, public_key, display_name, paired_at,
                              status, last_known_clock)
           VALUES (?, ?, ?, ?, 'trusted', '{}')
           ON CONFLICT(device_id) DO UPDATE SET
             public_key = excluded.public_key,
             display_name = excluded.display_name,
             paired_at = excluded.paired_at,
             status = 'trusted'`
      ).run(
        deviceId,
        Buffer.from(publicKey),
        displayName,
        Math.floor(pairedAtMs / 1e3)
      );
      return true;
    }
  };
}
function listTrustedPeers(db) {
  return db.prepare(
    `SELECT device_id, display_name, paired_at,
              last_endpoint_host, last_endpoint_port, last_endpoint_seen
       FROM peers
       WHERE status = 'trusted' ORDER BY paired_at`
  ).all();
}
function recordPeerEndpoint(db, deviceId, host, port, seenMs) {
  db.prepare(
    `UPDATE peers
     SET last_endpoint_host = ?, last_endpoint_port = ?, last_endpoint_seen = ?
     WHERE device_id = ?`
  ).run(host, port, seenMs, deviceId);
}
async function createPairingOffer(opts) {
  let resolveOuter;
  let rejectOuter;
  const result = new Promise(
    (res, rej) => {
      resolveOuter = res;
      rejectOuter = rej;
    }
  );
  let activeSession = null;
  const host = await serveSync(opts.identity.privateKey, opts.port ?? 0, (s) => {
    activeSession = s;
    void runDisplayerSide(s).catch(rejectOuter);
  });
  async function runDisplayerSide(session) {
    try {
      const localPayload = {
        v: 1,
        device_id: opts.identity.deviceId,
        public_key: Buffer.from(opts.identity.publicKey).toString("base64"),
        nonce: Buffer.from(freshNonce()).toString("base64"),
        name: opts.name
      };
      await session.json.send(localPayload);
      const remoteRaw = await session.json.receive();
      const ps = new PairingSession();
      ps.exchangePayloads(localPayload, remoteRaw);
      ps.bindTranscript(session.raw.handshakeHash());
      ps.verifyRemoteStatic(session.raw.remoteStaticKey());
      const safetyNumber2 = ps.displaySafetyNumber();
      ps.confirmSafetyNumber(safetyNumber2, safetyNumber2);
      ps.storeTrust(
        () => opts.store.store({
          deviceId: remoteRaw.device_id,
          publicKey: Buffer.from(remoteRaw.public_key, "base64"),
          displayName: remoteRaw.name ?? remoteRaw.device_id.slice(0, 12),
          pairedAtMs: Date.now()
        })
      );
      await session.json.send({ kind: "PAIRING_OK" });
      session.done();
      host.close();
      resolveOuter({ peerDeviceId: remoteRaw.device_id, safetyNumber: safetyNumber2 });
    } catch (err2) {
      session.done();
      host.close();
      rejectOuter(err2 instanceof Error ? err2 : new Error(String(err2)));
    }
  }
  const { actualPort } = await new Promise((res) => {
    setImmediate(() => res({ actualPort: host.actualPort }));
  });
  const base = makePairingPayload(
    opts.identity,
    actualPort,
    opts.name
  );
  const qrText = encodePairingPayload({
    ...base,
    nonce: Buffer.from(freshNonce()).toString("base64")
  });
  void activeSession;
  let offerClosed = false;
  const cancel = () => {
    if (offerClosed) return;
    offerClosed = true;
    host.close();
    try {
      activeSession?.done();
    } catch {
    }
    activeSession = null;
    rejectOuter(new Error("pairing offer cancelled"));
  };
  const originalResolve = resolveOuter;
  resolveOuter = (v) => {
    offerClosed = true;
    originalResolve(v);
  };
  const originalReject = rejectOuter;
  rejectOuter = (e) => {
    offerClosed = true;
    originalReject(e);
  };
  return { qrText, result, cancel };
}
async function acceptPairingPayload(opts) {
  const remote = decodePairingPayload(opts.qrText);
  if (!remote.connect) throw new Error("payload has no connect hint");
  const conn = await connectSync(
    opts.identity.privateKey,
    remote.connect.ip,
    remote.connect.port
  );
  const json = conn.json;
  try {
    const localPayload = {
      v: 1,
      device_id: opts.identity.deviceId,
      public_key: Buffer.from(opts.identity.publicKey).toString("base64"),
      nonce: Buffer.from(randomBytes6(16)).toString("base64"),
      name: opts.name
    };
    const firstRaw = await json.receive();
    const remoteRaw = firstRaw;
    await json.send(localPayload);
    const ps = new PairingSession();
    ps.exchangePayloads(localPayload, remoteRaw);
    ps.bindTranscript(conn.raw.handshakeHash());
    ps.verifyRemoteStatic(conn.raw.remoteStaticKey());
    const safetyNumber2 = ps.displaySafetyNumber();
    ps.confirmSafetyNumber(safetyNumber2, safetyNumber2);
    ps.storeTrust(
      () => opts.store.store({
        deviceId: remote.device_id,
        publicKey: Buffer.from(remote.public_key, "base64"),
        displayName: remote.name ?? remote.device_id.slice(0, 12),
        pairedAtMs: Date.now()
      })
    );
    const ok = await json.receive();
    if (ok.kind !== "PAIRING_OK") {
      throw new Error("pairing not confirmed by other side");
    }
    return { peerDeviceId: remote.device_id, safetyNumber: safetyNumber2 };
  } finally {
    conn.done();
  }
}

// src/sync/misbehavior.ts
var DEFAULT_MISBEHAVIOR_CONFIG = {
  windowMs: 10 * 60 * 1e3,
  tier1Count: 500,
  tier1Ratio: 0.5,
  tier2Count: 5e3,
  throttleBaseMs: 30 * 1e3,
  throttleCapMs: 10 * 60 * 1e3
};
var LADDER_LABELS = {
  0: "observe",
  1: "warn",
  2: "throttle",
  3: "suspend"
};
function freshBook() {
  return {
    level: 0,
    levelSinceMs: 0,
    backoffUntilMs: 0,
    backoffMs: 0,
    droppedWhileThrottled: 0,
    recommendUnpair: false,
    events: []
  };
}
var PeerMisbehaviorTracker = class {
  constructor(cfg = DEFAULT_MISBEHAVIOR_CONFIG, now = Date.now, onHardBlock) {
    this.cfg = cfg;
    this.now = now;
    this.onHardBlock = onHardBlock;
  }
  cfg;
  now;
  onHardBlock;
  books = /* @__PURE__ */ new Map();
  // ------------------------------------------------------------------
  // Intake gate (called by sync_engine BEFORE validation/parsing)
  // ------------------------------------------------------------------
  /** True while that producer's incoming records must be dropped at intake. */
  isIntakeDropped(producer) {
    const b = this.books.get(producer);
    if (b === void 0) return false;
    if (b.level === 3) return true;
    return b.level === 2 && this.now() < b.backoffUntilMs;
  }
  /**
   * Count one record dropped at intake while throttled (Level 2). One
   * aggregated counter — never a per-packet quarantine row, skip entry, or
   * UI entry (DC-16 §3 Level 2). Dropped arrivals still count toward the
   * Tier-2 flood window: a peer already at throttle level that keeps
   * sending is presumptively flooding, so a line-rate burst trips the hard
   * block mid-burst even though nothing further is validated.
   */
  recordDropped(producer) {
    const b = this.bookFor(producer);
    b.droppedWhileThrottled++;
    b.events.push({ t: this.now(), kind: "dropped" });
    this.evaluate(producer, b, "dropped");
    return b.droppedWhileThrottled;
  }
  // ------------------------------------------------------------------
  // Outcome feed (called by sync_engine per applied-batch record)
  // ------------------------------------------------------------------
  /** A validation rejection reached the quarantine branch. */
  recordInvalid(producer) {
    const b = this.bookFor(producer);
    b.events.push({ t: this.now(), kind: "invalid" });
    this.evaluate(producer, b, "invalid");
  }
  /** A record was processed without a validation rejection. */
  recordOk(producer) {
    const b = this.bookFor(producer);
    b.events.push({ t: this.now(), kind: "ok" });
    this.evaluate(producer, b, "ok");
  }
  // ------------------------------------------------------------------
  // §4.2 manual override — one click, no confirmation, no restart
  // ------------------------------------------------------------------
  resetPeer(producer) {
    this.books.set(producer, freshBook());
  }
  getState(producer) {
    return this.snapshot(producer, this.bookFor(producer));
  }
  /** All producers with any recorded bookkeeping (may include Level 0). */
  knownPeers() {
    return Array.from(this.books.keys()).sort();
  }
  // ------------------------------------------------------------------
  // internals
  // ------------------------------------------------------------------
  bookFor(producer) {
    let b = this.books.get(producer);
    if (b === void 0) {
      b = freshBook();
      this.books.set(producer, b);
    }
    return b;
  }
  snapshot(producer, b) {
    const w = this.windowCounts(b);
    return {
      device_id: producer,
      level: b.level,
      recommend_unpair: b.recommendUnpair,
      window_invalid: w.invalid,
      window_total: w.total,
      window_ratio: w.total === 0 ? 0 : w.invalid / w.total,
      dropped_while_throttled: b.droppedWhileThrottled,
      level_since_ms: b.levelSinceMs,
      backoff_until_ms: b.backoffUntilMs
    };
  }
  /** Prune to the window and count. Tier-2 flood count = invalid + dropped. */
  windowCounts(b) {
    const cutoff = this.now() - this.cfg.windowMs;
    b.events = b.events.filter((e) => e.t > cutoff);
    let invalid = 0;
    let dropped = 0;
    for (const e of b.events) {
      if (e.kind === "invalid") invalid++;
      else if (e.kind === "dropped") dropped++;
    }
    return { invalid, dropped, total: b.events.length };
  }
  /**
   * Arrival-time evaluation (DC-16 §2.4: bursts trip mid-burst — this runs
   * on EVERY recorded event, never on a timer).
   */
  evaluate(producer, b, trigger) {
    const now = this.now();
    const w = this.windowCounts(b);
    if (w.invalid + w.dropped > this.cfg.tier2Count) {
      this.onHardBlock?.(producer);
      return;
    }
    if (w.invalid === 0 && w.dropped === 0 && b.level > 0) {
      b.level = 0;
      b.levelSinceMs = 0;
      b.backoffUntilMs = 0;
      b.backoffMs = 0;
      b.recommendUnpair = false;
      return;
    }
    const ratio = w.total === 0 ? 0 : w.invalid / w.total;
    if (trigger === "invalid" && w.invalid > this.cfg.tier1Count && ratio > this.cfg.tier1Ratio) {
      if (b.level < 3) {
        b.level = b.level + 1;
        b.levelSinceMs = now;
        if (b.level === 2) {
          b.backoffMs = this.cfg.throttleBaseMs;
          b.backoffUntilMs = now + b.backoffMs;
        }
      }
    }
    if (b.level === 3 && now - b.levelSinceMs >= this.cfg.windowMs) {
      b.recommendUnpair = true;
    }
  }
};

// src/sync/full_state.ts
function localVersionClock(db, entityId) {
  const row = db.prepare(
    "SELECT version FROM entity_versions WHERE entity_id = ?"
  ).get(entityId);
  if (row) return JSON.parse(row.version);
  const rows = db.prepare(
    "SELECT causality_clock FROM changes WHERE entity_id = ?"
  ).all(entityId);
  let v = {};
  for (const r of rows) {
    v = merge(v, JSON.parse(r.causality_clock));
  }
  return v;
}
function latestProducer(db, entityId) {
  const row = db.prepare(
    "SELECT latest_producer, latest_seq FROM entity_versions WHERE entity_id = ?"
  ).get(entityId);
  if (row) return { device_id: row.latest_producer, local_seq: row.latest_seq };
  const change = db.prepare(
    `SELECT device_id, local_seq FROM changes WHERE entity_id = ?
       ORDER BY hlc_timestamp DESC, local_seq DESC LIMIT 1`
  ).get(entityId);
  return change;
}
function recordSnapshotEntityVersion(db, entityId, entityType, clock, producer, seq) {
  const before = localVersionClock(db, entityId);
  const merged = merge(before, clock);
  const prev = db.prepare(
    "SELECT latest_producer, latest_seq FROM entity_versions WHERE entity_id = ?"
  ).get(entityId);
  let out = prev ?? { latest_producer: producer, latest_seq: seq };
  if (prev === void 0 || (clock[producer] ?? 0) > (before[prev.latest_producer] ?? 0)) {
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
    Date.now()
  );
}
function clearEntityVersion(db, entityId) {
  db.prepare("DELETE FROM entity_versions WHERE entity_id = ?").run(entityId);
}
function hasUnresolvedConflict(db, entityId) {
  return db.prepare(
    `SELECT 1 FROM conflicts
         WHERE entity_id = ? AND status = 'unresolved' LIMIT 1`
  ).get(entityId) !== void 0;
}
function localRowMatchesEntry(db, entry) {
  const table = entry.entity_type === "event" ? "events" : entry.entity_type === "calendar" ? "calendars" : null;
  if (table === null) return false;
  const idColumn = entry.entity_type === "event" ? "event_id" : "calendar_id";
  const row = db.prepare(
    `SELECT * FROM ${table} WHERE ${idColumn} = ?`
  ).get(entry.entity_id);
  if (row === void 0) return false;
  let parsed;
  try {
    parsed = JSON.parse(entry.data);
  } catch {
    return false;
  }
  if (entry.entity_type === "calendar") {
    const a = row;
    const b = parsed;
    return a["title"] === b["title"] && a["color"] === b["color"];
  }
  return canonicalJson(row) === canonicalJson(parsed);
}
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}
function buildSnapshot(db, emit, batchSize = 256) {
  const clockRows = db.prepare(
    "SELECT peer_device_id, max_seq FROM device_clock"
  ).all();
  const snapshot_clock = {};
  for (const r of clockRows) snapshot_clock[r.peer_device_id] = r.max_seq;
  const events = db.prepare(
    "SELECT * FROM events ORDER BY event_id ASC"
  ).all();
  const calendars = db.prepare(
    "SELECT * FROM calendars ORDER BY calendar_id ASC"
  ).all();
  const buffer = [];
  const flush = () => {
    if (buffer.length === 0) return;
    emit({ snapshot_clock, entities: [...buffer], tombstones: [] });
    buffer.length = 0;
  };
  for (const c of calendars) {
    const entityId = String(c.calendar_id);
    const version = localVersionClock(db, entityId);
    const winner = latestProducer(db, entityId);
    buffer.push({
      entity_id: entityId,
      entity_type: "calendar",
      data: JSON.stringify(c),
      producer_device_id: winner?.device_id ?? "_unversioned",
      producer_seq: winner?.local_seq ?? 0,
      causality_clock: version
    });
    if (buffer.length >= batchSize) flush();
  }
  for (const e of events) {
    const entityId = e.event_id;
    const version = localVersionClock(db, entityId);
    const winner = latestProducer(db, entityId);
    buffer.push({
      entity_id: entityId,
      entity_type: "event",
      data: JSON.stringify(e),
      producer_device_id: winner?.device_id ?? "_unversioned",
      producer_seq: winner?.local_seq ?? 0,
      causality_clock: version
    });
    if (buffer.length >= batchSize) flush();
  }
  const tombs = db.prepare("SELECT entity_id, entity_type, producer_device_id, seq, causality_clock, deleted_at_hlc FROM entities_tombstones").all();
  if (tombs.length > 0) {
    emit({
      snapshot_clock,
      entities: [],
      tombstones: tombs.map((t) => ({
        ...t,
        causality_clock: JSON.parse(t.causality_clock)
      }))
    });
  }
  flush();
}
function applySnapshot(db, snapshot, knowledge) {
  const result = {
    appliedEntities: 0,
    inheritedTombstones: 0,
    survivedLocal: 0,
    absenceTombstones: 0,
    conflictPreserved: 0
  };
  const insertTombstone = db.prepare(`
    INSERT INTO entities_tombstones (entity_id, entity_type, producer_device_id, seq, causality_clock, deleted_at_hlc)
    VALUES (@entity_id, @entity_type, @producer_device_id, @seq, @causality_clock, @deleted_at_hlc)
    ON CONFLICT(entity_id, producer_device_id, seq) DO NOTHING`);
  const deleteEvent = db.prepare("DELETE FROM events WHERE event_id = ?");
  const tx = db.transaction(() => {
    db.exec(`
      CREATE TEMP TABLE IF NOT EXISTS stage_entities (
        entity_id TEXT PRIMARY KEY, entity_type TEXT, data TEXT)`);
    for (const entry of snapshot.entities) {
      const localVersion = localVersionClock(db, entry.entity_id);
      if (!dominates(snapshot.snapshot_clock, localVersion)) {
        result.survivedLocal++;
        continue;
      }
      if (hasUnresolvedConflict(db, entry.entity_id)) {
        result.conflictPreserved++;
        continue;
      }
      if (localRowMatchesEntry(db, entry)) {
        continue;
      }
      db.prepare(
        `INSERT INTO temp.stage_entities (entity_id, entity_type, data) VALUES (?, ?, ?)
         ON CONFLICT(entity_id) DO UPDATE SET data = excluded.data`
      ).run(entry.entity_id, entry.entity_type, entry.data);
      recordSnapshotEntityVersion(
        db,
        entry.entity_id,
        entry.entity_type,
        entry.causality_clock,
        entry.producer_device_id,
        entry.producer_seq
      );
      result.appliedEntities++;
    }
    const staged = db.prepare(
      "SELECT entity_id, entity_type, data FROM stage_entities"
    ).all();
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
        const data = JSON.parse(s.data);
        upsertCalendar.run({
          calendar_id: data.calendar_id,
          title: data.title ?? "",
          color: data.color ?? null,
          created_hlc: data.created_hlc ?? 0,
          updated_hlc: data.updated_hlc ?? 0
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
    const snapshotIds = new Set(snapshot.entities.map((e) => e.entity_id));
    const localEvents = db.prepare("SELECT event_id FROM events").all();
    for (const le of localEvents) {
      if (snapshotIds.has(le.event_id)) continue;
      if (hasUnresolvedConflict(db, le.event_id)) {
        result.conflictPreserved++;
        continue;
      }
      const localVersion = localVersionClock(db, le.event_id);
      if (!dominates(snapshot.snapshot_clock, localVersion)) continue;
      if (Object.keys(localVersion).length === 0) continue;
      const winner = latestProducer(db, le.event_id);
      insertTombstone.run({
        entity_id: le.event_id,
        entity_type: "event",
        producer_device_id: winner?.device_id ?? "_absence",
        seq: winner?.local_seq ?? 0,
        causality_clock: JSON.stringify(
          merge(localVersion, snapshot.snapshot_clock)
        ),
        deleted_at_hlc: Date.now()
      });
      deleteEvent.run(le.event_id);
      clearEntityVersion(db, le.event_id);
      result.absenceTombstones++;
    }
    for (const t of snapshot.tombstones) {
      insertTombstone.run({
        ...t,
        causality_clock: JSON.stringify(t.causality_clock)
      });
      result.inheritedTombstones++;
    }
    for (const [d, s] of Object.entries(snapshot.snapshot_clock)) {
      const current = db.prepare("SELECT applied_through FROM applied_upto WHERE producer_device_id = ?").get(d)?.applied_through ?? 0;
      db.prepare(`
        INSERT INTO applied_upto (producer_device_id, applied_through) VALUES (?, ?)
        ON CONFLICT(producer_device_id) DO UPDATE SET applied_through = excluded.applied_through`).run(
        d,
        Math.max(current, s)
      );
      db.prepare(
        "DELETE FROM pending_changes WHERE device_id = ? AND local_seq <= ?"
      ).run(d, Math.max(current, s));
      db.prepare(
        "DELETE FROM skipped_seqs WHERE producer_device_id = ? AND local_seq <= ?"
      ).run(d, Math.max(current, s));
      advanceAppliedIfContiguous(knowledge, d, s);
    }
    for (const [d, s] of Object.entries(snapshot.snapshot_clock)) {
      db.prepare(`
        INSERT INTO device_clock (peer_device_id, max_seq) VALUES (?, ?)
        ON CONFLICT(peer_device_id) DO UPDATE SET max_seq = MAX(max_seq, excluded.max_seq)`).run(d, s);
    }
  });
  tx();
  return result;
}
function advanceAppliedIfContiguous(k, deviceId, target) {
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
    if (k.skipped?.has(deviceId)) {
      const set = k.skipped.get(deviceId);
      for (const s of [...set]) {
        if (s <= target) set.delete(s);
      }
      if (set.size === 0) k.skipped.delete(deviceId);
    }
  }
}

// src/sync/full_state_triggers.ts
var GAP_ROUND_LIMIT = 2;
var DEFAULT_MAX_INCREMENTAL_BACKLOG = 1e3;
var MIN_MAX_INCREMENTAL_BACKLOG = 100;
var MAX_MAX_INCREMENTAL_BACKLOG = 1e5;
function clampMaxIncrementalBacklog(value) {
  return Math.min(
    MAX_MAX_INCREMENTAL_BACKLOG,
    Math.max(MIN_MAX_INCREMENTAL_BACKLOG, value)
  );
}
function computeIncrementalCost(needed, info) {
  let total = 0;
  for (const r of needed) {
    const cap = info?.maxLocalSeq?.[r.device_id];
    const hi = cap === void 0 ? r.hi : Math.min(cap, r.hi);
    if (hi < r.lo) continue;
    const floor = info?.retainedLo?.[r.device_id];
    const lo = floor === void 0 ? r.lo : Math.max(floor, r.lo);
    if (hi < lo) continue;
    total += hi - lo + 1;
  }
  return total;
}
var TriggerStateTracker = class {
  streaks = /* @__PURE__ */ new Map();
  lastGapRoundAt = /* @__PURE__ */ new Map();
  now;
  limit;
  constructor(options = {}) {
    this.now = options.now ?? Date.now;
    this.limit = options.gapRoundLimit ?? GAP_ROUND_LIMIT;
  }
  key(peerId, direction) {
    return `${direction}|${peerId}`;
  }
  /**
   * Record one failed (unservable) round against peer/direction; returns the
   * new consecutive-streak length (DC-09 §3.1 pseudocode: streak += 1).
   */
  recordGapRound(peerId, direction = "OUTGOING") {
    const k = this.key(peerId, direction);
    const streak = (this.streaks.get(k) ?? 0) + 1;
    this.streaks.set(k, streak);
    this.lastGapRoundAt.set(k, this.now());
    return streak;
  }
  /**
   * Reset the streak after a servable outcome (DC-09 §3.1: any round with a
   * servable outcome resets; also used at session start).
   */
  resetStreak(peerId, direction = "OUTGOING") {
    const k = this.key(peerId, direction);
    this.streaks.set(k, 0);
    this.lastGapRoundAt.set(k, this.now());
  }
  /** Current consecutive unservable-round streak for peer/direction. */
  streak(peerId, direction = "OUTGOING") {
    return this.streaks.get(this.key(peerId, direction)) ?? 0;
  }
  /** Timestamp of last recorded/reset round (diagnostics; injectable clock). */
  lastActivityAt(peerId, direction = "OUTGOING") {
    return this.lastGapRoundAt.get(this.key(peerId, direction));
  }
  /** DC-09 §3.1 Trigger A gate: streak >= GAP_ROUND_LIMIT. Non-consuming. */
  shouldOfferTriggerA(peerId, direction = "OUTGOING") {
    return this.streak(peerId, direction) >= this.limit;
  }
  /** Convenience passthrough to the module-level cost estimator. */
  computeIncrementalCost(needed, info) {
    return computeIncrementalCost(needed, info);
  }
  /**
   * DC-09 §3.3 Trigger C gate: strictly greater-than (TR-3 boundary: exactly
   * MAX_INCREMENTAL_BACKLOG stays incremental). maxBacklog is the
   * user-adjustable setting value, clamped into [100, 100,000].
   */
  shouldOfferTriggerC(cost, maxBacklog = DEFAULT_MAX_INCREMENTAL_BACKLOG) {
    return cost > clampMaxIncrementalBacklog(maxBacklog);
  }
};
function offerSessionKey(localDeviceId, remoteDeviceId, direction) {
  return `${localDeviceId}|${remoteDeviceId}|${direction}`;
}
var OfferDedup = class {
  offered = /* @__PURE__ */ new Set();
  shouldOffer(key, trigger) {
    if (trigger === "USER_INITIATED") return true;
    return !this.offered.has(key);
  }
  markOffered(key) {
    this.offered.add(key);
  }
  hasOffered(key) {
    return this.offered.has(key);
  }
  /** Session end clears dedup state (§3.5); next session re-evaluates. */
  reset() {
    this.offered.clear();
  }
};
function resolveOfferRace(myDeviceId, peerDeviceId) {
  return myDeviceId > peerDeviceId;
}

// src/sync/sync_engine.ts
function sigToHex(sig) {
  return Array.from(sig, (b) => b.toString(16).padStart(2, "0")).join("");
}
var SYNC_IDLE_TIMEOUT_MS = 15e3;
var DRAIN_POST_ACK_POLLS = 10;
var IDLE_TICK = /* @__PURE__ */ Symbol("pkg4-idle-timeout");
var SyncIdleTimeoutError = class extends Error {
  constructor(phase, idleMs) {
    super(
      `sync session timed out waiting for peer (no message for ${idleMs}ms in ${phase})`
    );
    this.phase = phase;
    this.idleMs = idleMs;
    this.name = "SyncIdleTimeoutError";
  }
  phase;
  idleMs;
};
function sigFromHex(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
var helloClockAnomalyCount = 0;
function createSyncEngine(deps) {
  const knowledge = deps.knowledge ?? loadKnowledgeFromDb2(deps.db);
  revalidateQuarantine(deps.db, deps.mutateEntity, knowledge);
  reconcileQuarantineResolutions(deps.db);
  pruneResolvedQuarantine(deps.db);
  const holder = { knowledge };
  const maxBatch = deps.maxBatchRecords ?? 256;
  const idleTimeoutMs = deps.idleTimeoutMs ?? SYNC_IDLE_TIMEOUT_MS;
  const triggers = deps.triggers ?? new TriggerStateTracker();
  let sessionDedup = new OfferDedup();
  const misbehavior = deps.misbehavior ?? new PeerMisbehaviorTracker(DEFAULT_MISBEHAVIOR_CONFIG, Date.now);
  misbehavior.onHardBlock = (p) => hardBlockProducer(deps.db, p);
  gcZombiePending();
  function nextMessage(transport) {
    let pending = null;
    return () => {
      if (pending === null) {
        pending = transport.receive().then(
          (msg) => {
            pending = null;
            return msg;
          },
          (err2) => {
            pending = null;
            throw err2;
          }
        );
      }
      return pending;
    };
  }
  async function receiveIdleBounded(getNext, phase) {
    const pending = getNext();
    let timer;
    const idle = new Promise((resolve) => {
      timer = setTimeout(() => resolve(IDLE_TICK), idleTimeoutMs);
    });
    let msg;
    try {
      msg = await Promise.race([pending, idle]);
    } catch (e) {
      clearTimeout(timer);
      throw e;
    }
    clearTimeout(timer);
    if (msg === IDLE_TICK) {
      void pending.catch(() => {
      });
      throw new SyncIdleTimeoutError(phase, idleTimeoutMs);
    }
    return msg;
  }
  function gcZombiePending() {
    const res = deps.db.prepare(
      `DELETE FROM pending_changes WHERE (device_id, local_seq) IN (
           SELECT p.device_id, p.local_seq FROM pending_changes p
           JOIN applied_upto a ON a.producer_device_id = p.device_id
           WHERE p.local_seq <= a.applied_through)`
    ).run();
    if (res.changes === 0) return;
    const fresh = loadKnowledgeFromDb2(deps.db);
    holder.knowledge.pending = fresh.pending;
  }
  function getDeviceClockDb() {
    const rows = deps.db.prepare("SELECT peer_device_id AS d, max_seq AS s FROM device_clock").all();
    const clock = {};
    for (const r of rows) clock[r.d] = r.s;
    return clock;
  }
  function noteHelloClockAnomaly(peerClock, peerKey, stats) {
    const advertised = peerClock[deps.selfDeviceId];
    if (typeof advertised !== "number" || !Number.isFinite(advertised)) return;
    const own = getDeviceClockDb()[deps.selfDeviceId] ?? 0;
    if (advertised <= own) return;
    helloClockAnomalyCount++;
    stats.helloClockAnomaly = true;
    console.warn(
      `[tide][health] HELLO clock anomaly: peer session (${peerKey}) advertises device_clock[${deps.selfDeviceId}] = ${advertised} > our own ${own}. Impossible under honest operation (DC-02 \xA74.1) \u2014 indicates identity theft or a non-conformant same-id restore. Health cue only; no enforcement action taken (DC-16 v1).`
    );
  }
  function mergeDeviceClock(db, clock) {
    const upsert = db.prepare(`
      INSERT INTO device_clock (peer_device_id, max_seq) VALUES (?, ?)
      ON CONFLICT(peer_device_id) DO UPDATE SET
        max_seq = MAX(max_seq, excluded.max_seq)`);
    for (const [d, s] of Object.entries(clock)) upsert.run(d, s);
  }
  function seedSelfAppliedFrontier() {
    const row = deps.db.prepare(
      `SELECT MAX(s) AS m FROM (
           SELECT MAX(local_seq) AS s FROM changes WHERE device_id = ?
           UNION ALL
           SELECT (SELECT max_seq FROM device_clock WHERE peer_device_id = ?)
         )`
    ).get(deps.selfDeviceId, deps.selfDeviceId);
    const frontier = row?.m ?? 0;
    if (!Number.isFinite(frontier) || frontier <= 0) return;
    deps.db.prepare(
      `INSERT INTO applied_upto (producer_device_id, applied_through) VALUES (?, ?)
         ON CONFLICT(producer_device_id) DO UPDATE SET
           applied_through = MAX(applied_through, excluded.applied_through)`
    ).run(deps.selfDeviceId, frontier);
    if ((holder.knowledge.appliedUpto[deps.selfDeviceId] ?? 0) < frontier) {
      holder.knowledge.appliedUpto[deps.selfDeviceId] = frontier;
    }
  }
  async function runSession(transport) {
    const stats = {
      sent: 0,
      receivedApplied: 0,
      receivedBuffered: 0,
      receivedDuplicate: 0,
      receivedQuarantined: 0,
      receivedDroppedIntake: 0
    };
    sessionDedup = new OfferDedup();
    stashed.length = 0;
    seedSelfAppliedFrontier();
    gcZombiePending();
    const hello = {
      v: 1,
      type: "HELLO",
      device_clock: getDeviceClockDb()
    };
    await transport.send(hello);
    stats.sent++;
    const peerHello = await expectType(
      () => receiveIdleBounded(nextMessage(transport), "HELLO"),
      "HELLO"
    );
    advancePeerKnowledge(peerHello.device_clock);
    const peerKey = deps.peerDeviceId ?? derivePeerKey(peerHello.device_clock);
    triggers.resetStreak(peerKey);
    noteHelloClockAnomaly(peerHello.device_clock, peerKey, stats);
    await pushRevocationQueue(transport, stats);
    let ranges = neededRanges(holder.knowledge, peerHello.device_clock, deps.selfDeviceId);
    let gapRetries = 0;
    let pullIterations = 0;
    while (ranges.length > 0 && gapRetries < 2 && pullIterations < 10) {
      pullIterations++;
      await transport.send({ v: 1, type: "CHANGES_REQUEST", ranges });
      stats.sent++;
      const batch = await expectBatchOrPeerRequest(nextMessage(transport), transport, stats);
      if (batch === null) break;
      applyBatch(batch.changes, stats);
      const before = JSON.stringify(ranges);
      ranges = batch.remaining_ranges ?? neededRanges(holder.knowledge, peerHello.device_clock, deps.selfDeviceId);
      if (JSON.stringify(ranges) === before) {
        gapRetries++;
        triggers.recordGapRound(peerKey);
      } else {
        gapRetries = 0;
        triggers.resetStreak(peerKey);
      }
    }
    if (gapRetries > 0 && triggers.shouldOfferTriggerA(peerKey)) {
      const key = offerSessionKey(deps.selfDeviceId, peerKey, "OUTGOING");
      if (sessionDedup.shouldOffer(key, "GAP_ROUNDS")) {
        sessionDedup.markOffered(key);
        await emitFullStateOffer(transport, stats, false, "GAP_ROUNDS");
        await driveFullStateOffer(nextMessage(transport), transport, stats, true);
      }
    }
    const ack = {
      v: 1,
      type: "CHANGES_ACK",
      applied_upto: snapshotAppliedUpto()
    };
    await transport.send(ack);
    stats.sent++;
    try {
      await serveRequests(nextMessage(transport), transport, peerHello.device_clock, stats, 2, true);
    } finally {
      try {
        transport.close?.();
      } catch {
      }
    }
    return stats;
  }
  async function serveRequests(nextMessage2, transport, peerClock, stats, quietTicks = 2, untilPeerAck = false) {
    let quiet = 0;
    while (quiet < quietTicks) {
      const stashedMsg = drainStashed();
      if (stashedMsg !== null) {
        const ended2 = await handleBarrierMessage(
          stashedMsg,
          transport,
          stats,
          nextMessage2,
          untilPeerAck
        );
        if (ended2) return;
        quiet = 0;
        continue;
      }
      const msg = untilPeerAck ? await receiveIdleBounded(() => nextMessage2(transport), "serve/barrier") : await receiveWithTimeout(() => nextMessage2(transport), 5);
      if (msg === null) {
        if (untilPeerAck) return;
        quiet++;
        continue;
      }
      quiet = 0;
      const ended = await handleBarrierMessage(
        msg,
        transport,
        stats,
        nextMessage2,
        untilPeerAck
      );
      if (ended) return;
    }
  }
  async function handleBarrierMessage(msg, transport, stats, nextMessage2, barrierMode) {
    switch (msg.type) {
      case "CHANGES_REQUEST": {
        const changes = fetchRanges(msg.ranges);
        for (let i = 0; i < changes.length; i += maxBatch) {
          const slice = changes.slice(i, i + maxBatch);
          await transport.send({
            v: 1,
            type: "CHANGES_BATCH",
            changes: slice
          });
          stats.sent++;
        }
        if (changes.length === 0) {
          await transport.send({ v: 1, type: "CHANGES_BATCH", changes: [] });
          stats.sent++;
        }
        return false;
      }
      case "CHANGES_BATCH":
        applyBatch(msg.changes, stats);
        return false;
      case "FULL_STATE_OFFER":
        await handleIncomingOffer(msg, () => nextMessage2(transport), transport, stats);
        return false;
      case "FULL_STATE_SNAPSHOT":
        applyIncomingSnapshot(msg, stats);
        return false;
      case "CHANGES_ACK":
        mergeAckIntoLastKnownClock(msg.applied_upto);
        if (barrierMode) {
          await drainPostAck(nextMessage2, transport, stats);
          return true;
        }
        return false;
      case "HELLO":
        advancePeerKnowledge(msg.device_clock);
        return false;
      case "REVOCATION_RECORDS":
        await handleRevocationRecords(msg, transport, stats);
        return false;
      case "REVOCATIONS_ACK":
        handleRevocationsAck(msg);
        return false;
      default:
        return false;
    }
  }
  async function drainPostAck(nextMessage2, transport, stats) {
    for (let poll = 0; poll < DRAIN_POST_ACK_POLLS; poll++) {
      const msg = await receiveWithTimeout(() => nextMessage2(transport), 5);
      if (msg === null) return;
      if (msg.type === "CHANGES_REQUEST") {
        const changes = fetchRanges(msg.ranges);
        for (let i = 0; i < changes.length; i += maxBatch) {
          await transport.send({ v: 1, type: "CHANGES_BATCH", changes: changes.slice(i, i + maxBatch) });
          stats.sent++;
        }
        if (changes.length === 0) {
          await transport.send({ v: 1, type: "CHANGES_BATCH", changes: [] });
          stats.sent++;
        }
      } else if (msg.type === "CHANGES_BATCH") {
        applyBatch(msg.changes, stats);
      } else if (msg.type === "CHANGES_ACK") {
        mergeAckIntoLastKnownClock(msg.applied_upto);
      } else if (msg.type === "HELLO") {
        advancePeerKnowledge(msg.device_clock);
      } else if (msg.type === "REVOCATION_RECORDS") {
        await handleRevocationRecords(msg, transport, stats);
      } else if (msg.type === "REVOCATIONS_ACK") {
        handleRevocationsAck(msg);
      } else if (msg.type === "FULL_STATE_SNAPSHOT") {
        applyIncomingSnapshot(msg, stats);
      } else if (msg.type === "FULL_STATE_OFFER") {
      }
    }
  }
  async function expectBatchOrPeerRequest(nextMessage2, transport, stats) {
    const msg = await receiveIdleBounded(nextMessage2, "pull/CHANGES_BATCH");
    if (msg !== null && msg.type !== "CHANGES_BATCH") {
      stashed.push(msg);
      return expectBatch(nextMessage2, transport, stats);
    }
    if (msg === null) return null;
    return msg;
  }
  const stashed = [];
  function drainStashed() {
    return stashed.shift() ?? null;
  }
  async function expectBatch(nextMessage2, transport, stats) {
    for (; ; ) {
      const msg = stashed.length > 0 ? drainStashed() : await receiveIdleBounded(nextMessage2, "pull/CHANGES_BATCH");
      if (msg === null) return null;
      if (msg.type === "CHANGES_BATCH" && msg.v === 1) return msg;
      if (msg.type === "CHANGES_REQUEST") {
        const changes = fetchRanges(msg.ranges);
        for (const sliceStart of chunk(changes, maxBatch)) {
          await transport.send({ v: 1, type: "CHANGES_BATCH", changes: sliceStart });
        }
        if (changes.length === 0) {
          await transport.send({ v: 1, type: "CHANGES_BATCH", changes: [] });
        }
      } else if (msg.type === "HELLO") {
        advancePeerKnowledge(msg.device_clock);
      } else if (msg.type === "CHANGES_ACK") {
        mergeAckIntoLastKnownClock(msg.applied_upto);
      } else if (msg.type === "FULL_STATE_OFFER") {
        await handleIncomingOffer(msg, nextMessage2, transport, stats);
      } else if (msg.type === "FULL_STATE_SNAPSHOT") {
        applyIncomingSnapshot(msg, stats);
      } else if (msg.type === "REVOCATION_RECORDS") {
        await handleRevocationRecords(msg, transport, stats);
      } else if (msg.type === "REVOCATIONS_ACK") {
        handleRevocationsAck(msg);
      }
    }
  }
  function revocations() {
    return deps.revocations;
  }
  async function pushRevocationQueue(transport, stats) {
    const ch = revocations();
    if (ch === void 0) return;
    const peer = deps.peerDeviceId ?? "unknown";
    const queued = ch.queueFor(peer);
    if (queued.length === 0) return;
    await transport.send({
      v: 1,
      type: "REVOCATION_RECORDS",
      records: queued.map((s) => ({
        record: s.record,
        signature_hex: sigToHex(s.signature)
      }))
    });
    stats.sent++;
  }
  async function handleRevocationRecords(msg, transport, stats) {
    const ch = revocations();
    if (ch === void 0) return;
    const peer = deps.peerDeviceId ?? "unknown";
    for (const wire of msg.records) {
      await ch.acceptInbound(
        { record: wire.record, signature: sigFromHex(wire.signature_hex) },
        peer
      );
    }
    await transport.send({
      v: 1,
      type: "REVOCATIONS_ACK",
      accepted: ch.acceptedTriples()
    });
    stats.sent++;
  }
  function handleRevocationsAck(msg) {
    const ch = revocations();
    if (ch === void 0) return;
    ch.recordAck(deps.peerDeviceId ?? "unknown", msg.accepted);
  }
  async function emitFullStateOffer(transport, stats, userInitiated = false, reason) {
    await transport.send({
      v: 1,
      type: "FULL_STATE_OFFER",
      snapshot_clock: getDeviceClockDb(),
      sender_device_id: deps.selfDeviceId,
      ...userInitiated ? { user_initiated: true } : {},
      ...reason ? { reason } : {}
    });
    stats.sent++;
  }
  async function streamFullStateSnapshot(transport, stats) {
    const chunks = [];
    buildSnapshot(deps.db, (s) => chunks.push(s));
    if (chunks.length === 0) {
      chunks.push({ snapshot_clock: getDeviceClockDb(), entities: [], tombstones: [] });
    }
    for (let i = 0; i < chunks.length; i++) {
      const chunkMsg = chunks[i];
      await transport.send({
        v: 1,
        type: "FULL_STATE_SNAPSHOT",
        snapshot_clock: chunkMsg.snapshot_clock,
        entities: chunkMsg.entities,
        tombstones: chunkMsg.tombstones,
        final: i === chunks.length - 1
      });
      stats.sent++;
    }
  }
  function applyIncomingSnapshot(msg, stats) {
    const result = applySnapshot(
      deps.db,
      {
        snapshot_clock: msg.snapshot_clock,
        entities: msg.entities,
        tombstones: msg.tombstones ?? []
      },
      holder.knowledge
    );
    stats.receivedApplied += result.appliedEntities;
  }
  async function acceptOffer(offer, getNext, transport, stats) {
    await transport.send({
      v: 1,
      type: "FULL_STATE_ACCEPT",
      offer_snapshot_clock_digest: JSON.stringify(offer.snapshot_clock)
    });
    stats.sent++;
    await receiveAndApplySnapshots(getNext, stats);
  }
  async function receiveAndApplySnapshots(getNext, stats) {
    for (let poll = 0; poll < 20; poll++) {
      const msg = await receiveWithTimeout(getNext, 5);
      if (msg === null) return;
      if (msg.type === "FULL_STATE_SNAPSHOT") {
        applyIncomingSnapshot(msg, stats);
        if (msg.final) return;
        continue;
      }
      stashed.push(msg);
    }
  }
  async function driveFullStateOffer(getNext, transport, stats, ourOfferGapTriggered = false) {
    for (let poll = 0; poll < 10; poll++) {
      const msg = await receiveWithTimeout(getNext, 5);
      if (msg === null) return;
      if (msg.type === "FULL_STATE_ACCEPT") {
        await streamFullStateSnapshot(transport, stats);
        return;
      }
      if (msg.type === "FULL_STATE_OFFER") {
        if (ourOfferGapTriggered) {
          await acceptOffer(msg, getNext, transport, stats);
          return;
        }
        if (resolveOfferRace(deps.selfDeviceId, msg.sender_device_id ?? "")) {
          continue;
        }
        await acceptOffer(msg, getNext, transport, stats);
        return;
      }
      stashed.push(msg);
    }
  }
  async function handleIncomingOffer(offer, getNext, transport, stats) {
    if (offer.reason === "GAP_ROUNDS") {
      const key = offerSessionKey(deps.selfDeviceId, offer.sender_device_id ?? "", "OUTGOING");
      if (sessionDedup.shouldOffer(key, "GAP_ROUNDS")) {
        sessionDedup.markOffered(key);
        await emitFullStateOffer(transport, stats);
        await driveFullStateOffer(getNext, transport, stats);
        return;
      }
    }
    const sender = offer.sender_device_id;
    if (sender !== void 0 && resolveOfferRace(deps.selfDeviceId, sender)) {
      sessionDedup.markOffered(
        offerSessionKey(deps.selfDeviceId, sender, "OUTGOING")
      );
      await emitFullStateOffer(transport, stats);
      await driveFullStateOffer(getNext, transport, stats);
      return;
    }
    await acceptOffer(offer, getNext, transport, stats);
  }
  function chunk(arr, size) {
    const out = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
  }
  async function receiveWithTimeout(nextMessage2, maxPolls) {
    for (let i = 0; i < maxPolls; i++) {
      const msg = await Promise.race([
        nextMessage2(),
        new Promise(
          (resolve) => setTimeout(() => resolve("timeout"), 2)
        )
      ]);
      if (msg !== "timeout") return msg;
    }
    return null;
  }
  function applyBatch(changes, stats) {
    for (const raw of changes) {
      const rawDevice = raw?.device_id;
      const producer = typeof rawDevice === "string" && rawDevice.length > 0 ? rawDevice : deps.peerDeviceId ?? "unknown";
      if (isHardBlocked(deps.db, producer)) continue;
      if (misbehavior.isIntakeDropped(producer)) {
        misbehavior.recordDropped(producer);
        stats.receivedDroppedIntake++;
        continue;
      }
      const rawProducer = raw?.device_id;
      const rawSeq = raw?.local_seq;
      if (typeof rawProducer === "string" && rawProducer.length > 0 && typeof rawSeq === "number" && Number.isInteger(rawSeq) && rawSeq > 0 && isSeqSkipped(deps.db, rawProducer, rawSeq)) {
        const cc = raw.causality_clock;
        if (typeof cc === "object" && cc !== null && !Array.isArray(cc) && Object.values(cc).every(
          (v) => typeof v === "number" && Number.isInteger(v) && v >= 0
        )) {
          mergeDeviceClock(deps.db, cc);
        }
        stats.receivedDuplicate++;
        misbehavior.recordOk(producer);
        continue;
      }
      let record;
      try {
        record = validateChangeRecord(raw);
      } catch (e) {
        quarantineRecord(deps.db, {
          reason: "invalid_change_record:" + (e instanceof Error ? e.message.slice(0, 120) : String(e).slice(0, 120)),
          senderDeviceId: deps.selfDeviceId,
          rawRecord: raw
        });
        const skippedProducer = raw?.device_id;
        const seq = raw?.local_seq;
        if (typeof skippedProducer === "string" && skippedProducer.length > 0 && typeof seq === "number" && Number.isInteger(seq) && seq > 0) {
          markSeqSkipped(deps.db, skippedProducer, seq);
          if (!holder.knowledge.skipped) holder.knowledge.skipped = /* @__PURE__ */ new Map();
          let set = holder.knowledge.skipped.get(skippedProducer);
          if (!set) {
            set = /* @__PURE__ */ new Set();
            holder.knowledge.skipped.set(skippedProducer, set);
          }
          set.add(seq);
        }
        stats.receivedQuarantined++;
        misbehavior.recordInvalid(producer);
        appendInvalidTally(deps.db, producer);
        continue;
      }
      const outcome = applyRemoteChange(
        deps.db,
        record,
        holder.knowledge,
        deps.mutateEntity
      );
      if (outcome === "applied") stats.receivedApplied++;
      else if (outcome === "buffered") stats.receivedBuffered++;
      else stats.receivedDuplicate++;
      misbehavior.recordOk(producer);
    }
  }
  function fetchRanges(ranges) {
    const out = [];
    const stmt = deps.db.prepare(`
      SELECT change_id, device_id, local_seq, entity_id, entity_type,
             field_path, operation, payload, hlc_timestamp, causality_clock,
             schema_version
      FROM changes WHERE device_id = ? AND local_seq >= ? AND local_seq <= ?
      ORDER BY local_seq`);
    for (const r of ranges) {
      const rows = stmt.all(r.device_id, r.lo, r.hi);
      for (const row of rows) {
        out.push({
          ...row,
          payload: JSON.parse(row.payload),
          causality_clock: JSON.parse(row.causality_clock)
        });
      }
    }
    return out;
  }
  function advancePeerKnowledge(peerClock) {
    advanceByMerge(holder.knowledge.peerAdvertised ?? (holder.knowledge.peerAdvertised = {}), peerClock);
  }
  function mergeAckIntoLastKnownClock(applied) {
    advanceByMerge(
      holder.knowledge.peerAdvertised ?? (holder.knowledge.peerAdvertised = {}),
      applied
    );
  }
  function snapshotAppliedUpto() {
    const rows = deps.db.prepare("SELECT producer_device_id AS d, applied_through AS a FROM applied_upto").all();
    const out = {};
    for (const r of rows) out[r.d] = r.a;
    return out;
  }
  return { runSession };
}
async function expectType(nextMessage, type) {
  const msg = await nextMessage();
  if (msg === null || msg.type !== type || msg.v !== 1) {
    throw new Error(`protocol violation: expected ${type}, got ${msg?.type ?? "closed"}`);
  }
  return msg;
}
function loadKnowledgeFromDb2(db) {
  const k = emptyKnowledge();
  k.skipped = /* @__PURE__ */ new Map();
  const upto = db.prepare(
    "SELECT producer_device_id AS d, applied_through AS a FROM applied_upto"
  ).all();
  for (const r of upto) k.appliedUpto[r.d] = r.a;
  const pend = db.prepare("SELECT device_id AS d, local_seq AS s FROM pending_changes").all();
  for (const r of pend) {
    let set = k.pending.get(r.d);
    if (!set) {
      set = /* @__PURE__ */ new Set();
      k.pending.set(r.d, set);
    }
    set.add(r.s);
  }
  const skipped = db.prepare(
    "SELECT producer_device_id AS d, local_seq AS s FROM skipped_seqs"
  ).all();
  for (const r of skipped) {
    let set = k.skipped.get(r.d);
    if (!set) {
      set = /* @__PURE__ */ new Set();
      k.skipped.set(r.d, set);
    }
    set.add(r.s);
  }
  return k;
}
function revalidateOneQuarantineRaw(db, rawRecord, mutate, knowledge) {
  let record;
  try {
    record = validateChangeRecord(JSON.parse(rawRecord));
  } catch {
    return { outcome: "invalid" };
  }
  try {
    let outcome;
    db.transaction(() => {
      db.prepare(
        "DELETE FROM skipped_seqs WHERE producer_device_id = ? AND local_seq = ?"
      ).run(record.device_id, record.local_seq);
      const k = knowledge ?? loadKnowledgeFromDb2(db);
      const res = applyRemoteChange(db, record, k, mutate);
      outcome = res;
    })();
    if (outcome === "applied") return { outcome: "applied" };
    if (outcome === "buffered") return { outcome: "buffered" };
    return { outcome: "duplicate" };
  } catch {
    markSeqSkipped(db, record.device_id, record.local_seq);
    return { outcome: "failed" };
  }
}
function retryQuarantineRecord(db, quarantineId, mutate) {
  const row = db.prepare(
    "SELECT raw_record, resolved_at_hlc FROM quarantine WHERE quarantine_id = ?"
  ).get(quarantineId);
  if (!row) return { outcome: "not_found", resolved: false };
  if (row.resolved_at_hlc !== null) {
    return { outcome: "already_resolved", resolved: false };
  }
  const res = revalidateOneQuarantineRaw(db, row.raw_record, mutate);
  if (res.outcome === "invalid" || res.outcome === "failed") {
    return { outcome: res.outcome, resolved: false };
  }
  const resolved = markQuarantineResolved(db, quarantineId, "retried_by_user");
  return { outcome: res.outcome, resolved };
}
function revalidateQuarantine(db, mutate, knowledge) {
  const rows = db.prepare("SELECT raw_record FROM quarantine ORDER BY quarantine_id").all();
  const result = {
    examined: 0,
    revalidated: 0,
    stillInvalid: 0
  };
  for (const row of rows) {
    result.examined++;
    const res = revalidateOneQuarantineRaw(db, row.raw_record, mutate, knowledge);
    if (res.outcome === "applied") result.revalidated++;
    else if (res.outcome === "invalid" || res.outcome === "failed") {
      result.stillInvalid++;
    }
  }
  return result;
}
function derivePeerKey(clock) {
  const producers = Object.keys(clock).sort();
  return producers.length > 0 ? producers.join(",") : "unknown";
}

// src/persistence/bridges/sync_service.ts
function existingText(db, eventId, col) {
  const row = db.prepare(`SELECT title, description FROM events WHERE event_id = ?`).get(eventId);
  void col;
  if (!row) return "";
  return col === "title" ? row.title : row.description;
}
function eventRowExists(db, eventId) {
  return !!db.prepare(`SELECT 1 FROM events WHERE event_id = ?`).get(eventId);
}
function makeEntityMutator() {
  return (db, record) => {
    if (record.entity_type !== "event") return;
    if (record.operation === "remove") {
      db.prepare("DELETE FROM events WHERE event_id = ?").run(record.entity_id);
      return;
    }
    if (record.field_path === "title") {
      if (typeof record.payload.value !== "string") return;
      db.prepare(
        "UPDATE events SET title = ?, updated_hlc = ? WHERE event_id = ?"
      ).run(record.payload.value, record.hlc_timestamp, record.entity_id);
      return;
    }
    if (record.field_path === "description") {
      if (typeof record.payload.value !== "string") return;
      db.prepare(
        "UPDATE events SET description = ?, updated_hlc = ? WHERE event_id = ?"
      ).run(record.payload.value, record.hlc_timestamp, record.entity_id);
      return;
    }
    if (record.field_path === "schedule") {
      const v2 = record.payload.value;
      if (!v2 || typeof v2.startMs !== "number" || typeof v2.endMs !== "number")
        return;
      if (!eventRowExists(db, record.entity_id)) return;
      insertEventRow(
        db,
        {
          id: record.entity_id,
          title: existingText(db, record.entity_id, "title"),
          description: existingText(db, record.entity_id, "description"),
          startMs: v2.startMs,
          endMs: Math.max(v2.endMs, v2.startMs),
          allDay: v2.allDay === true
        },
        record.hlc_timestamp,
        true
        // upsert
      );
      return;
    }
    const value = record.payload.value;
    if (!value || typeof value !== "object") return;
    const v = value;
    if (typeof v.title !== "string" || typeof v.startMs !== "number" || typeof v.endMs !== "number") {
      return;
    }
    const allDay = v.allDay === true;
    insertEventRow(
      db,
      {
        id: typeof v.id === "string" ? v.id : record.entity_id,
        title: v.title,
        description: typeof v.description === "string" ? v.description : "",
        startMs: v.startMs,
        endMs: Math.max(v.endMs, v.startMs),
        allDay
      },
      record.hlc_timestamp,
      true
      // upsert
    );
    void eventFields;
  };
}

// src/application/scheduler.ts
var DEBOUNCE_SECONDS_DEFAULT = 10;
var DEBOUNCE_SECONDS_MIN = 1;
var DEBOUNCE_SECONDS_MAX = 300;
var SWEEP_MINUTES_DEFAULT = 10;
var SWEEP_MINUTES_MIN = 5;
var SWEEP_MINUTES_MAX = 1440;
var MAX_CONCURRENT_SESSIONS_DEFAULT = 3;
var MAX_CONCURRENT_SESSIONS_MIN = 1;
var MAX_CONCURRENT_SESSIONS_MAX = 10;
var BACKOFF_BASE_MS = 6e4;
var BACKOFF_FACTOR = 2;
var BACKOFF_MAX_MS = 36e5;
function clamp(value, fallback, min, max) {
  if (value === void 0 || typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, value));
}
var Scheduler = class {
  clock;
  settingsInternal;
  /** Pending local changes awaiting the debounced push (§3.3). */
  dirty = false;
  /** Absolute ms deadline currently armed by the runtime, if any. */
  debounceFireAtMs = null;
  /** Active session lock, keyed by remote peer device_id (§4.1). */
  activePeers = /* @__PURE__ */ new Set();
  /** Consecutive failure count per peer (backoff exponent, §6.1). */
  consecutiveFailures = /* @__PURE__ */ new Map();
  /** Earliest next automatic attempt per peer (absolute ms, §6.1). */
  nextAttemptAt = /* @__PURE__ */ new Map();
  constructor(deps) {
    this.clock = deps.now;
    this.settingsInternal = {
      debounceSeconds: clamp(
        deps.settings?.debounceSeconds,
        DEBOUNCE_SECONDS_DEFAULT,
        DEBOUNCE_SECONDS_MIN,
        DEBOUNCE_SECONDS_MAX
      ),
      sweepMinutes: clamp(
        deps.settings?.sweepMinutes,
        SWEEP_MINUTES_DEFAULT,
        SWEEP_MINUTES_MIN,
        SWEEP_MINUTES_MAX
      ),
      maxConcurrentSessions: clamp(
        deps.settings?.maxConcurrentSessions,
        MAX_CONCURRENT_SESSIONS_DEFAULT,
        MAX_CONCURRENT_SESSIONS_MIN,
        MAX_CONCURRENT_SESSIONS_MAX
      )
    };
  }
  // ------------------------------------------------------------------
  // Settings (§3.5: live effect, clamped to bounds)
  // ------------------------------------------------------------------
  getSettings() {
    return this.settingsInternal;
  }
  /** Applies a partial settings update immediately; values clamp to bounds. */
  updateSettings(partial) {
    this.settingsInternal = {
      debounceSeconds: clamp(
        partial.debounceSeconds,
        this.settingsInternal.debounceSeconds,
        DEBOUNCE_SECONDS_MIN,
        DEBOUNCE_SECONDS_MAX
      ),
      sweepMinutes: clamp(
        partial.sweepMinutes,
        this.settingsInternal.sweepMinutes,
        SWEEP_MINUTES_MIN,
        SWEEP_MINUTES_MAX
      ),
      maxConcurrentSessions: clamp(
        partial.maxConcurrentSessions,
        this.settingsInternal.maxConcurrentSessions,
        MAX_CONCURRENT_SESSIONS_MIN,
        MAX_CONCURRENT_SESSIONS_MAX
      )
    };
  }
  // ------------------------------------------------------------------
  // Trigger events (§3.1) — pure decisions, no side effects beyond state
  // ------------------------------------------------------------------
  /**
   * Local change applied: mark dirty and (re)start the debounce window.
   * Every change restarts the timer — fires once, debounce seconds after
   * the LAST change.
   */
  onLocalChange() {
    this.dirty = true;
    this.debounceFireAtMs = this.clock() + this.settingsInternal.debounceSeconds * 1e3;
    return { shouldScheduleDebounce: true, fireAtMs: this.debounceFireAtMs };
  }
  /**
   * Runtime reports the armed debounce timer expired. If changes are still
   * pending, decide a push toward the given available trusted peers,
   * skipping peers with an active session (coalesced, §4.1) or active
   * backoff (§6.1). Otherwise nothing to do.
   *
   * @param availablePeers remote peer device_ids currently known-available
   *   (from the discovery layer). Defaults to none.
   */
  onDebounceFired(availablePeers = []) {
    this.debounceFireAtMs = null;
    if (!this.dirty) {
      return { action: "noop" };
    }
    this.dirty = false;
    const peers = availablePeers.filter((p) => this.isPeerEligible(p));
    return { action: "push", peers };
  }
  /** Application start / main-window foregrounding (§3.2): NOT debounced. */
  onStartup() {
    return { action: "immediate-sync" };
  }
  /** Network change / Wi-Fi reconnect (§3.4): immediate attempt, backoff-bounded. */
  onNetworkChange() {
    return { action: "immediate-sync" };
  }
  /** Periodic background sweep tick (§3.1 row 4). */
  onSweepTick() {
    return { action: "sweep" };
  }
  /** Currently armed debounce deadline, or null when nothing is pending. */
  getDebounceFireAtMs() {
    return this.debounceFireAtMs;
  }
  // ------------------------------------------------------------------
  // Session tracking (§4.1 / §4.2)
  // ------------------------------------------------------------------
  /**
   * Attempts to open a sync session with the peer. Fails (returns false,
   * fully coalesced per §4.1) when:
   *   - a session with this peer is already active, OR
   *   - the peer is in automatic backoff and this is not a manual sync, OR
   *   - the cross-peer concurrency cap is reached (§4.2).
   */
  tryBeginSession(peerId, options = {}) {
    if (this.activePeers.has(peerId)) {
      return false;
    }
    if (!options.manualSyncBypassesBackoff && this.isBackoffActive(peerId)) {
      return false;
    }
    if (!this.canStartSession()) {
      return false;
    }
    this.activePeers.add(peerId);
    return true;
  }
  /**
   * Closes a session. On success, backoff state resets entirely (§6.1);
   * on failure, the peer enters/exalates exponential backoff:
   * next attempt allowed at now + min(base * 2^prior_failures, 1h),
   * so the FIRST failure delays by exactly the base of 1 minute (§6.1/TR-7).
   */
  endSession(peerId, success) {
    this.activePeers.delete(peerId);
    if (success) {
      this.recordSuccess(peerId);
      return;
    }
    const failures = this.consecutiveFailures.get(peerId) ?? 0;
    this.consecutiveFailures.set(peerId, failures + 1);
    this.nextAttemptAt.set(peerId, this.clock() + this.backoffDelayFor(failures));
  }
  /** Absolute earliest ms at which an automatic attempt to the peer may start. */
  nextAttemptAllowedAt(peerId) {
    return this.nextAttemptAt.get(peerId) ?? 0;
  }
  /** True while automatic triggers must skip the peer (manual sync may not). */
  isBackoffActive(peerId) {
    return this.clock() < this.nextAttemptAllowedAt(peerId);
  }
  /** Any successful session resets that peer's backoff to base (§6.1). */
  recordSuccess(peerId) {
    this.consecutiveFailures.delete(peerId);
    this.nextAttemptAt.delete(peerId);
  }
  isActive(peerId) {
    return this.activePeers.has(peerId);
  }
  get activeSessionCount() {
    return this.activePeers.size;
  }
  /** Cross-peer concurrency gate (§4.2). */
  canStartSession() {
    return this.activeSessionCount < this.settingsInternal.maxConcurrentSessions;
  }
  backoffDelayFor(failures) {
    return Math.min(BACKOFF_BASE_MS * BACKOFF_FACTOR ** failures, BACKOFF_MAX_MS);
  }
  isPeerEligible(peerId) {
    return !this.isActive(peerId) && !this.isBackoffActive(peerId);
  }
};

// src/application/scheduler_runtime.ts
var defaultLog = (message) => {
  console.log(`[tide-scheduler] ${message}`);
};
function makeSessionOpener(deps) {
  return async ({ deviceId, endpoint }) => {
    const session = await withTimeout(
      connectSync(deps.privateKey, endpoint.host, endpoint.port),
      SYNC_CONNECT_TIMEOUT_MS,
      `sync connect timed out waiting for peer ${endpoint.host}:${endpoint.port} (no TCP connect / Noise handshake within ${SYNC_CONNECT_TIMEOUT_MS}ms)`
    );
    session.dialEndpoint = { host: endpoint.host, port: endpoint.port };
    session.deviceId = deviceId;
    await deps.runSession(session);
    return true;
  };
}
var SchedulerRuntime = class {
  scheduler;
  deps;
  log;
  debounceTimer = null;
  sweepTimer = null;
  running = false;
  constructor(deps) {
    this.deps = deps;
    this.scheduler = deps.scheduler;
    this.log = deps.log ?? defaultLog;
  }
  // ------------------------------------------------------------------
  // Lifecycle
  // ------------------------------------------------------------------
  start() {
    if (this.running) return;
    this.running = true;
    const sweepMinutes = this.scheduler.getSettings().sweepMinutes ?? SWEEP_MINUTES_DEFAULT;
    this.sweepTimer = setInterval(() => {
      this.consume(this.scheduler.onSweepTick(), { manual: false });
    }, sweepMinutes * 6e4);
    this.log(`runtime started (sweep every ${sweepMinutes}min; sweep is UNWIRED/no-op)`);
  }
  stop() {
    this.running = false;
    if (this.debounceTimer !== null) clearTimeout(this.debounceTimer);
    this.debounceTimer = null;
    if (this.sweepTimer !== null) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
  }
  get isRunning() {
    return this.running;
  }
  // ------------------------------------------------------------------
  // Trigger events (DC-13 §3.1) — thin timers over pure decisions
  // ------------------------------------------------------------------
  /** Local change applied: (re)arm the debounce timer (every change restarts). */
  onLocalChange() {
    const decision = this.scheduler.onLocalChange();
    if (this.debounceTimer !== null) clearTimeout(this.debounceTimer);
    const delay = Math.max(0, decision.fireAtMs - this.deps.now());
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      const availablePeers = this.deps.listPeers().filter((p) => p.endpoint !== null).map((p) => p.deviceId);
      this.consume(this.scheduler.onDebounceFired(availablePeers), { manual: false });
    }, delay);
  }
  /**
   * Manual "Sync now" (tray menu / toolbar, DC-19 §4.2): immediate-sync with
   * manualSyncBypassesBackoff=true. NOT debounced.
   */
  manualSyncNow() {
    this.consume({ action: "immediate-sync" }, { manual: true });
  }
  /** Exposed for tests/embedders that drive decisions directly. */
  consume(decision, opts) {
    switch (decision.action) {
      case "noop":
        return;
      case "sweep":
        this.log("sweep action received: UNWIRED (compaction feature pending) \u2014 no-op");
        return;
      case "immediate-sync":
        for (const peer of this.deps.listPeers()) {
          void this.attempt(peer, opts.manual);
        }
        return;
      case "push": {
        const wanted = new Set(decision.peers);
        for (const peer of this.deps.listPeers()) {
          if (wanted.has(peer.deviceId)) void this.attempt(peer, opts.manual);
        }
        return;
      }
    }
  }
  // ------------------------------------------------------------------
  // Session lifecycle (§4.1 one session per peer, §4.2 concurrency cap)
  // ------------------------------------------------------------------
  async attempt(peer, manual) {
    if (peer.endpoint === null) {
      this.log(`peer ${peer.deviceId}: no endpoint known (DC-11 wiring pending) \u2014 skipped`);
      return;
    }
    const ok = this.scheduler.tryBeginSession(peer.deviceId, {
      manualSyncBypassesBackoff: manual
    });
    if (!ok) {
      this.log(
        `peer ${peer.deviceId}: session not started (active / backoff / concurrency cap${manual ? "; manual bypass did not apply" : ""})`
      );
      return;
    }
    this.deps.onSessionStart?.(peer.deviceId);
    let success = false;
    try {
      success = await this.deps.openSession({
        deviceId: peer.deviceId,
        endpoint: peer.endpoint
      });
    } catch (err2) {
      this.log(
        `peer ${peer.deviceId}: session failed: ${err2 instanceof Error ? err2.message : String(err2)}`
      );
      success = false;
    } finally {
      this.scheduler.endSession(peer.deviceId, success);
      this.deps.onSessionEnd?.(peer.deviceId, success);
    }
    this.log(
      `peer ${peer.deviceId}: session ${success ? "succeeded" : "failed"}` + (success ? "" : " \u2014 exponential backoff armed (DC-13 \xA76.1)")
    );
  }
};
function startSchedulerRuntime(deps) {
  const scheduler = new Scheduler({ now: deps.now, settings: deps.settings });
  const runtime = new SchedulerRuntime({ ...deps, scheduler });
  runtime.start();
  return {
    scheduler,
    runtime,
    manualSyncNow: () => runtime.manualSyncNow(),
    onLocalChange: () => runtime.onLocalChange(),
    stop: () => runtime.stop(),
    // DC-20 §7.1: live-apply — stop (clears timers), update the Scheduler's
    // clamped settings, restart (rebuilds the sweep interval timer; the
    // debounce timer is only armed by the next local change). In-flight
    // sessions are unaffected (beginSession/endSession bookkeeping lives in
    // the Scheduler, not the timers).
    updateSchedulerSettings: (partial) => {
      runtime.stop();
      scheduler.updateSettings(partial);
      runtime.start();
      const s = scheduler.getSettings();
      deps.log?.(
        `settings live-applied (debounce=${s.debounceSeconds}s, sweep=${s.sweepMinutes}min, maxConcurrent=${s.maxConcurrentSessions})`
      );
    }
  };
}

// src/application/reminder_engine.ts
function rebuildSchedule(events, reminders, nowMs, lastTickMs) {
  const out = [];
  const byEntity = new Map(events.map((e) => [e.entity_id, e]));
  for (const rem of reminders) {
    const ev = byEntity.get(rem.entity_id);
    if (ev === void 0) continue;
    const startMs = ev.all_day === 1 || ev.utc_start_ms == null ? wallToMs(ev.start_wall) : ev.utc_start_ms;
    if (!Number.isFinite(startMs)) continue;
    const endMsFor = (fallbackMs) => ev.utc_end_ms != null ? ev.utc_end_ms : fallbackMs;
    let fireAt;
    if (ev.all_day === 1) {
      if (!ev.all_day_reminder_time) continue;
      const dayBefore = new Date(startMs - 864e5);
      fireAt = wallToMs(
        `${isoDate(dayBefore)}T${ev.all_day_reminder_time}`
      );
      if (!Number.isFinite(fireAt)) continue;
      if (fireAt > nowMs) {
        out.push(makeFire(rem, ev, fireAt, false));
      } else {
        const endMs2 = endMsFor(startMs + 864e5);
        if (endMs2 > nowMs) out.push(makeFire(rem, ev, fireAt, true));
      }
      continue;
    }
    fireAt = startMs - rem.minutes_before * 6e4;
    if (fireAt > nowMs) {
      out.push(makeFire(rem, ev, fireAt, false));
      continue;
    }
    if (rem.updated_hlc_ms != null && rem.updated_hlc_ms > fireAt) continue;
    const endMs = endMsFor(startMs + 36e5);
    if (endMs > nowMs) {
      const onTime = lastTickMs != null && lastTickMs < fireAt;
      out.push(makeFire(rem, ev, fireAt, !onTime));
    }
  }
  return out.sort((a, b) => a.fire_at_ms - b.fire_at_ms);
}
function makeFire(rem, ev, fireAtMs, missed) {
  return {
    key: `${rem.member_id}|${rem.entity_id}|${fireAtMs}`,
    member_id: rem.member_id,
    entity_id: rem.entity_id,
    title: ev.title,
    // pkg10 F4 (D6): all-day events have no meaningful time-of-day — label
    // the DAY, not a fabricated "00:00".
    event_start_label: ev.all_day === 1 ? ev.start_wall.replace("T", " ").slice(0, "YYYY-MM-DD".length) : ev.start_wall.replace("T", " "),
    fire_at_ms: fireAtMs,
    missed
  };
}
function wallToMs(wall) {
  const m = wall.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return NaN;
  return new Date(
    +m[1],
    +m[2] - 1,
    +m[3],
    +m[4],
    +m[5],
    0,
    0
  ).getTime();
}
function isoDate(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function filterDelivered(schedule, delivered) {
  return schedule.filter((f) => !delivered.has(f.key));
}
function markDelivered(delivered, fires) {
  for (const f of fires) delivered.add(f.key);
}
function renderNotification(f) {
  return f.missed ? {
    summary: `Missed reminder: ${f.title}`,
    body: `Was due ${f.event_start_label}`
  } : {
    summary: f.title,
    body: `Starts ${f.event_start_label}`
  };
}

// src/application/notification_delivery.ts
import { spawn } from "node:child_process";
var deadStrategies = /* @__PURE__ */ new Set();
function argsFor(strategy, fire, summary, body) {
  switch (strategy) {
    case "notify-send":
      return [
        "--app-name=Tide",
        "--category=calendar",
        "--expire-time=10000",
        ...fire.missed ? ["--urgency=normal"] : [],
        summary,
        body
      ];
    case "gdbus":
      return [
        "call",
        "--session",
        "--dest",
        "org.freedesktop.Notifications",
        "--object-path",
        "/org/freedesktop/Notifications",
        "--method",
        "org.freedesktop.Notifications.Notify",
        "Tide",
        "0",
        "",
        summary,
        body,
        "[]",
        "{}",
        "10000"
      ];
    case "dbus-send":
      return [
        "--session",
        "--print-reply=literal",
        "--dest=org.freedesktop.Notifications",
        "/org/freedesktop/Notifications",
        "org.freedesktop.Notifications.Notify",
        "string:Tide",
        "uint32:0",
        "string:",
        `string:${summary}`,
        `string:${body}`,
        "array:string:",
        "dict:string:variant:",
        "int32:10000"
      ];
    default:
      return null;
  }
}
var STRATEGIES = ["notify-send", "gdbus", "dbus-send"];
function deliverNotification(fire, onResult) {
  const { summary, body } = renderNotification(fire);
  let settled = false;
  const settle = (ok) => {
    if (!settled) {
      settled = true;
      onResult(ok);
    }
  };
  const attempt = (index) => {
    if (index >= STRATEGIES.length) {
      console.error(
        "[tide] desktop notifications: ALL strategies failed this dispatch; reminder will retry on next rebuild (DC-22 \xA77.1)"
      );
      settle(false);
      return;
    }
    const strategy = STRATEGIES[index];
    if (deadStrategies.has(strategy)) {
      attempt(index + 1);
      return;
    }
    const args = argsFor(strategy, fire, summary, body);
    if (!args) {
      deadStrategies.add(strategy);
      attempt(index + 1);
      return;
    }
    console.log(`[tide] notify via ${strategy}`);
    try {
      const child = spawn(strategy, args, { stdio: "ignore" });
      child.on("error", (err2) => {
        deadStrategies.add(strategy);
        console.error(
          `[tide] notify strategy "${strategy}" unavailable (${err2.message}); falling back`
        );
        attempt(index + 1);
      });
      child.on("exit", (code) => {
        if (code === 0) {
          settle(true);
        } else {
          deadStrategies.add(strategy);
          console.error(
            `[tide] notify strategy "${strategy}" exited ${code ?? "signal"}; falling back`
          );
          attempt(index + 1);
        }
      });
      setTimeout(() => settle(false), 1e4).unref();
    } catch (err2) {
      deadStrategies.add(strategy);
      console.error(
        `[tide] notify strategy "${strategy}" spawn threw: ${err2 instanceof Error ? err2.message : String(err2)}`
      );
      attempt(index + 1);
    }
  };
  attempt(0);
}

// src/domain/recurrence_conflicts.ts
var DAY_NAMES = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];
var JS_DAY_TO_NAME = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
function parseRule(rule) {
  const parts = rule.split(";").map((p) => p.trim());
  let freq = "DAILY";
  let interval = 1;
  let byDay = [];
  let count = null;
  let until = null;
  for (const part of parts) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const key = part.slice(0, eq).toUpperCase();
    const value = part.slice(eq + 1).trim();
    switch (key) {
      case "FREQ": {
        const f = value.toUpperCase();
        if (f === "DAILY" || f === "WEEKLY" || f === "MONTHLY" || f === "YEARLY") freq = f;
        break;
      }
      case "INTERVAL":
        interval = Math.max(1, parseInt(value, 10) || 1);
        break;
      case "BYDAY":
        byDay = value.split(",").map((d) => d.trim().toUpperCase()).filter((d) => DAY_NAMES.includes(d));
        break;
      case "COUNT":
        count = Math.max(1, parseInt(value, 10) || 1);
        break;
      case "UNTIL":
        until = value.replace(/[-T:]/g, "").slice(0, 8);
        break;
    }
  }
  return { freq, interval, byDay, count, until };
}
function pad(n, width) {
  return String(n).padStart(width, "0");
}
function formatId(d) {
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1, 2)}${pad(d.getUTCDate(), 2)}T${pad(d.getUTCHours(), 2)}${pad(d.getUTCMinutes(), 2)}${pad(d.getUTCSeconds(), 2)}`;
}
function dateOnlyId(d) {
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1, 2)}${pad(d.getUTCDate(), 2)}`;
}
function expandOccurrences(series, windowStartId, windowEndId) {
  const rule = parseRule(series.recurrence_rule);
  const m = series.base_start_wall.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/
  );
  if (!m) throw new Error(`bad base_start_wall: ${series.base_start_wall}`);
  const base = new Date(
    Date.UTC(
      +m[1],
      +m[2] - 1,
      +m[3],
      +m[4],
      +m[5],
      m[6] ? +m[6] : 0
    )
  );
  const winLoDate = windowStartId.replace(/\D/g, "").slice(0, 8);
  const winHiDate = windowEndId.replace(/\D/g, "").slice(0, 8);
  const winLo = `${winLoDate}T000000`;
  const winHi = `${winHiDate}T235959`;
  const out = [];
  const hardCap = 1e4;
  const maxOccurrences = rule.count ?? hardCap;
  let generated = 0;
  const emit = (d) => {
    const id = formatId(d);
    generated++;
    if (id >= winLo && id <= winHi) out.push(id);
    return generated >= maxOccurrences;
  };
  const weekIndex = (d) => Math.floor((d.getTime() / 864e5 - 4) / 7);
  const baseWeek = weekIndex(base);
  const baseDayName = JS_DAY_TO_NAME[base.getUTCDay()];
  const baseMidnight = Date.UTC(
    base.getUTCFullYear(),
    base.getUTCMonth(),
    base.getUTCDate()
  );
  const baseTOD = base.getTime() - baseMidnight;
  if (rule.freq === "DAILY") {
    for (let step = 0; ; step += rule.interval) {
      const d = new Date(base.getTime() + step * 864e5);
      if (rule.until !== null && dateOnlyId(d) > rule.until) break;
      if (step > 0 && d.getTime() - base.getTime() > hardCap * 864e5) break;
      if (emit(d)) break;
    }
    return out;
  }
  if (rule.freq === "WEEKLY") {
    const days = rule.byDay.length > 0 ? rule.byDay : [baseDayName];
    const nameToOffset = {
      MO: 0,
      TU: 1,
      WE: 2,
      TH: 3,
      FR: 4,
      SA: 5,
      SU: 6
    };
    const offsets = days.map((n) => nameToOffset[n]).filter((o) => o !== void 0).sort((a, b) => a - b);
    for (let w = 0; ; w += rule.interval) {
      const weekStart = new Date((4 + (baseWeek + w) * 7) * 864e5 + baseTOD);
      if (rule.until !== null) {
        if (dateOnlyId(weekStart) > rule.until) break;
      }
      if (weekStart.getTime() - base.getTime() > hardCap * 864e5) break;
      for (const off of offsets) {
        const d = new Date(weekStart.getTime() + off * 864e5);
        if (d.getTime() < base.getTime()) continue;
        if (rule.until !== null && dateOnlyId(d) > rule.until) break;
        if (emit(d)) return out;
      }
    }
    return out;
  }
  const dayOfMonth = base.getUTCDate();
  for (let mi = 0; ; mi += rule.interval) {
    const d = new Date(
      Date.UTC(
        base.getUTCFullYear(),
        base.getUTCMonth() + mi,
        1,
        base.getUTCHours(),
        base.getUTCMinutes(),
        base.getUTCSeconds()
      )
    );
    d.setUTCDate(dayOfMonth);
    if (d.getUTCDate() !== dayOfMonth) continue;
    if (rule.until !== null && dateOnlyId(d) > rule.until) break;
    if (mi > hardCap * rule.interval) break;
    if (emit(d)) break;
  }
  if (rule.freq === "YEARLY") {
    for (let yi = 0; ; yi += rule.interval) {
      const d = new Date(
        Date.UTC(
          base.getUTCFullYear() + yi,
          base.getUTCMonth(),
          1,
          base.getUTCHours(),
          base.getUTCMinutes(),
          base.getUTCSeconds()
        )
      );
      d.setUTCDate(base.getUTCDate());
      if (d.getUTCDate() !== base.getUTCDate()) continue;
      if (rule.until !== null && dateOnlyId(d) > rule.until) break;
      if (yi > hardCap * rule.interval) break;
      if (emit(d)) break;
    }
    return out;
  }
  return out;
}

// src/application/conflicts_ui.ts
var ConflictCommandError = class extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = "ConflictCommandError";
  }
  code;
};
function parseJson(s) {
  return JSON.parse(s);
}
function effectiveOf(row) {
  switch (row.operation) {
    case "set":
      return { deleted: false, value: parseJson(row.payload).value };
    case "member_add":
    case "member_update":
      return { deleted: false, value: parseJson(row.payload) };
    case "remove":
    case "member_remove":
      return { deleted: true, value: void 0 };
    default:
      return { deleted: false, value: parseJson(row.payload) };
  }
}
var ConflictsViewModel = class {
  constructor(db, selfDeviceId) {
    this.db = db;
    this.selfDeviceId = selfDeviceId;
  }
  db;
  selfDeviceId;
  /**
   * Conflict ids whose resolution change record has been PROVEN propagated
   * (DC-06 §4.2 knowledge machinery, wired by the caller). Undo is withheld
   * for these (P3 / TR-3).
   */
  propagated = /* @__PURE__ */ new Set();
  // ------------------------------------------------------------------
  // Badge layer (§3.1) — advisory counts, never gating anything
  // ------------------------------------------------------------------
  /** Unresolved-conflict count per entity id. */
  badgeCounts() {
    const rows = this.db.prepare(
      `SELECT entity_id, COUNT(*) AS c FROM conflicts
         WHERE status = 'unresolved' GROUP BY entity_id`
    ).all();
    return new Map(rows.map((r) => [r.entity_id, r.c]));
  }
  /** Optional global indicator total (§3.1). */
  totalUnresolved() {
    const row = this.db.prepare(
      "SELECT COUNT(*) AS c FROM conflicts WHERE status = 'unresolved'"
    ).get();
    return row?.c ?? 0;
  }
  // ------------------------------------------------------------------
  // List view (§5.2)
  // ------------------------------------------------------------------
  listUnresolved(filter = {}) {
    const clauses = ["c.status = 'unresolved'"];
    const params = {};
    if (filter.entity_id !== void 0) {
      clauses.push("c.entity_id = @entity_id");
      params.entity_id = filter.entity_id;
    }
    if (filter.calendar_id !== void 0) {
      clauses.push(
        `EXISTS (SELECT 1 FROM events e WHERE e.event_id = c.entity_id
                 AND e.calendar_id = @calendar_id)`
      );
      params.calendar_id = filter.calendar_id;
    }
    if (filter.utc_from_ms !== void 0 || filter.utc_to_ms !== void 0) {
      clauses.push(
        `EXISTS (SELECT 1 FROM events e WHERE e.event_id = c.entity_id
                 AND (@utc_from_ms IS NULL OR e.utc_start_ms >= @utc_from_ms)
                 AND (@utc_to_ms IS NULL OR e.utc_start_ms <= @utc_to_ms))`
      );
      params.utc_from_ms = filter.utc_from_ms ?? null;
      params.utc_to_ms = filter.utc_to_ms ?? null;
    }
    const rows = this.db.prepare(
      `SELECT c.conflict_id, c.entity_id, c.field_path, c.status,
                (SELECT COUNT(*) FROM conflict_participants p
                 WHERE p.conflict_id = c.conflict_id) AS participant_count
         FROM conflicts c WHERE ${clauses.join(" AND ")}
         ORDER BY c.detected_at_hlc`
    ).all(params);
    return rows.map((r) => ({ ...r }));
  }
  // ------------------------------------------------------------------
  // Presentation accessor: entity display title for list rows.
  // ------------------------------------------------------------------
  /** Display title of an affected event entity, or null when unknown. */
  entityTitle(entityId) {
    const row = this.db.prepare(
      "SELECT title FROM events WHERE event_id = ?"
    ).get(entityId);
    return row?.title ?? null;
  }
  // ------------------------------------------------------------------
  // Detail view (§3.2) — pure read, no detection run, no mutation
  // ------------------------------------------------------------------
  getDetail(conflictId) {
    const c = this.loadConflict(conflictId);
    if (c === void 0) {
      throw new ConflictCommandError("not_found", `no conflict ${conflictId}`);
    }
    const participants = this.loadParticipants(conflictId);
    const candidates = [];
    let localChangeId = null;
    for (const p of participants) {
      const change = this.db.prepare(
        "SELECT operation FROM changes WHERE change_id = ?"
      ).get(p.change_id);
      const eff = change !== void 0 ? effectiveOf({ operation: change.operation, payload: p.payload }) : { deleted: false, value: parseJson(p.payload) };
      if (p.device_id === this.selfDeviceId) localChangeId = p.change_id;
      candidates.push({
        change_id: p.change_id,
        device_id: p.device_id,
        device_name: this.deviceName(p.device_id),
        deleted: eff.deleted,
        value: eff.value,
        hlc_timestamp: this.changeHlc(p.change_id)
      });
    }
    const titleRow = this.db.prepare(
      "SELECT title FROM events WHERE event_id = ?"
    ).get(c.entity_id);
    return {
      conflict_id: conflictId,
      entity_id: c.entity_id,
      entity_title: titleRow?.title ?? null,
      field_path: c.field_path,
      status: c.status,
      candidates,
      local_change_id: localChangeId,
      ...c.status === "resolved_custom" && c.resolved_value !== null ? { resolved_value: parseJson(c.resolved_value) } : {},
      ...c.resolved_at_hlc !== null && c.resolved_at_hlc !== void 0 ? { resolved_at_hlc: c.resolved_at_hlc } : {}
    };
  }
  /** Is undo currently offered for this conflict? (P3) */
  undoAvailable(conflictId) {
    const c = this.loadConflict(conflictId);
    return c !== void 0 && c.status.startsWith("resolved_") && !this.propagated.has(conflictId);
  }
  /** Caller invokes after DC-06 §4.2 propagation proof for this resolution. */
  markPropagated(conflictId) {
    this.propagated.add(conflictId);
  }
  // ------------------------------------------------------------------
  // Commands (§4 / §6.1)
  // ------------------------------------------------------------------
  /**
   * Resolve one conflict. ONE transaction writes BOTH the winning-value
   * normal change record (fresh local_seq + clock entry, via standard T1)
   * AND the status flip with resolved_at_hlc (TR-1). Returns the new
   * change record.
   */
  resolve(conflictId, option) {
    const c = this.loadConflict(conflictId);
    if (c === void 0) {
      throw new ConflictCommandError("not_found", `no conflict ${conflictId}`);
    }
    if (c.status !== "unresolved") {
      throw new ConflictCommandError(
        "not_unresolved",
        `conflict already ${c.status}`
      );
    }
    let status;
    let win;
    switch (option.kind) {
      case "keep_mine": {
        const local = this.localParticipant(conflictId);
        status = "resolved_keep_local";
        win = this.effectiveOfParticipant(local);
        break;
      }
      case "keep_theirs": {
        const locals = this.participantsOf(conflictId).filter(
          (p) => p.device_id === this.selfDeviceId
        );
        const nonLocal = this.participantsOf(conflictId).filter(
          (p) => p.device_id !== this.selfDeviceId
        );
        let pick = nonLocal[0];
        if (option.change_id !== void 0) {
          pick = nonLocal.find((p) => p.change_id === option.change_id);
          if (pick === void 0) {
            throw new ConflictCommandError(
              "unknown_candidate",
              `change_id ${option.change_id} is not an incoming participant`
            );
          }
        } else if (nonLocal.length !== 1) {
          throw new ConflictCommandError(
            "unknown_candidate",
            "N-way conflict requires an explicit change_id for keep_theirs"
          );
        }
        void locals;
        status = "resolved_keep_incoming";
        win = this.effectiveOfParticipant(pick);
        break;
      }
      case "keep_both": {
        status = "resolved_custom";
        win = { deleted: false, value: option.value };
        break;
      }
    }
    let record;
    const tx = this.db.transaction(() => {
      record = createLocalChange(this.db, this.selfDeviceId, {
        entity_id: c.entity_id,
        entity_type: "event",
        field_path: c.field_path,
        operation: win.deleted ? "remove" : "set",
        payload: win.deleted ? {} : { value: win.value },
        hlc_now: () => Date.now()
      });
      this.db.prepare(
        `UPDATE conflicts SET status = ?, resolved_value = ?,
           resolved_at_hlc = ? WHERE conflict_id = ?`
      ).run(
        status,
        status === "resolved_custom" ? JSON.stringify(win.value) : null,
        Date.now(),
        conflictId
      );
    });
    tx();
    return record;
  }
  /** §4 "Skip / decide later": a strict NO-OP (TR-2). Returns nothing. */
  skip(_conflictId) {
  }
  /**
   * §6.2 UNDO: another normal change record restoring the prior effective
   * value, plus status back to "unresolved", in one transaction. History is
   * append-only — no rows are updated or deleted in `changes`. Withheld
   * after a propagation proof (P3 / TR-3).
   */
  undo(conflictId) {
    const c = this.loadConflict(conflictId);
    if (c === void 0) {
      throw new ConflictCommandError("not_found", `no conflict ${conflictId}`);
    }
    if (!c.status.startsWith("resolved_")) {
      throw new ConflictCommandError(
        "not_unresolved",
        `cannot undo status ${c.status}`
      );
    }
    if (this.propagated.has(conflictId)) {
      throw new ConflictCommandError(
        "undo_withheld_propagated",
        "resolution already propagated \u2014 make a new edit instead (P3)"
      );
    }
    const prior = this.effectiveOfParticipant(
      this.localParticipant(conflictId)
    );
    let record;
    const tx = this.db.transaction(() => {
      record = createLocalChange(this.db, this.selfDeviceId, {
        entity_id: c.entity_id,
        entity_type: "event",
        field_path: c.field_path,
        operation: prior.deleted ? "remove" : "set",
        payload: prior.deleted ? {} : { value: prior.value },
        hlc_now: () => Date.now()
      });
      this.db.prepare(
        `UPDATE conflicts SET status = 'unresolved', resolved_value = NULL,
           resolved_at_hlc = NULL WHERE conflict_id = ?`
      ).run(conflictId);
    });
    tx();
    this.propagated.delete(conflictId);
    return record;
  }
  /**
   * §5.3 bulk = N SEQUENTIAL INDIVIDUALS through the identical write path.
   * A failure mid-bulk leaves completed items resolved and the rest
   * untouched (each individually consistent, TR-7).
   */
  resolveBulk(decisions) {
    for (const d of decisions) this.resolve(d.conflictId, d.option);
  }
  // ------------------------------------------------------------------
  // §6.3 / §6.4 remote-resolution intake (sync-driven transitions)
  // ------------------------------------------------------------------
  exportResolution(conflictId) {
    const c = this.loadConflict(conflictId);
    if (c === void 0 || !c.status.startsWith("resolved_")) return null;
    return {
      entity_id: c.entity_id,
      field_path: c.field_path,
      status: c.status,
      ...c.resolved_value !== null ? { resolved_value: parseJson(c.resolved_value) } : {},
      participant_change_ids: this.participantsOf(conflictId).map(
        (p) => p.change_id
      )
    };
  }
  exportType = "RESOLVED_CONFLICT";
  /**
   * DC-14 §6.3 RESOLVED-ON-RECEIPT dedup rule. Receiving a resolution NEVER
   * mutates entity data here (the value travels via CHANGES_BATCH, §6.3).
   *
   *   - matching unresolved copy (same conflict entity + participant set):
     *     mark resolved with the arrived outcome (suppress re-prompting);
     *   - local copy already resolved: stale arrival is RECORDED but does
     *     NOT overwrite local status/value (§6.4 v1 first-by-arrival);
     *   - participants don't match: separate local variant — untouched.
   */
  applyRemoteResolution(remote) {
    if (!remote.status.startsWith("resolved_")) {
      throw new Error("applyRemoteResolution requires a resolved_* status");
    }
    const want = [...remote.participant_change_ids].sort().join("\0");
    const rows = this.db.prepare(
      `SELECT c.conflict_id AS conflict_id, c.status AS status,
                (SELECT GROUP_CONCAT(change_id, ',') FROM conflict_participants p
                 WHERE p.conflict_id = c.conflict_id) AS ids
         FROM conflicts c WHERE c.entity_id = ? AND c.field_path = ?`
    ).all(remote.entity_id, remote.field_path);
    const match = rows.find(
      (r) => r.ids !== null && [...r.ids.split(",")].sort().join("\0") === want
    );
    if (match === void 0) return "no_match";
    if (match.status !== "unresolved") return "recorded_stale";
    const tx = this.db.transaction(() => {
      this.db.prepare(
        `UPDATE conflicts SET status = ?, resolved_value = ?,
           resolved_at_hlc = ? WHERE conflict_id = ?`
      ).run(
        remote.status,
        remote.resolved_value !== void 0 ? JSON.stringify(remote.resolved_value) : null,
        Date.now(),
        match.conflict_id
      );
    });
    tx();
    return "resolved_on_receipt";
  }
  // ------------------------------------------------------------------
  // §7.1 obsolete closure on parent-entity tombstone
  // ------------------------------------------------------------------
  /**
   * Called when entity `entityId` is tombstoned: flips its unresolved
   * conflicts to the TERMINAL device-local state "obsolete" (never a
   * resolved_* value — no choice was made). Retained and explainable via
   * the tombstone reference. Terminal: subsequent resolve() calls refuse.
   */
  closeObsoleteOnTombstone(entityId, tombstoneRef) {
    const tx = this.db.transaction(() => {
      const info = this.db.prepare(
        `UPDATE conflicts SET status = 'obsolete', resolved_value = ?
           WHERE entity_id = ? AND status = 'unresolved'`
      ).run(
        JSON.stringify({ closed_obsolete_by_tombstone: tombstoneRef }),
        entityId
      );
      return info.changes;
    });
    return tx();
  }
  // ------------------------------------------------------------------
  // internals
  // ------------------------------------------------------------------
  loadConflict(conflictId) {
    return this.db.prepare(
      `SELECT conflict_id, entity_id, field_path, status, resolved_value,
                resolved_at_hlc FROM conflicts WHERE conflict_id = ?`
    ).get(conflictId);
  }
  participantsOf(conflictId) {
    return this.db.prepare(
      `SELECT change_id, device_id, local_seq, causality_clock, payload
         FROM conflict_participants WHERE conflict_id = ?
         ORDER BY (device_id = ?) DESC, change_id`
    ).all(conflictId, this.selfDeviceId);
  }
  loadParticipants(conflictId) {
    return this.participantsOf(conflictId);
  }
  /** §4 "local current value" — the participant produced by THIS device. */
  localParticipant(conflictId) {
    const mine = this.participantsOf(conflictId).find(
      (p) => p.device_id === this.selfDeviceId
    );
    if (mine === void 0) {
      throw new ConflictCommandError(
        "no_local_participant",
        "keep_mine/undo require a locally produced participant (\xA74)"
      );
    }
    return mine;
  }
  effectiveOfParticipant(p) {
    const change = this.db.prepare(
      "SELECT operation FROM changes WHERE change_id = ?"
    ).get(p.change_id);
    if (change !== void 0) {
      return effectiveOf({ operation: change.operation, payload: p.payload });
    }
    const parsed = parseJson(p.payload);
    const deleted = parsed === null || typeof parsed !== "object" || Object.keys(parsed).length === 0;
    return { deleted, value: deleted ? void 0 : parsed };
  }
  changeHlc(changeId2) {
    const row = this.db.prepare(
      "SELECT hlc_timestamp FROM changes WHERE change_id = ?"
    ).get(changeId2);
    return row?.hlc_timestamp ?? 0;
  }
  /** §3.2b device attribution through paired-device display names. */
  deviceName(deviceId) {
    if (deviceId === this.selfDeviceId) return "This device";
    const row = this.db.prepare(
      "SELECT display_name FROM peers WHERE device_id = ?"
    ).get(deviceId);
    return row?.display_name ?? deviceId;
  }
};

// src/persistence/bridges/sidecar_server.ts
function msFromWallId(id) {
  const digits = id.replace(/\D/g, "");
  const y = +digits.slice(0, 4);
  const mo = +digits.slice(4, 6);
  const dd = +digits.slice(6, 8);
  const hh = +digits.slice(8, 10) || 0;
  const mi = +digits.slice(10, 12) || 0;
  const ss = +digits.slice(12, 14) || 0;
  return new Date(y, mo - 1, dd, hh, mi, ss, 0).getTime();
}
var SyncManager = class {
  constructor(core, identity, dataDir) {
    this.core = core;
    this.identity = identity ?? loadOrCreateIdentity(
      dataDir ?? core.dbPath.replace(/[/\\][^/\\]+$/, "") ?? "."
    );
  }
  core;
  identity;
  /**
   * TD-006 / DC-16: process-wide Tier-1 tracker, shared by every engine
   * session this sidecar runs, so ladder state persists across sessions.
   * In-memory ONLY — a sidecar restart fails OPEN back to Level 0 (§2.3).
   */
  misbehavior = new PeerMisbehaviorTracker();
  host = null;
  get deviceId() {
    return this.identity.deviceId;
  }
  /** The port this sidecar will listen on (requested, if binding pending). */
  resolvedPort(requested) {
    return requested ?? (process.env.TIDE_SYNC_PORT ? Number(process.env.TIDE_SYNC_PORT) : SYNC_DEFAULT_PORT);
  }
  ensureListener(port) {
    if (!this.host) {
      void serveSync(
        this.identity.privateKey,
        this.resolvedPort(port),
        (session) => this.onInbound(session)
      ).then(
        (h2) => {
          this.host = h2;
        },
        (err2) => {
          console.error(
            `[tide] sync listener failed to start on port ${this.resolvedPort(port)}:`,
            err2 instanceof Error ? err2.message : err2
          );
          console.error(
            "[tide] sync inbound connections are unavailable until the port frees up; the calendar itself is unaffected."
          );
        }
      );
      return this.resolvedPort();
    }
    return this.host.actualPort;
  }
  /**
   * Close the sync listener (if any). Called on stdin EOF: the parent GUI
   * is gone, so nothing can ever drain this listener again. NOTE: this
   * stops new accepts and drops the listen handle, but established peer
   * sockets and a pending pairing-offer listener (pairing_manager's own
   * serveSync host) are NOT touched — the process.exit(0) in the stdin
   * close handler is what guarantees teardown. Without that exit this
   * method alone would not drain the loop.
   * (investigation: docs/proposals/sidecar-orphan-investigation.md)
   */
  closeListener() {
    this.host?.close();
    this.host = null;
    this.cancelPendingOffer("sidecar listener shutdown");
  }
  /**
   * Registry of the current pending pairing offer (one at a time — creating
   * a new offer supersedes the previous one, matching the Devices UI flow).
   * Tracked so stdin-EOF shutdown and explicit cancel_pairing_offer can
   * close its listener. The stored promise is already caught by the
   * dispatcher; cancel() rejects it with a benign error.
   */
  pendingOffer = null;
  trackPairingOffer(offer) {
    this.cancelPendingOffer("superseded by a newer pairing offer");
    this.pendingOffer = offer;
  }
  cancelPendingOffer(_reason) {
    const offer = this.pendingOffer;
    this.pendingOffer = null;
    if (!offer) return;
    try {
      offer.cancel();
    } catch {
    }
  }
  /** True when `offer` is the currently tracked pending offer. */
  hasPendingOffer(offer) {
    return this.pendingOffer === offer;
  }
  /** Drop the tracking entry without cancelling (ceremony completed). */
  untrackPairingOffer(offer) {
    if (this.pendingOffer === offer) this.pendingOffer = null;
  }
  /**
   * Run a sync engine session over an authenticated channel.
   *
   * DC-21 D3 (owner amendment, binding): BEFORE any session result is
   * trusted, the handshake's remote static key is verified against the trust
   * store row for `expectedDeviceId` (when the caller attributes the dial to
   * a paired peer — scheduler path). A mismatch throws BEFORE runSession, so
   * nothing is exchanged and nothing is persisted (DC-11 §4.6 silent drop).
   */
  async runEngineSession(session, expectedDeviceId) {
    const remoteKeyBuf = Buffer.from(session.raw.remoteStaticKey());
    try {
      if (expectedDeviceId !== void 0) {
        const row = this.core.db.prepare(
          "SELECT public_key FROM peers WHERE device_id = ? AND status = 'trusted'"
        ).get(expectedDeviceId);
        const remoteX25519Hex = remoteKeyBuf.toString("hex");
        const trustedX25519Hex = row ? Buffer.from(
          ed25519ToX25519PublicKey(new Uint8Array(row.public_key))
        ).toString("hex") : null;
        if (row === void 0 || trustedX25519Hex !== remoteX25519Hex) {
          throw new Error(
            `DC-21 D3 identity mismatch: endpoint attributed to ${expectedDeviceId} presented remote static key ${remoteX25519Hex.slice(0, 16)}\u2026 \u2014 session aborted, endpoint NOT persisted (DC-11 \xA74.6 silent drop)`
          );
        }
      }
      const engine = createSyncEngine({
        db: this.core.db,
        selfDeviceId: this.identity.deviceId,
        mutateEntity: makeEntityMutator(),
        misbehavior: this.misbehavior
      });
      let stats;
      try {
        stats = await engine.runSession(session.transport);
      } finally {
        session.done();
      }
      const remoteDeviceId = expectedDeviceId ?? this.resolveDeviceIdByRemoteKey(remoteKeyBuf);
      if (remoteDeviceId !== void 0 && session.dialEndpoint !== void 0) {
        recordPeerEndpoint(
          this.core.db,
          remoteDeviceId,
          session.dialEndpoint.host,
          session.dialEndpoint.port,
          Date.now()
        );
      }
      return {
        ...stats,
        remote_device_id: remoteDeviceId ?? "unknown"
      };
    } catch (err2) {
      session.done();
      throw err2;
    }
  }
  /**
   * DC-21 D3/D6: inbound sessions have no expectedDeviceId (the peer dialed
   * us); resolve identity by matching the handshake's remote static key
   * against the trust store. Unmatched keys return undefined — the session
   * stats still return (the engine already ran; the data flow was
   * authenticated by Noise against SOME paired key or rejected), but no
   * endpoint is recorded.
   */
  resolveDeviceIdByRemoteKey(remoteKeyBuf) {
    const rows = this.core.db.prepare("SELECT device_id, public_key FROM peers WHERE status = 'trusted'").all();
    const remoteHex = remoteKeyBuf.toString("hex");
    for (const row of rows) {
      const x255192 = Buffer.from(
        ed25519ToX25519PublicKey(new Uint8Array(row.public_key))
      );
      if (x255192.toString("hex") === remoteHex) return row.device_id;
    }
    return void 0;
  }
  onInbound(session) {
    void this.runEngineSession(session).catch(() => {
    });
  }
  // ------------------------------------------------------------------
  // TD-006 / DC-16 §4: peer-state visibility + explicit recovery actions
  // ------------------------------------------------------------------
  /**
   * Per-peer misbehavior state for the UI (Sync-Errors badge + Paired
   * Devices). Merge of: paired peers, live Tier-1 ladder state, Tier-2
   * durable hard blocks, and the §2.3 durable invalid tally (history).
   */
  peerStateSnapshot() {
    const peers = listTrustedPeers(this.core.db);
    const blocks = new Map(listHardBlocks(this.core.db).map((b) => [b.producer_device_id, b]));
    const tally = new Map(
      listPeerInvalidTally(this.core.db).map((t) => [t.producer_device_id, t])
    );
    const known = /* @__PURE__ */ new Set([
      ...peers.map((p) => p.device_id),
      ...this.misbehavior.knownPeers(),
      ...blocks.keys(),
      ...tally.keys()
    ]);
    const out = [];
    for (const id of Array.from(known).sort()) {
      const paired = peers.some((p) => p.device_id === id);
      const peer = peers.find((p) => p.device_id === id);
      const t1 = this.misbehavior.getState(id);
      const b = blocks.get(id) ?? null;
      const tl = tally.get(id) ?? null;
      out.push({
        ...t1,
        paired,
        display_name: peer?.display_name ?? null,
        paired_at: peer ? peer.paired_at * 1e3 : null,
        ladder_label: LADDER_LABELS[t1.level],
        hard_block: b ? {
          first_triggered_at: b.first_triggered_at,
          last_triggered_at: b.last_triggered_at,
          trigger_count: b.trigger_count
        } : null,
        tally: tl ? { total_invalid: tl.total_invalid, last_invalid_at: tl.last_invalid_at } : null
      });
    }
    return out;
  }
  /** §4.2 Tier-1 manual override: one click, back to Level 0 immediately. */
  resetPeerState(deviceId) {
    this.misbehavior.resetPeer(deviceId);
  }
  /**
   * §4.2 Tier-2 Unblock (the UI enforces the two-step confirmation; this is
   * the actual action). Clears the durable row and returns the peer to
   * Tier-1 Level 0 observation.
   */
  unblockPeer(deviceId) {
    const cleared = unhardBlockProducer(this.core.db, deviceId);
    this.misbehavior.resetPeer(deviceId);
    return cleared;
  }
};
var EVENT_INPUT_KEYS = /* @__PURE__ */ new Set([
  "title",
  "description",
  "startMs",
  "endMs",
  "allDay",
  // DC-12: optional RRULE on CREATE (makes the event a series base event).
  // Rejected on update_event — series rule edits go through update_series_rule.
  "recurrenceRule"
]);
var EVENT_INPUT_KEY_LIST = ["title", "description", "startMs", "endMs", "allDay"];
function fail(msg) {
  throw new Error(msg);
}
function validateEventInput(raw, op) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    fail(
      `${op}: input must be an object with fields title, description, startMs, endMs, allDay`
    );
  }
  const input = raw;
  if ("id" in input) {
    fail(
      `${op}: input.id is not accepted \u2014 event ids are assigned by the sidecar and are not client-settable (update_event targets the id in args.id); the request was rejected without any state change`
    );
  }
  const unknown = Object.keys(input).filter((k) => !EVENT_INPUT_KEYS.has(k));
  if (unknown.length > 0) {
    fail(
      `${op}: unknown input field(s): ${unknown.join(", ")} \u2014 allowed: title, description, startMs, endMs, allDay`
    );
  }
  const missing = EVENT_INPUT_KEY_LIST.filter((k) => !(k in input));
  if (missing.length > 0) {
    fail(
      `${op}: input is missing required field(s): ${missing.join(", ")} \u2014 the full event input (title, description, startMs, endMs, allDay) is required; partial updates are rejected without any state change`
    );
  }
  if (typeof input.title !== "string") {
    fail(`${op}: input.title must be a string`);
  }
  if (typeof input.description !== "string") {
    fail(`${op}: input.description must be a string`);
  }
  for (const k of ["startMs", "endMs"]) {
    if (typeof input[k] !== "number" || !Number.isFinite(input[k])) {
      fail(`${op}: input.${k} must be a finite number`);
    }
  }
  if (typeof input.allDay !== "boolean") {
    fail(`${op}: input.allDay must be a boolean`);
  }
  const clean2 = {
    title: input.title,
    description: input.description,
    startMs: input.startMs,
    endMs: input.endMs,
    allDay: input.allDay
  };
  if (input.recurrenceRule !== void 0) {
    if (op === "update_event") {
      fail(
        "update_event: input.recurrenceRule is not accepted \u2014 series rule edits go through update_series_rule (the rule is its own DC-12 \xA73 conflict entity)"
      );
    }
    if (typeof input.recurrenceRule !== "string") {
      fail("create_event: input.recurrenceRule must be a string");
    }
    clean2.recurrenceRule = validateRRule(input.recurrenceRule, op);
  }
  validateEventValues(clean2, op);
  return clean2;
}
function requireEventId(raw, op) {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    fail(`${op}: args.id must be a non-empty string`);
  }
  return raw;
}
function makeDispatcher(core, sync) {
  return (op, args) => {
    switch (op) {
      case "ping":
        return { pong: true, device_id: core.selfDeviceId };
      case "list_events": {
        const { from_ms: f, to_ms: t } = args;
        for (const [k, v] of [
          ["from_ms", f],
          ["to_ms", t]
        ]) {
          if (v !== void 0 && v !== null && typeof v !== "number") {
            fail(`list_events: args.${k} must be a number or null`);
          }
        }
        return core.listEvents({
          fromMs: f ?? null,
          toMs: t ?? null
        });
      }
      case "create_event":
        return core.createEvent(validateEventInput(args.input, "create_event"));
      case "update_event": {
        const id = requireEventId(args.id, "update_event");
        return core.updateEvent(id, validateEventInput(args.input, "update_event"));
      }
      case "delete_event":
        core.deleteEvent(requireEventId(args.id, "delete_event"));
        return null;
      // Pkg6 (BND-06 allow-list drift): read-only series listing. The op was
      // in lib.rs sync_op's ALLOWED list but unimplemented here (fell through
      // to `unknown op`). Grep evidence (pkg6-report §3): frontend/store.ts
      // listSeries() invokes "list_series" on the desktop path — removal from
      // the allow-list would have permanently disabled the recurrence
      // indicator decoration (the store tolerates absence, but wiring the
      // trivially-listable read restores the intended feature). EventCore
      // listSeries() is a pure SELECT over series + occurrence_overrides
      // (DC-12 §2) — no change records, no mutation, no args.
      case "list_series":
        return core.listSeries();
      // DC-22: reminder member write path (dialog "Remind me" checkbox).
      // Replicates as reminder member_add/update/remove (D5).
      case "get_reminder": {
        if (typeof args.event_id !== "string") fail("get_reminder: args.event_id required");
        return core.reminderFor(args.event_id);
      }
      case "set_reminder": {
        if (typeof args.event_id !== "string") fail("set_reminder: args.event_id required");
        if (typeof args.minutes_before !== "number" || !Number.isInteger(args.minutes_before) || args.minutes_before < 0) {
          fail("set_reminder: args.minutes_before must be a non-negative integer");
        }
        if (typeof args.enabled !== "boolean") fail("set_reminder: args.enabled must be a boolean");
        core.setReminder(args.event_id, {
          minutesBefore: args.minutes_before,
          enabled: args.enabled
        });
        return { set: true };
      }
      case "clear_reminder": {
        if (typeof args.event_id !== "string") fail("clear_reminder: args.event_id required");
        core.clearReminder(args.event_id);
        return { cleared: true };
      }
      // --- DC-12 §2.1/§3: series write paths. The rule is its own conflict
      // entity (series_id, "recurrence_rule"); occurrence overrides are
      // keyed (series_id, recurrence_id) with per-field DC-03 entities
      // "overrides.<rid>.<field>" (§2.2). Deterministic ok:false on any
      // validation failure; a rejected request never mutates state.
      case "update_series_rule": {
        if (typeof args.series_id !== "string" || args.series_id.length === 0) {
          fail("update_series_rule: args.series_id must be a non-empty string");
        }
        if (typeof args.rule !== "string") {
          fail("update_series_rule: args.rule must be a string (RFC 5545 RRULE)");
        }
        return core.updateSeriesRule(args.series_id, args.rule);
      }
      case "update_occurrence": {
        if (typeof args.series_id !== "string" || args.series_id.length === 0) {
          fail("update_occurrence: args.series_id must be a non-empty string");
        }
        const rid = validateRecurrenceId(args.recurrence_id, "update_occurrence");
        const rawPatch = args.patch;
        if (rawPatch === null || typeof rawPatch !== "object" || Array.isArray(rawPatch)) {
          fail("update_occurrence: args.patch must be an object");
        }
        const patch = rawPatch;
        const unknown = Object.keys(patch).filter(
          (k) => !OVERRIDE_FIELDS.includes(k)
        );
        if (unknown.length > 0) {
          fail(
            `update_occurrence: unknown patch field(s): ${unknown.join(", ")} \u2014 allowed: ${OVERRIDE_FIELDS.join(", ")}`
          );
        }
        if (Object.keys(patch).length === 0) {
          fail("update_occurrence: args.patch must set at least one field");
        }
        const clean2 = {};
        if (patch.cancelled !== void 0) {
          if (typeof patch.cancelled !== "boolean") {
            fail("update_occurrence: patch.cancelled must be a boolean");
          }
          clean2.cancelled = patch.cancelled;
        }
        for (const k of ["title", "start_wall", "end_wall", "tz_id"]) {
          const v = patch[k];
          if (v === void 0) continue;
          if (typeof v !== "string" || v.trim().length === 0) {
            fail(`update_occurrence: patch.${k} must be a non-empty string`);
          }
          clean2[k] = v;
        }
        return core.updateOccurrence(args.series_id, rid, clean2);
      }
      // --- Pkg5 (QA M-2): read-only Conflicts surface (DC-14 §3.1/§3.2/§5).
      // Delegates to ConflictsViewModel so response shapes are the exact
      // ConflictListItem / ConflictDetailView the frontend bridge consumes.
      // Deliberately READ-ONLY: resolve/skip are DC-14 §4.3 explicit user
      // actions and are NOT exposed over RPC in this package (the shell
      // bridge injection per frontend/conflicts.ts TODO(backend) is the
      // separate write-path work item).
      case "list_conflicts": {
        const vm = new ConflictsViewModel(core.db, core.selfDeviceId);
        const filter = {};
        if (args.entity_id !== void 0 && (typeof args.entity_id !== "string" || args.entity_id.length === 0)) {
          fail("list_conflicts: args.entity_id must be a non-empty string");
        }
        if (typeof args.entity_id === "string" && args.entity_id.length > 0) {
          filter.entity_id = args.entity_id;
        }
        return {
          total_unresolved: vm.totalUnresolved(),
          conflicts: vm.listUnresolved(filter)
        };
      }
      case "conflict_detail": {
        if (typeof args.conflict_id !== "string" || args.conflict_id.length === 0) {
          fail("conflict_detail: args.conflict_id must be a non-empty string");
        }
        const vm = new ConflictsViewModel(core.db, core.selfDeviceId);
        return vm.getDetail(args.conflict_id);
      }
      // --- DC-14 §4.3 write path: resolve / skip over RPC. Both delegate to
      // ConflictsViewModel commands so the write transaction (winning-value
      // change record + status flip, §6.1) and the TR-2 skip no-op live in
      // exactly one place (the application layer).
      case "resolve_conflict": {
        if (typeof args.conflict_id !== "string" || args.conflict_id.length === 0) {
          fail("resolve_conflict: args.conflict_id must be a non-empty string");
        }
        const raw = args.option;
        if (raw === null || typeof raw !== "object") {
          fail("resolve_conflict: args.option must be an object");
        }
        let option;
        switch (raw.kind) {
          case "keep_mine":
            option = { kind: "keep_mine" };
            break;
          case "keep_theirs":
            if (raw.change_id !== void 0 && (typeof raw.change_id !== "string" || raw.change_id.length === 0)) {
              fail(
                "resolve_conflict: args.option.change_id must be a non-empty string"
              );
            }
            option = raw.change_id === void 0 ? { kind: "keep_theirs" } : { kind: "keep_theirs", change_id: raw.change_id };
            break;
          case "keep_both":
          case "resolved_custom":
            if (!("value" in raw)) {
              fail("resolve_conflict: args.option.value is required");
            }
            option = { kind: "keep_both", value: raw.value };
            break;
          default:
            fail(
              'resolve_conflict: args.option.kind must be "keep_mine" | "keep_theirs" | "resolved_custom"'
            );
        }
        const vm = new ConflictsViewModel(core.db, core.selfDeviceId);
        return vm.resolve(args.conflict_id, option);
      }
      case "skip_conflict": {
        if (typeof args.conflict_id !== "string" || args.conflict_id.length === 0) {
          fail("skip_conflict: args.conflict_id must be a non-empty string");
        }
        const vm = new ConflictsViewModel(core.db, core.selfDeviceId);
        vm.skip(args.conflict_id);
        return null;
      }
      default:
        throw new Error(`unknown op: ${op}`);
    }
  };
}
var SYNC_CONNECT_TIMEOUT_MS = (() => {
  const raw = process.env.TIDE_SYNC_CONNECT_TIMEOUT_MS;
  const n = raw !== void 0 ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 15e3;
})();
function withTimeout(p, ms, message) {
  let timer;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return (async () => {
    try {
      return await Promise.race([p, guard]);
    } finally {
      clearTimeout(timer);
      void p.catch(() => {
      });
    }
  })();
}
function makeSyncDispatcher(sync, core) {
  return (op, args) => {
    switch (op) {
      case "device_info": {
        const peers = listTrustedPeers(core.db);
        return {
          device_id: sync.identity.deviceId,
          paired_peers: peers.map((p) => ({
            device_id: p.device_id,
            display_name: p.display_name,
            paired_at: p.paired_at * 1e3
          })),
          // DC-21 §3.4/D4: the shell registers mDNS on this port (and
          // re-registers goodbye-first on change).
          listening_port: sync.ensureListener()
        };
      }
      case "pairing_offer": {
        const offerPromise = createPairingOffer({
          identity: sync.identity,
          port: typeof args.port === "number" ? args.port : void 0,
          name: typeof args.name === "string" ? args.name : sync.identity.deviceId.slice(0, 12),
          store: sqlPeerStore(core.db)
        });
        void offerPromise.then((o) => {
          sync.trackPairingOffer(o);
          o.result.catch(() => {
          }).finally(() => {
            if (sync.hasPendingOffer(o)) sync.untrackPairingOffer(o);
          });
          return o;
        }).catch(() => {
        });
        return offerPromise.then((o) => ({ qr_text: o.qrText }));
      }
      case "cancel_pairing_offer": {
        sync.cancelPendingOffer("user cancel");
        return { cancelled: true };
      }
      case "pairing_accept": {
        if (typeof args.qr_text !== "string")
          throw new Error("qr_text required");
        return acceptPairingPayload({
          identity: sync.identity,
          qr_text_text: void 0,
          qrText: args.qr_text,
          name: typeof args.name === "string" ? args.name : void 0,
          store: sqlPeerStore(core.db)
        }).then((r) => ({
          peer_device_id: r.peerDeviceId,
          safety_number: r.safetyNumber
        }));
      }
      case "sync_now": {
        if (typeof args.host !== "string" || typeof args.port !== "number") {
          throw new Error("host and port required");
        }
        return (async () => {
          const session = await withTimeout(
            connectSync(
              sync.identity.privateKey,
              args.host,
              args.port
            ),
            SYNC_CONNECT_TIMEOUT_MS,
            `sync connect timed out waiting for peer ${args.host}:${args.port} (no TCP connect / Noise handshake within ${SYNC_CONNECT_TIMEOUT_MS}ms)`
          );
          return sync.runEngineSession(session);
        })();
      }
      // TD-001 §2 Option A "Sync Errors": read-only quarantine listing for
      // the UI badge + dialog. No retry/delete surface exists by design.
      case "list_quarantine": {
        const limit = typeof args.limit === "number" && args.limit > 0 ? Math.floor(args.limit) : void 0;
        return {
          rows: listQuarantine(core.db, { limit }),
          total: countQuarantined(core.db)
        };
      }
      // TD-005: active/resolved/total counts for the Sync-Errors badge
      // (badge counts ACTIVE only; resolved rows are archived diagnostics).
      case "quarantine_stats": {
        return listQuarantineStats(core.db);
      }
      // TD-005 remainder: per-item Retry — runs the single record through
      // the SAME revalidation apply path used at restart. Idempotent; safe
      // against concurrent restart (both paths are transactional and
      // dedupe on the changes UNIQUE key). Prune afterwards so the
      // resolved-row retention cap holds after each new resolution.
      case "retry_quarantine": {
        if (typeof args.quarantine_id !== "number" || !Number.isInteger(args.quarantine_id)) {
          throw new Error("quarantine_id required");
        }
        const result = retryQuarantineRecord(
          core.db,
          args.quarantine_id,
          makeEntityMutator()
        );
        pruneResolvedQuarantine(core.db);
        return result;
      }
      // TD-005 remainder: per-item Delete (give up on record). Requires the
      // explicit confirm flag (defense-in-depth behind the UI's two-step
      // confirmation, DC-15 §3.5). Retains the row with
      // resolved_reason='user_deleted' and guarantees the skipped_seqs
      // entry exists so the stream stays unblocked.
      case "delete_quarantine": {
        if (typeof args.quarantine_id !== "number" || !Number.isInteger(args.quarantine_id)) {
          throw new Error("quarantine_id required");
        }
        const result = deleteQuarantineByUser(core.db, args.quarantine_id, {
          confirm: args.confirm === true
        });
        pruneResolvedQuarantine(core.db);
        return result;
      }
      // --- TD-006 / DC-16 §4: peer misbehavior visibility + recovery ------
      // Read-only per-peer state (Sync-Errors badge section + Paired Devices).
      case "peer_state": {
        return { peers: sync.peerStateSnapshot() };
      }
      // O4 Paired Devices list: identity id, display name, paired-since,
      // last-seen (null: not tracked), Tier-1 + Tier-2 state per device.
      case "list_paired_devices": {
        return {
          self_device_id: sync.identity.deviceId,
          devices: sync.peerStateSnapshot().filter((p) => p.paired)
        };
      }
      // §4.2 Tier-1: "Reset peer state" — one click, no confirmation.
      case "reset_peer_state": {
        if (typeof args.device_id !== "string" || args.device_id.length === 0) {
          throw new Error("device_id required");
        }
        sync.resetPeerState(args.device_id);
        return { ok: true };
      }
      // §4.2 Tier-2: "Unblock" — two-step confirmation lives in the UI;
      // this executes the cleared action and returns to Level 0.
      case "unblock_peer": {
        if (typeof args.device_id !== "string" || args.device_id.length === 0) {
          throw new Error("device_id required");
        }
        return { ok: true, cleared: sync.unblockPeer(args.device_id) };
      }
      default:
        throw new Error(`unknown op: ${op}`);
    }
  };
}
async function handleLine(dispatcher, line) {
  let response;
  try {
    const req = JSON.parse(line);
    if (req.id == null && typeof req.notification === "string") {
      if (req.notification === "mdns_event") {
        void dispatcher("mdns_event", req.args ?? {});
      }
      return "";
    }
    if (typeof req.op !== "string") throw new Error("missing op");
    try {
      response = {
        id: req.id ?? null,
        ok: true,
        result: await Promise.resolve(dispatcher(req.op, req.args ?? {}))
      };
    } catch (e) {
      response = {
        id: req.id ?? null,
        ok: false,
        error: e instanceof Error ? e.message : String(e)
      };
    }
  } catch (e) {
    response = {
      id: null,
      ok: false,
      error: `bad request line: ${e instanceof Error ? e.message : String(e)}`
    };
  }
  return JSON.stringify(response);
}
function main() {
  const dbPath = process.env.TIDE_DB_PATH;
  if (!dbPath) {
    console.error("tide-sidecar: TIDE_DB_PATH is required");
    process.exit(2);
  }
  const syncIdentity = loadOrCreateIdentity(
    process.env.TIDE_DATA_DIR ?? dbPath.replace(/[/\\][^/\\]+$/, "") ?? "."
  );
  const core = new EventCore(dbPath, syncIdentity.deviceId);
  const sync = new SyncManager(core, syncIdentity);
  const dispatch = makeDispatcher(core);
  const syncDispatch = makeSyncDispatcher(sync, core);
  let schedulerHandle = null;
  const combined = (op, args) => op === "update_settings" ? (() => {
    if (schedulerHandle === null) {
      throw new Error("scheduler runtime not started");
    }
    const partial = {};
    for (const key of [
      "sync_debounce_seconds",
      "sweep_interval_minutes",
      "max_concurrent_sessions"
    ]) {
      const v = args[key];
      if (typeof v === "number" && Number.isFinite(v)) {
        partial[key] = v;
      }
    }
    schedulerHandle.updateSchedulerSettings(partial);
    return { applied: true, next_start_only: "max_incremental_backlog" };
  })() : op.startsWith("sync_") || op === "device_info" || op === "pairing_offer" || op === "pairing_accept" || op === "cancel_pairing_offer" || op === "list_quarantine" || op === "quarantine_stats" || op === "retry_quarantine" || op === "delete_quarantine" || op === "peer_state" || op === "list_paired_devices" || op === "reset_peer_state" || op === "unblock_peer" ? syncDispatch(op, args) : dispatch(op, args);
  const endpointCache = new EndpointCache();
  const pairedDeviceIds = () => listTrustedPeers(core.db).map((p) => p.device_id);
  const expectedPrefixes = () => {
    const map = /* @__PURE__ */ new Map();
    for (const deviceId of pairedDeviceIds()) {
      map.set(instancePrefix(deviceId), deviceId);
    }
    return map;
  };
  const combinedWithMdns = (op, args) => {
    if (op === "mdns_event") {
      const e = args;
      if (e.kind !== "added" && e.kind !== "removed" || typeof e.instance_name !== "string" || typeof e.host !== "string" || typeof e.port !== "number") {
        console.error("[tide] mdns_event: malformed event ignored");
        return { applied: false };
      }
      const deviceId = matchInstanceToPeer(e.instance_name, pairedDeviceIds());
      if (deviceId === void 0) {
        return { applied: false };
      }
      endpointCache.applyEvent(e, deviceId);
      return { applied: true };
    }
    if (op === "mdns_snapshot") {
      const entries = args.entries;
      if (!Array.isArray(entries)) {
        return { applied: 0, available: false };
      }
      const applied = endpointCache.applySnapshot(entries, expectedPrefixes());
      return { applied, available: true };
    }
    return combined(op, args);
  };
  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    void handleLine(combinedWithMdns, trimmed).then((out) => {
      if (out !== "") process.stdout.write(out + "\n");
    });
  });
  const deliveredReminderKeys = /* @__PURE__ */ new Set();
  let lastTickMs = null;
  const deliveredPrune = () => {
    const cutoff = Date.now() - 25 * 36e5;
    for (const key of deliveredReminderKeys) {
      const ms = Number(key.split("|")[2]);
      if (Number.isFinite(ms) && ms < cutoff) deliveredReminderKeys.delete(key);
    }
  };
  const reminderTick = () => {
    try {
      const baseEvents = core.db.prepare(
        `SELECT e.event_id AS entity_id, e.title,
                  e.utc_start_ms, e.utc_end_ms,
                  COALESCE(e.start_wall, e.start_date || 'T00:00') AS start_wall,
                  COALESCE(e.end_wall, e.end_date || 'T23:59')      AS end_wall,
                  e.all_day, e.all_day_reminder_time
           FROM events e`
      ).all();
      const events = [];
      const seriesRows = core.db.prepare(
        `SELECT s.series_id, s.base_event_id, s.recurrence_rule
           FROM series s`
      ).all();
      const seriesByBase = new Map(seriesRows.map((s) => [s.base_event_id, s]));
      const now = Date.now();
      const WIN_LO = `${new Date(now - 25 * 36e5).getFullYear()}0101T000000`;
      for (const ev of baseEvents) {
        const row = seriesByBase.get(ev.entity_id);
        const timed = ev.all_day !== 1 && ev.utc_start_ms != null;
        if (!row || !timed) {
          events.push(ev);
          continue;
        }
        let occIds = [];
        try {
          occIds = expandOccurrences(
            {
              series_id: row.series_id,
              base_start_wall: ev.start_wall,
              tz_id: "local",
              recurrence_rule: row.recurrence_rule
            },
            WIN_LO,
            `${new Date(now).getFullYear() + 1}1231T235959`
          );
        } catch {
          events.push(ev);
          continue;
        }
        if (occIds.length === 0) {
          events.push(ev);
          continue;
        }
        const durMs = (ev.utc_end_ms ?? 0) - ev.utc_start_ms;
        for (const occId of occIds) {
          const startMs = msFromWallId(occId);
          events.push({
            ...ev,
            entity_id: `${ev.entity_id}#${occId}`,
            utc_start_ms: startMs,
            utc_end_ms: startMs + Math.max(durMs, 0)
          });
        }
      }
      const reminders = core.db.prepare(
        // DC-22 D5: disabled reminders (enabled = 0) are stored but INACTIVE
        // — the schedule engine never schedules them (NULL/1 = active).
        // updated_hlc feeds the late-configuration discard (reminder_engine).
        "SELECT member_id, entity_id, minutes_before, updated_hlc AS updated_hlc_ms FROM reminders WHERE enabled IS NULL OR enabled = 1"
      ).all();
      const schedule = rebuildSchedule(events, reminders, Date.now(), lastTickMs);
      deliveredPrune();
      const due = filterDelivered(schedule, deliveredReminderKeys).filter(
        (f) => f.fire_at_ms <= Date.now()
      );
      for (const fire of due) {
        console.log(
          `[tide] reminder dispatch: key=${fire.key} missed=${fire.missed} title="${fire.title}"`
        );
        deliverNotification(fire, (ok) => {
          if (ok) {
            markDelivered(deliveredReminderKeys, [fire]);
            console.log(`[tide] reminder delivered: key=${fire.key}`);
          } else {
            console.warn(
              `[tide] reminder delivery FAILED (will retry next tick): key=${fire.key}`
            );
          }
        });
      }
    } catch (err2) {
      console.error(
        "[tide] reminder rebuild failed (will retry):",
        err2 instanceof Error ? err2.message : String(err2)
      );
    }
  };
  reminderTick();
  const reminderTimer = setInterval(() => {
    const started = Date.now();
    reminderTick();
    lastTickMs = started;
  }, 3e4);
  void reminderTimer;
  const schedulerRuntime = startSchedulerRuntime({
    now: () => Date.now(),
    listPeers: () => {
      const peers = listTrustedPeers(core.db);
      const byDevice = new Map(peers.map((p) => [p.device_id, p]));
      return peers.map((p) => ({
        deviceId: p.device_id,
        endpoint: resolveEndpoint(
          endpointCache,
          {
            deviceIds: () => peers.map((x) => x.device_id),
            lastKnown: (deviceId) => {
              const row = byDevice.get(deviceId);
              return row?.last_endpoint_host != null && row.last_endpoint_port != null && row.last_endpoint_seen != null ? {
                host: row.last_endpoint_host,
                port: row.last_endpoint_port,
                seen: row.last_endpoint_seen
              } : null;
            }
          },
          p.device_id
        )?.endpoint ?? null
      }));
    },
    openSession: makeSessionOpener({
      privateKey: sync.identity.privateKey,
      runSession: (rawSession) => {
        const session = rawSession;
        return sync.runEngineSession(session, session.deviceId);
      }
    }),
    log: (m) => console.error(`[tide] ${m}`)
  });
  schedulerHandle = schedulerRuntime;
  rl.on("close", () => {
    sync.closeListener();
    setImmediate(() => process.exit(0));
    core.db.close();
  });
}
var self = process.argv[1] ?? "";
if (process.env.VITEST === void 0 && /sidecar\.(mjs|ts|cjs)$/.test(self)) {
  main();
}
export {
  SYNC_CONNECT_TIMEOUT_MS,
  SyncManager,
  handleLine,
  makeDispatcher,
  makeSyncDispatcher,
  withTimeout
};
/*! Bundled license information:

@noble/ed25519/index.js:
  (*! noble-ed25519 - MIT License (c) 2019 Paul Miller (paulmillr.com) *)

@noble/curves/utils.js:
@noble/curves/abstract/modular.js:
@noble/curves/abstract/curve.js:
@noble/curves/abstract/edwards.js:
@noble/curves/abstract/montgomery.js:
@noble/curves/ed25519.js:
  (*! noble-curves - MIT License (c) 2022 Paul Miller (paulmillr.com) *)
*/
