# TIDE DESIGN CONTRACT DC-07
# Exact SQLite Schema
Status: APPROVED by project owner (2026-08-25)

OWNER DECISION (2026-08-25), resolves the §12 encryption-at-rest open item:
The calendar database MUST be encrypted at rest using SQLCipher-style
AES-256 page-level encryption on all platforms (Windows, Android, Linux).
The database key is generated locally, held in OS-protected credential
storage with the same custody rules as the identity private key (DC-05
§2.3: never synchronized, never backed up, never leaves the device), and
is provided to SQLCipher at connection open. The accepted performance
overhead (~5-15% on this workload) is approved by the owner. Threat-model
note unchanged: this protects the dormant file, not a compromised running
session (DC-05 §8 N1).
Depends on: Architecture Spec v0.3 §5, §6, §7, §8, §15, §30, §31;
            DC-01; DC-02; DC-03; DC-04; DC-05; DC-06
Unblocks: persistence layer implementation, sync protocol (deferred #11),
          full-state snapshot format (deferred #7)
Resolves: deferred decision #10 from Spec §30

==================================================
1. PURPOSE
==================================================

Defines the exact SQLite schema that stores Tide's authoritative local
state (Spec §5): calendar domain data, the change history in DC-01 shape,
knowledge state per DC-02, conflict records per DC-03, member tombstones
and quarantine per DC-04, trust/identity material per DC-05, and the
bookkeeping compaction needs per DC-06.

Core principle (Spec §5): "SQLite stores state. Synchronization exchanges
changes." The database file is the LOCAL SOURCE OF TRUTH on each device.
SQLite files are NEVER synchronized, replicated, or copied between devices
(INVARIANT 3). Only structured records (DC-01) travel over the wire.

This contract is DDL-level but implementation-neutral: any engine reading
this schema (Rust/sqlx/rusqlite, migration tooling, tests) must be able to
produce byte-equivalent logical databases from it.

==================================================
2. GENERAL PRINCIPLES
==================================================

2.1  Local authority. The SQLite file is authoritative local state
     (Spec §5, INVARIANT 2). It is never written by anything except this
     device's own domain/sync layers, and never leaves the device except
     as user-initiated backups (Spec §25: restore = new identity).

2.2  Stable IDs only. Every sync-relevant table is keyed by stable
     identifiers from DC-01: UUIDv4 entity_id, UUIDv4 member_id,
     "<device_id>:<local_seq>" change_id, cryptographic device_id
     (DC-05 §2.2). No positional/index-based keys anywhere (DC-04 §2.2).
     No network-derived values (INVARIANT 5).

2.3  Timestamp encoding.
     a) All synchronization/bookkeeping timestamps (hlc_timestamp,
        detected_at_hlc, deleted_at_hlc, received_at_hlc, paired_at,
        resolved_at_hlc) are stored as UTC epoch-millisecond INTEGERs.
     b) EXCEPTION — recurrence wall-clock fields (Spec §7, INVARIANT 9):
        timed events store their wall-clock datetime as TEXT plus a
        separate tz_id column holding an IANA timezone identifier string
        (e.g. "Europe/Berlin"). A fixed UTC offset MUST NOT replace the
        source timezone for recurring semantics. Derived UTC columns
        (utc_start, utc_end) exist ONLY for transport/comparison/indexing
        and are explicitly NON-AUTHORITATIVE (marked DERIVED below);
        they must always be recomputable from the wall-clock + tz_id pair.
     c) All-day events use date-only TEXT ("YYYY-MM-DD") plus an all_day
        flag; they carry no timezone.

2.4  Transactions. All multi-step writes run inside explicit
     transactions (section 7). SQLite runs in WAL mode with
     PRAGMA foreign_keys = ON set on every connection.

2.5  Schema versioning and migrations. A schema_version table holds the
     current integer version. Migrations for v1.x are ADDITIVE ONLY:
     new tables, new nullable/redefaulted columns, new indexes. Any
     destructive statement (DROP TABLE, DROP COLUMN, NOT NULL tightening,
     data rewriting) requires EXPLICIT owner authorization before it may
     ship — Spec §15 database safety rules and the agent safety rules
     apply: no implementation agent may invent or execute destructive
     migrations silently (INVARIANT 13).

