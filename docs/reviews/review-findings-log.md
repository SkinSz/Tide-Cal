# Tide Review Findings & Remediation Log
Created: 2026-08-25. Source: adversarial review agents + owner-approved fixes.
Contracts are authoritative; this log tracks code-vs-contract gaps.

## Review 1 — sync/security modules (agent, 2026-08-25). Verdict: NEEDS-FIXES

### CRITICAL
- C-1 full_state.ts §7.1 dominance rule broken: uses hlcBound=max(seq values)
  vs updated_hlc (epoch ms) => snapshot NEVER replaces local rows; absence-
  handling (deletion-by-omission) entirely missing. Fix: per-entry version
  vector + dominates(snapshot_clock, localVersion) verbatim + absence pass +
  TR-6 property test.

### HIGH
- H-1 full_state device_clock merge overwrites instead of element-wise MAX
  -> monotonicity violation. Fix: max_seq = MAX(existing, incoming).
- H-2 snapshot entries carry fabricated producer "_snapshot"/seq=0. Fix: emit
  real winning (producer, seq, causality_clock) per entity from changes history.
- H-3 sync_engine drops invalid records without durable quarantine (DC-04
  §4.3 / DC-08 §5 Stage 2 violation). Fix: INSERT INTO quarantine before continue.
- H-4 receiveWithTimeout Promise.race swallows late-resolving messages.
  Fix: keep pending receive attached; reuse its result next poll.

### MEDIUM
- M-1 compaction: empty constraintSet silently compacts everything. Fix:
  explicit allowEmptyConstraintSet opt-in flag.
- M-2 compaction: entity tombstone can be swept while member tombstones of
  same entity remain. Fix: cross-check guard in sweep.
- M-3 sync_engine streams all chunks on one request instead of receiver-driven
  continuation; no remaining_ranges emitted. Fix per DC-08 §3.3.
- M-4 protocol version handling: must implement DC-08 §5 Stage 1 (v>1 ignore;
  unparseable/v<1 close; malformed known type drop+continue; unknown type ignore).
- M-5 pull loop gapRetries resets on any ranges change -> DoS via alternating
  ranges. Fix: absolute cap or monotone-progress check.
- M-6 loadKnowledgeFromDb stub; applied_upto/lastKnownClock memory-only ->
  re-request full history each restart; compaction stalls. Fix: persist/load.
- M-7 DC-09 trigger layer absent (no OFFER/ACCEPT handshake, no Triggers A-D,
  no computeIncrementalCost, no race resolution). To implement as DC-09 module.
- M-8 buildSnapshot loads whole events table into memory; only events covered
  (missing calendars/series/overrides/members); tombstone message ordering wrong.
- M-9 invalid snapshot entries abort whole apply instead of per-entry quarantine.
- M-10 identity keys generated in TS; DC-05 §2.1 mandates Rust-side custody.
  Resolution: owner decision — dev-phase TS implementation accepted for now;
  move custody to Rust/Tauri commands before production. Documented deviation.

### LOW/NIT
- L-1 ACK once at end vs after-each-batch; stats.sent missed in one path;
  stale comment; closed-peer falls through to send.
- L-2 victim selection outside transaction (TOCTOU, safe single-process);
  per-record prepare inefficiency; stats not rolled back on tx failure.
- L-3 explicit initCrypto() preferred over module-load mutation; no key zeroize.
- L-4 inheritedTombstones counts skipped duplicates.

### Test gaps (to add)
- sync engine: TR-2..TR-13 mostly missing (relay convergence, reorder property,
  partial-batch poisoning, unknown-type grace, version fail-closed, replay idem,
  batch continuation).
- compaction: TR-1 fuzz, TR-3/TR-4 constraint-set cases, TR-6 kill-mid-sweep,
  TR-9 bounded growth, empty-constraintSet guard, member/entity ordering guard.
- full_state: TR-6 concurrent-edit property (exposes C-1), trigger tests,
  absence handling, streaming bounds.
