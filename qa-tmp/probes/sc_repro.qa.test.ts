// Repro-count runs: SC2 (same-field conflict) x5, SC5 (compacted snapshot hole) x3, SC6 (quarantine replay) x3
// Pkg6 disposition (2026-08-30): the SC2 x5 run asserts implicit-LWW row
// convergence that Pkg5/DC-03 §3.3 REPLACED with per-device conflict
// preservation (divergence conflict-backed; pkg5 tests pin it). Left
// failing intentionally — observe-only pending owner disposition.
import { expect, test } from "vitest";
import type Database from "better-sqlite3";
import { join } from "node:path";
import { EventCore } from "../../src/persistence/bridges/event_core.ts";
import { sweep } from "../../src/sync/compaction.ts";
import {
  makeDevice,
  pairDevices,
  sessionOnce,
  oracle,
  saveResult,
  type Device,
} from "./helpers.ts";
import { createSyncEngine, makeEntityMutator } from "./helpers.ts";

function mkEvent(d: Device, title: string) {
  const t = Date.now();
  return d.core.createEvent({ title, description: "c", startMs: t, endMs: t + 3600_000, allDay: false });
}

test("REPRO SC2 same-field concurrent edits x5", async () => {
  const runs: unknown[] = [];
  for (let run = 0; run < 5; run++) {
    const a = makeDevice("A");
    const b = makeDevice("B");
    pairDevices(a, b);
    const ev = mkEvent(a, "original");
    await sessionOnce(a, b);
    await sessionOnce(b, a);
    a.core.updateEvent(ev.id, { title: "edit-A", description: "c", startMs: ev.startMs, endMs: ev.endMs, allDay: false });
    b.core.updateEvent(ev.id, { title: "edit-B", description: "c", startMs: ev.startMs, endMs: ev.endMs, allDay: false });
    await sessionOnce(a, b);
    await sessionOnce(b, a);
    await sessionOnce(a, b);
    await sessionOnce(b, a);
    const o = oracle([a, b]);
    const tA = (a.db.prepare("SELECT title FROM events WHERE event_id=?").get(ev.id) as { title: string }).title;
    const tB = (b.db.prepare("SELECT title FROM events WHERE event_id=?").get(ev.id) as { title: string }).title;
    const conf = (a.db.prepare("SELECT COUNT(*) c FROM conflicts").get() as { c: number }).c;
    runs.push({ run, converged: o.converged, titleA: tA, titleB: tB, conflictRowsA: conf, detail: o.detail });
    a.core.db.close();
    b.core.db.close();
  }
  saveResult("sc2-x5", runs);
  expect(runs.every((r) => (r as { converged: boolean }).converged)).toBe(true);
}, 120000);

