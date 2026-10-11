# TIDE DESIGN CONTRACT DC-24
# Windows Port — Packaging, Installation, Data Safety, and Platform Facts
Status: APPROVED by project owner (2026-10-11).
        §3/§6 binding facts (marked OWNER-APPROVED) were decided by the
        owner on 2026-10-11; §4/§5 items marked PROPOSAL were accepted
        by the owner on 2026-10-11 ("Everything else sounds fine") and
        are binding as of this approval. Commit as a pair with DC-25
        (owner-approved 2026-10-11).
        Cross-reference: the keystore convergence (P2/§4.3) is
        scheduled by the owner to be tackled AFTER the Windows port
        ships, jointly for Linux + Windows — its detailed design is
        DC-25 (APPROVED 2026-10-11). DC-24 §4.3 stays as the Windows
        side-fact; DC-25 is the normative custody contract.
Depends on: DC-15 (packaging/installation/data layout; §4.1 approved
            Windows portability constraints, §4.2 open-items seed);
            DC-05 (device identity, key custody);
            DC-11 + DC-21 (mDNS discovery/endpoint plumbing);
            DC-13 (background/tray process, autostart default-off);
            DC-17 (database encryption at rest, SQLCipher key custody);
            Architecture Spec v0.3 §4, §30
Unblocks: Windows port work package (implementation); Windows release
          engineering; counterpart of DC-15 §4.2
Resolves: DC-15 §4.2 open items (artifact format, signing, autostart
          mechanism, firewall/DC-11 Windows counterpart, keystore
          re-verification, sidecar delivery on Windows)
Out of scope: CalDAV (Spec §26 — skipped by owner); auto-update
              (deferred per DC-15 §5.1); telemetry/crash reporting
              (NONE by product principle, DC-15 §5.4); MSIX/store
              distribution; CI pipeline mechanics beyond the build
              strategy decision in §5.4

==================================================
1. PURPOSE
==================================================

Decides the Windows-port packaging and platform facts as the companion
contract to DC-15 §4. The Linux contract (DC-15 §3) remains the
normative reference; this contract only fixes what Windows needs
BEYOND it — the smallest scope that unblocks the port:

  - the Windows artifact format and its unsigned-by-design signing
    posture with a compensating checksum control (§3),
  - the Windows firewall ruleset mechanism that makes DC-11 mDNS/sync
    discovery work without leaving the user with raw firewall prompts
    (§6),
  - the still-open platform decisions from DC-15 §4.2 / the 2026-10-11
    owner session (§4, §5).

Non-goals: any change to Linux packaging; any sync-protocol or
discovery-protocol change (DC-08/DC-11 semantics are platform-neutral);
no new helper daemons (DC-15 §2 standing rule).

==================================================
2. FROZEN CONSTRAINTS THIS CONTRACT IMPLEMENTS
==================================================

  - DC-15 §4.1 (APPROVED 2026-08-27): data at %APPDATA%\tide\ (db +
    data), %LOCALAPPDATA%\tide\ (caches/logs); TIDE_DB_PATH /
    TIDE_DATA_DIR precedence unchanged; sidecar-in-bundle unchanged;
    uninstall-never-touches-user-data unchanged; secrets via the
    DC-05 keystore abstraction, never DPAPI-manual, never loose files.
  - DC-15 §3.2.1 D9: dev-profile isolation carries over unchanged —
    debug builds resolve all runtime paths through the single
    profile_id() helper to com.tide.app.dev; %APPDATA%\<profile_id()>
    semantics; profile_id() REUSED, never a second literal (the
    duplication that caused the 2026-09-03 locale-reset bug is the
    named hazard).
  - DC-13: autostart is opt-in, default-OFF; the installer does not
    create it.
  - DC-17: the calendar DB is encrypted at rest; the SQLCipher key and
    the device identity key never appear in plaintext config or
    world-readable files. The installer must not undermine this.
  - Owner standing rule: no network calls, no telemetry from
    installer, uninstaller, or firewall helper — anywhere.

==================================================
3. ARTIFACT, SIGNING, AND DISTRIBUTION (BINDING — OWNER-APPROVED 2026-10-11)
==================================================

