# TIDE DESIGN CONTRACT DC-10
# Trust-Revocation Propagation
Status: APPROVED by project owner (2026-08-25)

OWNER Q&A AMENDMENTS (2026-08-25):
- Returning-device latency confirmed bounded by first-contact sync, not
  the periodic sweep: mDNS presence + DC-13 immediate/network-change
  triggers mean a device coming online is offered queued revocations
  within seconds-to-minutes of reaching any peer that knows the record.
  Remaining caveat (no reachable informed peer) restated from E2.
Depends on: Architecture Spec v0.3 §19, §21, §30 (#8), §31; DC-05 §7; DC-06 §2.6;
            DC-08 §3.7, §4
Unblocks: complete revocation lifecycle (create -> propagate -> enforce);
          removal of the "propagation algorithm details" deferral in DC-05 §7.3
Resolves: deferred decision #8 from Spec §30
          (trust-revocation propagation protocol)

==================================================
1. PURPOSE AND PROBLEM STATEMENT
==================================================

DC-05 §7 defines WHAT a revocation is (a signed record), how it is
authenticated (§7.2), and how it is enforced locally (§7.3). DC-08 §3.7
defines the message type that CARRIES records and the mid-session cutoff.
None of these defines HOW a record reaches every trusted device in the mesh.
This contract defines exactly that: the propagation strategy.

Frozen constraints this contract implements:

  - Spec §19/[27]: revocation is eventually consistent. A peer that has
    not yet LEARNED a revocation may temporarily continue trusting the
    revoked device. This window is an ACCEPTED v1 LIMITATION; this
    contract's goal is to close it as fast as practical without a central
    server, never to guarantee instantaneous global revocation.
  - INVARIANT 6 / INVARIANT 11: propagation rides trusted peer-to-peer
    sessions only; no coordinator exists.
  - INVARIANT 14: propagation must be safe under offline, delayed,
    duplicated, and reordered delivery.

Core principle inherited unchanged from the whole contract series:
this contract moves REVOCATION DATA only. It never verifies signatures
(DC-05 §7.2), never gates sessions or rejects changes (DC-05 §7.3),
and never frames messages (DC-08). It owns DELIVERY and per-peer
KNOWLEDGE BOOKKEEPING only.

The problem precisely:

    When device R revokes device X on some device A, every OTHER trusted
    device that still trusts X is a hazard until it learns the record.
    There is no server to notify. The only channels are the sync sessions
    of the trusted mesh itself. The design question is: which sessions
    carry the record, when, and how do we avoid sending it forever?

Answer in one line: epidemic gossip over trusted links with per-peer
acknowledgment bookkeeping, plus an urgent push by the revoking device.

==================================================
2. PROPAGATION STRATEGY (GOSSIP OVER TRUSTED LINKS ONLY)
==================================================

2.1  THE REVOCATION QUEUE

     Each device maintains, per PEER, a revocation queue:

         revocation_queue(peer) = { accepted_revocation_records }
                                  minus { records for which
                                          revocation_ack[peer][record] = true }

     - "Accepted" means stored after passing DC-05 §7.2 verification
       (store-once semantics; duplicates are no-ops).
     - A record a device created ITSELF enters its own store immediately
       (the creator is trivially "accepted").
     - Records naming the peer itself are NOT queued for that peer
       (a revoked peer is cut off by DC-08 TR-7 before it could matter).
     - The queue is derived state, recomputed from the record store plus
       ack bookkeeping; it needs no separate durability beyond both.

2.2  PIGGYBACK PRINCIPLE (DEFAULT PATH)

     Per DC-08 §4, REVOCATION_RECORDS already ride every sync session as
     opportunistic piggyback traffic, in either direction, any order.
     Rule: whenever a session with peer P opens or runs, the device sends
     ALL records currently in revocation_queue(P). This is the DEFAULT
     propagation path and requires no scheduling decisions: normal
     session triggers (Spec §22) drive it entirely.

     Other devices (i.e., relays that merely learned a revocation)
     forward on their NORMAL session schedule. No relay-specific timers,
     no priority queues, no re-prioritization of sync triggers for
     revocation purposes. Simplicity over latency for relays.

2.3  URGENT MODE — THE REVOKING DEVICE PUSHES

     Analysis first: a REVOKED device cannot be trusted to propagate its
     own revocation — it holds no authority to sign restoration or
     confirmation records (DC-05 §7.2), and a malicious revoked device
     would simply refuse to spread its own death sentence. Self-
     propagation is therefore excluded BY CONSTRUCTION: the urgent path
     belongs exclusively to the REVOKING device.

     Rule: when a device creates a revocation record (DC-05 §7.1), it
     SHOULD proactively attempt immediate sync sessions with ALL of its
     currently trusted peers (best-effort, subject to availability),
     prioritizing delivery of the new record ahead of routine exchange
     within those sessions. This bounds the vulnerability window for
     DIRECT neighbors of the revoker to roughly one connection setup.

     Peers receiving the record via urgent push then hold it and forward
     it on their own normal schedules (§2.2). Urgency does NOT cascade:
     a relay never initiates extra sessions because it holds a fresh
     revocation. Cascading urgency would require trust in relays'
     diligence that v1 deliberately avoids specifying.

2.4  FORWARDING RULES

     - A device forwards ANY valid revocation record it has accepted to
       every peer whose ack state for that record is unset (§2.5).
     - Forwarding is UNCONDITIONAL by topology: no distance metric, no
       hop count, no spanning tree. Gossip redundancy is cheap (records
       are tiny and rare) and buys robustness.
     - TTL-FREE: records never expire. A revocation does not become
       invalid by age (Spec §19: revoked status is one-way). A record
       may legitimately be forwarded months later to a newly paired
       device or a long-offline returning peer.
     - LOOP PREVENTION: store-once semantics (DC-05 §7.2/§7.3 acceptance
       rule) make redelivery idempotent. Receiving an already-stored
       record is a no-op (logged at debug); the receiver simply ACKs it
       (§3), which stops future re-sends. Loops are therefore harmless
       by construction rather than prevented structurally.

2.5  PER-PEER ACK STATE

     Mirroring lastKnownClock bookkeeping (DC-02 §4 / DC-06 §2.1), each
     device keeps:

         revocation_ack[peer][record_key] = true | unset

     where record_key = (revoked_device_id, revoked_at_hlc,
                         revoked_by_device_id) — the minimal unique
     triple identifying a record (two devices cannot produce identical
     triples since revoked_by_device_id differs; HLC disambiguates
     multiple revocations of the same device_id).

     - Set to true upon receipt of an ACK covering the triple (§3).
     - Never reset except by explicit local data loss (backup restore,
       fresh install) — in which case the record store is also gone and
       the queues rebuild from scratch.
     - This is KNOWLEDGE bookkeeping only. It never feeds enforcement,
       compaction constraint sets (DC-06 §2.6 uses local record presence,
       not remote acks), or clock arithmetic.

2.6  MESH CLOSURE ARGUMENT (CONVERGENCE, INFORMAL)

     Assumption (Spec §21): the trusted mesh is CONNECTED in the eventual
     sense — every trusted device eventually completes at least one sync
     session with at least one other trusted device, repeatedly, and the
     graph of devices that have EVER synced remains connected.

     Claim: under rules §2.2–§2.5, every accepted revocation record
     eventually reaches every trusted device, i.e., the set of devices
     unaware of any given record shrinks monotonically and reaches empty.

     Informal argument: pick any record r accepted on device A and any
     other trusted device Z. Since the eventual-session graph is
     connected, there exists a path A = d0, d1, ..., dk = Z where each
     consecutive pair eventually shares a session. By induction along
     the path: once di holds r, r ∈ revocation_queue(d_{i+1}), so the
     next di/di+1 session delivers r; acceptance at di+1 is guaranteed
     (same signature verification, deterministic). At-least-once
     delivery with idempotent acceptance means lost messages, crashes,
     and reordering delay but never defeat convergence.

     Convergence condition stated informally:

         If every trusted device keeps having sessions with trusted
         peers (directly or transitively), then for every revocation
         record there is a time after which NO trusted device lacks it.

     No bound on wall-clock time exists or is promised (Spec §19):
     convergence speed equals the speed of ordinary session occurrence,
     improved only by the §2.3 urgent push for direct neighbors.

==================================================
3. ACKNOWLEDGMENT MESSAGE
==================================================

Decision: a dedicated message type rather than extending CHANGES_ACK.
Justification: CHANGES_ACK carries applied_upto clock maps with precise
DC-02 semantics; overloading it with security-knowledge triples would
entangle two unrelated bookkeeping systems and complicate DC-06's
exclusivity argument (TR-6). A separate type keeps the catalog clean;
it piggybacks in the same slot as other piggybacked traffic (DC-08 §4).

New catalog entry (DC-08 catalog style):

--------------------------------------------------
3.x  REVOCATIONS_ACK
--------------------------------------------------

Sent by a device to declare which revocation records it has ACCEPTED
(verified and stored per DC-05 §7.2). Receiver marks
revocation_ack[sender][triple] := true and stops queuing those records
for the sender (§2.5).

    {
      "v": 1,
      "type": "REVOCATIONS_ACK",
      "accepted": [
        {
          "revoked_device_id": "d-tablet",
          "revoked_at_hlc": 1724600030000,
          "revoked_by_device_id": "d-desktop"
        }
      ]
    }

Rules:
  - Triples reference records by identity ONLY; no signatures, reasons,
    or payloads are echoed.
  - An ACK for a record the sender has NOT actually accepted is harmless:
    the receiver merely stops re-sending to a peer that claims knowledge.
    A lying peer can only harm ITSELF (it will lack records others stop
    forwarding to it); it cannot alter anyone else's trust state. No
    challenge/response mechanism exists in v1.
  - Acking implies acceptance of the FULL current record set matching the
    triple; if multiple distinct records shared a triple (impossible per
    §2.5 uniqueness argument), the first-accepted dominates.
  - Sent opportunistically like all piggyback traffic; typically
    immediately after processing an inbound REVOCATION_RECORDS in the
    same session.
  - Idempotent: duplicate/replayed ACKs are no-ops (INVARIANT 14;
    extends DC-08 TR-12 naturally).

Delivery discipline overall: AT-LEAST-ONCE. A device keeps re-sending
queued records every session until an ACK arrives. Lost sessions or lost
ACKs simply cause later re-sends; nothing breaks (idempotent acceptance).
This is deliberate: exactly-once would need per-record transport state,
which contradicts INVARIANT 14 simplicity requirements.

==================================================
4. ENFORCEMENT RECAP BOUNDARY AND MESH HEALING
==================================================

Boundary (non-negotiable separation of concerns):

    Enforcement = DC-05 §7.3: refuse sessions with known-revoked peers
    (DENY_REVOKED), reject change records produced by known-revoked
    devices, DC-08 TR-7 mid-session cutoff.

    Propagation = THIS contract: delivery of records + acknowledgment
    bookkeeping. Nothing here denies sessions or judges changes.

Rejected-changes behavior (mesh healing):

    A device that receives CHANGE records produced by a device it
    KNOWS to be revoked rejects them (already specified, DC-05 §7.3)
    and CONTINUES participating in propagation normally: it forwards
    the revocation record(s) it holds to the sending peer if that peer
    has not ACKed them (per §2.4), per the standard piggyback flow.

    This is how the mesh heals: the peer that just leaked revoked-
    producer changes learns the revocation FROM the very session that
    exposed its ignorance, and will enforce DENY_REVOKED from its next
    session onward. Propagation must NEVER be suppressed as a side
    effect of rejecting changes — rejection and education happen in the
    same session. Only the DC-08 TR-7 cutoff (record names the CURRENT
    peer) ends the session before further exchange, in which case the
    record was by definition delivered first.

==================================================
5. EDGE CASES
==================================================

E1  SIMULTANEOUS MUTUAL REVOCATION

    Devices A and B revoke each other concurrently; each learns the
    other's record during a session attempt.

    Resolution: both records are valid. Verification under DC-05 §7.2
    checks the signer against the receiver's trust store AT ARRIVAL
    TIME; each device still trusted the other when the record arrives
    (its own revocation of the other does not invalidate its ability to
    verify the other's signature — the other was a legitimate revoker
    at creation time). Deterministic outcome: both records are stored, both are enforced,
    both devices reach status=revoked regarding each other. Result: no
    sync between them ever again, regardless of arrival order. There is
    no un-revoke path (DC-05 §7.2 one-way transitions), so no race, no
    oscillation. Both devices also forward BOTH records onward normally.

E2  REVOCATION OF AN OFFLINE DEVICE

    The offline device receives nothing; the record waits in every
    trusted peer's queue (for peers that haven't ACKed it) until either
    the revoked device appears (irrelevant — it gets cut off) or, more
    importantly, until OTHER peers appear and relay it.

    ACCEPTED V1 LIMITATION (restated from Spec §19 / DC-05 §7.3): the
    offline-revoked device MAY continue syncing with OTHER peers until
    THOSE peers learn of the revocation. Example: P revokes T on phone;
    tablet (unaware) still syncs with desktop until desktop learns.
    Every such exposure is bounded by ordinary gossip latency. No v1
    mechanism shortens this beyond §2.3's direct-peer push.

