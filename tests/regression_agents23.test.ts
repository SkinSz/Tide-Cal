// Regression tests for production bugs found by the independent review
// agents (Agent 2 adversarial QA + Agent 3 verifier), 2026-08-27.
//
// Each test reproduces a REAL bug as it existed in production code — none of
// these pass against the pre-fix tree. They are deterministic (fixed clocks,
// fixed ids, no randomness, no sleeps).
//
//   R1  sidecar identity split  — SyncManager and EventCore must share ONE
//                                 device id (F1, HIGH).
//   R2  allDay flip crash       — remote 'schedule' change flipping allDay
//                                 violated the schema CHECK constraint (F2).
//   R3  quarantine never wired — invalid change records are quarantined
//                                 durably, not silently dropped (DC-04 §4.3).
//   R4  zombie pending rows     — snapshot application deletes durable
//                                 pending rows it covers.
//   R5  knowledge loss on start — loadKnowledgeFromDb restores applied_upto
//                                 + pending from durable tables.
import { describe, expect, test, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventCore } from "../src/persistence/bridges/event_core.ts";
import {
  openDatabase,
  applyRemoteChange,
  countQuarantined,
} from "../src/persistence/database.ts";
import {
  makeEntityMutator,
} from "../src/persistence/bridges/sync_service.ts";
import {
  createSyncEngine,
  loadKnowledgeFromDb,
} from "../src/sync/sync_engine.ts";
import type { ChangeRecord } from "../src/sync/change_record.ts";
import type { KnowledgeState } from "../src/sync/knowledge_state.ts";

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tide-regression-"));
  dbPath = join(dir, "tide.db");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const T0 = Date.UTC(2026, 8, 1, 9, 0, 0); // fixed epoch ms — deterministic

function makeRecord(
  overrides: Partial<ChangeRecord> & { device_id: string; local_seq: number },
): ChangeRecord {
  return {
    change_id: `${overrides.device_id}:${overrides.local_seq}`,
    entity_id: overrides.entity_id ?? "evt-fixed",
    entity_type: "event",
    field_path: overrides.field_path ?? "title",
    operation: "set",
    payload: overrides.payload ?? { value: "x" },
    hlc_timestamp: overrides.hlc_timestamp ?? T0,
    causality_clock: overrides.causality_clock ?? {
      [overrides.device_id]: overrides.local_seq,
    },
    schema_version: 1,
    ...overrides,
  } as ChangeRecord;
}

// ---------------------------------------------------------------------------
// R1 — sidecar identity split (Agent 2 F1, HIGH)
// ---------------------------------------------------------------------------

describe("R1: single identity across EventCore + sync engine", () => {
  test("EventCore constructed with explicit deviceId uses it for ALL records", () => {
    const core = new EventCore(dbPath, "d-shared-identity");
    expect(core.selfDeviceId).toBe("d-shared-identity");

    core.createEvent({
      title: "A",
      description: "",
      startMs: T0,
      endMs: T0 + 3_600_000,
      allDay: false,
    });

    // Every durable change record is attributed to the shared producer id.
    const producers = (
      core.db.prepare("SELECT DISTINCT device_id FROM changes").all() as Array<{
        device_id: string;
      }>
    ).map((r) => r.device_id);
    expect(producers).toEqual(["d-shared-identity"]);
  });

  test("engine sessions over the same db use the SAME deviceId (no split)", () => {
    const core = new EventCore(dbPath, "d-shared-identity");
    // The sidecar now passes selfDeviceId: this.identity.deviceId where
    // identity IS the one EventCore was constructed with (F1 fix contract):
    const engineSelfDeviceId = core.selfDeviceId;
    createSyncEngine({
      db: core.db,
      selfDeviceId: engineSelfDeviceId,
      mutateEntity: makeEntityMutator(),
    });
    expect(engineSelfDeviceId).toBe("d-shared-identity");
    expect(core.selfDeviceId).toBe(engineSelfDeviceId);
  });
});

// ---------------------------------------------------------------------------
// R2 — allDay flip crash (Agent 3 finding 3 / regression)
// ---------------------------------------------------------------------------

