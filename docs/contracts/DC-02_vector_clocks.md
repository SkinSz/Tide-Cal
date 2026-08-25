# TIDE DESIGN CONTRACT DC-02
# Vector Clocks: Comparison, Merge, Advancement
Status: APPROVED by project owner (2026-08-25)
Depends on: Architecture Spec v0.3 §9, §10, §13, §14, §31; DC-01
Unblocks: DC-03 (scalar conflict detection), DC-04 (collection merge),
          missing-change detection in the sync protocol
Resolves: deferred decision #2 from Spec §30

==================================================
1. PURPOSE
==================================================

Defines the exact semantics of the vector-clock-style device knowledge
model referenced by DC-01's causality_clock field and Spec §10:

  - the per-device knowledge clock ("device clock")
  - the accumulated knowledge state used for dedupe and anti-entropy
  - comparison operations (dominates / causallyBefore / concurrent)
  - advancement rules (who may advance which entries, and how)
  - missing-change detection (exact needed seq ranges per device)
  - relay correctness and idempotent, reorder-safe application

This contract defines SEMANTICS ONLY. It does not define the wire
protocol (deferred #11), SQLite schema (deferred #10), or tombstone
compaction (DC-06).

==================================================
2. DEFINITIONS
==================================================

2.1  Device Clock ("device clock")

     A persistent map maintained by every Tide device:

         device_clock : Map<device_id, integer>
                        // device_id -> highest local_seq OBSERVED
                        // from that device

     Rules:
       a) The device's OWN entry equals its own current local_seq.
          It advances by exactly 1 each time the device creates a new
          change record (DC-01), i.e. it is assigned at change creation:
              device_clock[self] = new_local_seq
       b) Every entry for OTHER devices starts ABSENT (not 0). Absence
          means "no knowledge of this device", not "seen through seq 0".
       c) The map is durable: it survives restart, backup/restore of
          domain data, and process death.

     Example (Phone after creating its 184th change):
         { "d-phone": 184, "d-desktop": 72, "d-tablet": 31 }
     This is exactly the value stamped into Phone's next outgoing
     change record as causality_clock (DC-01 §2).

2.2  Knowledge State

     The knowledge state is the device's record of what it has APPLIED,
     tracked separately from the advertised device_clock:

         applied_upto : Map<device_id, integer>
             // per producing device, the highest local_seq such that
             // ALL changes 1..local_seq from that device have been
             // applied contiguously. Contiguity is required because
             // local_seq is gap-free per producer (DC-01 TR-2).

     Additionally, out-of-order arrivals above applied_upto are held:

         pending : Set<(device_id, local_seq)>
             // received changes with local_seq > applied_upto[device_id]
             // awaiting gap fill

     Invariant: for every device d,
         max(seq for (d,s) in pending, default = applied_upto[d])
             >= applied_upto[d]

2.3  Causality Clock (from DC-01)

     A vector clock snapshot carried by each change record:
         { "<device_id>": <seq>, ... }

2.4  Notation

     For clocks A, B and device id d:
       A[d]  = A.get(d, 0)        // absent treated as 0 FOR COMPARISON ONLY
       A|B   = element-wise merge  (A|B)[d] = max(A[d], B[d])

==================================================
3. COMPARISON OPERATIONS
==================================================

Pseudocode (authoritative):

    function dominates(A, B):
        // A has seen everything B has seen
        for d in keys(B):
            if A[d] < B[d]: return false
        return true
        // Note: extra entries in A are fine — more knowledge dominates.

    function sameOrDescendant(X, Y):
        // change X happened at-or-after change Y causally
        return dominates(X.causality_clock, Y.causality_clock)
               AND X.causality_clock[Y.producer] >= Y.local_seq

    function causallyBefore(Y, X):
        return sameOrDescendant(X, Y) and
               not equalClocks(X.causality_clock, Y.causality_clock)

    function concurrent(A, B):
        return not dominates(A, B) and not dominates(B, A)

