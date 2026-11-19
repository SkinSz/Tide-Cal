// DC-26 §3.3 view refresh scheduler: TR-5 (coalescing) and TR-6 (edit-safe).
import { describe, expect, it } from "vitest";
import { createRefreshScheduler } from "../frontend/data_refresh.ts";

function harness(editing = false) {
  const timers: Array<{ fn: () => void; ms: number; live: boolean }> = [];
  const state = { editing, refreshes: 0 };
  const s = createRefreshScheduler({
    quietMs: 1500,
    isEditing: () => state.editing,
    refresh: () => {
      state.refreshes++;
    },
    setTimer: (fn, ms) => {
      const t = { fn, ms, live: true };
      timers.push(t);
      return t;
    },
    clearTimer: (h) => {
      (h as { live: boolean }).live = false;
    },
  });
  const fireLive = () => {
    for (const t of timers.filter((x) => x.live)) {
      t.live = false;
      t.fn();
    }
  };
  return { s, state, timers, fireLive };
}

describe("DC-26 refresh scheduler", () => {
  it("TR-5: a burst of notices yields exactly one refresh after the quiet period", () => {
    const h = harness();
    h.s.notify();
    h.s.notify();
    h.s.notify();
    expect(h.state.refreshes).toBe(0);
    expect(h.timers.filter((t) => t.live)).toHaveLength(1);
    expect(h.timers[0]!.ms).toBe(1500);
    h.fireLive();
    expect(h.state.refreshes).toBe(1);
  });

  it("no notice, no refresh", () => {
    const h = harness();
    h.s.editorClosed();
    h.fireLive();
    expect(h.state.refreshes).toBe(0);
  });

  it("TR-6: held back while an editor is open, exactly one refresh on close", () => {
    const h = harness(true);
    h.s.notify();
    h.fireLive();
    expect(h.state.refreshes).toBe(0);
    h.s.notify(); // more data while still editing
    h.fireLive();
    expect(h.state.refreshes).toBe(0);
    h.state.editing = false;
    h.s.editorClosed();
    expect(h.state.refreshes).toBe(1);
    h.s.editorClosed(); // closing another dialog later does nothing
    expect(h.state.refreshes).toBe(1);
  });

  it("closing a dialog during the quiet period does not refresh early", () => {
    const h = harness();
    h.s.notify();
    h.s.editorClosed();
    expect(h.state.refreshes).toBe(0);
    h.fireLive();
    expect(h.state.refreshes).toBe(1);
  });
});
