# Tide — Where We Stand (2026-08-31)

Branch `master` @ a7e8aa5 (remediation branch MERGED — fast-forward, 26
commits: all six remediation packages, P11 root-cause fix + adversarial
review, UX wave, probe promotion, DC-19/DC-20 contracts, TD-009, DC-14
write path, DC-13 runtime + tray). The /tmp worktrees are retired; all
development now happens in /home/skins/tide on master.
Suite: 591/591 green · tsc clean · cargo build clean.

Scope: feature completeness, open work, and what still needs a design
contract. SUPERSEDES the 2026-08-30 edition.

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
| DC-11 | mDNS discovery | APPROVED | Done (discovery + pairing); ENDPOINT PLUMBING INTO SIDECAR still open (§3.4) |
| DC-12 | Recurrence conflicts | APPROVED | Partial — read surfacing done; CREATION UI missing (see §3.3) |
| DC-13 | Background sync scheduling | APPROVED | Done — runtime wrapper live (a18e5a4); endpoints pending (§3.4) |
| DC-14 | Conflict resolution UI | APPROVED | Done — write path landed (resolve_conflict/skip_conflict RPC + live frontend bridge) |
| DC-15 | Packaging / installation | APPROVED | Not started — rulebook only per owner instruction; §4 Windows WIP |
| DC-16 | Peer misbehavior blocking | APPROVED v2 | Done (two-tier ladder, durable hard blocks) |
| DC-17 | Database encryption at rest | DRAFT v2 — BACKLOGGED | Not implemented; needs owner approval |
| DC-18 | .ics export | APPROVED (design only) | Not implemented — explicitly awaiting owner go |
| DC-19 | Tray icon / context menu | APPROVED (2026-08-31) | Done — tray + menu live (Open Tide / Sync now / Options… / Quit); close=hide-to-tray; clean Quit |
| DC-20 | Options window | APPROVED (2026-08-31) | NOT yet implemented — see §3.2 |

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

### 3.3 Recurrence: creation + occurrence editing (DC-12) — partially open
- Done: read-side surfacing — list_series op (Pkg6), dialog rule line with
  occurrence-vs-series note, chip glyphs from live series data; DC-12
  conflict semantics (R1-R6, D7) implemented and tested incl. DST (R5).
- Missing: **no UI/domain path to CREATE a recurring event** (no RRULE
  input in the dialog; `series` table empty in the app DB) and no
  occurrence-override editing flows (§R-rules this-occurrence/whole-series).
- Per DC-12 §8, "this and following" split requires a future owner-initiated
  DC — still reserved.

### 3.4 Scheduler ENDPOINT plumbing (DC-11 → DC-13) — the sync-automation gap
- Done: DC-13 runtime wrapper is LIVE in the sidecar (a18e5a4) — timers
  drive the Scheduler; sweep actions no-oped (standing compaction
  constraint); local-change debounce works.
- Missing: **peers have no endpoints.** The DC-07 peers table stores no
  host/port and mDNS browse results are not plumbed into the sidecar, so
  every automatic-session peer is skipped with a log line. Automatic sync
  begins once endpoints arrive (mDNS discovery → sidecar, or last-known-
  endpoint persistence). Manual Sync now (tray/toolbar fallback) works
  today with explicit host/port.
- This is now the main blocker between "sync works" and "sync is automatic".

### 3.5 Reminders / attendees (DC-04, DC-07, spec §6)
- Tables + merge semantics exist; NO create/edit UI or product write path.
  Spec §6 lists them as core domain data — post-v1 by implication, but they
  are spec-promised features, not optional extras.

### 3.6 Time/date model edge coverage (spec §7) — verify before ship
- DST-tested for recurrence expansion (DC-12 R5, Berlin fall-back test);
  ISO-week and localized presentation are thin (week start hard-coded
  Monday; locale via Intl defaults). Low risk, but §7 MUSTs deserve an
  explicit audit item before release.

## 4. TECH DEBT (docs/technical-debt.md)

| ID | Priority | Status | Note |
|---|---|---|---|
| TD-001 | 7/10 HIGH | OPEN (registry) | Quarantine-and-skip semantics; lead recommendation (Option 3) written, PENDING OWNER APPROVAL. NOTE: commits 271e86c/96a257a implemented skipped_seqs (schema v2) + restart revalidation — the registry entry predates them and needs status reconciliation against the code. Gates multi-device release. |
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
5. mDNS→sidecar endpoint plumbing — DC-11 defines discovery, DC-13 defines
   the consumer; the BRIDGE (discovery results flowing into the scheduler's
   peer list + last-known-endpoint persistence) has no contract section
   today. Needed before §3.4 closes. (May be a DC-11/DC-13 amendment rather
   than a new DC.)

## 6. DELIBERATELY NOT STARTED (per standing owner instructions)

- Installer/packaging builds (DC-15 rulebook; no build authorized)
- Windows port (Spec §1 Linux-first; DC-15 §4 WIP)
- .ics import (needs its own contract)
- CalDAV (explicitly skipped by owner)

## 7. RECOMMENDED ORDER (lead's pick, with reasoning)

1. **DC-20 options window** — contract freshly approved; small
   self-contained package; delivers the settings surface and closes the
   DC-20 implementation gap.
2. **TD-001 status reconciliation** — paper exercise against the code
   (271e86c/96a257a landed most of it) + owner ratification; gates
   multi-device release.
3. **mDNS→sidecar endpoint plumbing** — closes §3.4 and makes sync
   actually automatic (the tray's whole point). Needs the small
   contract bridge item from §5.5 first.
4. **.ics export (DC-18)** — on the owner's word; self-contained.
5. **Recurrence creation UI** — largest UI piece.
6. **TD-010 tray error marker** — pairs naturally with any tray work.
