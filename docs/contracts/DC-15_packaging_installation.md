# TIDE DESIGN CONTRACT DC-15
# Packaging, Installation, and Data Layout (Linux / Windows)
Status: APPROVED by project owner (2026-08-27).
        §4 Windows section is WIP by design (Windows port of Tide
        itself is deferred — see §5.3); its §4.1 portability
        constraints are approved, §4.2 open items are not.
Depends on: Architecture Spec v0.3 §1 (platform scope), §4, §5, §30;
            DC-05 (device identity, key custody); DC-07 (SQLite schema,
            encryption-at-rest decision); DC-13 (background/tray process)
Unblocks: First distributable Linux build; release engineering;
          upgrade/uninstall data-safety guarantees
Resolves: deferred packaging/distribution decisions from Spec §30

==================================================
1. PURPOSE
==================================================

Decides the minimum binding facts for turning the working Tauri 2
application into an installable, upgradable, cleanly uninstallable
product:

  - which artifact formats we ship per platform,
  - WHERE durable data lives (database, identity keys, data dir) and
    which paths are fixed vs. user-overridable,
  - what install/upgrade/uninstall may and may NEVER touch,
  - how the sidecar (Node domain-core over stdio) is delivered,
  - how TIDE_DB_PATH / TIDE_DATA_DIR overrides interact with installs.

Non-goals: auto-update channels, code-signing procurement, store
distribution (Flathub/MSIX), CI pipeline design. These are noted as
future extensions where relevant.

==================================================
2. FROZEN CONSTRAINTS THIS CONTRACT IMPLEMENTS
==================================================

  - Spec §1: Linux is the first target platform; Windows port is
    planned but not started (owner decision 2026-08-27).
  - DC-05: device identity key lives in the OS keystore (same custody
    as the DB key per the 2026-08-25 encryption decision); NEVER
    backed up, never included in any uninstaller's "remove all data"
    default path without explicit warning.
  - DC-07 + owner decision 2026-08-25: calendar database encrypted
    at rest (SQLCipher-style AES-256 page encryption); DB key in OS
    keystore. The installer must not undermine this (no world-readable
    key files, no plaintext key in config).
  - DC-13: background/tray component runs without the main window;
    packaging must install whatever that component needs (autostart
    entry optional, off by default).
  - Owner standing rule: no cron/relay notification side channels — the
    installer ships the app only, no helper daemons beyond what DC-13
    specifies.

==================================================
3. LINUX (primary target — FULL SPEC)
==================================================

3.1 Artifact formats (binding)
  - PRIMARY: native package via Tauri 2 bundler:
      * .deb (Debian/Ubuntu/Mint/pop!_os family) — ships for every
        release.
      * .rpm (Fedora/Nobara/openSUSE family) — ships for every release
        (owner runs Fedora-family: Nobara).
  - SECONDARY (optional, later): AppImage for distros without either;
    Flatpak deferred (sandboxing complicates mDNS discovery DC-11 and
    keystone/keyring access; revisit only on user demand).
  - NOT shipped: bare tarballs (no uninstall story), snap (no demand).

3.2 Filesystem layout (binding)
  App binaries/resources:
    - /usr/bin/tide (or /usr/lib/tide/ + launcher symlink; follow
      whatever the Tauri deb/rpm template produces — bundle layout is
      NOT hand-maintained).
    - Icons/.desktop entry: /usr/share/applications/tide.desktop,
      /usr/share/icons/hicolor/... (bundler-managed).
  Durable user data (XDG Base Directory spec, binding):
    - Database + data dir default:
        $XDG_DATA_HOME/tide/  (~/.local/share/tide/)
      containing: calendar.db (+ -wal/-shm), quarantine/sync
      bookkeeping if file-backed, logs/ (rotated, size-capped).
    - Config default:
        $XDG_CONFIG_HOME/tide/  (~/.config/tide/config.toml)
      containing ONLY non-secret settings. Secrets NEVER here.
    - Identity + DB keys: system keystore via the Tauri keyring
      (Secret Service / kwallet through the OS keyring API used by
      DC-05). Never written as files by the app. If a headless
      fallback file is ever required, it MUST be 0600 and live under
      $XDG_DATA_HOME/tide/keys/ — decision deferred until actually
      needed (NOT approved as-is; requires owner sign-off then).
  Runtime/cache:
    - $XDG_CACHE_HOME/tide/ (~/.cache/tide/) for anything disposable.

