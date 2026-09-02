// Tide sync runtime: sidecar-side composition root for device-to-device
// synchronization (milestone: sidecar sync RPC + pairing flow).
//
// COMPOSITION ONLY — every cryptographic/protocol decision is made by the
// existing, tested modules; this file adds:
//   - persisted identity bootstrap (DC-05 §2: once per installation)
//   - length-prefix-framed TCP carrier for Noise frames
//   - host/connect session management over that carrier
//   - pairing payload convenience helper
import { createServer, connect, type Server, type Socket } from "node:net";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { networkInterfaces } from "node:os";
import {
  generateIdentity,
  identityFromPrivateKey,
  type DeviceIdentity,
} from "../security/identity.ts";
import {
  FramingError,
  handshakeOverTransport,
  type FramedByteTransport,
  type NoiseTransportHandle,
  type RawSessionHandle,
  NoiseSessionTransport,
} from "./noise_transport.ts";

const KEY_FILE = "device_identity.key";
export const SYNC_DEFAULT_PORT = 47471;
const MAX_FRAME = 4 * 1024 * 1024;

export type SyncChannel = NoiseTransportHandle;

// ---------------------------------------------------------------------------
// Identity bootstrap
// ---------------------------------------------------------------------------

/** Load or create this installation's Ed25519 identity (0600 key file). */
export function loadOrCreateIdentity(dataDir: string): DeviceIdentity {
  const path = join(dataDir, KEY_FILE);
  if (existsSync(path)) {
    return identityFromPrivateKey(new Uint8Array(readFileSync(path)));
  }
  const id = generateIdentity();
  writeFileSync(path, Buffer.from(id.privateKey), { mode: 0o600 });
  // NOTE(key custody): OS-keystore binding is a tracked pre-ship requirement;
  // until then the raw seed lives next to the DB with restrictive mode.
  return id;
}

// ---------------------------------------------------------------------------
// TCP framing
// ---------------------------------------------------------------------------

/**
 * Length-prefix framing adapter over a TCP socket (4-byte BE header).
 * Tracks queued-but-unwritten bytes so owners can close only after flush.
 */
function socketFraming(
  sock: Socket,
): FramedByteTransport & { readonly flushing: boolean } {
  let buffer = Buffer.alloc(0);
  const queue: Buffer[] = [];
  let notify: (() => void) | null = null;
  let closed = false;

  const wake = (): void => {
    if (notify && (queue.length > 0 || closed)) {
      const n = notify;
      notify = null;
      n();
    }
  };
  // TD-018 (pkg9 review F1/F2): distinguish ERROR from CLEAN CLOSE. `closed`
  // alone resolves receive() as null (FIN = clean EOF). When the carrier
  // FAILED (RST / socket exception / oversized frame — 'error' event or
  // over-MAX_FRAME), receive() REJECTS with FramingError instead. The Noise
  // feed loop catches that rejection and pushes its sentinel frame, making
  // the session end LOUD (SessionError) rather than masquerading as a clean
  // converged close (DC-05 §6.3). The failure state lives on the framing
  // OBJECT itself — never on the raw socket (pkg9 F1: accessor on `sock`
  // was unreachable dead code).
  let failed = false;
  const fail = (err?: boolean): void => {
    closed = true;
    if (err) failed = true;
    wake();
  };

  sock.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4 && !closed) {
      const len = buffer.readUInt32BE(0);
      if (len > MAX_FRAME) {
        failed = true; // protocol-level framing violation: carrier failure
        sock.destroy();
        return;
      }
      if (buffer.length < 4 + len) break;
      queue.push(Buffer.from(buffer.subarray(4, 4 + len)));
      buffer = Buffer.from(buffer.subarray(4 + len));
    }
    wake();
  });
  sock.on("close", () => fail()); // FIN-path: clean close, NOT failed
  sock.on("error", () => fail(true)); // carrier failure
  sock.on("end", () => fail()); // peer half-close: clean, NOT failed

  let pendingWrites = 0;
  return {
    /** Resolves when the frame is handed to the kernel AND flushed. */
    async send(frame: Uint8Array): Promise<void> {
      if (closed || sock.destroyed) throw new Error("socket closed");
      const head = Buffer.alloc(4);
      head.writeUInt32BE(frame.length, 0);
      pendingWrites++;
      await new Promise<void>((resolve, reject) => {
        sock.write(head, (e1) => {
          if (e1) {
            pendingWrites--;
            reject(e1);
            return;
          }
          sock.write(Buffer.from(frame), (e2) => {
            pendingWrites--;
            if (e2) reject(e2);
            else resolve();
          });
        });
      });
      // cork: wait until kernel buffer flushed below watermark
      await new Promise<void>((resolve) => {
        if (pendingWrites > 0 || sock.writableLength > 0) {
          const check = (): void => {
            if (sock.writableLength === 0 || sock.destroyed) resolve();
            else sock.once("drain", check);
          };
          check();
        } else resolve();
      });
    },
    /** True while frames are still being flushed to the kernel. */
    get flushing(): boolean {
      return pendingWrites > 0 || sock.writableLength > 0;
    },
    async receive(): Promise<Uint8Array | null> {
      if (queue.length > 0) return new Uint8Array(queue.shift()!);
      // TD-018 (pkg9 F1/F2): a FAILED carrier REJECTS (FramingError) — the
      // Noise feed loop converts this into the loud SessionError sentinel.
      // A cleanly-closed carrier still resolves null (FIN = clean EOF).
      if (closed && failed) throw new FramingError("sync carrier failed (RST/socket error/oversize frame)");
      if (closed) return null;
      await new Promise<void>((resolve) => {
        notify = resolve;
      });
      if (queue.length > 0) return new Uint8Array(queue.shift()!);
      if (failed) throw new FramingError("sync carrier failed (RST/socket error/oversize frame)");
      return null; // closed while waiting (clean)
    },
  };
}

