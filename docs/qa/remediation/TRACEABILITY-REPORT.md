# Tide Remediation Campaign — FINAL TRACEABILITY REPORT & RELEASE VERDICT

Date: 2026-08-30 · Branch `remediation` · Worktree /tmp/tide-remediation
Baseline: 52d54ab (QA consolidation report, AMBER verdict, commit on main)
Final HEAD at report: see commit ledger below. Scope: remediation campaign
only — every original QA finding from docs/qa/CONSOLIDATION-REPORT.md
(plus review-residuals raised during the campaign) is dispositioned here.
No finding is silently omitted. No production code changed in this report.

---

## 1. Commit ledger (all on branch `remediation`)

| Package | Commit(s) | Scope |
|---|---|---|
| Pkg1 | 4dbb516 (+83dedbf cleanup) | C-1 compaction×snapshot data loss (CRITICAL) |
| Pkg2 | cdece6f | M-1 identity corruption at sidecar boundary (CRITICAL) |
| Pkg3 | ee3b154 | M-5/M-6/m-3(m-4)/F-2 input validation |
| Pkg4 | d0642ad | M-3/F3 + BND-08 sync session timeouts |
| Pkg5 | 2079ad2 | M-2/F2 DC-03 conflict pipeline wired |
| Pkg5b | 0af8fed | P9 residual + M-4 root cause (self-exclusion, seedSelfAppliedFrontier, conflict-aware applySnapshot) |
| Pkg6 | 96a257a + 38f00b1 | hygiene sweep (F-1/F-5/F-6/P11/BND-06 + baseline cleanup) |
| Docs | 6961e23 | deferred adversarial validation report |
| Docs | (this commit) | final traceability report |

Every package 1–5b passed the full gate: implementation agent → lead
validation (own repro + tsc + focused suite) → unprimed adversarial review
→ lead commit. Pkg6 was hygiene-only with per-item test assertions.

## 2. Finding-by-finding traceability matrix

Severities are the original QA-campaign severities. "Evidence" = regression
test (in committed suite) and/or committed report section.

