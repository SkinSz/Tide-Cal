// Tide DC-07: SQLite schema DDL (APPROVED contract).
// One source of truth for table creation. Encryption-at-rest is applied at
// connection level (SQLCipher key pragma) by the caller, not here.

export const SCHEMA_VERSION = 1;

export const DDL = `
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
    raw_record        TEXT NOT NULL
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
