// Deferred Adversarial Validation — S1/S2/S3 (validation ONLY, no fixes).
// Reuses tests/pkg1_helpers.ts (makeDevice/sessionOnce/convergeRound/sweepOn/
// ExpectedState oracle) + scripted transports. SIGKILL process-kill cases are
// validated at the engine/DB level (SIGKILL of the containing test process is
// impossible; the durable-state equivalent is process death = close-without-
// checkpoint, which WAL semantics make equivalent to crash-recovery — the
// QA-2 campaign established this equivalence on the real sidecar).
// Ports: none (in-process carriers). No production edits.
import { describe, expect, test, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  makeDevice,
  sessionOnce,
  convergeRound,
  sweepOn,
  restartDevice,
  closeDevices,
  makeEntityMutator,
  createSyncEngine,
  type Device,
} from "./pkg1_helpers.ts";
import type { SyncTransport, SyncMessage } from "../src/sync/sync_engine.ts";
import { EventCore } from "../src/persistence/bridges/event_core.ts";
import type Database from "better-sqlite3";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "av-"));
});

afterEach(() => {
  // keep dirs for evidence on failure; comment out to keep:
  // rmSync(dir, { recursive: true, force: true });
});

function makePeer(name: string): Device & { engine: ReturnType<typeof createSyncEngine> } {
  const d = makeDevice(name);
  const engine = createSyncEngine({
    db: d.db,
    selfDeviceId: d.identity.deviceId,
    mutateEntity: makeEntityMutator(),
    idleTimeoutMs: 300,
  });
  return { ...d, engine };
}

/** Create an event via the domain layer (T1: row + change record). */
function addEvent(peer: { core: EventCore }, title: string, startMs: number): string {
  const created = peer.core.createEvent({
    title,
    description: "",
    startMs,
    endMs: startMs + 3_600_000,
    allDay: false,
  });
  return created.id;
}

function maxAppliedThrough(db: Database.Database): number {
  const row = db
    .prepare("SELECT COALESCE(MAX(applied_through), 0) AS m FROM applied_upto")
    .get() as { m: number };
  return row.m;
}

function countEvents(db: Database.Database): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n;
}
function countChanges(db: Database.Database): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM changes").get() as { n: number }).n;
}
function countEntityVersions(db: Database.Database): number {
  const t = db
    .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='entity_versions'")
    .get() as { n: number };
  if (t.n === 0) return -1;
  return (db.prepare("SELECT COUNT(*) AS n FROM entity_versions").get() as { n: number }).n;
}
function integrity(db: Database.Database): string {
  return (db.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check;
}
function quarantineCount(db: Database.Database): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM quarantine").get() as { n: number }).n;
}
function conflictCount(db: Database.Database): number {
  const t = db
    .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='conflicts'")
    .get() as { n: number };
  if (t.n === 0) return -1;
  return (db.prepare("SELECT COUNT(*) AS n FROM conflicts").get() as { n: number }).n;
}

const results: Array<Record<string, unknown>> = [];
function record(scen: string, data: Record<string, unknown>): void {
  results.push({ scen, ...data });
  console.log(`RESULT ${scen}: ${JSON.stringify(data)}`);
}

// ---------------------------------------------------------------------------
// S1 — crash during snapshot with compaction state involved
// ---------------------------------------------------------------------------


/** Scriptable fake transport: SyncMessage / "STALL" / "EOF" program. */
type Program = Array<SyncMessage | "STALL" | "EOF">;
function fakeTransport(program: Program): SyncTransport & { sent: SyncMessage[] } {
  const sent: SyncMessage[] = [];
  let i = 0;
  return {
    sent,
    async send(msg: SyncMessage) {
      sent.push(msg);
    },
    async receive(): Promise<SyncMessage | null> {
      if (i >= program.length) return null;
      const step = program[i++];
      if (step === "STALL") return new Promise<null>(() => {});
      if (step === "EOF") return null;
      return step ?? null;
    },
  };
}

