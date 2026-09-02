# pkg8 — BLIND adversarial review: recurrence wave (TD-014 / TD-015 / TD-016)

Reviewer: Hermes subagent, 2026-09-02. Scope: uncommitted diff in /home/skins/tide
(src/domain/recurrence_conflicts.ts, frontend/dialog.ts, frontend/recurrence_edit.ts,
tests/td014_expansion.test.ts, tests/recurrence_uncheck.test.ts,
tests/td015_override_identity.test.ts). pkg7 files (sync_engine.ts,
full_state_triggers.test.ts, pkg7-review.md, td014_red_probe.mjs) excluded per brief.

## Verdict

**UNSOUND** — one blocking finding (F1): the TD-016 uncheck+Save path, when the
dialog is opened on any occurrence chip OTHER than the series' first occurrence,
rewrites the base event's start to the chip's date via `updateEvent(id, input)`.
Expansion is anchored to the base start, so every occurrence BEFORE the edit
point silently disappears from the calendar. This directly violates the binding
owner decision in TD-016 ("all past occurrences remain on the calendar
untouched") on what is arguably the main path (editing a later occurrence).
TD-014 expansion semantics and TD-015 identity handling are sound; all three
suites and tsc pass.

## Test results

| COMMAND | EXIT STATUS |
|---|---|
| `npx vitest run tests/td014_expansion.test.ts` | 0 (11 passed) |
| `npx vitest run tests/recurrence_uncheck.test.ts` | 0 (5 passed) |
| `npx vitest run tests/td015_override_identity.test.ts` | 0 (2 passed) |
| `npx tsc --noEmit` | 0 (clean) |

Note: the task brief said td014_expansion.test.ts has 17 tests; the file
contains 11. No functional impact, but the discrepancy is unexplained.

## Findings

### F1 — TD-016: uncheck+Save on a non-first occurrence chip destroys all earlier occurrences (severity 9, BLOCKING)

`frontend/dialog.ts:659-674` (Save handler, `!repeatOn() && !occurrenceScope()` branch):

```ts
await updateEvent(id, input);
const until = deriveRecurrenceId(existing.startMs, existing.allDay).slice(0, 8);
```

`input` is built by `readInput()` (`frontend/dialog.ts:495-529`), whose date
comes from `ev-date`, seeded at open time with the CHIP's start
(`frontend/dialog.ts:448`: `field("ev-date").value = toDateInput(existing.startMs)`).
`updateEvent` writes the full base event (`frontend/store.ts:324-345`), i.e. the
series base's `startMs` is moved to the edited chip's date. Since
`expandOccurrences` steps from the base (`src/domain/recurrence_conflicts.ts:161`
DAILY: `base.getTime() + step*86_400_000`; WEEKLY/MONTHLY likewise anchor at
`base`), every occurrence before the new base date is no longer generated.

Reproduction (analytical, deterministic): `FREQ=DAILY;UNTIL=20261231`, base
2026-09-02 10:00. Open the dialog on the 2026-10-01 chip, uncheck Repeat, Save.
Result: base start → 2026-10-01, rule UNTIL → 20261001. Expansion now yields
exactly one occurrence (2026-10-01). All September occurrences are gone —
silent data loss, no confirm, no tombstone. Violates the binding owner decision
(docs/technical-debt.md TD-016, 2026-09-02): "all past occurrences remain on
the calendar untouched".

Secondary defect in the same lines: `until` is derived from the chip's
(possibly MOVED) `existing.startMs`, contradicting the code's own comment
("the edited occurrence's ORIGINAL start date") and DC-12 §2.3 — it should be
`dialogOccurrenceId.slice(0, 8)` when chip meta is present. For a moved chip
the UNTIL lands on the moved date, not the original occurrence date.

The fix direction: on this path, do NOT change the base start (or preserve the
chain differently); and derive UNTIL from the original occurrence id.

### F2 — TD-016 test suite never exercises the F1 path (severity 7)

`tests/recurrence_uncheck.test.ts:257-265` opens the dialog on the series BASE
event (`openSeriesDialog` dispatches `tide:eventclick` with the base event, whose
start IS the first occurrence). So "rule UNTIL = edited occurrence's original
start" (`:295`), "past occurrences remain intact" (`:313`) and "the edited
occurrence survives" (`:349`) all pass trivially: the edit point equals the
base day, and `updateEvent`'s start rewrite is a no-op. The five tests pin the
no-delete / no-tombstone property genuinely, but the destructive F1 scenario
(chip ≠ first occurrence, or moved chip) is untested. The whole-series-delete
two-step test (`:373`) is real and good.

### F3 — TD-014: MONTHLY rules with COUNT are silently truncated by the day-unit hardCap (severity 4)

`src/domain/recurrence_conflicts.ts:216-217`: the MONTHLY loop breaks when
`d.getTime() - base.getTime() > hardCap * 86_400_000` — i.e. ~10 000 days ≈ 329
months. A rule `FREQ=MONTHLY;COUNT=500` emits only ~329 occurrences: COUNT is
an RFC 5545 total-occurrence bound with NO time span, so the hardCap (a hang
guard for open-ended rules) must not apply when `rule.count` is set. Same shape
in WEEKLY (≈1 428 weeks — only bites for COUNT > ~1 400) and DAILY (exact
parity, benign). Not a hang; a correctness deviation. Fix: skip the hardCap
break when `rule.count !== null` (COUNT itself already bounds the loop).

### F4 — terminateRuleAt can EXTEND a series past an earlier existing UNTIL (severity 4)

`frontend/recurrence_edit.ts:137-139`: the helper strips ANY existing UNTIL and
appends the new (later) date. The docblock claims "the earliest terminating
bound wins", but the code implements the opposite when the new UNTIL is later
(e.g. existing `UNTIL=20260601`, edit point 2026-09-02 → rule re-extends over
Jun–Aug, resurrecting occurrence dates that had already ended). The correct
owner-decision behavior for "end recurrence here" is
`UNTIL = min(existing UNTIL, edit-point date)`. Low practical frequency (the
mandatory-UNTIL builder makes later-UNTIL rules rare) but it is a silent
re-expansion, so it belongs on the list.

### F5 — TD-015 identity: sound; staleness analysis (severity 2, informational)

`frontend/dialog.ts:443` captures `occurrenceOf(existing)?.recurrenceId` at open
(the WeakMap meta is keyed at the occurrence's ORIGINAL start per
`frontend/calendar.ts:209-216`), and both the override Save path (`:689-692`)
and the occurrence-cancel path (`:749-752`) use it with a correct
`deriveRecurrenceId(existing.startMs)` fallback for base events. Invalidation is
correct: every `openFor` re-captures (different chip → new id; new-event flow →
null; base-event fallback → null meta → derive). Staleness: a rule edit between
open and save cannot happen in the modal flow (single user, no re-render path
writes the rule while the dialog is open); if it did, writing an override under
the captured rid produces exactly the R1-orphan outcome DC-12 §2.4 declares
accepted. Cancelled-after-open: re-writing `cancelled: true` on the same rid is
idempotent and R2-conformant. The two tests in
tests/td015_override_identity.test.ts genuinely pin the moved-chip
edit-after-move and delete-after-move cases (no phantom override keyed at the
moved wall time). No defect found.

### F6 — TD-014 expansion conformance: no wrong-occurrence case found (severity 2, informational)

Adversarial cases checked against `src/domain/recurrence_conflicts.ts:147-233`:

- DAILY day-stepping (`:160-168`): exact `interval`-day multiples from base;
  UNTIL check precedes emit (UNTIL-inclusive via `dateOnlyId(d) > until`);
  hardCap-break guard (`step > 0`) prevents a zero-iteration anomaly. Sound.
- WEEKLY (`:170-201`): MO-first week index `Math.floor((t/86_400_000 − 4)/7)`
  is correct for negative epoch times (pre-1970 bases); weeks iterate in
  `interval` multiples from the base's own MO-week (WKST=MO default, RFC
  5545); empty BYDAY → base weekday (`:174`); pre-base candidates in the
  anchor week are skipped WITHOUT counting toward COUNT (`:196`, correct);
  the mid-week `break` on UNTIL (`:198`) is safe because `offsets` is sorted
  ascending — every later candidate in the week is also > UNTIL, and the
  outer loop's week-start check then terminates. No hang (outer loop bounded
  by week-start UNTIL check and the hardCap week check `:194`).
