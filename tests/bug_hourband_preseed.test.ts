// Owner bug report 2026-10-12 (bug 3, both platforms): double-click on a
// week-view hour band must pre-seed the new-event dialog with THAT band's
// start — openFor() unconditionally reset to 09:00, discarding the hour.
// Fix: explicitTime sentinel (non-midnight passed date = hour-band signal);
// end = start + 1h (the band's own convention).
import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";

const dialog = readFileSync(
  new URL("../frontend/dialog.ts", import.meta.url),
  "utf8",
);
const calendar = readFileSync(
  new URL("../frontend/calendar.ts", import.meta.url),
  "utf8",
);

describe("hour-band dblclick pre-seed (owner bug 2026-10-12)", () => {
  test("calendar week-view dblclick emits a full date+hour ISO (not date-only)", () => {
    // The week-view handler builds d from cell.date then setHours(hour,0,0,0)
    // and dispatches toISOString — pin the setHours call exists in the band
    // dblclick path.
    expect(calendar).toMatch(/d\.setHours\(hour, 0, 0, 0\)/);
  });

  test("openFor honors the passed time instead of resetting to 09:00", () => {
    expect(dialog).toMatch(/const explicitTime = d\.getHours\(\) !== 0 \|\| d\.getMinutes\(\) !== 0/);
    // the pre-seed branch sets start from the passed time…
    expect(dialog).toMatch(/ev-start-t"\)\.value = toTimeInput\(d\.getTime\(\)\)/);
    // …and derives end as start + 1h
    expect(dialog).toMatch(/new Date\(d\.getTime\(\) \+ 60 \* 60 \* 1000\)/);
    // the 09:00 default remains ONLY in the non-explicit branch
    const elseBranch = dialog.match(/else \{\s*d\.setHours\(9/);
    expect(elseBranch).toBeTruthy();
  });
});