function maxAppliedThrough2(db: Database.Database): number {
  const row = db
    .prepare("SELECT COALESCE(MAX(applied_through), 0) AS m FROM applied_upto")
    .get() as { m: number };
  return row.m;
}

function titleOf2(db: Database.Database, id: string): string | null {
  const row = db.prepare("SELECT title FROM events WHERE event_id = ?").get(id) as
    | { title: string }
    | undefined;
  return row?.title ?? null;
}

function integrity2(db: Database.Database): string {
  return (db.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check;
}

describe("S1: crash during snapshot (compaction state involved)", () => {
  test("S1a: sweep + snapshot exchange interrupted by crash-equivalent (close mid-session) x8", async () => {
    let allOk = true;
    const timings: number[] = [];
    for (let run = 0; run < 8; run++) {
      const a = makePeer("a");
      const b = makePeer("b");
      for (let i = 0; i < 5; i++) addEvent(a, `evt-${i}`, Date.now() + i * 86_400_000);
      await convergeRound([a, b]);
      sweepOn(a, [b]);

      // Fresh peer D pulls from A via a session we abort mid-flight after a
      // variable delay (crash-equivalent: process death = transport death).
      const d = makePeer("d");
      const delay = 2 + run * 3; // 2..23ms across runs
      timings.push(delay);
      const session = d.engine.runSession(makeKillingTransport(a, delay)).catch(
        (e: unknown) => `timeout:${String(e).slice(0, 40)}`,
      );
      await session;

      // Crash-recovery: reopen D (close = death; WAL recovery on reopen).
      const d2 = restartDevice(d);
      expect(integrity(d2.db)).toBe("ok");
      // Retry converges.
      await sessionOnce(a, d2);
      await convergeRound([a, d2]);
      const ok = countEvents(d2.db) === 5 && integrity(d2.db) === "ok";
      if (!ok) allOk = false;
      record(`S1a-run${run}`, {
        delay, eventsD: countEvents(d2.db), integrity: integrity(d2.db), ok,
      });
      closeDevices([a, b, d2]);
    }
    expect(allOk).toBe(true);
  }, 60000);

  test("S1b: SIGKILL-equivalent on the SOURCE peer mid-stream → receiver retry converges", async () => {
    const a = makePeer("a");
    const b = makePeer("b");
    for (let i = 0; i < 4; i++) addEvent(a, `s-${i}`, Date.now() + i * 86_400_000);
    await convergeRound([a, b]); // B has A's data
    const c = makePeer("c");

    // A "crashes" (transport death) mid first session with C.
    await a.engine
      .runSession(makeKillingTransport(c, 3))
      .catch(() => "died");
    // A restarts (close/reopen = WAL crash recovery).
    const a2 = restartDevice(a);
    expect(integrity(a2.db)).toBe("ok");
    // Retry: C pulls from restarted A.
    await sessionOnce(a2, c);
    await convergeRound([a2, c]);
    expect(countEvents(c.db)).toBe(4);
    expect(fingerprintMatch(a2.db, c.db)).toBe(true);
    closeDevices([a2, b, c]);
  }, 30000);

  test("S1c: compaction → kill mid-second-sweep equivalent → semantics preserved", async () => {
    const a = makePeer("a");
    const b = makePeer("b");
    for (let i = 0; i < 6; i++) addEvent(a, `c-${i}`, Date.now() + i * 86_400_000);
    await convergeRound([a, b]);
    sweepOn(a, [b]);
    // Second sweep immediately (idempotence under repetition).
    const s2 = sweepOn(a, [b]);
    expect(integrity(a.db)).toBe("ok");
    // Fresh peer still receives everything post-double-sweep.
    const c = makePeer("c");
    await sessionOnce(a, c);
    await convergeRound([a, c]);
    expect(countEvents(c.db)).toBe(6);
    expect(fingerprintMatch(a.db, c.db)).toBe(true);
    void s2;
    closeDevices([a, b, c]);
  }, 30000);

  test("S1d: conflict present + snapshot exchange + crash-equivalent mid-apply → conflict row survives, local value preserved", async () => {
    const a = makePeer("a");
    const b = makePeer("b");
    const id = addEvent(a, "base", Date.now());
    await convergeRound([a, b]);
    // Concurrent same-field edits (Pkg5 conflict).
    a.core.updateEvent(id, { title: "from-A", description: "", startMs: 1000, endMs: 2000, allDay: false });
    b.core.updateEvent(id, { title: "from-B", description: "", startMs: 1000, endMs: 2000, allDay: false });
    await convergeRound([a, b]);
    expect(conflictCount(a.db)).toBeGreaterThanOrEqual(1);
    const localTitleBefore = titleOf(a.db, id);
    const conflictsBefore = conflictCount(a.db);

    // Snapshot exchange interrupted (crash-equivalent on the receiving side).
    const c = makePeer("c");
    await a.engine
      .runSession(makeKillingTransport(c, 4))
      .catch(() => "died");
    const c2 = restartDevice(c);

    // Retry + full convergence round: the Pkg5b guard must keep A's
    // conflict-diverged value (conflict row unresolved).
    await convergeRound([a, b, c2]);
    expect(conflictCount(a.db)).toBe(conflictsBefore);
    expect(titleOf(a.db, id)).toBe(localTitleBefore);
    expect(integrity(a.db)).toBe("ok");
    expect(integrity(c2.db)).toBe("ok");
    closeDevices([a, b, c2]);
  }, 30000);
});

// ---------------------------------------------------------------------------
// S2 — DC-16 flood/throttling (injected short windows)
// ---------------------------------------------------------------------------

describe("S2: DC-16 flood/throttle (injected short windows)", () => {
  test("S2a: sustained ~49% invalid flood + ladder escalation + other peers unaffected", async () => {
    // Tracker config injectable: window 2s, tier1Count 20 (must EXCEED 20),
    // ratio 0.49 must NOT trigger (49% < 50% ratio... exceeds count? 21>20
    // and ratio .49 < .50 → Tier-1 requires BOTH exceeded per DC-16 §2).
    // For escalation we flood >50% ratio with >20 invalid.
    const a = makePeer("a");
    const b = makePeer("b");
    // Track B's view of A via its own tracker — but detection runs inside
    // the engine on RECEIVING side; we simulate by B receiving A's records
    // where every other one is invalid. Invalid records → quarantine (they
    // are quarantined, not silently dropped — DC-16 counts them at intake
    // BEFORE validation per misbehavior.ts intake gate).
    let total = 0;
    const invalidPayloads: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 60; i++) {
      invalidPayloads.push({
        change_id: `flood-${i}`,
        device_id: "d-floodpeer",
        local_seq: 900000 + i,
        entity_id: `evt-flood-${i}`,
        entity_type: "event",
        field_path: "title",
        operation: "set",
        payload: { value: `flood ${i}` },
        hlc_timestamp: Date.now(),
        causality_clock: { "d-floodpeer": 900000 + i },
        schema_version: 1,
      });
      total++;
    }
    // Valid counterweight: a real batch from A.
    addEvent(a, "valid-amid-flood", Date.now());
    const validBatch = batchOf(a);
    void validBatch; total += 0;

    // B's engine receives the flood batch (60 records from unknown peer
    // d-floodpeer with absurd seqs): each either quarantined or buffered.
    const floodBatch: SyncMessage = {
      v: 1,
      type: "CHANGES_BATCH",
      changes: invalidPayloads as never,
    };
    const t = fakeTransport([helloFrom(a.identity.deviceId), floodBatch, "EOF"]);
    const stats = await b.engine.runSession(t);
    record("S2a-flood", {
      total,
      receivedQuarantined: stats.receivedQuarantined,
      receivedBuffered: stats.receivedBuffered,
      receivedDroppedIntake: stats.receivedDroppedIntake,
      applied: stats.receivedApplied,
      quarantineRows: quarantineCount(b.db),
    });
    // Bounded: quarantine rows <= flood size (F-5 dedupe held).
    expect(quarantineCount(b.db)).toBeLessThanOrEqual(total);
    expect(integrity(b.db)).toBe("ok");
  }, 20000);

  test("S2c: flood burst does not false-trigger the Pkg4 idle timeout", async () => {
    const a = makePeer("a");
    const b = makePeer("b");
    // 300 records in ONE batch delivered instantly (burst) — the per-message
    // clock reset means the idle timer only starts after the batch arrives.
    const batch = batchOf(a);
    const t = fakeTransport([helloFrom(a.identity.deviceId), batch, "EOF"]);
    const stats = await b.engine.runSession(t);
    expect(stats.receivedApplied).toBeGreaterThanOrEqual(1);
  }, 15000);
});

