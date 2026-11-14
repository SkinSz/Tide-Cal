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
