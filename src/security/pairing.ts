// Tide DC-05 §5: QR pairing payload codec + pairing ceremony session state machine.
// Uses node:crypto standard constructions only (Spec §17 hard constraint).
// Semantics per DC-05 §5.1 (payload), §5.4 (safety number), §6.1 (V1–V3),
// §6.3 (fail-closed: any verification failure => zero trust-store mutation).

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { concat, deriveDeviceId } from "./identity.ts";
// DC-05 §6.1 V1: the QR's Ed25519 identity key is converted to its bound
// X25519 form via the standard DC-05 §4 conversion before byte-comparison
// against the Noise remote static (which is an X25519 key by construction).
import { ed25519ToX25519PublicKey } from "../network/noise_transport.ts";

// ---------------------------------------------------------------------------
// Errors (machine-readable codes)
// ---------------------------------------------------------------------------

export type PairingErrorCode =
  | "MALFORMED_JSON"
  | "BAD_VERSION"
  | "MISSING_FIELD"
  | "EXTRA_FIELD"
  | "BAD_TYPE"
  | "BAD_DEVICE_ID"
  | "BAD_BASE64"
  | "BAD_PUBLIC_KEY"
  | "SHORT_NONCE"
  | "NONCE_REUSE"
  | "BAD_CONNECT"
  | "ID_KEY_MISMATCH"
  | "BAD_SECRET";

const ERROR_MESSAGES: Record<PairingErrorCode, string> = {
  MALFORMED_JSON: "payload is not valid JSON",
  BAD_VERSION: "unsupported payload version (expected v===2)",
  MISSING_FIELD: "required field absent",
  EXTRA_FIELD: "field outside the schema",
  BAD_TYPE: "field has wrong JSON type",
  BAD_DEVICE_ID: "device_id does not match d-<64 hex>",
  BAD_BASE64: "field is not well-formed base64",
  BAD_PUBLIC_KEY: "public_key is not a 32-byte Ed25519 key",
  SHORT_NONCE: "nonce shorter than 128 bits",
  NONCE_REUSE: "nonce was already seen in a recent pairing ceremony (TR-10)",
  BAD_CONNECT: "connect hint malformed (ip/port invalid)",
  ID_KEY_MISMATCH: "device_id is not derived from public_key",
  BAD_SECRET: "secret is not 16 bytes of canonical base64",
};

export class PairingError extends Error {
  readonly code: PairingErrorCode;
  /** Offending field name, when applicable. */
  readonly field?: string;

  constructor(code: PairingErrorCode, field?: string) {
    super(`pairing:${code}${field ? ` (${field}): ${ERROR_MESSAGES[code]}` : `: ${ERROR_MESSAGES[code]}`}`);
    this.name = "PairingError";
    this.code = code;
    this.field = field;
  }
}

// ---------------------------------------------------------------------------
// §5.1 QR payload codec
// ---------------------------------------------------------------------------

/** UNTRUSTED connectivity hint (§5.1b) — never persisted into identity/trust. */
export interface PairingConnectHint {
  ip: string;
  port: number;
}

/** Version of the pasted code and of the ceremony payload (Appendix B, P2/P9). */
export const PAIRING_VERSION = 2;

/**
 * DC-05 Appendix B.2 (P2): the pasted (or scanned) code. "secret" and
 * "connect" are required; "name" is not allowed (DC-28 P5, OB-2).
 */
export interface PairingCode {
  v: 2;
  device_id: string;
  /** base64 Ed25519 public key */
  public_key: string;
  /** base64, >=128 bits fresh CSPRNG (§5.1a) */
  nonce: string;
  /** base64, exactly 16 bytes; one-time pairing secret (B.2, P1) */
  secret: string;
  connect: PairingConnectHint;
}

/**
 * DC-05 Appendix B.7 (P9): the payload each side sends over the ENCRYPTED
 * channel after the handshake. Never carries "secret" or "connect".
 */