Worked examples (Phone=P, Desktop=D):

    P = {P:184, D:72}      Desktop = {P:180, D:75}

    dominates(P, Desktop)?
      P[D]=72 < 75  -> false
    dominates(Desktop, P)?
      Desktop[P]=180 < 184 -> false
    => concurrent(P, Desktop) == true.
    Neither side wins. hlc_timestamp MUST NOT break this tie (Spec [21],
    [DC-01 §4.4]); the pair is handed to conflict detection (DC-03).

    More examples:
      A={P:185,D:75} vs B={P:184,D:72}
        A[P]>=B[P], A[D]>=B[D], clocks unequal
        => causallyBefore(B, A); A dominates B. Auto-apply A.
      A={P:184} vs B={P:184}
        equalClocks -> neither before nor after; identical knowledge
        point. If these are two different changes, they are concurrent.
      A={P:184,D:72,T:5} vs B={P:184,D:72}
        dominates(A,B)=true, dominates(B,A)=false -> B causally before A.

Properties that follow from these definitions:
  - dominates is reflexive and transitive (partial order).
  - concurrent is symmetric but NOT transitive.
  - merge (|) is commutative, associative, idempotent.

==================================================
4. ADVANCEMENT RULES
==================================================

4.1  OWN ENTRY. A device's own device_clock[SELF] advances ONLY when the
     device itself creates a change record. Nothing else — not receiving
     a peer's clock that shows a higher value for SELF (impossible unless
     identity theft), not restore, not sync — writes to it.

4.2  RECEIVED ENTRIES. When a change record or any message carrying a
     causality_clock C arrives over an authenticated channel:

         for d, s in C:
             if s > device_clock[d]:
                 device_clock[d] = s        // element-wise max only

     Entries never decrease. Unknown device_ids are ADDED (first sight of
     a newly paired/relayed device).

4.3  No entry ever regresses: device_clock[d] := max(device_clock[d], s).
     Restore-from-backup must take max with restored state, never assign
     (Spec INVARIANT 10).

4.4  applied_upto advances only along contiguous application:
         apply(d, seq): if seq == applied_upto[d] + 1 then advance and
         drain consecutive members of pending; else buffer in pending.

==================================================
5. MISSING-CHANGE DETECTION
==================================================

Given a peer P advertising clock ADV (its device_clock) and our knowledge
state (applied_upto U, pending set), the exact set of changes we need:

    function neededRanges(ADV):
        need = []
        for d, adv_seq in ADV:
            have = U[d]  // default 0 if absent
            if adv_seq > have:
                // we lack everything from have+1 .. adv_seq EXCEPT what
                // already sits in pending (arrived early, unapplied)
                have_pending = {s for (dd,s) in pending if dd == d}
                for (lo, hi) in invertToRanges(have+1, adv_seq,
                                               exclude=have_pending):
                    need.append((d, lo, hi))
        return need

    // invertToRanges(lo, hi, exclude): returns maximal contiguous
    // sub-ranges of [lo..hi] containing no member of `exclude`.

The inverse direction (what the PEER needs from us) is computed by the
peer symmetrically using OUR advertised clock. Anti-entropy therefore
converges: each exchange strictly reduces the union of missing ranges.

Example:
    ADV = {P:200, D:9}, U = {P:184, D:7},
    pending = {(D,9)}
    => need = [(P, 185, 200), (D, 8, 8)]
    (D:9 is excluded — already buffered, will apply once 8 arrives.)

==================================================
6. RELAY SUPPORT
==================================================

Relaying requires no special mechanism — it falls out of §4.2:

  1. Phone creates change (P, 184) with causality_clock
     {P:184, D:71} and sends to Desktop.
  2. Desktop applies it and merges the clock:
        Desktop.device_clock[P] = max(..., 184)
  3. Desktop forwards the UNMODIFIED change record (same change_id,
     same causality_clock, DC-01 §3.3) to Tablet.
  4. Tablet applies it and merges:
        Tablet.device_clock[P] = 184

Tablet now has knowledge of Phone's change 184 without ever talking to
Phone. Any future Tablet change carries {T:n, ..., P:184}, so Phone can
correctly judge its own change causally-before Tablet's descendants.
This realizes Spec §10's topology:

    Phone <-→ Desktop
                 ↓
              Tablet

with no direct Phone–Tablet channel and no central server (INVARIANT 11).

Correctness condition: a relayed record is forwarded byte-for-byte;
relays NEVER rewrite causality_clock or local_seq.

==================================================
7. IDEMPOTENCY AND REORDER SAFETY
==================================================

