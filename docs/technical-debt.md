# Tide Technical Debt Log

Canonical project-level technical-debt registry. Stable IDs; statuses:
OPEN / INVESTIGATE / DEFERRED / BLOCKED / RESOLVED.
When an item is fixed: mark RESOLVED, record the resolving commit and the
regression test that proves it — do not delete entries.

Established 2026-08-27 after sync-engine milestone commit `e534c1f`
(verified state at commit: 320/320 tests, TSC clean, two-instance E2E
stable, independent final verification PASS WITH CONCERNS with zero new issues).

## How this register works

This file is the single register of known defects, risks and accepted limitations. Every item has one TD number and appears once; related items are cross-referenced, not duplicated.

Rule: no finding may live only in a branch or worktree. Before a branch or worktree is frozen or abandoned, its findings are moved into this register.

Status vocabulary used in the overview (each entry's own Status line below keeps its original wording and history):
- FIXED: done.
- OPEN: known, not fixed.
- CONFLICT ENGINE: open; belongs to the conflict-engine work.
- NEEDS DECISION: blocked on a design or contract decision.
- DORMANT WHILE SNAPSHOTS ARE OFF: only reachable if full-state snapshots are switched on again; they are off since commit 02563c5.
- ACCEPTED LIMITATION: accepted as it is.
- CLOSED BY DECISION: decided not to be a defect, or dropped.
- MERGED: the same defect as another TD, which keeps the evidence.

Operating constraint: full-state snapshots and change-log truncation are off (DC-06 and DC-09 operating constraint). Items marked DORMANT must be fixed before snapshots are switched on.

## Overview

| TD | Title | Status | Related |
|---|---|---|---|
| TD-001 | Quarantined sequence gap | FIXED | - |
| TD-002 | NaN numeric payload handling | FIXED | - |
| TD-003 | Legacy dev-* identity migration | OPEN | - |
| TD-004 | Sidecar identity-path E2E coverage | FIXED | - |
| TD-005 | Quarantine lifecycle: resolution state, retention, manual resolution UI | FIXED | - |
| TD-006 | Malicious or buggy peer flooding invalid sync packets | FIXED | - |
| TD-007 | Hygiene findings from TD-005/006/002 verification | FIXED | - |
| TD-008 | Slow-drip flood grows quarantine storage unboundedly | FIXED | - |
| TD-009 | Frontend Cancel button for pending pairing offer | FIXED | - |
| TD-010 | Tray ERROR-PRESENT marker (attention icon state) | OPEN | - |
| TD-011 | Visual verification pass for the 2026-08-31 wave | OPEN | - |
| TD-012 | Post-freeze full-suite verification pass | FIXED | - |
| TD-013 | Transient EADDRINUSE on harness port bands | FIXED | - |
| TD-014 | Recurrence expansion: INTERVAL/WEEKLY semantics broken | FIXED | - |
| TD-015 | Occurrence-override identity derived from moved start | FIXED | - |
| TD-016 | Unchecking Repeat silently deletes the whole series | FIXED | - |
| TD-017 | CHANGES_ACK semantics deviate from DC-08 3.4 | FIXED | - |
| TD-018 | Dead-carrier session masquerades as success | FIXED | - |
| TD-019 | Minor sync-layer hygiene | OPEN | - |
| TD-020 | Session-end barrier regressed 4 suite tests | FIXED | - |
| TD-021 | WebKitWebProcess renderer crash | CLOSED BY DECISION | - |
| TD-022 | Notification delivery portability | FIXED | - |
| TD-023 | Dev-launch taskbar icon depends on binary-stem app_id | FIXED | - |
| TD-024 | Damaged series data from pre-fix re-anchoring bug | FIXED | - |
| TD-025 | Sidecar SIGSEGV during pairing-code creation on Debian | OPEN | - |
| TD-026 | All-day end_date stored exclusive, violating DC-07 | FIXED | - |
| TD-027 | ics interchange conformance sweep candidates | OPEN | - |
| TD-028 | UI unresponsive while the Windows firewall UAC prompt is open | CLOSED BY DECISION | - |
| TD-029 | Per-user NSIS uninstaller likely cannot remove firewall rules | CLOSED BY DECISION | - |
| TD-030 | Conflict dialog shows raw data instead of readable values | FIXED | - |
| TD-031 | Conflicts badge count goes stale | FIXED | - |
| TD-032 | Long device ids truncated in Devices/Sync views | FIXED | - |
| TD-033 | Layout breaks in small windows | CLOSED BY DECISION | - |
| TD-034 | Sidecar stderr piped but never read | FIXED | - |
| TD-035 | mDNS browse restarted every 25 s | FIXED | - |
| TD-036 | Sync sessions accepted any handshake key, not only paired devices | FIXED | - |
| TD-037 | Conflict resolution always writes entity_type event / operation set | CONFLICT ENGINE | - |
| TD-038 | mDNS snapshot seeding is never populated | OPEN | - |
| TD-039 | Windows: settings live inside the data folder | OPEN | - |
| TD-040 | Pairing scanner stores trust before the other side confirms | MERGED | TD-058 |
| TD-041 | Full-state snapshots ignore the revoked-producer cutoff | FIXED | - |
| TD-042 | Revocation wire shape differs from DC-08 3.7 | NEEDS DECISION | - |
| TD-043 | Offering device does not show a refused re-pair | OPEN | - |
| TD-044 | The urgent-push ACK does not reach the revoking device | OPEN | - |
| TD-045 | Post-cutoff data that reached an unaware peer stays only there | OPEN | - |
| TD-046 | A device whose peers are all tainted can never accept full state | DORMANT WHILE SNAPSHOTS ARE OFF | TD-052, TD-083, TD-101 |
| TD-047 | A multi-message snapshot is applied per message, not as one unit | FIXED | - |
| TD-048 | A lone or repeated final snapshot message deletes the rest of the stream | DORMANT WHILE SNAPSHOTS ARE OFF | TD-052 |
| TD-049 | Pairing scanner checks session key against the other side's payload, not the pasted code | FIXED | - |
| TD-050 | A peer can announce a name that reads like another label | OPEN | - |
| TD-051 | Offering device sends its own name to whoever connects first | FIXED | - |
| TD-052 | A snapshot from a lagging sender deletes history it never held | DORMANT WHILE SNAPSHOTS ARE OFF | TD-046, TD-048, TD-063, TD-083 |
| TD-054 | Lookalike names are not disambiguated | OPEN | - |
| TD-055 | Names that render blank pass the name rule | OPEN | - |
| TD-056 | Any announced name that is a prefix of the sender's id is dropped | OPEN | - |
| TD-057 | Name field 'Room left' counts spaces that saving removes | OPEN | - |
| TD-058 | The pairing scanner stores trust before the other side confirms | OPEN | TD-040 |
| TD-059 | Pairing code text cannot be wiped from memory | OPEN | - |
| TD-060 | A connection that stalls inside the Noise handshake is never timed out | OPEN | TD-068 |
| TD-061 | DC-27 A.2 and DC-28 4.5 wording predates DC-05 Appendix B | OPEN | - |
| TD-062 | A listener-port test writes to /tmp whatever TMPDIR says | OPEN | - |
| TD-063 | The full-state offer exchange never completes over real TCP | DORMANT WHILE SNAPSHOTS ARE OFF | TD-052 |
| TD-064 | A sync batch above the Noise message limit fails silently | OPEN | TD-065 |
| TD-065 | One CHANGES_REQUEST is answered with every batch, but the puller applies one | OPEN | TD-064 |
| TD-066 | Ed25519 verification accepts universal signatures for small-order public keys | OPEN | - |
| TD-067 | Changes by an author never paired with arrive relayed through a paired device | NEEDS DECISION | - |
| TD-068 | The inbound frame queue is unbounded before and after authentication | OPEN | TD-060 |
| TD-069 | No per-record or per-producer size limit for applied change records | OPEN | - |
| TD-070 | Concurrent edits to series, occurrence overrides and calendars are not detected as conflicts (devices differ without warning) | CONFLICT ENGINE | TD-085, TD-088 |
| TD-071 | The unpairing cutoff can differ between devices | OPEN | TD-089 |
| TD-072 | A device can advertise sequence numbers it cannot serve | OPEN | TD-090 |
| TD-073 | Reminder changes from other devices are stored but not written to the reminders table | FIXED | - |
| TD-074 | Concurrent sync sessions can leave a stale hold counter or waiting notice | OPEN | - |
| TD-075 | Rejection proofs live in the display list of quarantined records | CONFLICT ENGINE | - |
| TD-076 | A genuine create of a non-default calendar can be quarantined by an unrelated rejected change | OPEN | - |
| TD-077 | When one (device, seq) exists with two contents, the first copy to arrive is stored | OPEN | TD-079 |
| TD-078 | Revalidation allow-list matches invalid-record reasons by text prefix | OPEN | - |
| TD-079 | A device restored from an older backup reuses sequence numbers (silent divergence) | OPEN | TD-077 |
| TD-080 | Reminders can fire twice after a restart; two labels wrong | OPEN | - |
| TD-081 | All-day reminders never fire | OPEN | - |
| TD-082 | Fresh worktree has no dist/sidecar.mjs; one test depends on another having built it | OPEN | - |
| TD-083 | Applying a full-state snapshot deletes events but not their reminders | DORMANT WHILE SNAPSHOTS ARE OFF | TD-052 |
| TD-084 | Recurring event that cannot be expanded for the alarm is only logged | OPEN | - |
| TD-085 | A resolution on the conflict screen does not restore a deleted event | CONFLICT ENGINE | TD-070, TD-096 |
| TD-086 | Reminder replay cost grows quadratically with edits of one reminder | OPEN | - |
| TD-087 | Saving the event dialog before its reminder lookup finishes can clear reminders | OPEN | - |
| TD-088 | Conflict resolution status does not travel between devices | CONFLICT ENGINE | TD-094 |
| TD-089 | Unpairing warning: show which devices have not confirmed an unpairing | OPEN | TD-071 |
| TD-090 | Relay of advertised-but-unservable changes was never tested | OPEN | TD-072 |
| TD-091 | A device updated by a full copy has no per-change identity or conflict rows | DORMANT WHILE SNAPSHOTS ARE OFF | TD-052, TD-048 |
| TD-092 | Choosing an edit as winner does not update the event | CONFLICT ENGINE | - |
| TD-093 | "Keep mine" can write an outdated value | CONFLICT ENGINE | - |
| TD-094 | A conflict can exist on one device but not on another | CONFLICT ENGINE | TD-070, TD-088 |
| TD-095 | A conflict stays open after a later delete | CONFLICT ENGINE | - |
| TD-096 | Restore versus delete leaves devices disagreeing on whether the event exists | CONFLICT ENGINE | TD-085 |
| TD-097 | A whole-event restore overwrites a concurrent description edit | ACCEPTED LIMITATION | - |
| TD-098 | Undo after a delete resolution does not bring the event back | ACCEPTED LIMITATION | - |
| TD-099 | Edits for not-yet-created items were dropped but acknowledged | FIXED | - |
| TD-100 | Non-event item types were stored but never written | FIXED | - |
| TD-101 | Change-log truncation was found unwired and is kept off | CLOSED BY DECISION | TD-046 |
| TD-102 | Conflict contents depend on the order in which changes arrive | CONFLICT ENGINE | TD-088, TD-094 |
| TD-103 | The value shown under an open conflict differs between devices | CLOSED BY DECISION | TD-102 |

Count per status:

| Status | Count |
|---|---|
| FIXED | 33 |
| OPEN | 41 |
| CONFLICT ENGINE | 10 |
| NEEDS DECISION | 2 |
| DORMANT WHILE SNAPSHOTS ARE OFF | 6 |
| ACCEPTED LIMITATION | 2 |
| CLOSED BY DECISION | 5 |
| MERGED | 1 |
| **Total** | **100** |

---

## TD-001 — Quarantined sequence gap
- **ID:** TD-001
- **Title:** Quarantined producer sequence can permanently block later records from the same producer
- **Priority:** 7/10 — HIGH
- **Status:** RESOLVED (implemented 2026-08-27, commits 271e86c + 96a257a; RATIFIED by owner 2026-09-02) — registry closure 2026-09-02.
- **Ratification note (owner, 2026-09-02):** Option 3 (quarantine-and-skip with retained records + defined recovery path) is confirmed as the binding semantics. The registry entry is now closed to match the already-shipped implementation; no code change was required or made by this closure.
- **Why it matters:** Potential synchronization liveness/convergence failure. If producer P's seq N is quarantined, dense-sequence expectation means all of P's later records buffer in `pending_changes` waiting for a record that will never apply — unbounded durable growth, stream never converges.
- **Current behavior:** `applyBatch` in `src/sync/sync_engine.ts` quarantines records failing `validateChangeRecord` (DC-04 §4.3 durable quarantine) but does not advance any frontier for them. Later seqs of the same producer stay buffered (confirmed by an independent verification probe: d-M seq 1 quarantined, seq 2 left as durable pending zombie).
- **Trigger for addressing it:** Next sync work session; must precede release of multi-device sync.
- **Relevant files/components:** `src/sync/sync_engine.ts` (applyBatch quarantine branch), `src/persistence/database.ts` (`quarantineRecord`, `applyRemoteChange`, pending table), `src/sync/knowledge_state.ts` (classifyArrival/advanceApplied), `docs/contracts/DC-04` §4.3, DC-02 knowledge semantics, DC-08 protocol.
- **Known repro:** Quarantine producer P seq N through engine session, then deliver P seq N+1 valid → N+1 buffers forever. Independent verification probe (repro script) was preserved under /tmp at investigation time.
- **Required protocol/design decision (must be made BEFORE implementing):** What does the protocol intend when a record is rejected/quarantined? Options include (a) quarantine implies skip+advance applied_upto to N for that producer (treat rejected as "processed"), (b) explicit negative ack/re-request protocol change per DC-08, (c) documented per-stream recovery path. Decide semantics first, then implement the smallest conformant solution.
- **Lead-dev recommendation (2026-08-27, PENDING OWNER APPROVAL — do not implement before approval):**
  Adopt **Option 3 — quarantine-and-skip with retained records + defined recovery path.**
  Semantics: on validation failure, quarantine the record AND advance the producer's
  applied_upto past the rejected seq (treat as "processed"), but KEEP the quarantined
  record durably (never delete). Recovery: quarantined records are retried automatically
  on engine restart (re-validate — a version update may now accept them) and remain
  inspectable. No wire-protocol change required; validation is NOT weakened; no data is
  destroyed on a false reject. Rejected alternatives: (a) skip+discard — permanently
  loses data on a false rejection; (b) negative-ack/re-request per DC-08 — safest but a
  full protocol extension, deferred as future work.
  Companion UI work (owner-initiated, scope TBD): surface quarantined records in the GUI
  similar to the conflict dialog — e.g. a "Sync-Errors" view showing the affected
  producer/seq with per-item Retry and Delete actions. Scope options range from plain
  error surfacing (cheap) to interpreted user-facing messages with retry/delete per
  record (more extensive; needs quarantine metadata + a new dialog + RPC surface).
  Implementation must follow the approved DC once this decision is ratified.
- **Constraints on the fix:** Do NOT weaken validation merely to make sequences advance. Must add deterministic regression tests including the specific case "seq N quarantined followed by seq N+1"; verify the producer stream cannot become permanently stuck; verify restart/persistence behavior; keep existing suite green.

## TD-005 — Quarantine lifecycle: resolution state, retention, and manual resolution UI
- **ID:** TD-005
- **Title:** Quarantined records have no lifecycle — no resolved/active distinction, no retention policy, manual Retry/Delete UI missing
- **Priority:** 5/10 — MEDIUM
- **Status:** RESOLVED (2026-08-27) — core + remainder complete. Durable lifecycle state (schema v3 `resolved_at_hlc`/`resolved_reason`), reconciliation hook, AND the full resolution UI: human-readable reason sentences (verbatim code always shown alongside; unknown codes fall back to the code), per-item Retry (`retry_quarantine` RPC → `retryQuarantineRecord`, sharing the restart revalidation apply path via the extracted `revalidateOneQuarantineRaw`), and per-item Delete with DC-15 §3.5 two-step confirmation (`delete_quarantine` RPC requires explicit `confirm: true`; row is RETAINED with `resolved_reason='user_deleted'` rather than physically deleted, and the `skipped_seqs` entry is guaranteed/re-created so the stream stays unblocked). Retention (TD-008 closure): config constant `QUARANTINE_RESOLVED_RETENTION_CAP = 1000` in `src/persistence/database.ts` — RESOLVED rows only are pruned oldest-first at engine startup and after each new resolution; ACTIVE rows are NEVER pruned; cumulative prune count is durable (`quarantine_prune_stats`, schema v5) and exposed via `listQuarantineStats.total_pruned`. Tests: `tests/td005_quarantine_lifecycle.test.ts` + `tests/td005_resolution_ui.test.ts` (17 tests). Production changes uncommitted.
- **Why it matters:** Quarantine rows are durable-by-design (never deleted) but nothing ever marks them resolved or ages them out. Unbounded accumulation (e.g. 200+ errors) makes the Sync-Errors list useless and causes alert fatigue (a badge that never clears stops being read). Operational resolution (retry-on-restart) exists since TD-001's fix, but the user-facing resolution surface does not.
- **Motivating scenario (owner, 2026-08-27):** 200 sync errors accumulate, are saved and never cleaned up — is that a problem? Yes for usability/observability; storage itself is negligible.
- **Scope when addressed:** (a) resolved/active distinction: revalidation success marks the diagnostic row resolved (archive, not delete) — badge counts only active; (b) "Interpreted Sync Error Resolution UI" (from the TD-001 work package): human-readable reasons, per-item manual Retry, per-item manual Delete with confirmation (see DC-15 §3.5 destructive-action safeguards pattern); (c) retention/cleanup rule for dead entries (e.g. quarantining producer no longer paired) — deletion always owner-confirmed, never silent.
- **Relevant files/components:** `src/persistence/database.ts` (quarantine table — needs resolved flag/migration), `src/sync/sync_engine.ts` (`revalidateQuarantine`), `frontend/sync_errors.ts`, Option-B RPC surface.
- **Trigger:** Before multi-device release to real users; owner sees accumulated list as noisy.

## TD-006 — Malicious/buggy peer flooding invalid sync packets: rate-limit or block design
- **ID:** TD-006
- **Title:** No design for blocking or rate-limiting a device that sends large volumes of false/invalid sync packets
- **Priority:** 4/10 now — rises at release; SECURITY/ROBUSTNESS
- **Status:** RESOLVED (commit pending — lead dev commits; design: DC-16 APPROVED v2; implementation: this package + `tests/regression_td006.test.ts`)
- **Resolution (2026-08-27):** Implemented per approved DC-16 (two-tier, owner directives D6/D7/O3/O4 applied). TIER 1: `src/sync/misbehavior.ts` — per-producer in-memory rolling-window tracker (count + ratio over the 10-min sweep frame; thresholds/window as config with §2.4 defaults >500 @ >50%), ladder L0 observe → L1 warn → L2 throttle (intake drop with capped exponential backoff, one aggregated drop counter, requests still answered) → L3 suspend; Level-4 is a RECOMMENDATION surfaced in the UI only, never executed; all Tier-1 state in-memory, fails OPEN on restart. TIER 2: >5,000 invalid per rolling 10-min window (ratio-independent, evaluated on ARRIVAL so bursts trip mid-burst; throttled intake drops count toward the flood window to keep bursts covered) → durable `hard_blocks` table (schema v4 migration: producer_device_id, first/last_triggered_at, trigger_count) + §2.3 durable `peer_invalid_tally` (informs UI history, never triggers). Hard block survives restart; cleared only by explicit Unblock (two-step confirmation in the new Paired Devices dialog) or unpair/revocation. Intake drop happens BEFORE validation/parsing (no quarantine rows/skip entries; near-zero cost); requests FROM the peer are still answered. Snapshot-delivered records (DC-16 §2.5) are exempt from both tiers. UI (Option-A patterns, no Rust changes): Sync-Errors gains a per-peer state section (`shapePeerStates`); NEW minimal Paired Devices dialog (`frontend/paired_devices.ts`) with per-device Tier-1/Tier-2 state and Reset (one click) / Unblock (two-step, states why/when + re-exposure warning) / Unpair (disabled placeholder routing to the DC-10 flow). New sidecar ops via the existing passthrough: `peer_state`, `list_paired_devices`, `reset_peer_state`, `unblock_peer`. Tests: `tests/regression_td006.test.ts` (22 tests — threshold boundaries incl. 500/501 and ratio edge, throttle intake-drop semantics, clean-window recovery, restart fail-open, Tier-2 boundary/durability/unblock, snapshot exemption, RPC ops, UI shaping).
- **Why it matters:** Quarantine handling (TD-001) makes a single bad record non-blocking, but nothing bounds a peer that floods invalid records: each unique invalid packet creates a durable quarantine row + skip entry (storage growth), consumes sync round-trips, and bloats the Sync-Errors UI. A buggy or malicious peer can degrade the receiving device indefinitely. This is the aggregate/flooding counterpart to per-record quarantine.
- **Owner directive (2026-08-27):** a design contract MUST be drafted covering how to block/throttle a device that sends tons of false/invalid sync packets — before any implementation.
- **Questions the contract must answer (seed list):** detection threshold (count/rate per producer? invalid-ratio?); action ladder (throttle → ignore stream → unpair, cf. DC-10 revocation); user visibility and manual override (false positives must be recoverable); interplay with quarantine retention (TD-005) and with pairing/revocation state (DC-05/DC-10); no autonomous permanent blocking without user notification (owner principle: nothing data-destructive or pair-ending happens silently).
- **Relevant files/components:** `src/sync/sync_engine.ts` (applyBatch quarantine branch, stats.receivedQuarantined), DC-08 protocol (any throttle signaling would be a wire change — design first), DC-11 discovery scope.
- **Trigger:** Draft the contract alongside TD-005 or before first multi-device release; implement only after owner approves the DC.

## TD-002 — NaN numeric payload handling
- **ID:** TD-002
- **Title:** Malformed numeric input containing NaN may bind as NULL or corrupt durable event rows
- **Priority:** 5/10 — MEDIUM
- **Status:** RESOLVED (fix uncommitted at investigation time — TD-002 investigation; resolving artifact: `tests/td002_nan_investigation.test.ts`; files changed: `src/sync/change_record.ts`)
- **Why it matters:** Silent durable-state corruption possibility from malformed remote payloads (better-sqlite3 binds JS NaN to SQL NULL).
- **Current behavior (independent verification finding):** NaN in schedule startMs/endMs is not caught by `typeof v.startMs === "number"` guards; NaN binds as NULL into nullable `utc_start_ms`/`utc_end_ms`, wall strings become `"NaN:NaN:NaN"`. Does not violate CHECK (row stays internally consistent with all_day unchanged), classification was expected/unsupported input.
- **Investigation verdict (2026-08-27, TD-002 investigation) — REACHABLE + CORRUPTING (Path A):**
  - Bare `NaN`/`Infinity` JSON literals are rejected by `JSON.parse` per spec, BUT `1e999` is a *valid JSON number token* that parses to `Infinity` (empirically confirmed in node: `JSON.parse('{"startMs":1e999}').startMs === Infinity`, `typeof === "number"`). Outgoing `JSON.stringify(NaN|Infinity)` emits `"null"`, so no legit producer emits non-finite — but any on-the-wire `1e999` from a buggy/hostile peer parses into `Infinity` and sails through every `typeof` guard: `validateChangeRecord` checked only `hlc_timestamp` finiteness, `sync_service.ts` mutator checks only `typeof v.startMs === "number"`.
  - Corruption empirically confirmed against better-sqlite3: `Infinity` binds as durable `REAL Infinity` (not NULL); `NaN` binds as NULL; `derivedScheduleColumns` on non-finite epoch-ms yields `"NaN:NaN:NaN"`-style wall/date strings with `all_day` unchanged — exactly the corruption the debt entry described.
  - **Fix (smallest conformant):** `validateChangeRecord` (`src/sync/change_record.ts`) now deep-scans `payload` for non-finite numbers and throws `ChangeRecordError("missing_field", ...)`; the sync engine's existing DC-04 §4.3 machinery durably quarantines the rejected record (verified: validation failure at `sync_engine.ts` applyBatch routes to `quarantineRecord`). No new error code added (no consumer switches on the union); no weakening of any existing validation. `sync_service.ts`/`event_core.ts` untouched.
  - **Evidence:** `tests/td002_nan_investigation.test.ts` (7 tests) proves: 1e999-wire record rejected; NaN and nested non-finite payloads rejected; legitimate large-but-finite timestamps (year 9999) still validate AND bind as `integer` with clean wall strings; documented demonstration of the pre-fix derived-column garbage. Full suite after fix: 26 files / 342 tests PASS; `npx tsc --noEmit` clean.
- **Trigger for addressing it:** RESOLVED (see investigation verdict above).
- **Relevant files/components:** `src/persistence/bridges/sync_service.ts` (mutator guards), `src/sync/change_record.ts` (validateChangeRecord), `src/persistence/bridges/event_core.ts` (derivedScheduleColumns).

## TD-003 — Legacy dev-* identity migration
- **ID:** TD-003
- **Title:** Legacy dev-* identity data migration
- **Priority:** 4/10 now; potentially 6/10 at release
- **Status:** DEFERRED
- **Why it matters:** Databases written by pre-unification trees attribute historic changes to the marker-file id (`dev-<uuid>`) while new records use the Ed25519-derived id (`d-<sha256>`). Historic data keeps a second producer identity forever.
- **Trigger for addressing it:** Preparing any release/update that must upgrade existing SQLite databases created by older versions. Do NOT implement before then.
- **Relevant files/components:** `src/persistence/bridges/event_core.ts` (`loadOrCreateDeviceId` marker-file fallback), `src/network/sync_runtime.ts` (`loadOrCreateIdentity`), `src/persistence/bridges/sidecar_server.ts`.

## TD-004 — Sidecar identity-path E2E coverage
- **ID:** TD-004
- **Title:** No end-to-end test covers sidecar main() production startup identity wiring
- **Priority:** 6/10 — MEDIUM-HIGH
- **Status:** RESOLVED (commit pending — lead dev commits; resolving artifact: `tests/sidecar_identity_e2e.test.ts`)
- **Resolution (2026-08-27):** New E2E test `tests/sidecar_identity_e2e.test.ts` builds the real esbuild sidecar bundle and spawns it with fresh `TIDE_DB_PATH`/`TIDE_DATA_DIR` in a temp dir, driving actual `main()` production startup over stdio JSON-RPC. Verified: `device_info`/`ping` report ONE deviceId shared by SyncManager + EventCore; the persisted identity (`device_identity.key`, reloaded via `loadOrCreateIdentity`) matches; ALL durable change records carry exactly that id (no legacy `dev-*` marker-file split, marker absent); after SIGKILL + restart on the SAME data dir the identity is identical and new records still carry it. One restart cycle; deterministic (response-count polling, hard timeout, no sleeps); ~0.6s runtime. Full suite 335/335, tsc clean. No production changes needed — wiring was correct.
- **Why it matters:** The F1 identity-split fix in `sidecar_server.ts main()` is verified statically and at unit level, but the realistic production startup/wiring path has never been executed under test. Cheap risk elimination.
- **Current behavior:** Existing regression test R1 constructs EventCore + engine directly; no test drives `main()`'s actual load-identity-once → inject into EventCore + SyncManager sequence across restart.
- **Trigger for addressing it:** FIRST task next session, BEFORE substantial further sync/sidecar refactoring.
- **Test requirements (smallest realistic E2E):**
  - exercise the real production startup wiring path;
  - verify SyncManager loads/uses the persisted sync deviceId;
  - verify EventCore receives that same explicit deviceId;
  - verify EventCore and SyncEngine therefore share one device identity;
  - verify identity remains stable across initialization/restart where applicable.
  - Do NOT redesign identity semantics.
- **Relevant files/components:** `src/persistence/bridges/sidecar_server.ts` (main(), SyncManager), `tests/regression_agents23.test.ts` (R1 neighbors), spawn/headless pattern already exists in `tests/two_instance_sync.test.ts` and the stdio test in `tests/event_store_bridge.test.ts`.

## TD-007 — Hygiene findings from TD-005/006/002 independent verification (2026-08-27)
- **ID:** TD-007
- **Title:** Minor findings from combined independent verification (verdict: SAFE TO COMMIT)
- **Priority:** 2/10 — LOW (hygiene)
- **Status:** RESOLVED (2026-11-14): (1) the hard-block lookup is prepared once per engine (`makeHardBlockCheck`); (2) the misbehavior tracker measures every window/backoff/level age on the monotonic clock (`monotonicWallClock` = performance.timeOrigin + performance.now), so wall-clock steps in either direction neither extend nor shorten a penalty (an earlier rebase approach was rejected by blind review: a back-then-forward trip could end a throttle early); (3) `resolved_at_hlc` (and `received_at_hlc`) holding wall-clock ms is documented at `markQuarantineResolved`, deliberately without a migration; (4) the single `onHardBlock` slot ("last engine wins", never share a tracker across databases) is documented at the hook. Regression: `tests/td007_td019_hygiene.test.ts`.
- **Findings (file:line per verifier):**
  1. `src/sync/sync_engine.ts` applyBatch: `isHardBlocked()` calls `db.prepare()` per record on every arrival — hoist to a per-engine prepared statement.
  2. `src/sync/misbehavior.ts`: Date.now-based windows lack monotonicity guards — a backward system-clock jump can extend a peer's throttle/suspend retention up to the jump magnitude (fails closed, self-heals). Consider monotonic guard or clamping.
  3. `src/persistence/database.ts` `markQuarantineResolved`: writes `Date.now()` (wall clock) into column `resolved_at_hlc` — rename column (v5 migration, cosmetic) or accept and document the mismatch.
  4. `src/sync/sync_engine.ts`: `misbehavior.onHardBlock` hook is overwritten per engine instance — harmless with single-DB product; becomes a bug only if shared tracker ever spans multiple databases. Guard or document.
- **Constraint:** none of these affect correctness under the product's current single-DB architecture; fix opportunistically in the next package touching each file.

## TD-008 — Slow-drip flood below both DC-16 tiers grows quarantine storage unboundedly
- **ID:** TD-008
- **Title:** Peer sending ~49% invalid sustained (under Tier-1 ratio, under Tier-2 count) accumulates quarantine rows indefinitely
- **Priority:** 3/10 — LOW-MEDIUM (bounded per-window, but unbounded over time; acceptable per DC-16 §2.4 as approved)
- **Status:** RESOLVED (2026-08-27) — closed by TD-005's retention cap: newest 1,000 RESOLVED quarantine rows are kept, older resolved rows are pruned silently at engine startup and after each new resolution (ACTIVE rows are never pruned); cumulative prune counts are durable (`quarantine_prune_stats`, schema v5) and surfaced via `listQuarantineStats.total_pruned`. Slow-drip accumulation is therefore bounded for resolved rows; only rows the user has not yet acted on persist, which is by design.
- **Why it matters:** Verifier-identified residual (owner-approved quota design): an attacker/buggy peer pacing just under both tiers (e.g. 4,900 invalid + 5,100 valid per 10-min window forever) adds quarantine rows indefinitely — ~700k rows/day at that rate. Storage-only issue (each row is small); sync liveness is unaffected (TD-001 ladder handles progression); Sync-Errors UI aggregates.
- **Resolution path:** TD-005 retention/retention-cap work is the designed answer (prune oldest resolved/low-value quarantine rows when a cap is exceeded — deletion always behind explicit policy, never silent for ACTIVE rows). Fold this scenario into TD-005's retention design when implemented.
- **Trigger:** with TD-005 retention work, or before any multi-user/large-calendar release.

## TD-009 — Frontend Cancel button for pending pairing offer
- **ID:** TD-009
- **Title:** Wire a Cancel button in the Devices dialog to the existing cancel_pairing_offer op
- **Priority:** 2/10 — LOW (optional/aesthetic: the security gap is CLOSED server-side; the op exists, is allow-listed, and offers are already cleaned up by supersede, ceremony completion, and stdin-EOF shutdown)
- **Status:** RESOLVED (2026-08-30) — frontend Cancel button wired to `cancel_pairing_offer` (frontend/index.html `btn-pairing-cancel`, frontend/devices.ts `cancelPairingOffer`, tests/td009_cancel_button.test.ts)
- **Scope:** frontend/devices.ts + frontend/index.html: show a Cancel affordance while a pairing offer is pending (pairing-step-show visible with a code), call syncOp("cancel_pairing_offer"), update UI state. No backend work required.
- **Origin:** independent review of f441f75 (pairing-offer lifecycle) noted user-initiated cancel is currently unreachable in the UI.

## TD-010 — Tray ERROR-PRESENT marker (attention-needed icon state)
- **ID:** TD-010
- **Title:** Tray icon shows an ERROR-PRESENT state when quarantine/conflicts need attention
- **Priority:** 3/10 — LOW-MEDIUM (passive visibility; the dialogs already own the detail)
- **Status:** OPEN (created 2026-08-31, DC-19 drafting — owner deferred it from v1 tray scope)
- **Semantics (DC-19 §3.3, normative when implemented):** boolean marker on the tray icon shown when at least one of: (a) non-resolved quarantine rows exist (Sync-Errors dialog domain), (b) unresolved conflict rows exist (Conflicts dialog domain). Source of truth: `quarantine_stats` + `list_conflicts` via existing sync_op RPC. Marker is boolean — NEVER duplicates dialog detail. Clears when both counts reach zero. v1 tray states remain IDLE + SYNCING only (DC-19 D7).
- **Relevant files:** src-tauri/src/lib.rs (tray wiring, DC-19 implementation), frontend dialogs already expose the underlying counters.
- **Trigger:** with the DC-13 runtime wrapper/tray implementation, or on owner request.

## TD-011 — Owner visual verification pass for the 2026-08-31 wave
- **ID:** TD-011
- **Title:** Owner visual smoke test: tray menu/options window, conflict resolution, UX wave (whole-day banner, drag-drop, Del-delete), toolbar cleanup
- **Priority:** 6/10 — MEDIUM-HIGH (release gate: all landed work is agent-verified only; owner visual checks are the final gate per established discipline)
- **Status:** OPEN (created 2026-08-31; assigned to the project owner)
- **Scope (what to click through, per DC-19/DC-20/DC-14 and the UX wave):**
  1. TRAY: icon present in KDE Plasma; right-click menu shows exactly
     Open Tide / Sync now / Options… / Quit (no Sync Errors, no Settings).
     Open Tide shows/focuses the window; window X hides to tray (process +
     sidecar stay alive); Quit exits cleanly (sidecar exits via stdin EOF,
     no SIGKILL).
  2. OPTIONS WINDOW (tray → Options…): opens as a SEPARATE window with
     left nav (General + Sync) + right content; Sync shows the 4 settings
     with contract bounds; Save persists to ~/.config/tide/config.toml
     (verify the file after Save); out-of-range input is refused with an
     inline error; Cancel restores last-saved values; live-apply of
     debounce/sweep/concurrent takes effect without restart; backlog limit
     is labeled next-start.
  3. CONFLICT RESOLUTION (DC-14): with two devices, create a genuine
     same-field conflict; Conflicts dialog lists it; Keep/Discard resolve
     it; the resolution propagates to the peer; skip writes nothing.
  4. UX WAVE (week view): overlapping appointments render side by side;
     whole-day appointment paints a SOLID full-height accent block (not a
     translucent wash); timed drag-drop shows a live ghost with the real
     snapped time range and lands exactly there; whole-day chips drag to
     another day; selecting a chip + Del arms ("Confirm delete?"), second
     Del deletes, any other key cancels.
  5. TOOLBAR CLEANUP: no Sync now / Quit buttons in the toolbar; only
     prev/today/next, Conflicts, Sync errors, New event, Month/Week.
- **Known non-issues during verification:** libayatana deprecation warning
  in the log (Tauri upstream library notice, tray works — DC-15 packaging
  note); the scheduler logs "[tide] runtime started…" to stderr (by design,
  stdout is the RPC channel).
- **Launch recipe:** terminal 1: `cd /home/skins/tide && npm run ui:dev`;
  terminal 2: `cd /home/skins/tide/src-tauri && TIDE_SIDECAR_PATH=/home/skins/tide/dist/sidecar.mjs cargo run`.

## TD-012 — Post-freeze full-suite verification pass
- **ID:** TD-012
- **Title:** Post sync-stall-fix full suite re-run (npm test + tsc + cargo build) not yet executed
- **Priority:** 5/10 — MEDIUM
- **Status:** RESOLVED (2026-09-02). Superseded-in-part by TD-020: the run HAPPENED and found 4 real deterministic failures (the barrier regression) — that was the finding, not a flake. The failures were fixed by the TD-020 package (commit bc1a3de, pkg7 independent review). Post-fix gate: `npx vitest run` → 705/705 PASS (74 files) + `npx tsc --noEmit` → 0 + `node tests/probes/three_device_harness.mjs` → 7/7 PASS, all recorded in the TD-020 commit.
- **Why it matters:** The c088023 sync-stall fix is verified by scoped suites (transport 17/17, sync suites 8/8, recurrence 24/24) and the full three-device harness (7/7 scenarios, 50 sessions, 0 session errors) — but the FULL vitest suite has not been re-run since the fix. The one-suite-at-a-time rule (postmortem c13e457) deliberately deferred it while the two independent adversarial reviews were pending.
- **Resolving action:** One clean full `npm test` + `npx tsc --noEmit` + `cargo build` pass, recorded here with COMMAND + EXIT STATUS. Expected: all green (no other production code changed in c088023 beyond sync_engine/noise_transport). Any failure here is a finding, not a flake — investigate, never ratchet.
- **Trigger:** immediately after both independent reviews were delivered.

## TD-013 — Transient EADDRINUSE on harness port bands
- **ID:** TD-013
- **Title:** Three-device harness scenarios occasionally fail with EADDRINUSE on a port that nothing holds afterwards
- **Priority:** 4/10 — MEDIUM (test-infrastructure flake, not protocol)
- **Status:** RESOLVED (2026-11-14): the default port band moved from 41900 (inside the Linux ephemeral range 32768-60999, so outbound or TIME_WAIT sockets could hold a band port; cause INFERRED, not reproduced) to 31900, below every common ephemeral range; the harness refuses a band that overlaps this host's range; `waitHealthy` now proves the listener with a real TCP connect (the echoed `listening_port` proved nothing) inside its existing bounded window, logging every failed attempt and any sidecar bind-failure line.
- **Evidence:** During the c088023 verification run, harness scenario 2 failed once with EADDRINUSE on 41910 (sidecar sync listener could not bind; nothing held the port afterwards; scenario passed on rerun). A second occurrence observed in the independent-review re-run. Pattern: TIME_WAIT or interface-timing race between scenario teardown and next-scenario bind.
- **Fix direction:** deterministic per-run port bases in RunContext, or a bounded bind-retry with explicit logging in the harness (never retry-until-green — outside the harness itself).
- **Trigger:** Before the harness becomes the standing release gate for future sync work (it now is), make it deterministic.

## TD-014 — Recurrence expansion: INTERVAL/WEEKLY semantics broken (independent review, CRITICAL+)
- **ID:** TD-014
- **Title:** expandOccurrences: DAILY/MONTHLY INTERVAL>1 hangs or collapses; WEEKLY without BYDAY expands daily; WEEKLY INTERVAL>1 picks wrong weeks
- **Priority:** 9/10 — CRITICAL (UI freeze reachable from the dialog builder)
- **Status:** RESOLVED (2026-09-02, commit bc1a3de, pkg8 independent review). Expansion rewritten as direct per-FREQ RFC 5545 stepping; all review probe cases + 11 regression tests in tests/td014_expansion.test.ts; hangs empirically reproduced pre-fix (RED probe) and eliminated.
- **Findings (file:line, empirical probes in the review report):**
  - F1 CRITICAL: `src/domain/recurrence_conflicts.ts:198-212` — skip loop never recomputes `daysSinceBase`, so `DAILY;INTERVAL=2` HANGS the renderer (probe: COUNT=5 never returns); with UNTIL it collapses to 1 occurrence; `MONTHLY;INTERVAL=2` hangs; `periodDays = 28*interval` is not a month.
  - F2 MAJOR: `:175-176` — `FREQ=WEEKLY` without BYDAY matches every day (comment claims base-weekday restriction; code doesn't do it). Probe: base Wed, 1-week window → 14 daily chips.
  - F3 MAJOR: `:148-169` — `WEEKLY;INTERVAL=2;BYDAY=MO,WE` lands in off-weeks (weekCursor/day-walk interplay broken).
- **Reachability:** the DC-12 dialog builder exposes interval + daily/weekly/monthly, so a user picking "every 2 days" freezes the calendar render (calendar.ts:243 expandSeriesEvents). Synced-in rules from other clients hit F2/F3 too.
- **Fix direction:** rewrite expansion as proper per-FREQ stepping (daily: step days from base with modulo check; weekly: week-anchored stepping against weekStart with BYDAY set membership; monthly: calendar-month stepping, NOT 28-day approximations), recompute the anchor derivative each step, add probes for every FREQ×INTERVAL×BYDAY combination the builder can produce, plus the review's probe cases as regression tests.
- **Constraint:** INVARIANT 9 (wall-clock preservation) must hold; do not touch tz semantics (confirmed clean in review); tests FIRST, prove each fails on current code.
- **Trigger:** NEXT IMPLEMENTATION WAVE — this blocks the recurrence wave being owner-visual-passable.

## TD-015 — Occurrence-override identity derived from MOVED start (independent review, data-integrity)
- **ID:** TD-015
- **Title:** dialog.ts derives recurrenceId from the override's moved startMs → second edit of a moved occurrence writes an orphan override + duplicate chip
- **Priority:** 8/10 — HIGH (data integrity, DC-12 R1/R2 violation)
- **Status:** RESOLVED (2026-09-02, commit bc1a3de, pkg8 independent review). dialogOccurrenceId captured at open from occurrenceOf chip meta; used in override save AND occurrence-cancel; fallback to deriveRecurrenceId only for base events. Regression: tests/td015_override_identity.test.ts (2 tests, RED on old code).
- **Finding:** `frontend/dialog.ts:661,716-719` calls `deriveRecurrenceId(existing.startMs, …)` where `existing` is the rendered chip whose startMs is the override's moved start. calendar.ts:278 already exports `occurrenceOf(ev)` carrying the correct original recurrenceId — dialog.ts never imports it. Second edit/delete of a moved occurrence keys a NEW override under the moved wall-time; the original is orphaned, uneditable from the UI, and the grid renders duplicate chips.
- **Fix direction:** thread the chip's original `recurrenceId` (via `occurrenceOf`) into the dialog open path and derive from THAT; regression test: move an occurrence, edit it again, assert ONE override row and one chip.
- **Trigger:** same wave as TD-014 (recurrence follow-up package).

## TD-016 — Unchecking "Repeat" on a series silently deletes the whole series (independent review)
- **ID:** TD-016
- **Title:** dialog Save with Repeat unchecked runs deleteEvent(id) on the series — no confirmation, no warning
- **Priority:** 7/10 — HIGH (destructive action behind an innocuous Save)
- **Status:** RESOLVED (2026-09-02, commit bc1a3de, pkg8 independent review; SEMANTICS DECIDED by owner 2026-09-02)
- **Owner decision (2026-09-02, binding):** KEEP THE EVENT CHAIN when the tickbox is unset. Unchecking "Repeat" must NOT delete anything. It means "end recurrence here": all past occurrences remain on the calendar untouched, the series terminates at the edited occurrence (UNTIL = edit point / recurrence ends), and the edited occurrence survives as a standalone single event with the user's latest edits. Whole-series deletion remains available ONLY as the explicit delete-series action (series root / dialog's whole-series choice) behind the two-step destructive confirm. Unchecking a checkbox is never a delete.
- **Finding:** `frontend/dialog.ts:644-653`. Violates the destructive-confirm contract (two-step confirm with warning; `confirm:true` at RPC level) and the UI-interaction-is-owner's-call rule.
- **Fix direction:** implement the owner semantics above: Save with Repeat unchecked converts the series to (past occurrences + terminating standalone occurrence) via UNTIL/chain preservation — never deleteEvent on the series. Regression tests: past occurrences intact after uncheck; no tombstones created for prior occurrences; series deleted only via explicit delete path (still confirmed).
- **Trigger:** same wave as TD-014/015.

## TD-017 — CHANGES_ACK semantics deviate from frozen DC-08 §3.4 (independent review)
- **ID:** TD-017
- **Title:** c088023 repurposed CHANGES_ACK as a one-shot bidirectional session terminator without a DC-08 amendment
- **Priority:** 6/10 — MEDIUM-HIGH (protocol/contract integrity; no correctness break in the homogeneous fleet)
- **Status:** RESOLVED (2026-09-02). Owner decision: AMEND THE CONTRACT (Option A) — "we do NOT rework the code to per-batch ACKs; that would re-introduce bugs the barrier fixed, and the barrier matters as soon as real networks are involved." DC-08 Appendix A (v2) authored and approved same day, formalizing: one ACK per session as joint terminator; bounded post-ACK drain (TD-020); stash consultation; barrier-mode compaction unlock deferred to next session's ACK (deliberate trade); INVARIANT 14 idempotence. Residual conformance work (barrier-phase applications ACKed at next session) is inherent to the approved amendment, not open debt.
- **Finding:** DC-08 §3.4 specifies per-batch ACK ("sent after each batch is fully processed, not coalesced across sessions"); the implementation sends ONE ACK per session before serving the peer's pull, and receiving a peer ACK terminates the barrier. Internally self-consistent (verified deadlock-free in review), but (1) a conformant per-batch peer's ACK would cut the barrier short, (2) barrier-mode applications are never ACKed (delays compaction unlock on the peer). Frozen-contract deviation without an amendment is a process violation.
- **Fix direction:** DC-08 amendment (v2) formalizing the barrier semantics (one ACK as joint terminator; per-batch ACKs retained for compaction knowledge when records are applied in barrier mode), or rework the barrier to a dedicated message. Owner decides via the amendment; do NOT silently conform the code to the old text.
- **Trigger:** next sync-layer work session; must precede any non-homogeneous (third-party) peer implementation.

## TD-018 — Dead-carrier session masquerades as success (independent review)
- **ID:** TD-018
- **Title:** transport error mapped to clean EOF + swallowed pump error → a peer RST mid-session reports a converged session
- **Priority:** 6/10 — MEDIUM-HIGH (observability/correctness-of-reporting, not data loss)
- **Status:** RESOLVED (2026-09-02, commit 550bbd1, pkg9 independent review). The framing layer now distinguishes carrier failure from clean FIN: a failed carrier makes `receive()` reject with FramingError, the feed loop turns that into a sentinel frame that fails AEAD and ends the session with a loud SessionError, FIN stays a clean EOF, and pump failures are logged. Paired with TD-017 (DC-08 Appendix A v2). Regression: `tests/td018_carrier_failure.test.ts` (RST shape and FIN shape tested together).
- **Finding:** `noise_transport.ts` feed loop's `finally` close (correct for FIN) plus `sync_runtime`'s error/end/close → receive()=null mapping plus the outbound pump's `void pump.catch(() => {})` mean a dead carrier surfaces as clean session end; pre-fix it surfaced as a loud SyncIdleTimeoutError. DC-05 §6.3 requires transport failure to be terminal (SessionError).
- **Fix direction:** distinguish FIN from error at the framing layer (error → SessionError, not null-EOF) and propagate pump failure to the session result; regression test with an error-injected carrier. Careful not to re-break the stall fix (FIN must stay clean EOF).
- **Trigger:** next sync-layer work session (pairs with TD-017 in one package).

## TD-019 — Minor sync-layer hygiene (independent review)
- **ID:** TD-019
- **Title:** engine-level message stash leaks across sessions (F3); FrameQueue single-waiter slot + immortal outbound pump (F4); ACK sends possibly-stale applied_upto (F5)
- **Priority:** 3/10 — LOW (all bounded; no data-loss attack found in review)
- **Status:** PARTIAL (2026-11-14). F3 DONE: already fixed by the session-start stash reset (DC-08 Appendix A.3); regression test added. F5 DONE (documented, no code change): the ACK reads the durable frontier at send time; lagging barrier-phase applications is the accepted DC-08 A.2.4 trade and only under-reports. F4 OPEN, deliberately not changed: FrameQueue's single waiter slot is load-bearing, because the engine builds a new receive cache per protocol phase (`nextMessage(transport)` at each phase) and can leave an abandoned pending receive; FIFO waiters would hand the next frame to it and lose it (semantics pinned by a test, documented in `noise_transport.ts`). The parked outbound pump is believed to be reclaimed with its session handle (INFERRED, not measured). What is left: make the engine use ONE receive cache per session first; only then are FIFO waiters or ending the pump safe.
- **Details:** stash is pre-existing, not introduced by c088023; pump leak is one closure per session; stale-ACK frontier is safe under max-merge. Fix opportunistically in the next sync package (TD-017/018 wave).
- **Trigger:** with TD-017/TD-018.


## TD-020 — c088023 session-end barrier regresses 4 suite tests (independent review follow-up + full-suite run)
- **ID:** TD-020
- **Title:** DC-08 barrier change causes revocation-queue non-drain (TRP-1/TRP-4b) and serve/barrier hangs under in-memory transports (Pkg5b, DC-09 gap rounds)
- **Priority:** 9/10 — CRITICAL/BLOCKING (master suite is red: 681 passed / 4 failed of 685)
- **Status:** RESOLVED (2026-09-02, commit bc1a3de, pkg7 independent review SOUND WITH CONCERNS — all 4 actionable findings applied)
- **Evidence (full-suite run 2026-09-01, /tmp/full-suite3.log):**
  - `tests/revocation_propagation.test.ts` TRP-1 + TRP-4b (DETERMINISTIC, also fails file-alone):
    `expect(a.queue.queue(b.id)).toHaveLength(0)` got 1 — B's REVOCATIONS_ACK arrives while A has
    already exited the barrier on B's CHANGES_ACK (barrier-exit cuts sibling ack handling),
    so A never records the ack and the revocation re-sends next session.
  - `tests/pkg5b_snapshot_conflicts.test.ts` "genuinely gapped peer..." — timeout at 5000ms test bound.
  - `tests/full_state_triggers.test.ts` "gap rounds -> exactly one offer..." — `SyncIdleTimeoutError:
    no message for 15000ms in serve/barrier` (engine.ts:379 via receiveIdleBounded). Both are
    barrier-wait geometry with the test msgPipePair transports; in-memory pipes only deliver EOF
    if a side calls close(), and runSession never closes the transport — a side that exits its
    barrier leaves the peer's receiveIdleBounded parked for the full idle bound.
  - Suite totals: 3 files failed / 68 passed, 4 tests failed / 681 passed (685).
  - Corroborating: the independent sync review predicted exactly this class — barrier semantics
    deviate from DC-08 §3.4 and "records applied during barrier mode are never ACKed".
- **Why the release gate missed it:** the three-device harness (real TCP) passes 7/7 — real
  transports propagate FIN as EOF, so barrier waits terminate quickly. The regression only
  surfaces under in-memory transports without close propagation + ack-ordering geometry.
- **Fix direction (one package, must precede release):**
  1. Amend the barrier per review finding F2: on peer CHANGES_ACK, drain remaining queued messages
     (bounded) instead of returning immediately, so sibling acks (REVOCATIONS_ACK) and
     late batches are processed; consider DC-08 v2 amendment formalizing barrier semantics.
  2. Give SyncTransport a close() (or have runSession signal end-of-session) so in-memory AND
     real transports deliver deterministic EOF at session end instead of relying on the 15s
     idle bound.
  3. Tests FIRST: revive the 4 failing tests as the regression proof; each must fail on
     current code and pass after.
- **Constraint:** no timeout changes (the no-retry-until-green rule); no weakening; INVARIANT 14 (safe under
  duplicated/reordered comms) must hold for the amended barrier.
- **Trigger:** IMMEDIATELY — blocks TD-012 closure and any further sync-layer work.


---

## TD-021 — WebKitWebProcess renderer crash (owner smoke, 2026-09-04)
- **ID:** TD-021
- **Title:** WebKitGTK renderer crashes fatally during normal use; swallows any reminder due while down
- **Priority:** 6/10 — MEDIUM-HIGH (blocks release quality; user-facing stability)
- **Status:** DROPPED by owner (2026-09-04). Owner assessment: the observed WebKitWebProcess fatal errors coincided with the hard recurrence rework period — the app was firing errors while exercising recurrence, and the renderer crashes are attributed to that era, not to an independent upstream defect. No crash signature was captured post-rework; item withdrawn without upstream filing. Re-open only if a fatal renderer crash recurs on the current recurrence-stable codebase (capture `journalctl --user -b | grep -iA5 webkit` at that time).
- **Original report:** `/usr/libexec/webkit2gtk-4.1/WebKitWebProcess has encountered a fatal error and was closed` — owner saw a random crash during use. No Tide logic involved (renderer-level), but a crash kills the webview and can take the sidecar down with it → reminders due in that window surface as "missed" on next launch (D1), or are silently absent if the whole app dies.
- **Files:** n/a (upstream + possibly frontend rendering features).

## TD-022 — Notification delivery portability: multi-strategy (2026-09-04)
- **ID:** TD-022
- **Title:** Reminder delivery should not hard-depend on notify-send (libnotify absent on minimal installs)
- **Priority:** 4/10 — LOW-MEDIUM → CLOSED
- **Status:** RESOLVED (commit c2fe3e8, 2026-09-04). Delivery now tries notify-send → gdbus → dbus-send in order; failed strategies are dead for the session and the chain converges to one delivery or a documented all-failed retry. pkg10 F1 (confirm-before-mark) preserved. Verified by PATH-isolated live probes (notify-send-only / gdbus-only / no-binary envs) + tests/td022_notify_strategies.test.ts (6 tests). Telemetry: one log line per attempt + outcome.
- **Residual (deferred, optional):** Rust-side notify-rust would remove even the child-process dependency; not needed while a GLib system is a release prerequisite (Tauri requires it anyway — gdbus is always present). .desktop file + icon still ship in the RPM/DEB (TD-023 adjacent).

## TD-023 — Dev-launch taskbar icon depends on binary-stem app_id ("app")
- **ID:** TD-023
- **Title:** Wayland app_id in dev = binary stem ("app"), not the bundle identifier; icons must be installed under both names
- **Priority:** 2/10 — LOW (dev-environment only; release build is correctly keyed to com.tide.app)
- **Status:** RESOLVED (2026-09-04, commit ad69d6d + codification). Icon install codified as `scripts/install-dev-icons.sh` (idempotent: installs hicolor icons under both com.tide.app and the dev binary stem `app` in 32/64/128/256, writes a dev .desktop with StartupWMClass=app, refreshes kbuildsycoca6/gtk caches). Verified by live run (EXIT 0, all files installed). Machine-local state is now reproducible from the repo on any fresh dev machine; release RPM/DEB with proper .desktop + icon remains the permanent fix and makes this moot.

## TD-024 — Damaged series data from the pre-fix re-anchoring bug (owner DB)
- **ID:** TD-024
- **Title:** "Test repeat daily" series base re-anchored to 2026-09-10; two occurrence overrides orphaned in owner DB
- **Priority:** 3/10 — LOW
- **Status:** RESOLVED (verified 2026-09-04, no repair needed) — owner deleted the test series themselves after the underlying bug was fixed in 5b51f78. DB re-inspection: series row, base event, and overrides all gone; remaining data (weekly series + cancelled override, whole-day event, single event) consistent; no tombstone anomalies. The orphaned-override repair became moot.

## TD-025 — Sidecar SIGSEGV (signal 11) during pairing-code creation on Debian (external user report)
- **ID:** TD-025
- **Title:** DEB install on stock Debian: sidecar exits with SIGSEGV when creating a pairing code
- **Priority:** 6/10 — MEDIUM-HIGH (first external-user install broken at a core feature)
- **Status:** RESOLVED-PENDING-VERIFICATION (2026-09-08): fix applied (better-sqlite3 12.11.1 + extra vendored deps); awaiting friend's confirmation on the rebuilt DEB.
- **CLOSING STATUS UPDATE (2026-09-23):** v0.1.1 packages built from commit ae61943
  (`Tide-0.1.1-1.x86_64.rpm` + `Tide_0.1.1_amd64.deb`, payload verified: sidecar md5
  a8357e8a… with conformRRule present, better-sqlite3 12.11.1 + bindings +
  file-uri-to-path shipped, `nodejs` dep resolves). Both pushed to GitHub main
  (tag v0.1.1). Awaiting ONLY the friend's re-test on Debian to flip this to
  fully RESOLVED. Dev-side verification beyond doubt: dev app ran the v12
  bundle through the entire 2026-09-22 gate session (export→Google→import→
  export round trip, hours of use) with zero hermes-node fatals — the same
  crash class that killed the app in the Sep-8 investigation.
- **Report:** Owner's friend installed Tide_0.1.0_amd64.deb on (actual) Debian. Creating a pairing code → error "sidecar exited: signal 11 (SIGSEGV)".
- **Why it matters:** SIGSEGV in the sidecar means Node started and died in NATIVE code — the only native module in the sidecar is better-sqlite3. Pairing-code creation is the first operation that WRITES to the domain DB, so the crash site is consistent with the sqlite binding. NOT a missing-nodejs problem: absent node yields spawn failure ("command not found"), not signal 11.
- **Artifact facts (verified from the shipped DEB):** `prebuilds/linux-x64.node` IS present and bundled (`usr/lib/Tide/node_modules/better-sqlite3/prebuilds/`). So the file is not missing — a runtime-level mismatch remains the prime suspect.
- **Leading hypotheses (ranked):**
  1. better-sqlite3 v13 prebuild vs Debian's distro Node (Debian 11 → Node 12, Debian 12 → Node 18): N-API addon built with newer toolchain segfaults on older/patched runtime.
  2. Conflicting Node installs on the user machine (distro node + snap/nvm) → mismatched runtime/native load.
  3. Old glibc or missing CPU ISA in the prebuilt binary (rarer).
  4. Own sync/crypto path — unlikely; pure TS throws instead of segfaulting.
- **Diagnostics received (2026-09-08, tide-faults.txt):** Debian 13.6 (trixie), x64,
  system Node **v20.19.2** at /usr/bin/node (single install, no nvm/snap conflict).
  His probe `node -e "require('node_modules/better-sqlite3')"` failed with
  **MODULE_NOT_FOUND — NOT a segfault**: the probe syntax itself is broken
  (a path without `./` prefix is resolved as a module name, never hits the
  native binding). Reproduced identically on the owner machine. So the native
  binding has NOT yet been exercised on his machine.
- **Owner-machine verification of the shipped DEB payload (2026-09-08, OBSERVED):**
  extracted Tide_0.1.0_amd64.deb data.tar.gz to a fake /usr/lib/Tide; ran the
  actual shipped `dist/sidecar.mjs` against the actual vendored
  better-sqlite3 13.0.3 (prebuild md5 4a98ff01…): ping OK, device_info OK,
  **pairing_offer OK** (the reported crasher) — on Node v26.7.0. Prebuild ELF
  needs max GLIBC_2.34 (trixie ships 2.41 — fine) and only old NAPI symbols
  (Node 20 supports NAPI 9 — fine on paper).
- **Next diagnostics (corrected probes, sent to user 2026-09-08):**
  P1 `node -e "const D = require('/usr/lib/Tide/node_modules/better-sqlite3'); const db = new D(':memory:'); db.exec('create table t(x)'); db.prepare('insert into t values (1)').run(); console.log('sqlite ok:', db.prepare('select x from t').get().x)"`
  P2 `cd /usr/lib/Tide && TIDE_DB_PATH=/tmp/t.db TIDE_DATA_DIR=/tmp node dist/sidecar.mjs` then paste `{"id":1,"op":"ping","args":{}}` + Enter; report output + exit code.
  P3 `node -e "console.log(process.report.getReport().header.glibcVersionRuntime, process.versions.napi)"`
  Decision tree: P1 segfault → hypothesis 1 confirmed (prebuild vs Node 20
  runtime) → candidate fixes (bundle Node runtime / rebuild prebuild on
  Node 20 / document Node >= 22). P1 ok but P2 segfault → JS-level difference
  between Node 20 and 26 running sidecar.mjs (esbuild target). P1+P2 ok →
  crash is in the GUI launch environment (env vars, working dir, permissions).
- **Previous diagnostics requested (2026-09-07, superseded):** `node --version`; `cat /etc/debian_version` / `lsb_release -a`; `which node`; Tide log tail from `~/.local/share/com.tide.app/logs/` or terminal stderr; isolation probe `cd /usr/lib/Tide && node -e "require('node_modules/better-sqlite3'); console.log('ok')"` — segfault here confirms hypothesis 1.
- **ROOT CAUSE CONFIRMED (2026-09-08, PROVEN):** friend's P1 probe segfaulted
  (Speicherzugriffsfehler) on Node v20.19.2 — the native binding itself crashes.
  Upstream bug: WiseLibs/better-sqlite3#1514 — v13.0.3 prebuilds segfault at
  napi_module_register on Node 20 and early Node 22 (cross-platform:
  darwin-arm64, win32-x64, linux-x64 all reported; v12.x unaffected on all
  Node versions). v13 declares engines ">=22" but even 22.x < 22.14 crashes.
  Debian 13 (trixie) ships Node 20.x → the v13 DEB can never work there.
  P3 confirmed glibc 2.41 / NAPI 9 on his machine (those were never the problem).
- **FIX APPLIED (2026-09-08, uncommitted):** downgrade better-sqlite3
  13.0.3 → 12.11.1 (engines "20.x || 22.x || … 26.x"). Full suite re-run:
  786/786 PASS. DEB-layout simulation with the v12 tree (sidecar.mjs +
  vendored better-sqlite3 + bindings + file-uri-to-path): P1-equivalent write
  OK, sidecar ping + device_info OK on Node v26. NOTE: v12 loads the addon via
  require('bindings') — tauri.conf.json resources now ALSO ship
  node_modules/bindings and node_modules/file-uri-to-path (v13 did not need
  them). Sidecar bundle rebuilt. Packages need rebuild + re-upload
  (same-NVRA reinstall trap: bump Release or md5-verify).
- **Candidate fixes (decision after diagnosis, SUPERSEDED by the downgrade):** document/require Node >= X for DEB targets; or re-vendor better-sqlite3 with wider prebuild range; or bundle a Node runtime in the DEB (ties into Windows-port Node-runtime decision).
- **Relevant files:** `src-tauri/resources/better-sqlite3/` (vendored prebuilds), `src-tauri/tauri.conf.json` (resources/deb depends), `src/persistence/bridges/sidecar_server.ts` (sidecar startup), DC-15 packaging.

## Owner rulings recorded 2026-09-08 (DC-18 implementation review)
- SEQUENCE on cancellation VEVENTs: v1 uses SEQUENCE:0; §3.4's increment language does NOT override §3.7's v1 rule. (Exporter already implements this.)
- tauri-plugin-dialog: approved. v1 scope (all calendars, one VCALENDAR): approved. X-TIDE-CALENDAR grouping: approved.
- Manual cross-suite import test (Google/Apple/Outlook) is a real RELEASE GATE, owner-executed.

## TD-026 — All-day end_date stored EXCLUSIVE violating DC-07 inclusive semantics (gate 2026-09-22)
- **ID:** TD-026
- **Title:** derivedScheduleColumns fed the exclusive endMs instant into the INCLUSIVE end_date column; 1-day all-day events stored as 2-day spans and exported as 2-day DTEND ranges
- **Priority:** 6/10 — MEDIUM-HIGH (data corruption visible to every interchange consumer)
- **Status:** RESOLVED (2026-09-22, commits 73d42dc + release ae61943). Write seam: inclusiveEndDateFromExclusiveMs (endMs - 1 -> local date) in derivedScheduleColumns; one fix point covers local writes, replicated schedule records (sync_service makeEntityMutator) and full-state upserts (all re-derive via insertEventRow). Data repair: schema v8 migration re-derives existing all_day rows from utc_end_ms, guarded (utc_end_ms > 0 AND derived end >= start_date) so legacy shell-store rows (utc_* = 0) are untouched — verified against a live-DB copy. Importer's 23:59:59.999 form idempotent under -1ms. Regression: tests/gate_allday_end_date.test.ts (6 tests incl. Google-round-trip DTEND + Tide->Tide round-trip + migration). Full suite 835/835.
- **Root cause class:** same inclusive/exclusive boundary confusion as the DC-18 UNTIL bug fixed the same session (conformRRule in 4b5e6a8) — both found by the owner's Google Calendar gate. Interchange-boundary semantics are now RFC-5545-conformant in both directions.

## TD-027 — .ics interchange conformance sweep candidates (residuals, informational)
- **ID:** TD-027
- **Title:** Known interchange residuals after the 2026-09-22 gate: reminders not exported (DC-18 §3.5 by contract), VTIMEZONE two-transition horizon, planner UUID minting at plan time
- **Priority:** 2/10 — LOW (all documented v1 limitations, no correctness break)
- **Status:** OPEN (registry of knowns, not defects)
- 1. Reminders: NOT exported by design (DC-18 §3.5); VALARM mapping deferred to a future contract. Google itself is unreliable at VALARM import (double-import quirk) — worth remembering if VALARM export is ever added.
- 2. VTIMEZONE horizon: exports carry two concrete transitions, no RRULE (handoff §4.6) — fine for mainstream consumers; revisit only if multi-year imports misbehave.
- 3. Import planner determinism: foreign-UID Case C mints randomUUID() at PLAN time (handoff §4.5) — intentional per D2; move to applier only if pure-plan ever matters mechanically.

## TD-028 — UI unresponsive while the Windows firewall UAC prompt is open
- **ID:** TD-028
- **Title:** Sync now blocks its caller (tray menu thread / async command worker) while the elevated firewall-rule creation waits for the UAC answer
- **Priority:** 3/10 — LOW (once per machine; the prompt is modal anyway)
- **Status:** CLOSED — not debt (owner, 2026-11-14): the UAC prompt runs on its own secure desktop, so the app being unresponsive while it is open has no user-visible cost.
- **Fix direction:** run `ensure_firewall(app, true)` on the blocking pool from both entry points and continue the sync pass from its completion.

## TD-029 — Per-user NSIS uninstaller likely cannot remove the firewall rules
- **ID:** TD-029
- **Title:** DC-24 §6.5 assumes an elevated uninstaller; Tide installs per user under AppData\Local, so `netsh delete rule` from the uninstaller probably fails silently
- **Priority:** 2/10 — LOW (leftover rules are inert once the program path is gone)
- **Status:** CLOSED (owner report 2026-11-14: no longer observed on the current installer).
- **Verify:** uninstall on a test PC, then `netsh advfirewall firewall show rule name="Tide sync"`.

## TD-030 — Conflict dialog shows raw data instead of readable values
- **ID:** TD-030
- **Title:** Conflict candidates render as JSON (`{"startMs":…,"endMs":…}`), field names as internal paths (`schedule`), devices as ids
- **Priority:** 7/10 — HIGH (users cannot make an informed choice; owner report 2026-11-14)
- **Status:** RESOLVED (2026-11-14, DC-14 Appendix A): conflicts show readable labels, locale- and clock-aware dates/times, only differing sub-fields, "Device <8 chars>" sides, side-named buttons, and raw data only in a collapsed "Technical details" section
- **Relevant files:** `frontend/conflicts.ts` (`formatCandidateValue`, `describeConflict`, `describeCandidateSide`), `src/application/conflicts_ui.ts`

## TD-031 — Conflicts badge count goes stale
- **ID:** TD-031
- **Title:** Badge count is read only at startup and after a resolution; a conflict created by a later sync shows "(0)" until restart
- **Priority:** 7/10 — HIGH (conflicts go unnoticed; owner report 2026-11-14)
- **Status:** RESOLVED (2026-11-14, DC-26): the badge re-reads after every calendar redraw (`tide:rendered`) and every sync that changed data (DC-26 TR-8)

## TD-032 — Long device ids truncated with "…" in Devices / Sync views
- **ID:** TD-032
- **Title:** Device ids are cut off; the paired-devices list should show either the short id or a friendly name
- **Priority:** 4/10 — MEDIUM
- **Status:** RESOLVED (2026-11-14, DC-28 friendly device names): every Devices / Sync surface shows one label (local nickname, else the name the device announced at pairing, else "Device <8 hex short id>"), never a truncated id with "…". Shared rule: `src/domain/device_names.ts`; regression: `tests/dc28_surfaces_dom.test.ts` (TR-6 / TR-9, one DOM test per surface) and `tests/dc28_device_names.test.ts`.

## TD-033 — Layout breaks in small windows
- **ID:** TD-033
- **Title:** Below a certain window size the layout stops scaling and scroll bars appear
- **Priority:** 4/10 — MEDIUM
- **Status:** MITIGATED (2026-11-14, owner: "whatever is easier for now"): main window minimum size = the 800×600 default (`tauri.conf.json` minWidth/minHeight), the size the layout is known to work at. A responsive layout remains possible later.

## TD-034 — Sidecar stderr piped but never read
- **ID:** TD-034
- **Title:** The shell piped the sidecar's stderr without reading it: a full pipe could block the sidecar, and its error output never reached the log
- **Priority:** 5/10 — MEDIUM (hang risk; hidden diagnostics)
- **Status:** RESOLVED (commit e6e5495): `src-tauri/src/sidecar.rs` drains stderr on its own thread into the app log (target `sidecar`), lines capped at 2,048 bytes (rest counted, not kept); the log file is size-capped with numbered archives (`logfile.rs`). Regression: `sidecar::tests::stderr_flood_does_not_block_the_sidecar`.

## TD-035 — mDNS browse restarted every 25 s
- **ID:** TD-035
- **Title:** The browse loop started a new mDNS browse every 25 s, resetting the query backoff and re-sending a burst of queries each cycle
- **Priority:** 3/10 — LOW (network chatter against DC-11 §3.3 rate rules)
- **Status:** RESOLVED (2026-11-14): one long-lived browse (`discovery.rs` `start_browse`), restarted only when it ends or fails to start (5 s backoff). The loop keeps the live view itself (resolved adds or updates, removed deletes) and re-pushes it every 25 s, so sidecar cache entries (120 s TTL) stay fresh exactly as the per-cycle re-browse used to do. Regression: `mdns_service::browse_loop_tests` (fake browse source); runtime probe `discovery::tests::persistent_browse_runtime_probe` (`--ignored`, two real daemons: present past the 120 s TTL, removed under the same name after withdraw). Owner decision 2026-11-14 (DC-11 Appendix A): plus an on-demand query round on Sync now and when a scheduled sync cannot reach a paired peer (sidecar `discovery_kick` notice), at most one per 60 s, and removals are forwarded to the sidecar. Runtime verification on the real Linux/Windows pair (TR-A5) is owed by the owner smoke test; until then verified on one host only.

## TD-036 — Sync sessions accepted any handshake key, not only paired devices
- **ID:** TD-036
- **Title:** Inbound sessions (and Sync now to a typed address) ran the sync engine for ANY Noise key; a never-paired device on the network could read the whole calendar and inject changes
- **Priority:** 10/10 — CRITICAL (confidentiality + integrity; found 2026-11-14 while drafting DC-27)
- **Status:** RESOLVED (2026-11-14): `SyncManager.runEngineSession` refuses, before any record is served or applied, a session whose remote static key matches no `status='trusted'` peer; refusals logged with a per-kind 1/min throttle. PROVEN by `tests/inbound_trust_gate.test.ts` (fails 2/3 without the fix, passes with it). Blind review: SAFE WITH CONCERNS (minors applied). Completed by DC-27 (2026-11-14, uncommitted at time of writing): the gate now matches the handshake key against ALL peers rows (trusted and revoked), refuses a key whose row is revoked or whose id a stored valid revocation record names (DENY_REVOKED), and runs `canSynchronize` (device_id = hash(stored key), status) before any message; Unpair writes `status='revoked'`. Tests: `tests/inbound_trust_gate.test.ts` (unchanged) + `tests/dc27_unpair.test.ts` TR-1.

## TD-037 — Conflict resolution always writes entity_type "event" / operation "set"
- **ID:** TD-037
- **Title:** `ConflictsViewModel.resolve` (src/application/conflicts_ui.ts) writes the winning value as an event "set" for every field kind; for reminders `effectiveOf(member_update)` may produce `{value:{value:…}}`, and overrides / `*` removals also get entity_type "event"
- **Priority:** 5/10 — MEDIUM (data shape after resolving a non-event conflict; HYPOTHESIS, not reproduced)
- **Status:** OPEN (blind review of DC-14 Appendix A, 2026-11-14)
- **Verify:** create a reminder conflict between two devices, resolve it, inspect the reminder row and the emitted change record.

## TD-038 — mDNS snapshot seeding is never populated
- **ID:** TD-038
- **Title:** DC-21 §3.2(b) snapshot replay after a sidecar restart sends nothing: `SidecarEventSink::record_observation` is a no-op and `BrowseService::record` has no caller, so `push_snapshot` always pushes an empty list
- **Priority:** 2/10 — LOW (latent: the sidecar is spawned once per app run and the shell has no sidecar-restart path today, so nothing currently depends on the snapshot)
- **Status:** OPEN (pre-existing; found by the DC-11 Appendix A blind review, 2026-11-14)
- **Note when fixing:** the snapshot must not store "removed" events, because `applySnapshot` (endpoint_bridge.ts) forces kind "added" and would resurrect a removed peer.

## TD-039 — Windows: settings live inside the data folder
- **ID:** TD-039
- **Title:** On Windows `app_config_dir` and `app_data_dir` both resolve to `%APPDATA%\<profile_id>` (`com.tide.app`), so `config.toml` sits in the same folder as the database and the identity key. The DC-27 Path B step "rename the data folder" therefore also resets the Options settings on Windows (Linux keeps them in `~/.config/<profile_id>`). DC-15 §4.1 / DC-24 still name the folder `%APPDATA%\tide`.
- **Priority:** 3/10 — LOW (settings only; no calendar data at risk)
- **Status:** OPEN (found while resolving DC-27 V6, 2026-11-14). Evidence: `src-tauri/src/lib.rs` `config_dir()` / data dir in `setup()`; Tauri 2.11.5 `path/desktop.rs` (`dirs::config_dir()` / `dirs::data_dir()`); dirs 6.0.0 `win.rs` (both `known_folder_roaming_app_data`).
- **Workaround:** copy `config.toml` from the renamed folder into the new one after the first start.

## TD-040 — Pairing scanner stores trust before the other side confirms
- **ID:** TD-040
- **Title:** `acceptPairingPayload` (src/network/pairing_manager.ts) stores the displayer as trusted before it receives `PAIRING_OK`. If the displayer refuses (DC-27 P10 `PAIRING_REFUSED`) or fails, the scanner keeps a one-sided trust row (DC-05 Case A).
- **Priority:** 3/10 — LOW (Case A is refused at the other side's gate; for DC-27 the scanner is the removed device, which already trusted the displayer)
- **Status:** MERGED into TD-058 (same defect); TD-058 keeps the evidence. Earlier status: OPEN (pre-existing ceremony order; observed during DC-27, 2026-11-14)

## TD-041 — Full-state snapshots ignore the revoked-producer cutoff
- **ID:** TD-041
- **Title:** DC-27 §4.14 / DC-05 Appendix A.2 drop a revoked producer's change records above the cutoff in `applyBatch`, and pull ranges are clamped. A DC-09 FULL_STATE_SNAPSHOT is applied without that filter, so state the revoked device authored after the cutoff arrives by snapshot from any peer that applied it during the gossip window, also after that peer has learned the revocation. The receiver's applied_upto for the revoked device rises above the cutoff, and an above-cutoff delete removes the receiver's copy through the absence rule.
- **Priority:** 3/10 — LOW (PROVEN at the `applySnapshot` seam and at the session engine's snapshot handler; snapshots are rare: Trigger A only fires on persistent gaps and `sweep()` has no production caller)
- **Status:** RESOLVED (2026-11-14, DC-27 Appendix B option a), DC-08 Appendix B, DC-09 Appendix A). Full-state offers and snapshots declare the sender's applied frontier (`applied_upto`); a receiver that holds a cutoff declines the offer or snapshot when the declared value for the revoked device is above the cutoff, missing or malformed, and never raises its own applied_upto for the revoked device from a snapshot above the cutoff or above the sender's declared value. Cost of the rule: TD-046. Receivers without a cutoff are unchanged. The three repro tests in `tests/dc27_unpair.test.ts` are ordinary tests now, with the TR-16 tests and a no-retry-loop test next to them. Cost: a peer that applied the removed device above the cutoff no longer serves full state to devices holding the record; incremental sync is unaffected.

## TD-042 — Revocation wire shape differs from DC-08 §3.7
- **ID:** TD-042
- **Title:** The engine sends `REVOCATION_RECORDS { records: [{ record, signature_hex }] }`; DC-08 §3.7 specifies `{ revocations: [{ record, signature (base64) }] }` (DC-27 S7 / O3). Both ends run the same code, so they interoperate.
- **Priority:** 2/10 — LOW (contract/code drift; owned by DC-08)
- **Status:** OPEN (decision needed: amend DC-08 to the implemented shape, or change the code)

## TD-043 — The offering device does not show a refused re-pair
- **ID:** TD-043
- **Title:** When a removed device scans this device's pairing code, this device refuses (DC-27 P10) and the scanner shows the refusal text, but the offering device's UI shows nothing: the `pairing_offer` result is consumed by the sidecar and never surfaced (same for any other offer-side failure).
- **Priority:** 2/10 — LOW (UX; nothing is stored)
- **Status:** OPEN (pre-existing offer-result plumbing; observed during DC-27, 2026-11-14)

## TD-044 — The urgent-push ACK does not reach the revoking device
- **ID:** TD-044
- **Title:** After Unpair, the urgent push session (revoking device dials the peer) delivers the record and the peer accepts it (it refuses the removed device from then on), but the peer's REVOCATIONS_ACK is lost: the peer logs "sync outbound pump failed (carrier error, session fails closed): socket closed". The Removed devices list therefore shows that peer as "waiting" until the next ordinary session in which the ACK arrives (the record is re-sent, DC-10 §3 at-least-once).
- **Priority:** 4/10 — MEDIUM (display lag only; enforcement is not affected)
- **Status:** OPEN (OBSERVED 3/3 runs in `tests/probes/three_device_harness.mjs --scenario=unpair_propagation`, 2026-11-14; the in-process TR-6 test does receive the ACK). HYPOTHESIS: the initiator leaves the DC-08 session-end barrier and closes before the responder's ACK (sent after the async signature check) arrives — same class as TD-020. A fix touches the DC-08 barrier and needs its own review.

## TD-045 — Post-cutoff data that reached an unaware peer stays only there
- **ID:** TD-045
- **Title:** Changes the removed device made after the cutoff that reached a peer before it learned the revocation stay on that peer (DC-27 §4.4 keeps them), and edits of those entities by that peer are not applied on devices that rejected the original (no row to update). Those devices permanently differ for such entities.
- **Priority:** 2/10 — LOW (bounded by the Spec §19 gossip window; accepted by DC-27 P12)
- **Status:** OPEN for the incremental path (OBSERVED in `tests/dc27_unpair.test.ts` "TR-8 an unaware P edits the rejected above-cutoff event": no quarantine row, P's stream keeps advancing, L has no row for the entity). Since TD-041 was resolved, such data no longer spreads from that peer by full-state snapshot to devices holding the record. Snapshot direction OPEN, decided together with TD-052 (same cause; DC-27 Appendix B.7 is a PROPOSAL, not approved): state that a peer applied from the removed device above the cutoff may be removed by a later full-state apply from a peer that never applied it. This needs a clean sender whose snapshot_clock[W] is above the cutoff, i.e. one that has applied a change citing W above the cutoff. PROVEN: a clean L (applied_upto[W] 2 = cutoff, snapshot_clock[W] 3 after pulling P's event that cites W:3) sends a snapshot that the tainted P accepts (not declined), and the absence rule (DC-09 §5.2) tombstones P's copy of W's above-cutoff event (`tests/dc27_unpair.test.ts` "TD-045 (i) a clean peer's snapshot removes, on the tainted P, an event W created above the cutoff" and "TD-045 (i) engine: ..."). Mixed entities, PROVEN by the four "TD-045 (ii) mixed entity ..." tests: (A) an event created at or below the cutoff, W's title edit above it, a later P edit: never removed (L's snapshot holds the row); once L has applied P's edit, L's row replaces P's (W's title gone, P's description kept), before that P's row is unchanged. (B) an event W created above the cutoff, a later P edit: kept on P while L has not applied P's edit; once L has applied it, the event is removed on P and P's own edit goes with it. Open point: (B) after L applied P's edit removes a trusted device's change, which the owner's permission (above-cutoff state only) does not cover; it needs an owner decision. Boundary: the same mechanism also removes at-or-below-cutoff history (TD-052); the acceptance does not cover that.

## TD-046 — A device whose peers are all tainted can never accept full state
- **ID:** TD-046
- **Title:** Under DC-27 Appendix B option a) (DC-09 Appendix A.2), a device that holds a revocation cutoff C for a removed device W declines full state from any peer whose declared applied_upto[W] is above C, or that sends no declaration (older build). applied_upto never goes down, so this taint is permanent. A device whose peers are all tainted or run an older build can never accept full state while it holds the cutoff; it falls back to incremental sync only, and a gap that only full state can close (compacted history) stays open.
- **Priority:** 2/10 — LOW (INFERRED from the rule; latent while compaction has no production caller, since without compaction incremental sync can close every gap)
- **Status:** OPEN (INFERRED 2026-11-14 from DC-09 Appendix A.2 and DC-06 §3.4 monotone applied_upto; accepted cost of DC-27 Appendix B option a), see B.4). Becomes relevant once compaction ships. Dormant while full-state snapshots are off (since 02563c5); must be fixed before snapshots are switched on.

