// Full-state snapshots are OFF by default in this release (engine option
// `snapshots`, default off):
//  (a) a persistent gap never produces a FULL_STATE_OFFER; it is simply
//      requested again each session (bounded, no loop, no log spam);
//  (b) an incoming offer is declined (counted, no ACCEPT) and nothing applies;
//  (c) an unsolicited snapshot message is dropped, not applied.
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "better-sqlite3";
import { openDatabase } from "../src/persistence/database.ts";
import { makeEntityMutator } from "../src/persistence/bridges/sync_service.ts";
import { createSyncEngine } from "../src/sync/sync_engine.ts";
import type { SyncMessage, SyncTransport } from "../src/sync/sync_engine.ts";

const SELF = "d-self", PEER = "d-peer";
let dir: string;
let db: Database;
let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tide-snapoff-"));
  db = openDatabase({ path: join(dir, "tide.db") });
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  warn.mockRestore();
  try { db.close(); } catch { /* closed */ }
  rmSync(dir, { recursive: true, force: true });
});

/** Scripted peer: answers every CHANGES_REQUEST with an empty batch (the range cannot be served). */
function peer(first: SyncMessage[], afterAck: SyncMessage[] = []): SyncTransport & { sent: SyncMessage[] } {
  const queue: SyncMessage[] = [...first];
  const sent: SyncMessage[] = [];
  return {
    sent,
    async send(m: SyncMessage) {
      sent.push(m);
      if (m.type === "CHANGES_REQUEST") queue.push({ v: 1, type: "CHANGES_BATCH", changes: [] });
      if (m.type === "CHANGES_ACK") queue.push({ v: 1, type: "CHANGES_ACK", applied_upto: {} }, ...afterAck);
    },
    async receive() {
      return queue.shift() ?? null;
    },
  };
}
const engine = () => createSyncEngine({ db, selfDeviceId: SELF, mutateEntity: makeEntityMutator(), peerDeviceId: PEER });
const count = (sent: SyncMessage[], type: string) => sent.filter((m) => m.type === type).length;

test("(a) a persistent gap: zero FULL_STATE_OFFER over several sessions; re-requested each session, bounded, no log spam", async () => {
  const eng = engine();
  for (let i = 1; i <= 5; i++) {
    warn.mockClear();
    const t = peer([{ v: 1, type: "HELLO", device_clock: { [PEER]: 5 } }]);
    await eng.runSession(t);
    expect(count(t.sent, "FULL_STATE_OFFER"), `session ${i}: no offer`).toBe(0);
    expect(count(t.sent, "CHANGES_REQUEST"), `session ${i}: requested again, bounded`).toBe(2);
    expect(warn.mock.calls.length, `session ${i}: no log lines from the gap`).toBe(0);
  }
  expect(db.prepare("SELECT COUNT(*) c FROM changes").get()).toEqual({ c: 0 });
});

test("(b) an incoming FULL_STATE_OFFER is declined: counted, no ACCEPT, nothing applied", async () => {
  const t = peer([
    { v: 1, type: "HELLO", device_clock: {} },
    { v: 1, type: "FULL_STATE_OFFER", snapshot_clock: { [PEER]: 1 }, sender_device_id: PEER },
  ]);
  const stats = await engine().runSession(t);
  expect(stats.snapshotsDeclined).toBe(1);
  expect(count(t.sent, "FULL_STATE_ACCEPT")).toBe(0);
  expect(count(t.sent, "FULL_STATE_OFFER")).toBe(0);
  expect(db.prepare("SELECT COUNT(*) c FROM events").get()).toEqual({ c: 0 });
  expect(db.prepare("SELECT COUNT(*) c FROM changes").get()).toEqual({ c: 0 });
});

test("(c) an unsolicited FULL_STATE_SNAPSHOT message is dropped: counted, one stderr line, nothing applied", async () => {
  const snap: SyncMessage = {
    v: 1,
    type: "FULL_STATE_SNAPSHOT",
    snapshot_clock: { [PEER]: 1 },
    applied_upto: { [PEER]: 1 },
    entities: [
      {
        entity_id: "evt-snap", entity_type: "event", version: { [PEER]: 1 }, latest_producer: PEER, latest_seq: 1, latest_hlc: 1,
        state: { title: "from snapshot", description: "", startMs: 1_800_000_000_000, endMs: 1_800_003_600_000, allDay: false },
      } as never,
    ],
    tombstones: [],
    final: true,
  };
  const t = peer([{ v: 1, type: "HELLO", device_clock: {} }], [snap]);
  const stats = await engine().runSession(t);
  expect(stats.snapshotsDeclined).toBe(1);
  expect(warn.mock.calls.filter((c) => String(c[0]).includes("snapshot message dropped"))).toHaveLength(1);
  expect(db.prepare("SELECT COUNT(*) c FROM events").get()).toEqual({ c: 0 });
  expect(db.prepare("SELECT COUNT(*) c FROM applied_upto").get()).toEqual({ c: 0 });
});
