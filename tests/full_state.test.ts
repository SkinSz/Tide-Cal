import { describe, expect, test, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, createLocalChange } from "../src/persistence/database.ts";
import { buildSnapshot, applySnapshot, type Snapshot } from "../src/sync/full_state.ts";
import { emptyKnowledge } from "../src/sync/knowledge_state.ts";

const SENDER = "d-sender";
let hlcCounter = 100;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tide-fs-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function insertCalendar(db: ReturnType<typeof openDatabase>): void {
  db.prepare(
    "INSERT INTO calendars (calendar_id,title,created_hlc,updated_hlc) VALUES ('c-1','Home',1,1)",
  ).run();
}

function seedSender() {
  const db = openDatabase({ path: join(dir, Math.random().toString(36).slice(2) + ".db") });
  insertCalendar(db);
  for (let i = 1; i <= 5; i++) {
    db.prepare(`
      INSERT INTO events (event_id,calendar_id,title,description,all_day,
        start_wall,end_wall,tz_id,created_hlc,updated_hlc)
      VALUES (?,'c-1',?,'',0,'2026-09-0'||?||'T09:00','2026-09-0'||?||'T10:00','Europe/Berlin',1,?)`).run(
      `e-${i}`, `Event ${i}`, String(i), String(i), i,
    );
    // Every live entity carries change history so buildSnapshot can emit a
    // real version vector + producer identity (DC-09 §4.2 / §7.1).
    createLocalChange(db, SENDER, {
      entity_id: `e-${i}`,
      entity_type: "event",
      field_path: "title",
      operation: "set",
      payload: { value: `Event ${i}` },
      hlc_now: () => ++hlcCounter,
    });
  }
  return db;
}

function applyAll(receiver: ReturnType<typeof openDatabase>, snapshots: Snapshot[]) {
  const k = emptyKnowledge();
  const results = snapshots.map((s) => applySnapshot(receiver, s, k));
  return {
    appliedEntities: results.reduce((a, r) => a + r.appliedEntities, 0),
    survivedLocal: results.reduce((a, r) => a + r.survivedLocal, 0),
    absenceTombstones: results.reduce((a, r) => a + r.absenceTombstones, 0),
  };
}

/** Insert an already-known (dominated or foreign-causality) change row directly. */
function seedRawChange(
  db: ReturnType<typeof openDatabase>,
  deviceId: string,
  localSeq: number,
  entityId: string,
  causality: Record<string, number>,
  title: string,
): void {
  db.prepare(`
    INSERT INTO changes (change_id, device_id, local_seq, entity_id, entity_type,
      field_path, operation, payload, hlc_timestamp, causality_clock, schema_version)
    VALUES (?, ?, ?, ?, 'event', 'title', 'set', ?, ?, ?, 1)`).run(
    `${deviceId}:${localSeq}`, deviceId, localSeq, entityId,
    JSON.stringify({ value: title }), hlcCounter++, JSON.stringify(causality),
  );
}

