// TD-007 / TD-019 hygiene regressions (2026-11-14).
//
//   TD-007 (1): the intake gate's hard-block lookup is prepared once per
//               engine, not once per arriving record, and still sees blocks
//               written after the engine was built.
//   TD-007 (2): the tracker measures durations on the monotonic clock, so
//               wall-clock steps (either direction) neither extend nor
//               shorten a window, throttle backoff or Level-4 timer.
//   TD-019 F3:  a message stashed by a session that died must not be
//               processed by the next session on the same engine
//               (DC-08 Appendix A.3: the stash is cleared at session start).
//   TD-019 F4:  FrameQueue's single waiter slot is load-bearing (the engine
//               may abandon a pending receive and start a fresh one); pin
//               "newest receive gets the next frame" so nobody turns it
//               into a FIFO that hands frames to abandoned receivers.
import { describe, expect, test, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "better-sqlite3";
import {
  openDatabase,
  hardBlockProducer,
} from "../src/persistence/database.ts";
import {
  PeerMisbehaviorTracker,
  DEFAULT_MISBEHAVIOR_CONFIG,
  monotonicWallClock,
  type MisbehaviorConfig,
} from "../src/sync/misbehavior.ts";
import {
  createSyncEngine,
  type SyncTransport,
  type SyncMessage,
} from "../src/sync/sync_engine.ts";
import { makeEntityMutator } from "../src/persistence/bridges/sync_service.ts";
import { makeLocalDuplexPair } from "../src/network/noise_transport.ts";
import type { ChangeRecord, VectorClock } from "../src/sync/change_record.ts";
import { seedEvent } from "./sync_seed_helpers.ts";

const T0 = Date.UTC(2026, 10, 14, 9, 0, 0);
const SELF = "d-a-self"; // sorts BELOW PEER: loses the DC-09 §7.3 offer race
const PEER = "d-z-peer";

let dir: string;
let db: Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tide-td007-"));
  db = openDatabase({ path: join(dir, "tide.db") });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function makeRecord(seq: number, device = PEER, entity = "evt-hyg"): ChangeRecord {
  return {
    change_id: `${device}:${seq}`,
    device_id: device,
    local_seq: seq,
    entity_id: entity,
    entity_type: "event",
    field_path: "title",
    operation: "set",
    payload: { value: `v${seq}` },
    hlc_timestamp: T0 + seq,
    causality_clock: { [device]: seq },
    schema_version: 1,
  };
}


/**
 * Scripted peer: each receive() takes the next script entry. An Error entry
 * makes that receive reject (carrier died); an empty script is clean EOF.
 */
function scriptedTransport(script: Array<SyncMessage | Error>): SyncTransport & {
  sent: SyncMessage[];
} {
  const sent: SyncMessage[] = [];
  return {
    sent,
    async send(m: SyncMessage) {
      sent.push(m);
    },
    async receive() {
      const next = script.shift();
      if (next === undefined) return null;
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

function changeCount(producer: string): number {
  return (
    db.prepare("SELECT COUNT(*) AS n FROM changes WHERE device_id = ?").get(producer) as {
      n: number;
    }
  ).n;
}

// ---------------------------------------------------------------------------
// TD-007 (1)
// ---------------------------------------------------------------------------

describe("TD-007 (1): hard-block lookup prepared once per engine", () => {
  test("a 40-record batch prepares the hard_blocks lookup once, at engine build", async () => {
    seedEvent(db, "evt-hyg");
    let hardBlockPrepares = 0;
    const realPrepare = db.prepare.bind(db);
    (db as unknown as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
      if (sql.includes("FROM hard_blocks WHERE producer_device_id")) hardBlockPrepares++;
      return realPrepare(sql);
    };
    const engine = createSyncEngine({
      db,
      selfDeviceId: SELF,
      mutateEntity: makeEntityMutator(),
      misbehavior: new PeerMisbehaviorTracker(DEFAULT_MISBEHAVIOR_CONFIG, () => T0),
    });
    expect(hardBlockPrepares).toBe(1);
    const records = Array.from({ length: 40 }, (_, i) => makeRecord(i + 1));
    const stats = await engine.runSession(
      scriptedTransport([
        { v: 1, type: "HELLO", device_clock: { [PEER]: 40 } as VectorClock },
        { v: 1, type: "CHANGES_BATCH", changes: records },
      ]),
    );
    expect(stats.receivedApplied).toBe(40);
    expect(hardBlockPrepares).toBe(1); // NOT 1 + 40
  });

  test("the hoisted check still sees a block written AFTER the engine was built", async () => {
    const engine = createSyncEngine({
      db,
      selfDeviceId: SELF,
      mutateEntity: makeEntityMutator(),
      misbehavior: new PeerMisbehaviorTracker(DEFAULT_MISBEHAVIOR_CONFIG, () => T0),
    });
    hardBlockProducer(db, PEER); // durable block lands after construction
    const stats = await engine.runSession(
      scriptedTransport([
        { v: 1, type: "HELLO", device_clock: { [PEER]: 3 } as VectorClock },
        { v: 1, type: "CHANGES_BATCH", changes: [1, 2, 3].map((s) => makeRecord(s)) },
      ]),
    );
    expect(stats.receivedApplied).toBe(0);
    expect(changeCount(PEER)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// TD-007 (2)
// ---------------------------------------------------------------------------

const FAST_CFG: MisbehaviorConfig = {
  ...DEFAULT_MISBEHAVIOR_CONFIG,
  tier1Count: 1,
  tier2Count: 10_000,
  throttleBaseMs: 30_000,
};

describe("TD-007 (2): wall-clock steps neither extend nor shorten penalties", () => {
  const J = 60 * 60 * 1000;
  let realDateNow: () => number;
  let offset = 0;
  beforeEach(() => {
    realDateNow = Date.now;
    offset = 0;
    Date.now = () => realDateNow() + offset; // a steppable WALL clock
  });
  afterEach(() => {
    Date.now = realDateNow;
  });

  test("default clock is monotonic: back-then-forward wall step keeps a throttle (review 2026-11-14)", () => {
    const t = new PeerMisbehaviorTracker(FAST_CFG); // production default clock
    for (let i = 0; i < 3; i++) t.recordInvalid(PEER); // L0 -> L1 -> L2
    expect(t.getState(PEER).level).toBe(2);
    offset = -J; // wall clock steps back an hour…
    t.getState(PEER); // …a UI poll lands during the trip…
    offset = 0; // …and NTP corrects it again
    expect(t.isIntakeDropped(PEER)).toBe(true); // still throttled (fails closed)
    offset = +J; // a forward step does not end it either
    expect(t.isIntakeDropped(PEER)).toBe(true);
  });

  test("monotonicWallClock ignores Date.now and never goes backwards", () => {
    const a = monotonicWallClock();
    offset = -J;
    const b = monotonicWallClock();
    expect(b).toBeGreaterThanOrEqual(a);
    expect(Math.abs(b - realDateNow())).toBeLessThan(J / 2); // still reads as epoch ms
  });
});

// ---------------------------------------------------------------------------
// TD-019 F3
// ---------------------------------------------------------------------------

describe("TD-019 F3: a dead session's stash never reaches the next session", () => {
  test("a CHANGES_BATCH stashed by session 1 (which then died) is not applied by session 2", async () => {
    const engine = createSyncEngine({
      db,
      selfDeviceId: SELF,
      mutateEntity: makeEntityMutator(),
      misbehavior: new PeerMisbehaviorTracker(DEFAULT_MISBEHAVIOR_CONFIG, () => T0),
      snapshots: true,
    });

    // Session 1: we pull from PEER; PEER answers with a FULL_STATE_OFFER that
    // we (lower id) accept; while we wait for its snapshot a CHANGES_BATCH
    // arrives (stashed as unrelated traffic), then the carrier dies.
    const s1 = scriptedTransport([
      { v: 1, type: "HELLO", device_clock: { [PEER]: 1 } as VectorClock },
      {
        v: 1,
        type: "FULL_STATE_OFFER",
        snapshot_clock: { [PEER]: 1 } as VectorClock,
        sender_device_id: PEER,
      },
      { v: 1, type: "CHANGES_BATCH", changes: [makeRecord(1)] },
      new Error("carrier died mid-session"),
    ]);
    await expect(engine.runSession(s1)).rejects.toThrow("carrier died");
    expect(s1.sent.some((m) => m.type === "FULL_STATE_ACCEPT")).toBe(true);
    expect(changeCount(PEER)).toBe(0); // stashed, never applied

    // Session 2 on the SAME engine: nothing to pull, peer ACKs, clean EOF.
    const s2 = scriptedTransport([
      { v: 1, type: "HELLO", device_clock: {} as VectorClock },
      { v: 1, type: "CHANGES_ACK", applied_upto: {} },
    ]);
    const stats2 = await engine.runSession(s2);
    expect(stats2.receivedApplied).toBe(0);
    expect(changeCount(PEER)).toBe(0); // session 1's stash did not leak
  });
});

// ---------------------------------------------------------------------------
// TD-019 F4
// ---------------------------------------------------------------------------

describe("TD-019 F4: FrameQueue single-waiter semantics are pinned", () => {
  test("the NEWEST pending receive gets the next frame; a superseded one stays pending", async () => {
    const [a, b] = await makeLocalDuplexPair();
    let firstSettled = false;
    const first = a.receive().then((m) => {
      firstSettled = true;
      return m;
    });
    void first;
    const second = a.receive(); // supersedes the first waiter
    const msg: SyncMessage = { v: 1, type: "HELLO", device_clock: { [PEER]: 7 } as VectorClock };
    await b.send(msg);
    expect(await second).toEqual(msg);
    await new Promise((r) => setImmediate(r));
    // The abandoned receive did NOT consume (and so lose) the frame.
    expect(firstSettled).toBe(false);
  });
});