2.6  JSON columns. Fields whose content is defined as JSON objects by
     other contracts (payload, causality_clock, last_known_clock,
     resolved_value, raw_record) are stored as TEXT containing canonical
     compact JSON. Their internal shape is owned by the source contract
     (DC-01..DC-06), not by this schema.

==================================================
3. DOMAIN TABLES (calendar model, Spec §6)
==================================================

CREATE TABLE calendars (
    calendar_id   TEXT PRIMARY KEY,            -- UUIDv4, stable forever
    title         TEXT NOT NULL,
    color         TEXT,                         -- presentation hint
    created_hlc   INTEGER NOT NULL,             -- UTC epoch ms
    updated_hlc   INTEGER NOT NULL              -- UTC epoch ms
);

CREATE TABLE events (
    event_id      TEXT PRIMARY KEY,             -- UUIDv4, stable forever
    calendar_id   TEXT NOT NULL REFERENCES calendars(calendar_id),
    title         TEXT NOT NULL,
    description   TEXT NOT NULL DEFAULT '',
    all_day       INTEGER NOT NULL CHECK (all_day IN (0, 1)),
    -- ALL-DAY representation: date-only strings, no timezone.
    start_date    TEXT,                         -- 'YYYY-MM-DD' when all_day=1
    end_date      TEXT,                         -- inclusive, when all_day=1
    -- TIMED representation: wall-clock + IANA zone per Spec §7.
    start_wall    TEXT,                         -- 'YYYY-MM-DDTHH:MM[:SS]'
                  -- local wall-clock start when all_day=0
    end_wall      TEXT,                         -- local wall-clock end
    tz_id         TEXT,                         -- IANA identifier, e.g.
                  -- 'Europe/Berlin'; NEVER a bare fixed offset
    -- DERIVED, NON-AUTHORITATIVE (Spec §7): recomputed from wall+tz_id,
    -- used only for transport/comparison/indexing. Must never be read
    -- back as the recurrence-authoritative time.
    utc_start_ms  INTEGER,                      -- DERIVED
    utc_end_ms    INTEGER,                      -- DERIVED
    created_hlc   INTEGER NOT NULL,
    updated_hlc   INTEGER NOT NULL,
    CHECK ((all_day = 1 AND start_date IS NOT NULL AND end_date IS NOT NULL
               AND start_wall IS NULL AND end_wall IS NULL AND tz_id IS NULL)
        OR (all_day = 0 AND start_wall IS NOT NULL AND end_wall IS NOT NULL
               AND tz_id IS NOT NULL AND start_date IS NULL
               AND end_date IS NULL))
);

CREATE TABLE series (
    series_id         TEXT PRIMARY KEY,         -- UUIDv4; also the entity_id
                      -- of recurrence-rule changes (DC-01 §3.1)
    base_event_id     TEXT NOT NULL UNIQUE REFERENCES events(event_id),
    recurrence_rule   TEXT NOT NULL,            -- RRULE-string form; its own
                      -- conflict entity (series_id, "recurrence_rule")
    created_hlc       INTEGER NOT NULL,
    updated_hlc       INTEGER NOT NULL
);

CREATE TABLE occurrence_overrides (
    series_id     TEXT NOT NULL REFERENCES series(series_id),
    recurrence_id TEXT NOT NULL,                -- identifies the ORIGINAL
                  -- occurrence (Spec §8); composite identity
                  -- series_id + recurrence_id (DC-01 §3.1)
    cancelled     INTEGER NOT NULL DEFAULT 0 CHECK (cancelled IN (0,1)),
    title         TEXT,
    start_wall    TEXT,                          -- override wall-clock, if moved
    end_wall      TEXT,
    tz_id         TEXT,                          -- IANA id; wall clock preserved
    utc_start_ms  INTEGER,                       -- DERIVED, non-authoritative
    utc_end_ms    INTEGER,                       -- DERIVED, non-authoritative
    updated_hlc   INTEGER NOT NULL,
    PRIMARY KEY (series_id, recurrence_id)
);

