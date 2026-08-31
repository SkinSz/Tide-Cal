# TIDE DESIGN CONTRACT DC-20
# Settings Surface — Tray Submenu
Status: DRAFT — awaiting owner approval (drafted 2026-08-31).
Depends on: Architecture Spec v0.3 §30 (INV 13); DC-09 (owner amendment:
        MAX_INCREMENTAL_BACKLOG user-adjustable); DC-13 §3.5 (scheduler
        settings + bounds); DC-19 §6 (tray context menu is the ONLY
        configuration surface; D1 forbids an app-UI settings button)
Unblocks: tray Settings submenu implementation; live/restart change
        semantics; persistence of user-tuned scheduler/backlog values
Resolves: DC-19 §6.1's no-settings-v1 recommendation (superseded by this
        contract's concrete design) and DC-19 §6.2's reserved submenu slot

==================================================
1. PURPOSE AND SCOPE
==================================================

Defines WHICH settings are user-configurable, WHERE they live (tray
submenu per DC-19 §6.2), HOW a changed value takes effect (change
semantics), and WHERE values persist.

IN SCOPE (v1): the settings inventory of §3; their persistence (§5);
their change semantics (§6); the tray submenu surface (§4).

OUT OF SCOPE: any settings dialog in the app UI (DC-19 D1 — forbidden);
Windows; encryption settings (DC-17); .ics settings; sync listen port
(stays an environment/launch concern — DC-15 §3.2 precedence chain —
NOT a menu item; changing a listen port is a launch-time concern, not a
running-app toggle); device display naming (no approved contract basis;
INVARIANT 13).

==================================================
2. INVENTORY — VERIFIED AGAINST SOURCE
==================================================

Every candidate needs an approved-contract basis (INV 13). Four qualify:

S1  sync_debounce_seconds        (DC-13 §3.5)
    default 10 · bounds [5, 120] · clamped by Scheduler.updateSettings
S2  sweep_interval_minutes       (DC-13 §3.5)
    default 10 · bounds per DC-13 §3.5 · clamped
S3  max_concurrent_sessions      (DC-13 §3.5)
    default 3 · bounds [1, 5] · clamped
S4  max_incremental_backlog      (DC-09 owner amendment)
    default 1000 · bounds [100, 100000] · clamped by
    full_state_triggers clampMaxIncrementalBacklog
    read site: src/sync/full_state_triggers.ts Trigger C (§3.3)

EXCLUDED (no contract basis today — INV 13):
- sync listen port (TIDE_SYNC_PORT is a launch-time env var; DC-15 §3.2
  precedence chain already covers it)
- device display name
- anything DC-17 (encryption) — that contract is BACKLOGGED

==================================================
3. SURFACE — TRAY SUBMENU (DC-19 §6.2)
==================================================

3.1  A single "Settings" submenu of the tray context menu, after the
     functional items and before Quit:

     Open Tide
     Sync now
     ─────────
     Settings ▸   (submenu below)
     Quit

3.2  Submenu items — ONE PER SETTING. libappindicator menu items are
     click-to-act labels (no inline text fields), so each item either:
       (a) CYCLES through preset values on click (fine-grained bounds
           make cycling impractical for S4 — see (b)), or
       (b) steps the value up/down on left/right click via paired
           items: "Backlog limit: 1000 ▲ / ▼" stepping by the bound's
           natural increment (S4: ×10 steps within [100, 100000]).
     RECOMMENDATION: (b) paired step items for S4; (a) cycling or paired
     steps for S1-S3 (their ranges are small). Every change is clamped
     to the DC-13/DC-09 bounds BEFORE persisting (invalid values are
     impossible by construction).

3.3  Each item's label ALWAYS shows the current effective value — the
     menu is also the read surface (no separate "view settings").

3.4  The submenu is built by the Rust shell (same layer as the tray
     itself). Values live in persistence (§5); the Rust shell reads them
     at menu build and after each change.

==================================================
4. CHANGE SEMANTICS — PER SETTING (the core question)
==================================================

The fair question: live-apply vs restart-required. The deciding factor
is the READ SITE of each value.

