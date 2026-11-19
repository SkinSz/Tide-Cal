// DC-22: the reminder timer's per-tick logic, shared by the sidecar's
// reminderTick and the tests (one code path). Delivery, dispatch logging and the
// delivered ledger's pruning/marking stay in sidecar_server.ts.
//
// Recurring series (DC-22 amendment, owner decision 2026-11-19): a reminder on the
// base event applies to EVERY occurrence; a moved occurrence fires the reminder's
// offset before its NEW start; a cancelled occurrence has no reminder; there are no
// per-occurrence reminder overrides in v1.
import type Database from "better-sqlite3";
import {
  rebuildSchedule,
  filterDelivered,
  type EventRow,
  type ReminderRow,
  type ScheduledFire,
} from "./reminder_engine.ts";
import { expandOccurrences } from "../domain/recurrence_conflicts.ts";
import { baseStartWall, msFromWallId } from "../domain/wall_time.ts";

/** A series that could not be expanded; the timer falls back to the base event only. */
export interface TickProblem {
  kind: "series_expansion_failed";
  seriesId: string;
  eventId: string;
  /** error class name only: messages can carry calendar content */
  errorName: string;
}

/** One log line for a problem: ids only, never titles, descriptions or times. */
export function formatTickProblem(p: TickProblem): string {
  return `[tide] reminder schedule: recurring event not expanded (${p.errorName}); only its first occurrence can fire: series=${p.seriesId} event=${p.eventId}`;
}

interface OverrideSqlRow {
  recurrence_id: string;
  cancelled: number;
  title: string | null;
  start_wall: string | null;
  end_wall: string | null;
}

/** The full schedule as the tick builds it (before the delivered/due filters). */
export function buildTickSchedule(
  db: Database.Database,
  nowMs: number,
  lastTickMs: number | null,
  onProblem?: (p: TickProblem) => void,
): ScheduledFire[] {
  // Real events schema: timed events carry utc_start_ms/utc_end_ms (the
  // authoritative INSTANT, tz_id-resolved) plus a TIME-ONLY start_wall
  // ("09:00:00"); all-day events carry start_date/end_date (midnight wall
  // convention, local by definition).
  const baseEvents = db
    .prepare(
      `SELECT e.event_id AS entity_id, e.title,
              e.utc_start_ms, e.utc_end_ms,
              COALESCE(e.start_wall, e.start_date || 'T00:00') AS start_wall,
              COALESCE(e.end_wall, e.end_date || 'T23:59')      AS end_wall,
              e.all_day, e.all_day_reminder_time
       FROM events e`,
    )
    .all() as EventRow[];
  const seriesRows = db
    .prepare(`SELECT s.series_id, s.base_event_id, s.recurrence_rule FROM series s`)
    .all() as Array<{ series_id: string; base_event_id: string; recurrence_rule: string }>;
  const seriesByBase = new Map(seriesRows.map((s) => [s.base_event_id, s]));
  const overridesFor = db.prepare(
    `SELECT recurrence_id, cancelled, title, start_wall, end_wall
     FROM occurrence_overrides WHERE series_id = ?`,
  );
  // Window: 25h back (missed horizon, D1) to 1y forward.
  const WIN_LO = `${new Date(nowMs - 25 * 3_600_000).getFullYear()}0101T000000`;
  const WIN_HI = `${new Date(nowMs).getFullYear() + 1}1231T235959`;

  const events: EventRow[] = [];
  /** base event id -> synthetic occurrence ids that carry its reminders */
  const occurrencesOf = new Map<string, string[]>();
  for (const ev0 of baseEvents) {
    const timed = ev0.all_day !== 1 && ev0.utc_start_ms != null;
    // A timed event's label and wall come from its start INSTANT: the full local
    // date and time (the stored start_wall has no date).
    const ev: EventRow = timed ? { ...ev0, start_wall: baseStartWall(ev0.utc_start_ms as number) } : ev0;
    const row = seriesByBase.get(ev.entity_id);
    if (!row || !timed) {
      events.push(ev);
      continue;
    }
    let occIds: string[] = [];
    try {
      occIds = expandOccurrences(
        {
          series_id: row.series_id,
          base_start_wall: ev.start_wall, // full "YYYY-MM-DDTHH:MM", as the calendar builds it
          tz_id: "local",
          recurrence_rule: row.recurrence_rule,
        },
        WIN_LO,
        WIN_HI,
      );
    } catch (err) {
      onProblem?.({
        kind: "series_expansion_failed",
        seriesId: row.series_id,
        eventId: ev.entity_id,
        errorName: err instanceof Error ? err.name : "Error",
      });
      events.push(ev); // degraded: base-row behavior
      continue;
    }
    if (occIds.length === 0) {
      events.push(ev);
      continue;
    }
    const overrides = new Map(
      (overridesFor.all(row.series_id) as OverrideSqlRow[]).map((o) => [o.recurrence_id, o]),
    );
    const durMs = Math.max((ev.utc_end_ms ?? 0) - (ev.utc_start_ms as number), 0);
    const kept: string[] = [];
    for (const occId of occIds) {
      const ov = overrides.get(occId);
      if (ov?.cancelled) continue; // cancelled occurrence: no reminder
      const startMs = ov?.start_wall ? msFromWallId(ov.start_wall) : msFromWallId(occId);
      const endMs = ov?.end_wall ? msFromWallId(ov.end_wall) : startMs + durMs;
      const id = `${ev.entity_id}#${occId}`;
      kept.push(id);
      events.push({
        ...ev,
        entity_id: id,
        title: ov?.title ?? ev.title,
        start_wall: baseStartWall(startMs),
        utc_start_ms: startMs,
        utc_end_ms: endMs,
      });
    }
    occurrencesOf.set(ev.entity_id, kept);
  }

  const baseReminders = db
    .prepare(
      // DC-22 D5: disabled reminders (enabled = 0) are stored but INACTIVE
      // (NULL/1 = active). updated_hlc feeds the late-configuration discard.
      "SELECT member_id, entity_id, minutes_before, updated_hlc AS updated_hlc_ms FROM reminders WHERE enabled IS NULL OR enabled = 1",
    )
    .all() as ReminderRow[];
  // A reminder on a series' base event applies to every occurrence.
  const reminders: ReminderRow[] = [];
  for (const rem of baseReminders) {
    const occ = occurrencesOf.get(rem.entity_id);
    if (occ === undefined) reminders.push(rem);
    else for (const id of occ) reminders.push({ ...rem, entity_id: id });
  }
  return rebuildSchedule(events, reminders, nowMs, lastTickMs);
}

/**
 * Fires to deliver on this tick: the schedule minus already-delivered keys,
 * only those due at `nowMs`. Does NOT mark anything delivered (the caller marks
 * on confirmed dispatch).
 */
export function computeDueReminders(
  db: Database.Database,
  nowMs: number,
  lastTickMs: number | null,
  delivered: Set<string>,
  onProblem?: (p: TickProblem) => void,
): ScheduledFire[] {
  const schedule = buildTickSchedule(db, nowMs, lastTickMs, onProblem);
  // FUTURE fires (fire_at_ms > now) stay in the schedule and fire on a later
  // tick; only fires that are DUE NOW are delivered (smoke-test bug 2026-09-04).
  return filterDelivered(schedule, delivered).filter((f) => f.fire_at_ms <= nowMs);
}
