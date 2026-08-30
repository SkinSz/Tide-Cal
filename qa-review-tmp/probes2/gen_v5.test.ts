// pkg1-review CHECK A + CHECK B: v5-era DB generation under BASELINE code
// (run with the remediation diff stashed, so SCHEMA_VERSION=5 and no
// entity_versions table exists).
import { expect, test } from "vitest";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { EventCore } from "../../src/persistence/bridges/event_core.ts";
import { loadOrCreateIdentity } from "../../src/network/sync_runtime.ts";
import { createLocalChange, openDatabase } from "../../src/persistence/database.ts";
import { sweep } from "../../src/sync/compaction.ts";

const OUT = join(import.meta.dirname, "..", "gen");

test("gen-A: v5 DB with calendar + events, then DC-06 sweep deletes ALL change history", () => {
  const dir = join(OUT, "checkA", "deviceA");
  mkdirSync(dir, { recursive: true });
  const identity = loadOrCreateIdentity(dir);
  const core = new EventCore(join(dir, "tide.db"), identity.deviceId);
  for (let i = 0; i < 3; i++) {
    core.createEvent({
      title: `pre-${i}`,
      description: "checkA",
      startMs: 1_750_000_000_000 + i * 3600_000,
      endMs: 1_750_000_000_000 + i * 3600_000 + 1800_000,
      allDay: false,
    });
  }
  // Give the calendar a NON-default title with real change history (T1), so a
  // wiped history means the peer's custom calendar metadata is unrecoverable.
  createLocalChange(
    core.db as Database.Database,
    identity.deviceId,
    {
      entity_id: "local",
      entity_type: "calendar",
      field_path: "title",
      operation: "set",
      payload: { value: "Work Calendar" },
      hlc_now: () => 1_750_000_001_000,
    },
    (db) => {
      db.prepare("UPDATE calendars SET title = 'Work Calendar' WHERE calendar_id = 'local'").run();
    },
  );

  const nChangesBefore = (core.db as Database.Database)
    .prepare("SELECT COUNT(*) c FROM changes").get() as { c: number };
  // Simulate the pre-v6 compaction outcome: a constraint peer provably knows
  // every record of device A, so sweep() deletes the ENTIRE change history
  // (calendar bootstrap + calendar title change + all event records).
  const FAKE_PEER = "constraint-peer-zz";
  const stats = sweep({
    db: core.db as Database.Database,
    selfDeviceId: identity.deviceId,
    lastKnownClock: { [FAKE_PEER]: { [identity.deviceId]: 1_000_000 } },
    constraintSet: [FAKE_PEER],
  });
  const after = {
    changes: (core.db as Database.Database).prepare("SELECT COUNT(*) c FROM changes").get() as { c: number },
    events: (core.db as Database.Database).prepare("SELECT COUNT(*) c FROM events").get() as { c: number },
    calTitle: (core.db as Database.Database).prepare("SELECT title FROM calendars").get() as { title: string },
    schemaVersion: (core.db as Database.Database).prepare("SELECT version v FROM schema_version").get() as { v: number },
    entityVersionsExists: (core.db as Database.Database)
      .prepare("SELECT COUNT(*) c FROM sqlite_master WHERE name='entity_versions'").get() as { c: number },
  };
  console.log("[gen-A] changesBefore:", JSON.stringify(nChangesBefore),
    "sweepStats:", JSON.stringify(stats), "after:", JSON.stringify(after));
  expect(after.changes.c).toBe(0); // history fully compacted
  expect(after.events.c).toBe(3); // live rows remain
  expect(after.calTitle.title).toBe("Work Calendar"); // live calendar remains
  expect(after.schemaVersion.v).toBe(5); // still pre-migration
  expect(after.entityVersionsExists.c).toBe(0); // no v6 state table
  (core.db as Database.Database).close();
});

// CHECK B templates: large synthetic v5 DBs so the v5->v6 backfill migration
// runs long enough (~100ms+) for SIGKILL timings 0-25ms to land INSIDE the
// migration window. Data shape matches T1/T2 output; insertion is bulk SQL for
// speed (the migration code path is identical regardless of data provenance).
function genBulk(dir: string, n: number, devA: string): void {
  mkdirSync(dir, { recursive: true });
  const db = openDatabase({ path: join(dir, "tide.db") }); // baseline -> v5
  const T0 = 1_750_000_000_000;
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO calendars (calendar_id, title, color, created_hlc, updated_hlc)
       VALUES ('local', 'My Calendar', NULL, 1, 1)`).run();
    const insEv = db.prepare(
      `INSERT INTO events (event_id, calendar_id, title, description, all_day,
         start_date, end_date, start_wall, end_wall, tz_id, utc_start_ms, utc_end_ms,
         created_hlc, updated_hlc)
       VALUES (?, 'local', ?, '', 0, NULL, NULL, '10:00', '11:00', 'UTC', ?, ?, ?, ?)`);
    const insCh = db.prepare(
      `INSERT INTO changes (change_id, device_id, local_seq, entity_id, entity_type,
         field_path, operation, payload, hlc_timestamp, causality_clock, schema_version)
       VALUES (?, ?, ?, ?, 'event', 'event', 'set', '{}', ?, ?, 1)`);
    for (let i = 0; i < n; i++) {
      const eid = `evt-bulk-${i}`;
      const seq = i + 1;
      insEv.run(eid, `bulk-${i}`, T0 + i * 3600_000, T0 + i * 3600_000 + 1800_000, seq, seq);
      insCh.run(`chk-${devA}-${seq}`, devA, seq, eid, T0 + seq, JSON.stringify({ [devA]: seq }));
    }
    // Multi-change entity: evt-bulk-0 gets 5 revisions -> expected backfilled
    // vector {devA: 5}, latest_seq 5 (element-wise max correctness probe).
    for (let r = 2; r <= 5; r++) {
      const seq = n + r;
      insCh.run(`chk-${devA}-${seq}`, devA, seq, "evt-bulk-0", T0 + seq,
        JSON.stringify({ [devA]: seq }));
    }
    db.prepare("INSERT INTO device_clock (peer_device_id, max_seq) VALUES (?, ?)").run(devA, n + 5);
  });
  tx();
  const v = db.prepare("SELECT version v FROM schema_version").get() as { v: number };
  console.log(`[gen-B] ${dir}: events=${n + 0} changes=${(db.prepare("SELECT COUNT(*) c FROM changes").get() as { c: number }).c} schema_v=${v.v}`);
  expect(v.v).toBe(5);
  db.close();
}

test("gen-B1: bulk v5 template db1", () => {
  genBulk(join(OUT, "checkB", "db1"), 60_000, "devA-gen-1");
});

test("gen-B2: bulk v5 template db2", () => {
  genBulk(join(OUT, "checkB", "db2"), 60_000, "devA-gen-2");
});
