// Recurrence surfacing tests (DC-12 §2, display-only) — alongside
// tests/conflicts_ui.test.ts pattern: DB-backed store + pure display-shaping
// layer. Covers EventCore.listSeries (read-only RPC surface), plain-language
// RRULE rendering for common cases, raw-RRULE fallback for exotic rules,
// grid indicator/override-marker shaping, and the edit-dialog distinction
// line. No mutation, no change records: read-only by design.
import { describe, expect, test, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "better-sqlite3";
import { openDatabase } from "../src/persistence/database.ts";
import { EventCore } from "../src/persistence/bridges/event_core.ts";
import {
  describeRule,
  parseRRule,
  recurrenceBadge,
  overrideMarker,
  dialogRecurrenceLine,
  type SeriesInfo,
} from "../frontend/recurrence.ts";
import {
  listSeries,
  createEvent,
  listEvents,
  type EventStoreBridge,
  type CalendarEvent,
} from "../frontend/store.ts";

// ---------------------------------------------------------------------------
// Regression (verifier-found MAJOR): a failing listSeries (list_series Tauri
// command not wired yet) must NOT flip the global localStorage-fallback flag —
// subsequent event CRUD must still route to the real store bridge.
// ---------------------------------------------------------------------------

describe("listSeries failure does not poison event-CRUD fallback", () => {
  test("failing series invoke returns [] and leaves createEvent/listEvents on the bridge", async () => {
    const created: CalendarEvent[] = [];
    let seriesCalls = 0;
    const bridge: EventStoreBridge = {
      listEvents() {
        return created.slice();
      },
      createEvent(input) {
        const event = { id: `e-${created.length + 1}`, ...input };
        created.push(event);
        return event;
      },
      updateEvent() {
        throw new Error("not used in this test");
      },
      deleteEvent() {},
      // Simulates the desktop app's current state: the series bridge exists
      // but the backing list_series op fails (backend not wired).
      listSeries() {
        seriesCalls += 1;
        throw new Error("list_series not implemented");
      },
    };
    // Stub window + a canary localStorage: any fallback write would land here.
    const lsWrites: string[] = [];
    const prevWindow = (globalThis as { window?: unknown }).window;
    const prevLs = (globalThis as { localStorage?: unknown }).localStorage;
    (globalThis as { window?: unknown }).window = { __TIDE_EVENT_STORE__: bridge };
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: () => null,
      setItem: (_k: string, v: string) => lsWrites.push(v),
    };

    try {
      const series = await listSeries();
      expect(series).toEqual([]);
      expect(seriesCalls).toBe(1);

      // Event CRUD still routes to the REAL store, not localStorage.
      const event = await createEvent({
        title: "Standup",
        description: "",
        startMs: 0,
        endMs: 0,
        allDay: true,
      });
      expect(created.map((e) => e.id)).toContain(event.id);

      const listed = await listEvents();
      expect(listed.map((e) => e.id)).toContain(event.id);

      expect(lsWrites).toEqual([]);
    } finally {
      (globalThis as { window?: unknown }).window = prevWindow;
      (globalThis as { localStorage?: unknown }).localStorage = prevLs;
    }
  });
});

let dir: string;
let db: Database;
let core: EventCore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tide-recurrence-ui-"));
  core = new EventCore(join(dir, "t.db"));
  db = core.db;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function seedSeries(opts: {
  seriesId: string;
  baseEventId: string;
  rule: string;
  overrides?: Array<{
    rid: string;
    cancelled?: boolean;
  }>;
}): void {
  db.prepare(
    `INSERT INTO calendars (calendar_id, title, created_hlc, updated_hlc)
     VALUES ('cal-home', 'Home', 1, 1)
     ON CONFLICT(calendar_id) DO NOTHING`,
  ).run();
  db.prepare(
    `INSERT INTO events (event_id, calendar_id, title, description, all_day,
       start_date, end_date, created_hlc, updated_hlc)
     VALUES (?, 'cal-home', 'Standup', '', 1, '2026-09-02', '2026-09-02', 1, 1)`,
  ).run(opts.baseEventId);
  db.prepare(
    `INSERT INTO series (series_id, base_event_id, recurrence_rule,
       created_hlc, updated_hlc) VALUES (?, ?, ?, 1, 1)`,
  ).run(opts.seriesId, opts.baseEventId, opts.rule);
  for (const o of opts.overrides ?? []) {
    db.prepare(
      `INSERT INTO occurrence_overrides (series_id, recurrence_id,
         cancelled, updated_hlc) VALUES (?, ?, ?, 1)`,
    ).run(opts.seriesId, o.rid, o.cancelled ? 1 : 0);
  }
}

