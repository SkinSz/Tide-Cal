# QA FINDING: Three-Device Harness Intermittent Sync Stall — Root Cause

- Date: 2026-08-31 (UTC)
- Work package: diagnosis only — NO production fix implemented (owner approval gates production changes)
- Scope of tree changes: **none** (temporary instrumentation was added to `src/sync/sync_engine.ts`, `src/network/sync_runtime.ts`, `tests/probes/three_device_harness.mjs`, then fully reverted and verified; `dist/sidecar.mjs` rebuilt clean; `npx tsc --noEmit` OK)
- Repro evidence: `/tmp/tide-3dev-harness/reports/*.json` (7 archived harness runs) and an instrumented rerun (traces quoted below; temp files under `/tmp/tide-3dev-trace/`)

## Verdict (one paragraph)

The stall is a **session-lifetime race between the two independent engine runs
that share one DC-08 connection**, compounded by an **EOF-propagation defect in
the TCP carrier**. When the sync_now *responder* has nothing to pull, it exits
its serve loop after a ~20 ms idle window, sends its CHANGES_ACK, and its
`session.done()` ends the TCP socket — possibly *before* the initiator has even
finished its own HELLO wait, let alone sent its CHANGES_REQUEST. The
initiator's request is then never served, and — because the carrier→Noise
frame-feed loop drops the peer-close condition instead of closing the inbound
frame queue — the initiator's pending receive **never resolves as clean EOF**;
it hangs until the Pkg4 15 s idle bound fires
`SyncIdleTimeoutError(... in pull/CHANGES_BATCH)`. The reverse direction is a
separate session and works, which is why the harness (bidirectional rounds +
tolerated per-session errors) masks the defect and reports overall PASS.

## Answers to the owner's five questions

### Q1 — Which side stalls, under what conditions?

**The sync_now initiator stalls** (its RPC surfaces the error). Verified across
7 archived harness runs + 1 instrumented rerun: the error is always
`"<X> sync_now: sync session timed out waiting for peer (no message for
15000ms in pull/CHANGES_BATCH)"`, where X is the initiator of the failed
session — B in `independent_offline_changes`, `concurrent_modification`,
`fresh_peer`; C in `offline_peer`, `restart`. Exactly one session fails per
scenario run (6/6 runs identical pattern).

Conditions (from the instrumented trace): the **responder's neededRanges is
empty** while the **initiator has pending ranges**. `basic_three_way` never
stalls because every early session has data flowing both ways, so the responder
is still inside its own pull phase — where an interleaved CHANGES_REQUEST is
stashed and served inline — rather than in the fragile serve-and-close path.

The defect is NOT a Noise/crypto or framing failure: all failing sessions had
`noise_transport: true` for every successful sibling session, and the stalled
initiator had already decrypted the peer's HELLO (and even the peer's final
CHANGES_ACK) correctly.

### Q2 — WHERE in the DC-08 sequence?

Precisely: **initiator, in the pull phase, waiting for the first CHANGES_BATCH
after sending CHANGES_REQUEST** (`expectBatchOrPeerRequest` →
`receiveIdleBounded(..., "pull/CHANGES_BATCH")`, src/sync/sync_engine.ts).

Instrumented trace of the failing session (responder A = d-b37a9e…, initiator
B = d-3ef042…; timestamps ms-mod-1e5, one process each):

```
A (responder): 40584 session start · 40585 hello-done · ranges=[]
               40595 serve poll quiet=0 msg=null · 40606 quiet=1 msg=null
               40607 session END (ack sent) · socket END event
B (initiator): 40542 session start · 40626 hello-done
               ranges=[{device_id d-135dff…, lo:1, hi:2}]   ← has data to pull
               40626 pull-wait got=CHANGES_ACK               ← A's ack, not a batch
               (15 s silence → SyncIdleTimeoutError in pull/CHANGES_BATCH)
```

A's whole engine session ended 19 ms **before** B finished its HELLO wait. B
never sent its CHANGES_REQUEST in time; A never served it. HELLO, Noise
handshake, ACK framing all fine; the stall point is exactly the
REQUEST→BATCH gap.

### Q3 — Which layer?

Two defects at two layers, one primary and one amplifying:

1. **PRIMARY — session-state / sync-logic (engine layer).**
   `runSession` (src/sync/sync_engine.ts) implements each side of the session
   as a fully independent engine run over one socket: HELLO → own pull →
   `serveRequests` → own ACK. The responder side has **no coupling between
   "I finished my pull" and "my peer may still be pulling from me"**:
   - `serveRequests` exits after `quietTicks = 2` quiet polls, where each poll
     is bounded by `receiveWithTimeout(..., 5)` polling every **2 ms** — a
     ~10–20 ms liveness window (line ~630 and `receiveWithTimeout` ~line 988).
   - After the serve window it unconditionally sends its own CHANGES_ACK and
     returns; `runEngineSession`'s `finally` then calls `session.done()` which
     `sock.end()`s the connection (src/persistence/bridges/sidecar_server.ts
     ~242; src/network/sync_runtime.ts `doneOnce`/`connectSync.done`).
   Nothing in the state machine waits for the peer's ACK (or any signal that
   the peer's pull is satisfied) before tearing the session down. This violates
   the DC-08 §4 intent of one shared session carrying both concurrent pulls:
   the two directions' lifetimes are not joined.

2. **AMPLIFIER — transport (TCP carrier → Noise frame queue).**
   In `noise_transport.ts` (`carrierToInbound` feed, ~lines 606–614), when
   `inner.receive()` returns null (peer FIN from `sock.end()`), the feed loop
   simply `break`s — it **never calls `inbound.close()`** on the Noise
   `FrameQueue`. `FrameQueue.receive()` therefore leaves its registered waiter
   pending forever, so `NoiseSessionTransport.receive()` on the surviving side
   never resolves `null` ("peer closed cleanly") and never throws. The engine's
   clean-EOF handling (`if (msg === null) return null; break`) — which would
   have turned this into a *benign short session* — is unreachable on this
   path. That is why the symptom is a 15 s hang, not a fast clean close.

The **timeout layer is NOT the cause**: Pkg4's `SYNC_IDLE_TIMEOUT_MS` (15 s)
behaves exactly as designed — it converts what would otherwise be a permanent
hang into a deterministic error, and its phase label is what localized the
defect. Bumping it would only widen the blind spot.

### Q4 — Does reverse-direction success mask a state-machine defect?

**Yes.** Two distinct mechanisms:

- **Across sessions (harness-visible masking):** the reverse sync_now is a
  separate TCP connection with a fresh pair of engine runs; it transfers the
  data the failed session should have carried. `driveToConvergence` records the
  per-session error, tolerates it, and re-runs the pair in later rounds; the
  4th round in the trace shows B finally receiving its CHANGES_BATCH. Oracle
  digests converge → scenario PASS despite a real protocol failure every run.
- **Within a session (the defect itself):** each side's engine independently
  decides the shared session is over. A half-open state arises: the responder
  has completed BOTH its pull and its serve/ACK and closed the socket, while
  the initiator is still mid-pull. There is no per-session state that joins
  "my peer is done with me" to "I may close". The initiator racing its own
  HELLO/pull setup against the responder's early close is exactly the race.

### Q5 — Relation to existing timeout/recovery work?

- **Pkg4 guarded path (QA M-3 idle bound, 15 s):** related as the *detector*,
  not the cause. It fires correctly and deterministically here; before Pkg4
  this same race would have hung `sync_now` forever (the EOF-amplifier made
  even the null-return path unreachable). No idle-timeout change is warranted.
- **`engine idle bound` in the harness (`SYNC_RPC_TIMEOUT_MS = 22000`):** the
  harness comment ">= engine idle bound + margin" is exactly why the stall
  manifests as a ~15 s per-session cost inside a 22 s RPC budget — consistent
  with the observed ~19 s scenario durations.
- **TD-001 quarantine-and-skip / skipped_seqs (271e86c/96a257a):** NOT related.
  All failing sessions show `receivedQuarantined = 0`, no skip rows involved;
  the stall occurs before any record application.
- **Historical corroboration:** the QA-campaign sync agent's "pull-phase hang"
  observation (docs/qa/remediation-era notes,
  references/qa-campaign-mid-observations.md) is almost certainly this same
  defect, previously unlocalized.

