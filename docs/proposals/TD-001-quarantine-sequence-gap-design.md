# TD-001 Phase 1 — Quarantined-sequence-gap: semantics findings & design proposal

Status: PROPOSAL (pending owner approval). No production code touched.
Grounded at commit ea2a910. Evidence: DC-02 §2.2/§4.4/§5/§7, DC-04 §4.3,
DC-07 §4.10/TR-10, DC-08 §3.4/§4 Stage 6/§6.3; code: `src/sync/knowledge_state.ts`,
`src/persistence/database.ts` (applyRemoteChange), `src/sync/sync_engine.ts`
(applyBatch), `src/sync/full_state.ts`.

## 0. Spec finding that shapes everything

The owner-endorsed direction "quarantine AND advance applied_upto" **contradicts
the current specs as written**:

- DC-08 §4 Stage 6: "Quarantined records do NOT advance applied_upto (they were
  not applied)." The stated rationale is safety: ACKing unapplied data could let
  compaction destroy the only copy of a record the receiver refuses (INVARIANT 8).
- DC-02 §2.2: `applied_upto[d]` = highest seq such that ALL 1..seq were "applied
  contiguously". A quarantined record is never applied (DC-04 §4.3a), so
  advancing `applied_upto` past it would silently redefine the term.

**However**, the specs' safety concern is satisfiable without changing ACK or
applied_upto semantics, because DC-04 §4.3b/TR-10 + DC-07 TR-10 already require
the quarantined record to be retained durably — the "only copy" the compaction
argument protects is never destroyed. And DC-04 §4.3a explicitly permits
"knowledge state beyond clock advancement" to remain untouched while allowing
clock advancement; neededRanges (DC-02 §5) is computed receiver-side, so
filtering skipped seqs out of requests is a purely local change. Conclusion:
quarantine-and-skip is implementable as a **receiver-local, no-wire-change
extension** with one new durable state term. No major protocol redesign; no
silent redefinition of `applied_upto`.

## 1. Design proposal (10 points)

**(1) Current root cause.** `applyBatch` quarantines DC-01/DC-04-invalid records
(sync_engine.ts ~line 643) but advances nothing. `applied_upto[P]` stays below N
forever, so `classifyArrival` sends every later P seq to `buffer` (pending_changes),
and `neededRanges` keeps reporting N. Result: unbounded durable pending growth,
stream never converges, and each anti-entropy round re-requests N only to
re-quarantine it (the behavior DC-08 Stage 6 calls "intentional" — safe but
non-converging for permanently-invalid records).

**(2) Exact meaning of applied_upto today.** Per producer d: highest local_seq
such that ALL changes 1..seq were applied contiguously (DC-02 §2.2). Durable in
`applied_upto` table; monotone via MAX-upsert; advanced only by
`advanceApplied` (apply+drain) and dominated-merge on snapshot apply
(full_state.ts). Quarantine never touches it. **It stays exactly this. The
proposal does not redefine it.**

**(3) Representing a quarantined sequence.** Add a new durable term, cleanly
distinct from the three existing outcome classes (applied / buffered-pending /
duplicate):

- New column/table: `skipped_seqs(producer_device_id, local_seq)` — one row per
  producer seq that was quarantined and is thereby *resolved for sequence
  progress*. (Alternative shape: a per-producer `skipped_upto` watermark; a set
  is chosen because quarantines may be non-contiguous with valid seqs arriving
  later. Compaction of the set: any skipped seq ≤ applied_upto can be deleted —
  see (8).)

State machine becomes four-way, preserving all distinctions:
- **applied** — in `changes`, ≤ applied_upto. Blocks nothing.
- **skipped (quarantined-resolved)** — row in quarantine (never deleted) +
  row in skipped_seqs. Unblocks later seqs; still visible; revalidation target.
- **pending** — in pending_changes; genuinely blocking (gap still expected).
- **duplicate** — classified at arrival.

`applied_upto` never crosses a skipped seq; "processed frontier" is derived,
never stored as applied_upto: nextExpected(d) = smallest s > applied_upto[d]
with no skipped_seqs row (computed by scanning the small skipped set).

