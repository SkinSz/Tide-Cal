// Tide two-instance end-to-end sync test (headless, in-process).
//
// Two full "devices" are brought up with isolated identities + SQLite DBs,
// paired over a real Noise_XX channel (in-memory framed carrier, same code
// path as the TCP runtime), then:
//   1. A creates an event via EventCore
//   2. engine session runs A -> B
//   3. B's events table must contain the event (applied through the entity
//      mutator, not just stored as a change record)
//   4. B mutates back; reverse session must converge both rows
import { describe, expect, test } from "vitest";

(globalThis as { __TIDE_SYNC_DEBUG?: boolean }).__TIDE_SYNC_DEBUG = true;
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import {
  loadOrCreateIdentity,
} from "../src/network/sync_runtime.ts";
import type { FramedByteTransport } from "../src/network/noise_transport.ts";
import {
  handshakeOverTransport,
  type RawSessionHandle,
} from "../src/network/noise_transport.ts";
import {
  PairingSession,
  freshNonce,
  encodePairingPayload,
  decodePairingPayload,
  type PairingPayload,
} from "../src/security/pairing.ts";
import { sqlPeerStore } from "../src/network/pairing_manager.ts";
import { makeEntityMutator } from "../src/persistence/bridges/sync_service.ts";
import { createSyncEngine } from "../src/sync/sync_engine.ts";
import { openDatabase } from "../src/persistence/database.ts";
import { EventCore } from "../src/persistence/bridges/event_core.ts";

/** In-memory lossless ordered frame pipe pair (handshake + session carrier). */
function pipePair(): [FramedByteTransport, FramedByteTransport] {
  interface End {
    queue: Uint8Array[];
    waiter: ((f: Uint8Array | null) => void) | null;
    peer?: End;
  }
  const make = (): End => ({ queue: [], waiter: null });
  const x = make();
  const y = make();
  x.peer = y;
  y.peer = x;
  const wrap = (
    self: ReturnType<typeof make>,
  ): FramedByteTransport => ({
    async send(frame): Promise<void> {
      const p = self.peer!;
      if (p.waiter) {
        const w = p.waiter;
        p.waiter = null;
        w(frame);
      } else {
        p.queue.push(frame);
      }
    },
    async receive(): Promise<Uint8Array | null> {
      const next = self.queue.shift();
      if (next !== undefined) return next;
      return await new Promise<Uint8Array | null>((resolve) => {
        self.waiter = resolve;
      });
    },
  });
  return [wrap(x), wrap(y)];
}

interface Device {
  core: EventCore;
  identity: ReturnType<typeof loadOrCreateIdentity>;
}

function makeDevice(tag: string): Device {
  const dir = mkdtempSync(join(tmpdir(), `tide-e2e-${tag}-`));
  const dbPath = join(dir, "tide.db");
  // EventCore opens its own handle via openDatabase; identity beside it.
  const identity = loadOrCreateIdentity(dir);
  const core = new EventCore(dbPath, identity.deviceId);
  return { core, identity };
}

/**
 * Run the pairing ceremony between two devices over an in-memory pipe — the
 * identical PairingSession flow pairing_manager drives over TCP.
 */
