// Tide DC-05 §4/§6 — Noise_XX_25519_ChaChaPoly_SHA256 encrypted transport.
//
// FROZEN DECISION (DC-05 §4): all session transport security uses the Noise
// Protocol Framework pattern Noise_XX_25519_ChaChaPoly_SHA256, performed by
// an ESTABLISHED LIBRARY (Spec §17 hard constraint: no custom cryptographic
// primitives or handshake logic may be implemented in-house). This module
// binds the `noise-c.wasm` package — a WebAssembly build of rweather/noise-c,
// the reference C Noise Framework implementation — and adapts it to the
// SyncTransport interface of src/sync/sync_engine.ts so the sync engine plugs
// in UNCHANGED (DC-08 §4).
//
// DC-05 §6.3 fail-closed rules enforced structurally below:
//   - No plaintext fallback: there is exactly ONE path from send() to the
//     wire (through CipherState.EncryptWithAd) and ONE path from the wire to
//     receive()'s caller (through CipherState.DecryptWithAd + JSON.parse).
//     Neither has an alternate branch; any failure marks the transport DEAD
//     and throws SessionError. There is no code path that emits or accepts
//     unencrypted application payload.
//   - Decrypt/authenticity failure => SessionError + transport marked dead.
//   - Replay protection is provided by the library's transport CipherState
//     nonce discipline: each successful DecryptWithAd advances a strictly
//     monotonic nonce, so a replayed or reordered frame fails the AEAD check
//     and trips the same fail-closed path (DC-05 T4).

import { createRequire } from "node:module";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256, sha512 } from "@noble/hashes/sha2.js";
// Established, audited library for the Ed25519 -> X25519 montgomery map
// (DC-05 §4; Spec §17: no custom cryptographic primitives).
import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import type { SyncMessage, SyncTransport } from "../sync/sync_engine.ts";

/** Frozen v1 cipher suite name (DC-05 §4). */
export const NOISE_PROTOCOL_NAME = "Noise_XX_25519_ChaChaPoly_SHA256";

/**
 * Thrown for any session-security failure: decrypt/authentication failure,
 * replayed or malformed frames, use of a dead transport, handshake failure.
 * Per DC-05 §6.3 every such error is terminal for the session.
 */
