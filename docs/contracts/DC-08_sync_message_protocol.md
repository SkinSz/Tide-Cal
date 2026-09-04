# TIDE DESIGN CONTRACT DC-08
# Synchronization Message Protocol
Status: APPROVED by project owner (2026-08-25); AMENDED v2 by project
        owner (2026-09-02) — see Appendix A (session-end barrier,
        CHANGES_ACK semantics). Amendment supersedes §3.4 rule 3 and
        §5.4 where they conflict.
Depends on: Architecture Spec v0.3 §20, §21, §22, §23, §24, §30, §31;
            DC-01; DC-02; DC-03; DC-04; DC-05; DC-06; DC-07
Unblocks: sync engine implementation, revocation propagation (#8),
          full-state synchronization algorithm (#7) — as its carrier
Resolves: deferred decision #11 from Spec §30
          (exact synchronization message protocol)

==================================================
1. PURPOSE
==================================================

Defines the exact message protocol devices exchange during
synchronization: envelope format, message catalog, canonical session
flow, receive-side validation pipeline, and backpressure bounds.

Frozen constraints this contract implements:

  - Spec [15]/§24: JSON wire format. Every message is one JSON object.
  - Spec §20/INVARIANT 6: every message flows EXCLUSIVELY inside a
    completed DC-05 Noise_XX session between mutually trusted peers.
    There is no plaintext mode and no fallback.
  - INVARIANT 11: no central coordinator; both sides are symmetric
    pull-driven peers.
  - INVARIANT 14: safe under offline, delayed, duplicated, reordered
    delivery.

Core principle inherited unchanged from the whole contract series:
this protocol moves DATA only. It never decides trust (DC-05), never
resolves conflicts (deferred #12), never picks LWW winners ([21]),
and never carries identity claims beyond what the Noise handshake
already proved.

==================================================
2. PROTOCOL PRINCIPLES
==================================================

2.1  VERSIONED ENVELOPE

     Every message is exactly one JSON object:

         { "v": 1, "type": "<message_type>", ... type-specific fields }

     - "v" is the protocol version, integer, currently 1.
     - "type" is a string from the catalog in section 3.
     - No framing beyond "one JSON object per Noise transport
       message-stream boundary". Length-prefixing, chunking of large
       objects at the byte level, and similar concerns are transport
       IMPLEMENTATION DETAILS (section 9); they are not part of this
       contract and must be invisible to message semantics.

2.2  FORWARD COMPATIBILITY

     A receiver that encounters an unknown "type" MUST:
       a) log it (debug level),
       b) ignore the message entirely,
       c) continue the session normally.
     Unknown fields within known types are likewise ignored. This is
     what makes vN+1 rollout non-breaking for v1 receivers.

2.3  NO TRUST OR IDENTITY CLAIMS IN MESSAGES

     Device identity comes from the Noise static key verified during
     the DC-05 handshake (§6.1 V1-V4). NO message field may assert,
     override, or re-state who the sender is in any way that receiver
     logic trusts:

       - The receiver attributes every incoming message to
         peer_id = the authenticated Noise remote static key's
         device_id (DC-05 §2.2). Any device_id appearing inside a
         message body is DATA ABOUT THIRD PARTIES (producers,
         revoked devices), never a claim about the sender.
       - A message claiming to originate from a different device than
         the Noise peer is not an error to detect — the notion is
         meaningless; sender identity IS the Noise peer, period.

2.4  IDEMPOTENT PROCESSING EVERYWHERE

     Replays are always safe (INVARIANT 14):

       - Change records dedupe by change_id (DC-01 §4.2, DC-02 §7.1).
       - HELLO advertisement is a monotonic max-merge (DC-02 §4.2);
         receiving it twice changes nothing.
       - CHANGES_ACK applies element-wise max to lastKnownClock
         (DC-06 §2.1); duplicates are no-ops.
       - CONFLICT_RECORDS upsert by conflict identity + participant
         payloads; REVOCATION_RECORDS verify-and-store-once.
       - FULL_STATE_SNAPSHOT application sets applied_upto := sender
         clock by dominated merge (DC-02 §4.3 / DC-06 §3.4);
         re-applying the same snapshot converges identically.

     No message in this protocol has a side effect that is not
     idempotent under repetition.

==================================================
3. MESSAGE CATALOG
==================================================

