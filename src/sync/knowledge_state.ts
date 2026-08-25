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
}

export function emptyKnowledge(): KnowledgeState {
  return { appliedUpto: {}, pending: new Map() };
}

export function appliedThrough(k: KnowledgeState, deviceId: string): number {
  return k.appliedUpto[deviceId] ?? 0;
}

/** Is this (device,seq) already applied or buffered? (DC-02 §7.1) */
export function isDuplicate(
  k: KnowledgeState,
  deviceId: string,
  localSeq: number,
): boolean {
  return (
    localSeq <= appliedThrough(k, deviceId) ||
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
  const through = appliedThrough(k, deviceId);
  if (localSeq <= through) return "duplicate";
  if (localSeq === through + 1) return "apply";
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
  let next = appliedThrough(k, deviceId) + 1;
  // The triggering record must be exactly `next` for a legal call; be lenient
  // to idempotent replays only via isDuplicate checks upstream.
  if (localSeq !== next) return drained;
  drained.push({ device_id: deviceId, local_seq: localSeq });
  const pend = k.pending.get(deviceId);
  while (pend?.has(next + 1)) {
    next += 1;
    pend.delete(next);
    drained.push({ device_id: deviceId, local_seq: next });
  }
  if (pend && pend.size === 0) k.pending.delete(deviceId);
  k.appliedUpto[deviceId] = next;
  return drained;
}

/**
 * DC-02 §5 neededRanges: exact disjoint contiguous ranges we still need,
 * given a peer's advertised clock, EXCLUDING already-pending records.
 */
export function neededRanges(
  k: KnowledgeState,
  advertised: VectorClock,
): SeqRange[] {
  const need: SeqRange[] = [];
  for (const [d, advSeq] of Object.entries(advertised)) {
    const have = appliedThrough(k, d);
    if (advSeq <= have) continue;
    const havePending = k.pending.get(d) ?? new Set<number>();
    let lo = have + 1;
    for (let s = have + 1; s <= advSeq + 1; s++) {
      // close the current run when hitting a pending seq or the end
      if (s === advSeq + 1 || havePending.has(s)) {
        if (lo < s) need.push({ device_id: d, lo, hi: s - 1 });
        lo = s + 1;
      }
    }
  }
  return need;
}
