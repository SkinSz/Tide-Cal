// TD-047: a multi-message FULL_STATE_SNAPSHOT stream is one unit.
//
// DC-09 §5.1 / §7.2 / TR-7: the receiver applies the whole snapshot as one
// atomic logical apply. Before the fix the engine applied (and committed)
// every message on its own, so the absence rule (§5.2) of one message
// deleted the local entities that travel in another message of the same
// stream. Real seams: the sender's own engine produces the stream (default
// batch size, more than 256 entities), the receiver's own engine consumes
// it through its session loop, real SQLite files.
import { afterEach, describe, expect, test } from "vitest";
import { rmSync } from "node:fs";
import type Database from "better-sqlite3";
import {
  closeDevices,
  makeDevice,
  semanticEvents,
  sessionOnce,
  type Device,
} from "./pkg1_helpers.ts";
import { makeEntityMutator } from "../src/persistence/bridges/sync_service.ts";
import { createSyncEngine, type SyncMessage, type SyncTransport } from "../src/sync/sync_engine.ts";

type SnapMsg = Extract<SyncMessage, { type: "FULL_STATE_SNAPSHOT" }>;

const devices: Device[] = [];
afterEach(() => {
  closeDevices(devices);
  for (const d of devices.splice(0)) rmSync(d.dir, { recursive: true, force: true });
});

function dev(tag: string): Device {
  const d = makeDevice(tag);
  devices.push(d);
  return d;
}

function addEvents(d: Device, from: number, to: number): void {
  const t = Date.UTC(2026, 10, 20, 9);
  for (let i = from; i <= to; i++) {
    d.core.createEvent({
      title: `E-${String(i).padStart(3, "0")}`,
      description: "",
      startMs: t + i * 60_000,
      endMs: t + i * 60_000 + 1_800_000,
      allDay: false,
    });
  }
}

function eventIdByTitle(d: Device, title: string): string {
  return (d.db.prepare("SELECT event_id AS id FROM events WHERE title = ?").get(title) as { id: string }).id;
}

function scriptedTransport() {
  const inbox: Array<SyncMessage | null> = [];
  const waiters: Array<(m: SyncMessage | null) => void> = [];
  const sent: SyncMessage[] = [];
  const transport: SyncTransport = {
    send: async (m) => {
      sent.push(m);
    },
    receive: () =>
      inbox.length > 0 ? Promise.resolve(inbox.shift()!) : new Promise((r) => waiters.push(r)),
    close: () => {
      const w = waiters.shift();
      if (w) w(null);
    },
  };
  const push = (m: SyncMessage | null): void => {
    const w = waiters.shift();
    if (w) w(m);
    else inbox.push(m);
  };
  return { transport, sent, push };
}

function engineOf(d: Device, peerId: string) {
  return createSyncEngine({
    db: d.db,
    selfDeviceId: d.identity.deviceId,
    mutateEntity: makeEntityMutator(),
    peerDeviceId: peerId,
    snapshots: true,
  });
}

/**
 * The sender's own engine streams its full state: the peer asks for it
 * (Trigger A request), the sender offers, the peer accepts. Returns the
 * FULL_STATE_SNAPSHOT messages exactly as the sender put them on the wire.
 */
async function senderStream(s: Device, peerId: string): Promise<SnapMsg[]> {
  const t = scriptedTransport();
  const run = engineOf(s, peerId).runSession(t.transport);
  t.push({ v: 1, type: "HELLO", device_clock: {} });
  t.push({ v: 1, type: "FULL_STATE_OFFER", snapshot_clock: {}, reason: "GAP_ROUNDS", sender_device_id: peerId });
  t.push({ v: 1, type: "FULL_STATE_ACCEPT" });
  t.push({ v: 1, type: "CHANGES_ACK", applied_upto: {} });
  t.push(null);
  await run;
  return t.sent.filter((m): m is SnapMsg => m.type === "FULL_STATE_SNAPSHOT");
}

/** One receiver session: HELLO, the given messages, then ACK + EOF (or EOF only). */
async function deliver(
  engine: ReturnType<typeof engineOf>,
  msgs: SyncMessage[],
  opts: { endWithAck?: boolean } = {},
) {
  const t = scriptedTransport();
  const run = engine.runSession(t.transport);
  t.push({ v: 1, type: "HELLO", device_clock: {} });
  for (const m of msgs) t.push(m);
  if (opts.endWithAck !== false) t.push({ v: 1, type: "CHANGES_ACK", applied_upto: {} });
  t.push(null);
  return run;
}

function rows(db: Database.Database, sql: string): unknown[] {
  return db.prepare(sql).all();
}

/** Semantic state that must match the sender after a full-state apply. */
function stateOf(d: Device) {
  return {
    events: [...semanticEvents(d.db).values()],
    calendars: rows(d.db, "SELECT calendar_id, title, color FROM calendars ORDER BY calendar_id"),
    tombstonedIds: rows(d.db, "SELECT DISTINCT entity_id FROM entities_tombstones ORDER BY entity_id"),
  };
}

