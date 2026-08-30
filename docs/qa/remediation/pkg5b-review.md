# Package 5b — Independent Adversarial Review (conflict-aware snapshot + anti-entropy completion)

Date: 2026-08-30 · Reviewer: independent adversarial reviewer (read-only on `src/`; probes under
`qa-review5c-tmp/`) · Subject: uncommitted Pkg5b changes on HEAD 2079ad2, incl. the anti-entropy
completion addendum (pkg5b-report §6). `docs/qa/remediation/pkg5b-report.md` was read only AFTER
the assessment below was fixed (falsification probes + contract checks + clean-HEAD comparison).

---

## 1. VERDICT

**PASS** — for the Pkg5b completion as scoped (conflict-aware snapshot + self-exclusion + self-
frontier seeding + SC9 probe synchronization), with four recorded concerns (§6), none of which is
a defect in the delivered code within the contracts' model.

- tsc `--noEmit` clean (exit 0).
- Full suite: **533 / 540 pass, 7 fail** — every failure classified (§5), none unexplained,
  none masking data loss (verified by direct DB inspection, not by trusting assertions).
- Targeted green confirmed independently: pkg1 (both), pkg5, pkg5b, pkg5c, full_state,
  sync_engine, knowledge_state, TD-001 regression — 9 files, 62/62.
- SC9 passes 3/3 post-fix (re-run by this reviewer, independently of the agent).

---

## 2. FALSIFICATION TABLE

| # | Attack | Result | Evidence |
|---|--------|--------|----------|
| 1 | **Backup-restore on self-exclusion**: device's DB rolled back to older state, same device id, peers hold newer own seqs → own tail unrecoverable? | **CONFIRMED — but out of contract** (see §3). Empirically: lost own seqs are NOT pulled back (self excluded from neededRanges, no Trigger A, DC-08 §7 forbids peer push), and the next local write re-allocates the colliding seq. The scenario is excluded by DC-05 §2.2/Spec §25 (restore = new identity, key never in backups) and DC-02 §4.3 (restore must MAX-merge, never assign). The seq-collision half is pre-existing and independent of Pkg5b. | probe `qa-review5c-tmp/restore-attack.probe.test.ts` ("backup-restore attack") — after 2 sessions: own changes stuck at restored 3, `appliedUptoSelf=3`; next write allocates seq 4 while peer holds a different a#4 |
| 2 | `seedSelfAppliedFrontier` over-advances `applied_upto[self]` → skips legitimate later re-delivery / hides missing self-records | **REFUTED (honest operation)**. Seed = MAX(changes.max(self), device_clock[self]); by DC-02 §4.1 device_clock[SELF] advances only via own T1 writes, and T1 applies what it writes, so the seed equals the true produced frontier. Re-delivery of own records is duplicate by definition. The ONLY untruthful inputs are out-of-contract (raw DB rollback — attack 1 — or Byzantine clock inflation via the pre-existing self-component clock merge, §6-C). | code read (sync_engine.ts seed, database.ts T1/mergeClocks); pkg5b test 7 pins own-echo → duplicate; P3/P7 pass unmodified |
| 3 | Conflict-preserved path keeps a DELETED entity alive forever (delete vs conflict-row interplay) | **REFUTED**. Guard only SKIPS snapshot application; it never resurrects (replacement path skips the entry; absence path skips the tombstone). Deleter keeps its deletion, editor keeps its edit, both under unresolved conflict rows; a locally deleted entity is absent from `events` so neither guard can fire on it. Resolution lifts the guard (status → `resolved_*`; pinned by pkg5b test 3). | probe (SC8 replica): HUB liveRow=0, SAT1 liveRow=1, SAT2 liveRow=0 — ALL THREE hold unresolved conflict rows (`'*'` on the direct pair, `'title'` via relay) |
| 4 | Non-conflicted entities lose exact §7.1 semantics | **REFUTED**. Guard sits after the `survivedLocal` check and before the Pkg1 idempotence skip; non-conflicted staging/absence logic untouched. Pkg1 suites, full_state, property tests, TD-001 — all green (62/62 incl. synthetic dominated-snapshot test). | test run (§1); pkg5b test 4 |
| 5 | SC9 fix awaits the responder using protocol knowledge the probe shouldn't have; no protocol barrier exists | **REFUTED (as objection); one design note**. The probe records the HOST-side session promise in the `serveSync` accept callback (app wiring: sidecar `onInbound → runSession`), not wire internals. The protocol does offer an ACK-level primitive (`CHANGES_ACK` carries `applied_upto`) that could build a wire barrier, but the chosen approach injects nothing into the protocol. Note: the 15 s bounds are best-effort; an overrunning responder session would make the oracle read flaky (strict assertion, so flaky-fail, never false-pass). | DC-08 §4 read; sc9 diff read; SC9 3/3 green in this reviewer's run |
| 6 | Probe failures (SC2/SC8/qa5-P9/P11) mask real data loss | **REFUTED**. Clean-HEAD worktree run separates pre-existing from behavior-change; for every behavior-change failure the divergence is backed by verified unresolved conflict rows (row 3; SC2's per-device divergence + verbatim payloads pinned in pkg5 tests 5/10). See §5. | `/tmp/tide-head-5c` worktree at 2079ad2; probes re-run both sides |

---

## 3. THE BACKUP-RESTORE ATTACK — detailed disposition

**Constructed and executed** (`qa-review5c-tmp/restore-attack.probe.test.ts`): device a produces
6 events (multiple change records), syncs to b; a's DB is rolled back (own `changes` rows above
seq 3 deleted, matching entity rows/versions deleted, `device_clock[a]=3`, `applied_upto[a]`
cleared — a consistent older file of the SAME device id). Sessions a↔b then run.