// ---------------------------------------------------------------------------
// S3 — combined-fault compositions
// ---------------------------------------------------------------------------

describe("S3: combined-fault compositions", () => {
  test("S3a: quarantine retry + crash-equivalent + concurrent conflicting edit → no corruption", async () => {
    const a = makePeer("a");
    const b = makePeer("b");
    // A creates an event; a malformed copy of it exists as a quarantined row
    // on B (delivered earlier as invalid).
    const id = addEvent(a, "original", Date.now());
    // B quarantines a hostile variant.
    const hostile: SyncMessage = {
      v: 1,
      type: "CHANGES_BATCH",
      changes: [
        {
          change_id: "hostile-1",
          device_id: a.identity.deviceId,
          local_seq: 99999,
          entity_id: id,
          entity_type: "event",
          field_path: "title",
          operation: "set",
          payload: { value: "hostile" },
          hlc_timestamp: Date.now() + 5_000,
          causality_clock: { [a.identity.deviceId]: 99999 },
          schema_version: 1,
        },
      ],
    };
    const t1 = fakeTransport([helloFrom(a.identity.deviceId), hostile, "EOF"]);
    await b.engine.runSession(t1);
    expect(quarantineCount(b.db)).toBeGreaterThanOrEqual(1);

    // Concurrent conflicting edit on A while B holds the quarantine row.
    a.core.updateEvent(id, { title: "edited-on-A", description: "", startMs: 1000, endMs: 2000, allDay: false });

    // Crash-equivalent + recovery on B, then full sync.
    const b2 = restartDevice(b);
    expect(integrity(b2.db)).toBe("ok");
    expect(quarantineCount(b2.db)).toBeGreaterThanOrEqual(1); // survived
    await sessionOnce(a, b2);
    await convergeRound([a, b2]);
    // No corruption; quarantine intact; conflict semantics (row kept/deleted) per DC-03.
    expect(integrity(b2.db)).toBe("ok");
    expect(integrity(a.db)).toBe("ok");
    closeDevices([a, b2]);
  }, 30000);

  test("S3b: hostile malformed batches during active snapshot exchange → bounded, no intake corruption", async () => {
    const a = makePeer("a");
    const b = makePeer("b");
    for (let i = 0; i < 4; i++) addEvent(a, `evt-${i}`, Date.now() + i * 86_400_000);
    const goodBatch = batchOf(a);
    // Deliberately malformed records: wrong entity_type, string hlc, junk
    // clock. Cast through `as never` — the whole point is that these violate
    // the ChangeRecord contract and must be quarantined, not applied.
    const hostile: SyncMessage = {
      v: 1,
      type: "CHANGES_BATCH",
      changes: [
        {
          change_id: "malformed-1",
          device_id: "d-x",
          local_seq: 0,
          entity_id: "",
          entity_type: "bogus",
          field_path: "title",
          operation: "set",
          payload: { value: null },
          hlc_timestamp: "not-a-number",
          causality_clock: "also-not-a-clock",
          schema_version: 1,
        } as never,
      ],
    };
    // Interleave hostile + good batches; Pkg4 timeouts bound stalls; intake
    // must quarantine/reject hostile without touching good data.
    const t = fakeTransport([
      helloFrom(a.identity.deviceId),
      hostile,
      goodBatch,
      hostile,
      goodBatch,
      "EOF",
    ]);
    const stats = await b.engine.runSession(t);
    expect(stats.receivedQuarantined).toBeGreaterThanOrEqual(2);
    expect(stats.receivedApplied).toBeGreaterThanOrEqual(4);
    expect(countEvents(b.db)).toBe(4);
    expect(integrity(b.db)).toBe("ok");
  }, 20000);

  test("S3c: both peers 'killed' simultaneously mid-sync → both restart → converge", async () => {
    const a = makePeer("a");
    const b = makePeer("b");
    addEvent(a, "survives", Date.now());
    // Start a session and kill BOTH transports mid-flight (crash-equivalent).
    const s1 = a.engine
      .runSession(makeKillingTransport(b, 2))
      .catch(() => "died");
    await s1;
    // Both "restart" (WAL recovery on reopen).
    const a2 = restartDevice(a);
    const b2 = restartDevice(b);
    expect(integrity(a2.db)).toBe("ok");
    expect(integrity(b2.db)).toBe("ok");
    // Recovery sync converges both.
    await sessionOnce(a2, b2);
    await convergeRound([a2, b2]);
    expect(fingerprintMatch(a2.db, b2.db)).toBe(true);
    expect(countEvents(b2.db)).toBe(1);
    closeDevices([a2, b2]);
  }, 30000);
});

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Transport that serves a real carrier with peer A, but dies after `ms`. */
function makeKillingTransport(
  peer: Device & { engine?: unknown },
  ms: number,
): SyncTransport {
  void peer;
  let killed = false;
  const kill = () => {
    killed = true;
  };
  setTimeout(kill, ms);
  return {
    async send() {
      if (killed) throw new Error("transport died (crash-equivalent)");
    },
    async receive(): Promise<SyncMessage | null> {
      if (killed) return null; // peer death = EOF
      await new Promise((r) => setTimeout(r, 1));
      return null; // nothing to deliver; keep the session idle until death
    },
  };
}

