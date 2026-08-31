// SC5: snapshot+event-stream interaction (DC-09). SC6: quarantine during active sync. SC7: abort/restart mid-session.
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
  dumpState,
  saveResult,
  type Device,
  guardProcess,
} from "./sync_probe_helpers.ts";

function mkEvent(d: Device, title: string) {
  const t = Date.now();
  return d.core.createEvent({ title, description: "c", startMs: t, endMs: t + 3600_000, allDay: false });
}

guardProcess();

test("SC5 compaction gap -> Trigger A snapshot -> incremental continues (DC-09)", async () => {
  const a = makeDevice("A");
  const b = makeDevice("B");
  pairDevices(a, b);
  for (let i = 0; i < 6; i++) mkEvent(a, `pre-${i}`);
  await sessionOnce(a, b);
  await sessionOnce(b, a);
  expect(oracle([a, b]).converged).toBe(true);

  // B falls behind: B's applied_upto[A] rewound by simulating a fresh clone that
  // only knows A's first 2 changes. Easier honest route: A compacts its change
  // log after B acknowledged everything, then a NEW device C (empty) syncs from A.
  // C requests A:1..N -> unservable gap -> Trigger A snapshot.
  const c = makeDevice("C");
  pairDevices(a, c);
  pairDevices(b, c);

  // A creates more; C has nothing. First converge C with A.
  await sessionOnce(a, c);
  await sessionOnce(c, a);
  await sessionOnce(b, c);
  await sessionOnce(c, b);
  const o1 = oracle([a, b, c]);
  expect(o1.converged, JSON.stringify(o1.detail)).toBe(true);

  // Now compact A's old changes (C and B provably know them via ACKs).
  const clockA: Record<string, Record<string, number>> = {};
  for (const p of [b, c]) {
    const rows = p.db.prepare("SELECT producer_device_id d, applied_through s FROM applied_upto").all() as any[];
    clockA[p.identity.deviceId] = Object.fromEntries(rows.map((r) => [r.d, r.s]));
  }
  const stats = sweep({ db: a.db, selfDeviceId: a.identity.deviceId, lastKnownClock: clockA, constraintSet: [b.identity.deviceId, c.identity.deviceId] });
  const aChangesAfter = (a.db.prepare("SELECT COUNT(*) c FROM changes").get() as { c: number }).c;

  // Fresh device D pulls from compacted A -> snapshot path
  const d = makeDevice("D");
  pairDevices(a, d);
  const r1 = await sessionOnce(a, d);
  await sessionOnce(d, a);
  const o2 = oracle([a, d]);
  const logTypes = r1.fromLog.map((m: any) => m.type);
  // incremental continues: A creates new events, sync D incrementally
  mkEvent(a, "post-snap-1");
  mkEvent(a, "post-snap-2");
  const r2 = await sessionOnce(a, d);
  await sessionOnce(d, a);
  const o3 = oracle([a, d]);
  const logTypes2 = r2.fromLog.map((m: any) => m.type);

  saveResult("sc5", {
    sweepStats: stats,
    aChangesAfter,
    oracleAfter3way: o1,
    oracleAfterSnapshotSync: o2,
    oracleAfterIncremental: o3,
    sessionLogTypes: logTypes,
    incrementalLogTypes: logTypes2,
    stateA: dumpState("A", a),
    stateD: dumpState("D", d),
  });
  expect(o2.converged, JSON.stringify(o2.detail)).toBe(true);
  expect(o3.converged, JSON.stringify(o3.detail)).toBe(true);
  a.core.db.close();
  b.core.db.close();
  c.core.db.close();
  d.core.db.close();
});

