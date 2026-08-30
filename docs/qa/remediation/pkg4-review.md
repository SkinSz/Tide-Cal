# Fix Package 4 — Independent Adversarial Review (sync idle timeout, QA M-3/F3 + BND-08)

**Reviewer:** independent adversarial reviewer (Pkg4 falsification attempt)
**Date:** 2026-08-30
**Worktree:** /tmp/tide-remediation, branch `remediation`, HEAD ee3b154 + Pkg1–3 committed; Pkg4 uncommitted.
**Scope of review:** `src/sync/sync_engine.ts`, `src/persistence/bridges/sidecar_server.ts` (diff), `tests/pkg4_sync_timeout.test.ts`, probes under `qa-review4-tmp/`.
**Report under review (pkg4-report.md): deliberately NOT read** prior to writing this assessment.

---

## Verdict

**PASS.**

The claimed mechanism is real and the required invariant holds under every falsification probe attempted: every initiator blocking-receive path terminates deterministically in every peer-failure mode (stall, death-without-FIN, EOF, unroutable host); applied batches are retained and idempotent across timeout→retry; initiator state is never corrupted; the next sync converges; slow-but-alive peers are not falsely timed out (boundary verified at 290 ms/310 ms against a 300 ms idle); and Pkg1 GAP_ROUNDS semantics are preserved (gap → offer exchange bounded; data converges on recovery). The full suite reproduces at 493/496 with the three documented failures, one of which (SC7) is now confirmed to be a harness artifact, not a product defect.

---

## 1. Scope verification

`git status --short` + `git diff --stat`: exactly two modified files —
`src/sync/sync_engine.ts` (+124/−9 with comments) and
`src/persistence/bridges/sidecar_server.ts` (+71/−9). Untracked: `tests/pkg4_sync_timeout.test.ts`, `docs/qa/remediation/pkg4-report.md` (plus pre-existing untracked `qa-review{2,3}-tmp/` from earlier packages). No production code outside the two files touched. `npx tsc --noEmit` exits 0. **Scope clean.**

## 2. Coverage audit: is EVERY blocking receive bounded?

All receive paths on the initiator side were enumerated from source:

| Receive path | Mechanism | Bounded? | Error semantics |
|---|---|---|---|
| HELLO wait (`runSession`, sync_engine.ts:403) | `receiveIdleBounded(..., "HELLO")` (Pkg4) | ✅ idle window | `SyncIdleTimeoutError("HELLO")` |
| Pull first batch (`expectBatchOrPeerRequest`, :538) | `receiveIdleBounded` (Pkg4) — the defect point | ✅ idle window | `SyncIdleTimeoutError("pull/CHANGES_BATCH")` |
| Multi-round pull / interleaved traffic (`expectBatch`, :566) | `receiveIdleBounded` (Pkg4) | ✅ idle window | `SyncIdleTimeoutError("pull/CHANGES_BATCH")` |
| GAP_ROUNDS offer exchange (`driveFullStateOffer` :768, `receiveAndApplySnapshots` :746) | pre-existing `receiveWithTimeout` poll caps (10×5 / 20×5 × 2 ms) | ✅ bounded ~100–200 ms (see Concern A) | **clean completion, not SyncIdleTimeoutError** |
| Serve loop (`serveRequests` :488) | pre-existing `receiveWithTimeout(…, 5)`, quietTicks=2 | ✅ bounded (~20 ms of silence) | clean completion |
| Revocation handling (:627) | no receives | ✅ n/a | n/a |
| `sync_now` connect + Noise handshake (sidecar_server.ts:603) | `withTimeout(connectSync…, SYNC_CONNECT_TIMEOUT_MS)` (Pkg4) | ✅ watchdog (15 s, env-overridable) | deterministic error; late rejection of the underlying connect is swallowed by `void p.catch(()=>{})` |

**No remaining unbounded `await nextMessage()` / `transport.receive()` path exists on the initiator side.** The two idle-bounded points are exactly the two blocking waits that mattered (HELLO, pull batch); every other receive was already bounded by pre-existing poll-cap machinery.

