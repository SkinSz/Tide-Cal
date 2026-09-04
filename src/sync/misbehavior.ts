// Tide TD-006 / DC-16: two-tier peer misbehavior handling.
//
// TIER 1 (soft, self-clearing, IN-MEMORY, fails OPEN on restart):
//   per-producer rolling-window tracking of invalid records fed ONLY by
//   validation rejections reaching the quarantine branch
//   (stats.receivedQuarantined). NOT transport errors; NOT
//   snapshot-delivered records (DC-16 §2.5 exemption). Ladder (DC-16 §3):
//     Level 0 observe -> 1 warn (UI only) -> 2 throttle (intake drop with
//     exponential backoff, requests still answered, one aggregated drop
//     counter) -> 3 suspend (session-scoped). NO auto-escalation to 4:
//     a Level-4 recommendation is computed and stored for UI display only;
//     unpair always goes through the existing DC-10 flow.
//
// TIER 2 (hard, durable, NOT self-clearing): > tier2Count (5,000) invalid
//   from one producer in any rolling window (ratio-independent, evaluated
//   on ARRIVAL so bursts trip mid-burst). The durable hard_blocks row is
//   written by the onHardBlock callback (wired to the DB in sync_engine).
//   While hard-blocked the engine drops intake BEFORE validation; only an
//   explicit user Unblock or unpair/revocation clears it.
//
// Window/thresholds ship as config (DC-16 D6) with the §2.4 defaults.

export interface MisbehaviorConfig {
  /** Rolling evaluation window (DC-13 sweep_minutes frame). */
  windowMs: number;
  /** Tier-1 soft ceiling: invalid COUNT that must be EXCEEDED. */
  tier1Count: number;
  /** Tier-1 ratio that must be EXCEEDED (invalid / total received). */
  tier1Ratio: number;
  /** Tier-2 hard trigger: invalid COUNT that must be EXCEEDED. */
  tier2Count: number;
  /** Level-2 throttle backoff base (exponential doubling starts here). */
  throttleBaseMs: number;
  /** Level-2 throttle backoff cap. */
  throttleCapMs: number;
}

/** DC-16 §2.4 defaults (D6): 10-min window, >500 @ >50%, >5,000 hard. */
export const DEFAULT_MISBEHAVIOR_CONFIG: MisbehaviorConfig = {
  windowMs: 10 * 60 * 1000,
  tier1Count: 500,
  tier1Ratio: 0.5,
  tier2Count: 5000,
  throttleBaseMs: 30 * 1000,
  throttleCapMs: 10 * 60 * 1000,
};

export type LadderLevel = 0 | 1 | 2 | 3;

export const LADDER_LABELS: Record<LadderLevel, string> = {
  0: "observe",
  1: "warn",
  2: "throttle",
  3: "suspend",
};

/** Per-producer Tier-1 bookkeeping snapshot (for UI + tests). */
export interface PeerTier1State {
  device_id: string;
  level: LadderLevel;
  /** DC-16 §3 L4: recommendation only — NEVER auto-executed (D7). */
  recommend_unpair: boolean;
  /** Invalid count in the current window. */
  window_invalid: number;
  /** Total records received in the current window. */
  window_total: number;
  /** window_invalid / window_total (0 when nothing received). */
  window_ratio: number;
  /** Aggregated "N dropped while throttled" counter (§3 Level 2). */
  dropped_while_throttled: number;
  /** When the current level was entered (epoch ms; 0 when Level 0). */
  level_since_ms: number;
  /** While > now, that producer's intake is dropped (Level 2 backoff). */
  backoff_until_ms: number;
}

interface PeerBook {
  level: LadderLevel;
  levelSinceMs: number;
  backoffUntilMs: number;
  backoffMs: number;
  droppedWhileThrottled: number;
  recommendUnpair: boolean;
  /** kind: "ok" | "invalid" (validation rejection) | "dropped" (intake). */
  events: Array<{ t: number; kind: "ok" | "invalid" | "dropped" }>;
}

function freshBook(): PeerBook {
  return {
    level: 0,
    levelSinceMs: 0,
    backoffUntilMs: 0,
    backoffMs: 0,
    droppedWhileThrottled: 0,
    recommendUnpair: false,
    events: [],
  };
}

/**
 * In-memory Tier-1 tracker. Holds NO durable state — a restart constructs a
 * fresh instance and every peer is back at Level 0 (DC-16 §2.3 fail-open).
 * Tier-2 detection runs here but the durable row write goes through the
 * `onHardBlock` callback so this module stays storage-agnostic.
 */
export class PeerMisbehaviorTracker {
  private readonly books = new Map<string, PeerBook>();

  constructor(
    private readonly cfg: MisbehaviorConfig = DEFAULT_MISBEHAVIOR_CONFIG,
    private readonly now: () => number = Date.now,
    /** Durable Tier-2 write hook (sync_engine wires this to hard_blocks). */
    public onHardBlock?: (producerDeviceId: string) => void,
  ) {}

  // ------------------------------------------------------------------
  // Intake gate (called by sync_engine BEFORE validation/parsing)
  // ------------------------------------------------------------------

  /** True while that producer's incoming records must be dropped at intake. */
  isIntakeDropped(producer: string): boolean {
    const b = this.books.get(producer);
    if (b === undefined) return false;
    if (b.level === 3) return true; // suspend: session-scoped
    return b.level === 2 && this.now() < b.backoffUntilMs;
  }