Observed: a ends with its own history still truncated (`afterChanges=3`, `clockA=3`,
`appliedUptoSelf=3`) — the self-exclusion blocks the pull-back, no Trigger A fires, and DC-08 §7
("NO PUSH AUTHORITY") forbids b from pushing. Additionally a's next local write allocates
`local_seq=4` while b already holds a#4 with a different payload — b will classify the new
record as duplicate (change_id = (device, seq) collision) and silently drop it.

**Why this is not a Pkg5b defect:**

1. **DC-05 §2.2 / Spec §25**: `device_id` is derived from the keypair; "the private key … is
   never included in backups (Spec §25: **restore = new identity**)". A restored device cannot
   legally return with the same device id. Under its new id it has zero self history and the
   exclusion is a no-op — there is nothing to exclude.
2. **DC-02 §4.3**: "Restore-from-backup must take max with restored state, never assign
   (Spec INVARIANT 10)." A raw same-id file rollback is a non-conformant restore procedure by
   definition.
3. **The removed recovery path was the M-4 pathology itself.** Pre-Pkg5b, the phantom self-range
   fired Trigger A / self-requests every session; in the rollback case that accident would
   happen to re-fetch the lost tail — but only if a session ran before the user's next local
   write. That is the exact behavior QA M-4 chartered this package to remove.
4. **The seq-collision hazard is pre-existing and Pkg5b-independent**: after a raw rollback, the
   user's next local write allocates the colliding seq regardless of Pkg5b (T1 allocation rule
   untouched); pre-Pkg5b it was masked only when a recovery session happened to run first.

**Recommendation (owner, follow-up, not a Pkg5b blocker):** record a technical-debt item that
backup/restore tooling MUST be Spec §25 / DC-02 §4.3 conformant, plus a cheap hardening hook:
on HELLO, a peer advertising `self > device_clock[self]` is DC-02 §4.1's "impossible unless
identity theft" condition — surface it as a DC-16/health signal (and operator-visible recovery
cue) instead of silently ignoring it. This restores observability of the rollback case without
reintroducing the phantom pull.

---

## 4. CITATION CHECKS

1. **DC-08 §4 (anti-entropy completion)** — VERIFIED VERBATIM, and it means what the agent
   claims. Line 414: *"Both sides run the SAME role. Each independently pulls what IT needs;
   there is no coordinator, no master, no push authority."* SYMMETRY property (§4, properties):
   *"A pulling from B and B pulling from A are independent exchanges multiplexed over one
   session. Neither waits for the other's pull to start its own."* The canonical diagram shows
   both pulls inside ONE session. DC-08 §7 line 575: *"NO PUSH AUTHORITY."* ⇒ One session IS
   bidirectional; the initiator resolving is not a barrier for the responder's independent
   exchange. The SC9 probe fix is the legitimate consequence. The agent's wire-trace claim
   (responder sends `CHANGES_REQUEST`, applies the served batch) is consistent with the engine
   code (`runSession` is role-agnostic; sidecar runs a full engine per inbound connection) and
   with `tests/pkg5c_anti_entropy.test.ts` test 1 (CHANGES_REQUEST pinned in both directions).
2. **DC-02 §5 (neededRanges)** — the contract pseudocode is device-agnostic; the self-exclusion
   is a **literal deviation** from §5's letter. It is justified by §4.1 + T1 contiguity: in
   honest operation `advertised[self] ≤ device_clock[self] ≤ applied_upto[self]` (after the
   seed), so the §5 formula itself yields no self ranges; the phantom existed only because
   `applied_upto[self]` was never tracked. The deviation never hides a genuine need inside the
   contract's model (attack 1 is out of that model, §3). Acceptable as a documented deviation;
   the code docstring documents it.
