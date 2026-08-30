# Package 5 — Independent Adversarial Review (QA M-2 / QA-1 F2: DC-03 conflict pipeline)

Date: 2026-08-30 · Reviewer: independent adversarial reviewer (Falsification attempt)
Scope of review: UNCOMMITTED Pkg5 changes on `/tmp/tide-remediation` (branch `remediation`,
HEAD d0642ad + Pkg1–4): `src/persistence/database.ts`, `src/persistence/bridges/sidecar_server.ts`,
`src-tauri/src/lib.rs`, untracked `tests/pkg5_conflicts.test.ts` + diagnosis.
Production code untouched by this review; probes live in `qa-review5-tmp/` (`qa5_probes.test.ts`,
`qa5_probe10.test.ts`, `qa5_probe11.test.ts`). `docs/qa/remediation/pkg5-report.md` was NOT read
prior to writing this assessment.

---

## 1. VERDICT

**PASS** — with one CONFIRMED material concern, which the implementer had already declared
out of scope and scheduled as a follow-up (DC-09 §7.1 snapshot domination vs conflict-diverged
rows). The snapshot interaction was independently verified to be **real and material, not
cosmetic**: a follow-up package touching `src/sync/full_state.ts` is genuinely required.

- Original finding (detect() dead code, no writer for `conflicts`/`conflict_participants`,
  silent convergence, UI without data source) is remediated at the T2 layer for the live
  pipeline, with correct DC-03 semantics and no invented LWW.
- All 10 adversarial probes passed except where they were designed to document pre-existing,
  contract-literal behavior (P11) or the declared out-of-scope issue (P9 — by design).
- Full suite: **506/509 passed** (matches the claimed expectation); the 3 failures are exactly
  the pre-verified known failures: `tests/month_view_clicks.test.ts` (chip-count flake),
  `qa-tmp/probes/sc5_snap_quar_restart.qa.test.ts` SC6 (m-1 quarantine-replay count) and SC7
  (stale-cap 5 s timeout). Pkg5 suite: **13/13 passed**.

## 2. FALSIFICATION TABLE

| # | Adversarial variation | Result | Evidence |
|---|-----------------------|--------|----------|
| 1a | Concurrent same-field record whose value EQUALS local row | PASS — noop, zero rows, not even an `updated_hlc` rewrite (§3.1) | pkg5 test 3; probe P1(1) |
| 1b | Concurrent same-field record whose value DIFFERS | PASS — exactly 1 unresolved row, both payloads verbatim, entity row NOT overwritten even with a future-dated `hlc_timestamp` (no-LWW) | pkg5 tests 1–2; probe P1(2) |
| 1c | Stale concurrent record equal to ROW but different from participant payload (row advanced causally) | PASS — §3.1 row comparison wins, no row | probe P1(3) |
| 2 | Conflict, then a THIRD device's concurrent edit arrives later | PASS — SAME unresolved record extended to 3 participants (§3.5/TR-9), no duplicate row; sync completes | probe P2 (pkg5 test 10 covers simultaneous 3-peer variant) |
| 3 | Resolution, then re-delivery of the SAME original record | PASS — `duplicate` at T2 (fresh + after restart); no resurrection; status stays `resolved_keep_local`; participant set unchanged | probe P3 |
| 4 | Conflict + restart + further sync | PASS — rows byte-identical (`toEqual` on raw rows), participants intact, no duplicates | pkg5 test 8; probe P4 |
| 5 | Delete (`field_path='*'` remove) vs concurrent field edit, BOTH directions | PASS — conflict on (entity,'title') at the delete-holder and (entity,'*') at the edit-holder; deleted row not resurrected, edit not destroyed; participants = `{remove,set}`; payload/clock JSON well-formed; no dup after further sync | probe P5; pkg5 test 4 |
| 6 | Different-field concurrent edits (title vs description) | PASS — zero rows, full merge, independent oracle green (§3.6/TR-3 regression) | pkg5 test 6; probe P6 |
| 7 | Conflict must not stall sync | PASS — `applied_upto` ≥ every producer's max `local_seq` on all 3 devices; `sessionOnce` completes with `errors=0`; no Pkg4 `SyncIdleTimeoutError` | probe P7; pkg5 tests 9/12 |
| 8 | `list_conflicts`/`conflict_detail` reachable via dispatch; shapes | PASS — `Object.keys` sorted-equality against `ConflictListItem` / `ConflictDetailView` / `CandidateView` from `conflicts_ui.ts`; validation + `not_found` errors surface; write ops NOT dispatchable | pkg5 test 13; probe P8 |
| 9 | Snapshot interaction (DC-09 §7.1) | **CONFIRMED ISSUE (declared out of scope)** — conflict row survives, ROW VALUE converges to the domination winner | see §4 |
| 10 | Causal-before stale record drained from a gap buffer | OBSERVATION — stale value overwrites the newer local row value; contract-literal (DC-03 §3.3 "conflicting is empty → apply C normally") and pre-existing mutator behavior, not a Pkg5 regression | probe P11, §5.3 |
| 11 | Scope of diff | PASS — `git diff` touches exactly the 3 declared files (+5/−2 lib.rs allow-list 14→16, +37 sidecar read-only ops, +234 database.ts detection); untracked files are the test/diagnosis/report only | git status/diff |

