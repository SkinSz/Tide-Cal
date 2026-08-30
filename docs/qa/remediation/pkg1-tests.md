# Package 1 — Regression Test Plan & Results (QA C-1)

Date: 2026-08-30 · Agent: Pkg1 implementation · Baseline SHA 52d54ab, branch `remediation`
Companion doc: `pkg1-diagnosis.md` (root cause, invariant INV-1, layer choice).

## Test files (all in `tests/`, committed with the package)

- `tests/pkg1_helpers.ts` — harness (ported from the QA probe harness:
  in-memory message pipes, engine-on-both-ends sessions, DC-06 `sweepOn`)
  plus the **independent expected-state oracle** (`ExpectedState` +
  `assertAgainstOracle`). The oracle is maintained by the test DRIVER from
  its own operation log; no expected value is ever derived from
  `buildSnapshot`/`applySnapshot`/`sweep` output (pkg1-diagnosis §8).
- `tests/pkg1_compaction_snapshot.test.ts` — deterministic scenarios P1.1–P1.9.
- `tests/pkg1_compaction_snapshot.property.test.ts` — seeded generative test.

Every deterministic test asserts BOTH:
(a) **semantic correctness** — each peer's `events` table exactly equals the
expected state (id set + per-event field values + deleted-ids never
resurrected), and
(b) **convergence** — all peers pairwise identical (independent digests).

Pass ⇔ `each peer == Expected ∧ peers pairwise equal`. This closes the
oracle gap that let the QA campaign report success on convergence-to-data-loss
(pkg1-diagnosis §6).

## Deterministic matrix (required coverage → test)

| Required scenario | Test | Notes |
|---|---|---|
| live events → compaction → snapshot | P1.1 | both stream directions exercised via 3 identity combinations |
| compaction → restart → snapshot | P1.3 | both veterans restarted before the exchange |
| compacted source → fresh peer | P1.2 | SC5 shape, 3 runs with fresh identities |
| multiple peers (3+) | P1.4 | 3 converged + 2 fresh peers join post-compaction |
| events before AND after compaction boundary | P1.5 | post-boundary creates + an update on the compacted DB |
| tombstoned events through compaction+snapshot | P1.6 | delete before sweep, delete after sweep; must stay deleted everywhere |
| repeated snapshot exchanges | P1.7 | 4 extra full rounds post-compaction |
| snapshot after restart | P1.8 | receiving side restarts, then a second sweep + fresh peer |
| repeated compaction/snapshot cycles | P1.9 | 5 sweep↔snapshot cycles with creates+updates, veterans restarted each round |

## Generative property test

`P1.PROP` — seeded PRNG (mulberry32), default seed `20260830`, override with
`PKG1_SEED` env var; the seed is printed in the output, so any failing seed
reproduces exactly with `PKG1_SEED=<seed> npx vitest run
tests/pkg1_compaction_snapshot.property.test.ts`. 24 bounded steps
(<10 s; observed ~1.5–5 s) interleaving creates / updates / deletes /
convergence syncs / snapshot exchange / single-direction sessions /
compaction on a random device / device restart / fresh-peer bootstrap, with
an oracle checkpoint after EVERY step and a final repeated-exchange soak.
Verified green for seeds 20260830 (default), 1 (5 devices), 42 (3 deletes),
987654.

Schedule note: mutations are barriered by convergence rounds so the oracle
uses exact sequential semantics; concurrent-conflict semantics are Pkg5's
surface and deliberately not encoded in the oracle (pkg1-diagnosis §8).

## Focused results

```
npx vitest run tests/pkg1_compaction_snapshot.test.ts tests/pkg1_compaction_snapshot.property.test.ts
→ Test Files 2 passed (2); Tests 10 passed (10)
npx vitest run qa-tmp/probes/sc_repro.qa.test.ts -t "SC5"   (original CRITICAL repro)
→ 1 passed (was failing 1/1 at baseline 52d54ab)
npx vitest run qa-tmp/probes/sc1_baseline.qa.test.ts
→ 4 passed (SC1/SC4 replay-idempotence accounting restored; see report §7)
```

## Out-of-scope notes for reviewers

- The oracle deliberately does not assert tombstone-row counts for user
  deletions: `deleteEvent` writes no `entities_tombstones` row (QA-1 F8,
  assigned to Pkg6). Absence-of-live-row is asserted instead. The absence
  rule itself is exercised via `ApplyResult.absenceTombstones` semantics
  (deletion-by-omission) which P1.6/P1.PROP cover end to end.
- Full-suite failures pre-existing at baseline 52d54ab and unrelated to this
  package: `tests/month_view_clicks.test.ts` ("selection is exclusive" —
  fails identically with `src` stashed), `qa-tmp` SC6/SC7, transient
  `ensure_listener_port` EADDRINUSE under parallel file execution (passes in
  isolation at baseline and with the fix).