- identity: malformed private key inputs.

## Review 2 — domain core + persistence (agent, 2026-08-25). Verdict: NEEDS-FIXES

### CRITICAL
- C1 loadKnowledgeFromDb is a stub -> after restart, redelivery crashes
  (UNIQUE) or re-buffers (UNIQUE on pending_changes). Fix: rebuild
  KnowledgeState from applied_upto + pending_changes tables; treat DB UNIQUE
  violations as idempotent duplicates in applyRemoteChange.
- C2 T2 atomicity hole: advanceApplied mutates memory BEFORE tx;
  bufferPending AFTER commit. If mutate throws mid-T2: DB rolls back but
  memory advanced => retry classified duplicate => silent loss. Fix: derive
  classification from DB inside tx, or roll back memory on failure.
- C3 T1 nextSeq = MAX(changes.local_seq)+1 regresses after compaction of own
  rows; clock upsert assigns instead of max. Fix: nextSeq =
  max(device_clock[self], MAX(local_seq)) + 1; element-wise-max upserts.

### HIGH
- H1 encryptionKey accepted but ignored (dev-phase deviation, documented —
  must gate shipping; owner decision stands).
- H2 'obsolete' status added to schema/conflict enum without owner sign-off.
  NOTE: DC-14 §7.1 IS approved and defines obsolete — reviewer's contracts
  predates it. Resolution: documented as authorized by DC-14 approval; tighten
  CHECK so obsolete carries no resolved_value/resolved_at_hlc.

### MEDIUM
- M1 validateChangeRecord gaps: member ops without member_id accepted;
  missing schema_version accepted; negative hlc; causality entries of 0;
  remove payload unchecked; tombstone-marker/override field_path unchecked.
- M2 deepEqual: arrays vs objects equal; NaN vs NaN unequal; undefined-key
  asymmetry. Fix with Array.isArray + Object.is for numbers.
- M3 effectiveValue returns whole member payload not payload.value (metadata
  keys flip convergence into conflict).
- M4 property test has tautological pending-drained assertion (k_pendingEmpty
  stub). Fix: assert real knowledge state.

### LOW/NIT
- incoming records never validated in applyRemoteChange; blind JSON.parse cast
  for drained pendings; drained[...]! assertion; catch-all initSchema treats
  any error as fresh DB; O(n²) pending reload per drain step; unused xProducer
  param; DDL lacks explicit ON DELETE RESTRICT textually; non-canonical JSON
  serialization order.
- Verified NOT bugs: buffered records' clocks merged at buffer time;
  neededRanges boundary handling correct.

### Test gaps
- DC-01 TR-3/5/6/7; DC-02 TR-4 relay, TR-5 static no-LWW, TR-6 restart
  monotonicity, randomized comparison properties; DC-03 TR-6/7/8/10;
  DC-07 TR-2 randomized round-trip, TR-5 DST, TR-6 FK, TR-7 kill-9 atomicity,
  TR-8 EXPLAIN QUERY PLAN, migration framework absent entirely.

## Remediation status
- [x] M-10 documented as owner-approved dev-phase deviation (move to Rust pre-prod)
- [ ] C-1 rewrite §7.1 + absence pass + property test (agent in flight)
- [ ] H-1 max merge fix (agent in flight)
- [ ] H-2 real producer identity in snapshots (agent in flight)
- [ ] H-4 receive race fix (agent in flight)
- [ ] M-5 pull-loop cap (agent in flight)
- [ ] H-3 durable quarantine writes (agent in flight)
- [ ] P-C1/C2/C3 persistence criticals — DISPATCH NEXT (database.ts owner busy)
- [ ] P-M1..M4 validation/deepEqual fixes — queue after criticals
- [ ] pairing.test esbuild #require issue — check builder output (may be stale info)
- [ ] revocation 5 failures noted by reviewer vs 19/19 pass reported by builder — verify locally