All examples show wire JSON verbatim. Fields marked OPTIONAL may be
absent; all others are REQUIRED unless stated. Receivers MUST reject
(= quarantine/log per section 5) messages missing required fields or
carrying wrongly typed values — never guess.

--------------------------------------------------
3.1  HELLO
--------------------------------------------------

Sent by BOTH sides immediately after the session opens (post-
handshake, post-canSynchronize=ALLOW on both ends). Carries the
sender's current device_clock advertisement (DC-02 §2.1).

    {
      "v": 1,
      "type": "HELLO",
      "device_clock": { "d-phone": 200, "d-desktop": 9 }
    }

Rules:
  - Exactly one HELLO per side per session; a second HELLO on the
    same session is treated as malformed (logged, ignored).
  - The map keys are producer device_ids; values are integers >= 0.
  - On receipt, merge element-wise into local knowledge state per
    DC-02 §4.2 AND update lastKnownClock(peer) := element-wise max
    with the advertised clock (DC-06 §2.1 — advertisements come only
    from the peer itself over DC-05 transport).
  - The advertised clock feeds neededRanges computation (DC-02 §5)
    against our applied_upto/pending state.
  - hlc-style wall-clock data is deliberately ABSENT: cross-device
    clock synchronization is never required (Spec [21]; hlc is
    presentation-only).

--------------------------------------------------
3.2  CHANGES_REQUEST
--------------------------------------------------

Sent when we need ranges from the peer, computed via DC-02 §5
neededRanges(peerAdvertisedClock) against OUR knowledge state.

    {
      "v": 1,
      "type": "CHANGES_REQUEST",
      "ranges": [
        { "device_id": "d-phone",   "lo": 185, "hi": 200 },
        { "device_id": "d-desktop", "lo": 8,   "hi": 8 }
      ]
    }

Rules:
  - lo..hi are inclusive integer local_seq bounds of the PRODUCING
    device named by device_id. device_id here identifies a third-party
    producer whose changes the peer may hold (possibly as relay) —
    see §2.3; it is never a sender claim.
  - An empty "ranges" array is valid and means "nothing incremental
    needed"; it still elicits piggyback records (CONFLICT_RECORDS /
    REVOCATION_RECORDS) if the sender has any pending.
  - A request for ranges of a device the RECEIVER has never heard of
    is answered with whatever matching records exist (likely none) —
    never an error.
  - Requests are bounded by section 6 limits.

--------------------------------------------------
3.3  CHANGES_BATCH
--------------------------------------------------

The answer to a CHANGES_REQUEST: an array of change records in exact
DC-01 shape, verbatim (relays NEVER rewrite them — DC-02 §6).

    {
      "v": 1,
      "type": "CHANGES_BATCH",
      "changes": [
        {
          "change_id": "d-phone:185",
          "device_id": "d-phone",
          "local_seq": 185,
          "entity_id": "e-a1b2...",
          "entity_type": "event",
          "field_path": "title",
          "operation": "set",
          "payload": { "value": "Dentist" },
          "hlc_timestamp": 1724600000123,
          "causality_clock": { "d-phone": 185, "d-desktop": 72 },
          "schema_version": 1
        },
        { "...": "... up to batch limit ..." }
      ],
      "remaining_ranges": [
        { "device_id": "d-phone", "lo": 193, "hi": 200 }
      ]
    }

Rules:
  - "remaining_ranges" is OPTIONAL. Present when the sender knows the
    requested span exceeds one batch limit (§6.1): it lists the
    sub-ranges NOT covered by this batch, so the receiver can issue
    precise continuation requests without recomputing blind.
  - Batching is SENDER-CHUNKED (the sender decides how to split),
    RECEIVER-DRIVEN CONTINUED (further chunks flow only in response
    to further CHANGES_REQUESTs). The receiver must never assume a
    single batch completes a range; it keeps issuing requests until
    neededRanges against the peer's clock is empty (or remaining_ranges
    tells it what is left).
  - Records inside one batch MAY arrive unordered relative to
    local_seq; ordering/gap handling is the receiver pipeline's job
    (section 5, steps 3-4), never the sender's obligation.
  - A batch answering a request may contain FEWER records than asked
    (records already compacted away, DC-06 §3) — absence of a record
    within a compacted region is legitimate, not an error. Absence
    INSIDE uncompacted history simply leaves the gap; the next
    anti-entropy round re-reports it (DC-02 §7.3).

