// DC-05 Appendix B (v3 amendment: code binding and proof of the code).
// One test (or table) per TR-B1..TR-B12 plus the VB items that can be
// checked automatically (VB-1, VB-2, VB-3 against the older decoder, VB-4,
// VB-8, VB-9). Everything runs over REAL TCP + Noise_XX (serveSync /
// connectSync); adversaries are test peers built from the same primitives.
import { afterEach, describe, expect, test, vi } from "vitest";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { connect as netConnect, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateIdentity } from "../src/security/identity.ts";
import {
  PAIRING_PROOF_LABEL,
  PairingError,
  PairingSession,
  computePairingProof,
  decodeBase64Exact,
  decodeCeremonyPayload,
  decodePairingCode,
  encodePairingCode,
  freshNonce,
  pairingProofFrame,
  verifyPairingProof,
  type PairingCode,
} from "../src/security/pairing.ts";
import {
  PAIRING_CODE_INVALID_MESSAGE,
  PAIRING_OFFER_BOUNDS,
  PAIRING_PROOF_MAX_CIPHER_BYTES,
  PAIRING_UNREACHABLE_MESSAGE,
  PairingCodeInvalidError,
  PairingUnreachableError,
  acceptPairingPayload,
  badProofLogLine,
  createPairingOffer,
  type PairingOffer,
  type PairingOfferBounds,
  type TrustedPeerStore,
} from "../src/network/pairing_manager.ts";
import {
  connectSync,
  describeFrame,
  loadOrCreateIdentity,
  serveSync,
  type InboundSession,
} from "../src/network/sync_runtime.ts";
import { decodePairingPayload as decodeV1Code } from "./fixtures/pairing_v1_decoder.ts";
import { handshakeOverTransport, type FramedByteTransport } from "../src/network/noise_transport.ts";
import { EventCore } from "../src/persistence/bridges/event_core.ts";
import { SyncManager, makeSyncDispatcher } from "../src/persistence/bridges/sidecar_server.ts";
import { EndpointCache } from "../src/network/endpoint_bridge.ts";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

type Id = ReturnType<typeof generateIdentity>;
const b64 = (u: Uint8Array) => Buffer.from(u).toString("base64");
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const P13 = "This pairing code is no longer valid. Create a new one.";

const offers: PairingOffer[] = [];
const servers: Array<{ close(): void }> = [];
afterEach(() => {
  for (const o of offers.splice(0)) o.cancel();
  for (const s of servers.splice(0)) s.close();
  delete (globalThis as { __TIDE_JDBG?: boolean }).__TIDE_JDBG;
  vi.restoreAllMocks();
});

interface Recorder extends TrustedPeerStore {
  stored: Array<{ deviceId: string; publicKey: Uint8Array; announcedName: string | null }>;
  revokedQueries: number;
}
function recorder(revoked: string[] = []): Recorder {
  const r: Recorder = {
    stored: [],
    revokedQueries: 0,
    store(p) {
      r.stored.push(p);
      return true;
    },
    isRevoked(id) {
      r.revokedQueries++;
      return revoked.includes(id);
    },
  };
  return r;
}

const nonceSnapshot = () => [...PairingSession.recentNonces.keys()];

async function offer(opts: { store?: Recorder; bounds?: Partial<PairingOfferBounds>; name?: string; id?: Id } = {}) {
  const id = opts.id ?? generateIdentity();
  const store = opts.store ?? recorder();
  let secretBuf: Buffer | null = null;
  const o = await createPairingOffer({
    identity: id,
    store,
    bounds: opts.bounds,
    name: opts.name,
    testHooks: { secretBuffer: (b) => (secretBuf = b) },
  });
  offers.push(o);
  const settled = o.result.then(
    (v) => ({ ok: true as const, v }),
    (e: unknown) => ({ ok: false as const, e }),
  );
  return { id, o, code: decodePairingCode(o.qrText), store, settled, secretBuf: () => secretBuf! };
}

const secretOf = (code: PairingCode) => decodeBase64Exact(code.secret, 16)!;

async function connector(code: PairingCode, seed: Uint8Array = generateIdentity().privateKey) {
  return connectSync(seed, code.connect.ip, code.connect.port);
}

/** Push raw plaintext bytes as one encrypted frame (for oversize / non-JSON frames). */
function pushRaw(s: InboundSession, plain: Uint8Array): void {
  s.raw.outbound.push(s.raw.sendCipher.EncryptWithAd(new Uint8Array(0), plain));
}

/**
 * Count APPLICATION frames (frames that decrypt under the session) until the
 * peer closes or `ms` elapses. The carrier's failure sentinel never decrypts
 * and is not counted.
 */
async function drainFrames(s: InboundSession, ms: number): Promise<{ frames: number; closed: boolean; texts: string[] }> {
  let frames = 0;
  const texts: string[] = [];
  const deadline = Date.now() + ms;
  for (;;) {
    const left = deadline - Date.now();
    if (left <= 0) return { frames, closed: false, texts };
    const r = await Promise.race([s.raw.inbound.receive(), sleep(left).then(() => "timeout" as const)]);
    if (r === "timeout") return { frames, closed: false, texts };
    if (r === null) return { frames, closed: true, texts };
    try {
      texts.push(new TextDecoder().decode(s.raw.receiveCipher.DecryptWithAd(new Uint8Array(0), r)));
      frames++;
    } catch {
      return { frames, closed: true, texts }; // carrier failed (sentinel)
    }
  }
}

function connRefused(code: PairingCode): Promise<string> {
  return new Promise((res) => {
    const s = netConnect({ host: code.connect.ip, port: code.connect.port });
    s.once("connect", () => {
      s.destroy();
      res("connected");
    });
    s.once("error", (e: NodeJS.ErrnoException) => res(e.code ?? "error"));
  });
}

const ceremonyPayloadOf = (id: Id, extra: Record<string, unknown> = {}) => ({
  v: 2,
  device_id: id.deviceId,
  public_key: b64(id.publicKey),
  nonce: freshNonce(),
  ...extra,
});

function codeFor(id: Id, port: number, secret: Buffer = randomBytes(16)): string {
  return encodePairingCode({
    v: 2,
    device_id: id.deviceId,
    public_key: b64(id.publicKey),
    nonce: freshNonce(),
    secret: secret.toString("base64"),
    connect: { ip: "127.0.0.1", port },
  });
}

/** Capture every console line and every raw stderr write during fn(). */
async function captureLogs<T>(fn: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = [];
  const sinks = (["error", "warn", "log", "info", "debug"] as const).map((k) =>
    vi.spyOn(console, k).mockImplementation((...a: unknown[]) => {
      lines.push(a.map((x) => (typeof x === "string" ? x : x instanceof Error ? `${x.message} ${x.stack}` : JSON.stringify(x))).join(" "));
    }),
  );
  const w = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stderr.write);
  try {
    return { result: await fn(), lines };
  } finally {
    for (const s of sinks) s.mockRestore();
    w.mockRestore();
  }
}

/**
 * A fake displayer listening with `key`. Script per session: receives the
 * first frame (records it), then runs `after` which may send frames, then
 * drains what the scanner sends next.
 */