export interface PairingPayload {
  v: 2;
  device_id: string;
  /** base64 Ed25519 public key */
  public_key: string;
  /** base64, >=128 bits fresh CSPRNG (§5.1a) */
  nonce: string;
  /** DC-28 §4.5/§4.8: optional, untrusted, never affects identity. */
  name?: unknown;
}

/** B.2 (P1): size of the one-time pairing secret in bytes. */
export const PAIRING_SECRET_BYTES = 16;

/** B.2 (P1): a fresh one-time secret from the CSPRNG (caller owns and wipes it). */
export function freshPairingSecret(): Buffer {
  return randomBytes(PAIRING_SECRET_BYTES);
}

/** 16 fresh random bytes, base64 (§5.1a: CSPRNG, never reused). */
export function freshNonce(): string {
  return randomBytes(16).toString("base64");
}

// ---------------------------------------------------------------------------
// TR-10 second clause: session-layer nonce-reuse memory (bounded LRU)
// ---------------------------------------------------------------------------

/** Maximum number of recently seen nonces retained (Review-3 M-4). */
export const PAIRING_NONCE_LRU_LIMIT = 1024;

/**
 * Bounded LRU store of recently seen pairing nonces. Insertion-ordered Map
 * used as an LRU: a re-sight refreshes recency; inserting past
 * {@link PAIRING_NONCE_LRU_LIMIT} evicts the least-recently-seen entry.
 */
export type NonceStore = Map<string, true>;

export function createNonceStore(): NonceStore {
  return new Map();
}

/** True when `nonce` was already seen in a recent ceremony (TR-10). */
export function isKnownNonce(nonce: string, store: NonceStore): boolean {
  return store.has(nonce);
}

/** Record a nonce as seen, refreshing its recency and bounding the store. */
export function recordNonce(nonce: string, store: NonceStore): void {
  if (store.has(nonce)) {
    // Refresh recency (LRU touch) without growing.
    store.delete(nonce);
    store.set(nonce, true);
    return;
  }
  store.set(nonce, true);
  while (store.size > PAIRING_NONCE_LRU_LIMIT) {
    const oldest = store.keys().next();
    if (oldest.done) break;
    store.delete(oldest.value);
  }
}

/**
 * Canonical JSON of a v2 code — the exact string that is shown and pasted.
 * Key order is fixed (v, device_id, public_key, nonce, secret, connect).
 */