3.1 Artifact format (OWNER-APPROVED, binding)
  - Tide on Windows ships as ONE artifact per release: the Tauri 2
    bundler NSIS installer (bundle target "nsis"), x64 first; ARM64
    follows when the build strategy (§5.4) produces it.
  - No MSI, no MSIX, no store, no portable zip, no bare exe drop.
    Rationale (owner): NSIS is the Tauri default path with the least
    packaging friction; MSI/MSIX revisit only on demand.

3.2 Code signing: NONE — unsigned (OWNER-APPROVED, binding)
  - No EV/OV certificate is procured for the Windows port (owner
    decision: no budget). The installer and all executables ship
    UNSIGNED. Consequence accepted and documented: Windows
    SmartScreen will warn ("Windows protected your PC") on first
    run; users click "More info" → "Run anyway". This warning is a
    KNOWN, DOCUMENTED property of the unsigned build — support
    answers point at the checksum procedure below, never at
    "ignore the warning" alone.
  - COMPENSATING CONTROL (binding, part of every release): the
    SHA256 checksum of EVERY release artifact MUST be published on
    the SAME release page, next to the download link, in a plain
    text or code block, e.g.:

        Tide_0.2.0_x64-setup.exe  sha256: <hex digest>

    A release page without a checksum next to its artifact is an
    incomplete release — the release is not done until both exist.

  3.2.1 User verification steps (normative support text; must appear
        in the README's Windows section and in the release-notes
        template):
        1. Download the installer from the official release page.
        2. In a terminal run:
             certutil -hashfile Tide_<ver>_x64-setup.exe SHA256
        3. Compare the printed digest with the sha256 value on the
           release page. They must match EXACTLY.
        4. On mismatch: do not run the installer; report it.

3.3 Install/upgrade/uninstall rules (binding; mirrors DC-15 §3.5)
  - INSTALL: the NSIS installer creates nothing outside
    %ProgramFiles%\Tide (or the per-user equivalent NSIS chooses)
    plus the paths in DC-15 §4.1 at first APP RUN. No registry
    pollution beyond the standard NSIS uninstall entry. No network
    access during install.
  - UPGRADE: plain installer-over-installer. Schema migrations run
    in-app at sidecar startup (existing mechanism, DC-15 §3.5 D6);
    the installer never touches user data.
  - UNINSTALL: removes program files and the NSIS uninstall entry
    ONLY. User data (%APPDATA%\tide, %LOCALAPPDATA%\tide,
    %APPDATA%\<profile_id()> dev profile, Credential Manager
    entries) is NEVER touched by default. The DC-15 §3.5 uninstall
    notification pair and the explicit opt-in "Remove everything"
    action with its destructive-action safeguards apply on Windows
    with the §4.1 path list:
        %APPDATA%\tide, %LOCALAPPDATA%\tide, Credential Manager
        entries (via the OS keystore API — never by raw path
        guessing), and the dev profile directory if present.
    NSIS custom pages carry the interactive choice; the app-side
    flow (DC-15 §3.5) is the pattern to follow.

==================================================
4. DATA SAFETY AND PLATFORM FACTS
==================================================

4.1 Path layout (binding; DC-15 §4.1 restated for the port)
  - Database + durable data:  %APPDATA%\tide\
  - Caches/logs:              %LOCALAPPDATA%\tide\
  - Config (non-secret):      %APPDATA%\tide\config.toml
  - Dev profile (debug):      same layout under
    %APPDATA%\com.tide.app.dev\ via profile_id() — no second
    literal, ever (DC-15 §3.2.1).
  - Shared code must use the platform-appropriate dir API, not
    string paths (DC-15 §4.1).

4.2 Environment overrides (binding; DC-15 §3.3)
  - TIDE_DB_PATH / TIDE_DATA_DIR precedence env > config > default is
    preserved on Windows. Not set by the installer; documented in the
    README as power-user/test hooks.

