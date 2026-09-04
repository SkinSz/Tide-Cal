// Tide app-shell IPC bridge: event CRUD over the desktop event store, with a
// localStorage fallback so the UI also runs in a plain browser (vite dev).
//
// Store resolution order:
//   1. Injected domain-core bridge (window.__TIDE_EVENT_STORE__). The desktop
//      runtime can inject an adapter backed by src/persistence/bridges/
//      event_core.ts (EventCore), so every mutation flows through DC-07
//      createLocalChange() — change records + device_clock advance included.
//      The sidecar (dist/sidecar.mjs) exposes exactly this interface over its
//      stdio protocol for the shell to proxy.
//   2. Tauri invoke() against the shell's event commands.
//   3. localStorage fallback (plain browser).
import { invoke } from "@tauri-apps/api/core";

export interface CalendarEvent {
  id: string;
  title: string;
  description: string;
  /** epoch ms */
  startMs: number;
  /** epoch ms */
  endMs: number;
  allDay: boolean;
}

export interface EventInput {
  title: string;
  description: string;
  startMs: number;
  endMs: number;
  allDay: boolean;
  /**
   * DC-12 §2.1: optional RFC 5545 RRULE — CREATE only (makes the event the
   * base event of a recurring series). Never sent on update_event (rule
   * edits go through updateSeriesRule).
   */
  recurrenceRule?: string;
}

/**
 * Contract implemented by the TS domain-core bridge (see
 * src/persistence/bridges/event_core.ts). Mirrors the public API below.
 */
export interface EventStoreBridge {
  listEvents(range?: { fromMs?: number | null; toMs?: number | null }):
    | CalendarEvent[]
    | Promise<CalendarEvent[]>;
  createEvent(input: EventInput): CalendarEvent | Promise<CalendarEvent>;
  updateEvent(id: string, input: EventInput): CalendarEvent | Promise<CalendarEvent>;
  deleteEvent(id: string): void | Promise<void>;
  /**
   * READ-ONLY recurrence surfacing (DC-12 §2): series rows + overrides.
   * Optional — older bridges without it simply show no recurrence indicators.
   */
  listSeries?():
    | Array<{
        seriesId: string;
        baseEventId: string;
        recurrenceRule: string;
        overrides: Array<{
          recurrenceId: string;
          cancelled: boolean;
          title?: string | null;
          startWall?: string | null;
          endWall?: string | null;
          tzId?: string | null;
        }>;
      }>
    | Promise<
        Array<{
          seriesId: string;
          baseEventId: string;
          recurrenceRule: string;
          overrides: Array<{
            recurrenceId: string;
            cancelled: boolean;
            title?: string | null;
            startWall?: string | null;
            endWall?: string | null;
            tzId?: string | null;
          }>;
        }>
      >;
  /**
   * DC-12 §2.1 write path: edit a series' recurrence rule (its own conflict
   * entity). Optional — bridges without it degrade to a rejected save.
   */
  updateSeriesRule?(
    seriesId: string,
    rule: string,
  ): { seriesId: string; recurrenceRule: string } | Promise<{ seriesId: string; recurrenceRule: string }>;
  /**
   * DC-12 §2.2/§4.1 write path: create/edit one occurrence override keyed
   * (series_id, recurrence_id). Optional.
   */
  updateOccurrence?(
    seriesId: string,
    recurrenceId: string,
    patch: {
      cancelled?: boolean;
      title?: string;
      start_wall?: string;
      end_wall?: string;
      tz_id?: string;
    },
  ):
    | { seriesId: string; recurrenceId: string; changed: string[] }
    | Promise<{ seriesId: string; recurrenceId: string; changed: string[] }>;
}

declare global {
  interface Window {
    /** Injected by the desktop runtime; see EventStoreBridge docs. */
    __TIDE_EVENT_STORE__?: EventStoreBridge;
  }
}

function injectedBridge(): EventStoreBridge | undefined {
  try {
    return globalThis.window?.__TIDE_EVENT_STORE__;
  } catch {
    return undefined;
  }
}

// --- localStorage fallback -------------------------------------------------

