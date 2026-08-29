# Tide Pre-Release Hardening Campaign — CONSOLIDATION REPORT

Lead: Lead QA Dev (orchestrator) · Date: 2026-08-29 (evening)
Pinned SHA: **781dc7b** (clean tree at campaign start; verified unchanged at end)
Agents: QA-1 Sync/Convergence (/tmp/tide-qa-sync), QA-2 Crash/Persistence
(/tmp/tide-qa-crash), QA-3 Boundary/Adversarial (/tmp/tide-qa-boundary).
Isolation: separate worktrees, port ranges (41000s/42000s/43000s), per-agent
DB/data dirs, kill-only-own-processes. Verified before spawn; no cross-agent
interference observed (one boundary-agent-side stale sidecar correctly
attributed to QA-2's environment and left alone).

---

## 1. VERDICT: **AMBER — not release-ready until two fix packages land**

- **RED (release blockers):** 2 findings (C-1, M-1 below).
- **GREEN (proven healthy):** storage/persistence core, RPC frame handling,
  IPC durability, pairing-offer lifecycle, quarantine mechanics — see §5.

---

## 2. WHAT WAS TESTED (aggregate)

~210 logged scenario checks across three matrices:
- QA-1: 12 sync scenarios (convergence oracle: SHA-256 fingerprints of
  normalized semantic state across 2–4 peers), real-TCP + in-memory carriers,
  composed faults (kill-mid-convergence ×5, hostile-payload-during-sync ×3).
- QA-2: 12 crash scenarios × ≥3 runs each — SIGKILL mid-write/mid-IPC/mid-list/
  mid-update-delete, 10 kill-restart cycles, migration downgrade + 8
  kill-during-open attempts, WAL truncation ×3, main-DB byte corruption ×3,
  real two-process TCP sync with mid-sync SIGKILL ×3.
- QA-3: 136 executed checks (166 matrix rows) — seam round-trips, wrong types,
  malformed frames (28 classes), pipelining (100-deep), floods (500-op burst,
  1000-invalid flood), pairing cycles (20 cancel + 10 supersede), concurrency
  during long ops, restart persistence, allow-list static/dynamic comparison.

**Not tested (explicit):** DC-16 misbehavior-ladder flood to Tier-1 (needs
500+ invalid records/window; out of QA-1 budget), migration torn-write window
(sub-ms transaction; not constructible via public surface — QA-2 F-3), .ics
export surface (DC-18 approved, not implemented), GUI-layer UX flows.

## 3. WHAT PASSED (proven healthy)

- **Storage core:** 100+ acked writes durable across kills at every probed
  moment; unacked ops all-or-nothing; T1 atomicity (event↔change) never
  violated; integrity_check=ok after every abuse cycle; WAL masking of main-DB
  corruption never served wrong data.
- **IPC frame handling:** 28/28 malformed-frame classes rejected/ignored with
  process survival; 100-deep pipelining zero cross-contamination; 500-op burst
  clean; unicode/1MB/2^53/negative-ms round-trips byte-equal.
- **Pairing-offer lifecycle:** 30 offer/cancel/supersede cycles, zero socket
  or RSS leak (validates commit f441f75).
- **Quarantine mechanics:** survives crashes; retry applies exactly once
  (15/15); delete never poisons the seq stream; flood of 1000 invalid records
  fully rejected, counters untouched.
- **Real-TCP sync resilience:** mid-sync SIGKILL → full convergence 3/3.

## 4. WHAT FAILED — deduplicated, severity-normalized

### RELEASE BLOCKERS

**C-1 · CRITICAL — Compaction × snapshot silently destroys live events**
(QA-1 F1, 3/3, survives restart, data loss)
DC-06 sweep deletes change history while live event rows remain;
buildSnapshot then omits history-less entities, and the §7.1 absence rule
treats the empty post-compaction version vector as "dominated" — tombstoning
the source device's OWN live events when it accepts an incomplete snapshot.
Alternate path: fresh peers permanently miss the data (applied_upto advances,
everything forever duplicate). Silent, unrecoverable, fingerprints stay
"equal" (convergence to empty = data loss the oracle only caught via row
counts). Evidence: sync-agent evidence/results/sc5*.json (sweep deletedChanges
8/9 → eventsA 6→0 after snapshot).

**M-1 · MAJOR — update_event with client-supplied input.id silently corrupts
state** (QA-3 BND-01, 3/3 + restart persistence 3/3)
Target row untouched (edit silently lost), rogue event row inserted, 3 change
records written claiming the update applied → record/row divergence that sync
would propagate cross-device. ok:true throughout. Not reachable via the
shipped typed Rust layer today (EventInput is 5 fields), but the sidecar is
the authoritative contract and accepts this from any raw client/tests/
tooling. Evidence: boundary-agent evidence/seam_deep.json E2 rows.

### MAJOR (non-blocking but must fix pre-release)

**M-2 · MAJOR — DC-03 conflict detection is not wired into the live pipeline**
(QA-1 F2, 5/5). detect()/conflicts table have no writer in src/; concurrent
same-field edits silently converge to one side (timing-dependent winner); no
user surface. The conflicts UI (TD-005-era work) currently has no data
source. Same-field is the gap; different-field merges correctly (3/3).

**M-3 · MAJOR — No read timeout in engine pull phase** (QA-1 F3, 2-3/3).
A peer that solicits CHANGES_REQUEST then stalls (sleep, power loss, NAT
death) leaves runEngineSession pending forever; sync_now RPC never returns;
manual restart required. Availability, not corruption.

**M-4 · MAJOR — Every sync degenerates to full-state transfer**
(QA-1 F4, deterministic). neededRanges includes the peer's own produced
records (applied_upto never covers self) → every session has a no-progress
gap round → DC-09 Trigger A full-state snapshot EVERY session: O(entire DB)
traffic, and it multiplies exposure to C-1's snapshot semantics.

**M-5 · MAJOR — endMs < startMs accepted; response/persisted/synced values
disagree** (QA-3 BND-02, 3/3). Response echoes the written value, row holds
the clamp (startMs), change-record payload carries yet another value.
Reachable from the typed UI today.

**M-6 · MAJOR — Scalar type confusion silently transformed at the sidecar
seam** (QA-3 BND-03, deterministic). title:42 → stored "42.0"; startMs:"abc"
→ stored 0 (ok:true); startMs:null → 0; 1e999 → response null, stored 0.
Raw-protocol reachable only today; violates the no-silent-transformation
contract for the authoritative process.

### MINOR

**m-1** — Quarantine re-delivery after frontier advance re-quarantines:
second row per replay (QA-1 F5, 3/3); unbounded pollution of Sync-Errors by
a repetitive peer; data otherwise correct.
**m-2** — Zombie pending_changes row survives convergence after aborts
(QA-1 F6, 2/5); diagnostics skew only.
**m-3** — allDay accepts any value, silently normalizes, echoes raw; missing
allDay silently false (QA-3 BND-04). Raw-protocol only.
**m-4** — create_event honors client-supplied input.id (QA-3 BND-05) —
companion to M-1; collision blocked by UNIQUE today.

### OBSERVATIONS (not defects)

- Delete-vs-edit converges to deletion but the deleting peer retains no
  tombstone row (QA-1 F8) — safe today ONLY while C-1's absence-rule flaw
  exists unchecked; flag for the C-1 fix package.
- Known-seq malformed records dropped as duplicates before validation —
  invisible to DC-16 accounting (QA-1 F7).
- noise-c.wasm maps unhandled rejections to process.exit(1) — a hard-crash
  path if any engine promise rejects uncaught in production (QA-1 F9).
- ensureDefaultCalendar emits a spurious authoritative change per restart
  (QA-2 F-1, 10/10 cycles): change log grows with restart count; latent LWW
  data-loss trap once calendar rename ships. Recommended fix-before-rename-
  feature. (Severity held at MAJOR by lead synthesis; agent said MAJOR —
  confirmed, it is protocol-hygiene + latent trap, no current data loss.)
- update_event rejects partial input with raw NOT NULL constraint error
  (QA-2 F-2) — API contract sharpness.
- list_series in Rust allow-list but unimplemented in sidecar — dormant
  drift (QA-3 BND-06). Will become a broken-device-dialog bug the moment
  the UI calls it.
- Protocol leniency quirks (dup JSON keys last-wins; id 1e999 → id:null
  response; same-id in-flight ambiguity) (QA-3 BND-07).
- sync_now to unroutable host hangs with no cancel surface; sidecar stays
  responsive (QA-3 BND-08). Correlates with M-3 (both = unbounded engine
  session waits).
- Migration torn-write window untestable via public surface (sub-ms
  transaction); demonstrated safe 8/8 (QA-2 F-3).
- WAL durability note: backup tooling MUST copy -wal alongside -db
  (QA-2 F-4).

## 5. CROSS-AGENT CORRELATIONS & ROOT-CAUSE CLUSTERS

**Cluster 1 — "Snapshot absence-rule assumes complete change history"**
(C-1 + QA-1 F8 + M-4): the snapshot pipeline's domination logic and the
deleting-peer's no-tombstone behavior both presume change records are
eternal. Compaction breaks that presumption; per-session full-state (M-4)
guarantees the broken path runs constantly. Fix package #1: make snapshot
build carry explicit tombstones + version vectors for history-less entities,
or forbid compaction of history still referenced by live entities; fix
neededRanges to exclude self-produced sequences. Recommended: fix C-1 and
M-4 together (same files: full_state.ts, compaction.ts, knowledge_state.ts).

**Cluster 2 — "Sidecar input validation gap"** (M-1 + M-6 + m-3 + m-4 +
QA-2 F-2): one validateEventInput() at the dispatcher (string title/desc,
finite-int startMs/endMs with end>=start, boolean allDay, reject unknown
fields and client-supplied id) closes five findings. Fix package #2.

**Cluster 3 — "Unbounded engine-session waits"** (M-3 + BND-08): add a
bounded idle/read timeout to the pull phase and a cancel surface for
sync_now. Fix package #3.

**Cluster 4 — "Conflict pipeline unwired"** (M-2 standalone): wire
detect() into applyRemoteChange/mutator path; conflicts UI already exists.
Fix package #4 (design-alignment work per DC-03 — needs a small design
review before implementation since detect() was never live).

