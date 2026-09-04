// Tide DC-09 §3 trigger-layer tests (fixes review finding M-7).
// Covers TR-1 (Trigger A gating), TR-2 posture (Trigger B bypass),
// TR-3 (Trigger C boundary), §7.3 race determinism, §3.5 dedup/session
// reset, and a paired-engine integration extending DC-09 TR-1.

import { describe, expect, test, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_MAX_INCREMENTAL_BACKLOG,
  GAP_ROUND_LIMIT,
  MAX_MAX_INCREMENTAL_BACKLOG,
  MIN_MAX_INCREMENTAL_BACKLOG,
  OfferDedup,
  TriggerStateTracker,
  clampMaxIncrementalBacklog,
  computeIncrementalCost,
  offerSessionKey,
  resolveOfferRace,
} from "../src/sync/full_state_triggers.ts";
import {
  createSyncEngine,
  type SyncMessage,
  type SyncTransport,
} from "../src/sync/sync_engine.ts";
import { openDatabase, createLocalChange } from "../src/persistence/database.ts";

describe("DC-09 §3.1 Trigger A — gap-round streak gating", () => {
  let clock = 0;
  const tick = () => ++clock;

  // Isolate the injectable-clock counter per test: stamps must reflect THIS
  // test's ticks only, not leftovers from earlier cases in the block.
  beforeEach(() => {
    clock = 0;
  });

  test("fires only at streak >= GAP_ROUND_LIMIT (2)", () => {
    const tracker = new TriggerStateTracker({ now: tick });
    expect(GAP_ROUND_LIMIT).toBe(2);

    expect(tracker.shouldOfferTriggerA("peer-1")).toBe(false);
    expect(tracker.recordGapRound("peer-1")).toBe(1);
    expect(tracker.shouldOfferTriggerA("peer-1")).toBe(false); // 1 round: no offer
    expect(tracker.recordGapRound("peer-1")).toBe(2);
    expect(tracker.shouldOfferTriggerA("peer-1")).toBe(true); // 2 consecutive
    expect(tracker.recordGapRound("peer-1")).toBe(3);
    expect(tracker.shouldOfferTriggerA("peer-1")).toBe(true); // still offering
  });

  test("resets on a servable round; peers and directions are independent", () => {
    const tracker = new TriggerStateTracker({ now: tick });

    tracker.recordGapRound("p");
    tracker.recordGapRound("p");
    expect(tracker.shouldOfferTriggerA("p")).toBe(true);

    tracker.resetStreak("p"); // servable outcome (§3.1)
    expect(tracker.streak("p")).toBe(0);
    expect(tracker.shouldOfferTriggerA("p")).toBe(false);

    // Rebuild the streak after a reset.
    tracker.recordGapRound("p");
    expect(tracker.shouldOfferTriggerA("p")).toBe(false);
    tracker.recordGapRound("p");
    expect(tracker.shouldOfferTriggerA("p")).toBe(true);

    // Other peer unaffected; direction-scoped keys.
    tracker.recordGapRound("q");
    expect(tracker.shouldOfferTriggerA("q")).toBe(false);
    expect(tracker.shouldOfferTriggerA("p", "INCOMING")).toBe(false);
    expect(tracker.shouldOfferTriggerA("p", "OUTGOING")).toBe(true);
  });

  test("injectable clock is used for activity stamps", () => {
    const tracker = new TriggerStateTracker({ now: tick });
    tracker.recordGapRound("p");
    expect(tracker.lastActivityAt("p")).toBe(1);
    tracker.recordGapRound("p");
    expect(tracker.lastActivityAt("p")).toBe(2);
  });
});

