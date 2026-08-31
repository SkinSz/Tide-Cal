# Tide — Where We Stand (2026-09-01)

Branch `master` @ 1e628f7. Supersedes the 2026-08-31 edition.

HEADLINE CHANGES SINCE THE LAST EDITION:
- Three-device harness sync stall ROOT-CAUSED (docs/qa/three-device-
  harness-sync-stall-ROOT-CAUSE.md) and FIXED (c088023): DC-08 session-
  end barrier + Noise carrier EOF propagation. Full harness now 7/7
  scenarios PASS (6 original + new stall_repro regression pin), 50
  sessions, ZERO session errors. The release-blocking sync stall is
  CLOSED at the root-cause layer.
- One delegated agent's WIP (the first sync-stall fix attempt) was
  REJECTED by the owner: timeout ratchet (15s→30s→120s), release gate
  never run, and it kept running tests after detecting sibling-agent
  contention. Evidence diff + postmortem committed (c13e457) with
  three BINDING agent rules: (1) one vitest suite per repo at a time,
  bounded workers (14 GB host — the concurrent vitest fleets of two
  agents caused a kernel-OOM freeze + reboot on 2026-09-01 ~00:35);
  (2) NEVER ratchet test timeouts to get green — report and stop;
  (3) sibling-repo contention = STOP and report, not continue.
- DC-21 (mDNS→sidecar endpoint plumbing) APPROVED 2026-09-01 with
  owner security amendment (routing-hints-only boundary on D3) —
  implementation NOT yet authorized, awaiting owner go.
- DC-22 (Reminders & Local Notification Semantics) APPROVED 2026-09-01
  (owner decisions D1 missed-reminder show-on-launch; D2 all-day =
  per-event day-before tick + picked time) — implementation NOT yet
  authorized, awaiting owner go.
- DC-12 recurrence wave LANDED: recurring-event creation +
  occurrence-override editing (adbfe69), opt-in rule builder +
  required end date (341e502), series rendering with per-occurrence
  glyphs + Until picker auto-close (4d424c8).
- Two BLIND adversarial reviewers dispatched 2026-09-01 over the
  recent waves (sync/network + frontend/domain) — results pending;
  their findings will be folded into the next edition.

Suite: 638/638 green at last FULL run (2026-08-31). Post-fix full-suite
re-run pending (deliberately deferred while blind reviewers hold the
repo — one-suite-at-a-time rule); scoped suites + harness green per
verification above.

Scope: feature completeness, open work, and what still needs a design
contract.

---

## 0. EVALUATION BASIS

Drafted AFTER evaluating the founding document —
`docs/specs/ARCHITECTURE_SPEC_v0.3.md` (FROZEN, the "what is Tide" outline
predating all design contracts) — against the current implementation, the
contract ledger (DC-01..20), and the technical-debt registry.

The spec's §1 PROJECT DEFINITION is the yardstick every feature claim below
is measured against: privacy-first, local-first calendar; fully offline; no
cloud account; no permanently available central server; device-to-device
sync; full local functionality without network. §6 (calendar domain: events,
recurrence, recurrence overrides, reminders, timezones, deletion state) and
§7 (time/date: IANA zones, DST, localized presentation) define the domain
scope. §27 mandates the LLM-development architecture this project runs on.

Where the implementation falls short of a spec MUST, that is an open item
regardless of contract status.

---

## 1. CONTRACT STATUS LEDGER