  /**
   * Count one record dropped at intake while throttled (Level 2). One
   * aggregated counter — never a per-packet quarantine row, skip entry, or
   * UI entry (DC-16 §3 Level 2). Dropped arrivals still count toward the
   * Tier-2 flood window: a peer already at throttle level that keeps
   * sending is presumptively flooding, so a line-rate burst trips the hard
   * block mid-burst even though nothing further is validated.
   */
  recordDropped(producer: string): number {
    const b = this.bookFor(producer);
    b.droppedWhileThrottled++;
    b.events.push({ t: this.now(), kind: "dropped" });
    this.evaluate(producer, b, "dropped");
    return b.droppedWhileThrottled;
  }

  // ------------------------------------------------------------------
  // Outcome feed (called by sync_engine per applied-batch record)
  // ------------------------------------------------------------------

  /** A validation rejection reached the quarantine branch. */
  recordInvalid(producer: string): void {
    const b = this.bookFor(producer);
    b.events.push({ t: this.now(), kind: "invalid" });
    this.evaluate(producer, b, "invalid");
  }

  /** A record was processed without a validation rejection. */
  recordOk(producer: string): void {
    const b = this.bookFor(producer);
    b.events.push({ t: this.now(), kind: "ok" });
    this.evaluate(producer, b, "ok");
  }

  // ------------------------------------------------------------------
  // §4.2 manual override — one click, no confirmation, no restart
  // ------------------------------------------------------------------

  resetPeer(producer: string): void {
    this.books.set(producer, freshBook());
  }

  getState(producer: string): PeerTier1State {
    return this.snapshot(producer, this.bookFor(producer));
  }

  /** All producers with any recorded bookkeeping (may include Level 0). */
  knownPeers(): string[] {
    return Array.from(this.books.keys()).sort();
  }

  // ------------------------------------------------------------------
  // internals
  // ------------------------------------------------------------------

  private bookFor(producer: string): PeerBook {
    let b = this.books.get(producer);
    if (b === undefined) {
      b = freshBook();
      this.books.set(producer, b);
    }
    return b;
  }

  private snapshot(producer: string, b: PeerBook): PeerTier1State {
    const w = this.windowCounts(b);
    return {
      device_id: producer,
      level: b.level,
      recommend_unpair: b.recommendUnpair,
      window_invalid: w.invalid,
      window_total: w.total,
      window_ratio: w.total === 0 ? 0 : w.invalid / w.total,
      dropped_while_throttled: b.droppedWhileThrottled,
      level_since_ms: b.levelSinceMs,
      backoff_until_ms: b.backoffUntilMs,
    };
  }

  /** Prune to the window and count. Tier-2 flood count = invalid + dropped. */
  private windowCounts(b: PeerBook): {
    invalid: number;
    dropped: number;
    total: number;
  } {
    const cutoff = this.now() - this.cfg.windowMs;
    b.events = b.events.filter((e) => e.t > cutoff);
    let invalid = 0;
    let dropped = 0;
    for (const e of b.events) {
      if (e.kind === "invalid") invalid++;
      else if (e.kind === "dropped") dropped++;
    }
    return { invalid, dropped, total: b.events.length };
  }

  /**
   * Arrival-time evaluation (DC-16 §2.4: bursts trip mid-burst — this runs
   * on EVERY recorded event, never on a timer).
   */
  private evaluate(
    producer: string,
    b: PeerBook,
    trigger: "ok" | "invalid" | "dropped",
  ): void {
    const now = this.now();
    const w = this.windowCounts(b);

    // --- Tier 2: hard block, ratio-independent, from ANY ladder level ---
    if (w.invalid + w.dropped > this.cfg.tier2Count) {
      this.onHardBlock?.(producer);
      return; // intake now drops everything; no further ladder bookkeeping
    }

    // --- De-escalation is always faster than escalation (§3.1) ---
    if (w.invalid === 0 && w.dropped === 0 && b.level > 0) {
      // Clean window: fully recover to Level 0 (§3 Level 2 "resets to the
      // lowest level on a window with no invalid records").
      b.level = 0;
      b.levelSinceMs = 0;
      b.backoffUntilMs = 0;
      b.backoffMs = 0;
      b.recommendUnpair = false;
      return;
    }

    // --- Tier 1 breach: invalid count EXCEEDS ceiling AND ratio EXCEEDS 50%.
    // Escalates ONLY on a fresh invalid ARRIVAL — re-evaluating the same
    // window events on unrelated traffic must not climb the ladder. ---
    const ratio = w.total === 0 ? 0 : w.invalid / w.total;
    if (
      trigger === "invalid" &&
      w.invalid > this.cfg.tier1Count &&
      ratio > this.cfg.tier1Ratio
    ) {
      if (b.level < 3) {
        // Gradual: never skip more than one level per sustained signal.
        b.level = (b.level + 1) as LadderLevel;
        b.levelSinceMs = now;
        if (b.level === 2) {
          b.backoffMs = this.cfg.throttleBaseMs;
          b.backoffUntilMs = now + b.backoffMs;
        }
      }
    }

    // --- Level-4 RECOMMENDATION (D7): computed + stored for UI display,
    //     never executed. Sustained suspend (a full window at Level 3). ---
    if (b.level === 3 && now - b.levelSinceMs >= this.cfg.windowMs) {
      b.recommendUnpair = true;
    }
  }
}
