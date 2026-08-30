// pkg1-review CHECK A (H1 calendar asymmetry) + CHECK D (H4 deletion
// propagation) — run under the FIXED code (diff restored).
import { expect, test } from "vitest";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { openDatabase } from "../../src/persistence/database.ts";
import { buildSnapshot, type Snapshot } from "../../src/sync/full_state.ts";
import { loadOrCreateIdentity } from "../../src/network/sync_runtime.ts";
import { EventCore } from "../../src/persistence/bridges/event_core.ts";
import { makeEntityMutator } from "../../src/persistence/bridges/sync_service.ts";
import { createSyncEngine } from "../../src/sync/sync_engine.ts";
import {
  convergeRound,
  makeDevice,
  sessionOnce,
  sweepOn,
  msgPipePair,
  type Device,
} from "../../tests/pkg1_helpers.ts";

const GEN = join(import.meta.dirname, "..", "gen");
const fakeDevice = (db: Database.Database, dir: string, tag: string, deviceId: string): Device =>
  ({ tag, dir, core: { db } as unknown as EventCore, db, identity: { deviceId } as never });

// ---------------------------------------------------------------------------
// CHECK A
// ---------------------------------------------------------------------------
test("CHECK-A: migrated v5 DB w/ compacted calendar history -> snapshot + fresh peer", async () => {
  const dir = join(GEN, "checkA", "deviceA");
  const idA = loadOrCreateIdentity(dir);
  // Open with plain openDatabase (NOT EventCore) so the default-calendar
  // re-bootstrap cannot mask the compacted-history condition.
  const dbA = openDatabase({ path: join(dir, "tide.db") });

  const sv = dbA.prepare("SELECT version v FROM schema_version").get() as { v: number };
  const ev = dbA.prepare("SELECT COUNT(*) c FROM entity_versions").get() as { c: number };
  const ch = dbA.prepare("SELECT COUNT(*) c FROM changes").get() as { c: number };
  const cal = dbA.prepare("SELECT title FROM calendars").get() as { title: string };
  const nEv = dbA.prepare("SELECT COUNT(*) c FROM events").get() as { c: number };
  console.log("[A] post-migration: schema_v:", sv.v, "entity_versions rows:", ev.c,
    "changes:", ch.c, "calendar title:", JSON.stringify(cal.title), "events:", nEv.c);
  expect(sv.v).toBe(6);
  expect(ev.c).toBe(0); // backfill had nothing to copy: history swept pre-migration

  // buildSnapshot: what does a fresh peer get offered?
  const entries: Array<{ entity_type: string; producer: string; clock: string; id: string }> = [];
  buildSnapshot(dbA, (s: Snapshot) => {
    for (const e of s.entities) {
      entries.push({ entity_type: e.entity_type, producer: e.producer_device_id, clock: JSON.stringify(e.causality_clock), id: e.entity_id });
    }
  });
  const calEntries = entries.filter((e) => e.entity_type === "calendar");
  const evtEntries = entries.filter((e) => e.entity_type === "event");
  console.log("[A] snapshot entries: calendars:", calEntries.length,
    "events:", evtEntries.length, "sample event:", JSON.stringify(evtEntries[0]));
  expect(evtEntries.length).toBe(3); // events loop is over-inclusive ("_unversioned")
  expect(calEntries.length).toBe(0); // CALENDAR OMITTED — the H1 asymmetry

  // Fresh peer B bootstraps from A (B is a real EventCore device: pure v6 flow).
  const b = makeDevice("B-checkA");
  const aFake = fakeDevice(dbA, dir, "A-checkA", idA.deviceId);
  const dump = (label: string) => {
    const q = (db: Database.Database, sql: string) => db.prepare(sql).all();
    console.log(`[A] ${label} | A: cal=${JSON.stringify((dbA.prepare("SELECT title FROM calendars").get() as { title: string }).title)}` +
      ` changes=${(q(dbA, "SELECT COUNT(*) c FROM changes") as Array<{ c: number }>)[0]!.c}` +
      ` evers=${JSON.stringify(q(dbA, "SELECT entity_id, version FROM entity_versions"))}` +
      ` | B: cal=${JSON.stringify((b.db.prepare("SELECT title FROM calendars").get() as { title: string }).title)}` +
      ` changes=${(q(b.db, "SELECT COUNT(*) c FROM changes") as Array<{ c: number }>)[0]!.c}` +
      ` events=${(q(b.db, "SELECT COUNT(*) c FROM events") as Array<{ c: number }>)[0]!.c}`);
  };
  dump("before session 1");
  await sessionOnce(aFake, b);
  dump("after session 1 (A->B, both engines)");
  await sessionOnce(b, aFake);
  dump("after session 2 (B->A, both engines)");
  const bEvents = (b.db.prepare("SELECT COUNT(*) c FROM events").get() as { c: number }).c;
  const bCals = b.db.prepare("SELECT calendar_id, title FROM calendars").all();
  const bVers = b.db.prepare("SELECT entity_id, entity_type, version FROM entity_versions ORDER BY entity_id").all();
  console.log("[A] fresh peer B: events:", bEvents, "calendars:", JSON.stringify(bCals));
  console.log("[A] fresh peer B entity_versions:", JSON.stringify(bVers));
  expect(bEvents).toBe(3); // events DID arrive (over-inclusive loop)
  // B has its OWN "local" bootstrap calendar; A's custom "Work Calendar"
  // metadata only arrives once A re-acquires calendar version state (see dump).
  console.log("[A] B calendars:", JSON.stringify(bCals));

  // Reverse direction: B streams its snapshot back to A. B's calendar entry
  // carries B's own bootstrap causality; A's unversioned calendar row — does
  // A's custom title survive?
  const aCalAfter = dbA.prepare("SELECT title FROM calendars").get() as { title: string };
  console.log("[A] A calendar title after B->A session:", JSON.stringify(aCalAfter));
  console.log("[A] A entity_versions after B->A:", JSON.stringify(
    dbA.prepare("SELECT entity_id, entity_type, version FROM entity_versions").all()));
  (b.core.db as Database.Database).close();
  dbA.close();
});