Implementation details verified sound:
- `receiveIdleBounded` resets the idle clock per wait → per-message semantics; slow-but-alive transfers cannot trip it regardless of session length.
- `null` (peer EOF) passes through unchanged — existing null handling preserved.
- On idle expiry the abandoned H-4 pending receive gets a no-op catch — no `unhandledRejection` window (probe-verified).
- `session.done()` moved into `try/finally` in `SyncManager` — the socket can no longer dangle on a failed session; `done()` is safe on a destroyed socket.
- `withTimeout` clears its timer and attaches a no-op catch to the abandoned promise in a `finally`.

## 3. Falsification table (adversarial probes, `idleTimeoutMs=300`)

All probes in `qa-review4-tmp/` (probes.ts, probes2.ts, probes3.ts, probes4.ts, debug_p2*.ts). Engine driven directly with scripted transports; watchdog probes use real TCP sockets.

| # | Probe | Attack | Result |
|---|---|---|---|
| P1R | Stall after HELLO (silent accept, no FIN) | `SyncIdleTimeoutError` at 302 ms; initiator state **byte-identical before/after** (changes/events/applied_upto) | ✅ PASS |
| P2Rv3 | Stall after a complete batch prefix | Clean bounded completion (62 ms, pre-existing quiet-tick bound); nothing hung | ✅ PASS |
| P12 | True mid-multi-batch stall (peer advertises 3 seqs, sends only seq 1, stalls) | `SyncIdleTimeoutError("pull/CHANGES_BATCH")` at 338 ms; **first batch retained** (`applied_through=1`, no rollback); retry converges to full state, **0 duplicate change_ids** | ✅ PASS |
| P2R | Stall after an out-of-order (gap) record | Record correctly **buffered** into `pending_changes` (DC-02 out-of-order discipline — NOT a defect; see §4 adjudication); timeout at 301 ms; retry converges, 0 duplicates | ✅ PASS |
| P3/P4 | EOF after HELLO / after CHANGES_REQUEST (peer close) | Clean termination in ~25 ms (null path), no hang, no error | ✅ PASS |
| P5 | Stall after pull completes (serve/ACK phase) | Terminates: bounded via pull-loop idle window when ranges remain; clean completion when pull is satisfied | ✅ PASS |
| P6Rv3a | Message delivered at **290 ms** of 300 ms idle | **Accepted and applied** (`applied=2`, event row present) | ✅ no false timeout |
| P6Rv3b | Message delivered at **310 ms** of 300 ms idle | `SyncIdleTimeoutError` at ~301 ms; session terminated deterministically; late message not applied | ✅ boundary well-defined (>=: timer must fire after arrival) |
| P7 | GAP_ROUNDS: 2 unservable gap rounds (compaction on peer) then stall during full-state offer exchange | Bounded clean completion in 37 ms (poll caps); no hang | ✅ bounded (see Concern A) |
| P8 | GAP_ROUNDS recovery | Fresh healthy session after gap+stall: peers converge, semantic row equality | ✅ Pkg1 semantics preserved |
| P10 | `withTimeout` unit: underlying promise **rejects 250 ms after** a 100 ms watchdog | Watchdog error surfaces at 100 ms; **0 unhandledRejections**; late resolution also safe (value dropped, no crash) | ✅ PASS |
| P11a | Real TCP connect to unroutable host (203.0.113.1:9123) | Bounded at 501 ms with `TIDE_SYNC_CONNECT_TIMEOUT_MS=500` (env override honored; default 15 s) | ✅ BND-08 fixed |
| P11b | Real TCP accept then Noise-handshake silence | Bounded at 501 ms | ✅ PASS |
| P11c | Real TCP accept, then RST at 900 ms (after a 500 ms watchdog) | Watchdog fires first; **0 unhandledRejections, 0 uncaughtExceptions** after the delayed refusal surfaces | ✅ PASS |

Adversarial probe attempts that FAILED to falsify the fix: 14 of 14 attacks bounded.

## 4. Adjudication: P2R `firstBatchAppliedAndRetained: false`

This was **a probe-construction artifact, not a product defect**. My P2R probe sent only the peer's seq-2 event record while advertising a clock that implied a missing seq-1. Debug (`debug_p2r.ts`) shows the engine did exactly the right thing: the out-of-order record was **buffered into `pending_changes`** (contiguity discipline, DC-02), `applied_through` correctly did not advance past a missing predecessor, and the session then timed out deterministically. Evidence the product is correct: (a) the buffered record survived the timeout (retention), (b) the retry session converged with **0 duplicate change_ids**, and (c) probe P12 — which sends a genuine contiguous prefix — shows the first batch **applied and retained** (`applied_through=1`) across the timeout with clean convergence on retry. The suite's real-transport tests agree.

