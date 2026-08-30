# Package 1 — Technical Diagnosis: Compaction × Full-State Snapshot Destroys Live Events

Date: 2026-08-30 · Agent: Pkg1 implementation · Baseline SHA 52d54ab (branch `remediation`)
QA finding: C-1 / QA-1 F1 (CRITICAL). Evidence: `/tmp/tide-qa-sync/docs/qa/sync-agent/FINDINGS.md` §F1,
`evidence/results/sc5*.json`, probe `qa-tmp/probes/sc_repro.qa.test.ts` ("SC5", 3/3 deterministic at baseline).

---

## 1. What exactly does compaction remove/transform?

`sweep()` (`src/sync/compaction.ts`, DC-06 §5.2) runs one transaction that deletes **history rows only**:

| Table | Deleted when | What is lost |
|---|---|---|
| `changes` | `(producer, seq)` compactable: every constraint-set peer's `lastKnownClock[P][D] >= S`, and not an unresolved-conflict participant | the change record itself — including its `causality_clock` and `producer (device_id, local_seq)` identity |
| `member_tombstones` | same predicate | the member-deletion marker |
| `entities_tombstones` | same predicate | the entity-deletion marker |

`sweep()` **never** touches the live semantic rows (`events`, `calendars`, `series`,
`occurrence_overrides`) and never rewrites clocks. That is correct per DC-06: compaction is
garbage-collection of *retired history* ("every peer provably knows this record"), not a state
transformation. Nothing in the live tables changes; the **semantic state is untouched**.

What *is* implicitly destroyed: the only durable place where an entity's **version vector** and
**latest-producer identity** were recorded is the `changes` log (they are *derived* by aggregating
it — see §2). After a sweep deletes an entity's records, that derived quantity is unrecoverable
from the remaining rows.

## 2. What does the snapshot represent, and what is its source of truth?

`buildSnapshot()` (`src/sync/full_state.ts`, DC-09 §4) streams the sender's **current semantic
state**: one entry per live row in `calendars` / `events`, each carrying

- `data` — serialized **live row** (`SELECT * FROM events`), and
- `causality_clock` — `localVersionClock(entityId)` = *element-wise max of `causality_clock`
  over every `changes` row for that entity* (DC-02 §2 / DC-09 §7.1 "normative form"), and
- `producer_device_id` / `producer_seq` — `latestProducer(entityId)` = the `changes` row with
  max `(hlc_timestamp, local_seq)`.

The `data` payload therefore comes from live rows, but the **version metadata is derived from the
change log**, and — fatally — an entity with **zero remaining `changes` rows is SKIPPED entirely**
(warn: *"every live entity is backed by change records — shouldn't happen"*). The change log is
treated as the source of truth for *which entities exist*, even though the live tables are the
actual semantic state.

`snapshot_clock` = the `device_clock` table (per-producer max seq known locally). It is
**independent of compaction** and keeps advancing.

## 3. What assumptions does snapshot application make?

`applySnapshot()` (DC-09 §5/§7.1) makes three assumptions about history completeness:

1. **A1 (staging rule):** for each snapshot entry, the receiver's *true* entity version vector is
   computable. The implementation computes it with the same `localVersionClock()` — i.e. from the
   change log. If the change log was compacted, it computes `{}` instead.
2. **A2 (absence rule, §5.2/§7.1 deletion-by-omission):** a live local entity **absent** from the
   snapshot is tombstoned iff `dominates(snapshot_clock, localVersion)`. This is a legitimate and
   necessary rule — it is the only mechanism that propagates a *deletion* that has no retained
   tombstone row on the sender (F8: `deleteEvent` writes only a `remove` change, no tombstone row)
   and the only way a frontier that has passed a deletion can be communicated by full state.
