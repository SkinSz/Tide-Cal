# Package 5b — Conflict-aware snapshot application + Trigger-A excludes self-produced sequences

Date: 2026-08-30 · Agent: Pkg5b implementation · Baseline: branch `remediation`, HEAD 2079ad2
(uncommitted changes on top, for lead review). Fixes the Pkg5-review §4/P9 CONFIRMED residual
(DC-09 §7.1 snapshot domination silently overwrites conflict-diverged row VALUES) and the
M-4 trigger scope (Trigger A fired on every session between converged peers).

---

## 1. Mechanism

### Fix B (root cause): `neededRanges` excludes self-produced sequences — closes M-4 trigger firing

Reproduced at HEAD 2079ad2 (probe `qa-review5b-tmp/probe5b.test.ts` PROBE-B): a session between
two fully-converged peers sent
`HELLO, CHANGES_REQUEST{self 1..1}, CHANGES_REQUEST{self 1..1}, FULL_STATE_OFFER, FULL_STATE_ACCEPT, CHANGES_ACK`
— i.e. the device requested its OWN history back, every session.

Root cause chain:
1. A peer's advertised HELLO clock contains a component for OUR device id (it learned our seqs
   by applying our changes).
2. Receiver-side knowledge never tracked `applied_upto[self]` (T2 only advances remote
   producers), so `neededRanges` produced a phantom range for self.
3. The range never shrank: the peer served our own records back as duplicates, and duplicates
   never advance `applied_upto`; post-compaction the range was outright unservable. Either way
   `gapRetries` hit 2 → `triggers.recordGapRound` → **DC-09 §3 Trigger A fired on every session
   between converged peers** (the M-4 "full-state per session" finding).

Fix (`src/sync/knowledge_state.ts`): `neededRanges(k, advertised, selfDeviceId?)` skips the
advertised component whose device equals `selfDeviceId` (optional third arg — legacy 2-arg form
unchanged). Engine call sites (`src/sync/sync_engine.ts` pull loop, both recomputations) pass
`deps.selfDeviceId`.