// ---------------------------------------------------------------------------
// Host / connect
// ---------------------------------------------------------------------------

export interface InboundSession {
  /** Raw cipher handle (transport-level access). */
  raw: RawSessionHandle;
  /** SyncMessage-typed channel — what createSyncEngine consumes. */
  transport: NoiseTransportHandle;
  /** Free-form JSON channel for the pairing ceremony. */
  json: JsonChannel;
  /** Ends the underlying connection (call after use finishes). */
  done(): void;
  /**
   * DC-21 D6: the endpoint this session DIALED (scheduler/connectSync path
   * only; undefined for inbound sessions). Recorded into the peers table as
   * the last-known endpoint ONLY after a successful authenticated session.
   */
  dialEndpoint?: { host: string; port: number };
}

/**
 * Listen for inbound Noise_XX RESPONDER sessions on `port`.
 * `onSession` is invoked per authenticated connection with a RAW cipher
 * handle plus ready-made SyncMessage and JSON channels over it.
 */
export function serveSync(
  identitySeed: Uint8Array,
  port: number,
  onSession: (s: InboundSession) => void,
): Promise<{ actualPort: number; close(): void }> {
  const server: Server = createServer((sock) => {
    void (async () => {
      try {
        const inner = socketFraming(sock);
        const raw = await handshakeOverTransport(
          "responder",
          inner,
          identitySeed,
        );
        const framing = inner as FramedByteTransport & { flushing?: boolean };
        const doneOnce = (() => {
          let called = false;
          return (): void => {
            if (called) return;
            called = true;
            // Give queued frames a moment to flush before ending the socket.
            const finish = (): void => {
              sock.end();
            };
            if (framing.flushing) setTimeout(finish, 50);
            else finish();
          };
        })();
        onSession({
          raw,
          transport: new NoiseSessionTransport(
            raw.sendCipher,
            raw.receiveCipher,
            raw.handshakeHash(),
            raw.remoteStaticKey(),
            raw.inbound,
            raw.outbound,
            "responder",
          ),
          json: makeJsonChannel(raw),
          done: doneOnce,
        });
      } catch {
        // Fail-closed: any handshake error kills the socket, no plaintext path.
        sock.destroy();
      }
    })();
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, () => {
      const addr = server.address();
      const actualPort =
        typeof addr === "object" && addr !== null ? addr.port : port;
      resolve({ actualPort, close: () => server.close() });
    });
  });
}

