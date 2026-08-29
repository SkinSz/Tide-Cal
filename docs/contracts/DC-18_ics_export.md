# TIDE DESIGN CONTRACT DC-18
# iCalendar (.ics) Export — Interoperability Boundary Semantics
Status: APPROVED by project owner (2026-08-29). Implementation NOT yet
        authorized to start — this approval covers the design only.

Depends on: Architecture Spec v0.3 §6 (Calendar Domain), §26 (External
            Calendar Formats); DC-01; DC-07 (SQLite schema, v5)
Unblocks: implementation of .ics export (Outlook / Google Calendar /
          Apple Calendar compatible output)
Out of scope: .ics IMPORT (not requested; would need its own contract),
              CalDAV (explicitly skipped by owner, 2026-08-25),
              reminders (see §8 — deferred to a future contract),
              visual design of any export surface

==================================================
1. PURPOSE AND PRINCIPLE
==================================================

Defines the semantics of exporting Tide calendar data to iCalendar
(.ics, RFC 5545) files.

Binding rule (Spec §26): external formats MUST NOT dictate the SQLite
schema, revision model, vector clocks, conflict model, or sync protocol.
Export is a READ-ONLY PROJECTION at an interoperability boundary:

    SQLite (source of truth) -> Exporter (pure function) -> .ics bytes

The exporter is a PURE function of the domain data. It holds no state,
writes nothing to the DB, registers no callbacks, and never mutates the
internal model. Consequence: export correctness is testable headlessly
(bytes in -> bytes out), and a failed export cannot corrupt anything.

==================================================
2. EXPORT SURFACE AND TRIGGER
==================================================

2.1 Trigger: user-invoked only. A toolbar/dialog action "Export
    calendar (.ics)" (exact UI placement out of scope here). No
    background/scheduled export; no auto-export on change (v1).

2.2 Scope selection: user picks ONE calendar or ALL calendars.
    Default: all calendars in one file.

2.3 Output: a single .ics file (text/calendar, UTF-8, CRLF line
    endings per RFC 5545 §3.1). One VCALENDAR per file. Events from
    multiple calendars are distinguished via per-event grouping only if
    both calendars are exported (see 4.4) — otherwise one file per
    calendar is acceptable output for the single-calendar case.

2.4 Delivery: file save via the OS save dialog (Tauri). The exporter
    produces bytes; file placement is UI plumbing.

==================================================
3. MAPPING — TIDE MODEL -> RFC 5545
==================================================

3.1 Calendar -> VCALENDAR
    - PRODID: "-//Tide//Calendar Export//EN"
    - VERSION: 2.0 (fixed, RFC 5545 §3.7.3)
    - CALSCALE: GREGORIAN

3.2 Event -> VEVENT (one per Tide event)
    | Tide field              | .ics property                        |
    |-------------------------|--------------------------------------|
    | event_id                | UID (verbatim; see 3.6)              |
    | title                   | SUMMARY                              |
    | description             | DESCRIPTION (empty string omitted)   |
    | all_day=1               | DTSTART;VALUE=DATE / DTEND;VALUE=DATE|
    | all_day=0, utc_*        | DTSTART / DTEND in UTC (Z form)      |
    | start/end (timed, tz)   | DTSTART;TZID=<tz_id> when tz known   |
    | created_hlc             | (not exported — see 3.7)             |
    | updated_hlc             | (not exported — see 3.7)             |
    | tombstone (deleted)     | NOT exported (see 3.8)               |

3.3 Timezone rules (normative):
    - All-day events use VALUE=DATE with no time component; DTEND is
      EXCLUSIVE per RFC 5545 (Tide end_date is inclusive — the exporter
      adds one day. This conversion is normative and MUST be tested).
    - Timed events with a known tz_id: DTSTART;TZID=<tz>. The VTIMEZONE
      component for each referenced tz MUST be emitted in the file
      (most consumers require it). If tz_id is not IANA-canonical in
      the DB, fall back to UTC (Z form) rather than emitting a
      non-resolvable TZID; log the fallback.
    - Timed events without tz: UTC (Z form).

3.4 Recurrence: a Tide event with a series row (RRULE) exports as ONE
    VEVENT with RRULE:<recurrence_rule> verbatim, PLUS one
    RECURRENCE-ID override VEVENT per occurrence_overrides row that is
    NOT cancelled:
      - modified occurrence -> VEVENT with same UID, RECURRENCE-ID set
        to the ORIGINAL occurrence start, overridden DTSTART/DTEND/
        SUMMARY as stored.
      - cancelled occurrence -> VEVENT with same UID, RECURRENCE-ID,
        METHOD-free cancellation representation:
        STATUS:CANCELLED and SEQUENCE incremented (RFC 5545 §3.8.7.3;
        this is the interop-safe cancellation form accepted by Google/
        Apple/Outlook for file import).
    - The raw recurrence_rule string is stored Tide-side as RRULE
      grammar (DC-07); it is exported VERBATIM with NO validation or
      rewriting in v1. Validation of RRULE grammar is the writer's
      responsibility at event creation, not the exporter's. (Known
      limitation, accepted: an invalid stored RRULE produces an
      invalid VEVENT; importing consumer may drop it. Do NOT silently
      rewrite recurrence in the exporter.)

3.5 Reminders: NOT exported in v1. Rationale: Tide reminders are a
    collection-valued entity (DC-07 `reminders` table) with
    minutes_before semantics; .ics VALARM has different
    trigger/action/acknowledgement semantics, and per-spec §6 the
    reminder model is part of the domain, not the file format.
    Deferring keeps the exporter lossy-but-simple; a future contract
    (DC-19 candidate) defines VALARM mapping when reminders reach UI
    completeness.

