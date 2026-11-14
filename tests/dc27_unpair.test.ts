// DC-27 Unpair a Device: one test per testable requirement (TR-1 .. TR-15)
// plus the v9 schema migration and the implementation-time verification
// items that can be proven in-process (V2, V4, V5, V8, V11).
//
// Real seams wherever the requirement is about the product: real
// SyncManager instances, real Noise_XX over loopback TCP, real SQLite files,
// real pairing ceremonies. Engine-level only where a test needs to inject a
// message a conforming peer never sends (TR-10).
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { connectSync, loadOrCreateIdentity, serveSync } from "../src/network/sync_runtime.ts";
import { EventCore } from "../src/persistence/bridges/event_core.ts";
import {
  makeSyncDispatcher,
  SyncManager,
  SyncRefusedError,
} from "../src/persistence/bridges/sidecar_server.ts";
import { EndpointCache } from "../src/network/endpoint_bridge.ts";
import { makeEntityMutator } from "../src/persistence/bridges/sync_service.ts";
import {
  createSyncEngine,
  PeerClosedBeforeHelloError,
  type SyncMessage,
  type SyncTransport,
} from "../src/sync/sync_engine.ts";
import {
  dbTrustLookup,
  makeDbRevocationChannel,
  isKnownRevoked,
  unpairLocal,
} from "../src/security/revocation_store.ts";
import {
  canonicalRevocationBytes,
  createRevocation,
  validateRevocationRecord,
  verifyRevocation,
  type RevocationRecord,
} from "../src/security/revocation.ts";
import {
  acceptPairingPayload,
  createPairingOffer,
  listTrustedPeers,
  PairingRefusedError,
  REVOKED_REPAIR_MESSAGE,
  sqlPeerStore,
} from "../src/network/pairing_manager.ts";
import { applyRemoteChange, loadKnowledgeFromDb, openDatabase } from "../src/persistence/database.ts";
import { applySnapshot, buildSnapshot, type Snapshot } from "../src/sync/full_state.ts";
import type { ChangeRecord } from "../src/sync/change_record.ts";
import { SCHEMA_VERSION } from "../src/persistence/schema.ts";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

let root: string;
const live: Dev[] = [];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tide-dc27-"));
});
afterEach(() => {
  for (const d of live.splice(0)) {
    try {
      d.mgr.closeListener();
    } catch {
      /* already closed */
    }
    try {
      d.core.db.close();
    } catch {
      /* already closed */
    }
  }
  rmSync(root, { recursive: true, force: true });
});

interface Dev {
  label: string;
  dir: string;
  identity: ReturnType<typeof loadOrCreateIdentity>;
  core: EventCore;
  mgr: SyncManager;
  port: number;
}

function makeDev(label: string, dir?: string): Dev {
  const d = dir ?? mkdtempSync(join(root, label.replace(/\W/g, "") + "-"));
  mkdirSync(d, { recursive: true }); // the shell creates the data dir (create_dir_all)
  const identity = loadOrCreateIdentity(d);
  const core = new EventCore(join(d, "tide.db"), identity.deviceId);
  const mgr = new SyncManager(core, identity);
  const dev = { label, dir: d, identity, core, mgr, port: 0 };
  live.push(dev);
  return dev;
}

async function listen(d: Dev): Promise<number> {
  d.mgr.ensureListener(0);
  for (let i = 0; i < 300 && !d.port; i++) {
    await sleep(10);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    d.port = (d.mgr as any).host?.actualPort ?? 0;
  }
  expect(d.port).toBeGreaterThan(0);
  return d.port;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function addPeer(host: Dev, peer: Dev, status: "trusted" | "revoked" = "trusted"): void {
  host.core.db
    .prepare(
      "INSERT INTO peers (device_id, public_key, display_name, paired_at, status) VALUES (?, ?, ?, ?, ?)",
    )
    .run(peer.identity.deviceId, Buffer.from(peer.identity.publicKey), peer.label, 1, status);
}

function pairAll(...devs: Dev[]): void {
  for (const a of devs) for (const b of devs) if (a !== b) addPeer(a, b);
}

function addEvent(d: Dev, title: string): void {
  const t = Date.UTC(2026, 10, 20, 9);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  d.core.createEvent({ title, description: "", startMs: t, endMs: t + 3_600_000, allDay: false } as any);
}

const titles = (d: Dev): string[] =>
  (d.core.db.prepare("SELECT title FROM events ORDER BY title").all() as Array<{ title: string }>).map(
    (r) => r.title,
  );

const statusOf = (d: Dev, peer: Dev): string | undefined =>
  (
    d.core.db.prepare("SELECT status FROM peers WHERE device_id = ?").get(peer.identity.deviceId) as
      | { status: string }
      | undefined
  )?.status;

const totalChanges = (d: Dev): number =>
  (d.core.db.prepare("SELECT total_changes() AS n").get() as { n: number }).n;

const count = (d: Dev, sql: string, ...p: unknown[]): number =>
  (d.core.db.prepare(sql).get(...p) as { n: number }).n;

/** Wrap a session's transport so every message type is logged per direction. */
function tap(session: Awaited<ReturnType<typeof connectSync>>, onSend?: (m: SyncMessage) => void) {
  const sent: string[] = [];
  const received: string[] = [];
  const t = session.transport;
  const wrapped: SyncTransport & typeof t = Object.assign(Object.create(t), {
    send: async (m: SyncMessage) => {
      sent.push(m.type);
      onSend?.(m);
      return t.send(m);
    },
    receive: async () => {
      const m = await t.receive();
      received.push(m === null ? "<closed>" : m.type);
      return m;
    },
    close: () => t.close?.(),
  });
  return { session: { ...session, transport: wrapped }, sent, received };
}

/** `from` dials `to` (Sync now path when expected is undefined). */
async function dial(from: Dev, to: Dev, expected?: string) {
  const s = await connectSync(from.identity.privateKey, "127.0.0.1", to.port);
  try {
    return await from.mgr.runEngineSession(s, expected);
  } finally {
    await sleep(150); // the responder's half of the session settles
  }
}

async function waitFor(pred: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error("waitFor timed out");
    await sleep(20);
  }
}

function dump(d: Dev, tables: string[]): string {
  const out: Record<string, unknown> = {};
  for (const t of tables) {
    out[t] = (d.core.db.prepare(`SELECT * FROM ${t} ORDER BY 1, 2`).all() as Array<
      Record<string, unknown>
    >).map((r) =>
      Object.fromEntries(
        Object.entries(r).map(([k, v]) => [k, Buffer.isBuffer(v) ? v.toString("hex") : v]),
      ),
    );
  }
  return JSON.stringify(out);
}

const TRUST_TABLES = ["peers", "revocation_records", "hard_blocks", "peer_invalid_tally", "pending_changes"];

function storedRecord(d: Dev): { record: RevocationRecord; signature: Uint8Array; bytes: string } {
  const row = d.core.db
    .prepare("SELECT record_bytes, signature FROM revocation_records LIMIT 1")
    .get() as { record_bytes: Buffer; signature: Buffer };
  const bytes = Buffer.from(row.record_bytes).toString("utf8");
  return {
    record: validateRevocationRecord(JSON.parse(bytes)),
    signature: new Uint8Array(row.signature),
    bytes,
  };
}

// ---------------------------------------------------------------------------
// TR-1  gate on all three session paths (+ never-paired key, inbound)
// ---------------------------------------------------------------------------

describe("TR-1 gate on every session path", () => {
  test("TR-1 (a) inbound, (b) Sync now, (c) scheduler: refused after the handshake, zero messages, zero writes on L", { timeout: 60_000 }, async () => {
    const L = makeDev("Linux PC");
    const W = makeDev("Windows PC");
    const stranger = makeDev("Stranger");
    pairAll(L, W);
    addEvent(L, "L-ONLY");
    addEvent(W, "W-ONLY");
    addEvent(stranger, "STRANGER");
    await listen(L);
    await listen(W);
    await listen(stranger);
    await L.mgr.unpairDevice(W.identity.deviceId, true);
    const before = totalChanges(L);
    const dumpBefore = dump(L, [...TRUST_TABLES, "events", "changes"]);

    // (a) inbound: W dials L. L closes after the handshake; W receives nothing.
    const a = await connectSync(W.identity.privateKey, "127.0.0.1", L.port);
    const ta = tap(a);
    await expect(W.mgr.runEngineSession(ta.session)).rejects.toBeInstanceOf(PeerClosedBeforeHelloError);
    expect(ta.received).toEqual(["<closed>"]);

    // (b) Sync now from L to W's endpoint: L refuses before sending anything.
    const b = await connectSync(L.identity.privateKey, "127.0.0.1", W.port);
    const tb = tap(b);
    await expect(L.mgr.runEngineSession(tb.session)).rejects.toMatchObject({
      name: "SyncRefusedError",
      decision: "DENY_REVOKED",
    });
    expect(tb.sent).toEqual([]);

    // (c) scheduler path (attributed dial): same refusal, nothing sent.
    const c = await connectSync(L.identity.privateKey, "127.0.0.1", W.port);
    const tc = tap(c);
    await expect(L.mgr.runEngineSession(tc.session, W.identity.deviceId)).rejects.toBeInstanceOf(
      SyncRefusedError,
    );
    expect(tc.sent).toEqual([]);

    // never-paired key on the inbound path: same result.
    const s = await connectSync(stranger.identity.privateKey, "127.0.0.1", L.port);
    const ts = tap(s);
    const eng = createSyncEngine({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: stranger.core.db as any,
      selfDeviceId: stranger.identity.deviceId,
      mutateEntity: makeEntityMutator(),
    });
    await expect(eng.runSession(ts.session.transport)).rejects.toThrow(/expected HELLO, got closed/);
    expect(ts.received).toEqual(["<closed>"]);
    s.done();
    await sleep(300);

    expect(totalChanges(L)).toBe(before);
    expect(dump(L, [...TRUST_TABLES, "events", "changes"])).toBe(dumpBefore);
    expect(titles(L)).toEqual(["L-ONLY"]);
    expect(titles(W)).toEqual(["W-ONLY"]);
    expect(titles(stranger)).toEqual(["STRANGER"]);
  });

  test("TR-1 a key only known-revoked by a stored record (no peers row flip) is refused too", { timeout: 30_000 }, async () => {
    // Fail closed: a trusted row whose id a valid record names is refused.
    const L = makeDev("L");
    const W = makeDev("W");
    const P = makeDev("P");
    pairAll(L, W, P);
    await L.mgr.unpairDevice(W.identity.deviceId, true);
    const rec = L.core.db.prepare("SELECT * FROM revocation_records").get() as Record<string, unknown>;
    P.core.db
      .prepare(
        `INSERT INTO revocation_records VALUES (@revoked_device_id, @revoked_by_device_id,
          @revoked_at_hlc, @reason, @record_bytes, @signature, @verification_state,
          @received_at_hlc, @revoked_after_seq)`,
      )
      .run(rec);
    expect(statusOf(P, W)).toBe("trusted");
    expect(isKnownRevoked(P.core.db, W.identity.deviceId)).toBe(true);
    await listen(P);
    const s = await connectSync(W.identity.privateKey, "127.0.0.1", P.port);
    await expect(W.mgr.runEngineSession(s)).rejects.toBeInstanceOf(PeerClosedBeforeHelloError);
  });
});

