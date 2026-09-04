// DC-22 — reminder scheduling engine: rebuild purity (D8), fire policy (D1),
// all-day day-before semantics (D2), idempotency (D10), content (D6).
import { describe, expect, test } from "vitest";
import {
  rebuildSchedule,
  filterDelivered,
  markDelivered,
  renderNotification,
  type EventRow,
  type ReminderRow,
} from "../src/application/reminder_engine.ts";

const event = (over: Partial<EventRow> & { entity_id: string }): EventRow => ({
  title: "Dentist",
  start_wall: "2026-09-10T09:00",
  end_wall: "2026-09-10T10:00",
  all_day: 0,
  all_day_reminder_time: null,
  ...over,
});
const reminder = (over: Partial<ReminderRow> & { member_id: string; entity_id: string }): ReminderRow => ({
  minutes_before: 30,
  ...over,
});
// Evaluation instant: 2026-09-08 12:00 local.
const NOW = new Date(2026, 8, 8, 12, 0).getTime();
const ms = (s: string): number => new Date(s.replace("T", " ")).getTime();

describe("DC-22 D3/D8: relative offsets derived to future fire instants", () => {
  test("30-min reminder schedules 30 minutes before start", () => {
    const ev = event({ entity_id: "e-1" });
    const fires = rebuildSchedule([ev], [reminder({ member_id: "m-1", entity_id: "e-1" })], NOW);
    expect(fires).toHaveLength(1);
    expect(fires[0]!.fire_at_ms).toBe(ms("2026-09-10T08:30"));
    expect(fires[0]!.missed).toBe(false);
  });

  test("tombstoned/absent event → reminder never scheduled (§6.1)", () => {
    const fires = rebuildSchedule([], [reminder({ member_id: "m-1", entity_id: "e-ghost" })], NOW);
    expect(fires).toEqual([]);
  });
});

describe("DC-22 D1: missed-while-not-running = show-on-launch, discard after end", () => {
  test("fire_at passed but event not yet ended → missed surface", () => {
    // Start Sep 8 09:00 (this morning, already passed at NOW=12:00), end 13:00.
    const ev = event({
      entity_id: "e-1",
      start_wall: "2026-09-08T09:00",
      end_wall: "2026-09-08T13:00",
      utc_start_ms: ms("2026-09-08T09:00"),
      utc_end_ms: ms("2026-09-08T13:00"),
    });
    const fires = rebuildSchedule([ev], [reminder({ member_id: "m-1", entity_id: "e-1", minutes_before: 30 })], NOW);
    expect(fires).toHaveLength(1);
    expect(fires[0]!.missed).toBe(true);
    expect(fires[0]!.fire_at_ms).toBe(ms("2026-09-08T08:30"));
  });

  test("on-time decision: previous tick BEFORE fireAt → on-time even if this tick is very late (owner 2026-09-04)", () => {
    // Fire moment 11:30, event 12:00. Previous tick ran 11:29 (before the
    // moment) — the engine was alive when the moment passed; the current
    // tick (NOW=12:00, 30 min late because of an overrun/suspend edge) is
    // still the FIRST delivery chance → on-time, NOT missed.
    const ev = event({
      entity_id: "e-1",
      start_wall: "2026-09-08T12:00",
      end_wall: "2026-09-08T14:00",
      utc_start_ms: ms("2026-09-08T12:00"),
      utc_end_ms: ms("2026-09-08T14:00"),
    });
    const lastTick = ms("2026-09-08T11:29");
    const fires = rebuildSchedule(
      [ev],
      [reminder({ member_id: "m-1", entity_id: "e-1", minutes_before: 30 })],
      NOW,
      lastTick,
    );
    expect(fires).toHaveLength(1);
    expect(fires[0]!.missed).toBe(false);
    expect(fires[0]!.fire_at_ms).toBe(ms("2026-09-08T11:30"));
  });

  test("on-time decision: fire moment predates previous tick → genuinely missed (engine was down)", () => {
    // Fire moment 08:30, previous tick 09:00 — the moment passed BEFORE the
    // last tick, so that tick should have delivered it and didn't: the
    // engine was down/suspended → missed.
    const ev = event({
      entity_id: "e-1",
      start_wall: "2026-09-08T09:00",
      end_wall: "2026-09-08T13:00",
      utc_start_ms: ms("2026-09-08T09:00"),
      utc_end_ms: ms("2026-09-08T13:00"),
    });
    const lastTick = ms("2026-09-08T09:00");
    const fires = rebuildSchedule(
      [ev],
      [reminder({ member_id: "m-1", entity_id: "e-1", minutes_before: 30 })],
      NOW,
      lastTick,
    );
    expect(fires).toHaveLength(1);
    expect(fires[0]!.missed).toBe(true);
  });

  test("on-time decision: first tick after start (lastTickMs null) → missed per D1", () => {
    // No previous tick exists — show-on-launch semantic.
    const ev = event({
      entity_id: "e-1",
      start_wall: "2026-09-08T09:00",
      end_wall: "2026-09-08T13:00",
      utc_start_ms: ms("2026-09-08T09:00"),
      utc_end_ms: ms("2026-09-08T13:00"),
    });
    const fires = rebuildSchedule(
      [ev],
      [reminder({ member_id: "m-1", entity_id: "e-1", minutes_before: 30 })],
      NOW,
      null,
    );
    expect(fires).toHaveLength(1);
    expect(fires[0]!.missed).toBe(true);
  });

  test("event fully ended → reminder discarded (not noise)", () => {
    const ev = event({
      entity_id: "e-1",
      start_wall: "2026-09-07T09:00",
      end_wall: "2026-09-07T10:00",
      utc_start_ms: ms("2026-09-07T09:00"),
      utc_end_ms: ms("2026-09-07T10:00"),
    });
    const fires = rebuildSchedule([ev], [reminder({ member_id: "m-1", entity_id: "e-1" })], NOW);
    expect(fires).toEqual([]);
  });
});

