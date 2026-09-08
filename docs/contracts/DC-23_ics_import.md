# TIDE DESIGN CONTRACT DC-23
# iCalendar (.ics) Import — Inbound Interoperability Semantics
Status: APPROVED by project owner (2026-09-08, implementation gate
        instruction). D1–D5 approved as amended below; implementation
        authorized subject to the §1.1 atomicity wording.

Depends on: DC-18 (.ics export — the inverse boundary, mapping table reuse);
            Spec v0.3 §6 (Calendar Domain), §26 (External Calendar Formats);
            DC-01 (change records); DC-07 (SQLite schema v7);
            DC-12 (recurrence, RRULE subset, occurrence overrides)
Unblocks: implementation of .ics import (menu entry "Import .ics…",
          placeholder already in the burger menu)
Out of scope: CalDAV (skipped by owner, 2026-08-25); .ics re-export of
              imported data (already covered by DC-18); recurring-event
              EXPANSION into individual events (import preserves series
              structure, §5.4); visual design of the import surface

==================================================
1. PURPOSE AND PRINCIPLE
==================================================

Defines the semantics of importing iCalendar (.ics, RFC 5545) files into
Tide. Import is the WRITE-side counterpart of DC-18's read-only export.

Binding principle (mirrors Spec §26, inverse direction): the file format
MUST NOT dictate the SQLite schema, revision model, vector clocks, or sync
protocol. Import is a CONTROLLED INGEST at the interoperability boundary:

    .ics bytes -> Parser (pure function) -> ImportPlan (pure data)
               -> Applier (domain core T1 writes, DC-01 change records)

The parser and planner are PURE functions (no fs, no DB, no callbacks, no
global mutable state, no Tauri dependency, deterministic). The applier is
the ONLY component that writes, and it writes exclusively through the
existing domain core (EventCore methods — no raw SQL) so every imported
entity lands atomically with its DC-01 change record and device-clock
advance — imported events are indistinguishable from locally-created ones
to sync peers.

1.1 Atomicity (binding wording, owner-corrected 2026-09-08):

    Plan-then-apply: the complete import plan is parsed and validated
    before mutation begins. During application, each entity is committed
    atomically through the domain core. If runtime/domain application of
    one entity fails, previously committed entities are not rolled back;
    the failure is reported and application continues.

    DC-23 therefore guarantees:
      - no mutation from an unvalidated/malformed plan
      - atomicity of each domain operation (one T1 per entity)
      - normal Tide change-record semantics
      - no raw-SQL partial entity writes
    It does NOT guarantee one giant database transaction covering the
    entire file. This is intentional.

1.2 Security posture: imported ICS is HOSTILE external input. The parser
    executes nothing, fetches nothing, touches no filesystem/network, and
    mutates no global state. Parsing is bounded (§10.2) so malformed or
    fuzzed input cannot cause uncontrolled resource use. The accepted
    grammar is exactly the §3.1 subset — widening it requires a contract
    change.

==================================================
2. IMPORT SURFACE AND TRIGGER
==================================================

2.1 Trigger: user-invoked only, via burger menu "Import .ics…" (the
    existing placeholder entry). No directory watching, no auto-import,
    no URL fetch in v1.

2.2 File selection: OS open dialog (tauri-plugin-dialog, already
    approved for DC-18). Single file per import run.

2.3 Destination: ALL events import into the shell-local calendar
    ("local") — v1 has exactly one calendar; DC-18 export already tags
    source calendars via X-TIDE-CALENDAR. A future multi-calendar Tide
    would revisit this (decision deferred, NOT fixed here).

2.4 Result surface: a completion report — counts of created / updated /
    skipped / failed entities, and the list of failed items with reasons
    (fail-visible, never silent). The report is shown in a message
    dialog and written to the app log.

==================================================
3. PARSING (normative)
==================================================

3.1 Parser scope: RFC 5545 core subset — VCALENDAR/VEVENT, DTSTART/
    DTEND (DATE and DATE-TIME, TZID params), SUMMARY, DESCRIPTION,
    UID, RRULE, RECURRENCE-ID, STATUS:CANCELLED, SEQUENCE, DTSTAMP.
    Out of parser scope (ignored, recorded in the report as skipped
    properties — never a parse failure): VTODO, VJOURNAL, VFREEBUSY,
    VALARM, ATTENDEE, ORGANIZER, EXDATE, RDATE, X- properties, unrecognized
    properties. Rationale: Tide's domain has no representation for them;
    ignoring-with-report is the honest projection.

3.2 Structural tolerance: parser MUST accept CRLF and bare-LF line
    endings on input (consumers in the wild emit both); folding per
    §3.1 must be unfolded before property parsing. A file that is not
    parseable AT ALL (no BEGIN:VEVENT found, malformed VCALENDAR) is a
    hard error with a precise reason — nothing is imported.

3.3 Duplicate UID inside ONE file: RFC 5545 violation. Parser keeps the
    FIRST occurrence, reports the duplicates as skipped (fail-visible).

