// TD-014 RED-phase probe: runs expandOccurrences in a child process with a
// hard wall-clock kill. A correct expansion of these bounded rules (COUNT)
// returns in milliseconds; a hang proves the F1/F2/F3 defects.
import { spawnSync } from "node:child_process";

/** @type {Array<{name: string, code: string}>} */
const cases = [
  {
    name: "F1a DAILY;INTERVAL=2;COUNT=5",
    code: `import { expandOccurrences } from "/home/skins/tide/src/domain/recurrence_conflicts.ts";
    const r = expandOccurrences({ series_id: "s", base_start_wall: "2026-09-02T09:00", tz_id: "Europe/Berlin", recurrence_rule: "FREQ=DAILY;INTERVAL=2;COUNT=5" }, "20260902T000000", "20301231T235959");
    console.log("RESULT", JSON.stringify(r));`,
  },
  {
    name: "F1b MONTHLY;INTERVAL=2;COUNT=4",
    code: `import { expandOccurrences } from "/home/skins/tide/src/domain/recurrence_conflicts.ts";
    const r = expandOccurrences({ series_id: "s", base_start_wall: "2026-09-02T09:00", tz_id: "Europe/Berlin", recurrence_rule: "FREQ=MONTHLY;INTERVAL=2;COUNT=4" }, "20260902T000000", "20301231T235959");
    console.log("RESULT", JSON.stringify(r));`,
  },
  {
    name: "F2 WEEKLY no BYDAY, 1-week window",
    code: `import { expandOccurrences } from "/home/skins/tide/src/domain/recurrence_conflicts.ts";
    const r = expandOccurrences({ series_id: "s", base_start_wall: "2026-09-02T09:00", tz_id: "Europe/Berlin", recurrence_rule: "FREQ=WEEKLY" }, "20260902T000000", "20260908T235959");
    console.log("RESULT", JSON.stringify(r));`,
  },
  {
    name: "F3 WEEKLY;INTERVAL=2;BYDAY=MO,WE",
    code: `import { expandOccurrences } from "/home/skins/tide/src/domain/recurrence_conflicts.ts";
    const r = expandOccurrences({ series_id: "s", base_start_wall: "2026-09-07T08:00", tz_id: "Europe/Berlin", recurrence_rule: "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE" }, "20260907T000000", "20260927T235959");
    console.log("RESULT", JSON.stringify(r));`,
  },
];

const PROBE = "/tmp/td014-probe.mjs";
let failures = 0;
for (const c of cases) {
  const { writeFileSync, rmSync } = await import("node:fs");
  writeFileSync(PROBE, c.code);
  const t0 = Date.now();
  const r = spawnSync("node", ["--experimental-strip-types", PROBE], { timeout: 8000, encoding: "utf8" });
  const ms = Date.now() - t0;
  const out = (r.stdout ?? "").trim();
  const status = r.status === 0 && out.startsWith("RESULT") ? "OK" : `FAIL(${r.status ?? "timeout"})`;
  if (status !== "OK") failures++;
  console.log(`${status.padEnd(12)} ${String(ms).padStart(5)}ms  ${c.name}  ${out.slice(0, 90)}`);
  rmSync(PROBE, { force: true });
}
process.exit(failures > 0 ? 1 : 0);
