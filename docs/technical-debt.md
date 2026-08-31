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

## TD-009 — Frontend Cancel button for pending pairing offer
- **ID:** TD-009
- **Title:** Wire a Cancel button in the Devices dialog to the existing cancel_pairing_offer op
- **Priority:** 2/10 — LOW (optional/aesthetic: the security gap is CLOSED server-side; the op exists, is allow-listed, and offers are already cleaned up by supersede, ceremony completion, and stdin-EOF shutdown)
- **Status:** RESOLVED (2026-08-30) — frontend Cancel button wired to `cancel_pairing_offer` (frontend/index.html `btn-pairing-cancel`, frontend/devices.ts `cancelPairingOffer`, tests/td009_cancel_button.test.ts)
- **Scope:** frontend/devices.ts + frontend/index.html: show a Cancel affordance while a pairing offer is pending (pairing-step-show visible with a code), call syncOp("cancel_pairing_offer"), update UI state. No backend work required.
- **Origin:** blind review of f441f75 (pairing-offer lifecycle) noted user-initiated cancel is currently unreachable in the UI.

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
- **Status:** OPEN (created 2026-09-01)
- **Why it matters:** The c088023 sync-stall fix is verified by scoped suites (transport 17/17, sync suites 8/8, recurrence 24/24) and the full three-device harness (7/7 scenarios, 50 sessions, 0 session errors) — but the FULL vitest suite has not been re-run since the fix. The one-suite-at-a-time rule (postmortem c13e457) deliberately deferred it while the two blind adversarial reviewers hold the repo.
- **Resolving action:** One clean full `npm test` + `npx tsc --noEmit` + `cargo build` pass, recorded here with COMMAND + EXIT STATUS. Expected: all green (no other production code changed in c088023 beyond sync_engine/noise_transport). Any failure here is a finding, not a flake — investigate, never ratchet.
- **Trigger:** Immediately after both blind reviewers deliver.

## TD-013 — Transient EADDRINUSE on harness port bands
- **ID:** TD-013
- **Title:** Three-device harness scenarios occasionally fail with EADDRINUSE on a port that nothing holds afterwards
- **Priority:** 4/10 — MEDIUM (test-infrastructure flake, not protocol)
- **Status:** OPEN (created 2026-09-01; observed twice independently)
- **Evidence:** During the c088023 verification run, harness scenario 2 failed once with EADDRINUSE on 41910 (sidecar sync listener could not bind; nothing held the port afterwards; scenario passed on rerun). A second occurrence observed in the blind-review re-run. Pattern: TIME_WAIT or interface-timing race between scenario teardown and next-scenario bind.
- **Fix direction:** deterministic per-run port bases in RunContext, or a bounded bind-retry with explicit logging in the harness (NOT in agents — agent rule 2 forbids retry-until-green outside the harness itself).
- **Trigger:** Before the harness becomes the standing release gate for future sync work (it now is), make it deterministic.

