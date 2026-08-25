import { describe, expect, test, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, createLocalChange, applyRemoteChange } from "../src/persistence/database.ts";
import { sweep, compactable } from "../src/sync/compaction.ts";
import { makeChange } from "./change_record.test.ts";
import { emptyKnowledge } from "../src/sync/knowledge_state.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tide-comp-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const SELF = "d-self";
const PEER = "d-peer";

function setup() {
  const db = openDatabase({ path: join(dir, Math.random().toString(36).slice(2) + ".db") });
  const k = emptyKnowledge();
  return { db, k };
}

describe("DC-06 compaction", () => {
  test("retains records when peer knows nothing (TR-2 stale-peer protection)", () => {
    const { db, k } = setup();
    createLocalChange(db, SELF, {
      entity_id: "e1", entity_type: "event", field_path: "title",
      operation: "set", payload: { value: "x" }, hlc_now: () => 1,
    });
    const deps = {
      db, selfDeviceId: SELF,
      lastKnownClock: {},
      constraintSet: [PEER],
    };
    const stats = sweep(deps);
    expect(stats.deletedChanges).toBe(0);
    db.close();
  });

  test("compacts once peer provably knows (§2.2)", () => {
    const { db, k } = setup();
    const rec = createLocalChange(db, SELF, {
      entity_id: "e1", entity_type: "event", field_path: "title",
      operation: "set", payload: { value: "x" }, hlc_now: () => 1,
    });
    const deps = {
      db, selfDeviceId: SELF,
      lastKnownClock: { [PEER]: { [SELF]: rec.local_seq } },
      constraintSet: [PEER],
    };
    let stats = sweep(deps);
    expect(stats.deletedChanges).toBe(1);
    // TR-8 idempotency
    stats = sweep(deps);
    expect(stats.deletedChanges).toBe(0);
    db.close();
  });

  test("TR-5 unresolved-conflict participants are never compacted", () => {
    const { db, k } = setup();
    // local change that will be a conflict participant
    const localRec = createLocalChange(db, SELF, {
      entity_id: "e-c", entity_type: "event", field_path: "title",
      operation: "set", payload: { value: "Dentist" }, hlc_now: () => 1,
    });
    // incoming concurrent change: seed producer history 1..8 so seq 9 applies
    for (let s = 1; s <= 8; s++) {
      applyRemoteChange(
        db,
        makeChange({
          device_id: "d-other", local_seq: s, entity_id: `e-seed-${s}`,
          clock: { "d-other": s }, value: `seed${s}`,
        }),
        k,
      );
    }
    const incoming = makeChange({
      device_id: "d-other", local_seq: 9, entity_id: "e-c",
      clock: { "d-other": 9 }, value: "Doctor",
    });
    expect(applyRemoteChange(db, incoming, k)).toBe("applied");

    // insert conflict + participants (simulating detection output)
    db.prepare(
      "INSERT INTO conflicts (conflict_id,entity_id,field_path,status,detected_at_hlc) VALUES ('c-1','e-c','title','unresolved',1)",
    ).run();
    db.prepare(
      "INSERT INTO conflict_participants (conflict_id,change_id,device_id,local_seq,causality_clock,payload) VALUES ('c-1',?, 'd-other',9,'{}','{}')",
    ).run(incoming.change_id);
    db.prepare(
      "INSERT INTO conflict_participants (conflict_id,change_id,device_id,local_seq,causality_clock,payload) VALUES ('c-1',?, ?, ?, '{}','{}')",
    ).run(localRec.change_id, SELF, localRec.local_seq);

    const deps = {
      db, selfDeviceId: SELF,
      lastKnownClock: { [PEER]: { [SELF]: 100, "d-other": 100 } },
      constraintSet: [PEER],
    };
    const stats = sweep(deps);
    const remaining = db
      .prepare("SELECT change_id FROM changes")
      .all() as Array<{ change_id: string }>;
    const ids = new Set(remaining.map((r) => r.change_id));
    expect(ids.has(localRec.change_id)).toBe(true);   // protected
    expect(ids.has(incoming.change_id)).toBe(true);   // protected
    // seed records 1..8 are NOT conflict participants -> compactable & swept
    expect(stats.deletedChanges).toBe(8);
    db.close();
  });

  test("TR-7 monotonicity: sweep never changes advertised knowledge", () => {
    const { db, k } = setup();
    createLocalChange(db, SELF, {
      entity_id: "e2", entity_type: "event", field_path: "title",
      operation: "set", payload: { value: "y" }, hlc_now: () => 1,
    });
    const before = db.prepare("SELECT max_seq FROM device_clock").all();
    sweep({
      db, selfDeviceId: SELF,
      lastKnownClock: { [PEER]: { [SELF]: 50 } },
      constraintSet: [PEER],
    });
    const after = db.prepare("SELECT max_seq FROM device_clock").all();
    expect(after).toEqual(before);
    db.close();
  });
});

describe("DC-06 member tombstone boundary", () => {
  test("member tombstones follow the same predicate", () => {
    const { db } = setup();
    db.prepare(`
      INSERT INTO member_tombstones (entity_id, collection_path, member_id, producer_device_id, seq, causality_clock)
      VALUES ('e-m','reminders','r-1',?,7,'{}')`).run("d-x");
    const deps = {
      db, selfDeviceId: SELF,
      lastKnownClock: { [PEER]: { "d-x": 6 } }, // peer only knows through 6
      constraintSet: [PEER],
    };
    expect(compactable(deps, "d-x", 7)).toBe(false);
    deps.lastKnownClock[PEER]!["d-x"] = 7;
    expect(compactable(deps, "d-x", 7)).toBe(true);
    db.close();
  });
});
