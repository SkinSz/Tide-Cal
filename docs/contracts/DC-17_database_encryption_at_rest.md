# TIDE DESIGN CONTRACT DC-17
# Database Encryption at Rest (Calendar DB)
Status: DRAFT v2 — BACKLOGGED DESIGN CONTRACT, NOT APPROVED FOR
        IMPLEMENTATION. Revisit when Tide is ready for encryption at
        rest. v2 expands v1 per owner critical review: exact cipher
        configuration + integrity/tamper-detection model; complete key
        lifecycle (incl. loss/reinstall/backup-restore stances);
        migration plaintext-leakage handling; platform/build
        feasibility; key-handoff threat model; future verification
        checklist. NOT APPROVED; implementation intentionally deferred.
Depends on: DC-05 (device identity, key custody in OS keystore);
            DC-07 (SQLite schema); DC-15 (sidecar in-bundle packaging,
            per-platform data layout, Windows/Android scope);
            TD-003 (legacy dev-* identity migration)
Unblocks: First distributable Linux build with an encrypted database
          (DC-15 ship gate); any release carrying real user data
Resolves: Owner decision 2026-08-25 (binding): encrypt the calendar
          database at rest — AES-256 page-level encryption, DB key in
          OS keystore per DC-05; this contract selects the concrete
          off-the-shelf mechanism and the key-delivery + migration path

==================================================
1. PURPOSE AND THREAT STATEMENT
==================================================

The owner decided on 2026-08-25 (binding) that the calendar database
must be encrypted at rest. Requirements frozen by that decision:

  - AES-256 page-level encryption of the whole database file, not
    selective field encryption.
  - The database key lives in the OS keystore, using the SAME custody
    mechanism as the device identity key (DC-05, restated in DC-15
    §3.2): never written to disk as a file by the app, NEVER backed
    up, never included in any export or uninstaller purge.
  - Performance overhead is accepted; no optimization may trade away
    the encryption.

1.1 Threat model (what this protects against)
  - Lost/stolen laptop: someone images the disk or copies
    ~/.local/share/tide/calendar.db (plus -wal/-shm) and reads the
    user's calendar contents offline.
  - Casual local snooping: another user account or local malware
    reading the data directory.
  - Accidental leakage of the database file via a backup, a support
    bundle, or a stray file copy.

1.2 Out of scope (stated honestly)
  - An attacker with root on the RUNNING machine, or one who can read
    process memory, can obtain the key from the live process. Page
    encryption at rest does NOT defend a compromised running session.
  - Filesystem-level encryption alone (fscrypt/LUKS/EFS) is rejected
    for this role (see §3.5): it protects only while the device is
    powered off, and it provides no per-file key custody we control.

Non-goal: designing our own crypto. Every option below is an
off-the-shelf, maintained mechanism. We write zero cryptographic
primitives ourselves.

==================================================
2. CURRENT STATE (GROUNDING)
==================================================

  - The domain core runs as a Node sidecar (src/persistence/
    bridges/sidecar_server.ts, stdio JSON-RPC host), spawned by the
    Tauri (Rust) shell; it opens the SQLite database through
    better-sqlite3 ^13.0.3 (package.json). It is a native addon,
    external to the esbuild bundle ("sidecar:build" keeps it
    --external:better-sqlite3).
  - better-sqlite3 itself has NO first-class encryption support;
    adding it means a custom source build with special compile flags
    (their docs/compilation.md route), which is fragile and
    version-locked.
  - DC-05/DC-15 already put secrets (identity key, and the DB key per
    the 2026-08-25 decision) in the OS keystore via the Tauri keyring
    API (Secret Service / kwallet on Linux; Credential Manager on
    Windows in the future §4).

==================================================
3. CANDIDATE EVALUATION
==================================================

3.1 SQLite SEE (official SQLite Encryption Extension)
  - The "official" option: closed-source, perpetual license, US
    $2,000 one-time per product (sqlite.org/purchase/see).
  - REJECTED. $2,000 for a feature functionally equivalent to free,
    maintained alternatives below. Documented here so the rejection
    is a decision, not an oversight.

3.2 Plain better-sqlite3 + classic SQLCipher (source build)
  - SQLCipher is mature and the de-facto standard (AES-256 page
    encryption, PRAGMA key). But wiring it into better-sqlite3
    requires replacing/bundling the SQLite source and applying
    compile flags via preinstall scripts, tightly coupled to the
    better-sqlite3 version (docs/compilation.md). Fragile, painful
    upgrades, breaks the "system Node/native addon must just work"
    property the sidecar relies on (DC-15 §3.4 version-locking).
  - REJECTED: fragile custom builds for the same outcome as 3.6.

