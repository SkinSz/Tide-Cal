# Independent assessment (written BEFORE reading pkg1-report.md)

## Defect (my own derivation from FINDINGS F1 + code)
DC-06 `sweep()` deletes `changes` rows; the entity's version vector and
latest-producer identity were derivable ONLY by aggregating those rows
(`localVersionClock`/`latestProducer` in full_state.ts, baseline). After
compaction, live entities collapsed to an empty clock + no producer, which
produced two loss modes in the DC-09 pipeline:
1. buildSnapshot skipped the entity ("no change history") → receiver's
   applied_upto advanced past it → permanently stranded.
2. Receiver streams its snapshot → source applies §7.1 absence rule →
   `dominates(snapshot_clock, {})` is vacuously true → own live events
   tombstoned.
Violated invariant: compaction may change REPRESENTATION of history, never the
SEMANTIC state it represents. Convergence-to-data-loss (fingerprints equal,
both empty) — agreement is not correctness.

## What the fix appears to do (from diff, before falsification)
- New durable `entity_versions` STATE table (schema v6): per-entity version
  vector + latest producer, maintained transactionally inside T1
  (createLocalChange) and T2 (applyRemoteChange) via `recordEntityVersion`;
  backfilled at migration from surviving change history.
- buildSnapshot reads versions from entity_versions (change-log fallback);
  events loop no longer omits entities without producer identity (over-
  inclusive with "_unversioned" placeholder).
- applySnapshot: records snapshot-entry causality into entity_versions on
  staged apply (merge, never regresses); absence rule now requires a
  NON-EMPTY local version (empty = missing evidence, not domination);
  entity_versions row cleared on absence tombstone.
- localRowMatchesEntry: byte-identical rows skip staging (replay idempotence).
- sync_engine: GAP_ROUNDS-tagged Trigger-A offers are answered with data
  (receiver emits its own offer; gapped side accepts rival offers instead of
  racing §7.3).

## Hypotheses to falsify
H1. Calendar asymmetry: buildSnapshot's CALENDAR loop retains
    `if (winner === undefined) continue;` (events loop was made
    over-inclusive). A v5 DB whose calendar bootstrap change record was
    already swept BEFORE migration → no entity_versions row → calendar
    omitted from snapshots → fresh peer permanently misses a LIVE calendar.
    In pure v6 flow calendars always get version rows (bootstrap rides T1),
    so exposure is exactly the migration-after-compaction path.
H2. Backfill correctness: causality_clock includes self
    (`[selfDeviceId]: nextSeq` in createLocalChange), so element-wise max
    over any change subset containing the newest record is the true vector.
    If the NEWEST record of an entity was swept pre-v6 (possible: constraint
    peers knew it), backfill reconstructs a SHORT vector {A: k-1} while
    device_clock says A: k. Does any path then wrongly dominate/tombstone?
    (snapshot_clock claims more than entity evidence — the absence rule
    compares snapshot_clock to LOCAL version, so receiver-side is guarded;
    sender-side over-inclusion is benign.)
H3. GAP_ROUNDS protocol liveness: both-sides-gap, dedup-key collisions, or
    the "already offered this session → fall through to race handling"
    branch could strand or loop.
H4. Absence-rule weakening: empty-version guard keeps live rows, but does a
    LEGITIMATE deletion of an unversioned zombie row ever become impossible?
    (Zombie rows have no version evidence ever → deletion by snapshot
    omission can never remove them → divergence risk if the zombie is stale
    on one peer only.)
H5. T1/T2 atomicity of recordEntityVersion; migration atomicity under kill.
H6. Test-oracle independence: ExpectedState is driver-maintained, but does it
    cover calendars/series/occurrence_overrides? (Looks events-only.)
