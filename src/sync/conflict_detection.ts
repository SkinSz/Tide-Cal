// Tide DC-03: Scalar conflict detection + conflict records.
// Pure decision logic per APPROVED contract DC-03 (v2: §3.2a). The caller owns storage.

import type { ChangeRecord, VectorClock } from "./change_record.ts";
import { concurrent, sameOrDescendant, equalClocks } from "./vector_clock.ts";

export type ConflictStatus =
  | "unresolved"
  | "resolved_keep_local"
  | "resolved_keep_incoming"
  | "resolved_custom"
  | "obsolete"; // DC-14 §7.1 device-local terminal state

export interface ConflictParticipant {
  change_id: string;
  device_id: string;
  local_seq: number;
  causality_clock: VectorClock;
  payload: ChangeRecord["payload"];
}

export interface ConflictRecord {
  conflict_id: string; // UUIDv4 at creation (caller supplies)
  entity_id: string;
  field_path: string;
  participants: ConflictParticipant[];
  detected_at_hlc: number;
  status: ConflictStatus;
  resolved_value?: unknown;
  resolved_at_hlc?: number;
}

/** Deep structural equality of JSON values; DELETED === DELETED. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) {
    return false;
  }
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  return ka.every(
    (k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
  );
}

export function effectiveValue(c: ChangeRecord): { deleted: boolean; value: unknown } {
  switch (c.operation) {
    case "set":
      return { deleted: false, value: (c.payload as { value: unknown }).value };
    case "remove":
      return { deleted: true, value: undefined };
    case "member_add":
    case "member_update":
      return { deleted: false, value: c.payload };
    case "member_remove":
      return { deleted: true, value: undefined };
  }
}

export function valuesDiffer(a: ChangeRecord, b: ChangeRecord): boolean {
  const va = effectiveValue(a);
  const vb = effectiveValue(b);
  if (va.deleted !== vb.deleted) return true;
  return !deepEqual(va.value, vb.value);
}

export type DetectionOutcome =
  | { kind: "noop" } // identical-value convergence (DC-03 §3.1)
  | { kind: "apply" } // causally-after or no concurrent differing pair
  | { kind: "stale" } // §3.2a: causally dominated by a local participant — history only
  | { kind: "conflict"; conflicting: ChangeRecord[] }; // DC-03 §3.3

/**
 * DC-03 §3 detection algorithm.
 * @param incoming C — the change being applied
 * @param localCurrent current effective local value for this conflict entity
 * @param locals already-applied, un-compacted changes touching the SAME
 *        conflict entity (caller filters by (entity_id, field_path))
 */
export function detect(
  incoming: ChangeRecord,
  localCurrent: { deleted: boolean; value: unknown },
  locals: ChangeRecord[],
): DetectionOutcome {
  const v = effectiveValue(incoming);

  // Rule 3.1: identical-value convergence first (idempotent no-op)
  if (
    (v.deleted && localCurrent.deleted) ||
    (!v.deleted && !localCurrent.deleted && deepEqual(v.value, localCurrent.value))
  ) {
    return { kind: "noop" };
  }

  // Rule 3.2a (v2): STALE CAUSAL-BEFORE = history only. If any local
  // participant dominates C's knowledge (C is causally before it), C is
  // superseded knowledge and MUST NOT regress the materialized row. Stored
  // in history + clocks merged by the caller; no conflict record (there is
  // no concurrent divergence to preserve). Mutually exclusive with §3.3:
  // concurrent(C, L) and causallyBefore(C, L) cannot both hold (DC-02 §3).
  const dominated = locals.some((l) =>
    sameOrDescendant(
      l.causality_clock,
      { device_id: l.device_id, local_seq: l.local_seq },
      incoming.causality_clock,
      { device_id: incoming.device_id, local_seq: incoming.local_seq },
    ) && !equalClocks(l.causality_clock, incoming.causality_clock),
  );
  if (dominated) {
    return { kind: "stale" };
  }

  // Rule 3.2/§3.3: concurrency check against un-compacted participants
  const conflicting = locals.filter((l) => concurrent(incoming.causality_clock, l.causality_clock));
  if (conflicting.length === 0) {
    return { kind: "apply" };
  }
  const differing = conflicting.filter((l) => valuesDiffer(incoming, l));
  if (differing.length === 0) {
    return { kind: "apply" };
  }
  return { kind: "conflict", conflicting: differing };
}