export function encodePairingCode(code: PairingCode): string {
  return JSON.stringify({
    v: code.v,
    device_id: code.device_id,
    public_key: code.public_key,
    nonce: code.nonce,
    secret: code.secret,
    connect: { ip: code.connect.ip, port: code.connect.port },
  });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const DEVICE_ID_RE = /^d-[0-9a-f]{64}$/;

function decodeBase64Strict(value: string, field: string): Buffer {
  // Empty string is well-formed-but-too-short; length checks below give the
  // more precise error code, so let it through the syntax gate.
  if (value !== "" && !BASE64_RE.test(value)) throw new PairingError("BAD_BASE64", field);
  // Re-encode check rejects non-canonical paddings/lengths that slip past the regex.
  const buf = Buffer.from(value, "base64");
  if (buf.toString("base64") !== value) throw new PairingError("BAD_BASE64", field);
  return buf;
}

/** Strict canonical base64 of exactly `bytes` bytes, or null (no throw). */
export function decodeBase64Exact(value: unknown, bytes: number): Buffer | null {
  if (typeof value !== "string" || !BASE64_RE.test(value)) return null;
  const buf = Buffer.from(value, "base64");
  if (buf.length !== bytes || buf.toString("base64") !== value) return null;
  return buf;
}

/**
 * The identity fields shared by the code and the ceremony payload:
 * v === 2 (checked FIRST, so an older code fails with BAD_VERSION whatever
 * else it carries), the key allowlist, device_id format, public_key, nonce,
 * and device_id === "d-" + hex(SHA-256(public_key)) (§2.2, closes G4).
 */
function decodeIdentityFields(
  parsed: unknown,
  allowed: readonly string[],
): Record<string, unknown> & { device_id: string; public_key: string; nonce: string } {
  if (!isPlainObject(parsed)) throw new PairingError("BAD_TYPE", "<root>");
  if (!("v" in parsed)) throw new PairingError("MISSING_FIELD", "v");
  if (typeof parsed.v !== "number" || parsed.v !== PAIRING_VERSION) {
    throw new PairingError("BAD_VERSION", "v");
  }
  const allow = new Set(allowed);
  for (const key of Object.keys(parsed)) {
    if (!allow.has(key)) throw new PairingError("EXTRA_FIELD", key);
  }
  for (const required of ["device_id", "public_key", "nonce"] as const) {
    if (!(required in parsed)) throw new PairingError("MISSING_FIELD", required);
  }

  if (typeof parsed.device_id !== "string") throw new PairingError("BAD_TYPE", "device_id");
  if (!DEVICE_ID_RE.test(parsed.device_id)) throw new PairingError("BAD_DEVICE_ID", "device_id");

  if (typeof parsed.public_key !== "string") throw new PairingError("BAD_TYPE", "public_key");
  const pkBytes = decodeBase64Strict(parsed.public_key, "public_key");
  if (pkBytes.length !== 32) throw new PairingError("BAD_PUBLIC_KEY", "public_key");
  if (deriveDeviceId(pkBytes) !== parsed.device_id) {
    throw new PairingError("ID_KEY_MISMATCH", "device_id");
  }

  if (typeof parsed.nonce !== "string") throw new PairingError("BAD_TYPE", "nonce");
  const nonceBytes = decodeBase64Strict(parsed.nonce, "nonce");
  if (nonceBytes.length * 8 < 128) throw new PairingError("SHORT_NONCE", "nonce");

  return parsed as Record<string, unknown> & { device_id: string; public_key: string; nonce: string };
}

/**
 * Strict decoder of a pasted v2 code (§5.1 rules, Appendix B.2 P2, TR-9,
 * TR-B5, TR-B6). Throws PairingError with a machine-readable code; the
 * message never contains any field VALUE (the code carries the secret).
 */
export function decodePairingCode(raw: string): PairingCode {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new PairingError("MALFORMED_JSON");
  }
  const p = decodeIdentityFields(parsed, ["v", "device_id", "public_key", "nonce", "secret", "connect"]);

  if (!("secret" in p)) throw new PairingError("MISSING_FIELD", "secret");
  if (decodeBase64Exact(p.secret, PAIRING_SECRET_BYTES) === null) {
    throw new PairingError("BAD_SECRET", "secret");
  }

  if (!("connect" in p)) throw new PairingError("MISSING_FIELD", "connect");
  if (!isPlainObject(p.connect)) throw new PairingError("BAD_TYPE", "connect");
  for (const key of Object.keys(p.connect)) {
    if (key !== "ip" && key !== "port") throw new PairingError("EXTRA_FIELD", `connect.${key}`);
  }
  if (!("ip" in p.connect) || !("port" in p.connect)) {
    throw new PairingError("MISSING_FIELD", "connect.ip|port");
  }
  const { ip, port } = p.connect;
  if (typeof ip !== "string" || ip.length === 0) throw new PairingError("BAD_CONNECT", "connect.ip");
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new PairingError("BAD_CONNECT", "connect.port");
  }

  return {
    v: 2,
    device_id: p.device_id,
    public_key: p.public_key,
    nonce: p.nonce,
    secret: p.secret as string,
    connect: { ip, port },
  };
}

/**
 * Strict decoder of the ceremony payload received over the encrypted
 * channel (Appendix B.7, P9, TR-B7). The frame must be a JSON object
 * (null, arrays, numbers, strings abort); "secret" and "connect" are
 * EXTRA_FIELD. "name" is passed through untouched: DC-28 §4.5/§4.8 drops
 * an invalid one later, and it never affects identity.
 */
export function decodeCeremonyPayload(frame: unknown): PairingPayload {
  const p = decodeIdentityFields(frame, ["v", "device_id", "public_key", "nonce", "name"]);
  const out: PairingPayload = { v: 2, device_id: p.device_id, public_key: p.public_key, nonce: p.nonce };
  if ("name" in p) out.name = p.name;
  return out;
}

