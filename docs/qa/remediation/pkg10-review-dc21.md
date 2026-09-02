# Pkg10 Review — DC-21 mDNS endpoint plumbing (Blind Review #1)

Reviewer: subagent #1. Scope: DC-21 files only. Repo read-only.
Status: IN PROGRESS — findings written incrementally.

## Findings

### F1. CRITICAL (startup crash): `app.state::<BrowseService>()` used before `app.manage(BrowseService::new())`
- **File:** `src-tauri/src/lib.rs:693` (manage happens later at `:716`)
- The sidecar-ready block calls `app.state::<mdns_service::BrowseService>()` synchronously inside `.setup(...)` **before** `app.manage(mdns_service::BrowseService::new())` runs further down the same closure. Tauri's `Manager::state()` **panics** when the type has not been managed.
- Consequence: every successful sidecar spawn (i.e. every normal launch) panics the setup closure → app fails to start. This block is also NOT feature-gated (only the browse-loop start below is), so it fires regardless of the `mdns` cargo feature.
- Fix: `app.manage(mdns_service::BrowseService::new())` must execute before the sidecar-spawn/ping block.

### F2. HIGH (feature broken + protocol mismatch): notification dispatch never triggers — `"id": null` fails the `req.id === undefined` check
- **Files:** `src-tauri/src/sidecar.rs:133` (`json!({"id": null, "notification": "mdns_event", ...})` writes an explicit `null` id) vs `src/persistence/bridges/sidecar_server.ts` (handleLine notification guard is `typeof req.notification === "string" && req.id === undefined`).
- `JSON.parse('{"id":null,...}')` yields `id === null`, not `undefined`. So every `mdns_event` notification falls through to the op path, throws `"missing op"`, and an **error envelope with `id: null` is written to stdout** — exactly the stdout corruption the code comment claims to prevent.
- Two effects:
  1. `mdns_event` is never routed to the dispatcher; the endpoint cache stays permanently empty and the scheduler runs last-known-only. The DC-21 bridge is functionally dead on the push path.
  2. The Rust reader (`sidecar.rs read_loop:205`) can't resolve `id: null` to a pending caller (parse_id → None) → logs `"sidecar response missing id"` warn per event. No crash (reader tolerates it), but log spam and a lying comment; the "return \"\" — write nothing" mechanism never executes.
- Fix: guard should be `req.id == null` (or `=== undefined || === null`), and/or Rust should omit the id field entirely. Verified safe: the Rust reader does skip empty lines and non-JSON lines (sidecar.rs:197-207), so IF the guard were fixed, `return ""` + skip-write would be correctly parsed (nothing is written for notifications).

### F3. MEDIUM (D3 hardening / resource leak): D3 identity-mismatch throw leaks the Noise socket
- **Files:** `src/persistence/bridges/sidecar_server.ts` (runEngineSession D3 check throws BEFORE the engine block), `src/application/scheduler_runtime.ts` (makeSessionOpener has no try/finally around `deps.runSession(session)`).
- On a spoofed endpoint presenting a wrong static key, `runEngineSession` throws before the `session.done()` finally-block is entered, and `makeSessionOpener`/`withTimeout` never close the session → the TCP + Noise socket to the attacker's server is leaked. Repeated spoof attempts (cheap for an attacker) exhaust file descriptors in the sidecar.
- D3 enforcement itself IS correctly on the scheduler path (traced: scheduler `openSession({deviceId, endpoint})` → `makeSessionOpener` sets `session.deviceId` → `runSession` wrapper → `runEngineSession(session, session.deviceId)` → trust-store `SELECT ... AND status='trusted'` + x25519 comparison → throw before `runSession`). Trust semantics are sound; only cleanup is missing. Wrap in try/finally: `try { await deps.runSession(session) } finally { session.done() }` (or move the D3 check inside the existing finally scope).

### F4. MEDIUM (unbounded growth): Rust snapshot buffer never dedupes and never records removals
- **File:** `src-tauri/src/mdns_service.rs:154-158` (`record`), `:204-215` (browse loop always emits `kind: "added"`).
- `record()` appends to `self.snapshot: Vec<MdnsEvent>` on **every** observation of **every** browse cycle (25s); nothing dedupes by `instance_name` and nothing removes departed services (no `removed` events exist anywhere in the Rust path). Over hours: ~140+ entries/service/hour, replayed **in full** at every sidecar restart via `push_snapshot` (which sends each duplicate as its own mdns_event — sidecar-side idempotency masks it, but memory + push volume grow without bound).
- Fix: keep a `HashMap<instance_name, MdnsEvent>` (last observation wins, insert-ordered for determinism), matching the sidecar cache's semantics.

### F5. LOW (dead code / contract drift): `verifyPeerIdentityAgainstTrustStore` and the `mdns_snapshot` dispatcher branch are unreachable
- `src/network/endpoint_bridge.ts:160-173` — exported D3 helper is never imported/called (sidecar_server implements its own inline equivalent, with an important difference: the live version correctly converts the trust-store ed25519 key via `ed25519ToX25519PublicKey`, while the dead helper compares raw strings against rows that would be ed25519 — a future caller of the helper would always fail).
- `mdns_snapshot` op in `combinedWithMdns` is never sent: contract §3.2(b) specifies sidecar→Rust pull, implemented (documented in mdns_service.rs) as a Rust→sidecar push of `mdns_event`s. Documented deviation is acceptable, but the dead `mdns_snapshot` branch + dead `applySnapshot` seed path should either be wired or removed.

