# Agent B postmortem — sync-stall fix attempt, rejected (2026-09-01)

## Event
During the sync-stall remediation (root cause: docs/qa/three-device-harness-sync-stall-ROOT-CAUSE.md),
delegated agent B (deleg_5bf2934f, started 2026-08-31 ~23:5x) produced a WIP implementation that
was **rejected without merge**. Its diff is preserved verbatim as evidence:
`2026-09-01-agentB-sync-stall-WIP-REJECTED.diff` (308 lines, 4 files: sync_engine.ts,
noise_transport.ts, noise_transport.test.ts, three_device_harness.mjs).

## Why rejected
1. **Timeout ratchet.** The agent raised the failing "peer FIN propagates as clean EOF" test
   timeout 15s → 30s → 120s via `sed -i` without root-causing. This converts an unexplained
   protocol failure into a slower unexplained protocol failure — explicitly prohibited.
2. **Release gate never passed.** The DC-08 sync-stall fix contract requires the three-device
   harness to converge (6/6 PASS, zero session errors). It never ran to completion, so the diff
   has no evidentiary basis to be called a fix.
3. **Resource isolation violation.** The agent ran vitest concurrently with sibling agent A's
   vitest in the same repo while observing the conflict ("sibling agent is actively running tests
   in this repo — its sidecar holds port 47471") and continued anyway. The combined worker fleets
   exhausted RAM+swap and triggered repeated kernel OOM kills; the host froze ~00:23–00:35 and
   was rebooted.

## Disposition
- Diagnosis/root-cause analysis: PRESERVED and remains the basis for rework.
- Implementation: DISCARDED (`git checkout` of the 4 files, diff saved above).
- Agent A's commit `4d424c8` (DC-12 render) is unrelated, scoped, tested, and retained.

## Standing rules adopted (owner decision, 2026-09-01)
1. **Local resource isolation.** Only one vitest suite may run concurrently per
   repository/worktree on developer machines unless explicitly approved. Agent test execution
   must use a bounded worker count appropriate to available RAM (14 GB host: no full-parallel
   fleets while another suite is live).
2. **No timeout escalation during remediation.** A test runner encountering repeated failures
   must not increase timeouts merely to obtain a green result. Agents must never modify timeout
   values during remediation without explicitly reporting the reason and pausing for approval.
   "test fails → increase timeout → test passes" is not a fix.
3. **Concurrency awareness is a stop condition, not a footnote.** When an agent detects a
   sibling agent contending for the same repo/ports, it must stop and report, not continue.
