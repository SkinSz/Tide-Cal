# Tide — Feature Completeness & Open Work Report

Date: 2026-08-30 · Branch `remediation` @ 2eb3bb2 · P11 fix committed, adversarial review PASS (8/8)
Scope: what features are missing, need implementation, or need a design contract.
Derived from the design contracts (DC-01..18), the technical-debt registry,
and the architecture spec's deferred-decision list — cross-checked against
source where a claim of "done" needed proof.

---

## 1. CONTRACT STATUS LEDGER

| DC | Title | Status | Implementation |
|---|---|---|---|
| DC-01 | Change record schema | APPROVED | Done (Pkg1-6 hardened) |
| DC-02 | Vector clocks | APPROVED | Done |
| DC-03 | Conflict detection | APPROVED + **v2 (2026-08-30, §3.2a)** | Done — P11 fix landed, adversarial review PASS 8/8 |
| DC-04 | Collection merge | APPROVED | Core merge done; attendee/reminder collections have no product surface |
| DC-05 | Identity / pairing / transport | APPROVED | Done (pairing lifecycle, revocation) |
| DC-06 | Tombstone compaction | APPROVED | Done — sweep() fixed, still deliberately UNWIRED from scheduler (see §3) |
| DC-07 | SQLite schema | APPROVED | v6, migration chain live |
| DC-08 | Sync message protocol | APPROVED | Done (21 RPC ops, Noise XX over TCP) |
| DC-09 | Full-state sync | APPROVED + 2 amendments | Done; MAX_INCREMENTAL_BACKLOG is user-adjustable **but has no settings UI** (§5) |
| DC-10 | Revocation propagation | APPROVED | Done (unpair/unblock surfaces) |
| DC-11 | mDNS discovery | APPROVED | Done |
| DC-12 | Recurrence conflicts | APPROVED | Partial — see §2.3 |
| DC-13 | Background sync scheduling | APPROVED | **Partial** — see §2.4 |
| DC-14 | Conflict resolution UI | APPROVED | **Partial — read surface done, write path missing** (see §2.1) |
| DC-15 | Packaging / installation | APPROVED | **Not started** — rulebook only, per owner instruction; §4 Windows WIP |
| DC-16 | Peer misbehavior blocking | APPROVED v2 | Done (two-tier ladder, durable hard blocks) |
| DC-17 | Database encryption at rest | **DRAFT v2 — BACKLOGGED** | Not implemented; needs owner approval before any work |
| DC-18 | .ics export | APPROVED (design only) | **Not implemented** — explicitly awaiting owner go |

## 2. OPEN FEATURES (need implementation; contracts already exist)

### 2.1 Conflict-resolution write path (DC-14) — highest value gap
- What exists: toolbar badge, conflict list dialog, side-by-side candidate
  detail, Keep/Discard buttons mapped to keep_mine/keep_theirs
  (frontend/conflicts.ts), and the backend `ConflictsViewModel.resolve()`
  write transaction (src/application/conflicts_ui.ts §6).
- What's missing — three seams, all explicitly TODO'd in code:
  1. **No data path to the webview**: frontend/conflicts.ts expects an
     injected `window.__TIDE_CONFLICTS__` bridge — nothing injects it
     (grep: zero injection sites in sidecar/Rust). It has NO invoke/syncOp
     calls, so the dialog always renders the honest empty fallback. The
     sidecar HAS `list_conflicts`/`conflict_detail` ops and Rust allow-lists
     them, but the frontend never calls them.
  2. **No resolve/skip RPC ops**: sidecar dispatcher deliberately exposes
     only read ops ("Deliberately READ-ONLY" — sidecar_server.ts:503). The
     resolve/skip ops are unwritten, unwired in Rust, and unapproved as ops.
  3. **No resolution propagation**: DC-14 §6/§7 propagation of outcomes to
     other devices rides the sync engine — not yet exercised end-to-end.
- Net effect: a user CAN see a conflict today but CANNOT resolve it in the
  GUI. This is the single biggest functional hole.

### 2.2 .ics export (DC-18) — approved, awaiting owner go
- `export_ics(scope, target_path)` Tauri command specified, zero code.
- Blocked only by your explicit go (the approval covered design).

### 2.3 Recurrence surfacing & series editing (DC-12) — partially open
- Done: read-only surfacing is real — `list_series` op implemented (Pkg6),
  dialog shows a plain-language rule line with this-occurrence-vs-series
  note, chips carry the 🔁/✎ glyph via live series data.
- Missing: **no UI to CREATE a recurring event** (no RRULE input in the
  dialog; `series` table is empty in the app DB). DC-12 constrains
  correctness/identity, not creation UI — so this needs an implementation
  package for series creation + occurrence-override editing (this-occurrence
  vs whole-series flows per DC-12 §R-rules).
- Explicitly out of scope by contract: "this and following" split (needs a
  future owner-initiated DC per DC-12 §8).

