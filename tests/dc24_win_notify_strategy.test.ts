// DC-24 §4.5 (2026-10-11): Windows notification strategy joins the TD-022
// chain. Tests assert the SOURCE CONTRACT (the suite's established pattern
// for strategy-chain tests — see td022_notify_strategies.test.ts):
//   - per-platform chain selection (win32 → [powershell-toast])
//   - the toast strategy is XML-escaped (no injection via summary/body)
//   - spawn shape unchanged for Linux strategies (executable == strategy)
//   - powershell-toast spawns powershell.exe with -NoProfile/-NonInteractive
//   - session-dead-strategy + all-failed log rules carried over verbatim
import { describe, expect, test, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";

const src = readFileSync(
  new URL("../src/application/notification_delivery.ts", import.meta.url),
  "utf8",
);

describe("DC-24 §4.5: Windows toast strategy in the TD-022 chain", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("chain selection is per-platform (win32 → powershell-toast)", () => {
    expect(src).toMatch(/process\.platform === "win32" \? STRATEGIES_WINDOWS : STRATEGIES_LINUX/);
    expect(src).toMatch(/const STRATEGIES_WINDOWS = \["powershell-toast",\s*"powershell-messagebox"\] as const/);
    // Linux chain unchanged in TD-022 order
    expect(src).toMatch(/\["notify-send",\s*"gdbus",\s*"dbus-send"\] as const/);
  });

  test("toast XML text nodes are XML-escaped (injection guard)", () => {
    const esc = src.match(/function xmlEscape[\s\S]*?\n\}/)?.[0] ?? "";
    expect(esc).toContain("&amp;");
    expect(esc).toContain("&lt;");
    expect(esc).toContain("&gt;");
    expect(esc).toContain("&quot;");
    expect(esc).toContain("&apos;");
  });

  test("powershell-toast spawns powershell.exe with safe flags", () => {
    const spawnBlock = src.match(/\[exe, spawnArgs\][\s\S]*?spawn\(exe, spawnArgs/)?.[0] ?? "";
    expect(spawnBlock).toContain('"powershell.exe"');
    const args = src.match(/function case_powershell_toast_args[\s\S]*?\n\}/)?.[0] ?? "";
    expect(args).toContain("-NoProfile");
    expect(args).toContain("-NonInteractive");
    expect(args).toContain("Windows.UI.Notifications.ToastNotificationManager");
    // no shell interpreter anywhere (same rule as TD-022)
    expect(src).not.toMatch(/shell:\s*true/);
    expect(src).not.toMatch(/exec\(/);
  });

  test("TD-022 session rules carried over verbatim", () => {
    expect(src).toMatch(/deadStrategies\.add\(strategy\)/);
    expect(src).toMatch(/ALL strategies failed this dispatch/);
    expect(src).toMatch(/settle\(true\)/);
    expect(src).toMatch(/settle\(false\)/);
  });

  // Review-strengthened pins (blind review 2026-10-12):

  test("summary/body flow through xmlEscape INTO the toast XML (regression guard)", () => {
    // The interpolation site must call xmlEscape, not the raw variable.
    expect(src).toMatch(/\$\{xmlEscape\(summary\)\}/);
    expect(src).toMatch(/\$\{xmlEscape\(body\)\}/);
    expect(src).not.toMatch(/<text id="1">\$\{summary\}/);
    expect(src).not.toMatch(/<text id="2">\$\{body\}/);
  });

  test("both Windows strategies travel as ONE argv element (no shell split)", () => {
    const toast = src.match(/function case_powershell_toast_args[\s\S]*?\n\}/)?.[0] ?? "";
    const box = src.match(/function case_powershell_messagebox_args[\s\S]*?\n\}/)?.[0] ?? "";
    // -Command takes a single concatenated string (one argv element).
    expect(toast).toMatch(/"-Command",/);
    expect(box).toMatch(/"-Command",/);
    // MessageBox text is single-quote-doubled (PowerShell string escape).
    expect(box).toMatch(/replace\(\/'\/g, "''"\)/);
  });

  test("windows chain has the binding two-step order: toast → fallback", () => {
    // DC-24 §4.5: powershell-toast primary, tray-fallback equivalent second.
    expect(src).toMatch(
      /\["powershell-toast",\s*"powershell-messagebox"\] as const/,
    );
  });
});
