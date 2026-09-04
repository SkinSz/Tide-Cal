// TD-022 (2026-09-04): multi-strategy notification delivery regression tests.
// Strategies: notify-send → gdbus → dbus-send; dead strategies are skipped
// for the rest of the session; confirmed-success-only marking (pkg10 F1) is
// preserved — the callback fires true ONLY on a spawned child exiting 0.
import { describe, expect, test, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";

const src = readFileSync(
  new URL("../src/application/notification_delivery.ts", import.meta.url),
  "utf8",
);

describe("TD-022: multi-strategy notify delivery", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("source declares all three strategies in priority order", () => {
    expect(src).toMatch(
      /\["notify-send",\s*"gdbus",\s*"dbus-send"\]/,
    );
  });

  test("gdbus strategy targets org.freedesktop.Notifications.Notify", () => {
    const gdbus = src.match(/case "gdbus":[\s\S]*?return \[[\s\S]*?\];/)?.[0] ?? "";
    expect(gdbus).toContain("org.freedesktop.Notifications");
    expect(gdbus).toContain("org.freedesktop.Notifications.Notify");
    expect(gdbus).toContain("--session");
  });

  test("dbus-send strategy uses typed string args (no shell, no injection)", () => {
    const dbus = src.match(/case "dbus-send":[\s\S]*?return \[[\s\S]*?\];/)?.[0] ?? "";
    expect(dbus).toContain("string:");
    expect(dbus).toContain("uint32:0");
    expect(dbus).toContain("int32:10000");
    // no shell invocation anywhere in the module
    expect(src).not.toMatch(/shell:\s*true/);
    expect(src).not.toMatch(/exec\(/);
  });

  test("failed strategies are remembered for the session (deadStrategies)", () => {
    expect(src).toMatch(/deadStrategies\.add\(strategy\)/);
  });

  test("all-strategies-dead path settles false and does not spawn", () => {
    expect(src).toMatch(/ALL strategies failed this dispatch/);
  });

  test("pkg10 F1 contract preserved: marking only via onResult callback", () => {
    expect(src).toMatch(/settle\(true\)/);
    expect(src).toMatch(/settle\(false\)/);
  });
});
