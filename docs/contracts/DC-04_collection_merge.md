# TIDE DESIGN CONTRACT DC-04
# Collection Merge Semantics
Status: APPROVED by project owner (2026-08-25)
Depends on: Architecture Spec v0.3 §13, §14, §30, §31; DC-01; DC-02; DC-03
Unblocks: sync protocol (deferred #11), conflict-resolution UI (deferred #12)
Resolves: deferred decision #4 from Spec §30

==================================================
1. PURPOSE
==================================================

Defines how collection-valued fields (Spec §14: reminders, attendees,
future collection-valued properties) are represented, tracked, merged,
and protected against silent data loss during synchronization.

DC-03 defined conflict detection for SCALARS and for SINGLE-MEMBER
collection boundary cases (its §3.7). This contract extends those
boundary rules to WHOLE collections:

  - the collection data model and member identity
  - per-member change tracking
  - collection-wide merge algebra
  - prohibition of whole-collection replacement
  - member tombstones and empty-collection edge cases
  - determinism of collection state under reordering

Core principles inherited unchanged: a conflict is DATA, never a silent
decision (Spec §13); no timestamp-based winners (Spec [21]); every sync
operation is safe under offline, delayed, duplicated, reordered
communication (INVARIANT 14).

==================================================
2. DEFINITIONS
==================================================

2.1  Collection Field

     A collection field is an UNORDERED MAP:

         collection : Map<member_id, member_value>

     identified by its collection_path (e.g. "reminders", "attendees")
     on one entity_id. There is no inherent order, no first element,
     no index. Any display ordering (e.g. reminders sorted by
     minutes_before) is DERIVED LOCALLY at presentation time and is
     never semantic content.

2.2  Member Identity

     member_id is the explicit stable UUIDv4 identifier chosen once at
     member creation time (DC-01 §3.2) and carried in every subsequent
     change record for that member. Rules:

       a) member_id is immutable for the life of the member.
       b) Array index / position is NEVER identity and is NEVER
          synchronized as semantic content ([23]).
       c) A member_id is never reused within a collection, even after
          the member is removed (tombstone protection, section 5).

2.3  Member Conflict Entity (extends DC-03 §2.1)

     Each MEMBER is its own conflict entity in exactly the DC-03 sense:

         member_conflict_entity = (entity_id, "<collection_path>.<member_id>")

     Example:
         ("e-a1b2...", "reminders.r-88a1...")

     Two change records touch the same member entity iff these pairs
     are equal. Records touching DIFFERENT members of the same
     collection are different conflict entities and NEVER conflict
     with each other (DC-03 §3.6 applies per member).

2.4  Per-Member Change Tracking

     Every add, update, or remove of a member produces its own change
     record (DC-01 operations member_add / member_update /
     member_remove), keyed on "<collection_path>.<member_id>":

     Add a reminder:
     {
       "...": "...",
       "field_path": "reminders.r-88a1...",
       "operation": "member_add",
       "payload": { "member_id": "r-88a1...",
                    "value": { "minutes_before": 30 } }
     }

     Update it:
       field_path: "reminders.r-88a1..."
       operation: "member_update"
       payload:   { "member_id": "r-88a1...",
                    "value": { "minutes_before": 15 } }

     Remove it:
       field_path: "reminders.r-88a1..."
       operation: "member_remove"
       payload:   { "member_id": "r-88a1..." }

     There is NO operation that touches two members at once, and none
     that touches a collection without naming a member_id.

2.5  Concurrency

     Defined solely by DC-02 §3 on causality clocks. hlc_timestamp
     plays no role anywhere in this contract.

2.6  Effective Member Value

     After applying a change to member M:
       member_add    -> payload.value
       member_update -> payload.value
       member_remove -> ABSENT (member deleted)
     Two values are IDENTICAL iff they are deep-equal JSON values, or
     both are ABSENT (same rule as DC-03 §2.4).

==================================================
3. MERGE SEMANTICS
==================================================

When an incoming member-level change C arrives and passes DC-02 §7
application gating, it is evaluated against local state of ITS OWN
member entity only, using DC-03's algorithm restricted to that entity.
The whole-collection consequences follow automatically:

Rule 3.1  UNION OF CONCURRENT DISTINCT-MEMBER ADDS.
     Concurrent (or any-order) member_add records with DIFFERENT
     member_ids both apply. The resulting collection is their union.
     This is Spec §14's default semantics; it falls out of per-member
     independence, not from any collection-wide comparison.