**(4) Later sequences progress.** In `classifyArrival`, a seq that is not
duplicate and equals nextExpected(d) is "apply": apply it, set
applied_upto := that seq — but only after collapsing: skipped rows < new
applied_upto are GC'd. Seqs > nextExpected still buffer. Example: N quarantined
→ skip(N); N+1 arrives → nextExpected = N+1 → apply, applied_upto := N+1,
GC skip(N) (quarantine row remains). Pending N+2.. drain normally.
neededRanges additionally excludes skipped seqs (receiver-local), so the peer
is never re-sent the rejected record and no requests loop forever. ACK stays
ACK stays exactly `applied_upto` per DC-08 §3.4/Stage 6 — which means the ACK
plateaus at N-1 for a while. This is deliberate and honest: DC-02 §2.2 strictly
implies "all 1..N applied", and claiming N+1 would falsely report N as applied.
Consequence: peer-side compaction of its copy of N is delayed — which is exactly
the safety property Stage 6 protects (the record is retained on both sides, in
our quarantine and in the peer's history). Liveness is fully restored because
requests stop excluding nothing and applied state progresses past N; the ACK
plateau is a bounded, safe inefficiency that self-heals on revalidation (6) or
the next FULL_STATE_SNAPSHOT dominated-merge (8). Lifting the plateau earlier
would require the DC-08 negative-ack extension (deferred, see (10)).

**(5) After restart.** `loadKnowledgeFromDb` also loads skipped_seqs (plus the
in-memory set mirrors it). Quarantine rows survive (DC-07 TR-10). No seq is
re-requested for skipped positions; pending rows above them stay pending.

**(6) Automatic revalidation (restart-time).** At engine init (after
loadKnowledgeFromDb): iterate quarantine rows; re-run validateChangeRecord +
the full apply path against current durable state. If now valid (e.g. forward-
fixed validator, schema-version bump): apply the mutation idempotently (dedupe
by change_id / changes-table UNIQUE), remove its skipped_seqs row, merge
causality_clock; if it equals applied_upto+1 (the stalled case) the frontier
now advances honestly and the ACK resumes. If still invalid: remain
quarantined, skipped row stays. Revalidation is idempotent and countable
(DC-04 §4.3c); validation is NOT weakened. No mid-session revalidation in v1
(keep the trigger surface minimal); restart is the owner-endorsed trigger.

**(7) Duplicate delivery.** Extend `isDuplicate`/`classifyArrival`:
seq ≤ applied_upto OR in pending OR in skipped_seqs → duplicate: drop silently,
still merge clocks (DC-02 §7.1). Re-delivery of a quarantined record therefore
does NOT create duplicate quarantine rows (idempotent, avoids quarantine spam).
Deterministic: same record ⇒ same classification on any replay (INVARIANT 14).

**(8) Snapshots.** FULL_STATE_SNAPSHOT unaffected: applied_upto := dominated
merge with snapshot_clock (DC-06 §3.4), which may legitimately jump past
skipped seqs because the snapshot replaces incremental reconstruction and the
snapshot content carries current semantic state. Post-snapshot, skipped rows
≤ new applied_upto are GC'd; quarantine diagnostic rows survive (DC-08 §3.6:
"a snapshot does not auto-delete ... quarantined diagnostics"). Pending rows
≤ frontier deleted (existing F3 logic). If a snapshot is later re-requested,
skipped seqs no longer gate anything. Snapshot application of invalid entries
quarantines individually (DC-08 §3.6) — same skip machinery applies to snapshot-
derived records if sequence-tracked; snapshot entities are not sequence-gated in
the current implementation, so no change needed there.

**(9) Causal-clock and convergence invariants.** Clock merge on quarantine is
already permitted (DC-04 §4.3a) and unchanged. Monotonicity (DC-02 TR-6):
skipped_seqs only ever grows pre-GC; GC only removes rows ≤ applied_upto;
applied_upto advancement path unchanged (MAX-upsert). Convergence (INVARIANT
14): skip classification is a pure function of record content + durable state,
so duplicate/reorder/replay produce identical final state. The skipped record's
mutation is absent locally; if the producer later supersedes it (higher seq on
same entity) normal DC-03/DC-04 merge applies; if it's revalidated, the mutation
lands; if permanently invalid, the peer retains its copy (no compaction unlock
via ACK, by design) so the data is never lost mesh-wide and a future full-state
resync reconciles. No LWW introduced; validation untouched.

**(10) Rejected alternatives.**
- *Advance applied_upto on quarantine (pure owner Option a, no new state)* —
  silently redefines DC-02 §2.2 (applied_upto would claim quarantined seqs were
  applied) and breaks the honest ACK; also orphans revalidation: a revalidated
  record would have nothing to attach to.
