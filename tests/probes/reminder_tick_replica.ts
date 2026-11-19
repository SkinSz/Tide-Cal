// Test helper: a line-for-line replica of the INPUT ASSEMBLY of `reminderTick`
// in src/persistence/bridges/sidecar_server.ts (~1764-1901 at 02563c5).
//
// WHY A REPLICA: reminderTick is a closure inside the sidecar's main(); it is
// not exported and the sidecar harness cannot drive it with a fake clock. This
// helper issues the SAME SQL, performs the SAME series expansion and calls the
// SAME `rebuildSchedule` / `filterDelivered` / `markDelivered` functions with
// the same inputs. `nowMs` replaces Date.now(). It is a copy, so it can drift
// from the sidecar: when the fix lands, point this helper at the shared
// function the fix extracts (and delete the copy).
import type Database from "better-sqlite3";
import {
  rebuildSchedule,
  filterDelivered,
  markDelivered,
  type ScheduledFire,
} from "../../src/application/reminder_engine.ts";
import { expandOccurrences } from "../../src/domain/recurrence_conflicts.ts";

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

/** The schedule exactly as reminderTick builds it (before the due filter). */
export function scheduleLikeTick(
  db: Database.Database,
  nowMs: number,
  lastTickMs: number | null,
): ScheduledFire[] {
  const baseEvents = db
    .prepare(
      `SELECT e.event_id AS entity_id, e.title,
                  e.utc_start_ms, e.utc_end_ms,
                  COALESCE(e.start_wall, e.start_date || 'T00:00') AS start_wall,
                  COALESCE(e.end_wall, e.end_date || 'T23:59')      AS end_wall,
                  e.all_day, e.all_day_reminder_time
           FROM events e`,
    )
    .all() as never[];
  const events: never[] = [];
  const seriesRows = db
    .prepare(`SELECT s.series_id, s.base_event_id, s.recurrence_rule FROM series s`)
    .all() as Array<{ series_id: string; base_event_id: string; recurrence_rule: string }>;
  const seriesByBase = new Map(seriesRows.map((s) => [s.base_event_id, s]));
  const now = nowMs;
  const WIN_LO = `${new Date(now - 25 * 3_600_000).getFullYear()}0101T000000`;
  for (const ev of baseEvents) {
    const row = seriesByBase.get((ev as { entity_id: string }).entity_id);
    const timed =
      (ev as { all_day: number }).all_day !== 1 &&
      (ev as { utc_start_ms: number | null }).utc_start_ms != null;
    if (!row || !timed) {
      events.push(ev);
      continue;
    }
    let occIds: string[] = [];
    try {
      occIds = expandOccurrences(
        {
          series_id: row.series_id,
          base_start_wall: (ev as { start_wall: string }).start_wall,
          tz_id: "local",
          recurrence_rule: row.recurrence_rule,
        },
        WIN_LO,
        `${new Date(now).getFullYear() + 1}1231T235959`,
      );
    } catch {
      events.push(ev);
      continue;
    }
    if (occIds.length === 0) {
      events.push(ev);
      continue;
    }
    const durMs =
      ((ev as { utc_end_ms: number }).utc_end_ms ?? 0) -
      (ev as { utc_start_ms: number }).utc_start_ms;
    for (const occId of occIds) {
      const startMs = msFromWallId(occId);
      events.push({
        ...(ev as Record<string, unknown>),
        entity_id: `${(ev as { entity_id: string }).entity_id}#${occId}`,
        utc_start_ms: startMs,
        utc_end_ms: startMs + Math.max(durMs, 0),
      } as never);
    }
  }
  const reminders = db
    .prepare(
      "SELECT member_id, entity_id, minutes_before, updated_hlc AS updated_hlc_ms FROM reminders WHERE enabled IS NULL OR enabled = 1",
    )
    .all() as never[];
  return rebuildSchedule(events, reminders, nowMs, lastTickMs);
}

/** What one tick would DELIVER: schedule, minus delivered keys, only fires due now. */
export function dueLikeTick(
  db: Database.Database,
  nowMs: number,
  lastTickMs: number | null,
  delivered: Set<string>,
): ScheduledFire[] {
  const schedule = scheduleLikeTick(db, nowMs, lastTickMs);
  const due = filterDelivered(schedule, delivered).filter((f) => f.fire_at_ms <= nowMs);
  markDelivered(delivered, due);
  return due;
}

/**
 * Simulated timer, same bookkeeping as the sidecar: one initial tick at
 * `startMs` (lastTickMs null), then interval ticks at the given instants;
 * `lastTickMs` is assigned AFTER each interval tick (so the first interval
 * tick still sees null). Returns, per tick, what was delivered.
 */
export function runTicks(
  db: Database.Database,
  startMs: number,
  intervalTickInstants: number[],
  delivered: Set<string> = new Set(),
): Array<{ at: number; due: ScheduledFire[] }> {
  const out: Array<{ at: number; due: ScheduledFire[] }> = [];
  let lastTickMs: number | null = null;
  out.push({ at: startMs, due: dueLikeTick(db, startMs, lastTickMs, delivered) });
  for (const at of intervalTickInstants) {
    out.push({ at, due: dueLikeTick(db, at, lastTickMs, delivered) });
    lastTickMs = at;
  }
  return out;
}
