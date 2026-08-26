// Tide app-shell IPC bridge: event CRUD over Tauri invoke, with a
// localStorage fallback so the UI also runs in a plain browser (vite dev).
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
}

// --- localStorage fallback -------------------------------------------------

const LS_KEY = "tide.events.v1";

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
  tauriCall: () => Promise<T>,
  fallback: () => Promise<T>,
): Promise<T> {
  if (usingFallback) return fallback();
  try {
    return await tauriCall();
  } catch (e) {
    // No Tauri runtime (plain browser) or backend error -> degrade gracefully.
    console.warn("[tide] IPC unavailable, using local fallback store:", e);
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

export function listEvents(range?: {
  fromMs: number;
  toMs: number;
}): Promise<CalendarEvent[]> {
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
  return withFallback(
    () => invoke<CalendarEvent>("create_event", { input }),
    () => {
      const event: CalendarEvent = { id: newId(), ...input };
      lsSave([...lsLoad(), event]);
      return Promise.resolve(event);
    },
  );
}

export function updateEvent(
  id: string,
  input: EventInput,
): Promise<CalendarEvent> {
  return withFallback(
    () => invoke<CalendarEvent>("update_event", { id, input }),
    () => {
      const events = lsLoad();
      const idx = events.findIndex((e) => e.id === id);
      if (idx === -1) return Promise.reject(new Error("event not found"));
      events[idx] = { id, ...input };
      lsSave(events);
      return Promise.resolve(events[idx]);
    },
  );
}

export function deleteEvent(id: string): Promise<void> {
  return withFallback(
    () => invoke<void>("delete_event", { id }),
    () => {
      lsSave(lsLoad().filter((e) => e.id !== id));
      return Promise.resolve();
    },
  );
}