test("REPRO SC5 compacted snapshot hole x3", async () => {
  const runs: unknown[] = [];
  for (let run = 0; run < 3; run++) {
    const a = makeDevice("A");
    const b = makeDevice("B");
    pairDevices(a, b);
    for (let i = 0; i < 6; i++) mkEvent(a, `pre-${run}-${i}`);
    await sessionOnce(a, b);
    await sessionOnce(b, a);

    const c = makeDevice("C");
    pairDevices(a, c);
    pairDevices(b, c);
    await sessionOnce(a, c);
    await sessionOnce(c, a);
    await sessionOnce(b, c);
    await sessionOnce(c, b);
    const o1 = oracle([a, b, c]);

    const clockA: Record<string, Record<string, number>> = {};
    for (const p of [b, c]) {
      const rows = p.db.prepare("SELECT producer_device_id d, applied_through s FROM applied_upto").all() as any[];
      clockA[p.identity.deviceId] = Object.fromEntries(rows.map((r) => [r.d, r.s]));
    }
    const stats = sweep({ db: a.db, selfDeviceId: a.identity.deviceId, lastKnownClock: clockA, constraintSet: [b.identity.deviceId, c.identity.deviceId] });

    const d = makeDevice("D");
    pairDevices(a, d);
    await sessionOnce(a, d);
    await sessionOnce(d, a);
    const o2 = oracle([a, d]);
    // second chance: more rounds — can D ever catch up?
    await sessionOnce(a, d);
    await sessionOnce(d, a);
    await sessionOnce(a, d);
    await sessionOnce(d, a);
    const o3 = oracle([a, d]);
    const eventsD = (d.db.prepare("SELECT COUNT(*) c FROM events").get() as { c: number }).c;
    const eventsA = (a.db.prepare("SELECT COUNT(*) c FROM events").get() as { c: number }).c;
    const appliedUptoD = d.db.prepare("SELECT producer_device_id, applied_through FROM applied_upto").all();
    runs.push({ run, sweep: stats, oracle3way: o1.converged, oracleAfterSnapshot: o2.converged, oracleAfter3MoreRounds: o3.converged, eventsA, eventsD, appliedUptoD, detail: o3.detail });
    a.core.db.close();
    b.core.db.close();
    c.core.db.close();
    d.core.db.close();
  }
  saveResult("sc5-x3", runs);
  expect(runs.every((r) => (r as { oracleAfter3MoreRounds: boolean }).oracleAfter3MoreRounds)).toBe(true);
}, 120000);

test("REPRO SC6 quarantine replay x3", async () => {
  const runs: unknown[] = [];
  const fakeC = "dev-fake-producer-C";
  for (let run = 0; run < 3; run++) {
    const b = makeDevice("B");
    const t = Date.now();
    const batch = [1, 2, 3].map((seq) => {
      const rec: Record<string, unknown> = {
        change_id: `${fakeC}:${seq}`, device_id: fakeC, local_seq: seq,
        entity_id: `evt-q${seq}`, entity_type: "event", field_path: "event", operation: "set",
        payload: { value: { title: `valid-${seq}`, description: "v", startMs: t, endMs: t + 3600000, allDay: false } },
        hlc_timestamp: t + seq, causality_clock: { [fakeC]: seq }, schema_version: 1,
      };
      if (seq === 1) delete rec.causality_clock; // invalid
      return rec;
    });
    const scripted = (n: number) => ({
      sent: [] as unknown[], received: [] as unknown[],
      async send(msg: unknown) { this.sent.push(msg); },
      async receive(): Promise<unknown> {
        if (this.received.length < n) {
          this.received.push("hello");
          if (this.received.length === 1) return { v: 1, type: "HELLO", device_clock: { [fakeC]: 3 } };
          return { v: 1, type: "CHANGES_BATCH", changes: batch, remaining_ranges: [] };
        }
        return null;
      },
    });
    const eng = createSyncEngine({ db: b.db, selfDeviceId: b.identity.deviceId, mutateEntity: makeEntityMutator() });
    const s1 = await eng.runSession(scripted(2) as never);
    const q1 = (b.db.prepare("SELECT COUNT(*) c FROM quarantine").get() as { c: number }).c;
    const eng2 = createSyncEngine({ db: b.db, selfDeviceId: b.identity.deviceId, mutateEntity: makeEntityMutator() });
    const s2 = await eng2.runSession(scripted(2) as never);
    const q2 = (b.db.prepare("SELECT COUNT(*) c FROM quarantine").get() as { c: number }).c;
    const skipped = b.db.prepare("SELECT COUNT(*) c FROM skipped_seqs").get() as { c: number };
    runs.push({ run, s1Quarantined: s1.receivedQuarantined, s2Quarantined: s2.receivedQuarantined, qAfter1: q1, qAfter2: q2, skippedRows: skipped.c });
    b.core.db.close();
  }
  saveResult("sc6-x3", runs);
  expect(runs.every((r) => (r as { qAfter2: number }).qAfter2 >= 1)).toBe(true);
}, 120000);
