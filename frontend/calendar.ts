// Tide calendar grid: month view and week view, vanilla TS DOM rendering.
import type { CalendarEvent } from "./store.ts";
import { listEvents, listSeries, updateEvent, deleteEvent, type SeriesRow } from "./store.ts";
import { recurrenceBadge, type SeriesInfo } from "./recurrence.ts";
import { expandOccurrences } from "../src/domain/recurrence_conflicts.ts";
import { formatTimeLabel, getTimeFormat } from "./theme.ts";

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
  // Calendar chips follow the General time-format setting (the grid itself
  // is and stays 24h; this is the visible "9:00 AM" / "09:00" label).
  const d = new Date(ms);
  const hhmm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return formatTimeLabel(hhmm, getTimeFormat());
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

/**
 * Series lookup for recurrence surfacing: base_event_id -> SeriesInfo.
 * Best-effort/read-only: a failed series fetch renders no indicators
 * (never blocks the calendar).
 */
async function seriesByBaseEvent(): Promise<Map<string, SeriesInfo>> {
  let rows: SeriesRow[] = [];
  try {
    rows = await listSeries();
  } catch (e) {
    console.warn("[tide] series lookup unavailable:", e);
  }
  seriesRowsCache = rows; // raw rows feed series expansion in render()
  const map = new Map<string, SeriesInfo>();
  for (const r of rows) {
    map.set(r.baseEventId, {
      seriesId: r.seriesId,
      baseEventId: r.baseEventId,
      rule: r.recurrenceRule,
      overrides: r.overrides,
    });
  }
  return map;
}

// ---------------------------------------------------------------------------
// DC-12: series expansion on the calendar read path.
//
// listEvents() returns only BASE event rows, so without this a recurring
// series rendered a single chip on its start day (owner bug report). Here we
// expand each series within the rendered window using the domain core's
// expandOccurrences (wall-clock naive arithmetic, DST-correct by construction)
// and honour occurrence overrides: cancelled occurrences render NO chip,
// edited occurrences render with the override fields and a ✎ marker.
// ---------------------------------------------------------------------------

/** Zero-padded 2-digit number (local pad helper — calendar's pad takes 1 arg). */
function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** 'YYYYMMDDTHHMMSS' from epoch ms (local wall clock, matching chip labels). */
function wallIdFromMs(ms: number): string {
  const d = new Date(ms);
  return (
    `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}` +
    `T${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`
  );
}

/** Epoch ms from a 'YYYYMMDD[THHMMSS]' wall-clock id (local time). */
function msFromWallId(id: string): number {
  const digits = id.replace(/\D/g, "");
  const y = +digits.slice(0, 4);
  const mo = +digits.slice(4, 6);
  const dd = +digits.slice(6, 8);
  const hh = +digits.slice(8, 10) || 0;
  const mi = +digits.slice(10, 12) || 0;
  const ss = +digits.slice(12, 14) || 0;
  return new Date(y, mo - 1, dd, hh, mi, ss, 0).getTime();
}