## 3. DC-03 CITATION CHECK

Verified verbatim against `docs/contracts/DC-03_conflict_detection.md` (APPROVED 2026-08-25):

- **"Local value kept" materialization — FAITHFUL, not invented.** §3.3: *"Local state is NOT
  overwritten. BOTH values are preserved in the record."*; §3.4: *"The stored pre-conflict
  local value remains visible until resolution."*; TR-2: *"local field value remains unchanged
  pending resolution."* The implementation (skip `mutate` on CONFLICT; still insert into
  `changes`, still `recordEntityVersion`, clocks advance) is the only automatic behavior the
  contract specifies; §4.3 forbids auto-resolution and §5 forbids timestamp winners. No-LWW
  independently confirmed (pkg5 test 2: future-dated hlc cannot win; probe P1).
- **Concurrency test — CORRECT.** §2.3 delegates to DC-02 §3; `concurrent()` in
  `vector_clock.ts` is exactly "neither dominates" (non-strict element-wise ≥ both ways);
  `detect()` filters participants solely by `concurrent(causality_clock)`, never `hlc_timestamp`.
  Rule ordering matches the §3 pseudocode: 3.1 (identical vs `localCurrent` row value) →
  concurrent filter → differing filter → conflict.
- **'*' remove handling per §3.4 — CORRECT, citation slightly loose.** §3.4 itself never
  mentions `'*'`; the token comes from DC-01 §2 (field_path, delete_event writes
  `field_path: "*"` — `event_core.ts:368`). Treating a whole-entity remove as touching EVERY
  conflict entity of that entity_id is the faithful realization of *"a concurrent set-vs-remove
  … pair is a CONFLICT … the delete does NOT silently destroy the concurrent edit"* and §2.4
  (remove → field DELETED). Both directions probe-verified (P5). Acceptable; not a
  mis-citation, but the diagnosis attributes to §3.4 what §3.4 implies via DC-01's encoding.
- **§3.5/TR-9 collapse — FAITHFUL.** One unresolved row per `(entity_id, field_path)`;
  existing record extended with `INSERT OR IGNORE` participants (immutable once added, §4);
  new concurrent pair after resolution would get a fresh record (never reopens a resolved
  one) — matches §4.3.
- **§4 record shape — FAITHFUL.** UUIDv4 via `randomUUID()`; participants carry
  change_id/device_id/local_seq/causality_clock/payload verbatim; status transitions only via
  DC-14 view-model; DC-07 CHECK constraint unchanged. Minor note: `detected_at_hlc` is
  `Date.now()`; §4 says "HLC of the detecting device", but the codebase's HLC is wall-clock ms
  throughout (`hlc.now()`), and §5 makes the field presentation-only. Consistent with codebase
  practice; cosmetic.
- **Defensible interpretation note:** on §3.1 noop the incoming record is still written to
  `changes` (only the entity-row write is skipped). TR-5 says "no state change beyond clock
  advancement"; the history insert is required for dedup and for the record to participate in
  FUTURE detections (§2.2 participants = applied un-compacted changes). Judged correct; noted
  for the record.

## 4. SNAPSHOT-INTERACTION VERDICT (the deciding question)

**The declared out-of-scope issue is REAL, MATERIAL, and a follow-up package is genuinely
required — not cosmetic.**

Direct probe (P9, exact engine path — `buildSnapshot` on b, `applySnapshot` on a, immediately
after a converged 2-peer conflict):

- Before: a.row = "From A", b.row = "From B", both devices hold 1 unresolved conflict row.
- After applying b's snapshot to a: **a's events row is overwritten to "From B"**
  (`appliedEntities=2`), because after convergence `snapshot_clock` ⊇ the local entity version,
  so DC-09 §7.1's "local survives iff NOT dominated" fails and the snapshot replaces the row.
