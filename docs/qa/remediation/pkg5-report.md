# Package 5 — Implementation Report: DC-03 Conflict Detection Wired into the Live Pipeline

Date: 2026-08-30 · Branch `remediation`, base d0642ad (Pkg1–4 committed) · No commits made
QA findings closed: M-2 / QA-1 F2 (MAJOR, 5/5) — conflict detection never wired; Conflicts UI with no data source.
Companion docs: `pkg5-diagnosis.md` (pipeline trace + citations), `tests/pkg5_conflicts.test.ts` (regression suite).

---

## 1. Pipeline trace (what was broken)

`detect()` (`src/sync/conflict_detection.ts`, DC-03 §3 verbatim) was referenced
only by its own unit test. The live application path was:

```
remote:  sync_engine.applyBatch → applyRemoteChange (T2, database.ts)
             └─ mutate (makeEntityMutator) — wrote the entity row UNCONDITIONALLY
local:   EventCore.createEvent/updateEvent/deleteEvent → createLocalChange (T1)
```

Nothing evaluated the incoming record against local participants, so the
DC-07 `conflicts` / `conflict_participants` tables (already in the DDL) had no
writer in `src/`, and a concurrent same-field pair converged silently:
second-arrival row overwrite at T2, and across sessions the DC-09
`applySnapshot` §7.1 domination rule ("local survives iff NOT dominated by
snapshot_clock") decided the surviving value — winner selection with no user
decision, contra DC-03 §5/TR-7 ("every concurrent differing pair surfaces as
an unresolved conflict record") and Spec §13 INVARIANT 7.

## 2. Authoritative layer + fix shape

Per DC-03 §3 ("When an incoming change record C arrives and passes DC-02 §7
application gating … BEFORE mutating local state the device evaluates C
against all participants L for C's conflict entity"), detection is wired at
**T2/applyRemoteChange**, inside the same transaction as the change-record
insert, per drained record:

- `localCurrent` — the conflict entity's current value derived from the live
  `events` row (title/description scalars, `schedule` group, whole-event
  `event`, `*` = live row ⇒ not deleted; missing row ⇒ DELETED).
- `locals` — un-compacted participants from `changes` where
  `(entity_id, field_path)` matches; a `'*'` whole-entity remove touches every
  conflict entity of that entity (DC-03 §3.4 delete-vs-edit); distinct field
  paths never match (§2.1, §3.6).
- Outcome handling (exactly DC-03's three rules):
  - **apply** (§3.2 causal-after, no concurrent differing participant) →
    entity-row `mutate` runs as before.
  - **noop** (§3.1 identical-value convergence) → NO row write at all
    (idempotent, not even an `updated_hlc` churn).
  - **conflict** (§3.3/§3.4) → the entity row is **NOT overwritten** (the
    pre-conflict local value stays visible until resolution); the record still
    enters `changes` and knowledge/applied_upto/clocks advance (DC-02 §7
    application gating is unaffected — sync progress and future detections
    keep working); one conflict row is persisted/extended.
- **Conflict record persistence** (DC-03 §4 / DC-07 schema, no DDL change):
  `conflict_id` UUIDv4 generated once; `detected_at_hlc` = detecting device
  wall clock (presentation-only per §5); `status='unresolved'` — detection
  NEVER resolves (§4.3); participants = incoming C + every concurrent
  differing local L, stored verbatim (change_id, device_id, local_seq,
  causality_clock, payload); an existing UNRESOLVED record for the same
  conflict entity is EXTENDED (INSERT OR IGNORE) so N concurrent writers join
  ONE record (§3.5 / TR-9); a RESOLVED record is never reopened — a genuinely
  new concurrent pair creates a fresh record.

**Local-write path scope decision (documented, no code):** T1 needs no hook.
A locally created change's causality clock is built from the device's merged
`device_clock` (element-wise max over ALL received clocks) plus the local
increment, so it causally dominates every participant in local history —
DC-03 §3.2 (causal-after applies cleanly) makes local writes NO_CONFLICT by
construction. Both peers of a concurrent pair detect on REMOTE arrival, which
is the only path DC-03 §3 defines.

**Entity-type scope:** detection runs for `entity_type === 'event'` — the only
type the live mutator writes (`makeEntityMutator`); other entity types have no
row write to protect (see diagnosis §4).

## 3. Files changed

| File | Change |
|---|---|
| `src/sync/conflict_detection.ts` | unchanged (pure decision logic reused as-is) |
| `src/persistence/database.ts` | T2 wiring: `eventRowLocalValue`, `loadConflictLocals`, `detectAndRecordConflict`, `recordConflictRow`; per-drained-record detection before `mutate` (skip mutate on conflict/noop) |
| `src/persistence/bridges/sidecar_server.ts` | read-only ops `list_conflicts` (total_unresolved + ConflictListItem[], optional `entity_id` filter) and `conflict_detail` (ConflictDetailView), delegating to `ConflictsViewModel` so shapes match the DC-14 frontend contract exactly; deliberately NO resolve/skip RPC (DC-14 §4.3 write path = shell bridge work item, see `frontend/conflicts.ts` TODO(backend)) |
| `src-tauri/src/lib.rs` | `sync_op` ALLOWED list 14 → 16 (`list_conflicts`, `conflict_detail`) — same-commit allow-list rule |
| `tests/pkg5_conflicts.test.ts` | 13-test regression suite (below) |
| `docs/qa/remediation/pkg5-diagnosis.md`, `pkg5-report.md` | this package's docs |

No schema changes (conflicts tables were already in the base DDL). No
frontend changes. No changes outside the declared surface limits — in
particular `src/sync/full_state.ts` and `src/sync/sync_engine.ts` are
untouched (see §6).

## 4. DC-03 citations applied

- §2.1/§2.2/§2.3 — conflict entity = `(entity_id, field_path)`; participants =
  applied un-compacted change records; concurrency solely per DC-02 §3
  (causality_clock; `hlc_timestamp` plays NO role).
- §3.1 — identical-value convergence: no-op regardless of concurrency (TR-5).
- §3.2 — causal-after applies cleanly (local-write path rationale).
- §3.3 — concurrent same-field difference ⇒ conflict record; local state NOT
  overwritten; both values preserved (TR-2). **This is the automatic
  materialization DC-03 specifies — deliberately NOT LWW.**
- §3.4 — delete-vs-edit participates like any value; neither silent win (TR-4).
- §3.5 — multiple participants join ONE record (TR-9).
- §3.6 — different fields never conflict (TR-3).
- §4.1/§4.3 — records persist durably across restart, never auto-resolved;
  resolution transitions are explicit user actions only (DC-14) (TR-8).
- §4.4 — resolution writes the winning value back as a NORMAL change record so
  resolution propagates causally.
- §5/TR-7 — no timestamp-based winner selection anywhere.

## 5. Verification (commands + exit status)

- `npx vitest run tests/pkg5_conflicts.test.ts` → **13/13 passed**, exit 0.
- `npx vitest run` (full suite) → see §5.1; failures are the documented
  pre-existing baseline set (month_view date-flake, SC6 m-1; SC7 passes under
  the 180s cap per pkg4-review) — no new failures introduced.
- `npx tsc --noEmit` → exit 0.

### 5.1 Regression suite coverage (tests/pkg5_conflicts.test.ts)

Level 1 — DC-03 materialization at T2 (direct `applyRemoteChange` +
`makeEntityMutator`, no snapshot path, fully deterministic):
1. same-field concurrent record → conflict row, BOTH payloads verbatim, local
   value NOT overwritten, history + knowledge advanced (§3.3/TR-2).
2. no-LWW: a concurrent record with a far-later `hlc_timestamp` still cannot
   overwrite the local value (§5/TR-7).
3. identical value concurrently → no conflict row, not even `updated_hlc`
   churn (§3.1/TR-5).
4. delete-vs-edit → conflict on both receivers; deleted entity NOT
   resurrected, edited value NOT destroyed (§3.4/TR-4).

Level 2 — real sessions (pkg1 harness makeDevice/sessionOnce/convergeRound,
Pkg4 bounded sessions):
5. sessions: conflict rows on BOTH receivers, both payloads preserved, rows
   converge to one of the conflicting values (see §6 for the snapshot note).
6. different-field concurrency → zero conflict rows, full merge, single
   expected-state oracle + pairwise convergence (§3.6/TR-3).
7. identical value over sessions → no rows, converged.
8. conflict records survive `restartDevice` byte-identical and unresolved
   (§4.1/TR-8).
9. repeated sessions → no duplicate rows, no status changes.
10. 3-peer same-field conflict → exactly one record per device with ALL THREE
    participants, identical participant sets across devices, pairwise row
    convergence (§3.5/TR-9).
11. resolution semantics: `ConflictsViewModel.resolve(keep_mine)` →
    `resolved_keep_local` + winning value written back as a NORMAL change
    record (§4.4); it propagates causally to the peer (no new conflicts, peer
    row adopts the value); the resolved conflict NEVER re-appears as
    unresolved across further sessions; the peer's copy flips through the
    DC-14 §6.3 `applyRemoteResolution` intake with matching participant set
    (`resolved_on_receipt`) — intake→engine wiring itself is deferred #11
    (documented, deliberately not built: DC-03 §8 / DC-14 §6.3 place
    resolution transport in the sync-protocol contract).
12. bounded sessions complete cleanly with conflict rows present (Pkg4).
13. retrieval: `list_conflicts` / `conflict_detail` return exact
    ConflictListItem / ConflictDetailView shapes (key sets asserted), filter
    + validation + not_found semantics, and the Rust allow-list carries both
    ops (allow-list drift guard).

Expected-state oracle: asserted alongside every scenario — single shared
oracle for merge scenarios (full convergence), per-device oracles for conflict
scenarios (divergence IS the specified DC-03 outcome), plus producer-frontier
equality as the "sessions converged" check.

### 5.2 Full-suite result

`npx vitest run` → **506/509 passed, 3 failed** (2 files):
`tests/month_view_clicks.test.ts` (date-flake chips assertion),
`qa-tmp/probes/sc5_snap_quar_restart.qa.test.ts` (SC6 m-1 duplicate-quarantine
assertion; SC7 abort/restart timeout at its 5s default). **Baseline-attributed
pre-existing:** re-ran both files with this package's tracked changes stashed
at d0642ad → identical 3 failures. All 46 other files pass, including Pkg1–4
regression suites and all database/sync suites with the new detection active —
no behavioral regression in causal (non-concurrent) paths.

## 6. Remaining uncertainty / cross-contract finding (for the lead)

**DC-09 snapshot phase vs DC-03 §3.3.** The T2 layer materializes conflicts
exactly per DC-03 (row keeps local value — proven by level-1 tests). However,
every sync session also runs the DC-09 full-state phase: the pull loop's
gap-detection fires Trigger A even on fully-converged peers (empty request
ranges "don't shrink"), so a FULL_STATE_OFFER/snapshot exchange happens every
session (this is the separately-known "every-session full-state transfer"
waste finding). `applySnapshot` §7.1 then replaces a local entity whose
version vector is dominated by `snapshot_clock` — for conflict-diverged rows
this converges the ROW to the domination winner's value (deterministic for a
given session/device order, but a silent winner selection at row level). At
session level the suite therefore asserts: conflict rows + verbatim payloads
on every receiver, convergence to one of the conflicting values, no third
values, no data loss.

Fixing the row-level behavior would require `applySnapshot` (or the trigger
layer) to be conflict-aware — e.g. skip replacing an entity that has an
unresolved conflict record — which is in `src/sync/full_state.ts` /
`src/sync/sync_engine.ts`, OUTSIDE this package's declared surface limits.
Recommend a follow-up package (Pkg6 candidate) for: (a) conflict-aware
snapshot application, and (b) the every-session full-state trigger bug that
amplifies it. Note the two contracts genuinely tension here: DC-03 §3.3
("local state is NOT overwritten") vs DC-09 §7.1 ("dominated local state is
replaced"); the lead may want an explicit owner ruling on which governs the
post-snapshot row value for entities with unresolved conflicts.

**Retrieval wiring:** the sidecar exposes the read ops, but the desktop shell
does not yet inject `window.__TIDE_CONFLICTS__` (the `frontend/conflicts.ts`
TODO(backend) shell-bridge work item: proxy commands + bridge injection).
Until then the Conflicts button still renders its honest empty state. Resolve/
skip RPC surfaces were deliberately NOT added (read-only package scope; DC-14
§4.3 requires them to be explicit user actions via the shell bridge).

**Detection scope:** `entity_type === 'event'` only (the live mutator's
domain). Calendar/series/override conflicts would need row-read derivations
per type; no row-mutation path exists for them today, so there is nothing to
protect. Recorded as a scope decision in pkg5-diagnosis.md §4.