| DC | Title | Status | Implementation |
|---|---|---|---|
| DC-01 | Change record schema | APPROVED | Done (Pkg1-6 hardened) |
| DC-02 | Vector clocks | APPROVED | Done |
| DC-03 | Conflict detection | APPROVED + v2 (2026-08-30, §3.2a) | Done — P11 fix landed, adversarial review PASS 8/8 |
| DC-04 | Collection merge | APPROVED | Core merge done; attendee/reminder collections have no product surface |
| DC-05 | Identity / pairing / transport | APPROVED | Done |
| DC-06 | Tombstone compaction | APPROVED | Done — sweep() fixed, still deliberately UNWIRED from scheduler (see §3.4) |
| DC-07 | SQLite schema | APPROVED | v6, migration chain live |
| DC-08 | Sync message protocol | APPROVED | Done (21 RPC ops, Noise XX over TCP) |
| DC-09 | Full-state sync | APPROVED + 2 amendments | Done; backlog limit user-adjustable via DC-20 options window |
| DC-10 | Revocation propagation | APPROVED | Done (unpair/unblock surfaces) |
| DC-11 | mDNS discovery | APPROVED | Done (discovery + pairing); endpoint plumbing → DC-21 (APPROVED 2026-09-01, awaiting owner go) |
| DC-12 | Recurrence conflicts | APPROVED | Done — creation UI + overrides + series rendering LANDED (adbfe69/341e502/4d424c8); "this and following" split still reserved per DC-12 §8 |
| DC-13 | Background sync scheduling | APPROVED | Done — runtime wrapper live (a18e5a4); sync stall FIXED (c088023); endpoints pending DC-21 implementation |
| DC-14 | Conflict resolution UI | APPROVED | Done — write path landed (resolve_conflict/skip_conflict RPC + live frontend bridge) |
| DC-15 | Packaging / installation | APPROVED | Not started — rulebook only per owner instruction; §4 Windows WIP |
| DC-16 | Peer misbehavior blocking | APPROVED v2 | Done (two-tier ladder, durable hard blocks) |
| DC-17 | Database encryption at rest | DRAFT v2 — BACKLOGGED | Not implemented; needs owner approval |
| DC-18 | .ics export | APPROVED (design only) | Not implemented — explicitly awaiting owner go |
| DC-19 | Tray icon / context menu | APPROVED (2026-08-31) | Done — tray + menu live (Open Tide / Sync now / Options… / Quit); close=hide-to-tray; clean Quit |
| DC-20 | Options window | APPROVED (2026-08-31) | Done — options window live (02a2bfd + TD-011 rounds: Cancel closes, plain-English copy, General 12/24h + manual Light/Dark live-apply, badge retry, AM/PM fix) |
| DC-21 | mDNS→sidecar endpoint plumbing | APPROVED (2026-09-01) | Not implemented — awaiting owner go; routing-hints-only security boundary (D3 owner amendment) |
| DC-22 | Reminders & local notifications | APPROVED (2026-09-01) | Not implemented — awaiting owner go; delivery = ephemeral local side effect, not replicated state |

## 2. WHAT THE SPEC PROMISES — VERIFIED DELIVERED

Measured against the frozen outline (commit 1226d6e, 2026-08-25):

- **Offline-first core (§1, §23):** full calendar CRUD and rendering with no
  network; SQLite authoritative (INV 2); DB files never replicated (INV 3).
- **P2P mesh, no server (§21, INV 11):** direct + relayed sync over Noise XX
  TCP; mid-sync SIGKILL converges; bidirectional anti-entropy per DC-08 §4.
- **Identity & trust (§10, §15-19, INV 4-6):** cryptographic identity,
  QR pairing, trust revocation, mDNS never grants trust.
- **Change-based sync (§9, INV 16/22):** field-level change records,
  vector-clock knowledge, tombstones + knowledge-governed compaction (§12,
  INV 18/19), full-state resync for stale peers (INV 20).
- **Conflict philosophy (§13, INV 7):** no silent LWW — DC-03 detection now
  includes the stale causal-before rule (v2 §3.2a, P11 closed).
- **Security (§20):** encrypted, authenticated, integrity-protected transport.
- **Backup/restore (§25, INV 10):** restore = new identity, enforced.
- **LLM development architecture (§27, INV 30/31):** the contract pipeline is
  exactly the §30/§31 mechanism in action (14 deferred decisions → 20 DCs).

## 3. OPEN FEATURES — spec/contract exists, implementation missing

