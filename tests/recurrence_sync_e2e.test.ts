// Recurrence sync (verification): a recurring series travels A -> B -> C
// (relay, no A<->C link) as a SERIES (series row + rule), not as a single event;
// moving one occurrence and editing the whole series both arrive correctly.
// Real EventCore calls on both ends, real sync engine over in-memory pipes.
import { afterAll, describe, expect, test } from "vitest";
import { rmSync } from "node:fs";
import { makeDevice, sessionOnce, fingerprint, guardProcess, type Device } from "./probes/sync_probe_helpers.ts";
import { expandOccurrences } from "../src/domain/recurrence_conflicts.ts";

guardProcess();
const all: Device[] = [];
const mk = (tag: string): Device => { const d = makeDevice(tag); all.push(d); return d; };
afterAll(() => {
  for (const d of all) {
    try { d.db.close(); } catch { /* closed */ }
    try { rmSync(d.dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

async function settle(a: Device, b: Device, c: Device): Promise<void> {
  await sessionOnce(a, b); await sessionOnce(b, c); await sessionOnce(a, b); await sessionOnce(b, c);
}
const START = new Date(2027, 0, 18, 9, 0).getTime(); // Monday
const WEEKLY = "FREQ=WEEKLY;BYDAY=MO";

/** The instants (epoch ms, local wall) a device would show: expansion minus cancelled, overrides applied. */
function instants(d: Device): number[] {
  const ser = d.core.listSeries();
  expect(ser.length, `series rows on ${d.tag}`).toBe(1);
  const s = ser[0]!;
  // same derivation as the calendar (frontend/calendar.ts baseStartWall): full wall time from the start instant
  const row = d.db.prepare("SELECT utc_start_ms FROM events WHERE event_id = ?").get(s.baseEventId) as { utc_start_ms: number };
  const bd = new Date(row.utc_start_ms);
  const p2 = (n: number): string => String(n).padStart(2, "0");
  const base = { start_wall: `${bd.getFullYear()}-${p2(bd.getMonth() + 1)}-${p2(bd.getDate())}T${p2(bd.getHours())}:${p2(bd.getMinutes())}` };
  const ids = expandOccurrences(
    { series_id: s.seriesId, base_start_wall: base.start_wall, tz_id: "local", recurrence_rule: s.recurrenceRule },
    "20270101T000000", "20271231T235959",
  );
  const ov = new Map(s.overrides.map((o) => [o.recurrenceId, o]));
  const ms = (id: string): number => {
    const x = id.replace(/\D/g, "");
    return new Date(+x.slice(0, 4), +x.slice(4, 6) - 1, +x.slice(6, 8), +x.slice(8, 10) || 0, +x.slice(10, 12) || 0).getTime();
  };
  const out: number[] = [];
  for (const id of ids) {
    const o = ov.get(id);
    if (o?.cancelled) continue;
    out.push(o?.startWall ? ms(o.startWall) : ms(id));
  }
  return out.sort((x, y) => x - y);
}

describe("recurrence over sync (A creates, B relays, C receives)", () => {
  async function created() {
    const [a, b, c] = [mk("A"), mk("B"), mk("C")];
    await settle(a, b, c);
    const e = a.core.createEvent({ title: "Weekly", description: "", startMs: START, endMs: START + 3_600_000, allDay: false, recurrenceRule: WEEKLY });
    await settle(a, b, c);
    return { a, b, c, eid: e.id };
  }

  test("B and C receive a SERIES (series row with the rule, base event), not a single event", async () => {
    const { a, b, c, eid } = await created();
    for (const d of [b, c]) {
      const s = d.core.listSeries();
      expect(s.length, d.tag).toBe(1);
      expect(s[0]!.recurrenceRule, d.tag).toBe(WEEKLY);
      expect(s[0]!.baseEventId, d.tag).toBe(eid);
      expect(s[0]!.seriesId, d.tag).toBe(a.core.listSeries()[0]!.seriesId);
      expect(d.db.prepare("SELECT COUNT(*) n FROM events").get(), d.tag).toEqual({ n: 1 });
    }
    expect(fingerprint(b.db).digest).toBe(fingerprint(a.db).digest);
    expect(fingerprint(c.db).digest).toBe(fingerprint(a.db).digest);
  });

  test("occurrences expand to the same instants on all three devices (more than one, weekly)", async () => {
    const { a, b, c } = await created();
    const ia = instants(a);
    expect(ia.length).toBeGreaterThan(40);
    expect(ia[0]).toBe(START);
    expect(ia[1]! - ia[0]!).toBe(7 * 86_400_000 + (new Date(ia[1]!).getTimezoneOffset() - new Date(ia[0]!).getTimezoneOffset()) * 60_000);
    expect(instants(b)).toEqual(ia);
    expect(instants(c)).toEqual(ia);
  });

  test("moving ONE occurrence (override by A) arrives on B and C; other occurrences unchanged", async () => {
    const { a, b, c } = await created();
    const before = instants(a);
    a.core.updateOccurrence(a.core.listSeries()[0]!.seriesId, "20270125T090000", { start_wall: "2027-01-26T10:30" });
    await settle(a, b, c);
    const moved = new Date(2027, 0, 26, 10, 30).getTime();
    const want = before.filter((x) => x !== new Date(2027, 0, 25, 9, 0).getTime()).concat(moved).sort((x, y) => x - y);
    expect(instants(a)).toEqual(want);
    expect(instants(b)).toEqual(want);
    expect(instants(c)).toEqual(want);
    expect(fingerprint(c.db).digest).toBe(fingerprint(a.db).digest);
  });

  test("cancelling one occurrence (override by B, the relay) arrives on A and C", async () => {
    const { a, b, c } = await created();
    const before = instants(a);
    b.core.updateOccurrence(b.core.listSeries()[0]!.seriesId, "20270201T090000", { cancelled: true });
    await settle(a, b, c);
    const want = before.filter((x) => x !== new Date(2027, 1, 1, 9, 0).getTime());
    for (const d of [a, b, c]) expect(instants(d), d.tag).toEqual(want);
  });

  test("editing the WHOLE series rule (by A) arrives on B and C: every device expands the new rule", async () => {
    const { a, b, c } = await created();
    const sid = a.core.listSeries()[0]!.seriesId;
    a.core.updateSeriesRule(sid, "FREQ=WEEKLY;INTERVAL=2;COUNT=5");
    await settle(a, b, c);
    for (const d of [a, b, c]) {
      expect(d.core.listSeries()[0]!.recurrenceRule, d.tag).toBe("FREQ=WEEKLY;INTERVAL=2;COUNT=5");
      expect(instants(d).length, d.tag).toBe(5);
    }
    expect(instants(b)).toEqual(instants(a));
    expect(instants(c)).toEqual(instants(a));
    expect(fingerprint(c.db).digest).toBe(fingerprint(a.db).digest);
  });

  test("editing the whole series rule by C (the far end) travels back to A through the relay", async () => {
    const { a, b, c } = await created();
    c.core.updateSeriesRule(c.core.listSeries()[0]!.seriesId, "FREQ=WEEKLY;COUNT=3");
    await settle(a, b, c);
    for (const d of [a, b, c]) expect(instants(d).length, d.tag).toBe(3);
    expect(fingerprint(a.db).digest).toBe(fingerprint(c.db).digest);
  });
});