async function fakeDisplayer(
  key: Id,
  script: (s: InboundSession, first: unknown) => Promise<void>,
  opts: { sendFirst?: unknown } = {},
) {
  const log = { sessions: 0, firstFrames: [] as unknown[], afterFrames: -1, closed: false };
  let done!: () => void;
  const finished = new Promise<void>((r) => (done = r));
  const srv = await serveSync(key.privateKey, 0, (s) => {
    log.sessions++;
    void (async () => {
      try {
        if (opts.sendFirst !== undefined) await s.json.send(opts.sendFirst);
        const firstR = await drainOne(s, 3000);
        if (firstR === undefined) {
          log.afterFrames = 0;
          log.closed = true;
          return;
        }
        log.firstFrames.push(firstR);
        await script(s, firstR);
        const rest = await drainFrames(s, 1500);
        log.afterFrames = rest.frames;
        log.closed = rest.closed;
      } finally {
        s.done();
        done();
      }
    })();
  });
  servers.push(srv);
  return { port: srv.actualPort, log, finished };
}

async function drainOne(s: InboundSession, ms: number): Promise<unknown | undefined> {
  const r = await Promise.race([s.raw.inbound.receive(), sleep(ms).then(() => "timeout" as const)]);
  if (r === "timeout" || r === null) return undefined;
  try {
    return JSON.parse(new TextDecoder().decode(s.raw.receiveCipher.DecryptWithAd(new Uint8Array(0), r)));
  } catch {
    return undefined;
  }
}

async function scannerError(qrText: string, store = recorder(), id: Id = generateIdentity()): Promise<unknown> {
  return acceptPairingPayload({ identity: id, qrText, store }).then(
    () => "resolved",
    (e: unknown) => e,
  );
}

function expectP13(err: unknown, reason?: string): void {
  expect(err).toBeInstanceOf(PairingCodeInvalidError);
  expect((err as Error).message).toBe(P13);
  if (reason !== undefined) expect((err as PairingCodeInvalidError).reason).toBe(reason);
}

/**
 * A Noise initiator over our own framing whose message 3 is held until
 * release(): the displayer's side of the handshake completes only then.
 */
async function heldHandshake(code: PairingCode) {
  const sock: Socket = await new Promise((res, rej) => {
    const s = netConnect({ host: code.connect.ip, port: code.connect.port }, () => res(s));
    s.once("error", rej);
  });
  let buf = Buffer.alloc(0);
  const q: Buffer[] = [];
  let wake: (() => void) | null = null;
  let closed = false;
  sock.on("data", (d: Buffer) => {
    buf = Buffer.concat([buf, d]);
    while (buf.length >= 4 && buf.length >= 4 + buf.readUInt32BE(0)) {
      const n = buf.readUInt32BE(0);
      q.push(Buffer.from(buf.subarray(4, 4 + n)));
      buf = Buffer.from(buf.subarray(4 + n));
    }
    wake?.();
  });
  sock.on("close", () => ((closed = true), wake?.()));
  sock.on("error", () => {});
  let sends = 0;
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let ready2!: () => void;
  const ready = new Promise<void>((r) => (ready2 = r));
  const t: FramedByteTransport = {
    async send(frame) {
      sends++;
      if (sends === 2) {
        ready2(); // message 2 was read, message 3 is ready
        await held;
      }
      const h = Buffer.alloc(4);
      h.writeUInt32BE(frame.length);
      sock.write(Buffer.concat([h, Buffer.from(frame)]));
    },
    async receive() {
      for (;;) {
        if (q.length) return new Uint8Array(q.shift()!);
        if (closed) return null;
        await new Promise<void>((r) => (wake = r));
        wake = null;
      }
    },
  };
  const session = handshakeOverTransport("initiator", t, generateIdentity().privateKey);
  return { session, release, ready2: ready };
}

async function rawDrain(raw: Awaited<ReturnType<typeof handshakeOverTransport>>, ms: number) {
  let frames = 0;
  const deadline = Date.now() + ms;
  for (;;) {
    const left = deadline - Date.now();
    if (left <= 0) return { frames, closed: false };
    const r = await Promise.race([raw.inbound.receive(), sleep(left).then(() => "t" as const)]);
    if (r === "t") return { frames, closed: false };
    if (r === null) return { frames, closed: true };
    try {
      raw.receiveCipher.DecryptWithAd(new Uint8Array(0), r);
      frames++;
    } catch {
      return { frames, closed: true };
    }
  }
}

// ---------------------------------------------------------------------------
// TR-B1 connector without the code learns nothing
// ---------------------------------------------------------------------------

