# TIDE DESIGN CONTRACT DC-19
# Tray Icon and Context Menu (Linux First)
Status: APPROVED by project owner (2026-08-31, D1-D7 decided; D8 is a
        non-blocking implementation detail).
        Owner directive this contract encodes: NO options/settings button in
        the app UI; the tray icon's right-click context menu IS the v1
        settings/configuration surface.
Depends on: Architecture Spec v0.3 §4 (background/tray operation), §1
        (Linux first); DC-13 §3-§7 (scheduler actions, settings bounds);
        DC-08 §5 (sync_now semantics); DC-15 §3 (data layout, packaging
        constraints)
Unblocks: DC-13 runtime wrapper implementation (the scheduler consumer);
        Linux background/tray component; release build with background sync
Resolves: DC-13 §8 deferred item "Tray icon and settings UI
        appearance/layout"

==================================================
1. PURPOSE AND SCOPE
==================================================

Defines the tray icon's presence, states, context-menu catalog, and the
exact semantics of every menu action on Linux (KDE Plasma / GNOME via the
StatusNotifier/AppIndicator protocols). It is the contract the DC-13
runtime wrapper implements against.

IN SCOPE (v1): tray icon + states, right-click context menu, show/hide
window, manual sync-now trigger, quit semantics, minimal v1 settings
submenu (§6).

OUT OF SCOPE (v1): Windows tray (DC-15 §4), notifications/toasts (any OS),
a full settings dialog, CalDAV, auto-start-on-login management, icon
theme animation.

==================================================
2. TRAY PRESENCE AND LIFECYCLE
==================================================

2.1  The tray icon exists whenever the Tide process is running (DC-13 §5:
     background operation is the normal state; closing the main window
     hides it, the process and sidecar stay alive).

2.2  Closing the main window (X button) HIDES the window. It MUST NOT quit
     the process and MUST NOT terminate the sidecar. Quit is exclusively a
     menu action (§4.4).

2.3  If the tray icon is not available (compositor without
     StatusNotifier support), Tide degrades to a normal windowed app:
     closing the window hides it to the taskbar, and a menu entry is added
     in-app (see §4.6). The app MUST NOT become unreachable.

==================================================
3. TRAY ICON STATES
==================================================

3.1  IDLE (default icon): no session activity.

3.2  SYNCING (alternate icon or overlay badge): at least one engine
     session is in flight. Source of truth: the sidecar's session stats
     (sync_op surface); the Rust shell polls or is notified — the polling
     mechanism is an implementation detail, not contract.