4.1  S1-S3 (scheduler settings): LIVE-APPLY is natural and cheap.
     - The pure Scheduler already exposes updateSettings(partial) with
       clamping (verified: src/application/scheduler.ts).
     - The runtime wrapper (scheduler_runtime.ts) owns the timers:
       a debounce/sweep/concurrency change requires rebuilding the
       sweep interval timer and letting the next decision pass use the
       new values. Runtime restart (stop() → start()) is the smallest
       correct mechanism — sub-second, no data risk, no session in
       flight is aborted (in-flight sessions complete; the runtime's
       beginSession/endSession bookkeeping keeps the count consistent).
     - RECOMMENDATION: LIVE-APPLY via runtime restart-on-change. The
       user experience is "it just took effect"; no app restart needed.

4.2  S4 (max_incremental_backlog): RESTART-REQUIRED for v1.
     - Read site: full_state_triggers reads a module-level constant
       chain (DEFAULT/MIN/MAX + clamp) at decision time; there is no
       mutable injection point today.
     - Making it live would mean threading a mutable settings source
       through the trigger layer — a real code change in the sync
       decision path, out of proportion for a knob nobody has needed
       to turn yet.
     - RECOMMENDATION: v1 = persist the value; it takes effect at next
       app start. The menu item label notes "(next start)". A future
       amendment can promote it to live-apply when a consumer exists.

4.3  GENERAL RULE (v1): a setting is live-apply iff its read site
     already consumes a mutable/injectable source (S1-S3 via the
     runtime); otherwise it is restart-scoped (S4). No hybrid
     half-applied states: a changed value is persisted FIRST (§5),
     then applied (live) or marked pending-restart.

4.4  CRASH SAFETY: persistence (§5) happens inside the change action
     before any apply step; a crash between persist and apply leaves a
     persisted value that the next start picks up — never a lost
     change, never a corrupt half-state.

==================================================
5. PERSISTENCE
==================================================

5.1  RECOMMENDATION: config file, NOT the SQLite DB.
     DC-15 §3.2 already reserves $XDG_CONFIG_HOME/tide/config.toml for
     "ONLY non-secret settings" with an explicit precedence chain
     (env var > config.toml > built-in default). All four settings are
     non-secret, and DC-15's layout exists precisely for this. A
     settings table would need an additive DC-07 migration for values
     that are NOT calendar domain data — the wrong home.

5.2  Precedence per DC-15 §3.2: TIDE_* env var > config.toml > built-in
     default. The menu reads the EFFECTIVE value (after precedence) and
     writes to config.toml. An env var override naturally wins and the
     menu shows it.

5.3  Format: TOML keys mirroring the S1-S4 names, unknown keys ignored
     on load (forward-compatible), malformed file → log + all defaults
     (fail-open, never fail-start).

5.4  Secrets NEVER in config.toml (DC-15 §3.2) — none of S1-S4 are
     secrets; this is a standing constraint for any future setting.

==================================================
6. DECISIONS
==================================================

D1 (DECIDED): Inventory v1 = S1-S4 only (§2). Everything without an
    approved contract basis is OUT (INV 13).
D2 (OPEN, owner): Accept the inventory? (recommendation: yes)
D3 (OPEN, owner): Surface = paired step/cycle menu items per §3.2, one
    per setting, labels always showing the effective value.
    (recommendation: yes)
D4 (OPEN, owner): S1-S3 LIVE-APPLY via scheduler-runtime restart-on-
    change; S4 RESTART-REQUIRED for v1 (§4).
    (recommendation: adopt as written)
D5 (OPEN, owner): Persistence = config.toml per DC-15 §3.2 precedence
    chain; TOML, fail-open, env-var-wins (§5).
    (recommendation: adopt as written)
D6 (OPEN, owner): The tray Settings submenu is built and owned by the
    Rust shell (§3.4) — same layer as the tray itself.
    (recommendation: yes)
D7 (OPEN, owner): Timing — implement DC-20 with the next GUI package, or
    defer until a real tuning need appears? DC-19 §6.1's original
    stance (defaults suffice for v1) remains defensible.
    (recommendation: defer implementation until an actual tuning need;
    keep the contract APPROVED so the design is settled)
