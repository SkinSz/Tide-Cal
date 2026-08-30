# Remediation Campaign — Phase 0 Baseline & Traceability Map

Date: 2026-08-29 (night) · Lead: Lead Remediation Dev
Baseline SHA: **52d54ab** (main; QA consolidation report commit)
Remediation worktree: `/tmp/tide-remediation` branch `remediation` @ 52d54ab,
deps installed, sidecar built, sanity green, tree clean.
QA campaign SHA was 781dc7b → only diff is the consolidation report commit
(docs only). No material implementation drift: **proceed**.

## Finding verification at current HEAD (Phase 0 §4)

| QA ID | Claim | Re-verified at 52d54ab? |
|---|---|---|
| C-1 (Pkg1) | compaction × snapshot destroys live events | YES — QA probe sc_repro SC5 fails 1/1 in remediation worktree |
| M-1 (Pkg2) | update_event input.id → phantom row + false changelog | YES — live stdio repro: create evt-REAL-1, update with input.id=evt-PHANTOM-9 → ok:true, phantom row exists, target untouched |
| M-5/BND-02 (Pkg3) | end<start accepted; response 1000 vs stored 5000 | YES — live stdio repro |
| M-2 (Pkg5) | conflict detection unwired | YES — `detect()` has zero production importers; conflicts table has no writer |
| M-3 (Pkg4) | pull-phase hang | Accepted from QA evidence (SC10 3/3 + SC9 hang traces); deterministic repro requires a stalled peer fixture — will re-verify via new regression test during Pkg4 |
| M-4 (full-state per session) | neededRanges includes self | Accepted from QA-1 F4 evidence (message trace); fix deferred to separate architectural package per instruction |
| F-1 (hygiene) | ensureDefaultCalendar spurious change per restart | Accepted from QA-2 s5_cycles.json (changes_delta=1 ×10) |

## Data Safety Decision (per instruction §Existing Data Safety)

**Package 1 (C-1): PRE-RELEASE WIPE ACCEPTABLE.**
Rationale: the corruption path requires DC-06 compaction to have run; compaction
is a maintenance operation not yet exposed to end users (no UI/scheduler
invokes sweep in the shipped app — verification: grep shows sweep() called
only from tests and the DC-06 proposal). Affected state = events
tombstoned-without-trace on devices that accepted a post-compaction snapshot,
or fresh peers missing data. In the only existing databases (developer QA
machines), data is disposable. Reset procedure: delete
`~/.local/share/com.tide.app/tide-domain.db*` (+ sidecar identities if a
clean device identity is desired: `tide-domain.db` siblings under TIDE_DATA_DIR).
No repair path will be attempted for pre-fix corrupted DBs (unrecoverable by
design — the loss is silent). Re-verify sweep-callers claim during Pkg1
implementation; if any production caller exists, ESCALATE to decision C.

**Package 2 (M-1): PRE-RELEASE WIPE ACCEPTABLE.**
Affected state: phantom event rows + record/row divergence. Only reachable
via raw sidecar protocol (typed Rust layer blocks input.id today); existing
DBs are developer/QA only. The fix makes future input rejected explicitly;
pre-existing phantom rows are detectable (rows whose event_id never appears
as target of a create change record / change records referencing a different
materialized row) — detection/repair procedure will be documented in the
package report as a QA-script, not shipped product code. Wipe procedure same
as above.

## Traceability map (QA finding → package)

| QA finding | Sev | Package |
|---|---|---|
| C-1 (QA-1 F1) | CRITICAL | Pkg 1 |
| M-1 (BND-01) | CRITICAL | Pkg 2 |
| M-6 (BND-03), M-5 (BND-02), m-3 (BND-04), m-4 (BND-05), QA-2 F-2 | MAJOR/MINOR | Pkg 3 |
| M-3 (QA-1 F3) + BND-08 | MAJOR | Pkg 4 |
| M-2 (QA-1 F2) | MAJOR | Pkg 5 |
| M-4 (QA-1 F4) | MAJOR | DEFERRED — separate architectural package (per instruction §Full-State Sync Efficiency) |
| QA-1 F5 (m-1), F6 (m-2), F7, F8*, F9; QA-2 F-1; BND-06, BND-07 | MINOR/OBS | Pkg 6 hygiene sweep (after 1–5; F8's tombstone gap is fixed as part of Pkg 1's snapshot correctness since the absence rule is the same code path) |

## Sequencing (per instruction)

1 → 2 → 3 → 4 → 5 → hygiene. Dependency notes:
- Pkg2 vs Pkg1: different subsystems (RPC input identity vs snapshot/compaction
  model). Independent. Will confirm after Pkg1 diff lands.
- Pkg3 overlaps Pkg2 (same dispatcher boundary files): Pkg3 REBASED onto Pkg2's
  validated state; not run in parallel.
- Pkg4 (sync_engine timeouts) independent of 2/3 surfaces → may run parallel
  with Pkg3 in separate worktree, serial merge by lead.
- Pkg5 (conflict pipeline) touches sync_engine + database + UI surface →
  serialized after 4.

## Verification addendum (Pkg1 data-safety claim)

Verified at 52d54ab: `sweep()` (src/sync/compaction.ts) has NO production
caller — src/application/scheduler.ts emits a `{action:"sweep"}` tick, but no
module consumes the scheduler's actions and nothing imports compaction/sweep
outside tests. The shipped application cannot currently trigger compaction.
Decision A (PRE-RELEASE WIPE ACCEPTABLE) therefore holds with the added
requirement: **Pkg1 must make sweep() safe BEFORE the scheduler wiring ships**
(sweep wiring itself remains unshipped; do not wire it in this campaign).