Smaller items (F-1 ensureDefaultCalendar guard, m-1 quarantine re-delivery
dedupe, m-2 pending GC, BND-06 list_series drift, noise-wasm rejection
guard) → fix package #5 (hygiene sweep).

## 6. GAP CHECK → COMBINED-FAULT PASS DECISION

**Decision: one narrowly-scoped combined-fault pass IS warranted** — but
only after fix packages 1–2 land, testing THE FIXES, not pre-fix state:
the highest-risk untested intersection is "compaction + snapshot + concurrent
edit + kill mid-snapshot" (C-1's exact seam under violence), and QA-1's
budget expired before DC-16 flood testing. Scope lock: (a) post-fix replay
of SC5 with a SIGKILL injected mid-snapshot-apply, (b) Tier-1 flood reaching
the misbehavior ladder while a snapshot exchange is in flight. Everything
else was adequately covered; no other gap justifies a pass. (Same isolation
rules apply when this runs.)

## 7. REMAINING UNCERTAINTY

- DC-16 ladder under sustained flood: untested (budget) — behavior under
  Tier-1 escalation is inference from tests, not campaign evidence.
- Migration torn-write: safe by construction argument, not by observation.
- GUI-layer surfaces (dialogs, invoke path through the real Rust gate under
  adverse input) were out of scope; QA-3 verified the sidecar contract and
  static allow-list only.