E3  RE-PAIRING AFTER REVOCATION

    Revoked status NEVER flips back (DC-05 §7.2: accepted transitions
    are trusted->revoked only). Re-establishing synchronization with a
    formerly revoked device requires a NEW pairing ceremony (full QR
    exchange per DC-05 §5–§6), performed explicitly by the user.

    Trust-store interplay, simplest safe rule:

        On the device that performed the original revocation, the old
        trust entry REMAINS status="revoked" permanently. Successful
        re-pairing creates a FRESH trust entry (new pairing record,
        same device_id, new handshake keys per ceremony) only upon
        explicit user action completing the full ceremony. The revoked
        entry is retained (audit trail) but superseded by the fresh
        entry; canSynchronize consults the freshest entry.

        Justification: retaining the revoked entry means an attacker
        who steals the OLD key material gains nothing (new static key
        from a fresh Noise_XX run), and history shows why the device
        was revoked.

    What can un-revoke on a THIRD device (one that holds the old
    revocation record)? Analysis: candidates would be (a) a counter-
    record signed by the revoked device — invalid, DC-05 §7.2 rejects
    self-signed restoration; (b) a "forgive" record signed by the
    original revoker — requires a new signed-record TYPE and a
    distributed un-revoke protocol, disproportionate for v1; (c) new
    pairing evidence relayed by peers — would mean trust decisions
    flow through gossip carriers, breaking the "protocol moves DATA
    only" principle and creating a replay surface.

    DECISION: NONE in v1. No evidence received over the mesh can flip
    a revoked entry on a third device. Consequently, re-pairing after
    revocation requires removing and re-adding the peer ON EACH DEVICE
    MANUALLY (each device's user repeats the QR ceremony with the
    returning device, creating a fresh local trust entry). This is
    tedious but simple, safe, local, and consistent with INVARIANT 11
    (no central authority) and DC-05's ceremony-only trust creation.
    A distributed forgiveness protocol is explicitly future work.

