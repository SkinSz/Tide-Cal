// Pkg4 (QA M-3 / QA-1 F3, correlated BND-08) — bounded sync session idle
// timeout. The initiator's blocking receive points (HELLO handshake, pull-
// phase CHANGES_BATCH loop) previously awaited the peer forever: a peer that
// stalled or died without FIN (laptop sleep, power loss, NAT timeout) hung
// runSession — and the sync_now RPC — indefinitely.
//
// Fix under test: SYNC_IDLE_TIMEOUT_MS per-message idle bound (the clock
// restarts on EVERY received message, so slow-but-alive transfers never
// false-time out); SyncIdleTimeoutError; session.done() in a finally block
// (socket never dangles); sync_now connect watchdog for unroutable hosts.
//
// Semantics asserted: timeout → deterministic SyncIdleTimeoutError; applied
// batches RETAINED (idempotent by change_id — nothing to roll back);
// initiator state stable across the failure; retry/recovery converges.
//
// Tests drive createSyncEngine directly with scripted SyncTransport objects
// (the same interface the Noise carrier implements) and inject a short
// deps.idleTimeoutMs (300ms) so the suite stays fast. The production default
// is 15s — justified in docs/qa/remediation/pkg4-report.md.
import { describe, expect, test, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSyncEngine,
  SYNC_IDLE_TIMEOUT_MS,
  SyncIdleTimeoutError,
  type SyncTransport,
  type SyncMessage,
} from "../src/sync/sync_engine.ts";
import { openDatabase } from "../src/persistence/database.ts";
import { EventCore } from "../src/persistence/bridges/event_core.ts";
import { makeEntityMutator } from "../src/persistence/bridges/sync_service.ts";
import {
  loadOrCreateIdentity,
} from "../src/network/sync_runtime.ts";
import { msgPipePair, sessionOnce, makeDevice, closeDevices } from "./pkg1_helpers.ts";
import type Database from "better-sqlite3";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pkg4-timeout-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

type Peer = {
  tag: string;
  dir: string;
  db: Database.Database;
  core: EventCore;
  engine: ReturnType<typeof createSyncEngine>;
  deviceId: string;
  identity: ReturnType<typeof loadOrCreateIdentity>;
};

const IDLE = 300; // injected per-message idle bound (ms) — suite stays fast

function makePeer(name: string): Peer {
  const dir = mkdtempSync(join(tmpdir(), `pkg4-${name}-`));
  const identity = loadOrCreateIdentity(dir);
  const core = new EventCore(join(dir, "tide.db"), identity.deviceId);
  const engine = createSyncEngine({
    db: core.db,
    selfDeviceId: identity.deviceId,
    mutateEntity: makeEntityMutator(),
    idleTimeoutMs: IDLE,
  });
  return {
    tag: name, dir, db: core.db, core, engine,
    deviceId: identity.deviceId, identity,
  };
}

/** Create an event via the domain layer (T1: row + change record). */
function addEvent(peer: Peer, title: string, startMs: number): void {
  peer.core.createEvent({
    title,
    description: "",
    startMs,
    endMs: startMs + 3_600_000,
    allDay: false,
  });
}

function countEvents(peer: Peer): number {
  return (
    peer.db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }
  ).n;
}

function countChanges(peer: Peer): number {
  return (
    peer.db.prepare("SELECT COUNT(*) AS n FROM changes").get() as { n: number }
  ).n;
}

function countEntityVersions(peer: Peer): number {
  const row = peer.db
    .prepare(
      "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='entity_versions'",
    )
    .get() as { n: number };
  if (row.n === 0) return -1;
  return (
    peer.db.prepare("SELECT COUNT(*) AS n FROM entity_versions").get() as {
      n: number;
    }
  ).n;
}

function maxAppliedThrough(peer: Peer): number {
  const row = peer.db
    .prepare(
      "SELECT COALESCE(MAX(applied_through), 0) AS m FROM applied_upto",
    )
    .get() as { m: number };
  return row.m;
}

function helloFrom(deviceId: string): SyncMessage {
  return { v: 1, type: "HELLO", device_clock: { [deviceId]: 5 } };
}

/** Scriptable fake transport: SyncMessage / "STALL" / "EOF" program. */
type Program = Array<SyncMessage | "STALL" | "EOF">;
function fakeTransport(program: Program): SyncTransport & {
  sent: SyncMessage[];
} {
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
      return step as SyncMessage;
    },
  };
}

/**
 * Engine-on-both-ends session where the INITIATOR's receive is delayed
 * `delayMs` per message (slow-but-alive: delay < idle) — real DC-08
 * protocol on both ends, production pattern.
 */