// ---------------------------------------------------------------------------
// Appendix B.3 proof of the one-time secret (P3)
// ---------------------------------------------------------------------------

/** B.3: label || 0x00, fixed and public. */
export const PAIRING_PROOF_LABEL = Buffer.concat([
  Buffer.from("tide-pairing-proof-v2", "ascii"),
  Buffer.from([0x00]),
]);

/** Size of an HMAC-SHA256 proof. */
export const PAIRING_PROOF_BYTES = 32;

/** B.3: proof = HMAC-SHA256(key = secret, data = label || h). */
export function computePairingProof(secret: Uint8Array, handshakeHash: Uint8Array): Buffer {
  return createHmac("sha256", Buffer.from(secret))
    .update(PAIRING_PROOF_LABEL)
    .update(Buffer.from(handshakeHash))
    .digest();
}

/** B.3: the scanner's first encrypted frame. */
export function pairingProofFrame(secret: Uint8Array, handshakeHash: Uint8Array): {
  kind: "PAIRING_PROOF";
  proof: string;
} {
  return { kind: "PAIRING_PROOF", proof: computePairingProof(secret, handshakeHash).toString("base64") };
}

/**
 * B.3 displayer check. True only when `frame` is an object with exactly the
 * keys "kind" and "proof", kind === "PAIRING_PROOF", proof is canonical
 * base64 of exactly 32 bytes, and it equals the proof computed from our own
 * secret and our own h. The comparison is node:crypto timingSafeEqual on two
 * 32-byte buffers (length checked first, VB-2); no string or early-exit
 * comparison touches the proof (TR-B11). Never throws; never logs.
 */
export function verifyPairingProof(
  frame: unknown,
  secret: Uint8Array | null,
  handshakeHash: Uint8Array,
): boolean {
  if (secret === null || secret.length !== PAIRING_SECRET_BYTES) return false;
  if (!isPlainObject(frame)) return false;
  const keys = Object.keys(frame);
  if (keys.length !== 2 || !("kind" in frame) || !("proof" in frame)) return false;
  if (frame.kind !== "PAIRING_PROOF") return false;
  const got = decodeBase64Exact(frame.proof, PAIRING_PROOF_BYTES);
  if (got === null) return false;
  const want = computePairingProof(secret, handshakeHash);
  if (got.length !== want.length) return false; // timingSafeEqual throws on unequal lengths
  const ok = timingSafeEqual(got, want);
  want.fill(0);
  got.fill(0);
  return ok;
}

// ---------------------------------------------------------------------------
// §5.4 safety number (+ §6.1 V3 transcript mixing)
// ---------------------------------------------------------------------------

/** Decimal digit expansion of a digest, left-padded to `digits` length. */
function digestToDigits(digest: Buffer, digits: number): string {
  const decimal = BigInt("0x" + digest.toString("hex")).toString();
  if (decimal.length >= digits) return decimal.slice(0, digits);
  return decimal.padStart(digits, "0");
}

/**
 * DC-05 §5.4:
 *   safety_number = decimal digits of SHA-256(concat(sort([pkA, pkB])))[0..40]
 * rendered as five groups of 8 digits. Sorting makes it symmetric.
 *
 * When `transcriptHash` is provided (§6.1 V3), the §5.4 number is additionally
 * HMAC-SHA256'd with the Noise handshake hash, so a MITM who substituted keys
 * yields DIFFERENT safety numbers on the two screens (the handshake hashes
 * differ per side) even if the human comparison were skipped.
 */