const LS_KEY = "tide.events.v1";
// DC-12: localStorage fallback series/overrides store (plain-browser dev only;
// the real store keeps these in SQLite via EventCore / the sidecar).
const LS_SERIES_KEY = "tide.series.v1";
const LS_OVERRIDES_KEY = "tide.overrides.v1";

interface LsSeries {
  seriesId: string;
  baseEventId: string;
  recurrenceRule: string;
}
interface LsOverride {
  seriesId: string;
  recurrenceId: string;
  cancelled: boolean;
  title?: string | null;
  start_wall?: string | null;
  end_wall?: string | null;
  tz_id?: string | null;
}

function lsJson<T>(key: string): T[] {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "[]") as T[];
  } catch {
    return [];
  }
}

function lsLoad(): CalendarEvent[] {
  try {
    return JSON.parse(localStorage.getItem(LS_KEY) ?? "[]") as CalendarEvent[];
  } catch {
    return [];
  }
}

function lsSave(events: CalendarEvent[]): void {
  localStorage.setItem(LS_KEY, JSON.stringify(events));
}

let usingFallback = false;

async function withFallback<T>(
  primary: () => Promise<T>,
  fallback: () => Promise<T>,
): Promise<T> {
  if (usingFallback) return fallback();
  try {
    return await primary();
  } catch (e) {
    // No Tauri runtime (plain browser) or backend error -> degrade gracefully.
    console.warn("[tide] primary store unavailable, using local fallback:", e);
    usingFallback = true;
    return fallback();
  }
}

function lsList(range?: { fromMs: number; toMs: number }): Promise<CalendarEvent[]> {
  const events = lsLoad();
  const filtered = range
    ? events.filter((e) => e.startMs < range.toMs && e.endMs > range.fromMs)
    : events;
  return Promise.resolve(filtered.sort(byStart));
}

function byStart(a: CalendarEvent, b: CalendarEvent): number {
  return a.startMs - b.startMs || a.title.localeCompare(b.title);
}

function newId(): string {
  return (
    Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10)
  );
}

// --- public API ------------------------------------------------------------

export interface SeriesRow {
  seriesId: string;
  baseEventId: string;
  recurrenceRule: string;
  overrides: Array<{
    recurrenceId: string;
    cancelled: boolean;
    title?: string | null;
    startWall?: string | null;
    endWall?: string | null;
    tzId?: string | null;
  }>;
}

/**
 * READ-ONLY: series + occurrence_overrides for recurrence surfacing.
 * Falls back to [] when no backend exposes it (localStorage fallback store
 * has no series concept) — callers then simply render no indicators.
 */
export function listSeries(): Promise<SeriesRow[]> {
  const bridge = injectedBridge();
  const run = async () =>
    bridge?.listSeries
      ? bridge.listSeries()
      : invoke<SeriesRow[]>("list_series");
  // Per-call display fallback ONLY — must NOT set the global usingFallback
  // flag: list_series is an optional decoration whose absence (backend not
  // wired yet, plain browser) says nothing about event-CRUD availability.
  // Poisoning the global flag here silently diverted all subsequent event
  // CRUD to localStorage in the desktop app (verifier-found MAJOR bug).
  return run().catch((e) => {
    // Plain-browser fallback store: return the LS series data (DC-12) when
    // there is no bridge at all; with a bridge, a failed lookup is simply
    // "no indicators" (never poison event CRUD — see comment above).
    if (!bridge) {
      return lsJson<LsSeries>(LS_SERIES_KEY).map((s) => ({
        seriesId: s.seriesId,
        baseEventId: s.baseEventId,
        recurrenceRule: s.recurrenceRule,
        overrides: lsJson<LsOverride>(LS_OVERRIDES_KEY)
          .filter((o) => o.seriesId === s.seriesId)
          .map((o) => ({
            recurrenceId: o.recurrenceId,
            cancelled: o.cancelled,
            title: o.title ?? null,
            startWall: o.start_wall ?? null,
            endWall: o.end_wall ?? null,
            tzId: o.tz_id ?? null,
          })),
      }));
    }
    console.warn("[tide] listSeries unavailable, showing no indicators:", e);
    return [] as SeriesRow[];
  });
}