/** Outbound session to a peer: connect TCP, run Noise_XX INITIATOR. */
export async function connectSync(
  identitySeed: Uint8Array,
  host: string,
  port: number,
): Promise<InboundSession> {
  const sock = await new Promise<Socket>((resolve, reject) => {
    const s = connect({ host, port }, () => resolve(s));
    s.once("error", reject);
  });
  const inner = socketFraming(sock);
  const raw = await handshakeOverTransport("initiator", inner, identitySeed);
  return {
    raw,
    transport: new NoiseSessionTransport(
      raw.sendCipher,
      raw.receiveCipher,
      raw.handshakeHash(),
      raw.remoteStaticKey(),
      raw.inbound,
      raw.outbound,
      "initiator",
    ),
    json: makeJsonChannel(raw),
    done: () => {
      const framing = inner as FramedByteTransport & { flushing?: boolean };
      if (framing.flushing) setTimeout(() => sock.end(), 50);
      else sock.end();
    },
  };
}

// ---------------------------------------------------------------------------
// JSON channel over a raw session (pairing ceremony framing)
// ---------------------------------------------------------------------------

export interface JsonChannel {
  send(obj: unknown): Promise<void>;
  receive(): Promise<unknown>;
}

/** Set to log channel lifecycle (debug). */
export const JSON_CHANNEL_DEBUG = false;
function jdbg(m: string): void {
  if ((globalThis as { __TIDE_JDBG?: boolean }).__TIDE_JDBG)
    console.error("[json]", m);
}

/**
 * JSON-per-frame codec over a raw Noise session. Every frame is AEAD
 * encrypted/decrypted by the same cipher states the engine path uses —
 * no plaintext route exists.
 */
function makeJsonChannel(raw: RawSessionHandle): JsonChannel {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  let dead = false;
  return {
    async send(obj: unknown): Promise<void> {
      jdbg("send " + JSON.stringify(obj).slice(0, 60));
      if (dead) throw new Error("json channel dead");
      const frame = raw.sendCipher.EncryptWithAd(
        new Uint8Array(0),
        enc.encode(JSON.stringify(obj)),
      );
      raw.outbound.push(frame);
    },
    async receive(): Promise<unknown> {
      if (dead) { jdbg("receive on dead"); throw new Error("json channel dead"); }
      const frame = await raw.inbound.receive();
      if (frame === null) { jdbg("receive -> null (closed)"); return null; }
      let plain: Uint8Array;
      try {
        plain = raw.receiveCipher.DecryptWithAd(new Uint8Array(0), frame);
      } catch (err) {
        dead = true;
        try { raw.sendCipher.free(); raw.receiveCipher.free(); } catch {}
        throw new Error(`json channel decrypt failed (fail-closed): ${String(err)}`);
      }
      const obj = JSON.parse(dec.decode(plain)) as unknown;
      jdbg("receive ok " + JSON.stringify(obj).slice(0, 60));
      return obj;
    },
  };
}

// ---------------------------------------------------------------------------
// Pairing payload convenience (DC-05 §5.1)
// ---------------------------------------------------------------------------

/**
 * Build this device's QR payload fields except the nonce — the nonce is
 * ceremony state and MUST come from freshNonce()/PairingSession ownership.
 */
export function makePairingPayload(
  identity: DeviceIdentity,
  port: number,
  name?: string,
): {
  v: 1;
  device_id: string;
  public_key: string;
  connect: { ip: string; port: number };
} {
  return {
    v: 1,
    device_id: identity.deviceId,
    public_key: Buffer.from(identity.publicKey).toString("base64"),
    connect: { ip: localIpHint(), port },
    ...(name !== undefined ? { name } : {}),
  };
}

/** Best-effort LAN address hint (first non-internal IPv4). */
function localIpHint(): string {
  for (const list of Object.values(networkInterfaces())) {
    for (const net of list ?? []) {
      if (net.family === "IPv4" && !net.internal) return net.address;
    }
  }
  return "127.0.0.1";
}