// ---------------------------------------------------------------------------
// TR-2  atomicity
// ---------------------------------------------------------------------------

test("TR-2 a fault inside the unpair transaction leaves every trust table byte-identical", async () => {
  const L = makeDev("L");
  const W = makeDev("W");
  pairAll(L, W);
  const w = W.identity.deviceId;
  L.core.db.prepare("UPDATE peers SET last_endpoint_host='10.0.0.9', last_endpoint_port=47471, last_endpoint_seen=5 WHERE device_id=?").run(w);
  L.core.db.prepare("INSERT INTO hard_blocks VALUES (?, 1, 2, 3)").run(w);
  L.core.db.prepare("INSERT INTO peer_invalid_tally VALUES (?, 7, 8)").run(w);
  L.core.db.prepare("INSERT INTO pending_changes VALUES (?, 9, '{}', 1)").run(w);
  const before = dump(L, TRUST_TABLES);
  await expect(
    L.mgr.unpairDevice(w, true, {
      beforeCommit: () => {
        throw new Error("injected fault");
      },
    }),
  ).rejects.toThrow("injected fault");
  expect(dump(L, TRUST_TABLES)).toBe(before);
  expect(statusOf(L, W)).toBe("trusted");
});

// ---------------------------------------------------------------------------
// TR-3  record validity on a third device
// ---------------------------------------------------------------------------

test("TR-3 the stored record verifies on a third device that trusts L and has no reason key", async () => {
  const L = makeDev("L");
  const W = makeDev("W");
  const P = makeDev("P");
  pairAll(L, W, P);
  addEvent(W, "W1");
  await listen(L);
  await dial(W, L);
  const res = await L.mgr.unpairDevice(W.identity.deviceId, true);
  expect(res).toMatchObject({ ok: true, already: false, peers_to_tell: 1 });
  const { record, signature, bytes } = storedRecord(L);
  const parsed = JSON.parse(bytes) as Record<string, unknown>;
  expect(Object.keys(parsed).sort()).toEqual([
    "revoked_after_seq",
    "revoked_at_hlc",
    "revoked_by_device_id",
    "revoked_device_id",
    "v",
  ]);
  expect("reason" in parsed).toBe(false);
  // keys sorted, canonical (DC-27 §6 c)
  expect(bytes).toBe(Buffer.from(canonicalRevocationBytes(record)).toString("utf8"));
  const applied = (L.core.db.prepare("SELECT applied_through AS n FROM applied_upto WHERE producer_device_id=?").get(W.identity.deviceId) as { n: number }).n;
  expect(record.revoked_after_seq).toBe(applied);
  expect(applied).toBeGreaterThan(0);
  const verdict = await verifyRevocation({ record, signature }, dbTrustLookup(P.core.db));
  expect(verdict).toEqual({ valid: true });
  // and the reason column of the stored row is NULL (P4)
  expect(count(L, "SELECT COUNT(*) AS n FROM revocation_records WHERE reason IS NOT NULL")).toBe(0);
});

// ---------------------------------------------------------------------------
// TR-4  confirmation (sidecar side; the UI state machine is in
// tests/dc27_unpair_ui.test.ts)
// ---------------------------------------------------------------------------

test("TR-4 unpair_device without confirm:true fails and changes nothing", async () => {
  const L = makeDev("L");
  const W = makeDev("W");
  pairAll(L, W);
  const dispatch = makeSyncDispatcher(L.mgr, L.core, { endpointCache: new EndpointCache() });
  const before = dump(L, TRUST_TABLES);
  for (const args of [
    { device_id: W.identity.deviceId },
    { device_id: W.identity.deviceId, confirm: "true" },
    { device_id: W.identity.deviceId, confirm: 1 },
    { device_id: W.identity.deviceId, confirm: false },
  ]) {
    await expect(Promise.resolve().then(() => dispatch("unpair_device", args))).rejects.toThrow(
      "ERR_CONFIRM: confirm:true required",
    );
  }
  expect(dump(L, TRUST_TABLES)).toBe(before);
  await expect(
    Promise.resolve().then(() => dispatch("unpair_device", { device_id: "d-unknown", confirm: true })),
  ).rejects.toThrow(/^ERR_NOT_PAIRED/);
  expect(dump(L, TRUST_TABLES)).toBe(before);
});

// ---------------------------------------------------------------------------
// TR-5  idempotence (+ V4: concurrent calls)
// ---------------------------------------------------------------------------

test("TR-5 a second unpair returns already:true, adds no record, starts no push; concurrent calls store one record (V4)", async () => {
  const L = makeDev("L");
  const W = makeDev("W");
  const P = makeDev("P");
  pairAll(L, W, P);
  let pushes = 0;
  L.mgr.urgentPush = () => void pushes++;
  const first = await L.mgr.unpairDevice(W.identity.deviceId, true);
  expect(first.already).toBe(false);
  expect(pushes).toBe(1);
  const second = await L.mgr.unpairDevice(W.identity.deviceId, true);
  expect(second).toEqual({ ok: true, already: true });
  expect(pushes).toBe(1);
  expect(count(L, "SELECT COUNT(*) AS n FROM revocation_records")).toBe(1);

  // V4: two calls in flight at once (the dispatcher does not serialize).
  const results = await Promise.all([
    L.mgr.unpairDevice(P.identity.deviceId, true),
    L.mgr.unpairDevice(P.identity.deviceId, true),
  ]);
  expect(results.map((r) => r.already).sort()).toEqual([false, true]);
  expect(count(L, "SELECT COUNT(*) AS n FROM revocation_records WHERE revoked_device_id=?", P.identity.deviceId)).toBe(1);
  expect(pushes).toBe(2);
});

// ---------------------------------------------------------------------------
// TR-6  propagation (three real instances)
// ---------------------------------------------------------------------------

describe("TR-6 propagation", () => {
  test("TR-6 P online: L's urgent push tells P, P then refuses W (no manual L-P sync)", { timeout: 60_000 }, async () => {
    const L = makeDev("L");
    const W = makeDev("W");
    const P = makeDev("P");
    pairAll(L, W, P);
    await listen(L);
    await listen(P);
    await listen(W);
    // L knows P's endpoint the way the scheduler leaves it (last-known).
    L.core.db
      .prepare("UPDATE peers SET last_endpoint_host='127.0.0.1', last_endpoint_port=?, last_endpoint_seen=? WHERE device_id=?")
      .run(P.port, Date.now(), P.identity.deviceId);
    // and W's, which unpair must clear (not dialed).
    L.core.db
      .prepare("UPDATE peers SET last_endpoint_host='127.0.0.1', last_endpoint_port=?, last_endpoint_seen=? WHERE device_id=?")
      .run(W.port, Date.now(), W.identity.deviceId);
    const dispatch = makeSyncDispatcher(L.mgr, L.core, { endpointCache: new EndpointCache() });
    const res = (await dispatch("unpair_device", { device_id: W.identity.deviceId, confirm: true })) as {
      peers_to_tell: number;
    };
    expect(res.peers_to_tell).toBe(1);
    await waitFor(() => statusOf(P, W) === "revoked");
    await waitFor(() => count(L, "SELECT COUNT(*) AS n FROM revocation_acks WHERE peer_device_id=?", P.identity.deviceId) === 1);
    addEvent(W, "W-AFTER");
    const s = await connectSync(W.identity.privateKey, "127.0.0.1", P.port);
    await expect(W.mgr.runEngineSession(s)).rejects.toBeInstanceOf(PeerClosedBeforeHelloError);
    expect(titles(P)).not.toContain("W-AFTER");
    const removed = (dispatch("list_removed_devices", {}) as { removed: Array<{ told: Array<{ device_id: string; done: boolean }> }> }).removed;
    expect(removed).toHaveLength(1);
    expect(removed[0]!.told).toEqual([expect.objectContaining({ device_id: P.identity.deviceId, done: true })]);
  });

  test("TR-6 P offline: P keeps trusting W until its first later session with L, then refuses W", { timeout: 60_000 }, async () => {
    const L = makeDev("L");
    const W = makeDev("W");
    const P = makeDev("P");
    pairAll(L, W, P);
    await listen(L);
    await listen(W);
    // P's endpoint points at a closed port: P is offline for the push.
    L.core.db
      .prepare("UPDATE peers SET last_endpoint_host='127.0.0.1', last_endpoint_port=1, last_endpoint_seen=? WHERE device_id=?")
      .run(Date.now(), P.identity.deviceId);
    const dispatch = makeSyncDispatcher(L.mgr, L.core, { endpointCache: new EndpointCache() });
    await dispatch("unpair_device", { device_id: W.identity.deviceId, confirm: true });
    await sleep(500);
    expect(statusOf(P, W)).toBe("trusted");
    let removed = (dispatch("list_removed_devices", {}) as { removed: Array<{ told: Array<{ done: boolean }> }> }).removed;
    expect(removed[0]!.told).toEqual([expect.objectContaining({ done: false })]);
    // accepted v1 limitation (DC-27 §4.7): W still syncs with the unaware P
    await listen(P);
    addEvent(W, "W-WHILE-P-UNAWARE");
    await dial(W, P);
    expect(titles(P)).toContain("W-WHILE-P-UNAWARE");
    // P's first later session with L (P dials L)
    await dial(P, L);
    expect(statusOf(P, W)).toBe("revoked");
    const s = await connectSync(W.identity.privateKey, "127.0.0.1", P.port);
    await expect(W.mgr.runEngineSession(s)).rejects.toBeInstanceOf(PeerClosedBeforeHelloError);
    removed = (dispatch("list_removed_devices", {}) as { removed: Array<{ told: Array<{ done: boolean }> }> }).removed;
    expect(removed[0]!.told).toEqual([expect.objectContaining({ done: true })]);
  });
});