- *Skip + discard quarantine row after ack* — violates DC-04 §4.3b/TR-10 and
  DC-08 §7 ("no deletion of data on malformed input"); loses data on false reject.
- *Negative-ack / re-request protocol extension per DC-08* — safest long-term
  (explicit per-seq rejection on the wire), but a full DC-08 revision (new
  message, peer-side semantics, version negotiation). Deferred as future work,
  as in the TD-001 recommendation.
- *Drop the dense-sequence expectation (allow sparse applied_upto)* — breaks
  DC-01 TR-2 gap-free seq, dedupe, and neededRanges arithmetic everywhere.
- *Re-request the quarantined record forever (status quo, spec-literal)* —
  DC-08 Stage 6 calls it intentional, but combined with §6.3 it produces the
  observed unbounded pending growth; a liveness bug regardless of intent, and
  the specs' own DC-04 §4.3d requires quarantine to be "NON-BLOCKING", which
  the status quo violates for the stream.

## 2. Sizing note — Option A "Sync Errors" UI (basic surface)

Scope: badge/indicator + flat list of quarantine rows. NO per-item
retry/delete, NO interpreted messages (explicitly out of scope).

Backend (Node sidecar):
- `src/persistence/database.ts`: add `listQuarantine(db, {limit})` beside
  `countQuarantine` (SELECT quarantine_id, quarantine_reason, received_at_hlc,
  sender_device_id, raw_record ORDER BY quarantine_id DESC). ~15 lines.
- `src/persistence/bridges/sidecar_server.ts` (`makeSyncDispatcher`): new op
  `list_quarantine` returning the rows (raw_record already JSON). ~10 lines.
  Count for the badge can ride on the same op (return `{rows, total}`).

Transport: none needed — `sync_op` passthrough already exists
(`frontend/devices.ts syncOp`, Tauri `sync_op` command in `src-tauri/src/lib.rs`).
No new Rust command.

Frontend:
- `frontend/sync_errors.ts` (new, ~120 lines) modeled on `frontend/devices.ts`:
  dialog listing rows (producer id truncated, seq parsed out of raw_record if
  present, reason code verbatim, raw metadata expandable `<details>`), badge
  count. Refresh on dialog open + after `sync_now`.
- `frontend/main.ts` + `index.html`: toolbar button + badge span + dialog
  markup (mirrors devices-dialog pattern). ~30 lines markup/wiring.

Tests: dispatcher op test + a DOM-level test alongside `tests/conflicts_ui.test.ts`.

Total: ~4 files touched, 1 new frontend module + 1 test file; no protocol,
schema, or Rust changes. Estimated half a session.

## 3. Required regression tests (minimum set)

1. N quarantined → exactly one quarantine row with correct reason, verbatim
   raw_record (DC-04 TR-7); state hash unchanged apart from clock.
2. N quarantined, then valid P seq N+1 → N+1 APPLIES (not buffered);
   pending_changes empty; no unbounded growth over a follow-up batch N+2..N+k.
3. Quarantine durable across restart: row survives with verbatim raw_record,
   countable by reason (DC-07 TR-10); skipped_seqs survives too.
4. Restart-time revalidation attempted: engine init touches every quarantine
   row (assert revalidation pass ran; still-invalid rows remain quarantined,
   skipped state unchanged).
5. Duplicate delivery safe: re-delivering the quarantined record k times
   yields no new quarantine rows, no state change, clocks merged (INVARIANT 14).
6. Later-valid record applies on revalidation: validator-now-accepts scenario →
   restart revalidation applies the mutation idempotently, skipped row removed,
   applied_upto advances honestly when the stalled seq becomes nextExpected.
7. No false success reporting: ACK never carries a frontier that claims the
   quarantined seq was applied; stats outcome classes (applied/buffered/
   duplicate/quarantined) remain mutually exclusive and countable.
8. Snapshot/incremental around the stream: FULL_STATE_SNAPSHOT with
   snapshot_clock past a skipped seq dominated-merges applied_upto, GCs
   skipped rows ≤ frontier, preserves quarantine diagnostics; subsequent
   incremental batches classify correctly (no dupes, no re-quarantine).
9. neededRanges excludes skipped seqs (unit test on knowledge_state) — no
   infinite re-request loop.
