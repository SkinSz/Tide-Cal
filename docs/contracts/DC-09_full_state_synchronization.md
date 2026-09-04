# TIDE DESIGN CONTRACT DC-09
# Full-State Synchronization Triggers and Algorithm
Status: APPROVED by project owner (2026-08-25), with amendment:
MAX_INCREMENTAL_BACKLOG default lowered from 10,000 to 1,000 records, and
per owner decision it is a USER-ADJUSTABLE SETTING: the value is exposed in
the program settings (bounds below) rather than being a hard-coded constant.
All other triggers/constants unchanged.

OWNER AMENDMENT 2 (2026-08-25): DC-13 approved with tuned defaults —
debounce 10s (was 5), sweep interval 10 min (was 15). Rationale: keep data
fresher without meaningful network cost; see DC-13 §3.5 for the updated
normative values and bounds.
Depends on: Architecture Spec v0.3 §11, §12, §30 (#7), §31; DC-02 §4; DC-06 §2.5,
§3.4; DC-07 (transactional apply); DC-08 §3.6, §5, §6.3
Unblocks: GUARANTEED_FULL_RESYNC(P) evaluation (DC-06 §2.5); recovery from
compacted-history gaps; bounded first sync after pairing

==================================================
1. PURPOSE AND SAFETY GOAL
==================================================

Incremental replay requires that SOME peer still holds the un-compacted change
history covering the receiver's gaps. When that history is gone (compacted
everywhere) or impractically large (a device offline for months), incremental
anti-entropy cannot make progress: every round re-discovers the same gap.

Full-state synchronization is the RECOVERY mechanism for exactly this case.
It reconstructs current semantic state directly (Spec §11):

    A full-state snapshot represents CURRENT state, including the current
    ABSENCE of deleted entities. It does not replay historical deletion
    events; deletion knowledge travels as explicit tombstone markers that
    ride along per §4 below.

Full-state is NOT routine sync. Normal operation is incremental anti-entropy
(DC-08 §4); a full-state exchange is a heavy, exceptional event triggered only
by the deterministic rules of §3. The SAFETY GOAL mirrors DC-06:

    A full-state exchange must never lose deletions (INVARIANT 8), never
    erase unresolved conflicts or quarantine state (DC-06 §1, §4), and
    must terminate replay debt in both directions exactly as specified
    by DC-06 §3.4's clock exchange.

This contract owns deferred decision #7: WHEN a FULL_STATE_OFFER is emitted
(trigger thresholds) and HOW snapshots are constructed and applied. The
carrier message framing is DC-08 §3.6; the compaction predicate boundary is
DC-06 §2.5.

==================================================
2. DEFINITIONS
==================================================

snapshot_clock     The sender's current device_clock (DC-02) captured at
                   snapshot construction start. Frozen for the whole offer/
                   accept/stream sequence.

retained_lo(D)     The lowest producer sequence S for device D such that this
                   device still retains change records with seq >= S locally
                   (i.e., 1 if nothing compacted; otherwise one past the
                   compaction frontier). Maintained per DC-06 §5.3 summary.

failed_round       One CHANGES_REQUEST -> CHANGES_BATCH cycle in which the
                   receiver's requested range [lo, hi] intersects a producer
                   range the sender cannot serve because lo < retained_lo(D)
                   for some producer D (DC-08 §3.3 gap reporting).

MAX_INCREMENTAL_BACKLOG   = 1,000 records by DEFAULT (owner-amended
                          2026-08-25; was 10,000). This is a
                          USER-ADJUSTABLE SETTING exposed in program
                          settings. Bounds: minimum 100, maximum 100,000;
                          values outside these bounds are clamped/rejected.
                          The setting is local to each device (no need for
                          mesh agreement — it only decides when THIS device
                          offers full state). Default chosen so a typical
                          personal calendar switches to snapshot transfer
                          early; full snapshots are small for calendar-
                          scale data, so the lower threshold carries no
                          practical cost.

GAP_ROUND_LIMIT    = 2 consecutive failed rounds (constant; see TR-1).

offer_session_key  (local_device_id, remote_device_id, direction). Offers are
                   deduplicated per key per session (§3.5).

==================================================
3. TRIGGER POLICY
==================================================

Exactly four triggers cause a device to emit FULL_STATE_OFFER to a peer.
All triggers are deterministic given local tables + session history; two
identical devices reach identical decisions. There is no heuristic,
no timer-based trigger, and no "probably stale" guess.