3.3 Filesystem encryption (fscrypt / LUKS / Windows EFS)
  - REJECTED: wrong layer. It protects data only while the device is
    off/locked and does not follow the file (e.g., copied DB, backup,
    tarball). It also gives us no per-file key custody — the key is
    the user's login/disk key, not an app-held secret per DC-05, so
    "revoke/rotate the DB key" and "never backed up" are out of our
    control. Not an encryption-at-rest design for THIS file.

3.4 Field-level application crypto
  - Encrypt individual sensitive columns in JS before insert.
  - REJECTED: different threat model (leaves schema, metadata,
    freetext columns, -wal artifacts, and deleted-page remnants in
    plaintext), complexifies every query/index, and would force us to
    write key-handling and padding logic ourselves — exactly what the
    owner ruled out.

3.5 CHOSEN: better-sqlite3-multiple-ciphers (SQLite3MultipleCiphers
    backend)
  - npm package better-sqlite3-multiple-ciphers: a drop-in fork of
    better-sqlite3 (same API surface) built with SQLite3MultipleCiphers
    (github.com/utelle/SQLite3MultipleCiphers) — actively maintained
    upstream, ships prebuilt binaries, supports AES-256 page
    encryption and the SQLCipher-compatible PRAGMA key API.
  - Zero custom crypto written by us; zero custom native builds; we
    swap one dependency and keep every existing DC-07 call site.
  - Sources: npmjs.com/package/better-sqlite3-multiple-ciphers;
    github.com/m4heshd/better-sqlite3-multiple-ciphers (active:
    CI releases through Aug 2026); github.com/utelle/
    SQLite3MultipleCiphers (upstream engine, SQLCipher-compat PRAGMA
    API documented in its wiki/docs).
  - Follow-up rule: pin the fork's major version in package.json and
    re-verify API compatibility on every bump (it tracks upstream
    better-sqlite3 releases with a lag).

3.6 WAL and sidecar files
  - SQLite3MultipleCiphers/SQLCipher encrypt the -wal and -shm
    artifacts as part of the encrypted database session (the page
    codec applies to all database files of the connection). Wording
    note for implementers: the -shm file is a shared-memory index and
    is NOT meaningfully sensitive, but we do not rely on that; treat
    all calendar.db* siblings as encrypted output. No plaintext
    spill files are created by the sidecar.

==================================================
3A. EXACT CRYPTOGRAPHIC CONFIGURATION (v2)
==================================================

Chosen profile: the **"sqlcipher" compatibility scheme** of
SQLite3MultipleCiphers, which in current versions uses **ChaCha20-
Poly1305 AEAD** page encryption (256-bit key):
  - PRAGMA cipher  = 'sqlcipher' (compat profile), then PRAGMA key.
  - AEAD means every page carries an authentication tag: bit-flips or
    tampered pages are DETECTED at page decode time, not silently
    decrypted. Rationale: plain AES-256-CBC encrypts but provides NO
    integrity — a tampered page decrypts to plausible garbage. The
    owner's requirement "tampering or corruption is detected" rules
    plain CBC out. (If an AES-native AEAD profile is preferred at
    implementation time, SQLite3MultipleCiphers' ascon/other AEAD
    profiles may be substituted — the requirement is AEAD, the exact
    primitive is negotiable; see OPEN O4.)
Detection behavior: a wrong key OR a tampered/corrupted page surfaces
as SQLITE_NOTADB or a page-decode error on open/read. The app MUST
fail closed: refuse to open the database, show a recovery message
(pointing at the last backup / .ics export), and NEVER auto-recreate,
auto-decrypt, or auto-recover over the encrypted file. A tampered DB
must never silently turn into a truncated-but-openable one.
KDF: profile default (PBKDF2-HMAC-SHA512, 256k iterations in current
sqlcipher-compat scheme) — exact parameters recorded at implementation
time; tuning only per OPEN O1.
Key: 256-bit from crypto-grade RNG (§4.1).

==================================================