- MONTHLY (`:204-221`): `Date.UTC(y, m+mi, 1, h, mm, ss)` then
  `setUTCDate(dayOfMonth)` with the `d.getUTCDate() !== dayOfMonth` guard
  correctly skips short months (Feb 30 → Mar 2 rollover is detected and
  discarded, never folded); skipped months do not count toward COUNT (RFC
  5545); loop always terminates (UNTIL break, hardCap break, or emit/COUNT
  break — `continue` on short months cannot skip past both bounds because
  both are re-checked every iteration and `mi` strictly increases).
- COUNT counts emitted occurrences only (`emit` at `:152-156` increments
  `generated` after the pre-base skip; window filtering does not consume
  COUNT — matches "COUNT bounds total generation, window is display-only").
- Wall-clock/INVARIANT 9: all arithmetic is on UTC calendar fields
  (`getUTC*`, `Date.UTC`, epoch-day math); no tz conversion, no fixed-offset
  DST hazard. Per the brief this is correct by design.
- Residual limitation (pre-existing, not a regression): MONTHLY BYDAY/BYSETPOS
  are parsed but ignored (expansion uses base day-of-month only); parseRule
  filters invalid BYDAY tokens so `offsets` can never be empty enough to hang
  the WEEKLY loop. Ordinal BYDAY forms ("1MO") are filtered out by
  `parseRule` (`:50-53`) and cannot reach the expander.

### F7 — Old delete behavior fully removed from the uncheck path; no surviving path found (severity 2, informational)

`deleteEvent` is now reachable only from the explicit two-step `ev-delete`
handler (`frontend/dialog.ts:726-774`); the `ev-repeat` NONE option is disabled
inside the builder (`:292`) and the checkbox-uncheck listener only clears the
draft (`:566-571`). Occurrence-scope uncheck is impossible: the TD-016 branch
requires `!occurrenceScope()`; occurrence-scope Save goes to `updateOccurrence`.
The only residual concern is F1's start rewrite, not a delete.

### F8 — No interference with the pkg7 package (severity 1, informational)

The new tests import only `frontend/calendar.ts`, `frontend/dialog.ts`,
`frontend/store.ts` types and `src/domain/recurrence_conflicts.ts`; they do not
touch `src/sync/sync_engine.ts` or `tests/full_state_triggers.test.ts`, and no
DOM/store globals leak beyond the file-scoped beforeEach/afterEach restore
(`tests/recurrence_uncheck.test.ts:246-256`, same pattern in the TD-015 file).
Repo files were not modified during this review (except this report).

## Summary

- TD-014 expansion rewrite: correct per RFC 5545 for the supported subset;
  no hang construct found; F3 is the only conformance gap (COUNT+MONTHLY
  truncation).
- TD-015: sound, well-tested.
- TD-016: mechanism (updateEvent + terminateRuleAt, never delete) matches the
  binding owner decision EXCEPT on non-first-occurrence chips, where the base
  start rewrite erases past occurrences (F1, blocking) and the UNTIL date can
  come from a moved start (F1 secondary). Tests pass but never cover that case
  (F2).