CREATE TABLE reminders (
    member_id       TEXT PRIMARY KEY,           -- UUIDv4 (DC-01 §3.2)
    entity_id       TEXT NOT NULL,              -- owning event
    collection_path TEXT NOT NULL DEFAULT 'reminders',
    minutes_before  INTEGER NOT NULL CHECK (minutes_before >= 0),
    updated_hlc     INTEGER NOT NULL,
    UNIQUE (entity_id, collection_path, member_id)
);

CREATE TABLE attendees (
    member_id       TEXT PRIMARY KEY,           -- UUIDv4 (DC-01 §3.2)
    entity_id       TEXT NOT NULL,
    collection_path TEXT NOT NULL DEFAULT 'attendees',
    display_name    TEXT,
    role            TEXT,                        -- opaque to sync (DC-04 §10)
    updated_hlc     INTEGER NOT NULL,
    UNIQUE (entity_id, collection_path, member_id)
);

Notes:
- Reminders and attendees are COLLECTION MEMBERS with explicit UUIDv4
  member_id chosen at creation (DC-04 §2.2); position is never stored
  as semantic content. There is no table-level operation corresponding
  to "set whole collection" — application code enforces DC-04 §4.1;
  the schema cannot express it because members are independent rows.
- occurrence_overrides carries no FK to a precomputed occurrence list;
  recurrence_id is an opaque occurrence identifier per Spec §8.

==================================================
4. SYNCHRONIZATION STATE TABLES
==================================================

4.1  Entity tombstones (DC-01 §6 tombstone-marker shape)

CREATE TABLE entities_tombstones (
    entity_id        TEXT NOT NULL,
    entity_type      TEXT NOT NULL CHECK (entity_type IN
                         ('calendar','event','series','occurrence_override')),
    producer_device_id TEXT NOT NULL,
    seq              INTEGER NOT NULL,           -- producer's local_seq of
                     -- the deletion record
    causality_clock  TEXT NOT NULL,              -- JSON {device_id: seq}
    deleted_at_hlc   INTEGER NOT NULL,
    PRIMARY KEY (entity_id, producer_device_id, seq)
);

4.2  Member tombstones (DC-04 §5)

CREATE TABLE member_tombstones (
    entity_id        TEXT NOT NULL,
    collection_path  TEXT NOT NULL,
    member_id        TEXT NOT NULL,
    producer_device_id TEXT NOT NULL,
    seq              INTEGER NOT NULL,
    causality_clock  TEXT NOT NULL,             -- JSON
    PRIMARY KEY (entity_id, collection_path, member_id,
                 producer_device_id, seq)
);

4.3  Local change history (exact DC-01 §2 record shape)

CREATE TABLE changes (
    change_id        TEXT PRIMARY KEY,          -- "<device_id>:<local_seq>"
                     -- UNIQUE mirrors DC-01 TR-1 / dedupe key
    device_id        TEXT NOT NULL,
    local_seq        INTEGER NOT NULL CHECK (local_seq > 0),
    entity_id        TEXT NOT NULL,
    entity_type      TEXT NOT NULL CHECK (entity_type IN
                         ('calendar','event','series','occurrence_override',
                          'reminder','tombstone-marker')),
    field_path       TEXT NOT NULL,
    operation        TEXT NOT NULL CHECK (operation IN
                         ('set','remove','member_add','member_update',
                          'member_remove')),
    payload          TEXT NOT NULL,             -- JSON per DC-01 §2 payload
    hlc_timestamp    INTEGER NOT NULL,          -- presentation-only (DC-03 §5)
    causality_clock  TEXT NOT NULL,             -- JSON per DC-02
    schema_version   INTEGER NOT NULL DEFAULT 1,
    UNIQUE (device_id, local_seq)               -- change_id == this pair
);

Note: 'attendee' changes ride under entity_type 'reminder' semantics via
field_path ("attendees.<member_id>") OR, if the implementation prefers,
the enum gains an 'attendee' value in an additive migration — either is
DC-01-compatible since DC-01 fixes the six-value enum for wire records;
locally stored copies of attendee records use whatever entity_type the
wire record carried. No local-only rewriting of entity_type is allowed.

