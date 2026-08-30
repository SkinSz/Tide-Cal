# TIDE DESIGN CONTRACT DC-13
# Background Operation and Synchronization Scheduling
Status: APPROVED by project owner (2026-08-25)

OWNER AMENDMENTS (2026-08-25):
- Defaults tuned: sync.debounce_seconds 10 (was 5), sync.sweep_minutes
  10 (was 15) — fresher data without meaningful network load; see §3.1
  and §3.5.
Depends on: Architecture Spec v0.3 §4, §22, §30 (#13, #14), §31;
             DC-05; DC-07; DC-08; DC-09
Unblocks: Linux implementation of the background/tray component,
          sync scheduler implementation
Resolves: deferred decisions #13 from Spec §30
          (exact Windows background-process architecture) and #14
          (exact synchronization intervals and batching parameters)

==================================================
1. PURPOSE
==================================================

Decides the MINIMUM set of binding facts needed to implement the
background component and the sync scheduler on LINUX (first target
platform per Spec §1 owner amendment 2026-08-25; originally written for
Windows — all decisions below are platform-portable via Tauri 2, with
Linux-specific notes where they differ):

  - which process model hosts background operation (Spec §4 leaves it
    as an implementation decision; deferred decision #13 requires a
    design contract before implementing),
  - WHEN sync sessions open: concrete default intervals and debounce
    parameters for every trigger class in Spec §22 (deferred #14),
  - how triggers interact with each other and with in-flight sessions.

Frozen constraints this contract implements:

  - Spec §4: synchronization can operate without the main calendar
    window remaining open.
  - Spec §22: synchronization is opportunistic and event-driven;
    unavailable peers never block local operation; changes SHOULD be
    batched/debounced.
  - Spec INVARIANT 11: no central coordinator; scheduling is purely a
    local decision each device makes about its own sessions.
  - Spec INVARIANT 1: everything here is best-effort optimization;
    offline operation is unaffected if no trigger ever fires.
  - DC-08 §4: trigger points decide WHEN a session opens, never WHAT
    happens inside one. Nothing below modifies session semantics.
  - DC-09: full-state synchronization may be triggered by any trigger
    that opens a session; this contract only decides when that happens.

Core principle inherited unchanged from the whole contract series:
scheduling moves OPPORTUNITY, not correctness. If the scheduler never
runs, data remains safe locally (INVARIANT 2) and converges at the
next successful session (INVARIANT 14 via DC-08).

==================================================
2. PROCESS MODEL DECISION (#13)
==================================================

2.1  DECISION

     Tide on Windows is a SINGLE-PROCESS Tauri 2 application.

     - The Tauri main window is hidden (not destroyed) when the user
       closes it; the process stays alive with a tray icon present.
     - The sync engine runs as a Tauri-managed async task inside the
       same Rust process (tokio task spawned under the Tauri async
       runtime). It shares memory with the UI layer but communicates
       with it through channels/events, not shared mutable state.
     - mDNS discovery (per the discovery lifecycle contract), the
       Noise endpoint (DC-05), and the SQLite writer all live in this
       same process.

2.2  JUSTIFICATION

     - No multi-process IPC: a separate service/host process would
       require an IPC channel duplicating state (pending queues,
       clocks, peer status) between processes, with versioning and
       crash-recovery complexity for zero functional gain.
     - SQLite single-writer simplicity (DC-07): one process means one
       writer discipline. A second process would force cross-process
       writer coordination or busy-wait locking against WAL.
     - Matches Spec §4 "lightweight background/tray operation": one
       idle process with a parked window is lighter than two.
     - Tauri 2 natively supports hide-to-tray lifecycles; nothing here
       fights the framework.

2.3  REJECTED ALTERNATIVE: SEPARATE BACKGROUND PROCESS/SERVICE

     Explicitly rejected:
     a) IPC surface must then carry change records or database access
        across a boundary — new failure modes for integrity guarantees
        that the in-process model gets for free.
     b) Two processes contend for the single SQLite writer (DC-07);
        WAL helps but cross-process lock negotiation adds latency to
        foreground UI operations, violating section 4.3.
     c) Service installation (auto-start, elevation, update ordering)
        is disproportionate to a personal calendar app and conflicts
        with Spec §3's "normal installed desktop application" stance.
     d) Crash isolation benefit is marginal: the sync engine already
        isolates failures behind the validation pipeline (DC-08 §5).

