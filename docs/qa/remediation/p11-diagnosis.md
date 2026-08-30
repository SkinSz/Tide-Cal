# P11 — Stale Causal-Before Overwrite: Diagnosis

Date: 2026-08-30 · Worktree /tmp/tide-remediation · P11 remediation work package §1
Scope: reproduction + mechanism ONLY. No code changed in this step.

## 1. The scenario (reproduced, tests/probes/qa5_probe11.test.ts pattern)

Devices a, b, c; event E with title="Base"; all three converged.

1. b updates title → "B stale"  = record **C** (producer b#2)
2. c receives C, then c updates title → "C later" = record **D** (producer c#2)
3. a receives **only D** (D is c's next contiguous seq — no gap, no C relay)
4. the stale causal-before record C later arrives at a from b

## 2. Answers to the work-package questions

**Q1 — What exact incoming operation causes the stale overwrite?**
A `set` record on conflict entity `(event_id, "title")` whose causality_clock
is DOMINATED by a local participant: specifically the title record C produced
by b BEFORE c produced its descendant D.

**Q2 — What newer state already exists when it arrives?**
a's materialized row holds the value from D ("C later" when D is correctly
selected) and a's `changes` table contains D with
`dominates(D.causality_clock, C.causality_clock) === true` and
`concurrent(C, D) === false` — verified in the diagnosis probe.

**Q3 — How does the system determine that C is causally older?**
DC-02 §3: `dominates(D.clock, C.clock)` is true and clocks unequal ⇒ C is
`causallyBefore(D, C)`. The relation is computed in src/sync/vector_clock.ts
and available to detection via `detect()`.

**Q4 — Which code path lets it mutate the row anyway?**
`detectAndRecordConflict()` (src/persistence/database.ts:488) calls
`detect()` (src/sync/conflict_detection.ts:80). `detect()` implements ONLY
three rules — §3.1 identical-value, §3.2/§3.3 concurrency-vs-locals, and the
no-concurrent-participants fall-through (line 97-99: `if
(conflicting.length === 0) return { kind: "apply" }`). There is NO
causally-dominated check: an incoming record that is causally BEFORE a local
participant is not `concurrent` with it, so `conflicting` is empty and the
outcome is **"apply"** — the mutator (makeEntityMutator,
src/persistence/bridges/sync_service.ts) then overwrites the row
unconditionally. That is the authoritative root cause: **the detection
algorithm lacks the DC-03 §3.2 dual (stale) rule; its absence makes the
fall-through treat "not concurrent" as "causally after".**

**Q5 — What happens to the stale operation?**
Accepted into history (insertChange runs unconditionally in
applyRemoteChange — correct per DC-02 §7), applied to materialized state
(the bug), never turned into a conflict, never surfaced to the user.

**Q6 — Outcome classification.**
User-visible stale overwrite of newer materialized state (title regresses
from "C later" to "B stale") with NO conflict record and NO diagnostics —
the exact class Spec §13 exists to prevent. It is persistent (row state
regressed on every device that replays C), though later genuinely-concurrent
edits still conflict normally. NOT data loss in the DC-06 sense (values
remain in history), but a silent winner-pick that Spec §13/INVARIANT 7
forbids.

## 3. Secondary defect found during diagnosis (delivery-order test flake)

The original qa5_probe11 selects D with
`ORDER BY local_seq DESC LIMIT 1` across ALL producers — C is b#2 and D is
c#2, a local_seq TIE where SQLite's returned row depends on scan order. The
diagnosis probe proved: when D is selected correctly (payload filter),
`deliver(a, D)` yields a.title = "C later" (correct); when C is picked
instead, a's row is ALREADY "B stale" before any stale delivery. The test's
flakiness is its own selection bug — the production stale-overwrite is the
defect proper and occurs under BOTH selections (final title = "B stale"
either way).

## 4. Contract question this sets up (work package §2)

DC-03 §3 has rules for: identical value (3.1), causally-after (3.2),
concurrent-differing (3.3), delete-vs-edit (3.4). It has NO rule for
causally-BEFORE-different-value — the algorithm's `conflicting.length === 0`
fall-through silently covers three distinct cases: causally-after (correct
to apply), causally-before (incorrect to apply), and equal-clocks-identical
(reachable via 3.1). Spec §13 ("Non-concurrent changes automatically apply")
is ambiguous about dominated-but-not-yet-seen records; DC-02 §3's example
"A dominates B → Auto-apply A" does not address delivery of B after A.

The intended default from the owner — a causally dominated incoming
operation must not regress newer materialized state — matches Spec §13's
anti-silent-loss philosophy and requires an explicit new rule in DC-03
(§3.2a "stale causal-before = history-only"), not a reinterpretation of §3.3.