4.4  Own device_clock map (DC-02 §2.1)

CREATE TABLE device_clock (
    peer_device_id TEXT PRIMARY KEY,            -- includes SELF entry
    max_seq        INTEGER NOT NULL CHECK (max_seq > 0)
);

Absence of a row means "no knowledge of that device" — never stored as 0
(DC-02 §2.1b).

4.5  applied_upto (DC-02 §2.2)

CREATE TABLE applied_upto (
    producer_device_id TEXT PRIMARY KEY,
    applied_through    INTEGER NOT NULL CHECK (applied_through >= 0)
);

4.6  Pending out-of-order remote changes (DC-02 §2.2 pending set)

CREATE TABLE pending_changes (
    device_id       TEXT NOT NULL,
    local_seq       INTEGER NOT NULL CHECK (local_seq > 0),
    record_payload  TEXT NOT NULL,              -- full DC-01 record verbatim
                    -- so drain re-runs normal application unchanged
    received_at_hlc INTEGER NOT NULL,
    PRIMARY KEY (device_id, local_seq)
);

4.7  Conflicts (DC-03 §4 record shape)

CREATE TABLE conflicts (
    conflict_id      TEXT PRIMARY KEY,          -- UUIDv4, stable forever
    entity_id        TEXT NOT NULL,
    field_path       TEXT NOT NULL,             -- together == DC-03 §2.1
                     -- conflict entity
    status           TEXT NOT NULL CHECK (status IN
                         ('unresolved','resolved_keep_local',
                          'resolved_keep_incoming','resolved_custom')),
    detected_at_hlc  INTEGER NOT NULL,
    resolved_value   TEXT,                      -- nullable JSON; required
                     -- (NOT NULL-enforced in code) when resolved_custom
    resolved_at_hlc  INTEGER,                   -- nullable; present iff resolved
    CHECK ((status = 'unresolved' AND resolved_value IS NULL
               AND resolved_at_hlc IS NULL)
        OR (status LIKE 'resolved_%'))
);

CREATE TABLE conflict_participants (
    conflict_id     TEXT NOT NULL REFERENCES conflicts(conflict_id),
    change_id       TEXT NOT NULL,
    device_id       TEXT NOT NULL,
    local_seq       INTEGER NOT NULL,
    causality_clock TEXT NOT NULL,              -- JSON
    payload         TEXT NOT NULL,              -- JSON, verbatim participant
    PRIMARY KEY (conflict_id, change_id)
);
-- Participants are immutable once added (DC-03 §4); no UPDATE path exists.

4.8  Peers / trust store (DC-05 §3.1 + DC-06 §2.1 lastKnownClock(P))

CREATE TABLE peers (
    device_id        TEXT PRIMARY KEY,
    public_key       BLOB NOT NULL,             -- Ed25519 pk; SHA-256(pk)
                     -- digest must equal device_id (verified on load,
                     -- DC-05 TR-13)
    display_name     TEXT NOT NULL,
    paired_at        INTEGER NOT NULL,          -- UTC epoch ms
    status           TEXT NOT NULL CHECK (status IN ('trusted','revoked')),
    last_known_clock TEXT NOT NULL DEFAULT '{}' -- JSON map per DC-06
                     -- §2.1 lastKnownClock(P); updated ONLY from
                     -- authenticated advertisements (DC-06 §6.4)
);
-- status transitions trusted->revoked only; enforced in code (DC-05 §7.2).

4.9  Revocation records (DC-05 §7)

CREATE TABLE revocation_records (
    revoked_device_id    TEXT NOT NULL,
    revoked_by_device_id TEXT NOT NULL,
    revoked_at_hlc       INTEGER NOT NULL,
    reason               TEXT,
    record_bytes         BLOB NOT NULL,         -- signed record VERBATIM
    signature            BLOB NOT NULL,         -- Ed25519 detached sig
    verification_state   TEXT NOT NULL CHECK
                         (verification_state IN ('pending','valid','invalid')),
    received_at_hlc      INTEGER NOT NULL,
    PRIMARY KEY (revoked_device_id, revoked_by_device_id, revoked_at_hlc)
);