Rule 3.2  INDEPENDENCE OF DISJOINT MEMBERS.
     Concurrent updates/removes of DIFFERENT members apply
     independently; neither blocks, conflicts with, or overwrites the
     other. Editing reminder A never conflicts with editing or
     deleting reminder B.

Rule 3.3  SAME-MEMBER DIVERGENCE = CONFLICT.
     Concurrent conflicting changes to the SAME member_id — differing
     adds (DC-03 §3.7a), update-vs-update with different values,
     update vs remove (DC-03 §3.4/§3.7d) — produce ONE unresolved
     Conflict Record on that member entity via DC-03 §3/§4. The local
     member value is NOT overwritten pending resolution.

Rule 3.4  IDENTICAL-VALUE CONVERGENCE = IDEMPOTENT NO-OP.
     Concurrent changes to the same member with identical effective
     values converge silently: the later arrival is a no-op regardless
     of concurrency (DC-03 §3.1). No conflict record.

Rule 3.5  CONCURRENT ADD + REMOVE OF SAME MEMBER = CONFLICT.
     member_add(M) concurrent with member_remove(M) is a conflict per
     DC-03 §3.7d / §3.4: neither the removal silently destroys the add
     nor does the add silently resurrect over the removal.

Rule 3.6  CAUSAL CHANGES APPLY CLEANLY.
     A change causally after all uncompacted participants on its
     member entity applies normally (DC-03 §3.2).

Pseudocode — collection merge is just N independent member merges:

    function applyToCollection(entity_id, collection_path, C):
        // C is member_add | member_update | member_remove only (section 4)
        M = C.payload.member_id
        return detect(entity_id, collection_path + "." + M, C)   // DC-03 §3

Worked example (Phone P, Desktop D, clocks mutually non-dominating):
    P: member_add reminders.r-1 (minutes_before=30)
    D: member_add reminders.r-2 (minutes_before=15)
    -> union: both reminders present. No interaction whatsoever.

    P: member_update reminders.r-1 -> 45
    D: member_remove reminders.r-1
    -> conflict on ("e-a1b2...", "reminders.r-1"); both intents
       preserved in the Conflict Record participants.
    Meanwhile D's member_remove reminders.r-2 applied concurrently
    by P applies cleanly: r-2 disappears on P without conflict.

==================================================
4. PROHIBITION OF WHOLE-COLLECTION REPLACEMENT
==================================================

4.1  FORBIDDEN OPERATION. There is no "set entire reminders list"
     change record. The ONLY valid operations addressing a collection
     path are member_add, member_update, and member_remove (DC-01 §2),
     each carrying an explicit member_id. This is what guarantees
     per-member merging is ALWAYS possible (Spec [23]): because no
     record ever claims authority over the whole collection, no record
     can silently discard another device's concurrent members.

4.2  VALIDATION. On receipt (before DC-02 gating and before DC-03
     detection), every incoming record whose field_path addresses a
     known collection-valued path MUST be validated:

       - operation must be member_add | member_update | member_remove
       - payload must carry member_id matching the final component of
         field_path
       - member_id must be a well-formed UUIDv4-format identifier

     A record violating any of these (including any hypothetical bulk/
     replacement form, e.g. operation="set" on "reminders", or a
     payload containing an array of members) is INVALID INPUT.

4.3  REJECTION AND QUARANTINE. An invalid record MUST be:

     a) NEVER APPLIED — no part of it may mutate collection state,
        knowledge state beyond clock advancement, or conflict records;
     b) QUARANTINED durably: stored with at least
          {
            "quarantine_reason": <machine-readable code, e.g.
                                  "whole_collection_replacement" |
                                  "member_id_mismatch" |
                                  "invalid_member_id">,
            "received_at_hlc": ...,
            "sender_device_id": ...,
            "raw_record": <the record verbatim>
          }
        so it can be inspected and reported;
     c) SURFACED, not swallowed: quarantine events MUST be countable
        and observable (a test must be able to assert "exactly one
        record quarantined with reason X"); they are diagnostics, NOT
        user-facing conflicts and NOT resolvable through the conflict
        UI;
     d) NON-BLOCKING for the rest of the session: other records from
        the same sender continue to apply normally.

     Quarantine is a durable diagnostic holding area; exact storage
     location/tables are deferred decision #10, retention policy is an
     implementation choice provided (b)-(c) hold.

4.4  Rationale. Because replacement cannot exist, merge results never
     depend on collection snapshots — only on the SET of member-level
     changes ever applied, which is what makes section 6 provable.

==================================================
5. MEMBER REMOVAL AND MEMBER TOMBSTONES
==================================================