4.3 Key custody: identity key + SQLCipher DB key on Windows
    (PROPOSAL P2 — ACCEPTED by owner 2026-10-11; detailed design
    resolved by DC-25, see §8)
  - Target state: both secrets live in Windows Credential Manager
    through the SAME keystore-abstraction seam DC-05 specifies
    (plumbable Rust-side via the `keyring` crate's Windows
    Credential Manager backend — support must be VERIFIED against
    the then-current crate version at implementation time; if the
    crate cannot serve, the abstraction gets a second backend, the
    call sites do not change).
  - Current state to reconcile (verified in repo): today BOTH Linux
    and Windows store the identity key as a 0600-mode file
    (device_identity.key next to the DB, src/network/sync_runtime.ts
    loadOrCreateIdentity), with OS-keystore binding explicitly
    tracked as a pre-ship requirement. The Windows port MUST NOT add
    a second custody model: the abstraction gets a Windows backend
    (Credential Manager) behind the same interface; the 0600-file
    fallback (Windows equivalent: file under %APPDATA% with a
    restrictive ACL, current-user-only) remains the documented
    interim, as it already is on Linux. Converging both platforms to
    the keystore is the SAME pre-ship item, not a Windows-only one.
  - Never: DPAPI-manual blobs, plaintext key in config.toml, keys in
    %LOCALAPPDATA% caches.

4.4 Node sidecar delivery on Windows (PROPOSAL P3 — pending owner
    approval; DC-15 D4 "in-bundle, no system Node dependency" is the
    binding constraint)
  - Recommended form: bundle a PINNED node.exe (same major version
    the Linux packages pin) INSIDE the bundle resources, next to
    sidecar.mjs and the vendored better-sqlite3. The Tauri shell
    spawns <resource-dir>\node.exe sidecar.mjs over stdio exactly as
    it spawns `node` on Linux — one spawn seam, no PATH lookup, no
    system Node, no version drift. A single-file sidecar executable
    (SEA/Bun-style) is the rejected alternative: it re-freezes the
    native-module story that better-sqlite3 already owns.
  - Re-vendoring prerequisite (implementation fact, binding when the
    port starts): the vendored copy in
    src-tauri/resources/better-sqlite3/ is currently stripped to
    linux-only. It must be re-vendored with the win32-x64 (and, if
    targeted, win32-arm64) prebuilds (.node binaries) matching the
    then-current fork version — prebuild availability for that exact
    version must be VERIFIED at implementation time (the v12
    better-sqlite3 line ships win32 prebuilds; v13's cross-platform
    segfault class, TD-025, is the reason the version check is
    mandatory, not optional). The 12.11.1-downgrade lesson applies:
    verify the prebuild actually loads on the bundled node.exe
    before shipping.

4.5 Notification delivery on Windows (PROPOSAL P5 — pending owner
    approval; TD-022 strategy-chain pattern is binding)
  - notification_delivery.ts is a strategy chain (notify-send →
    gdbus → dbus-send; failed strategies dead for the session, one
    log line per attempt, all-failed retry documented). A Windows
    strategy joins the SAME chain, selected per platform:
    recommended default: a PowerShell one-shot toast via
    Windows.UI.Notifications (ships with every Windows 10/11, no new
    dependency, invoked as a child process exactly like notify-send).
    Fallback strategy: tray-balloon via the Tauri tray (DC-19 icon is
    present whenever the tray runs). Chain order on Windows:
    powershell-toast → tray-fallback. Same session-dead-strategy and
    logging rules as TD-022. No notification daemon, no scheduled
    task, no service.

==================================================
5. BUILD, BINARY NAMING, ICONS
==================================================

5.1 mainBinaryName / windows_subsystem (PROPOSAL P4 — pending owner
    approval)
  - tauri.conf.json sets mainBinaryName = "tide"; on Windows this
    yields tide.exe. The default (absent) windows_subsystem attribute
    keeps the console window in debug and hides it in release — the
    standard Tauri behavior; NO #[windows_subsystem] override is
    added in Rust source so the single main.rs stays
    platform-uniform (Tauri's build profile already applies the
    windows_subsystem linker flag in release).
  - Implementation-time checks (binding when the port builds):
    verify the produced tide.exe: (a) runs windowless in release,
    (b) NSIS registers the correct Start-Menu shortcut name "Tide",
    (c) the tray icon (DC-13/DC-19) uses the existing
    src-tauri/icons/icon.ico — icons already exist; no new icon
    work expected, only verification.
  - Known trap to re-verify: some Tauri versions reject
    mainBinaryName differing from productName for the NSIS target or
    rename the installer artifact accordingly. If so, follow what
    the bundler produces — the binding facts are "one NSIS installer
    named after Tide with tide.exe inside"; the exact config knob
    achieving it may be adjusted without a contract change, as long
    as no second literal of the identifier appears.