### 3.1 DC-20 Options window — APPROVED, not yet implemented
- Design fully specified (DC-20, owner-approved 2026-08-31): dedicated
  options window, Outlook-style (left nav pane + right content), reachable
  ONLY from tray menu "Options…", NEVER from the calendar UI (D9).
- v1 inventory: Sync category with 4 settings (debounce 5-120s, sweep
  interval, max concurrent sessions 1-5, backlog limit 100-100k).
- Decisions locked: Save-all atomic commit (D4); backlog limit is
  restart-scoped for v1 (D5); persistence in ~/.config/tide/config.toml
  (D6); window created ON DEMAND — resource-lean lifecycle, no resident
  webview (D7).
- Effort: small self-contained package (second HTML entry, Rust
  window-builder, two settings proxy commands, config reader).

### 3.2 .ics export (DC-18) — approved, awaiting owner go
- `export_ics(scope, target_path)` specified; zero implementation. The UI
  placement ("Export calendar (.ics)") is explicitly out of DC-18's scope.

### 3.3 Recurrence — LANDED (was "partially open")
- Creation UI + occurrence-override editing (adbfe69), opt-in rule
  builder + required end date (341e502), series rendering with
  per-occurrence glyphs + Until picker auto-close (4d424c8).
- Still reserved: "this and following" split (future owner DC per
  DC-12 §8). Occurrence-override editing exists in domain + dialog;
  owner visual pass still owed via TD-011 scope.

### 3.4 Scheduler ENDPOINT plumbing — moved to DC-21
- Contract DC-21 APPROVED 2026-09-01 (routing-hints-only security
  boundary on D3 per owner amendment). Implementation awaiting owner
  go. Until it lands, automatic sessions still skip endpoint-less
  peers; manual Sync now works.

### 3.5 Reminders — moved to DC-22
- Contract DC-22 APPROVED 2026-09-01 (missed-reminder policy D1;
  all-day per-event day-before reminder D2; delivery = ephemeral
  local side effect, never replicated). Implementation awaiting
  owner go. Attendees remain spec-promised, no product surface
  (post-v1 by implication).

### 3.6 Time/date model edge coverage (spec §7) — verify before ship
- DST-tested for recurrence expansion (DC-12 R5, Berlin fall-back test);
  ISO-week and localized presentation are thin (week start hard-coded
  Monday; locale via Intl defaults). Low risk, but §7 MUSTs deserve an
  explicit audit item before release.

## 4. TECH DEBT (docs/technical-debt.md)

