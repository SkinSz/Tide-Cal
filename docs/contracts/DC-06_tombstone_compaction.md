# TIDE DESIGN CONTRACT DC-06
# Tombstone Compaction Algorithm
Status: APPROVED by project owner (2026-08-25)
Depends on: Architecture Spec v0.3 §11, §12, §30, §31; DC-01 §6; DC-02; DC-03 §2.2; DC-04 §5.4
Unblocks: change-history GC, storage-boundedness work; depends on nothing unapproved
beyond DC-01..DC-05

==================================================
1. PURPOSE AND SAFETY GOAL
==================================================

Change history MUST NOT grow without bound (Spec §11). Compaction is how we
bound it: periodically removing change records and tombstone markers that can
no longer matter to any future synchronization.

But compaction is the single most dangerous operation in the system, because
it destroys exactly the evidence that protects deleted entities:

    INVARIANT 8 (Spec §31):
    Deleted entities cannot be reintroduced merely because a peer was offline.

Therefore the SAFETY GOAL of this contract:

    After any compaction, no trusted peer that may still perform incremental
    replay may miss a deletion it needs to know about.

CORE THEOREM (informal):

    A tombstone for entity E produced by device D at seq S may be compacted
    from OUR history only when we can PROVE that every possible future
    source of old E-state — i.e., any trusted peer that could ever replay
    changes about E to us or through us — already has knowledge beyond the
    deletion (its knowledge clock includes D:S).

If a peer's knowledge cannot be proven sufficient, the tombstone is retained.
Retention is always safe; compaction is what needs proof. This asymmetry is
the design principle of this contract.

Compaction never changes semantic state: deleting an entity stays deleted,
unresolved conflicts stay visible, and what we advertise as known only ever
moves forward (see TR-7 monotonicity).

==================================================
2. KNOWLEDGE-BASED PRECONDITION
==================================================

This is the heart of the contract. All preconditions are expressed in DC-02
vocabulary: device_clock (what a device knows), applied_upto (what it has
contiguously applied), and causality via per-producer sequences.

2.1  lastKnownClock(P)

For each trusted peer P, we maintain:

    lastKnownClock(P) : Map<device_id, integer>

the best knowledge WE have of what P has applied, learned exclusively from
clocks P itself advertised during past sync sessions (DC-02 §3 advertisement;
never inferred from third parties — a relayed claim about P is not proof).

Rules:
- lastKnownClock(P) is updated ONLY from messages authenticated as coming
  from P (DC-05 transport).
- It is conservative/stale by construction: if we have not heard from P
  recently, our entry simply reflects an older session.
- A device_id absent from lastKnownClock(P) counts as 0.

2.2  Compactability w.r.t. one peer

Given tombstone T = (entity_id, producer D, seq S):

    COMPACTABLE_wrt(T, P)   iff   lastKnownClock(P)[D] >= S

i.e., P provably knows about this deletion (it has applied at least seq S
from D). Note this uses the ADVERTISED device_clock, which dominates
applied_upto; advertised knowledge is the correct notion because pending
out-of-order records above applied_upto still count as known (DC-02 §4.4).

2.3  Compactable simpliciter

    compactable(T)  iff  COMPACTABLE_wrt(T, P) for every peer P in
                         CONSTRAINT_SET

CONSTRAINT_SET is the union of:
  a) all currently trusted peers (mutually paired devices, Spec [10], [12]);
  b) all peers that could REJOIN the mesh incrementally — devices still
     paired (not revoked) but currently unreachable/offline.

A peer leaves the constraint set ONLY by revocation (§2.6). Offline alone
never removes a constraint.

2.4  Unknown / stale peers — conservative rule

If a peer's status is unknown, or its lastKnownClock entry is older than the
tombstone's producer sequence, its constraint counts as NOT SATISFIED and
the tombstone is RETAINED. There is no timeout after which "probably fine"
applies. Explicit cases:

- Newly paired devices: before their first sync they have contributed NO
  clock advertisement. They enter the constraint set immediately upon
  pairing with lastKnownClock(P) = {} (all zeros), so every existing
  tombstone is non-compactable until P's first sync proves otherwise.