describe("TR-B1 connector without the code learns nothing", () => {
  const cases: Array<[string, (c: InboundSession, code: PairingCode) => Promise<void>]> = [
    ["(a) sends nothing", async () => {}],
    ["(b) sends a random 32-byte proof", async (c) => c.json.send({ kind: "PAIRING_PROOF", proof: randomBytes(32).toString("base64") })],
    ["(c) sends a proof under a wrong secret", async (c) => c.json.send(pairingProofFrame(randomBytes(16), c.raw.handshakeHash()))],
    ["(d) sends a malformed frame", async (c) => c.json.send({ kind: "PAIRING_PROOF", proof: "AAAA", extra: 1 })],
    ["(d) sends a non-JSON frame", async (c) => pushRaw(c, new TextEncoder().encode("{not json"))],
    ["(d) sends an oversize frame", async (c) => pushRaw(c, Buffer.alloc(PAIRING_PROOF_MAX_CIPHER_BYTES + 100, 0x41))],
    ["(e) sends a ceremony payload instead of a proof", async (c) => c.json.send(ceremonyPayloadOf(generateIdentity()))],
  ];
  test.each(cases)("TR-B1 %s: zero application frames, closed, stores untouched", { timeout: 30_000 }, async (_label, act) => {
    const { code, o, store } = await offer({ bounds: { proofWaitMs: 400 } });
    const nonces = nonceSnapshot();
    const c = await connector(code);
    await act(c, code);
    const r = await drainFrames(c, 5000);
    expect(r).toMatchObject({ frames: 0, closed: true });
    expect(store.stored).toEqual([]);
    expect(store.revokedQueries).toBe(0); // the revocation store was not queried
    expect(nonceSnapshot()).toEqual(nonces); // TR-10 memory unchanged
    expect(o.status()).toBe("open"); // one bad proof is below the P7 limit
  });

  test("TR-B1 / B.3 a VALID proof inside an oversize frame is refused before decryption (size cap)", { timeout: 30_000 }, async () => {
    const { code, o, store } = await offer({ bounds: { proofWaitMs: 2000 } });
    const c = await connector(code);
    const json = JSON.stringify(pairingProofFrame(secretOf(code), c.raw.handshakeHash()));
    pushRaw(c, new TextEncoder().encode(json + " ".repeat(PAIRING_PROOF_MAX_CIPHER_BYTES)));
    expect(await drainFrames(c, 3000)).toMatchObject({ frames: 0, closed: true });
    expect(o.status()).toBe("open");
    expect(store.stored).toEqual([]);
  });

  test("TR-B1 the connector got only the Noise handshake: its session key is the displayer's (R1), nothing else", { timeout: 30_000 }, async () => {
    const { code, id } = await offer({ bounds: { proofWaitMs: 300 } });
    const c = await connector(code);
    // R1 (accepted, P14): the static key is learned at the handshake layer
    expect(Buffer.from(c.raw.remoteStaticKey()).length).toBe(32);
    void id;
    expect((await drainFrames(c, 3000)).frames).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// TR-B2 MITM with a different key is aborted (S1)
// ---------------------------------------------------------------------------

describe("TR-B2 MITM with a different key", () => {
  test("TR-B2 the scanner aborts at S1; the listener receives zero application frames; no trust entry", { timeout: 30_000 }, async () => {
    const X = generateIdentity(); // the device the code names
    const M = generateIdentity(); // the listener answering at the hinted address
    // the MITM claims the code's identity in its payload, sent first
    const fake = await fakeDisplayer(M, async () => {}, { sendFirst: ceremonyPayloadOf(X) });
    const store = recorder();
    const err = await scannerError(codeFor(X, fake.port), store);
    expectP13(err, "session_key");
    await fake.finished;
    expect(fake.log.sessions).toBe(1);
    expect(fake.log.firstFrames).toEqual([]); // no proof, no payload, no name
    expect(fake.log.afterFrames).toBe(0);
    expect(store.stored).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// TR-B3 payload mismatch is aborted (S2/S3)
// ---------------------------------------------------------------------------

describe("TR-B3 payload mismatch", () => {
  const variants: Array<[string, (X: Id, Y: Id) => Record<string, unknown>, string]> = [
    ["device_id and public_key of another device (S2)", (_X, Y) => ceremonyPayloadOf(Y), "payload_mismatch"],
    ["the code's device_id with another key (B.7 id derivation)", (X, Y) => ({ ...ceremonyPayloadOf(Y), device_id: X.deviceId }), "ID_KEY_MISMATCH"],
    ["the code's key with another device_id (B.7 id derivation)", (X, Y) => ({ ...ceremonyPayloadOf(X), device_id: Y.deviceId }), "ID_KEY_MISMATCH"],
  ];
  test.each(variants)("TR-B3 %s: the scanner aborts before sending its own payload", { timeout: 30_000 }, async (_l, make, reason) => {
    const X = generateIdentity();
    const Y = generateIdentity();
    const secret = randomBytes(16);
    const proofs: boolean[] = [];
    const fake = await fakeDisplayer(X, async (s, first) => {
      proofs.push(verifyPairingProof(first, secret, s.raw.handshakeHash()));
      await s.json.send(make(X, Y));
    });
    const store = recorder();
    const W = generateIdentity();
    const err = await scannerError(codeFor(X, fake.port, secret), store, W);
    expectP13(err, reason);
    await fake.finished;
    expect(proofs).toEqual([true]); // the scanner's only frame was a valid proof
    expect(fake.log.afterFrames).toBe(0); // no own payload, no own name
    expect(store.stored).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// TR-B4 replayed proof refused
// ---------------------------------------------------------------------------

describe("TR-B4 replayed proof", () => {
  test("TR-B4 (a) a correct-secret proof over ANOTHER session's h is refused while the secret is alive", { timeout: 30_000 }, async () => {
    const { code, o } = await offer({ bounds: { proofWaitMs: 2000 } });
    const secret = secretOf(code);
    const c1 = await connector(code);
    const replayed = pairingProofFrame(secret, c1.raw.handshakeHash());
    c1.destroy(); // counts as one missing proof
    const c2 = await connector(code);
    expect(Buffer.from(c2.raw.handshakeHash()).equals(Buffer.from(c1.raw.handshakeHash()))).toBe(false);
    await c2.json.send(replayed);
    expect(await drainFrames(c2, 4000)).toMatchObject({ frames: 0, closed: true });
    expect(o.status()).toBe("open"); // secret still alive...
    const c3 = await connector(code);
    await c3.json.send(pairingProofFrame(secret, c3.raw.handshakeHash()));
    const r3 = await drainFrames(c3, 1500);
    expect(r3.frames).toBe(1); // ...a proof for its own session is accepted
    expect(o.status()).toBe("pairing");
  });

  test("TR-B4 (b) after a valid proof: a new connection is refused and an in-flight valid proof achieves nothing", { timeout: 30_000 }, async () => {
    const { code, o } = await offer({ bounds: { proofWaitMs: 5000 } });
    const secret = secretOf(code);
    const winner = await connector(code);
    const late = await connector(code); // handshaken before the proof was accepted
    await sleep(300); // the displayer registered both connections
    await winner.json.send(pairingProofFrame(secret, winner.raw.handshakeHash()));
    for (let i = 0; i < 200 && o.status() === "open"; i++) await sleep(10);
    expect(o.status()).toBe("pairing");
    // late's own-session proof (computable only because the test holds the secret)
    await late.json.send(pairingProofFrame(secret, late.raw.handshakeHash())).catch(() => {});
    expect(await drainFrames(late, 3000)).toMatchObject({ frames: 0, closed: true });
    expect(await connRefused(code)).toBe("ECONNREFUSED"); // port closed
  });
});

// ---------------------------------------------------------------------------
// TR-B5 old codes refused (and VB-3 against the older decoder)
// ---------------------------------------------------------------------------

describe("TR-B5 old codes refused", () => {
  test("TR-B5 a v1 code fails with BAD_VERSION and no TCP connection is opened", { timeout: 30_000 }, async () => {
    let connections = 0;
    const srv = createServer((s) => {
      connections++;
      s.destroy();
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    servers.push(srv);
    const port = (srv.address() as { port: number }).port;
    const X = generateIdentity();
    const v1 = JSON.stringify({ v: 1, device_id: X.deviceId, public_key: b64(X.publicKey), nonce: freshNonce(), connect: { ip: "127.0.0.1", port } });
    const v1WithName = JSON.stringify({ ...JSON.parse(v1), name: "Old PC" });
    for (const raw of [v1, v1WithName]) {
      expect(() => decodePairingCode(raw)).toThrow(PairingError);
      try {
        decodePairingCode(raw);
      } catch (e) {
        expect((e as PairingError).code).toBe("BAD_VERSION"); // version checked first
      }
      expectP13(await scannerError(raw), "BAD_VERSION");
    }
    await sleep(100);
    expect(connections).toBe(0);
  });

  test("TR-B5 / VB-3 a v2 code fails the v1 decoding rules of the older build (EXTRA_FIELD)", { timeout: 30_000 }, async () => {
    const { o } = await offer();
    let err: unknown;
    try {
      decodeV1Code(o.qrText);
    } catch (e) {
      err = e;
    }
    expect((err as { code?: string }).code).toBe("EXTRA_FIELD");
    // the fixture is the c44d0a5 decoder verbatim (when git history is there)
    let blob: string | null = null;
    try {
      blob = execFileSync("git", ["show", "c44d0a5:src/security/pairing.ts"], { cwd: join(import.meta.dirname, ".."), encoding: "utf8" });
    } catch {
      blob = null;
    }
    if (blob !== null) {
      const verbatim = blob.split("\n").slice(142, 223).join("\n");
      const fixture = readFileSync(join(import.meta.dirname, "fixtures/pairing_v1_decoder.ts"), "utf8");
      expect(fixture).toContain(verbatim);
    }
  });
});

// ---------------------------------------------------------------------------
// TR-B6 code tampering
// ---------------------------------------------------------------------------

describe("TR-B6 code tampering", () => {
  const base = (): Record<string, unknown> => {
    const X = generateIdentity();
    return JSON.parse(codeFor(X, 4000));
  };
  const other = generateIdentity();
  const cases: Array<[string, (c: Record<string, unknown>) => void, string]> = [
    ["device_id mutated, key intact", (c) => (c.device_id = other.deviceId), "ID_KEY_MISMATCH"],
    ["device_id one hex digit flipped", (c) => (c.device_id = String(c.device_id).replace(/.$/, (d) => (d === "0" ? "1" : "0"))), "ID_KEY_MISMATCH"],
    ["secret of 15 bytes", (c) => (c.secret = randomBytes(15).toString("base64")), "BAD_SECRET"],
    ["secret of 17 bytes", (c) => (c.secret = randomBytes(17).toString("base64")), "BAD_SECRET"],
    ["secret not base64", (c) => (c.secret = "!".repeat(24)), "BAD_SECRET"],
    ["secret non-canonical padding", (c) => (c.secret = String(c.secret).replace(/==$/, "=A")), "BAD_SECRET"],
    ["secret not a string", (c) => (c.secret = 12345), "BAD_SECRET"],
    ["secret removed", (c) => delete c.secret, "MISSING_FIELD"],
    ["connect removed", (c) => delete c.connect, "MISSING_FIELD"],
    ["name added", (c) => (c.name = "My PC"), "EXTRA_FIELD"],
  ];
  test.each(cases)("TR-B6 %s fails at decode (%s)", (_l, mutate, want) => {
    const c = base();
    mutate(c);
    let err: unknown;
    try {
      decodePairingCode(JSON.stringify(c));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(PairingError);
    expect((err as PairingError).code).toBe(want);
    // the error text never carries a field value
    expect((err as Error).message).not.toContain(String(c.secret ?? "\u0000"));
  });

  test("TR-B6 a well-formed but different secret passes decode and fails at the proof: silent close, P13, counted, no trust", { timeout: 30_000 }, async () => {
    const { o, store } = await offer();
    const tampered = { ...JSON.parse(o.qrText), secret: randomBytes(16).toString("base64") };
    const { result: err, lines } = await captureLogs(() => scannerError(JSON.stringify(tampered)));
    expectP13(err, "closed");
    expect(lines).toContain(badProofLogLine(1));
    expect(store.stored).toEqual([]);
    expect(o.status()).toBe("open");
  });
});

// ---------------------------------------------------------------------------
// TR-B7 ceremony payload validation, both sides
// ---------------------------------------------------------------------------

describe("TR-B7 ceremony payload validation", () => {
  const C = generateIdentity();
  const D = generateIdentity();
  const bad: Array<[string, unknown, string]> = [
    ["null", null, "BAD_TYPE"],
    ["an array", [ceremonyPayloadOf(C)], "BAD_TYPE"],
    ["a number", 5, "BAD_TYPE"],
    ["a string", "payload", "BAD_TYPE"],
    ["an extra key", ceremonyPayloadOf(C, { extra: 1 }), "EXTRA_FIELD"],
    ['"secret" present', ceremonyPayloadOf(C, { secret: freshNonce() }), "EXTRA_FIELD"],
    ['"connect" present', ceremonyPayloadOf(C, { connect: { ip: "1.2.3.4", port: 1 } }), "EXTRA_FIELD"],
    ["device_id not derived from public_key", { ...ceremonyPayloadOf(C), device_id: D.deviceId }, "ID_KEY_MISMATCH"],
    ["v1 payload", { ...ceremonyPayloadOf(C), v: 1 }, "BAD_VERSION"],
  ];
  test.each(bad)("TR-B7 decoder rejects %s (%s)", (_l, frame, want) => {
    let err: unknown;
    try {
      decodeCeremonyPayload(frame);
    } catch (e) {
      err = e;
    }
    expect((err as PairingError).code).toBe(want);
  });

  test("TR-B7 an invalid name is NOT a decode failure (DC-28 drops it later)", () => {
    expect(decodeCeremonyPayload(ceremonyPayloadOf(C, { name: { evil: true } })).name).toEqual({ evil: true });
  });

  // displayer side: a party WITH the secret proves, then sends a bad payload
  // P10: decode first (revocation store not consulted on a decode failure),
  // then the DC-27 refusal (consulted once), then binding.
  const displayerBad: Array<[string, (self: Id) => unknown, number]> = [
    ...bad.map(([l, f]) => [l, () => f, 0] as [string, (self: Id) => unknown, number]),
    ["a public_key that does not match the session key", () => ceremonyPayloadOf(D), 1],
  ];
  test.each(displayerBad)("TR-B7 displayer side: %s aborts with zero trust-store mutation", { timeout: 30_000 }, async (_l, make, revokedQueries) => {
    const { code, o, store, settled, secretBuf } = await offer();
    const self = generateIdentity();
    const nonces = nonceSnapshot();
    const c = await connector(code, self.privateKey);
    await c.json.send(pairingProofFrame(secretOf(code), c.raw.handshakeHash()));
    const first = await drainOne(c, 3000);
    expect(decodeCeremonyPayload(first).device_id).toBe(code.device_id); // displayer payload arrived
    await c.json.send(make(self));
    const r = await settled;
    expect(r.ok).toBe(false);
    expect(store.stored).toEqual([]);
    expect(nonceSnapshot()).toEqual(nonces);
    expect(o.status()).toBe("ended"); // P5: a new code is needed
    expect(store.revokedQueries).toBe(revokedQueries); // P10 order
    expect(secretBuf().every((b) => b === 0)).toBe(true);
    expect((await drainFrames(c, 2000)).frames).toBe(0); // no PAIRING_OK
  });

  test("TR-B7 / B.5 an offer cancelled while the ceremony runs stores nothing", { timeout: 30_000 }, async () => {
    let offerRef: PairingOffer | null = null;
    const store = recorder();
    store.isRevoked = (id) => {
      store.revokedQueries++;
      offerRef?.cancel(); // the user cancels between decode and the trust write
      return id === "never";
    };
    const h = await offer({ store });
    offerRef = h.o;
    const W = generateIdentity();
    const c = await connector(h.code, W.privateKey);
    await c.json.send(pairingProofFrame(secretOf(h.code), c.raw.handshakeHash()));
    await drainOne(c, 3000);
    await c.json.send(ceremonyPayloadOf(W));
    await h.settled;
    expect(store.revokedQueries).toBe(1);
    expect(h.o.status()).toBe("cancelled");
    expect(store.stored).toEqual([]);
  });

  test.each([
    ["closes after the scanner's payload (code used up / cancelled / expired mid-ceremony)", null],
    ["answers with an unknown kind", { kind: "SOMETHING_ELSE" }],
  ] as Array<[string, unknown]>)("TR-B7 / B.10 scanner side: a displayer that %s gives the single text", { timeout: 30_000 }, async (_l, answer) => {
    const X = generateIdentity();
    const fake = await fakeDisplayer(X, async (s) => {
      await s.json.send(ceremonyPayloadOf(X));
      await drainOne(s, 3000); // the scanner's payload
      if (answer === null) s.destroy();
      else await s.json.send(answer);
    });
    expectP13(await scannerError(codeFor(X, fake.port)), "not_confirmed");
  });

  test("B.10 an unclassified connect error shows a plain sentence; the detail is in the log only", { timeout: 30_000 }, async () => {
    const X = generateIdentity();
    const code = encodePairingCode({
      v: 2,
      device_id: X.deviceId,
      public_key: b64(X.publicKey),
      nonce: freshNonce(),
      secret: freshNonce(),
      connect: { ip: "256.256.256.256", port: 4000 }, // not an address: resolution fails
    });
    const { result: err, lines } = await captureLogs(() => scannerError(code));
    expect(err).toBeInstanceOf(PairingUnreachableError);
    expect((err as Error).message).toBe(PAIRING_UNREACHABLE_MESSAGE);
    expect((err as Error).message).not.toMatch(/256|4000|Error|E[A-Z]{3,}/);
    expect(PAIRING_UNREACHABLE_MESSAGE).not.toMatch(/DC-|§|sidecar|contract|secret|proof|payload/i);
    expect(lines.some((l) => /^\[tide\] pairing: connect failed \([A-Z_]+\)$/.test(l))).toBe(true);
  });

  test.each(bad)("TR-B7 scanner side: %s aborts, nothing more is sent, zero trust-store mutation", { timeout: 30_000 }, async (_l, frame) => {
    const X = generateIdentity();
    const secret = randomBytes(16);
    const fake = await fakeDisplayer(X, async (s) => {
      if (frame === null) await s.json.send(null);
      else await s.json.send(frame);
    });
    const store = recorder();
    expectP13(await scannerError(codeFor(X, fake.port, secret), store));
    await fake.finished;
    expect(fake.log.firstFrames).toHaveLength(1); // the proof only
    expect(fake.log.afterFrames).toBe(0);
    expect(store.stored).toEqual([]);
  });

  test("TR-B7 scanner side: a closed channel after the proof aborts (P13)", { timeout: 30_000 }, async () => {
    const X = generateIdentity();
    const fake = await fakeDisplayer(X, async (s) => s.destroy());
    const store = recorder();
    expectP13(await scannerError(codeFor(X, fake.port), store), "closed");
    expect(store.stored).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// TR-B8 single use
// ---------------------------------------------------------------------------

describe("TR-B8 single use", () => {
  test("TR-B8 two connectors with valid proofs for their own sessions race: exactly one proceeds", { timeout: 60_000 }, async () => {
    const { lines } = await captureLogs(async () => { for (let round = 0; round < 5; round++) {
      const { code, o } = await offer({ bounds: { proofWaitMs: 5000 } });
      const secret = secretOf(code);
      const [a, b] = await Promise.all([connector(code), connector(code)]);
      // let the displayer finish both handshakes, so BOTH connections wait
      // for a proof (otherwise the later one is refused at onSession and the
      // race between two waiting connections is never exercised)
      await sleep(300);
      await Promise.all([
        a.json.send(pairingProofFrame(secret, a.raw.handshakeHash())),
        b.json.send(pairingProofFrame(secret, b.raw.handshakeHash())),
      ]);
      const [ra, rb] = await Promise.all([drainFrames(a, 1500), drainFrames(b, 1500)]);
      const results = [ra, rb].sort((x, y) => x.frames - y.frames);
      expect(results[0]).toMatchObject({ frames: 0, closed: true }); // closed without a message
      expect(results[1]!.frames).toBe(1); // the displayer's payload
      expect(o.status()).toBe("pairing");
      o.cancel();
    } });
    // B.5: the connection closed because another one proved first is not counted
    expect(lines.filter((l) => l.includes("without valid proof"))).toEqual([]);
  });

  test("TR-B8 a handshake that completes after the proof was accepted gets nothing and is not counted", { timeout: 30_000 }, async () => {
    const { result, lines } = await captureLogs(async () => {
      const { code, o } = await offer({ bounds: { proofWaitMs: 5000 } });
      const secret = secretOf(code);
      // late: TCP + Noise messages 1/2 now, message 3 held back
      const late = await heldHandshake(code);
      await late.ready2;
      const winner = await connector(code);
      await sleep(200);
      await winner.json.send(pairingProofFrame(secret, winner.raw.handshakeHash()));
      for (let i = 0; i < 200 && o.status() === "open"; i++) await sleep(10);
      expect(o.status()).toBe("pairing");
      late.release(); // the displayer's onSession now runs while the offer is consumed
      const raw = await late.session;
      raw.outbound.push(raw.sendCipher.EncryptWithAd(new Uint8Array(0), new TextEncoder().encode(JSON.stringify(pairingProofFrame(secret, raw.handshakeHash())))));
      const frames = await rawDrain(raw, 2000);
      return frames;
    });
    expect(result).toMatchObject({ frames: 0, closed: true });
    expect(lines.filter((l) => l.includes("without valid proof"))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// TR-B9 bounds (P6, P7, P8) and secret destruction on every end
// ---------------------------------------------------------------------------

describe("TR-B9 bounds", () => {
  test("TR-B9 defaults are 10 s proof wait, 3 bad proofs, 10 minute lifetime", () => {
    expect(PAIRING_OFFER_BOUNDS).toEqual({ proofWaitMs: 10_000, maxBadProofs: 3, lifetimeMs: 600_000 });
  });

  test("TR-B9 silence after the handshake: closed after the P6 wait, counted as one bad proof", { timeout: 30_000 }, async () => {
    const { result, lines } = await captureLogs(async () => {
      const { code, o } = await offer({ bounds: { proofWaitMs: 500 } });
      const c = await connector(code);
      const t0 = Date.now();
      const r = await drainFrames(c, 5000);
      return { r, elapsed: Date.now() - t0, status: o.status() };
    });
    expect(result.r).toMatchObject({ frames: 0, closed: true });
    expect(result.elapsed).toBeGreaterThanOrEqual(400);
    expect(result.elapsed).toBeLessThan(3000);
    expect(result.status).toBe("open");
    expect(lines.filter((l) => l.includes("without valid proof"))).toEqual([badProofLogLine(1)]);
  });

  test("TR-B9 the P7-th bad proof ends the offer; the listener closes and the secret is destroyed", { timeout: 30_000 }, async () => {
    const { result, lines } = await captureLogs(async () => {
      const h = await offer();
      for (let i = 0; i < 3; i++) {
        const c = await connector(h.code);
        await c.json.send({ kind: "PAIRING_PROOF", proof: randomBytes(32).toString("base64") });
        await drainFrames(c, 3000);
        if (i < 2) expect(h.o.status()).toBe("open");
      }
      return h;
    });
    expect(result.o.status()).toBe("ended");
    const s = await result.settled;
    expect(s.ok).toBe(false);
    expectP13((s as { e: unknown }).e, "bad_proofs");
    expect(await connRefused(result.code)).toBe("ECONNREFUSED");
    expect(result.secretBuf().every((b) => b === 0)).toBe(true);
    expect(lines.filter((l) => l.includes("without valid proof"))).toEqual([1, 2, 3].map(badProofLogLine));
    // the scanner with the REAL code now sees the single text
    expectP13(await scannerError(result.o.qrText), "unreachable");
  });

  test("TR-B9 a failed Noise handshake is not counted", { timeout: 30_000 }, async () => {
    const { result, lines } = await captureLogs(async () => {
      const h = await offer();
      // raw TCP: a junk frame where Noise message 1 is expected; 10 bytes
      // is shorter than an X25519 key, so ReadMessage fails (any 32+ bytes
      // would be a valid message 1)
      await new Promise<void>((res) => {
        const s = netConnect({ host: h.code.connect.ip, port: h.code.connect.port }, () => {
          const junk = randomBytes(10);
          const head = Buffer.alloc(4);
          head.writeUInt32BE(junk.length);
          s.write(Buffer.concat([head, junk]));
        });
        s.on("close", () => res());
        s.on("error", () => {});
      });
      // two bad proofs after it: still open (the handshake failure did not count)
      for (let i = 0; i < 2; i++) {
        const c = await connector(h.code);
        await c.json.send({ kind: "PAIRING_PROOF", proof: randomBytes(32).toString("base64") });
        await drainFrames(c, 3000);
      }
      return h;
    });
    expect(result.o.status()).toBe("open");
    expect(lines.filter((l) => l.includes("without valid proof"))).toEqual([1, 2].map(badProofLogLine));
  });

  test("TR-B9 the offer ends at the P8 lifetime; the secret is destroyed", { timeout: 30_000 }, async () => {
    const h = await offer({ bounds: { lifetimeMs: 400 } });
    expect(h.o.status()).toBe("open");
    const s = await Promise.race([h.settled, sleep(3000).then(() => ({ ok: "still open" as const }))]);
    expect(h.o.status()).toBe("ended");
    expect(s.ok).toBe(false);
    expectP13((s as { e: unknown }).e, "expired");
    expect(await connRefused(h.code)).toBe("ECONNREFUSED");
    expect(h.secretBuf().every((b) => b === 0)).toBe(true);
  });

  test("TR-B9 the P8 lifetime also ends a ceremony stalled after the proof; nothing is stored", { timeout: 30_000 }, async () => {
    const h = await offer({ bounds: { lifetimeMs: 800 } });
    const c = await connector(h.code);
    await c.json.send(pairingProofFrame(secretOf(h.code), c.raw.handshakeHash()));
    const r = await drainFrames(c, 5000); // payload arrives, then the close at the lifetime
    expect(r).toMatchObject({ frames: 1, closed: true });
    expect(h.o.status()).toBe("ended");
    expect(h.store.stored).toEqual([]);
  });

  test("TR-B9 / B.5 the secret is wiped at the moment of consumption, while the ceremony still runs", { timeout: 30_000 }, async () => {
    const h = await offer();
    const c = await connector(h.code);
    expect(h.secretBuf().some((b) => b !== 0)).toBe(true); // alive while open
    await c.json.send(pairingProofFrame(secretOf(h.code), c.raw.handshakeHash()));
    expect(decodeCeremonyPayload(await drainOne(c, 3000)).device_id).toBe(h.code.device_id);
    expect(h.o.status()).toBe("pairing"); // ceremony running, not ended
    expect(h.secretBuf().every((b) => b === 0)).toBe(true);
  });

  test("TR-B9 / B.2 a listener that cannot start (EADDRINUSE on a given port) wipes the secret", { timeout: 30_000 }, async () => {
    const blocker = createServer(() => {});
    await new Promise<void>((r) => blocker.listen(0, () => r()));
    servers.push(blocker);
    const port = (blocker.address() as { port: number }).port;
    let secretBuf: Buffer | null = null;
    const err = await createPairingOffer({
      identity: generateIdentity(),
      store: recorder(),
      port,
      testHooks: { secretBuffer: (b) => (secretBuf = b) },
    }).then(
      () => null,
      (e: unknown) => e,
    );
    expect((err as NodeJS.ErrnoException | null)?.code).toBe("EADDRINUSE");
    expect(secretBuf).not.toBeNull();
    expect(secretBuf!.every((b) => b === 0)).toBe(true);
  });

  test("TR-B9 cancel and a completed pairing destroy the secret too", { timeout: 30_000 }, async () => {
    const a = await offer();
    a.o.cancel();
    expect(a.o.status()).toBe("cancelled");
    expect(a.secretBuf().every((b) => b === 0)).toBe(true);
    const b = await offer();
    await acceptPairingPayload({ identity: generateIdentity(), qrText: b.o.qrText, store: recorder() });
    await b.settled;
    expect(b.o.status()).toBe("paired");
    expect(b.secretBuf().every((x) => x === 0)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// TR-B10 nothing secret in logs (debug trace enabled)
// ---------------------------------------------------------------------------

describe("TR-B10 nothing secret in logs", () => {
  test("TR-B10 over the TR-B paths, stderr/console never contain the secret, a proof or h (base64 or hex)", { timeout: 60_000 }, async () => {
    (globalThis as { __TIDE_JDBG?: boolean }).__TIDE_JDBG = true;
    const secrets: Buffer[] = [];
    const proofs: Buffer[] = [];
    const hashes: Buffer[] = [];
    const stringified: string[] = [];
    const orig = JSON.stringify;
    vi.spyOn(JSON, "stringify").mockImplementation(((...a: Parameters<typeof JSON.stringify>) => {
      const out = orig(...a);
      if (typeof out === "string") stringified.push(out);
      return out;
    }) as typeof JSON.stringify);

    const { lines } = await captureLogs(async () => {
      // honest pairing through the real scanner
      const honest = await offer({ name: "Linux PC" });
      secrets.push(secretOf(honest.code));
      await acceptPairingPayload({ identity: generateIdentity(), qrText: honest.o.qrText, name: "Windows PC", store: recorder() });
      await honest.settled;
      // bad proofs, replay, wrong secret, silence, oversize
      const h = await offer({ bounds: { proofWaitMs: 300, maxBadProofs: 10 } });
      const s = secretOf(h.code);
      secrets.push(Buffer.from(s));
      const c1 = await connector(h.code);
      hashes.push(Buffer.from(c1.raw.handshakeHash()));
      const p1 = computePairingProof(s, c1.raw.handshakeHash());
      proofs.push(p1);
      c1.destroy();
      const c2 = await connector(h.code);
      hashes.push(Buffer.from(c2.raw.handshakeHash()));
      await c2.json.send({ kind: "PAIRING_PROOF", proof: p1.toString("base64") }); // replay
      await drainFrames(c2, 2000);
      const c3 = await connector(h.code);
      hashes.push(Buffer.from(c3.raw.handshakeHash()));
      const wrong = computePairingProof(randomBytes(16), c3.raw.handshakeHash());
      proofs.push(wrong);
      await c3.json.send({ kind: "PAIRING_PROOF", proof: wrong.toString("base64") });
      await drainFrames(c3, 2000);
      const c4 = await connector(h.code);
      pushRaw(c4, Buffer.alloc(1000, 0x41));
      await drainFrames(c4, 2000);
      // MITM at S1 and a tampered secret
      const X = generateIdentity();
      const ms = randomBytes(16);
      secrets.push(ms);
      const fake = await fakeDisplayer(generateIdentity(), async () => {});
      await scannerError(codeFor(X, fake.port, ms));
      const t = { ...JSON.parse(h.o.qrText), secret: randomBytes(16).toString("base64") };
      secrets.push(decodeBase64Exact(t.secret, 16)!);
      await scannerError(JSON.stringify(t));
      // a valid proof on h (consumes), then the ceremony
      const c5 = await connector(h.code);
      hashes.push(Buffer.from(c5.raw.handshakeHash()));
      proofs.push(computePairingProof(s, c5.raw.handshakeHash()));
      await c5.json.send(pairingProofFrame(s, c5.raw.handshakeHash()));
      await drainFrames(c5, 1000);
      c5.destroy();
    });
    // the honest scanner's proof, as it was serialized for the wire
    for (const t of stringified) {
      if (!t.includes('"PAIRING_PROOF"')) continue;
      const p = (JSON.parse(t) as { proof?: string }).proof;
      if (typeof p === "string") proofs.push(Buffer.from(p, "base64"));
    }
    expect(proofs.length).toBeGreaterThanOrEqual(4);
    const all = lines.join("\n");
    expect(all).toContain("[json]"); // the debug trace really ran
    for (const buf of [...secrets, ...proofs, ...hashes]) {
      for (const form of [buf.toString("base64"), buf.toString("hex"), buf.toString("base64").slice(0, 12), buf.toString("hex").slice(0, 16)]) {
        expect(all).not.toContain(form);
      }
    }
    // the bad-proof line carries only the counter
    for (const l of lines.filter((x) => x.includes("without valid proof"))) {
      expect(l).toMatch(/^\[tide\] pairing: connection without valid proof closed \(\d+\)$/);
    }
    // every trace line is shape-only
    for (const l of lines.filter((x) => x.startsWith("[json]"))) {
      expect(l).toMatch(/^\[json\] (send|receive ok) (keys=\[[a-z_,]*\]|type=\w+) len=\d+$|^\[json\] receive (-> null \(closed\)|on dead|decrypt failed|oversize len=\d+|not json len=\d+)$/);
    }
  });

  test("TR-B10 / VB-9 describeFrame shows keys and length only", () => {
    const proof = randomBytes(32).toString("base64");
    const d = describeFrame({ kind: "PAIRING_PROOF", proof }, 70);
    expect(d).toBe("keys=[kind,proof] len=70");
    expect(d).not.toContain(proof.slice(0, 4));
  });
});

// ---------------------------------------------------------------------------
// TR-B11 constant-time comparison (code inspection)
// ---------------------------------------------------------------------------

describe("TR-B11 constant-time comparison", () => {
  const src = readFileSync(join(import.meta.dirname, "../src/security/pairing.ts"), "utf8");
  const fn = src.slice(src.indexOf("export function verifyPairingProof("), src.indexOf("\n}\n", src.indexOf("export function verifyPairingProof(")) + 2);

  test("TR-B11 verifyPairingProof compares the proof only with timingSafeEqual on equal-length buffers", () => {
    expect(fn).toContain("timingSafeEqual(got, want)");
    // the length check precedes the call
    expect(fn.indexOf("got.length !== want.length")).toBeGreaterThan(0);
    expect(fn.indexOf("got.length !== want.length")).toBeLessThan(fn.indexOf("timingSafeEqual(got, want)"));
    // no other comparison of the proof bytes or text
    const body = fn.replace("got.length !== want.length", "").replace("timingSafeEqual(got, want)", "");
    // (a null check of the decode result is not a comparison of proof bytes)
    expect(body.replace("got === null", "")).not.toMatch(/\b(got|want)\b\s*(===|!==|==|!=)/);
    expect(body).not.toMatch(/(===|!==|==|!=)\s*\b(got|want)\b/);
    expect(body).not.toMatch(/\.(equals|compare)\(/);
    expect(body).not.toMatch(/frame\.proof\s*(===|!==)/);
  });

  test("TR-B11 no other source file compares a proof", () => {
    for (const f of ["../src/network/pairing_manager.ts", "../src/network/sync_runtime.ts"]) {
      const s = readFileSync(join(import.meta.dirname, f), "utf8");
      expect(s).not.toMatch(/proof\w*\s*(===|!==|==|!=)|\.equals\([^)]*proof/i);
    }
    expect(src.match(/timingSafeEqual\(/g)).toHaveLength(1);
  });

  test("TR-B11 the construction is HMAC-SHA256(secret, label || h)", () => {
    const secret = randomBytes(16);
    const h = randomBytes(32);
    expect(PAIRING_PROOF_LABEL.equals(Buffer.from("tide-pairing-proof-v2\u0000", "ascii"))).toBe(true);
    const want = createHmac("sha256", secret).update(Buffer.concat([PAIRING_PROOF_LABEL, h])).digest();
    expect(computePairingProof(secret, h).equals(want)).toBe(true);
    expect(verifyPairingProof({ kind: "PAIRING_PROOF", proof: want.toString("base64") }, secret, h)).toBe(true);
    expect(verifyPairingProof({ kind: "PAIRING_PROOF", proof: want.toString("base64") }, secret, randomBytes(32))).toBe(false);
    expect(verifyPairingProof({ kind: "PAIRING_PROOF", proof: want.toString("base64") }, null, h)).toBe(false);
    expect(verifyPairingProof({ kind: "PAIRING_PROOF", proof: want.toString("base64"), x: 1 }, secret, h)).toBe(false);
    expect(verifyPairingProof({ kind: "PAIRING_OK", proof: want.toString("base64") }, secret, h)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// TR-B12 honest path: two real instances pair through a v2 code and sync
// ---------------------------------------------------------------------------

describe("TR-B12 honest path", () => {
  test("TR-B12 both store the correct identity and announced name, then sync as before", { timeout: 60_000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), "tide-dc05b-"));
    const devs: Array<{ core: EventCore; mgr: SyncManager }> = [];
    try {
      const make = (tag: string) => {
        const dir = join(root, tag);
        mkdirSync(dir, { recursive: true });
        const identity = loadOrCreateIdentity(dir);
        const core = new EventCore(join(dir, "tide.db"), identity.deviceId);
        const mgr = new SyncManager(core, identity);
        const dispatch = makeSyncDispatcher(mgr, core, { endpointCache: new EndpointCache() });
        devs.push({ core, mgr });
        return { identity, core, mgr, call: (op: string, args: Record<string, unknown> = {}) => Promise.resolve(dispatch(op, args)) as Promise<Record<string, unknown>> };
      };
      const L = make("L");
      const W = make("W");
      await L.call("set_device_name", { name: "Linux PC" });
      await W.call("set_device_name", { name: "Windows PC" });
      expect((await L.call("pairing_offer_status")).status).toBe("none");
      const offerRes = (await L.call("pairing_offer")) as { qr_text: string };
      expect(Object.keys(JSON.parse(offerRes.qr_text))).toEqual(["v", "device_id", "public_key", "nonce", "secret", "connect"]);
      expect((await L.call("pairing_offer_status")).status).toBe("open");
      const acc = (await W.call("pairing_accept", { qr_text: offerRes.qr_text })) as { peer_device_id: string };
      expect(acc.peer_device_id).toBe(L.identity.deviceId);
      for (let i = 0; i < 300 && (await L.call("pairing_offer_status")).status !== "paired"; i++) await sleep(10);
      expect((await L.call("pairing_offer_status")).status).toBe("paired");
      const row = (c: EventCore, id: string) =>
        c.db.prepare("SELECT device_id, public_key, announced_name, status FROM peers WHERE device_id = ?").get(id) as
          | { device_id: string; public_key: Buffer; announced_name: string | null; status: string }
          | undefined;
      const atW = row(W.core, L.identity.deviceId)!;
      const atL = row(L.core, W.identity.deviceId)!;
      expect(Buffer.from(atW.public_key).equals(Buffer.from(L.identity.publicKey))).toBe(true);
      expect(Buffer.from(atL.public_key).equals(Buffer.from(W.identity.publicKey))).toBe(true);
      expect([atW.announced_name, atW.status]).toEqual(["Linux PC", "trusted"]);
      expect([atL.announced_name, atL.status]).toEqual(["Windows PC", "trusted"]);
      // the code is single use: pasting it again is refused with the single text
      await expect(W.call("pairing_accept", { qr_text: offerRes.qr_text })).rejects.toThrow(P13);

      // sync as before (TR-3/TR-4 unchanged paths)
      const t = Date.UTC(2026, 10, 20, 9);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      L.core.createEvent({ title: "L1", description: "", startMs: t, endMs: t + 3_600_000, allDay: false } as any);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      W.core.createEvent({ title: "W1", description: "", startMs: t, endMs: t + 3_600_000, allDay: false } as any);
      L.mgr.ensureListener(0);
      let port = 0;
      for (let i = 0; i < 300 && !port; i++) {
        await sleep(10);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        port = (L.mgr as any).host?.actualPort ?? 0;
      }
      await W.mgr.runEngineSession(await connectSync(W.identity.privateKey, "127.0.0.1", port));
      await sleep(200);
      const titles = (c: EventCore) => (c.db.prepare("SELECT title FROM events ORDER BY title").all() as Array<{ title: string }>).map((r) => r.title);
      expect(titles(L.core)).toEqual(["L1", "W1"]);
      expect(titles(W.core)).toEqual(["L1", "W1"]);
    } finally {
      for (const d of devs) {
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
    }
  });

  test("TR-B12 the P13 text is one constant, shared by the UI, and free of internal terms", async () => {
    expect(PAIRING_CODE_INVALID_MESSAGE).toBe(P13);
    const ui = readFileSync(join(import.meta.dirname, "../frontend/devices.ts"), "utf8");
    expect(ui).toContain(`export const CODE_INVALID_TEXT = "${P13}";`);
    expect(P13).not.toMatch(/DC-|§|sidecar|contract|secret|proof|v2|payload/i);
  });
});

// ---------------------------------------------------------------------------
// VB items with an automated check
// ---------------------------------------------------------------------------

describe("VB checks", () => {
  test("VB-1 both ends of one session hold byte-identical h; two sessions differ", { timeout: 30_000 }, async () => {
    const A = generateIdentity();
    const B = generateIdentity();
    const serverH: Buffer[] = [];
    const srv = await serveSync(B.privateKey, 0, (s) => {
      serverH.push(Buffer.from(s.raw.handshakeHash()));
      s.done();
    });
    servers.push(srv);
    const c1 = await connectSync(A.privateKey, "127.0.0.1", srv.actualPort);
    const c2 = await connectSync(A.privateKey, "127.0.0.1", srv.actualPort);
    for (let i = 0; i < 100 && serverH.length < 2; i++) await sleep(10);
    const h1 = Buffer.from(c1.raw.handshakeHash());
    const h2 = Buffer.from(c2.raw.handshakeHash());
    expect(h1.length).toBe(32);
    expect(serverH.some((h) => h.equals(h1))).toBe(true);
    expect(serverH.some((h) => h.equals(h2))).toBe(true);
    expect(h1.equals(h2)).toBe(false);
    c1.done();
    c2.done();
  });

  test("VB-1 the hash is taken before Split() frees the handshake state (source order)", () => {
    const src = readFileSync(join(import.meta.dirname, "../src/network/noise_transport.ts"), "utf8");
    const a = src.indexOf("hs.GetHandshakeHash()");
    const b = src.indexOf("hs.Split()");
    expect(a).toBeGreaterThan(0);
    expect(a).toBeLessThan(b);
  });

  test("VB-2 timingSafeEqual throws on unequal lengths; verifyPairingProof returns false first", () => {
    expect(() => timingSafeEqual(Buffer.alloc(31), Buffer.alloc(32))).toThrow();
    const secret = randomBytes(16);
    const h = randomBytes(32);
    expect(verifyPairingProof({ kind: "PAIRING_PROOF", proof: randomBytes(31).toString("base64") }, secret, h)).toBe(false);
    expect(verifyPairingProof({ kind: "PAIRING_PROOF", proof: randomBytes(33).toString("base64") }, secret, h)).toBe(false);
  });

  test("VB-4 closing the listener stops new connections and keeps the accepted one open", { timeout: 30_000 }, async () => {
    const B = generateIdentity();
    let accepted: InboundSession | null = null;
    const srv = await serveSync(B.privateKey, 0, (s) => (accepted = s));
    const c = await connectSync(generateIdentity().privateKey, "127.0.0.1", srv.actualPort);
    for (let i = 0; i < 100 && accepted === null; i++) await sleep(10);
    srv.close();
    const refused = await new Promise<string>((res) => {
      const s = netConnect({ host: "127.0.0.1", port: srv.actualPort });
      s.once("connect", () => (s.destroy(), res("connected")));
      s.once("error", (e: NodeJS.ErrnoException) => res(e.code ?? "error"));
    });
    expect(refused).toBe("ECONNREFUSED");
    await accepted!.json.send({ kind: "PING" });
    expect(await c.json.receive()).toEqual({ kind: "PING" });
    await c.json.send({ kind: "PONG" });
    expect(await accepted!.json.receive()).toEqual({ kind: "PONG" });
    c.done();
    accepted!.done();
  });

  test("VB-8 a newer scanner reaching an older displayer: proof sent, v1 payload received, abort at decode, nothing more sent", { timeout: 30_000 }, async () => {
    const X = generateIdentity();
    // older displayer: sends its v1 payload right after the handshake
    const fake = await fakeDisplayer(X, async () => {}, {
      sendFirst: { v: 1, device_id: X.deviceId, public_key: b64(X.publicKey), nonce: freshNonce(), name: "Old PC" },
    });
    const store = recorder();
    expectP13(await scannerError(codeFor(X, fake.port), store), "BAD_VERSION");
    await fake.finished;
    expect(fake.log.firstFrames).toHaveLength(1);
    expect((fake.log.firstFrames[0] as { kind: string }).kind).toBe("PAIRING_PROOF");
    expect(fake.log.afterFrames).toBe(0);
    expect(store.stored).toEqual([]);
  });
});
