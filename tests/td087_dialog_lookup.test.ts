// TD-087: saving the event dialog before the reminder lookup has returned (or
// after it failed) must NOT clear or overwrite the event's reminders. Until the
// lookup lands the "Remind me" checkbox shows the no-reminder state, and Save
// currently writes whatever the checkbox shows, i.e. clearReminder().
//
// Accepted fixes (the test asserts only the invariant, not the mechanism):
// Save is blocked until the lookup returned, OR the save goes through but
// writes no reminder change. What must never happen is a reminder write made
// from a checkbox state that was never loaded.
// Same DOM stub as tests/reminder_dialog.test.ts, with a CONTROLLABLE get.
import { describe, expect, test, beforeEach, afterEach, vi } from "vitest";

type Rem = { minutesBefore: number; enabled: boolean; count?: number } | null;
const rem = vi.hoisted(() => ({
  pending: null as null | { resolve: (r: unknown) => void; reject: (e: unknown) => void },
  all: [] as Array<{ resolve: (r: unknown) => void; reject: (e: unknown) => void }>,
  sets: [] as Array<[string, number]>,
  clears: [] as string[],
}));
vi.mock("../frontend/store.ts", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    getReminder: () =>
      new Promise((resolve, reject) => {
        rem.pending = { resolve, reject };
        rem.all.push(rem.pending);
      }),
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
// When set, updateEvent stays pending until the gate resolves (save in flight).
let gate: Promise<void> | null = null;
const updates: Array<{ id: string; input: EventInput }> = [];

function installBridge(): void {
  const bridge = {
    listEvents: () => events.slice(),
    createEvent(input: EventInput) { return { id: "evt-new", ...input }; },
    updateEvent(id: string, input: EventInput) { updates.push({ id, input }); return gate ? gate.then(() => ({ id, ...input })) : { id, ...input }; },
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
  rem.pending = null;
  rem.all.length = 0;
  rem.sets.length = 0;
  rem.clears.length = 0;
  gate = null;
  initDialog();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  (globalThis as { document?: unknown }).document = prevDoc;
  (globalThis as { window?: unknown }).window = prevWin;
});

function evt(): CalendarEvent {
  const start = new Date(2027, 2, 2, 9, 0).getTime();
  return { id: "evt-1", title: "T", description: "", startMs: start, endMs: start + 3_600_000, allDay: false };
}
async function openOn(ev: CalendarEvent): Promise<void> {
  events = [ev];
  for (const fn of docListeners.get("tide:eventclick") ?? []) fn({ detail: ev });
  await new Promise((r) => setTimeout(r, 0));
}
async function save(): Promise<void> {
  byId.get("ev-save")!.dispatch("click");
  await new Promise((r) => setTimeout(r, 0));
}
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("TD-087: a save made before the reminder lookup returned", () => {
  test("lookup still pending: Save does not clear or overwrite the event's reminders", async () => {
    await openOn(evt()); // getReminder is pending: checkbox shows the unloaded default (unticked)
    expect(rem.pending).not.toBeNull();
    await save();
    expect(rem.clears, "clearReminder() was called from an unloaded checkbox").toEqual([]);
    expect(rem.sets).toEqual([]);
  });

  test("lookup failed: Save does not clear the event's reminders", async () => {
    await openOn(evt());
    rem.pending!.reject(new Error("ipc unavailable"));
    await settle();
    await save();
    expect(rem.clears, "clearReminder() was called after a failed lookup").toEqual([]);
    expect(rem.sets).toEqual([]);
  });

  test("lookup returns later with a reminder: the event still has it (no clear, even if Save was pressed first)", async () => {
    await openOn(evt());
    await save(); // too early
    rem.pending!.resolve({ minutesBefore: 30, enabled: true, count: 1 } satisfies NonNullable<Rem>);
    await settle();
    expect(rem.clears).toEqual([]);
    // once loaded, the checkbox reflects the stored reminder
    expect(byId.get("ev-remind-on")!.checked).toBe(true);
  });

  test("a late lookup from a previously opened event never applies to the current dialog", async () => {
    await openOn(evt()); // lookup #1 pending
    await openOn(evt()); // dialog opened again: lookup #2 pending
    expect(rem.all.length).toBe(2);
    rem.all[0]!.resolve({ minutesBefore: 30, enabled: true, count: 1 }); // late answer of the first open
    await settle();
    expect(byId.get("ev-remind-on")!.checked, "the late answer must not fill the current dialog").toBe(false);
    await save(); // second lookup still pending: nothing may be written
    expect(rem.clears).toEqual([]);
    expect(rem.sets).toEqual([]);
  });

  test("while the lookup is loading the dialog says so, and says saving leaves reminders alone", async () => {
    await openOn(evt());
    const note = byId.get("ev-remind-note")!;
    expect(note.hidden).toBe(false);
    expect(note.textContent).toMatch(/Loading this event's reminders/);
    rem.pending!.resolve(null);
    await settle();
    expect(note.hidden).toBe(true);
  });

  // Race: Save is clicked while the lookup is loading; the lookup answers while
  // the save is still waiting for the event update. The decision to write a
  // reminder is taken at click time, so no reminder write may follow.
  for (const [name, answer] of [
    ["a stored enabled reminder", { minutesBefore: 30, enabled: true, count: 1 }],
    ["several stored reminders", { minutesBefore: 30, enabled: true, count: 2 }],
    ["a stored disabled reminder", { minutesBefore: 30, enabled: false, count: 1 }],
  ] as const) {
    test(`lookup answers while the save is in flight (${name}): no reminder write (no set, no clear)`, async () => {
      let release!: () => void;
      gate = new Promise<void>((r) => { release = r; });
      await openOn(evt());
      byId.get("ev-save")!.dispatch("click"); // Save while loading
      await settle();
      rem.pending!.resolve(answer); // the lookup answers during the save
      await settle();
      release(); // the event update answers
      await settle();
      await settle();
      expect(rem.sets, "setReminder() ran from a lookup answer that arrived mid-save").toEqual([]);
      expect(rem.clears, "clearReminder() ran from a lookup answer that arrived mid-save").toEqual([]);
    });
  }
});