describe("DC-22 D2: all-day events fire the DAY BEFORE at the picked time", () => {
  test("day-before at picked 20:00; minutes_before measures back from it", () => {
    const ev = event({
      entity_id: "e-allday",
      title: "Conference",
      start_wall: "2026-09-15T00:00",
      end_wall: "2026-09-16T00:00",
      all_day: 1,
      all_day_reminder_time: "20:00",
    });
    const fires = rebuildSchedule([ev], [reminder({ member_id: "m-1", entity_id: "e-allday" })], NOW);
    expect(fires).toHaveLength(1);
    expect(fires[0]!.fire_at_ms).toBe(ms("2026-09-14T20:00"));
  });

  test("all-day created for TODAY, day-before moment passed → immediate missed (D1)", () => {
    const ev = event({
      entity_id: "e-today",
      start_wall: "2026-09-08T00:00",
      end_wall: "2026-09-09T00:00",
      all_day: 1,
      all_day_reminder_time: "20:00",
    });
    // NOW is Sep 8 12:00; day-before moment was Sep 7 20:00 — passed.
    const fires = rebuildSchedule([ev], [reminder({ member_id: "m-1", entity_id: "e-today" })], NOW);
    expect(fires).toHaveLength(1);
    expect(fires[0]!.missed).toBe(true);
  });

  test("all-day without a picked time is not scheduled (opt-in, no default in v1)", () => {
    const ev = event({ entity_id: "e-allday", all_day: 1, all_day_reminder_time: null });
    expect(rebuildSchedule([ev], [reminder({ member_id: "m-1", entity_id: "e-allday" })], NOW)).toEqual([]);
  });
});

describe("DC-22 D10: idempotency — deterministic keys + delivered-once guard", () => {
  test("rebuilding twice yields identical keys (restart cannot duplicate)", () => {
    const ev = event({ entity_id: "e-1" });
    const rems = [reminder({ member_id: "m-1", entity_id: "e-1" })];
    const a = rebuildSchedule([ev], rems, NOW);
    const b = rebuildSchedule([ev], rems, NOW);
    expect(a.map((f) => f.key)).toEqual(b.map((f) => f.key));
  });

  test("filterDelivered + markDelivered: fired keys never fire again in-session", () => {
    const ev = event({ entity_id: "e-1" });
    const rems = [reminder({ member_id: "m-1", entity_id: "e-1" })];
    const schedule = rebuildSchedule([ev], rems, NOW);
    const delivered = new Set<string>();
    const due = filterDelivered(schedule, delivered);
    markDelivered(delivered, due);
    // Rebuild after the same state: everything already delivered → nothing.
    const schedule2 = rebuildSchedule([ev], rems, NOW);
    expect(filterDelivered(schedule2, delivered)).toEqual([]);
  });

  test("event moved → NEW key (old entry dropped, replace-before-schedule)", () => {
    const before = event({ entity_id: "e-1" });
    const after = event({ entity_id: "e-1", start_wall: "2026-09-10T14:00" });
    const k1 = rebuildSchedule([before], [reminder({ member_id: "m-1", entity_id: "e-1" })], NOW)[0]!.key;
    const k2 = rebuildSchedule([after], [reminder({ member_id: "m-1", entity_id: "e-1" })], NOW)[0]!.key;
    expect(k1).not.toBe(k2);
  });
});

