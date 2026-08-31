# Proposal: three Tide devices on one machine — real pairing + Noise-XX-over-TCP sync harness

Status: investigation only (no production code changed). Proposal supported by a
completed end-to-end smoke run (see "Evidence" below) on this machine.

## TL;DR

No new protocol, no production code, no Tauri shell needed. The smallest realistic
harness is **three independent `dist/sidecar.mjs` Node processes**, each with its own
temp directory (own SQLite DB + own Ed25519 identity key), each pinned to its own
loopback TCP port via `TIDE_SYNC_PORT`, driven over the existing **stdio JSON-RPC
surface** with four ops:

1. `device_info` — read device_id + force listener startup
2. `pairing_offer` / `pairing_accept` — real DC-05 ceremony over real Noise_XX TCP
3. `sync_now {host, port}` — real DC-08 anti-entropy session over real Noise_XX TCP
4. `list_events` — convergence oracle read-back

Everything the harness needs already exists in the production sidecar. What is missing
is only a **driver script** (the "Tauri GUI stands-in": spawns 3 sidecars, shuttles
`qr_text` between them, issues `sync_now`), plus a **report formatter**. That driver is
test-harness code, not product code.

## Why this is the real protocol (not mocks)

- `SyncManager.ensureListener()` (src/persistence/bridges/sidecar_server.ts:117) calls
  `serveSync(identity.privateKey, port)` — a real `net.Server` hosting Noise_XX
  handshakes. Port comes from `TIDE_SYNC_PORT` env (line 112) or `SYNC_DEFAULT_PORT`;
  a fixed env port per instance is the deterministic multi-instance mechanism.
- `pairing_offer` → `createPairingOffer()` (src/network/pairing_manager.ts:107) opens a
  one-shot Noise_XX TCP listener and returns `qr_text` embedding
  `connect: { ip, port }` + device_id + public key + nonce.
- `pairing_accept {qr_text}` → `acceptPairingPayload()` connects out over TCP, completes
  Noise_XX, verifies remote static against the announced key, binds the transcript,
  computes the safety number, and stores trust in the `peers` table (the same path the
  GUI uses).
- `sync_now {host, port}` → `connectSync()` + `runEngineSession()` — exactly the DC-08
  bidirectional anti-entropy session (responder runs its own pull; see pkg5c header for
  the session-independence semantics that the harness must respect: the initiator's
  resolution does NOT mean the responder finished — the report driver must await
  settle/apply completion before asserting convergence, as sc9 does).

## Instance isolation (per device)

Each of the three instances gets:

| Env var          | Role                                              |
|------------------|---------------------------------------------------|
| `TIDE_DB_PATH`   | own SQLite DB (`<tmpdir>/<device>/tide.db`)       |
| `TIDE_DATA_DIR`  | own Ed25519 identity (`device_identity.key`) — sidecar main() derives identity from `TIDE_DATA_DIR ?? dirname(TIDE_DB_PATH)`; either var alone suffices |
| `TIDE_SYNC_PORT` | own fixed loopback listener port                  |

Spawn: `node dist/sidecar.mjs` with `stdio: ['pipe','pipe','inherit']`. **Pre-create the
per-device directory before spawn** — the sidecar does not mkdir it
(`loadOrCreateIdentity` ENOENTs otherwise; this bit the smoke run first).

Deterministic port allocation: pick a fixed reserved band (probe convention uses
41000–41999; sc9/sc5c use 41060+/41310+). A static band like 41900–41999 for this
harness avoids collisions with existing tests. `EADDRINUSE` is logged, not fatal, but
the listener then never starts — the harness should verify the advertised
`listening_port` from `device_info` and fail fast if the bind lost the race.

## Harness flow (driver pseudocode, ~150 LOC)

```
for name in [A,B,C]:  spawn sidecar(name, dir=tmp/<name>, port=4190n)
    rpc("device_info")            # confirms identity + listener port
    rpc("create_event", {input:{...}})   # seed one distinct event per device

pair(A,B):
    {qr_text} = A.rpc("pairing_offer", {name:"A"})
    accept = B.rpc("pairing_accept", {qr_text, name:"B"})   # real TCP Noise_XX
pair(A,C):  same shape (fresh offer; an offer settles after ONE scanner)

converge:  # hub topology: B<->A<->C
    B.rpc("sync_now", {host:"127.0.0.1", port:41901})
    C.rpc("sync_now", {host:"127.0.0.1", port:41901})
    A.rpc("sync_now", {host:"127.0.0.1", port:41902})
    A.rpc("sync_now", {host:"127.0.0.1", port:41903})
    B.rpc("sync_now", {host:"127.0.0.1", port:41901})   # final round
    C.rpc("sync_now", {host:"127.0.0.1", port:41901})

oracle: titles = list_events() per device → must be identical on all three
report: JSON per-step evidence (device_ids, safety numbers, sync stats, titles)
```