### 2.4 Background scheduler runtime (DC-13) — partial
- Done: the pure decision logic (trigger catalog, debounce, sweep interval,
  concurrency bounds) exists and is tested.
- Missing: **the runtime wrapper** — nothing consumes the scheduler's
  actions; there is no setInterval/setTimeout wiring, no tray component
  (DC-13 "Unblocks: Linux implementation of the background/tray component"),
  no hide-to-tray lifecycle. Sync today happens only via manual sync_now.
- Interaction constraint: wiring scheduler→sweep is BLOCKED until the Pkg1
  follow-ups are confirmed landed in the shipping path (standing constraint
  from the remediation campaign).

### 2.5 Settings surface (DC-09 amendment + DC-13 §3.5)
- MAX_INCREMENTAL_BACKLOG (100..100,000) and scheduler knobs are specified
  as user-adjustable, but there is **no settings UI** — defaults are
  hard-wired in production. DC-13 defers tray/settings appearance to a
  future UI contract. Either build a minimal settings panel or amend the
  contracts to make defaults fixed for v1.

### 2.6 Reminders / attendees (DC-04, DC-07)
- Tables and merge semantics exist; there is **no create/edit UI or domain
  write path** for reminders or attendees in the product surface. Spec lists
  them as stored data. Likely post-v1.

## 3. TECH DEBT (from docs/technical-debt.md + campaign residues)

| ID | Priority | Status | Note |
|---|---|---|---|
| TD-001 | 7/10 HIGH | OPEN | Quarantine-and-skip semantics. Lead recommendation (Option 3) written and PENDING OWNER APPROVAL; blocked stream growth otherwise. Must precede multi-device release. NOTE: parts exist (skipped_seqs schema v2, revalidation) — registry needs a status reconciliation against commits 271e86c/96a257a. |
| TD-003 | 4/10 | DEFERRED | Legacy dev-* identity migration. Correctly deferred until an upgrade release exists. |
| TD-007 | 2/10 | OPEN | Hygiene nits (prepared statements, monotonic windows, resolved_at_hlc naming, onHardBlock guard). Opportunistic. |
| TD-009 | 2/10 | OPEN | Pairing-offer Cancel button — frontend-only, op exists and is allow-listed. |
| P11 | — | **CLOSED** | Root cause fixed (DC-03 v2 §3.2a, e53ec02), regression tests prove old failure, adversarial review PASS 8/8 (2eb3bb2). Registry entry should be updated. |
| F9 residual | 2/10 | OPEN | General unhandled-rejection → exit(1) hardening beyond the Pkg4-guarded path. |
| BND-07 | 2/10 | OPEN | Protocol leniency quirks (dup JSON keys, id 1e999). |
| Backup-restore seq collision | 3/10 | OUT OF CONTRACT | Detection cue live (Pkg6 HELLO anomaly); proper fix = never applies (DC-05 §2.2 restore = new identity). |

## 4. NEEDS A NEW DESIGN CONTRACT (nothing invented yet)

1. **"This and following" recurrence split** — DC-12 §8 explicitly reserves
   a future owner-initiated DC.
2. **Tray icon + settings UI layout** — DC-13 §8 defers to a future UI
   contract (needed before §2.5 above can be built properly).
3. **Second-order resolution reconciliation** — DC-14 §6.4: arrival-order
   mesh edge cases; a future contract MAY add it. Not urgent.
4. **DC-02/DC-03 clarification on gap-buffered causal-before records** —
   P11 fixed the materialized-row regression; the related question of
   whether the stale record should ALSO be marked (vs silently stored) is
   an optional contract refinement. Default: not needed.
5. **DC-17 encryption** — already drafted, BACKLOGGED; needs your approval
   to become an implementation contract (keystore integration, migration
   of existing plaintext DBs).

## 5. DELIBERATELY NOT STARTED (per your standing instructions)

- Installer/packaging builds (DC-15 rulebook exists; no build authorized)
- Windows port (Spec §1 Linux-first; DC-15 §4 WIP)
- .ics import (out of scope of DC-18; would need its own contract)
- CalDAV (explicitly skipped by owner)

## 6. RECOMMENDED ORDER (my pick, with reasoning)

1. **Conflict-resolution write path** (DC-14) — biggest user-visible gap;
   design fully specified; unblocks the entire conflict UX story. Requires
   a resolve/skip RPC pair + Rust proxy + bridge injection — all within
   already-approved contracts. No new design work.
2. **Pairing-offer Cancel button** (TD-009) — trivial, closes a security-
   adjacent UX gap in an afternoon.
3. **DC-13 runtime wrapper + minimal tray** — makes sync actually
   automatic; the pure logic is already tested. Needs the small UI
   contract for tray/settings, or owner decision to keep manual sync for v1.
4. **.ics export** (DC-18) — on your word; self-contained.
5. **TD-001 status reconciliation + owner approval** of Option 3 — paper
   exercise plus possibly small work; gates multi-device release.
6. **Recurrence creation UI** — largest UI piece; schedule after the above.