async function pairDevices(a: Device, b: Device): Promise<void> {
  const [innerA, innerB] = pipePair();
  console.error("[t] handshake starting");
  const [rawA, rawB] = (await Promise.all([
    handshakeOverTransport("initiator", innerA, a.identity.privateKey),
    handshakeOverTransport("responder", innerB, b.identity.privateKey),
  ])) as [RawSessionHandle, RawSessionHandle];
  console.error("[t] handshake done");

  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const jsonOf = (raw: RawSessionHandle) => ({
    async send(o: unknown): Promise<void> {
      console.error("[t] json send", JSON.stringify(o).slice(0, 40));
      raw.outbound.push(
        raw.sendCipher.EncryptWithAd(new Uint8Array(0), enc.encode(JSON.stringify(o))),
      );
    },
    async receive(): Promise<unknown> {
      console.error("[t] json receive waiting");
      const f = await raw.inbound.receive();
      if (f === null) throw new Error("closed");
      console.error("[t] json got frame");
      return JSON.parse(dec.decode(raw.receiveCipher.DecryptWithAd(new Uint8Array(0), f)));
    },
  });

  const payloadFor = (d: Device): PairingPayload => ({
    v: 1,
    device_id: d.identity.deviceId,
    public_key: Buffer.from(d.identity.publicKey).toString("base64"),
    nonce: Buffer.from(freshNonce()).toString("base64"),
  });

  // Both sides exchange payloads CONCURRENTLY (each side: send then receive);
  // awaiting A's receive before B sends would deadlock a single-threaded flow.
  const jA = jsonOf(rawA);
  const jB = jsonOf(rawB);
  const localA = payloadFor(a);
  const localB = payloadFor(b);
  console.error("[t] exchanging payloads");
  const [, , remoteForA, remoteForB] = (await Promise.all([
    jA.send(localA),
    jB.send(localB),
    jA.receive(),
    jB.receive(),
  ])) as [void, void, PairingPayload, PairingPayload];
  console.error("[t] payloads exchanged");

  const runCeremony = (
    self: Device,
    local: PairingPayload,
    remote: PairingPayload,
    raw: RawSessionHandle,
    remoteDeviceId: string,
  ): string => {
    const ps = new PairingSession();
    ps.exchangePayloads(local, remote);
    ps.bindTranscript(raw.handshakeHash());
    ps.verifyRemoteStatic(raw.remoteStaticKey());
    const safety = ps.displaySafetyNumber();
    ps.confirmSafetyNumber(safety, safety); // same-human flow under test
    ps.storeTrust(() =>
      sqlPeerStore(self.core.db as never).store({
        deviceId: remoteDeviceId,
        publicKey: Buffer.from(remote.public_key, "base64"),
        displayName: remote.device_id.slice(0, 10),
        pairedAtMs: Date.now(),
      }),
    );
    return safety;
  };

  console.error("[t] running ceremonies");
  const sB = runCeremony(b, localB, remoteForB, rawB, a.identity.deviceId);
  const sA = runCeremony(a, localA, remoteForA, rawA, b.identity.deviceId);
  console.error("[t] ceremonies done");
  expect(sA).toBe(sB);

  rawA.sendCipher.free();
  rawA.receiveCipher.free();
  rawB.sendCipher.free();
  rawB.receiveCipher.free();
}

