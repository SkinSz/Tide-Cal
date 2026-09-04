// Tide DC-09 §3: Full-state synchronization TRIGGER LAYER — the deterministic
// decision machinery for WHEN a FULL_STATE_OFFER is emitted (fixes review
// finding M-7). Pure logic, no I/O:
//
//   Trigger A (§3.1)  GAP_ROUND_LIMIT = 2 consecutive unservable gap rounds
//                     against the same peer/direction -> offer.
//   Trigger B (§3.2)  USER_INITIATED always offers, bypassing all dedup.
//   Trigger C (§3.3)  computeIncrementalCost > MAX_INCREMENTAL_BACKLOG
//                     (default 1,000; USER-ADJUSTABLE setting per owner
//                     amendment, bounds [100, 100,000], clamped outside).
//   Race (§7.3)       resolveOfferRace: higher device_id string wins,
//                     deterministic both directions.
//   Dedup (§3.5)      at most ONE automatic outgoing offer per
//                       offer_session_key = local|remote|direction
//                     per session; session end clears it.
//
// Injectable clock keeps the tracker pure and testable.

import type { SeqRange } from "./knowledge_state.ts";

// ---------------------------------------------------------------------------
// Normative constants (DC-09 §2)
// ---------------------------------------------------------------------------

/** DC-09 §3.1 / TR-1: two consecutive failed rounds gate Trigger A. */
export const GAP_ROUND_LIMIT = 2;

/**
 * DC-09 §2 (owner amendment 2026-08-25): default backlog bound lowered from
 * 10,000 to 1,000 records; exposed as a user-adjustable setting.
 */
export const DEFAULT_MAX_INCREMENTAL_BACKLOG = 1000;

/** Setting bounds (DC-09 §2): values outside are clamped/rejected. */
export const MIN_MAX_INCREMENTAL_BACKLOG = 100;
export const MAX_MAX_INCREMENTAL_BACKLOG = 100_000;

export function clampMaxIncrementalBacklog(value: number): number {
  return Math.min(
    MAX_MAX_INCREMENTAL_BACKLOG,
    Math.max(MIN_MAX_INCREMENTAL_BACKLOG, value),
  );
}

export type OfferDirection = "INCOMING" | "OUTGOING";

/** The four triggers of DC-09 §3 (naming follows the summary table). */
export type OfferTriggerKind =
  | "GAP_ROUNDS" // Trigger A
  | "USER_INITIATED" // Trigger B
  | "BACKLOG" // Trigger C
  | "PROVABLE_STALENESS"; // Trigger D

/** Needed-range shape (alias of knowledge_state.SeqRange for readability). */
export type NeededRange = SeqRange;

/**
 * Optional per-producer retention metadata refining the cost estimate to
 * DC-09 §3.3's "count only records we could actually serve": ranges below
 * retained_lo(D) or above max_local_seq(D) contribute nothing. When omitted,
 * the estimate is simply the total record count of the given ranges.
 */
export interface ProducerRetentionInfo {
  /** producer device_id -> highest local_seq still held (max_local_seq(D)) */
  maxLocalSeq?: Record<string, number>;
  /** producer device_id -> lowest retained seq (retained_lo(D), default 1) */
  retainedLo?: Record<string, number>;
}

/**
 * DC-09 §3.3 computeIncrementalCost — integer, conservative, deterministic:
 * same ranges + retention info => same value. Default form (no retention
 * info) counts every record in every range inclusively.
 */
export function computeIncrementalCost(
  needed: readonly NeededRange[],
  info?: ProducerRetentionInfo,
): number {
  let total = 0;
  for (const r of needed) {
    const cap = info?.maxLocalSeq?.[r.device_id];
    const hi = cap === undefined ? r.hi : Math.min(cap, r.hi);
    if (hi < r.lo) continue;
    const floor = info?.retainedLo?.[r.device_id];
    const lo = floor === undefined ? r.lo : Math.max(floor, r.lo);
    if (hi < lo) continue;
    total += hi - lo + 1;
  }
  return total;
}

// ---------------------------------------------------------------------------
// TriggerStateTracker (DC-09 §3.1/§3.3 bookkeeping; pure, injectable clock)
// ---------------------------------------------------------------------------

export interface TriggerTrackerOptions {
  /** injectable clock (default Date.now); stamps streak activity only */
  now?: () => number;
  /** override GAP_ROUND_LIMIT (tests only; normative value is 2) */
  gapRoundLimit?: number;
}

export class TriggerStateTracker {
  private readonly streaks = new Map<string, number>();
  private readonly lastGapRoundAt = new Map<string, number>();
  private readonly now: () => number;
  private readonly limit: number;