- QA-1's convergence oracle excludes sync bookkeeping — corruption hiding
  purely in bookkeeping (like m-2) is caught only where agents checked it
  explicitly.
- Lead confidence: high on blockers (deterministic, evidence-backed, spot-
  checked); medium on real-world frequency of M-3/M-4 (depends on usage
  patterns of sync_now).

---

## OBSERVER PASS (Phase 3) — PASS

- Evidence spot-checks: QA-1 SC5 x3 JSON verified (sweep deletedChanges=8,
  eventsA→0, oracle converged-to-empty = the data-loss signature) ✓;
  QA-3 seam_deep.json E2 rows verified (ok=true, resp.id=PHANTOM,
  phantomRow=true, newChangeRecs=3) ✓; QA-2 s5_cycles.json verified
  (changes_delta=1 for 10/10 cycles, integrity ok) ✓. Conclusions in all
  three reports are evidence-anchored, not asserted.
- Contamination: zero modified tracked files in all three worktrees (only
  untracked qa-tmp/ + docs/qa/); main tree clean at 781dc7b; zero orphaned
  sidecar processes; all agents attributed environment artifacts correctly
  (e.g. QA-3 leaving QA-2's stale sidecar alone; QA-1 documenting a probe
  seq-collision as harness artifact, not a defect).
- No production fixes made by any agent or by the lead. ✓
- Agent self-reported severities accepted after normalization check; two
  escalations by lead documented in §4 (C-1 impact wording, F-1 kept MAJOR
  with rationale).

## RELEASE BLOCKERS (summary)

1. C-1 compaction × snapshot data loss (fix package #1)
2. M-1 update_event input.id corruption (fix package #2)

Both are deterministic, evidence-backed, and survive restart. Ship-blocking
until fixed and re-verified.
