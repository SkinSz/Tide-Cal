// Tide DC-13 scheduler tests — pure logic against an injected fake clock.
// No real timers anywhere (mirrors the module's own constraint).

import { describe, expect, it } from "vitest";
import {
  BACKOFF_BASE_MS,
  BACKOFF_MAX_MS,
  Scheduler,
  type SchedulerSettings,
} from "../src/application/scheduler.ts";

/** Deterministic manual clock (ms). */
function makeClock(startMs = 1_000_000) {
  let t = startMs;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
    set: (ms: number) => {
      t = ms;
    },
    get time() {
      return t;
    },
  };
}

function makeScheduler(
  clock = makeClock(),
  settings?: Partial<SchedulerSettings>,
): { scheduler: Scheduler; clock: ReturnType<typeof makeClock> } {
  return { scheduler: new Scheduler({ now: clock.now, settings }), clock };
}

describe("DC-13 §3.1 debounce trigger", () => {
  it("fires exactly once after N rapid changes within one window", () => {
    const { scheduler, clock } = makeScheduler();

    // N=10 rapid edits, all inside a single debounce window.
    let decision = scheduler.onLocalChange();
    for (let i = 0; i < 9; i++) {
      clock.advance(500);
      decision = scheduler.onLocalChange();
    }

    expect(decision.shouldScheduleDebounce).toBe(true);
    const fireAt = decision.fireAtMs;
    expect(fireAt).toBe(clock.time + 10_000);

    // The armed deadline is unaffected by time passing alone.
    clock.advance(9_000);
    expect(scheduler.getDebounceFireAtMs()).toBe(fireAt);

    clock.advance(1_000); // reach fireAtMs
    expect(scheduler.onDebounceFired(["p1"])).toEqual({ action: "push", peers: ["p1"] });

    // Second fire in the same window coalesces to nothing (TR-3: ONE session).
    expect(scheduler.onDebounceFired(["p1"])).toEqual({ action: "noop" });
  });

  it("restarts the timer on every change (debounce, not throttle)", () => {
    const { scheduler, clock } = makeScheduler();

    scheduler.onLocalChange();
    const firstFireAt = clock.time + 10_000;
    expect(scheduler.getDebounceFireAtMs()).toBe(firstFireAt);

    clock.advance(9_000); // 1s before the original deadline
    scheduler.onLocalChange(); // restart
    expect(scheduler.getDebounceFireAtMs()).toBe(clock.time + 10_000);
    expect(scheduler.getDebounceFireAtMs()).not.toBe(firstFireAt);

    clock.advance(9_500); // still 0.5s short of the RESTARTED deadline
    expect(scheduler.getDebounceFireAtMs()).toBe(clock.time + 500);

    clock.advance(500);
    expect(scheduler.onDebounceFired(["p1"]).action).toBe("push");
  });

  it("uses the configured debounceSeconds for fireAtMs", () => {
    const { scheduler, clock } = makeScheduler(makeClock(), { debounceSeconds: 60 });
    const decision = scheduler.onLocalChange();
    expect(decision.fireAtMs).toBe(clock.time + 60 * 1000);
  });
});

describe("DC-13 §3.1/§3.2 immediate triggers", () => {
  it("startup produces an immediate-sync decision", () => {
    const { scheduler } = makeScheduler();
    expect(scheduler.onStartup()).toEqual({ action: "immediate-sync" });
  });

  it("network change produces an immediate-sync decision", () => {
    const { scheduler } = makeScheduler();
    expect(scheduler.onNetworkChange()).toEqual({ action: "immediate-sync" });
  });

  it("sweep tick produces a sweep decision", () => {
    const { scheduler } = makeScheduler();
    expect(scheduler.onSweepTick()).toEqual({ action: "sweep" });
  });
});

