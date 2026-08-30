# Package 4 Report — Sync Pull-Phase Timeout (QA M-3 / F3, correlated BND-08)

Worktree: /tmp/tide-remediation, branch `remediation`, baseline ee3b154.
Production changes UNCOMMITTED at report time (lead gates before commit).

## Timeout semantics (the contract)

| Question | Answer |
|---|---|
| What is timed | Per-MESSAGE IDLE on the initiator's blocking receive points: HELLO wait + pull-phase CHANGES_BATCH wait. The clock restarts on every received message — an actively progressing transfer of any size can never false-time out. |
| Value | 15s (`SYNC_IDLE_TIMEOUT_MS`), matching the campaign's 15s REQUEST_TIMEOUT convention; healthy loopback per-message gaps are milliseconds (3 orders of magnitude below). Env override for connect: `TIDE_SYNC_CONNECT_TIMEOUT_MS`. |
| How it terminates | Initiator throws `SyncIdleTimeoutError` (phase + idleMs) out of `runSession`; `runEngineSession` wraps in try/finally with `session.done()` — the socket NEVER dangles on a failed session (previously cleanup only ran on success). |
| State persisted | Applied batches STAY COMMITTED — each batch is applied in its own transaction and is idempotent by change_id. Nothing to roll back; no partial rows. |
| Retry safety | Always safe: next sync recomputes neededRanges from knowledge state and re-requests exactly what is missing; `applied_upto` advances only transactionally per batch, never regresses. |
| Caller-visible | `sync_now` returns a deterministic `ok:false` ("sync session timed out waiting for peer (no message for Nms in PHASE)") — it returns in every peer-failure mode: stall, power loss, FIN close, unroutable host (bounded separately by the 15s connect/handshake watchdog, env-overridable). |
| Next sync | Normal: recomputed ranges, full convergence. |

## Files changed
- `src/sync/sync_engine.ts` — constant + error class + injectable
  `deps.idleTimeoutMs` + bounded receive at HELLO and pull wait.
- `src/persistence/bridges/sidecar_server.ts` — finally-done() +
  sync_now connect/handshake watchdog + unhandled-rejection guard on the
  losing connect promise (a late EHOSTUNREACH can never crash the sidecar
  after sync_now returned — hardening against the noise-wasm
  process.exit(1) class, QA-1 F9).

## Tests added
`tests/pkg4_sync_timeout.test.ts` — 7 tests, engine-driven with scripted
transports (deterministic; no sockets) + engine-on-both-ends delayed-pipe
sessions (150ms per-message delay < 300ms injected idle — the
slow-but-alive case), injected idle keeps the suite ~3s:
1. constant = 15s default
2. stalled peer → SyncIdleTimeoutError + initiator state byte-stable
   (changes/events/entity_versions identical)
3. slow-but-alive (150ms gaps < 300ms idle) → session COMPLETES, batch
   applied
4. timeout → retry applies records once (idempotent, no duplicate rows)
5. applied_upto never regresses across a timeout
6. timeout then recovery converges peers (semantic equality)

## Results
- `npx vitest run tests/pkg4_sync_timeout.test.ts` → 7/7 PASS, exit 0
- `npx tsc --noEmit` → exit 0
- Full suite `npx vitest run` → 493/496; the 3 failures are the documented
  pre-existing set (month_view date-flake, SC6 m-1, SC7 F3-hang).

## SC7 status (honest)
SC7 (abort mid-session ×3) still fails in its probe — BUT the failure mode
changed: the surviving engine no longer hangs forever; it now recovers via
the 15s idle timeout. The probe's own 5s assertion timeout predates Pkg4 and
3 cycles × up-to-15s recovery exceeds any reasonable assertion cap. The
probe (QA harness artifact in qa-tmp/) predates the fix and does not inject
a short idle timeout. Resolution options for the lead: update the probe to
inject `idleTimeoutMs` (harness fix, not production) or accept the
documented failure with this explanation. Production behavior is correct —
the hang is now bounded and recovery converges.

## Remaining uncertainty
- Real-WAN latencies untested (loopback only); 15s chosen by convention,
  not measurement — ops can tune via env for connect; idle bound is
  code-level (follow-up: env-override if ever needed).
- A full cancel-RPC surface for in-flight sync_now remains OUT of scope
  (Pkg6 candidate); with bounded timeouts every sync_now now returns, so
  the practical need is small.
- The B-side ("peer disappears during THEIR pull") is the responder's
  symmetric case; covered by design symmetry (both sides run the same
  bounded receive), asserted indirectly via recovery tests.