## TD-014 — Recurrence expansion: INTERVAL/WEEKLY semantics broken (blind review, CRITICAL+)
- **ID:** TD-014
- **Title:** expandOccurrences: DAILY/MONTHLY INTERVAL>1 hangs or collapses; WEEKLY without BYDAY expands daily; WEEKLY INTERVAL>1 picks wrong weeks
- **Priority:** 9/10 — CRITICAL (UI freeze reachable from the dialog builder)
- **Status:** OPEN (created 2026-09-01, blind adversarial review F1/F2/F3)
- **Findings (file:line, empirical probes in reviewer report):**
  - F1 CRITICAL: `src/domain/recurrence_conflicts.ts:198-212` — skip loop never recomputes `daysSinceBase`, so `DAILY;INTERVAL=2` HANGS the renderer (probe: COUNT=5 never returns); with UNTIL it collapses to 1 occurrence; `MONTHLY;INTERVAL=2` hangs; `periodDays = 28*interval` is not a month.
  - F2 MAJOR: `:175-176` — `FREQ=WEEKLY` without BYDAY matches every day (comment claims base-weekday restriction; code doesn't do it). Probe: base Wed, 1-week window → 14 daily chips.
  - F3 MAJOR: `:148-169` — `WEEKLY;INTERVAL=2;BYDAY=MO,WE` lands in off-weeks (weekCursor/day-walk interplay broken).
- **Reachability:** the DC-12 dialog builder exposes interval + daily/weekly/monthly, so a user picking "every 2 days" freezes the calendar render (calendar.ts:243 expandSeriesEvents). Synced-in rules from other clients hit F2/F3 too.
- **Fix direction:** rewrite expansion as proper per-FREQ stepping (daily: step days from base with modulo check; weekly: week-anchored stepping against weekStart with BYDAY set membership; monthly: calendar-month stepping, NOT 28-day approximations), recompute the anchor derivative each step, add probes for every FREQ×INTERVAL×BYDAY combination the builder can produce, plus the reviewer's probe cases as regression tests.
- **Constraint:** INVARIANT 9 (wall-clock preservation) must hold; do not touch tz semantics (reviewer confirmed those clean); tests FIRST, prove each fails on current code.
- **Trigger:** NEXT IMPLEMENTATION WAVE — this blocks the recurrence wave being owner-visual-passable.

## TD-015 — Occurrence-override identity derived from MOVED start (blind review, data-integrity)
- **ID:** TD-015
- **Title:** dialog.ts derives recurrenceId from the override's moved startMs → second edit of a moved occurrence writes an orphan override + duplicate chip
- **Priority:** 8/10 — HIGH (data integrity, DC-12 R1/R2 violation)
- **Status:** OPEN (created 2026-09-01, blind adversarial review F4)
- **Finding:** `frontend/dialog.ts:661,716-719` calls `deriveRecurrenceId(existing.startMs, …)` where `existing` is the rendered chip whose startMs is the override's moved start. calendar.ts:278 already exports `occurrenceOf(ev)` carrying the correct original recurrenceId — dialog.ts never imports it. Second edit/delete of a moved occurrence keys a NEW override under the moved wall-time; the original is orphaned, uneditable from the UI, and the grid renders duplicate chips.
- **Fix direction:** thread the chip's original `recurrenceId` (via `occurrenceOf`) into the dialog open path and derive from THAT; regression test: move an occurrence, edit it again, assert ONE override row and one chip.
- **Trigger:** same wave as TD-014 (recurrence follow-up package).

## TD-016 — Unchecking "Repeat" on a series silently deletes the whole series (blind review)
- **ID:** TD-016
- **Title:** dialog Save with Repeat unchecked runs deleteEvent(id) on the series — no confirmation, no warning
- **Priority:** 7/10 — HIGH (destructive action behind an innocuous Save)
- **Status:** OPEN (created 2026-09-01, blind adversarial review F5)
- **Finding:** `frontend/dialog.ts:644-653`. Violates the destructive-confirm contract (two-step confirm with warning; `confirm:true` at RPC level) and the UI-interaction-is-owner's-call rule.
- **Fix direction:** owner decision needed on semantics: (a) unchecking Repeat = "end recurrence here" (convert to single event / set UNTIL), or (b) keep delete-series but route through the two-step destructive confirm. Recommendation: (a) — unchecking a checkbox should never equal deleting data.
- **Trigger:** owner decision, then same wave as TD-014/015.

## TD-017 — CHANGES_ACK semantics deviate from frozen DC-08 §3.4 (blind review)
- **ID:** TD-017
- **Title:** c088023 repurposed CHANGES_ACK as a one-shot bidirectional session terminator without a DC-08 amendment
- **Priority:** 6/10 — MEDIUM-HIGH (protocol/contract integrity; no correctness break in the homogeneous fleet)
- **Status:** OPEN (created 2026-09-01, blind adversarial review F2 — sync reviewer)
- **Finding:** DC-08 §3.4 specifies per-batch ACK ("sent after each batch is fully processed, not coalesced across sessions"); the implementation sends ONE ACK per session before serving the peer's pull, and receiving a peer ACK terminates the barrier. Internally self-consistent (reviewer verified deadlock-free), but (1) a conformant per-batch peer's ACK would cut the barrier short, (2) barrier-mode applications are never ACKed (delays compaction unlock on the peer). Frozen-contract deviation without an amendment is a process violation.
- **Fix direction:** DC-08 amendment (v2) formalizing the barrier semantics (one ACK as joint terminator; per-batch ACKs retained for compaction knowledge when records are applied in barrier mode), or rework the barrier to a dedicated message. Owner decides via the amendment; do NOT silently conform the code to the old text.
- **Trigger:** next sync-layer work session; must precede any non-homogeneous (third-party) peer implementation.

## TD-018 — Dead-carrier session masquerades as success (blind review)
- **ID:** TD-018
- **Title:** transport error mapped to clean EOF + swallowed pump error → a peer RST mid-session reports a converged session
- **Priority:** 6/10 — MEDIUM-HIGH (observability/correctness-of-reporting, not data loss)
- **Status:** OPEN (created 2026-09-01, blind adversarial review F1 — sync reviewer)
- **Finding:** `noise_transport.ts` feed loop's `finally` close (correct for FIN) plus `sync_runtime`'s error/end/close → receive()=null mapping plus the outbound pump's `void pump.catch(() => {})` mean a dead carrier surfaces as clean session end; pre-fix it surfaced as a loud SyncIdleTimeoutError. DC-05 §6.3 requires transport failure to be terminal (SessionError).
- **Fix direction:** distinguish FIN from error at the framing layer (error → SessionError, not null-EOF) and propagate pump failure to the session result; regression test with an error-injected carrier. Careful not to re-break the stall fix (FIN must stay clean EOF).
- **Trigger:** next sync-layer work session (pairs with TD-017 in one package).

## TD-019 — Minor sync-layer hygiene (blind review)
- **ID:** TD-019
- **Title:** engine-level message stash leaks across sessions (F3); FrameQueue single-waiter slot + immortal outbound pump (F4); ACK sends possibly-stale applied_upto (F5)
- **Priority:** 3/10 — LOW (all bounded; no data-loss attack found by the reviewer)
- **Status:** OPEN (created 2026-09-01, blind adversarial review F3/F4/F5 — sync reviewer)
- **Details:** stash is pre-existing, not introduced by c088023; pump leak is one closure per session; stale-ACK frontier is safe under max-merge. Fix opportunistically in the next sync package (TD-017/018 wave).
- **Trigger:** with TD-017/TD-018.
