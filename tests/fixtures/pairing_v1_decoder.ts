// Fixture: the pasted-code decoder of the build BEFORE DC-05 Appendix B
// (git c44d0a5, src/security/pairing.ts lines 143-223, copied verbatim
// below the PairingError stand-in). It stands in for "an older build" in
// TR-B5 / VB-3: a v2 code must be refused by it at paste. The installed
// package (tide-0.1.0-1) is checked against the same rule at runtime in the
// implementation report; this copy keeps the check reproducible in CI.
// tests/dc05b_pairing_proof.test.ts asserts that this text still equals the
// c44d0a5 blob when git history is available.

export class PairingError extends Error {
  readonly code: string;
  constructor(code: string, field?: string) {
    super(`pairing:${code}${field ? ` (${field})` : ""}`);
    this.code = code;
  }
}

interface PairingConnectHint {
  ip: string;
  port: number;
}
interface PairingPayload {
  v: 1;
  device_id: string;
  public_key: string;
  nonce: string;
  connect?: PairingConnectHint;
  name?: string;
}

// ---- verbatim from c44d0a5 ----
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

/**
 * Strict decoder (§5.1 rules + TR-9 tamper detection):
 * v must be exactly 1, no extra top-level fields, device_id well-formed,
 * public_key valid base64 of a 32-byte Ed25519 key, nonce >=128 bits,
 * connect (when present) an ip/port pair. Throws PairingError with a
 * machine-readable code on any malformation/tampering.
 */
export function decodePairingPayload(raw: string): PairingPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new PairingError("MALFORMED_JSON");
  }
  if (!isPlainObject(parsed)) throw new PairingError("BAD_TYPE", "<root>");

  const allowed = new Set(["v", "device_id", "public_key", "nonce", "connect", "name"]);
  for (const key of Object.keys(parsed)) {
    if (!allowed.has(key)) throw new PairingError("EXTRA_FIELD", key);
  }

  if (!("v" in parsed)) throw new PairingError("MISSING_FIELD", "v");
  if (parsed.v !== 1 || typeof parsed.v !== "number") throw new PairingError("BAD_VERSION", "v");

  for (const required of ["device_id", "public_key", "nonce"] as const) {
    if (!(required in parsed)) throw new PairingError("MISSING_FIELD", required);
  }

  if (typeof parsed.device_id !== "string") throw new PairingError("BAD_TYPE", "device_id");
  if (!DEVICE_ID_RE.test(parsed.device_id)) throw new PairingError("BAD_DEVICE_ID", "device_id");

  if (typeof parsed.public_key !== "string") throw new PairingError("BAD_TYPE", "public_key");
  const pkBytes = decodeBase64Strict(parsed.public_key, "public_key");
  if (pkBytes.length !== 32) throw new PairingError("BAD_PUBLIC_KEY", "public_key");

  if (typeof parsed.nonce !== "string") throw new PairingError("BAD_TYPE", "nonce");
  const nonceBytes = decodeBase64Strict(parsed.nonce, "nonce");
  if (nonceBytes.length * 8 < 128) throw new PairingError("SHORT_NONCE", "nonce");

  let connect: PairingConnectHint | undefined;
  if ("connect" in parsed && parsed.connect !== undefined) {
    if (!isPlainObject(parsed.connect)) throw new PairingError("BAD_TYPE", "connect");
    for (const key of Object.keys(parsed.connect)) {
      if (key !== "ip" && key !== "port") throw new PairingError("EXTRA_FIELD", `connect.${key}`);
    }
    if (!("ip" in parsed.connect) || !("port" in parsed.connect)) {
      throw new PairingError("MISSING_FIELD", "connect.ip|port");
    }
    const { ip, port } = parsed.connect;
    if (typeof ip !== "string" || ip.length === 0) throw new PairingError("BAD_CONNECT", "connect.ip");
    if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
      throw new PairingError("BAD_CONNECT", "connect.port");
    }
    connect = { ip, port };
  }

  let name: string | undefined;
  if ("name" in parsed && parsed.name !== undefined) {
    if (typeof parsed.name !== "string") throw new PairingError("BAD_TYPE", "name");
    name = parsed.name;
  }

  return { v: 1, device_id: parsed.device_id, public_key: parsed.public_key, nonce: parsed.nonce, connect, name };
}