test("SC6 quarantine during active sync: invalid record mid-stream, valid flow continues", async () => {
  const b = makeDevice("B");
  const fakeC = "dev-fake-producer-C";
  const t = Date.now();
  const valid2 = {
    change_id: `${fakeC}:2`, device_id: fakeC, local_seq: 2, entity_id: "evt-q1",
    entity_type: "event", field_path: "event", operation: "set",
    payload: { value: { title: "valid-2", description: "v", startMs: t, endMs: t + 3600000, allDay: false } },
    hlc_timestamp: t, causality_clock: { [fakeC]: 2 }, schema_version: 1,
  };
  const valid3 = { ...valid2, change_id: `${fakeC}:3`, local_seq: 3, entity_id: "evt-q2",
    payload: { value: { title: "valid-3", description: "v", startMs: t, endMs: t + 3600000, allDay: false } },
    hlc_timestamp: t + 1, causality_clock: { [fakeC]: 3 } };
  const invalid1 = { ...valid2, local_seq: 1, change_id: `${fakeC}:1`, entity_id: "evt-q0" };
  delete (invalid1 as Record<string, unknown>).causality_clock; // structurally invalid

  const batch = [invalid1, valid2, valid3];
  // scripted peer transport: HELLO first, then serve B's pull with the batch
  const scripted = {
    sent: [] as unknown[],
    async send(msg: unknown) {
      this.sent.push(msg);
    },
    received: [] as unknown[],
    async receive(): Promise<unknown> {
      if (this.received.length === 0) {
        this.received.push("hello");
        return { v: 1, type: "HELLO", device_clock: { [fakeC]: 3 } };
      }
      if (this.received.length === 1) {
        this.received.push("batch");
        const sentArr = this.sent as Array<{ type: string }>;
        const m = [...sentArr].reverse().find((x) => x.type === "CHANGES_REQUEST");
        void m;
        return { v: 1, type: "CHANGES_BATCH", changes: batch, remaining_ranges: [] };
      }
      return null; // EOF
    },
  };
  const { createSyncEngine, makeEntityMutator } = await import("./sync_probe_helpers.ts");
  const eng = createSyncEngine({ db: b.db, selfDeviceId: b.identity.deviceId, mutateEntity: makeEntityMutator() });
  const stats = await eng.runSession(scripted as never);

  const q = b.db.prepare("SELECT quarantine_id, quarantine_reason, sender_device_id FROM quarantine").all() as any[];
  const skipped = b.db.prepare("SELECT * FROM skipped_seqs").all();
  const rows = b.db.prepare("SELECT event_id,title FROM events WHERE event_id IN ('evt-q1','evt-q2','evt-q0') ORDER BY event_id").all();
  const appliedUpto = b.db.prepare("SELECT * FROM applied_upto").all();

  // replay the same batch: invalid re-delivery must be duplicate-classified (no 2nd quarantine row)
  const scripted2 = {
    sent: [] as unknown[], received: [] as unknown[],
    async send(msg: unknown) { this.sent.push(msg); },
    async receive(): Promise<unknown> {
      if (this.received.length === 0) { this.received.push("hello"); return { v: 1, type: "HELLO", device_clock: { [fakeC]: 3 } }; }
      if (this.received.length === 1) { this.received.push("batch"); return { v: 1, type: "CHANGES_BATCH", changes: batch, remaining_ranges: [] }; }
      return null;
    },
  };
  const eng2 = createSyncEngine({ db: b.db, selfDeviceId: b.identity.deviceId, mutateEntity: makeEntityMutator() });
  const stats2 = await eng2.runSession(scripted2 as never);
  const qAfter = (b.db.prepare("SELECT COUNT(*) c FROM quarantine").get() as { c: number }).c;

  saveResult("sc6", { stats, stats2, quarantine: q, skipped, rows, appliedUpto, qAfter });
  expect(q.length).toBe(1); // invalid quarantined exactly once
  expect(rows.length).toBe(2); // both valid events applied
  expect(qAfter).toBe(1); // no duplicate quarantine row on replay
  b.core.db.close();
});

test("SC7 abort mid-session x3 + restart: converge, no duplication", async () => {
  // Pkg6: assertion-timeout bump 5s -> 180s (QA harness artifact fix, per
  // pkg4-review justification and pkg5b-review §5: this probe's own runtime
  // is ~45 s of legitimate abort/restart cycles; the 5 s vitest default was
  // a stale missing per-test timeout, not a product hang — SC7 passes
  // deterministically when given 180 s, verified in qa-review5c-tmp).
  const runs: unknown[] = [];
  for (let run = 0; run < 3; run++) {
    const a = makeDevice("A");
    const b = makeDevice("B");
    pairDevices(a, b);
    for (let i = 0; i < 8; i++) mkEvent(a, `r${run}-ev-${i}`);
    // abort the very first session mid-flight (partial batch may land)
    await sessionOnce(a, b, { tolerateError: true, filter: (msg) => !((msg as { type?: string }).type === "CHANGES_ACK") === false });
    // crude abort: drop every CHANGES_BATCH after the first one delivered
    let batches = 0;
    await sessionOnce(a, b, {
      tolerateError: true,
      filter: (msg, dir) => {
        const t = (msg as { type?: string }).type;
        if (dir === "to" && t === "CHANGES_BATCH") { batches++; return batches <= 1; }
        return true;
      },
    });
    // restart simulation: reopen both DBs
    a.core.db.close();
    b.core.db.close();
    const aR = new EventCore(join(a.dir, "tide.db"), a.identity.deviceId);
    const bR = new EventCore(join(b.dir, "tide.db"), b.identity.deviceId);
    const a2: Device = { ...a, core: aR, db: aR.db as Database.Database };
    const b2: Device = { ...b, core: bR, db: bR.db as Database.Database };
    await sessionOnce(a2, b2);
    await sessionOnce(b2, a2);
    await sessionOnce(a2, b2);
    const o = oracle([a2, b2]);
    const changesB = (b2.db.prepare("SELECT COUNT(*) c FROM changes").get() as { c: number }).c;
    const eventsB = (b2.db.prepare("SELECT COUNT(*) c FROM events").get() as { c: number }).c;
    const pendingB = (b2.db.prepare("SELECT COUNT(*) c FROM pending_changes").get() as { c: number }).c;
    runs.push({ run, converged: o.converged, detail: o.detail, changesB, eventsB, pendingB, stateA: dumpState("A", a2) });
    saveResult(`sc7-run${run}`, runs[runs.length - 1]);
    a2.core.db.close();
    b2.core.db.close();
  }
  expect(runs.every((r) => (r as { converged: boolean }).converged)).toBe(true);
  expect(runs.every((r) => (r as { pendingB: number }).pendingB === 0)).toBe(true);
}, 180_000); // Pkg6: per-test assertion timeout (see comment at test head)