describe("DC-09 §3.3 Trigger C — incremental backlog bound", () => {
  const tracker = new TriggerStateTracker();

  test("computeIncrementalCost counts all records in ranges", () => {
    expect(
      computeIncrementalCost([
        { device_id: "d-A", lo: 1, hi: 700 },
        { device_id: "d-B", lo: 1, hi: 300 },
      ]),
    ).toBe(1000);

    // Deterministic: same input -> same integer.
    const ranges = [{ device_id: "d", lo: 5, hi: 9 }] as const;
    expect(computeIncrementalCost(ranges)).toBe(
      computeIncrementalCost([...ranges]),
    );
  });

  test("retention info restricts cost to servable records (DC-09 §3.3)", () => {
    // Range [1..100] but producer retains only from seq 51 up to 90.
    expect(
      computeIncrementalCost([{ device_id: "d-A", lo: 1, hi: 100 }], {
        retainedLo: { "d-A": 51 },
        maxLocalSeq: { "d-A": 90 },
      }),
    ).toBe(40);
  });

  test("boundary with default setting: 1000 stays incremental, 1001 offers", () => {
    expect(DEFAULT_MAX_INCREMENTAL_BACKLOG).toBe(1000);
    expect(tracker.shouldOfferTriggerC(1000)).toBe(false);
    expect(tracker.shouldOfferTriggerC(1001)).toBe(true);
    expect(tracker.shouldOfferTriggerC(999)).toBe(false);
  });

  test("user-adjustable setting honored within bounds, clamped outside", () => {
    expect(clampMaxIncrementalBacklog(50)).toBe(MIN_MAX_INCREMENTAL_BACKLOG);
    expect(clampMaxIncrementalBacklog(500_000)).toBe(MAX_MAX_INCREMENTAL_BACKLOG);
    expect(clampMaxIncrementalBacklog(2500)).toBe(2500);

    // Setting at its minimum: flip occurs at >100 (TR-3).
    expect(tracker.shouldOfferTriggerC(100, MIN_MAX_INCREMENTAL_BACKLOG)).toBe(false);
    expect(tracker.shouldOfferTriggerC(101, MIN_MAX_INCREMENTAL_BACKLOG)).toBe(true);
    // Out-of-bounds setting values are clamped before comparison (DC-09 §2).
    // Setting 10 clamps UP to the minimum 100: 99 <= 100 stays incremental,
    // while anything above 100 offers despite the invalid setting.
    expect(tracker.shouldOfferTriggerC(99, 10)).toBe(false);
    expect(tracker.shouldOfferTriggerC(150, 10)).toBe(true); // > clamped 100
    // Setting 10,000,000 clamps DOWN to the maximum 100,000.
    expect(tracker.shouldOfferTriggerC(100_001, 10_000_000)).toBe(true);
    expect(tracker.shouldOfferTriggerC(100_000, 10_000_000)).toBe(false);
  });
});

describe("DC-09 §3.5 OfferDedup + §3.2 Trigger B bypass", () => {
  test("second automatic offer same session suppressed; new session resets", () => {
    const dedup = new OfferDedup();
    const key = offerSessionKey("me", "peer", "OUTGOING");
    expect(key).toBe("me|peer|OUTGOING");

    expect(dedup.shouldOffer(key, "GAP_ROUNDS")).toBe(true);
    dedup.markOffered(key);
    expect(dedup.shouldOffer(key, "GAP_ROUNDS")).toBe(false);
    expect(dedup.hasOffered(key)).toBe(true);

    // Session end clears state (in-memory only).
    dedup.reset();
    expect(dedup.shouldOffer(key, "GAP_ROUNDS")).toBe(true);
  });

  test("Trigger B (USER_INITIATED) always offers regardless of dedup", () => {
    const dedup = new OfferDedup();
    const key = offerSessionKey("me", "peer", "OUTGOING");
    dedup.markOffered(key);
    dedup.markOffered(offerSessionKey("me", "peer", "INCOMING"));

    for (let i = 0; i < 3; i++) {
      expect(dedup.shouldOffer(key, "USER_INITIATED")).toBe(true);
    }
    expect(dedup.shouldOffer(key, "BACKLOG")).toBe(false);
    expect(dedup.shouldOffer(key, "PROVABLE_STALENESS")).toBe(false);
  });
});

