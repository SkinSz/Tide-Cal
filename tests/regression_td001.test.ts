// TD-001 Phase 2 regression tests — quarantine-and-skip (owner-approved
// design: docs/proposals/TD-001-quarantine-sequence-gap-design.md §3).
//
// All 9 required regression tests, deterministic (fixed clocks, ids, no
// sleeps beyond the transport poll tick). None of these pass against the
// pre-fix tree except where noted as baseline contracts.
import { describe, expect, test, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  openDatabase,
  applyRemoteChange,
  countQuarantined,
  quarantineRecord,
  markSeqSkipped,
  isSeqSkipped,
  listSkippedSeqs,
  listQuarantine,
} from "../src/persistence/database.ts";
import { makeEntityMutator } from "../src/persistence/bridges/sync_service.ts";
import {
  createSyncEngine,
  loadKnowledgeFromDb,
  revalidateQuarantine,
  type SyncTransport,
  type SyncMessage,
  type SessionStats,
} from "../src/sync/sync_engine.ts";
import { applySnapshot } from "../src/sync/full_state.ts";
import {
  neededRanges,
  emptyKnowledge,
  type KnowledgeState,
} from "../src/sync/knowledge_state.ts";
import type { ChangeRecord, VectorClock } from "../src/sync/change_record.ts";
import type { Database } from "better-sqlite3";

const T0 = Date.UTC(2026, 8, 1, 9, 0, 0); // fixed epoch ms — deterministic
const PRODUCER = "d-bad";

let dir: string;
let dbPath: string;
let db: Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tide-td001-"));
  dbPath = join(dir, "tide.db");
  db = openDatabase({ path: dbPath });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function makeRecord(
  overrides: { local_seq: number; device_id?: string } &
    Partial<Omit<ChangeRecord, "local_seq" | "device_id">>,
): ChangeRecord {
  const device = overrides.device_id ?? PRODUCER;
  const seq = overrides.local_seq;
  const base: ChangeRecord = {
    change_id: `${device}:${seq}`,
    device_id: device,
    local_seq: seq,
    entity_id: "evt-td001",
    entity_type: "event",
    field_path: "title",
    operation: "set",
    payload: { value: `v${seq}` },
    hlc_timestamp: T0 + seq,
    causality_clock: { [device]: seq },
    schema_version: 1,
  };
  return { ...base, ...overrides } as ChangeRecord;
}

/** An invalid record: bad operation (DC-01 violation), otherwise shaped. */
function invalidRecord(seq: number): ChangeRecord {
  return {
    ...makeRecord({ local_seq: seq }),
    operation: "upsert" as never, // not in the operation enum
  } as ChangeRecord;
}

// ---------------------------------------------------------------------------
// Session harness: a scripted peer so the RECEIVER engine's applyBatch
// (quarantine site) is exercised through the real protocol path.
// ---------------------------------------------------------------------------

