// GATE-2026-09-22 all-day end_date regression tests.
//
// Owner report: all-day events exported into Google Calendar spanned an
// extra day. Root cause: derivedScheduleColumns derived the INCLUSIVE
// end_date column (DC-07: "inclusive, when all_day=1") from the EXCLUSIVE
// endMs instant (the dialog's wholeDay path stores endMs = next local
// midnight), writing the day AFTER the real last covered day. The exporter
// then correctly added the RFC 5545 +1 (exclusive DTEND), producing a 2-day
// DTEND range for a 1-day event.
//
// T1: the write seam (create/update -> derived columns -> export).
// T2: the v8 data-repair migration over a simulated pre-fix DB.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { EventCore, derivedScheduleColumns } from "../src/persistence/bridges/event_core.ts";
import { buildExportInput, exportToIcs } from "../src/interop/ics_export.ts";
import { parseIcs, planImport, buildExistingIndex, applyImportPlan } from "../src/interop/ics_import.ts";

const NOW = Date.parse("2026-09-22T12:00:00Z");
const dir = mkdtempSync(join(tmpdir(), "tide-allday-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function makeCore(): EventCore {
  return new EventCore(join(dir, `db-${Math.random().toString(36).slice(2)}.db`), "dev-test-device");
}

/** Local midnight of YYYY-MM-DD in the test device's zone. */
function localMidnight(date: string): number {
  return new Date(`${date}T00:00:00`).getTime();
}

describe("T1: whole-day end_date is INCLUSIVE (last covered day, not next midnight)", () => {
  test("1-day all-day event stores start=end (was start=end+1)", () => {
    const core = makeCore();
    core.createEvent({
      title: "One day",
      description: "",
      startMs: localMidnight("2026-10-01"),
      endMs: localMidnight("2026-10-01") + 86_400_000, // dialog wholeDay convention
      allDay: true,
    });
    const row = core.db.prepare(
      "SELECT start_date, end_date FROM events",
    ).get() as { start_date: string; end_date: string };
    expect(row.start_date).toBe("2026-10-01");
    expect(row.end_date).toBe("2026-10-01"); // NOT 2026-10-02
    core.db.close();
  });

  test("2-day all-day event stores end = second day", () => {
    const d = derivedScheduleColumns({
      id: "x",
      title: "t",
      description: "",
      startMs: localMidnight("2026-10-01"),
      endMs: localMidnight("2026-10-03"), // exclusive: covers Oct 1-2
      allDay: true,
    });
    expect(d.start_date).toBe("2026-10-01");
    expect(d.end_date).toBe("2026-10-02");
  });

  test("importer's 23:59:59.999 form is idempotent under the -1ms", () => {
    const d = derivedScheduleColumns({
      id: "x",
      title: "t",
      description: "",
      startMs: localMidnight("2026-10-01"),
      endMs: new Date("2026-10-02T23:59:59.999").getTime(),
      allDay: true,
    });
    expect(d.start_date).toBe("2026-10-01");
    expect(d.end_date).toBe("2026-10-02");
  });

  test("export emits a 1-day DTEND for a 1-day all-day event (Google round-trip)", () => {
    const core = makeCore();
    core.createEvent({
      title: "One day",
      description: "",
      startMs: localMidnight("2026-10-01"),
      endMs: localMidnight("2026-10-01") + 86_400_000,
      allDay: true,
    });
    const ics = exportToIcs(buildExportInput(core, NOW));
    const props = extractProps(ics);
    expect(props.get("DTSTART;VALUE=DATE")).toBe("DTSTART;VALUE=DATE:20261001");
    expect(props.get("DTEND;VALUE=DATE")).toBe("DTEND;VALUE=DATE:20261002"); // exclusive next day = 1-day span
    core.db.close();
  });

  test("Tide->Tide round-trip preserves the 1-day all-day span", () => {
    const src = makeCore();
    src.createEvent({
      title: "One day",
      description: "",
      startMs: localMidnight("2026-10-01"),
      endMs: localMidnight("2026-10-01") + 86_400_000,
      allDay: true,
    });
    const ics = exportToIcs(buildExportInput(src, NOW));
    const dst = makeCore();
    const parsed = parseIcs(ics);
    const { plan } = planImport(parsed, buildExistingIndex(dst));
    applyImportPlan(dst, plan);
    const row = dst.db.prepare(
      "SELECT start_date, end_date FROM events",
    ).get() as { start_date: string; end_date: string };
    expect(row.start_date).toBe("2026-10-01");
    expect(row.end_date).toBe("2026-10-01");
    src.db.close();
    dst.db.close();
  });
});

/** Minimal DTSTART/DTEND extractor keyed by full property name incl. params. */
function extractProps(ics: string): Map<string, string> {
  const props = new Map<string, string>();
  for (const line of ics.split("\r\n")) {
    const m = /^((?:DTSTART|DTEND|RRULE)[^:]*):(.+)$/.exec(line);
    if (m) props.set(m[1]!, line);
  }
  return props;
}

describe("T2: v8 data-repair migration fixes pre-fix all-day rows", () => {
  test("opening a v7 DB with inflated end_date rewrites it to inclusive", () => {
    // Build a FRESH (post-fix) core, then corrupt the row back to the
    // pre-fix state and stamp the version down to 7 — the exact state an
    // existing dev DB is in before this fix ships.
    const core = makeCore();
    core.createEvent({
      title: "Legacy",
      description: "",
      startMs: localMidnight("2026-10-01"),
      endMs: localMidnight("2026-10-01") + 86_400_000,
      allDay: true,
    });
    const endMs = core.db.prepare("SELECT utc_end_ms FROM events").get() as { utc_end_ms: number };
    core.db.exec(
      `UPDATE events SET end_date = '2026-10-02'; ` + // the pre-fix wrong value
        `UPDATE schema_version SET version = 7;`,
    );
    const path = core.dbPath;
    core.db.close();

    // Reopen: migration v8 runs, re-derives from utc_end_ms.
    const reopened = new EventCore(path, "dev-test-device");
    const row = reopened.db.prepare(
      "SELECT end_date, version FROM events, schema_version LIMIT 1",
    ).get() as { end_date: string; version: number };
    expect(row.version).toBe(8);
    expect(row.end_date).toBe("2026-10-01");
    reopened.db.close();
    void endMs;
  });
});