## TD-047 — A multi-message snapshot is applied per message, not as one unit
- **ID:** TD-047
- **Title:** `applySnapshot` (src/sync/full_state.ts) runs once per FULL_STATE_SNAPSHOT message and commits each message in its own transaction. Its absence loop (deletion by omission, DC-09 §5.2) only sees the entities of that one message, so every local entity that travels in a different message of the same stream is treated as absent and tombstoned when its version is dominated. This contradicts DC-09 §5.1 and §7.2 and TR-7 (one atomic logical apply of the whole snapshot).
- **Priority:** 6/10 — MEDIUM (data loss on the receiver for any snapshot larger than one message; snapshots are rare today: Trigger A only fires on persistent gaps and `sweep()` has no production caller)
- **Status:** RESOLVED (2026-11-14). PROVEN before the fix: a 300-event stream in 2 messages to a fresh receiver left 45 events; the same result with the `full_state.ts` of commit e741d61, so it predated the TD-041 fix. Fix: the receiver stages every message of a stream in connection-scoped temporary tables (`SnapshotStream` in src/sync/full_state.ts) and applies the whole stream at `final` in one transaction: entity merges, the absence rule over all messages, inherited tombstones, applied_upto/device_clock and the pending/skipped clean-up. Each message is still judged under DC-09 Appendix A.2; the A.3 clamp uses the cutoffs held at commit, so a cutoff that arrives mid-stream governs the whole stream. A stream that ends before `final`, or whose messages disagree on snapshot_clock or applied_upto, writes nothing. Covered by `tests/td047_snapshot_stream.test.ts` and the TD-047 cases in `tests/dc27_unpair.test.ts`. Remaining gap: see TD-048.