==================================================
6. TESTABLE REQUIREMENTS
==================================================

TRP-1  TOPOLOGY CONVERGENCE: simulate line (P-D-T), star (hub +
       N leaves), and partial meshes (random connected graphs, up to
       20 nodes) with randomized session ordering. After enough rounds
       that every node has participated in >= diameter(node count)
       sessions, EVERY node has accepted every revocation record
       (instrumented: zero nodes lacking any record). Determinism:
       repeated seeds converge identically.

TRP-2  URGENT PUSH LATENCY: on record creation, the revoking device
       attempts sessions with ALL direct trusted peers; every AVAILABLE
       direct peer accepts the record within that single immediate
       session (no wait for scheduled triggers). Unavailable peers fall
       back to §2.2 opportunistic delivery.

TRP-3  FORGED RECORDS NEVER PROPAGATE: injecting a self-signed record
       (signed by the revoked device claiming to revoke another), a
       record signed by an unknown key, and a bit-flipped valid record
       yields: dropped + logged as security events (DC-08 §3.7), never
       stored, never ACKed, never re-forwarded. Downstream peers receive
       zero copies.

TRP-4  ACK SUPPRESSION + AT-LEAST-ONCE RECOVERY: (a) after B sends
       REVOCATIONS_ACK for record r, A's queue for B no longer contains
       r and subsequent sessions carry no copy of r to B; (b) with the
       ACK dropped by fault injection, A re-sends r on a later session
       and B's second acceptance is a byte-level no-op (state identical
       to single delivery — extends DC-08 TR-12).

