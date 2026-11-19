// TD-073: reminder changes must be APPLIED on the receiving
// device through the same path as local edits and the prerequisite rule.
// Written against the REQUIRED behavior; on 02563c5 reminder changes are stored
// in history but never written to the reminders table.
import { afterAll, describe, expect, test } from "vitest";
import { rmSync } from "node:fs";
import { makeDevice, sessionOnce, guardProcess, type Device } from "./probes/sync_probe_helpers.ts";
import { scheduleLikeTick } from "./probes/reminder_tick_replica.ts";

guardProcess();
const all: Device[] = [];
const mk = (tag: string): Device => { const d = makeDevice(tag); all.push(d); return d; };
afterAll(() => {
  for (const d of all) {
    try { d.db.close(); } catch { /* closed */ }
    try { rmSync(d.dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

const START = new Date(2027, 2, 1, 10, 0).getTime();
const NOW = new Date(2027, 2, 1, 8, 0).getTime();
const ev = (title: string) => ({ title, description: "", startMs: START, endMs: START + 3_600_000, allDay: false });

type Rem = { member_id: string; minutes_before: number; enabled: number | null };
const rems = (d: Device, eid: string): Rem[] =>
  d.db.prepare("SELECT member_id, minutes_before, enabled FROM reminders WHERE entity_id = ? ORDER BY member_id").all(eid) as Rem[];
const eventExists = (d: Device, eid: string): boolean => d.db.prepare("SELECT 1 FROM events WHERE event_id = ?").get(eid) !== undefined;

async function full(a: Device, b: Device): Promise<void> { await sessionOnce(a, b); }
async function settle(a: Device, b: Device, c: Device): Promise<void> {
  await full(a, b); await full(b, c); await full(a, b); await full(b, c);
}
/** dst pulls ONLY `origin`'s stream up to `upto` from src (HELLO rewrite, as in the delivery-order test). */
async function pullUpTo(src: Device, dst: Device, origin: Device, upto: number): Promise<void> {
  const seen = new WeakSet<object>();
  await sessionOnce(src, dst, {
    filter: (msg, dir) => {
      const m = msg as { type?: string; device_clock?: Record<string, number> };
      if (m && m.type === "HELLO" && !seen.has(m)) {
        seen.add(m);
        m.device_clock = dir === "from" ? { [origin.identity.deviceId]: upto } : {};
      }
      return true;
    },
  });
}
const lastSeq = (d: Device): number =>
  (d.db.prepare("SELECT MAX(local_seq) m FROM changes WHERE device_id = ?").get(d.identity.deviceId) as { m: number }).m;

async function threeDevices(): Promise<[Device, Device, Device]> {
  const [a, b, c] = [mk("A"), mk("B"), mk("C")];
  await settle(a, b, c); // bootstrap calendars
  return [a, b, c];
}

describe("reminder arrives, is held until its event exists, then is applied", () => {
  test("a reminder from B whose event has not reached C is HELD (not stored, no row), then applied when the event arrives", async () => {
    const [a, b, c] = await threeDevices();
    const eid = a.core.createEvent(ev("held")).id;
    await full(a, b); // B has the event
    b.core.setReminder(eid, { minutesBefore: 10, enabled: true });
    const remSeq = lastSeq(b);
    // C asks B for ONLY B's stream: remB depends on A's create, which C lacks
    await pullUpTo(b, c, b, remSeq);
    expect(eventExists(c, eid)).toBe(false);
    expect(rems(c, eid)).toEqual([]);
    const storedRem = c.db.prepare("SELECT COUNT(*) n FROM changes WHERE entity_type = 'reminder'").get() as { n: number };
    expect(storedRem.n).toBe(0); // held = not stored (prerequisite rule)
    // the event arrives
    await full(b, c);
    await full(b, c);
    expect(eventExists(c, eid)).toBe(true);
    expect(rems(c, eid).map((r) => r.minutes_before)).toEqual([10]);
  });

  test("reminder created on A reaches B and C (direct and via relay) with identical member id and minutes", async () => {
    const [a, b, c] = await threeDevices();
    const eid = a.core.createEvent(ev("plain")).id;
    a.core.setReminder(eid, { minutesBefore: 15, enabled: true });
    await settle(a, b, c);
    const ra = rems(a, eid);
    expect(ra.length).toBe(1);
    expect(rems(b, eid)).toEqual(ra);
    expect(rems(c, eid)).toEqual(ra);
    // the received reminder is usable: the alarm schedules a fire on the receiving device
    const fires = scheduleLikeTick(c.db, NOW, 1).filter((f) => f.fire_at_ms > NOW);
    expect(fires.map((f) => f.fire_at_ms)).toEqual([START - 15 * 60_000]);
  });
});

describe("reminder on a deleted event does not come back", () => {
  test("delete after the reminder was synced: no reminder row remains on any device, alarm schedules nothing", async () => {
    const [a, b, c] = await threeDevices();
    const eid = a.core.createEvent(ev("gone")).id;
    a.core.setReminder(eid, { minutesBefore: 15, enabled: true });
    await settle(a, b, c);
    a.core.deleteEvent(eid);
    await settle(a, b, c);
    for (const d of [a, b, c]) {
      expect(eventExists(d, eid), `event on ${d.tag}`).toBe(false);
      expect(rems(d, eid), `reminder rows on ${d.tag}`).toEqual([]);
      expect(scheduleLikeTick(d.db, NOW, 1), `schedule on ${d.tag}`).toEqual([]);
    }
  });

  // B adds a reminder to A's event, A receives it, THEN A deletes the event (causal chain).
  // Whatever order C receives the pieces in, no device may end with the event or a reminder row.
  // (A delete that is CONCURRENT with a reminder add is a delete-versus-edit conflict on the
  // event: out of scope here, reported separately.)
  const variants: Array<[string, (a: Device, b: Device, c: Device, seqB: number) => Promise<void>]> = [
    ["C receives B's reminder first (event unknown to C), then everything", async (a, b, c, seqB) => {
      await pullUpTo(b, c, b, seqB); await full(a, b); await full(b, c);
    }],
    ["C receives everything at once", async (a, b, c) => { await full(a, b); await full(b, c); }],
    ["C syncs with B before B has A's delete, then again after", async (a, b, c) => {
      await full(b, c); await full(a, b); await full(b, c);
    }],
  ];
  for (const [name, run] of variants) {
    test(`reminder added by B, then A deletes the event: ${name}`, async () => {
      const [a, b, c] = await threeDevices();
      const eid = a.core.createEvent(ev("race")).id;
      await full(a, b);
      b.core.setReminder(eid, { minutesBefore: 5, enabled: true });
      const seqB = lastSeq(b);
      await full(a, b); // A now has B's reminder
      a.core.deleteEvent(eid);
      await run(a, b, c, seqB);
      await settle(a, b, c);
      for (const d of [a, b, c]) {
        expect(eventExists(d, eid), `event on ${d.tag}`).toBe(false);
        expect(rems(d, eid), `reminder rows on ${d.tag}`).toEqual([]);
        expect(scheduleLikeTick(d.db, NOW, 1), `schedule on ${d.tag}`).toEqual([]);
      }
    });
  }
});

describe("two devices add a reminder to the same event offline", () => {
  async function twoOffline() {
    const [a, b, c] = await threeDevices();
    const eid = a.core.createEvent(ev("two")).id;
    await settle(a, b, c);
    a.core.setReminder(eid, { minutesBefore: 15, enabled: true });
    b.core.setReminder(eid, { minutesBefore: 30, enabled: true });
    await settle(a, b, c);
    return { a, b, c, eid };
  }

  test("after sync every device holds BOTH reminders (same member ids)", async () => {
    const { a, b, c, eid } = await twoOffline();
    for (const d of [a, b, c]) expect(rems(d, eid).map((r) => r.minutes_before).sort(), d.tag).toEqual([15, 30]);
    expect(rems(b, eid)).toEqual(rems(a, eid));
    expect(rems(c, eid)).toEqual(rems(a, eid));
  });

  test("the reminder the dialog shows (EventCore.reminderFor) is the one with the LOWEST member_id, same on every device", async () => {
    const { a, b, c, eid } = await twoOffline();
    const rows = rems(a, eid); // ordered by member_id
    expect(rows.length).toBe(2);
    const expected = { minutesBefore: rows[0]!.minutes_before, enabled: true };
    for (const d of [a, b, c]) expect(d.core.reminderFor(eid), d.tag).toEqual(expected);
  });

  test("the alarm schedules a fire for EACH reminder on every device", async () => {
    const { a, b, c, eid } = await twoOffline();
    void eid;
    for (const d of [a, b, c]) {
      const fires = scheduleLikeTick(d.db, NOW, 1).filter((f) => f.fire_at_ms > NOW).map((f) => f.fire_at_ms).sort((x, y) => x - y);
      expect(fires, d.tag).toEqual([START - 30 * 60_000, START - 15 * 60_000]);
    }
  });

  test('saving from the dialog (setReminder) "keeps only this one": the other reminder is removed and that converges', async () => {
    // Owner answer 4 dialog text: "This event has 2 reminders. Saving keeps only this one."
    const { a, b, c, eid } = await twoOffline();
    const keep = rems(a, eid)[0]!;
    a.core.setReminder(eid, { minutesBefore: 60, enabled: true });
    await settle(a, b, c);
    for (const d of [a, b, c]) {
      expect(rems(d, eid).map((r) => [r.member_id, r.minutes_before]), d.tag).toEqual([[keep.member_id, 60]]);
    }
  });
});