3.4 Timezone handling: DTSTART;TZID=X resolves X against the IANA db
    (same rule as DC-18 §3.3): known zone -> stored as tz_id + wall +
    UTC columns (like any Tide event); unknown/absent zone -> UTC
    (Z form). VTIMEZONE blocks in the file are NOT parsed for rule data
    (we trust the IANA db; a file's embedded rules are advisory only) —
    a TZID that is not in our db falls back to UTC regardless of any
    embedded VTIMEZONE.

    D3 APPROVED: a TZID unknown to Tide's IANA timezone database falls
    back to UTC. The fallback MUST be visible in the import report.
    Embedded VTIMEZONE rules are not authoritative and MUST NOT override
    Tide's IANA database.

3.5 All-day events: DTSTART;VALUE=DATE with EXCLUSIVE DTEND — convert
    to Tide's INCLUSIVE end_date by subtracting one day (inverse of the
    DC-18 §3.3 normative conversion; MUST be tested with the same
    boundary cases: single-day, multi-day, month/year/leap edges).

==================================================
4. UID MATCHING AND DEDUPE (normative — D1/D2 APPROVED 2026-09-08)
==================================================

The event UID is the matching key against existing Tide events (DC-18
§3.6 chose UID = event_id verbatim to enable exactly this). Identity
resolution happens in the PLANNER, explicitly and completely, before any
application:

  Case A — UID matches a live Tide event_id  -> UPDATE through the normal
           domain update path (EventCore.updateEvent; D1 APPROVED). No
           duplicate, no silent skip, no validation bypass, normal change
           records.
  Case B — UID is a valid canonical Tide event_id (evt-<uuid>) with no
           matching event -> CREATE with that id.
  Case C — foreign UID (not canonical Tide shape), no matching event ->
           CREATE with a FRESH generated Tide event_id. The foreign UID
           is NOT persisted in Tide state in v1 (D2 APPROVED with
           explicit limitation): event_id stays canonical evt-<uuid> —
           external formats MUST NOT dictate Tide's identity/schema
           model. CONSEQUENCE (intentional, documented): repeated import
           of the same foreign-origin file creates duplicates.
           Future foreign-identity support is a SEPARATE mapping
           contract (provider/source + foreign_uid -> Tide event_id);
           it must NEVER widen or replace the canonical event_id, and no
           such schema change may be smuggled into DC-23.
  Case D — UID matches a tombstoned event / deleted series -> SKIP with
           report (never resurrect a tombstone from a file — that would
           fight DC-06 compaction and DC-12 §4.2 D7 series domination
           semantics).

  DC-18 round-trip identity remains intact: Tide event_id -> export ->
  UID -> import -> Case A -> UPDATE. D2 concerns only files from foreign
  systems whose UID is not a Tide id.

RATIONALE for update-not-duplicate (D1): re-importing an exported file
after a round-trip through another calendar application is the primary
use case; duplicate-on-match would silently duplicate the user's whole
calendar. The update path reuses existing domain validation (same rules
as update_event).

4.5 Series (VEVENT with RRULE):
    - UID not in DB -> create base event + series row with the rule
      VERBATIM through createEvent's recurrenceRule path (which runs the
      DC-12 §2.1 validator). A rule using keys outside our subset
      (BYMONTHDAY, WKST, FREQ=SECONDLY/MINUTELY/HOURLY, …) FAILS
      VALIDATION: the event imports as a NON-recurring single event on
      its DTSTART (lossy-but-visible: the report states "recurrence
      simplified"), never a silent rewrite of the rule, never a silent
      drop, and the DC-12 validator is NOT weakened (D4 APPROVED).
    - UID exists as a series base -> update rule via updateSeriesRule
      (its own conflict entity per DC-12 §3), update base fields via
      updateEvent.
  4.6 RECURRENCE-ID override VEVENTs: apply through updateOccurrence —
      cancelled (STATUS:CANCELLED) -> cancelled: true; otherwise apply
      title/start/end as the override. The override's effective times
      are resolved in the BASE event's tz (matches DC-18 export
      behavior). Overrides referencing a series that was skipped/failed
      are skipped with reason.
  4.7 Ordering: series bases BEFORE their overrides regardless of file
      order (two-pass plan: bases first, overrides second).

==================================================
5. WRITE PATH AND ATOMICITY
==================================================

5.1 Plan-then-apply (§1.1 binding wording): the complete import plan is
    parsed and validated BEFORE mutation begins; the applier then
    executes it entity-by-entity through the domain core (each entity
    its own T1, exactly like interactive edits).

5.2 Partial failure: if runtime/domain application of one entity fails,
    previously committed entities are NOT rolled back; the failure is
    reported and application continues. The final report is the truth
    surface. DC-23 does NOT guarantee one giant transaction covering the
    entire file — intentional (§1.1).

5.3 No file is ever modified by the importer. Read-only on the source.

5.4 No expansion: a series imports as ONE base + rule + overrides.
    Generating concrete occurrences remains the render-time job it
    already is (DC-12).

5.5 Reminders: VALARM is ignored (DC-18 §3.5 symmetry — reminders are a
    domain entity, not a file-format concern).

==================================================
6. IMPLEMENTATION BOUNDARY
==================================================