--------------------------------------------------
3.1  TRIGGER A — History gap persists across rounds
--------------------------------------------------

During incremental anti-entropy, the RECEIVER asks for ranges it is missing
(DC-02 §5 neededRanges). If a range's low bound predates our retained_lo for
that producer, we cannot serve those records — they are compacted locally
(DC-06 §5). We report the un-servable sub-range in the CHANGES_BATCH response.

Rule: after GAP_ROUND_LIMIT = 2 CONSECUTIVE failed rounds against the same
peer where the SAME gap region persists due to compaction (not due to
in-flight batches), the sender MUST emit FULL_STATE_OFFER to that peer.

Why two rounds and not one: a single failed round can be transient (the
records may be mid-batch, or the receiver asked for a range spanning both
servable and un-servable portions). Two consecutive identical failures is
cheap to detect and eliminates false positives without delaying recovery
materially.

Why the SENDER offers, not the receiver: the sender is the party that knows
the history is gone. The receiver cannot distinguish "gap exists" from "gap
is servable next round".

    procedure ON_CHANGES_REQUEST(req):
        servable, gapped := partition_ranges(req.ranges)
        stream records for servable                       // DC-08 §3.3/§6.3
        report gapped regions in batch trailer
        if gapped all have lo < retained_lo(producer):
            if peer_state.gap_rounds_streak >= GAP_ROUND_LIMIT:
                OFFER_FULL_STATE(to := peer)              // §3.5 dedup applies
            else:
                peer_state.gap_rounds_streak += 1
        else:
            peer_state.gap_rounds_streak := 0

The streak counter resets on any round with a servable outcome and at session
start. It is per-peer, per-direction.

--------------------------------------------------
3.2  TRIGGER B — Explicit user action
--------------------------------------------------

A user-invoked "resync this device" command (per-device, from the settings
surface — UI itself is out of scope) MUST always result in a
FULL_STATE_OFFER being emitted to each currently connected trusted peer,
bypassing all dedup (§3.5) and all thresholds. This is the human recovery
hatch: it must work even when every automatic trigger has misfired or been
suppressed.

User-initiated offers are marked user_initiated := true so the receiving side
logs them distinctly (diagnostics only; semantics identical).

--------------------------------------------------
3.3  TRIGGER C — First sync backlog bound
--------------------------------------------------

First sync after pairing is NOT full-state by default. A newly paired device
starts empty; anti-entropy from an empty clock works perfectly well (needed
ranges = everything retained), and it inherits tombstones carried in normal
batches, preserving INVARIANT 8 the ordinary way (DC-06 §2.4).

EXCEPTION — bounded work: if the estimated missing change count exceeds
MAX_INCREMENTAL_BACKLOG (default 1,000; user-adjustable setting, see
section 2), the established side offers full
state instead. Estimation procedure computeIncrementalCost():

    function computeIncrementalCost(peer_clock):      // integer, conservative
        total := 0
        for D, lo_needed in neededRanges(peer_clock): // DC-02 §5
            hi := max_local_seq(D)
            if hi > lo_needed:
                total += min(hi - lo_needed,
                             hi - max(retained_lo(D) - 1, lo_needed))
                 // count only records we could actually serve;
                 // un-servable compacted ranges count toward the estimate
                 // too — replaying them is impossible anyway, so counting
                 // them here correctly pushes huge backlogs to full-state
        return total

    if computeIncrementalCost(new_peer_clock) > MAX_INCREMENTAL_BACKLOG:
        OFFER_FULL_STATE(to := new_peer)

Rationale: replaying >10k records in one first session is slower, more
failure-prone, and more battery/hostility-inducing than a streamed snapshot
of current state; and the snapshot path exercises the same validation
pipeline. The threshold counts RECORDS, not bytes, so it is deterministic
and testable independent of payload sizes.

Note: Trigger C fires on FIRST sync after pairing only (peer_clock was
absent/zero before this session). Subsequent sessions use Trigger A/D paths.

--------------------------------------------------
3.4  TRIGGER D — Receiver-side provable staleness
--------------------------------------------------

A receiver MAY determine its own applied state is provably stale beyond peer
retention: its applied_upto[D] for some producer D is below what peers could
plausibly still retain, OR Trigger-A-style gap reports have arrived FROM a
peer indicating our requests cannot be served anywhere.