2.4  LIFECYCLE

     App start:
       -> spawn sync engine async task
       -> begin discovery per the discovery lifecycle contract
       -> run startup trigger (section 3.2)

     Main window closed:
       -> window is HIDDEN, webview kept alive but idle
       -> process continues: tray icon remains, discovery continues,
          all triggers remain armed
       -> background operation is now the sole visible presence

     Quit (tray menu):
       -> stop accepting new sessions and cancel armed timers
       -> graceful shutdown of any in-flight session per DC-08 §4
          property: either finish the exchange cleanly or abort at a
          message boundary such that local state is exactly the
          pre-session state plus fully-applied-and-ACKed records;
          partial batches are never committed (DC-08 TR-4 applies)
       -> flush SQLite, close handles, exit process

     The tray menu offers at minimum: open main window, sync now,
     quit. Menu APPEARANCE is out of scope (section 8); existence of
     these three actions is normative.

==================================================
3. SYNC TRIGGER SCHEDULE (#14)
==================================================

3.1  TRIGGER CATALOG AND DEFAULTS

     The following defaults are NORMATIVE STARTING VALUES. Every value
     is a user-visible setting (section 3.5); shipped defaults are
     what unconfigured installations use.

     ------------------------------------------------------------
     Trigger            Default behavior
     ------------------------------------------------------------
     Application        Immediate discovery sweep + immediate sync
     startup            attempt with all known trusted peers.

     Foregrounding      Same as startup: immediate discovery + sync
     (main window       attempts. Rationale: user attention is the
     opened/shown)      strongest signal that peers may have moved
                        too (laptop reopened elsewhere).

     Local change       DEBOUNCE: start/restart a timer on every
     (any applied       local write; fire once after the debounce
     local commit)      interval, default 10 seconds after the LAST
                        change (owner-tuned 2026-08-25; was 5 — slightly
                        stronger batching while still feeling instant).
                        On fire, attempt push to all
                        known-available trusted peers. DC-08 batch
                        limits apply unchanged regardless of how
                        many edits coalesced.

     Periodic           Every 10 minutes while background operation
     background sweep   is active (owner-tuned 2026-08-25; was 15 —
                        fresher data at negligible cost: an idle-mesh
                        periodic exchange is two small HELLOs plus any
                        piggyback records, typically under ~2 KB per
                        round): discovery sweep + sync attempt
                        with discovered trusted peers (including
                        previously unknown ones — this is how a
                        peer returning from absence gets found).

     Network change /   Immediate discovery + sync attempt with
     Wi-Fi reconnect    known trusted peers (bounded by backoff,
                        section 5).
     ------------------------------------------------------------

3.2  STARTUP/FOREGROUND TRIGGER DETAIL

     Fires immediately, NOT debounced. Multiple rapid
     foreground events within the debounce window coalesce into one
     sweep (same lock/coalescing rules as section 4).

3.3  CHANGE-TRIGGERED PUSH DETAIL

     The debounce exists purely for batching (Spec §22); it never
     delays durability — changes are committed to SQLite immediately
     and pushed later. Pending changes survive any delay indefinitely
     (Spec §22; INVARIANT 2). If a push attempt fails, pending
     changes remain stored and the peer enters backoff (section 5);
     they are delivered at the next successful opportunity.

     Batching bound inherited from DC-08 §6.1: whatever the debounce
     coalesces still goes out in <=256-record batches.

3.4  NETWORK-CHANGE TRIGGER DETAIL

     OS network-change notifications are best-effort; missed events
     are compensated by the periodic sweep. Rapid flapping is dampened
     by the per-peer-pair session lock and backoff — no additional
     flap-detection mechanism is required.

3.5  SETTINGS

     All three numeric parameters are user-visible settings following
     the owner's established preference pattern from the DC-09
     amendment (settings persist in local configuration, take effect
     live without restart, and revert to defaults when unset):

       sync.debounce_seconds   default 10   bounds [1 .. 300]
       sync.sweep_minutes      default 10   bounds [5 .. 1440]
       sync.max_concurrent_sessions  default 3  bounds [1 .. 10]

     Backoff parameters (section 5) are NOT settings; they are fixed
     algorithm constants.

3.6  PLATFORM NOTE (NON-NORMATIVE FOR WINDOWS v1)

     Windows v1 has no aggressive doze mode; periodic timers fire
     reliably while the process lives. Android/iOS futures WILL need
     OS work-manager/scheduling integration; the trigger catalog
     above sits behind a platform-facing scheduler interface so a
     future platform contract can substitute OS schedulers without
     touching session semantics. This is noted, not decided, here.

==================================================
4. CONCURRENCY RULES
==================================================

4.1  ONE SESSION PER PEER PAIR

     At most ONE active sync session per peer pair at any time. The
     lock is keyed by the REMOTE peer device_id (DC-05 identity, never
     network address — INVARIANT 5).

     A second trigger targeting a peer whose session is active is
     COALESCED into a no-op: the running session already exchanges
     everything both sides need (DC-08 §4 symmetry); anything written
     locally during the session is picked up either in its final
     HELLO-driven ranges or at the next trigger. No queued "second
     session" exists — coalescing is complete, not deferred.

4.2  CROSS-PEER CONCURRENCY BOUND

     Sessions with DIFFERENT peers MAY run concurrently, bounded by
     max_concurrent_sessions (default 3). Excess session attempts
     queue (FIFO) and start when a slot frees. Queued entries are
     re-checked against current availability/backoff at dequeue time;
     stale entries are dropped silently.

4.3  UI NEVER BLOCKS ON SYNC, VICE VERSA

     Local UI operations never wait on any sync activity, and sync
     never waits on UI. Enforced structurally:

     - SQLite runs in WAL mode; readers (UI queries) proceed while
       the writer works (DC-07).
     - ALL writes — UI-originated and sync-applied — serialize through
       ONE async writer task. Producers enqueue; nobody blocks on
       completion except the sync engine awaiting its own ACK-relevant
       commits, and even that await is async, never thread-blocking.
     - Sync engine and UI communicate via channels only; no shared
       locks span the boundary.

==================================================
5. RESOURCE BOUNDS
==================================================

5.1  IDLE CPU

     Between sweeps, with no active sessions and no pending debounce,
     the process performs NO periodic wakeups beyond the configured
     sweep timer. Idle CPU target: approximately 0% (timer + event
     driven; no polling loops anywhere in the design).

5.2  MEMORY CAP OF THE SYNC SUBSYSTEM

     The sync subsystem (queues, buffers, quarantine, per-peer state)
     is subject to the existing unbounded-buffering prohibition
     (DC-08 §6.3) and additionally to an overall soft cap: bounded
     queues with drop-oldest-telemetry policy on overflow, sized so
     the subsystem's steady-state footprint is negligible relative to
     the app. Exact byte values are tuning, not contract; the EXISTENCE
     of the caps is normative and testable (TR-8).

5.3  WAKE REASON LOGGING

     Every scheduler activation logs its reason (startup | foreground
     | debounce | sweep | network | manual). This is diagnostic
     telemetry only; correctness never depends on it.

5.4  NO QUIET HOURS / PAUSE FEATURE

     Deliberately NOT introduced. A user who wants silence disables
     sync (existing setting) — documented behavior, not a new feature.
     Quiet hours would add schedule-state that interacts badly with
     offline convergence expectations for zero v1 value.

==================================================
6. FAILURE BACKOFF
==================================================

6.1  PER-PEER EXPONENTIAL BACKOFF

     A failed connection/session attempt to a peer (unreachable,
     refused, handshake failure) starts exponential backoff for THAT
     peer:

       base delay:      1 minute
       factor:          2 (each consecutive failure doubles)
       maximum delay:   1 hour
       reset:           any SUCCESSFUL session resets to base

     During backoff, automatic triggers skip that peer (manual
     "sync now" bypasses backoff — explicit human intent wins).

     Purpose: an offline phone must not cause busy-looping connection
     attempts every few minutes for hours. With these constants, ten
     consecutive failures stretch attempts past an hour apart.

6.2  STATE LIFETIME

     Backoff state is IN-MEMORY ONLY. Process restart clears it. This
     is acceptable and deliberate: restart also fires the startup
     trigger, which SHOULD get a fresh chance anyway; persistence
     would only add staleness.

==================================================
7. TESTABLE REQUIREMENTS
==================================================

TR-1  CLOSE-TO-TRAY CONTINUES SYNC: integration test with simulated
      peers — make a local edit, close the main window, bring a peer
      online within one sweep period -> the change reaches the peer
      WITHOUT reopening the window; process alive throughout (assert
      via simulated peer observing the incoming session).

TR-2  QUIT IS CLEAN: start a session, invoke quit mid-session ->
      process exits; on next start, local state equals pre-session
      state plus fully-applied-and-ACKed records only; no partial
      batch committed; SQLite opens cleanly with zero recovery errors
      (extends DC-08 §4 abort property to process teardown).

TR-3  DEBOUNCE BATCHING: perform N>=10 edits within one debounce
      window -> EXACTLY ONE outgoing session to each available peer,
      carrying all N changes (respecting DC-08 batch limits); zero
      additional sessions until the next independent trigger.

TR-4  PERIODIC SWEEP TIMELINESS: with only the sweep armed, sweeps
      fire within configured_sweep_minutes +/- 5% tolerance over a
      multi-hour soak; zero sweeps occur when background operation is
      inactive (process quit) — trivially true, asserted negatively
      via the harness.

TR-5  PER-PEER LOCK UNDER RACING TRIGGERS: fire debounce expiry,
      sweep tick, and manual sync simultaneously toward one peer ->
      exactly ONE session observed on the wire; other triggers
      coalesce with no error surfaced to UI; post-session state
      identical to single-trigger case.

TR-6  CROSS-PEER PARALLELISM BOUND: with max_concurrent_sessions=2,
      trigger pushes to 4 available peers -> at most 2 concurrent
      sessions at any instant (wire-observed), remaining 2 queued and
      completed afterward; total sessions eventually = 4.

TR-7  BACKOFF GROWTH AND RESET: simulate repeated unreachable peer ->
      attempt gaps follow 1m, 2m, 4m ... capped at 1h (tolerance for
      scheduler jitter); one successful session resets the next gap
      to base; backoff skips automatic triggers but manual sync still
      attempts immediately.

TR-8  RESOURCE CAPS HOLD: instrumented soak shows idle CPU ~0%
      between events (no wakeups besides sweep timer); sync-subsystem
      allocations stay under the configured soft cap under a
      flood-of-changes workload, with overflow handled per section
      5.2 rather than growing unboundedly (DC-08 §6.3 extended).

TR-9  LIVE SETTINGS EFFECT: change sync.debounce_seconds /
      sync.sweep_minutes / sync.max_concurrent_sessions at runtime ->
      subsequent behavior uses new values with NO restart; bounds are
      enforced (out-of-range input rejected/clamped); reverting to
      unset restores defaults.

TR-10 CONFIGURED INTERVALS RESPECTED: parameterized test sweeping
      the legal bounds of each setting asserts observed inter-event
      timing matches the configured value within tolerance — no code
      path hardcodes a constant that bypasses settings.

==================================================
8. OUT OF SCOPE
==================================================

- Tray icon and settings UI appearance/layout -> DC-19 (tray icon/context
  menu contract)
  only the EXISTENCE of the tray actions and the settings listed in
  section 3.5 is contractual here.
- mDNS discovery mechanics and discovery lifecycle internals ->
  discovery/network-layer contract (separate); this contract consumes
  its "peers found / lost" events only.
- Android/iOS platform specifics including OS work-manager
  integration -> future platform contracts (noted in section 3.6,
  decided nowhere here).
- Power-management interactions with the OS beyond the section 3.6
  observation -> future platform contracts.
- Anything inside a session: message flow, batching limits, full-state
  thresholds -> DC-08 / DC-09 entirely.
- Conflict resolution, storage schema, identity/pairing -> DC-03/#12,
  DC-07, DC-05 respectively.

==================================================
9. OPEN ITEMS OWNED ELSEWHERE
==================================================

- Discovery event delivery mechanism to the scheduler -> discovery
  lifecycle contract.
- Exact memory-cap byte values and queue depths -> tuning, owned by
  implementation, bounded by TR-8.
- Mobile scheduler substitution behind the platform interface ->
  future mobile platform contract.