// ---------------------------------------------------------------------------
// Plain-language RRULE rendering
// ---------------------------------------------------------------------------

describe("describeRule — common cases", () => {
  test("weekly on Monday", () => {
    expect(describeRule("FREQ=WEEKLY;BYDAY=MO")).toBe(
      "Repeats weekly on Monday",
    );
  });

  test("daily", () => {
    expect(describeRule("FREQ=DAILY")).toBe("Repeats daily");
  });

  test("every 2 weeks on Tuesday, Thursday", () => {
    expect(describeRule("FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH")).toBe(
      "Repeats every 2 weeks on Tuesday, Thursday",
    );
  });

  test("every 3 days", () => {
    expect(describeRule("FREQ=DAILY;INTERVAL=3")).toBe("Repeats every 3 days");
  });

  test("monthly", () => {
    expect(describeRule("FREQ=MONTHLY")).toBe("Repeats monthly");
  });

  test("yearly", () => {
    expect(describeRule("FREQ=YEARLY")).toBe("Repeats yearly");
  });

  test("weekly all five weekdays", () => {
    expect(describeRule("FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR")).toBe(
      "Repeats weekly on Monday, Tuesday, Wednesday, Thursday, Friday",
    );
  });
});

describe("describeRule — raw fallback for exotic/unknown rules", () => {
  test("BYSETPOS is NOT a common case: raw string, byte-identical", () => {
    const rule = "FREQ=MONTHLY;BYDAY=MO;BYSETPOS=2";
    expect(describeRule(rule)).toBe(rule);
  });

  test("COUNT param falls back to raw", () => {
    const rule = "FREQ=DAILY;COUNT=10";
    expect(describeRule(rule)).toBe(rule);
  });

  test("UNTIL param falls back to raw", () => {
    const rule = "FREQ=WEEKLY;BYDAY=WE;UNTIL=20261231T000000Z";
    expect(describeRule(rule)).toBe(rule);
  });

  test("ordinal BYDAY (2MO) falls back to raw — qualifier never dropped", () => {
    const rule = "FREQ=MONTHLY;BYDAY=2MO";
    expect(describeRule(rule)).toBe(rule);
  });

  test("unknown FREQ falls back to raw", () => {
    const rule = "FREQ=HOURLY;INTERVAL=6";
    expect(describeRule(rule)).toBe(rule);
  });

  test("garbage string falls back to raw", () => {
    expect(describeRule("NOT AN RRULE")).toBe("NOT AN RRULE");
    expect(describeRule("")).toBe("");
  });

  test("invalid INTERVAL falls back to raw", () => {
    const rule = "FREQ=DAILY;INTERVAL=0";
    expect(describeRule(rule)).toBe(rule);
    expect(parseRRule("FREQ=DAILY;INTERVAL=1.5")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Read-only store surface (EventCore.listSeries)
// ---------------------------------------------------------------------------

describe("EventCore.listSeries — read-only join of series + overrides", () => {
  test("returns series rows with verbatim rule and their overrides", () => {
    seedSeries({
      seriesId: "s-1",
      baseEventId: "e-1",
      rule: "FREQ=WEEKLY;BYDAY=WE",
      overrides: [{ rid: "20260902T090000" }, { rid: "20260909T090000", cancelled: true }],
    });
    seedSeries({ seriesId: "s-2", baseEventId: "e-2", rule: "FREQ=DAILY" });

    const rows = core.listSeries();
    expect(rows).toHaveLength(2);
    const s1 = rows.find((r) => r.seriesId === "s-1")!;
    expect(s1.baseEventId).toBe("e-1");
    // Verbatim rule (DC-12 §2.1: never rewritten by the display layer).
    expect(s1.recurrenceRule).toBe("FREQ=WEEKLY;BYDAY=WE");
    expect(s1.overrides).toEqual([
      {
        recurrenceId: "20260902T090000",
        cancelled: false,
        title: null,
        startWall: null,
        endWall: null,
        tzId: null,
      },
      {
        recurrenceId: "20260909T090000",
        cancelled: true,
        title: null,
        startWall: null,
        endWall: null,
        tzId: null,
      },
    ]);
    const s2 = rows.find((r) => r.seriesId === "s-2")!;
    expect(s2.overrides).toEqual([]);
  });

  test("listSeries is read-only: no change records, no row mutations", () => {
    seedSeries({ seriesId: "s-1", baseEventId: "e-1", rule: "FREQ=DAILY" });
    const changesBefore = db.prepare("SELECT COUNT(*) AS c FROM changes").get();
    const seriesBefore = db
      .prepare<[], { rule: string }>("SELECT recurrence_rule AS rule FROM series")
      .get();
    core.listSeries();
    core.listSeries();
    const changesAfter = db.prepare("SELECT COUNT(*) AS c FROM changes").get();
    const seriesAfter = db
      .prepare<[], { rule: string }>("SELECT recurrence_rule AS rule FROM series")
      .get();
    expect(changesAfter).toEqual(changesBefore);
    expect(seriesAfter).toEqual(seriesBefore);
  });
});

// ---------------------------------------------------------------------------
// Grid indicator + override marker (display shaping)
// ---------------------------------------------------------------------------

function info(partial: Partial<SeriesInfo>): SeriesInfo {
  return {
    seriesId: "s-1",
    baseEventId: "e-1",
    rule: "FREQ=WEEKLY;BYDAY=MO",
    overrides: [],
    ...partial,
  };
}

describe("recurrenceBadge / overrideMarker — grid surfacing", () => {
  test("series event gets glyph + plain-language tooltip", () => {
    const b = recurrenceBadge(info({ rule: "FREQ=WEEKLY;BYDAY=MO" }));
    expect(b.glyph).toBe("🔁");
    expect(b.tooltip).toBe("Recurring — Repeats weekly on Monday");
    expect(b.hasOverride).toBe(false);
    expect(overrideMarker(info({}))).toBe("");
  });

  test("exotic rule tooltip shows the RAW RRULE string", () => {
    const rule = "FREQ=MONTHLY;BYDAY=MO;BYSETPOS=2";
    const b = recurrenceBadge(info({ rule }));
    expect(b.tooltip).toBe(`Recurring — ${rule}`);
  });

  test("overrides surface a changed-occurrence marker", () => {
    const i = info({
      overrides: [
        { recurrenceId: "20260902T090000", cancelled: false },
        { recurrenceId: "20260909T090000", cancelled: true },
      ],
    });
    const b = recurrenceBadge(i);
    expect(b.hasOverride).toBe(true);
    expect(b.tooltip).toContain("1 occurrence changed");
    expect(b.tooltip).toContain("1 occurrence cancelled");
    expect(overrideMarker(i)).toBe(
      "1 changed occurrence, 1 cancelled occurrence",
    );
  });

  test("single changed occurrence marker is singular", () => {
    const i = info({ overrides: [{ recurrenceId: "20260902T090000", cancelled: false }] });
    expect(overrideMarker(i)).toBe("1 changed occurrence");
  });
});

// ---------------------------------------------------------------------------
// Edit-dialog distinction line (THIS occurrence vs SERIES)
// ---------------------------------------------------------------------------

describe("dialogRecurrenceLine — dialog distinction", () => {
  test("series event line states rule + series/base-event scope honestly", () => {
    const line = dialogRecurrenceLine(info({ rule: "FREQ=WEEKLY;BYDAY=MO" }));
    expect(line).toContain("Part of a recurring series");
    expect(line).toContain("Repeats weekly on Monday");
    // Distinction visible: saving touches the SERIES base event, not a
    // single occurrence; no per-occurrence editing is claimed.
    expect(line).toContain("base event");
    // DC-12 occurrence-override editing: the line names the scope choice and
    // the R2 anchoring + R6 exclusion explicitly.
    expect(line).toContain("This occurrence only");
    expect(line).toContain("no “this and following”");
  });

  test("line mentions overrides when the series has them", () => {
    const line = dialogRecurrenceLine(
      info({ overrides: [{ recurrenceId: "20260902T090000", cancelled: false }] }),
    );
    expect(line).toContain("Overrides on this series: 1 changed occurrence");
  });

  test("raw fallback inside the dialog line too (never misrepresent)", () => {
    const rule = "FREQ=YEARLY;BYYEARDAY=100";
    const line = dialogRecurrenceLine(info({ rule }));
    expect(line).toContain(rule);
    expect(line).not.toContain("Repeats");
  });
});