export function safetyNumber(
  pkA: Uint8Array,
  pkB: Uint8Array,
  transcriptHash?: Uint8Array,
): string {
  const sorted = [Buffer.from(pkA), Buffer.from(pkB)].sort((a, b) => a.compare(b));
  const [lo, hi] = sorted as [Buffer, Buffer];
  const base = createHash("sha256").update(concat(lo, hi)).digest();

  const effective =
    transcriptHash !== undefined
      ? createHmac("sha256", Buffer.from(transcriptHash)).update(base).digest()
      : base;

  const digits = digestToDigits(effective, 40);
  return [0, 8, 16, 24, 32].map((i) => digits.slice(i, i + 8)).join("-");
}

/** Convenience: digits-only form (no dashes), for programmatic comparison. */
export function safetyNumberDigits(
  pkA: Uint8Array,
  pkB: Uint8Array,
  transcriptHash?: Uint8Array,
): string {
  return safetyNumber(pkA, pkB, transcriptHash).replaceAll("-", "");
}

// ---------------------------------------------------------------------------
// §6.1 pairing session state machine
//   idle -> payload_exchanged -> verified -> trusted_stored | aborted
// ---------------------------------------------------------------------------

export type PairingState = "idle" | "payload_exchanged" | "verified" | "trusted_stored" | "aborted";

/**
 * Enforces the DC-05 §6.1 post-handshake verification ORDER:
 *   exchangePayloads -> bindTranscript (V3 input) ->
 *   verifyRemoteStatic (V1/V2 byte-compare) -> confirmSafetyNumber (V3 compare)
 *   -> storeTrust (V4 gate caller's concern).
 * Any failure path funnels through abort(): all partial state is cleared and
 * NO trust-store mutation occurs (§6.3 fail-closed).
 */
export class PairingSession {
  /**
   * Process-wide memory of nonces seen by ANY pairing ceremony on this
   * device (TR-10 second clause, Review-3 M-4). Bounded LRU of
   * {@link PAIRING_NONCE_LRU_LIMIT} entries.
   */
  static readonly recentNonces: NonceStore = createNonceStore();

  #state: PairingState = "idle";
  #local?: PairingPayload;
  #remote?: PairingPayload;
  #transcriptHash?: Uint8Array;
  #remoteVerified = false;
  #confirmed = false;

  get state(): PairingState {
    return this.#state;
  }

  /**
   * §5.1/§5.2: both payloads seen. `remote` comes from scanning the QR
   * (decodePairingPayload); `local` is our own announcement.
   *
   * TR-10 (Review-3 M-4): a remote payload whose nonce was already seen in
   * a recent ceremony is rejected outright (fail-closed: session aborted).
   */
  exchangePayloads(local: PairingPayload, remote: PairingPayload): void {
    this.#requireState("idle");
    if (isKnownNonce(remote.nonce, PairingSession.recentNonces)) {
      this.#state = "aborted"; // fail closed before any state is kept
      throw new PairingError("NONCE_REUSE", "nonce");
    }
    // Appendix B.7: the nonce is RECORDED only after the binding check
    // (verifyRemoteStatic), so a payload that fails binding leaves the
    // TR-10 memory unchanged.
    this.#local = local;
    this.#remote = remote;
    this.#state = "payload_exchanged";
  }