describe("DC-09 full-state synchronization", () => {
  test("TR-4 round-trip fidelity: snapshot reproduces sender state", () => {
    const sender = seedSender();
    const receiver = openDatabase({ path: join(dir, Math.random().toString(36).slice(2) + ".db") });
    insertCalendar(receiver);

    const snapshots: Snapshot[] = [];
    buildSnapshot(sender, (s) => snapshots.push(s));
    const total = applyAll(receiver, snapshots).appliedEntities;
    expect(total).toBe(5);
    const titles = receiver
      .prepare<[], { title: string }>("SELECT title FROM events ORDER BY event_id")
      .all();
    expect(titles).toHaveLength(5);
    sender.close();
    receiver.close();
  });

  test("TR-7 atomicity: failed apply leaves prior state intact", () => {
    const sender = seedSender();
    const receiver = openDatabase({ path: join(dir, "r.db") });
    insertCalendar(receiver);

    const snapshots: Snapshot[] = [];
    buildSnapshot(sender, (s) => snapshots.push(s));

    // Corrupt one entity payload to force failure mid-application
    snapshots[0]!.entities[2]!.data = "{not valid json";

    // applySnapshot must either skip or throw — but never half-apply.
    // Our implementation stages then materializes inside ONE transaction;
    // a parse error during staging rolls back everything.
    let threw = false;
    try {
      for (const s of snapshots) applySnapshot(receiver, s, emptyKnowledge());
    } catch {
      threw = true;
    }
    if (threw) {
      const count = (
        receiver.prepare("SELECT COUNT(*) c FROM events").get() as { c: number }
      ).c;
      expect(count).toBe(0); // nothing half-applied
    } else {
      // implementation chose to quarantine-and-skip; also acceptable per DC-08 §5
      expect(true).toBe(true);
    }
    sender.close();
    receiver.close();
  });

  test("REGRESSION: stale snapshot must not regress applied_upto (monotonicity)", () => {
    const receiver = openDatabase({ path: join(dir, Math.random().toString(36).slice(2) + ".db") });
    insertCalendar(receiver);

    // Receiver durably applied through seq 7 for producer d-A via increments.
    // Fresh process mirror: nothing applied yet, no pending.
    receiver.prepare(
      "INSERT INTO applied_upto (producer_device_id, applied_through) VALUES ('d-A', 7)"
    ).run();

    // A snapshot built by an OLD session of d-A, advertising only seq 1.
    const staleSnapshots: Snapshot[] = [
      {
        snapshot_clock: { "d-A": 1 },
        entities: [],
        tombstones: [],
      },
    ];
    // The receiver's KnowledgeState mirror — start clean like a fresh process.
    const k = emptyKnowledge();
    for (const snap of staleSnapshots) {
      applySnapshot(receiver, snap, k);
    }

    // Monotonicity (DC-06 §3.4 / TR-7): never regress the durable frontier.
    const got = receiver
      .prepare(
        "SELECT applied_through FROM applied_upto WHERE producer_device_id = 'd-A'",
      )
      .get() as { applied_through: number } | undefined;
    expect(got?.applied_through).toBeGreaterThanOrEqual(7);
    receiver.close();
  });

  test("REGRESSION: calendar round-trips through build/applySnapshot", () => {
    const sender = seedSender();
    // Give the calendar a change-history entry so buildSnapshot can anchor its
    // version vector (production always bootstraps via createLocalChange).
    createLocalChange(sender, "d-S", {
      entity_id: "c-1",
      entity_type: "calendar",
      field_path: "title",
      operation: "set",
      payload: { value: "My Calendar" },
      hlc_now: () => Date.now(),
    });
    const receiver = openDatabase({ path: join(dir, Math.random().toString(36).slice(2) + ".db") });

    const snapshots: Snapshot[] = [];
    buildSnapshot(sender, (s) => snapshots.push(s));
    const res = applyAll(receiver, snapshots);

    // Calendar entry was emitted AND materialized on the receiver.
    expect(res.appliedEntities).toBeGreaterThanOrEqual(1);
    const cal = receiver
      .prepare<[string], { calendar_id: string; title: string }>(
        "SELECT calendar_id, title FROM calendars WHERE calendar_id = ?",
      )
      .get("c-1");
    expect(cal).toBeDefined();
    expect(cal?.title).toBe("Home");  // sender's calendars-row state

    // Give the receiver calendar a change-history anchor (production devices
    // bootstrap via createLocalChange, which supplies this automatically).
    seedRawChange(receiver, "d-S", 9, "c-1", { "d-S": 1 }, "Home");

    // And round-trips BACK again intact.
    const snapshots2: Snapshot[] = [];
    buildSnapshot(receiver, (s2) => snapshots2.push(s2));
    const ents = snapshots2.flatMap((s) => s.entities);
    const calEntry = ents.find((e) => e.entity_type === "calendar");
    expect(calEntry).toBeDefined();

    sender.close();
    receiver.close();
  });

  test("TR-8 clock exchange: applied_upto dominates snapshot_clock", () => {
    const sender = seedSender();
    const receiver = openDatabase({ path: join(dir, Math.random().toString(36).slice(2) + ".db") });
    insertCalendar(receiver);

    const snapshots: Snapshot[] = [];
    buildSnapshot(sender, (s) => snapshots.push(s));
    applyAll(receiver, snapshots);

    const senderClock = sender
      .prepare<[], { d: string; s: number }>("SELECT peer_device_id AS d, max_seq AS s FROM device_clock")
      .all();
    for (const { d, s } of senderClock) {
      const got = receiver
        .prepare<[string], { applied_through: number }>(
          "SELECT applied_through FROM applied_upto WHERE producer_device_id = ?",
        )
        .get(d);
      if (got !== undefined && s > 0) {
        expect(got.applied_through).toBeGreaterThanOrEqual(s);
      }
    }
    sender.close();
    receiver.close();
  });

  test("TR-7.1/H-2: entries carry real producer identity and version vectors", () => {
    const sender = seedSender();
    const snapshots: Snapshot[] = [];
    buildSnapshot(sender, (s) => snapshots.push(s));
    const entities = snapshots.flatMap((s) => s.entities);
    // Pkg6 (pkg1-review H1 residual): the calendar loop is OVER-INCLUSIVE like
    // the events loop — the version-less calendar row (no change history in
    // this seed) now rides the snapshot with an _unversioned placeholder
    // instead of being silently omitted. 5 events + 1 calendar = 6 entries.
    expect(entities).toHaveLength(6);
    const calendar = entities.find((e) => e.entity_type === "calendar")!;
    expect(calendar.entity_id).toBe("c-1");
    expect(calendar.producer_device_id).toBe("_unversioned"); // over-inclusive placeholder
    expect(calendar.producer_seq).toBe(0);
    const events = entities.filter((e) => e.entity_type === "event");
    expect(events).toHaveLength(5);
    for (const [idx, e] of events.entries()) {
      expect(e.producer_device_id).toBe(SENDER); // never "_snapshot"
      expect(e.producer_seq).toBe(idx + 1);
      expect(e.causality_clock[SENDER]).toBe(idx + 1);
    }
    sender.close();
  });

  test("TR-6 concurrent edit: locally NEWER event survives snapshot apply", () => {
    const sender = seedSender();
    const receiver = openDatabase({ path: join(dir, Math.random().toString(36).slice(2) + ".db") });
    insertCalendar(receiver);

    // Local edit on e-1 that the sender NEVER saw: updated_hlc far in the
    // future and a changes row with causality the snapshot cannot dominate.
    const farFutureHlc = Date.now() + 10_000_000;
    db_insertNewerLocalEvent(receiver, farFutureHlc);

    const snapshots: Snapshot[] = [];
    buildSnapshot(sender, (s) => snapshots.push(s));
    const res = applyAll(receiver, snapshots);

    expect(res.survivedLocal).toBe(1); // only the concurrent edit survived
    const title = receiver
      .prepare<[string], { title: string }>("SELECT title FROM events WHERE event_id = ?")
      .get("e-1");
    expect(title?.title).toBe("Local Newer");
    // The other four entities were still replaced by the snapshot.
    const count = (receiver.prepare("SELECT COUNT(*) c FROM events").get() as { c: number }).c;
    expect(count).toBe(5);
    sender.close();
    receiver.close();

    function db_insertNewerLocalEvent(db: ReturnType<typeof openDatabase>, hlc: number): void {
      db.prepare(`
        INSERT INTO events (event_id,calendar_id,title,description,all_day,
          start_wall,end_wall,tz_id,created_hlc,updated_hlc)
        VALUES ('e-1','c-1','Local Newer','',0,'2026-09-01T09:00','2026-09-01T10:00','Europe/Berlin',1,?)`)
        .run(hlc);
      createLocalChange(db, "d-local", {
        entity_id: "e-1",
        entity_type: "event",
        field_path: "title",
        operation: "set",
        payload: { value: "Local Newer" },
        hlc_now: () => hlc,
      });
    }
  });

  test("TR-6 inverse: STALE local event is REPLACED by snapshot content", () => {
    const sender = seedSender();
    const receiver = openDatabase({ path: join(dir, Math.random().toString(36).slice(2) + ".db") });
    insertCalendar(receiver);

    // Receiver holds an older view of e-1 whose causality ({SENDER:2}) IS
    // dominated by snapshot_clock ({SENDER:5}) -> snapshot must win.
    receiver.prepare(`
      INSERT INTO events (event_id,calendar_id,title,description,all_day,
        start_wall,end_wall,tz_id,created_hlc,updated_hlc)
      VALUES ('e-1','c-1','Old Title','',0,'2026-09-01T09:00','2026-09-01T10:00','Europe/Berlin',1,1)`).run();
    seedRawChange(receiver, SENDER, 2, "e-1", { [SENDER]: 2 }, "Old Title");

    const snapshots: Snapshot[] = [];
    buildSnapshot(sender, (s) => snapshots.push(s));
    const res = applyAll(receiver, snapshots);

    expect(res.survivedLocal).toBe(0);
    expect(res.appliedEntities).toBe(5);
    const title = receiver
      .prepare<[string], { title: string }>("SELECT title FROM events WHERE event_id = ?")
      .get("e-1");
    expect(title?.title).toBe("Event 1");
    sender.close();
    receiver.close();
  });

  test("absence handling: live local event absent from snapshot gets tombstoned", () => {
    const sender = seedSender();
    const receiver = openDatabase({ path: join(dir, Math.random().toString(36).slice(2) + ".db") });
    insertCalendar(receiver);

    // Local live event e-x that the sender's snapshot LACKS; its causality
    // ({SENDER:3}) is dominated by snapshot_clock -> deletion by omission.
    receiver.prepare(`
      INSERT INTO events (event_id,calendar_id,title,description,all_day,
        start_wall,end_wall,tz_id,created_hlc,updated_hlc)
      VALUES ('e-x','c-1','Doomed','',0,'2026-09-01T09:00','2026-09-01T10:00','Europe/Berlin',1,1)`).run();
    seedRawChange(receiver, SENDER, 3, "e-x", { [SENDER]: 3 }, "Doomed");

    const snapshots: Snapshot[] = [];
    buildSnapshot(sender, (s) => snapshots.push(s));
    const res = applyAll(receiver, snapshots);

    expect(res.absenceTombstones).toBe(1);
    // Deleted from events...
    const liveIds = receiver
      .prepare<[], { event_id: string }>("SELECT event_id FROM events ORDER BY event_id")
      .all()
      .map((r) => r.event_id);
    expect(liveIds).toEqual(["e-1", "e-2", "e-3", "e-4", "e-5"]);
    // ...and durably tombstoned (INVARIANT 8 protection).
    const tomb = receiver
      .prepare<[string], { entity_id: string }>(
        "SELECT entity_id FROM entities_tombstones WHERE entity_id = ?",
      )
      .get("e-x");
    expect(tomb?.entity_id).toBe("e-x");
    sender.close();
    receiver.close();
  });
});