## Repro recipe

```bash
cd /home/skins/tide
npm run sidecar:build
node tests/probes/three_device_harness.mjs --scenario=independent_offline_changes
# exit 0 (scenario PASSES) but report JSON shows:
#   {"from":"B","to":"A","error":"B sync_now: sync session timed out waiting
#    for peer (no message for 15000ms in pull/CHANGES_BATCH)"}
```

Reproduced in 6/6 archived runs of 5 of the 6 scenarios (per-scenario
deterministic at current load; within a scenario ~1 of 4–10 sessions fails —
the per-session miss probability is timing-dependent, so under different
machine load the scenario-level flake rate will vary, but the mechanism is
fully deterministic: responder-with-empty-ranges closing inside the
initiator's HELLO/pull setup window).

Minimal condition to force it deterministically: any topology where a device's
sync_now target is fully up-to-date with the initiator (responder
`neededRanges == []`) while the initiator still has unserviced ranges — e.g.
B and C both create events, then drive B→A before A has pulled anything to
give B.

## Proposed fix design (NOT implemented — owner approval required)

Fix at the correct layers, no timeout bumping:

1. **Engine/session-state (primary):** make the responder's post-pull serving
   phase wait for the peer's session-completion signal instead of a ~20 ms
   quiet window. Options (recommend a):
   - a) Define the session's final ACK as the *joint* terminator: after a side
     sends its CHANGES_ACK it keeps serving until it receives the peer's
     CHANGES_ACK, then closes (DC-08 amendment note: "ACK is bidirectional
     session-end barrier"). Minimal change: `serveRequests` quiet-window
     replaced by "exit on peer ACK or idle bound", and `runSession` sends its
     ACK *before* entering the final serve (or immediately after pull, so both
     ACKs are exchanged early and serve continues until peer ACK).
   - b) Move the ACK to session start semantics (ack-of-frontier, not
     ack-of-session) and make close cooperative: a side may `done()` only when
     its own pull is complete AND the peer's advertised/piggybacked state says
     the peer's pull is complete.
   Either way the initiator's CHANGES_REQUEST must never be servable-after-
   close; the responder's serve loop must span the peer's whole pull.
2. **Transport (amplifier):** in the carrier→inbound feed loop
   (`noise_transport.ts`), call `inbound.close()` when `inner.receive()`
   returns null or the feed loop throws, so peer FIN propagates as a clean
   `null` receive. This restores the engine's designed clean-EOF handling and
   de-risks every future session lifetime bug from "15 s mystery timeout" to
   "immediate clean close". Independently valuable even after fix 1.
3. **Harness/QA follow-ups (non-production):** a probe pinning
   "initiator with pending ranges + responder with empty ranges converges in a
   single session, zero session errors"; consider making the harness FAIL on
   any recorded session error for the release gate (currently tolerated).

## Evidence chain (command → result)

| # | Claim | Command | Result |
|---|-------|---------|--------|
| 1 | Stall reproduces across runs, same signature | archived `/tmp/tide-3dev-harness/reports/*.json` (7 runs, commit e56b3f9) | 5/6 scenarios fail in every run; always `15000ms in pull/CHANGES_BATCH` |
| 2 | Instrumented rerun reproduces | `TIDE_SYNC_TRACE=1 node tests/probes/three_device_harness.mjs --scenario=independent_offline_changes --report-dir=/tmp/tide-3dev-trace` | exit 0, session B→A error identical; sidecar stderr traces quoted above |
| 3 | Responder had empty ranges & closed early | trace stderr-A / stderr-B (t=40585 `ranges=[]`; t=40607 session END) vs initiator t=40626 hello-done | responder closed 19 ms before initiator finished HELLO wait |
| 4 | Initiator got ACK-not-batch, then silence | trace stderr-B t=40626 `pull-wait got=CHANGES_ACK` | no further message for 15 s |
| 5 | Instrumentation reverted | `git status --short; git diff --stat` after revert | empty (production-clean tree) |
| 6 | Clean rebuild & type health | `npm run sidecar:build && npx tsc --noEmit` | REBUILD_OK, TSC_OK, exit 0 |
