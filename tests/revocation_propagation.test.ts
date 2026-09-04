// Tide DC-10 end-to-end verification: revocations propagate through the
// SYNC ENGINE path (REVOCATION_RECORDS / REVOCATIONS_ACK piggyback),
// covering TRP-1 (convergence), TRP-3 (forged records never propagate),
// TRP-4 (ack suppression + at-least-once recovery).
import { describe, expect, test, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/persistence/database.ts";
import {
  createSyncEngine,
  type RevocationChannel,
  type SyncEngine,
  type SyncTransport,
} from "../src/sync/sync_engine.ts";
import {
  acceptRevocation,
  createRevocation,
  createRevocationState,
  RevocationQueue,
  recordTriple,
  type RevocationTriple,
  type SignedRevocation,
  type TrustStoreEntry,
} from "../src/security/revocation.ts";
import { generateIdentity } from "../src/security/identity.ts";

type Trust = Map<string, TrustStoreEntry>;

interface Device {
  id: string;
  trust: Trust;
  state: ReturnType<typeof createRevocationState>;
  queue: RevocationQueue;
  channel: RevocationChannel & { dropAcksFromUs: boolean };
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}

function makeDevice(trust: Trust): Device {
  const identity = generateIdentity();
  const state = createRevocationState();
  const queue = new RevocationQueue(state);
  const dev: Device = {
    id: identity.deviceId,
    trust,
    state,
    queue,
    channel: undefined as unknown as Device["channel"],
    publicKey: identity.publicKey,
    privateKey: identity.privateKey,
  };
  const lookup = (id: string) => trust.get(id);
  let suppressAcks = false;
  dev.channel = {
    set dropAcksFromUs(v: boolean) {
      suppressAcks = v;
    },
    get dropAcksFromUs() {
      return suppressAcks;
    },
    queueFor(peer) {
      return queue.queue(peer);
    },
    async acceptInbound(signed, _fromPeer) {
      const r = await acceptRevocation(state, signed, lookup);
      return r.accepted;
    },
    acceptedTriples(): RevocationTriple[] {
      if (suppressAcks) return [];
      return [...state.records.values()].map((s) => recordTriple(s.record));
    },
    recordAck(peer, triples) {
      queue.ackPeer(peer, triples);
    },
  };
  return dev;
}

/** Polling paired transports (same harness shape as sync_engine.test.ts). */
function pairedTransports(): [SyncTransport, SyncTransport] {
  const qA: SyncMessageLike[] = [];
  const qB: SyncMessageLike[] = [];
  const poll = <T>(q: T[]): Promise<T | null> =>
    new Promise((resolve) => {
      const check = () => {
        const v = q.shift();
        if (v !== undefined) resolve(v);
        else setTimeout(check, 1);
      };
      check();
    });
  return [
    { send: async (m) => void qB.push(m), receive: () => poll(qA) },
    { send: async (m) => void qA.push(m), receive: () => poll(qB) },
  ];
}
type SyncMessageLike = Parameters<SyncTransport["send"]>[0];

function makeEngine(dev: Device, dbPath: string): SyncEngine {
  return createSyncEngine({
    db: openDatabase({ path: dbPath }),
    selfDeviceId: dev.id,
    peerDeviceId: undefined, // set per session below
    revocations: dev.channel,
  });
}

async function runPair(
  a: Device,
  b: Device,
  dir: string,
  opts?: { bPeerIdForA?: string; aPeerIdForB?: string },
): Promise<void> {
  const [tA, tB] = pairedTransports();
  const engA = createSyncEngine({
    db: openDatabase({ path: join(dir, "a.db") }),
    selfDeviceId: a.id,
    peerDeviceId: opts?.bPeerIdForA ?? b.id,
    revocations: a.channel,
  });
  const engB = createSyncEngine({
    db: openDatabase({ path: join(dir, "b.db") }),
    selfDeviceId: b.id,
    peerDeviceId: opts?.aPeerIdForB ?? a.id,
    revocations: b.channel,
  });
  await Promise.all([engA.runSession(tA), engB.runSession(tB)]);
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tide-revoke-e2e-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("DC-10 end-to-end through the sync engine", () => {
  test("TRP-1 direct delivery + §3 ack: record rides the session, ack stops re-sends", async () => {
    // Mesh: A (revoker) and B share a trust store including victim X.
    const victim = generateIdentity();
    const trust: Trust = new Map();
    const a = makeDevice(trust);
    const b = makeDevice(trust);
    trust.set(a.id, { publicKey: keyOf(a), status: "trusted" });
    trust.set(b.id, { publicKey: keyOf(b), status: "trusted" });

    // A creates a revocation of X (§2.1: creator is trivially "accepted").
    const signed = await createRevocation(
      {
        revoked_device_id: victim.deviceId,
        revoked_by_device_id: a.id,
        revoked_at_hlc: 1724600030000,
      },
      privOf(a),
    );
    (await acceptRevocation(a.state, signed, (id) => trust.get(id)));

    await runPair(a, b, dir);

    // B accepted and stored the record end-to-end.
    const tripleKey = `${victim.deviceId}\u00001724600030000\u0000${a.id}`;
    expect(b.state.records.has(tripleKey)).toBe(true);
    // B acked it -> A's queue for B is now empty (TRP-4a suppression).
    expect(a.queue.queue(b.id)).toHaveLength(0);

    // Second session carries NO further copies of r.
    let sentSecondSession = 0;
    const origQueueFor = a.channel.queueFor.bind(a.channel);
    a.channel.queueFor = (peer) => {
      const q = origQueueFor(peer);
      sentSecondSession += q.length;
      return q;
    };
    await runPair(a, b, dir);
    expect(sentSecondSession).toBe(0);
    // Idempotent store-once: still exactly one record at B.
    expect(b.state.records.size).toBe(1);
  });

  test("TRP-1 relay over a line topology: A -> B -> C converges", async () => {
    const victim = generateIdentity();
    const trust: Trust = new Map();
    const a = makeDevice(trust);
    const b = makeDevice(trust);
    const c = makeDevice(trust);
    for (const d of [a, b, c]) {
      trust.set(d.id, { publicKey: keyOf(d), status: "trusted" });
    }
    const signed = await createRevocation(
      {
        revoked_device_id: victim.deviceId,
        revoked_by_device_id: a.id,
        revoked_at_hlc: 111,
      },
      privOf(a),
    );
    await acceptRevocation(a.state, signed, (id) => trust.get(id));

    // Hop 1: A <-> B
    const d1 = join(dir, "hop1"); mkdirSync(d1); await runPair(a, b, d1);
    expect(b.state.records.size).toBe(1);
    // Hop 2: B <-> C (B forwards unconditionally per §2.4)
    const d2 = join(dir, "hop2"); mkdirSync(d2); await runPair(b, c, d2);
    expect(c.state.records.size).toBe(1);
    const rec = [...c.state.records.values()][0]!;
    expect(rec.record.revoked_device_id).toBe(victim.deviceId);
    // TTL-free intact forwarding: signature still verifies byte-identically.
    expect(Array.from(rec.signature)).toEqual(Array.from(signed.signature));
  });

  test("TRP-4b dropped ACK -> at-least-once re-send, duplicate acceptance is a byte-level no-op", async () => {
    const victim = generateIdentity();
    const trust: Trust = new Map();
    const a = makeDevice(trust);
    const b = makeDevice(trust);
    trust.set(a.id, { publicKey: keyOf(a), status: "trusted" });
    trust.set(b.id, { publicKey: keyOf(b), status: "trusted" });
    const signed = await createRevocation(
      {
        revoked_device_id: victim.deviceId,
        revoked_by_device_id: a.id,
        revoked_at_hlc: 222,
      },
      privOf(a),
    );
    await acceptRevocation(a.state, signed, (id) => trust.get(id));

    // Session 1: B's ACK is suppressed by fault injection.
    b.channel.dropAcksFromUs = true;
    const s1 = join(dir, "s1"); mkdirSync(s1); await runPair(a, b, s1);
    expect(b.state.records.size).toBe(1);
    expect(a.queue.queue(b.id)).toHaveLength(1); // still queued (no ack seen)

    // Session 2: acks enabled again; A re-sends; acceptance is idempotent.
    b.channel.dropAcksFromUs = false;
    const before = snapshotStore(b.state.records);
    const s2 = join(dir, "s2"); mkdirSync(s2); await runPair(a, b, s2);
    expect(a.queue.queue(b.id)).toHaveLength(0);
    expect(snapshotStore(b.state.records)).toEqual(before);
  });

  test("TRP-3 forged records are never stored and never re-forwarded", async () => {
    const victimX = generateIdentity();
    const victimY = generateIdentity();
    const trust: Trust = new Map();
    const a = makeDevice(trust);
    const b = makeDevice(trust);
    const c = makeDevice(trust);
    for (const d of [a, b, c]) {
      trust.set(d.id, { publicKey: keyOf(d), status: "trusted" });
    }
    // Self-signed forgery: X "revokes" Y with X's own key (not trusted as
    // a revoker for itself — distinct-trusted-revoker rule, DC-05 §7.2).
    const forged = await createRevocation(
      {
        revoked_device_id: victimY.deviceId,
        revoked_by_device_id: victimX.deviceId,
        revoked_at_hlc: 333,
      },
      victimX.privateKey,
    );
    // Deliver the forged record into B directly through the engine channel.
    const ok = await b.channel.acceptInbound(forged, a.id);
    expect(ok).toBe(false);
    expect(b.state.records.size).toBe(0); // never stored
    // Therefore it can never be queued onward to C (never re-forwarded).
    expect(b.queue.queue(c.id)).toHaveLength(0);
  });

  test("records naming the peer are NOT queued for that peer (§2.1)", async () => {
    const victim = generateIdentity();
    const trust: Trust = new Map();
    const a = makeDevice(trust);
    const b = makeDevice(trust);
    trust.set(a.id, { publicKey: keyOf(a), status: "trusted" });
    trust.set(b.id, { publicKey: keyOf(b), status: "trusted" });
    const signed = await createRevocation(
      {
        revoked_device_id: b.id, // revokes the CURRENT peer itself
        revoked_by_device_id: a.id,
        revoked_at_hlc: 444,
      },
      privOf(a),
    );
    await acceptRevocation(a.state, signed, (id) => trust.get(id));
    expect(a.queue.queue(b.id)).toHaveLength(0); // cut off before it matters
    expect(a.queue.queue("d-someone-else")).toHaveLength(1);
  });
});

function keyOf(dev: Device): Uint8Array {
  return dev.publicKey;
}
function privOf(dev: Device): Uint8Array {
  return dev.privateKey;
}
function snapshotStore(records: Map<string, SignedRevocation>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, s] of records) {
    out[k] =
      JSON.stringify(s.record) +
      ":" +
      Array.from(s.signature).join(",");
  }
  return out;
}