5.2 Dev profile on Windows (binding; D9 carry-over)
  - cargo/debug builds resolve to com.tide.app.dev via profile_id();
    dev state disposable, starts empty, own device identity, no
    migration from prod (DC-15 §3.2.1 verbatim).

5.3 Release gate (binding when the port ships)
  - Fresh install on a clean Windows VM → launch → sidecar starts →
    identity created → encrypted DB at %APPDATA%\tide → firewall
    ruleset check behaves per §6 → mDNS pair with a Linux device
    (DC-11 end-to-end) → uninstall keeps all data (§3.3).
  - Checksum (§3.2) present on the release page before the release
    is announced.

5.4 Build strategy (PROPOSAL P1 — pending owner approval)
  - Recommended default: GitHub Actions windows-latest CI builds the
    NSIS artifact per release tag; native MSVC on a local Windows
    machine remains the documented fallback, not the pipeline. The
    repo currently releases by hand (owner builds RPM/DEB locally);
    Windows cannot be built on the existing Linux machine at all, so
    a build host is REQUIRED — CI is the cheapest, most reproducible
    one. The CI workflow uploads the artifact + its SHA256 (§3.2) as
    release assets; the owner reviews and publishes. No CI change is
    made until this proposal is approved.

==================================================
6. WINDOWS FIREWALL RULESET (BINDING — OWNER-APPROVED 2026-10-11)
==================================================

Owner decision: an ACTIVE ruleset check at startup / first sync use;
if no rule set exists for the app, set/create one accordingly. Design:

6.1 Check mechanism (binding)
  - Shell-side (Rust) check via `netsh advfirewall firewall show rule
    name=all` filtered for the app's rules (netsh is chosen over the
    Windows Firewall COM API: it is a one-shot child process with
    parseable output, needs no additional crate, and the SAME process
    shape creates rules — one tool for check + create, no COM
    apartment complexity). Output is parsed for marker rules added by
    us (named "Tide mDNS" / "Tide sync", see 6.3) — never a generic
    "any rule mentioning tide.exe" heuristic (uninstallers of other
    software must not be able to satisfy our check).

6.2 Check timing (binding)
  - At app startup (tray up, window allowed) AND re-checked lazily at
    first sync enablement if startup skipped it (e.g. sync disabled
    at startup). Check is cheap (one netsh child process) and logged
    (one log line: rules present / absent / check-failed).

6.3 Rule scope (binding)
  - If the check finds no Tide rules, the app proposes/creates
    exactly two INBOUND allow rules (elevation required — see 6.4):
      * "Tide mDNS"   : inbound UDP, local port 5353, program =
        tide.exe — required for DC-11 mDNS discovery replies on
        Windows (mDNS sockets bind 5353 inbound).
      * "Tide sync"   : inbound TCP, local port 47471
        (SYNC_DEFAULT_PORT — the literal is imported from the shared
        constant, never re-hardcoded), program = tide.exe — required
        for direct-TCP sync sessions (DC-05/DC-08).
    Outbound traffic needs NO rules on default-configured Windows
    (default outbound = allow); we do NOT create outbound rules, and
    we do NOT modify any existing (default) rules.