// ---------------------------------------------------------------------------
// TR-7  data kept
// ---------------------------------------------------------------------------

test("TR-7 events W produced before the unpair stay listed on L, also after a restart", { timeout: 30_000 }, async () => {
  const L = makeDev("L");
  const W = makeDev("W");
  pairAll(L, W);
  addEvent(L, "L1");
  addEvent(W, "W1");
  addEvent(W, "W2");
  addEvent(W, "W3");
  await listen(L);
  await dial(W, L);
  const before = titles(L);
  expect(before).toEqual(["L1", "W1", "W2", "W3"]);
  const changesBefore = count(L, "SELECT COUNT(*) AS n FROM changes");
  await L.mgr.unpairDevice(W.identity.deviceId, true);
  expect(titles(L)).toEqual(before);
  expect(count(L, "SELECT COUNT(*) AS n FROM changes")).toBe(changesBefore);
  // restart
  L.mgr.closeListener();
  L.core.db.close();
  const reopened = new EventCore(join(L.dir, "tide.db"), L.identity.deviceId);
  try {
    const t = (reopened.db.prepare("SELECT title FROM events ORDER BY title").all() as Array<{ title: string }>).map((r) => r.title);
    expect(t).toEqual(before);
  } finally {
    reopened.db.close();
  }
});

// ---------------------------------------------------------------------------
// TR-8  producer rejection with the cutoff (+ V5)
// ---------------------------------------------------------------------------

test("TR-8 / V5 above-cutoff W changes relayed by an unaware P are not applied, no quarantine, no stall; at-or-below-cutoff history applies on a device that never saw it", { timeout: 90_000 }, async () => {
  const L = makeDev("L");
  const W = makeDev("W");
  const P = makeDev("P");
  const Q = makeDev("Q"); // a device that never saw W's changes nor the record
  pairAll(L, W, P);
  addPeer(Q, L);
  addPeer(Q, P);
  addPeer(P, Q);
  addPeer(L, Q);
  await listen(L);
  await listen(P);
  addEvent(W, "W-BEFORE");
  await dial(W, L);
  await dial(W, P);
  // L unpairs W; no push installed, so P stays unaware.
  await L.mgr.unpairDevice(W.identity.deviceId, true);
  const cutoff = storedRecord(L).record.revoked_after_seq!;
  expect(cutoff).toBeGreaterThan(0);
  // W keeps writing and reaches the unaware P.
  addEvent(W, "W-AFTER");
  await dial(W, P);
  expect(titles(P)).toContain("W-AFTER");
  addEvent(P, "P-1");

  // (1) L syncs with the unaware P: never requests W above the cutoff.
  const s1 = await connectSync(L.identity.privateKey, "127.0.0.1", P.port);
  const requests: Array<{ device_id: string; lo: number; hi: number }> = [];
  const t1 = tap(s1, (m) => {
    if (m.type === "CHANGES_REQUEST") requests.push(...m.ranges);
  });
  const st1 = await L.mgr.runEngineSession(t1.session);
  await sleep(200);
  expect(titles(L)).toContain("P-1");
  expect(titles(L)).not.toContain("W-AFTER");
  for (const r of requests) if (r.device_id === W.identity.deviceId) expect(r.hi).toBeLessThanOrEqual(cutoff);
  expect(count(L, "SELECT COUNT(*) AS n FROM quarantine")).toBe(0);
  expect((st1 as { receivedQuarantined?: number }).receivedQuarantined).toBe(0);
  // P learned the record in that session; it keeps what it already applied (§4.4).
  expect(statusOf(P, W)).toBe("revoked");
  expect(titles(P)).toContain("W-AFTER");

  // (2) Q dials P: Q computes its pull ranges from P's HELLO before P's
  // record arrives, so W's above-cutoff seqs ARE served; they are dropped
  // on arrival, the at-or-below-cutoff history is applied.
  const s2 = await connectSync(Q.identity.privateKey, "127.0.0.1", P.port);
  const t2 = tap(s2);
  const st2 = (await Q.mgr.runEngineSession(t2.session)) as Awaited<ReturnType<SyncManager["runEngineSession"]>> & {
    receivedRejectedRevoked?: number;
  };
  await sleep(200);
  expect(isKnownRevoked(Q.core.db, W.identity.deviceId)).toBe(true);
  expect(titles(Q)).toContain("W-BEFORE");
  expect(titles(Q)).toContain("P-1");
  expect(titles(Q)).not.toContain("W-AFTER");
  expect(st2.receivedRejectedRevoked ?? 0).toBeGreaterThan(0);
  expect(count(Q, "SELECT COUNT(*) AS n FROM quarantine")).toBe(0);
  expect(count(Q, "SELECT COUNT(*) AS n FROM skipped_seqs WHERE producer_device_id=?", W.identity.deviceId)).toBe(0);
  expect(count(Q, "SELECT COUNT(*) AS n FROM pending_changes WHERE device_id=? AND local_seq > ?", W.identity.deviceId, cutoff)).toBe(0);

  // V5: later sessions neither retry the dropped range forever nor fall
  // into DC-09 Trigger A; another producer's stream keeps flowing.
  for (let i = 0; i < 3; i++) {
    addEvent(P, `P-next-${i}`);
    const s = await connectSync(Q.identity.privateKey, "127.0.0.1", P.port);
    const reqs: Array<{ device_id: string; lo: number; hi: number }> = [];
    const t = tap(s, (m) => {
      if (m.type === "CHANGES_REQUEST") reqs.push(...m.ranges);
    });
    await Q.mgr.runEngineSession(t.session);
    await sleep(150);
    expect(t.sent).not.toContain("FULL_STATE_OFFER");
    expect(t.received).not.toContain("FULL_STATE_OFFER");
    for (const r of reqs) if (r.device_id === W.identity.deviceId) expect(r.hi).toBeLessThanOrEqual(cutoff);
    expect(titles(Q)).toContain(`P-next-${i}`);
  }
  const qApplied = (Q.core.db.prepare("SELECT applied_through AS n FROM applied_upto WHERE producer_device_id=?").get(W.identity.deviceId) as { n: number }).n;
  expect(qApplied).toBe(cutoff);
});

test("TR-8 an unaware P edits the rejected above-cutoff event: L creates no quarantine row and P's stream keeps advancing", { timeout: 60_000 }, async () => {
  const L = makeDev("L");
  const W = makeDev("W");
  const P = makeDev("P");
  pairAll(L, W, P);
  await listen(L);
  await listen(P);
  addEvent(W, "W-BEFORE");
  await dial(W, L);
  await L.mgr.unpairDevice(W.identity.deviceId, true);
  addEvent(W, "W-AFTER");
  await dial(W, P); // P is unaware and applies W-AFTER
  const ev = P.core.db.prepare("SELECT event_id AS id, utc_start_ms AS start_ms, utc_end_ms AS end_ms FROM events WHERE title='W-AFTER'").get() as { id: string; start_ms: number; end_ms: number } | undefined;
  expect(ev).toBeDefined();
  // P edits W's above-cutoff event (a P-produced change on an entity L never received)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  P.core.updateEvent(ev!.id, { title: "W-AFTER edited on P", description: "", startMs: ev!.start_ms, endMs: ev!.end_ms, allDay: false } as any);
  addEvent(P, "P-LATER");
  await dial(L, P);
  await dial(L, P);
  expect(count(L, "SELECT COUNT(*) AS n FROM quarantine")).toBe(0);
  expect(titles(L)).toContain("P-LATER");
  const pSeq = (P.core.db.prepare("SELECT MAX(local_seq) AS n FROM changes WHERE device_id=?").get(P.identity.deviceId) as { n: number }).n;
  const lApplied = (L.core.db.prepare("SELECT applied_through AS n FROM applied_upto WHERE producer_device_id=?").get(P.identity.deviceId) as { n: number }).n;
  expect(lApplied).toBe(pSeq);
  // record what L shows for the entity (informational for the report)
  const onL = L.core.db.prepare("SELECT title FROM events WHERE event_id=?").get(ev!.id) as { title: string } | undefined;
  console.error(`[dc27-test] TR-8 edit-on-P: L row for the W-AFTER entity = ${JSON.stringify(onL ?? null)}`);
});

test("TR-5/V4 cutoff moved while signing: unpair re-signs with the new cutoff; a cutoff that never settles fails ERR_BUSY with nothing stored", async () => {
  const L = makeDev("L");
  const W = makeDev("W");
  const P = makeDev("P");
  pairAll(L, W, P);
  const bump = (id: string) =>
    L.core.db
      .prepare(
        `INSERT INTO applied_upto VALUES (?, 1)
         ON CONFLICT(producer_device_id) DO UPDATE SET applied_through = applied_through + 1`,
      )
      .run(id);
  // once: a session applies one more W change while the record is being signed
  let calls = 0;
  const once = await unpairLocal(L.core.db, {
    deviceId: W.identity.deviceId,
    selfDeviceId: L.identity.deviceId,
    privateKey: L.identity.privateKey,
    hlcNow: () => {
      if (calls++ === 0) void Promise.resolve().then(() => bump(W.identity.deviceId));
      return Date.now() + calls;
    },
  });
  expect(once).toMatchObject({ already: false, cutoff: 1 });
  expect(storedRecord(L).record.revoked_after_seq).toBe(1);
  // always: bounded retries, then ERR_BUSY and no partial change
  const before = dump(L, TRUST_TABLES);
  await expect(
    unpairLocal(L.core.db, {
      deviceId: P.identity.deviceId,
      selfDeviceId: L.identity.deviceId,
      privateKey: L.identity.privateKey,
      hlcNow: () => {
        void Promise.resolve().then(() => bump(P.identity.deviceId));
        return Date.now();
      },
    }),
  ).rejects.toThrow(/^ERR_BUSY/);
  const after = JSON.parse(dump(L, TRUST_TABLES)) as Record<string, unknown>;
  const b = JSON.parse(before) as Record<string, unknown>;
  for (const t of TRUST_TABLES) expect(after[t]).toEqual(b[t]);
  expect(statusOf(L, P)).toBe("trusted");
});

