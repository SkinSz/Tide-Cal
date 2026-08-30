# P11 Stale Causal-Before Fix — Adversarial Review (attempt 2)

- Reviewer: re-dispatched unprimed adversarial review subagent
- Date: 2026-08-30
- Fix under review: DC-03 v2 §3.2a (`detect()` "stale" classification in `src/sync/conflict_detection.ts`) + stale handling in `applyRemoteChange` (`src/persistence/database.ts`), commit e53ec02
- **Verdict: PASS** (8/8 attacks; no defects found; two process-level observations, no contract violations)

## Method

8 bounded adversarial attacks, each a throwaway vitest file (deleted after the
run; committed tree left clean — `git status` shows only this report). All
attacks were run against HEAD e53ec02 together with the existing
`tests/p11_stale_regression.test.ts` (6/6 green at review start): final run
17/17 passed. Assertions target external observables only (events row,
conflicts table, changes history, applied_upto, device_clock, oracle).

## Attack Results

| # | Attack | Result | Notes |
|---|--------|--------|-------|
| 1 | Order flip (C before D) | PASS | Stale C delivered to `a` BEFORE D: legitimately applies ("B stale", causal-at-the-time); later D overwrites → "C later". No conflicts either way. |
| 2 | Double stale replay | PASS | 2nd and 3rd deliveries of stale C after D applied: "duplicate" via advanced applied_upto; title stays "C later"; no conflict rows. |
| 3 | Stale-after-conflict | PASS | Stale recB (dominated by materialized recC, unseen by `a`): history-only — history row inserted, row untouched, no conflict created. A subsequent genuinely concurrent record (b's edit without seeing recC) creates an unresolved conflict; re-delivered stale recB leaves the conflict untouched (no resolve/obsolete side effect). |
| 4 | Mixed domination | PASS | (a) NOT-dominated concurrent record (device `d`'s sibling edit, concurrent with materialized recC) → §3.3 CONFLICT fires, some() is not too eager. (b) Record dominated by one local participant while concurrent with another → stale fires; provably safe (see Findings). |
| 5 | Delete-vs-edit + stale set | PASS | Delete-vs-edit conflict fires (§3.4: local row preserved with "C mid"). Stale title set delivered before AND after the conflict: value never regresses, row never flips, conflict rows survive untouched. |
| 6 | Non-title fields | PASS | Stale replay on `description`, `schedule` (startMs), and a synthetic whole-entity `field_path='event'` record: materialized row protected on all paths, no conflicts. |
| 7 | DC-02 §7 liveness | PASS | After stale delivery: `changes` grew by exactly 1, `applied_upto` for the stale producer advanced to its local_seq, `device_clock` frontier merged (every stale-clock entry ≤ stored max_seq), no stuck `pending_changes`; subsequent full `convergeRound` converges on "C later" everywhere (independent `oracle` = true). |
| 8 | Restart boundary | PASS | `restartDevice(a)` after D applied, stale C delivered twice: "C later" survives restart and both deliveries; no conflicts. |

## Findings

1. **Observation (API semantics, not a defect)**: `applyRemoteChange`'s return
   value is transport-level — "applied" whenever the per-producer frontier
   drained (regardless of internal apply/noop/stale detection), "buffered" on a
   causal gap, "duplicate" on redelivery. The §3.2a "stale" classification is
   internal and observable only behaviorally (history row inserted, entity row
   not mutated, no conflict row). Existing test expectations of
   `["applied","duplicate"]` are consistent with this.
2. **Gap-buffer interaction**: if `a` skipped record X (transitively dominated
   by a later applied record) and a later record Y whose causal past includes X
   arrives first, Y is "buffered" until X arrives; delivering X unblocks Y. The
   stale-X delivery itself does not mutate the row. This is correct per-producer
   frontier behavior (DC-02 §7), worth knowing when writing repros.
3. **Attack 4 safety argument (mixed domination)**: `sameOrDescendant` requires
   the dominating local record's clock to contain the incoming record's own
   (producer, seq) entry — i.e. some local participant SAW the incoming change.
   Therefore the local union knowledge necessarily contains the incoming record;
   a record that is "dominated by one participant but carries novel knowledge"
   is not realizable. DC-02 §3 exclusivity then guarantees stale-vs-L and
   conflict-vs-L are mutually exclusive. Empirically: dominated → stale (no
   row write, no conflict); not-dominated-but-concurrent → §3.3 conflict.
4. **§3.4 clarification surfaced by attack 5**: on a delete-vs-edit conflict the
   entity row is NOT overwritten — the pre-conflict local value stays materialized
   (row still exists with "C mid"). Stale redeliveries never flip this state.

## Answers

1. **Does the fix block stale regression on all paths tried?** YES — 8/8
   attack scenarios plus the 6 pre-existing regression scenarios: the
   materialized row was never regressed by a causally-dominated record, on
   title, description, schedule, whole-entity records, before/after conflicts,
   across replays, restart, and order flips.
2. **Does genuine concurrency still conflict?** YES — concurrently produced
   records (neither side having seen the other) produced unresolved conflict
   rows with the local value preserved (§3.3/§3.4), including when the
   concurrent record was a sibling of a dominated one (attack 4a) and after
   stale deliveries on the same field (attack 3).
3. **Does convergence still hold?** YES — attack 7: full convergeRound after a
   stale delivery converges to "C later" on all devices; the independent
   oracle reports converged=true; liveness bookkeeping (changes growth,
   applied_upto advance, clock merge, empty pending) all verified.
4. **Any bypass path found?** NONE. The closest near-misses are harness-level:
   the transport return value does not expose the detection kind (could mislead
   future test authors), and gap-buffering can mask a record until its causal
   predecessor arrives. Neither regresses state nor violates the contract.

## Repro recipes

No defects — no repro recipes required. Attack scenarios are described in the
table above; each maps 1:1 to a small vitest file built from
`tests/pkg1_helpers.ts` (makeDevice / convergeRound / direct single-record
`applyRemoteChange` delivery), modeled on `tests/p11_stale_regression.test.ts`.
