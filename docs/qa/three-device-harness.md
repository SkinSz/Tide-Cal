# Three-Device Real Sync Harness — release verification probe

Status: **implemented** (test/QA infrastructure only — zero production code changes).

`tests/probes/three_device_harness.mjs` is the repeatable pre-release sync check that came
out of the investigation in `docs/proposals/three-device-noise-tcp-harness.md`. It turns the
proven smoke experiment into a deterministic, owner-facing harness.

## What it tests

Three (four, for the fresh-peer scenario) **real** `dist/sidecar.mjs` Node processes, each
with its own temporary SQLite database, its own Ed25519 identity, and its own fixed loopback
TCP port, driven over the production stdio RPC surface (`{id, op, args}` →
`{id, ok, result|error}`):

- real pairing ceremony (DC-05 `pairing_offer` / `pairing_accept` over real Noise_XX TCP)
- real safety numbers (returned by the accept side; trust verified on **both** sides via the
  peers table through `device_info`)
- real DC-08 bidirectional anti-entropy sessions over real Noise_XX TCP (`sync_now`), with
  the Noise-transport remote id (`x25519:<hex>`) recorded per session as transport proof
- real conflict machinery (unresolved conflict rows via `list_conflicts`)
- real resulting calendar state (via `list_events`)

### Real vs simulated

| Real | Simulated |
|---|---|
| sidecar processes, SQLite DBs, device identities, pairing, safety numbers, Noise-XX transport, TCP, sync, conflict/quarantine machinery, calendar state | three physical machines; human GUI interaction (the harness is the GUI stand-in); physical network separation (all loopback) |

## How to run

```sh
npm run sidecar:build        # required: (re)build dist/sidecar.mjs
npm run harness:three-device # or: node tests/probes/three_device_harness.mjs --scenario=all
```

Options:

- `--scenario=NAME|all` — `basic_three_way`, `independent_offline_changes`,
  `concurrent_modification`, `offline_peer`, `restart`, `fresh_peer`
- `--port-base=41900` — fixed port band (41900+); the whole band is pre-checked and the run
  fast-fails if a port is taken (no bind races)
- `--seed=N` — recorded in the report (scenarios are currently deterministic)
- `--keep` — keep per-scenario temp device dirs (for debugging; default: removed)
- `--inject-failure` — controlled-failure mode: deliberately corrupts the expected state of
  the first scenario to prove the harness detects failure (validation step)
- `--report-dir=DIR` — default `/tmp/tide-3dev-harness/reports`

Exit code 0 = PASS, 1 = FAIL, 2 = usage/environment error. Each run writes
`<report-dir>/<run>.json` (full evidence) and `<run>.md` (owner digest).

## Scenarios

1. **basic_three_way** — A creates 3 events; hub convergence; A == B == C == expected.
2. **independent_offline_changes** — A, B, C each create a distinct event offline; all three
   valid changes must survive on all devices.
3. **concurrent_modification** — shared event modified on the same field concurrently on B
   and C. Asserts the documented DC-03/DC-14 behavior: NO silent last-write-wins — each
   device keeps one of the two edits and records an **unresolved conflict row**. (Conflict
   *resolution* is an explicit human action on the GUI write path and is deliberately not
   RPC-exposed, so the harness cannot drive it; pre-resolution divergence is by design.)
4. **offline_peer** — C is stopped; A and B keep working; C restarts on the same
   db/identity/port (pairing persists); reconcile to the expected state.
5. **restart** — all three sidecars stopped and restarted; identities unchanged; state
   re-converges.
6. **fresh_peer** — a fresh device D pairs to A and bootstraps to the expected state.

## The oracle

The expected logical state is built **independently**: the harness records its own intent
(every `create_event`/`update_event` it issued and the acknowledged result) and compares
each device's `list_events` output against that expectation, requiring both

```text
A == Expected AND B == Expected AND C == Expected   (semantic correctness)
AND A == B == C                                     (convergence)
```

Nothing in the oracle is derived from the sync engine, snapshot/compaction code, or the
device databases.

## Determinism & cleanup

- fixed port band with pre-run availability check (fast-fail on conflict)
- `TIDE_SYNC_CONNECT_TIMEOUT_MS=1500` for dead-peer fast failure
- per-op RPC deadlines; per-session pacing; engine idle bound is 15 s
- temp dirs under `os.tmpdir()`; sidecars exit on stdin-EOF; failed runs are torn down
  completely (processes, listeners, dirs) unless `--keep`
- the PRNG seed is recorded (currently unused; knob for future variants)

## Known production-behavior findings surfaced by this harness (test-only, not fixed here)

- **Initiator-side sync session hang (flaky, direction-dependent).** A `sync_now` session
  can stall in `pull/CHANGES_BATCH` until the engine idle bound (15 s) while the *same*
  session's responder-side pull still transfers data. After such a stall, further sessions
  in that same initiator→responder direction repeatedly stall, while the reverse direction
  works. Evidence: initiator timeouts recorded in the harness session logs
  (`error: "…no message for 15000ms in pull/CHANGES_BATCH"`) with eventual convergence via
  reverse-direction sessions. The harness tolerates this: it drives both directions,
  re-checks the oracle after every round, and records every session error in the report.
  If a future change makes this hang impossible, `drive_rounds` should collapse to 1 and
  session errors to 0.

## Interpreting a failure

The JSON report contains, per scenario: device ids, pairing results + safety numbers,
every sync session (with Noise transport proof and error strings), the expected state, the
observed state per device (with field-level diffs), convergence and semantic verdicts, and
sidecar stderr tails. `drive_rounds` > 1 or session errors indicate the flaky hang above;
a semantic mismatch means real state divergence.

## Limitations (explicitly NOT covered)

- physical network differences, real mDNS across machines, firewall behavior
- Wi-Fi/LAN path differences, Android hardware, mobile lifecycle
- automatic sync (DC-21 endpoints) — harness uses explicit `sync_now` only
- GUI conflict-resolution flow (not RPC-exposed; see concurrent_modification)