describe("DC-13 §4.1 one-session-per-peer lock", () => {
  it("second beginSession for the same peer returns false until endSession", () => {
    const { scheduler } = makeScheduler();

    expect(scheduler.tryBeginSession("peer-a")).toBe(true);
    expect(scheduler.isActive("peer-a")).toBe(true);

    // Racing triggers toward the same peer coalesce into a no-op (§4.1).
    expect(scheduler.tryBeginSession("peer-a")).toBe(false);
    expect(scheduler.activeSessionCount).toBe(1);

    scheduler.endSession("peer-a", true);
    expect(scheduler.isActive("peer-a")).toBe(false);
    expect(scheduler.tryBeginSession("peer-a")).toBe(true);
  });
});

describe("DC-13 §4.2 cross-peer concurrency bound", () => {
  it("respects the cap across different peers and frees slots on endSession", () => {
    const { scheduler } = makeScheduler();
    expect(scheduler.canStartSession()).toBe(true);

    expect(scheduler.tryBeginSession("p1")).toBe(true);
    expect(scheduler.tryBeginSession("p2")).toBe(true);
    expect(scheduler.tryBeginSession("p3")).toBe(true); // default cap = 3

    expect(scheduler.canStartSession()).toBe(false);
    expect(scheduler.tryBeginSession("p4")).toBe(false);
    expect(scheduler.tryBeginSession("p5")).toBe(false);
    expect(scheduler.activeSessionCount).toBe(3);

    scheduler.endSession("p2", true);
    expect(scheduler.canStartSession()).toBe(true);
    expect(scheduler.tryBeginSession("p4")).toBe(true);
  });

  it("live maxConcurrentSessions update takes effect immediately", () => {
    const { scheduler } = makeScheduler();
    scheduler.updateSettings({ maxConcurrentSessions: 2 });

    expect(scheduler.tryBeginSession("p1")).toBe(true);
    expect(scheduler.tryBeginSession("p2")).toBe(true);
    expect(scheduler.tryBeginSession("p3")).toBe(false);

    scheduler.updateSettings({ maxConcurrentSessions: 4 });
    expect(scheduler.tryBeginSession("p3")).toBe(true);
    expect(scheduler.tryBeginSession("p4")).toBe(true);
    expect(scheduler.tryBeginSession("p5")).toBe(false);
  });
});

describe("DC-13 §6.1 exponential backoff", () => {
  it("doubles 1m -> 2m -> 4m ... and caps at 1h", () => {
    const { scheduler, clock } = makeScheduler();

    let expectedDelay = BACKOFF_BASE_MS;
    for (let failureNo = 1; failureNo <= 8; failureNo++) {
      expect(scheduler.tryBeginSession("phone")).toBe(true);
      scheduler.endSession("phone", false);

      expect(scheduler.nextAttemptAllowedAt("phone")).toBe(clock.time + expectedDelay);

      // Automatic triggers skip the peer during backoff...
      expect(scheduler.isBackoffActive("phone")).toBe(true);
      expect(scheduler.tryBeginSession("phone")).toBe(false);

      // ...but time passing beyond the window re-allows attempts.
      clock.advance(expectedDelay + 1);
      expect(scheduler.isBackoffActive("phone")).toBe(false);

      expectedDelay = Math.min(expectedDelay * 2, BACKOFF_MAX_MS);
    }
    // After enough failures the gap stays pinned at the 1h maximum.
    expect(expectedDelay).toBe(BACKOFF_MAX_MS);
  });

  it("a successful session resets backoff to base", () => {
    const { scheduler, clock } = makeScheduler();

    scheduler.tryBeginSession("p");
    scheduler.endSession("p", false);
    expect(scheduler.nextAttemptAllowedAt("p")).toBe(clock.time + BACKOFF_BASE_MS);

    clock.advance(BACKOFF_BASE_MS + 1);
    scheduler.tryBeginSession("p");
    scheduler.endSession("p", true); // success resets (§6.1)
    expect(scheduler.nextAttemptAllowedAt("p")).toBe(0);

    // Next failure starts over at base, not at the doubled delay.
    scheduler.tryBeginSession("p");
    scheduler.endSession("p", false);
    expect(scheduler.nextAttemptAllowedAt("p")).toBe(clock.time + BACKOFF_BASE_MS);
  });

  it("recordSuccess resets without needing a session cycle", () => {
    const { scheduler, clock } = makeScheduler();
    scheduler.tryBeginSession("p");
    scheduler.endSession("p", false);
    scheduler.recordSuccess("p");
    expect(scheduler.nextAttemptAllowedAt("p")).toBe(0);
    expect(scheduler.tryBeginSession("p")).toBe(true);
    void clock;
  });

  it("manual sync bypasses backoff; automatic does not", () => {
    const { scheduler } = makeScheduler();

    scheduler.tryBeginSession("p");
    scheduler.endSession("p", false); // peer now in backoff

    expect(scheduler.isBackoffActive("p")).toBe(true);
    expect(scheduler.tryBeginSession("p")).toBe(false); // automatic skipped

    // Manual "sync now": explicit human intent wins (§6.1).
    expect(scheduler.tryBeginSession("p", { manualSyncBypassesBackoff: true })).toBe(true);
    scheduler.endSession("p", true);
    expect(scheduler.isBackoffActive("p")).toBe(false);
  });

  it("backoff skips ineligible peers from push decisions but keeps eligible ones", () => {
    const { scheduler } = makeScheduler();
    scheduler.onLocalChange(); // dirty: a debounced push is pending
    scheduler.tryBeginSession("offline");
    scheduler.endSession("offline", false); // in backoff
    scheduler.tryBeginSession("busy");
    // "busy" has an active session -> coalesced out of the push too.

    const decision = scheduler.onDebounceFired(["offline", "busy", "healthy"]);
    expect(decision).toEqual({ action: "push", peers: ["healthy"] });
  });
});