3. **DC-02 §4.1 vs the clock-merge paths (pre-existing, flagged)** — §4.1 says nothing but the
   device's own T1 write may advance `device_clock[SELF]`, yet `applyRemoteChange`'s
   `mergeClocks` and the skipped-record path's `mergeDeviceClock` upsert ALL causality_clock
   components including SELF. Harmless against honest peers (they cannot know a higher self seq
   than we produced), but a Byzantine peer can inflate `device_clock[self]`, which the Pkg5b
   seed would then propagate into `applied_upto[self]` (bounded impact: self-echo classification
   only; other producers' pulls unaffected; T1's MAX allocation rule makes inflation safe).
   Pre-existing, NOT introduced by Pkg5b — owner item.
4. **DC-03 §3.3/§3.4, DC-14 (resolution lifts guard)** — guard keys on `status='unresolved'`;
   `conflicts_ui.ts` resolution paths set `resolved_*`; pkg5b test 3 pins the lift. Consistent.

---

## 5. FULL-SUITE FAILURE CLASSIFICATION (all 7, verified — not taken on trust)

Method: clean worktree at HEAD 2079ad2 (pre-Pkg5b) with the same probe files, identical runs.

| Failure | At HEAD (pre-5b) | Classification |
|---|---|---|
| `month_view_clicks` chip-exclusivity ("expected 1 to be 2") | **FAILS identically** | pre-existing flake — not Pkg5b |
| SC6 quarantine re-delivery ("expected 2 to be 1") | **FAILS identically** | pre-existing (m-1 duplicate quarantine row) — Pkg6 candidate — not Pkg5b |
| SC7 abort+restart (timeout at 5000 ms) | **FAILS identically** | stale missing per-test timeout — **passes in 45 s when given 180 s** (verified, `qa-review5c-tmp/sc7-long.probe.test.ts`) — not Pkg5b |
| qa5 P11 (stale causal-before overwrite) | **FAILS identically** ("'B stale' vs 'C later'") | pre-existing reviewer-observation probe asserting desired-but-unimplemented semantics (pkg5-review §6.1 owner item) — not Pkg5b |
| SC2 same-field edits ×5 ("converged") | **PASSES at HEAD** → fails post-5b | **behavior change**: asserts implicit-LWW row convergence that Pkg5/DC-03 §3.3 replaced; divergence conflict-backed (pkg5 tests pin per-device divergence, verbatim payloads) — classified CORRECT |
| SC8 3-device delete-vs-edit ("same row state everywhere") | **PASSES at HEAD** → fails post-5b | **behavior change**, verified NOT data loss: my SC8 replica shows unresolved conflict rows on ALL THREE devices with the §3.4 pattern (deleter keeps deletion, editor keeps edit) — classified CORRECT |
| qa5 P9 session-level ("titles converge") | **PASSES at HEAD** → fails post-5b | **behavior change**: Pkg5b's exact target (P9 residual). Its own passing assertions confirm conflict rows frozen unresolved; its engine-level half passes (tolerant `toContain`). Classified CORRECT |

SC9: fixed probe passes 3/3 (this reviewer's run). pkg5c_anti_entropy: 3/3. Note the report's
§4 counts (526/8 of 534) predate the SC9 fix; current state is 533/7 of 540 — bookkeeping only.

---

## 6. CONCERNS (none blocking)

- **A. Backup/restore (§3)** — out-of-contract unrecoverability + pre-existing seq-collision;
  recommend tech-debt entry + DC-02 §4.1 HELLO anomaly signal.
- **B. Guard granularity** — `hasUnresolvedConflict` is per-ENTITY while DC-03 conflicts are per
  (entity_id, field_path). While any field's conflict is unresolved, snapshot application is
  blocked for the whole entity (non-conflicting fields rely on incremental T2 pulls, which are
  unguarded and per-field). Bounded staleness until resolution; tightening candidate (match
  `field_path`), not a blocker.
- **C. Self-component clock merges violate DC-02 §4.1's letter** (pre-existing, see §4.3).
- **D. neededRanges deviates from DC-02 §5's letter** (documented, conformant to §5's intent —
  §4.1; the seed is what makes the formula itself self-excluding in honest operation).

## 7. EVIDENCE INDEX (this review)

- `qa-review5c-tmp/restore-attack.probe.test.ts` — SC8 conflict-row spot-check (PASS) +
  backup-restore attack (recovery blocked, seq reuse demonstrated).
- `qa-review5c-tmp/sc7-long.probe.test.ts` — SC7 with 180 s cap: PASS in 45 s.
- `/tmp/tide-head-5c` — clean worktree at 2079ad2 used for the pre/post comparison runs
  (temp workspace; safe to delete).
