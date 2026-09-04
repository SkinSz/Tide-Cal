// Tide DC-13 sync scheduler — PURE decision logic (contract §3–§6).
//
// No real timers, no I/O, no network: every method is synchronous and the
// module only decides WHEN things should happen. A thin runtime wrapper
// (later milestone) owns the actual setTimeout/setInterval and translates
// these decisions into real sync sessions.
//
// Contract references:
//   §3.1 trigger catalog & owner-tuned defaults (debounce 10s, sweep 10min)
//   §3.5 settings bounds, live effect
//   §4.1 one session per peer pair (keyed by remote device_id)
//   §4.2 cross-peer concurrency bound (default 3)
//   §6.1 exponential backoff: base 1min, factor 2, cap 1h, reset on success
//   §6.2 backoff state is in-memory only

export const DEBOUNCE_SECONDS_DEFAULT = 10;
export const DEBOUNCE_SECONDS_MIN = 1;
export const DEBOUNCE_SECONDS_MAX = 300;

export const SWEEP_MINUTES_DEFAULT = 10;
export const SWEEP_MINUTES_MIN = 5;
export const SWEEP_MINUTES_MAX = 1440;

export const MAX_CONCURRENT_SESSIONS_DEFAULT = 3;
export const MAX_CONCURRENT_SESSIONS_MIN = 1;
export const MAX_CONCURRENT_SESSIONS_MAX = 10;

/** DC-13 §6.1 fixed algorithm constants (NOT user settings). */
export const BACKOFF_BASE_MS = 60_000;
export const BACKOFF_FACTOR = 2;
export const BACKOFF_MAX_MS = 3_600_000;

export interface SchedulerSettings {
  debounceSeconds: number;
  sweepMinutes: number;
  maxConcurrentSessions: number;
}

export interface SchedulerDeps {
  /** Injected clock, milliseconds. */
  now(): number;
  /** Optional initial settings; unset fields fall back to DC-13 §3.5 defaults. */
  settings?: Partial<SchedulerSettings>;
}

export interface DebounceScheduleDecision {
  shouldScheduleDebounce: true;
  /** Absolute deadline (ms, injected clock domain) the runtime should arm. */
  fireAtMs: number;
}

export type SyncDecision =
  | { action: "immediate-sync" }
  | { action: "sweep" }
  | { action: "push"; peers: string[] }
  | { action: "noop" };

export interface BeginSessionOptions {
  /**
   * Manual "sync now" intent bypasses per-peer backoff (DC-13 §6.1:
   * explicit human intent wins).
   */
  manualSyncBypassesBackoff?: boolean;
}

function clamp(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, value));
}

export class Scheduler {
  private readonly clock: () => number;

  private settingsInternal: SchedulerSettings;

  /** Pending local changes awaiting the debounced push (§3.3). */
  private dirty = false;

  /** Absolute ms deadline currently armed by the runtime, if any. */
  private debounceFireAtMs: number | null = null;

  /** Active session lock, keyed by remote peer device_id (§4.1). */
  private readonly activePeers = new Set<string>();

  /** Consecutive failure count per peer (backoff exponent, §6.1). */
  private readonly consecutiveFailures = new Map<string, number>();

  /** Earliest next automatic attempt per peer (absolute ms, §6.1). */
  private readonly nextAttemptAt = new Map<string, number>();

  constructor(deps: SchedulerDeps) {
    this.clock = deps.now;
    this.settingsInternal = {
      debounceSeconds: clamp(
        deps.settings?.debounceSeconds,
        DEBOUNCE_SECONDS_DEFAULT,
        DEBOUNCE_SECONDS_MIN,
        DEBOUNCE_SECONDS_MAX,
      ),
      sweepMinutes: clamp(
        deps.settings?.sweepMinutes,
        SWEEP_MINUTES_DEFAULT,
        SWEEP_MINUTES_MIN,
        SWEEP_MINUTES_MAX,
      ),
      maxConcurrentSessions: clamp(
        deps.settings?.maxConcurrentSessions,
        MAX_CONCURRENT_SESSIONS_DEFAULT,
        MAX_CONCURRENT_SESSIONS_MIN,
        MAX_CONCURRENT_SESSIONS_MAX,
      ),
    };
  }

  // ------------------------------------------------------------------
  // Settings (§3.5: live effect, clamped to bounds)
  // ------------------------------------------------------------------

  getSettings(): Readonly<SchedulerSettings> {
    return this.settingsInternal;
  }

  /** Applies a partial settings update immediately; values clamp to bounds. */
  updateSettings(partial: Partial<SchedulerSettings>): void {
    this.settingsInternal = {
      debounceSeconds: clamp(
        partial.debounceSeconds,
        this.settingsInternal.debounceSeconds,
        DEBOUNCE_SECONDS_MIN,
        DEBOUNCE_SECONDS_MAX,
      ),
      sweepMinutes: clamp(
        partial.sweepMinutes,
        this.settingsInternal.sweepMinutes,
        SWEEP_MINUTES_MIN,
        SWEEP_MINUTES_MAX,
      ),
      maxConcurrentSessions: clamp(
        partial.maxConcurrentSessions,
        this.settingsInternal.maxConcurrentSessions,
        MAX_CONCURRENT_SESSIONS_MIN,
        MAX_CONCURRENT_SESSIONS_MAX,
      ),
    };
  }

