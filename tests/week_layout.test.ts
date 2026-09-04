// Week-view layout regression tests (owner requests, 2026-08-30):
//   1. An ALL-DAY appointment renders in the lane on EVERY day it spans
//      (start..end), not just its first day (Outlook semantics).
//   2. Overlapping TIMED appointments are displayed SIDE BY SIDE (column
//      splitting), not stacked on top of each other.
// Reuses the minimal DOM stub pattern from month_view_clicks.test.ts.
import { describe, expect, test, beforeEach, afterEach } from "vitest";
import { render as renderCalendar } from "../frontend/calendar.ts";
import { setViewMode } from "../frontend/calendar.ts";
import type { CalendarEvent, EventStoreBridge } from "../frontend/store.ts";

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
  toggle(c: string, force?: boolean) {
    const s = this.list();
    const on = force ?? !s.has(c);
    if (on) s.add(c);
    else s.delete(c);
    this.write(s);
    return on;
  }
  contains(c: string) {
    return this.list().has(c);
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
  shown = false;
  closed = false;
  draggable = false;
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
  remove() {
    if (this.parentElement) {
      const i = this.parentElement.children.indexOf(this);
      if (i !== -1) this.parentElement.children.splice(i, 1);
    }
    this.parentElement = null;
    allElements.delete(this);
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
    const cls = sel.replace(/^\./, "").replace(/\./g, " ");
    while (el) {
      const want = cls.split(" ");
      if (want.every((c) => el!.classList.contains(c))) return el;
      el = el.parentElement;
    }
    return null;
  }
  querySelector(sel: string): DomEl | null {
    const id = sel.replace(/^#/, "");
    if (!byId.has(id)) byId.set(id, new DomEl("div"));
    return byId.get(id)!;
  }
  querySelectorAll(sel: string): DomEl[] {
    const cls = sel.replace(/^\./, "").split(".");
    return Array.from(allElements).filter((el) =>
      cls.every((c) => el.classList.contains(c)),
    );
  }
  getBoundingClientRect() {
    // Week columns report a fixed geometry so drop mapping is testable.
    return { top: 0, left: 0, bottom: 1440, right: 100, width: 100, height: 1440 };
  }
  showModal() { this.shown = true; }
  close() { this.closed = true; this.shown = false; }
  blur() {}
  focus() {}
}

function fire(type: string, detail: unknown): void {
  for (const fn of docListeners.get(type) ?? []) fn({ detail });
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
    dispatchEvent: (e: { type: string; detail: unknown }) => fire(e.type, e.detail),
  };
  (globalThis as { document?: unknown }).document = doc;
}

let events: CalendarEvent[] = [];
function installBridge(): void {
  const bridge: EventStoreBridge = {
    listEvents: () => events.slice(),
    createEvent() { throw new Error("not used"); },
    updateEvent() { throw new Error("not used"); },
    deleteEvent() {},
    listSeries: () => [],
  };
  (globalThis as { window?: unknown }).window = { __TIDE_EVENT_STORE__: bridge };
}

const prevDoc = (globalThis as { document?: unknown }).document;
const prevWin = (globalThis as { window?: unknown }).window;

beforeEach(() => {
  installDom();
  installBridge();
  events = [];
});

afterEach(() => {
  (globalThis as { document?: unknown }).document = prevDoc;
  (globalThis as { window?: unknown }).window = prevWin;
});

async function renderWeek(): Promise<DomEl> {
  setViewMode("week");
  await renderCalendar();
  return byId.get("calendar-grid")!;
}

function dayColumns(grid: DomEl): DomEl[] {
  return grid.children.filter((c) => c.classList.contains("day-col"));
}

function chipsIn(root: DomEl): DomEl[] {
  return root.querySelectorAll(".chip");
}