- Parser/planner: src/interop/ics_import.ts (new; mirrors DC-18 §5
  naming). Pure functions: parseIcs(text: string): ParseResult and
  planImport(parsed, existing): ImportPlan. No fs, no DB.
- Applier: applyImportPlan(core: EventCore, plan: ImportPlan):
  ImportReport — lives in the SAME module but is the only DB-touching
  part; it calls EventCore methods only (no raw SQL), guaranteeing
  change records / vector clocks / validation ride the existing paths.
- Sidecar op: import_ics { ics_text } -> ImportReport. The file read
  happens in the shell (Tauri command reads the chosen file, passes the
  TEXT to the sidecar — the sidecar stays fs-free; DC-18 pattern).
- Tauri command: import_ics(source_path) -> report JSON (reads file,
  calls sidecar, returns report). Not in sync_op ALLOWED (own typed
  command, DC-18 §5 pattern).
- Frontend: burger-menu "Import .ics…" entry enabled; open dialog
  (plugin-dialog, approved); result report in a message dialog.
- Dependency policy: ZERO new runtime dependencies — hand-rolled parser
  for the §3.1 subset (the format subset we ACCEPT is fixed and small;
  a full RFC 5545 parser is out of scope per §3.1).

==================================================
7. TESTING REQUIREMENTS (normative, block merge)
==================================================

Headless unit tests over parser/planner (no fs, no DB):
  T1  all-day EXCLUSIVE DTEND -> INCLUSIVE end_date (round-trip of
      DC-18 T1; single-day, multi-day, month/year/leap boundaries)
  T2  TZID known -> tz_id + wall + UTC columns; unknown TZID -> UTC
      fallback (D3)
  T3  RRULE inside our subset -> verbatim rule planned; outside subset
      -> recurrence-simplified plan + report entry (D4)
  T4  RECURRENCE-ID override: modified + cancelled forms planned
      correctly, including overrides-before-bases file order (§4.7)
  T5  TEXT unescaping: backslash, semicolon, comma, \n (inverse of
      DC-18 T5)
  T6  unfolding of folded lines (multi-byte UTF-8 boundary) + bare-LF
      tolerance (§3.2)
  T7  non-VEVENT components (VTODO etc.) ignored with report entry;
      no VEVENTs at all -> hard error (§3.2)
  T8  duplicate UIDs in one file -> first wins, rest skipped (§3.3)
  T9  malformed property lines -> skip-with-report, never crash
  T10 plan determinism: same input -> identical plan (pure function)

Integration tests (real EventCore, temp DB):
  I1  import into empty DB -> events/series/overrides created through
      createLocalChange (change records exist, entity_versions advance)
  I2  re-import same file (D2b consequence): DUPLICATES — asserted
      explicitly as the documented v1 limitation
  I3  import after export (round-trip): export a seeded DB, import the
      bytes into a fresh DB -> same events/series/overrides (modulo
      D2 ids)
  I4  tombstone match -> skip-with-report (§4.3)
  I5  domain-validation failure mid-apply -> partial apply + failed
      entry in report (§5.2)

Manual acceptance (owner): export live DB, import into Google Calendar,
re-export from Google, import that file into Tide — events, all-day
conversions, and a recurring series with one modified + one cancelled
occurrence land correctly. (Mirrors DC-18's gate in the inverse
direction.)

==================================================
8. OWNER DECISIONS — ALL APPROVED (2026-09-08)
==================================================

  D1  APPROVED: UID match -> UPDATE through the normal domain update
      path (not skip/duplicate). §4 Case A.
  D2  APPROVED: foreign UID -> fresh Tide event_id, NO foreign-UID
      persistence in v1; re-import of the same foreign file duplicates
      (documented limitation). Tide's canonical event_id remains
      unchanged and is not widened to arbitrary external UIDs; future
      external-identity mapping is separate contract work and MUST NOT
      replace or weaken Tide's canonical identity model. §4 Case C.
  D3  APPROVED: unknown TZID -> UTC fallback, report-visible; embedded
      VTIMEZONE rules not authoritative. §3.4.
  D4  APPROVED: unsupported RRULE -> non-recurring single event +
      visible report entry (lossy-but-visible); no validator weakening,
      no partial recurrence interpretation. §4.5.
  D5  APPROVED: destination = `local` calendar; no calendar-routing
      heuristics. §2.3.

==================================================
9. NON-GOALS / FUTURE CONTRACTS
==================================================

- Multi-calendar import routing (needs multi-calendar Tide first)
- Foreign-UID persistence (D2a) — its own schema-domain line
- VALARM -> reminders mapping (same DC-19-candidate as DC-18 §3.5)
- Directory watching / auto-import / URL fetch
- CalDAV (skipped by owner, 2026-08-25)

==================================================
10. ACCEPTANCE
==================================================

APPROVED 2026-09-08 (owner implementation-gate instruction): §3 parsing
scope, §4 dedupe semantics (D1–D2), §3.4/D3 timezone fallback, §4.5/D4
recurrence-simplification rule, §1.1/§5 corrected atomicity semantics,
and the zero-dependency parser stance (§6). Implementation authorized.
