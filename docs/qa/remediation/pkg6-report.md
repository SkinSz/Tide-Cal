# Package 6 — Hygiene Sweep Report

Date: 2026-08-30 · Agent: Pkg6 implementation · Base: HEAD 0af8fed (Pkg1–5b landed)
Status: **COMPLETE** — all 8 bounded items implemented, verified, left uncommitted for lead review.
Verification: `npx tsc --noEmit` exit 0; focused suites green (below); FULL SUITE **550 passed / 4 failed of 554** — every remaining failure documented (§ Final baseline).

---

## Item 1 — F-1 (QA-2): spurious authoritative calendar change per restart

**What changed** — `src/persistence/bridges/event_core.ts` `ensureDefaultCalendar()`: the
default-calendar T1 bootstrap (`createLocalChange` → `createLocalChange` route) now runs ONLY
when the `calendars` row for `local` is MISSING. An existing row (local or synced) is untouched:
no change record, no device_clock advance, no `updated_hlc` churn.

This closes the QA-2 s5_cycles finding (`changes_delta=1` per restart) and removes the latent
LWW data-loss trap: once calendar rename ships, the old code would have re-asserted
`title='My Calendar'` over a peer-renamed calendar on every sidecar restart.

**Test** — `tests/pkg6_hygiene.test.ts` item 1: (a) open same DB twice → change count
identical after 2nd open + calendar `updated_hlc` unchanged (was +1 per restart);
(b) latent-trap variant: user-renamed calendar survives restart without a new default-title
change record (calendar change-record count stays 1).

## Item 2 — pkg1-review H1 residual: CALENDAR snapshot loop over-inclusive

**What changed** — `src/sync/full_state.ts` `buildSnapshot()`: the calendar loop no longer
`continue`s when `latestProducer()` returns undefined. It now uses the same `_unversioned`
placeholder pattern as the events loop (`producer_device_id: "_unversioned"`,
`producer_seq: 0`), so a calendar row whose version state is missing (pre-v6-migration row,
or version state lost to compaction) still rides the snapshot and a fresh peer can never be
stranded without its calendar. Over-inclusion is benign (receiver §7.1 reconciles);
under-inclusion silently strands data.

**Test** — `tests/pkg6_hygiene.test.ts` item 2 (version-less calendar rides as
`_unversioned`); updated existing `tests/full_state.test.ts` TR-7.1/H-2 to the new contract
(6 entries = 5 events + 1 calendar with `_unversioned` placeholder — an intended,
documented behavior change of this package).

## Item 3 — BND-06: list_series allow-list drift → IMPLEMENTED (not removed)

**Decision + evidence** — grep before choosing:
- `src-tauri/src/lib.rs:131` — `list_series` in `sync_op` ALLOWED (the drift).
- `frontend/store.ts:151` — **the desktop frontend actively calls it**
  (`invoke<SeriesRow[]>("list_series")` inside `listSeries()`, with a per-call
  catch-fallback that renders no indicators).
- `src/persistence/bridges/event_core.ts` — `listSeries()` already implemented as a pure
  read-only SELECT over `series` + `occurrence_overrides` (DC-12 §2).
- `tests/recurrence_ui.test.ts` — covers the fallback path when the op is unavailable.

Removal was the instruction's preference **conditioned on nothing calling it** — the grep
refutes that precondition (removal would permanently disable the desktop recurrence
indicator decoration). Implementing was therefore chosen: it is a pure read-only SELECT
(trivially listable per DC-07/DC-12 §2), no args, no change records, no mutation.

**What changed** — `src/persistence/bridges/sidecar_server.ts` `makeDispatcher()`: new
`case "list_series": return core.listSeries();`. Routing verified: `list_series` does not
match the sync-dispatcher predicate (sidecar_server.ts `combined` router) and is already in
lib.rs `ALLOWED`, so Tauri → proxy → core dispatcher is now wired end-to-end.

**Test** — `tests/pkg6_hygiene.test.ts` item 3: dispatcher answers `list_series` ok:true with
an array, zero change records written (read-only).

## Item 4 — pkg2 test harness: response correlation by request id