  // ------------------------------------------------------------------
  // Trigger events (§3.1) — pure decisions, no side effects beyond state
  // ------------------------------------------------------------------

  /**
   * Local change applied: mark dirty and (re)start the debounce window.
   * Every change restarts the timer — fires once, debounce seconds after
   * the LAST change.
   */
  onLocalChange(): DebounceScheduleDecision {
    this.dirty = true;
    this.debounceFireAtMs = this.clock() + this.settingsInternal.debounceSeconds * 1000;
    return { shouldScheduleDebounce: true, fireAtMs: this.debounceFireAtMs };
  }

  /**
   * Runtime reports the armed debounce timer expired. If changes are still
   * pending, decide a push toward the given available trusted peers,
   * skipping peers with an active session (coalesced, §4.1) or active
   * backoff (§6.1). Otherwise nothing to do.
   *
   * @param availablePeers remote peer device_ids currently known-available
   *   (from the discovery layer). Defaults to none.
   */
  onDebounceFired(availablePeers: readonly string[] = []): SyncDecision {
    this.debounceFireAtMs = null;
    if (!this.dirty) {
      return { action: "noop" };
    }
    this.dirty = false;
    const peers = availablePeers.filter((p) => this.isPeerEligible(p));
    return { action: "push", peers };
  }

  /** Application start / main-window foregrounding (§3.2): NOT debounced. */
  onStartup(): SyncDecision {
    return { action: "immediate-sync" };
  }

  /** Network change / Wi-Fi reconnect (§3.4): immediate attempt, backoff-bounded. */
  onNetworkChange(): SyncDecision {
    return { action: "immediate-sync" };
  }

  /** Periodic background sweep tick (§3.1 row 4). */
  onSweepTick(): SyncDecision {
    return { action: "sweep" };
  }

  /** Currently armed debounce deadline, or null when nothing is pending. */
  getDebounceFireAtMs(): number | null {
    return this.debounceFireAtMs;
  }

  // ------------------------------------------------------------------
  // Session tracking (§4.1 / §4.2)
  // ------------------------------------------------------------------

  /**
   * Attempts to open a sync session with the peer. Fails (returns false,
   * fully coalesced per §4.1) when:
   *   - a session with this peer is already active, OR
   *   - the peer is in automatic backoff and this is not a manual sync, OR
   *   - the cross-peer concurrency cap is reached (§4.2).
   */
  tryBeginSession(peerId: string, options: BeginSessionOptions = {}): boolean {
    if (this.activePeers.has(peerId)) {
      return false;
    }
    if (!options.manualSyncBypassesBackoff && this.isBackoffActive(peerId)) {
      return false;
    }
    if (!this.canStartSession()) {
      return false;
    }
    this.activePeers.add(peerId);
    return true;
  }

  /**
   * Closes a session. On success, backoff state resets entirely (§6.1);
   * on failure, the peer enters/exalates exponential backoff:
   * next attempt allowed at now + min(base * 2^prior_failures, 1h),
   * so the FIRST failure delays by exactly the base of 1 minute (§6.1/TR-7).
   */
  endSession(peerId: string, success: boolean): void {
    this.activePeers.delete(peerId);
    if (success) {
      this.recordSuccess(peerId);
      return;
    }
    const failures = this.consecutiveFailures.get(peerId) ?? 0;
    this.consecutiveFailures.set(peerId, failures + 1);
    // TR-7: gaps follow 1m, 2m, 4m ... => first failure delays by base,
    // i.e. delay = min(base * 2^prior_failures, 1h).
    this.nextAttemptAt.set(peerId, this.clock() + this.backoffDelayFor(failures));
  }

  /** Absolute earliest ms at which an automatic attempt to the peer may start. */
  nextAttemptAllowedAt(peerId: string): number {
    return this.nextAttemptAt.get(peerId) ?? 0;
  }

  /** True while automatic triggers must skip the peer (manual sync may not). */
  isBackoffActive(peerId: string): boolean {
    return this.clock() < this.nextAttemptAllowedAt(peerId);
  }

  /** Any successful session resets that peer's backoff to base (§6.1). */
  recordSuccess(peerId: string): void {
    this.consecutiveFailures.delete(peerId);
    this.nextAttemptAt.delete(peerId);
  }

  isActive(peerId: string): boolean {
    return this.activePeers.has(peerId);
  }

  get activeSessionCount(): number {
    return this.activePeers.size;
  }

  /** Cross-peer concurrency gate (§4.2). */
  canStartSession(): boolean {
    return this.activeSessionCount < this.settingsInternal.maxConcurrentSessions;
  }

  private backoffDelayFor(failures: number): number {
    return Math.min(BACKOFF_BASE_MS * BACKOFF_FACTOR ** failures, BACKOFF_MAX_MS);
  }

  private isPeerEligible(peerId: string): boolean {
    return !this.isActive(peerId) && !this.isBackoffActive(peerId);
  }
}