// ---------------------------------------------------------------------------
// CHECK D
// ---------------------------------------------------------------------------
test("CHECK-D1: legitimate (versioned) deletion propagates via change record", async () => {
  const expectedIds: string[] = [];
  const a = makeDevice("D-A");
  const b = makeDevice("D-B");
  const e1 = a.core.createEvent({ title: "d1", description: "", startMs: 1_750_000_000_000, endMs: 1_750_000_000_000 + 3600_000, allDay: false });
  const e2 = a.core.createEvent({ title: "d2", description: "", startMs: 1_750_001_000_000, endMs: 1_750_001_000_000 + 3600_000, allDay: false });
  await convergeRound([a, b]);
  expect((b.db.prepare("SELECT COUNT(*) c FROM events").get() as { c: number }).c).toBe(2);

  a.core.deleteEvent(e2.id);
  await convergeRound([a, b]);
  const bHasE2 = b.db.prepare("SELECT COUNT(*) c FROM events WHERE event_id = ?").get(e2.id) as { c: number };
  const aTomb = a.db.prepare("SELECT entity_id FROM entities_tombstones WHERE entity_id = ?").get(e2.id);
  console.log("[D1] B: e2 rows:", bHasE2.c, "| A tombstone:", JSON.stringify(aTomb));
  expect(bHasE2.c).toBe(0); // deletion reached B via the remove change record
  // (deleteEvent emits only a 'remove' change, no entities_tombstones row —
  // tombstones are the absence/inherited path's artifact.)
  a.core.db.close(); b.core.db.close();
});

