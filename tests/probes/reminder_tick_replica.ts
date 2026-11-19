// Test adapter: drives the REAL per-tick logic (src/application/reminder_tick.ts,
// the same functions the sidecar's reminderTick calls) with an injected clock.
// No copied logic lives here any more.
import type Database from "better-sqlite3";
import { markDelivered, type ScheduledFire } from "../../src/application/reminder_engine.ts";
import { buildTickSchedule, computeDueReminders } from "../../src/application/reminder_tick.ts";

/** The schedule exactly as reminderTick builds it (before the due filter). */
export function scheduleLikeTick(
  db: Database.Database,
  nowMs: number,
  lastTickMs: number | null,
): ScheduledFire[] {
  return buildTickSchedule(db, nowMs, lastTickMs);
}

/** What one tick would DELIVER: schedule, minus delivered keys, only fires due now. */
export function dueLikeTick(
  db: Database.Database,
  nowMs: number,
  lastTickMs: number | null,
  delivered: Set<string>,
): ScheduledFire[] {
  const due = computeDueReminders(db, nowMs, lastTickMs, delivered);
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