export class SessionError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "SessionError";
    if (options && options.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

export interface NoiseStaticKeyPair {
  privateKey: Uint8Array;
  publicKey: Uint8Array;
}

/** Post-handshake directional transport cipher keys (Split() outputs). */
export interface SessionKeys {
  sendKey: Uint8Array;
  receiveKey: Uint8Array;
}

// ---------------------------------------------------------------------------
// noise-c.wasm binding (untyped CJS/WASM package — minimal structural types)
// ---------------------------------------------------------------------------

interface NoiseCipherState {
  InitializeKey(key: Uint8Array | null): void;
  HasKey(): boolean;
  SetNonce(nonce: number): void;
  EncryptWithAd(ad: Uint8Array | null, plaintext: Uint8Array): Uint8Array;
  DecryptWithAd(ad: Uint8Array | null, ciphertext: Uint8Array): Uint8Array;
  Rekey(): void;
  free(): void;
}

interface NoiseHandshakeState {
  Initialize(
    prologue: Uint8Array | null,
    s: Uint8Array | null,
    rs: Uint8Array | null,
    psk: Uint8Array | null,
  ): void;
  GetAction(): number;
  WriteMessage(payload?: Uint8Array | null): Uint8Array;
  ReadMessage(message: Uint8Array, payloadNeeded?: boolean): Uint8Array | null;
  GetHandshakeHash(): Uint8Array;
  GetRemotePublicKey(): Uint8Array;
  Split(): [NoiseCipherState, NoiseCipherState];
  free(): void;
}

interface NoiseConstants {
  NOISE_ROLE_INITIATOR: number;
  NOISE_ROLE_RESPONDER: number;
  NOISE_DH_CURVE25519: number;
  NOISE_ACTION_SPLIT: number;
  /** Cipher id for ChaCha20-Poly1305 (noise-c.wasm constant, = 17153). */
  NOISE_CIPHER_CHACHAPOLY: number;
}

interface NoiseApi {
  constants: NoiseConstants;
  CreateKeyPair(curveId: number): [Uint8Array, Uint8Array];
  CipherState: new (cipherId: number) => NoiseCipherState;
  HandshakeState: new (
    protocolName: string,
    role: number,
  ) => NoiseHandshakeState;
}

type NoiseFactory = (callback: (lib: NoiseApi) => void) => void;

let libraryPromise: Promise<NoiseApi> | null = null;

/** Load the WASM Noise library once per process. */
function loadNoiseLibrary(): Promise<NoiseApi> {
  if (libraryPromise === null) {
    libraryPromise = new Promise<NoiseApi>((resolve, reject) => {
      try {
        // createRequire keeps the CJS package out of TS type resolution and
        // lets Emscripten's Node glue load its .wasm via fs as designed.
        const requireCjs = createRequire(import.meta.url);
        const factory = requireCjs("noise-c.wasm") as NoiseFactory;
        factory((lib) => resolve(lib));
      } catch (err) {
        reject(new SessionError("failed to load noise-c.wasm", { cause: err }));
      }
    });
  }
  return libraryPromise;
}

const EMPTY_AD = new Uint8Array(0);
const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

function generateStaticKeys(lib: NoiseApi): NoiseStaticKeyPair {
  const [privateKey, publicKey] = lib.CreateKeyPair(
    lib.constants.NOISE_DH_CURVE25519,
  );
  return { privateKey, publicKey };
}

// ---------------------------------------------------------------------------
// Ed25519 -> X25519 identity binding (DC-05 §4)
// ---------------------------------------------------------------------------

/**
 * Deterministic Ed25519 -> X25519 PRIVATE key conversion (DC-05 §4):
 * SHA-512 of the 32-byte Ed25519 seed, first 32 bytes of the digest clamped
 * per the X25519 scalar rules (b[0] &= 248; b[31] &= 127; b[31] |= 64).
 * This is byte-for-byte the construction libsodium performs inside
 * `crypto_sign_ed25519_sk_to_curve25519` and that @noble/curves applies via
 * its own `toMontgomerySecret` — the scalar arithmetic itself is done by the
 * established libraries, never hand-rolled beyond the published clamp.
 *
 * Throws SessionError on any key that is not exactly 32 bytes.
 */
export function ed25519ToX25519PrivateKey(edPrivateKey: Uint8Array): Uint8Array {
  if (edPrivateKey.length !== 32) {
    throw new SessionError(
      `ed25519 private key must be 32 bytes (got ${edPrivateKey.length})`,
    );
  }
  const digest = sha512(edPrivateKey);
  const scalar = digest.slice(0, 32);
  scalar[0]! &= 248;
  scalar[31]! &= 127;
  scalar[31]! |= 64;
  return scalar;
}

/**
 * Deterministic Ed25519 -> X25519 PUBLIC key conversion (DC-05 §4): the
 * standard birational montgomery map u = (1 + y) / (1 - y), performed by
 * @noble/curves (`ed25519.utils.toMontgomery`, the current name of the
 * historical `edwardsToMontgomeryPub`; equivalent to libsodium's
 * `crypto_sign_ed25519_pk_to_curve25519`). Satisfies the §4 invariant:
 * X25519(edToX25519Priv(seed)) == edToX25519Pub(edPub(seed)).
 *
 * Throws SessionError on any key that is not exactly 32 bytes.
 */
export function ed25519ToX25519PublicKey(edPublicKey: Uint8Array): Uint8Array {
  if (edPublicKey.length !== 32) {
    throw new SessionError(
      `ed25519 public key must be 32 bytes (got ${edPublicKey.length})`,
    );
  }
  return ed25519.utils.toMontgomery(edPublicKey);
}

/**
 * Noise_XX static keypair DETERMINISTICALLY DERIVED from an Ed25519 identity
 * seed (DC-05 §4): the static is bound to the device identity instead of
 * being random. Production devices MUST use this path; random statics are
 * for tests only.
 */
export function noiseStaticsFromIdentity(
  identitySeed: Uint8Array,
): NoiseStaticKeyPair {
  const privateKey = ed25519ToX25519PrivateKey(identitySeed);
  return { privateKey, publicKey: x25519.getPublicKey(privateKey) };
}

// ---------------------------------------------------------------------------
// In-memory ciphertext frame plumbing (test/local loopback)
// ---------------------------------------------------------------------------

/**
 * One end of a lossless ordered byte-frame pipe. Frames on this pipe are
 * ALWAYS ciphertext produced by a Noise CipherState — nothing else ever
 * writes to it (fail-closed structure, see header comment).
 */
class FrameQueue {
  private queue: Uint8Array[] = [];
  private waiter: ((frame: Uint8Array | null) => void) | null = null;
  private closed = false;

  push(frame: Uint8Array): void {
    if (this.closed) return;
    if (this.waiter !== null) {
      const w = this.waiter;
      this.waiter = null;
      w(frame);
      return;
    }
    this.queue.push(frame);
  }

  receive(): Promise<Uint8Array | null> {
    const next = this.queue.shift();
    if (next !== undefined) return Promise.resolve(next);
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve) => {
      this.waiter = resolve;
    });
  }

  close(): void {
    this.closed = true;
    if (this.waiter !== null) {
      const w = this.waiter;
      this.waiter = null;
      w(null);
    }
  }
}

