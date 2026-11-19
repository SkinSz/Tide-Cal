// Reminder sync: further tests (the committed tests of edc6146 are
// unchanged). Firing-expansion failure reporting, notification date, stable keys,
// event-restore bringing reminders back, delete cascade without extra changes,
// dialog count.
import { afterAll, describe, expect, test } from "vitest";
import { rmSync } from "node:fs";
import { makeDevice, sessionOnce, guardProcess, type Device } from "./probes/sync_probe_helpers.ts";
import { buildTickSchedule, formatTickProblem, type TickProblem } from "../src/application/reminder_tick.ts";
import { renderNotification } from "../src/application/reminder_engine.ts";
import { createLocalChange } from "../src/persistence/database.ts";

guardProcess();
const all: Device[] = [];
const mk = (tag: string): Device => { const d = makeDevice(tag); all.push(d); return d; };
afterAll(() => {
  for (const d of all) {
    try { d.db.close(); } catch { /* closed */ }
    try { rmSync(d.dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});
const L = (y: number, mo: number, d: number, h: number, mi = 0): number => new Date(y, mo - 1, d, h, mi).getTime();
const NOW = L(2027, 1, 20, 12);

describe("firing: expansion failure is reported, not silent", () => {
  test("a series that cannot be expanded is reported with ids only (no title), and the base event still fires", () => {
    const d = mk("X");
    const e = d.core.createEvent({
      title: "Secret-Title-123", description: "Secret-Description", startMs: L(2027, 1, 25, 9), endMs: L(2027, 1, 25, 10),
      allDay: false, recurrenceRule: "FREQ=WEEKLY;BYDAY=MO",
    });
    d.core.setReminder(e.id, { minutesBefore: 15, enabled: true });
    const sid = d.core.listSeries()[0]!.seriesId;
    // The only input expansion rejects is an unusable start; force one (an out-of-range instant).
    d.db.prepare("UPDATE events SET utc_start_ms = 9000000000000000, utc_end_ms = 9000000000000000 WHERE event_id = ?").run(e.id);
    const problems: TickProblem[] = [];
    const fires = buildTickSchedule(d.db, NOW, 1, (p) => problems.push(p));
    expect(problems.length).toBe(1);
    expect(problems[0]).toMatchObject({ kind: "series_expansion_failed", seriesId: sid, eventId: e.id });
    const line = formatTickProblem(problems[0]!);
    expect(line).toContain(sid);
    expect(line).toContain(e.id);
    expect(line).not.toContain("Secret");
    // degraded, not crashed: the tick still returns a schedule
    expect(Array.isArray(fires)).toBe(true);
  });
});

describe("firing: notification and keys", () => {
  test("a timed reminder's notification text carries the date and time (no bare time)", () => {
    const d = mk("N");
    const e = d.core.createEvent({ title: "Dentist", description: "", startMs: L(2027, 1, 25, 9), endMs: L(2027, 1, 25, 10), allDay: false });
    d.core.setReminder(e.id, { minutesBefore: 15, enabled: true });
    const f = buildTickSchedule(d.db, NOW, 1)[0]!;
    expect(renderNotification(f).body).toBe("Starts 2027-01-25 09:00");
  });

  test("ledger key of a non-recurring reminder stays member|event|fireAt", () => {
    const d = mk("K");
    const e = d.core.createEvent({ title: "k", description: "", startMs: L(2027, 1, 25, 9), endMs: L(2027, 1, 25, 10), allDay: false });
    d.core.setReminder(e.id, { minutesBefore: 15, enabled: true });
    const f = buildTickSchedule(d.db, NOW, 1)[0]!;
    expect(f.key).toBe(`${f.member_id}|${e.id}|${L(2027, 1, 25, 8, 45)}`);
  });

  test("a moved occurrence notification shows the NEW date and time; a retitled one its title", () => {
    const d = mk("M");
    const e = d.core.createEvent({ title: "Weekly", description: "", startMs: L(2027, 1, 18, 9), endMs: L(2027, 1, 18, 10), allDay: false, recurrenceRule: "FREQ=WEEKLY;BYDAY=MO" });
    d.core.setReminder(e.id, { minutesBefore: 15, enabled: true });
    d.core.updateOccurrence(d.core.listSeries()[0]!.seriesId, "20270125T090000", { start_wall: "2027-01-26T10:30", title: "Moved" });
    const f = buildTickSchedule(d.db, NOW, 1).find((x) => x.fire_at_ms === L(2027, 1, 26, 10, 15))!;
    expect(f).toBeDefined();
    expect(renderNotification(f)).toEqual({ summary: "Moved", body: "Starts 2027-01-26 10:30" });
  });
});

describe("event delete removes its reminders locally (no extra reminder changes)", () => {
  test("deleting the event writes exactly one change (the delete) and no reminder row remains; the remote side does the same", async () => {
    const [a, b] = [mk("A"), mk("B")];
    await sessionOnce(a, b); await sessionOnce(b, a);
    const e = a.core.createEvent({ title: "d", description: "", startMs: L(2027, 1, 25, 9), endMs: L(2027, 1, 25, 10), allDay: false });
    a.core.setReminder(e.id, { minutesBefore: 15, enabled: true });
    await sessionOnce(a, b); await sessionOnce(b, a);
    const count = (d: Device): number => (d.db.prepare("SELECT COUNT(*) n FROM changes").get() as { n: number }).n;
    const before = count(a);
    a.core.deleteEvent(e.id);
    expect(count(a)).toBe(before + 1);
    await sessionOnce(a, b); await sessionOnce(b, a);
    expect(count(b)).toBe(count(a));
    for (const d of [a, b]) expect(d.db.prepare("SELECT COUNT(*) n FROM reminders").get()).toEqual({ n: 0 });
  });
});

describe("restore: an event row that comes back brings its reminders back", () => {
  test("B restores the deleted event with a full event record; devices applying it get the reminder back", async () => {
    const [a, b, c] = [mk("A"), mk("B"), mk("C")];
    for (const [x, y] of [[a, b], [b, c], [a, b], [b, c]] as Array<[Device, Device]>) await sessionOnce(x, y);
    const e = a.core.createEvent({ title: "r", description: "", startMs: L(2027, 1, 25, 9), endMs: L(2027, 1, 25, 10), allDay: false });
    a.core.setReminder(e.id, { minutesBefore: 15, enabled: true });
    for (const [x, y] of [[a, b], [b, c], [a, b], [b, c]] as Array<[Device, Device]>) await sessionOnce(x, y);
    a.core.deleteEvent(e.id);
    for (const [x, y] of [[a, b], [b, c], [a, b], [b, c]] as Array<[Device, Device]>) await sessionOnce(x, y);
    expect(b.db.prepare("SELECT COUNT(*) n FROM events WHERE event_id = ?").get(e.id)).toEqual({ n: 0 });
    // B brings the event back: a full-object event change (the shape a conflict resolution sends)
    const value = { id: e.id, title: "r", description: "", startMs: L(2027, 1, 25, 9), endMs: L(2027, 1, 25, 10), allDay: false };
    const hlc = b.core.hlcNow();
    createLocalChange(
      b.db, b.identity.deviceId,
      { entity_id: e.id, entity_type: "event", field_path: "event", operation: "set", payload: { value }, hlc_now: () => hlc },
      () => { /* local row write is not under test: B only produces the change */ },
    );
    for (const [x, y] of [[b, a], [b, c], [a, b], [b, c]] as Array<[Device, Device]>) await sessionOnce(x, y);
    for (const d of [a, c]) {
      expect(d.db.prepare("SELECT COUNT(*) n FROM events WHERE event_id = ?").get(e.id), `event on ${d.tag}`).toEqual({ n: 1 });
      expect(d.db.prepare("SELECT minutes_before FROM reminders WHERE entity_id = ?").all(e.id), `reminder on ${d.tag}`).toEqual([{ minutes_before: 15 }]);
    }
  });
});

describe("dialog count", () => {
  test("reminderCountFor is the number of reminders; reminderFor is stable (lowest member id)", () => {
    const d = mk("Q");
    const e = d.core.createEvent({ title: "q", description: "", startMs: L(2027, 1, 25, 9), endMs: L(2027, 1, 25, 10), allDay: false });
    expect(d.core.reminderCountFor(e.id)).toBe(0);
    d.core.setReminder(e.id, { minutesBefore: 15, enabled: true });
    d.db.prepare("INSERT INTO reminders (member_id, entity_id, collection_path, minutes_before, enabled, updated_hlc) VALUES ('rem-0000', ?, 'reminders', 5, 1, 1)").run(e.id);
    expect(d.core.reminderCountFor(e.id)).toBe(2);
    expect(d.core.reminderFor(e.id)).toEqual({ minutesBefore: 5, enabled: true }); // 'rem-0000' sorts first
    d.core.clearReminder(e.id);
    expect(d.core.reminderCountFor(e.id)).toBe(0);
  });
});