describe("DC-13 §3.5 settings clamping and live effect", () => {
  it("constructor settings clamp to contract bounds", () => {
    const low = new Scheduler({
      now: () => 0,
      settings: { debounceSeconds: 0, sweepMinutes: 0, maxConcurrentSessions: 0 },
    });
    expect(low.getSettings().debounceSeconds).toBe(1);
    expect(low.getSettings().sweepMinutes).toBe(5);
    expect(low.getSettings().maxConcurrentSessions).toBe(1);

    const high = new Scheduler({
      now: () => 0,
      settings: { debounceSeconds: 9999, sweepMinutes: 5000, maxConcurrentSessions: 100 },
    });
    expect(high.getSettings().debounceSeconds).toBe(300);
    expect(high.getSettings().sweepMinutes).toBe(1440);
    expect(high.getSettings().maxConcurrentSessions).toBe(10);
  });

  it("unset constructor fields fall back to owner-tuned defaults (§3.1)", () => {
    const { scheduler } = makeScheduler();
    expect(scheduler.getSettings()).toEqual({
      debounceSeconds: 10,
      sweepMinutes: 10,
      maxConcurrentSessions: 3,
    });
  });

  it("updateSettings clamps and takes effect live without restart (TR-9)", () => {
    const { scheduler, clock } = makeScheduler();

    scheduler.updateSettings({ debounceSeconds: 0 });
    expect(scheduler.getSettings().debounceSeconds).toBe(1);

    scheduler.updateSettings({ sweepMinutes: 5000 });
    expect(scheduler.getSettings().sweepMinutes).toBe(1440);

    scheduler.updateSettings({ debounceSeconds: -50, maxConcurrentSessions: 42 });
    expect(scheduler.getSettings().debounceSeconds).toBe(1);
    expect(scheduler.getSettings().maxConcurrentSessions).toBe(10);

    // Live effect on subsequent decisions:
    scheduler.updateSettings({ debounceSeconds: 45 });
    const decision = scheduler.onLocalChange();
    expect(decision.fireAtMs).toBe(clock.time + 45_000);
  });

  it("partial update leaves other fields untouched", () => {
    const { scheduler } = makeScheduler();
    scheduler.updateSettings({ sweepMinutes: 30 });
    expect(scheduler.getSettings()).toEqual({
      debounceSeconds: 10,
      sweepMinutes: 30,
      maxConcurrentSessions: 3,
    });
  });
});
