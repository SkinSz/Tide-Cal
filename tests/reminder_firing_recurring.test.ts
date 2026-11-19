// A1(a): do reminders on RECURRING timed events fire? Owner answer 1 (2026-11-19):
// the series reminder applies to every occurrence; a moved occurrence fires at
// minutes_before its NEW start; a cancelled occurrence does not fire.
// Inputs are assembled exactly as reminderTick does (tests/probes/reminder_tick_replica.ts).
import { afterAll, describe, expect, test } from "vitest";
import { rmSync } from "node:fs";
import { makeDevice, guardProcess } from "./probes/sync_probe_helpers.ts";
import { scheduleLikeTick } from "./probes/reminder_tick_replica.ts";

guardProcess();
const devs: Array<ReturnType<typeof makeDevice>> = [];
afterAll(() => {
  for (const d of devs) {
    try { d.db.close(); } catch { /* closed */ }
    try { rmSync(d.dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

const L = (y: number, mo: number, d: number, h: number, mi = 0): number =>
  new Date(y, mo - 1, d, h, mi, 0, 0).getTime();
const MIN = 60_000;

// Monday 2027-01-18 09:00-10:00, weekly on Mondays, reminder 15 min before.
function weekly() {
  const dev = makeDevice("W");
  devs.push(dev);
  const created = dev.core.createEvent({
    title: "Standup", description: "", startMs: L(2027, 1, 18, 9), endMs: L(2027, 1, 18, 10),
    allDay: false, recurrenceRule: "FREQ=WEEKLY;BYDAY=MO",
  });
  dev.core.setReminder(created.id, { minutesBefore: 15, enabled: true });
  const seriesId = dev.core.listSeries()[0]!.seriesId;
  return { dev, eventId: created.id, seriesId };
}
const NOW = L(2027, 1, 20, 12); // Wednesday after the first occurrence

describe("A1(a) recurring timed event + reminder: what the tick schedules", () => {
  test("control: a non-recurring event with a reminder is scheduled", () => {
    const dev = makeDevice("N");
    devs.push(dev);
    const e = dev.core.createEvent({ title: "once", description: "", startMs: L(2027, 1, 25, 9), endMs: L(2027, 1, 25, 10), allDay: false });
    dev.core.setReminder(e.id, { minutesBefore: 15, enabled: true });
    const fires = scheduleLikeTick(dev.db, NOW, 1);
    expect(fires.map((f) => f.fire_at_ms)).toEqual([L(2027, 1, 25, 8, 45)]);
  });

  test("weekly series: the next occurrence gets a fire at start - 15 min", () => {
    const { dev } = weekly();
    const fires = scheduleLikeTick(dev.db, NOW, 1).filter((f) => f.fire_at_ms > NOW);
    expect(fires.map((f) => f.fire_at_ms)[0]).toBe(L(2027, 1, 25, 8, 45));
  });

  test("weekly series: EVERY future occurrence is scheduled (next three Mondays)", () => {
    const { dev } = weekly();
    const got = scheduleLikeTick(dev.db, NOW, 1).filter((f) => f.fire_at_ms > NOW).map((f) => f.fire_at_ms);
    expect(got.slice(0, 3)).toEqual([L(2027, 1, 25, 8, 45), L(2027, 2, 1, 8, 45), L(2027, 2, 8, 8, 45)]);
  });

  test("moved occurrence: fires 15 min before its NEW start, not at the old time", () => {
    const { dev, seriesId } = weekly();
    // Monday 2027-01-25 09:00 moved to Tuesday 2027-01-26 10:30
    dev.core.updateOccurrence(seriesId, "20270125T090000", { start_wall: "2027-01-26T10:30" });
    const got = scheduleLikeTick(dev.db, NOW, 1).filter((f) => f.fire_at_ms > NOW).map((f) => f.fire_at_ms);
    expect(got).toContain(L(2027, 1, 26, 10, 15));
    expect(got).not.toContain(L(2027, 1, 25, 8, 45));
  });

  test("cancelled occurrence: no fire for it, the following occurrence still fires", () => {
    const { dev, seriesId } = weekly();
    dev.core.updateOccurrence(seriesId, "20270201T090000", { cancelled: true });
    const got = scheduleLikeTick(dev.db, NOW, 1).filter((f) => f.fire_at_ms > NOW).map((f) => f.fire_at_ms);
    expect(got).not.toContain(L(2027, 2, 1, 8, 45));
    expect(got).toContain(L(2027, 2, 8, 8, 45));
  });

  test("sanity of the unit: 15 min is 900000 ms", () => {
    expect(15 * MIN).toBe(900_000);
  });
});