describe("DC-22 pkg10 fixes: F1 confirmed dispatch, F3 tz instant, F4 all-day label", () => {
  test("F3: timed event uses utc_start_ms, not device-local reinterpretation", () => {
    // Event at 18:00 in a timezone 2h ahead of the device → utc_start_ms is
    // 16:00 device time. Wall string says "18:00" but must NOT be used.
    const utcStart = ms("2026-09-10T16:00");
    const ev = event({
      entity_id: "e-tz",
      start_wall: "2026-09-10T18:00",
      end_wall: "2026-09-10T19:00",
      utc_start_ms: utcStart,
      utc_end_ms: utcStart + 3_600_000,
    });
    const fires = rebuildSchedule([ev], [reminder({ member_id: "m-tz", entity_id: "e-tz", minutes_before: 30 })], NOW);
    expect(fires).toHaveLength(1);
    expect(fires[0]!.fire_at_ms).toBe(utcStart - 30 * 60_000);
  });

  test("F3: D1 discard rule uses utc_end_ms when present", () => {
    const utcStart = ms("2026-09-08T07:00"); // fire_at = 06:30, before NOW=12:00
    const ev = event({
      entity_id: "e-past",
      start_wall: "2026-09-08T09:00",
      end_wall: "2026-09-08T10:00",
      utc_start_ms: utcStart,
      utc_end_ms: NOW + 60_000, // event ends 1 min from NOW → still live
    });
    const fires = rebuildSchedule([ev], [reminder({ member_id: "m-p", entity_id: "e-past", minutes_before: 30 })], NOW);
    expect(fires).toHaveLength(1);
    expect(fires[0]!.missed).toBe(true);
  });

  test("F4: all-day label is the date, no fabricated 00:00", () => {
    const ev = event({
      entity_id: "e-ld",
      title: "Offsite",
      start_wall: "2026-09-15T00:00",
      end_wall: "2026-09-16T00:00",
      all_day: 1,
      all_day_reminder_time: "20:00",
    });
    const [fire] = rebuildSchedule([ev], [reminder({ member_id: "m-ld", entity_id: "e-ld" })], NOW);
    expect(fire!.event_start_label).toBe("2026-09-15");
  });

  test("D5: disabled reminders (enabled=0) are excluded by the sidecar SQL filter shape", () => {
    // Engine-level contract: a reminder absent from the input is never
    // scheduled (the SQL WHERE enabled IS NULL OR enabled=1 enforces D5).
    const ev = event({ entity_id: "e-1" });
    expect(rebuildSchedule([ev], [], NOW)).toEqual([]);
  });
});

describe("DC-22 D6: notification content — title + time only", () => {
  test("normal fire renders title + start; missed renders missed context", () => {
    const ev = event({ entity_id: "e-1", title: "Dentist" });
    const [fire] = rebuildSchedule([ev], [reminder({ member_id: "m-1", entity_id: "e-1" })], NOW);
    const normal = renderNotification(fire!);
    expect(normal.summary).toBe("Dentist");
    expect(normal.body).toBe("Starts 2026-09-10 09:00");

    const lateEv = event({
      entity_id: "e-2",
      start_wall: "2026-09-08T09:00",
      end_wall: "2026-09-08T13:00",
      utc_start_ms: ms("2026-09-08T09:00"),
      utc_end_ms: ms("2026-09-08T13:00"),
    });
    const [missedFire] = rebuildSchedule([lateEv], [reminder({ member_id: "m-2", entity_id: "e-2" })], NOW);
    const missed = renderNotification(missedFire!);
    expect(missed.summary).toContain("Missed");
    expect(missed.summary).toContain("Dentist");
  });
});
