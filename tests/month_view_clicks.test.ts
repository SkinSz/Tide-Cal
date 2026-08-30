// DOM-level regression tests for the owner UX contract on the calendar grid:
//   * double-click an empty MONTH day        -> create dialog opens (tide:neweventat)
//   * single-click a chip (month AND week)   -> SELECT only (tide:eventselect, no dialog)
//   * double-click a chip (month AND week)   -> edit dialog opens (tide:eventclick)
// Regression source: month dayColumn never had a dblclick handler (week hour
// bands got one in 5e0524b), and chips wired single-click straight to
// tide:eventclick (dialog open). No real DOM lib in the repo, so this uses a
// minimal in-file DOM stub exercising the real calendar.ts + dialog.ts code.
import { describe, expect, test, beforeEach, afterEach } from "vitest";
import { render as renderCalendar } from "../frontend/calendar.ts";
import { initDialog } from "../frontend/dialog.ts";
import type { CalendarEvent, EventStoreBridge } from "../frontend/store.ts";

// ---------------------------------------------------------------------------
// Minimal DOM stub
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
    return { top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0 };
  }
  showModal() {
    this.shown = true;
  }
  close() {
    this.closed = true;
    this.shown = false;
  }
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

// ---------------------------------------------------------------------------
// Store bridge stub
// ---------------------------------------------------------------------------

let events: CalendarEvent[] = [];

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
  setViewMode("month"); // undo any view-mode leak from a previous test
  initDialog();
});

