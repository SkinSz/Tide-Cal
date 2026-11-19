// Reminder history replay must reproduce what live sync wrote, with NO timestamp
// comparison to pick a winner (DC-03 section 5): causally later changes win,
// concurrent changes are last-arrival (TD-070), removals are respected, and a
// replay at every start changes nothing and rewrites nothing.
import { afterAll, describe, expect, test } from "vitest";
import { rmSync } from "node:fs";
import { makeDevice, sessionOnce, guardProcess, type Device } from "./probes/sync_probe_helpers.ts";
import { replayReminderHistory } from "../src/persistence/reminder_replay.ts";
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

const T0 = new Date(2027, 2, 2, 9).getTime();
const EV = { title: "t", description: "", startMs: T0, endMs: T0 + 3_600_000, allDay: false };
const rows = (d: Device) =>
  d.db.prepare("SELECT member_id, minutes_before, enabled, updated_hlc FROM reminders ORDER BY member_id").all() as Array<{ member_id: string; minutes_before: number; enabled: number | null; updated_hlc: number }>;
const mins = (d: Device): number[] => rows(d).map((r) => r.minutes_before);
const sync = async (x: Device, y: Device): Promise<void> => { await sessionOnce(x, y); await sessionOnce(y, x); };
/** device clock that runs `ms` ahead of real time (test hook on the HLC) */
const skewAhead = (d: Device, ms: number): void => { (d.core as unknown as { hlc: { last: number } }).hlc.last = Date.now() + ms; };

async function three(): Promise<[Device, Device, Device]> {
  const [a, b, c] = [mk("A"), mk("B"), mk("C")];
  await sync(a, b); await sync(b, c); await sync(a, c);
  return [a, b, c];
}
function restoreEvent(b: Device, id: string): void {
  const value = { id, title: "t", description: "", startMs: T0, endMs: T0 + 3_600_000, allDay: false };
  const hlc = b.core.hlcNow();
  createLocalChange(
    b.db, b.identity.deviceId,
    { entity_id: id, entity_type: "event", field_path: "event", operation: "set", payload: { value }, hlc_now: () => hlc },
    () => { /* B only produces the change */ },
  );
}

describe("clock skew: a causally later edit with a LOWER timestamp still wins in replay", () => {
  test("A's clock is 10 min fast; B edits A's reminder; replay from the earlier-code state equals live C", async () => {
    const [a, b, c] = await three();
    skewAhead(a, 10 * 60_000);
    const e = a.core.createEvent(EV);
    a.core.setReminder(e.id, { minutesBefore: 15, enabled: true });
    await sync(a, b);
    b.core.setReminder(e.id, { minutesBefore: 30, enabled: true }); // causally after A's add, lower hlc
    await sync(b, c); await sync(a, c);
    expect(mins(c)).toEqual([30]); // live
    const live = rows(c);
    c.db.prepare("DELETE FROM reminders").run(); // earlier-code state: history only
    replayReminderHistory(c.db);
    expect(rows(c)).toEqual(live);
  });

  test("same skew through the restore path: the restored event gets reminder 30", async () => {
    const [a, b, c] = await three();
    skewAhead(a, 10 * 60_000);
    const e = a.core.createEvent(EV);
    a.core.setReminder(e.id, { minutesBefore: 15, enabled: true });
    await sync(a, b);
    b.core.setReminder(e.id, { minutesBefore: 30, enabled: true });
    await sync(b, c); await sync(a, c); await sync(a, b);
    b.core.deleteEvent(e.id);
    await sync(b, c); await sync(b, a);
    expect(mins(c)).toEqual([]);
    restoreEvent(b, e.id);
    await sync(b, c);
    expect(mins(c)).toEqual([30]);
  });
});

describe("concurrent remove versus edit: replay never changes what live sync wrote", () => {
  async function concurrent(order: "update-then-remove" | "remove-then-update") {
    const [a, b, c] = await three();
    const e = a.core.createEvent(EV);
    a.core.setReminder(e.id, { minutesBefore: 15, enabled: true });
    await sync(a, b); await sync(a, c);
    b.core.clearReminder(e.id); // B removes
    await new Promise((r) => setTimeout(r, 5));
    a.core.setReminder(e.id, { minutesBefore: 45, enabled: true }); // A concurrently updates (later timestamp)
    if (order === "update-then-remove") { await sessionOnce(a, c); await sessionOnce(b, c); }
    else { await sessionOnce(b, c); await sessionOnce(a, c); }
    return c;
  }

  test("update arrives first, remove last: C ends without the reminder, also after replay and a restart", async () => {
    const c = await concurrent("update-then-remove");
    expect(rows(c)).toEqual([]);
    replayReminderHistory(c.db);
    replayReminderHistory(c.db); // next start
    expect(rows(c)).toEqual([]);
  });

  test("mirror: remove arrives first, update last: C ends with 45, also after replay and a restart", async () => {
    const c = await concurrent("remove-then-update");
    expect(mins(c)).toEqual([45]);
    const live = rows(c);
    replayReminderHistory(c.db);
    replayReminderHistory(c.db);
    expect(rows(c)).toEqual(live);
  });
});

describe("a replay at every start changes nothing and rewrites nothing", () => {
  test("second and third runs report zero changed rows and leave rows (with their timestamps) identical", async () => {
    const [a, b, c] = await three();
    const e = a.core.createEvent(EV);
    a.core.setReminder(e.id, { minutesBefore: 15, enabled: true });
    a.core.setReminder(e.id, { minutesBefore: 30, enabled: true }); // add then update: two stored changes for one row
    const e2 = a.core.createEvent({ ...EV, title: "t2" });
    a.core.setReminder(e2.id, { minutesBefore: 5, enabled: true });
    await sync(a, b); await sync(b, c); await sync(a, c);
    const live = rows(c);
    expect(live.length).toBe(2);
    for (let i = 0; i < 3; i++) {
      const r = replayReminderHistory(c.db);
      expect(r.applied, `run ${i}`).toBe(0);
      expect(r.unresolved, `run ${i}`).toBe(0);
      expect(rows(c)).toEqual(live);
    }
  });

  test("from the earlier-code state the first run restores the rows (applied = rows changed), later runs change none", async () => {
    const [a, b, c] = await three();
    const e = a.core.createEvent(EV);
    a.core.setReminder(e.id, { minutesBefore: 15, enabled: true });
    a.core.setReminder(e.id, { minutesBefore: 30, enabled: true });
    await sync(a, b); await sync(b, c); await sync(a, c);
    const live = rows(c);
    c.db.prepare("DELETE FROM reminders").run();
    const first = replayReminderHistory(c.db);
    expect(first.applied).toBe(1); // one row, although two changes were replayed
    expect(first.skippedStale).toBe(1); // the add is causally older than the update
    expect(rows(c)).toEqual(live);
    expect(replayReminderHistory(c.db).applied).toBe(0);
  });
});
