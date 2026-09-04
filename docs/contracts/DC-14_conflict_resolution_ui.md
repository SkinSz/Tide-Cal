# TIDE DESIGN CONTRACT DC-14
# Conflict Resolution UI — Semantics and Flows
Status: APPROVED by project owner (2026-08-25)

OWNER AMENDMENTS (2026-08-25):
- A dedicated "Conflicts" GUI button/entry point opening the conflict
  list view (§5.2), with sequential one-after-another resolution, is
  NORMATIVE (not optional).
Depends on: Architecture Spec v0.3 §13, §30 (#12), §31; DC-03; DC-04; DC-06;
             DC-07; DC-08
Unblocks: implementation of all conflict UI surfaces
Resolves: deferred decision #12 from Spec §30

==================================================
1. PURPOSE
==================================================

Defines exactly HOW a user resolves conflicts: the semantics and flows of
the resolution surface, the mapping of user actions to DC-03 status
values, the resolution write path, propagation of outcomes to other
devices, bulk operations, and edge-case behavior.

This contract defines SEMANTICS AND FLOWS, not visual design. It fixes
what states exist, what actions are available, what each action writes,
and what must never happen. Colors, layout, copy, animation, i18n, and
notification-platform specifics are OUT OF SCOPE (§8).

DC-12 (recurrence-specific conflict handling) does not yet exist in
docs/contracts/ — it is a NOTED DEPENDENCY. This contract's flows apply
to recurrence-rule and occurrence-override conflict entities exactly as
to any other, subject to whatever DC-12 later adds; nothing here
pre-judges DC-12.

Core principle (Spec §13, INVARIANT 7, DC-03 §5): resolution is ALWAYS an
explicit human decision. The UI is the ONLY code path that may move a
conflict from "unresolved" to "resolved_*" (DC-03 §4.3).

==================================================
2. RESOLUTION PRINCIPLES
==================================================

P1  EXPLICIT HUMAN ACTION ONLY. No timer, restart, sync cycle, compaction
    pass, background process, or heuristic ever resolves or closes a
    conflict, under any condition (INVARIANT 7; DC-03 TR-7/TR-8). The two
    exceptions defined by contracts are: explicit user resolution (this
    contract) and obsolete closure on parent-entity deletion (§6.1),
    which records a state rather than choosing between values.

P2  NO BLOCKING. A conflict NEVER blocks local calendar use (INVARIANT 1).
    While a conflict on field F of entity E is unresolved, E remains fully
    usable with its current stored value: it renders, opens, edits, and
    syncs normally per existing rules. A visible badge marks the affected
    event. No modal dialog may interrupt editing, viewing, or syncing
    because a conflict exists.

P3  RECOVERABILITY UNTIL PROPAGATION. Every resolution option MUST be
    undoable within a local undo window (default: until the resolution's
    change record has been propagated — proven by the DC-06 §4.2
    knowledge machinery — with a minimum presentation window; exact
    duration is a presentation parameter). Undo restores BOTH the prior
    conflict status ("unresolved") AND the prior effective value, via new
    normal change records — never by deleting history. After the
    resolution has propagated to peers, undo is no longer offered (the
    outcome has become shared history); a user who changes their mind
    after that simply makes a NEW edit, which propagates causally like
    any edit (and may itself conflict if concurrent).

P4  NO TIMESTAMP WINNERS IN THE SURFACE. The UI never orders options by
    recency or pre-selects a winner based on hlc_timestamp/wall-clock
    (DC-03 §5). HLC values appear ONLY as friendly relative-time labels
    ("about 10 minutes ago") for orientation — presentation only.

==================================================
3. CONFLICT SURFACE MODEL
==================================================

3.1  BADGE LAYER (non-blocking)

     - Each event/entity carrying >= 1 unresolved conflict shows a badge
       count = number of unresolved conflict records touching it.
     - An OPTIONAL global indicator shows total unresolved conflicts
       ("N unresolved conflicts"), tappable/inspectable to open the
       conflict list view (§5.2).
     - Badges are advisory. Their presence or absence never gates
       editing, deletion, or sync of the underlying entity.
     - NO modal dialogs anywhere in this surface. Conflict awareness is
       ambient; engagement is always user-initiated.

3.2  CONFLICT DETAIL VIEW

     One view per conflict record, showing exactly:

     a) Entity + field: human-readable identity of the conflict entity
        (entity summary + field_path rendered readably).

     b) BOTH candidate values side by side, each annotated with:
          - which device produced it (participant device_id, resolved to
            its paired-device display name)
          - when: detected/participant hlc rendered as friendly relative
            time — PRESENTATION ONLY (P4); no ordering implication.
        For delete-vs-edit conflicts, the deleted side renders as
        "value was removed" with the prior value recoverable from the
        participant payload.

     c) Participant list: every participant change record (DC-03 §4) with
        device attribution, so N-way conflicts (>2 devices) remain
        legible. All participants' values are selectable candidates.

     d) Available actions (§4), including Skip / decide later.

     The detail view reads exclusively from the local conflict record +
     participant payloads. Opening it triggers NO detection run and NO
     state mutation.

