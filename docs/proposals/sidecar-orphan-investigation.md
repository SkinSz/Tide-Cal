# Investigation: Sidecar Zombie/Orphan Lifecycle

Date: 2026-08-29 · Status: ROOT CAUSE FOUND (runtime-proven) · No production code changed.

## 1. Reproduced scenario (exact, evidence-backed)

1. Launch GUI normally (`cargo run`, sidecar spawned by lib.rs).
2. Open the Devices dialog (any op that triggers `ensureListener()` —
   `device_info` does it). Sidecar now LISTENS on TCP 47471.
3. `kill -9` the GUI app (simulates crash — Drop never runs).
4. RESULT: sidecar survives, reparented to `systemd --user`
   (PPid 1362), still holds port 47471. Classic orphan.

Without step 2 (no TCP listener), the same `kill -9` killed the sidecar
within ~2s — it died of stdin EOF. The listener is the difference.

## 2. Root cause (two independent layers, both confirmed)

**Layer A — Rust (why Drop doesn't fire):** `Sidecar` is managed via
`app.manage(SidecarState(...))`. On SIGKILL there is NO drop, NO wait,
NO stdin close — the app dies instantly. That part is inherent to a
hard kill; a parent-side Drop path can never cover it.

**Layer B — Node (why the sidecar does NOT exit on stdin EOF):**
- `sidecar_server.ts` main(): `rl.on("close", ...)` calls only
  `core.db.close()` and RELIES on the event loop draining ("let the
  event loop drain exits cleanly" — true only when no other refs).
- Once `serveSync()` has created the TCP server
  (`sync_runtime.ts:170`), that `net.Server` holds an ACTIVE event-loop
  ref. After stdin EOF + db.close(), the loop never drains: the process
  sleeps forever as an orphan, still listening on 47471.
- Verified live on the orphaned process: fd0 pipe write-end had NO
  holders (EOF delivered), no tide DB fd remained (db.close ran),
  process State=S, port 47471 still bound. SIGTERM killed it (default
  node handler) and freed the port.

So: Rust's Drop/kill path is fine for every graceful exit; the bug is
that the NODE side has no shutdown path once the sync listener exists.

## 3. Why the port stays blocked (consequence)

The orphan keeps 47471; the next GUI launch spawns a fresh sidecar whose
`ensureListener()` hits EADDRINUSE — the (already committed)
rejection-handler fix prevents the CRASH, but inbound sync stays dead
until the orphan is killed. The .catch() is a symptom patch, not a cure.

## 4. Fix options (design decision needed — owner picks)

Option 1 (recommended, smallest correct change): in
`sidecar_server.ts` rl.on("close"): after db.close(), close the sync
server (the runtime already returns `close()` — store it) and call
`process.exit(0)` if the loop still has refs. Semantics: stdin closed =
parent dead = sidecar must die. No arbitrary timeouts.

Option 2 (belt+braces, complements 1): set Linux
`prctl(PR_SET_PDEATHSIG, SIGTERM)` on the child pre-exec (libc crate)
so the kernel kills the sidecar when the parent dies. macOS/Windows
need per-OS equivalents (or skip: option 1 already covers them).

Option 3 (hardening, optional): port-in-use pre-check surfaced in the
GUI (owner-approved idea earlier) — stays relevant as a diagnostic even
after 1+2.

## 5. Regression test to add with the fix

Spawn real sidecar bundle with a dummy peer already LISTENING so
serveSync succeeds, feed stdin, close stdin (EOF), assert process exits
within N seconds (pre-fix: hangs forever while port stays bound).
Mirror of tests/ensure_listener_port.test.ts's child-process pattern.

## 6. Cleanup rule until fixed

`pkill -f 'dist/sidecar.mjs'` before any test run or relaunch (already
standard practice per handoff §1).
