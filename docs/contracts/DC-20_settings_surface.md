# TIDE DESIGN CONTRACT DC-20
# Options Window — Settings Surface
Status: APPROVED by project owner (2026-08-31, D1-D7 all decided).
Depends on: Architecture Spec v0.3 §30 (INV 13); DC-09 (owner amendment:
        MAX_INCREMENTAL_BACKLOG user-adjustable); DC-13 §3.5 (scheduler
        settings + bounds); DC-19 (tray menu; D1 amended 2026-08-31 —
        options window reachable ONLY from tray, never calendar UI)
Unblocks: options window implementation; settings persistence; live/
        restart change semantics; growth path for future settings
        categories
Resolves: DC-19 §6.1/§6.2 settings-surface deferral (superseded — the
        surface is now a dedicated options window, per owner)

==================================================
1. PURPOSE AND SCOPE
==================================================

Defines the dedicated OPTIONS WINDOW: its architecture, layout, which
settings it exposes (v1 inventory), how values persist, and how changes
take effect.

Owner decisions encoded (2026-08-31):
- Clicking "Options…" in the TRAY menu opens a dedicated, separate
  options window.
- The options window is NOT reachable from the Tide calendar UI — no
  toolbar button, no menu entry in the calendar webview. Tray menu only.
- Layout is Outlook-style: persistent LEFT NAVIGATION PANE (category
  entries) + right CONTENT pane, designed for growth — settings are
  expected to become plentiful; new categories slot into the left pane
  without redesign.

IN SCOPE (v1): options window architecture + lifecycle, Outlook-style
layout, the §3 setting inventory, persistence (§5), change semantics
(§6).

OUT OF SCOPE: any settings entry point in the calendar UI (D9); Windows;
encryption settings (DC-17); .ics settings; a general preferences
framework beyond the §3 inventory (INV 13 — new settings need contract
basis or a DC-20 amendment).

==================================================
2. WINDOW ARCHITECTURE
==================================================

2.1  SEPARATE WINDOW, not a dialog in the calendar webview. Tauri 2
     multi-window: a second WebviewWindow ("options") with its own
     HTML/TS entry, independent of the calendar window's lifecycle
     (opening/closing options never touches the calendar view state).

2.2  REACHABILITY: exclusively the tray menu "Options…" item (DC-19 D2).
     The calendar webview has no button, link, or menu path to it. If a
     user closes the options window, the tray item reopens it.

2.3  LIFECYCLE: at most ONE options window instance; repeated "Options…"
     clicks focus the existing instance. Closing it never quits the app
     and never touches the sidecar.

2.4  Implementation shape (non-binding, recommended): a second HTML
     entry (options.html + options.ts) built alongside index.html — the
     existing ui:build pipeline already bundles multiple entries; the
     window is created by the Rust shell on demand (tauri
     WebviewWindowBuilder) or pre-created hidden at setup. Either is
     conformant; the builder-on-demand path avoids an extra always-
     resident webview.

==================================================
3. LAYOUT — OUTLOOK STYLE
==================================================

3.1  Two panes: LEFT = navigation pane (vertical list of category
     entries; the active one highlighted); RIGHT = content pane showing
     the active category's settings. The left pane is PERSISTENT — it
     never collapses; selecting an entry swaps only the right pane.

3.2  v1 categories (left pane, top to bottom):
       a) "General" — future home for display/locale preferences
          (placeholders acceptable; may be empty-with-note in v1)
       b) "Sync" — the §3 inventory settings
     Categories with no settings yet SHOULD still appear (with an
     explanatory empty note) so the navigation model is visible from
     day one and never needs restructuring.

3.3  The window is resizable with sane minimum dimensions; the left
     pane has a fixed reasonable width; the right pane scrolls
     independently if content exceeds it.

==================================================
4. OPTIONS WINDOW BEHAVIOR
==================================================

4.1  Values are loaded fresh from persistence (§5) each time the window
     opens — no stale cache across open/close cycles.

4.2  Editing model: fields are editable in place; a single "Save"
     action commits ALL changed fields in one atomic write (validate →
     clamp → persist → apply per §6). "Cancel"/window-close discards
     uncommitted edits. Explicit per-field commit buttons are NOT used
     (mixed-commit state is a known UX trap).

4.3  VALIDATION: every field is clamped/validated against its contract
     bounds (DC-13 §3.5, DC-09) at Save; out-of-range input shows an
     inline error naming the bound — Save refuses until clean. No
     native popups (WebKit chrome ban).

4.4  UNSAVED-CHANGES GUARD: closing the window or switching categories
     with uncommitted edits asks in-window ("Discard changes?") — a
     custom in-window prompt, never a native dialog.