==================================================
4. RESOLUTION OPTIONS — EXACT STATUS MAPPING
==================================================

Every user action maps to exactly one DC-03 §4 status value:

  "Keep mine"      -> status := "resolved_keep_local"
                      winning value = the LOCAL current value (the
                      participant produced by this device / already
                      applied locally).

  "Keep theirs"    -> status := "resolved_keep_incoming"
                      winning value = the incoming participant's value.

  "Keep both" /
  manual merge     -> status := "resolved_custom"
                      winning value = user-supplied resolved_value.
                      Semantics per value class:
                        - Text fields: the detail view offers a combined
                          editor seeded with both values side by side;
                          the user composes the final text freely (the
                          result need not contain either input verbatim).
                        - Collection members (DC-04 member conflicts):
                          BOTH member variants are presented; the user
                          picks one, edits one before keeping, or
                          supplies a merged member body as resolved_value.
                        - Delete-vs-edit: "keep both" means re-applying
                          the edited value over the removal is expressed
                          explicitly as a custom choice, not implicit.

  "Skip / decide
   later"          -> NO write. Status remains "unresolved". The detail
                      view closes; badge persists. Skipping is free and
                      repeatable.

Rules:

4.1  There are NO other terminal outcomes. Any future option MUST map
     onto this enum or extend the enum via a new approved contract.

4.2  The UI MUST NOT rank, highlight, or pre-select an option by recency
     (P4). Default focus placement is a presentation choice, but no
     option may be auto-executed.

4.3  Resolution of ONE conflict record affects only that record's
     conflict entity. Resolving a title conflict never silently resolves
     a concurrent start-time conflict on the same event; each conflict
     entity gets its own explicit decision (bulk operations, §5, are
     still N individual decisions — see 5.3).

==================================================
5. BULK OPERATIONS
==================================================

5.1  PER-EVENT BULK: an event with K unresolved conflicts offers
     "resolve all conflicts on this event", which opens a sequential flow
     presenting the K detail views (or a compact combined list) and
     applies each chosen option individually.

5.2  CONFLICT LIST VIEW: a filterable list of unresolved conflicts,
     filterable at minimum by calendar and date range (of the affected
     entity). Selecting entries enables bulk actions.

5.3  NO SPECIAL BULK SEMANTICS. A bulk action applying option X to M
     selected conflicts is DEFINED AS exactly M individual resolutions
     applied sequentially through the identical write path of §6 — same
     transactions, same change records, same propagation messages, same
     undo behavior per item. Bulk is a UI convenience, never a distinct
     semantic mode. Partial completion (user aborts midway, crash
     mid-bulk) leaves completed items resolved and remaining items
     untouched, each individually consistent.

==================================================
6. RESOLUTION WRITE PATH & PROPAGATION
==================================================

6.1  WRITE PATH (local, atomic)

     Choosing Keep mine / Keep theirs / Keep both executes, inside ONE
     transaction per DC-07 §7 (T1 + conflicts.status update):

       1. the chosen value is written back as a NORMAL new change record:
          fresh local_seq, fresh causality clock entry, normal operation
          and payload (DC-03 §4.4) — via standard T1;
       2. the conflict row flips status -> resolved_* atomically in the
          SAME transaction, setting resolved_value (custom only) and
          resolved_at_hlc.

     Crash safety: a kill between steps can never yield a resolved status
     without its change record or vice versa (WAL rollback, DC-07 §7).