4.1 Generation and storage (binding)
  - A 256-bit random key is generated at first run (crypto-grade RNG,
    generated inside the process that stores it).
  - Stored in the OS keystore via the existing DC-05 mechanism (Tauri
    keyring API; Secret Service/kwallet on Linux — DC-15 §3.2).
    Same service/entry conventions as the identity key, distinct
    entry (e.g. service "tide", account "db-key").
  - NEVER written to disk plaintext, NEVER logged (no debug prints,
    no error messages carrying the key, no crash dumps of the args),
    NEVER included in .ics exports, sync traffic, or backups. The key
    protects the LOCAL file only; it never leaves the device.

4.2 Delivery to the sidecar — DECISION
  DIRECTION CHOSEN: the Rust shell reads the key from the keystore
  and passes it to the sidecar over the EXISTING stdio handshake as
  one line before/at session start, and the sidecar erases it from
  memory-borne request structures after applying PRAGMA key.
  Justification:
    - One custody path: the shell already owns keystore access
      (DC-05 keyring code lives there); the sidecar would otherwise
      need its own keystore client in Node, duplicating secret-access
      code and keyring quirks per desktop environment.
    - The stdio channel is already the sidecar's transport (DC-15
      §3.4); a single handshake line adds no new IPC surface.
    - Explicitly NOT an environment variable: /proc/<pid>/environ is
      readable by same-user processes and leaks into crash reports
      and some launchers; env vars are a known key-leak vector.
  DOCUMENTED FALLBACK (not chosen): the sidecar reads the keystore
  directly at startup. Keep this as the fallback if the stdio
  handshake proves awkward (e.g. a future headless mode with no Rust
  shell); it is acceptable but duplicates keystore plumbing.

4.3 Handshake shape (implementation guidance, not wire-frozen)
  - Line 1 from shell: a JSON object {"op":"db_key","key":"<base64>"}
    on stdin; sidecar replies {"ok":true} then proceeds to open the
    DB with PRAGMA key. Failure to deliver => sidecar exits with a
    nonzero code and a message that names the operation, never the
    key. The key string must not appear in any log line; log at most
    "db key received/rejected".

==================================================
4A. KEY LIFECYCLE (v2 — product decisions, binding)
==================================================

  - FIRST RUN: generate 256-bit key; store in OS keystore (DC-05
    entry, service "tide", account "db-key"); open/create DB with it.
  - NORMAL STARTUP: shell reads key from keystore -> stdio handshake
    -> sidecar PRAGMA key -> DB opens. Key never persisted outside
    the keystore.
  - KEY MISSING / KEYSTORE UNAVAILABLE: the DB cannot be decrypted.
    The app MUST fail with recovery guidance (check backups, .ics
    export) and MUST NEVER generate a fresh key over an existing
    encrypted DB — that would be silent data loss disguised as a
    reset. An absent key = permanently unreadable DB unless the user
    has a backup. This is a deliberate security trade-off.
  - OS KEYSTORE RESET (user resets/deletes keyring): same as missing —
    unreadable DB. This is why .ics export exists: the user's data
    escape hatch is the DATA export, not the DB file.
  - UNINSTALL / REINSTALL: default uninstall never touches the
    keystore (DC-15 §3.5) — so reinstall re-reads the key and the DB
    reopens intact. DC-15 "Remove everything" purge deletes BOTH the
    keystore entry and the DB file = documented, confirmed, total
    data loss. Intentional.
  - BACKUP / RESTORE: the key is NEVER part of any backup. Therefore
    an encrypted DB backup is DEVICE-BOUND: restoring it on another
    machine (or after a keystore purge) is impossible without the
    key, and v1 provides NO key-export UX. Same-device restore from
    a pre-existing backup works because the keystore key survives.
    Stance: accepted for v1; key-export UX deferred (see §8, trigger:
    owner request or multi-device restore demand).
  - MIGRATION TO ANOTHER DEVICE: done via .ics data export (planned
    DC) — NOT by copying the DB file. A copied DB without the key is
    unreadable BY DESIGN. Sync pairing is the primary data-transfer
    path between Tide devices.
  - KEY ROTATION: deferred (§8); the §5 safe-copy machinery is the
    future re-encrypt path.

==================================================
5. MIGRATION OF EXISTING PLAINTEXT DATABASES
==================================================

  - Existing installs may have a plaintext calendar.db (this repo's
    dev databases; TD-003-era legacy DBs). At sidecar startup, before
    normal ops: detect whether the DB at TIDE_DB_PATH is encrypted
    (SQLite3MultipleCiphers exposes whether a database is encrypted;
    failing PRAGMA key on a plaintext file is also detectable). If
    plaintext and a key is available, run the one-time re-key.