// --- DC-22: reminder member surface (event dialog "Remind me") ------------

/** Read one event's reminder, or null (no reminder configured). */
export function getReminder(
  eventId: string,
): Promise<{ minutesBefore: number; enabled: boolean } | null> {
  return invoke<{ minutesBefore: number; enabled: boolean } | null>("get_reminder", {
    event_id: eventId,
  });
}

/** Create-or-update the event's reminder member (DC-22 D5). */
export function setReminder(eventId: string, minutesBefore: number): Promise<void> {
  return invoke("set_reminder", { event_id: eventId, minutes_before: minutesBefore, enabled: true });
}

/** Remove the event's reminder member. */
export function clearReminder(eventId: string): Promise<void> {
  return invoke("clear_reminder", { event_id: eventId });
}

export function listEvents(range?: {
  fromMs: number;
  toMs: number;
}): Promise<CalendarEvent[]> {
  const bridge = injectedBridge();
  if (bridge) {
    return withFallback(
      () =>
        Promise.resolve(
          bridge.listEvents({ fromMs: range?.fromMs ?? null, toMs: range?.toMs ?? null }),
        ),
      () => lsList(range),
    );
  }
  return withFallback(
    () =>
      invoke<CalendarEvent[]>("list_events", {
        fromMs: range?.fromMs ?? null,
        toMs: range?.toMs ?? null,
      }),
    () => lsList(range),
  );
}

export function createEvent(input: EventInput): Promise<CalendarEvent> {
  const bridge = injectedBridge();
  if (bridge) {
    return withFallback(
      () => Promise.resolve(bridge.createEvent(input)),
      () => {
        const event = lsCreateEvent(input);
        return Promise.resolve(event);
      },
    );
  }
  return withFallback(
    () => invoke<CalendarEvent>("create_event", { input }),
    () => {
      const event = lsCreateEvent(input);
      return Promise.resolve(event);
    },
  );
}

/** LS fallback create: stores the event + a series row when a rule is set. */
function lsCreateEvent(input: EventInput): CalendarEvent {
  const event: CalendarEvent = { id: newId(), ...input };
  lsSave([...lsLoad(), event]);
  if (input.recurrenceRule) {
    const series: LsSeries = {
      seriesId: newId(),
      baseEventId: event.id,
      recurrenceRule: input.recurrenceRule,
    };
    localStorage.setItem(
      LS_SERIES_KEY,
      JSON.stringify([...lsJson<LsSeries>(LS_SERIES_KEY), series]),
    );
  }
  return event;
}

export function updateEvent(
  id: string,
  input: EventInput,
): Promise<CalendarEvent> {
  // DC-12: recurrenceRule is CREATE-only — never sent on update (rule edits
  // go through updateSeriesRule; the sidecar rejects it otherwise).
  const { recurrenceRule: _drop, ...base } = input;
  void _drop;
  const bridge = injectedBridge();
  if (bridge) {
    return withFallback(
      () => Promise.resolve(bridge.updateEvent(id, base)),
      () => {
        const events = lsLoad();
        const idx = events.findIndex((e) => e.id === id);
        if (idx === -1) return Promise.reject(new Error("event not found"));
        events[idx] = { id, ...base };
        lsSave(events);
        return Promise.resolve(events[idx]);
      },
    );
  }
  return withFallback(
    () => invoke<CalendarEvent>("update_event", { id, input: base }),
    () => {
      const events = lsLoad();
      const idx = events.findIndex((e) => e.id === id);
      if (idx === -1) return Promise.reject(new Error("event not found"));
      events[idx] = { id, ...base };
      lsSave(events);
      return Promise.resolve(events[idx]);
    },
  );
}

