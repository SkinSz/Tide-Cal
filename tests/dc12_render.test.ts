// DC-12 render regression tests (owner-reported bug package after 341e502):
//   1. The calendar must render SERIES OCCURRENCES, not just the base event
//      chip (daily +3 days => 4 chips on consecutive days).
//   2. Every occurrence chip carries the 🔁 glyph + plain-language tooltip;
//      an edited occurrence carries the ✎ marker; a cancelled occurrence
//      renders NO chip.
//   3. The Until date picker auto-closes on change like the Day picker
//      (.until-picking wiring in dialog.ts).
import { describe, expect, test, beforeEach, afterEach } from "vitest";
import {
  render as renderCalendar,
  setViewMode,
  startOfDay,
  addDays,
  expandSeriesEvents,
} from "../frontend/calendar.ts";
import { initDialog } from "../frontend/dialog.ts";
import type { CalendarEvent, EventStoreBridge, SeriesRow } from "../frontend/store.ts";

// ---------------------------------------------------------------------------
// Minimal DOM stub (same shape as tests/month_view_clicks.test.ts)
// ---------------------------------------------------------------------------

type Listener = (e: unknown) => void;

const allElements = new Set<DomEl>();
const docListeners = new Map<string, Set<Listener>>();
const byId = new Map<string, DomEl>();

class ClassList {
  constructor(private el: DomEl) {}
  private list(): Set<string> {
    return new Set(this.el.className.split(/\s+/).filter(Boolean));
  }
  private write(s: Set<string>) {
    this.el.className = Array.from(s).join(" ");
  }
  add(...cs: string[]) {
    const s = this.list();
    for (const c of cs) s.add(c);
    this.write(s);
  }
  remove(...cs: string[]) {
    const s = this.list();
    for (const c of cs) s.delete(c);
    this.write(s);
  }
  contains(c: string) {
    return this.list().has(c);
  }
  toggle(c: string, force?: boolean) {
    const s = this.list();
    const on = force ?? !s.has(c);
    if (on) s.add(c);
    else s.delete(c);
    this.write(s);
    return on;
  }
}

class DomEl {
  className = "";
  classList: ClassList;
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  children: DomEl[] = [];
  parentElement: DomEl | null = null;
  textContent = "";
  title = "";
  hidden = false;
  value = "";
  checked = false;
  listeners = new Map<string, Set<Listener>>();

  constructor(public tagName = "div") {
    this.classList = new ClassList(this);
    allElements.add(this);
  }

  appendChild(child: DomEl): DomEl {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }
  replaceChildren(...kids: DomEl[]) {
    for (const k of this.children) k.parentElement = null;
    this.children = kids;
    for (const k of kids) k.parentElement = this;
  }
  addEventListener(type: string, fn: Listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
  }
  dispatch(type: string, target: DomEl = this): void {
    const e = { target, stopPropagation() {} };
    for (const fn of this.listeners.get(type) ?? []) fn(e);
  }
  closest(sel: string): DomEl | null {
    let el: DomEl | null = this;
    const want = sel.replace(/^\./, "").split(".");
    while (el) {
      if (want.every((c) => el!.classList.contains(c))) return el;
      el = el.parentElement;
    }
    return null;
  }
  querySelector(sel: string): DomEl | null {
    if (sel.startsWith("#")) {
      const id = sel.slice(1);
      if (!byId.has(id)) byId.set(id, new DomEl("div"));
      return byId.get(id)!;
    }
    return this.querySelectorAll(sel)[0] ?? null;
  }
  querySelectorAll(sel: string): DomEl[] {
    const parts = sel.replace(/^\./, "").split(".");
    const matches: DomEl[] = [];
    const walk = (el: DomEl) => {
      for (const child of el.children) {
        if (parts.every((c) => child.classList.contains(c))) matches.push(child);
        walk(child);
      }
    };
    walk(this);
    return matches;
  }
  getBoundingClientRect() {
    return { top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0 };
  }
  showModal() {}
  close() {}
  blur() {}
  focus() {}
}

function installDom(): void {
  allElements.clear();
  docListeners.clear();
  byId.clear();
  const doc = {
    createElement: (tag: string) => new DomEl(tag),
    getElementById: (id: string) => {
      if (!byId.has(id)) byId.set(id, new DomEl("div"));
      return byId.get(id)!;
    },
    querySelectorAll: (sel: string) => new DomEl().querySelectorAll(sel),
    addEventListener: (type: string, fn: Listener) => {
      if (!docListeners.has(type)) docListeners.set(type, new Set());
      docListeners.get(type)!.add(fn);
    },
    dispatchEvent: (e: { type: string; detail: unknown }) => {
      for (const fn of docListeners.get(e.type) ?? []) fn({ detail: e.detail });
    },
  };
  (globalThis as { document?: unknown }).document = doc;
}