**Companion fix (discovered by regression, caught by qa5 probe P3):** removing the every-session
snapshot exchange also removed its accidental side effect of stamping `applied_upto[self]`
(applySnapshot's snapshot_clock merge covers all components incl. self). Without it, T2
misclassified re-delivery of a device's OWN records (peer echo) as buffer/apply instead of
duplicate. Fix (`src/sync/sync_engine.ts`, `seedSelfAppliedFrontier()` at session start): seed
`applied_upto[self] = MAX(max own local_seq in changes, device_clock[self])` — durable, MAX-merge,
one upsert per session. This is truthful knowledge (T1 applied those records atomically by
definition), requires no schema/persistence change, and makes T2's dedup classification correct
for self-record echo. Probe P3/P7 pass unmodified as a result.

**Result (M-4 efficiency claim, before/after):**
- BEFORE (HEAD): every converged-pair session: 1× FULL_STATE_OFFER + 1× FULL_STATE_ACCEPT
  (+ snapshot stream on the responder side) + 2 self-requests. Probe trace above.
- AFTER: `assertTypesOf(sessionLog) == ["HELLO","CHANGES_ACK"]` — **0 FULL_STATE_OFFER /
  FULL_STATE_ACCEPT / FULL_STATE_SNAPSHOT messages, 0 CHANGES_REQUEST, across 3 sessions in both
  directions** (asserted in `tests/pkg5b_snapshot_conflicts.test.ts`, "M-4 efficiency" test).

**M-4 disposition: FIXED (trigger-firing scope).** The M-4 finding's corrected scope per QA was
"the trigger fires even on converged peers because neededRanges includes self-produced
sequences" — that is exactly what is fixed and regression-pinned. The broader "architectural"
framing (full-state transfer efficiency generally) is moot for the converged-pair case:
converged peers now exchange zero full-state traffic; Trigger A fires only for genuinely
unservable gaps (fresh/compacted peers), where the exchange is the designed mechanism.

### Fix A (residual guard): conflict-aware `applySnapshot` — preserves DC-03 §3.3 across snapshots

Reproduced at HEAD (probe PROBE-A + Pkg5-review P9): after any snapshot exchange, the
conflict-diverged local row value was overwritten by the §7.1 domination winner ("From A" →
"From B") while the conflict ROW survived — an implicit winner selection that defeats
DC-03 §3.3/§3.4/TR-2 ("local value kept until resolution") and leaves the UI showing an
unresolved conflict whose row reflects neither the local nor a user-chosen value.

Fix (`src/sync/full_state.ts`):
- New `hasUnresolvedConflict(db, entity_id)`: `SELECT 1 FROM conflicts WHERE entity_id = ? AND
  status = 'unresolved' LIMIT 1` (read-only; full_state still never writes conflicts tables).
- In `applySnapshot`'s §7.1 staging loop: an entry whose entity carries an unresolved conflict
  row is SKIPPED (local materialized value + local entity version kept) and counted in a new
  `ApplyResult.conflictPreserved` counter. Non-conflicted entities keep §7.1 verbatim
  (regression-pinned by a synthetic dominated-snapshot test and the whole Pkg1 SC5 suite).
- Same guard in the §5.2 absence-deletion loop: an absent-but-dominated entity with an
  unresolved conflict is NOT absence-tombstoned (deleting the live row would be the same silent
  destruction; DC-03 §3.4 explicitly protects the concurrent edit from the concurrent delete).
- After user resolution the guard lifts naturally: status flips to `resolved_*` and the
  resolution change record raises the local version clock above the peer's snapshot_clock, so
  the resolution value survives §7.1 on its own merits (regression-pinned).

No redesign of the snapshot protocol; no weakening of §7.1 for non-conflicted entities; no
schema or persistence changes.

---

## 2. Files changed

Production (all within declared surface):
- `src/sync/knowledge_state.ts` — `neededRanges` optional `selfDeviceId` filter (+ doc).
- `src/sync/sync_engine.ts` — pass `deps.selfDeviceId` at both pull-loop call sites;
  `seedSelfAppliedFrontier()` called at session start (+ doc).
- `src/sync/full_state.ts` — `hasUnresolvedConflict()` helper; guard in the §7.1 replacement
  path and the §5.2 absence path; `ApplyResult.conflictPreserved` counter (+ docs).

Tests:
- `tests/pkg5b_snapshot_conflicts.test.ts` — NEW, 10 tests (see §3).
- `tests/pkg5_conflicts.test.ts` — header note + tests 5/10 updated: session-level rows now
  STAY DIVERGED per DC-03 §3.3 (each device keeps its own value; conflict rows + verbatim
  payloads unchanged). Previously these asserted snapshot-domination convergence of the rows —
  the exact behavior this package removes. Tests 1–4, 6–9, 11–13 untouched and passing
  (resolution propagation at §4.4 is causal, unaffected).

Evidence (untracked, left in place):
- `qa-review5b-tmp/probe5b.test.ts` — HEAD-baseline reproduction of both defects (PROBE-A/B)
  + post-fix verification; `qa-review5b-tmp/debug_au.test.ts` — applied_upto state dump.
- Reviewer/QA probe dirs (`qa-review5-tmp/`, `qa-tmp/probes/`) deliberately NOT modified.

No commits made; all changes uncommitted for lead review.

---

## 3. Regression coverage (`tests/pkg5b_snapshot_conflicts.test.ts`, 10/10 green)

1. **THE core regression**: conflict created at T2 (same-field concurrent edits) → snapshot
   exchange in BOTH directions → conflict row survives unresolved with both payloads verbatim
   AND local materialized value NOT overwritten ("From A" on a, "From B" on b);
   `conflictPreserved == 1` per side.
2. Absence rule does not destroy a conflicted live row missing from the snapshot (guard on the
   §5.2 path); a non-conflicted absent row is still absence-tombstoned (§7.1 unchanged there).
3. After `ConflictsViewModel.resolve(keep_mine)`: snapshot exchange no longer counts the entity
   as conflicted (`conflictPreserved == 0`), the resolution value stands, the row stays
   `resolved_keep_local`.
4. Non-conflicted entities keep §7.1 domination semantics unchanged (synthetic dominated
   snapshot replaces the row).
5. Unit — `neededRanges` excludes self; converged peers → `[]`; legacy 2-arg form documents the
   old phantom-self behavior; genuine other-producer gaps still reported; pending/skipped
   exclusions still honored.
6. M-4 efficiency: converged pair, 3 sessions × both directions → zero FULL_STATE_* messages,
   zero CHANGES_REQUEST (and no request names a device of the pair); pkg1-harness trace is
   exactly `["HELLO","CHANGES_ACK"]`.
7. Pkg5b companion: re-delivery of the device's OWN record → `duplicate` (seeded self frontier);
   no state change.
8. Genuinely gapped peer (compaction → fresh peer C) → Trigger A still fires (FULL_STATE_OFFER
   with `reason:"GAP_ROUNDS"` in the initiator log; responder streams FULL_STATE_SNAPSHOT) and
   the exchange completes (C materializes all 5 events; frontiers converge).
9. Conflict via real sessions + further real sessions → local values still kept per device
   (diverged), conflict rows untouched.

---

## 4. Results (COMMAND + EXIT STATUS)

- `npx vitest run tests/pkg5b_snapshot_conflicts.test.ts` → **exit 0** (10 passed).
- `npx vitest run tests/pkg1_compaction_snapshot.test.ts tests/pkg1_compaction_snapshot.property.test.ts`
  (Pkg1 SC5 regression, required to still pass) → **exit 0** (10 passed).
- `npx tsc -p tsconfig.json --noEmit` → **exit 0**.
- Full suite `npx vitest run` → exit 1; **526 passed / 8 failed of 534** (47/54 files).
  Failure disposition:
  - Pre-existing documented set (unchanged from HEAD, re-verified by stash-run):
    `tests/month_view_clicks.test.ts` (chip-count flake),
    `qa-tmp/probes/sc5_snap_quar_restart.qa.test.ts` SC6 + SC7,
    `qa-review5-tmp/qa5_probe11.test.ts` P11 (documented pre-existing observation, pkg5-review §6.1).
  - Behavior-change failures (4) — all in UNTRACKED QA-campaign evidence probes outside
    `tests/`, each asserting the OLD behavior this package deliberately removes:
    - `qa-review5-tmp/qa5_probes.test.ts` P9 session-level ("row values converge" — now they
      legitimately stay diverged; its P9 engine-level half passed at HEAD and its P3/P7 halves
      pass again after the self-frontier companion fix, unmodified).
    - `qa-tmp/probes/sc_repro.qa.test.ts` SC2, `sc7_abort_sc8_three.qa.test.ts` SC8,
      `sc9_tcp.qa.test.ts` SC9 — all assert pairwise row convergence of same-field concurrent
      edits, i.e. the snapshot-domination winner selection. Under the corrected contract these
      probes' "converged" success flag is no longer the specified outcome for UNRESOLVED
      conflicts. Left untouched (they are QA evidence artifacts, not the regression suite);
      the lead may want them re-pointed at the new divergence contract or retired.

---

## 5. Remaining uncertainty

1. **DC-03 vs DC-09 owner ruling** (carried over from pkg5-report §6, now narrower): for an
   entity with an unresolved conflict, this package makes DC-03 §3.3 govern the MATERIALIZED
   row value while DC-09 §7.1 still governs the clock/frontier exchange (snapshot entries for
   conflicted entities are skipped entirely, including their version merge — the local version
   stays anchored to local history). If the lead instead wants "record the domination outcome
   as data", that is a follow-up on top of this guard (the guard is the safety floor either way).
2. **Divergence is now observable session-level** — pkg5 tests 5/10 updated accordingly. The
   Conflicts UI (when wired) is the resolution path; until resolution, peers see divergent
   values for the conflicted field. That is the contract (TR-2), but it is a user-visible
   change from the pre-Pkg5b silent convergence.
3. `applied_upto[self]` seeding is a new durable row written by the sync layer (existing table,
   no schema change; MAX-merge, monotone with T2). Sweep interaction reviewed: `sweepOn` builds
   constraint peers' clocks from `applied_upto`; self-components are truthful and cannot cause
   over-deletion of OTHER producers' rows (verified by the full Pkg1 compaction suite passing).
4. The reviewer's P11 (causal-before stale overwrite through the gap buffer, pkg5-review §6.1)
   remains open and is untouched by this package (different path: change pipeline, not snapshots).

---

## 6. Pkg5b completion — anti-entropy diagnosis & SC9 resolution (addendum)

Date: 2026-08-30 · Trigger: lead analysis flagged SC9 `phase2Converged=false` 3/3 as "the
responder's new data has no push path in a single-direction session" after the Trigger-A fix
removed the accidental snapshot carriage. This addendum diagnoses that finding against the
contracts, states which of the candidate explanations is true, and records the fix + tests.

### 6.1 What the contracts specify

- **DC-08 §4 (canonical anti-entropy exchange)**: *"Both sides run the SAME role. Each
  independently pulls what IT needs; there is no coordinator, no master, no push authority
  (INVARIANT 11)."* The canonical sequence diagram shows BOTH pulls inside ONE session
  (A→B `CHANGES_REQUEST`/`CHANGES_BATCH`/`CHANGES_ACK` **and** B→A likewise), and the
  SYMMETRY property makes it explicit: *"A pulling from B and B pulling from A are
  independent exchanges multiplexed over one session. Neither waits for the other's pull to
  start its own."*
- **DC-08 §7**: *"NO PUSH AUTHORITY. A peer can never make us apply anything; it can only
  answer our pulls. All application is locally gated."* — this eliminates the "initiator
  pushes its own new records" candidate (b) outright: a push path is contractually
  forbidden.
- **DC-09 §3/§7**: the full-state exchange is a *"heavy, exceptional event"* carried by the
  deterministic §3 triggers (Trigger A GAP_ROUNDS distress, staleness #7), *"bypassing all
  dedup and all thresholds"* only for recovery. It is NOT the routine data path — so the
  intended way for the responder's new data to reach the initiator is the responder's OWN
  incremental pull (DC-08 §4), not snapshot carriage, and not alternating sessions.
- **DC-08 §4 CONVERGENCE**: *"each completed round strictly reduces the union of missing
  ranges; repeated opportunistic sessions reach eventual consistency."* Alternating
  initiation (candidate c) is a deployment scheduling concern (DC-08 §9: trigger scheduling
  → deferred #13/#14), not a correctness mechanism.

**Contract answer: (a)** — one session is full bidirectional anti-entropy; the responder
pulls what it needs in the same session.

### 6.2 Diagnosis: the product already implements (a); SC9 was racing it

Method: instrumented wire-trace probes (evidence, untracked:
`qa-review5b-tmp/anti_entropy_trace.test.ts` — in-memory + real-TCP message logs with
timestamps; `qa-review5b-tmp/race_window.test.ts` — race-window measurement).

Findings:

1. **Both peers run the full engine.** The responder is not a passive server:
   `sidecar_server.ts` `onInbound` → `runEngineSession` runs a complete
   `createSyncEngine(...).runSession(...)` for every inbound connection. The engine's
   pull loop is role-agnostic — the responder computes `neededRanges(peerHello.device_clock,
   selfDeviceId)` and sends its own `CHANGES_REQUEST` exactly like the initiator.
2. **Wire trace proves the responder pulls.** In the SC9 phase-2 shape (B initiates toward
   A, B holds 2 new events) over real TCP, A (responder) sends
   `CHANGES_REQUEST{device_id: B, lo: 2, hi: 3}`, B serves `CHANGES_BATCH`, and A applies it
   (`applied_upto[B] = 3`). Convergence happens in the ONE session — the "missing push
   path" does not exist because no push path is needed: A's new data reaches B because B
   pulls, and B's new data reaches A because A pulls, both multiplexed over the single
   session (DC-08 §4 SYMMETRY).
3. **The actual defect is a PROBE RACE, not a protocol gap.** Because the two directions
   are *independent exchanges* (DC-08 §4), the initiator's `runSession` resolving is NOT a
   barrier for the responder's session. Measured deterministically (3/3 runs): B's session
   resolves at +115 ms while A applies B's pulled batch at +135 ms — a ~20 ms window in
   which the SC9 oracle read A's database mid-session. The original probe asserted
   convergence immediately after the client session resolved.
4. **Which was masked by the accidental carriage?** SC9 passing 3/3 at the QA baseline was
   indeed an accident — but it masked a *probe synchronization* flaw, not a product gap.
   At the baseline, the phantom self-request fired Trigger A on every session
   (pkg5b-report §1 Fix B), and the resulting FULL_STATE_OFFER/ACCEPT/snapshot exchanges
   stretched the client session long enough that the responder's apply landed before the
   oracle read. Pkg5b's M-4 fix (converged peers exchange zero full-state traffic) made
   sessions lean, exposing the race 3/3. The product's data path was already correct.
5. **Correction to pkg5b-report §4**: that section described SC9's failures as asserting
   "pairwise row convergence of same-field concurrent edits" (snapshot-domination winner
   selection). That is WRONG for SC9: SC9 creates *disjoint new events* on each side and
   asserts event-table equality — it never creates a conflict. Its post-5b failure was
   purely the §6.2-3 race. (The conflict-shaped probes sc_repro SC2 / sc7 SC8 remain
   covered by that §4 disposition.)

### 6.3 Fix (probe only — zero product change)

Per the contract answer (a) being already implemented, the principled fix is the SC9 PROBE
expectation, not product code:

- `qa-tmp/probes/sc9_tcp.qa.test.ts`: the `serveSync` callback now records the responder
  session promise, and after each phase's `s.done()` the probe awaits the recorded
  responder session (bounded 15 s) before reading the oracle. Header comment documents the
  DC-08 §4 independence rationale. Convergence semantics asserted are unchanged.

### 6.4 New regression coverage (`tests/pkg5c_anti_entropy.test.ts`, 3/3 green)

1. **Single-session bidirectional convergence** (in-memory pipes, engine on BOTH ends —
   the real runtime shape): new data on BOTH sides, ONE session → both converge; wire
   evidence pins DC-08 §4 SYMMETRY: `CHANGES_REQUEST` present in BOTH directions' logs and
   `receivedApplied > 0` on both sides.
2. **Converged-pair silence preserved**: a pair with nothing to need exchanges zero
   `CHANGES_REQUEST` / `FULL_STATE_*` in a session (M-4 corrected behavior stays pinned).
3. **Real TCP, SC9 phase-2 shape, 3/3**: responder holds new data; initiator's session and
   responder's session both awaited (contract-independence) → convergence each run, ports
   41310-41312.

### 6.5 Results (COMMAND + EXIT STATUS)

- `npx vitest run qa-tmp/probes/sc9_tcp.qa.test.ts` → **exit 0**, 3/3 runs green;
  re-run twice more for stability → both green.
- `npx vitest run tests/pkg5c_anti_entropy.test.ts` → **exit 0** (3 passed).
- `npx vitest run tests/pkg1_compaction_snapshot.test.ts
  tests/pkg1_compaction_snapshot.property.test.ts tests/pkg5_conflicts.test.ts
  tests/pkg5b_snapshot_conflicts.test.ts tests/pkg4_sync_timeout.test.ts` → **exit 0**
  (40 passed) — Pkg1 SC5 suite, Pkg5 conflict tests, Pkg5b suite, Pkg4 idle timeouts all
  still green.
- `npx tsc -p tsconfig.json --noEmit` → **exit 0**.
- Full suite: see §4 dispositions, plus the SC9 line there is superseded by this addendum
  (SC9 now green). Documented pre-existing failures unchanged.

### 6.6 Files touched by this addendum

- `qa-tmp/probes/sc9_tcp.qa.test.ts` — probe synchronization fix (documented in-file).
- `tests/pkg5c_anti_entropy.test.ts` — NEW regression suite (§6.4).
- `docs/qa/remediation/pkg5b-report.md` — this section.
- Evidence (untracked, left in place): `qa-review5b-tmp/anti_entropy_trace.test.ts`,
  `qa-review5b-tmp/race_window.test.ts`.

No `src/` file was modified by this addendum; no network-layer or persistence change was
needed — the protocol gap hypothesized by the lead does not exist in the product.