6.2  UNDO

     Undo within the window (P3) writes ANOTHER normal change record
     restoring the prior effective value, and flips status back to
     "unresolved", in one transaction. Undo never deletes or rewrites
     history. Status transitions accepted locally are therefore:
     unresolved -> resolved_*, and resolved_* -> unresolved (undo only,
     pre-propagation). After propagation proof (DC-06 §4.2 machinery),
     undo is withheld.

6.3  PROPAGATION TO PEERS (DC-08 §3.5)

     The resolved conflict record travels via CONFLICT_RECORDS. On
     receipt, a peer applies this DEDUP / RESOLVED-ON-RECEIPT rule:

       IF the peer holds a conflict record matching by
       conflict_entity + participant set (DC-08 §3.5 upsert key)
         AND the peer's copy is still status="unresolved"
         AND the arriving record's participants match its own
         THEN mark its copy resolved with the arrived outcome
              (resolved-on-receipt): suppress any pending badge/prompt
              for it; do NOT re-prompt its user; do NOT re-detect.

       ELSE (participants don't match, i.e., the peer independently
       detected its own variant of the conflict): treat as a separate
       local conflict; its own user decides. Detection results are never
       overwritten by metadata.

     Receiving a resolution NEVER mutates entity data on the peer. If the
     peer wants its stored value to match the resolution, the resolution
     change record arrives through the NORMAL CHANGES_BATCH causal path
     and applies per DC-02 §7 (including possibly conflicting again if
     the peer made a concurrent divergent edit — which is then a genuine
     new conflict, surfaced normally).

6.4  RACING RESOLUTIONS (second-order problem) — ACCEPTED LIMITATION

     Question: if devices A and B resolve the SAME conflict DIFFERENTLY
     before either sees the other's resolution, is the divergence a
     second-order conflict?

     v1 RULE — FIRST RESOLUTION WINS BY ARRIVAL:
       - A peer applies an arriving remote resolution only if its local
         copy is still unresolved (per 6.3).
       - If its user ALREADY resolved locally, an arriving stale
         resolution is RECORDED but does NOT overwrite the local
         resolved status, value, or change record.
       - Consequence: devices that resolve concurrently and divergently
         converge deterministically to whichever resolution ARRIVED
         first locally — different devices may retain different
         outcomes, and the underlying entity values converge only
         through the normal causal application of the resolution change
         records (later concurrent edits may legitimately conflict again
         and be surfaced normally).

     This asymmetry is ACCEPTED FOR V1. It is deterministic, requires no
     second-round UX, never discards data silently (both resolutions
     remain in history), and honors P1/P4 (no timestamp arbitration —
     arrival order is mesh order, not clock order). A future contract
     MAY add explicit second-order reconciliation; it MUST NOT be
     invented during implementation.

==================================================
7. EDGE CASES
==================================================

7.1  CONFLICT ON DELETED ENTITY (obsolete closure)

     If the entity parent to a conflict entity is tombstoned elsewhere
     while the conflict is unresolved, the conflict AUTO-CLOSES as
     OBSOLETE:

       - transition: status "unresolved" -> "obsolete"
         (a device-local explanatory state; it is NOT a DC-03 §4
         resolved_* value and MUST NOT map onto one — no value was
         chosen);
       - the record is retained, visibly marked "closed — event was
         deleted", listing the tombstone that caused it; never silently
         dropped;
       - obsolete is TERMINAL: no badges, no prompts, no further
         resolution actions; the record participates in compaction per
         DC-06 rules;
       - the tombstone itself is unaffected (INVARIANT 8: deletion wins
         over offline resurrection — but visibly and explainably, not
         silently);
       - if the deletion races a local resolution, normal ordering rules
         apply: whichever the causal layer delivers first stands; a
         resolution arriving after obsolete closure is recorded only.

7.2  PARTICIPANT COMPACTION CANNOT STRAND A CONFLICT — ASSERTION

     A conflict whose participants were compacted away CANNOT arise:
     DC-06 §4.1 forbids compacting any change participating in an
     UNRESOLVED conflict, regardless of clock predicates. The UI may
     therefore always assume participant payloads are present while a
     conflict is unresolved, and MUST treat their absence as a defect
     (fail loudly in development builds; render "data unavailable" and
     keep the conflict unresolved otherwise — never fabricate a value).