/** Every receiver-side table a snapshot apply may write (byte-level check). */
function dbDump(d: Device): string {
  const tables = [
    "events",
    "calendars",
    "entity_versions",
    "entities_tombstones",
    "applied_upto",
    "device_clock",
    "pending_changes",
    "skipped_seqs",
    "quarantine",
  ];
  return JSON.stringify(tables.map((t) => rows(d.db, `SELECT * FROM ${t} ORDER BY 1, 2`)));
}

/** Rows still staged for an unfinished snapshot stream on this connection. */
function stagedRows(d: Device): number {
  const tables = rows(d.db, "SELECT name FROM temp.sqlite_master WHERE type = 'table'") as Array<{ name: string }>;
  let n = 0;
  for (const { name } of tables) {
    n += (d.db.prepare(`SELECT COUNT(*) AS n FROM temp."${name}"`).get() as { n: number }).n;
  }
  return n;
}

function expectSameState(r: Device, s: Device): void {
  const got = stateOf(r);
  const want = stateOf(s);
  console.error(
    `[td047] receiver events=${got.events.length} sender events=${want.events.length} ` +
      `receiver tombstoned=${got.tombstonedIds.length} sender tombstoned=${want.tombstonedIds.length}`,
  );
  expect(got.events).toEqual(want.events);
  // The receiver keeps its own bootstrap calendar; the sender's must be there.
  expect(got.calendars).toEqual(expect.arrayContaining(want.calendars as unknown[]));
  // Every tombstone the sender holds rides along (DC-09 §4.3); the receiver
  // may add its own absence tombstones (§5.2), but never one for an entity
  // it still holds live.
  expect(got.tombstonedIds).toEqual(expect.arrayContaining(want.tombstonedIds as unknown[]));
  const liveIds = new Set(got.events.map((e) => e.event_id));
  for (const t of got.tombstonedIds as Array<{ entity_id: string }>) {
    expect(liveIds.has(t.entity_id)).toBe(false);
  }
}

