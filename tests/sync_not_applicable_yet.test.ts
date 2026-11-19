// Changes held until a change they depend on arrives, and materialization of
// series, occurrence overrides and calendars: focused tests.
//  - a change whose target entity has not been created here yet is NOT applied:
//    no history row, read position (applied_upto) held, no conflict row, and a
//    later pull applies it once the creating change has arrived;
//  - an absent row for an entity this device already knows (deleted) keeps the
//    old behavior (stored, frontier advances);
//  - series / occurrence_override / calendar changes are written to their rows.
import { afterAll, expect, test } from "vitest";
import { rmSync } from "node:fs";
import { makeDevice, sessionOnce, fingerprint, guardProcess, type Device } from "./probes/sync_probe_helpers.ts";

guardProcess();
const T0 = 1_800_000_000_000;
const ev = (t: string) => ({ title: t, description: "d", startMs: T0, endMs: T0 + 3_600_000, allDay: false });
const made: Device[] = [];
const dev = (t: string): Device => {
  const d = makeDevice(t);
  made.push(d);
  return d;
};
afterAll(() => {
  for (const d of made) {
    try { d.db.close(); } catch { /* closed */ }
    try { rmSync(d.dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

/** dst pulls only `origin`'s stream up to `upto` from src (real engine, HELLO-restricted). */
async function pull(src: Device, dst: Device, origin: Device, upto: number) {
  const seen = new WeakSet<object>();
  return sessionOnce(src, dst, {
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
const settle = async (a: Device, b: Device, c: Device) => {
  await sessionOnce(a, b);
  await sessionOnce(b, c);
  await sessionOnce(a, b);
};
const frontier = (d: Device, origin: Device): number =>
  (d.db.prepare("SELECT applied_through v FROM applied_upto WHERE producer_device_id = ?").get(origin.identity.deviceId) as { v: number } | undefined)?.v ?? 0;
const hasChange = (d: Device, origin: Device, seq: number): boolean =>
  d.db.prepare("SELECT 1 FROM changes WHERE device_id = ? AND local_seq = ?").get(origin.identity.deviceId, seq) !== undefined;
const rows = (d: Device, sql: string) => d.db.prepare(sql).all();

test("edit before create: not stored, read position held, applied after create arrives", async () => {
  const a = dev("A"), b = dev("B"), c = dev("C");
  await settle(a, b, c);
  const e = a.core.createEvent(ev("orig"));
  await pull(a, b, a, 2);
  b.core.updateEvent(e.id, ev("edit-B"));
  const before = frontier(c, b);
  const r = await pull(b, c, b, 2);
  expect(r.toStats.receivedNotApplicableYet, "counted outcome").toBe(1);
  expect(hasChange(c, b, 2), "no history row").toBe(false);
  expect(frontier(c, b), "read position held").toBe(before);
  expect(rows(c, "SELECT * FROM events")).toHaveLength(0);
  expect(r.toStats.snapshotDeletions ?? 0).toBe(0);
  // no snapshot/full-state was triggered by the held change
  expect(hasChange(c, a, 2)).toBe(false);
  await pull(b, c, a, 2); // create arrives
  await sessionOnce(b, c); // next normal pull retries the held change
  expect(hasChange(c, b, 2)).toBe(true);
  expect(fingerprint(c.db).digest).toBe(fingerprint(b.db).digest);
  expect((fingerprint(c.db).events[0] as { title: string }).title).toBe("edit-B");
});

test("later seqs of the same origin do not pass a held change (buffered, then drained)", async () => {
  const a = dev("A"), b = dev("B"), c = dev("C");
  await settle(a, b, c);
  const e = a.core.createEvent(ev("orig"));
  await pull(a, b, a, 2);
  b.core.updateEvent(e.id, ev("edit-1"));
  b.core.updateEvent(e.id, { ...ev("edit-1"), description: "d2" });
  const r = await pull(b, c, b, 3);
  expect(frontier(c, b)).toBe(1);
  expect(hasChange(c, b, 3), "seq 3 must not be applied past held seq 2").toBe(false);
  expect(r.toStats.receivedNotApplicableYet).toBeGreaterThan(0);
  await pull(b, c, a, 2);
  await sessionOnce(b, c);
  expect(frontier(c, b)).toBe(3);
  expect(fingerprint(c.db).digest).toBe(fingerprint(b.db).digest);
});

test("absent row for a KNOWN (deleted) entity keeps today's behavior: stored, frontier advances", async () => {
  const a = dev("A"), b = dev("B");
  const e = a.core.createEvent(ev("orig"));
  await sessionOnce(a, b);
  a.core.deleteEvent(e.id); // A: remove at seq 3
  b.core.updateEvent(e.id, ev("edit-B")); // concurrent edit on B
  await sessionOnce(b, a); // A receives the edit for an event it deleted
  expect(hasChange(a, b, 2), "edit stored in history").toBe(true);
  expect(frontier(a, b)).toBe(2);
  expect(rows(a, "SELECT * FROM events")).toHaveLength(0);
});

test("series, override and calendar changes are written to their rows; event delete removes them", async () => {
  const a = dev("A"), b = dev("B");
  a.core.createEvent({ ...ev("rec"), recurrenceRule: "FREQ=WEEKLY;BYDAY=MO" });
  const sid = a.core.listSeries()[0]!.seriesId;
  a.core.updateSeriesRule(sid, "FREQ=WEEKLY;BYDAY=TU");
  a.core.updateOccurrence(sid, "20270118T090000", { title: "ov", cancelled: true });
  await sessionOnce(a, b);
  const fb = fingerprint(b.db);
  expect(fb.series).toHaveLength(1);
  expect((fb.series[0] as { recurrence_rule: string }).recurrence_rule).toBe("FREQ=WEEKLY;BYDAY=TU");
  expect(fb.occurrence_overrides).toHaveLength(1);
  expect(fingerprint(a.db).digest).toBe(fb.digest);
  // delete on A (event + series remove) must apply on B without FK errors
  a.core.deleteEvent(a.core.listEvents()[0]!.id);
  await sessionOnce(a, b);
  expect(rows(b, "SELECT * FROM series")).toHaveLength(0);
  expect(rows(b, "SELECT * FROM occurrence_overrides")).toHaveLength(0);
  expect(rows(b, "SELECT * FROM events")).toHaveLength(0);
});