To keep the protocol surface minimal, v1 defines NO separate REQUEST_FULL_STATE
message. Instead, the stale side simply emits its own FULL_STATE_OFFER — the
offer semantic is symmetric and either side may initiate (DC-08 §3.6 already
carries it bidirectionally). A device that knows it is stale offers its own
(currently thin) state; the fresher peer either declines silently (if it sees
nothing to gain) or accepts and sends the real snapshot. In practice the
stale side also accepts the fresher peer's offer, which arrives under
Trigger A/C logic. This avoids adding a message type while making
"receiver-requested resync" expressible.

--------------------------------------------------
3.5  Decision procedure and offer dedup

    function SHOULD_OFFER_FULL_STATE(peer, trigger):
        key := offer_session_key(self, peer, direction = OUTGOING)
        if trigger != USER_INITIATED and key in offers_made_this_session:
            return false                        // once per session per direction
        if simultaneous_offer_pending(peer):    // §7.3
            return resolve_offer_race(peer, trigger)
        record offer intent (key, snapshot_clock capture point)
        return true

Dedup rules:
- At most ONE outgoing FULL_STATE_OFFER per offer_session_key per session,
  unless re-triggered by USER_INITIATED (Trigger B always bypasses).
- After a completed or declined exchange, a NEW automatic offer for the same
  key within the same session requires a NEW trigger instance (e.g., a fresh
  pair of failed gap rounds).
- offers_made_this_session is in-memory only; session end clears it. Across
  sessions, triggers re-evaluate naturally.

Who offers — summary table:

    Trigger | Initiator of OFFER          | Gate
    --------+-----------------------------+---------------------------------
    A       | history-holding side        | 2 consecutive unservable rounds
    B       | user-commanded device       | none (always)
    C       | established side, on first  | cost > 10,000 records
            | sync to new peer            |
    D       | self-assessed stale side    | provable staleness beyond retention

==================================================
4. SNAPSHOT CONSTRUCTION (SENDER)
==================================================

4.1  Capture point

snapshot_clock := sender's current device_clock frozen AT CONSTRUCTION START.
Records committed after capture belong to the NEXT round (they flow through
normal anti-entropy later); they are NOT in the snapshot and NOT in
snapshot_clock. This keeps snapshot_clock truthful: it covers exactly what
the snapshot contains.

4.2  Content and ordering

The snapshot streams, entity_id ASCENDING (byte-wise, deterministic):

    a) ALL live entities: calendars, events, series, recurrence overrides,
       collection memberships (member presence lists per DC-04 §5).
    b) Tombstone markers per the rule below.
    c) NO quarantined diagnostics (quarantine stays local, DC-08 §5).
    d) NO conflict records in the snapshot body — unresolved conflicts
       survive separately via CONFLICT_RECORDS piggyback (DC-08 §3.5),
       unchanged by full-state resync (DC-06 §1, §4).

Each entry carries its full current entity state plus the producer
(device_id, seq) identity of the latest contributing record, so the receiver
can apply the concurrent-edit rule of §7.1.

4.3  Which tombstones ride along