export function deleteEvent(id: string): Promise<void> {
  const bridge = injectedBridge();
  if (bridge) {
    return withFallback(
      () => Promise.resolve(bridge.deleteEvent(id)),
      () => {
        lsSave(lsLoad().filter((e) => e.id !== id));
        return Promise.resolve();
      },
    );
  }
  return withFallback(
    () => invoke<void>("delete_event", { id }),
    () => {
      lsSave(lsLoad().filter((e) => e.id !== id));
      // D7 (DC-12 §4.2): removing a series' base event removes the series
      // and its overrides in the fallback store too.
      const series = lsJson<LsSeries>(LS_SERIES_KEY);
      const dead = series.filter((s) => s.baseEventId === id).map((s) => s.seriesId);
      if (dead.length > 0) {
        localStorage.setItem(
          LS_SERIES_KEY,
          JSON.stringify(series.filter((s) => !dead.includes(s.seriesId))),
        );
        localStorage.setItem(
          LS_OVERRIDES_KEY,
          JSON.stringify(
            lsJson<LsOverride>(LS_OVERRIDES_KEY).filter(
              (o) => !dead.includes(o.seriesId),
            ),
          ),
        );
      }
      return Promise.resolve();
    },
  );
}

/**
 * DC-12 §2.1/§3: edit a series' recurrence rule. Its own conflict entity
 * (series_id, "recurrence_rule"); stored verbatim by the domain core.
 */
export function updateSeriesRule(
  seriesId: string,
  rule: string,
): Promise<{ seriesId: string; recurrenceRule: string }> {
  const bridge = injectedBridge();
  const run = async () => {
    if (bridge?.updateSeriesRule) return bridge.updateSeriesRule(seriesId, rule);
    return invoke<{ seriesId: string; recurrenceRule: string }>(
      "update_series_rule",
      { series_id: seriesId, rule },
    );
  };
  const fallback = () => {
    const series = lsJson<LsSeries>(LS_SERIES_KEY);
    const idx = series.findIndex((s) => s.seriesId === seriesId);
    if (idx === -1) return Promise.reject(new Error("series not found"));
    series[idx] = {
      seriesId: series[idx]!.seriesId,
      baseEventId: series[idx]!.baseEventId,
      recurrenceRule: rule,
    };
    localStorage.setItem(LS_SERIES_KEY, JSON.stringify(series));
    return Promise.resolve({ seriesId, recurrenceRule: rule });
  };
  if (bridge) {
    return withFallback(() => Promise.resolve(run()), fallback);
  }
  return withFallback(() => run(), fallback);
}

export interface OccurrencePatch {
  cancelled?: boolean;
  title?: string;
  start_wall?: string;
  end_wall?: string;
  tz_id?: string;
}

/**
 * DC-12 §2.2/§2.3/§4.1: create/edit one occurrence override keyed
 * (series_id, recurrence_id). recurrence_id is the canonical wall-clock id
 * of the ORIGINAL occurrence (deriveRecurrenceId) and is never rewritten (R2).
 */
export function updateOccurrence(
  seriesId: string,
  recurrenceId: string,
  patch: OccurrencePatch,
): Promise<{ seriesId: string; recurrenceId: string; changed: string[] }> {
  const bridge = injectedBridge();
  const run = async () => {
    if (bridge?.updateOccurrence) return bridge.updateOccurrence(seriesId, recurrenceId, patch);
    return invoke<{ seriesId: string; recurrenceId: string; changed: string[] }>(
      "update_occurrence",
      { series_id: seriesId, recurrence_id: recurrenceId, patch },
    );
  };
  const fallback = () => {
    const overrides = lsJson<LsOverride>(LS_OVERRIDES_KEY);
    const idx = overrides.findIndex(
      (o) => o.seriesId === seriesId && o.recurrenceId === recurrenceId,
    );
    if (idx === -1) {
      overrides.push({
        seriesId,
        recurrenceId,
        cancelled: patch.cancelled ?? false,
        title: patch.title ?? null,
        start_wall: patch.start_wall ?? null,
        end_wall: patch.end_wall ?? null,
        tz_id: patch.tz_id ?? null,
      });
    } else {
      overrides[idx] = { ...overrides[idx]!, ...patch };
    }
    localStorage.setItem(LS_OVERRIDES_KEY, JSON.stringify(overrides));
    return Promise.resolve({
      seriesId,
      recurrenceId,
      changed: Object.keys(patch),
    });
  };
  if (bridge) {
    return withFallback(() => Promise.resolve(run()), fallback);
  }
  return withFallback(() => run(), fallback);
}