7.1  Application key. Every change is keyed by (device_id, local_seq)
     (= change_id, DC-01). Before applying:
         if seq <= applied_upto[device_id] OR (device_id, seq) in pending
             -> duplicate: drop silently, still merge sender's clock (§4.2).

7.2  Out-of-order arrival. seq > applied_upto + 1 -> store in pending;
     do not apply. When the gap fills, drain consecutively.

7.3  Gap handling. If a needed range does not arrive within normal
     operation, the missing-change computation (§5) re-reports it on the
     next anti-entropy round; the receiver may also request it directly
     (message protocol deferred #11).

7.4  Safety under any delivery order (INVARIANT 14): merging clocks is
     commutative/idempotent, so arrival ORDER of messages cannot change
     final knowledge state; application order within one producer is
     pinned by local_seq contiguity. Cross-producer interleaving is safe
     because conflicts are detected via §3 comparisons, not arrival order.

==================================================
8. EXAMPLES
==================================================

Phone creates its 185th change after having synced with Desktop:

{
  "change_id": "d-phone:185",
  "device_id": "d-phone",
  "local_seq": 185,
  "...": "...",
  "causality_clock": { "d-phone": 185, "d-desktop": 72 },
  ...
}

Desktop receives it:
    device_clock["d-phone"] = max(prev, 185)
    apply(d-phone, 185) since 185 == applied_upto["d-phone"] + 1
    -> applied_upto["d-phone"] = 185

Tablet receives the relayed copy while at applied_upto["d-phone"] = 182:
    183, 184 missing -> buffer 185 in pending
    neededRanges reports ("d-phone", 183, 184)
    after fetching them, drain 183, 184, 185 in order.

==================================================
9. TESTABLE REQUIREMENTS
==================================================

TR-1  Comparison correctness: for arbitrary clocks A, B:
      dominates(A,A) is true; dominates(A,B) and dominates(B,A) together
      imply equalClocks(A,B); concurrent(A,B) == (¬dominates(A,B) ∧
      ¬dominates(B,A)); concurrent is symmetric.
TR-2  Merge algebra: for arbitrary clocks A, B, C:
      A|B == B|A (commutative); (A|B)|C == A|(B|C) (associative);
      A|A == A (idempotent). Verified by property test.
TR-3  Gap detection: given any advertised clock and knowledge state,
      neededRanges returns exactly the disjoint contiguous ranges whose
      union is { (d,s) : s > applied_upto[d], s <= ADV[d], s ∉ pending }.
TR-4  Relay correctness across 3 devices (P→D→T): after relaying, T's
      device_clock[P] >= P.local_seq of the relayed change, T has applied
      it, and T's subsequent change clocks dominate the relayed change's
      causality_clock — verified without any direct P↔T traffic.
TR-5  No LWW anywhere: for a concurrent pair per §3, no code path selects
      a winner by hlc_timestamp or wall clock (Spec [21], INVARIANT 7);
      grep-level + behavioral test that concurrent pairs surface to
      conflict detection.
TR-6  Monotonicity: under any sequence of local creations, receives,
      merges, and restarts, device_clock[d] never decreases for any d.
TR-7  Idempotent application: delivering the same change k times (k>=1)
      in any order yields the same applied state and the same knowledge
      state as delivering it once.
TR-8  Reorder safety: for any permutation of a fixed multiset of change
      deliveries across multiple producers, final state converges once
      all gaps close (INVARIANT 14).

==================================================
10. OUT OF SCOPE
==================================================

- Wire envelope / sync message framing        -> deferred decision #11
- SQLite tables/columns storing clocks        -> deferred decision #10
- Tombstone compaction driven by knowledge    -> DC-06
- Full-state sync thresholds for stale peers  -> deferred decision #7
- Conflict detection/resolution algorithms    -> DC-03, DC-04, DC-05

==================================================
11. OPEN ITEMS OWNED ELSEWHERE
==================================================

- How conflict candidates from §3 become UI-visible conflicts  -> DC-03
- Collection-member concurrency using these comparisons        -> DC-04
- Compaction cutoff expressed against applied_upto            -> DC-06
- When stale peers switch to full-state sync                  -> deferred #7
- Message encoding of advertised clocks and range requests    -> deferred #11