4.10 Quarantine (DC-04 §4.3)

CREATE TABLE quarantine (
    quarantine_id    INTEGER PRIMARY KEY AUTOINCREMENT,
    quarantine_reason TEXT NOT NULL,            -- machine-readable code,
                     -- e.g. 'whole_collection_replacement',
                     -- 'member_id_mismatch', 'invalid_member_id'
    received_at_hlc  INTEGER NOT NULL,
    sender_device_id TEXT NOT NULL,
    raw_record       TEXT NOT NULL              -- verbatim record JSON
);

4.11 Identity (single-row; PUBLIC material only)

CREATE TABLE identity (
    singleton   INTEGER PRIMARY KEY CHECK (singleton = 1),
    device_id   TEXT NOT NULL,
    public_key  BLOB NOT NULL                   -- own Ed25519 public key
);

HARD RULE (restating DC-05 §2.3): the PRIVATE KEY NEVER ENTERS SQLITE.
It lives exclusively in OS-protected credential storage (or the documented
weak fallback file), outside the database, outside backups. This table
stores public material and derived device_id only.

4.12 Meta / schema version

CREATE TABLE schema_version (
    version       INTEGER PRIMARY KEY CHECK (version > 0),
    applied_at_hlc INTEGER NOT NULL
);
-- One row holds the current version. Fresh DBs initialize at version 1
-- inside the same transaction that creates all tables above.

==================================================
5. INDEXES (with justification)
==================================================

-- DC-06 §5.2 primary sweep index: compaction candidates are ordered and
-- range-scanned by (producer, seq) against lastKnownClock comparisons.
CREATE INDEX idx_changes_device_seq ON changes(device_id, local_seq);

-- DC-03 §2.2 participant lookup: detection scans applied uncompacted
-- history touching a conflict entity (entity_id, field_path prefix).
CREATE INDEX idx_changes_entity ON changes(entity_id, field_path);

-- Tombstone lookup during anti-entropy and sweep (per-producer seq ranges).
CREATE INDEX idx_etomb_producer_seq
    ON entities_tombstones(producer_device_id, seq);
CREATE INDEX idx_mtomb_producer_seq
    ON member_tombstones(producer_device_id, seq);

-- Conflict UI and sync gating enumerate unresolved conflicts fast;
-- also lets sweeps cheaply test "participates_in_unresolved_conflict"
-- via joins through conflict_participants(change_id).
CREATE INDEX idx_conflicts_status ON conflicts(status, detected_at_hlc);
CREATE INDEX idx_cparticipants_change ON conflict_participants(change_id);

-- DC-06 §5.3 per-producer MIN-uncompacted-seq summary: no dedicated
-- table is REQUIRED — it is derivable via
--   SELECT device_id, MIN(local_seq) FROM changes GROUP BY device_id
-- (and equivalently over the tombstone tables), which the
-- idx_changes_device_seq index supports as an index-only scan. If
-- profiling shows this query matters at scale, a materialized summary
-- table MAY be added in an additive migration (v1.x), not before.
-- Requirement: whichever mechanism ships MUST keep the sweep predicate
-- expressible without full-table scans.

-- Calendar/event browsing (UI-facing, cheap insurance).
CREATE INDEX idx_events_calendar ON events(calendar_id, utc_start_ms);
CREATE INDEX idx_overrides_series ON occurrence_overrides(series_id);

Justification summary: every index maps 1:1 to a named access path from a
prior contract (sweep ordering, participant detection, tombstone range
scans, conflict enumeration) or to a hot UI path; none is speculative.

==================================================
6. INVARIANT-ENFORCING CONSTRAINTS
==================================================

6.1  CHECK constraints enforce all enums fixed by prior contracts:
     changes.operation (DC-01 §2), changes.entity_type (DC-01 §2),
     entities_tombstones.entity_type, conflicts.status (DC-03 §4),
     peers.status (DC-05 §3.1), revocation_records.verification_state,
     events all_day/timed mutual exclusion (section 3), positive seqs.