describe("TD-047 a multi-message snapshot stream is applied as one unit (DC-09 §5.1, §7.2, TR-7)", () => {
  test("TD-047 repro (a): a 300-event stream reaches a fresh receiver complete", { timeout: 60_000 }, async () => {
    const S = dev("S");
    const R = dev("R");
    addEvents(S, 1, 301);
    S.core.deleteEvent(eventIdByTitle(S, "E-301")); // a tombstone rides along
    const stream = await senderStream(S, R.identity.deviceId);
    console.error(`[td047] stream messages=${stream.length} sizes=${stream.map((m) => `${m.entities.length}e/${(m.tombstones ?? []).length}t`).join(",")}`);
    expect(stream.length).toBeGreaterThanOrEqual(2);
    expect(stream.filter((m) => m.final === true)).toHaveLength(1);
    expect(stream[stream.length - 1]!.final).toBe(true);
    await deliver(engineOf(R, S.identity.deviceId), stream);
    expectSameState(R, S);
  });

  test("TD-047 repro (b): a receiver that already holds some of the entities ends equal to the sender", { timeout: 60_000 }, async () => {
    const S = dev("S");
    const R = dev("R");
    addEvents(S, 1, 150);
    await sessionOnce(S, R); // R pulls S's first 150 events incrementally
    expect(semanticEvents(R.db).size).toBe(150);
    addEvents(S, 151, 300);
    S.core.deleteEvent(eventIdByTitle(S, "E-010")); // R holds it; S deleted it
    const stream = await senderStream(S, R.identity.deviceId);
    expect(stream.length).toBeGreaterThanOrEqual(2);
    await deliver(engineOf(R, S.identity.deviceId), stream);
    expectSameState(R, S);
    expect(semanticEvents(R.db).has(eventIdByTitle(S, "E-150"))).toBe(true);
    // R now holds an absence tombstone (E-010), so its own stream carries a
    // tombstones-only message between entity messages (buildSnapshot order).
    const T = dev("T");
    const relay = await senderStream(R, T.identity.deviceId);
    console.error(`[td047] relay sizes=${relay.map((m) => `${m.entities.length}e/${(m.tombstones ?? []).length}t`).join(",")}`);
    expect(relay.some((m) => m.entities.length === 0 && (m.tombstones ?? []).length > 0 && m.final !== true)).toBe(true);
    await deliver(engineOf(T, R.identity.deviceId), relay);
    expect(stateOf(T).events).toEqual(stateOf(S).events);
    expectSameState(T, R);
  });

  test("absence across messages: an entity held locally that travels only in the last message survives; one absent from every message is deleted", { timeout: 60_000 }, async () => {
    const S = dev("S");
    const R = dev("R");
    addEvents(S, 1, 300);
    await sessionOnce(S, R); // R holds all 300 (incremental: two batches)
    expect(semanticEvents(R.db).size).toBe(300);
    const gone = eventIdByTitle(S, "E-005");
    S.core.deleteEvent(gone);
    const stream = await senderStream(S, R.identity.deviceId);
    const last = stream[stream.length - 1]!;
    const onlyLast = last.entities.filter((e) => e.entity_type === "event").map((e) => e.entity_id);
    const inOthers = new Set(stream.slice(0, -1).flatMap((m) => m.entities.map((e) => e.entity_id)));
    expect(onlyLast.length).toBeGreaterThan(0);
    for (const id of onlyLast) expect(inOthers.has(id)).toBe(false);
    for (const m of stream) expect(m.entities.some((e) => e.entity_id === gone)).toBe(false);
    await deliver(engineOf(R, S.identity.deviceId), stream);
    const live = semanticEvents(R.db);
    for (const id of onlyLast) expect(live.has(id)).toBe(true); // message 2 only: kept
    expect(live.has(gone)).toBe(false); // absent from all messages: deleted
    expectSameState(R, S);
  });

  test("an interrupted stream (session ends before `final`) writes nothing and leaves no staged rows; a later complete stream applies", { timeout: 60_000 }, async () => {
    const S = dev("S");
    const R = dev("R");
    addEvents(S, 1, 120);
    await sessionOnce(S, R); // R holds 120 events, which the stream would replace/keep
    addEvents(S, 121, 300);
    S.core.deleteEvent(eventIdByTitle(S, "E-007"));
    const stream = await senderStream(S, R.identity.deviceId);
    expect(stream.length).toBeGreaterThanOrEqual(2);
    const engine = engineOf(R, S.identity.deviceId);
    const before = dbDump(R);
    // EOF after every message but the last: nothing may land.
    await deliver(engine, stream.slice(0, -1), { endWithAck: false });
    expect(dbDump(R)).toBe(before);
    expect(stagedRows(R)).toBe(0);
    // Retry from scratch (DC-09 §7.2) on the SAME engine, after S changed
    // (fresh snapshot_clock): the abandoned messages must not join it.
    addEvents(S, 301, 301);
    const retry = await senderStream(S, R.identity.deviceId);
    await deliver(engine, retry);
    expectSameState(R, S);
    expect(stagedRows(R)).toBe(0);
  });

  test("a duplicated non-final message, reordered non-final messages and a full-stream replay all give the single-delivery state", { timeout: 60_000 }, async () => {
    const S = dev("S");
    addEvents(S, 1, 600);
    S.core.deleteEvent(eventIdByTitle(S, "E-042"));
    const stream = await senderStream(S, "peer");
    expect(stream.length).toBeGreaterThanOrEqual(3);
    const head = stream.slice(0, -1);
    const last = stream[stream.length - 1]!;

    const R1 = dev("R1"); // duplicate of message 1 inside the stream
    await deliver(engineOf(R1, S.identity.deviceId), [head[0]!, ...head, last]);
    expectSameState(R1, S);

    const R2 = dev("R2"); // non-final messages in reverse order
    await deliver(engineOf(R2, S.identity.deviceId), [...head].reverse().concat(last));
    expectSameState(R2, S);

    const R3 = dev("R3"); // whole stream twice (DC-08 TR-12)
    const e3 = engineOf(R3, S.identity.deviceId);
    await deliver(e3, stream);
    const once = dbDump(R3);
    await deliver(e3, stream);
    expect(stateOf(R3)).toEqual(stateOf(R1));
    expect(JSON.parse(dbDump(R3))[0]).toEqual(JSON.parse(once)[0]); // events rows unchanged
    expectSameState(R3, S);
  });

  test("a stream whose messages disagree on snapshot_clock or applied_upto is not applied, its tail included (nothing written)", { timeout: 60_000 }, async () => {
    const S = dev("S");
    const R = dev("R");
    addEvents(S, 1, 600);
    const stream = await senderStream(S, R.identity.deviceId);
    expect(stream.length).toBeGreaterThanOrEqual(3);
    const engine = engineOf(R, S.identity.deviceId);
    await deliver(engine, []); // a session's own bookkeeping, before the baseline
    const before = dbDump(R);
    // Message 2 disagrees; the messages after it (up to `final`) must not
    // be applied as a stream of their own either.
    const badClock = stream.map((m, i) =>
      i === 1 ? { ...m, snapshot_clock: { ...m.snapshot_clock, [S.identity.deviceId]: 1 } } : m,
    );
    await deliver(engine, badClock);
    expect(dbDump(R)).toBe(before);
    expect(stagedRows(R)).toBe(0);
    const badDeclared = stream.map((m, i) => (i === 1 ? { ...m, applied_upto: {} } : m));
    await deliver(engine, badDeclared);
    expect(dbDump(R)).toBe(before);
    expect(stagedRows(R)).toBe(0);
    await deliver(engine, stream); // the conforming stream still applies
    expectSameState(R, S);
  });
});
