// Reminder rows in the event dialog: the "Remind me" option is
// HIDDEN for whole-day events, saving a whole-day event leaves existing reminders
// untouched and writes no reminder change, and the "N reminders" notice is shown
// whenever the option is offered (it reappears when "Whole day" is unticked).
// Same DOM stub as tests/recurrence_uncheck.test.ts; the reminder store calls are
// recorded by a partial mock of frontend/store.ts.
import { describe, expect, test, beforeEach, afterEach, vi } from "vitest";

const rem = vi.hoisted(() => ({
  get: null as null | { minutesBefore: number; enabled: boolean; count?: number },
  sets: [] as Array<[string, number]>,
  clears: [] as string[],
}));
vi.mock("../frontend/store.ts", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    getReminder: async () => rem.get,
    setReminder: async (id: string, m: number) => { rem.sets.push([id, m]); },
    clearReminder: async (id: string) => { rem.clears.push(id); },
  };
});
import { initDialog } from "../frontend/dialog.ts";
import type { CalendarEvent, EventInput, EventStoreBridge } from "../frontend/store.ts";

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


let events: CalendarEvent[] = [];
const updates: Array<{ id: string; input: EventInput }> = [];

function installBridge(): void {
  const bridge = {
    listEvents: () => events.slice(),
    createEvent(input: EventInput) { return { id: "evt-new", ...input }; },
    updateEvent(id: string, input: EventInput) { updates.push({ id, input }); return { id, ...input }; },
    deleteEvent() {},
    listSeries: () => [],
  } as unknown as EventStoreBridge;
  (globalThis as { window?: unknown }).window = { __TIDE_EVENT_STORE__: bridge, setTimeout, clearTimeout };
}

const prevDoc = (globalThis as { document?: unknown }).document;
const prevWin = (globalThis as { window?: unknown }).window;
beforeEach(() => {
  installDom();
  installBridge();
  events = [];
  updates.length = 0;
  rem.get = null;
  rem.sets.length = 0;
  rem.clears.length = 0;
  initDialog();
});
afterEach(() => {
  (globalThis as { document?: unknown }).document = prevDoc;
  (globalThis as { window?: unknown }).window = prevWin;
});

function evt(allDay: boolean): CalendarEvent {
  const start = new Date(2027, 2, 2, allDay ? 0 : 9, 0).getTime();
  return { id: "evt-1", title: "T", description: "", startMs: start, endMs: start + (allDay ? 86_400_000 : 3_600_000), allDay };
}
async function openOn(ev: CalendarEvent): Promise<void> {
  events = [ev];
  for (const fn of docListeners.get("tide:eventclick") ?? []) fn({ detail: ev });
  await new Promise((r) => setTimeout(r, 0));
}
const noteHidden = (): boolean => byId.get("ev-remind-note")!.hidden;
const rowDisplay = (): string => byId.get("ev-remind-row")!.style.display ?? "";
async function toggleWholeDay(on: boolean): Promise<void> {
  byId.get("ev-allday")!.checked = on;
  byId.get("ev-allday")!.dispatch("change");
}
async function save(): Promise<void> {
  byId.get("ev-save")!.dispatch("click");
  await new Promise((r) => setTimeout(r, 0));
}

describe("reminder option in the event dialog", () => {
  test("the option is hidden for a whole-day event and shown for a timed one", async () => {
    await openOn(evt(true));
    expect(rowDisplay()).toBe("none");
    await openOn(evt(false));
    expect(rowDisplay()).toBe("");
  });

  test("saving a whole-day event leaves its existing reminder alone: no set, no clear", async () => {
    rem.get = { minutesBefore: 15, enabled: true, count: 1 };
    await openOn(evt(true));
    await save();
    expect(updates.length).toBe(1); // the save itself went through
    expect(rem.sets).toEqual([]);
    expect(rem.clears).toEqual([]);
  });

  test("ticking Whole day on a timed event and saving also leaves the reminder alone", async () => {
    rem.get = { minutesBefore: 15, enabled: true, count: 1 };
    await openOn(evt(false));
    await toggleWholeDay(true);
    await save();
    expect(rem.sets).toEqual([]);
    expect(rem.clears).toEqual([]);
  });

  test("a timed event still follows the checkbox (set when ticked, clear when not)", async () => {
    rem.get = { minutesBefore: 15, enabled: true, count: 1 };
    await openOn(evt(false));
    await save();
    expect(rem.sets).toEqual([["evt-1", 15]]);
    byId.get("ev-remind-on")!.checked = false;
    await save();
    expect(rem.clears).toEqual(["evt-1"]);
  });

  test("the 'N reminders' notice shows, hides while Whole day is ticked, and shows again when unticked", async () => {
    rem.get = { minutesBefore: 15, enabled: true, count: 2 };
    await openOn(evt(false));
    expect(noteHidden()).toBe(false);
    expect(byId.get("ev-remind-note")!.textContent).toBe("This event has 2 reminders. Saving keeps only this one.");
    await toggleWholeDay(true);
    expect(noteHidden()).toBe(true);
    await toggleWholeDay(false);
    expect(noteHidden()).toBe(false);
  });

  test("the notice says all reminders are removed while 'Remind me' is unticked", async () => {
    rem.get = { minutesBefore: 15, enabled: true, count: 2 };
    await openOn(evt(false));
    byId.get("ev-remind-on")!.checked = false;
    byId.get("ev-remind-on")!.dispatch("change");
    expect(noteHidden()).toBe(false);
    expect(byId.get("ev-remind-note")!.textContent).toBe("Saving removes all 2 reminders.");
    byId.get("ev-remind-on")!.checked = true;
    byId.get("ev-remind-on")!.dispatch("change");
    expect(byId.get("ev-remind-note")!.textContent).toBe("This event has 2 reminders. Saving keeps only this one.");
  });

  test("no notice for one reminder or none", async () => {
    rem.get = { minutesBefore: 15, enabled: true, count: 1 };
    await openOn(evt(false));
    expect(noteHidden()).toBe(true);
    rem.get = null;
    await openOn(evt(false));
    expect(noteHidden()).toBe(true);
  });
});