- **The conflict row survives untouched** (`conflicts`/`conflict_participants` are not read or
  written by `full_state.ts` — verified by grep and by `toEqual` row comparison): still
  `unresolved`, participants intact.

Consequence: the CONFLICT DATA survives (DC-03 §4.1/TR-8 satisfied — nothing is lost or
auto-resolved), but the MATERIALIZED VALUE silently converges to the vector-clock domination
winner while the conflict is still unresolved. That defeats DC-03 §3.3/TR-2's "local field
value remains unchanged pending resolution" across any snapshot exchange, and is exactly the
"implicit LWW-by-domination" residual the original finding described — now confined to the
snapshot path instead of the change path. Session-level probe confirms convergence happens
within the first anti-entropy round (both devices deterministic on one of the conflicting
values; never a third value, never data loss — pkg5 tests 5/10 assert exactly this, with the
limitation documented in the suite header).

Verdict: `full_state.ts` needs a Pkg6 change (e.g. exempt entities with unresolved conflict
rows from §7.1 replacement, or record the domination outcome as data). Until then the Conflicts
UI would show an unresolved conflict whose entity row no longer reflects either the local or a
user-chosen value. The implementer's claim is accurate and properly scoped out.

## 5. TEST QUALITY

- **Oracle independence: real.** `ExpectedState`/`assertAgainstOracle` is computed from the
  test driver's own operation log (pkg1 harness), never from sync outputs; conflict tests
  correctly use per-device expectations (divergence IS the specified outcome) with the
  single-state oracle applied only to converging scenarios (tests 1, 6, 7).
- **Implementation-independent assertions: real.** Raw SQL over `conflicts`/
  `conflict_participants` (not view-model round-trips) for row/payload claims; `Object.keys`
  sorted-equality shape pinning for retrieval; state-unchanged assertions compare full row
  tuples including `updated_hlc` (test 3) and raw rows across restart (test 8: `toEqual`).
- **Frontier assertions** (applied_upto convergence) are an independent stall oracle
  (`assertFrontiersConverged`).
- Weaknesses (non-blocking):
  1. The lib.rs allow-list check is a source-text `toContain` (drift guard), not an executed
     dispatch through the real Rust command. Accepted (no Rust test harness in-repo), noted.
  2. Level-2 session tests cannot assert §3.3 row divergence because the DC-09 snapshot phase
     converges rows within the round — documented in the suite header and correctly asserted
     as "one of the conflicting values, never a third"; the §3.3 guarantee is pinned at level 1
     (direct T2) where it belongs. This is precisely where the §4 follow-up will bite.
  3. No `schedule`-field or member-level conflict test at T2 (shared code path exercised via
     title only); DC-03 §3.7 member boundary cases have no live-pipeline producer today, so
     acceptable scope.

## 6. OBSERVATIONS (pre-existing, not Pkg5 regressions)

1. **Causal-before stale overwrite (P11).** A record that is causally BEFORE all local
   participants (delivered out of order through the gap buffer, its clock dominated by a
   descendant already applied) falls through DC-03 §3.3's "conflicting is empty → apply C
   normally" and the unconditional mutator overwrites the newer row value ("B stale" beat
   "C later"). Literal-contract behavior and identical pre-Pkg5 (the mutator always applied);
   flagging for the owner as a possible DC-02/DC-03 clarification, not a Pkg5 defect.
2. **Different conflict entities `event` vs `title`.** A concurrent whole-event record
   (`field_path='event'`, produced only by createEvent) and a title edit are different conflict
   entities (§2.1/§3.6) so they never conflict; the whole-row upsert would silently carry its
   own title. Unreachable in practice (creation precedes edits causally); noted.
3. `detected_at_hlc` = wall clock (see §3).

## 7. EVIDENCE INDEX

- `qa-review5-tmp/qa5_probes.test.ts` — 10/10 passing (P1–P9), incl. PROBE-P9 console output
  ("row value OVERWRITTEN by snapshot domination → From B").
- `qa-review5-tmp/qa5_probe11.test.ts` — P11 observation (stale causal-before overwrite).
- `qa-review5-tmp/qa5_probe10.test.ts` — relay variant (duplicate; documented for completeness).
- Full suite run: 48 files, 509 tests, 506 passed / 3 failed (known set).
- `qa-review5-tmp/pkg5.diff` — captured diff used for the scope check.