3.3 Environment overrides (binding)
  - TIDE_DB_PATH and TIDE_DATA_DIR remain supported (existing sidecar
    contract and E2E tests depend on them). Precedence:
      env var > config.toml > XDG default.
  - Installer/setc does NOT set these; they are power-user/test hooks.
    Document them in README, not in the GUI.

3.4 Sidecar delivery (binding)
  - The Node sidecar is NOT a system Node dependency. It ships INSIDE
    the bundle as a Tauri sidecar binary (compiled/bundled executable
    in the app's resource dir; Tauri shell-spawns it over stdio per
    Spec §4/DC-05 transport).
  - No global npm install, no PATH requirement, no system-wide Node.
    Rationale: version-lock the domain core to the shell; a system
    Node upgrade must never break or change sync semantics.

3.5 Install / upgrade / uninstall rules (binding)
  - INSTALL: package scripts must not require network access; must
    not create anything outside the paths in 3.2.
  - UPGRADE: must be a plain package upgrade. Database schema
    migrations run in-app at sidecar startup (existing mechanism);
    the package post-upgrade script does NOT touch user data.
    TD-003 (legacy dev-* identity migration) must be resolved before
    any upgrade ships to real users with pre-unification databases.
  - UNINSTALL: package removal removes ONLY /usr/bin + /usr/share
    resources. User data ($XDG_DATA_HOME/tide, config, keystore
    entries) is NEVER removed by default. An optional documented
    manual purge command may exist; it must print an explicit warning
    that deleting keystore identity keys permanently orphans the
    device's sync history (DC-05).
  - UNINSTALL NOTIFICATION (owner requirement, binding): the user
    MUST be informed of the data-retention behavior at both ends:
      * BEFORE uninstall runs: the uninstaller (package remove script,
        or the app's own uninstall entry point on platforms that have
        one) attempts a visible desktop notification (notify-send or
        the desktop's equivalent; fall back to a terminal message)
        stating: user data and device identity are KEPT, where they
        live, and that the calendar database is encrypted and only
        readable with this device's keystore keys.
      * AFTER uninstall completes: the package post-remove script
        attempts a second desktop notification confirming what was
        removed (program files only) and what was kept (data, config,
        identity); additionally it drops
        $XDG_DATA_HOME/tide/UNINSTALLED_NOTICE.txt with the same
        content so the information persists even if no notification
        daemon was running.
    Notifications are best-effort (a headless system may have no
    notification service); the notice file is the guaranteed channel.
    Both mechanisms contain NO telemetry and make NO network calls.
  - OPTIONAL "REMOVE EVERYTHING" (owner requirement, binding): the
    uninstaller offers an explicit opt-in action labeled
    "Remove everything" that deletes ALL user data in addition to the
    program. Rules:
      * OPT-IN ONLY. Default action (plain uninstall / Next-through)
        NEVER removes user data, config, or keystore entries — D5's
        retention guarantee applies unless the user actively chooses
        this option.
      * What it removes (complete list, all platforms):
          - $XDG_DATA_HOME/tide/ (database incl. -wal/-shm, keys
            fallback dir if ever present, logs, notices);
          - $XDG_CONFIG_HOME/tide/ (config.toml);
          - $XDG_CACHE_HOME/tide/;
          - keystore entries belonging to Tide (device identity key,
            DB encryption key) via the OS keyring API — never by
            raw file/path guessing.
        Windows counterpart (§4.1 semantics): %APPDATA%\tide,
        %LOCALAPPDATA%\tide, Credential Manager entries.
      * DESTRUCTIVE-ACTION SAFEGUARDS (mandatory):
          - explicit typed or checkbox confirmation (no single-click);
          - a warning that this permanently deletes the encrypted
            calendar database, that keystore identity keys are
            unrecoverable, and that the device's sync history /
            pairings on OTHER devices will reference a dead device;
          - the warning text matches the BEFORE-uninstall notification
            wording family (same facts, destructive variant);
          - after removal, the AFTER-uninstall confirmation states
            that EVERYTHING was removed and nothing remains.
      * Linux packaging note: deb/rpm maintainer scripts cannot show
        interactive dialogs portably, so the interactive "Remove
        everything" choice lives in the APP (Settings → "Uninstall
        and remove all data", which invokes the system uninstall then
        purges), with the package's post-remove script only handling
        the non-interactive default (keep data). AppImage, if ever
        shipped, bundles the same app-side flow.
      * If the purge partially fails (e.g. keystore unavailable), the
        tool must say exactly what was NOT removed and where it
        lives — never claim success silently.
      * No network calls, no telemetry, ever.
  - No root daemon, no systemd unit by default. Autostart (DC-13
    tray) is a user-level ~/.config/autostart entry, created only if
    the user enables it in-app; the installer does not create it.

