# Pkg1 Independent Review — Compaction × Snapshot (QA C-1)

**Verdict: PASS** (two non-blocking notes, see §6)

Worktree: `/tmp/tide-remediation`, branch `remediation`, uncommitted diff
(`src/persistence/{database,schema}.ts`, `src/sync/{full_state,sync_engine}.ts`, + new tests).
Review date: 2026-08-30. This review is READ-ONLY on production code; all probes live under
`qa-review-tmp/probes2/` and `qa-review-tmp/gen/`. The implementer narrative
(`pkg1-report.md`) was **not** read.

---

## 1. Context: this file completes a prior reviewer's interrupted pass

A previous independent reviewer produced a pre-falsification assessment
(`qa-review-tmp/INDEPENDENT-ASSESSMENT.md`) and ran 12 adversarial probes, **all of which
PASSED**: double compaction, compaction on both peers, restart-mid-cycle, fresh-peer
bootstrap, 3+ peers, update/delete after compaction, compaction between sync rounds, and
race-ordering coverage. That session ended before completing four remaining checks (A–D)
and writing this verdict. Sections 2–5 below are the completing work; §1 summarizes the
prior reviewer's assessment as given context.

Prior reviewer's independent defect derivation (written before reading the implementer's
report): DC-06 `sweep()` deletes `changes` rows whose version vector + latest-producer
identity were derivable **only** by aggregating those rows, so post-compaction live
entities collapsed to an empty clock → buildSnapshot skipped them (receiver's applied_upto
advanced past them → permanently stranded), and the reverse stream direction hit the
vacuous `dominates(snapshot_clock, {})` → own live events tombstoned. Compaction changed
the REPRESENTATION of history but not-preserved its SEMANTIC state — "convergence to data
loss (fingerprints equal, both empty) — agreement is not correctness."

Prior reviewer's hypotheses: H1 calendar asymmetry in buildSnapshot, H2 backfill
short-vector, H3 GAP_ROUNDS liveness, H4 absence-rule weakening, H5 T1/T2 + migration
atomicity, H6 test-oracle coverage. (H2/H3 were within the scope of the 12 passed probes;
this pass completes H1, H5, H6, and H4.)

---

## 2. CHECK A (H1) — calendar asymmetry in buildSnapshot after migration

**Code fact:** the CALENDAR loop in `buildSnapshot` (full_state.ts) still retains
`if (winner === undefined) continue;` while the events loop was made over-inclusive
(`"_unversioned"` placeholder). A calendar with no `entity_versions` row and no surviving
change records is omitted from snapshots.

**Reachability of the trigger state** (calendar history fully swept before the v5→v6
migration): the migration backfill (`backfillEntityVersions`) copies version vectors from
surviving change history only. If the calendar's changes were all swept pre-migration,
**no backfilled row is created** — confirmed empirically.

**Probe** (`qa-review-tmp/probes2/gen_v5.test.ts` "gen-A", run with the fix stashed so
`SCHEMA_VERSION=5`): device A bootstraps calendar `local`, renames it to
`"Work Calendar"` via a real T1 change (5 change records total), then a real DC-06
`sweep()` with a constraint peer that provably knows every record deletes **all 5** —
leaving the live calendar row, 3 live events, `schema_version=5`, zero change records.
(`qa-review-tmp/probes2/check_a_d.test.ts` "CHECK-A", run with the fix restored:)

- Reopen with `openDatabase` (plain, so the EventCore bootstrap can't mask the
  condition): migrates to v6, `entity_versions` rows = **0** (nothing to backfill).
- `buildSnapshot` output: **0 calendar entries, 3 event entries** — events ride as
  `_unversioned`, the calendar is omitted. H1 asymmetry **confirmed at snapshot level**.
- Fresh peer B (pure v6 EventCore device) syncs with A: B receives all 3 events. B's own
  bootstrap record (`local`/"My Calendar", T2 path on A) **re-creates A's calendar
  version state mid-session**; A's calendar becomes snapshot-eligible again and B
  converged to A's `"Work Calendar"`. Both peers ended on `"Work Calendar"` — **no data
  loss, correct convergence**.

**Why exposure is bounded (severity: LOW):**

1. **Self-healing:** any inbound calendar change record (T2 `applyRemoteChange` →
   `recordEntityVersion`) restores the version row, after which the calendar is included
   in snapshots again. In the probe this happened within the first session.