6.2  NOT NULL covers every field mandated by a source contract:
     all DC-01 record fields, causality clocks, trust-store fields
     (public_key/display_name/paired_at/status), quarantine fields
     (reason/received_at_hlc/sender_device_id/raw_record).

6.3  UNIQUE constraints mirror TRs: changes.change_id PK +
     UNIQUE(device_id, local_seq) (DC-01 TR-1); pending_changes
     composite PK (dedupe key DC-02 §7.1); conflicts.conflict_id PK
     (DC-03 TR-8 no duplicate conflict_id); conflict_participants
     (conflict_id, change_id) PK (no duplicate participants, DC-03 §4);
     occurrence_overrides (series_id, recurrence_id) PK (Spec §8).

6.4  Foreign keys: ON DELETE RESTRICT for domain references
     (events->calendars, series->events, overrides->series). Sync-state
     tables deliberately do NOT FK to domain rows: change history and
     tombstones must OUTLIVE the rows they describe (that is their
     purpose), and pending/conflict records reference possibly not-yet-
     present entities. This asymmetry is intentional.

6.5  What the schema deliberately does NOT enforce (owned elsewhere):
     vector-clock comparison semantics (DC-02), gap-free local_seq per
     producer (application layer), trusted->revoked transition direction
     (sync/security layer), private-key custody (OS keystore). SQLite
     constraints guard STRUCTURE; SEMANTICS stay in the contracts' layers.

==================================================
7. TRANSACTION BOUNDARIES (MANDATORY)
==================================================

The following operations MUST each execute inside ONE transaction
(BEGIN ... COMMIT; WAL rollback guarantees atomicity):

T1  CREATE LOCAL CHANGE (Spec §5 pipeline):
    entity/calendar/series/override/member mutation
    + INSERT INTO changes
    + UPSERT device_clock[SELF] = new_local_seq (DC-02 §4.1)
    — atomic, so a crash can never strand a mutated entity without its
    change record or advance the clock without the record.

T2  APPLY REMOTE CHANGE (DC-02 §7):
    dedupe check -> entity/state mutation (or no-op)
    + delete-from-pending OR insert-into-pending (gap buffering)
    + UPSERT applied_upto[producer] (+ drain consecutive pending rows)
    + element-wise-max merge of causality_clock into device_clock
    — atomic per DC-02 §7 reorder/idempotency requirements.

T3  CONFLICT DETECTION RESULT: insert/update conflicts row +
    insert conflict_participants rows atomically (a conflict record
    must never exist without its participants, DC-03 §4).

T4  COMPACTION SWEEP (DC-06 §6): knowledge-bookkeeping update (if any)
    + deletion of the victim batch (members first, then entity records,
    then tombstones) in a SINGLE transaction; kill mid-sweep rolls back
    fully (DC-06 TR-6).

T5  PAIRING / TRUST WRITES (DC-05): inserting a peer entry after
    successful ceremony, or flipping status='revoked' + inserting the
    revocation_records row, are single transactions — zero partial
    trust-store mutation on any failure (DC-05 §6.3 fail-closed rule).

T6  REVOCATION RECORD ACCEPTANCE: verification_state update + any
    dependent peers.status flip happen together or not at all.

T7  SCHEMA INITIALIZATION/MIGRATION: create-all-tables or apply-migration
    + schema_version update in one transaction (fresh DB is never left
    half-created).

Resolution writes (DC-03 §4.4: winning value becomes a NEW normal change
record) reuse T1 followed by the conflicts.status update — both within
one transaction.

==================================================
8. MIGRATION POLICY
==================================================

8.1  schema_version holds the current integer version (starts at 1).
     Each migration N -> N+1 is a named, code-reviewed function.

8.2  v1.x migrations are ADDITIVE ONLY: CREATE TABLE / CREATE INDEX /
     ALTER TABLE ADD COLUMN (nullable or WITH DEFAULT) / INSERT of
     derived backfill rows. They must leave every pre-existing row
     logically untouched.

