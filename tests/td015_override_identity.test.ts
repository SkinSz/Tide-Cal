// TD-015 — occurrence override identity must come from the ORIGINAL
// recurrence_id (DC-12 R2), not from the override's MOVED start.
//
// Defect: dialog.ts derives recurrenceId via deriveRecurrenceId(existing.startMs)
// where `existing` is the rendered chip whose startMs is the override's moved
// start. Second edit/delete of a moved occurrence then writes an ORPHAN
// override under the moved wall-time (duplicate chip, original uneditable).
// Fix: read the chip's original recurrenceId via occurrenceOf(ev) —
// expandSeriesEvents attaches it (calendar.ts occurrenceMeta).
//
// Regression contract: move an occurrence, edit it again → ONE override row,
// keyed by the ORIGINAL recurrence_id; move + delete → cancellation lands on
// the ORIGINAL recurrence_id too.
import { describe, expect, test, beforeEach, afterEach } from "vitest";
import { expandSeriesEvents } from "../frontend/calendar.ts";
import { initDialog } from "../frontend/dialog.ts";
import type {
  CalendarEvent,
  EventInput,
  EventStoreBridge,
  SeriesRow,
} from "../frontend/store.ts";

// ---------------------------------------------------------------------------
// Minimal DOM stub — SAME pattern as tests/recurrence_uncheck.test.ts
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
  after(node: DomEl) {
    this.parentElement?.appendChild(node);
  }
  setAttribute(k: string, v: string) {
    this.dataset[k] = v;
  }
  getAttribute(k: string): string | null {
    return this.dataset[k] ?? null;
  }
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
      throw new Error("TD-015 test: createEvent not used");
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
    updateSeriesRule(seriesId: string, rule: string) {
      calls.ruleUpdates.push({ seriesId, rule });
      const row = seriesRows.find((s) => s.seriesId === seriesId);
      if (row) row.recurrenceRule = rule;
      return Promise.resolve({ seriesId, recurrenceRule: rule });
    },
    updateOccurrence(seriesId: string, recurrenceId: string, patch: Record<string, unknown>) {
      calls.occurrencePatches.push({ seriesId, recurrenceId, patch });
      const row = seriesRows.find((s) => s.seriesId === seriesId);
      if (row) {
        const i = row.overrides.findIndex((o) => o.recurrenceId === recurrenceId);
        if (i >= 0) row.overrides[i] = { ...row.overrides[i]!, ...patch };
        else
          row.overrides.push({
            recurrenceId,
            cancelled: false,
            ...patch,
          });
      }
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
// Fixture: DAILY series, base 2026-09-02 10:00, occurrence MOVED to Sep 5
// ---------------------------------------------------------------------------

const BASE_ID = "evt-series";
const BASE_RULE = "FREQ=DAILY;UNTIL=20261231";
const ORIGINAL_RID = "20260902T100000";

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

function seriesWithMovedOccurrence(): SeriesRow {
  return {
    seriesId: "ser-1",
    baseEventId: BASE_ID,
    recurrenceRule: BASE_RULE,
    overrides: [
      {
        recurrenceId: ORIGINAL_RID,
        cancelled: false,
        title: "Standup (moved)",
        startWall: "2026-09-05T14:00", // MOVED: Fri Sep 5 14:00
        endWall: "2026-09-05T15:00",
      },
    ],
  };
}

/** Open the dialog on the RENDERED CHIP of the moved occurrence. */
async function openMovedChipDialog(): Promise<void> {
  const ev = baseEvent();
  events = [ev];
  seriesRows = [seriesWithMovedOccurrence()];
  // Render September — the chip for the moved occurrence (Sep 5) carries
  // occurrenceMeta with the ORIGINAL recurrenceId.
  const chips = expandSeriesEvents([ev], seriesRows, new Date(2026, 8, 1), new Date(2026, 8, 30));
  const movedChip = chips.find((c) => c.title === "Standup (moved)");
  if (!movedChip) throw new Error("moved chip not rendered");
  for (const fn of docListeners.get("tide:eventclick") ?? []) {
    fn({ detail: movedChip });
  }
  await new Promise((r) => setTimeout(r, 0));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("TD-015: second edit of a MOVED occurrence keys the ORIGINAL override", () => {
  test("edit-after-move writes ONE occurrence patch under the original recurrence_id", async () => {
    await openMovedChipDialog();

    // Retitle the moved chip again and Save as THIS-occurrence.
    byId.get("ev-title")!.value = "Standup (moved twice)";
    byId.get("ev-scope")!.value = "occurrence";
    byId.get("ev-save")!.dispatch("click");
    await new Promise((r) => setTimeout(r, 0));

    // EXACTLY ONE patch, keyed by the ORIGINAL rid (20260902T100000) —
    // NOT a new override keyed by the moved wall-time (20260905T140000).
    expect(calls.occurrencePatches).toHaveLength(1);
    expect(calls.occurrencePatches[0]!.recurrenceId).toBe(ORIGINAL_RID);
    expect(calls.occurrencePatches[0]!.patch.title).toBe("Standup (moved twice)");

    // The series now still holds exactly ONE override row.
    expect(seriesRows[0]!.overrides).toHaveLength(1);
    expect(seriesRows[0]!.overrides[0]!.recurrenceId).toBe(ORIGINAL_RID);
  });

  test("delete-after-move cancels the ORIGINAL occurrence, not a phantom", async () => {
    await openMovedChipDialog();

    // Two-step confirm delete, scoped to this occurrence.
    byId.get("ev-scope")!.value = "occurrence";
    byId.get("ev-delete")!.dispatch("click");
    await new Promise((r) => setTimeout(r, 0));
    byId.get("ev-delete")!.dispatch("click");
    await new Promise((r) => setTimeout(r, 0));

    // The cancellation lands on the ORIGINAL rid — the phantom override the
    // old code wrote (keyed 20260905T140000) must never appear.
    const cancelPatches = calls.occurrencePatches.filter(
      (p) => p.patch.cancelled === true,
    );
    expect(cancelPatches).toHaveLength(1);
    expect(cancelPatches[0]!.recurrenceId).toBe(ORIGINAL_RID);
    expect(seriesRows[0]!.overrides).toHaveLength(1);
    expect(seriesRows[0]!.overrides[0]!.recurrenceId).toBe(ORIGINAL_RID);
  });
});