function poll<T>(q: T[]): Promise<T | null> {
  // Bounded: resolve null after ~50ms of queue emptiness so a session that
  // is done pulling finishes deterministically instead of hanging.
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

function scriptedPeer(
  clock: VectorClock,
  batches: ChangeRecord[],
): { transport: SyncTransport; inbox: SyncMessage[] } {
  const inbox: SyncMessage[] = [];
  const transport: SyncTransport = {
    async send() {}, // messages TO the peer (requests/acks) are ignored
    receive: () => poll(inbox),
  };
  // Pre-load the peer's scripted responses: HELLO, then the batch the peer
  // will serve for the engine's CHANGES_REQUEST.
  inbox.push({ v: 1, type: "HELLO", device_clock: clock });
  inbox.push({ v: 1, type: "CHANGES_BATCH", changes: batches });
  return { transport, inbox };
}

/** Run one receiver session pulling `batches` from a peer at `clock`. */
async function runReceiverSession(
  database: Database,
  clock: VectorClock,
  batches: ChangeRecord[],
): Promise<SessionStats> {
  const { transport } = scriptedPeer(clock, batches);
  const engine = createSyncEngine({
    db: database,
    selfDeviceId: "d-self",
    mutateEntity: makeEntityMutator(),
  });
  return engine.runSession(transport);
}

function changesCount(database: Database): number {
  return (
    database.prepare("SELECT COUNT(*) c FROM changes").get() as { c: number }
  ).c;
}
function pendingCount(database: Database): number {
  return (
    database.prepare("SELECT COUNT(*) c FROM pending_changes").get() as {
      c: number;
    }
  ).c;
}
function appliedUpto(database: Database, d: string): number {
  return (
    (
      database
        .prepare(
          "SELECT applied_through a FROM applied_upto WHERE producer_device_id = ?",
        )
        .get(d) as { a: number } | undefined
    )?.a ?? 0
  );
}

// ---------------------------------------------------------------------------
// TD-001 §3 test 1 — quarantine of N: one row, correct reason, verbatim
// raw_record; semantic state untouched (apart from clock merge upstream).
// ---------------------------------------------------------------------------

describe("TD-001 §3.1 quarantine of N", () => {
  test("exactly one quarantine row, verbatim raw_record, no state change", async () => {
    const bad = invalidRecord(1);
    const stats = await runReceiverSession(db, { [PRODUCER]: 1 }, [bad]);

    expect(countQuarantined(db)).toBe(1);
    expect(countQuarantined(db, "invalid_change_record:")).toBe(0); // prefix, not exact
    const row = listQuarantine(db)[0]!;
    expect(row.quarantine_reason.startsWith("invalid_change_record:")).toBe(true);
    // DC-04 TR-7: raw record stored VERBATIM.
    expect(JSON.parse(row.raw_record)).toEqual(bad);
    expect(row.sender_device_id).toBe("d-self");
    // No semantic state: nothing applied, nothing buffered.
    expect(changesCount(db)).toBe(0);
    expect(pendingCount(db)).toBe(0);
    expect(appliedUpto(db, PRODUCER)).toBe(0);
    expect(stats.receivedQuarantined).toBe(1);
    expect(stats.receivedApplied).toBe(0);
    // TD-001: the seq is marked skipped (resolved-for-progress).
    expect(isSeqSkipped(db, PRODUCER, 1)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// TD-001 §3.2 — valid N+1 APPLIES after N is quarantined; pending drains;
// no unbounded growth over a follow-up batch.
// ---------------------------------------------------------------------------

describe("TD-001 §3.2 later sequences progress", () => {
  test("seq 1 applied + seq 2 quarantined, then 3..6 apply and drain", async () => {
    // Session 1: valid seq 1 applies; invalid seq 2 quarantined+skipped.
    const s1 = await runReceiverSession(db, { [PRODUCER]: 2 }, [
      makeRecord({ local_seq: 1 }),
      invalidRecord(2),
    ]);
    expect(appliedUpto(db, PRODUCER)).toBe(1);
    expect(isSeqSkipped(db, PRODUCER, 2)).toBe(true);
    expect(s1.receivedQuarantined).toBe(1);

    // Session 2: valid 3..6 arrive — N+1 APPLIES (not buffered), pending
    // drains, no unbounded pending growth.
    const s2 = await runReceiverSession(db, { [PRODUCER]: 6 }, [
      makeRecord({ local_seq: 3 }),
      makeRecord({ local_seq: 4 }),
      makeRecord({ local_seq: 5 }),
      makeRecord({ local_seq: 6 }),
    ]);
    expect(s2.receivedApplied).toBe(4);
    expect(s2.receivedBuffered).toBe(0);
    expect(appliedUpto(db, PRODUCER)).toBe(6); // jumped past quarantined 2 via N+1
    expect(pendingCount(db)).toBe(0);
    expect(changesCount(db)).toBe(5); // 1..6 minus the quarantined 2
    // skip(2) was GC'd once the frontier passed it; quarantine row remains.
    expect(isSeqSkipped(db, PRODUCER, 2)).toBe(false);
    expect(countQuarantined(db)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// TD-001 §3.3 — quarantine + skipped_seqs durable across restart.
// ---------------------------------------------------------------------------

describe("TD-001 §3.3 restart durability", () => {
  test("quarantine row (verbatim raw, countable) and skip row survive", async () => {
    const bad = invalidRecord(2);
    await runReceiverSession(db, { [PRODUCER]: 2 }, [
      makeRecord({ local_seq: 1 }),
      bad,
    ]);
    // A later valid seq must already be progressable pre-restart.
    expect(appliedUpto(db, PRODUCER)).toBe(1);
    expect(isSeqSkipped(db, PRODUCER, 2)).toBe(true);

    // "Restart": fresh knowledge purely from durable tables + fresh engine.
    const k = loadKnowledgeFromDb(db);
    expect(k.skipped?.get(PRODUCER)?.has(2)).toBe(true);
    // Countable by reason (DC-07 TR-10); the code carries the validator msg.
    expect(
      countQuarantined(db, "invalid_change_record:invalid operation upsert"),
    ).toBe(1);
    expect(JSON.parse(listQuarantine(db)[0]!.raw_record)).toEqual(bad);
    expect(listSkippedSeqs(db, PRODUCER)).toEqual([2]);

    // No seq is re-requested for skipped positions: neededRanges over the
    // restored state excludes seq 2.
    const engine = createSyncEngine({
      db,
      selfDeviceId: "d-self",
      mutateEntity: makeEntityMutator(),
    });
    void engine;
    const ranges = neededRanges(k, { [PRODUCER]: 2 });
    expect(ranges).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// TD-001 §3.4 — restart-time revalidation touches every quarantine row.
// ---------------------------------------------------------------------------

describe("TD-001 §3.4 restart-time revalidation attempted", () => {
  test("every row examined; still-invalid rows remain quarantined+skipped", async () => {
    const bad1 = invalidRecord(2);
    const bad3 = invalidRecord(4);
    await runReceiverSession(db, { [PRODUCER]: 2 }, [
      makeRecord({ local_seq: 1 }),
      bad1,
    ]);
    quarantineRecord(db, {
      reason: "invalid_change_record:synthetic",
      senderDeviceId: "d-self",
      rawRecord: bad3,
    });
    markSeqSkipped(db, PRODUCER, 4);

    const res = revalidateQuarantine(db, makeEntityMutator());
    expect(res.examined).toBe(2); // touched EVERY quarantine row
    expect(res.stillInvalid).toBe(2);
    expect(res.revalidated).toBe(0);
    // Both remain quarantined with their skip state unchanged.
    expect(countQuarantined(db)).toBe(2);
    expect(listSkippedSeqs(db, PRODUCER)).toEqual([2, 4]);
    expect(changesCount(db)).toBe(1);

    // Engine init runs the same pass (idempotent; nothing changes).
    createSyncEngine({ db, selfDeviceId: "d-self" });
    expect(countQuarantined(db)).toBe(2);
    expect(listSkippedSeqs(db, PRODUCER)).toEqual([2, 4]);
  });
});

// ---------------------------------------------------------------------------
// TD-001 §3.5 — duplicate re-delivery of a quarantined record is safe.
// ---------------------------------------------------------------------------

describe("TD-001 §3.5 duplicate delivery", () => {
  test("k re-deliveries: no new quarantine rows, no state change, clocks merged", async () => {
    const bad = invalidRecord(1);
    await runReceiverSession(db, { [PRODUCER]: 1 }, [bad]);
    const before = changesCount(db);

    // Re-deliver the SAME record k=3 times.
    for (let i = 0; i < 3; i++) {
      const stats = await runReceiverSession(db, { [PRODUCER]: 1 }, [bad]);
      expect(stats.receivedQuarantined).toBe(0); // no quarantine spam
      expect(stats.receivedDuplicate).toBe(1);
    }
    expect(countQuarantined(db)).toBe(1);
    expect(changesCount(db)).toBe(before);
    expect(appliedUpto(db, PRODUCER)).toBe(0);
    expect(isSeqSkipped(db, PRODUCER, 1)).toBe(true);
    // DC-02 §7.1: the duplicate's causality clock was merged (element-wise
    // MAX) — the peer's later seq is reflected in device_clock.
    const clock = db
      .prepare<[string], { max_seq: number }>(
        "SELECT max_seq FROM device_clock WHERE peer_device_id = ?",
      )
      .get(PRODUCER);
    expect(clock?.max_seq).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// TD-001 §3.6 — validator-now-accepts: restart revalidation applies the
// mutation idempotently, removes the skip row, advances the frontier.
// ---------------------------------------------------------------------------

describe("TD-001 §3.6 revalidation of now-valid records", () => {
  test("applies stalled seq, removes skip row, ACK frontier resumes", async () => {
    // Seed: seq 1 applied; seq 2 quarantined by an OLD validator. The stored
    // raw record is valid under the CURRENT validator (simulating a
    // forward-fixed validator / schema-version bump) — exactly the artifact
    // revalidation is designed to recover.
    applyRemoteChange(
      db,
      makeRecord({ local_seq: 1 }),
      { appliedUpto: {}, pending: new Map() },
    );
    const recovered = makeRecord({ local_seq: 2 });
    quarantineRecord(db, {
      reason: "invalid_change_record:old_validator_rule",
      senderDeviceId: "d-self",
      rawRecord: recovered,
    });
    markSeqSkipped(db, PRODUCER, 2);

    const res = revalidateQuarantine(db, makeEntityMutator());
    expect(res.revalidated).toBe(1);
    // skipped row removed, frontier advanced honestly (2 == old applied+1).
    expect(isSeqSkipped(db, PRODUCER, 2)).toBe(false);
    expect(appliedUpto(db, PRODUCER)).toBe(2);
    expect(changesCount(db)).toBe(2);
    // Quarantine diagnostic row survives (DC-04 §4.3b/TR-10).
    expect(countQuarantined(db)).toBe(1);

    // Idempotent: a second pass must not duplicate anything.
    const res2 = revalidateQuarantine(db, makeEntityMutator());
    expect(res2.revalidated).toBe(0);
    expect(changesCount(db)).toBe(2);
    expect(appliedUpto(db, PRODUCER)).toBe(2);

    // And a fresh session ACKs the resumed frontier.
    const ack: SyncMessage[] = [];
    const inbox: SyncMessage[] = [
      { v: 1, type: "HELLO", device_clock: { [PRODUCER]: 2 } },
    ];
    const transport: SyncTransport = {
      async send(msg) {
        if (msg.type === "CHANGES_ACK") ack.push(msg);
      },
      receive: () => poll(inbox),
    };
    await createSyncEngine({ db, selfDeviceId: "d-self" }).runSession(transport);
    const ackMsg = ack[0] as Extract<SyncMessage, { type: "CHANGES_ACK" }>;
    expect(ackMsg.applied_upto[PRODUCER]).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// TD-001 §3.7 — no false success reporting; outcome classes exclusive.
// ---------------------------------------------------------------------------

describe("TD-001 §3.7 honest ACK + exclusive outcome classes", () => {
  test("ACK never claims the quarantined seq; stats classes are exclusive", async () => {
    const ack: SyncMessage[] = [];
    const inbox: SyncMessage[] = [
      { v: 1, type: "HELLO", device_clock: { [PRODUCER]: 1 } },
      { v: 1, type: "CHANGES_BATCH", changes: [invalidRecord(1)] },
    ];
    const transport: SyncTransport = {
      async send(msg) {
        if (msg.type === "CHANGES_ACK") ack.push(msg);
      },
      receive: () => poll(inbox),
    };
    const engine = createSyncEngine({
      db,
      selfDeviceId: "d-self",
      mutateEntity: makeEntityMutator(),
    });
    const stats = await engine.runSession(transport);

    // ACK stays literal applied_upto (DC-02 §2.2): the quarantined seq is
    // NOT claimed as applied — the frontier plateaus at 0.
    const ackMsg = ack[0] as Extract<SyncMessage, { type: "CHANGES_ACK" }>;
    expect(ackMsg.applied_upto[PRODUCER] ?? 0).toBe(0);
    expect(appliedUpto(db, PRODUCER)).toBe(0);
    // Mutually exclusive, countable outcome classes.
    expect(stats.receivedQuarantined).toBe(1);
    expect(stats.receivedApplied).toBe(0);
    expect(stats.receivedBuffered).toBe(0);
    expect(stats.receivedDuplicate).toBe(0);
    expect(changesCount(db)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// TD-001 §3.8 — snapshot/incremental around the stream.
// ---------------------------------------------------------------------------

describe("TD-001 §3.8 snapshot dominated-merge around skipped seqs", () => {
  test("snapshot jumps skipped seq, GCs skip rows, keeps diagnostics; incremental classifies", async () => {
    const knowledge: KnowledgeState = {
      appliedUpto: {},
      pending: new Map(),
      skipped: new Map(),
    };
    // seq 1 applied; seq 2 quarantined+skipped; seq 5 buffered (3..4 gap).
    applyRemoteChange(db, makeRecord({ local_seq: 1 }), knowledge);
    quarantineRecord(db, {
      reason: "invalid_change_record:bad_operation",
      senderDeviceId: "d-self",
      rawRecord: invalidRecord(2),
    });
    markSeqSkipped(db, PRODUCER, 2);
    // Seq 3 applies immediately (nextExpected skips 2 — the design's core
    // liveness property); the frontier then sits at 3.
    expect(
      applyRemoteChange(db, makeRecord({ local_seq: 3 }), knowledge),
    ).toBe("applied");
    expect(appliedUpto(db, PRODUCER)).toBe(3);
    // Seq 5 is beyond nextExpected (4): genuinely buffered.
    expect(
      applyRemoteChange(db, makeRecord({ local_seq: 5 }), knowledge),
    ).toBe("buffered");

    const res = applySnapshot(
      db,
      { snapshot_clock: { [PRODUCER]: 5 }, entities: [], tombstones: [] },
      knowledge,
    );
    void res;
    // Dominated-merge jumped applied_upto past the skipped seq.
    expect(appliedUpto(db, PRODUCER)).toBe(5);
    expect(knowledge.appliedUpto[PRODUCER]).toBe(5);
    // Skip rows <= frontier GC'd; pending covered by frontier deleted.
    expect(isSeqSkipped(db, PRODUCER, 2)).toBe(false);
    expect(knowledge.skipped?.get(PRODUCER)).toBeUndefined();
    expect(pendingCount(db)).toBe(0);
    // Quarantine diagnostics survive (DC-08 §3.6).
    expect(countQuarantined(db)).toBe(1);

    // Subsequent incremental batches classify correctly: no dupes, no
    // re-quarantine; the quarantined seq re-delivered is a plain duplicate.
    expect(
      applyRemoteChange(db, makeRecord({ local_seq: 2 }), knowledge),
    ).toBe("duplicate");
    expect(
      applyRemoteChange(db, makeRecord({ local_seq: 6 }), knowledge),
    ).toBe("applied");
    expect(appliedUpto(db, PRODUCER)).toBe(6);
    expect(countQuarantined(db)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// TD-001 §3.9 — neededRanges excludes skipped seqs (no re-request loop).
// ---------------------------------------------------------------------------

describe("TD-001 §3.9 neededRanges excludes skipped seqs", () => {
  test("skipped positions split/exclude ranges; nothing re-requests N", () => {
    const k = emptyKnowledge();
    k.skipped = new Map();
    k.appliedUpto[PRODUCER] = 0;
    k.skipped.set(PRODUCER, new Set([2]));

    // Peer advertising 1..4: need 1, and 3..4 — never the skipped 2.
    expect(neededRanges(k, { [PRODUCER]: 4 })).toEqual([
      { device_id: PRODUCER, lo: 1, hi: 1 },
      { device_id: PRODUCER, lo: 3, hi: 4 },
    ]);
    // Frontier at 1 with only 2 skipped: the peer's seq 2 needs NOTHING.
    const k2 = emptyKnowledge();
    k2.skipped = new Map([[PRODUCER, new Set([2])]]);
    k2.appliedUpto[PRODUCER] = 1;
    expect(neededRanges(k2, { [PRODUCER]: 2 })).toEqual([]);

    // Non-contiguous skips: {2, 3} collapse into one excluded stretch.
    k.skipped.set(PRODUCER, new Set([2, 3]));
    expect(neededRanges(k, { [PRODUCER]: 4 })).toEqual([
      { device_id: PRODUCER, lo: 1, hi: 1 },
      { device_id: PRODUCER, lo: 4, hi: 4 },
    ]);
  });
});
