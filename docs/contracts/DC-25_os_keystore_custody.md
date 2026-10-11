# TIDE DESIGN CONTRACT DC-25
# OS Keystore Custody of Secrets — Linux + Windows Convergence
Status: APPROVED by project owner (2026-10-11).
        Owner approved the proposals P1–P5 as written, the KWallet v1
        exclusion (Secret Service as the single Linux backend), and
        joint commit with DC-24. All §4/§5 proposals are binding as
        of this approval; §2 frozen constraints carry prior
        approvals. Nothing is implementable before its trigger (§3).
Depends on: DC-05 (device identity, §2.3 keystore preference order);
            DC-15 (packaging/installation; §3.2 D2 secrets-only-in-
            keystore rule, §3.5 uninstall + "Remove everything",
            §4.1 paths, D9 dev-profile isolation);
            DC-17 (database encryption at rest; §4.2 stdio key
            delivery, §7B key-handoff threat model);
            DC-24 (Windows port contract, DRAFT — §4.3 P2 defines the
            Windows side this contract converges on)
Unblocks: Closing the DC-05 §2.3 / DC-15 D2 keystore pre-ship
          requirement on BOTH platforms; retirement of the 0600-file
          interim custody state (today's implementation reality)
Resolves: DC-24 §4.3 (P2) — the joint Linux+Windows keystore
          convergence item; DC-15 §3.2 D2 "secrets ONLY in OS
          keystore, never files" for real; the DC-17 keystore
          handoff dependency (its §4.2 delivery assumes a working
          keystore read exists)
Out of scope: key rotation UX, key export/backup/escrow, cloud sync
          of keys (all deferred by product principles — DC-17 §4A/§8);
          Android Keystore (lands with the Android port, DC-17 §7/O2);
          any change to the crypto itself (DC-05/DC-17 own that);
          any change to sync semantics or call sites (§4.1 — none)

==================================================
1. PURPOSE
==================================================

Decides HOW the two long-lived secrets of a Tide installation — the
device identity key (DC-05) and the calendar-DB encryption key
(DC-17) — are held in the OS keystore on BOTH Linux and Windows, as
ONE shared convergence task deliberately scheduled AFTER the Windows
port ships (owner decision 2026-10-11; the trigger condition is
stated in §3, not a date).

What this contract is NOT: it does not change what the keys are, how
they are generated, or how they are delivered to the sidecar —
DC-05/DC-17 own all of that and are unchanged. It decides only the
CUSTODY mechanism (where the key material lives at rest), the
one-time migration of existing file-based keys into the keystore, the
fallback when no keystore exists, and the uninstall purge semantics.

==================================================
2. CURRENT STATE (VERIFIED IN REPO, 2026-10-11 @ 1499a17)
==================================================

  - NO keystore code exists anywhere today. This is the grounding
    fact both older contracts gloss over: src-tauri/Cargo.toml has NO
    keyring crate and NO tauri-plugin-keyring/stronghold; there is no
    keystore call in src-tauri/src/ (discovery.rs, lib.rs, main.rs,
    mdns_service.rs, sidecar.rs). The "Tauri keyring API" that
    DC-05 §2.3, DC-15 §3.2, and DC-17 §4.1 all point at is a
    reference to a mechanism that has NOT been built yet.
  - The device identity key is a 0600-mode FILE written by the Node
    sidecar: src/network/sync_runtime.ts loadOrCreateIdentity()
    writes device_identity.key next to the DB, with an inline
    NOTE(key custody) acknowledging that OS-keystore binding is a
    tracked pre-ship requirement. (This also violates DC-05 §2.1's
    "TypeScript side MUST NOT generate or store keys" — moving
    custody to the Rust shell fixes both.)
  - The DB encryption key does not exist yet: DC-17 is a backlogged
    DRAFT and package.json still carries plain better-sqlite3
    ^12.11.1 (src/persistence/database.ts holds only a placeholder
    note for the future key). When DC-17 is implemented, its key
    custody target is THIS contract.
  - Windows: DC-24 §4.3 (P2, proposal) targets Windows Credential
    Manager behind "the SAME keystore-abstraction seam DC-05
    specifies" — which, per the above, does not exist. This contract
    creates it, once, for both platforms.

Consequence: DC-25 is greenfield work, not a refactor. The abstraction,
its backends, and the migration of the file-based identity key are all
built under this contract.

==================================================
3. TRIGGER AND TIMING (BINDING CARRY-OVER OF OWNER INTENT)
==================================================

Owner decision 2026-10-11: the keystore problem is tackled at the END
of the Windows port, jointly for Linux AND Windows — one shared
convergence task, NOT a Windows-only item and NOT a Linux-first item.

Trigger condition (this contract states a condition, not a date):

  The work package starts when BOTH of these hold:
    (a) the Windows port has shipped per DC-24 (NSIS artifact
        released per §3 of DC-24), and
    (b) DC-17 (database encryption) is either implemented or is
        being implemented in the same package — because migrating
        the DB key custody before any DB key exists would be
        meaningless, and migrating identity alone would leave the
        file-fallback machinery half-built.

Rationale (owner): doing custody twice (once Linux, once Windows)
would mean building the migration-once machinery twice and touching
live user data twice. One package, both platforms, real data
migrations verified on each.

==================================================
4. TARGET STATE AND ABSTRACTION SEAM
==================================================

4.1 One seam, two backends, unchanged call sites (PROPOSAL)
  - A single keystore-abstraction seam in the RUST shell, exposing
    exactly the operations the app needs: read(secret_id),
    write(secret_id, bytes), delete(secret_id), exists(secret_id).
    Nothing more (no metadata, no enumeration, no keyring
    introspection — smallest surface).
  - Two backends behind it, selected at build/run time per platform:
      * Linux: Secret Service (GNOME Keyring) via the `keyring`
        crate's secret-service feature, or the Tauri keyring plugin
        if one exists by then.
      * Windows: Windows Credential Manager via the `keyring`
        crate's windows-native feature (per DC-24 §4.3 P2).
    MANDATORY IMPLEMENTATION-TIME VERIFICATION (not asserted fact):
    which crate/plugin actually works per platform is tested when the
    package runs. DC-24 §4.3 already frames this correctly ("if the
    crate cannot serve, the abstraction gets a second backend, the
    call sites do not change") — this contract adopts that rule
    verbatim for both platforms. KWallet is NOT a v1 target (owner
    confirmed 2026-10-11; matches DC-15 §3.2's "keystone/keyring
    access; revisit only on user demand"): Secret Service is the one
    Linux backend because it is the distro-general path — GNOME/KDE/
    xfce/mate desktops ship gnome-keyring or an XDG-compliant agent
    providing it, while headless/minimal installs are the real
    fallback-mode case. A KDE/keyring shortfall discovered at
    verification time becomes an explicit fallback-mode question, not
    a redesign.
  - Call sites unchanged: the sidecar's loadOrCreateIdentity() call
    signature and the sidecar's DB-open path keep their shapes; only
    WHERE the key material comes from changes (§4.3). The abstraction
    lives in Rust; the Node side never talks to the keystore
    directly (see §4.3 — this also repairs the DC-05 §2.1 violation).
  - Secret identity convention (carrying DC-17 §4.1): service
    "tide", distinct accounts per secret — "device-identity" and
    "db-key". Dev profile (DC-15 D9) uses service "com.tide.app.dev"
    so dev and prod keystores never share entries — profile_id()
    REUSED, never a second literal.
  - Never: DPAPI-manual blobs, plaintext key in config.toml, keys in
    %LOCALAPPDATA% caches or $XDG_CACHE_HOME, env-var delivery
    (DC-17 §4.2's /proc/PID/environ reasoning applies to the identity
    key equally).

4.2 Ownership of custody moves to the Rust shell (PROPOSAL)
  - Today the sidecar generates and writes the identity key. Under
    this contract the Rust shell owns ALL keystore reads/writes; the
    sidecar receives key material over the EXISTING stdio handshake
    (the DC-17 §4.2/§4.3 pattern, extended): one handshake line per
    secret ({"op":"db_key"|"identity_key", "key":"<base64>"}), same
    fail-closed rules (delivery failure => sidecar exits nonzero with
    an operation-named, value-free message).
  - Generation: at first run the SHELL generates the identity key
    (DC-05 §2.1: all key operations live in the Rust layer) and
    writes it straight to the keystore; the sidecar never touches
    disk for key material. DB-key generation stays DC-17's (shell
    generates, keystore stores).
  - This is a deliberate scope item, not an incidental cleanup: it
    is the change that makes "0600 file" impossible, not just
    unlikely.

4.3 Fallback: keystore unavailable (PROPOSAL, documented INTERIM —
    never the steady state)
  - If the OS keystore is unavailable (headless Linux box with no
    secret-service daemon, broken keyring, or a Windows machine with
    a broken DPAPI/user profile), the app falls back to a file:
      * Linux: <data_dir>/device_identity.key / db.key, mode 0600,
        owner-only (today's exact pattern — the fallback is
        deliberately IDENTICAL to today's file, so the fallback IS
        the current state, not a new one).
      * Windows: equivalent file under %APPDATA%\tide with a
        restrictive ACL (current user only), per DC-24 §4.3.
  - Fallback MUST be visible: one log line at startup naming the
    custody mode in effect, plus a persistent, dismissible notice
    (tray/UI) stating that secrets are protected at file level only
    — mirroring DC-05 §2.3's "fallback MUST be logged" rule.
  - Retry rule: the app re-attempts the keystore at next startup,
    never on a timer. If the keystore becomes available later, the
    next startup MIGRATES the fallback file into the keystore (same
    verified-migration procedure as §5) and deletes the file.
  - Honest limitation (carry-over of DC-05 §8 N3 / DC-17 §7B): the
    fallback is weaker protection and is documented as such. It is
    the documented interim for machines without a keystore; the
    steady state for normal desktop installs is keystore custody.

==================================================
5. ONE-TIME MIGRATION OF EXISTING KEYS (PROPOSAL — the data-loss
   guard is the core of this section)
==================================================

Existing installs have real user data. The hazard to design against
is concrete: the DB key, once lost, makes the encrypted database
PERMANENTLY unreadable (DC-17 §4A — and a lost identity key silently
breaks pairing on every paired peer). Migration must therefore never
delete custody it has not proven it can read back.

5.1 Migration procedure (per secret, both secrets in one pass)
  On startup, when file-based key material exists AND the keystore is
  usable:
    1. READ the existing file key. (Identity: the file IS the key.
       DB key: exists only after DC-17 ships; for installs that were
       never encrypted there is no DB key to migrate — the new key is
       generated straight into the keystore.)
    2. WRITE it to the keystore under the §4.1 convention.
    3. VERIFY by reading it back from the keystore and byte-comparing
       against the original file value. Mismatch or error => ABORT,
       keep the file, log the failure, retry next startup. The file
       is NEVER deleted on an unverified path.
    4. Only after a verified read-back: delete the file. The deletion
       is the LAST step, after the keystore has demonstrably served
       the exact bytes back.
    5. Post-condition: the app re-runs the normal startup path (read
       from keystore) and proceeds. A crash between any steps is
       safe by construction — steps 1–3 are idempotent (rewrite to
       keystore is a no-op if identical), and the file is only
       removed after verification, so a crash always leaves a
       working key in at least one place.
  - NO DUPLICATE CUSTODY: this is a one-time, one-directional move.
    After migration, the file does not exist and is never re-created
    while the keystore works. The keystore is the sole custody from
    then on (§4.3 fallback only when the keystore is unavailable).

5.2 Interplay with DC-17's DB migration (ordering note, not a change)
  - For an install that gains BOTH the keystore and encryption in
    the same upgrade (plaintext DB today): DC-17 §5's ATTACH+safecopy
    re-key runs in the sidecar as specified; DC-25 only guarantees
    the shell can supply the (new) DB key from the keystore before
    that migration starts. DC-17's contract text is unchanged; DC-25
    adds the custody plumbing beneath it.

5.3 Migration on Windows
  - Same procedure; the "file" being migrated is today's 0600-equiva-
    lent (DC-24 §4.3: restrictive-ACL file under %APPDATA%). Fresh
    Windows installs created AFTER this package ships never produce
    a file at all.

==================================================
6. UNINSTALL CARRY-OVER (BINDING — DC-15 §3.5 / DC-24 §3.3)
==================================================

  - Default uninstall (Linux package remove; Windows NSIS): NEVER
    touches keystore entries. Reinstall re-reads both keys; the
    encrypted DB reopens intact (DC-17 §4A stance, unchanged).
  - "Remove everything" (explicit opt-in, DC-15 §3.5): deletes BOTH
    Tide keystore entries (service "tide", accounts "device-identity"
    and "db-key"; dev profile: service com.tide.app.dev equivalents)
    via the abstraction's delete() — i.e. via the OS keyring API on
    each platform (Secret Service / Credential Manager), NEVER by
    raw path guessing — plus the DC-15 §3.5 file list. All of DC-15's
    destructive-action safeguards, the BEFORE/AFTER notification
    pair, and the partial-failure honesty rule ("say exactly what was
    NOT removed") apply verbatim, now extended to name keystore
    entries explicitly on both platforms.
  - Fallback files, when present (§4.3), are covered by the existing
    §3.5 file purge (they live inside the data dir) — no second
    purge mechanism.

==================================================
7. THREAT-MODEL CARRY-OVER (verbatim adoption)
==================================================

DC-17 §7B applies to BOTH secrets and is adopted as-is:

  - Logging: keys are never logged. Error messages name the operation
    ("db key rejected", "identity key unreadable"), never a value.
  - Diagnostics: diagnostic bundles never include keystore extracts,
    stdin captures, environment dumps, or key files.
  - Key lifetime in memory: the shell holds key material only
    between keystore read and handshake write; the sidecar uses it
    only for its purpose (PRAGMA key / Noise static), then releases
    it. Honest JS limitation (GC copies may linger) accepted per
    DC-17 §7B; same for Rust-side copies within the stated window.
  - Process-local delivery: stdio pipe inherited by our own spawned
    child; no network listener; same-user spawn-hijack is out of
    scope (DC-17 §1.2).
  - Accidental persistence: keys never reach config files,
    localStorage, logs, persisted UI state, or sync traffic.
    Post-run scan of data dir + config surfaces for key bytes stays
    in the verification checklist (§8).

Additional note specific to custody: keystore access is same-user
protection against other users/offline disk theft, NOT protection
against root or a compromised running process (same scope statement
as DC-17 §1.2). Neither the Secret Service nor Credential Manager
changes that; the improvement over 0600 files is a managed,
non-copyable, OS-curated store (per-user encryption on Windows via
DPAPI backing; per-user keyring unlock on Linux) instead of an
ordinary file that a backup job or support bundle happily copies.

==================================================
8. VERIFICATION CHECKLIST (implementation gate — binding when the
   package runs)
==================================================

All items below are MANDATORY VERIFICATION items, not asserted
facts. Each is tested on BOTH platforms before this contract's work
is marked done:

  1. Backend works per platform: the chosen crate/plugin actually
     reads/writes/deletes under Secret Service on a GNOME session AND
     under Credential Manager on Windows 10/11 (DC-24 §4.3's
     "verified against the then-current crate version" rule,
     extended to Linux). Record which backend shipped per platform.
  2. Fresh install: no key file is EVER written on either platform;
     identity + DB keys exist only in the keystore.
  3. Migration with real data: an upgrade over an existing install
     (file-based identity on Linux; both platforms if applicable)
     migrates, verifies read-back, deletes the file, and the app
     continues — pairing still works, DB still opens (after DC-17).
  4. Migration abort path: simulate keystore write/read-back failure
     => file retained, startup proceeds on file fallback, retry next
     start; no data loss in any intermediate state (kill the process
     at each step; every state must reopen).
  5. Fallback mode: keystore unavailable => file fallback with
     restrictive permissions, visible notice, one custody-mode log
     line; keystore returns => auto-migration per §4.3.
  6. Dev/prod isolation: dev build reads/writes ONLY the
     com.tide.app.dev service; prod entries untouched (D9).
  7. Uninstall: default keeps keystore entries (reinstall reopens);
     "Remove everything" deletes both entries on BOTH platforms and
     reports partial failure honestly (DC-15 §3.5).
  8. Log/diagnostic scrubbing: forced-error runs produce no key
     bytes in logs or bundles (DC-17 §7B test, both secrets).
  9. Persistence scan: post-run scan of data dir, config, and
     localStorage finds no key bytes for either secret (§7).
  10. Windows fresh-install parity per DC-24 §5.3, updated: identity
      created in Credential Manager, no key file under %APPDATA%.

==================================================
9. SUMMARY OF DECISIONS (for review)
==================================================

  CARRIED OVER — already binding (restated for completeness):
  B1  Secrets (identity key, DB key) live in the OS keystore; never
      files in the steady state; never logged; never exported/
      backed up/escrowed. DC-05 §2.3, DC-15 §3.2 D2, DC-17 D2/D7.
  B2  Default uninstall keeps keystore entries; opt-in "Remove
      everything" deletes Tide keystore entries via the OS keyring
      API with full DC-15 §3.5 safeguards, on both platforms.
      DC-15 §3.5, DC-24 §3.3. (§6)
  B3  Timing: keystore work is ONE joint Linux+Windows package at
      the END of the Windows port; trigger = Windows port shipped
      (DC-24) AND DC-17 in the same implementation window. Owner
      decision 2026-10-11. (§3)

  PROPOSALS (agent defaults — NOT binding until owner approves):
  P1  One keystore-abstraction seam in the Rust shell (read/write/
      delete/exists, nothing more); Linux = Secret Service, Windows
      = Credential Manager, both behind it; backend per platform
      verified at implementation time (keyring crate or Tauri
      plugin, whichever serves); call sites unchanged. (§4.1)
  P2  Custody ownership moves to the Rust shell; keys reach the
      sidecar over the existing stdio handshake (DC-17 §4.2 pattern
      extended to the identity key); sidecar never touches disk for
      key material; repairs the DC-05 §2.1 TS-side violation. (§4.2)
  P3  Fallback when keystore unavailable: the current 0600-file
      pattern (Linux) / restrictive-ACL file (Windows), logged and
      visibly noticed, documented as INTERIM; auto-migrates into the
      keystore when it becomes available. (§4.3)
  P4  One-time migration with the verified-read-back guard: write to
      keystore, read back, byte-compare, and ONLY THEN delete the
      file; any mismatch aborts and keeps the file; idempotent under
      crashes; no duplicate custody afterwards. (§5)
  P5  Dev-profile isolation extends to the keystore via the
      com.tide.app.dev service name (profile_id() reused, no second
      literal). (§4.1)