| ID | Priority | Status | Note |
|---|---|---|---|
| TD-001 | 7/10 HIGH | OPEN (registry) | Quarantine-and-skip semantics; lead recommendation (Option 3) written, PENDING OWNER APPROVAL. NOTE: commits 271e86c/96a257a implemented skipped_seqs (schema v2) + restart revalidation — the registry entry predates them and needs status reconciliation against the code. Gates multi-device release. |
| TD-011 | 6/10 MEDIUM-HIGH | OPEN — assigned to OWNER | Visual verification pass for the 2026-08-31/09-01 waves: tray menu, options window (incl. General 12/24h + Light/Dark live-apply), conflict resolution end-to-end, UX wave, toolbar cleanup, AND the new DC-12 recurrence wave (creation dialog, rule builder, series chips). Full click-through checklist in docs/technical-debt.md TD-011. RELEASE GATE. |
| TD-012 | 5/10 MEDIUM | OPEN (created 2026-09-01) | Post-freeze process debt: post-fix FULL suite re-run pending (scoped suites + 3-device harness 7/7 green; full run deferred while blind reviewers hold the repo per the one-suite-at-a-time rule). Resolving action: one clean full `npm test` + tsc + cargo build pass, recorded here with COMMAND + EXIT STATUS. |
| TD-013 | 4/10 MEDIUM | OPEN (created 2026-09-01) | Transient EADDRINUSE on harness port bands: during the c088023 verification and a blind-review run, a harness scenario failed once with EADDRINUSE in the 41900 band (nothing held the port afterwards; passed on rerun). Likely TIME_WAIT/interface-timing flake in test port allocation. Fix direction: deterministic per-run port bases or SO_REUSEADDR-style retry in the harness RunContext. Must not be papered over by retry-until-green in agents (agent rule 2 applies). |
| TD-010 | 3/10 | OPEN | Tray ERROR-PRESENT marker (quarantines/conflicts need attention). Deferred from DC-19 v1 by owner; DC-19 §3.3 holds the normative spec. Natural companion to DC-20 options-window work. |
| TD-003 | 4/10 | DEFERRED | Legacy dev-* identity migration; correctly deferred until an upgrade release exists. |
| TD-007 | 2/10 | OPEN | Hygiene nits (prepared statements, monotonic windows, resolved_at_hlc naming, onHardBlock guard). |
| P11 | — | **CLOSED** | Root cause fixed (DC-03 v2 §3.2a, e53ec02); old failure reproduced then pinned as regression; adversarial review PASS 8/8 (2eb3bb2). |
| TD-009 | — | **CLOSED** | Cancel button landed (71b4fe4). Registry updated. |
| F9 residual | 2/10 | OPEN | General unhandled-rejection → exit(1) hardening beyond Pkg4's guarded path. |
| BND-07 | 2/10 | OPEN | Protocol leniency quirks (dup JSON keys, id 1e999). |
| Backup-restore seq collision | 3/10 | OUT OF CONTRACT | Detection cue live (Pkg6 HELLO anomaly); DC-05 §2.2 makes the scenario unreachable for conformant restores. |

## 5. NEEDS A NEW DESIGN CONTRACT (nothing invented yet)

1. "This and following" recurrence split — DC-12 §8 reserves it.
2. Second-order resolution reconciliation — DC-14 §6.4 allows a future
   contract; not urgent.
3. DC-02/DC-03 refinement: marking (vs silently storing) stale causal-before
   records — optional; default is no action.
4. DC-17 encryption — drafted and BACKLOGGED; needs owner approval to become
   implementable (keystore integration, plaintext-DB migration).
5. ~~mDNS→sidecar endpoint plumbing~~ — DONE: DC-21 drafted and APPROVED
   2026-09-01 (1e628f7).

## 6. DELIBERATELY NOT STARTED (per standing owner instructions)

- Installer/packaging builds (DC-15 rulebook; no build authorized)
- Windows port (Spec §1 Linux-first; DC-15 §4 WIP)
- .ics import (needs its own contract)
- CalDAV (explicitly skipped by owner)

## 7. RECOMMENDED ORDER (updated 2026-09-01 — post-freeze recovery edition)

Landed since the 2026-08-31 edition: DC-12 recurrence wave (creation,
overrides, series rendering), sync-stall root-cause fix (c088023,
harness 7/7), DC-21 + DC-22 contracts approved, agent-B rejection
postmortem + standing agent rules (c13e457).

1. **Blind adversarial reviews of the recent waves (IN FLIGHT)** — two
   reviewers dispatched 2026-09-01 (sync/network + frontend/domain).
   Their findings gate the next implementation wave.
2. **Post-fix full-suite re-run** — deferred until the reviewers release
   the repo (one-suite-at-a-time rule); scoped suites + harness already
   green.
3. **DC-21 or DC-22 implementation** — both APPROVED, both awaiting
   owner go; independent territories, can run in parallel (with the
   new resource-isolation rules).
4. **TD-011 — owner visual verification pass (RELEASE GATE)** — now
   also covers the recurrence-creation wave (nothing above is
   owner-visually verified).
5. **TD-001 status reconciliation** — paper exercise against the code
   (271e86c/96a257a landed most of it) + owner ratification; gates
   multi-device release.
6. **.ics export (DC-18)** — on the owner's word; self-contained.
7. **TD-010 tray error marker** — pairs naturally with any tray work.
