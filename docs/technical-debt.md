# Tide Technical Debt Log

Canonical project-level technical-debt registry. Stable IDs; statuses:
OPEN / INVESTIGATE / DEFERRED / BLOCKED / RESOLVED.
When an item is fixed: mark RESOLVED, record the resolving commit and the
regression test that proves it — do not delete entries.

Established 2026-08-27 after sync-engine milestone commit `e534c1f`
(verified state at commit: 320/320 tests, TSC clean, two-instance E2E
stable, blind final verification PASS WITH CONCERNS with zero new issues).

---

## TD-001 — Quarantined sequence gap
- **ID:** TD-001
- **Title:** Quarantined producer sequence can permanently block later records from the same producer
- **Priority:** 7/10 — HIGH
- **Status:** OPEN
- **Why it matters:** Potential synchronization liveness/convergence failure. If producer P's seq N is quarantined, dense-sequence expectation means all of P's later records buffer in `pending_changes` waiting for a record that will never apply — unbounded durable growth, stream never converges.
- **Current behavior:** `applyBatch` in `src/sync/sync_engine.ts` quarantines records failing `validateChangeRecord` (DC-04 §4.3 durable quarantine) but does not advance any frontier for them. Later seqs of the same producer stay buffered (confirmed by blind verifier probe3: d-M seq 1 quarantined, seq 2 left as durable pending zombie).
- **Trigger for addressing it:** Next sync work session; must precede release of multi-device sync.
- **Relevant files/components:** `src/sync/sync_engine.ts` (applyBatch quarantine branch), `src/persistence/database.ts` (`quarantineRecord`, `applyRemoteChange`, pending table), `src/sync/knowledge_state.ts` (classifyArrival/advanceApplied), `docs/contracts/DC-04` §4.3, DC-02 knowledge semantics, DC-08 protocol.
- **Known repro:** Quarantine producer P seq N through engine session, then deliver P seq N+1 valid → N+1 buffers forever. Blind verifier probe preserved at `/tmp/tide-verify-final/probe3.ts` (if still present).
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
- **Status:** RESOLVED (fix uncommitted at investigation time — TD-002 agent; resolving artifact: `tests/td002_nan_investigation.test.ts`; files changed: `src/sync/change_record.ts`)
- **Why it matters:** Silent durable-state corruption possibility from malformed remote payloads (better-sqlite3 binds JS NaN to SQL NULL).
- **Current behavior (blind verifier finding):** NaN in schedule startMs/endMs is not caught by `typeof v.startMs === "number"` guards; NaN binds as NULL into nullable `utc_start_ms`/`utc_end_ms`, wall strings become `"NaN:NaN:NaN"`. Does not violate CHECK (row stays internally consistent with all_day unchanged), classification was expected/unsupported input.
- **Investigation verdict (2026-08-27, TD-002 agent) — REACHABLE + CORRUPTING (Path A):**
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

## TD-007 — Hygiene findings from TD-005/006/002 blind verification (2026-08-27)
- **ID:** TD-007
- **Title:** Minor findings from combined blind verification (verdict: SAFE TO COMMIT)
- **Priority:** 2/10 — LOW (hygiene)
- **Status:** OPEN
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