TRP-5  MUTUAL REVOCATION TERMINATES CLEANLY: concurrent mutual
       revocation scenario (E1) ends with both devices storing both
       records, both enforcing DENY_REVOKED against each other, both
       propagating both records to third parties, and zero further sync
       attempts between the pair succeeding. Arrival order does not
       affect final state.

TRP-6  MESH HEALING UNDER LEAKED CHANGES: revoked-producer changes
       arriving at an unaware peer are rejected once the peer accepts
       the revocation mid-stream, AND the same/later session delivers
       the revocation back toward the leaking peer, after which the
       leaking peer refuses further sessions (DENY_REVOKED).

TRP-7  RE-PAIRING FLOW: (a) re-pairing attempts against a revoked entry
       WITHOUT completing the full ceremony create no usable trust;
       (b) after a successful explicit ceremony, only the performing
       device trusts the device again; (c) third devices holding the
       old revocation STILL enforce DENY_REVOKED after receiving any
       amount of post-repair traffic from intermediaries — no mesh
       message flips their entry; (d) each third device resumes sync
       only after its OWN manual re-ceremony.

TRP-8  TTL-FREE FORWARDING: a record held for a simulated 6-month
       offline period is still delivered intact and accepted by the
       returning peer on first contact; age plays no role in acceptance
       or queueing logic anywhere (assert no timestamp comparisons exist
       in the propagation path).

TRP-9  NO PLAINTEXT / SESSION-ONLY CHANNEL (static check): every
       propagation send/recv call site sits downstream of the Noise
       transport writer (mirrors DC-08 TR-10); revocations never travel
       via discovery hints, logs, or any non-session channel.

==================================================
7. OUT OF SCOPE
==================================================

- Signature verification of revocation records          -> DC-05 §7.2
- Enforcement gate (deny sessions, reject changes,
  mid-session cutoff)                                   -> DC-05 §7.3,
                                                            DC-08 TR-7
- Message framing, envelope, session flow position      -> DC-08
- Compaction constraint-set mechanics (when revoked
  peers drop from CONSTRAINT_SET)                       -> DC-06 §2.6
- UI for revoking and re-pairing flows                  -> UI contract
                                                        (deferred #12
                                                        adjacent)
- Distributed forgiveness / un-revoke protocol          -> future work,
  (deliberately none exists in v1, see E3)                new contract
                                                          required
- Sync session scheduling/triggers that determine
  relay forwarding times                                -> deferred #13/#14