5.1 Guaranteed migration path: ATTACH + safe copy
  - Open the plaintext DB read-only, ATTACH a new temp file
    (calendar.db.migrating) with the key applied, then copy all
    objects (schema + data) from source to the encrypted target.
  - Verify: row counts / a checksum query across core tables
    (DC-07 tables) match between source and target.
  - Atomic switch: on verify success, keep a pre-migration backup of
    the plaintext file (calendar.db.pre-encrypt) until verify has
    passed in the SAME run, then fsync + rename the encrypted file
    over the original path and delete the backup. Any failure leaves
    the original untouched and aborts startup with a clear error.
  - Rationale: SQLite3MultipleCiphers documents PRAGMA rekey for
    in-place re-encryption, but this contract's spot check of the
    fork's README did not conclusively confirm rekey coverage through
    the fork's API for all cipher configurations; the ATTACH+safecopy
    path is guaranteed by plain SQLite semantics and is therefore the
    REQUIRED path. PRAGMA rekey may be adopted later only after an
    explicit verified test, as an optimization.

==================================================
5A. PLAINTEXT-LEAKAGE HANDLING DURING MIGRATION (v2)
==================================================

Invariant: after a SUCCESSFUL migration, NO plaintext calendar.db*
file may remain in the data directory. Files to handle:
  - calendar.db          original plaintext: deleted only after the
                         verify step passes.
  - calendar.db-wal/-shm MUST be checkpointed (wal_checkpoint(TRUNCATE)
                         on the plaintext connection) BEFORE the copy,
                         then deleted together with the original after
                         verify — a leftover plaintext -wal is a leak.
  - calendar.db-journal  same handling as -wal if present.
  - calendar.db.migrating (encrypted target): atomic rename over the
                         original on success; deleted on failure.
  - calendar.db.pre-encrypt (plaintext backup): kept until verify
                         passes in the SAME run, then deleted. Residual
                         window: between verify success and backup
                         deletion, a crash leaves BOTH files — startup
                         re-runs cleanup (detect: .pre-encrypt exists +
                         main DB is encrypted => backup is stale, delete
                         it after a second verify).
  - SQLite temp/sort files: live in the OS temp dir, not the data dir;
                         migration should set PRAGMA temp_store=MEMORY
                         where feasible and document that OS-managed
                         temp cleanup applies elsewhere.
  - Crash recovery: a crash mid-migration leaves the original
                         plaintext DB + a partial .migrating target.
                         Startup re-detects plaintext, deletes the
                         stale .migrating, and re-runs migration
                         idempotently. No user data is lost at any
                         point — the original is never modified in
                         place.
  - Test requirement: post-migration, the data dir contains ONLY
                         calendar.db (encrypted) — grep/file-type
                         assertion in the future-verification checklist
                         (§9).

5.2 TD-003 interplay
  - Legacy dev-* identity databases may be encountered during the
    same first-run migration window. The DB re-key (this contract)
    and the identity migration (TD-003) are INDEPENDENT transformations
    but share the startup sequence: TD-003 identity migration MUST be
    resolved/ordered before the first shipping upgrade per DC-15 §3.5;
    the re-key must tolerate a DB that also carries legacy identity
    rows and not reorder sync semantics (DC-07 is unchanged by
    encryption).

==================================================
6. PERFORMANCE, WAL, EXPORT HYGIENE
==================================================

  - Owner has accepted the encryption overhead (AES-256 page codec);
    no feature may be proposed to "turn it off for speed". If a real
    workload bottleneck appears, the escalation path is KDF/parameter
    tuning (OPEN item O1), never disabling encryption.
  - WAL mode remains in use; -wal is encrypted per §3.6.
  - .ics export, sync payloads (DC-08), and user-initiated backups
    contain only calendar DATA the user asked to move — never the
    key, never a decrypted DB image beyond the explicit need of the
    operation. Diagnostic bundles must never include calendar.db* or
    keystore dumps.

==================================================
7. PER-PLATFORM CUSTODY
==================================================

  - Linux (primary, shipping): OS keystore via DC-05 mechanism —
    Secret Service (GNOME Keyring) / KWallet through the Tauri
    keyring API (DC-15 §3.2). Headless fallback file remains
    deferred/not approved per DC-15 §3.2.
  - Windows (future, per DC-15 §4): Windows Credential Manager
    (DPAPI-backed); same stdio delivery. Details land with the
    Windows port work.
  - Android (future): Android Keystore; timing OPEN (O2). The
    mechanism contract (keystore custody + process-local delivery)
    is designed to port as-is.