test("TR-10 a local unpair ends a live session with the removed device at once", { timeout: 30_000 }, async () => {
  const L = makeDev("L");
  const W = makeDev("W");
  pairAll(L, W);
  await listen(L);
  // W connects and stays silent: L's engine waits for HELLO (idle bound 15 s)
  const s = await connectSync(W.identity.privateKey, "127.0.0.1", L.port);
  await waitFor(() => L.mgr.liveSessionCount(W.identity.deviceId) === 1);
  const t0 = Date.now();
  await L.mgr.unpairDevice(W.identity.deviceId, true);
  await waitFor(() => L.mgr.liveSessionCount(W.identity.deviceId) === 0, 3_000);
  // W sees L's HELLO (sent before the unpair), then the connection end
  const got: Array<string | null> = [];
  for (let i = 0; i < 5; i++) {
    const m = await s.transport.receive();
    got.push(m === null ? null : m.type);
    if (m === null) break;
  }
  expect(got).toEqual(["HELLO", null]);
  expect(Date.now() - t0).toBeLessThan(3_000);
  s.done();
});

// ---------------------------------------------------------------------------
// TR-9  cleanup
// ---------------------------------------------------------------------------

test("TR-9 unpair clears block/tally rows, Tier-1 state, endpoints, and every dial list", async () => {
  const L = makeDev("L");
  const W = makeDev("W");
  const P = makeDev("P");
  pairAll(L, W, P);
  const w = W.identity.deviceId;
  L.core.db.prepare("UPDATE peers SET last_endpoint_host='10.0.0.9', last_endpoint_port=47471, last_endpoint_seen=5").run();
  L.core.db.prepare("INSERT INTO hard_blocks VALUES (?, 1, 2, 3)").run(w);
  L.core.db.prepare("INSERT INTO peer_invalid_tally VALUES (?, 7, 8)").run(w);
  for (let i = 0; i < 600 && L.mgr.misbehavior.getState(w).level === 0; i++) L.mgr.misbehavior.recordInvalid(w);
  expect(L.mgr.misbehavior.getState(w).level).toBeGreaterThan(0);
  const dispatch = makeSyncDispatcher(L.mgr, L.core, { endpointCache: new EndpointCache() });
  L.mgr.urgentPush = () => {}; // no network in this test
  await dispatch("unpair_device", { device_id: w, confirm: true });
  expect(count(L, "SELECT COUNT(*) AS n FROM hard_blocks WHERE producer_device_id=?", w)).toBe(0);
  expect(count(L, "SELECT COUNT(*) AS n FROM peer_invalid_tally WHERE producer_device_id=?", w)).toBe(0);
  expect(L.mgr.misbehavior.knownPeers()).not.toContain(w);
  expect(L.mgr.misbehavior.getState(w).level).toBe(0);
  const row = L.core.db.prepare("SELECT last_endpoint_host h, last_endpoint_port p, last_endpoint_seen s FROM peers WHERE device_id=?").get(w);
  expect(row).toEqual({ h: null, p: null, s: null });
  // P's endpoint is untouched
  expect(listTrustedPeers(L.core.db).map((p) => p.device_id)).toEqual([P.identity.deviceId]);
  // Sync now dial list (the shell fans out over sync_endpoints)
  const eps = (dispatch("sync_endpoints", {}) as { endpoints: Array<{ device_id: string }> }).endpoints;
  expect(eps.map((e) => e.device_id)).toEqual([P.identity.deviceId]);
  // Paired Devices list
  const listed = (dispatch("list_paired_devices", {}) as { devices: Array<{ device_id: string }> }).devices;
  expect(listed.map((d) => d.device_id)).not.toContain(w);
  // The DC-21 prefilter and the scheduler's dial list are both built from
  // listTrustedPeers in main() (static check of the composition root).
  const src = readFileSync(join(__dirname, "../src/persistence/bridges/sidecar_server.ts"), "utf8");
  expect(src).toMatch(/const pairedDeviceIds = \(\): string\[\] =>\s*listTrustedPeers\(core\.db\)/);
  expect(src).toMatch(/listPeers: \(\) => \{\s*(?:\/\/[^\n]*\n\s*)*const peers = listTrustedPeers\(core\.db\);/);
});

// ---------------------------------------------------------------------------
// TR-10  mid-session cutoff
// ---------------------------------------------------------------------------

test("TR-10 a valid record naming the current peer ends the session with no further messages", { timeout: 30_000 }, async () => {
  const X = makeDev("X");
  const Y = makeDev("Y");
  const Z = makeDev("Z"); // trusted by X; signs a record revoking Y
  pairAll(X, Y, Z);
  addEvent(Y, "Y1");
  const signed = await createRevocation(
    { revoked_device_id: Y.identity.deviceId, revoked_by_device_id: Z.identity.deviceId, revoked_at_hlc: Date.now(), revoked_after_seq: 0 },
    Z.identity.privateKey,
  );
  // Y runs a raw engine whose channel (non-conformingly) queues the record
  // naming Y itself: the only way the record can reach X inside a session
  // WITH Y (DC-10 §2.1 never queues it to Y).
  const yHost = await serveSync(Y.identity.privateKey, 0, (s) => {
    const eng = createSyncEngine({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: Y.core.db as any,
      selfDeviceId: Y.identity.deviceId,
      mutateEntity: makeEntityMutator(),
      peerDeviceId: X.identity.deviceId,
      revocations: {
        queueFor: () => [signed],
        acceptInbound: async () => false,
        acceptedTriples: () => [],
        recordAck: () => {},
      },
    });
    void eng.runSession(s.transport).catch(() => undefined).finally(() => s.done());
  });
  try {
    const s = await connectSync(X.identity.privateKey, "127.0.0.1", yHost.actualPort);
    const sentWhileRevoked: string[] = [];
    const t = tap(s, (m) => {
      if (statusOf(X, Y) === "revoked") sentWhileRevoked.push(m.type);
    });
    const res = (await X.mgr.runEngineSession(t.session, Y.identity.deviceId)) as { peerRevoked?: boolean };
    expect(res.peerRevoked).toBe(true);
    expect(statusOf(X, Y)).toBe("revoked");
    expect(sentWhileRevoked).toEqual([]);
    expect(t.sent).not.toContain("REVOCATIONS_ACK");
    expect(titles(X)).not.toContain("Y1");
    // no endpoint recorded for a peer revoked mid-session
    const row = X.core.db.prepare("SELECT last_endpoint_host h FROM peers WHERE device_id=?").get(Y.identity.deviceId) as { h: string | null };
    expect(row.h).toBeNull();
  } finally {
    yHost.close();
  }
});

// ---------------------------------------------------------------------------
// TR-11  same-id re-pair refused (P10)
// ---------------------------------------------------------------------------

describe("TR-11 same-id re-pair refused", () => {
  test("TR-11 L shows the code, removed W scans it: refused, nothing stored, row stays revoked", { timeout: 30_000 }, async () => {
    const L = makeDev("L");
    const W = makeDev("W");
    pairAll(L, W);
    await L.mgr.unpairDevice(W.identity.deviceId, true);
    const before = dump(L, TRUST_TABLES);
    const offer = await createPairingOffer({ identity: L.identity, store: sqlPeerStore(L.core.db), name: "L" });
    const offerResult = offer.result.then(
      () => "resolved",
      (e: unknown) => e,
    );
    await expect(
      acceptPairingPayload({ identity: W.identity, qrText: offer.qrText, store: sqlPeerStore(W.core.db), name: "W" }),
    ).rejects.toThrow(REVOKED_REPAIR_MESSAGE);
    expect(await offerResult).toBeInstanceOf(PairingRefusedError);
    expect(dump(L, TRUST_TABLES)).toBe(before);
    expect(statusOf(L, W)).toBe("revoked");
  });

  test("TR-11 removed W shows the code, L scans it: refused before connecting", { timeout: 30_000 }, async () => {
    const L = makeDev("L");
    const W = makeDev("W");
    pairAll(L, W);
    await L.mgr.unpairDevice(W.identity.deviceId, true);
    const before = dump(L, TRUST_TABLES);
    const offer = await createPairingOffer({ identity: W.identity, store: sqlPeerStore(W.core.db), name: "W" });
    try {
      await expect(
        acceptPairingPayload({ identity: L.identity, qrText: offer.qrText, store: sqlPeerStore(L.core.db), name: "L" }),
      ).rejects.toBeInstanceOf(PairingRefusedError);
    } finally {
      offer.cancel();
      await offer.result.catch(() => undefined);
    }
    expect(dump(L, TRUST_TABLES)).toBe(before);
  });

  test("TR-11 a device that only holds the record (no peers row) refuses the old id; the store never un-revokes", async () => {
    const L = makeDev("L");
    const W = makeDev("W");
    const T = makeDev("T"); // paired with L after the unpair, learned the record
    pairAll(L, W);
    await L.mgr.unpairDevice(W.identity.deviceId, true);
    addPeer(T, L);
    addPeer(L, T);
    await listen(L);
    await dial(T, L);
    expect(isKnownRevoked(T.core.db, W.identity.deviceId)).toBe(true);
    const store = sqlPeerStore(T.core.db);
    expect(store.isRevoked!(W.identity.deviceId)).toBe(true);
    expect(() =>
      store.store({ deviceId: W.identity.deviceId, publicKey: Buffer.from(W.identity.publicKey), displayName: "W", pairedAtMs: Date.now() }),
    ).toThrow(PairingRefusedError);
    expect(statusOf(T, W)).toBeUndefined();
    // and on L the revoked row can never be flipped back by the upsert
    expect(() =>
      sqlPeerStore(L.core.db).store({ deviceId: W.identity.deviceId, publicKey: Buffer.from(W.identity.publicKey), displayName: "W", pairedAtMs: Date.now() }),
    ).toThrow(PairingRefusedError);
    expect(statusOf(L, W)).toBe("revoked");
  });
});

// ---------------------------------------------------------------------------
// TR-12  fresh-start re-pair (Path B)
// ---------------------------------------------------------------------------

test("TR-12 W started on a renamed data folder pairs with L under a new id and receives ALL of L's events, also a third device paired after the unpair", { timeout: 60_000 }, async () => {
  const L = makeDev("L");
  const W = makeDev("W");
  pairAll(L, W);
  addEvent(L, "L1");
  addEvent(W, "OLD-W-1");
  addEvent(W, "OLD-W-2");
  await listen(L);
  await dial(W, L);
  const oldId = W.identity.deviceId;
  await L.mgr.unpairDevice(oldId, true);

  // Path B step 2-4: quit W, rename its data folder, start fresh at the
  // same path.
  W.mgr.closeListener();
  W.core.db.close();
  live.splice(live.indexOf(W), 1);
  renameSync(W.dir, W.dir + ".old");
  const W2 = makeDev("W", W.dir);
  expect(W2.identity.deviceId).not.toBe(oldId);
  expect(titles(W2)).toEqual([]);

  // Step 5: real pairing ceremony (L shows the code, fresh W scans it).
  const offer = await createPairingOffer({ identity: L.identity, store: sqlPeerStore(L.core.db), name: "L" });
  await acceptPairingPayload({ identity: W2.identity, qrText: offer.qrText, store: sqlPeerStore(W2.core.db), name: "W" });
  await offer.result;
  expect(statusOf(L, W2)).toBe("trusted");
  expect(L.core.db.prepare("SELECT status FROM peers WHERE device_id=?").get(oldId)).toEqual({ status: "revoked" });

  await dial(W2, L);
  expect(titles(W2)).toEqual(titles(L));
  expect(titles(W2)).toEqual(["L1", "OLD-W-1", "OLD-W-2"]);
  expect(isKnownRevoked(W2.core.db, oldId)).toBe(true);

  // a third device paired with L after the unpair
  const T = makeDev("T");
  addPeer(T, L);
  addPeer(L, T);
  await dial(T, L);
  expect(titles(T)).toEqual(["L1", "OLD-W-1", "OLD-W-2"]);
});

// ---------------------------------------------------------------------------
// TR-13  ACK durability
// ---------------------------------------------------------------------------

test("TR-13 after a restart, a record already ACKed by P is not sent to P again", { timeout: 60_000 }, async () => {
  const L = makeDev("L");
  const W = makeDev("W");
  const P = makeDev("P");
  pairAll(L, W, P);
  await L.mgr.unpairDevice(W.identity.deviceId, true);
  await listen(L);
  const s1 = await connectSync(P.identity.privateKey, "127.0.0.1", L.port);
  const t1 = tap(s1);
  await P.mgr.runEngineSession(t1.session);
  await sleep(200);
  expect(t1.received).toContain("REVOCATION_RECORDS");
  expect(count(L, "SELECT COUNT(*) AS n FROM revocation_acks WHERE peer_device_id=?", P.identity.deviceId)).toBe(1);

  // restart L
  L.mgr.closeListener();
  L.core.db.close();
  live.splice(live.indexOf(L), 1);
  const L2 = makeDev("L", L.dir);
  expect(L2.identity.deviceId).toBe(L.identity.deviceId);
  const ch = makeDbRevocationChannel(L2.core.db, {
    selfDeviceId: L2.identity.deviceId,
    selfPublicKey: L2.identity.publicKey,
    hlcNow: () => L2.core.hlcNow(),
  });
  expect(ch.queueFor(P.identity.deviceId)).toEqual([]);
  await listen(L2);
  const s2 = await connectSync(P.identity.privateKey, "127.0.0.1", L2.port);
  const t2 = tap(s2);
  await P.mgr.runEngineSession(t2.session);
  expect(t2.received).not.toContain("REVOCATION_RECORDS");
});

// ---------------------------------------------------------------------------
// TR-14  logging
// ---------------------------------------------------------------------------

test("TR-14 unpair / accept / reject / refusal log lines carry short ids only (runtime)", { timeout: 60_000 }, async () => {
  const lines: string[] = [];
  const spy = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
    lines.push(a.map(String).join(" "));
  });
  try {
    const L = makeDev("Linux PC");
    const W = makeDev("Windows PC");
    const P = makeDev("Phone");
    pairAll(L, W, P);
    await listen(L);
    await listen(P);
    await L.mgr.unpairDevice(W.identity.deviceId, true); // unpair line
    await L.mgr.unpairDevice(W.identity.deviceId, true); // already line
    await dial(P, L); // accept line on P
    // reject: a record signed by the now-revoked W, offered to P
    const forged = await createRevocation(
      { revoked_device_id: L.identity.deviceId, revoked_by_device_id: W.identity.deviceId, revoked_at_hlc: Date.now(), revoked_after_seq: 0 },
      W.identity.privateKey,
    );
    const ch = makeDbRevocationChannel(P.core.db, { selfDeviceId: P.identity.deviceId, selfPublicKey: P.identity.publicKey, hlcNow: () => Date.now() });
    expect(await ch.acceptInbound(forged, W.identity.deviceId)).toBe(false);
    // refusal at L's gate
    const s = await connectSync(W.identity.privateKey, "127.0.0.1", L.port);
    await W.mgr.runEngineSession(s).catch(() => undefined);
    await sleep(300);

    const relevant = lines.filter((l) => /unpair:|revocation:|sync refused/.test(l));
    expect(relevant.some((l) => /unpair: d-[0-9a-f]{14}… revoked; record stored; telling 1 peers/.test(l))).toBe(true);
    expect(relevant.some((l) => /unpair: d-[0-9a-f]{14}… already revoked; no-op/.test(l))).toBe(true);
    expect(relevant.some((l) => /revocation: accepted record for d-[0-9a-f]{14}… from d-[0-9a-f]{14}…/.test(l))).toBe(true);
    expect(relevant.some((l) => /revocation: rejected record \(revoker_not_trusted\) from d-[0-9a-f]{14}…/.test(l))).toBe(true);
    expect(relevant.some((l) => /sync refused: DENY_REVOKED d-[0-9a-f]{14}…/.test(l))).toBe(true);
    const secrets = [L, W, P].flatMap((d) => [
      d.identity.deviceId,
      Buffer.from(d.identity.publicKey).toString("hex"),
      Buffer.from(d.identity.publicKey).toString("base64"),
      Buffer.from(d.identity.privateKey).toString("hex"),
      d.label,
    ]);
    for (const l of relevant) {
      for (const sec of secrets) expect(l).not.toContain(sec);
      expect(l).not.toMatch(/[0-9a-f]{32,}/i); // no key / signature / record bytes
      expect(l).not.toMatch(/127\.0\.0\.1/); // no addresses at info level
    }
  } finally {
    spy.mockRestore();
  }
});

