// TD-006 / DC-16 regression tests — two-tier peer misbehavior handling +
// minimal Paired Devices surface. Deterministic: injectable clocks in the
// tracker, fixed ids/seqs, no sleeps (transport polls resolve on queue
// emptiness like tests/regression_td001.test.ts).
import { describe, expect, test, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  openDatabase,
  countQuarantined,
  isHardBlocked,
  hardBlockProducer,
  unhardBlockProducer,
  listHardBlocks,
  listPeerInvalidTally,
  appendInvalidTally,
} from "../src/persistence/database.ts";
import {
  PeerMisbehaviorTracker,
  DEFAULT_MISBEHAVIOR_CONFIG,
  LADDER_LABELS,
  type MisbehaviorConfig,
} from "../src/sync/misbehavior.ts";
import {
  createSyncEngine,
  type SyncTransport,
  type SyncMessage,
  type SessionStats,
} from "../src/sync/sync_engine.ts";
import { makeEntityMutator } from "../src/persistence/bridges/sync_service.ts";
import {
  EventCore,
} from "../src/persistence/bridges/event_core.ts";
import {
  SyncManager,
  makeSyncDispatcher,
  handleLine,
  type Dispatcher,
} from "../src/persistence/bridges/sidecar_server.ts";
import { loadOrCreateIdentity } from "../src/network/sync_runtime.ts";
import {
  shapePeerStates,
  type PeerStateRow,
} from "../frontend/sync_errors.ts";
import {
  shapePairedDevices,
  unblockNextStep,
  unblockWarningText,
} from "../frontend/paired_devices.ts";
import type { ChangeRecord, VectorClock } from "../src/sync/change_record.ts";
import type { Database } from "better-sqlite3";

const T0 = Date.UTC(2026, 8, 1, 9, 0, 0);
const BAD = "d-bad";
const SELF = "d-self";

let dir: string;
let dbPath: string;
let db: Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tide-td006-"));
  dbPath = join(dir, "tide.db");
  db = openDatabase({ path: dbPath });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function makeRecord(seq: number, device = BAD): ChangeRecord {
  return {
    change_id: `${device}:${seq}`,
    device_id: device,
    local_seq: seq,
    entity_id: "evt-td006",
    entity_type: "event",
    field_path: "title",
    operation: "set",
    payload: { value: `v${seq}` },
    hlc_timestamp: T0 + seq,
    causality_clock: { [device]: seq },
    schema_version: 1,
  };
}

function invalidRecord(seq: number, device = BAD): ChangeRecord {
  return {
    ...makeRecord(seq, device),
    operation: "upsert" as never, // not in the operation enum
  } as ChangeRecord;
}

