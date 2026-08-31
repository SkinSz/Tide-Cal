// Tide calendar grid: month view and week view, vanilla TS DOM rendering.
import type { CalendarEvent } from "./store.ts";
import { listEvents, listSeries, updateEvent, deleteEvent, type SeriesRow } from "./store.ts";
import { recurrenceBadge, type SeriesInfo } from "./recurrence.ts";
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

/**
 * Append the read-only recurrence indicator to a chip: 🔁 glyph + tooltip
 * with the plain-language rule (raw RRULE fallback), plus a "changed
 * occurrence" marker when overrides exist (DC-12 §2.2).
 */
function decorateRecurrence(
  chip: HTMLElement,
  ev: CalendarEvent,
  series: Map<string, SeriesInfo>,
): void {
  const info = series.get(ev.id);
  if (!info) return;
  const badge = recurrenceBadge(info);
  const glyph = document.createElement("span");
  glyph.className = "recurrence-glyph";
  glyph.textContent = badge.glyph;
  glyph.title = badge.tooltip;
  chip.appendChild(glyph);
  if (badge.hasOverride) {
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
  decorateRecurrence(chip, ev, series);
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
    decorateRecurrence(chip, ev, seriesLookup ?? new Map());
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
  document.addEventListener("dragover", (e) => {
    if (!dragEvent || dragEvent.id !== ev.id) return;
    const target = (e.target as HTMLElement | null)?.closest?.(".week-col") as HTMLElement | null;
    if (!target) {
      removeDragGhost();
      return;
    }
    e.preventDefault();
    if (ev.allDay) {
      updateAllDayGhost(target, ev);
    } else {
      updateDragGhost(target, e.clientY, Math.max((ev.endMs - ev.startMs) / 60000, 30));
    }
  });
  document.addEventListener("drop", removeDragGhost);
}

/** Whole-day drag ghost: a full-height banner preview on the target day. */
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
  const [events, series] = await Promise.all([
    eventsForRange(rangeStart, rangeEnd),
    seriesByBaseEvent(),
  ]);
  seriesLookup = series;
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
    band.title = `${pad(h)}:00 – ${pad((h + 1) % 24)}:00 (double-click: new appointment)`;
    col.appendChild(band);
  }

  // Single click on empty space: select day + highlight that hour band.
  col.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    if (target.closest(".chip")) return; // chip handler owns that click
    selectedDate = startOfDay(cell.date);
    const cellDiv = target.closest(".hour-cell") as HTMLElement | null;
    clickedHour = cellDiv ? Number(cellDiv.dataset.hour) : null;
    render();
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
