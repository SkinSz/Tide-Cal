// DC-26 §3.1 sidecar data notice: TR-1 (emission rule) and TR-3 (content).
import { describe, expect, it } from "vitest";
import {
  dataChangedNoticeLine,
  notifyDataChanged,
} from "../src/persistence/bridges/sidecar_server.ts";

describe("DC-26 data notice", () => {
  it("TR-1: one notice when changes were applied, carrying the count", () => {
    const calls: number[] = [];
    notifyDataChanged({ receivedApplied: 3 }, (n) => calls.push(n));
    expect(calls).toEqual([3]);
  });

  it("TR-1: no notice when nothing was applied", () => {
    const calls: number[] = [];
    notifyDataChanged({ receivedApplied: 0 }, (n) => calls.push(n));
    expect(calls).toEqual([]);
  });

  it("DC-26 v2: a snapshot that only deleted local rows also notifies", () => {
    const calls: number[] = [];
    notifyDataChanged({ receivedApplied: 0, snapshotDeletions: 2 }, (n) => calls.push(n));
    notifyDataChanged({ receivedApplied: 0, snapshotDeletions: 0 }, (n) => calls.push(n));
    expect(calls).toEqual([2]);
  });

  it("a throwing sink never fails the session", () => {
    expect(() =>
      notifyDataChanged({ receivedApplied: 1 }, () => {
        throw new Error("stdout closed");
      }),
    ).not.toThrow();
  });

  it("TR-3: wire line has no id and carries only notice/source/applied", () => {
    const msg = JSON.parse(dataChangedNoticeLine(2)) as Record<string, unknown>;
    expect(msg).toEqual({ notice: "data_changed", source: "sync", applied: 2 });
    expect("id" in msg).toBe(false);
  });
});

describe("DC-26 v2 TR-10: Sync Errors Retry", () => {
  it("an applied retry dispatches tide:data-changed; others do not", async () => {
    const { notifyRetryOutcome } = await import("../frontend/sync_errors");
    for (const [outcome, expected] of [
      ["applied", 1],
      ["still_quarantined", 0],
      ["duplicate", 0],
    ] as const) {
      const target = new EventTarget();
      let seen = 0;
      target.addEventListener("tide:data-changed", () => seen++);
      expect(notifyRetryOutcome(outcome, target)).toBe(expected === 1);
      expect(seen).toBe(expected);
    }
  });
});