==================================================
7A. PLATFORM/BUILD FEASIBILITY (v2 — design-level, risk-flagged)
==================================================

  - Linux (PRIMARY): fork ships prebuilt node addons for glibc x64 —
    compatible with the in-bundle sidecar (DC-15). musl/Alpine NOT a
    target. Risk: LOW.
  - Windows (future): fork publishes prebuilt Windows x64/x86 node
    addons; design-compatible with DC-15 §4. Risk: LOW-MEDIUM —
    prebuilt coverage must be re-verified at implementation time
    against the then-current fork version.
  - Android (future): RISK HIGH / ARCHITECTURAL — running the Node
    sidecar on Android is unproven territory (nodejs-mobile-style
    embedding vs. the Tauri mobile stack). If it proves infeasible,
    the fallback is a Rust-side DB layer (rusqlite with a
    sqlcipher/multiple-ciphers feature) — a significant but
    contained re-plumbing of the persistence boundary, NOT a change
    to this contract's crypto/key decisions. Recorded as a platform
    risk, not a redesign now.
  - TS/SQLite stack: drop-in fork, API-compatible with existing
    better-sqlite3 call sites (DC-07 unchanged). Risk: LOW.
  - Tauri/Rust: no Rust-side changes for Linux/Windows (DB lives in
    the Node sidecar; key custody already in the Tauri keyring per
    DC-05). Risk: LOW.

==================================================
7B. KEY-HANDOFF THREAT MODEL (v2 — proportionate)
==================================================

Scope assumption: per §1.2, same-user local attackers and root
compromise are OUT of scope. The handoff threat model covers
accidental exposure, not a compromised host.

  - Logging: the key is never logged. Error messages name the
    operation ("db key rejected"), never the value. Log scrubbing
    test in §9.
  - Diagnostics: diagnostic bundles never include stdin captures,
    environment dumps, or keystore extracts.
  - Key lifetime in memory: the shell holds the key only between
    keystore read and handshake write; the sidecar uses it only for
    PRAGMA key, then releases it to GC. Honest JS limitation: memory
    zeroing is best-effort, not guaranteed (GC copies may linger) —
    accepted; the at-rest threat model does not require memory
    hygiene against a live-process attacker.
  - Child-process authenticity: the stdio pipe is inherited by the
    child we spawned with our own argv over our own binary; the
    sidecar has no network listener. A same-user attacker who can
    hijack the spawn is already out of scope (§1.2). Adequate as-is.
  - Accidental persistence: the key must never reach config files,
    localStorage, logs, persisted UI state, or sync traffic. After
    PRAGMA key, the encrypted DB file does not contain the key.
    Verification: post-run scan of the data dir + config surfaces
    for the key bytes (in §9 checklist).

==================================================
8. DEFERRED WITH TRIGGERS
==================================================

  - Key rotation UX: deferred until a compromise/rekey need is proven
    (stolen keystore, user request). The migration machinery (§5)
    already gives us the safe-copy pattern to re-encrypt under a new
    key; nothing in the schema or delivery design blocks adding
    "rotate key" later. Trigger: owner request or a real incident.
  - Plaintext-header / partial-encryption options (encrypt pages but
    leave the header recognizable): deferred; only relevant if a
    third-party tool ever needs to identify the file type. Trigger: a
    concrete interoperability requirement appears.
  - Per-field/per-column encryption on top of page encryption:
    deferred; rejected in §3.4 for now. Trigger: a regulatory or
    sharing requirement that demands field-level segregation beyond
    full-file encryption.
  - Key-export UX (making encrypted-DB backups portable across
    devices): deferred. Trigger: owner request or a real multi-device
    restore need. Until then, backups are device-bound (§4A).

==================================================
8A. FUTURE VERIFICATION REQUIREMENTS (v2 — implementation gate)
==================================================