--------------------------------------------------
3.4  CHANGES_ACK
--------------------------------------------------

Sent after applying (or buffering) a received batch. Confirms,
PER PRODUCER, the contiguous applied frontier reached. The
ACK feeds lastKnownClock on BOTH sides per DC-06 §2.1: the receiver
of an ACK learns what its peer has applied — learned exclusively
from peer-originated messages over DC-05 transport, never inferred.

    {
      "v": 1,
      "type": "CHANGES_ACK",
      "applied_upto": { "d-phone": 192, "d-desktop": 8 }
    }

Rules:
  - Values are per-producer contiguous frontiers (applied_upto
    semantics, DC-02 §2.2): ALL changes 1..value from that producer
    are applied contiguously. Buffered-but-unapplied records are NOT
    counted (they will appear once gaps fill).
  - Receiver merges into lastKnownClock(peer) by element-wise max
    (monotonic; DC-06 §2.1/§2.2). This is what eventually unlocks
    compaction (DC-06 §5) on both sides.
  - ACK covers only records from THIS session's batches. It is sent
    after each batch is fully processed, not coalesced across sessions.

--------------------------------------------------
3.5  CONFLICT_RECORDS
--------------------------------------------------

Carries synchronizable conflict metadata per DC-03 §4.2: unresolved
conflicts (so peers can DISPLAY them without re-detecting) and
resolution outcomes (so a user resolves once, everywhere).

    {
      "v": 1,
      "type": "CONFLICT_RECORDS",
      "conflicts": [
        {
          "conflict_id": "c-77e0...",
          "conflict_entity": {
            "entity_id": "e-a1b2...",
            "field_path": "reminders.r-88a1..."
          },
          "participants": [
            { "change_id": "d-phone:186", "device_id": "d-phone",
              "local_seq": 186, "causality_clock": { "...": 0 },
              "payload": { "member_id": "r-88a1...",
                           "value": { "minutes_before": 30 } } }
          ],
          "detected_at_hlc": 1724600010000,
          "status": "unresolved"
        },
        {
          "conflict_id": "c-51a9...",
          "conflict_entity": { "entity_id": "e-c3d4...",
                               "field_path": "title" },
          "participants": [ { "...": "..." } ],
          "detected_at_hlc": 1724600020000,
          "status": "resolved_keep_incoming",
          "resolved_value": "Dentist, Thursday",
          "resolved_at_hlc": 1724600090000
        }
      ]
    }

Rules:
  - Record shape is DC-03 §4 verbatim. Participants carry their
    ORIGINAL change identities (change_id/device_id/local_seq/
    causality_clock/payload) so the receiver can correlate against
    its own history without trusting the carrier's interpretation.
  - Upsert semantics keyed by conflict_entity + participant set
    (device-local conflict_ids differ per detector and are NOT merged
    across devices — DC-04 §7). An arriving unresolved record never
    overwrites a locally resolved status, and vice versa: resolution
    outcomes propagate forward in time by resolved_at_hlc comparison
    ONLY as presentation metadata — the STATUS transition accepted
    over the mesh is unresolved->resolved_* only, mirroring DC-05
    §7.2's one-way transitions. A stale "unresolved" arriving after a
    local resolution is ignored.
  - These records are METADATA. Receiving one triggers NO detection
    run and NO state mutation beyond storage/display availability.
  - Sent opportunistically (piggybacked after batches, §4) whenever
    the sender holds conflict records the receiver has not yet
    acknowledged knowledge of.

--------------------------------------------------
3.6  FULL_STATE_OFFER / FULL_STATE_ACCEPT / FULL_STATE_SNAPSHOT
--------------------------------------------------

Semantic handshake for full-state resynchronization per DC-06 §3.4.
WHEN to offer is deferred decision #7 (staleness thresholds); this
protocol only carries the exchange.