**What changed** — `tests/pkg2_identity.test.ts` `runSidecar()` (tests only): the sidecar
answers asynchronously and responses can arrive out of order; the helper previously assumed
arrival order (`responses[i]` ↔ request i). It now correlates each response by its `id`
field, resolves when all request ids are answered, and returns responses ordered by the
requests' ids so every call-site index assertion keeps its meaning. Missing/never-answered
ids throw explicitly. Call sites unchanged.

**Test** — `tests/pkg2_identity.test.ts` 12/12 pass (incl. the raw-stdio battery and
restart persistence).

## Item 5 — F-5 (QA MINOR): re-quarantine after frontier advance

**What changed** — `src/persistence/database.ts` `quarantineRecord()`: before inserting, the
durable quarantine table is consulted for an existing row with the same
`(device_id, local_seq)` extracted via `json_extract` from its verbatim `raw_record`
(verified available in the bundled SQLite). A match suppresses the insert — TD-001's "never
create a second quarantine row" now holds across frontier advance (previously only the
skipped_seqs row guarded this, and that row is GC'd once the frontier advances past the
seq — the exact F-5 hole). Chosen over retaining skip rows across frontier advance because
it is the smaller change and keeps the TD-001 (4)/(8) frontier-GC semantics untouched. The
(device, seq) pair uniquely identifies a record (change_id = (device, seq)), so two
DIFFERENT invalid records can never collide on it. Callers' skip-row/misbehavior/stat
bookkeeping unchanged (diagnostic-only suppression).

**Result** — closes documented known-failure SC6 ("expected 2 to be 1"):
`npx vitest run qa-tmp/probes/sc5_snap_quar_restart.qa.test.ts -t "SC6"` → **1 passed**.
Tests: DB-level dedupe (`tests/pkg6_hygiene.test.ts` item 5, incl. engine-level
re-delivery-after-frontier-advance across two sessions → exactly 1 row).

## Item 6 — F-6 (QA-1): zombie pending_changes GC

**What changed** — `src/sync/sync_engine.ts`: new `gcZombiePending()` deletes every
`pending_changes` row whose `local_seq <= applied_upto[producer]` (rows above the frontier
and rows for producers with no frontier row are untouched — those are legitimately
buffered). The TD-001 F3 cleanup covered only the snapshot path; this extends the drain to
the abort case: a session aborted mid-transfer leaves buffered rows the frontier has
already passed, which can never drain (re-delivery classifies as duplicate). Runs at
engine construction (restart case) and at each session start (long-lived engines whose
frontier advanced past a buffered seq mid-life); the in-memory knowledge mirror is
refreshed only when rows were actually deleted.

**Test** — `tests/pkg6_hygiene.test.ts` item 6 (zombie at/below frontier removed; legit
buffered row above the frontier and no-frontier rows kept). Regression SC7's
`pendingB === 0` assertion now passes deterministically (both probe copies below).

## Item 7 — month_view_clicks date-flake (test-only)

**What changed** — `tests/month_view_clicks.test.ts`:
1. `evt()` anchors events to TODAY with the day-of-month CLAMPED
   (`min(today, daysInMonth-1) + dayOffset`), so `dayOffset=1` can never walk into the next
   month (the documented month-boundary flake: "expected 1 to be 2").
2. `beforeEach` resets `setViewMode("month")` — the calendar module keeps `viewMode` as
   module state and the week-view test leaked "week" into the chip-exclusivity test, which
   also produces "expected 1 to be 2" independent of the date.

Test-only change; the product code is untouched. 7/7 pass.

## Item 8 — P11 anomaly signal: HELLO clock anomaly (pkg5b-review §3/§6-A)

**What changed** — `src/sync/sync_engine.ts`: at HELLO processing, if a peer advertises a
clock component for OUR device id GREATER than our own `device_clock[self]` (impossible
under honest operation per DC-02 §4.1 — only our own T1 writes advance it; indicates
identity theft or a non-conformant same-id restore), the engine now:
- logs a `[tide][health] HELLO clock anomaly` warning,
- increments a process-lifetime counter (`getHelloClockAnomalyCount()`),
- sets `stats.helloClockAnomaly = true` (new optional `SessionStats` field).

