import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// Root cause (owner report, 2026-09-04): week-view dblclick-to-create broke.
// The single-click handler calls render(), which synchronously does
// root.replaceChildren() — the column the user clicked is destroyed between
// the two clicks of the double-click, so the browser never dispatches
// dblclick (both clicks must land on the SAME element). The handler still
// exists; it can never fire.
describe("week view hour-band dblclick creation", () => {
  const cal = readFileSync(
    new URL("../frontend/calendar.ts", import.meta.url),
    "utf8",
  );
  it("week-view single-click handler must NOT re-render synchronously (keeps dblclick alive)", () => {
    // Scope to the WEEK column handler (the one that has hour cells). The
    // month-view column has no dblclick-conflict (its dblclick targets the
    // same destroyed element problem, but month dblclick lands on the list
    // container — verified working; only the week one is guarded here).
    const weekPart = cal.slice(cal.indexOf("function weekDayColumn"));
    const clickHandler =
      weekPart.match(/col\.addEventListener\("click"[\s\S]*?\}\);/)?.[0] ?? "";
    expect(clickHandler).not.toContain("render()");
    // The dblclick handler must still exist and dispatch the event.
    expect(weekPart).toMatch(/addEventListener\("dblclick"[\s\S]*?tide:neweventat/);
  });
});