2. **Production open path heals immediately:** `EventCore`'s constructor runs
   `ensureDefaultCalendar()` → `createLocalChange` **on every open** (no dedup), so the
   app's first start after the migration re-writes a calendar change record + version row
   before any sync occurs. The raw-`openDatabase` exposure window is not the app's
   normal path.
3. **The only calendar is `local`** (`DEFAULT_CALENDAR_ID = "local"`, a shared constant;
   no production path creates other calendars): a fresh peer always bootstraps its own
   row, so a "missing calendar" in the stranded-data sense cannot occur — worst case is
   transient title/color metadata divergence that the next session corrects.
4. `sweep()` has **no production caller today** (only the harness and the scheduler's
   unused `{action:"sweep"}` tick), and the WIPE ACCEPTABLE data-safety decision is on
   file for the pre-release path.

**Residual (non-blocking) note:** the loop asymmetry is real code inconsistency. Making
the calendar loop over-inclusive exactly like the events loop would close it entirely.
Track as a small follow-up, not a blocker.

---

## 3. CHECK B (H5) — migration atomicity under kill -9

**Method** (`qa-review-tmp/probes2/{gen_v5.test.ts,open_once.ts,kill_runner.mjs}`):
two synthetic v5 template DBs (60,000 events + 60,004 change records + device_clock, bulk
SQL under baseline code — data provenance is irrelevant to the migration code path; size
makes the backfill window long enough for 0–25 ms kills). A bundled child process
(esbuild, fix code) prints `READY`, waits for a stdin `go` handshake (so timing starts at
a known point, past module load), then calls `openDatabase()` — which runs the
v5→v6 migration. Parent SIGKILLs at **9 timings: 0, 2, 4, 6, 8, 12, 16, 20, 25 ms** per
DB → **18 kill runs + 2 no-kill controls across 2 DBs**.

