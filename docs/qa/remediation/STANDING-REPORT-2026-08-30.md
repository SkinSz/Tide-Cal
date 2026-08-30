# Tide — Where We Stand (2026-08-30)

Branch `remediation` @ 2eb3bb2 · P11 fix committed, adversarial review PASS (8/8).
Scope: feature completeness, open work, and what still needs a design contract.

---

## 0. EVALUATION BASIS

This report was drafted AFTER evaluating the founding document —
`docs/specs/ARCHITECTURE_SPEC_v0.3.md` (FROZEN, the "what is Tide" outline
predating all design contracts) — against the current implementation, the
contract ledger (DC-01..18), and the technical-debt registry.

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
| DC-09 | Full-state sync | APPROVED + 2 amendments | Done; MAX_INCREMENTAL_BACKLOG user-adjustable but has NO settings UI (§3.5) |
| DC-10 | Revocation propagation | APPROVED | Done (unpair/unblock surfaces) |
| DC-11 | mDNS discovery | APPROVED | Done |
| DC-12 | Recurrence conflicts | APPROVED | Partial — see §3.3 |
| DC-13 | Background sync scheduling | APPROVED | Partial — see §3.4 |
| DC-14 | Conflict resolution UI | APPROVED | Partial — read surface done, write path missing (§3.1) |
| DC-15 | Packaging / installation | APPROVED | Not started — rulebook only per owner instruction; §4 Windows WIP |
| DC-16 | Peer misbehavior blocking | APPROVED v2 | Done (two-tier ladder, durable hard blocks) |
| DC-17 | Database encryption at rest | DRAFT v2 — BACKLOGGED | Not implemented; needs owner approval |
| DC-18 | .ics export | APPROVED (design only) | Not implemented — explicitly awaiting owner go |

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
  exactly the §30/§31 mechanism in action (14 deferred decisions → 18 DCs).

## 3. OPEN FEATURES — spec/contract exists, implementation missing

### 3.1 Conflict-resolution write path (DC-14) — highest-value gap
- Exists: toolbar badge, conflict list dialog, side-by-side candidate detail,
  Keep/Discard buttons (frontend/conflicts.ts); backend
  ConflictsViewModel.resolve() transaction (src/application/conflicts_ui.ts §6);
  sidecar read ops list_conflicts/conflict_detail (+ Rust allow-list).
- Missing (three seams, all explicit TODOs in code):
  1. No data path into the webview — frontend/conflicts.ts expects an
     injected `window.__TIDE_CONFLICTS__` bridge; nothing injects it (zero
     injection sites in sidecar/Rust) and it makes no invoke/syncOp calls,
     so the dialog always renders the honest empty fallback.
  2. No resolve/skip RPC ops — sidecar dispatcher is deliberately
     READ-ONLY (sidecar_server.ts:503); ops unwritten, unwired in Rust.
  3. No end-to-end exercise of DC-14 §6/§7 resolution propagation to peers.
- Net: a user can SEE a conflict today but CANNOT resolve it in the GUI.

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

### 3.4 Background scheduler runtime (DC-13) — partial
- Done: pure decision logic (trigger catalog, debounce, sweep interval,
  concurrency bounds), tested.