describe("two-instance sync E2E (headless)", () => {
  test("pair -> create on A -> sync -> event applied on B -> mutate on B -> reverse sync converges", async () => {
    console.error("[t] devices made");
    const a = makeDevice("A");
    const b = makeDevice("B");
    console.error("[t] IDS A=" + a.identity.deviceId.slice(0,8) + " B=" + b.identity.deviceId.slice(0,8));

    console.error("[t] pairing...");
    await pairDevices(a, b);
    console.error("[t] paired OK");

    // Trusted peers stored cross-referenced on both sides.
    const peersSql = (d: Device): Array<{ device_id: string }> =>
      (d.core.db as Database.Database)
        .prepare("SELECT device_id FROM peers WHERE status='trusted'")
        .all() as Array<{ device_id: string }>;
    expect(peersSql(a).map((p) => p.device_id)).toEqual([b.identity.deviceId]);
    expect(peersSql(b).map((p) => p.device_id)).toEqual([a.identity.deviceId]);

    console.error("[t] peers verified; creating event");
    // 1. Local create on A through the domain core.
    console.error("[t] creating event");
    console.error("[t] rows@A pre-sync:", JSON.stringify(
      (a.core.db as Database.Database).prepare("SELECT device_id, local_seq, entity_type FROM changes").all()));
    console.error("[t] clock@A pre-sync:", JSON.stringify(
      (a.core.db as Database.Database).prepare("SELECT * FROM device_clock").all()));
    const ev = a.core.createEvent({
      title: "Sync me",
      description: "from A",
      startMs: Date.now(),
      endMs: Date.now() + 3_600_000,
      allDay: false,
    });

    console.error("[t] rows@A post-create:", JSON.stringify(
      (a.core.db as unknown as Database.Database).prepare("SELECT device_id, local_seq, entity_type FROM changes").all()));

    // 2. Sync session A -> B over paired message transports (the same
    // harness as tests/sync_engine.test.ts; the encrypted-carrier hop is
    // covered by the pairing ceremony above and the noise transport suite).
    // Event-driven message pipes (waiter-based, no busy-poll): mirrors
    // FramedByteTransport semantics the engine expects — receive() holds a
    // single waiter until a frame arrives, and can be closed with null.
    const msgPipePair = (): [object, object] => {
      interface End {
        queue: unknown[];
        waiter: ((m: unknown) => void) | null;
        closed: boolean;
        peer?: End;
      }
      const make = (): End => ({ queue: [], waiter: null, closed: false });
      const x = make();
      const y = make();
      x.peer = y;
      y.peer = x;
      const wrap = (
        self: End,
      ): {
        send(msg: unknown): Promise<void>;
        receive(): Promise<unknown>;
        close(): void;
      } => ({
        async send(msg): Promise<void> {
          const p = self.peer!;
          if (p.closed) return;
          if (p.waiter) {
            const w = p.waiter;
            p.waiter = null;
            w(msg);
          } else p.queue.push(msg);
        },
        async receive(): Promise<unknown> {
          const next = self.queue.shift();
          if (next !== undefined) return next;
          if (self.closed) return null;
          return await new Promise((resolve) => {
            self.waiter = resolve;
          });
        },
        close(): void {
          self.closed = true;
          if (self.peer && self.peer.waiter) {
            const w = self.peer.waiter;
            self.peer.waiter = null;
            w(null);
          }
          if (self.waiter) {
            const w = self.waiter;
            self.waiter = null;
            w(null);
          }
        },
      });
      return [wrap(x), wrap(y)];
    };
    const sessionOnce = async (
      from: Device,
      to: Device,
    ): Promise<void> => {
      const [tFromRaw, tToRaw] = msgPipePair() as [
        {
          send(m: unknown): Promise<void>;
          receive(): Promise<unknown>;
          close(): void;
        },
        {
          send(m: unknown): Promise<void>;
          receive(): Promise<unknown>;
          close(): void;
        },
      ];
      // Thin logging taps around the raw pipes.
      const tFrom = {
        async send(msg: unknown): Promise<void> {
          console.error("[t] FROM>>", (msg as { type?: string }).type,
            JSON.stringify(msg).slice(0, 110));
          await tFromRaw.send(msg);
        },
        async receive(): Promise<unknown> {
          const m = await tFromRaw.receive();
          console.error("[t] FROM<<", m === null ? "null" : String((m as { type?: string }).type ?? "?"));
          return m;
        },
      };
      const tTo = {
        async send(msg: unknown): Promise<void> {
          console.error("[t] TO>>",  (msg as { type?: string }).type,
            JSON.stringify(msg).slice(0, 110));
          await tToRaw.send(msg);
        },
        async receive(): Promise<unknown> {
          const m = await tToRaw.receive();
          console.error("[t] TO<<", m === null ? "null" : String((m as { type?: string }).type ?? "?"));
          return m;
        },
      };
      const engFrom = createSyncEngine({
        db: from.core.db,
        selfDeviceId: from.identity.deviceId,
        mutateEntity: makeEntityMutator(),
      });
      const engTo = createSyncEngine({
        db: to.core.db,
        selfDeviceId: to.identity.deviceId,
        mutateEntity: makeEntityMutator(),
      });
      // Real carriers emit EOF when the peer finishes; emulate that so
      // expectBatch/serveRequests observe clean session end instead of
      // waiting forever on an idle-but-open pipe (TCP FIN semantics).
      const closingFrom = engFrom
        .runSession(tFrom as never)
        .then(
          (st) => {
            console.error("[t] engFrom stats", JSON.stringify(st));
            return tToRaw.close();
          },
          (e) => {
            console.error("[t] engFrom ERR", String(e));
            tToRaw.close();
            throw e;
          },
        );
      const closingTo = engTo.runSession(tTo as never).then(
        (st) => {
          console.error("[t] engTo stats", JSON.stringify(st));
          tFromRaw.close();
          return undefined;
        },
        (e) => {
          console.error("[t] engTo ERR", String(e));
          tFromRaw.close();
          throw e;
        },
      );
      await Promise.all([closingFrom, closingTo]);
      return undefined as never as void;
    };
    console.error("[t] clock@A pre-session:", JSON.stringify(
      (a.core.db as Database.Database).prepare("SELECT * FROM device_clock").all()));
    console.error("[t] rows@A pre-session:", JSON.stringify(
      (a.core.db as Database.Database).prepare("SELECT device_id, local_seq, entity_type FROM changes").all()));
    console.error("[t] clock@B pre-session:", JSON.stringify(
      (b.core.db as Database.Database).prepare("SELECT * FROM device_clock").all()));
    await sessionOnce(a, b);
    console.error("[t] A->B done");

    // 3. B must have the event ROW (entity mutation, not just change record).
    const rowOnB = (b.core.db as Database.Database)
      .prepare("SELECT event_id, title FROM events WHERE event_id = ?")
      .get(ev.id) as { event_id: string; title: string } | undefined;
    const changesOnB = (b.core.db as Database.Database)
      .prepare("SELECT entity_type, field_path, operation FROM changes")
      .all();
    console.error("[t] changes@B:", JSON.stringify(changesOnB));
    console.error("[t] applied_upto@B:", JSON.stringify(
      (b.core.db as Database.Database).prepare("SELECT * FROM applied_upto").all()));
    const pendB = (b.core.db as Database.Database)
      .prepare("SELECT device_id, local_seq FROM pending_changes").all();
    console.error("[t] pending@B:", JSON.stringify(pendB));
    const eventsOnB = (b.core.db as Database.Database)
      .prepare("SELECT event_id,title FROM events").all();
    console.error("[t] events@B:", JSON.stringify(eventsOnB));
    expect(rowOnB).toBeDefined();
    expect(rowOnB?.title).toBe("Sync me");

    // 4. B renames it; converge back.
    console.error("[t] renaming on B");
    b.core.updateEvent(ev.id, {
      title: "Renamed on B",
      description: "from B",
      startMs: ev.startMs,
      endMs: ev.endMs,
      allDay: false,
    });
    const chA = (a.core.db as Database.Database)
      .prepare("SELECT entity_type, operation FROM changes WHERE entity_type='event'").all();
    console.error("[t] all-changes@A:", JSON.stringify(
      (a.core.db as Database.Database).prepare("SELECT device_id, local_seq, entity_type FROM changes").all()));
    // DECISIVE PROBE: A's durable applied_upto for devB immediately before
    // session 2. Determines whether "buffered" classification is legitimate.
    const probe = (a.core.db as Database.Database)
      .prepare("SELECT producer_device_id, applied_through FROM applied_upto")
      .all();
    console.error("[t] PROBE applied_upto@A pre-session2:",
      JSON.stringify(probe.map((r: any) => ({
        dev: r.producer_device_id.slice(0, 8),
        thru: r.applied_through,
      }))));
    console.error("[t] PROBE pending@A pre-session2:",
      JSON.stringify((a.core.db as Database.Database)
        .prepare("SELECT device_id, local_seq FROM pending_changes").all()
        .map((r: any) => ({ dev: r.device_id.slice(0, 8), seq: r.local_seq }))));
    console.error("[t] sync B->A");
    await sessionOnce(b, a);
    console.error("[t] B->A done");

    console.error("[t] PROBE applied_upto@A post:", JSON.stringify(
      (a.core.db as Database.Database).prepare("SELECT * FROM applied_upto").all()));
    console.error("[t] PROBE pending@A post:", JSON.stringify(
      (a.core.db as Database.Database).prepare("SELECT device_id, local_seq FROM pending_changes").all()));
    console.error("[t] rows@A final:", JSON.stringify(
      (a.core.db as Database.Database)
        .prepare("SELECT device_id, local_seq, operation FROM changes WHERE entity_id = ?")
        .all(ev.id)
        .map((r: any) => ({ dev: r.device_id.slice(0, 8), seq: r.local_seq, op: r.operation })),
    ));
    console.error("[t] PROBE allchanges@A post:", JSON.stringify(
      (a.core.db as Database.Database)
        .prepare("SELECT device_id, local_seq, entity_type FROM changes")
        .all()
        .map((r: any) => ({ dev: r.device_id.slice(0, 8), s: r.local_seq, t: r.entity_type }))));
    console.error("[t] verifying A");
    const rowOnA =(a.core.db as Database.Database)
      .prepare("SELECT title FROM events WHERE event_id = ?")
      .get(ev.id) as { title: string } | undefined;
    expect(rowOnA?.title).toBe("Renamed on B");

    a.core.db.close();
    b.core.db.close();
  }, 30_000);
});