**Per-run verification:** raw `better-sqlite3` inspection (PRAGMA integrity_check, schema
version, table existence, row counts), then an unhindered recovery open, then backfill
verification: `entity_versions` row count == distinct entities in `changes` (60000),
element-wise-max spot checks on a multi-revision entity (expect `{devA: 60005}`,
`latest_seq 60005` — the synthetic entity's revisions carry seqs 60002–60005) and three
single-revision entities, events count 60000 preserved.

**Result: 20/20 consistent.**

- Every one of the 18 kills left the **last-committed v5 state intact**:
  `schema_version=5`, no `entity_versions` table, `integrity_check=ok`, all 60,000 events
  and 60,004 changes present. No partially-migrated state was ever observed — the
  migration (DDL + backfill + `UPDATE schema_version`) is one SQLite transaction, and
  SIGKILL at every timing either preceded it or rolled it back cleanly (WAL).
- Every recovery open completed the migration to v6 with the **verified-correct
  backfill** (20/20, including the element-wise-max and latest-producer checks).
- Controls: migration completes normally, `MIGRATED v=6`, backfill verified.

(Nuance stated honestly: with the handshake method, "killed before migration started" and
"killed mid-migration, rolled back" are indistinguishable post-hoc — both present the
identical, correct v5-retry state. That identity is precisely the atomicity property
being tested: no third outcome ever appeared.)

---

## 4. CHECK C (H6) — oracle quality

**Finding: the expected-state oracle is events-only — a test-coverage limitation, not a
defect in the fix.** In `tests/pkg1_helpers.ts`, `ExpectedState` tracks
`events: Map<string, ExpectedEvent>` (title/description/startMs/endMs/allDay), a
`deleted` list, and creation order; `assertAgainstOracle` compares each device's
`semanticEvents()` (the `events` table only, minus sync bookkeeping) against it plus
pairwise digest convergence. **Calendars are not covered** (no expected-calendar state,
no calendar assertion anywhere in the two test files); **series / occurrence_overrides
are out of snapshot scope entirely in v1** — the fix's own `localRowMatchesEntry` returns
`false` for them ("series/occurrence_override snapshots not carried in v1").

**Oracle independence: verified.** `ExpectedState` is maintained exclusively by the test
driver from its own operation log (`mkEvent`/`updEvent`/`expected.create|update|delete`,
and the generative test's seeded ops); nothing feeds from `buildSnapshot`,
`applySnapshot`, `sweep`, or any implementation output. The comparison row set
(`semanticEvents`) is a raw SQL projection of the `events` table. This is a genuine
independent oracle.

Implication: the P1 suite proves events survive compaction×snapshot; calendar snapshot
behavior (including the CHECK-A heal path and `localRowMatchesEntry`'s
calendar-specific title/color comparison) is exercised only by this review's probes and
older suites. Recommend adding calendar assertions to the oracle as follow-up coverage.

---

## 5. CHECK D (H4 quick check) — deletion propagation post-fix

Probes in `qa-review-tmp/probes2/check_a_d.test.ts` (all passing):

- **D1 — legitimate deletion via change record:** A creates E1,E2 → converge → A deletes
  E2 → converge → **E2 absent on B**. (`deleteEvent` emits a `remove` change record, no
  `entities_tombstones` row; deletion knowledge travels as a change record.)
- **D2 — absence path with real version evidence:** 3 peers; A deletes E1, only C learns
  the delete record; A is swept with constraint set `[C]` (B excluded — the only honest
  way to reach the absence branch with evidence: A's create+delete records AND tombstone
  all vanish). B still holds the live row **with non-empty version evidence**
  (`{"d-0366…":2}`). Next A→B session omits E1 with no riding tombstone →
  **B absence-tombstones E1** (row gone, tombstone row present, survivor E2 untouched).
  Deletions propagate post-fix.
- **D3 — guard scope:** a live event row injected with **no version evidence ever**
  ("zombie", zero `entity_versions` rows) **survives** the same omission exchange —
  `if (Object.keys(localVersion).length === 0) continue;` — while the versioned deletion
  in the same exchange still propagates. So the empty-version guard protects **only rows
  that never had version evidence**; it does not weaken any evidence-backed deletion.

**Residual (non-blocking) note:** a zero-evidence zombie can never be removed by the
absence rule (no evidence ⇒ no domination possible), so a stale zombie on one peer only
would diverge. Zombie rows are creatable only via the pre-v6 swept-history path or direct
writes — bounded by the same WIPE ACCEPTABLE decision and by production rows always
getting evidence at creation (v6 T1/T2). Acceptable; worth one line in the known-limits.

---

## 6. Overall verdict

**PASS for Package 1.**

Rationale:

1. The 12 prior adversarial probes (double compaction, both-peer compaction,
   restart-mid-cycle, fresh-peer bootstrap, 3+ peers, update/delete after compaction,
   compaction between sync rounds, race ordering) all passed, and the fix's own suite is
   green at review time (P1.1–P1.9 + property test: **10/10**).
2. **H5 cleared decisively:** migration v5→v6 is fully atomic under kill -9 — 18/18 kill
   timings (0–25 ms, 2 DBs) + 2 controls, all ending in either clean v5 retry or verified
   v6, `integrity_check=ok`, zero event loss, backfill element-wise-max verified.
3. **H1 is real but bounded:** the calendar-loop asymmetry exists and a
   swept-then-migrated DB does omit its calendar from snapshots — but it self-heals via
   T2 re-versioning within the first session, the production open path re-bootstraps the
   calendar (and its version row) on every `EventCore` construction, only one shared-id
   calendar exists, `sweep()` has no production caller, and the WIPE ACCEPTABLE decision
   is on file. Empirically: no data loss, correct convergence. Non-blocking follow-up:
   make the calendar loop over-inclusive like the events loop.
4. **H4 cleared:** legitimate deletions propagate both via change records and via the
   absence path with version evidence; the empty-version guard is scoped to zero-evidence
   rows only (zombie-removal limitation noted above, bounded).
5. **H6 noted as coverage limitation:** the oracle is genuinely independent
   (driver-maintained from the operation log) but events-only; calendars are not in the
   oracle, series/occurrence_overrides are out of v1 snapshot scope. Follow-up: extend
   the oracle.

### Evidence artifacts

- `qa-review-tmp/probes2/gen_v5.test.ts` — v5-era DB generation (baseline code, stash round-trip)
- `qa-review-tmp/probes2/check_a_d.test.ts` — CHECK A / D1 / D2 / D3 (4/4 passing)
- `qa-review-tmp/probes2/{open_once.ts,open_once.mjs,kill_runner.mjs}` — CHECK B harness (20/20)
- `qa-review-tmp/gen/checkA/deviceA`, `qa-review-tmp/gen/checkB/db{1,2}` — generated v5 templates
- Prior context: `qa-review-tmp/INDEPENDENT-ASSESSMENT.md`