8.3  DESTRUCTIVE migrations (DROP TABLE/COLUMN, type changes, NOT NULL
     tightening requiring rewrite) require EXPLICIT project-owner
     approval documented in the migration itself. No agent invents,
     schedules, or executes them autonomously (Spec §15 database-safety
     posture; INVARIANT 13).

8.4  Every migration runs inside T7-style transactions; a failed
     migration rolls back completely and the app refuses to open a DB
     at an unknown/higher schema_version (fail closed, forward-only).

==================================================
9. EXAMPLES
==================================================

9.1  Storing the DC-01 §7 title-change record:

INSERT INTO changes VALUES (
  'd-phone:184', 'd-phone', 184, 'e-a1b2...', 'event', 'title', 'set',
  '{"value":"Dentist"}', 1724600000123,
  '{"d-phone":184,"d-desktop":72}', 1);
-- rejected if d-phone already has local_seq 184 (UNIQUE), even though a
-- different change_id string would be needed to violate the PK too.

9.2  DST-correct timed event (Spec §7):

INSERT INTO events (event_id, calendar_id, title, all_day,
  start_wall, end_wall, tz_id, utc_start_ms, utc_end_ms, ...)
VALUES ('e-...', 'c-...', 'Standup', 0,
  '2026-10-25T09:00', '2026-10-25T09:30', 'Europe/Berlin',
  <derived>, <derived>, ...);
-- 2026-10-25 is a fall-back day in Berlin (03:00 -> 02:00 CEST->CET).
-- Authoritative storage keeps the WALL time 09:00 + 'Europe/Berlin';
-- utc_start_ms is recomputed via chrono-tz/TZif and lands on the CET
-- offset (+01:00) for that date. A weekly series recurring across this
-- boundary keeps 09:00 wall clock on every occurrence — the DERIVED
-- utc columns shift with the offset and are never fed back into
-- recurrence expansion (INVARIANT 9).

9.3  All-day event:
    all_day=1, start_date='2026-12-24', end_date='2026-12-26',
    start_wall/end_wall/tz_id all NULL (CHECK-enforced).

9.4  Buffered out-of-order arrival: Tablet receives (d-phone,185) while
    applied_upto[d-phone]=182 ->
    INSERT INTO pending_changes VALUES('d-phone',185,'<full record>',...);
    after fetching 183–184, T2 drains all three and deletes the pending
    row in the same transaction.

==================================================
10. TESTABLE REQUIREMENTS
==================================================

TR-1  CLEAN CREATE: executing the DDL of sections 3–5 against an empty
      SQLite file (foreign_keys=ON, WAL mode) completes without error;
      sqlite_master contains exactly the declared tables/indexes;
      schema_version contains exactly one row, version 1.

TR-2  ROUND-TRIP FIDELITY: for every record shape defined by DC-01
      (all five operations incl. tombstone-marker), DC-02 (device_clock/
      applied_upto/pending entries), DC-03 (conflict + participants),
      DC-04 (member tombstone, quarantine entry), DC-05 (peer entry,
      revocation record, identity row), serializing to these tables and
      reading back reconstructs the record byte-identically modulo
      JSON key order; a property test round-trips >=1000 randomized
      instances per shape.

TR-3  UNIQUENESS REJECTION: inserting a second row into changes with an
      existing change_id OR an existing (device_id, local_seq) pair
      fails with a UNIQUE constraint violation; same for duplicate
      conflict_id and duplicate (device_id, local_seq) in
      pending_changes.

TR-4  ENUM CHECKS: inserts violating any CHECK enum — operation='upsert',
      entity_type='blob', status='blocked', verification_state='maybe',
      events with all_day=0 and NULL tz_id, negative local_seq — are
      rejected; valid enum values insert cleanly.

