# TIDE DESIGN CONTRACT DC-03
# Scalar Conflict Detection
Status: APPROVED by project owner (2026-08-25); v2 amendment 2026-08-30
        (§3.2a stale causal-before = history only — P11 remediation,
        owner-directed work package)
Depends on: Architecture Spec v0.3 §8, §9, §13, §14, §30, §31; DC-01; DC-02
Unblocks: DC-04 (collection merge), conflict-resolution UI (deferred #12),
          sync protocol conflict-record transport (deferred #11)
Resolves: deferred decision #3 from Spec §30
Changelog: v2 (2026-08-30) — adds §3.2a closing the §3.3 fall-through for
           causally dominated incoming records (QA-1 P11). No prior rule
           changed; §3.1/3.2/3.3-3.7 semantics untouched.

==================================================
1. PURPOSE
==================================================

Defines exactly WHEN an incoming change record conflicts with local state,
and the persisted shape of the resulting Conflict Record.

Scope is SCALAR / SINGLE-MEMBER detection only:

  - one logical field of one entity at a time
  - the single-member boundary case of collection operations

It does not define collection-wide merge algebra (DC-04), how conflicts are
resolved by users or automatically (deferred #12), how conflict records
travel between devices (deferred #11), or when tombstone compaction may
consume change records that participate in conflicts (DC-06).

Core principle (Spec §13, INVARIANT 7): a conflict is DATA, never a
silent decision. Detection never picks a winner.

==================================================
2. DEFINITIONS
==================================================

2.1  Conflict Entity

     A conflict entity is ONE logical field of ONE entity, identified by
     the pair:

         conflict_entity = (entity_id, field_path)

     where entity_id and field_path carry exactly the meanings assigned
     by DC-01 §2. Two change records touch the SAME conflict entity iff
     their (entity_id, field_path) pairs are equal.

     Special conflict entities from Spec [24] and DC-01 §3.1:

       - The series recurrence rule is its own conflict entity:
             (series_uuid, "recurrence_rule")

       - EACH occurrence override field is its own conflict entity:
             (series_uuid, "overrides.<recurrence_id>.<field>")

     RULE [24]-R1: A series-rule change and an occurrence-override change
     on the same series are NEVER compared against each other for
     conflicts. They are different conflict entities; both survive
     independently even if concurrent. (Recurrence-specific resolution
     semantics beyond this independence are deferred decision #5.)

2.2  Participant Change

     An already-applied, un-compacted change record L held locally that
     touches the same conflict entity as an incoming change record C.
     "Un-compacted" means the record has not yet been removed from local
     history by tombstone/history compaction (DC-06). Once a participant
     is compacted away, it can no longer take part in NEW detections —
     compaction cutoffs must therefore respect DC-06's rules.

2.3  Concurrency

     Defined solely by DC-02 §3: concurrent(C, L) is true iff neither
     causality clock dominates the other. hlc_timestamp plays NO role in
     any determination in this contract (see §5).

2.4  Effective Value Semantics

     The value of a conflict entity after applying a change:
       operation "set"            -> payload.value
       operation "remove"         -> DELETED (field absent)
       operation "member_add" /
                  "member_update" -> payload.value for that member_id
       operation "member_remove"  -> DELETED for that member_id

     Two values are IDENTICAL iff they are deep-equal JSON values, or both
     are DELETED.

==================================================
3. DETECTION ALGORITHM
==================================================

When an incoming change record C arrives and passes DC-02 §7 application
gating (not duplicate, gap contiguous), BEFORE mutating local state the
device evaluates C against all participants L for C's conflict entity:

    function detect(entity_id, field_path, C):
        E = (entity_id, field_path)
        locals = [L for L in applied_uncompacted_changes
                  if touches(L, E)]

        // Rule 3.1: identical-value convergence first
        if effectiveValue(C) == currentLocalValue(E):
            apply nothing (no-op); return NO_CONFLICT

        // Rule 3.2: causal-after applies cleanly
        if for all L in locals: causallyBefore(L, C):
            apply C normally; return NO_CONFLICT

        // Rule 3.2a: stale causal-before = history only (v2)
        if any L in locals: causallyBefore(C, L):
            do NOT mutate the materialized row;
            store C in history (DC-02 §7) + merge clocks;
            return STALE_SUPERSEDED (no conflict record)

        // Rule 3.3: concurrency check
        conflicting = [L for L in locals if concurrent(C, L)
                       and valuesDiffer(C, L)]
        if conflicting is empty:
            apply C normally; return NO_CONFLICT
        else:
            do NOT overwrite;
            create/update Conflict Record per section 4;
            return CONFLICT

Rules in prose:

3.1  IDEMPOTENT CONVERGENCE. If C's effective value equals the local
     current value of the conflict entity, C is a no-op REGARDLESS of
     concurrency. Two devices independently writing the same value have
     converged; there is nothing to preserve.

3.2  CAUSAL-AFTER. If C is causally after every participant (per DC-02
     sameOrDescendant), C applies normally. No conflict exists — later
     knowledge supersedes earlier knowledge deterministically.

3.2a STALE CAUSAL-BEFORE = HISTORY ONLY (v2, added 2026-08-30). If C is
     causally BEFORE any participant L on the same conflict entity
     (causallyBefore(C, L) per DC-02 §3 — some local participant already
     dominates C's knowledge), C is part of history but MUST NOT mutate the
     materialized entity row: a causally dominated operation cannot regress
     newer state. C is still stored in the change history with clocks merged
     (DC-02 §7 application gating is unaffected) so replication, compaction
     accounting, and future detections keep working. No Conflict Record is
     created: there is no concurrent divergence to preserve — C is simply
     late delivery of superseded knowledge. This rule closes the §3.3
     fall-through gap exposed by QA-1 P11 (stale title overwrote a newer
     row; see docs/qa/remediation/p11-diagnosis.md).

     Distinction preserved: causally-BEFORE (this rule, drop from
     materialized state) vs CAUSAL-AFTER (3.2, apply) vs CONCURRENT
     (3.3/3.4, conflict record). Genuine concurrent edits are never caught
     by this rule: concurrent(C, L) and causallyBefore(C, L) are mutually
     exclusive by DC-02 §3 definitions.

3.3  CONCURRENT SAME-FIELD DIFFERENCE = CONFLICT. If C is concurrent
     (DC-02 §3) with any participant on the same conflict entity and their
     values differ, detection produces/extends a Conflict Record. Local
     state is NOT overwritten. BOTH values are preserved in the record.

3.4  DELETE VS EDIT. "remove" participates like any value: a concurrent
     set-vs-remove or member_update-vs-member_remove pair is a CONFLICT.
     Neither side wins:
       - the delete does NOT silently destroy the concurrent edit
       - the edit does NOT silently resurrect over the delete
     The stored pre-conflict local value remains visible until resolution.

3.5  MULTIPLE PARTICIPANTS. If C is concurrent with several participants,
     they join ONE conflict record for that conflict entity (participants
     list, §4), not one record per pair.

3.6  DIFFERENT FIELDS NEVER CONFLICT. Concurrency between changes on
     different conflict entities never produces a conflict here; each
     applies independently (Spec §13 "may merge automatically").

3.7  COLLECTION BOUNDARY CASES (single-member only):

     a) member_add of member_id M concurrently with member_add of the
        SAME M with DIFFERING values      -> CONFLICT on
        (entity_id, "<collection_path>.<M>").
     b) member_add of member_id M concurrently with member_add/update of
        the same M with identical values   -> no-op convergence (3.1).
     c) member_add/member_update of DIFFERENT member_ids                   -> merge, NOT conflict (union/independence, Spec §14).
     d) Concurrent add vs remove of the same member_id      -> CONFLICT (3.4).

     All remaining collection-wide semantics (ordering, bulk merge,
     member identity edge cases) are DC-04.

==================================================
4. CONFLICT RECORD
==================================================

A Conflict Record is a first-class, durable, locally stored object:

conflict_id         string   UUIDv4, generated once at detection time,
                             stable forever.

conflict_entity     object   { "entity_id": ..., "field_path": ... }
                             Exactly the conflict entity of §2.1.

participants        array    Every change record taking part, including
                             the incoming C and every concurrent local L.
                             Each entry:
                               {
                                 "change_id":       ...,
                                 "device_id":       ...,
                                 "local_seq":       ...,
                                 "causality_clock": { ... },
                                 "payload":         ...
                               }
                             Participants are immutable once added.

detected_at_hlc     integer  HLC of the DETECTING device at detection.
                             Presentation/ordering only (§5).

status              enum     "unresolved"
                             | "resolved_keep_local"
                             | "resolved_keep_incoming"
                             | "resolved_custom"

resolved_value      optional The final chosen value when status is
                             resolved_* ("resolved_custom"), or absent.

resolved_at_hlc     optional HLC of the resolving device at resolution
                             time; present only once resolved.

Example:

{
  "conflict_id": "c-7d31e0a9-...",
  "conflict_entity": { "entity_id": "e-a1b2...",
                       "field_path": "title" },
  "participants": [
    { "change_id": "d-phone:184",
      "device_id": "d-phone", "local_seq": 184,
      "causality_clock": { "d-phone": 184, "d-desktop": 72 },
      "payload": { "value": "Dentist" } },
    { "change_id": "d-desktop:75",
      "device_id": "d-desktop", "local_seq": 75,
      "causality_clock": { "d-desktop": 75, "d-phone": 180 },
      "payload": { "value": "Doctor" } }
  ],
  "detected_at_hlc": 1724600000999,
  "status": "unresolved"
}

Rules:

4.1  Conflict records persist durably across restart, like all domain
     data (INVARIANT 2). An unresolved conflict MUST NOT be forgotten,
     dropped, or auto-resolved by any timer, restart, sync cycle, or
     compaction pass.

4.2  Conflict records are synchronizable metadata: other devices can
     learn resolution outcomes so the same user does not resolve the same
     conflict twice. They travel as data like any other synchronized
     content. The exact wire transport and propagation semantics belong to
     the sync protocol contract (deferred #11); this contract only fixes
     the persisted shape.

4.3  Resolution transitions (unresolved -> resolved_*) are performed only
     through explicit resolution actions (UI contract, deferred #12) —
     never as a side effect of detection, application, or sync.

4.4  On keep_local / keep_incoming / custom resolution, the winning value
     is written back as a NORMAL new change record (with fresh local_seq
     and causality clock) so that resolution itself propagates causally.
     The original participants remain referenced by the conflict record.

==================================================
5. PROHIBITION ON TIMESTAMP-BASED RESOLUTION
==================================================

NO code path in detection, storage, sync, UI, or resolution may select a
winner between concurrent changes by comparing hlc_timestamp, wall-clock
time, or any derived recency measure. This restates Spec frozen decision
[21], INVARIANT 7, and DC-01 §4.4 / DC-02 TR-5.

hlc_timestamp fields on changes and on conflict records are
PRESENTATION-ONLY: display ordering, tie-breaking for list rendering, and
debugging aids. A detected conflict always surfaces as an unresolved
Conflict Record until explicitly resolved.

==================================================
6. EXAMPLES
==================================================

6.1  Classic set-vs-set conflict (Spec §13 example):
     Phone sets title="Dentist" (P:184), Desktop sets title="Doctor"
     (D:75), clocks mutually non-dominating (DC-02 §3 worked example)
     -> one unresolved conflict record on (e-a1b2..., "title") holding
     both payloads. Neither title is discarded.

6.2  Different-field concurrency: Phone sets title, Desktop sets
     description, concurrently -> both apply, no conflict record.

6.3  Causal-after: Tablet edits title AFTER receiving Phone's edit
     (its causality clock dominates P:184) -> applies cleanly.

6.4  Identical-value convergence: Phone and Desktop concurrently set
     title="Dentist" identically -> second arrival is a no-op; no
     conflict record.

6.5  Delete vs edit: Phone removes start time while Desktop concurrently
     sets start to a new time -> conflict preserved on
     (entity_id, "start"); the event is neither silently emptied nor
     silently moved.

6.6  Recurrence independence ([24]): Phone edits series
     "recurrence_rule"; Desktop concurrently overrides one occurrence via
     "overrides.20260902T090000.start". Different conflict entities ->
     rule change and override both survive; NO conflict between them.
     Had two devices edited "recurrence_rule" itself concurrently, that
     WOULD be a normal scalar conflict under §3.

6.7  Same-member add: two devices concurrently member_add reminder r-88a1
     with minutes_before=30 and minutes_before=15 -> conflict on
     (event, "reminders.r-88a1"). Two DIFFERENT reminder member_ids added
     concurrently -> union, no conflict.

==================================================
7. TESTABLE REQUIREMENTS
==================================================

TR-1  Causal-after applies cleanly: for any change C causally after all
      uncompacted local participants on its conflict entity, C applies
      normally and no conflict record is created.

TR-2  Same-field concurrency yields EXACTLY one unresolved conflict
      record for the conflict entity, whose participants include both the
      incoming change and the local change, preserving BOTH payload
      values verbatim; local field value remains unchanged pending
      resolution.

TR-3  Different-field concurrency: concurrent changes to distinct
      field_paths of the same entity produce zero conflict records and
      both apply.

TR-4  Delete-vs-edit concurrency (set/remove and member-level variants)
      produces an unresolved conflict; the deleted value does not
      silently vanish and the edited value does not silently overwrite —
      both are recoverable from participants.

TR-5  Identical-value convergence: delivering a change whose effective
      value deep-equals the local current value — under any concurrency,
      k>=1 times, in any order — results in no conflict record and no
      state change beyond clock advancement (idempotent).

TR-6  Series-rule vs override independence: a concurrent series-rule edit
      and occurrence-override edit produce NO conflict between them and
      both survive; two concurrent edits of "recurrence_rule" itself DO
      produce a conflict under the standard algorithm.

TR-7  No-LWW assertion: behavioral + static test that no execution path
      resolves a concurrent pair using hlc_timestamp or wall-clock time
      (INVARIANT 7, Spec [21]); every concurrent differing pair surfaces
      as an unresolved conflict record.

TR-8  Persistence: conflict records survive process restart and
      backup/restore cycles unresolved, byte-identical (modulo storage
      encoding); none is dropped, auto-resolved, or re-detected as a
      duplicate conflict_id.

TR-9  Multi-participant collapse: an incoming change concurrent with N
      local changes on the same conflict entity produces exactly one
      conflict record listing all N+1 participants.

TR-10 Member boundary cases: same-member differing-value adds conflict;
      same-member identical-value adds converge idempotently; different-
      member adds never reach this contract's conflict path.

==================================================
8. OUT OF SCOPE
==================================================

- Exact conflict-resolution UI and flows               -> deferred #12
- Collection-wide merge algebra and ordering           -> DC-04
- Tombstone/history compaction interacting with
  conflict participants                                -> DC-06
- Wire transport / framing of conflict records         -> deferred #11
- How resolutions propagate between devices            -> sync protocol
                                                         contract
- Recurrence-specific resolution semantics beyond the
  [24] independence rule                               -> deferred #5
- SQLite tables/columns storing conflicts              -> deferred #10

==================================================
9. OPEN ITEMS OWNED ELSEWHERE
==================================================

- How unresolved conflicts block or gate sync of the affected entity
  -> sync protocol contract
- Whether resolved conflict records compact like change history, and when
  -> DC-06
- How DC-04 extends participant/value semantics to whole collections
  -> DC-04
- How the UI enumerates and presents unresolved conflict records
  -> deferred #12