| Finding ID | Original severity | Final disposition | Package | Commit(s) | Review result | Regression/validation evidence | Final status |
|---|---|---|---|---|---|---|---|
| C-1 (QA-1 F1) compaction×snapshot destroys live events | CRITICAL | FIXED | Pkg1 | 4dbb516 | PASS (two-reviewer salvage cycle; 20/20 migration kill-timings) | entity_versions v6 durable snapshot state + absence-guard; AV S1a/S1c (8/8 kill-timings, idempotent sweep, fresh-peer convergence) | CLOSED |
| M-1 (BND-01, BND-05/m-4) update_event input.id phantom corruption | CRITICAL | FIXED | Pkg2 | cdece6f | PASS (42-check attack battery incl. __proto__; 18-check TCP divergence probe; differential pre/post) | identity contract enforced at sidecar; input.id rejected create+update; pkg2-phantom-detect.mjs shipped for pre-fix DBs | CLOSED |
| M-5 (BND-02) endMs<startMs, response/persisted/synced disagree | MAJOR | FIXED | Pkg3 | ee3b154 | PASS (28-case value matrix; sync-agreement probe; ±8.64e15 epoch domain decided) | validateEventValues canonical; endMs≥startMs enforced; single stored value | CLOSED |
| M-6 (BND-03) scalar type confusion at sidecar seam | MAJOR | FIXED | Pkg3 | ee3b154 | PASS (same matrix) | silent transformation eliminated (no "42.0", no "abc"→0, 1e999 rejected) | CLOSED |
| m-3 (BND-04) allDay silent normalization | MINOR | FIXED | Pkg3 | ee3b154 | PASS (same matrix) | strict boolean contract | CLOSED |
| QA-2 F-2 update_event raw NOT NULL error on partial input | MINOR | FIXED | Pkg3 | ee3b154 | PASS | full-input contract, explicit rejection | CLOSED |
| M-2 (QA-1 F2) conflict detection unwired | MAJOR | FIXED | Pkg5 | 2079ad2 | PASS (DC-03 citations verbatim incl. future-hlc no-LWW probe) | detect() wired at T2; local-value-kept verbatim §3.3; list_conflicts/conflict_detail ops; allow-list 14→16 | CLOSED |
| M-3 (QA-1 F3) unbounded pull-phase wait | MAJOR | FIXED | Pkg4 | d0642ad | PASS (unbounded-receive hunt; 290/310ms boundary; watchdog races 0 unhandled) | 15s per-message idle timeout (env-overridable); sync_now returns deterministic ok:false in every peer-failure mode; tests/pkg4_sync_timeout.test.ts | CLOSED |
| BND-08 sync_now to unroutable host, no cancel | MAJOR-correlate | FIXED | Pkg4 | d0642ad | PASS (P11a: real TCP to 203.0.113.1 bounded 501ms with override; default 15s connect watchdog) | same test file | CLOSED |
| M-4 (QA-1 F4) every session degenerates to full-state transfer | MAJOR | FIXED | Pkg5b | 0af8fed | PASS (4 non-blocking; backup-restore attack constructed → adjudicated out of contract, see §4) | neededRanges self-exclusion + seedSelfAppliedFrontier; converged-pair sessions wire-silent ([HELLO, CHANGES_ACK] asserted across 3 sessions both directions); tests/pkg5b_snapshot_conflicts.test.ts + tests/pkg5c_anti_entropy.test.ts | CLOSED |
| P9 residual (pkg5-review) snapshot domination overwrites conflict-diverged values | MAJOR (campaign-raised) | FIXED | Pkg5b | 0af8fed | PASS | conflict-aware applySnapshot (DC-09 §7.1 + §5.2 guard); guard never resurrects deleted entities, lifts on resolution; AV S1d (conflict row survives crashed snapshot exchange) | CLOSED |
| QA-1 F5 (m-1) re-quarantine after frontier advance | MINOR | FIXED | Pkg6 | 96a257a | per-item test-asserted (hygiene package) | durable (device_id, local_seq) dedupe before insert; SC6 now passes | CLOSED |
| QA-1 F6 (m-2) zombie pending_changes row | MINOR | FIXED | Pkg6 | 96a257a | per-item test-asserted | gcZombiePending() at engine construction + session start; SC7 assertion now deterministic | CLOSED |
| QA-2 F-1 spurious authoritative calendar change per restart | MAJOR (held) | FIXED | Pkg6 | 96a257a | per-item test-asserted | bootstrap runs only when calendar row missing; latent LWW rename-revert trap removed | CLOSED |
| BND-06 list_series allow-list drift | MINOR | FIXED (implemented, not removed — frontend actively calls it; grep-verified precondition refuted) | Pkg6 | 96a257a | per-item test-asserted | dispatcher case added; read-only, zero change records; wired end-to-end | CLOSED |
| pkg1-review H1 calendar snapshot loop under-inclusive | MINOR (campaign-raised) | FIXED | Pkg6 | 96a257a | per-item test-asserted | calendar loop uses _unversioned placeholder; fresh peer never stranded without calendar | CLOSED |
| P11 anomaly (pkg5b-review §3/§6-A) HELLO clock anomaly invisible | MINOR (campaign-raised) | FIXED as health cue | Pkg6 | 96a257a | per-item test-asserted | [tide][health] warning + counter + stats.helloClockAnomaly; deliberately not fed to misbehavior ladder; doubles as the restore-collision tech-debt signal | CLOSED (as designed signal) |
| QA-1 F8 deleting peer retains no tombstone row | OBSERVATION | FIXED via same code path | Pkg1 | 4dbb516 | PASS (part of C-1 package) | snapshot absence-rule corrected; tombstone semantics covered by snapshot correctness work | CLOSED |
| QA-1 F7 known-seq malformed records invisible to DC-16 accounting | OBSERVATION | NOT REPRODUCED as defect / accepted behavior; duplicate-drop precedes validation by design; DC-16 accounting applies to accepted-for-validation records | — | — | — | noted in campaign log; no product change | OBSERVATION-ACCEPTED |
| QA-1 F9 noise-wasm unhandledRejection → exit(1) | OBSERVATION | PARTIALLY MITIGATED | Pkg4 | d0642ad | PASS | unhandled-rejection guard on losing connect promise (the identified live path); remaining general case recorded as tech debt | MITIGATED / TECH DEBT |
| BND-07 protocol leniency quirks (dup JSON keys last-wins, id 1e999→null, same-id in-flight ambiguity) | OBSERVATION | OUT OF SCOPE (deferred; no correctness impact demonstrated) | — | — | — | documented in consolidation report | DEFERRED |
| QA-2 F-3 migration torn-write window | OBSERVATION | NOT REPRODUCED (sub-ms transaction not constructible via public surface; demonstrated safe 8/8) | — | — | — | QA-2 evidence | SAFE-BY-CONSTRUCTION / NOT REPRODUCED |
| QA-2 F-4 WAL backup tooling must copy -wal alongside -db | OBSERVATION | OUT OF SCOPE (operational documentation) | — | — | — | recorded; no product code owns backups yet | DOCUMENTED |
| SC2/SC8/qa5-P9/qa5-P11 probe failures (4) | test-level | INTENTIONALLY REPLACED SEMANTICS (see §5) | Pkg5/5b | 2079ad2/0af8fed | pkg5b-review §5: conflict rows present and unresolved on every device behind each failure — no data loss | skip-noted in-file with disposition comments (commits 96a257a/38f00b1) | EXPECTED FAILURE (documented) |
| Backup-restore seq-collision on neededRanges self-exclusion (pkg5b-review) | attack scenario | OUT OF CONTRACT (DC-05 §2.2 / Spec §25: restore = new identity, private keys never in backups; DC-02 §4.3 MAX-merge mandate). Old code's "recovery" was itself the M-4 pathology. Detection signal implemented (P11 HELLO anomaly, Pkg6). | Pkg6 | 96a257a | reviewer-traced to contracts | pkg5b-review adjudication | OUT OF CONTRACT (tech debt recorded) |
| S2b (AV) flood during crash recovery | validation scenario | PARTIAL coverage | AV | 6961e23 | — | recorded as coverage limitation; S2a/S2c/S3b cover the intake paths | PARTIAL (documented) |

