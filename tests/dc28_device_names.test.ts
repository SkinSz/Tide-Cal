// DC-28 friendly device names: TR-1..TR-5, TR-7, TR-8, TR-10, TR-11, the
// automated part of TR-12, and the V1/V2 evidence. TR-6 and TR-9 (DOM per
// surface) live in tests/dc28_surfaces_dom.test.ts.
//
// Pairing runs the REAL ceremony (createPairingOffer / acceptPairingPayload
// over TCP + Noise_XX). "Wire capture" records every JSON text the process
// serializes while a step runs (the encrypted channels serialize with
// JSON.stringify right before encryption), plus every console line.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { EventCore } from "../src/persistence/bridges/event_core.ts";
import {
  SyncManager,
  makeSyncDispatcher,
  type Dispatcher,
} from "../src/persistence/bridges/sidecar_server.ts";
import { EndpointCache } from "../src/network/endpoint_bridge.ts";
import { connectSync, loadOrCreateIdentity, serveSync } from "../src/network/sync_runtime.ts";
import {
  acceptPairingPayload,
  createPairingOffer,
  sqlPeerStore,
} from "../src/network/pairing_manager.ts";
import { decodePairingPayload, encodePairingPayload, freshNonce } from "../src/security/pairing.ts";
import { openDatabase, ensurePeerNamesSchemaV10 } from "../src/persistence/database.ts";
import { SCHEMA_VERSION } from "../src/persistence/schema.ts";
import { buildTxtRecord } from "../src/network/discovery.ts";
import {
  announcedNameFromPeer,
  deviceLabel,
  deviceNameViews,
  disambiguateLabels,
  shortId,
  validateName,
} from "../src/domain/device_names.ts";
import { NAME_CASES, encodeResult } from "./dc28_name_table.ts";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

let root: string;
interface Dev {
  dir: string;
  identity: ReturnType<typeof loadOrCreateIdentity>;
  core: EventCore;
  mgr: SyncManager;
  dispatch: Dispatcher;
  port: number;
}
const live: Dev[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tide-dc28-"));
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of live.splice(0)) {
    try {
      d.mgr.closeListener();
    } catch {
      /* closed */
    }
    try {
      d.core.db.close();
    } catch {
      /* closed */
    }
  }
  rmSync(root, { recursive: true, force: true });
});

