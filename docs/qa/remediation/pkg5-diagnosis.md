# Package 5 — Technical Diagnosis: DC-03 Conflict Detection Never Wired into the Live Pipeline

Date: 2026-08-30 · Baseline SHA d0642ad (branch `remediation`, Pkg1–4 committed)
QA finding: M-2 / QA-1 F2 (MAJOR, 5/5 repro). `detect()` in
`src/sync/conflict_detection.ts` is referenced only by
`tests/conflict_detection.test.ts`; the DC-07 `conflicts` /
`conflict_participants` tables have **no writer anywhere in `src/`** (verified
by grep at baseline: zero INSERT/UPDATE against either table outside schema
DDL). The Conflicts UI surface (`frontend/conflicts.ts`, DC-14) reads
`window.__TIDE_CONFLICTS__`, which nothing injects — its own header documents
the missing backend ("no Tauri command or sidecar RPC exposes the conflicts
surface yet").

---

## 1. Intended pipeline trace (where detection SHOULD sit)

### Remote arrival path (T2) — the authoritative integration point

```
peer session (sync_engine.runSession, pull phase)
  → applyBatch()                                    src/sync/sync_engine.ts
    → applyRemoteChange(db, record, knowledge, mutate)
                                                      src/persistence/database.ts  (T2)
        classifyArrival → duplicate | buffer | apply (+drain pending)
        for each drained record:
            mutate(db, record)        ← entity-row write (makeEntityMutator)
            INSERT INTO changes …     ← history
            recordEntityVersion(…)    ← Pkg1 durable version state
```

`mutate` is `makeEntityMutator()` (`src/persistence/bridges/sync_service.ts`),
which upserts/deletes the `events` row per record (title / description /
schedule groups, whole-event `event`, whole-entity `remove` with
`field_path='*'`). **Detection must run per drained record BEFORE `mutate`:**
DC-03 §3 — "When an incoming change record C arrives and passes DC-02 §7
application gating (not duplicate, gap contiguous), BEFORE mutating local
state the device evaluates C against all participants L for C's conflict
entity."

### Local write path (T1)

```
UI op (create_event / update_event / delete_event)
  → EventCore.createEvent / updateEvent / deleteEvent   src/persistence/bridges/event_core.ts
    → createLocalChange(db, deviceId, input, mutate)    src/persistence/database.ts  (T1)
```

**Scope decision (local path): NO detection hook needed at T1 — and DC-03's
own algorithm explains why.** A locally created change's `causality_clock` is
built from the device's merged `device_clock` (element-wise max over ALL
received clocks) with the local entry incremented (`createLocalChange`,
database.ts). It therefore causally dominates every participant record in
local history, so DC-03 §3.2 ("causal-after applies cleanly — later knowledge
supersedes earlier knowledge deterministically") always resolves a local write
to NO_CONFLICT by construction. Both peers of a concurrent pair detect the
conflict on REMOTE arrival — each device detects when it receives the other's
record. This matches DC-03 §3, which is defined for *incoming* change records
only. Hooking T1 would be dead code that can never return CONFLICT.

### Where detection terminates today

`detect()` (`src/sync/conflict_detection.ts`) is pure decision logic (DC-03
§3 rules 3.1–3.7 verbatim). Its only caller is its unit test. Nothing copies
its outcome into the DC-07 `conflicts`/`conflict_participants` tables, so:

- concurrent same-field edits hit `mutate` unconditionally; whichever record
  arrives second overwrites the row — and across sessions the DC-09 snapshot
  domination rule (`applySnapshot`, `src/sync/full_state.ts` §7.1: "local
  survives iff NOT dominated by snapshot_clock") decides the final value by
  vector-clock domination, not by any user decision. Net effect: implicit
  LWW-by-domination, no conflict data ever surfaces. DC-03 §5 explicitly
  prohibits silent winner selection outside explicit resolution ("every
  concurrent differing pair surfaces as an unresolved conflict record", TR-7).

## 2. What counts as a conflict (DC-03 citations, spot-verified against code)

- **Concurrency** — DC-03 §2.3: "defined solely by DC-02 §3:
  `concurrent(C, L)` is true iff neither causality clock dominates the other";
  `hlc_timestamp` plays NO role (§5, TR-7 no-LWW). Code:
  `concurrent()` in `src/sync/vector_clock.ts`.
- **Conflict entity** — DC-03 §2.1: the pair `(entity_id, field_path)`.
  Participants are "already-applied, un-compacted change records … that touch
  the same conflict entity" (§2.2) — i.e. rows of the `changes` table (§2.2:
  un-compacted = not yet removed by DC-06 sweep).
- **Trigger** — DC-03 §3.3: "If C is concurrent with any participant on the
  same conflict entity and their values differ, detection produces/extends a
  Conflict Record. Local state is NOT overwritten. BOTH values are preserved
  in the record." §3.4: delete-vs-edit participates like any value; "the
  stored pre-conflict local value remains visible until resolution."
- **Materialization specified by DC-03 (what we implement, no invented LWW)**:
  §3.3 "do NOT overwrite; create/update Conflict Record per section 4" +
  §3.4 "stored pre-conflict local value remains visible until resolution".
  I.e. the receiver's entity row keeps the LOCAL value; the incoming record is
  still written to history (`changes`) and knowledge/applied_upto still
  advance (application gating per DC-02 §7 is unaffected — the record is
  applied to *history and clocks*, just not to the *entity row*), and one
  unresolved conflict row per conflict entity holds both payloads. This is the
  only automatic behavior DC-03 specifies; resolution is explicitly out of
  detection's scope (§4.3: transitions "performed only through explicit
  resolution actions … never as a side effect of detection, application, or
  sync"; DC-14 is the UI contract).
- **No-conflict cases** — §3.1 identical-value convergence ("no-op REGARDLESS
  of concurrency"), §3.2 causal-after, §3.6 different fields never conflict,
  §3.5 several concurrent participants join ONE record (participants list),
  [24]-R1 recurrence independence.
- **Record shape** — §4: `conflict_id` UUIDv4, conflict entity, immutable
  participants (change_id, device_id, local_seq, causality_clock, payload),
  `detected_at_hlc` (presentation-only, §5), `status` unresolved →
  resolved_keep_local | resolved_keep_incoming | resolved_custom (§4.3;
  'obsolete' is DC-14 §7.1's device-local terminal state). §4.1: records
  persist durably across restart, never auto-resolved. §4.4: a resolution
  writes the winning value back as a NORMAL new change record so resolution
  propagates causally.

## 3. Storage + retrieval (DC-07)

DC-07 already carries the `conflicts` / `conflict_participants` tables in the
base DDL (`src/persistence/schema.ts`; CHECK constraint enforces the §4 status
lifecycle: unresolved rows have NULL resolved_value/resolved_at_hlc). **No
schema change is required.** The writer belongs in `applyRemoteChange` (T2)
inside the same transaction as the change insert, so record-history, version
state and conflict rows can never diverge.

Retrieval: `src/application/conflicts_ui.ts` `ConflictsViewModel` is the
normative read/command layer over exactly these tables (badgeCounts,
listUnresolved → ConflictListItem, getDetail → ConflictDetailView). The sidecar
owns the DB handle; the missing piece is a read-only stdio RPC
(`list_conflicts`, `conflict_detail`) in the dispatcher plus the matching
`sync_op` allow-list entries in `src-tauri/src/lib.rs` (the standing
allow-list-drift rule from GUI round 2). Write ops (resolve/skip) are
deliberately NOT exposed in this package: DC-14 resolution is UI-driven
(§4.3) and the shell bridge injection (`window.__TIDE_CONFLICTS__`) is a
separate work item documented in `frontend/conflicts.ts`'s TODO(backend).

## 4. Fix shape (implemented in this package)

1. `src/persistence/database.ts` — per drained record in T2: derive
   `localCurrent` from the live `events` row, load un-compacted participants
   from `changes` (same `(entity_id, field_path)`; a `'*'` whole-entity remove
   touches every conflict entity of that entity_id per §3.4), run `detect()`,
   and on CONFLICT persist/extend one unresolved conflict row (§3.5) while
   skipping the entity-row `mutate` (§3.3/§3.4). NOOP (§3.1) writes no row.
2. `src/persistence/bridges/sidecar_server.ts` — read-only `list_conflicts` /
   `conflict_detail` ops delegating to `ConflictsViewModel` (shape-identical).
3. `src-tauri/src/lib.rs` — allow-list entries for the two new ops.
4. Detection scope = `entity_type === 'event'`: the only entity type the live
   mutator writes (`makeEntityMutator`); other types have no row-mutation path
   to protect (recorded as scope decision, not a contract violation).

## 5. Verification standard

`tests/pkg5_conflicts.test.ts` on the Pkg1 harness (makeDevice / sessionOnce /
convergeRound) with the independent ExpectedState oracle asserted alongside
convergence; conflict scenarios assert per-device deterministic materialized
values (DC-03 §3.3 divergence is the SPECIFIED outcome, so the single-state
oracle is applied per device), merge scenarios assert full convergence.