test("TR-14 static: every DC-27 log line interpolates only short ids, codes and counts", () => {
  const files = ["../src/security/revocation_store.ts", "../src/persistence/bridges/sidecar_server.ts"];
  const allowed = /^(shortDeviceId\([^)]*\)|from|code|peersToTell|verdict\.reason|decision|clean|extra|deviceId !== undefined \? " " \+ shortDeviceId\(deviceId\) : "")$/;
  let checked = 0;
  for (const f of files) {
    const src = readFileSync(join(__dirname, f), "utf8");
    // template literals that form one of the §4.12 log lines
    const re = /`([^`]*(?:unpair:|revocation:|sync refused)[^`]*)`/g;
    for (const m of src.matchAll(re)) {
      // DC-27 line plus the continuation template on the next line(s)
      const start = m.index!;
      const stmt = src.slice(start, src.indexOf(";", start));
      for (const i of stmt.matchAll(/\$\{([^}]*(?:\([^)]*\))?[^}]*)\}/g)) {
        expect(i[1]!.trim(), `${f}: ${stmt}`).toMatch(allowed);
      }
      checked++;
    }
  }
  expect(checked).toBeGreaterThanOrEqual(6);
});

// ---------------------------------------------------------------------------
// TR-15  owner acceptance rehearsal (the real check is the two-machine
// smoke test; this only rehearses its script on one machine)
// ---------------------------------------------------------------------------

test("TR-15 rehearsal: unpair W on L, W can no longer sync, L keeps all appointments, W fresh start + pair works", { timeout: 60_000 }, async () => {
  const L = makeDev("Linux PC");
  const W = makeDev("Windows PC");
  pairAll(L, W);
  addEvent(L, "Dentist");
  addEvent(W, "Team call");
  await listen(L);
  await listen(W);
  await dial(W, L);
  const all = titles(L);
  await L.mgr.unpairDevice(W.identity.deviceId, true);
  addEvent(W, "After unpair");
  const s = await connectSync(W.identity.privateKey, "127.0.0.1", L.port);
  await expect(W.mgr.runEngineSession(s)).rejects.toBeInstanceOf(PeerClosedBeforeHelloError);
  // V8 / P6: W can tell "refused after handshake" apart and shows the hint.
  expect(W.mgr.peerStateSnapshot().find((p) => p.device_id === L.identity.deviceId)?.refused_us).toBe(true);
  expect(titles(L)).toEqual(all);
  W.mgr.closeListener();
  W.core.db.close();
  live.splice(live.indexOf(W), 1);
  renameSync(W.dir, W.dir + ".old");
  const W2 = makeDev("Windows PC", W.dir);
  const offer = await createPairingOffer({ identity: L.identity, store: sqlPeerStore(L.core.db), name: "Linux PC" });
  await acceptPairingPayload({ identity: W2.identity, qrText: offer.qrText, store: sqlPeerStore(W2.core.db), name: "Windows PC" });
  await offer.result;
  await dial(W2, L);
  expect(titles(W2)).toEqual(all);
});

// ---------------------------------------------------------------------------
// V8  "closed after handshake" vs "unreachable" over real TCP
// ---------------------------------------------------------------------------

