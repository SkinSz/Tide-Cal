// Tide DC-23 §13 integration tests: real EventCore + temp DB.
// Verifies the NORMAL Tide write machinery (change records, entity versions,
// device clock) is exercised — not just final rows (instruction §13).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { EventCore } from "../src/persistence/bridges/event_core.ts";
import {
  parseIcs,
  planImport,
  applyImportPlan,
  buildExistingIndex,
  type ExistingIndex,
} from "../src/interop/ics_import.ts";
import { exportToIcs, buildExportInput } from "../src/interop/ics_export.ts";
import { makeDispatcher } from "../src/persistence/bridges/sidecar_server.ts";

const dir = mkdtempSync(join(tmpdir(), "tide-dc23-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function makeCore(): EventCore {
  return new EventCore(join(dir, `db-${Math.random().toString(36).slice(2)}.db`), "import-test-device");
}

function icsOf(...vevents: string[]): string {
  return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//T//EN", ...vevents, "END:VCALENDAR", ""].join("\r\n");
}

function importInto(core: EventCore, text: string) {
  const existing: ExistingIndex = buildExistingIndex(core);
  const { plan, notices } = planImport(parseIcs(text), existing);
  const report = applyImportPlan(core, plan);
  return { report, notices };
}

describe("I1: import into empty DB — normal Tide machinery", () => {
  test("creates events + change records + entity versions + device clock", () => {
    const core = makeCore();
    const before = core.db.prepare("SELECT COUNT(*) AS n FROM changes").get() as { n: number };
    const { report } = importInto(core, icsOf(
      "BEGIN:VEVENT",
      "UID:evt-a1a1a1a1-a1a1-41a1-81a1-a1a1a1a1a1a1",
      "DTSTART:20260910T120000Z",
      "DTEND:20260910T130000Z",
      "SUMMARY:Imported plain",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:evt-b2b2b2b2-b2b2-42b2-82b2-b2b2b2b2b2b2",
      "DTSTART;VALUE=DATE:20260902",
      "DTEND;VALUE=DATE:20260903",
      "SUMMARY:Imported all-day",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:evt-c3c3c3c3-c3c3-43c3-83c3-c3c3c3c3c3c3",
      "DTSTART:20260907T090000Z",
      "DTEND:20260907T093000Z",
      "RRULE:FREQ=WEEKLY;BYDAY=MO",
      "SUMMARY:Imported series",
      "END:VEVENT",
    ));
    expect(report.failed).toHaveLength(0);
    expect(report.created).toHaveLength(3);
    expect(report.updated).toHaveLength(0);

    // Rows exist.
    expect(core.listEvents()).toHaveLength(3);
    const series = core.listSeries();
    expect(series).toHaveLength(1);
    expect(series[0]!.recurrenceRule).toBe("FREQ=WEEKLY;BYDAY=MO");

    // Normal Tide machinery: change records written (>= 1 per entity).
    const after = core.db.prepare("SELECT COUNT(*) AS n FROM changes").get() as { n: number };
    expect(after.n).toBeGreaterThan(before.n + 2);
    const kinds = core.db.prepare(
      "SELECT DISTINCT entity_type FROM changes",
    ).all() as Array<{ entity_type: string }>;
    expect(kinds.map((k) => k.entity_type)).toContain("event");
    expect(kinds.map((k) => k.entity_type)).toContain("series");

    // Entity versions durable snapshots exist for imported entities.
    const versions = core.db.prepare(
      "SELECT COUNT(DISTINCT entity_id) AS n FROM entity_versions",
    ).get() as { n: number };
    expect(versions.n).toBeGreaterThanOrEqual(3);

    // Device clock advanced (device_clock table, DC-01).
    const clock = core.db.prepare(
      "SELECT MAX(hlc_timestamp) AS m FROM changes",
    ).get() as { m: number };
    expect(clock.m).toBeGreaterThan(0);

    // All-day conversion landed as Tide stores it (inclusive end).
    const allDayRow = core.db.prepare(
      "SELECT start_date, end_date FROM events WHERE event_id = 'evt-b2b2b2b2-b2b2-42b2-82b2-b2b2b2b2b2b2'",
    ).get() as { start_date: string; end_date: string };
    expect(allDayRow.start_date).toBe("2026-09-02");
    expect(allDayRow.end_date).toBe("2026-09-02");
  });
});

describe("I2: repeated foreign-origin import duplicates (documented D2)", () => {
  test("same foreign file imported twice -> duplicates both times", () => {
    const core = makeCore();
    const text = icsOf(
      "BEGIN:VEVENT",
      "UID:xyz789@group.calendar.google.com",
      "DTSTART:20260910T120000Z",
      "DTEND:20260910T130000Z",
      "SUMMARY:Foreign",
      "END:VEVENT",
    );
    importInto(core, text);
    importInto(core, text);
    const rows = core.db.prepare(
      "SELECT COUNT(*) AS n FROM events WHERE title = 'Foreign'",
    ).get() as { n: number };
    expect(rows.n).toBe(2); // intentional v1 limitation, D2
  });

  test("same Tide-canonical file imported twice -> UPDATE (D1), no duplicate", () => {
    const core = makeCore();
    const text = icsOf(
      "BEGIN:VEVENT",
      "UID:evt-d4d4d4d4-d4d4-44d4-84d4-d4d4d4d4d4d4",
      "DTSTART:20260910T120000Z",
      "DTEND:20260910T130000Z",
      "SUMMARY:Round trip",
      "END:VEVENT",
    );
    importInto(core, text);
    const { report } = importInto(core, text);
    expect(report.updated).toHaveLength(1);
    expect(report.created).toHaveLength(0);
    const rows = core.db.prepare(
      "SELECT COUNT(*) AS n FROM events WHERE event_id = 'evt-d4d4d4d4-d4d4-44d4-84d4-d4d4d4d4d4d4'",
    ).get() as { n: number };
    expect(rows.n).toBe(1);
  });
});

describe("I3: DC-18 export -> DC-23 import round trip", () => {
  test("seeded DB exports, imports into fresh DB, semantics preserved", () => {
    // Source DB with the full zoo: plain, all-day, series, modified+cancelled.
    const src = makeCore();
    const dispatch = makeDispatcher(src);
    dispatch("create_event", { input: { title: "Plain", description: "", startMs: Date.parse("2026-09-10T12:00:00Z"), endMs: Date.parse("2026-09-10T13:00:00Z"), allDay: false } });
    dispatch("create_event", { input: { title: "All-day", description: "", startMs: Date.parse("2026-09-15T00:00:00"), endMs: Date.parse("2026-09-15T23:59:59.999"), allDay: true } });
    dispatch("create_event", { input: { title: "Series", description: "", startMs: Date.parse("2026-09-07T09:00:00Z"), endMs: Date.parse("2026-09-07T09:30:00Z"), allDay: false, recurrenceRule: "FREQ=WEEKLY;BYDAY=MO" } });
    const series = dispatch("list_series", {}) as Array<{ seriesId: string; baseEventId: string }>;
    dispatch("update_occurrence", { series_id: series[0]!.seriesId, recurrence_id: "20260914T090000", patch: { cancelled: true } });
    dispatch("update_occurrence", { series_id: series[0]!.seriesId, recurrence_id: "20260921T090000", patch: { title: "Series moved" } });

    const ics = exportToIcs(buildExportInput(src, Date.parse("2026-09-08T12:00:00Z")));

    // Fresh DB import.
    const dst = makeCore();
    const { report } = importInto(dst, ics);
    expect(report.failed).toHaveLength(0);

    // Semantic equivalence (ids may differ only for foreign UIDs — here all
    // UIDs are canonical Tide ids, so rows match 1:1 by event_id).
    const dstEvents = dst.listEvents();
    const srcEvents = src.listEvents();
    expect(dstEvents.length).toBe(srcEvents.length);
    for (const se of srcEvents) {
      const de = dstEvents.find((d) => d.id === se.id);
      expect(de, `event ${se.id} missing in destination`).toBeDefined();
      expect(de!.title).toBe(se.title);
      expect(de!.startMs).toBe(se.startMs);
      expect(de!.endMs).toBe(se.endMs);
      expect(de!.allDay).toBe(se.allDay);
    }
    // Series + overrides preserved.
    const dstSeries = dst.listSeries();
    expect(dstSeries).toHaveLength(1);
    expect(dstSeries[0]!.recurrenceRule).toBe("FREQ=WEEKLY;BYDAY=MO");
    const overrides = dstSeries[0]!.overrides;
    expect(overrides).toHaveLength(2);
    expect(overrides.filter((o) => o.cancelled).length).toBe(1);
    const moved = overrides.find((o) => !o.cancelled);
    expect(moved!.title).toBe("Series moved");
    expect(dstSeries[0]!.baseEventId).toBe(series[0]!.baseEventId); // round-trip id preserved
  });
});

describe("I4: tombstone match skips", () => {
  test("UID matching a tombstoned event is never resurrected", () => {
    const core = makeCore();
    // Create then delete -> tombstone.
    const ev = core.createEvent({ title: "Doomed", description: "", startMs: Date.parse("2026-09-10T12:00:00Z"), endMs: Date.parse("2026-09-10T13:00:00Z"), allDay: false });
    core.deleteEvent(ev.id);
    const { report } = importInto(core, icsOf(
      `BEGIN:VEVENT\r\nUID:${ev.id}\r\nDTSTART:20260910T120000Z\r\nDTEND:20260910T130000Z\r\nSUMMARY:Zombie\r\nEND:VEVENT`,
    ));
    expect(report.skipped).toHaveLength(1);
    expect(report.skipped[0]!.reason).toMatch(/tombstoned|deleted/i);
    expect(core.listEvents().find((e) => e.id === ev.id)).toBeUndefined();
  });
});

describe("I5: mid-apply domain failure -> partial apply + report", () => {
  test("valid entities commit; invalid one is reported failed, no rollback", () => {
    const core = makeCore();
    // Plan directly to inject an entity that FAILS domain validation
    // (inverted range) AFTER a valid one.
    const { plan } = planImport(parseIcs(icsOf(
      "BEGIN:VEVENT",
      "UID:evt-e5e5e5e5-e5e5-45e5-85e5-e5e5e5e5e5e5",
      "DTSTART:20260910T120000Z",
      "DTEND:20260910T130000Z",
      "SUMMARY:Will succeed",
      "END:VEVENT",
    )), { liveIds: new Set(), tombstonedIds: new Set(), seriesByBase: new Map(), tzByBase: new Map() });
    plan.actions.push({
      kind: "create_event",
      uid: "evt-f6f6f6f6-f6f6-46f6-86f6-f6f6f6f6f6f6",
      eventId: "evt-f6f6f6f6-f6f6-46f6-86f6-f6f6f6f6f6f6",
      allDay: false,
      title: "Inverted",
      description: "",
      startMs: 2000,
      endMs: 1000, // endMs < startMs -> validateEventValues throws
      rrule: null,
    });
    const report = applyImportPlan(core, plan);
    expect(report.created).toContain("evt-e5e5e5e5-e5e5-45e5-85e5-e5e5e5e5e5e5");
    expect(report.failed).toHaveLength(1);
    expect(report.failed[0]!.uid).toBe("evt-f6f6f6f6-f6f6-46f6-86f6-f6f6f6f6f6f6");
    // The valid entity STAYED committed (no rollback).
    expect(core.listEvents().some((e) => e.id === "evt-e5e5e5e5-e5e5-45e5-85e5-e5e5e5e5e5e5")).toBe(true);
  });
});