// Tide DC-18 §6 integration test: export a SEEDED DB through the real
// dispatcher path (makeDispatcher — the same seam the sidecar stdio loop
// serves) and assert the resulting bytes round-trip the strict structural
// parser without errors. The exporter itself stays headless/pure (T1-T10 in
// dc18_ics_export.test.ts); this test proves the DB -> ExportInput -> bytes
// chain against a real EventCore (DC-07 schema, temp SQLite file).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { EventCore } from "../src/persistence/bridges/event_core.ts";
import { makeDispatcher } from "../src/persistence/bridges/sidecar_server.ts";
import { buildExportInput, exportToIcs } from "../src/interop/ics_export.ts";

const NOW = Date.parse("2026-09-08T12:00:00Z");

const dir = mkdtempSync(join(tmpdir(), "tide-dc18-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function makeCore(): EventCore {
  return new EventCore(join(dir, `db-${Math.random().toString(36).slice(2)}.db`), "dev-test-device");
}

describe("DC-18 integration: seeded DB through the real dispatcher", () => {
  test("export_ics op returns bytes that parse and carry the seeded data", () => {
    const core = makeCore();
    const dispatch = makeDispatcher(core);

    // Seed through the real write path (change records + rows).
    dispatch("create_event", {
      input: {
        title: "Plain; event, with punctuation",
        description: "line1\nline2",
        startMs: Date.parse("2026-09-10T12:00:00Z"),
        endMs: Date.parse("2026-09-10T13:00:00Z"),
        allDay: false,
      },
    });
    dispatch("create_event", {
      input: {
        title: "All-day offsite",
        description: "",
        // All-day: local midnight .. inclusive end 23:59:59.999
        startMs: Date.parse("2026-09-15T00:00:00"),
        endMs: Date.parse("2026-09-15T23:59:59.999"),
        allDay: true,
      },
    });
    dispatch("create_event", {
      input: {
        title: "Weekly sync",
        description: "",
        startMs: Date.parse("2026-09-07T09:00:00Z"),
        endMs: Date.parse("2026-09-07T09:30:00Z"),
        allDay: false,
        recurrenceRule: "FREQ=WEEKLY;BYDAY=MO",
      },
    });
    const series = dispatch("list_series", {}) as Array<{
      seriesId: string;
      baseEventId: string;
      recurrenceRule: string;
    }>;
    expect(series.length).toBe(1);
    dispatch("update_occurrence", {
      series_id: series[0]!.seriesId,
      recurrence_id: "20260914T090000",
      patch: { cancelled: true },
    });
    dispatch("update_occurrence", {
      series_id: series[0]!.seriesId,
      recurrence_id: "20260921T090000",
      patch: { title: "Sync moved" },
    });

    // Export through the same op the Rust shell calls.
    const res = dispatch("export_ics", { now_ms: NOW }) as { ics: string };
    const text = res.ics;

    // Structural parse (strict grammar, CRLF, folding respected).
    expect(text.endsWith("\r\n")).toBe(true);
    expect(/(^|[^\r])\n/.test(text)).toBe(false);
    const unfolded = text.replace(/\r\n /g, "");
    const lines = unfolded.split("\r\n").filter((l) => l.length > 0);
    for (const line of lines) {
      const m = /^([A-Za-z0-9-]+)((?:;[^:=]+=[^:]*)*):(.*)$/.exec(line);
      expect(m, `malformed line: ${JSON.stringify(line)}`).not.toBeNull();
    }
    expect(lines.filter((l) => l === "BEGIN:VEVENT").length).toBe(5); // 2 singles + 1 series base + cancelled + modified override

    // Event ids are UIDs verbatim (§3.6).
    const plain = core.listEvents();
    expect(plain.length).toBe(3);
    for (const e of plain) {
      expect(lines.some((l) => l === `UID:${e.id}`)).toBe(true);
    }
    expect(lines.some((l) => l === "SUMMARY:Plain\\; event\\, with punctuation")).toBe(true);
    expect(lines.some((l) => l === "DESCRIPTION:line1\\nline2")).toBe(true);
    expect(lines.some((l) => l === "RRULE:FREQ=WEEKLY;BYDAY=MO")).toBe(true);
    expect(lines.filter((l) => l === "STATUS:CANCELLED").length).toBe(1);
    expect(lines.some((l) => l === "SUMMARY:Sync moved")).toBe(true);
    // All-day exclusive DTEND conversion applied to the seeded row.
    expect(lines.some((l) => l === "DTEND;VALUE=DATE:20260916")).toBe(true);
  });

  test("re-export through buildExportInput is UID-stable (§3.6)", () => {
    const core = makeCore();
    core.createEvent({
      title: "Stability",
      description: "",
      startMs: Date.parse("2026-09-10T08:00:00Z"),
      endMs: Date.parse("2026-09-10T09:00:00Z"),
      allDay: false,
    });
    const a = exportToIcs(buildExportInput(core, NOW));
    const b = exportToIcs(buildExportInput(core, NOW));
    // DTSTAMP is pinned by nowMs, so the whole file is byte-identical here;
    // the contract's stability claim is UID-level, which this subsumes.
    expect(a).toBe(b);
    const uid = a.match(/^UID:(.+)$/m)?.[1];
    expect(uid).toBe(core.listEvents()[0]!.id);
  });
});