Note on `sync_now` stats shape (observed, useful for the report):
`{sent, receivedApplied, receivedBuffered, receivedDuplicate, receivedQuarantined,
receivedDroppedIntake, remote_device_id:"x25519:<hex>"}` — the `x25519:` prefix on
`remote_device_id` is direct proof the session ran through the real Noise transport.

Pairing topology for 3 devices: a hub (A–B, A–C) plus 4 `sync_now` rounds converges all
three. A full triangle (all three pairwise offers) is also possible but needs no
sessions beyond the hub for convergence; prefer hub unless the scenario tests
transitivity specifically.

## Determinism notes / caveats found

1. **QR IP is the LAN address, not 127.0.0.1.** `makePairingPayload` embeds
   `localIpHint()` (first non-internal IPv4, sync_runtime.ts:330). On a single machine
   that address still routes locally (smoke run proved it), but the pairing listener
   binds on all interfaces — acceptable locally, worth one line in the report.
2. **One offer = one scanner.** `createPairingOffer`'s result settles when a scanner
   completes; pair each ordered pair with a **fresh offer** (the smoke run does this for
   A–B then A–C). Offers are tracked/cancelled by `cancel_pairing_offer` and killed at
   stdin-EOF — no residue if the driver kills the process tree.
3. **Two engine runs per sync session.** Per DC-08 §4, responder and initiator pull
   independently; `sync_now`'s returned stats cover only the initiating side. The
   harness converges with enough `sync_now` rounds (hub round + return round) rather
   than racing server-side internals it cannot see through the RPC surface.
4. **Connect watchdog is tunable:** `TIDE_SYNC_CONNECT_TIMEOUT_MS` exists for ops/tests
   (sidecar_server.ts:612) — set it (e.g. 500–2000 ms) for fast deterministic failure on
   dead peers.
5. **Scheduler runtime logs "runtime started" and sweep is UNWIRED/no-op** — periodic
   sweep does nothing today, so convergence must be driven entirely by explicit
   `sync_now` calls (matches the sidecar's own docs, sidecar_server.ts:925–931: mDNS
   browse is not yet plumbed; peers have no endpoints, so automatic sessions never
   fire). This is why `sync_now` with explicit host:port is the correct driver op.
6. **noise-c.wasm URL warning is benign** ("Failed to parse URL … falling back to
   ArrayBuffer instantiation") — stderr noise, no functional impact.
7. **stdout carries ONLY JSON-RPC envelopes**; logs go to stderr. A line-oriented
   driver with a strict JSON.parse-per-line parser is robust (the smoke run's only
   harness bug was its own flush logic, not the sidecar).
8. `create_event` takes `args.input` (validated event fields), not bare args; `list_events`
   takes `{from_ms, to_ms}` and returns a bare event array. Both pinned by the smoke run.

## Where the harness should live

Recommended: `tests/probes/` alongside sc9/sc5 (`sc10_three_devices.test.ts` or a
standalone script `scripts/harness_three_devices.mjs` producing an owner-visible JSON +
markdown report under `docs/qa/`). It can reuse `tests/probes/sync_probe_helpers.ts`'s
oracle conventions, but must spawn real sidecar processes (unlike sc9, which runs
engines in-process over serveSync/connectSync — good TCP coverage of the transport, but
not the full sidecar process boundary this owner scenario asks for).

## Evidence (smoke run on this machine, 2026-08-31)

Script: `/tmp/tide-3dev-smoke.mjs` (throwaway; final harness belongs in the repo per
above). Output summary:

- 3 sidecars, distinct device_ids, listening on 41901/41902/41903.
- Paired A↔B and A↔C with real safety numbers (5-digit groups printed both sides).
- `sync_now` sessions returned real Noise `x25519:` remote ids and applied changes
  (receivedApplied 2 / 4).
- Final oracle: all three devices report events `[from-A, from-B, from-C]` — full
  three-way convergence through the production pairing + sync path.

## Recommended deliverables (next step, still no production changes)

1. `scripts/harness_three_devices.mjs` (or vitest probe) implementing the flow above,
   with per-device temp dirs, fixed port band, fast-fail binds, and strict stdio
   framing.
2. Report artifact: JSON (raw evidence) + short markdown digest (device_ids, pairing
   safety numbers, sync stats, oracle digests, wall-clock timings) for the owner.
3. Optional hardening knobs: `TIDE_SYNC_CONNECT_TIMEOUT_MS`, per-step deadlines, and a
   process-tree teardown (`cancel_pairing_offer` + SIGKILL + rmSync) to guarantee no
   orphan listeners survive a failed run.