3.6 Acceptance checks (verify per release)
  - Fresh install → launch → sidecar starts → identity created in
    keystore → db created at XDG path (encrypted per DC-07).
  - Upgrade over existing install: data, identity, pairing survive.
  - Uninstall + reinstall: pairing still works (data intact).
  - rpm and deb both pass the above in clean containers.

==================================================
4. WINDOWS (WIP — PLACEHOLDER, NOT APPROVED)
==================================================

Status: WORK IN PROGRESS. Tide has never been built for Windows; the
port itself (Rust shell, sidecar spawn semantics, keystore choice,
mDNS stack) is a separate future work package. This section records
decisions that are cheap to fix NOW so the Windows port doesn't paint
us into a corner; everything else is deferred until the port starts.

4.1 Decisions fixed now (so Linux choices stay portable)
  - Data layout will use %APPDATA%\tide\ (roaming) for db+data,
    %LOCALAPPDATA%\tide\ for caches/logs — mirror of 3.2 semantics;
    Linux work must not hardcode XDG paths in shared code (use the
    platform-appropriate dir API, not string paths).
  - TIDE_DB_PATH / TIDE_DATA_DIR precedence (3.3) applies unchanged.
  - Sidecar-in-bundle rule (3.4) applies unchanged (Tauri sidecar
    supports Windows .exe).
  - Uninstall-never-touches-user-data rule (3.5) applies unchanged
    (WiX/MSI: no RemoveFile entries on user data paths).
  - Secrets go to Windows Credential Manager via the same keyring API
    abstraction DC-05 already uses (never DPAPI-manual, never files).

4.2 Open items for the future Windows work package (NOT decided here)
  - Artifact format: NSIS vs MSI (Tauri supports both) — decide with
    signing strategy.
  - Code signing (EV cert vs none for in-house use).
  - Background/tray autostart mechanism (registry Run key vs Startup
    folder) — counterpart of DC-13's Linux autostart note.
  - mDNS discovery behavior across Windows firewall prompts (DC-11).
  - SQLCipher/keyring: keystore custody re-verification on Windows.

==================================================
5. EXPLICITLY DEFERRED (with trigger conditions)
==================================================

5.1 Auto-update: deferred until first release is actually distributed
    to a second device/machine. Linux interim answer: package-manager
    upgrade (3.5) IS the update mechanism.
5.2 Flatpak/Store: only on explicit owner request (see 3.1).
5.3 Windows port: separate work package; §4.2 list is its seed.
5.4 Crash reporting/telemetry: NONE by product principle (privacy-
    first). No installer switch may enable any.

==================================================
6. SUMMARY OF BINDING DECISIONS (for review)
==================================================

  D1  Linux ships .deb + .rpm via Tauri bundler; no tarball/snap.
  D2  Data at $XDG_DATA_HOME/tide; config at $XDG_CONFIG_HOME/tide;
      secrets ONLY in OS keystore (DC-05 custody, never files).
  D3  TIDE_DB_PATH/TIDE_DATA_DIR overrides kept; precedence
      env > config > default; not set by the installer.
  D4  Sidecar ships in-bundle; no system Node dependency.
  D5  Uninstall removes app only; user data + identity never touched
      by default; user notified BEFORE and AFTER uninstall of what is
      removed vs. kept (desktop notification + notice file in the
      data dir as guaranteed fallback). Optional explicit opt-in
      "Remove everything" action deletes ALL user data + keystore
      keys with typed/checkbox confirmation and a destructive-action
      warning; default uninstall flow never triggers it.
  D6  Upgrades are plain package upgrades; migrations in-app only;
      TD-003 resolved first if legacy DBs exist.
  D7  No root daemon/systemd unit by default; autostart opt-in,
      user-level.
  D8  Windows: only portability constraints fixed (§4.1); everything
      else WIP until the port work package starts.