When DC-17 enters implementation, ALL of the following must be tested
before it ships. This checklist is binding for the implementation
package:

  1. Encrypted create/open: fresh DB created encrypted; reopen with
     key works; file header is NOT a plaintext SQLite header.
  2. Wrong-key rejection: opening with a wrong key fails closed
     (SQLITE_NOTADB / decode error) with the recovery message —
     never a silently truncated/openable DB, never an auto-recovery.
  3. Tamper detection: flip bytes in the encrypted file at various
     offsets → open/read fails closed; no silent corruption path.
  4. WAL/journal encryption: -wal/-shm exist only as encrypted
     output during normal operation (no plaintext page spills).
  5. Crash-safe migration: kill the process mid-migration at random
     points (bounded loop, e.g. 10 iterations) → restart always
     recovers: plaintext original intact, migration re-runs,
     completes.
  6. Plaintext-cleanup invariant: after successful migration, the
     data dir contains ONLY the encrypted calendar.db* — no
     plaintext .db/.wal/.shm/.journal/.pre-encrypt/.migrating files
     remain.
  7. Backup/restore: same-device restore from an encrypted backup
     reopens with the keystore key; cross-device restore without
     key correctly FAILS closed (documents the device-bound stance).
  8. Key-loss behavior: delete the keystore entry → app refuses to
     open the DB with recovery guidance; NEVER auto-generates a new
     key over the existing file.
  9. Windows/Linux run: full flow on both (per DC-15 §4 scope);
     Android explicitly out of scope per §7A risk.
 10. KDF/parameter defaults recorded in the release notes
     (completes OPEN O1's baseline).
 11. Log/diagnostic scrubbing: forced-error runs produce no key
     bytes in logs or bundles (§7B).
 12. Persistence scan: post-run scan of data dir, config, and
     localStorage finds no key bytes (§7B).

==================================================
9. DECISIONS
==================================================

DECIDED:
  D1. Mechanism: SQLite3MultipleCiphers via the better-sqlite3-
      multiple-ciphers drop-in fork (page encryption, SQLCipher-
      compatible PRAGMA API). No custom crypto, no custom native
      builds. SEE, SQLCipher source builds, filesystem encryption,
      and field-level crypto are all rejected (§3).
  D2. Key custody: 256-bit key generated at first run, stored in the
      OS keystore via the DC-05 mechanism; never on disk plaintext,
      never logged, never in exports/backups/sync traffic (§4.1).
  D3. Key delivery: Rust shell reads the keystore and hands the key
      to the sidecar via a one-line stdio handshake (NOT env vars —
      /proc/PID/environ leak). Direct sidecar keystore access is the
      documented fallback (§4.2).
  D4. Migration: one-time, atomic, guaranteed-path ATTACH+safecopy
      re-key of existing plaintext DBs at startup, with a
      pre-migration backup kept until verify passes; original
      untouched on any failure (§5.1). PRAGMA rekey only after a
      verified test, as an optimization.
  D5. Export hygiene: .ics/export/backup/diagnostic paths never
      embed the key and never produce a decrypted DB image beyond
      the operation's explicit need (§6). Performance overhead is
      owner-accepted; never traded away.
  D6. Crypto configuration (v2): an AEAD profile — the sqlcipher-
      compat scheme (ChaCha20-Poly1305) or an equivalent AEAD — is
      REQUIRED; plain AES-CBC (no integrity) is rejected. Tampering/
      corruption is detected at page decode and the app fails CLOSED
      (refuse to open, recovery guidance, never auto-recover).
      KDF: profile defaults; tuning only per O1. (§3A)
  D7. Key lifecycle stance (v2): missing/lost key = permanently
      unreadable DB, app fails with recovery guidance and NEVER
      regenerates over an encrypted DB; keystore survives default
      uninstall; "Remove everything" purge = confirmed total data
      loss by design; v1 has NO key-export UX — encrypted backups
      are device-bound; cross-device migration is via .ics data
      export, not DB copies. (§4A)
  D8. Migration plaintext-cleanup invariant (v2): after successful
      migration, no plaintext calendar.db* file (db, -wal, -shm,
      -journal, .pre-encrypt, .migrating, temp) remains in the data
      dir; crash mid-migration is recoverable and idempotent.
      (§5A)

OPEN:
  O1. Exact KDF parameters (iterations/memory, cipher config beyond
      AEAD) — defaults now; tuning only if a measured workload
      bottleneck appears.
  O2. Android Keystore timing — lands with the Android port, not
      before (§7). NOTE: Android also carries the §7A architectural
      risk (Node sidecar on Android unproven; Rust-side fallback
      identified).
  O3. Whether to adopt upstream better-sqlite3 directly IF it ever
      gains first-class encryption — revisit on that upstream change;
      until then the fork stays pinned and version-checked.
  O4. AEAD primitive selection within SQLite3MultipleCiphers
      (sqlcipher-compat ChaCha20-Poly1305 vs another AEAD profile) —
      requirement is AEAD, exact primitive finalized at
      implementation with vector tests.