afterEach(() => {
  (globalThis as { document?: unknown }).document = prevDoc;
  (globalThis as { window?: unknown }).window = prevWin;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function renderMonth(): Promise<DomEl> {
  await renderCalendar();
  return byId.get("calendar-grid")!;
}

// Pkg6 (date-flake fix, test-only): reset the shared view mode — the calendar
// module keeps `viewMode` module state, so the week-view test leaks "week"
// into later tests that call renderMonth() expecting a month grid.
const { setViewMode } = await import("../frontend/calendar.ts");

function dayColumns(grid: DomEl): DomEl[] {
  return grid.children.filter((c) => c.classList.contains("day-col"));
}

function chipsIn(root: DomEl): DomEl[] {
  return root.querySelectorAll(".chip");
}

function capture(types: string[]): Map<string, unknown[]> {
  const got = new Map<string, unknown[]>(types.map((t) => [t, []]));
  for (const t of types) {
    const sink = got.get(t)!;
    const fn: Listener = (e) => sink.push((e as { detail: unknown }).detail);
    // Additive: existing listeners (e.g. the dialog's) must keep firing.
    if (!docListeners.has(t)) docListeners.set(t, new Set());
    docListeners.get(t)!.add(fn);
  }
  return got;
}

function evt(title: string, dayOffset = 0): CalendarEvent {
  // Pkg6 (date-flake fix, test-only): anchor to TODAY but clamp the
  // day-of-month so today+dayOffset (max 1) can never walk across the month
  // boundary. The old `setDate(getDate()+dayOffset)` walked into the next
  // month whenever "today" was the last day(s) of a month, so the month grid
  // rendered fewer chips than asserted and the exclusivity test failed with
  // "expected 1 to be 2" — a documented pre-existing flake. Clamping keeps
  // every generated event inside the current month (deterministic on any
  // date, including month ends and February) while keeping event-0 anchored
  // to today, which the week-view assertions rely on (Monday-based week).
  const now = new Date();
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const day = Math.min(now.getDate(), daysInMonth - 1);
  const d = new Date(now.getFullYear(), now.getMonth(), day + dayOffset, 10, 0, 0, 0);
  const start = d.getTime();
  return {
    id: `evt-${title}`,
    title,
    description: "",
    startMs: start,
    endMs: start + 3_600_000,
    allDay: false,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("month view: double-click empty day opens the create dialog", () => {
  test("dblclick on an empty day column fires tide:neweventat for that day", async () => {
    await renderMonth();
    const got = capture(["tide:neweventat", "tide:eventclick"]);
    const col = dayColumns(byId.get("calendar-grid")!)[10]!; // some day cell
    expect(chipsIn(col)).toHaveLength(0);

    col.dispatch("dblclick");

    expect(got.get("tide:neweventat")).toHaveLength(1);
    const iso = got.get("tide:neweventat")![0] as string;
    expect(new Date(iso).toISOString().slice(0, 10)).toBe(col.dataset.date);
    expect(got.get("tide:eventclick")).toHaveLength(0); // create, not edit
  });

  test("tide:neweventat opens the event dialog in create mode", async () => {
    await renderMonth();
    const col = dayColumns(byId.get("calendar-grid")!)[10]!;
    col.dispatch("dblclick");
    // Dialog layer reacts to the same event the grid just fired:
    fire("tide:neweventat", col.dataset.date);

    const dlg = byId.get("event-dialog")!;
    expect(dlg.shown).toBe(true);
    expect(byId.get("dialog-title")!.textContent).toBe("New event");
    expect(byId.get("ev-id")!.value).toBe("");
    expect(byId.get("ev-date")!.value).toBe(col.dataset.date);
  });

  test("single click on an empty day only selects (tide:dayclick), no dialog", async () => {
    await renderMonth();
    const got = capture(["tide:dayclick", "tide:neweventat"]);
    const col = dayColumns(byId.get("calendar-grid")!)[11]!;
    col.dispatch("click");
    expect(got.get("tide:dayclick")).toHaveLength(1);
    expect(got.get("tide:neweventat")).toHaveLength(0);
    expect(byId.get("event-dialog")!.shown).toBe(false);
  });
});

describe("chips: single-click selects, double-click opens (month + week)", () => {
  test("month chip: single click selects only — no edit dialog", async () => {
    events = [evt("Lunch")];
    await renderMonth();
    const got = capture(["tide:eventselect", "tide:eventclick"]);
    const chip = chipsIn(byId.get("calendar-grid")!)[0]!;

    chip.dispatch("click");

    expect(got.get("tide:eventselect")).toHaveLength(1);
    expect((got.get("tide:eventselect")![0] as CalendarEvent).id).toBe("evt-Lunch");
    expect(got.get("tide:eventclick")).toHaveLength(0);
    expect(chip.classList.contains("chip-selected")).toBe(true);
    expect(byId.get("event-dialog")!.shown).toBe(false);
  });

  test("month chip: double click opens the edit dialog", async () => {
    events = [evt("Lunch")];
    await renderMonth();
    const got = capture(["tide:eventclick"]);
    const chip = chipsIn(byId.get("calendar-grid")!)[0]!;

    chip.dispatch("dblclick");

    expect(got.get("tide:eventclick")).toHaveLength(1);
    fire("tide:eventclick", got.get("tide:eventclick")![0]);
    expect(byId.get("event-dialog")!.shown).toBe(true);
    expect(byId.get("dialog-title")!.textContent).toBe("Edit event");
    expect(byId.get("ev-id")!.value).toBe("evt-Lunch");
  });

  test("week chip: single click selects only; double click opens", async () => {
    // Flip to week view through the same module the UI uses.
    const { setViewMode } = await import("../frontend/calendar.ts");
    setViewMode("week");
    events = [evt("Timed"), evt("AllDay", 1)];
    await renderMonth(); // renders the CURRENT mode = week

    const got = capture(["tide:eventselect", "tide:eventclick"]);
    const chips = chipsIn(byId.get("calendar-grid")!);
    expect(chips.length).toBeGreaterThanOrEqual(1);

    for (const chip of chips) {
      chip.dispatch("click");
      expect(chip.classList.contains("chip-selected")).toBe(true);
    }
    expect(got.get("tide:eventclick")).toHaveLength(0);
    expect(got.get("tide:eventselect")!.length).toBe(chips.length);

    chips[0]!.dispatch("dblclick");
    expect(got.get("tide:eventclick")).toHaveLength(1);
    fire("tide:eventclick", got.get("tide:eventclick")![0]);
    expect(byId.get("event-dialog")!.shown).toBe(true);
    expect(byId.get("dialog-title")!.textContent).toBe("Edit event");
  });

  test("selection is exclusive: selecting one chip deselects the other", async () => {
    events = [evt("A"), evt("B", 1)];
    await renderMonth();
    const chips = chipsIn(byId.get("calendar-grid")!);
    expect(chips.length).toBe(2);

    chips[0]!.dispatch("click");
    chips[1]!.dispatch("click");
    expect(chips[0]!.classList.contains("chip-selected")).toBe(false);
    expect(chips[1]!.classList.contains("chip-selected")).toBe(true);
  });
});