Analysis: the snapshot expresses absence implicitly — an absent live entity
looks deleted. But the receiver must ALSO inherit durable protection against
REINTRODUCTION (INVARIANT 8): after applying, the receiver holds no history
of the deleted entity, and if the tombstone were absent too, a future
third-party relay of old E-state could resurrect it on the receiver with
nothing to stop it (DC-06 §1's core worry, relocated).

RULE: the snapshot includes ALL NON-COMPACTABLE TOMBSTONES — i.e., every
tombstone the sender still retains that fails the DC-06 §2.3 predicate
(some CONSTRAINT_SET peer's clock does not yet dominate it, or it participates
in unresolved-conflict bookkeeping per DC-06 §4.1). Compactable tombstones
(the sender could have swept but hasn't yet) MAY be included or omitted —
omission is safe because their constraint set provably knows the deletion;
including them is harmless and idempotent (TR-12 posture). Implementations
SHOULD include whatever the current sweep candidate set yields for
simplicity; the normative requirement is only: non-compactable => MUST be
included.

Effect: the receiver inherits exactly the sender's outstanding INVARIANT 8
obligations, and its subsequent advertisements feed lastKnownClock on other
peers identically to the sender's did. Protection is transferred, not lost.

4.4  Streaming bounds

Construction streams from SQLite (DC-07 tables are the only staging area);
each FULL_STATE_SNAPSHOT message carries at most one batch limit of entities
under the DC-08 §6.3 caps, using multiple messages with IDENTICAL
snapshot_clock until complete (DC-08 §3.6). No full-payload memory
accumulation is permitted. Ordering is stable across the whole multi-message
sequence (global entity_id ascending, resumed in order — no resume tokens,
§7.2; a restart begins a fresh offer).

==================================================
5. SNAPSHOT APPLICATION (RECEIVER)
==================================================

5.1  Transactional semantics — single logical apply

Application is STAGED then COMMITTED atomically, following the DC-07
T-boundary style:

    BEGIN TRANSACTION (single logical apply; may span multiple SQLite
    transactions internally ONLY via the DC-07 staging pattern — the
    observable commit is atomic)
        stage all validated entity writes
        stage tombstone inserts (non-compactable set, §4.3)
        stage clock advance: applied_upto := dominated_merge(applied_upto,
                               snapshot_clock)         // DC-02 §4.2/§4.3,
                                                     // exactly DC-06 §3.4 step 2
    COMMIT                                            // all-or-nothing

Failure at ANY point mid-application — invalid entry failing hard checks,
process death, disconnect — aborts cleanly: ROLLBACK leaves prior state
fully intact. No partial application ever survives (TR-7).

5.2  What is replaced vs preserved

REPLACED (for entities covered by snapshot_clock's semantic scope):
    - live entity state (calendars, events, series, overrides, members),
      including ABSENCE: entities the receiver holds live that the sender's
      snapshot lacks AND whose local version is dominated by snapshot_clock
      become deleted locally, with a tombstone marker inserted per §4.3's
      inherited obligations.

PRESERVED (never touched by snapshot apply):
    - local unresolved conflicts and all conflict records
      (CONFLICT_RECORDS channel owns these; DC-06 §4);
    - quarantined diagnostics;
    - trust store, pairing, and identity data (DC-05);
    - any local data outside the snapshot's coverage (see §7.1 rule).

5.3  Validation pipeline

Every entity entry passes the FULL DC-08 §5 receive-side pipeline
(structural checks, schema conformance, quarantine routing) BEFORE staging.
Invalid entries quarantine individually WITHOUT failing the rest (DC-08
§3.6 rule) — except entries failing integrity-critical checks (e.g., forged
producer identity), which abort the whole apply (fail-closed, consistent
with DC-05 posture).

5.4  Clock exchange

On successful commit, the receiver performs EXACTLY DC-06 §3.4:

    applied_upto := dominated merge with snapshot_clock
    device_clock advertisement thereafter reflects the merged value

Subsequent HELLOs re-advertise the new device_clock (DC-06 §3.4 step 3),
feeding every peer's lastKnownClock(receiver). No special compaction hook
exists; the ordinary DC-06 §5 predicate simply starts succeeding because
clocks advanced.

==================================================
6. INTERACTION WITH COMPACTION (DC-06 §2.5 UNLOCKED)
==================================================

After a SUCCESSFUL full-state exchange (both directions complete, or the
relevant direction completes):

6.1  Recording the fact

Each side records locally:

    full_resync_completed(peer P, clock C, direction, completed_at)

where C is the snapshot_clock exchanged. This is bookkeeping/diagnostic
state (schema deferred #10); it drives NOTHING semantically by itself.

6.2  Advertising — how peers learn

There is NO new advertisement field. The mechanism is precisely DC-06
§3.4 step 3: the resynced device's SUBSEQUENT HELLOs advertise its advanced
device_clock, which updates every peer's lastKnownClock(P). Once
lastKnownClock(P)[D] >= S for all relevant (D,S), P's constraints drop out
of the ordinary DC-06 §2.3 predicate automatically.

Consistency check against DC-06 §2.5(a): GUARANTEED_FULL_RESYNC(P) required
PROOF from P's own advertisement that P is stale beyond retention (a) plus
protocol guarantee P cannot get incremental replay instead (b). DC-09
provides (b) structurally: when a peer's gap reports show unservable ranges
(Trigger A evidence) or its cost exceeds the backlog bound (Trigger C
evidence), the ONLY progress-making answer this contract permits is a
full-state offer — incremental replay of those ranges is impossible by
construction (the history is gone everywhere it was requested). Thus the
DC-06 sweep may treat peers satisfying (a)+(b) as constraint-exempt, and
after the resync actually completes, their re-advertised clocks satisfy the
ordinary predicate going forward. Both sides run post-sync sweeps (DC-06
§5.2) — the moment compaction debt unwinds.

6.3  Tombstone compactability after resync

Tombstones the receiver inherited (§4.3) are evaluated under the ORDINARY
predicate on the receiver. They become compactable there when the same
lastKnownClock dominance holds mesh-wide. Nothing about full-state makes a
tombstone MORE sticky or LESS sticky than DC-06 already specifies.

==================================================
7. EDGE CASES
==================================================

7.1  Concurrent local edits during long snapshot transfer

Local edits continue freely during offer/accept/stream; they produce normal
change records and will propagate in later rounds. Snapshot application MUST
NOT clobber newer local versions.

RULE (apply-snapshot-wins only when dominated):

    For each snapshot entry E with producer identity (D, S_latest):
        let L := local record for E's entity_id, if any
        if L exists AND L.producer_seq_for(D) ... i.e.,
           local_version_clock[D'] >= snapshot_clock[D'] FOR EVERY producer
           D' where the local record differs from the snapshot entry
               -> LOCAL SURVIVES; skip snapshot write for E.
        else
               -> SNAPSHOT WINS for E (write staged).

Simplified normative form (this is the contract):

    An entity's local state survives the snapshot iff the local record's
    causality is NOT dominated by snapshot_clock; otherwise the snapshot
    replaces it.

Correctness argument: if local is dominated by snapshot_clock, the local
edit is already contained in the state the snapshot summarizes — replacing
it loses nothing (its effect is IN the snapshot or superseded by it). If
local is concurrent-or-newer w.r.t. snapshot_clock, overwriting would
destroy a change the sender never saw; skipping preserves it, and the NEXT
anti-entropy round reconciles normally (the sender pulls the local edit;
DC-03 handles any resulting concurrency). Absence-handling (deletion by
omission, §5.2) uses the same test: a live local entity absent from the
snapshot is tombstoned only if its local version is dominated by
snapshot_clock.

Property-testable (TR-6). Simple, symmetric with DC-02 dominance, no new
machinery.

7.2  Interrupted snapshot transfer

Disconnect/crash mid-transfer: the partial apply NEVER commits (§5.1
atomicity). There are NO resume tokens in v1. Recovery: the offer may be
re-emitted later when a fresh trigger instance fires (or the user retries);
the new attempt reconstructs and streams from scratch with a FRESH
snapshot_clock captured then. Idempotent end state regardless of retry
count.

7.3  Simultaneous offers between the same pair

Both sides may offer concurrently (Trigger D invites this). Deterministic
resolution, deadlock-free:

    resolve_offer_race(peer, trigger):
        if my_device_id > peer_device_id:
            proceed with MY offer; DECLINE theirs silently (no ACCEPT)
        else:
            defer: withdraw my offer; ACCEPT theirs

Higher device_id wins; the lower side defers. Both sides compute the same
outcome from the same inputs, so no livelock. The deferred side's need is
still served: accepting the winner's snapshot advances its clock equally
(the snapshot content is symmetric-in-goal even if asymmetric-in-content,
and the following anti-entropy round closes any residual difference).
Trigger B (user-initiated) follows the same rule — determinism beats
priority; the user's intent is satisfied by whichever direction completes.

7.4  Offer declined / ignored

Declining is silent (no NACK in v1, DC-08 §3.6). A declined automatic offer
is not re-attempted this session (§3.5). Session continues incrementally or
closes; a later session re-evaluates triggers fresh.

==================================================
8. TESTABLE REQUIREMENTS
==================================================

TR-1  TRIGGER A GATING: with a simulated compacted-history peer, one
      failed round produces NO offer; two consecutive failed rounds with a
      persisting compaction-caused gap MUST produce exactly one
      FULL_STATE_OFFER. A round with any servable outcome resets the streak
      (no offer). Fuzzed over request interleavings.

TR-2  TRIGGER B ALWAYS WORKS: a user resync command emits an offer to every
      connected trusted peer regardless of clocks, thresholds, dedup state,
      or prior declined offers in the session. Zero cases where the command
      results in no offer while a peer is connected.

TR-3  BACKLOG THRESHOLD: first-sync behavior flips to full-state offer
      exactly when computeIncrementalCost() exceeds the configured
      MAX_INCREMENTAL_BACKLOG (default 1,000) and stays incremental at
      or below it; boundary values tested (e.g. default: 1,000 / 1,001).
      The user-adjustable setting is honored within bounds [100, 100,000]
      and clamped/rejected outside them; with the setting at its minimum,
      the flip occurs at >100. Estimate is deterministic: same tables +
      peer_clock + setting => same integer.

TR-4  ROUND-TRIP FIDELITY: construct a snapshot from a source DB; apply it
      to an empty receiver; the receiver's semantic state (live entities,
      member presence, inherited tombstone set) equals the source's
      semantic state modulo entities edited during transfer (which follow
      TR-6's rule). Verified property-style over randomized DBs.

TR-5  INVARIANT 8 ACROSS FULL-STATE FLOWS: sender deletes E, compacts ALL
      its history and (where predicates allow) related markers, then
      full-state-resyncs a receiver that never saw E. Post-sync, E is absent
      on the receiver AND reintroduction attempts via third-party replay of
      old E-state fail (tombstones rode along per §4.3). Fuzzed >=10^5
      scenarios mirroring DC-06 TR-1 methodology.

TR-6  CONCURRENT-EDIT RULE (PROPERTY TEST): random local edits injected
      during streaming; after apply, for every entity, surviving state is
      exactly: snapshot version iff local causality dominated by
      snapshot_clock, else local version. No third outcome exists. Then one
      anti-entropy round converges both sides (no silent loss — INVARIANT
      on no-lost-writes holds throughout).

TR-7  ATOMICITY: kill -9 / disconnect injected at random points during
      application; after restart the receiver's DB is byte-for-byte at
      pre-apply state (prior state intact), no staged rows leak, no clock
      advance occurred. Retry from scratch succeeds.

TR-8  CLOCK EXCHANGE EXACTNESS: after commit, receiver applied_upto
      dominates snapshot_clock per DC-02 §4.2 merge, equals the DC-06 §3.4
      prescription exactly, and the next HELLO advertises the merged clock
      (extends DC-08 TR-13 with concrete values).

TR-9  COMPACTION UNLOCK: after a completed exchange, peers' lastKnownClock
      for the resynced device advance from its next HELLO; previously
      blocked tombstones/records on OTHER devices become compactable under
      the unchanged DC-06 §5 predicate; sweeps after resync reduce stored
      records accordingly. GUARANTEED_FULL_RESYNC(P)-exempt sweeps (§6.2)
      verified safe by the same fuzz harness as DC-06 TR-1/TR-3.

TR-10 SIMULTANEOUS-OFFER DETERMINISM: with both sides offering in the same
      session, exactly one snapshot transfer completes per pair; the winner
      is always the higher device_id; no deadlock or livelock in any
      scheduling interleaving (property-tested with adversarial message
      orderings); final states converge after one subsequent round.

TR-11 STREAMING BOUNDS: during construction and application, peak memory
      attributable to the sync layer never exceeds one batch limit beyond
      fixed overhead (DC-08 §6.3), for databases up to 100x the largest
      tested working set; multiple FULL_STATE_SNAPSHOT messages carry
      identical snapshot_clock and concatenate to the exact §4.2 ordering.

TR-12 IDEMPOTENT RETRY: re-running the entire offer/accept/apply after a
      clean completion changes nothing (idempotent), and after an abort
      yields the correct final state.

==================================================
9. OUT OF SCOPE
==================================================

- Message framing and wire format of FULL_STATE_OFFER / FULL_STATE_ACCEPT /
  FULL_STATE_SNAPSHOT -> DC-08 §3.6 owns these; this contract only decides
  WHEN the offer fires and WHAT the snapshot semantically contains.
- The compaction predicate and CONSTRAINT_SET membership -> DC-06 §2/§5;
  this contract consumes compactable() and feeds lastKnownClock indirectly.
- SQLite staging tables, transaction mechanics, bookkeeping schema ->
  deferred decision #10 (this contract requires only atomic observable
  commit per DC-07 patterns).
- UI for the manual "resync this device" button -> future UI contract
  (deferred #12 family); this contract consumes the command as an input
  event.
- Trust-revocation propagation -> deferred decision #8; revoked peers are
  never offer targets (they cannot synchronize, DC-05/DC-06 §2.6).
- Sync session scheduling and intervals -> deferred #13/#14.

==================================================
10. OPEN ITEMS OWNED ELSEWHERE
==================================================

- Tuning MAX_INCREMENTAL_BACKLOG / GAP_ROUND_LIMIT values in production
  -> constants are normative here; recalibration is a spec-revision act,
  not an implementation choice.
- Resume tokens for partially-transferred snapshots -> explicitly rejected
  for v1 (§7.2); revisit only with a dedicated revision of this contract.
