// Tide DC-02 §2.2/§5: Knowledge state — applied_upto, pending, missing-change
// detection. Pure logic over explicit state objects.

import type { VectorClock } from "./change_record.ts";
import { get } from "./vector_clock.ts";

export interface SeqRange {
  device_id: string;
  lo: number; // inclusive
  hi: number; // inclusive
}

export interface KnowledgeState {
  /** producer device_id -> contiguous applied frontier (DC-02 §2.2) */
  appliedUpto: Record<string, number>;
  /** out-of-order buffered records above applied_upto */
  pending: Map<string, Set<number>>; // device_id -> seqs
  /**
   * TD-001: producer seqs that were quarantined and are thereby resolved
   * for sequence progress (durable twin: skipped_seqs). Optional so legacy
   * constructors keep working; persistence always populates it.
   */
  skipped?: Map<string, Set<number>>; // device_id -> seqs
}

export function emptyKnowledge(): KnowledgeState {
  return { appliedUpto: {}, pending: new Map() };
}

export function appliedThrough(k: KnowledgeState, deviceId: string): number {
  return k.appliedUpto[deviceId] ?? 0;
}

/** The (possibly absent) skipped set for a producer (TD-001). */
function skippedOf(k: KnowledgeState, deviceId: string): Set<number> {
  return k.skipped?.get(deviceId) ?? new Set<number>();
}

/**
 * TD-001: smallest seq > applied_upto[d] with no skipped_seqs row — the
 * derived "processed frontier". applied_upto itself NEVER crosses a
 * skipped seq (DC-02 §2.2 meaning preserved exactly).
 */
export function nextExpected(k: KnowledgeState, deviceId: string): number {
  let s = appliedThrough(k, deviceId) + 1;
  const skipped = skippedOf(k, deviceId);
  while (skipped.has(s)) s += 1;
  return s;
}

/** Is this (device,seq) already applied or buffered? (DC-02 §7.1) */
export function isDuplicate(
  k: KnowledgeState,
  deviceId: string,
  localSeq: number,
): boolean {
  return (
    localSeq <= appliedThrough(k, deviceId) ||
    skippedOf(k, deviceId).has(localSeq) || // TD-001
    k.pending.get(deviceId)?.has(localSeq) === true
  );
}

/**
 * Classify arrival per DC-02 §7.1/§7.2/§4.4.
 *   "duplicate" -> drop silently (still merge clocks)
 *   "apply"     -> apply now; caller must drain returned pending runs
 *   "buffer"    -> store in pending until gap fills
 */
export type Arrival = "duplicate" | "apply" | "buffer";

export function classifyArrival(
  k: KnowledgeState,
  deviceId: string,
  localSeq: number,
): Arrival {
  // DC-02 §7.1/§7.2: applied -> duplicate; buffered -> duplicate UNLESS
  // it has become applicable (applied_upto advanced to seq-1), in which
  // case the caller re-drains through it.
  // TD-001: a quarantined (skipped) seq is also a duplicate — re-delivery
  // merges clocks only and must not spam quarantine rows.
  const through = appliedThrough(k, deviceId);
  if (skippedOf(k, deviceId).has(localSeq)) return "duplicate";
  if (localSeq <= through) return "duplicate";
  if (localSeq === nextExpected(k, deviceId)) return "apply";
  return k.pending.get(deviceId)?.has(localSeq) === true ? "duplicate" : "buffer";
}

/** Buffer an out-of-order record (caller stores payload separately). */
export function bufferPending(
  k: KnowledgeState,
  deviceId: string,
  localSeq: number,
): void {
  if (localSeq <= appliedThrough(k, deviceId)) return;
  let set = k.pending.get(deviceId);
  if (!set) {
    set = new Set();
    k.pending.set(deviceId, set);
  }
  set.add(localSeq);
}

/**
 * Apply + drain: advance through localSeq and any consecutive pending
 * members (DC-02 §4.4). Returns the drained (device,seq) pairs in order,
 * INCLUDING the initial application — caller applies each payload in order.
 */
export function advanceApplied(
  k: KnowledgeState,
  deviceId: string,
  localSeq: number,
): Array<{ device_id: string; local_seq: number }> {
  const drained: Array<{ device_id: string; local_seq: number }> = [];
  // The triggering record must be exactly nextExpected — the smallest seq
  // above the frontier with no skip row (TD-001). Be lenient to idempotent
  // replays only via isDuplicate checks upstream.
  if (localSeq !== nextExpected(k, deviceId)) return drained;
  let next = localSeq;
  const skipped = skippedOf(k, deviceId);
  drained.push({ device_id: deviceId, local_seq: localSeq });
  const pend = k.pending.get(deviceId);
  // A skipped seq is never buffered, but guard anyway: the frontier must
  // never advance THROUGH a seq that still carries a skip row.
  while (pend?.has(next + 1) && !skipped.has(next + 1)) {
    next += 1;
    pend.delete(next);
    drained.push({ device_id: deviceId, local_seq: next });
  }
  if (pend && pend.size === 0) k.pending.delete(deviceId);
  k.appliedUpto[deviceId] = next;
  // TD-001 (4): skip rows at/below the new frontier are resolved — GC them
  // from the in-memory mirror (durable GC happens in the same transaction).
  if (k.skipped?.has(deviceId)) {
    const set = k.skipped.get(deviceId)!;
    for (const s of [...set]) {
      if (s <= next) set.delete(s);
    }
    if (set.size === 0) k.skipped.delete(deviceId);
  }
  return drained;
}

/**
 * DC-02 §5 neededRanges: exact disjoint contiguous ranges we still need,
 * given a peer's advertised clock, EXCLUDING already-pending records.
 *
 * Pkg5b (QA M-4 root-cause fix): `selfDeviceId`, when provided, excludes
 * SELF-PRODUCED sequences from the result. A producer's own seqs are local
 * by definition — the device created and applied them at T1 — so they can
 * never be "needed" from a peer, and the receiver-side knowledge state has
 * no reason to track an applied_upto frontier for them. Without this
 * exclusion, a peer's advertised clock component for our own device id
 * (it learned those seqs by applying our changes) produced a phantom
 * CHANGES_REQUEST for our own history; the request is either served back as
 * pure duplicates (duplicates never advance applied_upto, so the range never
 * shrinks) or unservable after compaction — in both cases the pull loop
 * registers persistent "gap rounds" and fires DC-09 §3 Trigger A on every
 * session between fully-converged peers (the M-4 every-session full-state
 * transfer). Excluding self restores the contract meaning: neededRanges is
 * about data we genuinely lack.
 */
export function neededRanges(
  k: KnowledgeState,
  advertised: VectorClock,
  selfDeviceId?: string,
): SeqRange[] {
  const need: SeqRange[] = [];
  for (const [d, advSeq] of Object.entries(advertised)) {
    // Pkg5b (QA M-4): self-produced sequences are never needed.
    if (selfDeviceId !== undefined && d === selfDeviceId) continue;
    const have = appliedThrough(k, d);
    if (advSeq <= have) continue;
    const havePending = k.pending.get(d) ?? new Set<number>();
    // TD-001: skipped seqs are never re-requested (receiver-local filter).
    const haveSkipped = skippedOf(k, d);
    let lo = have + 1;
    for (let s = have + 1; s <= advSeq + 1; s++) {
      // close the current run when hitting a pending/skipped seq or the end
      if (s === advSeq + 1 || havePending.has(s) || haveSkipped.has(s)) {
        if (lo < s) need.push({ device_id: d, lo, hi: s - 1 });
        lo = s + 1;
      }
    }
  }
  return need;
}