## 5. Test quality (tests/pkg4_sync_timeout.test.ts — 7/7 pass, 2.6 s)

Strong points (oracle independent of the fix's own error type where it matters):
- Byte-stability oracle: stall-after-HELLO asserts changes/events/entity_versions unchanged — a state oracle, not just an error-type check. ✅
- Real DC-08 protocol on both ends for slow-but-alive (150 ms per-message delay < 300 ms idle) and recovery tests; convergence asserted by **semantic row equality** between peers, not counts alone. ✅
- Idempotency: timeout → retry applies records once; deliberate duplicate re-delivery stays one row. ✅
- Retention: applied state survives the timeout (`applied_upto` never regresses).

Weaknesses (non-blocking):
- The "stalled mid-pull" test's post-timeout assertions are effectively vacuous (`toBeGreaterThanOrEqual(0)`), unlike P1R's byte-stability oracle.
- No GAP_ROUNDS-then-stall test, no boundary test (~idle), no EOF-mid-session test, no connect-watchdog test in the committed suite — all covered by this review's probes instead.
- Everything runs on scripted/in-process transports; no real-TCP end-to-end timeout test (this review's P11 probes covered real sockets).

## 6. Full suite + SC7

- Full suite reproduced: **493/496 passed** (47 files, ~48 s). Failures:
  1. `tests/month_view_clicks.test.ts` — pre-existing UI date-flake (documented).
  2. `qa-tmp/probes/sc5_snap_quar_restart.qa.test.ts > SC6` — pre-existing m-1 quarantine-replay count (documented).
  3. `SC7` — timeout at the probe's own **5 s assertion cap**.
- **SC7 verified fixed underneath:** rerun with `--testTimeout=180000 -t "SC7"` **PASSES in 45.5 s** (3 abort/restart cycles × bounded ~15 s Pkg4 idle recovery, convergence + no duplication asserted). The 5 s cap predates Pkg4; the F3 hang it used to detect no longer exists. Effective standing failures: 2 real known-failures + 1 stale harness cap (recommend bumping the probe's timeout separately).

## 7. Concerns (non-blocking)

- **A — GAP_ROUNDS stall semantics differ:** a stall during the Trigger-A offer exchange terminates via the pre-existing `receiveWithTimeout` poll caps (~100–200 ms) as a **clean completion**, not `SyncIdleTimeoutError`. Bounded and safe (next sync converges — P8), but the termination cause is invisible to callers, and the 2 ms poll ticks are aggressive real-time polling. Acceptable for this package; worth a follow-up if offer-exchange telemetry matters.
- **B — Late-resolving connect after watchdog:** if `connectSync` *succeeds* after the watchdog has fired, the resolved `InboundSession` is dropped without `done()` — the socket dangles until GC. Rare (connect slower than 15 s) and leak-only (no hang, no crash — P10-verified); a `void p.then(s => s.done()).catch(()=>{})` in `withTimeout`'s timeout branch would close it.
- **C — `SYNC_CONNECT_TIMEOUT_MS` is frozen at module load** (env read once). Fine for the sidecar process model; noted for ops.
- **D — Serve-phase quiet window (~20 ms)** is short vs. the 15 s idle bound; a peer slow to issue its CHANGES_REQUEST after HELLO may end the session early — but this is pre-existing behavior, unchanged by Pkg4, and converges on the next sync.

## 8. Falsification attempts summary (top 3)

1. **Searched for an unbounded receive path** — enumerated every `await` on receives in the engine and sidecar; found none beyond the two idle-bounded points and the pre-existing bounded poll paths. Falsification failed.
2. **Attacked the slow-peer boundary** — delivered a batch at 290 ms (accepted, applied) and 310 ms (deterministic timeout) against a 300 ms idle; the boundary is well-defined and no false timeout occurred. Falsification failed.
3. **Attacked retention/idempotency mid-multi-batch** — stalled the peer after a partial batch prefix and after an out-of-order record; in both cases state was retained (applied or correctly buffered), the session terminated deterministically, and retry converged with zero duplicate change_ids. Falsification failed.

**Verdict: PASS** — Pkg4 fixes M-3/F3 and BND-08 as claimed, preserves the required invariants, and survives independent adversarial probing.