FULL_STATE_OFFER (potential sender -> potential receiver):

    {
      "v": 1,
      "type": "FULL_STATE_OFFER",
      "snapshot_clock": { "d-phone": 200, "d-desktop": 12 },
      "snapshot_size_hint_bytes": 482113
    }

  - snapshot_clock summarizes what the offered snapshot would contain
    (the offerer's current device_clock at snapshot time).

FULL_STATE_ACCEPT (receiver accepts; the trigger thresholds live in
#7, not here):

    {
      "v": 1,
      "type": "FULL_STATE_ACCEPT",
      "offer_snapshot_clock_digest": "<opaque echo/hint, informational>"
    }

FULL_STATE_SNAPSHOT (sender streams current state):

    {
      "v": 1,
      "type": "FULL_STATE_SNAPSHOT",
      "snapshot_clock": { "d-phone": 200, "d-desktop": 12 },
      "entities": [ { "...": "full current entity state incl. collections,
                             tombstone markers, member presence..." } ]
    }

Rules:
  - Snapshot content = CURRENT semantic state (Spec §11: including
    absence of deleted entities), NOT a replay of history.
  - On applying a snapshot, the receiver performs exactly the DC-06
    §3.4 clock exchange: applied_upto := dominated-merge with
    snapshot_clock (DC-02 §4.2/§4.3); subsequent HELLOs re-advertise
    the new device_clock, feeding every peer's lastKnownClock.
  - The snapshot REPLACES incremental state reconstruction but does
    NOT bypass validation: entities are converted to conforming
    records/state through the same structural checks (§5 step 2);
    invalid entries quarantine individually without failing the rest.
  - A snapshot does not auto-delete locally-resolved conflicts or
    quarantined diagnostics; conflict records survive full-state
    resync (DC-06 §1: compaction/resync never erases unresolved
    state).
  - Declining an OFFER (no ACCEPT) is silent; the session continues
    incrementally or closes. No NACK exists in v1.

--------------------------------------------------
3.7  REVOCATION_RECORDS
--------------------------------------------------

Signed trust-revocation records per DC-05 §7, propagated through the
mesh (deferred #8 propagation strategy rides THIS message type).

    {
      "v": 1,
      "type": "REVOCATION_RECORDS",
      "revocations": [
        {
          "record": {
            "v": 1,
            "revoked_device_id": "d-tablet",
            "revoked_by_device_id": "d-desktop",
            "revoked_at_hlc": 1724600030000,
            "reason": "sold"
          },
          "signature": "<base64 Ed25519 detached signature>"
        }
      ]
    }

Rules:
  - Acceptance follows DC-05 §7.2 exactly: verify signature under the
    stored public key of revoked_by_device_id (which must be locally
    trusted). Forged/invalid records are dropped and logged; they are
    NOT quarantined as data (they are security events, logged as such).
  - IMMEDIATE ENFORCEMENT (mid-session rule): the moment a VALID
    revocation naming the CURRENT session peer is processed, the
    receiver stops exchanging further sync messages with that peer
    immediately — finish or abort the in-flight message, send no new
    requests/batches/ACKs, close the session cleanly. canSynchronize
    will return DENY_REVOKED on any future attempt (DC-05 §7.3/TR-11).
  - Revocations for OTHER (non-peer) devices are stored and forwarded
    opportunistically on later sessions (mesh propagation, #8).

--------------------------------------------------
3.8  PING / PONG
--------------------------------------------------

Optional keepalive. Timing, intervals, and timeouts are deliberately
UNSPECIFIED here (implementation/transport concern; also touched by
deferred #14 batching parameters).

    { "v": 1, "type": "PING", "nonce": 1724600040123 }
    { "v": 1, "type": "PONG", "nonce": 1724600040123 }

  - PONG echoes PING's nonce. Both are semantically inert; loss is
    harmless. They carry no state and must never gate correctness.

==================================================
4. SESSION FLOW (CANONICAL ANTI-ENTROPY EXCHANGE)
==================================================

Both sides run the SAME role. Each independently pulls what IT needs;
there is no coordinator, no master, no push authority (INVARIANT 11).
Trigger points (Spec §22: startup, foregrounding, network change,
discovery, local modification, manual) decide WHEN a session opens —
they belong to the background-process contract (#13/#14), not here.

Canonical sequence (A and B are symmetric; diagram shows one
direction plus the mirrored one):

    A                                          B
    |-- Noise_XX handshake (DC-05 §4/§6) ---->|
    |<-- complete, canSynchronize=ALLOW both -|
    |                                         |
    |-- HELLO(device_clock_A) --------------->|
    |<----------------------------- HELLO(device_clock_B)
    |                                         |
    | neededRanges(B_clock vs A state)        | neededRanges(A_clock vs B state)
    |                                         |
    |-- CHANGES_REQUEST(ranges_A_needs) ----->|
    |<-- CHANGES_BATCH(es) -------------------|
    |    apply: DC-02 gating + DC-03 detect   |
    |           + DC-04 collection/validation |
    |    quarantine invalid, buffer gapped    |
    |-- CHANGES_ACK(applied_upto) ----------->|  (feeds lastKnownClock(A))
    |                                         |
    |<-- CHANGES_REQUEST(ranges_B_needs) -----|
    |-- CHANGES_BATCH(es) ------------------->|
    |<-- CHANGES_ACK -------------------------|
    |                                         |
    |-- CONFLICT_RECORDS (piggyback) -------->|   (either direction,
    |<-- REVOCATION_RECORDS (piggyback) ------|    any order)
    |                                         |
    |   [optional FULL_STATE_OFFER/ACCEPT/SNAPSHOT per #7 thresholds]
    |   [optional PING/PONG keepalive]
    |                                         |
    |-- close --------------------------------|
    |   post-sync compaction sweep (DC-06 §5.2)

Properties:
  - SYMMETRY: steps between HELLOs execute concurrently in both
    directions; A pulling from B and B pulling from A are independent
    exchanges multiplexed over one session. Neither waits for the
    other's pull to start its own.
  - CONVERGENCE: each completed round strictly reduces the union of
    missing ranges (DC-02 §5); repeated opportunistic sessions reach
    eventual consistency (Spec §19 model).
  - A session may end at ANY point (crash, network loss, revocation).
    All state effects committed so far remain valid (idempotency,
    §2.4); the next session resumes purely from clock arithmetic —
    there is no session-level resume token, none is needed.

==================================================
5. RECEIVE-SIDE VALIDATION PIPELINE (ORDERED)
==================================================

Every inbound message passes these stages IN ORDER. Stages are
non-throwing: no input at any stage crashes the session.

  Stage 1 — ENVELOPE SCHEMA CHECK.
    Parse as JSON. Must be one object with integer "v" == 1 and
    string "type" in catalog. Unknown type -> log + IGNORE (§2.2),
    session continues. Wrong "v": if v > 1 (future), ignore message
    and log; if unparseable or v < 1, log + close session (fail
    closed on version mismatch — same posture as DC-05 §6.3).
    Missing/mistyped required fields on KNOWN types -> treat the
    whole message as malformed: log + drop it; continue session.

  Stage 2 — RECORD STRUCTURAL VALIDATION (per change record).
    Each entry of changes[] is validated independently against DC-01
    §2 structure and DC-04 §4.2 collection rules (operation set,
    member_id match/UUID form, forbidden whole-collection forms).
    Invalid records -> QUARANTINE durably per DC-04 §4.3 (reason code,
    received_at_hlc, sender_device_id = Noise peer, raw_record
    verbatim) WITHOUT breaking the session or the batch. Valid ones
    proceed. One bad record NEVER poisons a batch.

  Stage 3 — DEDUPE vs APPLIED/PENDING (DC-02 §7.1).
    seq <= applied_upto[producer] or (producer,seq) in pending ->
    duplicate: drop silently; still merge clocks (Stage-5 note).

  Stage 4 — CAUSAL ORDERING / GAP HANDLING (DC-02 §7.2/§4.4).
    seq == applied_upto+1 -> apply now, drain consecutive pending.
    Otherwise buffer in pending (bounded, §6.3).

  Stage 5 — DETECTION (DC-03 §3 / DC-04 §3) runs before mutation of
    the target value; conflicts become Conflict Records; concurrent
    pairs never overwrite (INVARIANT 7). Clock merges from BOTH
    applied and duplicate/dropped records follow DC-02 §4.2
    regardless of application outcome.

  Stage 6 — ACK ONLY WHAT WAS APPLIED OR BUFFERED-AND-COUNTABLE.
    CHANGES_ACK reports per-producer contiguous applied_upto reached
    this batch. Quarantined records do NOT advance applied_upto (they
    were not applied); they surface as observable quarantine counts
    (DC-04 §4.3c). If a quarantine creates a permanent hole in a
    producer's sequence, applied_upto stops below it and the next
    anti-entropy round will re-request — the sender re-sends, the
    record re-quarantines deterministically. This is intentional:
    ACKing unapplied data would let compaction destroy the only copy
    of a record the receiver refuses (violating INVARIANT 8 safety).

PARTIAL-BATCH APPLICATION SEMANTICS (normative summary):
    Within one CHANGES_BATCH, each record is processed through
    Stages 2-5 independently. Commit effects per record (SQLite
    transaction per record or per validated prefix — implementation
    choice, DC-07-compatible). Outcome classes per record:
      applied | buffered(pending) | duplicate-dropped |
      quarantined | superseded(dominated/tombstoned, DC-04 §5.2).
    The batch as a whole has NO atomicity requirement and NO
    all-or-nothing behavior. Malformed MESSAGES (Stage 1) are dropped
    wholesale because nothing in them was ever structured enough to
    apply; malformed RECORDS never take their siblings down.

==================================================
6. BACKPRESSURE AND BOUNDS
==================================================

6.1  BATCH LIMITS. A CHANGES_BATCH carries at most approximately
     256 change records or ~1 MiB of serialized JSON, whichever the
     sender hits first (exact constants are tuning parameters,
     deferred #14; the LIMITS themselves are normative). Senders MUST
     chunk; receivers MAY reject-as-malformed (log + drop batch,
     continue session) a grossly oversized batch.

6.2  RECEIVER THROTTLING. A receiver whose pending_changes table is
     near its configured bound MAY slow down by requesting smaller
     ranges per CHANGES_REQUEST (it controls the pump entirely —
     this is why continuation is receiver-driven, §3.3). There is no
     explicit negative-flow-control message in v1; throttling is
     expressed solely by asking for less.

6.3  NO UNBOUNDED BUFFERING. Pending buffers, quarantine, and
     batch-construction all STREAM FROM SQLITE (DC-07 tables are the
     only staging area). No implementation may accumulate a full
     sync payload in memory beyond one batch limit. Full-state
     snapshots likewise stream entity-by-entity under the same cap
     per message, using multiple FULL_STATE_SNAPSHOT messages with
     identical snapshot_clock until complete.

==================================================
7. WHAT THE PROTOCOL DELIBERATELY DOES NOT DO
==================================================

  - NO LWW anywhere. hlc_timestamp never selects winners ([21],
    DC-01 §4.4); no message field could even express a winner claim.
  - NO AUTOMATIC CONFLICT RESOLUTION. Conflicts travel as metadata;
    resolution is human (deferred #12) and propagates as an outcome
    record, never as a fresh overwrite decision.
  - NO DELETION OF DATA ON MALFORMED INPUT. Bad input quarantines;
    it never deletes local or remote state ("delete then resync" is
    forbidden forever).
  - NO TRUST DECISIONS. Trust lives in DC-05's store and gate; this
    protocol neither grants nor revokes trust except by RELAYING
    signed DC-05 §7 revocation records, which are verified against
    the pre-existing trust store.
  - NO CROSS-DEVICE CLOCK SYNCHRONIZATION REQUIREMENTS. Nothing in
    any message assumes synchronized wall clocks; hlc values are
    presentation/ordering aids only.
  - NO SERVER RELAY / COORDINATOR. Purely peer-to-peer mesh
    (INVARIANT 11); relaying is ordinary peer forwarding of verbatim
    records (DC-02 §6), not a service.
  - NO PUSH AUTHORITY. A peer can never make us apply anything; it
    can only answer our pulls. All application is locally gated.

==================================================
8. TESTABLE REQUIREMENTS
==================================================

TR-1  TWO-DEVICE CONVERGENCE: simulated devices A and B, both empty,
      random independent edit workloads, then one full anti-entropy
      session -> final SQLite semantic state (entities, collections,
      tombstones, conflict-record SET) byte-identical on both.

TR-2  THREE-DEVICE RELAY CONVERGENCE: topology P<->D<->T with NO
      direct P-T link (Spec §21); edits on all three converge
      identically everywhere via relaying alone; relayed records
      remain byte-identical end-to-end (DC-02 TR-4).

TR-3  DUPLICATE/REORDER/DELAY SAFETY: property test, >=500 randomized
      schedules (random duplication, permutation, artificial delays
      of messages across >=2 producers): final state and conflict
      set invariant to schedule (INVARIANT 14); zero crashes.

TR-4  PARTIAL-BATCH POISONING IMPOSSIBLE: a batch containing one
      structurally invalid record yields: exactly one quarantine
      entry (correct reason, verbatim raw_record), all valid siblings
      applied normally, session intact, ACK reflects only applied
      frontiers.

TR-5  UNKNOWN TYPE GRACE: injecting {"v":1,"type":"HOLOGRAM",...}
      mid-session logs and ignores it; session proceeds to normal
      completion; no error surfaces.

TR-6  HELLO FEEDS lastKnownClock: after a session, receiver's
      lastKnownClock(peer) equals element-wise max(previous, peer's
      advertised HELLO clock + peer's ACKs) exactly — no other input
      path can move it (DC-06 §2.1 exclusivity asserted negatively).

TR-7  MID-SESSION REVOCATION CUTOFF: delivering a valid
      REVOCATION_RECORDS naming the current peer stops all further
      exchange with that peer immediately (no subsequent
      requests/batches/ACKs observed on the wire); future sessions
      get DENY_REVOKED.

TR-8  CONFLICT PROPAGATION WITHOUT RE-DETECTION: A and B produce a
      genuine scalar conflict; when C later syncs with either, C
      displays the unresolved conflict from the CONFLICT_RECORDS
      message alone, having performed ZERO local detection runs for
      it (instrumented counter == 0), and C's record preserves both
      participant payloads.

TR-9  BATCH LIMIT + CONTINUATION: generating >256-change requests,
      sender chunks at the limit with remaining_ranges accurate;
      receiver drives continuation via repeated CHANGES_REQUESTs;
      final applied state identical to single-batch hypothetical;
      no batch ever exceeds the limit.

TR-10 NO PLAINTEXT OUTSIDE NOISE (static check): grep/lint/architecture
      test proves every serialization/send call site for sync
      messages sits downstream of the established Noise transport
      writer; no code path writes message bytes to a socket or log
      outside it (log output excludes message bodies by construction).

TR-11 VERSION MISMATCH FAILS CLOSED: a session where either side
      sends v != 1 on a known-type message (future v) gets those
      messages ignored with the session degrading gracefully; an
      UNPARSEABLE or lower-version envelope closes the session; no
      downgrade to any plaintext or legacy mode exists (extends
      DC-05 TR-8 to the message layer).

TR-12 IDEMPOTENT REPLAY: redelivering any captured legal message k>=1
      times, in any interleaving, leaves state identical to single
      delivery (covers HELLO, ACK, CONFLICT_RECORDS,
      REVOCATION_RECORDS, FULL_STATE_SNAPSHOT).

TR-13 SNAPSHOT CLOCK EXCHANGE: after FULL_STATE_SNAPSHOT application,
      receiver applied_upto dominates snapshot_clock (DC-06 §3.4)
      and the next session's HELLO advertises accordingly; peers'
      lastKnownClock updates unlock compaction exactly per DC-06 §5.

==================================================
9. OUT OF SCOPE
==================================================

- Transport framing BELOW the JSON-object boundary (length-prefixes,
  Noise stream chunking, multiplexing details) -> implementation
  detail; only the "one JSON object per message" semantic boundary
  is contractual here.
- mDNS discovery mechanics -> network-layer contract (separate).
- Trigger scheduling: WHEN sessions open, intervals, debounce ->
  background-process contract (deferred #13/#14).
- Full-state threshold values and staleness policy deciding when to
  OFFER -> deferred decision #7 (this contract carries the handshake).
- UI presentation of conflicts -> deferred decision #12.
- Exact batching constants (256 records / 1 MiB) as tuned production
  values -> deferred decision #14 (limits' existence is normative
  here; values are tunable).
- Revocation propagation STRATEGY (who forwards what when) ->
  deferred decision #8; this contract provides the carrier message.

==================================================
10. OPEN ITEMS OWNED ELSEWHERE
==================================================

- When FULL_STATE_OFFER is emitted                    -> deferred #7
- How often sessions trigger and how pushes debounce  -> deferred #13/#14
- How revocations route through the mesh optimally    -> deferred #8
- Quarantine review UX                                -> future UI work
- Rekey cadence inside long-lived sessions            -> implementation,
  constrained by snow standard mechanisms (DC-05 §6.2)

==================================================
APPENDIX A — AMENDMENT v2: SESSION-END BARRIER
==================================================
Status: APPROVED by project owner (2026-09-02). Authored per
TD-017 (independent adversarial review F2): the c088023 implementation
repurposed CHANGES_ACK as a one-shot bidirectional session
terminator without amending this contract. This appendix
formalizes that behavior as normative. Where this appendix
conflicts with §3.4 rule 3 or §5.4, THIS APPENDIX WINS.

A.1  MOTIVATION

Per-batch ACKs (§3.4 rule 3 as originally written) interact badly
with the DC-08 root-cause fix of 2026-08-31: a responder that
finishes its own pull and tears down the shared session inside
the initiator's HELLO/pull setup window strands the initiator
mid-protocol. The session-end barrier joins the two engine runs'
lifetimes so neither side can dismantle the session while the
other still owes it traffic. Real-network experience (stall
root-cause doc 2026-08-31) showed the barrier is REQUIRED for
liveness; per-batch ACKs are not required for correctness (the
applied_upto frontier in ONE ACK carries the same information a
sequence of per-batch ACKs would, and max-merge is order-free
per INVARIANT 14).

A.2  CHANGES_ACK — AMENDED SEMANTICS (supersedes §3.4 rule 3)

  1. ONE ACK PER SESSION, JOINT TERMINATOR. Each side sends
     exactly ONE CHANGES_ACK per session, immediately after its
     own pull completes (before serving the peer's pull). The
     message content is UNCHANGED from §3.4: per-producer
     contiguous applied_upto frontiers.

  2. BARRIER MODE. After sending its own ACK, a side enters the
     barrier serve phase: it keeps serving the peer's pull
     (CHANGES_REQUEST / CHANGES_BATCH / FULL_STATE_OFFER /
     FULL_STATE_SNAPSHOT / CONFLICT_RECORDS / REVOCATION_RECORDS)
     until it receives the peer's CHANGES_ACK — the JOINT
     TERMINATOR — or a clean EOF.

  3. BOUNDED POST-ACK DRAIN (TD-020). On receiving the peer's
     CHANGES_ACK the side does NOT exit immediately: it drains
     remaining in-flight sibling messages (REVOCATIONS_ACK, late
     batches) behind the terminator using a bounded poll loop
     (poll-count bound, NOT a time value; no timeout semantics
     changed). This prevents sibling-ack stranding (TRP-1/TRP-4b
     regression class). The drain's poll count is a tunable
     implementation constant (same class as §9 batching constants).

  4. BARRIER-MODE APPLICATIONS ARE ACKED. Records the barrier
     serves to the PEER (batches the peer applies during the
     barrier phase) are covered by the PEER's own ACK — which the
     peer sends after its pull completes, i.e. potentially BEFORE
     this side's barrier applications reach it. Therefore: the
     peer's compaction knowledge for barrier-phase applications
     advances at the NEXT session's ACK, not this session's. This
     is accepted as the amendment's deliberate trade (bounded
     compaction unlock delay ≤ one session interval) in exchange
     for the liveness guarantee of A.2.2.

  5. TERMINATOR IDEMPOTENCE (INVARIANT 14). Receiving more than
     one CHANGES_ACK in a session is legal: the first in barrier
     mode triggers the drain; later ones are max-merged into
     lastKnownClock and otherwise ignored. Duplicated/reordered
     ACKs cannot double-apply or corrupt state.

A.3  STASH INTERACTION (normative clarification)

The engine's session-level message stash (traffic parked by the
DC-09 offer-exchange helpers) MUST be consulted by the barrier
serve loop and MUST be cleared at session start (TD-019 F3 root;
Pkg7 finding 1). A stashed CHANGES_ACK is a valid terminator.

A.4  WHAT DOES NOT CHANGE

  - ACK payload semantics (per-producer contiguous frontier) —
    §3.4 rules 1-2 unchanged.
  - lastKnownClock max-merge — §3.4 unchanged.
  - INVARIANT 14 (duplicated/reordered comms safe) — holds per
    A.2.5.
  - The §5.4 canonical flow diagram gains the barrier phase, but
    the message sequence within each direction is unchanged:
    HELLO → (push pull serve) → ACK → serve-until-peer-ACK.

A.5  AMENDMENT RATIONALE (process record)

Deviation discovered by independent adversarial review (TD-017,
2026-09-01). Owner decision 2026-09-02: AMEND THE CONTRACT, do
NOT rework the code to per-batch ACKs — rework would re-introduce
the responder-teardown race the barrier exists to prevent, for
zero functional gain in the homogeneous fleet. Barrier semantics
verified by: pkg5b/pkg7 test waves, three-device real-TCP harness
(7/7), full suite 705/705 (commit bc1a3de).