// ---------------------------------------------------------------------------
// Store bridge stub
// ---------------------------------------------------------------------------

let events: CalendarEvent[] = [];
let seriesRows: SeriesRow[] = [];

function installBridge(): void {
  const bridge: EventStoreBridge = {
    listEvents: () => events.slice(),
    createEvent() {
      throw new Error("not used");
    },
    updateEvent() {
      throw new Error("not used");
    },
    deleteEvent() {},
    listSeries: () => seriesRows.map((s) => ({ ...s })),
  };
  (globalThis as { window?: unknown }).window = { __TIDE_EVENT_STORE__: bridge };
}

const prevDoc = (globalThis as { document?: unknown }).document;
const prevWin = (globalThis as { window?: unknown }).window;

beforeEach(() => {
  installDom();
  installBridge();
  events = [];
  seriesRows = [];
  setViewMode("month");
  initDialog();
});

afterEach(() => {
  (globalThis as { document?: unknown }).document = prevDoc;
  (globalThis as { window?: unknown }).window = prevWin;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Base event at 10:00 local on `day`, clamped so day+3 stays in-month. */
function dailyBase(): { ev: CalendarEvent; baseDay: Date } {
  const now = new Date();
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const dayNum = Math.min(now.getDate(), daysInMonth - 4);
  const base = new Date(now.getFullYear(), now.getMonth(), dayNum, 10, 0, 0, 0);
  const start = base.getTime();
  return {
    baseDay: startOfDay(base),
    ev: {
      id: "evt-series",
      title: "Standup",
      description: "",
      startMs: start,
      endMs: start + 3_600_000,
      allDay: false,
    },
  };
}

function dailySeriesRow(overrides: SeriesRow["overrides"] = []): SeriesRow {
  return {
    seriesId: "ser-1",
    baseEventId: "evt-series",
    recurrenceRule: "FREQ=DAILY",
    overrides,
  };
}

function dayColumns(grid: DomEl): DomEl[] {
  return grid.children.filter((c) => c.classList.contains("day-col"));
}

function columnFor(grid: DomEl, day: Date): DomEl {
  const iso = day.toISOString().slice(0, 10);
  const col = dayColumns(grid).find((c) => c.dataset.date === iso);
  expect(col, `day column for ${iso}`).toBeDefined();
  return col!;
}

function chipsIn(root: DomEl): DomEl[] {
  return root.querySelectorAll(".chip");
}

// ---------------------------------------------------------------------------
// 1. Series expansion renders occurrences
// ---------------------------------------------------------------------------

describe("DC-12 render: calendar expands recurring series", () => {
  test("daily series shows a chip on the base day and the next 3 days", async () => {
    const { ev, baseDay } = dailyBase();
    events = [ev];
    seriesRows = [dailySeriesRow()];
    await renderCalendar();
    const grid = byId.get("calendar-grid")!;
    for (let i = 0; i < 4; i++) {
      const col = columnFor(grid, addDays(baseDay, i));
      expect(chipsIn(col), `day +${i}`).toHaveLength(1);
    }
    // Occurrence chips act on the base event (select/edit/delete).
    expect(chipsIn(columnFor(grid, addDays(baseDay, 3)))[0]!.dataset.eventId).toBe("evt-series");
  });

  test("non-series events still render exactly one chip (unchanged)", async () => {
    const { ev, baseDay } = dailyBase();
    events = [ev]; // no series row
    await renderCalendar();
    expect(chipsIn(columnFor(byId.get("calendar-grid")!, baseDay))).toHaveLength(1);
    // And the next day has none.
    expect(chipsIn(columnFor(byId.get("calendar-grid")!, addDays(baseDay, 1)))).toHaveLength(0);
  });

  test("expandSeriesEvents: base event replaced by occurrences with per-occurrence times", () => {
    const { ev, baseDay } = dailyBase();
    const out = expandSeriesEvents([ev], [dailySeriesRow()], baseDay, addDays(baseDay, 4));
    // Base day + 3 following days = 4 occurrence chips; base row is NOT kept.
    expect(out).toHaveLength(4);
    expect(out.every((c) => c.startMs !== ev.startMs || out.indexOf(c) === 0)).toBe(true);
    // Consecutive-day wall-clock starts at the same time of day.
    const first = out[0]!.startMs;
    const second = out[1]!.startMs;
    expect(second - first).toBe(86_400_000);
  });
});

// ---------------------------------------------------------------------------
// 2. Glyph + tooltip on every occurrence chip; override/cancelled handling
// ---------------------------------------------------------------------------

describe("DC-12 render: occurrence chips carry glyph + tooltip, honour overrides", () => {
  test("every rendered occurrence chip has the 🔁 glyph and a 'Recurring' tooltip", async () => {
    const { ev, baseDay } = dailyBase();
    events = [ev];
    seriesRows = [dailySeriesRow()];
    await renderCalendar();
    const grid = byId.get("calendar-grid")!;
    for (let i = 0; i < 4; i++) {
      const chips = chipsIn(columnFor(grid, addDays(baseDay, i)));
      expect(chips.length).toBe(1);
      const chip = chips[0]!;
      const glyph = chip.querySelector(".recurrence-glyph");
      expect(glyph, `glyph on day +${i}`).toBeDefined();
      expect(glyph!.textContent).toBe("🔁");
      expect(glyph!.title.startsWith("Recurring — ")).toBe(true);
      expect(chip.title.startsWith("Recurring — ")).toBe(true);
    }
  });

  test("cancelled occurrence renders NO chip", async () => {
    const { ev, baseDay } = dailyBase();
    events = [ev];
    const cancelledId = `${baseDay.getFullYear()}${String(baseDay.getMonth() + 1).padStart(2, "0")}${String(baseDay.getDate() + 1).padStart(2, "0")}T100000`;
    seriesRows = [
      dailySeriesRow([{ recurrenceId: cancelledId, cancelled: true, title: null, startWall: null, endWall: null, tzId: null }]),
    ];
    await renderCalendar();
    const grid = byId.get("calendar-grid")!;
    expect(chipsIn(columnFor(grid, baseDay))).toHaveLength(1); // base day fine
    expect(chipsIn(columnFor(grid, addDays(baseDay, 1)))).toHaveLength(0); // cancelled
    expect(chipsIn(columnFor(grid, addDays(baseDay, 2)))).toHaveLength(1); // resumes
  });

  test("edited (moved) occurrence renders with override fields and ✎ marker", async () => {
    const { ev, baseDay } = dailyBase();
    events = [ev];
    const occId = `${baseDay.getFullYear()}${String(baseDay.getMonth() + 1).padStart(2, "0")}${String(baseDay.getDate() + 1).padStart(2, "0")}T100000`;
    // Move the second occurrence one day later with a new title.
    const moved = addDays(baseDay, 2);
    const movedStart = new Date(moved.getFullYear(), moved.getMonth(), moved.getDate(), 15, 0, 0, 0);
    const startWall = `${moved.getFullYear()}-${String(moved.getMonth() + 1).padStart(2, "0")}-${String(moved.getDate()).padStart(2, "0")}T15:00`;
    seriesRows = [
      dailySeriesRow([
        {
          recurrenceId: occId,
          cancelled: false,
          title: "Standup (moved)",
          startWall,
          endWall: null,
          tzId: null,
        },
      ]),
    ];
    await renderCalendar();
    const grid = byId.get("calendar-grid")!;
    // Original slot: no chip.
    expect(chipsIn(columnFor(grid, addDays(baseDay, 1)))).toHaveLength(0);
    // New slot: the moved chip (override title) + the native day+2 occurrence.
    const movedChips = chipsIn(columnFor(grid, addDays(baseDay, 2))).filter(
      (c) => c.textContent.includes("Standup (moved)"),
    );
    expect(movedChips).toHaveLength(1);
    expect(movedChips[0]!.querySelector(".override-marker")).toBeDefined();
    void movedStart;
  });
});

// ---------------------------------------------------------------------------
// 3. Until date picker auto-closes like the Day picker
// ---------------------------------------------------------------------------

describe("DC-12 render: Until picker auto-close wiring", () => {
  test("focus adds .until-picking; change blurs the field and removes it", () => {
    const dlg = byId.get("event-dialog")!;
    const until = byId.get("ev-until")!;
    let blurs = 0;
    until.blur = () => {
      blurs++;
    };

    until.dispatch("focus");
    expect(dlg.classList.contains("until-picking")).toBe(true);

    until.value = "2026-09-15";
    until.dispatch("change");
    expect(blurs).toBe(1); // auto-blur closes the WebKit popover
    expect(dlg.classList.contains("until-picking")).toBe(false);
  });

  test("blur alone clears the .until-picking state", () => {
    const dlg = byId.get("event-dialog")!;
    const until = byId.get("ev-until")!;
    until.dispatch("focus");
    expect(dlg.classList.contains("until-picking")).toBe(true);
    until.dispatch("blur");
    expect(dlg.classList.contains("until-picking")).toBe(false);
  });
});