- Missing: the RUNTIME WRAPPER — nothing consumes scheduler actions; no
  timers, no tray component (DC-13 "Unblocks: Linux implementation of the
  background/tray component"), no hide-to-tray lifecycle. Sync is manual
  sync_now only.
- Standing constraint: wiring scheduler→sweep is BLOCKED until Pkg1
  follow-ups are confirmed in the shipping path (remediation campaign).

### 3.5 Settings surface (DC-09 amendment + DC-13 §3.5) — missing
- MAX_INCREMENTAL_BACKLOG (bounds 100..100,000) and scheduler knobs are
  specified as user-adjustable; production hard-wires defaults. No settings
  UI exists, and DC-13 §8 defers tray/settings layout to a future UI
  contract. Either build that panel (needs the small UI contract first) or
  amend the contracts to pin defaults for v1.

### 3.6 Reminders / attendees (DC-04, DC-07, spec §6)
- Tables + merge semantics exist; NO create/edit UI or product write path.
  Spec §6 lists them as core domain data — post-v1 by implication, but they
  are spec-promised features, not optional extras.

### 3.7 Time/date model edge coverage (spec §7) — verify before ship
- DST-tested for recurrence expansion (DC-12 R5, Berlin fall-back test);
  ISO-week and localized presentation are thin (week start hard-coded
  Monday; locale via Intl defaults). Low risk, but §7 MUSTs deserve an
  explicit audit item before release.

## 4. TECH DEBT (docs/technical-debt.md + campaign residues)

| ID | Priority | Status | Note |
|---|---|---|---|
| TD-001 | 7/10 HIGH | OPEN (registry) | Quarantine-and-skip semantics; lead recommendation (Option 3) written, PENDING OWNER APPROVAL. NOTE: commits 271e86c/96a257a implemented skipped_seqs (schema v2) + restart revalidation — the registry entry predates them and needs status reconciliation against the code. Gates multi-device release. |
| TD-003 | 4/10 | DEFERRED | Legacy dev-* identity migration; correctly deferred until an upgrade release exists. |
| TD-007 | 2/10 | OPEN | Hygiene nits (prepared statements, monotonic windows, resolved_at_hlc naming, onHardBlock guard). |
| TD-009 | 2/10 | OPEN | Pairing-offer Cancel button — frontend-only; op exists and is allow-listed. |
| P11 | — | **CLOSED** | Root cause fixed (DC-03 v2 §3.2a, e53ec02); old failure reproduced then pinned as regression; adversarial review PASS 8/8 (2eb3bb2). Registry entry should be updated. |
| F9 residual | 2/10 | OPEN | General unhandled-rejection → exit(1) hardening beyond Pkg4's guarded path. |
| BND-07 | 2/10 | OPEN | Protocol leniency quirks (dup JSON keys, id 1e999). |
| Backup-restore seq collision | 3/10 | OUT OF CONTRACT | Detection cue live (Pkg6 HELLO anomaly); DC-05 §2.2 makes the scenario unreachable for conformant restores. |

## 5. NEEDS A NEW DESIGN CONTRACT (nothing invented yet)

1. "This and following" recurrence split — DC-12 §8 reserves it.
2. Tray icon + settings UI layout — DC-13 §8 defers to a future UI contract
   (prerequisite for §3.5 above).
3. Second-order resolution reconciliation — DC-14 §6.4 allows a future
   contract; not urgent.
4. DC-02/DC-03 refinement: marking (vs silently storing) stale causal-before
   records — optional; default is no action.
5. DC-17 encryption — drafted and BACKLOGGED; needs owner approval to become
   implementable (keystore integration, plaintext-DB migration).

## 6. DELIBERATELY NOT STARTED (per standing owner instructions)

- Installer/packaging builds (DC-15 rulebook; no build authorized)
- Windows port (Spec §1 Linux-first; DC-15 §4 WIP)
- .ics import (needs its own contract)
- CalDAV (explicitly skipped by owner)

## 7. RECOMMENDED ORDER (lead's pick, with reasoning)

1. Conflict-resolution write path (DC-14) — biggest user-visible gap; design
   fully specified; needs resolve/skip RPC pair + Rust proxy + bridge
   injection, all inside approved contracts. No new design work.
2. Pairing-offer Cancel button (TD-009) — trivial; closes a security-
   adjacent UX gap in an afternoon.
3. DC-13 runtime wrapper + minimal tray — makes sync automatic; pure logic
   already tested. Needs the small UI contract for tray/settings, or an
   owner decision to keep manual sync for v1.
4. .ics export (DC-18) — on the owner's word; self-contained.
5. TD-001 status reconciliation + owner ratification of Option 3 — gates
   multi-device release.
6. Recurrence creation UI — largest UI piece; schedule after the above.