## TD-048 — A lone or repeated final snapshot message deletes the rest of the stream
- **ID:** TD-048
- **Title:** FULL_STATE_SNAPSHOT messages carry no stream id or message index (DC-08), so a receiver cannot tell a complete one-message snapshot from the `final` message of a longer stream arriving alone, repeated or replayed. It applies that message as a whole snapshot, and the absence rule (DC-09 §5.2) tombstones every entity that travelled in the stream's other messages. This breaks DC-08 TR-12 (redelivery of any legal message leaves the state unchanged).
- **Priority:** 5/10 — MEDIUM (data loss; within a session the Noise transport's in-order nonces rule out third-party replay, so it needs a faulty or hostile paired peer or a future code path that delivers `final` alone)
- **Status:** OPEN. PROVEN by a reproduction (2026-11-14): sender with 600 events in 3 messages; the receiver held 600 after the full stream and 89 after the same `final` message was delivered once more (same result when it is duplicated inside one session). Related observations from the same review: `receiveAndApplySnapshots` (src/sync/sync_engine.ts) reads from the transport without draining the stashed-message queue first (HYPOTHESIS: an earlier message sitting in the stash would be left out of the commit; no conforming sequence found); `SnapshotStream.discard()` keeps its head after a declined or malformed message (safe today, since the engine discards the object); staging has no size limit; a database closed mid-stream makes the clean-up in the session `finally` throw and hide the session's own error. Fix needs a wire change (stream id and message index or count, checked before commit) and a DC-08/DC-09 amendment. Dormant while full-state snapshots are off (since 02563c5); must be fixed before snapshots are switched on.


## TD-049 — Pairing scanner checks the session key against the other side's own payload, not the pasted code
- **ID:** TD-049
- **Title:** In `acceptPairingPayload` (src/network/pairing_manager.ts:403-405) the scanner runs DC-05 §6.1 V2 against the payload the connected party sent over the encrypted channel (`exchangePayloads(localPayload, remoteRaw)`, `verifyRemoteStatic`), not against the `public_key` of the pasted code, and `connectSync` is given no expected key. Trust is then stored for the PASTED id and key (line 411). DC-05 §6.1 V2 says the scanner verifies the session key against the QR payload `public_key` (the authoritative out-of-band binding). Related: neither side runs the received encrypted payload through `decodePairingPayload`, and the displayer (line 279) stores `remoteRaw.device_id` without checking that it is derived from `remoteRaw.public_key`.
- **Priority:** 5/10 — MEDIUM (pairing ceremony binding; INFERRED impact: whoever answers at the pasted address can complete the ceremony with the scanner, which then stores trust in the pasted device's key; the safety-number comparison is still auto-confirmed, see the TODO(ui) in the same file)
- **Status:** RESOLVED 2026-11-15 by DC-05 Appendix B (B.1, B.7), implemented in src/network/pairing_manager.ts (`acceptPairingPayload`) and src/security/pairing.ts (`decodePairingCode`, `decodeCeremonyPayload`). The scanner now checks the session key against the pasted code before sending any frame (S1), strictly decodes the received payload, and aborts unless its device_id and public_key equal the code's (S2/S3); both decoders check device_id = "d-" + hex(SHA-256(public_key)). Tests: `tests/dc05b_pairing_proof.test.ts` TR-B2, TR-B3, TR-B6, TR-B7. Remaining: the safety-number comparison is still auto-confirmed (deferred by Appendix B.8 / P12, owner-approved), and the scanner stores trust before it receives PAIRING_OK (TD-058).

## TD-050 — A peer can announce a name that reads like another label
- **ID:** TD-050
- **Title:** DC-28 §4.8 allows any visible text, so a peer can announce "This device", "This device (local)" or "Device <another device's short id>". DC-28 P7 adds " (<short id>)" only when two entries in the SAME list collide (the conflict dialog includes this device, so a spoof there is disambiguated); in lists without this device (Paired Devices, Sync Errors), or across lists, such a name is shown as is, with only the muted "id <short id>" next to it in Paired Devices and Devices & sync.
- **Priority:** 2/10 — LOW (display only, D1: names never affect identity or trust; the peer is already paired)
- **Status:** OPEN (INFERRED from the DC-28 rules, 2026-11-14). Options: reserve the label forms "This device…" / "Device <8 hex>" in validateName for received names, or always show the short id next to announced names. Either is a DC-28 amendment.

## TD-051 — The offering device sends its own name to whoever connects first
- **ID:** TD-051
- **Title:** In the pairing ceremony the displayer (the device showing the code) sends its encrypted payload first (DC-05 §5.2 order, `createPairingOffer` in src/network/pairing_manager.ts), before it knows who connected: the offer listener has no expected key. With DC-28 that payload carries the saved own name, so any device that reaches the open offer port while the code is shown receives the name, even without the code. The scanner side does not have this gap (it checks the session key against the pasted code before adding its name).
- **Priority:** 2/10 — LOW (the name is display text the user chose to share when pairing, P3; the window is the open offer only; no identity or trust impact)
- **Status:** RESOLVED 2026-11-15 by DC-05 Appendix B (B.2-B.6), implemented in src/network/pairing_manager.ts (`createPairingOffer`). The v2 code carries a one-time 16-byte secret; the displayer sends nothing, parses nothing and consults neither store until the scanner's first frame proves the secret (HMAC-SHA256 over the session's handshake hash, compared in constant time); a wrong or missing proof gets a silent close and one counter line. Tests: `tests/dc05b_pairing_proof.test.ts` TR-B1, TR-B4, TR-B8, TR-B9, TR-B10. Residual (accepted, Appendix B.9 R1/P14): a connector without the code still learns the displayer's Noise static key from the handshake itself.

## TD-052 — A snapshot from a lagging sender deletes history it never held
- **ID:** TD-052
- **Title:** The absence rule (DC-09 §5.2) deletes a receiver's live entity that is absent from a full-state snapshot when the entity's version is dominated by the sender's snapshot_clock. snapshot_clock comes from the sender's device_clock, which takes in causal context (DC-27 Appendix B.1 e): a sender whose applied_upto[W] lags below an entity's seq, but which applied another producer's change that cites that seq, covers the entity without holding it. The receiver then tombstones legitimate history, including a removed device's changes at or below the revocation cutoff (against DC-27 §4.4 KEPT and TR-7). DC-09 Appendix A.2 accepts such a sender, since its declared applied_upto[W] is at or below the cutoff, and A.3 clamps applied_upto only. The apply also deletes when neither device holds any record (PROVEN at the apply level); whether a real session reaches that sender state is INFERRED, so the defect is INFERRED to be independent of revocation.
- **Priority:** 6/10 — MEDIUM (data loss on the receiver; snapshots are rare today: Trigger A only fires on persistent gaps and `sweep()` has no production caller)
- **Status:** OPEN. PROVEN 2026-11-14 by seven `test.fails` probes in `tests/dc27_unpair.test.ts` ("TD-045 (iii) KNOWN DATA LOSS (TD-052) ..."), with a passing control ("TD-045 (iii) control"). Setup: W writes W-1 (seq up to 2), S applies W through 2, W writes W-2 (seq 3); L, P and X apply W through 3; P creates an event whose clock cites W:3; L unpairs W (cutoff 3). S then lags (applied_upto[W] 2) while its snapshot_clock[W] is 3, in three ways: no record and an interrupted pull from P (P's records only), the same plus L's record (cutoff 3), or its own record (cutoff 2, so a real session with P does not apply W's seq 3). For each, a receiver holding the cutoff (L) and one holding none (X) accept the snapshot and lose W-2. Literal output, sender with a lower cutoff to L: `k1=2 k2(W-2)=3 cutoff=3 receiver=L receiver.cutoff=3 S.applied_upto[W]=2 S.declared[W]=2 S.snapshot_clock={"S":1,"W":3,"P":2,"L":1} receiver.version(W-2)={"W":3,"S":1} declined=false absenceTombstones=1 receiver titles after=["P-CITES-W","W-1"] tombstones(W-2)=1`. The other five direct-apply cases print the same values, except `receiver=X receiver.cutoff=none` for X. Through L's session engine (S relays its record first, L holds both, highest cutoff 3): `L cutoff=3 records on L=2 snapshotsDeclined=0 L titles after=["P-CITES-W","W-1"] tombstones(W-2)=1`. Control (S never applied P's records, snapshot_clock[W] 2): W-2 stays on both receivers. The clean evidence is receiver L (direct apply and session engine). The lower-cutoff sender to X case is apply-level only: in a real session S's record arrives before data, so X would hold cutoff 2 and W-2 would be above X's cutoff. Not established: whether a real session can deliver a snapshot from S while S still lags (the interrupted-pull state is set up through the change-apply path, not a dropped session). Fix needs a contract decision first (DC-09 §5.2 and §7.1; candidate: judge absence against the sender's applied frontier rather than device_clock). No code change made. Dormant while full-state snapshots are off (since 02563c5); must be fixed before snapshots are switched on.

## TD-054 — Lookalike names are not disambiguated
- **ID:** TD-054
- **Title:** DC-28 P7 (`disambiguateLabels` in src/domain/device_names.ts) compares labels as raw strings. Two names that render the same but differ in invisible or confusable characters (for example "Laptop" and "Laptop" + a trailing U+200D ZWJ, which §4.8 allows; or Latin/Cyrillic lookalikes) count as different labels, so neither gets " (<short id>)".
- **Priority:** 2/10 — LOW (display only, D1; the peer must already be paired)
- **Status:** OPEN (found by the DC-28 blind review, 2026-11-14). Options: compare a display skeleton (strip ZWJ/ZWNJ, case fold, Unicode confusables) when deciding duplicates. Needs a DC-28 amendment of P7.

## TD-055 — Names that render blank pass the name rule
- **ID:** TD-055
- **Title:** §4.8 rejects controls and format characters, but names made only of characters that render as nothing or as blank space pass: U+3164 HANGUL FILLER, U+FFA0 HALFWIDTH HANGUL FILLER, U+2800 BRAILLE PATTERN BLANK, combining marks without a base, unassigned code points. Such a peer shows an empty-looking label. Paired Devices and Devices & sync show the muted "id <short id>" next to it, but the Sync Errors "From:" line and the conflict dialog's side label / Keep button do not.
- **Priority:** 3/10 — LOW (display only; a paired peer can make itself hard to recognize on those two surfaces). Related: TD-050 (names that read like another label).
- **Status:** OPEN (contract gap in DC-28 §4.8, found by the DC-28 blind review, 2026-11-14). Options: reject names with no visible base character, or show the short id beside every peer label on every surface. Either is a DC-28 amendment.

## TD-056 — Any announced name that is a prefix of the sender's id is dropped
- **ID:** TD-056
- **Title:** DC-28 §4.5 drops a received name that is a prefix of the sender's device id (meant for the 12-character placeholder older builds send). `announcedNameFromPeer` applies it literally, so real but short names such as "d" or "d-7" are dropped too (the one-time migration uses the same rule).
- **Priority:** 1/10 — LOW (such names are implausible; the user can set a nickname)
- **Status:** OPEN (as specified by §4.5; found by the DC-28 blind review, 2026-11-14). Option: only drop prefixes of the placeholder length (12) or of at least "d-" + 8 hex.

## TD-057 — The name field's "Room left" counts spaces that saving removes
- **ID:** TD-057
- **Title:** `remainingRoomText` (frontend/name_editor.ts) measures the NFC input as typed. Leading/trailing spaces and runs of spaces, which validateName trims and collapses on save, are counted, so the field can show less room (or "Too long") than the saved name will use.
- **Priority:** 1/10 — LOW (cosmetic; Save still validates the normalized name)
- **Status:** OPEN (found by the DC-28 blind review, 2026-11-14). Fix: measure the trimmed/collapsed form.

## TD-058 — The pairing scanner stores trust before the other side confirms
- **ID:** TD-058
- **Title:** In `acceptPairingPayload` (src/network/pairing_manager.ts) the scanner writes its trust entry for the displayer and only then waits for PAIRING_OK. If the displayer then refuses (DC-27 A.2 "revoked"), fails its own checks (B.7 V2, store error) or the connection drops, the scanner keeps a trusted row for a device that did not store it back: one-sided trust (DC-05 TR-4: no session carries data, both sides deny; the row shows in Paired Devices).
- **Priority:** 5/10 — MEDIUM (one-sided trust after a failed pairing, PROVEN on the built sidecar; no data flows over it and it is removable by Unpair, but the user sees a "paired" device that the other side does not trust)
- **Status:** OPEN. PROVEN 2026-11-15 by the blind review of the DC-05 Appendix B change, on the built sidecar bundle, in two cases: (1) the displayer refuses with PAIRING_REFUSED "revoked" (DC-27 A.2) after the scanner's payload: the scanner shows the refusal text but keeps a trusted row for the displayer; (2) the displayer closes after the proof without PAIRING_OK (code used up, cancelled or expired mid-ceremony): the scanner shows the single "no longer valid" text and keeps a trusted row. Appendix B adds further failure paths after the scanner's trust write, each with the same effect: the displayer's strict payload decode (B.7), its session-key binding (V2), cancel or the 10-minute lifetime (P8) during the ceremony, and a store error on the displayer. First found by source reading during the same work; pre-existing, ordering unchanged because Appendix B P4 keeps the frame order. Fix options: store on the scanner only after PAIRING_OK (then a displayer that stored and sent OK can still be left one-sided if the scanner's own store fails), or roll the scanner's entry back on refusal. Either needs a DC-05 decision.

## TD-059 — The pairing code text cannot be wiped from memory
- **ID:** TD-059
- **Title:** DC-05 Appendix B.2 asks to overwrite the one-time secret when the offer ends. The secret's Buffer is zeroed on both sides (VB-6), but the code is also a JavaScript string (the `qr_text` reply, the NDJSON line, the Rust reply, the webview textarea). Strings are immutable and are freed only by garbage collection, so "destroy" for those copies means dropping the references: the sidecar tracks the offer without its text, and the Devices dialog clears the shown code once the offer has ended.
- **Priority:** 1/10 — LOW (local process memory only; the secret is dead once the offer ends, which the displayer enforces)
- **Status:** OPEN (accepted residual of VB-6, 2026-11-15). No fix planned in the JavaScript runtime.

## TD-060 — A connection that stalls inside the Noise handshake is never timed out
- **ID:** TD-060
- **Title:** `serveSync` (src/network/sync_runtime.ts) runs the Noise handshake with no time limit. A peer that opens TCP and never finishes the handshake keeps that socket open. On a pairing offer this is not counted as a bad proof (DC-05 Appendix B P6, as specified) and survives the end of the offer until the peer closes; the standing sync listener has the same behaviour.
- **Priority:** 2/10 — LOW (denial of service, out of scope per DC-05 §8 N4; no data exposed)
- **Status:** OPEN (OBSERVED by source reading, 2026-11-15; pre-existing). Fix option: a handshake deadline in `serveSync`; a sync-protocol decision (DC-05 §10 "session timeouts").

## TD-061 — DC-27 A.2 and DC-28 §4.5 wording predates DC-05 Appendix B
- **ID:** TD-061
- **Title:** Two contract texts owned elsewhere still describe the pre-Appendix-B ceremony: DC-27 Appendix A.2 says the refusal is sent "before any check or trust write" (Appendix B P10, approved: after the proof and the strict decode, before binding; open item OB-1), and DC-28 §4.5 says "decodePairingPayload keeps accepting name" (Appendix B P2: a v2 code with "name" is refused; OB-2). The implementation follows Appendix B.
- **Priority:** 1/10 — LOW (documentation consistency)
- **Status:** OPEN (2026-11-15). Fix: a one-line note in each of DC-27 A.2 and DC-28 §4.5 pointing to DC-05 Appendix B.

## TD-062 — A listener-port test writes to /tmp whatever TMPDIR says
- **ID:** TD-062
- **Title:** `freeDir()` in tests/ensure_listener_port.test.ts (line 29-30) builds its data folders as `path.join("/tmp", "tide-port-test-…")` instead of `os.tmpdir()`, so every full test run leaves `/tmp/tide-port-test-*` folders behind even when TMPDIR points elsewhere, and the folders are not removed afterwards.
- **Priority:** 1/10 — LOW (test hygiene only; no product code involved)
- **Status:** OPEN (OBSERVED 2026-11-15: two new folders after each full `npx vitest run` with TMPDIR set). Fix: use `os.tmpdir()` and remove the folder in the test's cleanup.

## TD-063 — The full-state offer exchange never completes over real TCP
- **ID:** TD-063
- **Title:** The DC-09 offer/accept exchange in src/sync/sync_engine.ts waits for the peer's FULL_STATE_OFFER or FULL_STATE_ACCEPT with `receiveWithTimeout` polls of 2 ms (about 10 ms per wait in `driveFullStateOffer`, about 200 ms in `receiveAndApplySnapshots`), while one message over the real Noise TCP carrier takes about 80 ms on loopback. Each side gives up before the other's answer arrives, sends its CHANGES_ACK, and the session ends without a snapshot. The snapshot recovery path for persistent gaps therefore does nothing over the real transport; the same databases over an in-memory pipe do apply the snapshot.
- **Priority:** 5/10 — MEDIUM (a recovery path is dead; no data is lost by it)
- **Status:** DORMANT WHILE SNAPSHOTS ARE OFF. PROVEN 2026-11-15 on a parked branch (wip/td052-declared-frontier): 20 attempts, 72 sessions, both device-id orders and both dial directions, zero snapshots applied. Trace on the production session code over real Noise TCP: one side sent its offer at 386 ms, stopped waiting at 398 ms and sent CHANGES_ACK; the other side's offer arrived at 450 ms. Snapshots are off since 02563c5, so the path is not reached. A working exchange would make TD-052 reachable, so TD-052 must be fixed before this one and before snapshots are switched on.

## TD-064 — A sync message above one Noise message fails, and the other peer reports success
- **ID:** TD-064
- **Title:** One Noise transport message carries at most 65,519 bytes of plaintext (65,535 minus the 16-byte tag), and the transport sends each sync message as exactly one Noise message with no fragmentation (`send()` in src/network/noise_transport.ts: one `EncryptWithAd` call). The engine sizes CHANGES_BATCH (`serveRequests` / `handleBarrierMessage`, src/sync/sync_engine.ts) by record count only (`maxBatchRecords`, 256), never by bytes. With ordinary event descriptions a 256-record batch is about 200-275 KB, so the serving peer's send throws "encrypt failed" and its session dies. `runEngineSession` (src/persistence/bridges/sidecar_server.ts) then closes with `session.done()`, a normal FIN, so the other peer sees a clean end and its `sync_now` returns success with `receivedApplied: 0`. The failure is visible only in the serving side's log (`[tide] inbound sync session failed: responder: encrypt failed`). The limit is bytes, not record count: between 90 and 100 ordinary events, or a few thousand tiny ones. A newly paired device, or any device with a larger backlog (ICS import, long offline period), never receives it. There is also no length bound on text fields, so a single record with an 80 KB description is itself over the limit.
- **Priority:** 8/10 — HIGH (sync silently stops for any backlog above about 90-100 ordinary events, and one side reports success)
- **Status:** OPEN. PROVEN on commit 5cf5e24, two built sidecars over real TCP with Noise_XX, a fresh device pulling with `sync_now` from a device holding N events:
  - A backlog of 80 ordinary events: all 80 arrive. A backlog of 200: the receiver holds 0 of 200; three consecutive pulls report applied 0 with no error; the serving side logs "encrypt failed" and the pulling side logs "socket closed". A backlog of 3,001: the receiver holds 0 of 3,001. Neither process exits.
  - The limit is bytes (one Noise message, 65,519 bytes of plaintext): between 90 and 100 ordinary events, or a few thousand tiny events (4-character titles, empty descriptions).
  - An earlier statement that a newly paired device catches up 3,001 changes by normal pulls held only in-process (it bypasses the one-message limit); over the real transport it fails. This is part of this item.
  - A fix exists as a separate unmerged change: message fragmentation in the transport, byte-sized batches (1 MiB target, 256-record cap kept), a reset instead of a normal close when a session fails, and a handshake prologue version tag so that mismatched builds refuse each other (it changes the wire format; specified in DC-08 Appendix C and DC-05 §4). With it applied, backlogs of 200 and 3,001 arrive in full. It does not touch the full-state snapshot code and does not depend on TD-052 while snapshots stay off; if snapshots are switched on again, TD-052 must be fixed first, because fragmentation would let snapshot messages commit.
  - Open follow-ups of that fix: a single record over its 8 MiB cap fails every session that tries to send it and blocks the batches queued behind it (a text-field length limit closes this); there is no backpressure on the outbound and inbound frame queues.
  - FULL_STATE_SNAPSHOT messages (256 entities per message) have the same shape, but snapshots are off by default (engine option `snapshots`, not enabled by the sidecar).

## TD-065 — One CHANGES_REQUEST is answered with every batch, but the puller applies only one per request
- **ID:** TD-065
- **Title:** The serving side answers one CHANGES_REQUEST with ALL batches for the requested ranges and no `remaining_ranges` (`handleBarrierMessage`, src/sync/sync_engine.ts), while the pulling side takes ONE CHANGES_BATCH per request (pull loop in `runSessionInner`, up to 10 iterations), recomputes its needed ranges and requests the rest again. The other batches of that answer are applied later by the barrier loop or counted as duplicates, so a large backlog is sent several times in one session. This deviates from DC-08 §3.3 (receiver-driven continuation with `remaining_ranges`). It only becomes visible once batches larger than one Noise message can be sent (see TD-064); on current code such a backlog fails before any batch is delivered.
- **Priority:** 4/10 — MEDIUM (convergence is not affected; traffic and apply work are multiplied for large backlogs)
- **Status:** OPEN. OBSERVED (in-process, 60-record batches, 1,202 events, one session): converged 1,202/1,202, but 165 batches carried 9,330 records for 1,203 unique records (about 7.8x). With 1 MiB / 256-record batches the reproduction shows 15 batches from the serving side and 2,252 duplicates for 1,203 applied on the pulling side. Not measured over the real transport. Candidate fix: one batch per request with `remaining_ranges`, and a pull bound that counts only rounds without progress.

## TD-066 — Ed25519 verification accepts universal signatures for small-order public keys
- **ID:** TD-066
- **Title:** `verifyAsync` in src/security/identity.ts calls @noble/ed25519 `verifyAsync` in its default (ZIP-215) mode. For a small-order public key (for example `0100…00`), the signature R = identity, S = 0 verifies for ANY message. Pairing does not reject such keys, so a device paired with a deliberately malformed key could be impersonated by anyone, not only by its key holder. Revocation records are checked against the key stored at pairing (src/security/revocation.ts), so the exposure requires a paired device whose key was crafted this way. Found while designing signed change records (deferred); it is a defect of the current code.
- **Priority:** 2/10 — LOW (needs a deliberately malformed key accepted at pairing; no honest key is affected)
- **Status:** OPEN (PROVEN 2026-11-15 by a diagnostic script: the noble default accepts the universal forgery, while `{zip215:false}` and Node's built-in verifier reject it; the two implementations also disagree on mixed-order keys, 64/64 versus 12/64 accepted). Remedy: exactly one verification implementation and rule for every signature check, and rejection of malformed (small-order or torsion-component) public keys at pairing.

## TD-067 — Changes by an author this device never paired with arrive relayed through a paired device
- **ID:** TD-067
- **Title:** Every sync session passes the trust gate before any sync message and before the sync engine is created (src/persistence/bridges/sidecar_server.ts: an unknown key is refused with DENY_UNPAIRED, a removed device with DENY_REVOKED), so this is NOT about unauthenticated connections. The question is about changes whose original author this device never paired with, arriving relayed through an authenticated paired device: `applyBatch` (src/sync/sync_engine.ts) checks only removed-device cutoffs, not whether the author is a paired device. Relay between a user's own devices is intended (ADR-0001: connection authentication is the trust boundary, relay is required, no per-record signatures). Found while designing signed change records (deferred); it is behaviour of the current code.
- **Priority:** 3/10 — LOW (requires a paired, authenticated peer; the connection-level trust gate holds; the open point is a design rule, not an unguarded entry)
- **Status:** OPEN as a design question (OBSERVED 2026-11-15 and re-checked 2026-11-19 by reading the code). The long-term rule depends on a trust-model decision: whether a group device list is introduced (authors outside the list held rather than applied) or relay of any author through paired devices remains the accepted model. Priority is low because every session is already authenticated and relay is intentional.

## TD-068 — The inbound frame queue is unbounded before and after authentication
- **ID:** TD-068
- **Title:** The socket framing in src/network/sync_runtime.ts pushes every complete inbound frame onto an in-memory queue (`queue.push(...)`) with no limit on the number of frames or total bytes and no read pause; only a single frame is capped (`MAX_FRAME`, 4 MiB). The listener binds all interfaces and the queue is filled from the first byte, i.e. before the Noise handshake has authenticated the peer. Any host that can reach the port can make the process hold memory faster than the session reads it, without having paired. Found while designing signed change records (deferred); it is a defect of the current code.
- **Priority:** 5/10 — MEDIUM (denial of service by memory growth from an unauthenticated host on the local network; no data exposure; DC-05 §8 treats pure DoS as out of scope, but the intake should be bounded)
- **Status:** OPEN (OBSERVED 2026-11-17 by source reading). Intended fix: before the handshake completes at most 4 frames / 64 KiB queued per connection and at most 16 unauthenticated connections; after authentication at most 2 frames / 8 MiB per connection with the socket paused when full, and a cap of 16 concurrent authenticated sessions. Related: TD-060 (no handshake deadline).

## TD-069 — No per-record size limit and no per-producer storage limit for applied change records
- **ID:** TD-069
- **Title:** A device paired with this one can produce valid change records without limit, each up to the transport cap (DC-08 Appendix C.3, 8,388,608 bytes per message), and the receiver stores every applied record. Nothing refuses, evicts or caps applied records, so one paired device can fill the disk of every peer with valid data. Found while designing signed change records (deferred); it is a defect of the current code.
- **Priority:** 5/10 — MEDIUM (needs a paired device, but a stolen key or a buggy peer is enough; no data exposure; storage exhaustion on every peer)
- **Status:** OPEN (INFERRED 2026-11-17; not source-checked against the shipped `applyBatch`). Needs its own design: a per-record size limit (with a visible refusal and field-level text limits), a per-producer storage limit, a user-facing message, and the interaction with DC-06 compaction and DC-27 unpair.

## TD-070 — Concurrent edits to series, occurrence overrides and calendars are not detected as conflicts
- **ID:** TD-070
- **Title:** `detectAndRecordConflict` (src/persistence/database.ts) returns "apply" for every entity type except events, so two devices that edit the same series rule, the same occurrence override field or the same calendar field at the same time create no conflict record. Each device keeps whichever change it applied last, so devices can end with different values depending on the order the changes arrived in. Events do not have this problem. The same applies to reminders: two devices editing the same reminder at once keep the change that arrived last (a change that is causally older than one already stored is skipped, but concurrent edits are not detected). A reminder added while another device deletes the same event is a delete-versus-edit conflict on the event: the event stays on the device that added the reminder.
- **Priority:** 6/10 — MEDIUM (data differs between devices without any warning; no loss of history, every change is stored and every device holds the same set of changes)
- **Status:** OPEN. Known convergence defect: the calendar state of two devices holding the same changes should be identical. Scheduled for the conflict-engine work.

## TD-071 — The unpairing cutoff can differ between devices
- **ID:** TD-071
- **Title:** When a device is unpaired, the unpairing device signs a record with a cutoff: the highest change number of the removed device that it had applied. Every other device uses the highest cutoff among the unpairing records it has accepted (`revokedCutoffs`, src/security/revocation_store.ts). A record is accepted only from a device that is directly paired with the receiver. Two devices can therefore hold different cutoffs for the same removed device, and a device that applied the removed device's changes before it learned the record keeps them. Devices can end up holding different data from a removed device.
- **Priority:** 4/10 — MEDIUM-LOW (affects only data written by a removed device after the unpairing point; no effect on devices that never synced with it)
- **Status:** OPEN. Known limitation of the unpairing design (DC-27, section 4.4 and Appendix B). To be revisited with the unpairing-warning work.

## TD-072 — A device can advertise sequence numbers it cannot serve
- **ID:** TD-072
- **Title:** A device's advertised clock (`device_clock`) merges the clock entries cited by every change it receives or holds, not only the changes it has applied. A device that holds a change citing another device's sequence numbers therefore advertises numbers it cannot serve. A downstream device asks for them every session, gets an empty answer and counts a persistent gap. While full-state snapshots were on, that gap ended in needless full-state offers. With snapshots off (the default in this release) the effect is only needless requests: on a four-device chain, 16 range requests over 4 sessions, no offers, and nothing logged by the gap itself.
- **Priority:** 3/10 — LOW (extra requests only; no data loss; no loop, each session asks at most twice per advertised range)
- **Status:** OPEN. Reproduced on a four-device chain (8 offers in 4 sessions before snapshots were switched off, 0 after). Recorded, not fixed. Candidate fix: advertise only the applied frontier. See also TD-090 (the relay-hop behaviour was never tested).

## TD-073 — Reminder changes from other devices are stored but not written to the reminders table
- **ID:** TD-073
- **Title:** Reminder changes (member add, update, remove) received from another device are stored in the change history but not written to the `reminders` table: the change applier accepts and ignores that entity type, so reminders do not sync between devices. A later fix has to replay the reminder changes already stored in the history. A reminder also references its event (a second referenced object), so the same rule for a missing referenced object applies to it.
- **Priority:** 6/10 — MEDIUM (a reminder set on one device never appears on the others)
- **Status:** RESOLVED in commit 496f4ef (reminder changes are applied and replayed). ADDRESSED: reminder changes are applied through the prerequisite rule, and `replayReminderHistory` (src/persistence/reminder_replay.ts) rebuilds rows from stored history at every start, in arrival order, with the same causal rule as live sync. A replayed change whose event is absent and whose prerequisite is missing or rejected cannot be decided; it stays in history, is logged by change id and retried at the next start (no visible notice).

## TD-074 — Concurrent sync sessions can leave a stale hold counter or waiting notice
- **ID:** TD-074
- **Title:** If two sync sessions run at the same time and one of them applies a change that the other still counts as held, the held-session counter (`held_changes`) or the "waiting on a change" notice for that change can briefly stay behind. It is cleaned up at the end of the next session or at the next engine start.
- **Priority:** 1/10 — LOW (transient; no effect on data)
- **Status:** OPEN. Known limitation.

## TD-075 — Rejection proofs live in the display list of quarantined records
- **ID:** TD-075
- **Title:** The prerequisite rule for a change whose target is missing needs to know whether a change it depends on was rejected. That proof is read from the quarantine table, which is also the list the user sees. Sync correctness should not depend on display rows. The retention cap now exempts the rows that serve as proof, and a row whose stored record cannot be read is no proof.
- **Priority:** 3/10 — LOW (works today; fragile if display rows are changed or removed)
- **Status:** OPEN. To revisit with the conflict-engine work.

## TD-076 — A genuine create of a non-default calendar can be quarantined by an unrelated rejected change
- **ID:** TD-076
- **Title:** A create of a non-default calendar is quarantined when its clock covers an unrelated change from another device that this device rejected: the prerequisite rule treats the rejected change as a prerequisite of the create (`sync_service.ts`, calendar apply path, together with the rejection-proof lookup in `database.ts`). Not reachable today, because only the default calendar exists.
- **Priority:** 2/10 — LOW (not reachable today)
- **Status:** OPEN. To fix before multiple calendars ship.

## TD-077 — When one (device, sequence number) exists with two contents, the first copy to arrive is stored
- **ID:** TD-077
- **Title:** A change is identified only by its origin device and sequence number. When two different copies of the same (device, sequence number) exist (for example after a device was restored from an older backup and reused the number), whichever copy arrives first is stored, and the other is reported as a duplicate-content warning. If the real copy is held and the other copy arrives first, the other copy is stored and the existing warning describes the stored copy; the real copy raises no new warning, because warnings of this kind are de-duplicated. Detection only; nothing is repaired. See TD-079.
- **Priority:** 4/10 — MEDIUM (needs a restored device reusing sequence numbers)
- **Status:** OPEN. To resolve together with TD-079.

## TD-078 — The revalidation allow-list matches invalid-record reasons by text prefix
- **ID:** TD-078
- **Title:** The restart-time revalidation re-checks unresolved rows whose reason is "depends on quarantined change" or starts with the invalid-record prefix. A future reason that happens to start with the same prefix would be re-checked automatically. Fix: fixed reason codes instead of free-text reasons, ideally together with TD-075.
- **Priority:** 2/10 — LOW (no such reason exists today)
- **Status:** OPEN.

## TD-079 — A device restored from an older backup reuses sequence numbers
- **ID:** TD-079
- **Title:** The next sequence number is taken from the local database only, so restoring an older backup rewinds it and the device can write new changes under numbers its peers already hold. Today this is detected and shown as a warning only (TD-077); devices can end up holding different content for the same change. Intended direction: a restored install gets a new device identity and the old identity is unpaired (as the architecture specification already requires for restores). Open question: how a restore is detected.
- **Priority:** 6/10 — MEDIUM (silent divergence after a restore)
- **Status:** OPEN.

## TD-080 — Reminders can fire twice after a restart, and two labels are wrong
- **ID:** TD-080
- **Title:** The list of reminders already delivered lives in memory only. After a restart (or the sidecar being restarted) a reminder that already fired, whose event has not ended yet, fires again, labelled "missed". Two labels are also wrong: a reminder whose time falls in the first 30 seconds after the app started is labelled "missed" although the app was running (the first interval check still has no previous check), and a reminder whose time passed while the timer was paused is delivered late but labelled "on time". Nothing is skipped in any of these cases while the event has not ended. Reproduction: run the alarm check with a simulated clock, once with the fire time inside the first 30 seconds after start, once with a gap in the checks that spans the fire time, and once with a restart after the reminder fired.
- **Priority:** 3/10 — LOW (duplicate or mislabelled notification; nothing lost)
- **Status:** OPEN. Fix direction: persist the delivered keys (or the last check time) locally.

## TD-081 — All-day reminders never fire
- **ID:** TD-081
- **Title:** An all-day reminder fires the day before at a time picked per event (DC-22 D2, section 5.4), stored in `events.all_day_reminder_time`. Nothing writes that column and it is not part of the change-record vocabulary, so an all-day event never gets a fire time and the reminder never fires. The event dialog hides "Remind me" for whole-day events; saving a whole-day event leaves any existing reminder unchanged. To build: a per-event time field in the dialog, a change record that carries it, and the fire rule in the alarm engine.
- **Priority:** 4/10 — MEDIUM-LOW (feature missing; the option is hidden so users are not misled)
- **Status:** OPEN.

## TD-082 — A fresh worktree has no dist/sidecar.mjs and one test depends on another having built it
- **ID:** TD-082
- **Title:** tests/ensure_listener_port.test.ts needs dist/sidecar.mjs. In a fresh checkout or worktree the file does not exist until `npm run sidecar:build` runs, so the test fails or passes depending on whether another test built it first (test-order dependency).
- **Priority:** 2/10 — LOW (test setup only)
- **Status:** OPEN. Fix: build the sidecar in a test setup step or skip with a clear message.

## TD-083 — Applying a full-state snapshot deletes events but not their reminders
- **ID:** TD-083
- **Title:** The snapshot apply path (src/sync/full_state.ts, the event delete statement) removes event rows without removing the reminder rows of those events. The local and remote change paths now remove them together with the event (`deleteEventRows`). Snapshots are off in this release.
- **Priority:** 2/10 — LOW (snapshots are off; orphan rows are harmless to the alarm, which only reads live events)
- **Status:** OPEN. Fix before snapshots are enabled. Dormant while full-state snapshots are off (since 02563c5); must be fixed before snapshots are switched on.

## TD-084 — A recurring event that cannot be expanded for the alarm is reported in the log only
- **ID:** TD-084
- **Title:** If a series cannot be expanded for the alarm timer, the timer now writes one log line per series (ids only, no calendar content) and falls back to the first occurrence. There is no visible notice: the user-facing warning list is built from change records (see TD-075), and a fake change record must not be created for it. A visible notice needs its own local warning list.
- **Priority:** 2/10 — LOW (not reachable with a valid event today)
- **Status:** OPEN.

## TD-085 — A resolution on the conflict screen does not restore a deleted event
- **ID:** TD-085
- **Title:** Resolving a delete-versus-edit conflict with "keep the edit" writes a change record (field path `*`, operation set) but does not recreate the deleted event row on this device, and the record's value shape is not the full-event shape the change applier accepts for an absent event, so other devices do not recreate it either. The only path that recreates an absent event today is an incoming full-event change (field path `event`); it also rebuilds that event's reminders. The restore-versus-delete behaviour (which side wins, how a restored event and its reminders come back) needs its own decision and design together with the conflict-engine work.
- **Priority:** 5/10 — MEDIUM (a user who chooses to keep an edit over a delete does not get the event back)
- **Status:** OPEN. Same area as TD-070.

## TD-086 — Reminder replay cost grows quadratically with the number of edits of one reminder
- **ID:** TD-086
- **Title:** The startup replay checks each stored reminder change against the other stored changes of the same reminder for causal staleness. For a reminder edited n times this is O(n²): about 0.3 s per start for 10,000 reminders with one change each, but about 1.5 s per start for a single reminder edited 2,000 times (measured on a desktop). Fix: index stored changes per reminder member, or keep the latest causal frontier per member.
- **Priority:** 2/10 — LOW (needs a reminder edited thousands of times)
- **Status:** OPEN.

## TD-087 — Saving the event dialog before its reminder lookup finishes can clear reminders
- **ID:** TD-087
- **Title:** The dialog loads the event's reminder asynchronously; until the lookup returns (or if it fails), the "Remind me" checkbox shows the no-reminder state. Saving a timed event in that window clears the event's reminders without the several-reminders notice. Over local IPC the window is in the millisecond range. Fix: disable saving until the lookup has returned, or skip reminder changes when the lookup did not complete.
- **Priority:** 2/10 — LOW (narrow timing window)
- **Status:** OPEN.

## TD-088 — Conflict resolution status does not travel between devices
- **ID:** TD-088
- **Title:** A conflict resolved on one device stays open on the other devices; the chosen resolution value does arrive, but the resolved status does not. There is no message in the sync engine that carries conflict records, and `applyRemoteResolution` has no caller in `src/`. Contracts DC-08 §3.5 and DC-14 §6.3 specify a transport for this that is not built. OBSERVED: a three-device reproduction in which one device resolved and the other two still showed the conflict unresolved. Related: TD-094 (a conflict existing on one device but not another).
- **Priority:** Not rated
- **Status:** CONFLICT ENGINE

## TD-089 — Unpairing warning: show which devices have not confirmed an unpairing
- **ID:** TD-089
- **Title:** Required behaviour, not built: after a device is unpaired, the user should see which of the remaining devices have not yet confirmed the unpairing. No code exists for it. Related: TD-071 (the unpairing cutoff can differ between devices), to be revisited together.
- **Priority:** Not rated
- **Status:** OPEN

## TD-090 — Relay of advertised-but-unservable changes was never tested
- **ID:** TD-090
- **Title:** A device can advertise changes it cannot serve (held back, or learned only from version counters). TD-072 records the observed symptom (needless requests); this item is the missing test evidence: that behaviour was never exercised across a relay hop, so the runtime effect is not established. With snapshots off, the full-copy fallback no longer triggers. No test has been written. Related: TD-072.
- **Priority:** Not rated
- **Status:** OPEN

## TD-091 — A device updated by a full copy has no per-change identity or conflict rows
- **ID:** TD-091
- **Title:** A device brought up to date by a full-state copy lacks the per-change identity records and conflict rows that incremental sync creates. Theoretical: no violation has been demonstrated. Only reachable when snapshots are on (off since 02563c5); must be reviewed before they are switched on. Related: TD-048, TD-052.
- **Priority:** Not rated
- **Status:** DORMANT WHILE SNAPSHOTS ARE OFF

## TD-092 — Choosing an edit as winner does not update the event
- **ID:** TD-092
- **Title:** On the conflict screen, picking one of the competing edits as the winner does not update the event itself. Belongs to the conflict-engine work.
- **Priority:** Not rated
- **Status:** CONFLICT ENGINE

## TD-093 — "Keep mine" can write an outdated value
- **ID:** TD-093
- **Title:** Choosing "keep mine" on a conflict can write a value that is no longer current, replacing newer data. Belongs to the conflict-engine work.
- **Priority:** Not rated
- **Status:** CONFLICT ENGINE

## TD-094 — A conflict can exist on one device but not on another
- **ID:** TD-094
- **Title:** Devices holding the same changes can disagree on whether a conflict exists at all. Related to TD-088 (status not shared) but not identical, and to TD-070 (concurrent edits to series, overrides and calendars are not detected).
- **Priority:** Not rated
- **Status:** CONFLICT ENGINE

## TD-095 — A conflict stays open after a later delete
- **ID:** TD-095
- **Title:** When an event is deleted after a conflict was recorded for it, the conflict stays open. INFERRED likely cause: `closeObsoleteOnTombstone` has no caller in `src/`.
- **Priority:** Not rated
- **Status:** CONFLICT ENGINE

## TD-096 — Restore versus delete leaves devices disagreeing on whether the event exists
- **ID:** TD-096
- **Title:** One device restores an event while another deletes it: after sync, devices can disagree on whether the event exists. TD-085 is the related single-device symptom (a resolution does not recreate the deleted event). Related: TD-085.
- **Priority:** Not rated
- **Status:** CONFLICT ENGINE

## TD-097 — A whole-event restore overwrites a concurrent description edit
- **ID:** TD-097
- **Title:** Restoring a whole event overwrites a description edit made concurrently on another device. Accepted as a limitation of the conflict engine.
- **Priority:** n/a
- **Status:** ACCEPTED LIMITATION

## TD-098 — Undo after a delete resolution does not bring the event back
- **ID:** TD-098
- **Title:** After a conflict about a deleted event is resolved, undoing the resolution does not bring the event back. Accepted as a limitation of the conflict engine.
- **Priority:** n/a
- **Status:** ACCEPTED LIMITATION

## TD-099 — Edits for not-yet-created items were dropped but acknowledged
- **ID:** TD-099
- **Title:** Edits that arrived before the item they edit existed were dropped while still being acknowledged, so they were never re-sent. Fixed in commit 02563c5 (prerequisite rule; the read position is not advanced until the prerequisite is applied).
- **Priority:** n/a
- **Status:** FIXED

## TD-100 — Non-event item types were stored but never written
- **ID:** TD-100
- **Title:** Changes for item types other than events were stored in history but never written to their tables. Fixed in commit 02563c5.
- **Priority:** n/a
- **Status:** FIXED

## TD-101 — Change-log truncation was found unwired and is kept off
- **ID:** TD-101
- **Title:** Delete-marker cleanup (DC-06 compaction) exists as a library but is not wired into production. Closed by the operating constraint in DC-06 and DC-09: change-log truncation stays off while full-state snapshots are off (since 02563c5). Related: TD-046.
- **Priority:** n/a
- **Status:** CLOSED BY DECISION

## TD-102 — Conflict contents depend on the order in which changes arrive
- **ID:** TD-102
- **Title:** Devices that hold the same changes can record different conflicts for them: the conflict record takes its field from whichever change arrived last, so a delete-versus-edit conflict is filed under the whole event on one device and under a single field on another (`recordConflictRow`, `src/persistence/database.ts`). Reproduced by the delivery-order test (scenario S4, conflict check, marked as an expected failure). Related: TD-088, TD-094.
- **Priority:** Not rated
- **Status:** CONFLICT ENGINE

## TD-103 — The value shown under an open conflict differs between devices
- **ID:** TD-103
- **Title:** While a conflict is unresolved, each device keeps showing its own local value (DC-03 §3.3/§3.4), so devices with the same changes can show different values until the conflict is resolved. Decided as intended behaviour: values must converge after resolution, not while a conflict is open; the conflict record itself must converge (TD-102).
- **Priority:** n/a
- **Status:** CLOSED BY DECISION
