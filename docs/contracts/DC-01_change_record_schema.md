# TIDE DESIGN CONTRACT DC-01
# Field-Level Change Record Schema
Status: APPROVED by project owner (2026-08-25)
Depends on: Architecture Spec v0.3 §6, §8, §9, §13, §14
Unblocks: DC-02 (vector clocks), conflict detection, sync protocol

==================================================
1. PURPOSE
==================================================

Defines the exact structure of a Change Record — the unit that devices
exchange during synchronization (Spec frozen decision [03], [16], [22]).

A change record describes ONE logical modification to ONE field or
collection member of ONE entity. It never describes a whole entity blob,
and never contains database-file data.

==================================================
2. CHANGE RECORD FIELDS
==================================================

change_id          string   Globally unique ID of this change.
                            Format: "<device_id>:<local_seq>"
                            (device_id + colon + monotonically increasing
                            integer). Deterministic, unique, sortable.

device_id          string   Cryptographic device identity (DC-05) of the
                            device that PRODUCED the change. Never derived
                            from IP/hostname/MAC (Spec [11]).

local_seq          integer  Producer's monotonically increasing sequence
                            number. Gap-free per device. Never reused.

entity_id          string   Stable identifier of the affected calendar
                            entity (event, calendar, series, override).
                            UUIDv4, generated once at entity creation,
                            stable across all devices forever.

entity_type        enum     One of:
                              "calendar"
                              "event"
                              "series"            (recurrence base)
                              "occurrence_override"
                              "reminder"          (collection member)
                              "tombstone-marker"  (see section 6)

field_path         string   Logical field modified. Dot notation.
                            Examples:
                              "title"
                              "description"
                              "start"
                              "end"
                              "all_day"
                              "timezone"
                              "recurrence_rule"
                              "reminders.<member_id>"   (collection member)

operation          enum     "set"      — create or overwrite scalar field
                              "remove"   — delete scalar field / member
                              "member_add"    — add collection member
                              "member_update" — modify collection member
                              "member_remove" — remove collection member

payload            object   The changed data. Structure depends on
                            operation:
                              set:           { "value": <json> }
                              remove:        {} (empty)
                              member_add:    { "member_id": ..., "value": ... }
                              member_update: { "member_id": ..., "value": ... }
                              member_remove: { "member_id": ... }

hlc_timestamp      integer  Hybrid Logical Clock timestamp (millisecond UTC
                            + logical counter). Ordering aid ONLY.
                            NEVER used to decide conflict winners.

causality_clock    object   Vector clock of the producing device AT THE
                            MOMENT the change was created:
                              { "<device_id>": <seq>, ... }
                            This is what makes concurrency detection
                            possible (formalized in DC-02).

schema_version     integer  Wire/schema version of this record. Starts 1.

==================================================
3. IDENTIFIER RULES
==================================================

3.1  occurrence overrides are identified by composite identity:
       entity_id = <series_uuid>
       field_path includes recurrence_id: e.g.
         "overrides.<recurrence_id>.start"
     This satisfies Spec §8 (series_id + recurrence_id) while keeping
     every override its own conflict entity ([24]).

3.2  Collection members (e.g., reminders) MUST carry an explicit stable
     member_id chosen at creation time (UUIDv4). Position/index is never
     used as identity ([23]).

3.3  change_ids are never regenerated. A retransmitted change carries the
     same change_id; receivers deduplicate on change_id (Spec §14).

==================================================
4. ORDERING AND IDEMPOTENCY RULES
==================================================

4.1  Changes from one device apply in local_seq order. local_seq is
     gap-free; a gap means changes are missing and must be fetched.

4.2  Applying the same change twice is a no-op (dedupe by change_id).

4.3  Applying changes out of order across devices must be safe: each
     change's causality_clock carries enough information to detect
     whether a causally-later change has already been applied. Formal
     rules live in DC-02.

4.4  hlc_timestamp breaks presentation ties only. It MUST NOT select a
     winner between concurrent writes ([21] — no silent LWW).

==================================================
5. WHAT A CHANGE RECORD IS NOT
==================================================

- Not a database row dump. Only the touched logical field.
- Not a command with side effects ("ring alarm"). Data only.
- Not trust-bearing. Records are untrusted until received over the
  authenticated transport (Spec §20).
- Not self-interpreting for UI. Conflict display is a separate contract.

==================================================
6. DELETIONS
==================================================

Deleting an event produces operation="remove" records for its fields /
a tombstone record per Spec §12. Tombstone record shape:

  entity_type: "tombstone-marker"
  field_path:  "entity"
  payload:     { "deleted_entity_type": ..., "deleted_at_hlc": ... }

Tombstone compaction timing is DC-06, not here.

==================================================
7. EXAMPLES
==================================================

Title change on phone:
{
  "change_id": "d-9f2c...:184",
  "device_id": "d-9f2c...",
  "local_seq": 184,
  "entity_id": "e-a1b2...",
  "entity_type": "event",
  "field_path": "title",
  "operation": "set",
  "payload": { "value": "Dentist" },
  "hlc_timestamp": 1724600000123,
  "causality_clock": { "d-9f2c...": 184, "d-desktop": 71 },
  "schema_version": 1
}

Add reminder to an event:
{ "...", "field_path": "reminders.r-88a1...", "operation": "member_add",
  "payload": { "member_id": "r-88a1...",
               "value": { "minutes_before": 30 } }, ... }

Cancel one occurrence of a recurring series:
{ "...", "entity_type": "occurrence_override",
  "field_path": "overrides.20260902T090000.cancelled",
  "operation": "set", "payload": { "value": true }, ... }

==================================================
8. TESTABLE REQUIREMENTS
==================================================

TR-1  change_id uniqueness: no two distinct changes share a change_id;
      identical change_id implies byte-identical record content.
TR-2  local_seq is gap-free per device under any edit workload.
TR-3  Serialization round-trips through JSON without loss.
TR-4  Duplicate application is idempotent (no double effect).
TR-5  Occurrence override records always carry both series identity and
      recurrence_id.
TR-6  Collection member operations always carry explicit member_id.
TR-7  No record ever contains IP/hostname/MAC-derived identity.

==================================================
9. OPEN ITEMS OWNED ELSEWHERE
==================================================

- Concurrency/comparison semantics of causality_clock -> DC-02
- Conflict detection using these records   -> DC-03
- Exact SQLite tables storing records      -> deferred decision #10
- Wire envelope/framing between devices    -> deferred decision #11