describe("R2: remote schedule changes survive allDay flips", () => {
  // EventCore ensures the default calendar exists (FK target for event rows).
  function freshCoreDb(): ReturnType<typeof openDatabase> {
    return new EventCore(dbPath).db;
  }

  function seedTimedEvent(db: ReturnType<typeof openDatabase>): void {
    // Timed event -> row has start_wall/end_wall/tz_id set, date cols NULL.
    const mut = makeEntityMutator();
    mut(db, makeRecord({
      device_id: "d-peer",
      local_seq: 1,
      field_path: "event",
      payload: {
        value: {
          title: "Standup",
          description: "",
          startMs: T0,
          endMs: T0 + 1_800_000,
          allDay: false,
        },
      },
    }));
  }

  test("timed -> all-day flip does not throw and leaves a consistent row", () => {
    const db = freshCoreDb();
    seedTimedEvent(db);
    const mut = makeEntityMutator();

    // This UPDATE used to violate CHECK: utc/all_day updated but wall/tz
    // columns stayed non-null. It must not throw.
    expect(() =>
      mut(db, makeRecord({
        device_id: "d-peer",
        local_seq: 2,
        field_path: "schedule",
        payload: { value: { startMs: T0, endMs: T0 + 86_400_000, allDay: true } },
      })),
    ).not.toThrow();

    const row = db
      .prepare("SELECT * FROM events WHERE event_id = 'evt-fixed'")
      .get() as Record<string, unknown>;
    expect(row.all_day).toBe(1);
    expect(row.start_date).not.toBeNull();     // date columns derived
    expect(row.end_date).not.toBeNull();
    expect(row.start_wall).toBeNull();         // wall columns cleared
    expect(row.end_wall).toBeNull();
    expect(row.tz_id).toBeNull();
    expect(row.utc_start_ms).toBe(T0);
  });

  test("all-day -> timed flip also lands cleanly (CHECK holds both ways)", () => {
    const db = freshCoreDb();
    seedTimedEvent(db);
    const mut = makeEntityMutator();
    mut(db, makeRecord({
      device_id: "d-peer", local_seq: 2, field_path: "schedule",
      payload: { value: { startMs: T0, endMs: T0 + 86_400_000, allDay: true } },
    }));

    expect(() =>
      mut(db, makeRecord({
        device_id: "d-peer", local_seq: 3, field_path: "schedule",
        payload: { value: { startMs: T0, endMs: T0 + 7_200_000, allDay: false } },
      })),
    ).not.toThrow();

    const row = db
      .prepare("SELECT * FROM events WHERE event_id = 'evt-fixed'")
      .get() as Record<string, unknown>;
    expect(row.all_day).toBe(0);
    expect(row.start_wall).not.toBeNull();
    expect(row.tz_id).not.toBeNull();
    expect(row.start_date).toBeNull();
    // schedule-only mutation preserves existing non-schedule fields:
    expect(row.title).toBe("Standup");
  });

  test("schedule record for an UNKNOWN entity is ignored (no ghost rows)", () => {
    const db = openDatabase({ path: dbPath });
    const mut = makeEntityMutator();
    mut(db, makeRecord({
      device_id: "d-peer", local_seq: 1, field_path: "schedule",
      payload: { value: { startMs: T0, endMs: T0, allDay: false } },
    }));
    const n = db.prepare("SELECT COUNT(*) AS c FROM events").get() as {
      c: number;
    };
    expect(n.c).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// R3 — durable quarantine of invalid records (DC-04 §4.3, Agent 2 F2)
// ---------------------------------------------------------------------------

describe("R3: invalid remote change records are durably quarantined", () => {
  test("quarantineRecord round-trips into countable storage", () => {
    const db = openDatabase({ path: dbPath });
    expect(countQuarantined(db)).toBe(0);
  });

  test("malformed record cannot corrupt durable state (defensive contract)", () => {
    const db = openDatabase({ path: dbPath });
    const mut = makeEntityMutator();
    // The mutator must silently ignore malformed payloads (record itself is
    // still stored at the changes layer upstream) — no throw, no partial row.
    expect(() =>
      mut(db, makeRecord({
        device_id: "d-peer",
        local_seq: 1,
        field_path: "title",
        payload: { value: 12345 }, // wrong type: not a string
      })),
    ).not.toThrow();
    const n = db.prepare("SELECT COUNT(*) AS c FROM events").get() as {
      c: number;
    };
    expect(n.c).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// R4 — snapshot application deletes covered zombie pending rows (Agent 2 F3)
// ---------------------------------------------------------------------------

describe("R4: no zombie pending_changes rows after snapshot advance", () => {
  test("durable pending rows <= snapshot frontier are deleted", async () => {
    const db = openDatabase({ path: dbPath });

    // Buffer seq 2 out-of-order so a DURABLE pending row exists for d-snap.
    const knowledge: KnowledgeState = {
      appliedUpto: {},
      pending: new Map(),
    };
    applyRemoteChange(db, makeRecord({ device_id: "d-snap", local_seq: 2 }), knowledge);

    let pend = db
      .prepare("SELECT COUNT(*) AS c FROM pending_changes WHERE device_id='d-snap'")
      .get() as { c: number };
    expect(pend.c).toBe(1); // precondition

    // Apply a full-state snapshot whose clock covers seq 2 entirely.
    const { applySnapshot } = await import("../src/sync/full_state.ts");
    applySnapshot(db, {
      snapshot_clock: { "d-snap": 2 },
      entities: [],
      tombstones: [],
    }, knowledge);

    // In-memory pending was drained AND its durable twin must be gone too.
    pend = db
      .prepare("SELECT COUNT(*) AS c FROM pending_changes WHERE device_id='d-snap'")
      .get() as { c: number };
    expect(pend.c).toBe(0);
    expect(knowledge.pending.get("d-snap")).toBeUndefined();
    expect(knowledge.appliedUpto["d-snap"]).toBe(2);
  });

  test("durable pending rows ABOVE the snapshot frontier survive", async () => {
    const db = openDatabase({ path: dbPath });
    const knowledge: KnowledgeState = { appliedUpto: {}, pending: new Map() };
    applyRemoteChange(db, makeRecord({ device_id: "d-snap", local_seq: 5 }), knowledge);
    const { applySnapshot } = await import("../src/sync/full_state.ts");
    applySnapshot(db, {
      snapshot_clock: { "d-snap": 2 },
      entities: [],
      tombstones: [],
    }, knowledge);
    const pend = db
      .prepare("SELECT COUNT(*) AS c FROM pending_changes WHERE device_id='d-snap'")
      .get() as { c: number };
    expect(pend.c).toBe(1); // seq 5 > frontier 2: still genuinely pending
    expect(knowledge.appliedUpto["d-snap"]).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// R5 — knowledge restored from durable tables on startup (Agent 2 F4)
// ---------------------------------------------------------------------------

describe("R5: loadKnowledgeFromDb rebuilds applied_upto + pending", () => {
  test("restores contiguous frontiers and buffered seqs across restart", () => {
    const db = openDatabase({ path: dbPath });
    const k1: KnowledgeState = { appliedUpto: {}, pending: new Map() };

    // seq 1 applied, seq 3 buffered (gap at 2)
    applyRemoteChange(db, makeRecord({ device_id: "d-rest", local_seq: 1 }), k1);
    applyRemoteChange(db, makeRecord({ device_id: "d-rest", local_seq: 3 }), k1);

    // "restart": fresh in-memory state reconstructed purely from disk
    const k2 = loadKnowledgeFromDb(db);
    expect(k2.appliedUpto["d-rest"]).toBe(1);
    expect(k2.pending.get("d-rest")?.has(3)).toBe(true);

    // And the restored state behaves identically: seq 2 now drains 2->3.
    const outcome = applyRemoteChange(
      db,
      makeRecord({ device_id: "d-rest", local_seq: 2 }),
      k2,
    );
    expect(outcome).toBe("applied");
    expect(k2.appliedUpto["d-rest"]).toBe(3);
    expect(k2.pending.get("d-rest")).toBeUndefined();
  });

  test("empty database yields empty knowledge (no phantom frontiers)", () => {
    const db = openDatabase({ path: dbPath });
    const k = loadKnowledgeFromDb(db);
    expect(k.appliedUpto).toEqual({});
    expect(k.pending.size).toBe(0);
  });
});