## 3. Deferred adversarial validation (post-fix, this campaign)

Committed 6961e23, docs/qa/remediation/adversarial-validation.md:
**9/9 scenarios PASS** (S2b partial). Headline S1a (crash-equivalent
mid-apply of a post-compaction snapshot to a fresh peer): 8/8 kill-timings
2–23ms — integrity ok, 5/5 events, retry converges, no phantom rows. The
Pkg1 durability design, Pkg5b conflict-preservation guard (S1d), Pkg6 F-5
bound (S2a), and Pkg4 timeout (S2c no false trigger) all held under the
exact violence they were built for.

## 4. Tech-debt register (recorded, non-blocking)

1. Backup-restore seq-collision (out of contract; DC-02 §4.1 HELLO anomaly
   signal implemented as the detection cue).
2. Conflict-preservation guard is per-entity; per-field guard candidate.
3. F9 residual: general unhandled-rejection → exit(1) hardening.
4. BND-07 protocol leniency quirks.
5. Tier-1 DC-16 threshold not exercised end-to-end (needs engine wiring for
   injected windows; intake-drop/ladder paths unit-covered).
6. Real-WAN latency behavior of the 15s idle bound (loopback-validated only).
7. TD-009 frontend Cancel button (pre-existing debt registry).

## 5. Final suite baseline

**550 passed / 4 failed of 554** (60 files), tsc clean, artifacts rebuilt.

The 4 failures are skip-noted probes asserting the pre-Pkg5 implicit-LWW
convergence semantics that DC-03 §3.3/§3.4 deliberately replaced; the
adversarial review verified conflict rows exist and are unresolved on every
device behind each one — intentional divergence pending user resolution,
no data loss. SC6, SC7, and the month_view date-flake all now pass.
3 of the 7 earlier standing failures were pre-existing/environmental and
are closed by Pkg4/Pkg6 work; the remainder are the 4 documented probes.

## 6. RELEASE VERDICT: **GREEN (pre-release, within tested scope)**

**Resolved release blockers:** both CRITICAL blockers (C-1, M-1) are FIXED,
independently reviewed PASS, and re-validated under adversarial combined
faults. All MAJORs (M-2 through M-6, M-4, BND-08) are CLOSED with the same
gate. No known release-blocking defect remains.

**Remaining known limitations / tech debt:** §4 above — all non-blocking,
none with demonstrated data loss or availability impact.

**Pre-existing failures / replaced test semantics:** the 4 skip-noted
probes (§5) — intentional, documented in-file, conflict-backed.

**Genuinely proven healthy (do not re-litigate):** storage/persistence core
(100+ acked writes durable across kills; T1 atomicity; WAL integrity),
IPC frame handling (28/28 malformed classes, 100-deep pipelining, floods),
pairing-offer lifecycle (30 cycles, zero leaks), quarantine mechanics
(incl. post-Pkg6 dedupe), real-TCP mid-kill convergence, bidirectional
anti-entropy per DC-08 §4, conflict pipeline + conflict-aware snapshots
under crash violence, bounded sync sessions, and the validated input
surface (28-case matrix).

**Not fully proven (honest gaps):** DC-16 Tier-1 end-to-end escalation
(inference from unit coverage, not campaign evidence); real-WAN idle-timeout
behavior; GUI-layer surfaces under adverse input (QA verified the sidecar
contract and static allow-list only; GUI correctness rests on the
smoke-test rounds, owner visual passes pending); migration torn-write is
safe-by-construction, not by observation; S2b partial.

**Verdict rationale:** every finding from the AMBER consolidation report is
either CLOSED through the full evidence gate, explicitly dispositioned
(OUT OF CONTRACT / OUT OF SCOPE / NOT REPRODUCED / DOCUMENTED), or recorded
as tech debt. Nothing was silently dropped. The two conditions the AMBER
verdict set for release ("until two fix packages land") are met and
surpassed. Ship-readiness now rests on the owner's visual smoke-test pass
and the standing constraint: **do not wire scheduler→sweep** until the
compaction feature itself is deliberately shipped.

## 7. Scratch-directory decision (per owner instruction)

The `qa-review2/3/4/5/5b/5c-tmp/` directories remain **untracked, not
removed**. Reason: `qa-review5-tmp/` and `qa-tmp/probes/` contain test
files that are part of the counted 554-test suite (the 4 skip-noted
disposition probes live there), and several review reports cite probe
files inside the other `qa-reviewN-tmp/` dirs as reproducibility anchors
(e.g. pkg5b-report → qa-review5b-tmp/probe5b.test.ts; pkg6-report →
qa-review5c-tmp/sc7-long.probe.test.ts). They are therefore evidence, not
pure scratch. Removal/ archival is deferred to an owner decision after the
probe files are either promoted into tests/ or formally retired.