5.1  Deletion of a member uses the ordinary member_remove record with
     exactly the DC-01 operation semantics — nothing special-cased.

5.2  MEMBER TOMBSTONE. Applying member_remove(M) creates a durable
     member tombstone for (entity_id, collection_path, M) recording
     the removing change's identity and causality_clock. Purpose:
     prevent reintroduction of M by stale peers (INVARIANT 8 extended
     to members). Specifically:

       - A stale peer that has not yet seen the removal and replays
         member_add/member_update for M causally BEFORE the removal
         must not resurrect M: the incoming record is dominated by the
         tombstone's clock and is discarded as already-superseded.
       - A genuine concurrent add/update of the SAME M (clocks mutually
         non-dominating with the removal) is a CONFLICT per Rule 3.5 /
         DC-03 §3.4 — preserved, not dropped.

5.3  member_id non-reuse (§2.2c) plus tombstones ensure a removed
     member can never be confused with a new distinct member.

5.4  BOUNDARY WITH ENTITY COMPACTION. When the whole ENTITY is deleted
     (event tombstone, DC-01 §6), its collections die with it; whether
     and when member tombstones may be compacted alongside entity-
     level tombstones/change history is DC-06's business exclusively.
     This contract requires only that compaction preserve INVARIANT 8
     semantics: after any compaction, no trusted incremental peer can
     resurrect a removed member. Until compacted, member tombstones
     persist across restart like all domain data (INVARIANT 2).

==================================================
6. EDGE CASES
==================================================

6.1  REMOVING THE LAST MEMBER.
     Perfectly legal. The collection becomes empty but CONTINUES TO
     EXIST as a value (an empty map), distinguished from "no such
     collection". Removing the last member produces an ordinary
     member_remove record; no aggregate record is emitted. A device
     may also remove several last-members concurrently — each is its
     own conflict entity; empties compose.

6.2  AUTO-VIVIFICATION.
     Adding a member to a collection that does not yet exist locally
     (e.g. an event replicated before any reminder arrived, or a fresh
     entity) implicitly CREATES the empty collection on first
     member_apply. Auto-vivification is implicit, local-only, and
     produces NO change record of its own — the member_add record IS
     the creation. It is deterministic: any device applying the same
     change set vivifies identically.

6.3  REMOVING AN ABSENT MEMBER.
     Incoming member_remove(M) when M does not exist locally:

       a) If the removal is causally AFTER our knowledge (we simply
          haven't applied the intervening history yet, or we already
          removed M): applying it is a NO-OP beyond clock advancement.
          Deterministic either way — absent-or-later means the target
          state is "M absent" and it already is.
       b) If the removal is CONCURRENT with a local re-add/re-create
          of M (local member_add(M) with mutually non-dominating
          clocks): CONFLICT per Rule 3.5 — the removal does not
          silently destroy the re-add, and vice versa.
       c) If the removal is causally BEFORE everything we know about M
          (i.e., we know nothing newer): it applies as a tombstone for
          an already-absent member — still recorded (§5.2), still a
          no-op to visible state.

     In all cases the result depends only on clock comparison between
     the removal and local knowledge of M — never on arrival order.

==================================================
7. DETERMINISM REQUIREMENT
==================================================

Given the same SET of member-level change records applied, the final
collection state is THE SAME regardless of application order,
delivery order, duplication, or interleaving across devices
(INVARIANT 14):

    state(collection) = F({applied member changes})      -- set function

Formally, for any permutation π of a fixed multiset of deliveries D:

    apply(D) == apply(π(D)) == apply(D duplicated arbitrarily)

This holds because:
  - each member evolves independently under DC-03's commutative-safe
    rules (identical values converge idempotently; divergent pairs
    surface as order-independent Conflict Records);
  - union across members is commutative/associative/idempotent;
  - no positional, size-based, or snapshot-based reasoning exists
    anywhere in the pipeline (sections 2, 4).

Conflicts detected during reordered replay are likewise stable: the
same concurrent pair yields the same participant set whichever side
arrives first (only conflict_id/detected_at_hlc differ, which are
device-local presentation metadata).

==================================================
8. EXAMPLES
==================================================

8.1  Union of concurrent adds:
     Phone adds reminder r-1(30min), Desktop concurrently adds
     r-2(15min) to the same event. Both devices end with both
     reminders. Zero conflict records.

8.2  Disjoint edits:
     Phone updates r-1 -> 20min while Desktop removes r-2,
     concurrently. Both effects land everywhere independently.