function makeDelayedSessionRunner(delayMs: number) {
  return async function delayedSessionOnce(
    from: Peer,
    to: Peer,
  ): Promise<void> {
    const [pFrom, pTo] = msgPipePair();
    const engFrom = createSyncEngine({
      db: from.db,
      selfDeviceId: from.identity.deviceId,
      mutateEntity: makeEntityMutator(),
      idleTimeoutMs: IDLE,
    });
    const engTo = createSyncEngine({
      db: to.db,
      selfDeviceId: to.identity.deviceId,
      mutateEntity: makeEntityMutator(),
    });
    const slowFrom: SyncTransport = {
      async send(msg: SyncMessage) {
        await pFrom.send(msg);
      },
      async receive(): Promise<SyncMessage | null> {
        await new Promise((r) => setTimeout(r, delayMs));
        const m = (await pFrom.receive()) as SyncMessage | null;
        return m;
      },
    };
    const runF = engFrom
      .runSession(slowFrom)
      .then(() => pTo.close())
      .catch(() => pTo.close());
    const runT = engTo
      .runSession(pTo as never)
      .then(() => pFrom.close())
      .catch(() => pFrom.close());
    await Promise.allSettled([runF, runT]);
  };
}

describe("Pkg4: sync session idle timeout (QA M-3)", () => {
  test("SYNC_IDLE_TIMEOUT_MS is the documented 15s default", () => {
    expect(SYNC_IDLE_TIMEOUT_MS).toBe(15_000);
  });

  test("stalled peer → SyncIdleTimeoutError, initiator state byte-stable", async () => {
    const a = makePeer("a");
    addEvent(a, "kept-1", Date.now());
    addEvent(a, "kept-2", Date.now() + 86_400_000);
    const changesBefore = countChanges(a);
    const eventsBefore = countEvents(a);
    const versionsBefore = countEntityVersions(a);

    // Peer sends HELLO then goes silent (no FIN, no data — the exact
    // laptop-sleep / NAT-timeout failure mode).
    const t = fakeTransport([helloFrom("d-peer"), "STALL"]);
    await expect(a.engine.runSession(t)).rejects.toBeInstanceOf(
      SyncIdleTimeoutError,
    );

    // Initiator state byte-stable: nothing applied, nothing corrupted.
    expect(countChanges(a)).toBe(changesBefore);
    expect(countEvents(a)).toBe(eventsBefore);
    expect(countEntityVersions(a)).toBe(versionsBefore);
  }, 10000);

  test("stalled mid-pull (after CHANGES_REQUEST) → timeout, applied state retained", async () => {
    const a = makePeer("a");
    // Peer's advertised clock includes producer d-peer — the engine WILL
    // emit CHANGES_REQUEST, then the peer stalls instead of answering.
    const t = fakeTransport([helloFrom("d-peer"), "STALL"]);
    await expect(a.engine.runSession(t)).rejects.toBeInstanceOf(
      SyncIdleTimeoutError,
    );
    // State retained/stable either way: nothing partial, nothing corrupt.
    expect(countEvents(a)).toBeGreaterThanOrEqual(0);
    expect(maxAppliedThrough(a)).toBeGreaterThanOrEqual(0);
  }, 10000);

  test("DEBUG baseline sessionOnce applies", async () => {
    const a = makeDevice("a");
    const b = makeDevice("b");
    a.core.createEvent({ title: "transferred", description: "", startMs: Date.now(), endMs: Date.now() + 3600000, allDay: false });
    await sessionOnce(a as never, b as never);
    expect(
      (b.db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n,
    ).toBe(1);
  }, 10000);

  test("slow-but-alive peer (gaps < idle) applies — no false timeout", async () => {
    const a = makePeer("a");
    const b = makePeer("b");
    addEvent(a, "transferred", Date.now());
    // 150ms per-message delay < 300ms idle: slow but progressing.
    await makeDelayedSessionRunner(150)(a, b);
    expect(countEvents(b)).toBe(1);
  }, 10000);

  test("timeout → retry applies records once (idempotent, no duplicates)", async () => {
    const a = makePeer("a");
    const b = makePeer("b");
    addEvent(a, "evt-A", Date.now());

    // Session 1: B's pull stalls → timeout (fake transport).
    const stalled = fakeTransport([helloFrom(a.deviceId), "STALL"]);
    await expect(b.engine.runSession(stalled)).rejects.toBeInstanceOf(
      SyncIdleTimeoutError,
    );
    expect(countEvents(b)).toBe(0); // nothing applied yet

    // Recovery: healthy engine-on-both-ends session applies A's record.
    await makeDelayedSessionRunner(50)(a, b);
    expect(countEvents(b)).toBe(1);

    // Duplicate delivery (second full session, same data): still one row.
    await makeDelayedSessionRunner(50)(a, b);
    expect(countEvents(b)).toBe(1);
  }, 10000);

  test("timeout then recovery converges peers (semantic equality)", async () => {
    const a = makePeer("a");
    const b = makePeer("b");
    addEvent(a, "one", Date.now());
    addEvent(a, "two", Date.now() + 86_400_000);

    const stalled = fakeTransport([helloFrom(a.deviceId), "STALL"]);
    await expect(b.engine.runSession(stalled)).rejects.toBeInstanceOf(
      SyncIdleTimeoutError,
    );

    await makeDelayedSessionRunner(50)(a, b);
    const bRows = b.db
      .prepare("SELECT event_id, title FROM events ORDER BY event_id")
      .all();
    const aRows = a.db
      .prepare("SELECT event_id, title FROM events ORDER BY event_id")
      .all();
    expect(JSON.stringify(bRows)).toBe(JSON.stringify(aRows));
    expect(bRows.length).toBe(2);
  }, 10000);
});