/** 'YYYY-MM-DDTHH:MM' naive wall clock from epoch ms (SeriesState form). */
function baseStartWall(ms: number): string {
  const d = new Date(ms);
  return (
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}` +
    `T${pad2(d.getHours())}:${pad2(d.getMinutes())}`
  );
}

/** Per-chip occurrence metadata consumed by decorateRecurrence (✎ marker). */
export interface OccurrenceMeta {
  recurrenceId: string;
  /** An override (title/start/end) applies to this occurrence. */
  edited: boolean;
}

const occurrenceMeta = new WeakMap<CalendarEvent, OccurrenceMeta>();

/** Occurrence metadata for a chip event, if it came from series expansion. */
export function occurrenceOf(ev: CalendarEvent): OccurrenceMeta | undefined {
  return occurrenceMeta.get(ev);
}

/**
 * Expand recurring series into per-occurrence chip events for the rendered
 * window. Non-series events pass through untouched; series base events are
 * replaced by their occurrence chips (the base day's occurrence included —
 * the first expansion hit is the base start itself). Best-effort: a series
 * whose rule fails to expand falls back to its base-event chip.
 */
export function expandSeriesEvents(
  events: CalendarEvent[],
  seriesRows: SeriesRow[],
  rangeStart: Date,
  rangeEnd: Date,
): CalendarEvent[] {
  const seriesByBase = new Map<string, SeriesRow>();
  for (const s of seriesRows) seriesByBase.set(s.baseEventId, s);

  const winLo = `${wallIdFromMs(rangeStart.getTime()).slice(0, 8)}T000000`;
  const winHi = `${wallIdFromMs(rangeEnd.getTime() - 1).slice(0, 8)}T235959`;

  const out: CalendarEvent[] = [];
  for (const ev of events) {
    const row = seriesByBase.get(ev.id);
    if (!row) {
      out.push(ev); // plain, non-recurring event
      continue;
    }
    let occIds: string[] = [];
    try {
      occIds = expandOccurrences(
        {
          series_id: row.seriesId,
          base_start_wall: baseStartWall(ev.startMs),
          tz_id: "local",
          recurrence_rule: row.recurrenceRule,
        },
        winLo,
        winHi,
      );
    } catch (e) {
      console.warn("[tide] series expansion failed, showing base chip:", e);
      out.push(ev);
      continue;
    }
    if (occIds.length === 0) {
      // Rule yields nothing in-window (e.g. base predates an edited rule) —
      // keep the base chip so the event never silently disappears.
      out.push(ev);
      continue;
    }
    const overrides = new Map(row.overrides.map((o) => [o.recurrenceId, o]));
    const durMs = Math.max(ev.endMs - ev.startMs, 0);
    for (const occId of occIds) {
      const ov = overrides.get(occId);
      if (ov?.cancelled) continue; // cancelled occurrence: NO chip
      const startMs = ov?.startWall ? msFromWallId(ov.startWall) : msFromWallId(occId);
      const endMs = ov?.endWall ? msFromWallId(ov.endWall) : startMs + durMs;
      const chipEvent: CalendarEvent = {
        ...ev,
        id: ev.id, // chips act on the base event (select/edit/delete)
        title: ov?.title ?? ev.title,
        startMs,
        endMs,
      };
      occurrenceMeta.set(chipEvent, {
        recurrenceId: occId,
        edited: ov !== undefined,
      });
      out.push(chipEvent);
    }
  }
  return out;
}

/**
 * Append the read-only recurrence indicator to a chip: 🔁 glyph + tooltip
 * with the plain-language rule (raw RRULE fallback), plus a "changed
 * occurrence" marker when overrides exist (DC-12 §2.2).
 * `occurrence` (set on series-expansion chips) scopes the ✎ marker to THAT
 * occurrence; base chips keep the series-level marker.
 */
function decorateRecurrence(
  chip: HTMLElement,
  ev: CalendarEvent,
  series: Map<string, SeriesInfo>,
  occurrence?: OccurrenceMeta,
): void {
  const info = series.get(ev.id);
  if (!info) return;
  const badge = recurrenceBadge(info);
  const glyph = document.createElement("span");
  glyph.className = "recurrence-glyph";
  glyph.textContent = badge.glyph;
  glyph.title = badge.tooltip;
  chip.appendChild(glyph);
  const showOverride = occurrence ? occurrence.edited : badge.hasOverride;
  if (showOverride) {
    const marker = document.createElement("span");
    marker.className = "override-marker";
    marker.textContent = "✎";
    marker.title = badge.tooltip;
    chip.appendChild(marker);
  }
  chip.title = badge.tooltip;
}

function eventChip(
  ev: CalendarEvent,
  allDayStyle: boolean,
  series: Map<string, SeriesInfo>,
): HTMLElement {
  const chip = document.createElement("div");
  chip.className = allDayStyle ? "chip chip-allday" : "chip";
  chip.dataset.eventId = ev.id;
  chip.textContent = allDayStyle ? ev.title : `${fmtTime(ev.startMs)} ${ev.title}`;
  chip.title = ev.title;
  // Every occurrence chip carries the 🔁 glyph + tooltip (occurrence metadata
  // scopes the ✎ "changed occurrence" marker to the overridden occurrence).
  decorateRecurrence(chip, ev, series, occurrenceOf(ev));
  // UX contract (owner rule): single-click SELECTS, double-click OPENS the
  // edit dialog. Never open on single click. Delete key deletes (with the
  // dialog's two-step confirm), drag moves (week view).
  chip.tabIndex = 0;
  chip.addEventListener("click", (e) => {
    e.stopPropagation();
    selectChip(chip);
    selectedEvent = ev;
    document.dispatchEvent(new CustomEvent("tide:eventselect", { detail: ev }));
  });
  chip.addEventListener("dblclick", (e) => {
    e.stopPropagation();
    onEventClick(ev);
  });
  chip.addEventListener("keydown", (e) => {
    const key = (e as KeyboardEvent).key;
    if (chip.dataset.deleteArmed === "1" && key !== "Delete" && key !== "Backspace") {
      disarmDelete(chip); // any other key cancels the armed delete
      return;
    }
    if (key !== "Delete" && key !== "Backspace") return;
    e.preventDefault();
    e.stopPropagation();
    deleteSelected(chip);
  });
  wireDrag(chip, ev);
  return chip;
}

// ---------------------------------------------------------------------------
// Delete key (owner request): Delete/Backspace on a selected chip opens the
// two-step in-app confirmation (same pattern as the dialog's Delete button —
// arm → "Confirm delete?" → execute; auto-revert after 8s). No native
// confirm() — WebKit popup chrome is banned (smoke-test round 2).
// ---------------------------------------------------------------------------

let selectedEvent: CalendarEvent | null = null;

function deleteSelected(chip: HTMLElement): void {
  const ev = selectedEvent;
  if (!ev || chip.dataset.eventId !== ev.id) return;
  if (chip.dataset.deleteArmed !== "1") {
    chip.dataset.deleteArmed = "1";
    chip.dataset.prevTitle = chip.textContent ?? "";
    chip.textContent = "Confirm delete? (Del again)";
    chip.title = "Press Delete again to confirm — click elsewhere or press any other key to cancel";
    chip.classList.add("chip-delete-arm");
    chip.dataset.revertTimer = window
      .setTimeout(() => disarmDelete(chip), 8000)
      .toString();
    return;
  }
  disarmDelete(chip);
  void (async () => {
    try {
      await deleteEvent(ev.id);
      selectedEvent = null;
      document.dispatchEvent(new CustomEvent("tide:refresh"));
    } catch (err) {
      console.error("[tide] delete failed:", err);
    }
  })();
}

function disarmDelete(chip: HTMLElement): void {
  chip.dataset.deleteArmed = "";
  if (chip.dataset.revertTimer) {
    clearTimeout(Number(chip.dataset.revertTimer));
    chip.dataset.revertTimer = "";
  }
  chip.classList.remove("chip-delete-arm");
  // Restore the original label (re-render is the general path; this keeps
  // the armed chip readable if the render hasn't happened yet).
  const ev = selectedEvent;
  if (ev && chip.dataset.eventId === ev.id) {
    chip.textContent = ev.allDay || chip.classList.contains("chip-allday")
      ? ev.title
      : `${fmtTime(ev.startMs)} ${ev.title}`;
    chip.title = ev.title;
    decorateRecurrence(chip, ev, seriesLookup ?? new Map(), occurrenceOf(ev));
  }
}

function cancelDeleteArms(root: ParentNode): void {
  root.querySelectorAll<HTMLElement>(".chip-delete-arm").forEach(disarmDelete);
}

// ---------------------------------------------------------------------------
// Drag-n-drop (owner request, week view): drag a chip to another day/hour to
// move the appointment. HTML5 DnD with the chip as source and the week day
// column as drop target; drop position maps to a new start time (day from the
// column, minutes-of-day from the drop Y). Preserves duration. allDay chips
// are excluded (the all-day lane has no time axis).
// ---------------------------------------------------------------------------

let dragEvent: CalendarEvent | null = null;
let seriesLookup: Map<string, SeriesInfo> | null = null;
/** Raw series rows from the last render (input to series expansion). */
let seriesRowsCache: SeriesRow[] = [];
let dragGhost: HTMLElement | null = null;

/** Remove the live drag ghost (owner request: real-time time feedback). */
function removeDragGhost(): void {
  dragGhost?.remove();
  dragGhost = null;
}

/**
 * Live drag ghost: a semi-transparent block pinned to the day column under
 * the cursor at the SNAPPED start time, labeled with the real wall-clock
 * range the drop would produce — so the owner can see exactly when the
 * appointment will land before releasing the mouse (Outlook-style).
 */
function updateDragGhost(col: HTMLElement, clientY: number, durMin: number): void {
  const rect = col.getBoundingClientRect();
  const yInCol = Math.min(Math.max(clientY - rect.top, 0), rect.height);
  let minutes = Math.round(((yInCol / rect.height) * MINUTES_PER_DAY) / 15) * 15;
  minutes = Math.min(Math.max(minutes, 0), MINUTES_PER_DAY - 15);
  const topPct = (minutes / MINUTES_PER_DAY) * 100;
  const heightPct = Math.min((durMin / MINUTES_PER_DAY) * 100, 100 - topPct);
  const endMin = Math.min(minutes + durMin, MINUTES_PER_DAY);

  if (!dragGhost) {
    dragGhost = document.createElement("div");
    dragGhost.className = "chip chip-timed drag-ghost";
    col.appendChild(dragGhost);
  } else if (dragGhost.parentElement !== col) {
    dragGhost.remove();
    col.appendChild(dragGhost);
  }
  const hh = (m: number) => `${pad(Math.floor(m / 60) % 24)}:${pad(Math.round(m % 60))}`;
  dragGhost.style.top = `${topPct}%`;
  dragGhost.style.height = `${heightPct}%`;
  dragGhost.style.left = "2px";
  dragGhost.style.right = "2px";
  dragGhost.style.width = "auto";
  dragGhost.style.zIndex = "50";
  dragGhost.textContent = `${hh(minutes)} – ${hh(endMin)}`;
  dragGhost.title = "Release to move the appointment here";
}

function wireDrag(chip: HTMLElement, ev: CalendarEvent): void {
  chip.draggable = true;
  chip.addEventListener("dragstart", (e) => {
    dragEvent = ev;
    e.dataTransfer?.setData("text/plain", ev.id);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
    chip.classList.add("chip-dragging");
  });
  chip.addEventListener("dragend", () => {
    chip.classList.remove("chip-dragging");
    dragEvent = null;
    removeDragGhost();
    document
      .querySelectorAll<HTMLElement>(".drop-target")
      .forEach((el) => el.classList.remove("drop-target"));
  });
  // Global dragover drives the ghost: the source chip fires drag events even
  // when the pointer is over another column, so the ghost follows across days.
  // Registered ONCE per chip render generation; the previous generation's
  // handlers see dragEvent.id mismatch (dragEvent only ever holds the newest
  // chip's event) and return immediately — no unbounded listener growth
  // (blind-review finding F6).
  document.addEventListener("dragover", handleDragOver);
  document.addEventListener("drop", removeDragGhost);
}

/**
 * Global dragover handler — module-level singleton, registered once per chip
 * via handleDragOver re-binding. Stale generations no-op on the id guard.
 */
function handleDragOverImpl(e: DragEvent): void {
  if (!dragEvent) return;
  const target = (e.target as HTMLElement | null)?.closest?.(".week-col") as HTMLElement | null;
  if (!target) {
    removeDragGhost();
    return;
  }
  e.preventDefault();
  if (dragEvent.allDay) {
    updateAllDayGhost(target, dragEvent);
  } else {
    updateDragGhost(target, e.clientY, Math.max((dragEvent.endMs - dragEvent.startMs) / 60000, 30));
  }
}
const handleDragOver: (e: DragEvent) => void = handleDragOverImpl;
function updateAllDayGhost(col: HTMLElement, ev: CalendarEvent): void {
  if (!dragGhost) {
    dragGhost = document.createElement("div");
    col.appendChild(dragGhost);
  } else if (dragGhost.parentElement !== col) {
    dragGhost.remove();
    col.appendChild(dragGhost);
  }
  dragGhost.className = "allday-banner drag-ghost-allday";
  dragGhost.textContent = ev.title;
  dragGhost.style.cssText = "";
  dragGhost.title = "Release to move the whole-day appointment to this day";
}

function wireWeekColumnDrop(col: HTMLElement, cell: DayCell): void {
  col.addEventListener("dragover", (e) => {
    if (!dragEvent) return; // only accept our own chips
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    col.classList.add("drop-target");
  });
  col.addEventListener("dragleave", (e) => {
    if (e.target === col) col.classList.remove("drop-target");
  });
  col.addEventListener("drop", (e) => {
    e.preventDefault();
    col.classList.remove("drop-target");
    removeDragGhost();
    const ev = dragEvent;
    if (!ev) return;
    const day = startOfDay(cell.date);
    if (ev.allDay) {
      // Whole-day drag: move the DATE only, keep the all-day flag. Duration
      // stays 24h (whole-day events are single-day per design contract).
      const dur = Math.max(ev.endMs - ev.startMs, DAY_MS);
      const startMs = day.getTime();
      if (startMs === ev.startMs) return; // no-op drop
      void (async () => {
        try {
          await updateEvent(ev.id, {
            title: ev.title,
            description: ev.description,
            startMs,
            endMs: startMs + dur,
            allDay: true,
          });
          selectedEvent = null;
          document.dispatchEvent(new CustomEvent("tide:refresh"));
        } catch (err) {
          console.error("[tide] whole-day move failed:", err);
        }
      })();
      return;
    }
    // Timed drag: map the drop Y to minutes-of-day; duration is preserved.
    const rect = col.getBoundingClientRect();
    const yInCol = Math.min(Math.max(e.clientY - rect.top, 0), rect.height);
    let minutes = Math.round(((yInCol / rect.height) * MINUTES_PER_DAY) / 15) * 15;
    minutes = Math.min(Math.max(minutes, 0), MINUTES_PER_DAY - 15);
    const dur = Math.max(ev.endMs - ev.startMs, 60_000);
    day.setMinutes(minutes);
    const startMs = day.getTime();
    if (startMs === ev.startMs) return; // no-op drop
    void (async () => {
      try {
        await updateEvent(ev.id, {
          title: ev.title,
          description: ev.description,
          startMs,
          endMs: startMs + dur,
          allDay: ev.allDay,
        });
        selectedEvent = null;
        document.dispatchEvent(new CustomEvent("tide:refresh"));
      } catch (err) {
        console.error("[tide] drag-move failed:", err);
      }
    })();
  });
}


/** Visual selection: exactly one chip highlighted at a time. */
function selectChip(chip: HTMLElement): void {
  document
    .querySelectorAll<HTMLElement>(".chip.chip-selected")
    .forEach((el) => el.classList.remove("chip-selected"));
  chip.classList.add("chip-selected");
}

function dayColumn(
  cell: DayCell,
  events: CalendarEvent[],
  series: Map<string, SeriesInfo>,
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
    const chip = eventChip(ev, ev.allDay || !sameDay(new Date(ev.startMs), cell.date), series);
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
  // Month view: double-click an empty day -> new-event dialog for that day
  // (chip dblclicks stopPropagation above and open the edit dialog instead).
  col.addEventListener("dblclick", (e) => {
    const target = e.target as HTMLElement;
    if (target.closest(".chip")) return;
    selectedDate = startOfDay(cell.date);
    document.dispatchEvent(
      new CustomEvent("tide:neweventat", { detail: cell.date.toISOString() }),
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
  const [baseEvents, series] = await Promise.all([
    eventsForRange(rangeStart, rangeEnd),
    seriesByBaseEvent(),
  ]);
  seriesLookup = series;
  // DC-12: expand recurring series into per-occurrence chips (cancelled
  // occurrences dropped, edited occurrences carry their override fields).
  const events = expandSeriesEvents(baseEvents, seriesRowsCache, rangeStart, rangeEnd);
  // Re-check: async gap may mean the user navigated meanwhile.
  if (seq !== renderSeq) {
    return;
  }

  if (mode === "week") {
    renderHourRuler(root);
    for (const cell of cells) {
      root.appendChild(
        weekDayColumn(cell, events, series, onEventClick),
      );
    }
    addHourLines();
  } else {
    for (const cell of cells) {
      root.appendChild(dayColumn(cell, events, series, onEventClick));
    }
  }
  document.getElementById("cal-label")!.textContent = label();
}

// --- Week view: time-grid ---------------------------------------------------
// Blocks are absolutely positioned per-day; top/height track start time and
// DURATION so an appointment's length is visible at a glance.

const MINUTES_PER_DAY = 24 * 60;

function fmtHour(h: number): string {
  // Week-view hour ruler follows the General time-format setting, same as
  // the event chips (owner request 2026-08-31).
  return formatTimeLabel(`${pad(h)}:00`, getTimeFormat());
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function renderHourRuler(root: HTMLElement): void {
  const ruler = document.createElement("div");
  ruler.className = "hour-ruler";
  // Owner layout (2026-08-31, refined): 24 slots, one label per bar —
  // 01:00 centred in the FIRST bar, 24:00 in the last, right after 23:00.
  // Slot-centred (not on the line) so the ruler starts at the top edge.
  for (let h = 1; h <= 24; h++) {
    const lbl = document.createElement("div");
    lbl.className = "hour-label";
    lbl.textContent = fmtRulerLabel(h);
    lbl.style.top = `${((h - 0.5) / 24) * 100}%`;
    ruler.appendChild(lbl);
  }
  root.appendChild(ruler);
}

/** Ruler label for the h:00 line; h=24 is the day boundary (00:00/24:00). */
function fmtRulerLabel(h: number): string {
  if (h === 24) return getTimeFormat() === "12h" ? "12:00 AM" : "24:00";
  return fmtHour(h);
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

/**
 * Outlook-style overlap layout: assign each event a horizontal "lane" so
 * events overlapping in time sit side by side, and events that merely chain
 * (A ends when B starts — touching is NOT overlapping) reuse the same lane.
 * `total` is the number of lanes in the event's own overlap cluster, so a
 * pair of overlapping events each span 50% while a lone event spans 100%.
 */
interface OverlapItem {
  ev: CalendarEvent;
  lane: number;
  total: number;
}

function layoutOverlapColumns(events: CalendarEvent[]): OverlapItem[] {
  const out: OverlapItem[] = [];
  let cluster: { ev: CalendarEvent; lane: number; laneEnd: number }[] = [];
  let clusterEnd = 0;

  const flush = () => {
    const total = cluster.reduce((m, c) => Math.max(m, c.lane + 1), 0);
    for (const c of cluster) out.push({ ev: c.ev, lane: c.lane, total });
    cluster = [];
  };

  for (const ev of events) {
    if (cluster.length > 0 && ev.startMs >= clusterEnd) flush(); // new cluster
    if (cluster.length === 0) {
      clusterEnd = ev.endMs;
      cluster.push({ ev, lane: 0, laneEnd: ev.endMs });
      continue;
    }
    // Place in the first lane whose last event ends at or before this start
    // (touching counts as free); otherwise open a new lane.
    let lane = cluster.findIndex((c) => ev.startMs >= c.laneEnd);
    if (lane === -1) {
      lane = cluster.length;
      cluster.push({ ev, lane, laneEnd: ev.endMs });
    } else {
      cluster[lane] = { ev, lane, laneEnd: ev.endMs };
    }
    clusterEnd = Math.max(clusterEnd, ev.endMs);
  }
  if (cluster.length > 0) flush();
  return out;
}


function weekDayColumn(
  cell: DayCell,
  events: CalendarEvent[],
  series: Map<string, SeriesInfo>,
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
  wireWeekColumnDrop(col, cell);

  // All-day lane on top (compact indicator on every day the event spans).
  // PLUS (owner request): a full 24h "column banner" inside the time grid so
  // the whole-day appointment visibly covers the entire day, Outlook-style.
  // The grid banner is click-through-inert (pointer-events: none) — the lane
  // chip owns selection/edit/delete, and the hour cells keep their click and
  // drop behavior (DnD targets ignore all-day events).
  for (const ev of events.filter(
    (e) =>
      e.allDay &&
      new Date(e.startMs) <= endOfDay(cell.date) &&
      new Date(e.endMs - 1) >= startOfDay(cell.date),
  )) {
    const laneChip = eventChip(ev, true, series);
    laneChip.classList.add("lane-chip");
    col.appendChild(laneChip);

    const banner = document.createElement("div");
    banner.className = "allday-banner";
    banner.textContent = ev.title;
    banner.title = `${ev.title} (whole day)`;
    col.appendChild(banner);
  }

  // Timed blocks: absolute positioning from clock times, with Outlook-style
  // overlap layout — events that overlap in time share the column's width
  // side by side (each gets left/width percentages), non-overlapping events
  // keep the full width.
  const timed = events
    .filter(
      (e) =>
        !e.allDay &&
        e.startMs < cell.date.getTime() + DAY_MS &&
        e.endMs > cell.date.getTime(),
    )
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  const lanes = layoutOverlapColumns(timed);
  for (const item of lanes) {
    const ev = item.ev;
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

    const chip = eventChip(ev, false, series);
    chip.classList.add("chip-timed");
    chip.style.top = `${topPct}%`;
    chip.style.height = `${heightPct}%`;
    // Horizontal split: lane index / lane count. A lone event spans 100%.
    const laneCount = Math.max(item.total, 1);
    chip.style.left = `${(item.lane / laneCount) * 100}%`;
    chip.style.width = `${(1 / laneCount) * 100}%`;
    chip.style.zIndex = String(3 + item.lane);
    chip.textContent = `${fmtTime(ev.startMs)} ${ev.title}`;
    col.appendChild(chip);
  }
  void onEventClick;

  // Real hour cells overlaying the column: hover shows the band, single
  // click selects it (highlight), double-click creates an event there.
  for (let h = 0; h < 24; h++) {
    const band = document.createElement("div");
    band.className = "hour-cell";
    if (h === clickedHour) band.classList.add("picked-band");
    band.dataset.hour = String(h);
    const startMin = h * 60;
    band.style.top = `${(startMin / MINUTES_PER_DAY) * 100}%`;
    band.style.height = `${(60 / MINUTES_PER_DAY) * 100}%`;
    band.title = `${formatTimeLabel(`${pad(h)}:00`, getTimeFormat())} – ${formatTimeLabel(`${pad((h + 1) % 24)}:00`, getTimeFormat())} (double-click: new appointment)`;
    col.appendChild(band);
  }

  // Single click on empty space: select day + highlight that hour band.
  // NOTE (owner bug 2026-09-04): NO render() here. render() synchronously
  // calls root.replaceChildren(), destroying this column between the two
  // clicks of a double-click — the browser then never dispatches dblclick
  // (both clicks must land on the same element) and dblclick-to-create was
  // dead. Selection state alone is enough: the .picked-band highlight is
  // applied by the next natural render (event save, view switch, nav), and
  // the band keeps its :hover affordance meanwhile.
  col.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    if (target.closest(".chip")) return; // chip handler owns that click
    selectedDate = startOfDay(cell.date);
    const cellDiv = target.closest(".hour-cell") as HTMLElement | null;
    clickedHour = cellDiv ? Number(cellDiv.dataset.hour) : null;
    document.dispatchEvent(
      new CustomEvent("tide:dayclick", { detail: cell.date.toISOString() }),
    );
  });
  // Double click: open the new-event dialog pre-seeded with day + hour.
  col.addEventListener("dblclick", (e) => {
    const target = e.target as HTMLElement;
    if (target.closest(".chip")) return;
    const cellDiv = target.closest(".hour-cell") as HTMLElement | null;
    const hour = cellDiv ? Number(cellDiv.dataset.hour) : new Date().getHours();
    selectedDate = startOfDay(cell.date);
    const d = new Date(cell.date);
    d.setHours(hour, 0, 0, 0);
    document.dispatchEvent(
      new CustomEvent("tide:neweventat", { detail: d.toISOString() }),
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
