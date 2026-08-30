# Package 1 — Implementation Report (QA C-1, CRITICAL)

Date: 2026-08-30 · Agent: Pkg1 · Worktree `/tmp/tide-remediation`, branch `remediation`
@ baseline 52d54ab. **Nothing committed — all changes left uncommitted for lead review.**

## 1. Diagnosis summary

Full analysis in `pkg1-diagnosis.md`. Verified chain (independently, not from the QA summary):

1. DC-06 `sweep()` deletes change records (correctly, per its retention policy) while live
   `events` rows remain. The entity **version vector** and **latest-producer identity** were
   derivable ONLY by aggregating the `changes` log → after compaction they collapse to `{}`.
2. `buildSnapshot` derives entries from live rows but version metadata from the change log, and
   **skipped** entities with no change history → post-compaction snapshots omit live data.
3. `applySnapshot` §7.1 absence rule tombstones any live local entity absent from a snapshot
   whose `snapshot_clock` dominates the local version — and `dominates(anything, {})` is
   vacuously true → the receiver **tombstoned its own live events**.
4. The "D never receives them" mode additionally persisted through the DC-09 §7.3 offer race:
   when the gapped device won the device-id race it streamed its own empty snapshot instead of
   receiving the peer's, stranding its unservable gap forever (identity coin-flip).
5. The QA convergence oracle reported success because it checks **peer agreement**, not
   **agreement on correct state** — symmetric destruction yields equal fingerprints.

**Violated invariant (now explicit):** *compaction may change the REPRESENTATION of history,
never the SEMANTIC state it represents* — formalized as INV-1a (buildSnapshot: entity set =
live rows; version vectors durably independent of the change log) and INV-1b (applySnapshot:
absence-deletion only against a REAL version vector; an empty clock proves nothing) in
`pkg1-diagnosis.md` §5.

## 2. Authoritative layer & implementation summary

**Chosen mechanism: durable per-entity version state** (`entity_versions`, schema v6) +
gap-triggered-offer semantics + replay idempotence. Compaction itself is UNCHANGED (its policy
was never the bug).

- `src/persistence/schema.ts` — SCHEMA_VERSION 5→6; `entity_versions` table (entity_id,
  entity_type, version JSON, latest_producer, latest_seq, latest_hlc, updated_hlc).
- `src/persistence/database.ts` — v6 migration (creates table + backfills from surviving
  change history); `recordEntityVersion()` called inside the T1 (`createLocalChange`) and T2
  (`applyRemoteChange`) transactions, so state and history can never diverge. Persistence files
  touched because version state must be maintained at every write path (justified per task
  constraints).
- `src/sync/full_state.ts` — `localVersionClock`/`latestProducer` read `entity_versions` first
  (change-log derivation kept as pre-v6 fallback); `buildSnapshot` never omits a live row;
  `applySnapshot` records snapshot-delivered causality into `entity_versions` (merge, never
  regresses), drops version state when absence-tombstoning, and refuses absence-deletion when
  the local version is EMPTY (vacuous domination is not evidence; legitimate deletions always
  leave real version evidence, so deletion propagation is NOT weakened); replay no-op skip when
  the local row already equals the entry (canonical JSON; calendars compared on semantic fields
  only — bootstrap HLC bookkeeping is QA-2 F-1/Pkg6).
- `src/sync/sync_engine.ts` — gap-triggered (Trigger A) offers carry `reason: "GAP_ROUNDS"`;
  the receiver answers with its own offer instead of racing; the gapped side accepts a rival
  offer instead of streaming its own. Non-gap offers keep §7.3 race semantics unchanged.

Not touched: compaction.ts, knowledge_state.ts, conflict_detection.ts, frontend, scheduler
(sweep wiring remains unshipped; re-verified: `sweep()` has zero production callers).

## 3. Files changed

```
src/persistence/schema.ts            |  19 +-
src/persistence/database.ts          | 129 ++++
src/sync/full_state.ts               | 182 ++++---
src/sync/sync_engine.ts              |  42 ++-
tests/pkg1_helpers.ts                | new (harness + independent expected-state oracle)
tests/pkg1_compaction_snapshot.test.ts      | new (P1.1–P1.9 deterministic)
tests/pkg1_compaction_snapshot.property.test.ts | new (seeded generative)
docs/qa/remediation/pkg1-diagnosis.md | new
docs/qa/remediation/pkg1-tests.md     | new
docs/qa/remediation/pkg1-report.md    | new (this file)
```
No overlaps with other packages' declared surfaces.