3.3  ERROR-PRESENT marker (owner decision 2026-08-31): the tray icon state
     showing "attention needed" is DEFERRED to a technical-debt follow-up
     (TD-010), NOT part of v1. v1 tray states are IDLE and SYNCING only.
     When implemented, "attention needed" means at least one of:
       - quarantine rows exist that are NOT resolved (active
         quarantine/peer-invalid state — the Sync-Errors dialog's domain),
       - unresolved conflict rows exist (the Conflicts dialog's domain).
     Source of truth: quarantine_stats + list_conflicts counters via the
     existing sync_op RPC (quarantine_stats, list_conflicts). The tray
     MUST NOT duplicate dialog detail — the marker is boolean, and
     "Open Tide" is how the user reaches the dialogs that explain it. The
     marker clears when both underlying counts reach zero.

3.4  Icon assets ship in the Tauri bundle (DC-15 §3 data layout does not
     apply — icons are program files, not user data).

==================================================
4. CONTEXT MENU CATALOG
==================================================

Right-click opens the menu. Items, in order:

4.1  "Open Tide" — shows and focuses the main window (un-hide from §2.2).
     If already visible: focus/raise. This item is ALWAYS enabled.

4.2  "Sync now" — triggers an immediate sync pass:
     - semantics: DC-13 scheduler action immediate-sync with
       manualSyncBypassesBackoff = true (explicit human intent wins per
       DC-13 §6.1); routes through the existing sync_now RPC op — no new
       Rust DB access.
     - MUST be disabled (greyed) while a session is already in flight for
       the same peer set, or when no peers are paired. Tooltip/state text
       is presentation detail.
     - Triggering it does NOT open the window.

4.3  (REMOVED v1 by owner decision, 2026-08-31): no "Sync Errors" menu
     item. Error surfacing is the TRAY ICON STATE instead (§3.3): the icon
     shows an ERROR-PRESENT marker when attention is needed (quarantined
     records and/or unresolved conflicts), and clicking the item that opens
     the window is how the user reaches the Sync-Errors/Conflicts dialogs
     that own the detail. Rationale: the menu item's only value was saving
     one click, while the icon state gives passive visibility without
     opening anything.

4.4  "Quit" — full application exit:
     - closes the main window,
     - shuts the sidecar down cleanly (stdin EOF path; the sidecar's own
       closeListener + exit semantics per tests/sidecar_eof_lifecycle.test.ts
       MUST be preserved — Quit MUST NOT SIGKILL),
     - then exits the process.
     - Quit MUST ask nothing (no confirm dialog); unsaved UI state does
       not exist (all writes are immediate through the domain core).

4.5  Separator rules: at most one separator between the functional group
     (4.1-4.3) and Quit. No nested menus beyond §6's optional submenu.

4.6  Fallback menu (§2.3): when no tray is available, the SAME items
     except Quit appear in an in-app overflow location (toolbar overflow
     or app menu); Quit remains available via window close + a small
     in-app Quit entry there. v1 MAY simplify to "window close quits" in
     this fallback mode ONLY, because without a tray the hide-to-tray
     lifecycle is meaningless — this fallback quit MUST still do §4.4's
     clean sidecar shutdown.

==================================================
5. LINUX PLATFORM NOTES (NORMATIVE FOR v1)
==================================================

5.1  KDE Plasma (owner's desktop) exposes tray icons via the
     StatusNotifierItem/AppIndicator protocol. Tauri 2's tray support maps
     onto libappindicator on Linux; the `tray-icon` Cargo feature MUST be
     enabled and libappindicator dev packages are a build dependency
     (packaging: DC-15 §4.1 dependency list).

5.2  GNOME without appindicator extension shows NO tray icon — §2.3's
     fallback applies. This is acceptable for v1.

5.3  Left-click behavior on Linux is NOT reliably distinguishable from
     right-click under AppIndicator; the menu is the ONLY guaranteed
     interaction. Left-click-opens-window is a best-effort nicety, never a
     contract item.

5.4  Wayland (owner's session): no global-coordinate APIs are used by this
     contract; the tray is compositor-managed. Window focus/raise after
     "Open Tide" is best-effort under Wayland.

==================================================
6. SETTINGS SUBMENU — RECOMMENDATION (v1: NONE)
==================================================

6.1  (SUPERSEDED by DC-20, drafted 2026-08-31): v1 originally shipped no
     settings submenu (rationale preserved below for history). DC-20 now
     defines a concrete bounded Settings submenu — four contract-grounded
     settings, change semantics, and persistence — superseding this
     recommendation once approved. Original rationale: the only
     user-adjustable values (DC-09 MAX_INCREMENTAL_BACKLOG 100..100000;
     DC-13 §3.5 scheduler intervals) have safe defaults tuned by the owner
     (DC-09 amendment; DC-13 §3.5). A settings surface before the runtime
     wrapper exists would be UI for values nobody changes.

6.2  (SUPERSEDED by DC-20, drafted 2026-08-31): settings enter as a
     DEDICATED OPTIONS WINDOW (Outlook-style: left navigation pane +
     right content), reachable ONLY from the tray menu "Options…" item —
     never a free-form dialog inside the calendar webview, never a
     toolbar button. The app-UI settings button remains FORBIDDEN by
     owner directive (D1).
     -> DC-20 IS that amendment (drafted; pending owner approval).

==================================================
7. OUT OF SCOPE
==================================================

- Windows tray behavior (DC-15 §4 WIP)
- Notifications, toasts, badges on the taskbar
- Settings dialog (the context menu submenu of §6 is the ceiling)
- Auto-start-on-login management (OS feature, not app feature)
- Detailed sync-state display (Sync-Errors dialog owns it)

==================================================
8. DECISIONS
==================================================

D1 (AMENDED, owner 2026-08-31): No options/settings button in the MAIN
    calendar UI (toolbar). A dedicated Options WINDOW, reachable ONLY
    from the tray context menu ("Options…" item), is the configuration
    surface — see DC-20. The prohibition targets cluttering the calendar
    toolbar; it does not forbid a separate settings window.
D2 (AMENDED, owner 2026-08-31): Menu catalog = Open Tide, Sync now,
    Options…, Quit — order per §4. ("Sync Errors" omitted per D6.)
    "Options…" opens the DC-20 options window.
D3 (DECIDED): Window close hides to tray; Quit is menu-only (§4.4) and
    performs a clean sidecar stdin-EOF shutdown.
D4 (DECIDED): "Sync now" routes through the existing sync_now RPC with
    manualSyncBypassesBackoff = true; disabled while a session is in
    flight or no peers are paired.
D5 (SUPERSEDED by DC-20): tray-submenu stepping replaced by the DC-20
    dedicated options window (Outlook-style: left navigation pane +
    right content). Still true: no settings entry in the calendar
    toolbar.
D6 (DECIDED, owner 2026-08-31): NO "Sync Errors" menu item in v1 (§4.3).
    Error surfacing deferred to TD-010 (tray ERROR-PRESENT marker).
D7 (DECIDED, owner 2026-08-31): v1 tray states = IDLE + SYNCING only. The
    ERROR-PRESENT marker (§3.3) is deferred to TD-010.
D9 (DECIDED, owner 2026-08-31): The options window is a SEPARATE window
    (not a dialog inside the calendar webview), NOT reachable from the
    calendar UI — tray menu only. Layout is Outlook-style: persistent
    left navigation pane (category tabs) + right content pane, sized for
    growth as settings accumulate.
D8 (OPEN, implementation detail, non-blocking): polling cadence for the
    SYNCING state (§3.2).