6.4 UAC elevation handling (binding)
  - Creating firewall rules requires administrator rights. The shell
    launches the netsh-create via a UAC-elevated child process
    (runas / ShellExecute "runas"), which triggers the standard UAC
    prompt. Rules are created ONCE per machine (idempotent: check
    first, create only when absent), not per launch.
  - The elevation prompt names netsh under our invocation; the
    user-facing dialog text (in-app, before the UAC prompt) explains:
    "Tide needs Windows Firewall rules so other paired devices can
    discover this computer and sync with it."
  - If the user REFUSES elevation (cancels UAC): DEGRADED MODE per
    owner decision — sync (discovery + inbound sessions) is DISABLED;
    a persistent, dismissible tray/UI notice states sync is off
    because firewall rules could not be created and offers "Try
    again" (re-attempts elevation at the user's next explicit
    action, never a loop). EVERYTHING else — calendar, editing,
    reminders, export/import, tray — works fully. The app must never
    retry elevation silently on a timer.
  - If the netsh check itself fails (netsh missing/odd output):
    fail-safe to degraded mode with the same notice (fail-visible,
    never fail-silent, never fail-open into broken discovery).

6.5 Uninstall (binding)
  - The NSIS uninstaller removes the two "Tide mDNS" / "Tide sync"
    rules it owns (netsh delete rule, elevated — the uninstaller
    already runs elevated under NSIS's default). If removal fails,
    uninstall continues and the leftover rule is inert (program path
    gone). No telemetry, no network calls anywhere in §6.

==================================================
7. ACCEPTANCE CHECKS (Windows, verify per release — binding)
==================================================
  - NSIS installer installs on clean Windows 10/11 x64; SmartScreen
    warning documented; checksum matches (§3.2.1).
  - Fresh install → launch → identity + encrypted DB under
    %APPDATA%\tide (dev build under %APPDATA%\com.tide.app.dev,
    empty, isolated).
  - First sync enable: firewall check runs; UAC accepted → rules
    exist, mDNS discovery of a Linux Tide peer works; UAC refused →
    sync disabled with notice, rest of app works (§6.4).
  - Reminder due → toast arrives (§4.5).
  - Upgrade over existing install: data, identity, pairing survive;
    firewall rules not duplicated (§6.3 idempotence).
  - Uninstall: program removed; user data + Credential Manager
    entries intact; owned firewall rules removed; BEFORE/AFTER
    notification flow per DC-15 §3.5.

==================================================
8. SUMMARY OF DECISIONS (for review)
==================================================

  OWNER-APPROVED (binding, decided 2026-10-11):
  B1  Artifact: Tauri NSIS installer, one per release. §3.1
  B2  Unsigned; compensating control: SHA256 checksum of every
      artifact published on the SAME release page; normative user
      verification steps (certutil). §3.2/§3.2.1
  B3  Windows firewall: active netsh-based ruleset check at
      startup/first sync use; on absence, create two inbound rules
      (UDP 5353 mDNS + TCP 47471 sync) via a single UAC elevation;
      refused elevation → sync disabled, app otherwise fully
      functional; fail-safe degraded mode; rules removed at
      uninstall. §6
  B4  DC-15 §4.1 portability constraints + D9 dev-profile isolation +
      TIDE_DB_PATH/TIDE_DATA_DIR overrides carry over verbatim;
      profile_id() reused, never a second literal. §2/§4.1/§4.2

  PROPOSALS (agent defaults — NOT binding until owner approves):
  P1  Build strategy: GitHub Actions windows-latest CI builds NSIS
      + checksum per release tag; local MSVC as fallback. §5.4
  P2  Key custody: identity key + SQLCipher key in Windows
      Credential Manager behind the existing DC-05 keystore
      abstraction (keyring crate — support verified at
      implementation time); restrictive-ACL file fallback mirrors
      Linux's interim 0600 file; keystore convergence is a joint
      pre-ship item, not Windows-only. §4.3
  P3  Sidecar delivery: pinned node.exe bundled in resources, spawns
      sidecar.mjs over stdio (no system Node, no SEA);
      prerequisite: re-vendor better-sqlite3 with win32-x64/arm64
      prebuilds, verified against the then-current fork version at
      implementation time. §4.4
  P4  mainBinaryName=tide → tide.exe; no #[windows_subsystem]
      override in source; implementation-time verification of
      windowless release run, shortcut name, and icon.ico tray use;
      bundler-knob adjustments allowed without contract change.
      §5.1
  P5  Notifications: Windows strategy joins the TD-022 chain —
      PowerShell toast (Windows.UI.Notifications) primary, tray
      fallback; same session-dead/log rules. §4.5