## 4. Regression tests added

Deterministic (each asserts BOTH exact-expected-state semantic correctness against an
oracle computed from the driver's own operation log AND pairwise convergence):
P1.1 live events → compaction → snapshot (both stream directions) · P1.2 compacted source →
fresh peer ×3 identities · P1.3 compaction → restart → snapshot · P1.4 multiple peers (5) ·
P1.5 events created before AND after the compaction boundary · P1.6 tombstoned events stay
deleted through compaction+snapshot · P1.7 repeated snapshot exchanges · P1.8 snapshot after
receiver restart · P1.9 five compaction/snapshot cycles with updates and restarts.

Generative: `P1.PROP` seeded (default 20260830, `PKG1_SEED` override, seed logged, failing seed
reproduces deterministically), 24 bounded steps ≈1.5–5 s interleaving creates/updates/deletes/
syncs/snapshot exchange/compaction/restart/fresh-peer bootstrap against the independent oracle,
checkpoint every step. Verified: seeds 20260830, 1, 42, 987654.

## 5. Test results

```
npx tsc -p tsconfig.json --noEmit                                   → EXIT 0
npx vitest run tests/pkg1_compaction_snapshot.test.ts \
              tests/pkg1_compaction_snapshot.property.test.ts \
              qa-tmp/probes/sc_repro.qa.test.ts                     → EXIT 0, 13 passed
npx vitest run qa-tmp/probes/sc_repro.qa.test.ts -t "SC5"           → PASS (3/3; failing at baseline)
npx vitest run qa-tmp/probes/sc1_baseline.qa.test.ts                → 4/4 PASS (SC1/SC4 red at baseline)
npx vitest run  (full suite)   → 465 passed, 3 failed / 468
```

Full-suite failures are **pre-existing at baseline 52d54ab** (verified by stashing `src/` and
re-running): `tests/month_view_clicks.test.ts` "selection is exclusive"; `qa-tmp` SC6 + SC7
(quarantine-replay duplicate row = F5, abort-restart timing). `ensure_listener_port`
EADDRINUSE appears only under parallel file execution (port contention; passes in isolation at
baseline and with the fix).

## 6. Performance sanity (~200-event DB, 2 devices + fresh receiver)

| Metric | Baseline | With fix | Δ |
|---|---|---|---|
| create 200 events (T1) | 64 ms | 73 ms | +14% (+0.045 ms/event; one small version upsert) |
| initial 2-way sync | 250 ms | 252 ms | — |
| buildSnapshot | 13.6 ms | 11.7 ms | faster (PK lookup vs changes scan) |
| snapshot size | 201 entities / 135,925 B | 201 entities / 135,925 B | identical |
| applySnapshot (fresh, 200) | 15.9 ms | 29.6 ms | +14 ms absolute; negligible |
| sweep (202 records deleted) | 6.0 ms | 6.1 ms | — |
| post-compaction snapshot entities | **0 (the bug)** | **201 (fixed)** | — |
| post-compaction session | 65 ms | 80 ms | +15 ms (data now actually flows) |

No order-of-magnitude regressions. DB rows: +1 `entity_versions` row per entity (≤ change count).

## 7. Side effect worth noting

The replay no-op skip changed qa-probe SC1/SC4 from race-outcome-dependent (SC4 passed at
baseline only when the offer race happened to make the *uncounted* side apply the snapshot) to
deterministic green: `receivedApplied` on a converged replay is now 0 instead of
N-events+calendar. SC1 had been failing at baseline in our runs; it is green with the fix.

## 8. Remaining uncertainty

- The absence rule now requires a non-empty local version. Legitimate deletion propagation is
  unaffected (deletions leave real version evidence), but an out-of-band row written directly
  into `events` (never through T1/T2/snapshot) can no longer be absence-deleted — it would
  survive snapshots. No production write path does this; flagging for the lead's awareness.
- `entity_versions` rows for tombstoned entities are not garbage-collected by `sweep()`
  (bounded leak, ≤ deleted-entity count, zero behavioral impact). Candidate for Pkg6 hygiene.
- Calendar no-op comparison covers the default-calendar bootstrap divergence (QA-2 F-1); a
  user-visible calendar rename still propagates normally (title/color compared).
- `series`/`occurrence_overrides` are still not carried by snapshots (pre-existing v1 snapshot
  scope); they sync via change records and compaction of those records is now safe, but a
  fresh-peer bootstrap from a fully-compacted source cannot reconstruct series until the
  snapshot format carries them (pre-existing, unchanged by this package).