// Anchor "today" into the current Monday-based week so the events land in
// the rendered range regardless of the test's run date.
function dayThisWeek(offsetFromMonday: number, hour: number): { startMs: number; endMs: number; dayStartMs: number } {
  const now = new Date();
  const dow = (now.getDay() + 6) % 7;
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - dow);
  const d = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + offsetFromMonday, hour, 0, 0, 0);
  const dayStart = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + offsetFromMonday, 0, 0, 0, 0);
  return { startMs: d.getTime(), endMs: d.getTime() + 3_600_000, dayStartMs: dayStart.getTime() };
}

// ---------------------------------------------------------------------------
// 1. All-day events span their full range
// ---------------------------------------------------------------------------

describe("week view: all-day appointment spans every day of its range", () => {
  test("an all-day event covering Mon..Wed renders a chip in 3 columns", async () => {
    const mon = dayThisWeek(0, 0);
    // all-day: start 00:00 Monday, end 00:00 Thursday (=3 days)
    const startMs = mon.dayStartMs;
    const endMs = mon.dayStartMs + 3 * 86_400_000;
    events = [{
      id: "evt-allday3", title: "Offsite", description: "",
      startMs, endMs, allDay: true,
    }];
    const grid = await renderWeek();

    // Lane chips on exactly the 3 covered days
    const laneChips = chipsIn(grid).filter((c) =>
      c.classList.contains("chip-allday") && c.classList.contains("lane-chip"),
    );
    expect(laneChips.length).toBe(3);

    // And NO timed block for it anywhere (all-day never paints into the grid)
    const timedForAllDay = chipsIn(grid).filter(
      (c) => c.classList.contains("chip-timed") && c.dataset.eventId === "evt-allday3",
    );
    expect(timedForAllDay.length).toBe(0);
  });

  test("a single-day all-day event renders exactly one lane chip", async () => {
    const mon = dayThisWeek(0, 0);
    events = [{
      id: "evt-allday1", title: "Holiday", description: "",
      startMs: mon.dayStartMs, endMs: mon.dayStartMs + 86_400_000, allDay: true,
    }];
    const grid = await renderWeek();
    const laneChips = chipsIn(grid).filter(
      (c) => c.classList.contains("chip-allday"),
    );
    expect(laneChips.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 2. Overlapping timed events sit side by side (Outlook semantics)
// ---------------------------------------------------------------------------

describe("week view: overlapping timed appointments render side by side", () => {
  test("two overlapping events get DIFFERENT horizontal positions", async () => {
    const t = dayThisWeek(2, 9); // Wednesday 09:00
    events = [
      { id: "evt-a", title: "A", description: "", startMs: t.startMs, endMs: t.endMs, allDay: false },
      // B overlaps A (starts 30 min into A's 1h window)
      { id: "evt-b", title: "B", description: "", startMs: t.startMs + 1_800_000, endMs: t.startMs + 2 * 3_600_000, allDay: false },
    ];
    const grid = await renderWeek();
    const chips = chipsIn(grid).filter((c) => c.classList.contains("chip-timed"));
    expect(chips.length).toBe(2);

    // Side-by-side = distinct left offsets (width narrowing is the mechanism)
    const lefts = chips.map((c) => c.style.left ?? "");
    const widths = chips.map((c) => c.style.width ?? "");
    expect(new Set(lefts).size).toBe(2);      // two distinct columns
    expect(new Set(widths).size).toBeGreaterThanOrEqual(1); // narrowed
    // Neither chip spans the full column width anymore
    for (const w of widths) {
      expect(w === "100%" || w === "").toBe(false);
    }
  });

  test("non-overlapping events keep the full column width", async () => {
    const t = dayThisWeek(2, 9);
    events = [
      { id: "evt-a", title: "A", description: "", startMs: t.startMs, endMs: t.endMs, allDay: false },
      { id: "evt-b", title: "B", description: "", startMs: t.startMs + 3_600_000, endMs: t.startMs + 2 * 3_600_000, allDay: false },
    ];
    const grid = await renderWeek();
    const chips = chipsIn(grid).filter((c) => c.classList.contains("chip-timed"));
    expect(chips.length).toBe(2);
    for (const c of chips) {
      // full width (or unset -> CSS default) and left edge at 0
      expect(c.style.left === "0%" || c.style.left === "" || c.style.left === undefined).toBe(true);
    }
  });

  test("a triple overlap (three events sharing a common minute) splits into three columns", async () => {
    const t = dayThisWeek(3, 14);
    // All three genuinely overlap: each starts 15 min apart, lasts 1h, so
    // minutes 15-60 are covered by all three -> cluster depth 3.
    events = [0, 1, 2].map((i) => ({
      id: `evt-${i}`, title: `E${i}`, description: "",
      startMs: t.startMs + i * 900_000,
      endMs: t.startMs + i * 900_000 + 3_600_000,
      allDay: false,
    }));
    const grid = await renderWeek();
    const chips = chipsIn(grid).filter((c) => c.classList.contains("chip-timed"));
    expect(chips.length).toBe(3);
    const lefts = new Set(chips.map((c) => c.style.left ?? ""));
    expect(lefts.size).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// 3. Whole-day banner: full-height grid banner + lane chip (owner round 2)
// ---------------------------------------------------------------------------

describe("week view: whole-day appointment paints a full-height grid banner", () => {
  test("all-day event renders lane chip AND an .allday-banner per covered day", async () => {
    const mon = dayThisWeek(0, 0);
    events = [{
      id: "evt-allday-b", title: "Offsite", description: "",
      startMs: mon.dayStartMs, endMs: mon.dayStartMs + 2 * 86_400_000, allDay: true,
    }];
    const grid = await renderWeek();
    const cols = dayColumns(grid);
    const covered = cols.filter((c) =>
      c.children.some((ch) => ch.classList.contains("chip-allday")),
    );
    expect(covered.length).toBe(2); // Mon + Tue
    for (const c of covered) {
      const banners = c.children.filter((ch) =>
        ch.classList.contains("allday-banner"),
      );
      expect(banners.length).toBe(1);
      expect(banners[0]!.textContent).toBe("Offsite");
    }
    // Non-covered columns have no banner
    const uncovered = cols.filter((c) => !covered.includes(c));
    for (const c of uncovered) {
      expect(
        c.children.some((ch) => ch.classList.contains("allday-banner")),
      ).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Drag ghost: live time feedback (owner round 2)
// ---------------------------------------------------------------------------

describe("week view: drag ghost shows the live snapped target time", () => {
  test("dragover renders a .drag-ghost labeled with the snapped range", async () => {
    const t = dayThisWeek(2, 9);
    events = [
      { id: "evt-a", title: "A", description: "", startMs: t.startMs, endMs: t.endMs, allDay: false },
    ];
    const grid = await renderWeek();
    const chip = chipsIn(grid).find((c) => c.dataset.eventId === "evt-a")!;
    expect(chip).toBeTruthy();

    // Simulate dragstart, then a dragover 25% down a column (09:00 day → 06:00).
    // The doc-level dragover listener fires with target inside the column.
    chip.dispatch("dragstart");
    const col = dayColumns(grid)[2]!;
    const dragEvt = {
      target: col,
      clientY: 0.25 * 1440, // matches the stub's 1440px column height
      preventDefault() {},
    };
    for (const fn of docListeners.get("dragover") ?? []) fn(dragEvt);

    const ghost = Array.from(allElements).find((el) =>
      el.classList.contains("drag-ghost"),
    );
    expect(ghost).toBeTruthy();
    expect(ghost!.textContent).toBe("06:00 – 07:00"); // snapped + duration kept
    // Ghost is a child of the hovered column
    expect(ghost!.parentElement).toBe(col);

    // dragend cleans up
    chip.dispatch("dragend");
    const after = Array.from(allElements).find((el) =>
      el.classList.contains("drag-ghost"),
    );
    expect(after).toBeUndefined();
  });
});
