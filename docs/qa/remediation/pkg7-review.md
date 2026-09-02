# pkg7-review.md — BLIND adversarial review of TD-020 uncommitted diff

Scope reviewed: `git diff` on src/sync/sync_engine.ts + tests/full_state_triggers.test.ts.
Cross-read in full: sync_engine.ts (all 1510 lines), tests/pkg1_helpers.ts (msgPipePair),
src/security/revocation.ts (ackPeer), docs/technical-debt.md TD-020 entry.

## Verdict: SOUND WITH CONCERNS

The fix correctly addresses the TD-020 mechanism (stranded REVOCATIONS_ACK behind the
CHANGES_ACK terminator; peer parked on the idle bound without EOF propagation). The
INVARIANT 14 claim checks out in code. Concerns are edge-window issues that are all
convergence-safe (at-least-once sync heals them) but should be recorded.

## Findings

1. **[severity 4] Stale stash can prematurely terminate a fresh session's barrier.**
   `stashed` is engine-scoped (sync_engine.ts:847) and never cleared at session start
   (runSession, :526-658, resets sessionDedup but not the stash). A CHANGES_ACK stashed
   by expectBatchOrPeerRequest (:840) in session N-1 survives into session N, where the
   NEW stash-first consult (:696-704) feeds it to handleBarrierMessage in barrier mode →
   mergeAckIntoLastKnownClock + drainPostAck + barrier return BEFORE the real peer ACK.
   Peer's late CHANGES_REQUESTs then hit a closed transport. Pre-existing exposure
   (expectBatch could also drain stale stash), but the diff makes the barrier — the
   session-end joint terminator — consume stash, which raises the stakes. Recommendation:
   `stashed.length = 0` in runSession alongside `sessionDedup = new OfferDedup()`.

2. **[severity 4] close() in finally after SyncIdleTimeoutError reports clean EOF to the
   peer — the peer's failure signal is masked.** runSession (:640-655) closes the
   transport on ANY exit from serveRequests, including SyncIdleTimeoutError. On in-memory
   pipes (and TCP FIN) the peer's pending receiveIdleBounded resolves null → its barrier
   treats it as "clean EOF: peer closed after its ACK" (:709) and returns SUCCESS stats.
   The initiator's timeout/stall is invisible to the peer (old behavior: peer also timed
   out and errored). Data-wise safe (next session re-pulls), but a peer that had queued
   work for the stalled side gets no failure cue. Consider closing with an error-signal
   variant or documenting the trade-off. Not a blocker.

3. **[severity 3] Test pipe close semantics deviate from pkg1_helpers: messages queued at
   close time are DROPPED, not drained.** full_state_triggers.test.ts poll(): checks
   `pipe.closed` BEFORE `q.shift()` — if either side closed, all queued inbound messages
   on BOTH queues resolve null. pkg1_helpers msgPipePair.receive() (pkg1_helpers.ts:88-95)
   drains `self.queue` first and only then honors `self.closed`; close() only wakes
   waiters. Concrete loss window: A's drainPostAck answers B's late CHANGES_REQUEST with
   batches, A's drain finishes first, A closes; B's drainPostAck poll then sees
   pipe.closed and resolves null — A's response batches sit in qToB and are dropped.
   Convergence-safe (re-request next session), but the test double is not faithful to the
   established carrier semantics the rest of the suite relies on. Fix: shift-then-closed
   check in poll().

4. **[severity 3] drainPostAck stashes FULL_STATE_OFFER that can never be handled this
   session.** :820 pushes offers into `stashed` "for safety", but the barrier returns
   immediately after drainPostAck (handleBarrierMessage :765-766) and runSession then
   closes the transport. The offer is stranded until the NEXT session's expectBatch
   happens to drain it — meanwhile the peer's driveFullStateOffer polls out and the
   handshake is dead for this session. Deliberate deferral, but the comment overstates
   safety; the offer is effectively dropped.

5. **[severity 2] stats.sent undercounted in drainPostAck's CHANGES_REQUEST branch.**
   :806 increments stats.sent ONCE after the batch loop, whereas the identical branch in
   handleBarrierMessage (:743) increments per batch. Diagnostic drift only.

6. **[severity 2] handleBarrierMessage has no FULL_STATE_ACCEPT case (falls to default:
   :778, silently dropped).** Matches old else-chain behavior (expectBatch also ignored
   it), so not a regression — noted for completeness since the dispatch was refactored.

## Verified positive claims (code evidence)

- **INVARIANT 14 / DC-08 §3.4 idempotence holds.** recordAck → RevocationAcks.ackPeer
  (revocation.ts:313-323) is a set-add keyed by revocationTripleKey — duplicate/replayed
  REVOCATIONS_ACKs are no-ops by construction. Duplicate CHANGES_BATCH apply: applyBatch
  → applyRemoteChange classifies re-delivery as "duplicate" (changes UNIQUE by change_id;
  sync_engine.ts:1261-1269); skipped-seq re-delivery is a silent drop + clock merge
  (:1188-1217). mergeAckIntoLastKnownClock (:1303-1308) is max-merge — monotone, duplicate
  terminators harmless (drainPostAck :809-810 correctly treats them as no-ops).
- **Stash/drain interaction: no message loss or double-processing vs old code.** The
  stash-first consult fixes a pre-diff latent bug: expectBatchOrPeerRequest stashed a
  peer's CHANGES_REQUEST (:837-841) that old serveRequests could never see (comment at
  :594 "serve loop follows" was false) — the diff makes the barrier serve it. Stash is
  drained before pipe reads each iteration, and stash holds OLDER messages, so relative
  order is preserved. drainPostAck's null exit is unambiguous enough (quiet → return);
  drain is bounded at 10 iterations of receiveWithTimeout(·,5) (~≤100ms worst case), and
  DRAIN_POST_ACK_POLLS never extends any timeout value (rule 2 respected).
- **finally-close vs peer mid-receive on pkg1 pipes: no loss.** msgPipePair close()
  (pkg1_helpers.ts:96-108) wakes the peer's waiter with null AND the local waiter;
  receive() drains the local queue before honoring closed, so queued messages remain
  readable. Engine only closes in finally after its own receive loop has exited, so the
  closer's queue state is irrelevant; the peer sees deterministic EOF within the same
  event-loop turn. sessionOnce's own pTo/pFrom.close() double-close is a no-op.
- **Barrier drain cannot hang**: every path in drainPostAck returns or loops a fixed
  count; receiveWithTimeout always resolves (H-4 cached pending kept across polls, so no
  message is swallowed by the race — doc at :1138-1143).

## Test results

- revocation_propagation 5/5, pkg5b_snapshot_conflicts 10/10, full_state_triggers 11/11,
  pkg4_sync_timeout 7/7, all exit 0 — verified by prior pass (not re-run; no code
  changes made by this review).