test("V8 a refused dial surfaces as PeerClosedBeforeHelloError every time; an unreachable peer fails at connect", { timeout: 60_000 }, async () => {
  const L = makeDev("L");
  const W = makeDev("W");
  pairAll(L, W);
  addEvent(W, "W1");
  await listen(L);
  await L.mgr.unpairDevice(W.identity.deviceId, true);
  for (let i = 0; i < 10; i++) {
    const s = await connectSync(W.identity.privateKey, "127.0.0.1", L.port);
    await expect(W.mgr.runEngineSession(s)).rejects.toBeInstanceOf(PeerClosedBeforeHelloError);
  }
  expect(W.mgr.peerStateSnapshot().find((p) => p.device_id === L.identity.deviceId)?.refused_us).toBe(true);
  // unreachable: no TCP connect at all -> a different error, before any session
  await expect(connectSync(W.identity.privateKey, "127.0.0.1", 1)).rejects.toThrow(/ECONNREFUSED/);
});

// ---------------------------------------------------------------------------
// V11  how a build without the cutoff field treats a new record
// ---------------------------------------------------------------------------

test("V11 a validator that drops unknown keys (pre-DC-27 builds) fails the signature of a cutoff record", async () => {
  const L = makeDev("L");
  const W = makeDev("W");
  const P = makeDev("P");
  pairAll(L, W, P);
  await L.mgr.unpairDevice(W.identity.deviceId, true);
  const { record, signature } = storedRecord(L);
  // the pre-DC-27 validateRevocationRecord rebuilt the record from the four
  // known fields only (git show 382b023:src/security/revocation.ts)
  const oldView = {
    v: 1 as const,
    revoked_device_id: record.revoked_device_id,
    revoked_by_device_id: record.revoked_by_device_id,
    revoked_at_hlc: record.revoked_at_hlc,
  };
  const verdict = await verifyRevocation({ record: oldView, signature }, dbTrustLookup(P.core.db));
  expect(verdict).toEqual({ valid: false, reason: "bad_signature" });
});

// ---------------------------------------------------------------------------
// Schema v9 migration (DC-07 Appendix X.1, DC-05 Appendix A)
// ---------------------------------------------------------------------------