  /** Feed the Noise handshake hash (snow `get_handshake_hash`) for V3 mixing. */
  bindTranscript(handshakeHash: Uint8Array): void {
    this.#requireState("payload_exchanged");
    if (this.#transcriptHash !== undefined) throw new PairingError("BAD_TYPE", "transcript already bound");
    this.#transcriptHash = handshakeHash;
  }

  /**
   * §6.1 V1/V2: byte-compare the remote static identity against the key
   * announced in the QR (scanner side authoritative OOB binding; displayer
   * side self-check). Mismatch => abort, zero partial state retained.
   *
   * BOTH sides are compared in the SAME key space (DC-05 §4/§6.1 V1):
   * the QR's Ed25519 identity key is first converted to its bound X25519
   * form via the deterministic §4 conversion, then compared against
   * `actualRemoteStatic` — which is an X25519 key because it comes from the
   * Noise_XX handshake over Curve25519 statics derived from identities.
   * Comparing raw Ed25519 bytes against Noise static can never match and
   * was exactly the Review-3 H-1 defect.
   */
  verifyRemoteStatic(actualRemoteStatic: Uint8Array): void {
    this.#requireState("payload_exchanged");
    if (this.#remoteVerified) throw new PairingError("BAD_TYPE", "already verified");
    const announcedEd = decodeBase64Strict(this.#remote?.public_key ?? "", "public_key");
    let announcedX25519: Buffer;
    try {
      announcedX25519 = Buffer.from(ed25519ToX25519PublicKey(announcedEd));
    } catch {
      this.abort(); // §6.3: malformed announced key => abort, zero mutation
      throw new PairingError("BAD_PUBLIC_KEY", "QR public_key not convertible to X25519");
    }
    if (!announcedX25519.equals(Buffer.from(actualRemoteStatic))) {
      this.abort(); // §6.1 V2: failure => abort, delete any partial state
      throw new PairingError("BAD_PUBLIC_KEY", "remote_static != X25519(QR public_key)");
    }
    recordNonce(this.#remote!.nonce, PairingSession.recentNonces); // B.7: after binding
    this.#remoteVerified = true;
  }

  /** §6.1 V3: the safety number displayed to the user on THIS side. */
  displaySafetyNumber(): string {
    this.#requireReadyToConfirm();
    return safetyNumber(
      Buffer.from(decodeBase64Strict(this.#local!.public_key, "public_key")),
      Buffer.from(decodeBase64Strict(this.#remote!.public_key, "public_key")),
      this.#transcriptHash,
    );
  }

  /**
   * §5.4/V3: humans compared both screens; pass the programmatic comparison
   * result here. Match => verified; mismatch => abort (no trust entry).
   */
  confirmSafetyNumber(localDisplayed: string, remoteReported: string): void {
    this.#requireReadyToConfirm();
    if (localDisplayed.replaceAll("-", "") !== remoteReported.replaceAll("-", "")) {
      this.abort(); // TR-6: mismatch writes no trust entry
      throw new PairingError("BAD_PUBLIC_KEY", "safety number mismatch");
    }
    this.#confirmed = true;
    this.#state = "verified";
  }

  /**
   * Final transition: persist the trusted-peer entry through `store` (which
   * MUST itself run the canSynchronize-style checks, §6.1 V4). Invoked at
   * most once, only from `verified`. Returns store()'s result.
   */
  storeTrust<T>(store: () => T): T {
    this.#requireState("verified");
    this.#state = "trusted_stored";
    return store();
  }

  /**
   * §6.3 fail-closed: clear ALL partial state from any reachable point.
   * After abort() nothing about the attempt survives (zero trust mutation —
   * this class never touches the trust store directly anyway; storeTrust is
   * the only bridge and it requires full verification first).
   */
  abort(): void {
    this.#local = undefined;
    this.#remote = undefined;
    this.#transcriptHash = undefined;
    this.#remoteVerified = false;
    this.#confirmed = false;
    if (this.#state !== "trusted_stored") this.#state = "aborted";
  }

  /** Internal guard: raw-state checks for early-phase methods. */
  #requireState(expected: PairingState): void {
    if (this.#state !== expected) {
      throw new PairingError("BAD_TYPE", `illegal transition request from state "${this.#state}"`);
    }
  }

  /** Internal guard: full preconditions before user confirmation steps (V3). */
  #requireReadyToConfirm(): void {
    if (
      this.#state !== "payload_exchanged" ||
      this.#transcriptHash === undefined ||
      !this.#remoteVerified
    ) {
      throw new PairingError(
        "BAD_TYPE",
        `verification order violated (state "${this.#state}", bound=${this.#transcriptHash !== undefined}, v2=${this.#remoteVerified})`,
      );
    }
  }

  /** Test/debug introspection: true when no partial material remains. */
  get isCleared(): boolean {
    return (
      this.#local === undefined &&
      this.#remote === undefined &&
      this.#transcriptHash === undefined &&
      !this.#remoteVerified &&
      !this.#confirmed
    );
  }
}

// Re-export for callers building payloads from raw identities.
export { deriveDeviceId };