export type FrameTap = (
  from: "initiator" | "responder" | "session",
  frame: Uint8Array,
) => void;

// ---------------------------------------------------------------------------
// XX handshake over a frame pipe
// ---------------------------------------------------------------------------

interface HandshakeResult {
  sendCipher: NoiseCipherState;
  receiveCipher: NoiseCipherState;
  handshakeHash: Uint8Array;
  remoteStaticKey: Uint8Array;
}

async function runXxHandshake(
  lib: NoiseApi,
  roleConstant: number,
  inbound: FrameQueue,
  outbound: FrameQueue,
  staticKeys: NoiseStaticKeyPair,
  tap: FrameTap | undefined,
  tapFrom: "initiator" | "responder",
): Promise<HandshakeResult> {
  const hs = new lib.HandshakeState(NOISE_PROTOCOL_NAME, roleConstant);
  const send = (frame: Uint8Array): void => {
    tap?.(tapFrom, frame);
    outbound.push(frame);
  };
  const recv = async (): Promise<Uint8Array> => {
    const frame = await inbound.receive();
    if (frame === null) {
      throw new SessionError("peer closed during handshake");
    }
    return frame;
  };

  try {
    // Empty prologue; static key contributed by each side (XX: -> e, <- e ee s es, -> s se).
    hs.Initialize(EMPTY_AD, staticKeys.privateKey, null, null);
    if (roleConstant === lib.constants.NOISE_ROLE_INITIATOR) {
      send(hs.WriteMessage(null)); // -> e
      hs.ReadMessage(await recv()); // <- e, ee, s, es
      send(hs.WriteMessage(null)); // -> s, se
    } else {
      hs.ReadMessage(await recv()); // -> e
      send(hs.WriteMessage(null)); // <- e, ee, s, es
      hs.ReadMessage(await recv(), true); // -> s, se
    }
    if (hs.GetAction() !== lib.constants.NOISE_ACTION_SPLIT) {
      throw new SessionError(
        `handshake did not complete (action=${hs.GetAction()})`,
      );
    }
    const handshakeHash = new Uint8Array(hs.GetHandshakeHash());
    const remoteStaticKey = new Uint8Array(hs.GetRemotePublicKey());
    // NOTE: Split() frees the HandshakeState internally on success (see
    // noise-c.wasm index.js). A further hs.free() here would be a double-free
    // and throw NOISE_ERROR_INVALID_PARAM.
    const [sendCipher, receiveCipher] = hs.Split();
    return { sendCipher, receiveCipher, handshakeHash, remoteStaticKey };
  } catch (err) {
    // On any failure path where Split() did not run, free explicitly.
    try {
      if (hs.GetAction() !== lib.constants.NOISE_ACTION_SPLIT) hs.free();
    } catch {
      /* already freed or invalid — nothing to reclaim */
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// The encrypted SyncTransport
// ---------------------------------------------------------------------------

export interface NoiseTransportHandle extends SyncTransport {
  /** Transcript hash from the completed XX handshake (channel binding input, DC-05 §6.1 V3). */
  handshakeHash(): Uint8Array;
  /** Remote X25519 static key learned during the handshake. */
  remoteStaticKey(): Uint8Array;
  /** True once any session-security failure has occurred (terminal, §6.3). */
  isDead(): boolean;
  /**
   * Test/diagnostics hook: inject a raw wire frame directly into this
   * endpoint's inbound path, bypassing the peer. Used by tests to feed
   * tampered / foreign / replayed ciphertext.
   */
  injectInboundFrame(frame: Uint8Array): void;
}

class NoiseSessionTransport implements NoiseTransportHandle {
  private dead = false;

  constructor(
    private readonly sendCipher: NoiseCipherState,
    private readonly receiveCipher: NoiseCipherState,
    private readonly transcriptHash: Uint8Array,
    private readonly peerStaticKey: Uint8Array,
    private readonly inbound: FrameQueue,
    private readonly outbound: FrameQueue,
    private readonly label: string,
    private readonly tap?: (from: "initiator" | "responder" | "session", frame: Uint8Array) => void,
  ) {}

  async send(msg: SyncMessage): Promise<void> {
    this.assertAlive("send");
    const plaintext = TEXT_ENCODER.encode(JSON.stringify(msg));
    let frame: Uint8Array;
    try {
      // THE ONLY egress path for application data.
      frame = this.sendCipher.EncryptWithAd(EMPTY_AD, plaintext);
    } catch (err) {
      this.markDead(err);
      throw new SessionError(`${this.label}: encrypt failed`, { cause: err });
    }
    // Observe the actual post-encryption ciphertext frame (test tap).
    this.tap?.("session", frame);
    this.outbound.push(frame);
  }

  async receive(): Promise<SyncMessage | null> {
    this.assertAlive("receive");
    const frame = await this.inbound.receive();
    if (frame === null) return null; // peer closed cleanly; not a crypto failure

    let plaintextBytes: Uint8Array;
    try {
      // THE ONLY ingress path for application data. A decrypt failure here
      // covers tampering AND replay (nonce state advances only on success).
      plaintextBytes = this.receiveCipher.DecryptWithAd(EMPTY_AD, frame);
    } catch (err) {
      this.markDead(err); // §6.3: fail closed, session dead, no fallback
      throw new SessionError(`${this.label}: decryption failed`, {
        cause: err,
      });
    }

    let msg: unknown;
    try {
      msg = JSON.parse(TEXT_DECODER.decode(plaintextBytes));
    } catch (err) {
      // Authenticated but not a SyncMessage: refuse, fail closed.
      this.markDead(err);
      throw new SessionError(`${this.label}: decrypted frame is not JSON`, {
        cause: err,
      });
    }
    if (
      typeof msg !== "object" ||
      msg === null ||
      typeof (msg as { type?: unknown }).type !== "string"
    ) {
      this.markDead(new Error("bad message shape"));
      throw new SessionError(`${this.label}: decrypted frame is not a SyncMessage`);
    }
    return msg as SyncMessage;
  }

  handshakeHash(): Uint8Array {
    return new Uint8Array(this.transcriptHash);
  }

  remoteStaticKey(): Uint8Array {
    return new Uint8Array(this.peerStaticKey);
  }

  isDead(): boolean {
    return this.dead;
  }

  injectInboundFrame(frame: Uint8Array): void {
    this.inbound.push(frame);
  }

  private assertAlive(op: string): void {
    if (this.dead) {
      throw new SessionError(
        `${this.label}: ${op} on dead session (DC-05 §6.3 fail-closed)`,
      );
    }
  }

  private markDead(_cause: unknown): void {
    this.dead = true;
    // Cipher states are never reused after death; free underlying WASM memory.
    try {
      this.sendCipher.free();
      this.receiveCipher.free();
    } catch {
      // already freed — still dead either way
    }
  }
}

// ---------------------------------------------------------------------------
// Public factories
// ---------------------------------------------------------------------------

/** Generate an X25519 static keypair for Noise_XX (via the established library). */
export async function generateNoiseStaticKeypair(): Promise<NoiseStaticKeyPair> {
  return generateStaticKeys(await loadNoiseLibrary());
}

export interface DuplexPairOptions {
  initiatorStaticKeys?: NoiseStaticKeyPair;
  responderStaticKeys?: NoiseStaticKeyPair;
  /**
   * Ed25519 identity seed keys (DC-05 §2.1). When given, the Noise static is
   * DETERMINISTICALLY DERIVED from the identity via the DC-05 §4 conversion
   * (ed25519ToX25519PrivateKey) instead of being random — this binds the
   * handshake static to the device identity so PairingSession's V1/V2 check
   * (converted QR key vs remote static) can pass in production topology.
   * Takes precedence over the matching `*StaticKeys` option.
   */
  initiatorIdentitySeed?: Uint8Array;
  responderIdentitySeed?: Uint8Array;
  /** Observe raw (ciphertext) frames as they hit the wire. */
  tapFrames?: FrameTap;
}

/**
 * Duplex pair factory for tests and local loopback: two fully handshaken
 * Noise_XX endpoints whose `send`/`receive` implement SyncTransport. All
 * traffic crosses the pipe as ChaChaPoly ciphertext under keys derived by
 * the real XX handshake (both ephemerals + both statics mixed into the
 * transcript).
 */
export async function makeLocalDuplexPair(
  options: DuplexPairOptions = {},
): Promise<[NoiseTransportHandle, NoiseTransportHandle]> {
  const lib = await loadNoiseLibrary();
  const resolveKeys = (
    explicit: NoiseStaticKeyPair | undefined,
    identitySeed: Uint8Array | undefined,
  ): NoiseStaticKeyPair => {
    if (identitySeed !== undefined) return noiseStaticsFromIdentity(identitySeed);
    if (explicit !== undefined) return explicit;
    return generateStaticKeys(lib);
  };
  const initiatorKeys = resolveKeys(
    options.initiatorStaticKeys,
    options.initiatorIdentitySeed,
  );
  const responderKeys = resolveKeys(
    options.responderStaticKeys,
    options.responderIdentitySeed,
  );

  const initiatorToResponder = new FrameQueue();
  const responderToInitiator = new FrameQueue();

  const initiator = runXxHandshake(
    lib,
    lib.constants.NOISE_ROLE_INITIATOR,
    responderToInitiator,
    initiatorToResponder,
    initiatorKeys,
    options.tapFrames,
    "initiator",
  );
  const responder = runXxHandshake(
    lib,
    lib.constants.NOISE_ROLE_RESPONDER,
    initiatorToResponder,
    responderToInitiator,
    responderKeys,
    options.tapFrames,
    "responder",
  );

  const [hi, hr] = await Promise.all([initiator, responder]);
  return [
    new NoiseSessionTransport(
      hi.sendCipher,
      hi.receiveCipher,
      hi.handshakeHash,
      hi.remoteStaticKey,
      responderToInitiator,
      initiatorToResponder,
      "initiator",
      options.tapFrames,
    ),
    new NoiseSessionTransport(
      hr.sendCipher,
      hr.receiveCipher,
      hr.handshakeHash,
      hr.remoteStaticKey,
      initiatorToResponder,
      responderToInitiator,
      "responder",
      options.tapFrames,
    ),
  ];
}

// ---------------------------------------------------------------------------
// wrapWithEncryption — wire-in point for an existing framed transport
// ---------------------------------------------------------------------------

/**
 * A lower-level carrier that moves opaque byte frames (e.g. a socket framing
 * adapter). Note this carries ciphertext BYTES, not parsed SyncMessages —
 * a SyncMessage union cannot hold ciphertext, which is precisely why the
 * encryption wrapper sits between it and the sync engine.
 */
export interface FramedByteTransport {
  send(frame: Uint8Array): Promise<void>;
  receive(): Promise<Uint8Array | null>;
}

/**
 * Wire-in point (DC-05 §6.2): take an already-established pair of directional
 * session cipher keys (e.g. Split() outputs relayed from a completed
 * handshake, or keys derived via {@link deriveSessionKeys}) and return a
 * SyncTransport that transparently encrypts/decrypts around `inner`.
 *
 * Fail-closed (§6.3): decrypt failure throws SessionError and permanently
 * kills the wrapper — subsequent calls throw immediately; no plaintext path.
 *
 * @internal TEST/INTERNAL USE ONLY (Review-3 M-3): this primitive wraps
 * TRANSCRIPT-FREE keys, bypassing the XX handshake that authenticates the
 * peer. Runtime-guarded: callers must pass `{ allowUnboundKeys: true }` to
 * acknowledge they are test/diagnostic code; production sessions must come
 * from {@link makeLocalDuplexPair}-style real handshakes instead.
 *
 * Async because the underlying Noise library loads once per process.
 */
export async function wrapWithEncryption(
  inner: FramedByteTransport,
  sessionKeys: SessionKeys,
  opts?: { allowUnboundKeys?: boolean },
): Promise<SyncTransport> {
  if ((opts?.allowUnboundKeys ?? false) !== true) {
    throw new SessionError(
      "wrapWithEncryption refused: transcript-free session keys are not " +
        "authenticated against any device identity (DC-05 Review-3 M-3). " +
        "This primitive is internal/test-only — pass { allowUnboundKeys: true } " +
        "to acknowledge, or use a real XX handshake for production sessions.",
    );
  }
  const lib = await loadNoiseLibrary();
  // CipherState takes the cipher ID constant, not the name string
  // (NOISE_CIPHER_CHACHAPOLY = 17153 per noise-c.wasm constants).
  const encryptor = new lib.CipherState(lib.constants.NOISE_CIPHER_CHACHAPOLY);
  encryptor.InitializeKey(sessionKeys.sendKey);
  const decryptor = new lib.CipherState(lib.constants.NOISE_CIPHER_CHACHAPOLY);
  decryptor.InitializeKey(sessionKeys.receiveKey);
  let dead = false;

  const kill = (): void => {
    dead = true;
    try {
      encryptor.free();
      decryptor.free();
    } catch {
      // already freed
    }
  };
  const assertAlive = (op: string): void => {
    if (dead) {
      throw new SessionError(
        `wrapped transport: ${op} on dead session (DC-05 §6.3)`,
      );
    }
  };

  return {
    async send(msg: SyncMessage): Promise<void> {
      assertAlive("send");
      let frame: Uint8Array;
      try {
        // Only egress path — always encrypted.
        frame = encryptor.EncryptWithAd(
          EMPTY_AD,
          TEXT_ENCODER.encode(JSON.stringify(msg)),
        );
      } catch (err) {
        kill();
        throw new SessionError("wrapped transport: encrypt failed", {
          cause: err,
        });
      }
      await inner.send(frame);
    },

    async receive(): Promise<SyncMessage | null> {
      assertAlive("receive");
      const frame = await inner.receive();
      if (frame === null) return null;
      let bytes: Uint8Array;
      try {
        // Only ingress path — always decrypted, never passed through.
        bytes = decryptor.DecryptWithAd(EMPTY_AD, frame);
      } catch (err) {
        kill(); // §6.3 fail-closed: tamper/replay => dead session
        throw new SessionError("wrapped transport: decryption failed", {
          cause: err,
        });
      }
      let msg: unknown;
      try {
        msg = JSON.parse(TEXT_DECODER.decode(bytes));
      } catch (err) {
        kill();
        throw new SessionError("wrapped transport: decrypted frame is not JSON", {
          cause: err,
        });
      }
      if (
        typeof msg !== "object" ||
        msg === null ||
        typeof (msg as { type?: unknown }).type !== "string"
      ) {
        kill();
        throw new SessionError(
          "wrapped transport: decrypted frame is not a SyncMessage",
        );
      }
      return msg as SyncMessage;
    },
  };
}

/**
 * Deterministically derive a directional {@link SessionKeys} pair from shared
 * secret material using HKDF-SHA256 (@noble/hashes — established, audited).
 * Both sides call this with the SAME seed; side A uses the result as-is,
 * side B swaps sendKey/receiveKey.
 *
 * @internal TEST/INTERNAL USE ONLY (Review-3 M-3): transcript-free key
 * derivation with no peer authentication. Only meaningful as input to
 * {@link wrapWithEncryption} in tests; production sessions derive keys from
 * a real XX handshake.
 */
export function deriveSessionKeys(
  seed: Uint8Array,
  context = "tide/noise-session-v1",
): SessionKeys {
  const okm = hkdf(
    sha256,
    seed,
    new TextEncoder().encode(context),
    new TextEncoder().encode("tide session keys: send || receive"),
    64,
  );
  return {
    sendKey: okm.slice(0, 32),
    receiveKey: okm.slice(32, 64),
  };
}