// Deterministic fake clock for tracker unit tests.
function fakeClock() {
  let now = T0;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

/** Fast config so engine tests can reach ladder levels with small batches. */
const FAST_CFG: MisbehaviorConfig = {
  ...DEFAULT_MISBEHAVIOR_CONFIG,
  tier1Count: 1,
  tier2Count: 10,
  throttleBaseMs: 30_000,
};

// ---------------------------------------------------------------------------
// Session harness (same pattern as regression_td001.test.ts)
// ---------------------------------------------------------------------------

function poll<T>(q: T[]): Promise<T | null> {
  return new Promise((resolve) => {
    let tries = 0;
    const check = () => {
      const v = q.shift();
      if (v !== undefined) resolve(v);
      else if (tries++ > 50) resolve(null);
      else setTimeout(check, 1);
    };
    check();
  });
}

function makeEngine(database: Database, tracker: PeerMisbehaviorTracker) {
  return createSyncEngine({
    db: database,
    selfDeviceId: SELF,
    mutateEntity: makeEntityMutator(),
    misbehavior: tracker,
  });
}

/** Run a receiver session pulling `batches` from BAD advertising `hi`. */
async function pullSession(
  database: Database,
  tracker: PeerMisbehaviorTracker,
  hi: number,
  batches: ChangeRecord[],
): Promise<SessionStats> {
  const inbox: SyncMessage[] = [
    { v: 1, type: "HELLO", device_clock: { [BAD]: hi } as VectorClock },
    { v: 1, type: "CHANGES_BATCH", changes: batches },
  ];
  const transport: SyncTransport = {
    async send() {},
    receive: () => poll(inbox),
  };
  return makeEngine(database, tracker).runSession(transport);
}

// ---------------------------------------------------------------------------
// Tier-1 ladder — threshold boundaries (DC-16 §2.4/D6: >500 AND >50%)
// ---------------------------------------------------------------------------

describe("TD-006 Tier 1 — threshold boundaries (default config)", () => {
  test("exactly 500 invalid (ratio 100%) stays at Level 0 — count must EXCEED 500", () => {
    const t = new PeerMisbehaviorTracker(DEFAULT_MISBEHAVIOR_CONFIG, fakeClock().now);
    for (let i = 0; i < 500; i++) t.recordInvalid(BAD);
    expect(t.getState(BAD).level).toBe(0);
  });

  test("501st invalid crosses the soft ceiling -> Level 1 warn (no throttling)", () => {
    const t = new PeerMisbehaviorTracker(DEFAULT_MISBEHAVIOR_CONFIG, fakeClock().now);
    for (let i = 0; i < 501; i++) t.recordInvalid(BAD);
    const s = t.getState(BAD);
    expect(s.level).toBe(1);
    expect(s.window_invalid).toBe(501);
    expect(t.isIntakeDropped(BAD)).toBe(false); // warn: no behavior change
  });

  test("ratio edge: 501 invalid / 1002 total (50.0%) stays; 502 crosses (>50%)", () => {
    const t = new PeerMisbehaviorTracker(DEFAULT_MISBEHAVIOR_CONFIG, fakeClock().now);
    for (let i = 0; i < 501; i++) t.recordOk(BAD);
    for (let i = 0; i < 501; i++) t.recordInvalid(BAD);
    expect(t.getState(BAD).level).toBe(0); // exactly 50% is NOT a breach
    t.recordInvalid(BAD); // 502/1003 = 50.05% > 50%
    expect(t.getState(BAD).level).toBe(1);
  });

  test("a mostly-valid peer (ratio <= 50%) NEVER escalates regardless of count", () => {
    const t = new PeerMisbehaviorTracker(DEFAULT_MISBEHAVIOR_CONFIG, fakeClock().now);
    for (let i = 0; i < 6000; i++) {
      t.recordOk(BAD);
      if (i % 20 === 0) t.recordInvalid(BAD); // ~5% invalid
    }
    expect(t.getState(BAD).level).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Tier-1 ladder — throttle / suspend / recovery / restart fail-open
// ---------------------------------------------------------------------------

describe("TD-006 Tier 1 — throttle, suspend, recovery (unit)", () => {
  test("Level 2 throttle: exponential backoff opens/closes the intake gate", () => {
    const clk = fakeClock();
    const t = new PeerMisbehaviorTracker(FAST_CFG, clk.now);
    // 3 invalids: 1st no breach (1 !> 1), 2nd -> L1, 3rd -> L2 with base backoff.
    t.recordInvalid(BAD);
    expect(t.getState(BAD).level).toBe(0);
    t.recordInvalid(BAD);
    expect(t.getState(BAD).level).toBe(1);
    t.recordInvalid(BAD);
    expect(t.getState(BAD).level).toBe(2);
    expect(t.isIntakeDropped(BAD)).toBe(true);
    expect(t.getState(BAD).backoff_until_ms).toBe(T0 + 30_000);
    // Backoff expiry re-opens intake; a further breach escalates to L3.
    clk.advance(30_001);
    expect(t.isIntakeDropped(BAD)).toBe(false);
    t.recordInvalid(BAD);
    expect(t.getState(BAD).level).toBe(3);
    expect(t.isIntakeDropped(BAD)).toBe(true); // suspend: session-scoped
  });

  test("throttle backoff respects the cap and resets on clean-window recovery", () => {
    const clk = fakeClock();
    const cfg: MisbehaviorConfig = {
      ...FAST_CFG,
      throttleBaseMs: 60_000,
      throttleCapMs: 90_000,
    };
    const t = new PeerMisbehaviorTracker(cfg, clk.now);
    for (let i = 0; i < 3; i++) t.recordInvalid(BAD); // -> L2, backoff = base
    expect(t.getState(BAD).backoff_until_ms).toBe(T0 + 60_000);
    expect(t.getState(BAD).backoff_until_ms).toBeLessThanOrEqual(T0 + cfg.throttleCapMs);
    // Clean window: full recovery resets the backoff to its base state.
    clk.advance(cfg.windowMs + 1);
    t.recordOk(BAD);
    expect(t.getState(BAD).level).toBe(0);
    expect(t.getState(BAD).backoff_until_ms).toBe(0);
    expect(t.isIntakeDropped(BAD)).toBe(false);
  });

  test("Level 3 sets the L4 RECOMMENDATION after a sustained window — never executes (D7)", () => {
    const clk = fakeClock();
    const t = new PeerMisbehaviorTracker(FAST_CFG, clk.now);
    for (let i = 0; i < 4; i++) t.recordInvalid(BAD); // -> L3
    expect(t.getState(BAD).level).toBe(3);
    expect(t.getState(BAD).recommend_unpair).toBe(false);
    clk.advance(DEFAULT_MISBEHAVIOR_CONFIG.windowMs + 1);
    t.recordInvalid(BAD); // re-evaluation with sustained L3
    expect(t.getState(BAD).recommend_unpair).toBe(true);
    // The recommendation is display-only: no unpair primitive exists here.
    expect(Object.keys(t.getState(BAD))).not.toContain("unpaired");
  });

  test("clean window auto-recovers to Level 0 (de-escalation is faster)", () => {
    const clk = fakeClock();
    const t = new PeerMisbehaviorTracker(FAST_CFG, clk.now);
    for (let i = 0; i < 4; i++) t.recordInvalid(BAD); // -> L3
    clk.advance(FAST_CFG.windowMs + 1);
    t.recordOk(BAD); // clean window: all invalids aged out
    const s = t.getState(BAD);
    expect(s.level).toBe(0);
    expect(s.recommend_unpair).toBe(false);
    expect(t.isIntakeDropped(BAD)).toBe(false);
  });

  test("restart clears Tier-1 state (in-memory fails OPEN, DC-16 §2.3)", () => {
    const t = new PeerMisbehaviorTracker(FAST_CFG, fakeClock().now);
    for (let i = 0; i < 10; i++) t.recordInvalid(BAD); // deep into the ladder
    expect(t.getState(BAD).level).toBe(3);
    // "Restart": a fresh process constructs a fresh tracker — no bookkeeping.
    const fresh = new PeerMisbehaviorTracker(FAST_CFG, fakeClock().now);
    expect(fresh.knownPeers()).toEqual([]);
    expect(fresh.isIntakeDropped(BAD)).toBe(false);
    expect(fresh.getState(BAD).level).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Tier 2 — durable hard block
// ---------------------------------------------------------------------------

describe("TD-006 Tier 2 — hard block (>5,000 per 10-min window, ratio-independent)", () => {
  test("boundary: exactly 5,000 does NOT block; 5,001st event blocks mid-burst", () => {
    const blocked: string[] = [];
    const t = new PeerMisbehaviorTracker(
      { ...FAST_CFG, tier2Count: 5000 },
      fakeClock().now,
      (p) => blocked.push(p),
    );
    for (let i = 0; i < 5000; i++) t.recordInvalid(BAD);
    expect(blocked).toEqual([]);
    t.recordInvalid(BAD); // 5001st ARRIVAL — evaluated immediately
    expect(blocked).toEqual([BAD]);
    // Ratio-independence: 5001 invalid + 5000 ok still blocks (count alone).
    const t2 = new PeerMisbehaviorTracker(
      { ...FAST_CFG, tier2Count: 5000 },
      fakeClock().now,
      (p) => blocked.push(p),
    );
    for (let i = 0; i < 5001; i++) {
      t2.recordOk(BAD);
      t2.recordInvalid(BAD);
    }
    expect(blocked).toContain(BAD);
  });

  test("throttled-drop arrivals feed the flood window (burst trips mid-burst)", () => {
    const blocked: string[] = [];
    const clk = fakeClock();
    const t = new PeerMisbehaviorTracker(
      { ...FAST_CFG, tier2Count: 10 },
      clk.now,
      (p) => blocked.push(p),
    );
    for (let i = 0; i < 3; i++) t.recordInvalid(BAD); // -> L2 throttle
    expect(t.getState(BAD).level).toBe(2);
    // While throttled the engine drops at intake and reports drops here;
    // those arrivals keep counting toward the Tier-2 flood window.
    for (let i = 0; i < 7; i++) t.recordDropped(BAD);
    expect(blocked).toEqual([]); // 3 invalid + 7 dropped = 10: NOT > 10 yet
    t.recordDropped(BAD); // 11th arrival — evaluated immediately, trips
    expect(blocked).toEqual([BAD]);
  });

  test("hard block is durable: survives restart, removed ONLY by explicit Unblock", async () => {
    hardBlockProducer(db, BAD);
    expect(isHardBlocked(db, BAD)).toBe(true);
    // "Restart": fresh engine over the SAME database — still blocked.
    const tracker = new PeerMisbehaviorTracker(FAST_CFG, fakeClock().now);
    const stats = await pullSession(db, tracker, 3, [
      invalidRecord(1),
      invalidRecord(2),
      invalidRecord(3),
    ]);
    // Intake dropped everything BEFORE validation/parsing: no quarantine
    // rows, no skip entries, no changes — bounded storage, near-zero cost.
    expect(countQuarantined(db)).toBe(0);
    expect(stats.receivedQuarantined).toBe(0);
    expect(
      (db.prepare("SELECT COUNT(*) c FROM changes").get() as { c: number }).c,
    ).toBe(0);
    const rows = listHardBlocks(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.producer_device_id).toBe(BAD);
    expect(rows[0]!.trigger_count).toBe(1);
    // Re-trigger updates last_triggered_at + increments trigger_count,
    // preserving first_triggered_at (§4.2 "why/when blocked").
    const first = rows[0]!.first_triggered_at;
    hardBlockProducer(db, BAD);
    const again = listHardBlocks(db)[0]!;
    expect(again.first_triggered_at).toBe(first);
    expect(again.trigger_count).toBe(2);
    // Explicit user Unblock clears it; returns true only when a row existed.
    expect(unhardBlockProducer(db, BAD)).toBe(true);
    expect(isHardBlocked(db, BAD)).toBe(false);
    expect(unhardBlockProducer(db, BAD)).toBe(false);
  });

  test("durable tally (§2.3) informs history but never triggers blocking", async () => {
    const tracker = new PeerMisbehaviorTracker(
      { ...FAST_CFG, tier2Count: 1_000_000 },
      fakeClock().now,
    );
    // 3 invalids: below tier1Count(2)? no — 3 > 2, but assert only the tally.
    await pullSession(db, tracker, 3, [
      invalidRecord(1),
      invalidRecord(2),
      invalidRecord(3),
    ]);
    const tally = listPeerInvalidTally(db);
    expect(tally).toHaveLength(1);
    expect(tally[0]!.producer_device_id).toBe(BAD);
    expect(tally[0]!.total_invalid).toBe(3);
    expect(isHardBlocked(db, BAD)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Engine integration — quarantine feed, throttle intake semantics, exemption
// ---------------------------------------------------------------------------

describe("TD-006 engine integration", () => {
  test("throttle intake-drop semantics: no quarantine rows/skips, one aggregated counter, requests still answered", async () => {
    const tracker = new PeerMisbehaviorTracker(FAST_CFG, Date.now);
    // 20 invalid records: L2 trips at the 3rd breach evaluation; the rest
    // are dropped at intake (FAST tier1Count=2: 3rd invalid -> L2).
    const stats = await pullSession(
      db,
      tracker,
      20,
      Array.from({ length: 20 }, (_, i) => invalidRecord(i + 1)),
    );
    expect(tracker.getState(BAD).level).toBe(2);
    // Throttle semantics: dropped records produce NO quarantine rows and NO
    // skip entries (they never reach validation), and the aggregated drop
    // counter is visible in stats + tracker state. The same burst then trips
    // the Tier-2 hard block mid-burst (3 invalid + 8 dropped > tier2Count
    // 10): the remaining 9 arrivals are hard-dropped BEFORE this counter.
    const quarantined = countQuarantined(db);
    expect(quarantined).toBe(3); // only pre-throttle rejections
    expect(stats.receivedDroppedIntake).toBe(8); // 4th..11th arrival
    expect(tracker.getState(BAD).dropped_while_throttled).toBe(
      stats.receivedDroppedIntake,
    );
    expect(isHardBlocked(db, BAD)).toBe(true); // tripped mid-burst, on arrival
    expect(
      (db.prepare("SELECT COUNT(*) c FROM skipped_seqs").get() as { c: number }).c,
    ).toBe(quarantined);

    // Requests FROM the throttled peer are still answered (receive-side
    // only): the peer asks for SELF's ranges and gets a CHANGES_BATCH.
    const inbox: SyncMessage[] = [
      { v: 1, type: "HELLO", device_clock: { [BAD]: 1 } as VectorClock },
      {
        v: 1,
        type: "CHANGES_REQUEST",
        ranges: [{ device_id: SELF, lo: 1, hi: 5 }],
      },
    ];
    const sent: SyncMessage[] = [];
    const transport: SyncTransport = {
      async send(msg) {
        sent.push(msg);
      },
      receive: () => poll(inbox),
    };
    await makeEngine(db, tracker).runSession(transport);
    expect(
      sent.some((m) => m.type === "CHANGES_BATCH"),
    ).toBe(true);
  });

  test("suspension (Level 3) drops intake for the session; a restart (fresh tracker) re-opens it", async () => {
    // Pre-arm the tracker to Level 3 with a deterministic fake clock (the
    // engine path only CONSUMES the gate; escalation timings are unit-tested
    // above without real-time dependence).
    const clk = fakeClock();
    const tracker = new PeerMisbehaviorTracker(FAST_CFG, clk.now);
    for (let i = 0; i < 4; i++) tracker.recordInvalid(BAD); // -> L3
    expect(tracker.isIntakeDropped(BAD)).toBe(true);
    // While suspended: valid records from BAD are dropped at intake.
    const stats = await pullSession(db, tracker, 2, [
      makeRecord(1),
      makeRecord(2),
    ]);
    expect(stats.receivedApplied).toBe(0);
    expect(stats.receivedDroppedIntake).toBe(2);
    expect(countQuarantined(db)).toBe(0);
    // Requests from the suspended peer would still be answered (tested in
    // the throttle test; suspension is receive-side only too).
    // Restart: fresh tracker (in-memory) -> fails OPEN, records apply again.
    const fresh = new PeerMisbehaviorTracker(FAST_CFG, Date.now);
    expect(fresh.isIntakeDropped(BAD)).toBe(false);
    const s2 = await pullSession(db, fresh, 4, [makeRecord(1), makeRecord(2)]);
    expect(s2.receivedApplied).toBe(2);
  });

  test("hard block trips mid-burst from ANY ladder level and instantly closes intake", async () => {
    const tracker = new PeerMisbehaviorTracker(FAST_CFG, Date.now);
    // FAST tier2Count=10: 11 arrivals from BAD (any mix) trip the durable block.
    await pullSession(
      db,
      tracker,
      12,
      Array.from({ length: 12 }, (_, i) => invalidRecord(i + 1)),
    );
    expect(isHardBlocked(db, BAD)).toBe(true);
    expect(tracker.getState(BAD).dropped_while_throttled).toBeGreaterThan(0);
    // Subsequent batches — even VALID records — are dropped before parsing.
    const s2 = await pullSession(db, tracker, 15, [
      makeRecord(13),
      makeRecord(14),
    ]);
    expect(s2.receivedApplied).toBe(0);
    expect(s2.receivedDroppedIntake).toBe(0); // hard-block drop: not counted
  });

  test("DC-16 §2.5 exemption: FULL_STATE_SNAPSHOT traffic never feeds either tier", async () => {
    const tracker = new PeerMisbehaviorTracker(FAST_CFG, Date.now);
    // 6,000 snapshot entities (the one legitimately high-volume transfer)
    // delivered from BAD: ladder stays at Level 0, no hard block, no tally.
    const entities = Array.from({ length: 6000 }, (_, i) => ({
      entity_id: `cal-${i}`,
      entity_type: "calendar" as const,
      data: JSON.stringify({
        calendar_id: `cal-${i}`,
        title: `c${i}`,
        color: null,
        created_hlc: T0 + i,
        updated_hlc: T0 + i,
      }),
      producer_device_id: BAD,
      producer_seq: i + 1,
      causality_clock: { [BAD]: i + 1 },
    }));
    const inbox: SyncMessage[] = [
      { v: 1, type: "HELLO", device_clock: {} as VectorClock },
      {
        v: 1,
        type: "FULL_STATE_SNAPSHOT",
        snapshot_clock: { [BAD]: 6000 } as VectorClock,
        entities,
        final: true,
      },
    ];
    const transport: SyncTransport = {
      async send() {},
      receive: () => poll(inbox),
    };
    await makeEngine(db, tracker).runSession(transport);
    const st = tracker.getState(BAD);
    expect(st.level).toBe(0);
    expect(st.window_total).toBe(0); // no ladder feed of any kind
    expect(countQuarantined(db)).toBe(0);
    expect(isHardBlocked(db, BAD)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// RPC ops + Paired Devices surface
// ---------------------------------------------------------------------------

describe("TD-006 dispatcher ops (peer_state / reset / unblock / list_paired_devices)", () => {
  function makeManager(): {
    core: EventCore;
    sync: SyncManager;
    dispatch: Dispatcher;
  } {
    const core = new EventCore(join(dir, "core.db"), SELF);
    const identity = loadOrCreateIdentity(dir);
    const sync = new SyncManager(core, identity, dir);
    return { core, sync, dispatch: makeSyncDispatcher(sync, core) };
  }

  function seedPeer(database: Database): void {
    database
      .prepare(
        `INSERT INTO peers (device_id, public_key, display_name, paired_at, status)
         VALUES (?, ?, ?, ?, 'trusted')`,
      )
      .run(BAD, Buffer.alloc(32, 7), "Laptop", 1700000000);
  }

  test("unblock_peer clears the durable row and returns the peer to Level 0", () => {
    const { core, sync, dispatch } = makeManager();
    hardBlockProducer(core.db, BAD);
    for (let i = 0; i < 501; i++) sync.misbehavior.recordInvalid(BAD); // > soft ceiling
    expect(sync.misbehavior.getState(BAD).level).toBeGreaterThan(0);

    // Two-step confirmation lives in the UI; the op executes the explicit action.
    const res = dispatch("unblock_peer", { device_id: BAD }) as {
      ok: boolean;
      cleared: boolean;
    };
    expect(res.ok).toBe(true);
    expect(res.cleared).toBe(true);
    expect(isHardBlocked(core.db, BAD)).toBe(false);
    expect(sync.misbehavior.getState(BAD).level).toBe(0); // §4.2: back to L0
    // Unblocking a non-blocked peer reports cleared=false (honest).
    expect((dispatch("unblock_peer", { device_id: BAD }) as { cleared: boolean }).cleared).toBe(false);
    // device_id is required.
    expect(() => dispatch("unblock_peer", {})).toThrow();
  });

  test("reset_peer_state clears Tier-1 bookkeeping in one click (§4.2)", () => {
    const { sync, dispatch } = makeManager();
    for (let i = 0; i < 501; i++) sync.misbehavior.recordInvalid(BAD); // > soft ceiling
    expect(sync.misbehavior.getState(BAD).level).toBe(1);
    dispatch("reset_peer_state", { device_id: BAD });
    expect(sync.misbehavior.getState(BAD).level).toBe(0);
    expect(() => dispatch("reset_peer_state", {})).toThrow();
  });

  test("peer_state + list_paired_devices expose ladder level, hard block, tally", async () => {
    const { core, sync, dispatch } = makeManager();
    seedPeer(core.db);
    hardBlockProducer(core.db, BAD);
    sync.misbehavior.recordInvalid(BAD); // live ladder bookkeeping (no tally)
    appendInvalidTally(core.db, BAD); // §2.3 durable tally (engine appends this)

    const line = JSON.parse(
      await handleLine(
        dispatch,
        JSON.stringify({ id: 9, op: "list_paired_devices", args: {} }),
      ),
    );
    expect(line.ok).toBe(true);
    const devices = line.result.devices as PeerStateRow[];
    expect(devices).toHaveLength(1);
    expect(devices[0]!.device_id).toBe(BAD);
    expect(devices[0]!.display_name).toBe("Laptop");
    expect(devices[0]!.paired).toBe(true);
    expect(devices[0]!.hard_block).not.toBeNull();
    expect(devices[0]!.hard_block!.trigger_count).toBe(1);
    expect(devices[0]!.tally!.total_invalid).toBe(1);
    expect(devices[0]!.ladder_label).toBe(LADDER_LABELS[0]);

    const peers = (dispatch("peer_state", {}) as { peers: PeerStateRow[] }).peers;
    expect(peers).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// UI pure layers
// ---------------------------------------------------------------------------

describe("TD-006 UI shaping (pure layers)", () => {
  const row: PeerStateRow = {
    device_id: "x519deadbeef0123456789",
    level: 2,
    recommend_unpair: false,
    window_invalid: 700,
    window_total: 900,
    window_ratio: 700 / 900,
    dropped_while_throttled: 1234,
    paired: true,
    display_name: null,
    paired_at: 1700000000000,
    ladder_label: "throttle",
    hard_block: null,
    tally: { total_invalid: 4321, last_invalid_at: T0 },
  };

  test("Sync-Errors per-peer state: Level 0 peers are silent, notable peers show verbatim numbers", () => {
    const [view] = shapePeerStates([row]);
    expect(view!.notable).toBe(true);
    expect(view!.display).toBe("x519deadbeef0123…"); // truncated id
    expect(view!.summary).toContain("level 2 (throttle)");
    expect(view!.summary).toContain("700 invalid / 900 received (78%)");
    expect(view!.summary).toContain("1234 dropped while throttled");
    const [quiet] = shapePeerStates([
      { ...row, level: 0, ladder_label: "observe" },
    ]);
    expect(quiet!.notable).toBe(false); // §4.1: Level 0 adds nothing
    const [hard] = shapePeerStates([
      {
        ...row,
        level: 0,
        ladder_label: "observe",
        hard_block: {
          first_triggered_at: T0,
          last_triggered_at: T0,
          trigger_count: 2,
        },
      },
    ]);
    expect(hard!.notable).toBe(true);
    expect(hard!.summary).toContain("HARD BLOCKED");
    expect(hard!.recommend_unpair).toBe(false);
  });

  test("Paired Devices shaping + two-step Unblock confirmation (§4.2)", () => {
    const devices = shapePairedDevices([
      {
        ...row,
        hard_block: {
          first_triggered_at: T0,
          last_triggered_at: T0,
          trigger_count: 2,
        },
      },
    ]);
    const v = devices[0]!;
    // Redesign 2026-08-27: unlabeled devices now show the truncated id
    // (honest) instead of a generic invented placeholder.
    expect(v.display).toBe("x519deadbeef0123…");
    expect(v.truncated_id).toBe("x519deadbeef0123…");
    expect(v.hard_blocked).toBe(true);
    expect(v.hard_block_summary).toContain("2 trigger(s)");
    // Two-step confirm state machine: idle -> confirm -> execute.
    expect(unblockNextStep("idle")).toBe("confirm");
    expect(unblockNextStep("confirm")).toBe("execute");
    expect(unblockNextStep("execute")).toBe("idle");
    // §4.2 text states why + when + the re-exposure warning.
    const warn = unblockWarningText(v);
    expect(warn).toContain("flood of invalid sync records");
    expect(warn).toContain(new Date(T0).toISOString());
    expect(warn).toContain("re-exposes");
  });
});
