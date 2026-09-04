// Tide DC-02: Vector Clocks — comparison, merge, advancement.
// Semantics-only module per APPROVED contract DC-02. All functions pure.

import type { VectorClock } from "./change_record.ts";

/** Absent entries are treated as 0 FOR COMPARISON ONLY (DC-02 §2.4). */
export function get(clock: VectorClock, deviceId: string): number {
  return clock[deviceId] ?? 0;
}

/** A has seen everything B has seen (DC-02 §3). Reflexive, transitive. */
export function dominates(a: VectorClock, b: VectorClock): boolean {
  for (const d of Object.keys(b)) {
    if (get(a, d) < b[d]!) return false;
  }
  return true;
}

export function equalClocks(a: VectorClock, b: VectorClock): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const d of keys) {
    if (get(a, d) !== get(b, d)) return false;
  }
  return true;
}

/**
 * Change X happened at-or-after change Y causally (DC-02 §3).
 * X.causality dominates Y's AND includes Y's producer seq.
 */
export function sameOrDescendant(
  xClock: VectorClock,
  xProducer: { device_id: string; local_seq: number },
  yClock: VectorClock,
  yProducer: { device_id: string; local_seq: number },
): boolean {
  return (
    dominates(xClock, yClock) &&
    get(xClock, yProducer.device_id) >= yProducer.local_seq
  );
}

export function causallyBefore(
  earlier: { clock: VectorClock; device_id: string; local_seq: number },
  later: { clock: VectorClock; device_id: string; local_seq: number },
): boolean {
  return (
    sameOrDescendant(later.clock, later, earlier.clock, earlier) &&
    !equalClocks(later.clock, earlier.clock)
  );
}

/** Neither dominates the other -> conflict candidate (DC-02 §3). Symmetric. */
export function concurrent(a: VectorClock, b: VectorClock): boolean {
  return !dominates(a, b) && !dominates(b, a);
}

/** Element-wise max merge. Commutative, associative, idempotent. New object. */
export function merge(a: VectorClock, b: VectorClock): VectorClock {
  const out: VectorClock = { ...a };
  for (const [d, s] of Object.entries(b)) {
    out[d] = Math.max(get(out, d), s);
  }
  return out;
}

/**
 * Element-wise max into target (mutation allowed here — this models the
 * persistent device_clock advancement at DC-02 §4.2/§4.3).
 */
export function advanceByMerge(target: VectorClock, incoming: VectorClock): void {
  for (const [d, s] of Object.entries(incoming)) {
    target[d] = Math.max(get(target, d), s);
  }
}