describe("schema v9 migration", () => {
  const cols = (db: Database.Database, t: string) =>
    (db.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map((c) => c.name);

  function v8Copy(dir: string): string {
    const path = join(dir, "v8.db");
    const fresh = openDatabase({ path });
    fresh.close();
    const raw = new Database(path);
    raw.exec(`
      DROP TABLE revocation_acks;
      ALTER TABLE revocation_records DROP COLUMN revoked_after_seq;
      INSERT INTO revocation_records VALUES ('d-w','d-l',5,NULL,x'7b7d',x'00','valid',5);
      UPDATE schema_version SET version = 8;
    `);
    raw.close();
    return path;
  }

  test("a v8 database migrates to v9: cutoff column + ACK store, existing records kept", () => {
    const dir = mkdtempSync(join(root, "mig-"));
    const path = v8Copy(dir);
    const db = openDatabase({ path });
    try {
      expect(SCHEMA_VERSION).toBe(9);
      expect((db.prepare("SELECT version FROM schema_version").get() as { version: number }).version).toBe(9);
      expect(cols(db, "revocation_records")).toContain("revoked_after_seq");
      expect(cols(db, "revocation_acks")).toEqual([
        "peer_device_id",
        "revoked_device_id",
        "revoked_by_device_id",
        "revoked_at_hlc",
        "acked_at",
      ]);
      expect(db.prepare("SELECT revoked_device_id, revoked_after_seq FROM revocation_records").all()).toEqual([
        { revoked_device_id: "d-w", revoked_after_seq: null },
      ]);
    } finally {
      db.close();
    }
  });

  test("a v9-stamped database missing the pieces is repaired idempotently", () => {
    const dir = mkdtempSync(join(root, "mig-"));
    const path = v8Copy(dir);
    const raw = new Database(path);
    raw.exec("UPDATE schema_version SET version = 9");
    raw.close();
    for (let i = 0; i < 2; i++) {
      const db = openDatabase({ path });
      expect(cols(db, "revocation_records")).toContain("revoked_after_seq");
      expect(cols(db, "revocation_acks")).toContain("peer_device_id");
      expect(db.prepare("SELECT COUNT(*) AS n FROM revocation_records").get()).toEqual({ n: 1 });
      db.close();
    }
  });

  test("a fresh database has the v9 shape", () => {
    const dir = mkdtempSync(join(root, "mig-"));
    const db = openDatabase({ path: join(dir, "f.db") });
    try {
      expect(cols(db, "revocation_records")).toContain("revoked_after_seq");
      expect(cols(db, "revocation_acks")).toContain("acked_at");
    } finally {
      db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Review fixes 2026-11-14: guards proven by mutation (each test below fails
// when the named guard is removed) and the MINOR-2 / MINOR-4 fixes.
// ---------------------------------------------------------------------------

/** `producer`'s change records as stored on `d` (same shape fetchRanges serves). */
function changeRecords(d: Dev, producer: string): ChangeRecord[] {
  const rows = d.core.db
    .prepare(
      `SELECT change_id, device_id, local_seq, entity_id, entity_type, field_path,
              operation, payload, hlc_timestamp, causality_clock, schema_version
       FROM changes WHERE device_id = ? ORDER BY local_seq`,
    )
    .all(producer) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    ...(r as unknown as ChangeRecord),
    payload: JSON.parse(r.payload as string),
    causality_clock: JSON.parse(r.causality_clock as string),
  }));
}

const maxSeq = (d: Dev, producer: string): number =>
  (d.core.db.prepare("SELECT COALESCE(MAX(local_seq), 0) AS n FROM changes WHERE device_id=?").get(producer) as { n: number }).n;

const appliedThrough = (d: Dev, producer: string): number | undefined =>
  (d.core.db.prepare("SELECT applied_through AS n FROM applied_upto WHERE producer_device_id=?").get(producer) as { n: number } | undefined)?.n;

/** Read W's side of a raw session until a message of `type` arrives. */
async function readUntil(s: Awaited<ReturnType<typeof connectSync>>, type: string): Promise<string[]> {
  const seen: string[] = [];
  for (let i = 0; i < 20; i++) {
    const m = await s.transport.receive();
    seen.push(m === null ? "<closed>" : m.type);
    if (m === null || m.type === type) return seen;
  }
  return seen;
}

/** In-memory transport the test scripts message by message (engine-level tests). */
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

test("M5/M8 after unpair the removed peer's still-open sending side cannot apply anything, also records claiming a third device's id", { timeout: 30_000 }, async () => {
  const L = makeDev("L");
  const W = makeDev("W");
  const P = makeDev("P");
  pairAll(L, W, P);
  await listen(L);
  // P's genuine changes, never synced to L. Records of a NON-revoked
  // producer are not filtered by the per-record cutoff check, so only the
  // session-level guard in applyBatch can stop them.
  addEvent(P, "P-VIA-W");
  const pRecords = changeRecords(P, P.identity.deviceId);
  expect(pRecords.length).toBeGreaterThan(0);
  // W dials L and drives the protocol by hand up to L's barrier.
  const s = await connectSync(W.identity.privateKey, "127.0.0.1", L.port);
  await s.transport.send({ v: 1, type: "HELLO", device_clock: {} });
  expect(await readUntil(s, "CHANGES_ACK")).toContain("CHANGES_ACK");
  expect(L.mgr.liveSessionCount(W.identity.deviceId)).toBe(1);
  // L unpairs W. session.done() only ends L's sending side (sock.end());
  // L's engine still reads. W sends at once, before it processes L's FIN.
  await L.mgr.unpairDevice(W.identity.deviceId, true);
  await s.transport.send({ v: 1, type: "CHANGES_BATCH", changes: pRecords });
  await s.transport.send({ v: 1, type: "CHANGES_ACK", applied_upto: {} });
  await waitFor(() => L.mgr.liveSessionCount(W.identity.deviceId) === 0, 5_000);
  s.done();
  await sleep(100);
  expect(titles(L)).not.toContain("P-VIA-W");
  expect(count(L, "SELECT COUNT(*) AS n FROM changes WHERE device_id=?", P.identity.deviceId)).toBe(0);
  expect(count(L, "SELECT COUNT(*) AS n FROM pending_changes WHERE device_id=?", P.identity.deviceId)).toBe(0);
  expect(appliedThrough(L, P.identity.deviceId)).toBeUndefined();
});

/**
 * Engine level: L's engine in a session with W reaches its barrier, L
 * unpairs W (real unpairLocal), then W's next message is `inject(...)`.
 */
async function injectAfterUnpair(inject: (L: Dev, P: Dev) => SyncMessage) {
  const L = makeDev("L");
  const W = makeDev("W");
  const P = makeDev("P");
  pairAll(L, W, P);
  addEvent(L, "L-OWN");
  addEvent(P, "P-SNAP");
  const t = scriptedTransport();
  const engine = createSyncEngine({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db: L.core.db as any,
    selfDeviceId: L.identity.deviceId,
    mutateEntity: makeEntityMutator(),
    peerDeviceId: W.identity.deviceId,
    revocations: makeDbRevocationChannel(L.core.db, {
      selfDeviceId: L.identity.deviceId,
      selfPublicKey: L.identity.publicKey,
      hlcNow: () => L.core.hlcNow(),
      log: () => {},
    }),
  });
  const run = engine.runSession(t.transport);
  t.push({ v: 1, type: "HELLO", device_clock: {} });
  await waitFor(() => t.sent.some((m) => m.type === "CHANGES_ACK"));
  await unpairLocal(L.core.db, {
    deviceId: W.identity.deviceId,
    selfDeviceId: L.identity.deviceId,
    privateKey: L.identity.privateKey,
    hlcNow: () => L.core.hlcNow(),
  });
  const before = t.sent.length;
  t.push(inject(L, P));
  t.push({ v: 1, type: "CHANGES_ACK", applied_upto: {} });
  t.push(null);
  const stats = (await run) as { peerRevoked?: boolean };
  return { L, P, stats, sentAfter: t.sent.slice(before).map((m) => m.type) };
}

test("M8 engine level: once the peer is revoked mid-session, its CHANGES_REQUEST is not served", { timeout: 30_000 }, async () => {
  const { stats, sentAfter } = await injectAfterUnpair((L) => ({
    v: 1,
    type: "CHANGES_REQUEST",
    ranges: [{ device_id: L.identity.deviceId, lo: 1, hi: maxSeq(L, L.identity.deviceId) }],
  }));
  expect(sentAfter).toEqual([]);
  expect(stats.peerRevoked).toBe(true);
});

test("M8 engine level: once the peer is revoked mid-session, its FULL_STATE_SNAPSHOT is not applied", { timeout: 30_000 }, async () => {
  const { L, stats } = await injectAfterUnpair((_L, P) => {
    const chunks: Array<{ snapshot_clock: Record<string, number>; entities: unknown[]; tombstones: unknown[] }> = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    buildSnapshot(P.core.db, (c) => chunks.push(c as any));
    const c = chunks[0]!;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { v: 1, type: "FULL_STATE_SNAPSHOT", snapshot_clock: c.snapshot_clock, entities: c.entities, tombstones: c.tombstones, final: true } as any;
  });
  expect(titles(L)).toEqual(["L-OWN"]);
  expect(stats.peerRevoked).toBe(true);
});

test("M7 a record signed by W is refused when L's unpair of W commits while the record is being verified", async () => {
  const L = makeDev("L");
  const W = makeDev("W");
  const P = makeDev("P");
  pairAll(L, W, P);
  const signed = await createRevocation(
    { revoked_device_id: P.identity.deviceId, revoked_by_device_id: W.identity.deviceId, revoked_at_hlc: Date.now(), revoked_after_seq: 0 },
    W.identity.privateKey,
  );
  const ch = makeDbRevocationChannel(L.core.db, {
    selfDeviceId: L.identity.deviceId,
    selfPublicKey: L.identity.publicKey,
    hlcNow: () => L.core.hlcNow(),
    log: () => {},
  });
  // verifyRevocation looks the revoker up synchronously (W: trusted), then
  // awaits the signature check. The status flip below stands in for L's
  // unpair of W committing during that await (deterministic; racing a real
  // unpairLocal would be signing versus verifying).
  const pending = ch.acceptInbound(signed, W.identity.deviceId);
  L.core.db.prepare("UPDATE peers SET status='revoked' WHERE device_id=?").run(W.identity.deviceId);
  expect(await pending).toBe(false);
  expect(count(L, "SELECT COUNT(*) AS n FROM revocation_records WHERE revoked_by_device_id=?", W.identity.deviceId)).toBe(0);
  expect(statusOf(L, P)).toBe("trusted");
  expect(isKnownRevoked(L.core.db, P.identity.deviceId)).toBe(false);
});

/** L applies `recs` through the real T2 path (applied or buffered). */
function deliver(L: Dev, recs: ChangeRecord[]): string[] {
  const k = loadKnowledgeFromDb(L.core.db);
  return recs.map((r) => applyRemoteChange(L.core.db, r, k, makeEntityMutator()));
}

test("M10 an accepted inbound record deletes the producer's buffered changes above its cutoff; a later gap fill does not drain them", { timeout: 60_000 }, async () => {
  const L = makeDev("L");
  const W = makeDev("W");
  const P = makeDev("P");
  pairAll(L, W, P);
  await listen(P);
  const w = W.identity.deviceId;
  addEvent(W, "W-1");
  const a1 = maxSeq(W, w);
  addEvent(W, "W-2");
  const a2 = maxSeq(W, w);
  await dial(W, P); // P holds W through a2
  await P.mgr.unpairDevice(w, true); // P's record: cutoff a2
  expect(storedRecord(P).record.revoked_after_seq).toBe(a2);
  addEvent(W, "W-3");
  const all = changeRecords(W, w);
  // L applied W through a1 and buffered W-3 (gap a1+1..a2)
  expect(deliver(L, all.filter((r) => r.local_seq <= a1)).every((o) => o === "applied")).toBe(true);
  expect(deliver(L, all.filter((r) => r.local_seq > a2)).every((o) => o === "buffered")).toBe(true);
  expect(count(L, "SELECT COUNT(*) AS n FROM pending_changes WHERE device_id=? AND local_seq > ?", w, a2)).toBeGreaterThan(0);
  // L accepts P's record (the inbound path)
  const ch = makeDbRevocationChannel(L.core.db, {
    selfDeviceId: L.identity.deviceId,
    selfPublicKey: L.identity.publicKey,
    hlcNow: () => L.core.hlcNow(),
    log: () => {},
  });
  const rec = storedRecord(P);
  expect(await ch.acceptInbound({ record: rec.record, signature: rec.signature }, P.identity.deviceId)).toBe(true);
  expect(count(L, "SELECT COUNT(*) AS n FROM pending_changes WHERE device_id=? AND local_seq > ?", w, a2)).toBe(0);
  // gap fill a1+1..a2 (at or below the cutoff) arrives from P in a real session
  await dial(L, P);
  expect(appliedThrough(L, w)).toBe(a2);
  expect(titles(L)).toEqual(["W-1", "W-2"]);
  expect(count(L, "SELECT COUNT(*) AS n FROM changes WHERE device_id=? AND local_seq > ?", w, a2)).toBe(0);
});

test("M11 a local unpair deletes the removed device's buffered changes above the cutoff in the same commit; none apply afterwards", { timeout: 60_000 }, async () => {
  const L = makeDev("L");
  const W = makeDev("W");
  const P = makeDev("P");
  pairAll(L, W, P);
  await listen(P);
  const w = W.identity.deviceId;
  addEvent(W, "W-1");
  const a1 = maxSeq(W, w);
  addEvent(W, "W-2");
  const a2 = maxSeq(W, w);
  addEvent(W, "W-3");
  await dial(W, P); // an unaware P holds all of W
  const all = changeRecords(W, w);
  deliver(L, all.filter((r) => r.local_seq <= a1));
  expect(deliver(L, all.filter((r) => r.local_seq > a2)).every((o) => o === "buffered")).toBe(true);
  const buffered = count(L, "SELECT COUNT(*) AS n FROM pending_changes WHERE device_id=?", w);
  expect(buffered).toBeGreaterThan(0);
  let seenInsideTx = -1;
  const out = await unpairLocal(L.core.db, {
    deviceId: w,
    selfDeviceId: L.identity.deviceId,
    privateKey: L.identity.privateKey,
    hlcNow: () => L.core.hlcNow(),
    beforeCommit: () => {
      seenInsideTx = count(L, "SELECT COUNT(*) AS n FROM pending_changes WHERE device_id=?", w);
    },
  });
  expect(out).toMatchObject({ already: false, cutoff: a1 });
  expect(seenInsideTx).toBe(0); // gone in the unpair transaction itself
  expect(count(L, "SELECT COUNT(*) AS n FROM pending_changes WHERE device_id=?", w)).toBe(0);
  // later sessions with the unaware P: nothing of W above the cutoff applies
  await dial(L, P);
  await dial(L, P);
  expect(titles(L)).toEqual(["W-1"]);
  expect(appliedThrough(L, w)).toBe(a1);
  expect(count(L, "SELECT COUNT(*) AS n FROM pending_changes WHERE device_id=?", w)).toBe(0);
});

test("MINOR-2 a revocation accepted from another device clears the same per-peer state as a local unpair", { timeout: 30_000 }, async () => {
  const X = makeDev("X");
  const Y = makeDev("Y");
  const Z = makeDev("Z");
  pairAll(X, Y, Z);
  await listen(Z);
  const y = Y.identity.deviceId;
  X.core.db.prepare("UPDATE peers SET last_endpoint_host='10.0.0.9', last_endpoint_port=47471, last_endpoint_seen=5").run();
  X.core.db.prepare("INSERT INTO hard_blocks VALUES (?, 1, 2, 3)").run(y);
  X.core.db.prepare("INSERT INTO peer_invalid_tally VALUES (?, 7, 8)").run(y);
  for (let i = 0; i < 600 && X.mgr.misbehavior.getState(y).level === 0; i++) X.mgr.misbehavior.recordInvalid(y);
  expect(X.mgr.misbehavior.getState(y).level).toBeGreaterThan(0);
  await Z.mgr.unpairDevice(y, true);
  await dial(X, Z); // X learns Z's record in an ordinary session
  expect(statusOf(X, Y)).toBe("revoked");
  expect(count(X, "SELECT COUNT(*) AS n FROM hard_blocks WHERE producer_device_id=?", y)).toBe(0);
  expect(count(X, "SELECT COUNT(*) AS n FROM peer_invalid_tally WHERE producer_device_id=?", y)).toBe(0);
  expect(X.mgr.misbehavior.getState(y).level).toBe(0);
  const row = X.core.db.prepare("SELECT last_endpoint_host h, last_endpoint_port p, last_endpoint_seen s FROM peers WHERE device_id=?").get(y);
  expect(row).toEqual({ h: null, p: null, s: null });
  // Z's endpoint is untouched
  const zRow = X.core.db.prepare("SELECT last_endpoint_host h FROM peers WHERE device_id=?").get(Z.identity.deviceId) as { h: string | null };
  expect(zRow.h).toBe("10.0.0.9");
});

test("MINOR-4 an inbound dialer that hangs up before HELLO is not marked as refusing us", { timeout: 30_000 }, async () => {
  const L = makeDev("L");
  const W = makeDev("W");
  pairAll(L, W);
  await listen(L);
  const spy = vi.spyOn(L.mgr, "runEngineSession");
  const s = await connectSync(W.identity.privateKey, "127.0.0.1", L.port);
  s.done(); // W hangs up right after the handshake
  await waitFor(() => spy.mock.results.length > 0);
  const err = await (spy.mock.results[0]!.value as Promise<unknown>).then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(PeerClosedBeforeHelloError);
  expect(L.mgr.peerStateSnapshot().find((p) => p.device_id === W.identity.deviceId)?.refused_us ?? false).toBe(false);
  spy.mockRestore();
});

// ---------------------------------------------------------------------------
// TD-041: a DC-09 full-state snapshot and the revoked-producer cutoff
// ---------------------------------------------------------------------------

describe("TD-041 snapshot vs revoked-producer cutoff", () => {
  /**
   * L unpairs W (cutoff = W's seq applied on L). W keeps writing and its
   * above-cutoff changes reach the unaware P (DC-27 §4.4: P keeps them).
   * P then learns the record in an ordinary session with L. Returns the
   * three devices, the cutoff and the id of W's above-cutoff event.
   */
  async function setup() {
    const L = makeDev("L");
    const W = makeDev("W");
    const P = makeDev("P");
    pairAll(L, W, P);
    await listen(L);
    await listen(P);
    addEvent(W, "W-BEFORE");
    await dial(W, L);
    await dial(W, P);
    await L.mgr.unpairDevice(W.identity.deviceId, true);
    const cutoff = storedRecord(L).record.revoked_after_seq!;
    addEvent(W, "W-AFTER");
    await dial(W, P); // P is unaware: applies W-AFTER
    await dial(L, P); // P learns the record; L rejects W-AFTER (TR-8)
    expect(statusOf(P, W)).toBe("revoked");
    expect(isKnownRevoked(L.core.db, W.identity.deviceId)).toBe(true);
    expect(titles(L)).not.toContain("W-AFTER");
    expect(titles(P)).toContain("W-AFTER");
    const wAfterId = (P.core.db.prepare("SELECT event_id AS id FROM events WHERE title='W-AFTER'").get() as { id: string }).id;
    return { L, W, P, cutoff, wAfterId };
  }

  function snapshotOf(d: Dev): Snapshot {
    const chunks: Snapshot[] = [];
    buildSnapshot(d.core.db, (s) => chunks.push(s));
    return {
      snapshot_clock: chunks[0]!.snapshot_clock,
      entities: chunks.flatMap((c) => c.entities),
      tombstones: chunks.flatMap((c) => c.tombstones),
    };
  }

  // TD-041 OPEN (PROVEN): fails today; flips to a hard failure once a rule
  // from DC-27 Appendix B lands. Then turn test.fails back into test.
  test.fails("TD-041 repro: a snapshot from P delivers W's above-cutoff event onto L, which holds W's revocation record", { timeout: 60_000 }, async () => {
    const { L, W, P, cutoff, wAfterId } = await setup();
    const snap = snapshotOf(P);
    const entry = snap.entities.find((e) => e.entity_id === wAfterId)!;
    console.error(
      `[td041] cutoff=${cutoff} entry.producer=${entry.producer_device_id === W.identity.deviceId ? "W" : "other"} ` +
        `entry.producer_seq=${entry.producer_seq} entry.clock[W]=${entry.causality_clock[W.identity.deviceId]} ` +
        `snapshot_clock[W]=${snap.snapshot_clock[W.identity.deviceId]}`,
    );
    applySnapshot(L.core.db, snap, loadKnowledgeFromDb(L.core.db));
    const lApplied = appliedThrough(L, W.identity.deviceId) ?? 0;
    console.error(`[td041] after snapshot: L titles=${JSON.stringify(titles(L))} L applied_upto[W]=${lApplied}`);
    // DC-27 TR-8 / DC-05 Appendix A.2 intent:
    expect(titles(L)).not.toContain("W-AFTER");
    expect(lApplied).toBeLessThanOrEqual(cutoff);
  });

  // TD-041 OPEN (PROVEN): fails today; flips to a hard failure once a rule
  // from DC-27 Appendix B lands. Then turn test.fails back into test.
  test.fails("TD-041 repro (engine): an aware, trusted P's FULL_STATE_SNAPSHOT in a session with L lands W's above-cutoff event on L", { timeout: 60_000 }, async () => {
    const { L, W, P, cutoff } = await setup();
    const t = scriptedTransport();
    const engine = createSyncEngine({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: L.core.db as any,
      selfDeviceId: L.identity.deviceId,
      mutateEntity: makeEntityMutator(),
      peerDeviceId: P.identity.deviceId,
      revocations: makeDbRevocationChannel(L.core.db, {
        selfDeviceId: L.identity.deviceId,
        selfPublicKey: L.identity.publicKey,
        hlcNow: () => L.core.hlcNow(),
        log: () => {},
      }),
    });
    const run = engine.runSession(t.transport);
    t.push({ v: 1, type: "HELLO", device_clock: {} });
    await waitFor(() => t.sent.some((m) => m.type === "CHANGES_ACK"));
    const snap = snapshotOf(P);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    t.push({ v: 1, type: "FULL_STATE_SNAPSHOT", snapshot_clock: snap.snapshot_clock, entities: snap.entities, tombstones: snap.tombstones, final: true } as any);
    t.push({ v: 1, type: "CHANGES_ACK", applied_upto: {} });
    t.push(null);
    await run;
    const lApplied = appliedThrough(L, W.identity.deviceId) ?? 0;
    console.error(`[td041-engine] L titles=${JSON.stringify(titles(L))} L applied_upto[W]=${lApplied} cutoff=${cutoff}`);
    expect(titles(L)).not.toContain("W-AFTER");
    expect(lApplied).toBeLessThanOrEqual(cutoff);
  });

  // TD-041 OPEN (PROVEN): fails today; flips to a hard failure once a rule
  // from DC-27 Appendix B lands. Then turn test.fails back into test.
  test.fails("TD-041 repro (delete): W's above-cutoff DELETE must not reach L by snapshot absence", { timeout: 60_000 }, async () => {
    const L = makeDev("L");
    const W = makeDev("W");
    const P = makeDev("P");
    pairAll(L, W, P);
    await listen(L);
    await listen(P);
    addEvent(W, "W-BEFORE");
    await dial(W, L);
    await dial(W, P);
    await L.mgr.unpairDevice(W.identity.deviceId, true);
    const cutoff = storedRecord(L).record.revoked_after_seq!;
    const id = (W.core.db.prepare("SELECT event_id AS id FROM events WHERE title='W-BEFORE'").get() as { id: string }).id;
    W.core.deleteEvent(id); // above the cutoff
    await dial(W, P); // unaware P applies the delete
    await dial(L, P); // P learns the record; L rejects the delete (TR-8)
    expect(titles(P)).not.toContain("W-BEFORE");
    expect(titles(L)).toContain("W-BEFORE");
    const snap = snapshotOf(P);
    const ptomb = snap.tombstones.filter((t) => t.entity_id === id);
    const r = applySnapshot(L.core.db, snap, loadKnowledgeFromDb(L.core.db));
    console.error(
      `[td041-delete] cutoff=${cutoff} snapshot tombstones for the entity=${ptomb.length} ` +
        `absenceTombstones=${r.absenceTombstones} L titles after=${JSON.stringify(titles(L))}`,
    );
    // Desired (DC-27 TR-8 intent): L keeps its legitimate copy.
    expect(titles(L)).toContain("W-BEFORE");
  });

  test("TD-041 evidence: snapshot provenance cannot isolate W's above-cutoff fields", { timeout: 60_000 }, async () => {
    const L = makeDev("L");
    const W = makeDev("W");
    const P = makeDev("P");
    pairAll(L, W, P);
    await listen(L);
    await listen(P);
    addEvent(W, "W-BEFORE");
    await dial(W, L);
    await dial(W, P);
    await L.mgr.unpairDevice(W.identity.deviceId, true);
    const cutoff = storedRecord(L).record.revoked_after_seq!;
    const wid = W.identity.deviceId;
    const ev = W.core.db.prepare("SELECT event_id AS id, utc_start_ms AS s, utc_end_ms AS e FROM events WHERE title='W-BEFORE'").get() as { id: string; s: number; e: number };
    // (1) W edits the TITLE of its at-or-below-cutoff event, above the cutoff.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    W.core.updateEvent(ev.id, { title: "W-TITLE-AFTER-CUTOFF", description: "", startMs: ev.s, endMs: ev.e, allDay: false } as any);
    await dial(W, P); // unaware P applies it
    // (2) P later edits the DESCRIPTION of the same event (legitimate P change).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    P.core.updateEvent(ev.id, { title: "W-TITLE-AFTER-CUTOFF", description: "P-DESC", startMs: ev.s, endMs: ev.e, allDay: false } as any);
    // (3) P creates an unrelated event after having seen W's above-cutoff change.
    addEvent(P, "P-ONLY");
    await dial(L, P); // P learns the record
    expect(statusOf(P, W)).toBe("revoked");
    const snap = snapshotOf(P);
    const merged = snap.entities.find((e) => e.entity_id === ev.id)!;
    const pOnlyId = (P.core.db.prepare("SELECT event_id AS id FROM events WHERE title='P-ONLY'").get() as { id: string }).id;
    const pOnly = snap.entities.find((e) => e.entity_id === pOnlyId)!;
    const lClockW = snapshotOf(L).snapshot_clock[wid];
    const lAppliedW = appliedThrough(L, wid);
    console.error(`[td041-evidence] untainted L: snapshot_clock[W]=${lClockW} applied_upto[W]=${lAppliedW} cutoff=${cutoff}`);
    // L never applied W above the cutoff, yet its snapshot_clock (from
    // device_clock, causal context) exceeds it: the clock cannot tell a
    // peer holding W's above-cutoff state from one that only saw it cited.
    expect(lAppliedW).toBe(cutoff);
    expect(lClockW).toBeGreaterThan(cutoff);
    console.error(
      `[td041-evidence] cutoff=${cutoff} merged: producer=${merged.producer_device_id === wid ? "W" : merged.producer_device_id === P.identity.deviceId ? "P" : "?"} ` +
        `clock[W]=${merged.causality_clock[wid]} title=${(JSON.parse(merged.data) as { title: string }).title} desc=${(JSON.parse(merged.data) as { description: string }).description}`,
    );
    console.error(
      `[td041-evidence] P-ONLY: producer=${pOnly.producer_device_id === P.identity.deviceId ? "P" : "?"} clock[W]=${pOnly.causality_clock[wid]}`,
    );
    // The merged row carries W's above-cutoff title, but its latest producer is P:
    expect(merged.producer_device_id).toBe(P.identity.deviceId);
    expect((JSON.parse(merged.data) as { title: string }).title).toBe("W-TITLE-AFTER-CUTOFF");
    expect(merged.causality_clock[wid]).toBeGreaterThan(cutoff);
    // An entity with NO W state also shows clock[W] above the cutoff (causal
    // context, not provenance), so a version-vector filter would drop it:
    expect(pOnly.producer_device_id).toBe(P.identity.deviceId);
    expect(pOnly.causality_clock[wid]).toBeGreaterThan(cutoff);
  });
});