  constructor(options: TriggerTrackerOptions = {}) {
    this.now = options.now ?? Date.now;
    this.limit = options.gapRoundLimit ?? GAP_ROUND_LIMIT;
  }

  private key(peerId: string, direction: OfferDirection): string {
    return `${direction}|${peerId}`;
  }

  /**
   * Record one failed (unservable) round against peer/direction; returns the
   * new consecutive-streak length (DC-09 §3.1 pseudocode: streak += 1).
   */
  recordGapRound(peerId: string, direction: OfferDirection = "OUTGOING"): number {
    const k = this.key(peerId, direction);
    const streak = (this.streaks.get(k) ?? 0) + 1;
    this.streaks.set(k, streak);
    this.lastGapRoundAt.set(k, this.now());
    return streak;
  }

  /**
   * Reset the streak after a servable outcome (DC-09 §3.1: any round with a
   * servable outcome resets; also used at session start).
   */
  resetStreak(peerId: string, direction: OfferDirection = "OUTGOING"): void {
    const k = this.key(peerId, direction);
    this.streaks.set(k, 0);
    this.lastGapRoundAt.set(k, this.now());
  }

  /** Current consecutive unservable-round streak for peer/direction. */
  streak(peerId: string, direction: OfferDirection = "OUTGOING"): number {
    return this.streaks.get(this.key(peerId, direction)) ?? 0;
  }

  /** Timestamp of last recorded/reset round (diagnostics; injectable clock). */
  lastActivityAt(peerId: string, direction: OfferDirection = "OUTGOING"): number | undefined {
    return this.lastGapRoundAt.get(this.key(peerId, direction));
  }

  /** DC-09 §3.1 Trigger A gate: streak >= GAP_ROUND_LIMIT. Non-consuming. */
  shouldOfferTriggerA(peerId: string, direction: OfferDirection = "OUTGOING"): boolean {
    return this.streak(peerId, direction) >= this.limit;
  }

  /** Convenience passthrough to the module-level cost estimator. */
  computeIncrementalCost(needed: readonly NeededRange[], info?: ProducerRetentionInfo): number {
    return computeIncrementalCost(needed, info);
  }

  /**
   * DC-09 §3.3 Trigger C gate: strictly greater-than (TR-3 boundary: exactly
   * MAX_INCREMENTAL_BACKLOG stays incremental). maxBacklog is the
   * user-adjustable setting value, clamped into [100, 100,000].
   */
  shouldOfferTriggerC(cost: number, maxBacklog = DEFAULT_MAX_INCREMENTAL_BACKLOG): boolean {
    return cost > clampMaxIncrementalBacklog(maxBacklog);
  }
}

// ---------------------------------------------------------------------------
// OfferDedup (DC-09 §3.5)
// ---------------------------------------------------------------------------

/**
 * DC-09 §2: offer_session_key := (local_device_id, remote_device_id,
 * direction). Deterministic, collision-free under the '|' separator because
 * device ids never contain '|'.
 */
export function offerSessionKey(
  localDeviceId: string,
  remoteDeviceId: string,
  direction: OfferDirection,
): string {
  return `${localDeviceId}|${remoteDeviceId}|${direction}`;
}

/**
 * Once-per-session-per-direction outgoing-offer bookkeeping (DC-09 §3.5):
 * in-memory only; a fresh instance represents a fresh session.
 * USER_INITIATED (Trigger B) ALWAYS bypasses, even after an offer was made
 * or declined (TR-2).
 */
export class OfferDedup {
  private readonly offered = new Set<string>();

  shouldOffer(key: string, trigger: OfferTriggerKind): boolean {
    if (trigger === "USER_INITIATED") return true; // §3.5: Trigger B bypasses
    return !this.offered.has(key);
  }

  markOffered(key: string): void {
    this.offered.add(key);
  }

  hasOffered(key: string): boolean {
    return this.offered.has(key);
  }

  /** Session end clears dedup state (§3.5); next session re-evaluates. */
  reset(): void {
    this.offered.clear();
  }
}

// ---------------------------------------------------------------------------
// Simultaneous-offer race resolution (DC-09 §7.3)
// ---------------------------------------------------------------------------

/**
 * Deterministic, deadlock-free resolution of simultaneous offers between the
 * same pair: the side with the HIGHER device_id string wins and proceeds with
 * its own offer (declining the peer's silently); the lower side defers and
 * ACCEPTs the winner's offer. Both sides compute the identical outcome.
 *
 * @returns true when MY offer proceeds (I won); false when I must defer and
 *          accept the peer's offer.
 */
export function resolveOfferRace(myDeviceId: string, peerDeviceId: string): boolean {
  return myDeviceId > peerDeviceId;
}