3. **A3 (vacuous domination):** `dominates(a, b)` is true for `b = {}` for ANY `a` (element-wise
   comparison over `b`'s keys only). An *unknown* version is therefore indistinguishable from a
   *fully dominated* version.

## 4. Why does post-compaction snapshot exchange tombstone/omit live events?

The failure chain (verified independently at 52d54ab; probe SC5):

1. A creates 6 events; two-way sync with B and C converges (change records replicate to all).
2. A runs `sweep()` with constraint set {B, C} built from their ACKs — legitimate runtime inputs.
   8/9 change records deleted (the default-calendar bootstrap record survives only because C's
   ACK did not cover it). **A's 6 live event rows remain; their version vectors become `{}`.**
3. Fresh peer D pairs with A. D is empty → unservable gap → DC-09 Trigger A → full-state exchange.
   - **Mode 1 (D streams, A applies):** A's buildSnapshot on the receiver side is irrelevant; A
     *applies* D's empty snapshot. Absence rule: A's 6 live events are absent; `localVersionClock`
     = `{}` (A2's premise broken by compaction); `dominates({D:……}, {})` = true (A3). A
     **tombstones and deletes its own 6 live events**. `eventsA=0, eventsD=0`.
   - **Mode 2 (A streams, D applies):** A's `buildSnapshot` **omits** every live event with no
     change history (§2), while `snapshot_clock` still advertises `A:9`. D applies an empty
     snapshot and `applied_upto[A] := 9`. D's later incremental pulls classify A's compacted
     (absent) records as already-covered: **D permanently never receives the events.**

Both modes share one root cause: **the representation of history (change log) was destroyed while
the semantic state it represented (live rows + version vectors) was still needed and was not
preserved anywhere else.** Compaction is correct as a history-retention policy; the snapshot layer
was silently depending on *uncompacted history* as its version-state substrate.

Note this is not specific to fresh peers: with F4 (every session does a full-state exchange), any
post-compaction session between B/C and A re-runs the same absence evaluation — mode 1 destroys
the data on every peer that accepts a snapshot from a compacted peer.

## 5. The invariant that SHOULD hold

> **INV-1 (representation vs. semantics):** *Compaction may change the REPRESENTATION of history,
> never the SEMANTIC state it represents.*

Precise forms for both sides of the snapshot protocol:

**INV-1a (buildSnapshot).** For every device, at any point in time (in particular immediately
after any number of `sweep()` calls):
1. The set of snapshot entities equals the set of live rows in the semantic tables.
2. Each entry's `data` equals the live row.
3. Each entry's `causality_clock` equals the entity's **true version vector**: the element-wise
   max of causality clocks over *all changes ever applied to that entity* — a quantity that must
   survive compaction **durably and independently of the `changes` table**.
4. Each entry's producer identity is the producer of the latest contributing change, same
   durability requirement.

**INV-1b (applySnapshot).** Absence-deletion (A2) is legitimate iff the receiver can evaluate it
against the entity's **real** version vector (INV-1a.3):
- If the receiver's version state for an entity is **real and dominated** by `snapshot_clock`,
  the sender demonstrably holds a state at-or-after every change the receiver knows → tombstone.
- If the receiver's version state is **empty/unknown**, domination CANNOT be proven
  (`dominates(anything, {})` is vacuous, not evidentiary) → the absence rule must **not** fire
  (DC-06's own principle: never fabricate knowledge). "Unknown" arises only for out-of-band rows
  that were never written through the change pipeline; a legitimately-deleted entity always
  leaves real evidence (a version row ≥ its creation clock, plus the sender's advanced
  `snapshot_clock`), so this guard does **not** weaken deletion propagation.

Corollary: after compaction, `buildSnapshot` output and `applySnapshot` decisions must be
**byte-identical in semantics** to what they would have been without compaction. (Today they are
not: entities vanish / clocks collapse to `{}`.)

## 6. Why did the QA convergence oracle report success?

The probe's `oracle()` compares **fingerprints across peers**: per-table row sets + a SHA-256
digest, and reports `converged = all peers equal`. It is a *peer-agreement* oracle, not a
*semantic-correctness* oracle. In failure mode 1 the destruction is symmetric — A's absence rule
tombstones the events **before** any further exchange, so both peers end at the same (empty)
state: all fingerprints equal, digest matches, `converged: true`. Convergence-to-data-loss is
indistinguishable from convergence-to-truth unless the expected state is defined **independently
of the implementation under test**. All Package 1 regression tests therefore assert
`each peer == Expected ∧ peers pairwise equal`, where `Expected` is computed by the test from its
own operation log (§8 of pkg1-tests.md), never from `buildSnapshot`/`sweep`/`applySnapshot`
outputs.

## 7. Root-cause layer chosen and why

**Authoritative layer: durable per-entity version state.** New `entity_versions` table
(schema v6), maintained transactionally at every path that mutates an entity:

| Write path | File | Action |
|---|---|---|
| local change (T1) | `persistence/database.ts` `createLocalChange` | merge record's `causality_clock` into the entity's version; update latest-producer identity |
| remote change (T2) | `persistence/database.ts` `applyRemoteChange` | same, for every drained/applied record |
| snapshot application | `sync/full_state.ts` `applySnapshot` | staged entities: version = merge(local, entry clock); absence-tombstoned entities: version row deleted with the row |

`buildSnapshot` / `applySnapshot` then read versions from `entity_versions` (single PK lookup,
faster than the previous per-entity `changes` scan), falling back to the change-log derivation
only for pre-v6 rows that were never rewritten. `buildSnapshot` **never omits** a live row: an
entity without any version info is still emitted (over-inclusion is benign — the receiver's
§7.1 rule decides; omission is what destroys data).

**Why not the alternatives:**
- *Compaction retains per-entity history:* keeping "enough" change records per live entity is a
  cover-set problem whose correctness is subtle (multi-producer merges), and it does nothing for
  entities that reached a peer **via snapshot** and never had local change records (a pre-existing
  hole independent of compaction). Retention-as-state conflates history with state.
- *applySnapshot-only guard (empty version ⇒ survive):* necessary as defense-in-depth but NOT
  sufficient alone — it fixes mode 1 only; mode 2 (buildSnapshot omission) still strands fresh
  peers, and absence-deletion of legitimately-deleted, snapshot-received entities would break.
- *Special-casing SC5:* rejected — fix must be the representation invariant, not the repro.

**Compaction itself is unchanged** — its deletion policy was never wrong; the missing piece was
that the *state derived from* the deleted history had no durable home. `entity_versions` is
state, not history: `sweep()` does not touch it (bounded leak: rows may outlive their
tombstoned entities; harmless — every reader keys off live rows — and bounded by deleted-entity
count).

## 7b. Second layer: DC-09 Trigger-A offer race (failure mode 2, receiver direction)

INV-1a alone left the *"D permanently never receives them"* mode intact for one half of the
identity space. Mechanism: when D has persistent unservable gaps (post-compaction), DC-09 §3
Trigger A makes **D** emit a FULL_STATE_OFFER; the §7.3 simultaneous-offer race resolves by
device_id, and the race **winner streams its own full state**. When the gapped device D wins the
race, it streams its own (empty) snapshot instead of receiving A's data — and because D's offer
is once-per-session, every subsequent session repeats the same outcome: **the gap strands
forever, decided by an identity coin-flip.** (Verified empirically pre-fix; also visible as
SC1/SC4 probe flip-flopping across identity draws.)

Fix (protocol-semantics, not a special case): a Trigger-A offer is a *request for the peer's
state*, not a competing data offer.

1. The gap-triggered offer carries `reason: "GAP_ROUNDS"`.
2. `handleIncomingOffer` (receiver): a `GAP_ROUNDS` offer is answered with the receiver's own
   offer (dedup-guarded), bypassing the §7.3 race — the gapped side will accept and receive.
3. `driveFullStateOffer` (gapped sender): when OUR in-flight offer was gap-triggered, a rival
   offer from the peer is ACCEPTED regardless of the race — we need their data, not to stream
   ours.

Both-gapped topologies converge (each accepts the other's offer; both streams flow, application
is idempotent); no deadlock is possible because rule 3 unconditionally accepts, so an emitted
gap offer always terminates in a snapshot application. Offers not marked `GAP_ROUNDS` (race
counter-offers) keep the original §7.3 semantics unchanged.

## 7c. Third layer: replay idempotence of snapshot application

The F4 behavior (full-state exchange every session) re-delivers the entire semantic state each
session. With INV-1a in place, the receiver's version state is real, so between converged peers
every snapshot entry was staged-and-upserted with byte-identical data — wasteful, and it made
the probes' replay-idempotence accounting (`receivedApplied`) race-outcome dependent (SC1/SC4
flipped with identity draws). `applySnapshot` now skips staging when the local live row already
equals the entry's data (canonical JSON compare; for calendar entries only the semantic fields
title/color are compared, since the default-calendar bootstrap rows carry per-device HLC
bookkeeping — QA-2 F-1, Pkg6's root fix). Skipping is a *literal* no-op (the upsert would write
identical values) and it keeps the local entity version anchored to the locally-applied change
history, the DC-02 normative form.

**Data safety:** pre-release wipe is acceptable per PHASE0-BASELINE; the v6 migration still
backfills `entity_versions` from surviving `changes` rows so pre-fix dev DBs behave correctly
without any repair path. `sweep()` remains unwired in production (verified: only tests call it);
this package makes it safe *before* scheduler wiring ships.

## 8. Expected logical state (independent definition used by the tests)

The oracle state is defined purely from the test driver's operation log, with **sequential
mutation semantics** (mutations are barriered by convergence rounds, so no conflict resolution
is involved — conflict semantics are Pkg5's surface):

- `Expected.events` = ordered map `id → {title, description, startMs, endMs, allDay}`;
  `create` inserts, `update` overwrites the listed fields, `delete` removes.
- `Expected.tombstones` = ids passed to `delete` (deletion markers must exist on peers that
  processed the deletion).
- Pass ⇔ every peer's `events` table **equals** `Expected.events` (exact field values) ∧
  peers pairwise identical ∧ tombstone expectations hold. No peer's state is ever used to
  compute `Expected`.