3.6 UID stability: UID = Tide event_id, verbatim. Tide event_ids are
    stable across devices (Spec §6). Re-exporting the same calendar
    produces byte-identical UIDs, so re-import into a consumer
    deduplicates rather than duplicating.

3.7 Timestamps and SEQUENCE:
    - DTSTAMP: export time (UTC, Z form), REQUIRED by RFC 5545.
      NOTE: DTSTAMP differs per export run — this is correct and
      expected; UID+SEQUENCE carry identity, DTSTAMP carries
      generation time. Re-exports are NOT byte-identical overall
      (only UID-stable, see 3.6).
    - SEQUENCE: v1 exports SEQUENCE:0 on every VEVENT. Tide's
      updated_hlc is not a monotonic per-event edit counter
      transferable to consumers, and SEQUENCE only matters for
      update propagation via iTIP, which file export does not do.
      (Future iTIP/scheduling work would revisit this.)

3.8 Deletions: tombstoned events are NOT exported. An .ics file is a
    snapshot of LIVE calendar data. (Cancelled OCCURRENCES of a live
    series are exported as cancelled per 3.4 — that is data, not
    deletion.)

3.9 Conflicts: events with unresolved DC-03 conflicts export their
    LOCAL side (the state in this device's DB). Export never waits on
    or surfaces conflict state; it is a projection of local truth.

==================================================
4. EDGE CASES (normative)
==================================================

4.1 Empty calendar / no calendars: exporting "all" with zero live
    events produces a valid VCALENDAR with zero VEVENTs (not an
    error).

4.2 Events with missing/invalid UTC fields: export the event with
    whatever projection is possible; NEVER skip an event silently.
    If a required field (e.g. DTSTART basis) is absent, emit the
    VEVENT with a UTC epoch-0 DTSTART and a X-TIDE-ERROR property
    documenting the anomaly, so consumers see it and the file stays
    parseable. (Fail-visible, not fail-silent, not fail-hard.)

4.3 Character escaping: SUMMARY/DESCRIPTION MUST be RFC 5545 §3.3.11
    TEXT-escaped (backslash, semicolon, comma, newline). Unicode
    passes through as UTF-8. Folding: lines longer than 75 octets
    MUST be folded per §3.1.

4.4 Duplicate UIDs across calendars: event_ids are globally unique
    (DC-01/DC-07), so cross-calendar UID collision cannot occur.

4.5 Multi-calendar export: one VCALENDAR containing all events;
    each VEVENT may carry a non-standard X-TIDE-CALENDAR property
    (calendar title) for consumer-side grouping hints. Consumers
    ignore unknown X- properties (RFC 5545 §3.8.8.2) — safe.

==================================================
5. IMPLEMENTATION BOUNDARY
==================================================

- Exporter module: src/interop/ics_export.ts (new; "interop" per Spec
  §26 naming).
- Pure-function API: exportToIcs(input: ExportInput): string (or
  Uint8Array). No fs, no DB handle inside the module — the caller
  (Tauri command) reads the DB, builds ExportInput, saves the file.
- Tauri command: export_ics(scope, target_path) -> bytes written;
  NOT part of the sync_op allow-list (it is not a sync surface op;
  it gets its own typed command, mirroring the event-CRUD pattern).
- Dependency policy: prefer ZERO new runtime dependencies (hand-rolled
  RFC 5545 writer is small and fully testable; the format subset we
  emit is fixed). If a library is later preferred, it must be
  vendored/audited per project dependency rules and this contract
  amended.

==================================================
6. TESTING REQUIREMENTS (normative, block merge)
==================================================

Headless unit tests over the pure exporter (no GUI, no fs):
  T1  all-day inclusive->exclusive DTEND conversion (the §3.3 trap)
  T2  timed event with tz_id -> TZID + emitted VTIMEZONE
  T3  timed event without tz -> UTC Z form
  T4  RRULE exported verbatim; RECURRENCE-ID override VEVENTs;
      cancelled occurrence -> STATUS:CANCELLED form (§3.4)
  T5  TEXT escaping: backslash, semicolon, comma, newline in
      title/description (§4.3)
  T6  line folding at 75 octets with a multi-byte UTF-8 boundary
  T7  empty calendar -> valid empty VCALENDAR
  T8  anomaly event -> fail-visible X-TIDE-ERROR path (§4.2)
  T9  UID verbatim stability across two export runs
  T10 CRLF line endings throughout; file parses with a strict
      reference parser (property-order and folding respected)

Integration test: export a seeded DB through the real Tauri command
path (or its TS seam) and assert the resulting bytes round-trip into
a reference parser without errors.

Manual acceptance (owner): export the live app DB, import into
Google Calendar (web), Apple Calendar, and Outlook; events, all-day
conversions, and a recurring series with one modified + one cancelled
occurrence land correctly.

==================================================
7. NON-GOALS / FUTURE CONTRACTS
==================================================
- .ics import (needs dedupe/update semantics vs live DB — its own
  contract; NOT requested)
- CalDAV (explicitly skipped by owner)
- VALARM/reminders mapping (DC-19 candidate, see §3.5)
- iTIP/scheduling (SEQUENCE revisit, §3.7)
- Export UI visual design

==================================================
8. ACCEPTANCE
==================================================

This contract is APPROVED when the owner accepts: the §3 mapping
table, the all-day exclusive-DTEND rule, the recurrence/override/
cancellation representation, reminders-deferred (§3.5), and the
zero-dependency exporter stance (§5). Implementation follows only
after approval, per the standing workflow.