7.3  OFFLINE RESOLUTION

     Resolution is a purely local transaction (§6.1): fully functional
     offline (INVARIANT 1). The change record queues and propagates on
     the next sync window. Undo remains available until the propagation
     proof of P3; offline, that simply means the whole offline period.

7.4  RESTART / SYNC INTERACTION

     Unresolved conflicts survive restart byte-identical (DC-03 TR-8).
     Sync apply paths (T2/T3) never touch conflict status except
     creating/updating records as "unresolved"; resolved-on-receipt
     (§6.3) is the sole sync-driven status transition and only targets
     still-unresolved copies.

==================================================
8. TESTABLE REQUIREMENTS
==================================================

TR-1  OPTION-TO-STATUS EXACTNESS: executing Keep mine / Keep theirs /
      Keep both yields conflict status EXACTLY resolved_keep_local /
      resolved_keep_incoming / resolved_custom respectively, plus
      EXACTLY ONE new normal change record carrying the winning value
      (fresh local_seq + clock), written in the same transaction (no
      intermediate observable states under crash injection between the
      mutation and the status flip).

TR-2  SKIP IS A NO-OP: Skip leaves status "unresolved", writes zero
      change records, mutates no entity data, and the badge persists.

TR-3  UNDO RESTORES FULLY: undo within the window restores prior
      effective value AND status "unresolved", via additional normal
      change records (history append-only — verified by audit that no
      rows were updated/deleted in `changes`); after a simulated
      propagation proof, undo is unavailable.

TR-4  PROPAGATION WITHOUT REPROMPTING (extends DC-08 TR-8): devices A,B
      share conflict X; A resolves X; C — which had displayed X
      unresolved from CONFLICT_RECORDS — on next sync with A marks X
      resolved-on-receipt WITHOUT prompting its user (instrumented:
      zero resolution-UI invocations) and without running detection.

TR-5  STALE RESOLUTION DOESN'T OVERWRITE: A and B resolve the same
      conflict differently out-of-band; whichever resolution arrives
      second at a given device is persisted as received-but-not-applied
      metadata and the device's own earlier resolution status/value/
      change record are unchanged (byte-compare before/after).

TR-6  OBSOLETE CLOSURE: tombstoning an entity with an unresolved
      conflict flips that conflict to "obsolete" (terminal, retained,
      explainable), never deletes it and never maps it to any
      resolved_* value; INVARIANT 8 holds.

TR-7  BULK = N SEQUENTIAL INDIVIDUALS: resolving M conflicts via bulk
      produces byte-equivalent persistent state (changes rows, conflict
      statuses, clocks) to issuing M individual resolutions sequentially
      in the same order; injected failure after k<M items leaves exactly
      k resolved and M-k untouched.

TR-8  NO AUTO-RESOLVE EVER (behavioral): across restart, backup/restore,
      repeated sync cycles, delayed/duplicated/reordered messages,
      compaction sweeps, and wall-clock/timer advancement (incl. system
      clock jumps), every unresolved conflict remains unresolved unless
      a user action or §6.3/§7.1 rule fired — instrumented counter of
      non-user status transitions == expected set only.

TR-9  NO MODAL BLOCKING: while a conflict is unresolved, the affected
      entity opens/edits/syncs normally; static + behavioral check that
      no code path presents a modal gated on conflict existence.

TR-10 PRESENTATION-ONLY HLCS: behavioral test that no UI path orders,
      pre-selects, or auto-executes resolution options using
      hlc_timestamp/wall-clock (restates DC-03 TR-7 at the UI layer).

==================================================
9. OUT OF SCOPE
==================================================

- Visual design: colors, layout, iconography, animation, copywriting
- Internationalization / locale formatting of relative times
- Notification platform specifics (OS banners, push, badges plumbing)
- Quarantine review UX (DC-08 §5 quarantine queue) — separate future work
- Recurrence-specific resolution semantics beyond [24] independence
  -> DC-12 (NOT YET WRITTEN — noted dependency; must not contradict
     this contract when it lands)
- Second-order resolution reconciliation beyond the §6.4 v1 rule
- SQLite storage details of conflict/UI state               -> DC-07

==================================================
10. OPEN ITEMS OWNED ELSEWHERE
==================================================

- Exact undo-window presentation duration                  -> platform UX
- Whether "obsolete" records compact on the same predicates as resolved
  ones                                                     -> DC-06 revision
- DC-12 recurrence flows interplay                         -> DC-12