TR-5  TIME REPRESENTATION CORRECTNESS:
      a) all-day events reject wall/tz columns and vice versa (CHECK);
      b) a timed event at '2026-10-25T09:00 Europe/Berlin' (fall-back
         day) stores wall clock + IANA id, and its utc_* DERIVED columns
         equal the instants computed independently by chrono-tz (or an
         equally established library); recompute-after-load matches the
         stored values; the following week's occurrence expands to 09:00
         WALL time with the shifted UTC instant;
      c) no code path writes a numeric UTC offset into tz_id (test greps
         rejects /^\+|-?\d\d:\d\d$/ forms and asserts round-trips through
         chrono-tz).

TR-6  FK INTEGRITY: with foreign_keys=ON, inserting an event for a
      nonexistent calendar, or an override for a nonexistent series,
      fails; deleting a referenced calendar is refused (RESTRICT).

TR-7  TRANSACTIONAL ATOMICITY: for each mandatory transaction T1–T7,
      simulate process death (kill -9 or fault-injected abort) at every
      step boundary: on reopen, the DB is consistent per DC-06 §6 —
      e.g., after mid-T1 death there is EITHER (old state, old clock)
      OR (new state, new change, advanced clock), never a mixture; a
      killed T4 sweep leaves all victims intact and reruns identically.

TR-8  SWEEP INDEX SUPPORT: EXPLAIN QUERY PLAN for the DC-06 §5.3
      min-uncompacted-seq derivation uses indexes (no full table scan)
      at >=10^5 change rows; candidate enumeration for a sweep touches
      idx_changes_device_seq ranges, not the whole table.

TR-9  MIGRATION v1->v2 ADDITIVE EXAMPLE: a reference additive migration
      (ALTER TABLE events ADD COLUMN notes TEXT;) applies inside one
      transaction on a populated v1 DB: all pre-existing rows survive
      with identical field values (new column NULL), schema_version
      advances exactly one step, and reopening with v1 code still works
      (ignored extra column). A simulated destructive variant is proven
      BLOCKED by policy review (not present in shipped migrations).

TR-10 QUARANTINE DURABILITY: a DC-04-invalid record inserted into
      quarantine survives restart with raw_record verbatim and remains
      countable per reason code (supports DC-04 TR-7 observability).

TR-11 IDENTITY PRIVACY: static assertion/test that the identity table
      schema contains NO private-key column and that no write path in
      the persistence layer accepts private key material (DC-05 §2.3).

==================================================
11. OUT OF SCOPE
==================================================

- Wire envelope / sync message framing          -> deferred decision #11
- Full-state snapshot format & thresholds       -> deferred decision #7
- Trust-revocation propagation algorithm        -> deferred decision #8
- Conflict-resolution UI / flows                -> deferred #12
- Recurrence-specific conflict semantics        -> deferred #5
- UI concerns, Tauri command surface exposing
  these tables                                  -> separate contracts /
                                                   implementation tasks
- Encryption-at-rest: RESOLVED by owner decision 2026-08-25 — SQLCipher-
  style AES-256 page encryption is MANDATORY on all platforms; key custody
  per DC-05 §2.3. Recorded in the status block above and in section 2.4a
  below.
- Query planner tuning beyond the indexes mandated here (profiling-driven,
  additive migrations only).
- Backup-file format (Spec §25 mechanics) beyond stating the private key
  and this DB's relationship: restore = new identity.

==================================================
12. OPEN ITEMS OWNED ELSEWHERE
==================================================

- Encryption-at-rest choice (plaintext SQLite relying on platform disk
  encryption vs SQLCipher vs OS-level DPAPI container) -> RESOLVED by
  owner decision 2026-08-25: SQLCipher-style AES-256 page-level
  encryption is mandatory on all platforms; DB key custody per DC-05
  §2.3 (OS keystore, never synced, never backed up). See the owner
  decision block in the status header.
- Whether a materialized per-producer min-uncompacted-seq table is
  warranted (section 5 note) -> profiling follow-up, additive migration.
- Whether attendee records need a distinct entity_type enum value on the
  wire (currently stored as carried) -> DC-01 revision if ever needed.
- Retention policy for quarantine rows (bounded growth) -> future
  housekeeping contract; until then quarantine grows monotonically.
- Exact connection/pool configuration for Tauri (WAL checkpoint cadence,
  busy_timeout) -> implementation task constrained by section 2.4.
