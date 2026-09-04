// TD-016 — Unchecking "Repeat" on a series must NOT delete the series.
// Owner decision (2026-09-02, binding): unchecking "Repeat" + Save means
// "END RECURRENCE AT THIS POINT":
//   1. nothing is deleted (no deleteEvent on the series, no tombstones);
//   2. past occurrences remain untouched;
//   3. the series terminates at the edited occurrence (rule UNTIL = the
//      edited occurrence's ORIGINAL start date);
//   4. the edited occurrence survives as a standalone single event carrying
//      the user's edits;
//   5. whole-series deletion remains ONLY the explicit delete path (two-step
//      confirm), unchanged.
import { describe, expect, test, beforeEach, afterEach } from "vitest";
import { expandSeriesEvents } from "../frontend/calendar.ts";
import { initDialog } from "../frontend/dialog.ts";
import type {
  CalendarEvent,
  EventInput,
  EventStoreBridge,
  SeriesRow,
} from "../frontend/store.ts";
import { expandOccurrences } from "../src/domain/recurrence_conflicts.ts";

// ---------------------------------------------------------------------------
// Minimal DOM stub (same shape as tests/dc12_render.test.ts)
// ---------------------------------------------------------------------------

type Listener = (e: unknown) => void;

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
    const on = force ?? !this.list().has(c);
    if (on) this.add(c);
    else this.remove(c);
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
  shown = false;
  listeners = new Map<string, Set<Listener>>();

  constructor(public tagName = "div") {
    this.classList = new ClassList(this);
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
  dispatch(type: string): void {
    const e = { target: this, stopPropagation() {} };
    for (const fn of this.listeners.get(type) ?? []) fn(e);
  }
  after(node: DomEl) {
    this.parentElement?.appendChild(node);
  }
  remove() {
    const p = this.parentElement;
    if (p) p.children = p.children.filter((c) => c !== this);
    this.parentElement = null;
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
    if (sel.includes("option")) return new DomEl("option"); // ev-repeat NONE option
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
  scrollIntoView() {}
  getBoundingClientRect() {
    return { top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0 };
  }
  showModal() {
    this.shown = true;
  }
  close() {
    this.shown = false;
  }
  blur() {}
  focus() {}
}

function installDom(): void {
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
// Store bridge stub that RECORDS every write
// ---------------------------------------------------------------------------

interface Calls {
  updates: Array<{ id: string; input: EventInput }>;
  deletes: string[];
  ruleUpdates: Array<{ seriesId: string; rule: string }>;
  occurrencePatches: Array<{ seriesId: string; recurrenceId: string; patch: Record<string, unknown> }>;
}

let events: CalendarEvent[] = [];
let seriesRows: SeriesRow[] = [];
const calls: Calls = { updates: [], deletes: [], ruleUpdates: [], occurrencePatches: [] };

function installBridge(): void {
  const bridge: EventStoreBridge = {
    listEvents: () => events.slice(),
    createEvent() {
      throw new Error("TD-016 test: createEvent not used");
    },
    updateEvent(id: string, input: EventInput) {
      calls.updates.push({ id, input });
      const idx = events.findIndex((e) => e.id === id);
      if (idx !== -1) events[idx] = { id, ...input };
      return events[idx] ?? { id, ...input };
    },
    deleteEvent(id: string) {
      calls.deletes.push(id);
      events = events.filter((e) => e.id !== id);
    },
    listSeries: () => seriesRows.map((s) => ({ ...s, overrides: s.overrides.map((o) => ({ ...o })) })),
    // Optional DC-12 write hooks:
    updateSeriesRule(seriesId: string, rule: string) {
      calls.ruleUpdates.push({ seriesId, rule });
      const row = seriesRows.find((s) => s.seriesId === seriesId);
      if (row) row.recurrenceRule = rule;
      return Promise.resolve({ seriesId, recurrenceRule: rule });
    },
    updateOccurrence(seriesId: string, recurrenceId: string, patch: Record<string, unknown>) {
      calls.occurrencePatches.push({ seriesId, recurrenceId, patch });
      return Promise.resolve({ seriesId, recurrenceId, changed: [] });
    },
  } as unknown as EventStoreBridge;
  (globalThis as { window?: unknown }).window = {
    __TIDE_EVENT_STORE__: bridge,
    setTimeout,
    clearTimeout,
  };
}

const prevDoc = (globalThis as { document?: unknown }).document;
const prevWin = (globalThis as { window?: unknown }).window;

beforeEach(() => {
  installDom();
  installBridge();
  events = [];
  seriesRows = [];
  calls.updates = [];
  calls.deletes = [];
  calls.ruleUpdates = [];
  calls.occurrencePatches = [];
  initDialog();
});

afterEach(() => {
  (globalThis as { document?: unknown }).document = prevDoc;
  (globalThis as { window?: unknown }).window = prevWin;
});

// ---------------------------------------------------------------------------
// Fixture: a DAILY series anchored 2026-09-02 10:00 local, ending 2026-12-31
// ---------------------------------------------------------------------------

const BASE_ID = "evt-series";
const BASE_RULE = "FREQ=DAILY;UNTIL=20261231";

function baseEvent(): CalendarEvent {
  const start = new Date(2026, 8, 2, 10, 0, 0, 0).getTime();
  return {
    id: BASE_ID,
    title: "Standup",
    description: "",
    startMs: start,
    endMs: start + 3_600_000,
    allDay: false,
  };
}

function seriesRow(): SeriesRow {
  return {
    seriesId: "ser-1",
    baseEventId: BASE_ID,
    recurrenceRule: BASE_RULE,
    overrides: [],
  };
}

/** Open the edit dialog on the series base event and let the async series lookup settle. */
async function openSeriesDialog(): Promise<void> {
  const ev = baseEvent();
  events = [ev];
  seriesRows = [seriesRow()];
  for (const fn of docListeners.get("tide:eventclick") ?? []) {
    fn({ detail: ev });
  }
  await new Promise((r) => setTimeout(r, 0));
}

/** Uncheck "Repeat" (the checkbox), retitle, and click Save. */
async function uncheckAndSave(newTitle: string): Promise<void> {
  byId.get("ev-repeat-on")!.checked = false;
  byId.get("ev-repeat-on")!.dispatch("change");
  byId.get("ev-title")!.value = newTitle;
  byId.get("ev-save")!.dispatch("click");
  await new Promise((r) => setTimeout(r, 0));
}

/**
 * Pkg8 review F2: open the dialog on a rendered CHIP that is NOT the series
 * base — the F1 regression window. The old code (pre-F1-fix) seeded ev-date
 * from the chip's start, so uncheck+Save moved the base anchor and every
 * earlier occurrence vanished. These tests pin the fix.
 */
async function openChipDialogOn(_dateCtorArgs: [number, number, number], chipTitle: string): Promise<void> {
  const ev = baseEvent();
  events = [ev];
  seriesRows = [seriesRow()];
  // Render the whole month (winHi is computed from rangeEnd - 1ms, so a
  // one-day window would exclude its own end date).
  const chips = expandSeriesEvents([ev], seriesRows, new Date(2026, 8, 1), new Date(2026, 8, 30));
  const chip = chips.find(
    (c) =>
      c.title === chipTitle &&
      new Date(c.startMs).getDate() === _dateCtorArgs[2],
  );
  if (!chip) throw new Error("chip not rendered");
  for (const fn of docListeners.get("tide:eventclick") ?? []) {
    fn({ detail: chip });
  }
  await new Promise((r) => setTimeout(r, 0));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("TD-016: unchecking Repeat + Save ends recurrence — nothing is deleted", () => {
  test("no deleteEvent, no occurrence tombstones; rule UNTIL = edited occurrence's original start", async () => {
    await openSeriesDialog();
    await uncheckAndSave("Standup (edited)");

    // Nothing is deleted — ever — on the uncheck path.
    expect(calls.deletes).toEqual([]);

    // No tombstones / overrides written for past occurrences either.
    expect(calls.occurrencePatches).toEqual([]);
    expect(seriesRows[0]!.overrides).toEqual([]);

    // The series rule is terminated at the edited occurrence's ORIGINAL
    // start date (2026-09-02), inclusive.
    expect(calls.ruleUpdates).toEqual([
      { seriesId: "ser-1", rule: "FREQ=DAILY;UNTIL=20260902" },
    ]);
  });

  test("past occurrences remain intact after uncheck + save", async () => {
    await openSeriesDialog();
    await uncheckAndSave("Standup (edited)");

    const rule = seriesRows[0]!.recurrenceRule;
    const base = "2026-09-02T10:00";
    // Window covering the whole original series span: occurrences still
    // exist up to and including the edit point.
    const ids = expandOccurrences(
      { series_id: "ser-1", base_start_wall: base, tz_id: "local", recurrence_rule: rule },
      "20260902T000000",
      "20261231T235959",
    );
    expect(ids.length).toBeGreaterThanOrEqual(1);
    expect(ids[0]!.slice(0, 8)).toBe("20260902");
    // Past occurrences (between base and the edit point) — here the edit
    // point IS the base day, so every occurrence the terminated rule still
    // generates must be on or before it.
    for (const id of ids) expect(id.slice(0, 8) <= "20260902").toBe(true);
  });

  test("no occurrences after the edit point", async () => {
    await openSeriesDialog();
    await uncheckAndSave("Standup (edited)");

    const rule = seriesRows[0]!.recurrenceRule;
    const base = "2026-09-02T10:00";
    // The day AFTER the edit point yields nothing, out to the old UNTIL.
    const after = expandOccurrences(
      { series_id: "ser-1", base_start_wall: base, tz_id: "local", recurrence_rule: rule },
      "20260903T000000",
      "20261231T235959",
    );
    expect(after).toEqual([]);
  });

  test("the edited occurrence survives as a standalone single event carrying the edits", async () => {
    await openSeriesDialog();
    await uncheckAndSave("Standup (edited)");

    // The base event row was updated (not deleted) with the user's edits.
    expect(calls.updates).toHaveLength(1);
    expect(calls.updates[0]!.id).toBe(BASE_ID);
    expect(calls.updates[0]!.input.title).toBe("Standup (edited)");
    expect(events.map((e) => e.id)).toContain(BASE_ID);
    expect(events.find((e) => e.id === BASE_ID)!.title).toBe("Standup (edited)");

    // Rendered: exactly ONE chip (the terminating occurrence at the edit
    // point) — the base event is preserved, nothing duplicated.
    const ev = events.find((e) => e.id === BASE_ID)!;
    const winStart = new Date(2026, 8, 1);
    const winEnd = new Date(2026, 8, 30);
    const chips = expandSeriesEvents([ev], seriesRows, winStart, winEnd);
    expect(chips).toHaveLength(1);
    expect(chips[0]!.title).toBe("Standup (edited)");
    expect(chips[0]!.startMs).toBe(new Date(2026, 8, 2, 10, 0, 0, 0).getTime());
  });
});

describe("Pkg8 F1/F2 regression: uncheck+Save from a NON-BASE chip keeps the anchor", () => {
  test("base anchor untouched — all occurrences before the edit point survive", async () => {
    // Open on the Sep 10 chip (NOT the base Sep 2). The base event's start
    // must remain 2026-09-02; the rule terminates at Sep 10.
    await openChipDialogOn([2026, 8, 10], "Standup");
    await uncheckAndSave("Standup (edited)");

    // No delete, ever.
    expect(calls.deletes).toEqual([]);

    // The base event row KEEPS its original start (anchor untouchable).
    expect(calls.updates).toHaveLength(1);
    expect(calls.updates[0]!.id).toBe(BASE_ID);
    expect(calls.updates[0]!.input.startMs).toBe(
      new Date(2026, 8, 2, 10, 0, 0, 0).getTime(),
    );

    // Rule terminates at the CHIP's occurrence date (Sep 10), inclusive.
    expect(calls.ruleUpdates).toEqual([
      { seriesId: "ser-1", rule: "FREQ=DAILY;UNTIL=20260910" },
    ]);

    // Full re-expansion: every occurrence from base through the edit point
    // survives (Sep 2 .. Sep 10 = 9 occurrences), nothing after.
    const rule = seriesRows[0]!.recurrenceRule;
    const ids = expandOccurrences(
      { series_id: "ser-1", base_start_wall: "2026-09-02T10:00", tz_id: "local", recurrence_rule: rule },
      "20260902T000000",
      "20261231T235959",
    );
    expect(ids).toHaveLength(9);
    expect(ids[0]!.slice(0, 8)).toBe("20260902");
    expect(ids[8]!.slice(0, 8)).toBe("20260910");
  });

  test("time edits on the non-base chip are preserved via the ORIGINAL occurrence id (R2)", async () => {
    await openChipDialogOn([2026, 8, 10], "Standup");
    // Change the time (start-ms differs from the chip) before uncheck+Save.
    byId.get("ev-start-t")!.value = "11:30";
    await uncheckAndSave("Standup (edited)");

    // The terminating occurrence carries the user's schedule edits as an
    // override keyed by its ORIGINAL recurrence id — never a phantom key.
    expect(calls.occurrencePatches).toHaveLength(1);
    expect(calls.occurrencePatches[0]!.recurrenceId).toBe("20260910T100000");
    expect(calls.occurrencePatches[0]!.patch.start_wall).toBe("2026-09-10T11:30");
  });
});

describe("TD-016: whole-series delete remains ONLY the explicit two-step delete path", () => {
  test("delete requires the second (confirm) click, then tombstones the whole series", async () => {
    await openSeriesDialog();

    // First click: arms the confirm — nothing deleted yet.
    byId.get("ev-delete")!.dispatch("click");
    await new Promise((r) => setTimeout(r, 0));
    expect(calls.deletes).toEqual([]);

    // Second click: executes the whole-series delete (D7).
    byId.get("ev-delete")!.dispatch("click");
    await new Promise((r) => setTimeout(r, 0));
    expect(calls.deletes).toEqual([BASE_ID]);
    // The delete path must not go through update/rule edits.
    expect(calls.updates).toEqual([]);
    expect(calls.ruleUpdates).toEqual([]);
    expect(events.map((e) => e.id)).not.toContain(BASE_ID);
  });
});