### F6. LOW (perf): `listTrustedPeers(core.db)` re-queried per peer inside `lastKnown` (N+1) and twice per scheduler sweep (`pairedDeviceIds()` also re-queried per `mdns_event`). Harmless at Tide's peer counts.

## D3 security assessment (priority 1)
- **No code path treats host/port as identity.** Endpoints only flow into: cache (hint), `resolveEndpoint` (dial target), `recordPeerEndpoint` (persist — see D6 below). Trust decisions come only from the Noise handshake + trust store.
- **Scheduler path enforces D3**: spoofing an `instance_name` prefix gets the endpoint cached (a hint — allowed), but a session to the attacker's server presents their x25519 static, which fails the `SELECT public_key FROM peers WHERE device_id = ? AND status='trusted'` comparison → throw before `runSession` → nothing exchanged, nothing persisted. Session stats return path unreachable on mismatch.
- **Spoofed endpoint persistence**: impossible — `recordPeerEndpoint` only runs after a successful `runEngineSession`, and on the scheduler path success implies the D3 key check passed. Attacker cannot seed `peers.last_endpoint_*` with their own host/port.
- Residual: socket leak on rejection (F3) is the only exploitable angle found.

## D6 assessment (priority 2)
- Pass. Write paths: only `runEngineSession` success → `recordPeerEndpoint`. `sync_now` (manual) resolves `remoteDeviceId` but has no `dialEndpoint` → no write (correct per §4.2 "explicit host/port" is fine either way). No browse-result-to-DB path exists: prefiltered non-paired events return before the cache; cache is in-memory only. Browse removal does not touch DB (cache delete only). Minor nit: `recordPeerEndpoint`'s UPDATE lacks `AND status='trusted'`, but both call sites derive the id from a trusted lookup — currently unreachable for revoked peers.

## Cache correctness (priority 3)
- TTL: `expiresAt = now + max(0, ttl_ms)`; stale entries skipped in `getForDevice` and never shadow last-known (D7 ✓). Expired entries linger in the Map (never swept) — cosmetic memory only.
- Instance collisions: keyed by instance_name; 32-bit prefix + 4 random hex → collisions practically impossible; a second instance for the same device just adds an entry, `getForDevice` picks Map-order-first — deterministic per insertion, acceptable.
- Restart idempotency: re-seed cannot duplicate (Map keyed by instance_name) ✓.
- Empty-stdout / Rust reader: reader skips blank lines and warns on unparseable/id-less lines — safe once F2 is fixed; today F2 makes every notification produce a spurious stdout line (warn-only on Rust side, no misparse).

## D7 assessment (priority 4)
- `resolveEndpoint`: live TTL-valid cache entry → last-known → undefined. Stale never shadows ✓. One nit: `getForDevice` returns the first matching entry rather than the most recently observed one when a device somehow has multiple live entries (contract §5.2 says "most recently observed host"); not reachable in practice while instance names are unique per device boot.

## Test results
- `vitest run tests/dc21_endpoint_bridge.test.ts tests/dc21_schema_migration.test.ts` → **14/14 passed** (828ms). Note: the dc21 endpoint_bridge tests exercise the TS cache/prefilter/verification logic only — they do NOT cover the Rust↔sidecar notification framing, which is exactly where F1/F2 live.
- `npx tsc --noEmit` → clean (exit 0).
- `vitest run tests/scheduler_runtime.test.ts tests/sidecar_identity_e2e.test.ts tests/pairing_stdio.test.ts` → **14/14 passed**.
- Rust: not compiled (repo read-only, no cargo run allowed); F1/F4/F2(Rust side) established by code reading of `lib.rs`/`mdns_service.rs`/`sidecar.rs`.

## Verdict
**REJECT — do not ship as-is.** The TS-side D3/D6/D7 semantics are correctly implemented (trust-store verification is genuinely enforced on the scheduler path before any exchange or persistence; no host/port-as-identity path exists; no browse-result-to-DB path), and all TS tests pass. But the Rust↔sidecar seam has two blockers: **F1** (guaranteed `app.state()` panic on every launch because `BrowseService` is managed after first use) and **F2** (`"id": null` vs `=== undefined` means mdns_event notifications are never dispatched — the endpoint cache stays empty and every event emits a spurious stdout error envelope). Additionally **F3** leaks a socket per spoofed-dial rejection — an attacker-reachable FD exhaustion vector, cheap to fix with try/finally. F1+F2+fixed, plus F3, would make this shippable.

### Finding index
| # | Severity | File:Line | Summary |
|---|----------|-----------|---------|
| F1 | CRITICAL | src-tauri/src/lib.rs:693 (manage at :716) | `state::<BrowseService>()` before `manage` → startup panic every launch |
| F2 | HIGH | sidecar.rs:133 / sidecar_server.ts handleLine | `id: null` ≠ `undefined` → notifications never dispatched; spurious stdout error envelope per event |
| F3 | MEDIUM | sidecar_server.ts runEngineSession + scheduler_runtime.ts | D3-mismatch throw leaks Noise/TCP socket (no finally) → FD exhaustion via spoofing |
| F4 | MEDIUM | src-tauri/src/mdns_service.rs:154 | snapshot Vec grows unbounded, no dedupe, no removals; full replay per restart |
| F5 | LOW | endpoint_bridge.ts:160, sidecar_server.ts mdns_snapshot branch | Dead code; dead helper has a latent ed25519-vs-x25519 comparison bug if ever wired |
| F6 | LOW | sidecar_server.ts listPeers/lastKnown | N+1 listTrustedPeers queries per sweep/event |