8.3  Same-member divergence:
     Phone sets r-1=45min, Desktop sets r-1=10min, concurrent ->
     unresolved conflict on ("e-a1b2...", "reminders.r-1") holding
     both payloads (DC-03 §4 shape).

8.4  Identical-value convergence:
     Both devices independently set r-1=30min -> second arrival is a
     no-op; converged; no conflict record.

8.5  Delete vs re-add:
     Desktop removes attendee a-9; Phone (unaware) re-adds a-9 with a
     new role value -> conflict per 3.5; neither intent lost. Had
     Phone re-added a DIFFERENT member a-10 instead, union would apply
     (different entity).

8.6  Stale peer:
     Tablet, offline since before the r-1 removal, syncs and replays
     its old member_update(r-1=50). Its clock is dominated by the
     tombstone's clock -> superseded, discarded, r-1 stays absent
     (INVARIANT 8).

==================================================
9. TESTABLE REQUIREMENTS
==================================================

TR-1  Union: two simulated devices concurrently member_add distinct
      member_ids to the same collection; after bidirectional sync both
      devices hold exactly the union of members, zero conflict records.

TR-2  Independence: concurrent edits/removes touching disjoint
      member_ids produce zero conflict records and every device
      converges to the composition of both effects.

TR-3  Same-member divergence: concurrent differing adds/updates of one
      member_id yield EXACTLY one unresolved conflict record on that
      member entity preserving both payloads; local value unchanged
      pending resolution.

TR-4  Identical-value convergence: delivering k>=1 copies of a
      member change whose effective value deep-equals current local
      value — under any concurrency/order — results in no conflict and
      no state change beyond clock advancement.

TR-5  Delete-vs-readd: concurrent member_remove(M) and
      member_add/update(M) produce an unresolved conflict (neither
      intent silently wins); a concurrent remove of M and add of a
      DIFFERENT member N do NOT interact.

TR-6  Auto-vivification: member_add applied against a locally absent
      collection implicitly creates it, emits no extra change record,
      and leaves the device indistinguishable (by state hash) from a
      device that had the collection all along.

TR-7  Whole-collection rejection: feeding a record with
      operation="set" on a collection path, or a member operation with
      missing/mismatching/non-UUID member_id, results in: record not
      applied (state hash unchanged apart from clock), exactly one
      quarantine entry with the correct machine-readable reason and
      verbatim raw_record, and normal continued processing of other
      records from the same sender.

TR-8  Order-independence/convergence property test: over >=500
      randomized operation sequences (adds/updates/removes across >=2
      and up to 4 simulated devices, random delays, duplicates, and
      permutations, including causal chains), all devices converge to
      byte-identical collection state once all changes are delivered;
      the conflict-record SET (by conflict_entity and participant
      payloads) is identical across permutations.

TR-9  Positional neutrality: for any scenario, inserting a spurious
      array reorder on one device (or shuffling serialized member
      order in transit) changes NO merge result, NO conflict outcome,
      and NO synchronized content — position/index never appears in
      any change record payload used for merging.

TR-10 Tombstone protection: a stale peer replaying a pre-removal
      member change for removed M after syncing does not resurrect M;
      the replay is discarded as dominated; a genuinely concurrent
      same-member change still surfaces as a conflict (not silently
      dropped).

TR-11 Absent-member removal: member_remove of a nonexistent member is
      a clean no-op (case 6.3a/c) or a conflict when concurrent with a
      local re-add (case 6.3b) — never a crash, never a resurrection,
      never silent loss.

TR-12 Last-member removal: removing the final member yields an empty
      but existing collection, propagates as an ordinary
      member_remove, and converges on all devices.

==================================================
10. OUT OF SCOPE
==================================================

- Attendee-specific UI or semantics (roles, response status)  -> future
  domain/UI work; attendees here are just collection members
- Recurrence override collections, beyond the single-member
  independence already fixed by DC-03 §2.1/§3.7               -> deferred #5
- Exact SQLite schema/tables for collections, member tombstones,
  quarantine storage                                          -> deferred #10
- Wire format/framing of member records                       -> deferred #11
- Tombstone compaction timing (member and entity level)       -> DC-06
- Conflict-resolution flows and UI                            -> deferred #12
- Full-state resynchronization of collections                 -> deferred #7

==================================================
11. OPEN ITEMS OWNED ELSEWHERE
==================================================

- Compaction of member tombstones relative to entity tombstones -> DC-06
- How unresolved member conflicts gate sync of the parent entity ->
  sync protocol contract
- Presentation/display ordering of members (sorting, UI) -> UI contracts
- Whether future collection types need typed member validation rules
  beyond this contract's structural checks -> domain design work