==================================================
5. SETTING INVENTORY (v1) — contract-grounded only
==================================================

All four live in the "Sync" category (§3.2b):

S1  sync_debounce_seconds    (DC-13 §3.5)  default 10   bounds [5, 120]
S2  sweep_interval_minutes   (DC-13 §3.5)  default 10   bounds per DC-13
S3  max_concurrent_sessions  (DC-13 §3.5)  default 3    bounds [1, 5]
S4  max_incremental_backlog  (DC-09 amd.)  default 1000 bounds
                                             [100, 100000]

EXCLUDED (no contract basis — INV 13): sync listen port (launch-time
env var, DC-15 §3.2 precedence chain — not a running-app toggle);
device display naming; anything DC-17. New settings require contract
basis or a DC-20 amendment; the left-pane category model (§3.2) is the
growth path.

==================================================
6. PERSISTENCE
==================================================

6.1  config.toml per DC-15 §3.2: $XDG_CONFIG_HOME/tide/config.toml,
     "ONLY non-secret settings", precedence chain env var > config.toml
     > built-in default. All four settings are non-secret.

6.2  TOML keys named after §5 S1-S4; unknown keys ignored on load;
     malformed file → log + built-in defaults (fail-open, never
     fail-start).

6.3  Secrets NEVER in config.toml (DC-15 §3.2 standing constraint).

6.4  The settings file is read by BOTH processes that need values: the
     sidecar (scheduler runtime + full-state triggers) and the options
     window (display). Rust shell may cache for menu labels; cache
     invalidates on Save.

==================================================
7. CHANGE SEMANTICS — PER SETTING
==================================================

The deciding factor is the READ SITE of each value.

7.1  S1-S3 (scheduler settings): LIVE-APPLY. The pure Scheduler exposes
     updateSettings(partial) with clamping (verified in source); the
     scheduler runtime owns the timers, and a settings change rebuilds
     the sweep interval timer + lets subsequent decision passes use the
     new values (runtime restart-on-change: stop() → apply → start();
     sub-second; in-flight sessions complete; concurrency bookkeeping
     stays consistent via beginSession/endSession).

7.2  S4 (max_incremental_backlog): RESTART-REQUIRED for v1. Read site:
     full_state_triggers consumes a module-level constant chain; there
     is no mutable injection point today. Making it live means threading
     a mutable settings source through the sync decision path — out of
     proportion for a knob with no tuning history. The options window
     labels it "(takes effect at next start)". A future amendment can
     promote it to live-apply.

7.3  Save order (§4.2): validate ALL fields → clamp → persist ALL to
     config.toml atomically → apply live where applicable (S1-S3) →
     surface "takes effect at next start" for S4. A crash between
     persist and apply leaves the persisted value for next start — a
     change is never lost, and there is never a half-applied state.

7.4  GENERAL RULE: live-apply iff the read site consumes a mutable/
     injectable source; otherwise restart-scoped. Future settings must
     state their semantics in their contract basis.

==================================================
8. DECISIONS
==================================================

D1 (DECIDED, owner 2026-08-31): Dedicated options WINDOW, Outlook-style
    (left nav pane + right content), reachable ONLY from the tray menu.
    Never from the calendar UI. (DC-19 D1 amended accordingly; D9
    records the window decision.)
D2 (DECIDED, owner 2026-08-31): v1 categories = General + Sync (§3.2);
    empty categories visible with a note so the navigation model is
    stable. New categories = DC-20 amendment.
D3 (DECIDED, owner 2026-08-31): v1 inventory = S1-S4 only (§5); all in
    the Sync category. New settings need contract basis or amendment
    (INV 13).
D4 (DECIDED, owner 2026-08-31): Save-all atomic commit per §4.2. One
    Save validates/clamps/persists/applies every changed field; per-field
    commit rejected (mixed-commit-state trap).
D5 (DECIDED, owner 2026-08-31): S4 restart-required for v1 per §7.2. The
    label reads "(takes effect at next start)". Promotion to live-apply
    is a future amendment if a tuning need appears.
D6 (DECIDED, owner 2026-08-31): Persistence = config.toml per §6 (DC-15
    §3.2 precedence chain). A DC-07 settings table rejected — machine-
    local preferences do not belong in calendar domain data.
D7 (DECIDED, owner 2026-08-31): Window created ON DEMAND via
    WebviewWindowBuilder (§2.4). NOT pre-created at startup: a hidden
    WebKitGTK webview costs ~30-60 MB RSS permanently (~25-40% of the
    app's footprint) to save a sub-second load on a window opened a few
    times a year — unacceptable footprint bloat (owner: "I hate such
    apps"). Resource-lean lifecycle is a design goal; revisit only if
    real-world open latency is ever complained about.