- Long-offline devices: see §3.4. Being offline long enough does not by
  itself make tombstones compactable; only a GUARANTEE of full-state
  resync does.

2.5  Full-resync-guaranteed peers

Spec [20] and §12 allow dropping a peer's protection when that peer is
GUARANTEED to perform full-state resynchronization instead of incremental
replay. The guarantee condition:

    GUARANTEED_FULL_RESYNC(P) iff BOTH:
      (a) P is known-stale beyond the full-state threshold (deferred #7):
          we have established — from P's own advertisement — that P's
          knowledge predates history we have already compacted or would
          compact in this sweep; AND
      (b) the protocol guarantees that such a peer cannot obtain
          incremental replay from us or any other trusted peer (it will
          be answered with full-state sync, not a delta stream).

Under (a)+(b), P's tombstone constraints DROP OUT of CONSTRAINT_SET for the
sweep: P reconstructs absence-of-entity directly from the full-state
snapshot (Spec §11 — full state includes current absence of deleted
entities). Analysis: this is safe because a full-state-synced peer never
replays old events at all, so there is no future incremental-replay source
of old E-state originating at P.

Exact thresholds and trigger logic are deferred decision #7; this contract
owns only the semantic boundary above.

2.6  Revoked peers

Revoked devices (Spec [26], [27]) can never synchronize again — INVARIANT 6
blocks them. Since a revoked peer can never perform replay of any kind, it
can never reintroduce a deleted entity, so:

    Revoked peers are removed from CONSTRAINT_SET entirely.

Justification of the relay concern: a revoked peer cannot RECEIVE anything
anymore (revoked peers cannot synchronize in either direction), so no
trusted peer can act as a push-relay into it. The residual worry — old
records a revoked device relayed BEFORE revocation — is handled by the
remaining constraint set: those records reached their destinations via
trusted peers, whose clocks must still dominate them before compaction.
The simplest correct rule is therefore: revoke => drop from constraint set,
no additional bookkeeping. Revocation propagation itself is deferred #8;
until revocation is LEARNED locally, the peer remains in CONSTRAINT_SET
(conservative).

==================================================
3. CHANGE-HISTORY CLEANUP vs TOMBSTONE DELETION
==================================================

Three distinct operations share one precondition machinery:

3.1  (a) Ordinary change-history cleanup (non-deletion records)

A normal change record R = (producer D, seq S, entity E) may be removed from
local history when every peer in CONSTRAINT_SET satisfies
lastKnownClock(P)[D] >= S — identical predicate to §2.3, applied to any
record rather than specifically to tombstones. Rationale: once all possible
future replay sources know >= S, no peer can ever ask us for R again, and no
peer could re-deliver it to us in a way we'd need to retain.

3.2  (b) Tombstone marker deletion

The tombstone marker itself (DC-01 §6 shape) is deleted under the SAME
predicate plus the conflict-interaction rule of §4. Deleting the marker is
the final act: afterwards the entity's deletion is remembered nowhere and
protection rests entirely on the theorem of §1.

Ordering within a sweep: ordinary history entries for entity E may be
compacted before or together with E's tombstone, but NEVER after the
tombstone while history remains that references it in a way requiring the
tombstone for interpretation (e.g., member tombstones, §5.4 of DC-04).
Practical rule: compact members first, then entity-level records, then the
entity tombstone, in one transaction (§6).

3.3  (c) Member-level tombstones (DC-04 §5)

Member tombstones for (entity_id, collection_path, M) follow IDENTICAL rules
scoped to their member identity: compactable when all CONSTRAINT_SET peers'
clocks dominate the member-tombstone record's producer sequence. Per DC-04
§5.4, whether/when member tombstones go alongside entity-level compaction is
exclusively this contract's business, and the answer is: they compact under
their own predicate; deleting the entity tombstone does NOT automatically
delete member tombstones unless the member predicate is also satisfied in
the same transaction.

3.4  Full-state resync resets the problem

When device X receives a FULL-STATE sync from peer P (or provides one):

Semantic clock exchange in full-state mode:
  1. X advertises its current state snapshot plus its own current
     device_clock.
  2. On APPLYING a full-state snapshot, X sets applied_upto := the sender's
     advertised device_clock (dominated merge, DC-02 §4.2) — i.e.,
     applied_upto JUMPS to current state; historical replay obligation ends.
  3. X then re-advertises its new device_clock in subsequent sessions, which
     feeds every peer's lastKnownClock(X) — this is precisely what converts
     "X was stale" into "X provably knows everything up to now", unlocking
     compaction on OTHER devices' histories too.

Full-state mode thus terminates replay debt in both directions without any
special-casing in the compaction predicate. Exact message framing is
deferred #11; trigger thresholds deferred #7.

==================================================
4. CONFLICT INTERACTION (DC-03)
==================================================

Per DC-03 §2.2, participant changes must remain present ("un-compacted")
while a conflict is live, and conflicts MUST NEVER be auto-resolved or
forgotten by compaction (INVARIANT 7).

Rules:

4.1  A change record participating in an UNRESOLVED conflict MUST NOT be
     compacted, regardless of clock predicates. The knowledge precondition
     of §2 is necessary but NOT sufficient for such records.

4.2  Conflict RECORDS themselves persist until:
       MINIMAL CONDITION: the conflict is resolved AND the resolution
       outcome has been propagated — proven by the same machinery:
       every CONSTRAINT_SET peer's lastKnownClock dominates the producer
       sequence of the resolution record (and of each losing participant,
       so no participant can re-raise the same conflict by replay).

4.3  Once resolved + propagated (per 4.2), the resolved-conflict records and
     losing participants MAY be compacted normally via §3.1. The winning
     value's record follows §3.1 like any ordinary record.

Compaction therefore never decides a winner, hides a conflict from a peer,
or erases user-facing unresolved state.

==================================================
5. ALGORITHM
==================================================

5.1  Predicate

    function compactable(record):
        // record = (producer D, seq S)
        if participates_in_unresolved_conflict(record):
            return false                                   // §4.1
        for P in CONSTRAINT_SET():
            // CONSTRAINT_SET = trusted ∪ possibly-rejoining (§2.3),
            // minus revoked (§2.6), minus guaranteed-full-resync (§2.5)
            if lastKnownClock(P).get(D, 0) < S:
                return false                               // §2.2
        return true

Deterministic: given the same local tables and lastKnownClock map, the
result is identical across runs and restarts.

5.2  Batch sweep

    procedure SWEEP():                       // periodic or post-sync
        candidates := index_lookup(records where compactable might hold)
        // primary index: (device_id, local_seq); secondary: (entity_id)
        victims := []
        for r in candidates ordered by (device_id, local_seq):
            if compactable(r): victims.append(r)
        // ordering: member-level before entity-level before tombstone (§3.2);
        // never delete an entity tombstone while its member tombstones
        // remain uncompacted
        BEGIN TRANSACTION                                    // §6
            update lastKnownClock bookkeeping, if any advanced this sweep
            DELETE victims
        COMMIT

Sweep triggers: post-sync (after clocks were exchanged — most productive
moment) and periodic idle sweep. Sweeps are idempotent (TR-8): running two
sweeps equals running one.

5.3  Performance considerations (qualitative only)

- The predicate is O(constraint set size) per candidate record; keep the
  constraint set small (it is bounded by paired-device count, typically <10).
- Index records by (producer device_id, local_seq) so lastKnownClock[P][D]
  comparisons are range scans, not table scans.
- Maintain a per-producer MIN-uncompacted-sequence summary so entire prefix
  ranges of a producer's history can be skipped wholesale when
  lastKnownClock min over CONSTRAINT_SET >= that prefix bound.
- Sweeps are cheap and should do nothing when nothing changed; post-sync
  sweeps amortize fully into sync time.
Schema specifics are deferred decision #10.

==================================================
6. FAILURE / RESTART BEHAVIOR
==================================================

Compaction decisions must be CRASH-SAFE:

6.1  Each sweep batch applies inside a SINGLE SQLite transaction
     (BEGIN ... COMMIT): the knowledge-bookkeeping advance (if any) and the
     record deletions commit atomically. SQLite's WAL rollback guarantees
     either both or neither.

6.2  FORBIDDEN intermediate states:
       - a record deleted but its associated knowledge advance not recorded;
       - a knowledge advance recorded but the now-compactable record left
         behind (merely wasteful, but avoid for determinism);
       - partially-deleted victim batches.

6.3  Kill-during-sweep behavior: process death mid-sweep rolls back the
     open transaction; the next sweep redoes the work identically
     (determinism, §5.1). No repair pass, no journaling beyond SQLite's own.

6.4  Compaction NEVER writes to lastKnownClock from inference; it only ever
     consumes advertisements already committed by the sync layer. Thus
     compaction itself cannot advance what we advertise as known (TR-7).

SQLite transaction mechanics and schema (#10) and sync framing (#11) are out
of scope here.

==================================================
7. TESTABLE REQUIREMENTS
==================================================

TR-1  INVARIANT 8 PRESERVATION: randomized multi-device simulation
      (>=5 devices, random offline periods, relaying chains, departures and
      rejoins, deletions interleaved with edits) — after compaction runs at
      ANY point in ANY interleaving, no deleted entity is ever
      reintroduced anywhere in the mesh. Fuzzed over >=10^5 scenarios.

TR-2  STALE-PEER PROTECTION: a peer whose clock is unknown or predates a
      tombstone causes that tombstone to be retained; assert retention for
      newly-paired (zero-clock) and long-offline peers.

TR-3  FULL-RESYNC-GUARANTEED PEER: when GUARANTEED_FULL_RESYNC(P) holds
      (§2.5 conditions a+b), P's constraints drop out and matching
      tombstones compact; verify P recovers correct state (deletions
      included) purely from full-state sync afterward.

TR-4  REVOKED-PEER REMOVAL: after a peer's revocation is learned, its
      constraint no longer blocks compaction; before it is learned, it
      still blocks. Pre-revocation relayed records remain protected by
      remaining peers' clocks (assert no premature compaction).

TR-5  UNRESOLVED-CONFLICT PARTICIPANT RETENTION: while a conflict is
      unresolved, all participating records survive sweeps regardless of
      clock state; after resolution + propagation (per §4.2), they become
      compactable. Conflict records are never silently dropped (INVARIANT 7).

TR-6  CRASH SAFETY: kill -9 the process during a sweep at random points;
      on restart the DB is consistent (no half-applied batch), invariant 8
      holds, and a rerun sweep completes correctly.

TR-7  MONOTONICITY: compaction never increases what we advertise as known;
      our advertised device_clock after any sweep equals before (compaction
      does not fabricate knowledge).

TR-8  IDEMPOTENCY: sweep(); sweep() leaves exactly the same DB state as
      sweep() once; repeated sweeps after quiescence are no-ops.

TR-9  BOUNDED GROWTH: in a simulated long run (steady edit/delete rate,
      periodic syncs among all peers), total stored change records +
      tombstones converge to a bound proportional to live entities +
      unresolved conflicts, not to cumulative operations performed.

==================================================
8. OUT OF SCOPE
==================================================

- Exact SQLite tables/schema for history, tombstones, lastKnownClock,
  and sweep bookkeeping -> deferred decision #10 (this contract requires
  only that sweep batches be single transactions).
- Sync message framing / exact wire protocol, including how advertised
  clocks travel -> deferred decision #11.
- Full-state synchronization trigger thresholds and algorithm ->
  deferred decision #7; this contract defines only the semantic boundary
  (§2.5, §3.4).
- Trust-revocation propagation algorithm -> deferred decision #8; this
  contract consumes "revocation learned" as an input event.
- Recurrence-specific deletion nuances beyond the entity/member model ->
  deferred decision #5; series/override deletions here are plain entities.