**Documented as a HEALTH CUE, not enforcement**: the misbehavior ladder is deliberately
NOT fed (an anomalous HELLO is not a record arrival), no clock merge is skipped
(element-wise MAX makes inflation harmless — pkg5b-review §4.3), no session is terminated.
Tests: anomalous HELLO → flag + counter increment + `[tide][health]` warning + zero
`hard_blocks` rows; honest HELLO → no flag, count unchanged.

---

## Test harness / probe fixes carried in this package

- `qa-tmp/probes/sc5_snap_quar_restart.qa.test.ts` — SC7 per-test assertion timeout 5s →
  180s (QA harness artifact fix, justified by pkg4-review/pkg5b-review §5: the probe's own
  runtime is ~45 s of legitimate abort/restart cycles; verified PASS in qa-review5c-tmp).
- `qa-review5c-tmp/sc7-long.probe.test.ts` — fixed the pre-existing broken dynamic import
  (`./helpers.ts` → `../qa-tmp/probes/helpers.ts`); the file previously errored at load.
- Skip-note dispositions (left failing, documented; per instruction "your choice") added to:
  `qa-review5-tmp/qa5_probe11.test.ts` (P11), `qa-review5-tmp/qa5_probes.test.ts` (P9),
  `qa-tmp/probes/sc_repro.qa.test.ts` (SC2 x5), `qa-tmp/probes/sc1_baseline.qa.test.ts` (SC2),
  `qa-tmp/probes/sc7_abort_sc8_three.qa.test.ts` (SC8). All four assert implicit-LWW /
  stale-overwrite convergence semantics that Pkg5/DC-03 §3.3/§3.4 replaced; the divergences
  are conflict-backed (pkg5b-review §5). Disposition: observe-only pending owner action.

## Verification

- `npx tsc --noEmit` → **exit 0**.
- Focused: `npx vitest run tests/pkg6_hygiene.test.ts` → **9/9 pass, exit 0**.
- `tests/month_view_clicks.test.ts` → **7/7 pass** (standing failure closed).
- `tests/pkg2_identity.test.ts` → **12/12 pass** (helper fix verified over raw stdio).
- `qa-tmp/probes/sc5_snap_quar_restart.qa.test.ts -t SC6` → **1 passed** (SC6 closes);
  `-t SC7` → **1 passed in 45.5 s** under the 180 s cap.
- `tests/full_state.test.ts` → 9/9 (TR-7.1 updated for the intended over-inclusion).
- FULL SUITE (`npx vitest run`): **Tests 550 passed | 4 failed (554)** across 60 files.

## Final full-suite baseline state (every remaining failure explained)

| Failure | Classification |
|---|---|
| `qa-review5-tmp/qa5_probes.test.ts` P9 session-level | Asserts implicit-LWW row convergence replaced by Pkg5/DC-03 §3.3; divergence conflict-backed (pkg5b-review §5). Skip-noted; observe-only, owner item. |
| `qa-review5-tmp/qa5_probe11.test.ts` P11 | Asserts stale-causal-before overwrite semantics replaced by DC-03 §3.3 (owner item, pkg5-review §6.1). Skip-noted. |
| `qa-tmp/probes/sc7_abort_sc8_three.qa.test.ts` SC8 | Asserts same-row-everywhere LWW convergence; delete-vs-edit now leaves unresolved conflict rows on all 3 devices (verified NOT data loss). Skip-noted. |
| `qa-tmp/probes/sc_repro.qa.test.ts` SC2 ×5 | Asserts implicit-LWW convergence replaced by DC-03 §3.3 conflict semantics; divergence conflict-backed (pkg5 tests pin per-device divergence). Skip-noted. |

Month_view (2 standing failures incl. the documented date-flake) and SC6 now PASS; SC7
passes under its 180 s assertion timeout (~45 s actual). No unexplained failures.

## Out-of-scope (not touched, per instruction)

- pkg2 runSidecar response-ORDERING beyond the id-correlation fix (done as the assigned
  test-harness item; no further harness rework), derivedScheduleColumns dead clamps,
  list_events from>to laxity, any architecture/refactor.