function makeDev(tag: string): Dev {
  const dir = join(root, tag);
  mkdirSync(dir, { recursive: true });
  const identity = loadOrCreateIdentity(dir);
  const core = new EventCore(join(dir, "tide.db"), identity.deviceId);
  const mgr = new SyncManager(core, identity);
  const dispatch = makeSyncDispatcher(mgr, core, { endpointCache: new EndpointCache() });
  const d = { dir, identity, core, mgr, dispatch, port: 0 };
  live.push(d);
  return d;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function call<T = Record<string, unknown>>(d: Dev, op: string, args: Record<string, unknown> = {}): Promise<T> {
  return (await d.dispatch(op, args)) as T;
}

/** Pair through the sidecar ops exactly as the GUI does (offer on a, accept on b). */
async function pairViaOps(a: Dev, b: Dev): Promise<string> {
  const offer = await call<{ qr_text: string }>(a, "pairing_offer", {});
  await call(b, "pairing_accept", { qr_text: offer.qr_text });
  // the displayer stores its row when the ceremony ends on its side
  for (let i = 0; i < 300; i++) {
    const info = await call<{ paired_peers: Array<{ device_id: string }> }>(a, "device_info");
    if (info.paired_peers.some((p) => p.device_id === b.identity.deviceId)) break;
    await sleep(10);
  }
  return offer.qr_text;
}

type PeerView = { device_id: string; label: string; short_id: string; nickname: string | null; announced_name: string | null };
async function peersOf(d: Dev): Promise<PeerView[]> {
  return (await call<{ paired_peers: PeerView[] }>(d, "device_info")).paired_peers;
}
function announcedOf(d: Dev, peerId: string): unknown {
  return (d.core.db.prepare("SELECT announced_name FROM peers WHERE device_id = ?").get(peerId) as
    | { announced_name: unknown }
    | undefined)?.announced_name;
}

/** Record every JSON text serialized and every console line during fn(). */
async function capture<T>(fn: () => Promise<T>): Promise<{ result: T; json: string[]; logs: string[] }> {
  const json: string[] = [];
  const logs: string[] = [];
  const orig = JSON.stringify;
  const s = vi.spyOn(JSON, "stringify").mockImplementation(((...a: Parameters<typeof JSON.stringify>) => {
    const out = orig(...a);
    if (typeof out === "string") json.push(out);
    return out;
  }) as typeof JSON.stringify);
  const sinks = (["error", "warn", "log", "info", "debug"] as const).map((k) =>
    vi.spyOn(console, k).mockImplementation((...args: unknown[]) => {
      logs.push(args.map((x) => (typeof x === "string" ? x : String(x))).join(" "));
    }),
  );
  try {
    return { result: await fn(), json, logs };
  } finally {
    s.mockRestore();
    for (const k of sinks) k.mockRestore();
  }
}

/** Pairing payload objects found among serialized texts. */
function pairingPayloads(json: string[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const t of json) {
    if (!t.startsWith("{")) continue;
    try {
      const o = JSON.parse(t) as Record<string, unknown>;
      if (o.v === 1 && typeof o.device_id === "string" && typeof o.public_key === "string" && "nonce" in o)
        out.push(o);
    } catch {
      /* not JSON */
    }
  }
  return out;
}

/**
 * A hand-made SCANNER that sends its own crafted encrypted payload (to put
 * names on the wire that a real Tide build would never send).
 */
async function craftedScanner(qrText: string, d: Dev, extra: Record<string, unknown>): Promise<unknown> {
  const remote = decodePairingPayload(qrText);
  const conn = await connectSync(d.identity.privateKey, remote.connect!.ip, remote.connect!.port);
  try {
    await conn.json.receive(); // the displayer speaks first
    await conn.json.send({
      v: 1,
      device_id: d.identity.deviceId,
      public_key: Buffer.from(d.identity.publicKey).toString("base64"),
      nonce: freshNonce(),
      ...extra,
    });
    return await conn.json.receive(); // PAIRING_OK
  } finally {
    conn.done();
  }
}

// ---------------------------------------------------------------------------
// TR-1 validateName
// ---------------------------------------------------------------------------

describe("TR-1 validateName (§4.8)", () => {
  test.each(NAME_CASES)("TR-1 $label", ({ input, expect: want }) => {
    expect(encodeResult(validateName(input))).toBe(want);
  });
  test("TR-1 the result is NFC and has no Zs runs or edges", () => {
    const r = validateName("  Á   B  ");
    expect(r).toEqual({ ok: true, name: "Á B" });
  });
});

// ---------------------------------------------------------------------------
// TR-2 / TR-3 pairing exchange
// ---------------------------------------------------------------------------

describe("TR-2 the own name arrives from the ENCRYPTED payload on both sides", () => {
  test("TR-2 displayer and scanner both store the other's encrypted name; a pasted-code name is ignored", { timeout: 30_000 }, async () => {
    const L = makeDev("L");
    const W = makeDev("W");
    expect((await call(L, "set_device_name", { name: "Linux PC" })).device_name).toBe("Linux PC");
    expect((await call(W, "set_device_name", { name: " Windows  PC " })).device_name).toBe("Windows PC");
    const offer = await call<{ qr_text: string }>(L, "pairing_offer", {});
    // tamper the pasted code with a DIFFERENT name (older builds put one there)
    const pasted = JSON.parse(offer.qr_text) as Record<string, unknown>;
    expect("name" in pasted).toBe(false); // P5
    pasted.name = "Pasted Name";
    const cap = await capture(async () => {
      await call(W, "pairing_accept", { qr_text: JSON.stringify(pasted) });
      for (let i = 0; i < 300 && announcedOf(L, W.identity.deviceId) === undefined; i++) await sleep(10);
    });
    // scanner (W) stored the displayer's ENCRYPTED name, not the pasted one
    expect(announcedOf(W, L.identity.deviceId)).toBe("Linux PC");
    // displayer (L) stored the scanner's encrypted name
    expect(announcedOf(L, W.identity.deviceId)).toBe("Windows PC");
    // both encrypted payloads carried the names
    const names = pairingPayloads(cap.json).map((p) => p.name);
    expect(names).toContain("Linux PC");
    expect(names).toContain("Windows PC");
    expect((await peersOf(W))[0]!.label).toBe("Linux PC");
    expect((await peersOf(L))[0]!.label).toBe("Windows PC");
  });

  test("TR-2 a caller-supplied args.name is not sent: only the SAVED name is (P3)", { timeout: 30_000 }, async () => {
    const L = makeDev("L");
    const W = makeDev("W");
    const cap = await capture(async () => {
      const offer = await call<{ qr_text: string }>(L, "pairing_offer", { name: "Sneaky" });
      await call(W, "pairing_accept", { qr_text: offer.qr_text, name: "Sneaky too" });
    });
    expect(cap.json.some((t) => t.includes("Sneaky"))).toBe(false);
  });
});

describe("TR-3 no own name set -> no name anywhere", () => {
  test("TR-3 neither payload nor the pasted code has a name key; the peer label is 'Device <short id>'", { timeout: 30_000 }, async () => {
    const L = makeDev("L");
    const W = makeDev("W");
    const cap = await capture(() => pairViaOps(L, W));
    const qr = JSON.parse(cap.result) as Record<string, unknown>;
    expect(Object.keys(qr).sort()).toEqual(["connect", "device_id", "nonce", "public_key", "v"]);
    const payloads = pairingPayloads(cap.json);
    const senders = new Set(payloads.map((p) => p.device_id));
    expect(senders).toEqual(new Set([L.identity.deviceId, W.identity.deviceId]));
    for (const p of payloads) expect("name" in p).toBe(false);
    expect((await peersOf(W))[0]!.label).toBe(`Device ${shortId(L.identity.deviceId)}`);
    expect((await peersOf(L))[0]!.label).toBe(`Device ${shortId(W.identity.deviceId)}`);
    expect(announcedOf(L, W.identity.deviceId)).toBeNull();
    expect(announcedOf(W, L.identity.deviceId)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// TR-4 invalid received name
// ---------------------------------------------------------------------------

describe("TR-4 an invalid received name", () => {
  test("TR-4 pairing succeeds, announced name empty, the log line has no part of the name", { timeout: 30_000 }, async () => {
    const L = makeDev("L");
    const S = makeDev("S");
    const offer = await createPairingOffer({ identity: L.identity, store: sqlPeerStore(L.core.db) });
    const cap = await capture(async () => {
      const ok = await craftedScanner(offer.qrText, S, { name: "Bob‮exe.cod" });
      await offer.result;
      return ok;
    });
    expect(cap.result).toEqual({ kind: "PAIRING_OK" });
    const row = L.core.db.prepare("SELECT status, display_name, announced_name FROM peers WHERE device_id = ?").get(S.identity.deviceId);
    expect(row).toEqual({ status: "trusted", display_name: "", announced_name: null });
    const line = cap.logs.find((l) => l.includes("pairing: peer name ignored"));
    expect(line).toBe("[tide] pairing: peer name ignored (format)");
    for (const l of cap.logs) for (const part of ["Bob", "exe", "cod", "‮"]) expect(l).not.toContain(part);
  });

  test("TR-4 a non-string name is dropped the same way", { timeout: 30_000 }, async () => {
    const L = makeDev("L");
    const S = makeDev("S");
    const offer = await createPairingOffer({ identity: L.identity, store: sqlPeerStore(L.core.db) });
    expect(await craftedScanner(offer.qrText, S, { name: { evil: true } })).toEqual({ kind: "PAIRING_OK" });
    await offer.result;
    expect(announcedOf(L, S.identity.deviceId)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// TR-5 label precedence + id-prefix placeholder
// ---------------------------------------------------------------------------

describe("TR-5 label precedence", () => {
  const ID = "d-7178a859" + "ab".repeat(28);
  test("TR-5 nickname > announced name > 'Device <short id>'; self -> 'This device'", () => {
    expect(deviceLabel({ device_id: ID, nickname: "Office", announced_name: "Windows PC" })).toBe("Office");
    expect(deviceLabel({ device_id: ID, nickname: "", announced_name: "Windows PC" })).toBe("Windows PC");
    expect(deviceLabel({ device_id: ID, nickname: null, announced_name: null })).toBe("Device 7178a859");
    expect(deviceLabel({ device_id: ID, self_device_id: ID, nickname: "Office" })).toBe("This device");
    // a stored value that fails §4.8 (hand-edited DB) is skipped
    expect(deviceLabel({ device_id: ID, nickname: "x‮", announced_name: "Windows PC" })).toBe("Windows PC");
  });

  test("TR-5 a received name that is a prefix of the sender's id is stored as none", { timeout: 30_000 }, async () => {
    expect(announcedNameFromPeer(ID.slice(0, 12), ID)).toEqual({ name: null, ignored: "id_prefix" });
    expect(announcedNameFromPeer("d-7178", ID)).toEqual({ name: null, ignored: "id_prefix" });
    const L = makeDev("L");
    const S = makeDev("S");
    const offer = await createPairingOffer({ identity: L.identity, store: sqlPeerStore(L.core.db) });
    // what older builds sent: deviceId.slice(0, 12)
    await craftedScanner(offer.qrText, S, { name: S.identity.deviceId.slice(0, 12) });
    await offer.result;
    expect(announcedOf(L, S.identity.deviceId)).toBeNull();
    expect((await peersOf(L))[0]!.label).toBe(`Device ${shortId(S.identity.deviceId)}`);
  });

  test("TR-5 a nickname set through the op wins and clearing it falls back", { timeout: 30_000 }, async () => {
    const L = makeDev("L");
    const W = makeDev("W");
    await call(W, "set_device_name", { name: "Windows PC" });
    await pairViaOps(L, W);
    const id = W.identity.deviceId;
    expect((await call(L, "set_peer_nickname", { device_id: id, nickname: "Office laptop" })).label).toBe("Office laptop");
    expect((await peersOf(L))[0]).toMatchObject({ label: "Office laptop", nickname: "Office laptop", announced_name: "Windows PC" });
    expect((await call(L, "set_peer_nickname", { device_id: id, nickname: "  " })).label).toBe("Windows PC");
    expect((await peersOf(L))[0]!.nickname).toBeNull();
    await expect(call(L, "set_peer_nickname", { device_id: id, nickname: "a⁦b" })).rejects.toThrow(/invisible or control/);
    await expect(call(L, "set_peer_nickname", { device_id: "d-" + "0".repeat(64), nickname: "X" })).rejects.toThrow(/not paired/);
    // a re-pair replaces the announced name but keeps the nickname
    await call(L, "set_peer_nickname", { device_id: id, nickname: "Office laptop" });
    await call(W, "set_device_name", { name: "Windows desktop" });
    await pairViaOps(L, W);
    for (let i = 0; i < 300 && announcedOf(L, id) !== "Windows desktop"; i++) await sleep(10);
    expect((await peersOf(L))[0]).toMatchObject({ label: "Office laptop", announced_name: "Windows desktop" });
  });
});

// ---------------------------------------------------------------------------
// TR-7 migration
// ---------------------------------------------------------------------------

describe("TR-7 v10 migration (§4.9)", () => {
  const A = "d-aaaaaaaa" + "1".repeat(56);
  const B = "d-bbbbbbbb" + "2".repeat(56);
  const C = "d-cccccccc" + "3".repeat(56);
  const D = "d-dddddddd" + "4".repeat(56);
  function v9Db(): string {
    const path = join(root, "v9.db");
    openDatabase({ path }).close();
    const raw = new Database(path);
    raw.exec("ALTER TABLE peers DROP COLUMN announced_name");
    const ins = raw.prepare("INSERT INTO peers (device_id, public_key, display_name, paired_at, status) VALUES (?, x'00', ?, 1, ?)");
    ins.run(A, A.slice(0, 12), "trusted"); // id-prefix placeholder (S3)
    ins.run(B, "Windows PC", "trusted"); // a real announced name
    ins.run(C, "Bob‮exe", "revoked"); // fails §4.8
    ins.run(D, "", "trusted");
    raw.exec("UPDATE schema_version SET version = 9");
    raw.close();
    return path;
  }
  const rows = (db: Database.Database) =>
    db.prepare("SELECT device_id, display_name, announced_name FROM peers ORDER BY device_id").all();
  const EXPECTED = [
    { device_id: A, display_name: "", announced_name: null },
    { device_id: B, display_name: "", announced_name: "Windows PC" },
    { device_id: C, display_name: "", announced_name: null },
    { device_id: D, display_name: "", announced_name: null },
  ];

  test("TR-7 placeholders become '', real names move to announced_name, invalid ones become NULL", () => {
    const db = openDatabase({ path: v9Db() });
    expect((db.prepare("SELECT version FROM schema_version").get() as { version: number }).version).toBe(SCHEMA_VERSION);
    expect(rows(db)).toEqual(EXPECTED);
    expect(deviceNameViews(rows(db) as never).map((v) => v.label)).toEqual([
      "Device aaaaaaaa",
      "Windows PC",
      "Device cccccccc",
      "Device dddddddd",
    ]);
    db.close();
  });

  test("TR-7 running the migration twice changes nothing; later opens keep a nickname", () => {
    const path = v9Db();
    const db = openDatabase({ path });
    expect(ensurePeerNamesSchemaV10(db)).toBe(false); // second run: no-op
    expect(rows(db)).toEqual(EXPECTED);
    db.prepare("UPDATE peers SET display_name = 'Office' WHERE device_id = ?").run(B);
    db.close();
    for (let i = 0; i < 2; i++) {
      const again = openDatabase({ path });
      expect(again.prepare("SELECT display_name, announced_name FROM peers WHERE device_id = ?").get(B)).toEqual({
        display_name: "Office",
        announced_name: "Windows PC",
      });
      again.close();
    }
  });

  test("TR-7 a v10-stamped DB without the column is repaired (column + one-time move)", () => {
    const path = v9Db();
    const raw = new Database(path);
    raw.exec(`UPDATE schema_version SET version = ${SCHEMA_VERSION}`);
    raw.close();
    const db = openDatabase({ path });
    expect(rows(db)).toEqual(EXPECTED);
    db.close();
  });

  test("TR-7 a fresh database has the column", () => {
    const db = openDatabase({ path: join(root, "fresh.db") });
    const cols = (db.prepare("PRAGMA table_info(peers)").all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toContain("announced_name");
    db.close();
  });
});

// ---------------------------------------------------------------------------
// TR-8 nickname is local
// ---------------------------------------------------------------------------

describe("TR-8 the nickname never leaves the device", () => {
  test("TR-8 setting it changes no outbound payload, sync message or log line", { timeout: 60_000 }, async () => {
    const L = makeDev("L");
    const W = makeDev("W");
    await call(L, "set_device_name", { name: "Linux PC" });
    await call(W, "set_device_name", { name: "Windows PC" });
    await pairViaOps(L, W);
    const NICK = "Nick-Secret-42";
    const t = Date.UTC(2026, 10, 20, 9);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    L.core.createEvent({ title: "from L", description: "", startMs: t, endMs: t + 3_600_000, allDay: false } as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    W.core.createEvent({ title: "from W", description: "", startMs: t, endMs: t + 3_600_000, allDay: false } as any);
    await call(L, "set_peer_nickname", { device_id: W.identity.deviceId, nickname: NICK });
    L.mgr.ensureListener(0);
    W.mgr.ensureListener(0);
    for (let i = 0; i < 300 && (!L.port || !W.port); i++) {
      await sleep(10);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      L.port = (L.mgr as any).host?.actualPort ?? 0;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      W.port = (W.mgr as any).host?.actualPort ?? 0;
    }
    const cap = await capture(async () => {
      // both directions, plus a re-pair (the only time own names travel)
      await L.mgr.runEngineSession(await connectSync(L.identity.privateKey, "127.0.0.1", W.port));
      await sleep(150);
      await W.mgr.runEngineSession(await connectSync(W.identity.privateKey, "127.0.0.1", L.port));
      await sleep(150);
      await pairViaOps(L, W);
      await pairViaOps(W, L);
    });
    const titles = (d: Dev) => (d.core.db.prepare("SELECT title FROM events ORDER BY title").all() as Array<{ title: string }>).map((r) => r.title);
    expect(titles(W)).toEqual(["from L", "from W"]); // the sessions really ran
    expect(pairingPayloads(cap.json).length).toBeGreaterThanOrEqual(4);
    // the capture covers the engine channel too, not only pairing
    expect(cap.json.some((j) => j.includes('"type":"HELLO"'))).toBe(true);
    expect(cap.json.some((j) => j.includes('"type":"CHANGES_BATCH"'))).toBe(true);
    for (const j of cap.json) expect(j).not.toContain(NICK);
    for (const l of cap.logs) expect(l).not.toContain(NICK);
    // and the peer holds it nowhere
    const dump = JSON.stringify(W.core.db.prepare("SELECT * FROM peers").all()) + JSON.stringify(W.core.db.prepare("SELECT * FROM changes").all());
    expect(dump).not.toContain(NICK);
    expect((await peersOf(L))[0]!.label).toBe(NICK);
  });
});

// ---------------------------------------------------------------------------
// TR-10 duplicates
// ---------------------------------------------------------------------------

describe("TR-10 duplicate labels get ' (<short id>)' within one list", () => {
  test("TR-10 pure rule", () => {
    const a = "d-7178a859" + "0".repeat(56);
    const b = "d-03cd91fe" + "0".repeat(56);
    const c = "d-11111111" + "0".repeat(56);
    expect(
      disambiguateLabels([
        { device_id: a, label: "Laptop" },
        { device_id: b, label: "Laptop" },
        { device_id: c, label: "Phone" },
      ]),
    ).toEqual(["Laptop (7178a859)", "Laptop (03cd91fe)", "Phone"]);
    // the same device twice is not a duplicate of itself
    expect(disambiguateLabels([{ device_id: a, label: "X" }, { device_id: a, label: "X" }])).toEqual(["X", "X"]);
  });

  test("TR-10 two peers that both announce 'Laptop' (device_info, list_paired_devices, peer_state)", { timeout: 30_000 }, async () => {
    const L = makeDev("L");
    const P = makeDev("P");
    const Q = makeDev("Q");
    await call(P, "set_device_name", { name: "Laptop" });
    await call(Q, "set_device_name", { name: "Laptop" });
    await pairViaOps(L, P);
    await pairViaOps(L, Q);
    const want = new Set([`Laptop (${shortId(P.identity.deviceId)})`, `Laptop (${shortId(Q.identity.deviceId)})`]);
    expect(new Set((await peersOf(L)).map((p) => p.label))).toEqual(want);
    const listed = (await call<{ devices: PeerView[] }>(L, "list_paired_devices")).devices;
    expect(new Set(listed.map((p) => p.label))).toEqual(want);
    const states = (await call<{ peers: PeerView[] }>(L, "peer_state")).peers;
    expect(new Set(states.map((p) => p.label))).toEqual(want);
    // a nickname makes one unique again: both become plain
    await call(L, "set_peer_nickname", { device_id: P.identity.deviceId, nickname: "Work laptop" });
    expect(new Set((await peersOf(L)).map((p) => p.label))).toEqual(new Set(["Work laptop", "Laptop"]));
  });
});

// ---------------------------------------------------------------------------
// TR-11 mDNS TXT unchanged
// ---------------------------------------------------------------------------

describe("TR-11 mDNS TXT stays {pv} only after setting an own name", () => {
  test("TR-11 device_info.txt has only pv", async () => {
    const L = makeDev("L");
    const before = (await call<{ txt: Record<string, string> }>(L, "device_info")).txt;
    await call(L, "set_device_name", { name: "Windows PC" });
    const after = (await call<{ txt: Record<string, string> }>(L, "device_info")).txt;
    expect(Object.keys(after)).toEqual(["pv"]);
    expect(after).toEqual(before);
    expect(after).toEqual(buildTxtRecord({}));
    expect(JSON.stringify(after)).not.toContain("Windows PC");
  });
});

// ---------------------------------------------------------------------------
// TR-12 (automated part; the owner's two-machine check is still owed)
// ---------------------------------------------------------------------------

describe("TR-12 automated proxy of the owner acceptance", () => {
  test("TR-12 name both, pair, every list op shows names and no truncated ids", { timeout: 30_000 }, async () => {
    const L = makeDev("L");
    const W = makeDev("W");
    expect((await call(L, "set_device_name", { name: "Linux PC" })).device_name).toBe("Linux PC");
    await expect(call(L, "set_device_name", { name: "a".repeat(33) })).rejects.toThrow(/too long/);
    expect(L.mgr.ownDeviceName).toBe("Linux PC"); // a refused save keeps the old name
    await call(W, "set_device_name", { name: "Windows PC" });
    await pairViaOps(W, L);
    const lists = [
      ...(await peersOf(L)),
      ...(await call<{ devices: PeerView[] }>(L, "list_paired_devices")).devices,
      ...(await call<{ peers: PeerView[] }>(L, "peer_state")).peers,
    ];
    expect(lists.map((p) => p.label)).toEqual(["Windows PC", "Windows PC", "Windows PC"]);
    const wLists = [...(await peersOf(W)), ...(await call<{ devices: PeerView[] }>(W, "list_paired_devices")).devices];
    expect(wLists.map((p) => p.label)).toEqual(["Linux PC", "Linux PC"]);
    const text = JSON.stringify(lists) + JSON.stringify(wLists);
    expect(text).not.toMatch(/[0-9a-f]{6,}(…|\.\.\.)/);
    expect(lists[0]!.short_id).toBe(shortId(W.identity.deviceId));
  });
});

// ---------------------------------------------------------------------------
// V1: the engine ignores unknown fields (DC-08 §2.2), the T1 precondition
// ---------------------------------------------------------------------------

describe("V1 unknown fields in HELLO are ignored by the engine", () => {
  test("V1 a HELLO carrying an extra 'name' field still completes the session both ways", { timeout: 30_000 }, async () => {
    const L = makeDev("L");
    const W = makeDev("W");
    await pairViaOps(L, W);
    const t = Date.UTC(2026, 10, 20, 9);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    W.core.createEvent({ title: "W1", description: "", startMs: t, endMs: t + 3_600_000, allDay: false } as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    L.core.createEvent({ title: "L1", description: "", startMs: t, endMs: t + 3_600_000, allDay: false } as any);
    L.mgr.ensureListener(0);
    for (let i = 0; i < 300 && !L.port; i++) {
      await sleep(10);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      L.port = (L.mgr as any).host?.actualPort ?? 0;
    }
    const s = await connectSync(W.identity.privateKey, "127.0.0.1", L.port);
    const send = s.transport.send.bind(s.transport);
    let injected = 0;
    s.transport.send = async (msg: unknown) => {
      const m = msg as Record<string, unknown>;
      if (m && m.type === "HELLO") {
        injected++;
        return send({ ...m, name: "Windows PC", future_field: { nested: true } } as never);
      }
      return send(msg as never);
    };
    await W.mgr.runEngineSession(s);
    await sleep(200);
    expect(injected).toBe(1);
    const titles = (d: Dev) => (d.core.db.prepare("SELECT title FROM events ORDER BY title").all() as Array<{ title: string }>).map((r) => r.title);
    expect(titles(L)).toEqual(["L1", "W1"]); // L (receiver of the extended HELLO) pulled and served normally
    expect(titles(W)).toEqual(["L1", "W1"]);
  });
});

// ---------------------------------------------------------------------------
// Scanner side against a hand-made DISPLAYER (§4.3 "to the one device being
// paired", TR-4 on the scanner side)
// ---------------------------------------------------------------------------

/**
 * A fake displayer listening with `host`'s key. It sends `payload` first,
 * records what the scanner sends back, and confirms with PAIRING_OK.
 */
async function craftedDisplayer(host: Dev, payload: Record<string, unknown>) {
  const got: Array<Record<string, unknown>> = [];
  const srv = await serveSync(host.identity.privateKey, 0, (sess) => {
    void (async () => {
      try {
        await sess.json.send(payload);
        got.push((await sess.json.receive()) as Record<string, unknown>);
        await sess.json.send({ kind: "PAIRING_OK" });
      } catch {
        /* scanner hung up */
      } finally {
        sess.done();
      }
    })();
  });
  return { got, port: srv.actualPort, close: () => srv.close() };
}
const payloadOf = (d: Dev, extra: Record<string, unknown> = {}) => ({
  v: 1 as const,
  device_id: d.identity.deviceId,
  public_key: Buffer.from(d.identity.publicKey).toString("base64"),
  nonce: freshNonce(),
  ...extra,
});
const codeFor = (d: Dev, port: number) =>
  encodePairingPayload({ ...payloadOf(d), connect: { ip: "127.0.0.1", port } });

describe("TR-2 / TR-4 scanner side against a hand-made displayer", () => {
  test("TR-2 the scanner sends its name only when the session key is the pasted code's key", { timeout: 30_000 }, async () => {
    const W = makeDev("W");
    const F = makeDev("F"); // answers at the hinted address
    const X = makeDev("X"); // the device the pasted code names
    await call(W, "set_device_name", { name: "Windows PC" });
    const fake = await craftedDisplayer(F, payloadOf(F, { name: "Fake name" }));
    try {
      // mismatch: the code names X, F answers
      await call(W, "pairing_accept", { qr_text: codeFor(X, fake.port) }).catch(() => {});
      expect(fake.got).toHaveLength(1);
      expect("name" in fake.got[0]!).toBe(false);
      expect(announcedOf(W, X.identity.deviceId) ?? null).toBeNull();
      expect(announcedOf(W, F.identity.deviceId) ?? null).toBeNull();
    } finally {
      fake.close();
    }
    const real = await craftedDisplayer(F, payloadOf(F, { name: "Fake name" }));
    try {
      // match: the code names F, F answers -> our name goes out, theirs is kept
      await call(W, "pairing_accept", { qr_text: codeFor(F, real.port) });
      expect(real.got[0]!.name).toBe("Windows PC");
      expect(announcedOf(W, F.identity.deviceId)).toBe("Fake name");
    } finally {
      real.close();
    }
  });

  test("TR-4 scanner side: an invalid name from the displayer is dropped, pairing succeeds, no part logged", { timeout: 30_000 }, async () => {
    const W = makeDev("W");
    const F = makeDev("F");
    const fake = await craftedDisplayer(F, payloadOf(F, { name: "Bob\u202eexe.cod" }));
    try {
      const cap = await capture(() => call(W, "pairing_accept", { qr_text: codeFor(F, fake.port) }));
      expect(cap.result).toMatchObject({ peer_device_id: F.identity.deviceId });
      expect(W.core.db.prepare("SELECT status, display_name, announced_name FROM peers WHERE device_id = ?").get(F.identity.deviceId)).toEqual({
        status: "trusted",
        display_name: "",
        announced_name: null,
      });
      expect(cap.logs).toContain("[tide] pairing: peer name ignored (format)");
      for (const l of cap.logs) for (const part of ["Bob", "exe", "cod", "\u202e"]) expect(l).not.toContain(part);
    } finally {
      fake.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Seam: the real sidecar main() routes the new ops to the sync dispatcher
// (an op missing from main()'s routing list answers "unknown op" even
// though makeSyncDispatcher handles it).
// ---------------------------------------------------------------------------

describe("DC-28 seams: main() routes the new ops", () => {
  test("set_device_name and set_peer_nickname reach the sync dispatcher over stdio", { timeout: 60_000 }, async () => {
    const { execFileSync, spawn } = await import("node:child_process");
    const { createInterface } = await import("node:readline");
    const outdir = mkdtempSync(join(import.meta.dirname, "../dist/dc28-"));
    try {
      const bundle = join(outdir, "sidecar.mjs");
      execFileSync(join(import.meta.dirname, "../node_modules/.bin/esbuild"), [
        join(import.meta.dirname, "../src/persistence/bridges/sidecar_server.ts"),
        "--bundle", "--platform=node", "--format=esm", "--external:better-sqlite3", `--outfile=${bundle}`,
      ]);
      const dir = join(root, "stdio");
      mkdirSync(dir, { recursive: true });
      const env: NodeJS.ProcessEnv = { ...process.env, TIDE_DB_PATH: join(dir, "tide.db"), TIDE_DATA_DIR: dir };
      delete env.VITEST;
      const child = spawn(process.execPath, [bundle], { env, stdio: ["pipe", "pipe", "pipe"] });
      const lines = [
        { id: 1, op: "set_device_name", args: { name: " Windows  PC " } },
        { id: 2, op: "set_device_name", args: { name: "Bob‮exe" } },
        { id: 3, op: "set_peer_nickname", args: { device_id: "d-" + "0".repeat(64), nickname: "X" } },
      ];
      const got: Array<{ id: number; ok: boolean; result?: unknown; error?: string }> = [];
      const rl = createInterface({ input: child.stdout! });
      rl.on("line", (l) => l.trim() && got.push(JSON.parse(l)));
      child.stdin!.write(lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
      for (let i = 0; i < 1000 && got.length < lines.length; i++) await sleep(10);
      child.stdin!.end();
      await new Promise((r) => child.on("exit", r));
      expect(got.find((r) => r.id === 1)).toMatchObject({ ok: true, result: { device_name: "Windows PC" } });
      expect(got.find((r) => r.id === 2)?.error).toMatch(/invisible or control/);
      expect(got.find((r) => r.id === 3)?.error).toMatch(/not paired/);
      for (const r of got) expect(r.error ?? "").not.toMatch(/unknown op/);
    } finally {
      rmSync(outdir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Review m-1: the v7 drift repair also runs for stamps below the current
// version, so a v8/v9-stamped DB lacking the v7 columns is repaired on its
// FIRST open by the v10 build (before: only on the second open).
// ---------------------------------------------------------------------------

describe("v10 migration also repairs v7 column drift on the first open", () => {
  for (const stamp of [8, 9]) {
    test(`a v${stamp}-stamped DB without reminders.enabled / events.all_day_reminder_time is repaired by ONE open`, () => {
      const path = join(root, `drift-v${stamp}.db`);
      openDatabase({ path }).close();
      const raw = new Database(path);
      // rebuild reminders without "enabled" (its CHECK constraint blocks DROP COLUMN)
      const remCols = (raw.prepare("PRAGMA table_info(reminders)").all() as Array<{ name: string }>)
        .map((c) => c.name)
        .filter((n) => n !== "enabled");
      raw.exec(`CREATE TABLE reminders_old AS SELECT ${remCols.join(", ")} FROM reminders`);
      raw.exec("DROP TABLE reminders");
      raw.exec("ALTER TABLE reminders_old RENAME TO reminders");
      raw.exec("ALTER TABLE events DROP COLUMN all_day_reminder_time");
      raw.exec(`UPDATE schema_version SET version = ${stamp}`);
      raw.close();
      const db = openDatabase({ path }); // ONE open only
      const cols = (t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map((c) => c.name);
      expect(cols("reminders")).toContain("enabled");
      expect(cols("events")).toContain("all_day_reminder_time");
      expect((db.prepare("SELECT version FROM schema_version").get() as { version: number }).version).toBe(SCHEMA_VERSION);
      db.close();
    });
  }
});
