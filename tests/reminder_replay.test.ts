// One-time replay of reminder changes already in history.
//
// ENTRY POINT CHOSEN BY THIS TEST (does not exist yet; the fix must provide it):
//     module  : src/persistence/reminder_replay.ts
//     export  : replayReminderHistory(db: Database): unknown
//   Called with the device's open better-sqlite3 handle. It applies, in causal
//   order and through the same code path / prerequisite rule as live sync, every
//   reminder change in `changes` that was never applied; idempotent; never lets an
//   older change overwrite a newer row; respects member_remove and deleted events.
//   The return value is not asserted.
//
// PRE-BATCH STATE: the receiving device is synced through the current code. Code
// before the fix stores reminder changes in `changes` and advances applied_upto but
// writes no reminders row, which is exactly the state to repair. After the fix the
// sync itself would write the rows, so the helper below ends by deleting the
// reminders rows of the device under test (the state the old code leaves, with
// `changes`/applied_upto untouched). The precondition is asserted: reminder changes
// present in history, reminders table empty.
//
// The entry point is loaded with a computed specifier so `tsc --noEmit` passes
// before the module exists.
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

const REPLAY_MODULE = "../src/persistence/" + "reminder_replay.ts";
async function replay(d: Device): Promise<void> {
  const mod = (await import(/* @vite-ignore */ REPLAY_MODULE)) as {
    replayReminderHistory: (db: Device["db"]) => unknown;
  };
  mod.replayReminderHistory(d.db);
}

const D = (day: number, h: number): number => new Date(2027, 2, day, h, 0).getTime();
const NOW = D(1, 6);
const mkEv = (title: string, startMs: number) => ({ title, description: "", startMs, endMs: startMs + 3_600_000, allDay: false });

type Rem = { member_id: string; entity_id: string; minutes_before: number; enabled: number | null };
const remRows = (d: Device): Rem[] =>
  d.db.prepare("SELECT member_id, entity_id, minutes_before, enabled FROM reminders ORDER BY member_id").all() as Rem[];
const schedule = (d: Device): Array<[string, number]> =>
  scheduleLikeTick(d.db, NOW, 1).map((f): [string, number] => [f.member_id, f.fire_at_ms]).sort();
const histCount = (d: Device): number => (d.db.prepare("SELECT COUNT(*) n FROM changes").get() as { n: number }).n;
const remChanges = (d: Device): number =>
  (d.db.prepare("SELECT COUNT(*) n FROM changes WHERE entity_type = 'reminder'").get() as { n: number }).n;

interface World { a: Device; p: Device; n: Device; e: Record<string, string> }

/** A is the origin; P is the device in the state left by the earlier code (changes in history, no rows); N received everything normally. */
async function world(): Promise<World> {
  const [a, p, n] = [mk("A"), mk("P"), mk("N")];
  for (const x of [p, n]) { await sessionOnce(a, x); await sessionOnce(x, a); }
  const e: Record<string, string> = {};
  e.add = a.core.createEvent(mkEv("added", D(2, 9))).id;
  e.edit = a.core.createEvent(mkEv("edited", D(3, 9))).id;
  e.del = a.core.createEvent(mkEv("removed", D(4, 9))).id;
  e.gone = a.core.createEvent(mkEv("event-deleted", D(5, 9))).id;
  a.core.setReminder(e.add, { minutesBefore: 15, enabled: true });
  a.core.setReminder(e.edit, { minutesBefore: 30, enabled: true });
  a.core.setReminder(e.edit, { minutesBefore: 45, enabled: true }); // member_update
  a.core.setReminder(e.del, { minutesBefore: 10, enabled: true });
  a.core.clearReminder(e.del); // member_remove
  a.core.setReminder(e.gone, { minutesBefore: 5, enabled: true });
  a.core.deleteEvent(e.gone);
  for (const x of [p, n]) { await sessionOnce(a, x); await sessionOnce(x, a); }
  return { a, p, n, e };
}

/** Put P into the earlier-code state: history intact, no reminder rows (see header). */
function intoPreBatchState(p: Device): void {
  p.db.prepare("DELETE FROM reminders").run();
  expect(remChanges(p), "precondition: reminder changes are in history").toBeGreaterThan(0);
  expect(remRows(p), "precondition: no reminder rows").toEqual([]);
}

describe("replay of reminder history (TD-073)", () => {
  test("after replay the earlier-code device matches the origin and a device that received the changes normally (rows and fire schedule)", async () => {
    const w = await world();
    intoPreBatchState(w.p);
    await replay(w.p);
    const want = remRows(w.a);
    expect(want.length).toBe(2); // add + edit survive; removed and deleted-event ones do not
    expect(remRows(w.p)).toEqual(want);
    expect(remRows(w.n)).toEqual(want);
    expect(schedule(w.p)).toEqual(schedule(w.n));
    expect(schedule(w.p)).toEqual(schedule(w.a));
    expect(schedule(w.p).length).toBe(2);
  });

  test("respects the later member_remove and the deleted event: no row for either", async () => {
    const w = await world();
    intoPreBatchState(w.p);
    await replay(w.p);
    const rows = remRows(w.p);
    expect(rows.filter((r) => r.entity_id === w.e.del)).toEqual([]);
    expect(rows.filter((r) => r.entity_id === w.e.gone)).toEqual([]);
    expect(rows.find((r) => r.entity_id === w.e.edit)!.minutes_before).toBe(45); // newest value, not the add's 30
  });

  test("idempotent: running replay twice gives the same rows and schedule as once, and writes no history", async () => {
    const w = await world();
    intoPreBatchState(w.p);
    await replay(w.p);
    const rows1 = remRows(w.p), sched1 = schedule(w.p), hist1 = histCount(w.p);
    await replay(w.p);
    expect(remRows(w.p)).toEqual(rows1);
    expect(schedule(w.p)).toEqual(sched1);
    expect(histCount(w.p)).toBe(hist1);
    expect(rows1.length).toBeGreaterThan(0);
  });

  test("an older change never overwrites a newer value (newer edit synced in before replay runs)", async () => {
    const w = await world();
    intoPreBatchState(w.p);
    // A edits the reminder again (90 min) and P receives it BEFORE the replay runs
    w.a.core.setReminder(w.e.edit!, { minutesBefore: 90, enabled: true });
    await sessionOnce(w.a, w.p); await sessionOnce(w.p, w.a);
    await sessionOnce(w.a, w.n); await sessionOnce(w.n, w.a);
    await replay(w.p);
    const got = remRows(w.p).find((r) => r.entity_id === w.e.edit);
    expect(got?.minutes_before).toBe(90);
    expect(remRows(w.p)).toEqual(remRows(w.n));
  });

  test("a reminder removed after the replay's source add stays removed even if the device syncs again afterwards", async () => {
    const w = await world();
    intoPreBatchState(w.p);
    await replay(w.p);
    await sessionOnce(w.a, w.p); await sessionOnce(w.p, w.a);
    expect(remRows(w.p).filter((r) => r.entity_id === w.e.del)).toEqual([]);
    expect(remRows(w.p)).toEqual(remRows(w.a));
  });
});
