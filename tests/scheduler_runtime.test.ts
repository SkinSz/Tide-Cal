// Tests for the DC-13 scheduler RUNTIME wrapper (src/application/
// scheduler_runtime.ts): the pure decision logic itself is covered by
// tests/scheduler.test.ts; here we verify the runtime's own behavior —
// timer translation, the standing UNWIRED-sweep constraint, session
// bookkeeping, and manualSyncBypassesBackoff semantics (DC-19 §4.2).

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { Scheduler } from "../src/application/scheduler.ts";
import {
  SchedulerRuntime,
  startSchedulerRuntime,
  type RuntimePeer,
} from "../src/application/scheduler_runtime.ts";

interface Harness {
  runtime: SchedulerRuntime;
  scheduler: Scheduler;
  opened: Array<{ deviceId: string; manual: boolean }>;
  sessions: Array<{ deviceId: string; success: boolean }>;
  logs: string[];
  clock: { now: number };
  peers: RuntimePeer[];
  setEndpoint(deviceId: string, endpoint: RuntimePeer["endpoint"]): void;
  failNext: { value: boolean };
}

function makeHarness(clockNow = 1_000_000): Harness {
  const clock = { now: clockNow };
  const scheduler = new Scheduler({ now: () => clock.now });
  const peers: RuntimePeer[] = [
    { deviceId: "peer-a", endpoint: { host: "127.0.0.1", port: 41001 } },
    { deviceId: "peer-b", endpoint: { host: "127.0.0.1", port: 41002 } },
    { deviceId: "peer-c", endpoint: null },
  ];
  const opened: Array<{ deviceId: string; manual: boolean }> = [];
  const sessions: Array<{ deviceId: string; success: boolean }> = [];
  const logs: string[] = [];
  const failNext = { value: false };
  const runtime = new SchedulerRuntime({
    scheduler,
    now: () => clock.now,
    listPeers: () => peers,
    openSession: async ({ deviceId }) => {
      opened.push({ deviceId, manual: false });
      if (failNext.value) {
        failNext.value = false;
        throw new Error("connect failed");
      }
      return true;
    },
    onSessionStart: (id) => sessions.push({ deviceId: id, success: true }),
    log: (m) => logs.push(m),
  });
  return {
    runtime,
    scheduler,
    opened,
    sessions,
    logs,
    clock,
    peers,
    setEndpoint(id, endpoint) {
      const p = peers.find((x) => x.deviceId === id);
      if (p) p.endpoint = endpoint;
    },
    failNext,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("SchedulerRuntime: sweep stays UNWIRED (standing constraint)", () => {
  it("no-ops sweep decisions with a log line and opens no session", () => {
    const h = makeHarness();
    h.runtime.consume(h.scheduler.onSweepTick(), { manual: false });
    expect(h.opened).toHaveLength(0);
    expect(
      h.logs.some((l) => l.includes("sweep") && l.includes("UNWIRED")),
    ).toBe(true);
  });

  it("the periodic sweep timer also only logs (no session attempts)", async () => {
    const h = makeHarness();
    h.runtime.start();
    // Sweep default is 10 minutes; advance well past one tick.
    await vi.advanceTimersByTimeAsync(11 * 60_000);
    h.runtime.stop();
    expect(h.opened).toHaveLength(0);
    expect(
      h.logs.filter((l) => l.includes("UNWIRED")).length,
    ).toBeGreaterThanOrEqual(1);
  });
});

describe("SchedulerRuntime: manual sync now (DC-19 §4.2 semantics)", () => {
  it("maps manualSyncNow to sessions for paired peers with endpoints, bypassing backoff", async () => {
    const h = makeHarness();
    // peer-a is in backoff — manual intent must still open a session (§6.1).
    h.scheduler.endSession("peer-a", false);
    h.runtime.manualSyncNow();
    // openSession calls are async; drain microtasks.
    await vi.advanceTimersByTimeAsync(0);
    expect(h.opened.map((o) => o.deviceId).sort()).toEqual(["peer-a", "peer-b"]);
  });

  it("automatic (non-manual) triggers respect backoff — peer is skipped", async () => {
    const h = makeHarness();
    h.scheduler.endSession("peer-a", false); // arms 1-minute backoff
    h.runtime.consume({ action: "immediate-sync" }, { manual: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.opened.map((o) => o.deviceId)).toEqual(["peer-b"]);
  });

  it("peers without a known endpoint are skipped with a log line, never dialed", async () => {
    const h = makeHarness();
    h.runtime.manualSyncNow();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.opened.some((o) => o.deviceId === "peer-c")).toBe(false);
    expect(
      h.logs.some((l) => l.includes("peer-c") && l.includes("no endpoint")),
    ).toBe(true);
  });

  it("a failing session is reported to the scheduler as endSession(false)", async () => {
    const h = makeHarness();
    h.failNext.value = true;
    h.runtime.manualSyncNow();
    await vi.advanceTimersByTimeAsync(0);
    // peer-a failed -> backoff armed: a subsequent automatic pass skips it.
    h.runtime.consume({ action: "immediate-sync" }, { manual: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.opened.filter((o) => o.deviceId === "peer-a")).toHaveLength(1);
  });
});

describe("SchedulerRuntime: debounce translation (DC-13 §3.3)", () => {
  it("fires a push to eligible peers once, debounce seconds after the LAST change", async () => {
    const h = makeHarness();
    h.runtime.start();
    h.runtime.onLocalChange(); // arms 10s deadline
    await vi.advanceTimersByTimeAsync(5_000);
    h.runtime.onLocalChange(); // restarts the window
    await vi.advanceTimersByTimeAsync(9_999);
    expect(h.opened).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.opened.map((o) => o.deviceId).sort()).toEqual(["peer-a", "peer-b"]);
    h.runtime.stop();
  });

  it("a debounce tick with no pending changes is a noop", async () => {
    const h = makeHarness();
    h.runtime.start();
    h.runtime.onLocalChange();
    await vi.advanceTimersByTimeAsync(10_000);
    // dirty was consumed; nothing further fires on later ticks.
    const count = h.opened.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.opened.length).toBe(count);
    h.runtime.stop();
  });

  it("push decisions target only the named peers", async () => {
    const h = makeHarness();
    h.runtime.consume({ action: "push", peers: ["peer-b"] }, { manual: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.opened.map((o) => o.deviceId)).toEqual(["peer-b"]);
  });
});

describe("startSchedulerRuntime factory", () => {
  it("starts running, applies clamped settings, and stop() tears timers down", async () => {
    const opened: string[] = [];
    const handle = startSchedulerRuntime({
      now: () => Date.now(),
      listPeers: () => [{ deviceId: "p", endpoint: { host: "h", port: 1 } }],
      openSession: async ({ deviceId }) => {
        opened.push(deviceId);
        return true;
      },
      log: () => {},
      settings: { sweepMinutes: 1 }, // below MIN(5) — clamps to 5 (DC-13 §3.5)
    });
    expect(handle.runtime.isRunning).toBe(true);
    expect(handle.scheduler.getSettings().sweepMinutes).toBe(5);
    handle.stop();
    expect(handle.runtime.isRunning).toBe(false);
    // After stop, sweep ticks do nothing.
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(opened).toHaveLength(0);
  });
});
