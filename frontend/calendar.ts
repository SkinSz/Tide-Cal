// Tide calendar grid: month view and week view, vanilla TS DOM rendering.
import type { CalendarEvent } from "./store.ts";
import { listEvents } from "./store.ts";

export type ViewMode = "month" | "week";

const DAY_MS = 86_400_000;

export function startOfDay(d: Date): Date {
  const c = new Date(d);
  c.setHours(0, 0, 0, 0);
  return c;
}

/** Monday-based week start. */
export function startOfWeek(d: Date): Date {
  const c = startOfDay(d);
  const dow = (c.getDay() + 6) % 7; // Mon=0..Sun=6
  c.setDate(c.getDate() - dow);
  return c;
}

function startOfMonth(d: Date): Date {
  const c = startOfDay(d);
  c.setDate(1);
  return c;
}

export function addDays(d: Date, n: number): Date {
  const c = new Date(d);
  c.setDate(c.getDate() + n);
  return c;
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function fmtTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

let current: Date = new Date();
let mode: ViewMode = "month";
let selectedDate: Date = startOfDay(new Date());

export function getViewMode(): ViewMode {
  return mode;
}

/** Currently selected day (source of truth for the event dialog). */
export function getSelectedDate(): Date {
  return new Date(selectedDate);
}

export function setViewMode(m: ViewMode): void {
  mode = m;
  render();
}

export function navigate(dir: -1 | 1 | 0): void {
  if (dir === 0) {
    current = new Date();
    selectedDate = startOfDay(new Date());
  } else if (mode === "month") {
    current = new Date(current.getFullYear(), current.getMonth() + dir, 1);
  } else {
    current = addDays(current, dir * 7);
  }
  render();
}

function label(): string {
  if (mode === "month") {
    return current.toLocaleDateString(undefined, {
      month: "long",
      year: "numeric",
    });
  }
  const ws = startOfWeek(current);
  const we = addDays(ws, 6);
  const fmt = (d: Date) =>
    d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return `${fmt(ws)} – ${fmt(we)}, ${we.getFullYear()}`;
}

interface DayCell {
  date: Date;
  inMonth: boolean;
}

function monthGrid(): DayCell[] {
  const first = startOfWeek(startOfMonth(current));
  const cells: DayCell[] = [];
  for (let i = 0; i < 42; i++) {
    const d = addDays(first, i);
    cells.push({ date: d, inMonth: d.getMonth() === current.getMonth() });
    if (i >= 34 && d.getDay() === 0 && d.getMonth() !== current.getMonth())
      break; // stop after a full final week
  }
  return cells;
}

async function eventsForRange(from: Date, to: Date): Promise<CalendarEvent[]> {
  try {
    return await listEvents({ fromMs: from.getTime(), toMs: to.getTime() + DAY_MS });
  } catch (e) {
    console.error("[tide] failed to load events:", e);
    return [];
  }
}

function eventChip(ev: CalendarEvent, allDayStyle: boolean): HTMLElement {
  const chip = document.createElement("div");
  chip.className = allDayStyle ? "chip chip-allday" : "chip";
  chip.dataset.eventId = ev.id;
  chip.textContent = allDayStyle ? ev.title : `${fmtTime(ev.startMs)} ${ev.title}`;
  chip.title = ev.title;
  return chip;
}

function dayColumn(
  cell: DayCell,
  events: CalendarEvent[],
  onEventClick: (ev: CalendarEvent) => void,
): HTMLElement {
  const col = document.createElement("div");
  col.className =
    "day-col" +
    (cell.inMonth ? "" : " day-outside") +
    (sameDay(cell.date, new Date()) ? " day-today" : "") +
    (sameDay(cell.date, selectedDate) ? " day-selected" : "");
  col.dataset.date = cell.date.toISOString().slice(0, 10);

  const head = document.createElement("div");
  head.className = "day-num";
  head.textContent = String(cell.date.getDate());
  col.appendChild(head);

  const list = document.createElement("div");
  list.className = "day-events";
  for (const ev of events.filter((e) => {
    const s = new Date(e.startMs);
    const en = new Date(e.endMs - 1);
    return s <= endOfDay(cell.date) && en >= startOfDay(cell.date);
  })) {
    const chip = eventChip(ev, ev.allDay || !sameDay(new Date(ev.startMs), cell.date));
    chip.addEventListener("click", (e) => {
      e.stopPropagation();
      onEventClick(ev);
    });
    list.appendChild(chip);
  }
  col.appendChild(list);

  col.addEventListener("click", () => {
    selectedDate = startOfDay(cell.date);
    render();
    document.dispatchEvent(
      new CustomEvent("tide:dayclick", { detail: cell.date.toISOString() }),
    );
  });
  return col;
}

function endOfDay(d: Date): Date {
  const c = startOfDay(d);
  c.setHours(23, 59, 59, 999);
  return c;
}

let renderSeq = 0;

export async function render(): Promise<void> {
  const root = document.getElementById("calendar-grid");
  if (!root) return;
  const seq = ++renderSeq;
  root.replaceChildren();
  root.classList.toggle("week", mode === "week");

  // weekday header
  if (mode === "week") {
    const corner = document.createElement("div");
    corner.className = "weekday-head hour-corner";
    root.appendChild(corner);
  }
  for (const wd of WEEKDAYS) {
    const h = document.createElement("div");
    h.className = "weekday-head";
    h.textContent = wd;
    root.appendChild(h);
  }

  const cells = mode === "month" ? monthGrid() : weekCells();
  const rangeStart = cells[0]!.date;
  const rangeEnd = addDays(cells[cells.length - 1]!.date, 1);
  const events = await eventsForRange(rangeStart, rangeEnd);
  // Re-check: async gap may mean the user navigated meanwhile.
  if (seq !== renderSeq) {
    return;
  }

  if (mode === "week") {
    renderHourRuler(root);
    for (const cell of cells) {
      root.appendChild(
        weekDayColumn(cell, events, onEventClick),
      );
    }
    addHourLines();
  } else {
    for (const cell of cells) {
      root.appendChild(dayColumn(cell, events, onEventClick));
    }
  }
  document.getElementById("cal-label")!.textContent = label();
}

// --- Week view: time-grid ---------------------------------------------------
// Blocks are absolutely positioned per-day; top/height track start time and
// DURATION so an appointment's length is visible at a glance.

const MINUTES_PER_DAY = 24 * 60;

function fmtHour(h: number): string {
  return `${pad(h)}:00`;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function renderHourRuler(root: HTMLElement): void {
  const ruler = document.createElement("div");
  ruler.className = "hour-ruler";
  for (let h = 0; h < 24; h++) {
    const lbl = document.createElement("div");
    lbl.className = "hour-label";
    lbl.textContent = fmtHour(h);
    ruler.appendChild(lbl);
  }
  root.appendChild(ruler);
}

/** Horizontal guide lines across all day columns (call after columns mount). */
function addHourLines(): void {
  for (let h = 0; h < 24; h++) {
    const line = document.createElement("div");
    line.className = "hour-line";
    line.style.top = `${(h / 24) * 100}%`;
    document
      .querySelectorAll<HTMLElement>("#calendar-grid .week-col")
      .forEach((col) => col.appendChild(line.cloneNode(true)));
  }
}

function minutesOfDay(d: Date): number {
  return d.getHours() * 60 + d.getMinutes();
}

function weekDayColumn(
  cell: DayCell,
  events: CalendarEvent[],
  onEventClick: (ev: CalendarEvent) => void,
  clickedHour: number | null = null,
): HTMLElement {
  const col = document.createElement("div");
  col.className =
    "day-col week-col" +
    (sameDay(cell.date, new Date()) ? " day-today" : "") +
    (sameDay(cell.date, selectedDate) ? " day-selected" : "");
  col.dataset.date = cell.date.toISOString().slice(0, 10);
  if (clickedHour != null) col.classList.add("hour-clicked");

  // All-day lane on top.
  for (const ev of events.filter(
    (e) =>
      e.allDay &&
      new Date(e.startMs) <= endOfDay(cell.date) &&
      new Date(e.endMs - 1) >= startOfDay(cell.date),
  )) {
    const chip = eventChip(ev, true);
    chip.addEventListener("click", (e) => {
      e.stopPropagation();
      onEventClick(ev);
    });
    chip.classList.add("lane-chip");
    col.appendChild(chip);
  }

  // Timed blocks: absolute positioning from clock times.
  for (const ev of events.filter(
    (e) => !e.allDay && e.startMs < cell.date.getTime() + DAY_MS &&
           e.endMs > cell.date.getTime(),
  )) {
    const s = Math.max(ev.startMs, cell.date.getTime());
    const en = Math.min(ev.endMs, cell.date.getTime() + DAY_MS);
    const startMin =
      s > cell.date.getTime() ? minutesOfDay(new Date(s)) : 0;
    const durMin = Math.max(
      (en - s) / 60000,
      30, // minimum visual block
    );
    const topPct = (startMin / MINUTES_PER_DAY) * 100;
    const heightPct = Math.min((durMin / MINUTES_PER_DAY) * 100, 100 - topPct);

    const chip = eventChip(ev, false);
    chip.classList.add("chip-timed");
    chip.style.top = `${topPct}%`;
    chip.style.height = `${heightPct}%`;
    chip.textContent = `${fmtTime(ev.startMs)} ${ev.title}`;
    chip.addEventListener("click", (e) => {
      e.stopPropagation();
      onEventClick(ev);
    });
    col.appendChild(chip);
  }
  void onEventClick;

  // Click on an empty hour band: select that day AND pre-seed a new event
  // starting at that hour (30-min default via dialog defaults).
  col.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    if (target.closest(".chip")) return; // chip handler owns that click
    const rect = col.getBoundingClientRect();
    const frac = (e.clientY - rect.top) / rect.height;
    clickedHour = Math.min(Math.floor(frac * 24), 23);
    selectedDate = startOfDay(cell.date);
    render();
    document.dispatchEvent(
      new CustomEvent("tide:dayclick", { detail: cell.date.toISOString() }),
    );
    document.dispatchEvent(
      new CustomEvent("tide:hourclick", {
        detail: { date: cell.date.toISOString(), hour: clickedHour },
      }),
    );
  });
  return col;
}

function weekCells(): DayCell[] {
  const ws = startOfWeek(current);
  return Array.from({ length: 7 }, (_, i) => ({
    date: addDays(ws, i),
    inMonth: true,
  }));
}

// Event click hook — wired by dialog.ts via tide:eventclick listener.
function onEventClick(ev: CalendarEvent): void {
  document.dispatchEvent(
    new CustomEvent("tide:eventclick", { detail: ev }),
  );
}