test("CHECK-D2: deletion propagates via ABSENCE path when A's delete evidence was swept while B held the live row", async () => {
  const a = makeDevice("D2-A");
  const b = makeDevice("D2-B");
  const c = makeDevice("D2-C");
  const e1 = a.core.createEvent({ title: "a1", description: "", startMs: 1_750_002_000_000, endMs: 1_750_002_000_000 + 3600_000, allDay: false });
  const e2 = a.core.createEvent({ title: "a2", description: "", startMs: 1_750_003_000_000, endMs: 1_750_003_000_000 + 3600_000, allDay: false });
  await convergeRound([a, b, c]);
  // A deletes e1; only C learns the delete record (B stays naive, still holds
  // the live row WITH version evidence {A:1..2}).
  a.core.deleteEvent(e1.id);
  await convergeRound([a, c]);
  const bVerBefore = b.db.prepare("SELECT version FROM entity_versions WHERE entity_id = ?").get(e1.id);
  console.log("[D2] B version evidence for e1 before absence:", JSON.stringify(bVerBefore));
  expect(bVerBefore).toBeDefined(); // B has REAL version evidence
  // Sweep A with constraint set = [C] only (B excluded — the operational
  // scenario where B is absent from the constraint set / its knowledge is
  // unknown). This is the ONLY honest way to reach the absence branch with
  // version evidence: A's create+delete records AND tombstone all vanish.
  const stats = sweepOn(a, [c]);
  console.log("[D2] sweep stats:", JSON.stringify(stats));
  expect(stats.deletedChanges).toBeGreaterThan(0);
  await convergeRound([a, b]); // A's snapshot omits e1, carries no tombstone
  const bHasE1 = b.db.prepare("SELECT COUNT(*) c FROM events WHERE event_id = ?").get(e1.id) as { c: number };
  const bTombE1 = b.db.prepare("SELECT producer_device_id FROM entities_tombstones WHERE entity_id = ?").get(e1.id);
  const bLive = (b.db.prepare("SELECT COUNT(*) c FROM events").get() as { c: number }).c;
  console.log("[D2] B: e1 rows:", bHasE1.c, "e1 absence-tombstone on B:", JSON.stringify(bTombE1),
    "live events on B (e2):", bLive);
  expect(bHasE1.c).toBe(0); // absence rule DID tombstone the legitimately-deleted event
  expect(bTombE1).toBeDefined();
  expect(bLive).toBe(1); // survivor untouched
  a.core.db.close(); b.core.db.close(); c.core.db.close();
});

test("CHECK-D3: empty-version guard protects only zero-evidence (zombie) rows", async () => {
  const a = makeDevice("D3-A");
  const b = makeDevice("D3-B");
  const e1 = a.core.createEvent({ title: "z1", description: "", startMs: 1_750_004_000_000, endMs: 1_750_004_000_000 + 3600_000, allDay: false });
  await convergeRound([a, b]);
  // Zombie: live event row on B with NO version evidence (never had any
  // change record) — e.g. pre-v6 row whose history was swept pre-migration.
  b.db.prepare(
    `INSERT INTO events (event_id, calendar_id, title, description, all_day,
       start_date, end_date, start_wall, end_wall, tz_id, utc_start_ms, utc_end_ms,
       created_hlc, updated_hlc)
     VALUES ('evt-zombie', 'local', 'zombie', '', 0, NULL, NULL, '10:00', '11:00', 'UTC', 1, 2, 1, 2)`).run();
  a.core.deleteEvent(e1.id);
  await convergeRound([a, b]);
  await convergeRound([a, b]);
  const z = b.db.prepare("SELECT COUNT(*) c FROM events WHERE event_id='evt-zombie'").get() as { c: number };
  const zVer = b.db.prepare("SELECT COUNT(*) c FROM entity_versions WHERE entity_id='evt-zombie'").get() as { c: number };
  const e1g = b.db.prepare("SELECT COUNT(*) c FROM events WHERE event_id = ?").get(e1.id) as { c: number };
  console.log("[D3] zombie rows on B:", z.c, "zombie entity_versions rows:", zVer.c,
    "versioned deleted e1 still on B:", e1g.c);
  expect(z.c).toBe(1); // guard keeps zero-evidence live row (never fabricated domination)
  expect(zVer.c).toBe(0); // and it has no version evidence — absence can NEVER remove it
  expect(e1g.c).toBe(0); // versioned deletion still propagates in the same exchange
  a.core.db.close(); b.core.db.close();
});