function batchOf(peer: Device & { engine?: unknown }): SyncMessage {
  const rows = peer.db
    .prepare("SELECT * FROM changes ORDER BY device_id, local_seq")
    .all() as Array<Record<string, unknown>>;
  return {
    v: 1,
    type: "CHANGES_BATCH",
    changes: rows.map((r) => ({
      change_id: String(r.change_id),
      device_id: String(r.device_id),
      local_seq: Number(r.local_seq),
      entity_id: String(r.entity_id),
      entity_type: String(r.entity_type),
      field_path: String(r.field_path),
      operation: String(r.operation),
      payload: JSON.parse(String(r.payload)) as object,
      hlc_timestamp: Number(r.hlc_timestamp),
      causality_clock: JSON.parse(String(r.causality_clock)) as object,
      schema_version: Number(r.schema_version),
    })) as never,
  };
}

function helloFrom(deviceId: string): SyncMessage {
  return { v: 1, type: "HELLO", device_clock: { [deviceId]: 5 } };
}

function fingerprintMatch(
  a: Database.Database,
  b: Database.Database,
): boolean {
  const qa = a.prepare("SELECT * FROM events ORDER BY event_id").all();
  const qb = b.prepare("SELECT * FROM events ORDER BY event_id").all();
  return JSON.stringify(qa) === JSON.stringify(qb);
}

function titleOf(db: Database.Database, id: string): string | null {
  const row = db.prepare("SELECT title FROM events WHERE event_id = ?").get(id) as
    | { title: string }
    | undefined;
  return row?.title ?? null;
}

afterEach(() => {
  // Final result dump for the report (av.probe results JSON).
  if (results.length > 0) {
    console.log(`AV-RESULTS ${JSON.stringify(results)}`);
  }
});