describe("DC-09 §7.3 simultaneous-offer race resolution", () => {
  test("higher device_id wins, deterministic in both directions", () => {
    expect(resolveOfferRace("d-B", "d-A")).toBe(true); // I proceed with mine
    expect(resolveOfferRace("d-A", "d-B")).toBe(false); // I defer/accept theirs

    // Same pair re-evaluated any number of times -> same outcome.
    for (let i = 0; i < 5; i++) {
      expect(resolveOfferRace("zeta", "alpha")).toBe(true);
      expect(resolveOfferRace("alpha", "zeta")).toBe(false);
    }
    // Equal ids: strictly-higher rule -> defer (still deterministic).
    expect(resolveOfferRace("same", "same")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Integration (extends DC-09 TR-1): two engines over paired transports where
// one side's change history was compacted (rows deleted manually) -> gap
// rounds occur -> FULL_STATE_OFFER fires -> snapshot applies -> convergence.
// ---------------------------------------------------------------------------

let hlcCounter = 500;
const nextHlc = () => ++hlcCounter;

function insertCalendar(db: ReturnType<typeof openDatabase>): void {
  db.prepare(
    "INSERT INTO calendars (calendar_id,title,created_hlc,updated_hlc) VALUES ('c-1','Home',1,1)",
  ).run();
}

function seedEventWithHistory(
  db: ReturnType<typeof openDatabase>,
  deviceId: string,
  eventId: string,
  title: string,
): void {
  db.prepare(`INSERT INTO events (event_id,calendar_id,title,description,all_day,
      start_wall,end_wall,tz_id,created_hlc,updated_hlc)
    VALUES (?,'c-1',?,'',0,'2026-09-01T09:00','2026-09-01T10:00','Europe/Berlin',?,?)`).run(
    eventId, title, hlcCounter, hlcCounter,
  );
  createLocalChange(db, deviceId, {
    entity_id: eventId,
    entity_type: "event",
    field_path: "title",
    operation: "set",
    payload: { value: title },
    hlc_now: nextHlc,
  });
}

/**
 * A later no-op edit (same title) so the entity keeps at least one RETAINED
 * change record after old-seq compaction. Mirrors real DC-06 compaction,
 * which never strips an entity's entire surviving history — a snapshot
 * entry needs its true version vector (DC-09 §4.2) from remaining records.
 */
function touchEventTitle(
  db: ReturnType<typeof openDatabase>,
  deviceId: string,
  eventId: string,
  title: string,
): void {
  db.prepare("UPDATE events SET updated_hlc = ? WHERE event_id = ?").run(hlcCounter, eventId);
  createLocalChange(db, deviceId, {
    entity_id: eventId,
    entity_type: "event",
    field_path: "title",
    operation: "set",
    payload: { value: title },
    hlc_now: nextHlc,
  });
}

type Log = { transport: SyncTransport; outbound: SyncMessage[] };

/** Poll-based paired transports that record every message each side sends. */
function pairedTransports(): [Log, Log] {
  const qToA: SyncMessage[] = [];
  const qToB: SyncMessage[] = [];
  // TD-020: ONE shared pipe state. close() on either end is a FIN to the
  // PEER: the peer's pending receive must resolve null (clean EOF), exactly
  // like pkg1_helpers' MsgPipe wakes the peer's waiter. (A per-end flag here
  // was the bug: the closer flagged its own inbound, so the peer never saw
  // the EOF and parked on the idle bound.) First session to finish releases
  // the other; a second close is a no-op.
  const pipe = { closed: false };
  const poll = (q: SyncMessage[]): Promise<SyncMessage | null> =>
    new Promise((resolve) => {
      const check = (): void => {
        // Pkg7 review (finding 3): DRAIN before EOF, matching pkg1_helpers'
        // msgPipePair — messages queued at close time are still delivered
        // (a FIN never erases data already in the pipe); only an EMPTY pipe
        // resolves null.
        const v = q.shift();
        if (v !== undefined) {
          resolve(v);
          return;
        }
        if (pipe.closed) {
          resolve(null);
          return;
        }
        setTimeout(check, 1);
      };
      check();
    });
  const mk = (
    outQ: SyncMessage[],
    inbound: SyncMessage[],
    log: SyncMessage[],
  ): SyncTransport => ({
    async send(msg) {
      log.push(msg);
      outQ.push(msg);
    },
    receive: () => poll(inbound),
    // TD-020: session-end signal — EOF the peer's pending receive.
    close() {
      pipe.closed = true;
    },
  });
  const logA: SyncMessage[] = [];
  const logB: SyncMessage[] = [];
  const a: Log = { transport: mk(qToB, qToA, logA), outbound: logA };
  const b: Log = { transport: mk(qToA, qToB, logB), outbound: logB };
  return [a, b];
}

const titlesOf = (
  db: ReturnType<typeof openDatabase>,
): string[] =>
  (
    db.prepare("SELECT event_id, title FROM events ORDER BY event_id").all() as Array<{
      event_id: string;
      title: string;
    }>
  ).map((r) => `${r.event_id}=${r.title}`);

describe("DC-09 TR-1 extended: compacted history triggers full-state recovery", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tide-triggers-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("gap rounds -> exactly one offer per side -> snapshot applies -> converge", async () => {
    // B holds five events with full change history...
    const dbA = openDatabase({ path: join(dir, "a.db") });
    const dbB = openDatabase({ path: join(dir, "b.db") });
    insertCalendar(dbA);
    insertCalendar(dbB);
    for (let i = 1; i <= 5; i++) {
      seedEventWithHistory(dbB, "d-B", `e-${i}`, `Event ${i}`);
    }
    // Later edits for e-1..e-3 (seqs 6..8): keeps one retained change record
    // per entity after the compaction below, so B can still build a valid
    // snapshot entry (version vector + latest producer) for them.
    for (let i = 1; i <= 3; i++) {
      touchEventTitle(dbB, "d-B", `e-${i}`, `Event ${i}`);
    }

    // ...then B's history for seqs 1..3 is compacted away (manual delete).
    dbB.prepare("DELETE FROM changes WHERE device_id = 'd-B' AND local_seq <= 3").run();
    const retainedOnB = (
      dbB.prepare("SELECT COUNT(*) c FROM changes WHERE device_id = 'd-B'").get() as { c: number }
    ).c;
    expect(retainedOnB).toBe(5); // seqs 4..8 still served incrementally
    // The gap A will request and B can never serve:
    expect(
      dbB.prepare(
        "SELECT MIN(local_seq) lo FROM changes WHERE device_id = 'd-B'",
      ).get() as { lo: number },
    ).toEqual({ lo: 4 });

    const [tA, tB] = pairedTransports();
    const engA = createSyncEngine({
      db: dbA,
      selfDeviceId: "d-A",
      peerDeviceId: "d-B",
    });
    const engB = createSyncEngine({
      db: dbB,
      selfDeviceId: "d-B",
      peerDeviceId: "d-A",
    });

    await Promise.all([engA.runSession(tA.transport), engB.runSession(tB.transport)]);

    const offersA = tA.outbound.filter((m) => m.type === "FULL_STATE_OFFER");
    const offersB = tB.outbound.filter((m) => m.type === "FULL_STATE_OFFER");

    // TR-1: persistent compaction-caused gaps produce exactly ONE offer here
    // (A hit 2 consecutive unservable rounds requesting e-1..e-3's records).
    expect(offersA.length).toBe(1);
    // §7.3: B has the higher device_id, so it declines A's offer silently and
    // proceeds with its own (race-counter) offer; A accepts it.
    expect(offersB.length).toBe(1);

    const acceptA = tA.outbound.filter((m) => m.type === "FULL_STATE_ACCEPT");
    expect(acceptA.length).toBe(1); // A accepted the winner's offer

    const snapsB = tB.outbound.filter((m) => m.type === "FULL_STATE_SNAPSHOT") as Array<
      Extract<SyncMessage, { type: "FULL_STATE_SNAPSHOT" }>
    >;
    expect(snapsB.length).toBeGreaterThanOrEqual(1);
    // §4.4: identical snapshot_clock across the stream, final marker on last.
    expect(new Set(snapsB.map((s) => JSON.stringify(s.snapshot_clock)))).toHaveLength(1);
    expect(snapsB[snapsB.length - 1]!.final).toBe(true);

    // Convergence: A now holds B's current semantic state (live entities),
    // even though the incremental path could never serve seqs 1..3.
    expect(titlesOf(dbA)).toEqual([
      "e-1=Event 1",
      "e-2=Event 2",
      "e-3=Event 3",
      "e-4=Event 4",
      "e-5=Event 5",
    ]);
    expect(titlesOf(dbA)).toEqual(titlesOf(dbB));

    // DC-06 §3.4 clock exchange: A's applied frontier dominates snapshot_clock.
    // snapshot_clock[d-B] = B's device_clock max_seq = 8 after the edits above.
    const appliedA = dbA
      .prepare("SELECT applied_through FROM applied_upto WHERE producer_device_id = 'd-B'")
      .get() as { applied_through: number };
    expect(appliedA.applied_through).toBe(8);

    dbA.close();
    dbB.close();
  }, 20000);
});
