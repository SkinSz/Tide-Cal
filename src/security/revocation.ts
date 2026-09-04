// Tide DC-10: Trust-Revocation Propagation runtime (APPROVED contract).
// Pure logic — no DB wiring, no network I/O, no side effects.
//
// Boundary (DC-10 §4): this module moves REVOCATION DATA only. It performs
// signature authentication (delegating to DC-05 §7.2 semantics via
// identity.ts), store-once acceptance bookkeeping, and per-peer delivery
// knowledge tracking. It never denies sessions, rejects changes, or frames
// messages — enforcement stays behind canSynchronize() and the sync engine.
//
// Canonical byte form for signing (DC-05 §7.1 "revocation_record bytes"):
//   UTF-8 encoding of the compact JSON serialization of the record object
//   whose keys appear in ascending code-unit ("lexicographic") order,
//   joined without whitespace, i.e. `{"k":v,...}` with JSON.stringify
//   escaping for strings and ECMAScript Number::toString for numbers.
//   Keys absent (undefined) are omitted entirely, so the same logical
//   record always yields the same bytes regardless of property insertion
//   order or presence of an empty `reason`. Example:
//     {"reason":"stolen","revoked_at_hlc":1724600030000,
//      "revoked_by_device_id":"d-ab..","revoked_device_id":"d-cd..","v":1}

import { signAsync, verifyAsync, deriveDeviceId } from "./identity.ts";

/** Record body per DC-05 §7.1 (the exact object that gets signed). */
export interface RevocationRecord {
  v: 1;
  revoked_device_id: string;
  revoked_by_device_id: string;
  /** Hybrid logical clock ms at creation — identity metadata ONLY. Never compared against wall-clock time anywhere in propagation (DC-10 §2.4 TTL-free). */
  revoked_at_hlc: number;
  reason?: string;
}

/** A record plus its detached Ed25519 signature over canonical bytes. */
export interface SignedRevocation {
  record: RevocationRecord;
  signature: Uint8Array;
}

/**
 * Minimal unique record identity per DC-10 §2.5: the triple
 * (revoked_device_id, revoked_at_hlc, revoked_by_device_id).
 */
export interface RevocationTriple {
  revoked_device_id: string;
  revoked_at_hlc: number;
  revoked_by_device_id: string;
}

/** One trust-store entry as consulted by DC-05 §7.2 verification. */
export interface TrustStoreEntry {
  publicKey: Uint8Array;
  /** Only entries with status "trusted" may author valid revocations. */
  status: "trusted" | "revoked";
}

/** Lookup callback over the local trust store (DB-backed in production). */
export type TrustStoreLookup = (
  deviceId: string,
) => TrustStoreEntry | undefined;

export class RevocationError extends Error {
  constructor(
    public code:
      | "bad_version"
      | "missing_field"
      | "bad_hlc",
    message: string,
  ) {
    super(message);
    this.name = "RevocationError";
  }
}

const encoder = new TextEncoder();

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

/** Structural validation. Throws RevocationError (caller-side construction). */
export function validateRevocationRecord(r: unknown): RevocationRecord {
  if (typeof r !== "object" || r === null) {
    throw new RevocationError("missing_field", "record is not an object");
  }
  const rec = r as Record<string, unknown>;
  if (rec.v !== 1) {
    throw new RevocationError("bad_version", `unsupported version ${String(rec.v)}`);
  }
  for (const key of [
    "revoked_device_id",
    "revoked_by_device_id",
  ] as const) {
    if (!isNonEmptyString(rec[key])) {
      throw new RevocationError("missing_field", `invalid ${key}`);
    }
  }
  if (
    typeof rec.revoked_at_hlc !== "number" ||
    !Number.isInteger(rec.revoked_at_hlc) ||
    rec.revoked_at_hlc < 0
  ) {
    throw new RevocationError("bad_hlc", "revoked_at_hlc must be a non-negative integer");
  }
  if (rec.reason !== undefined && !isNonEmptyString(rec.reason)) {
    throw new RevocationError("missing_field", "invalid reason");
  }
  const out: RevocationRecord = {
    v: 1,
    revoked_device_id: rec.revoked_device_id as string,
    revoked_by_device_id: rec.revoked_by_device_id as string,
    revoked_at_hlc: rec.revoked_at_hlc as number,
  };
  if (rec.reason !== undefined) out.reason = rec.reason as string;
  return out;
}

/**
 * Exact bytes that are signed/verified: compact JSON, keys sorted by
 * code-unit order, UTF-8 encoded (see header comment). Pure and total:
 * undefined-valued keys are omitted so insertion order cannot leak.
 */
export function canonicalRevocationBytes(record: RevocationRecord): Uint8Array {
  const obj = record as unknown as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  const parts = keys.map(
    (k) => `${JSON.stringify(k)}:${JSON.stringify(obj[k])}`,
  );
  return encoder.encode(`{${parts.join(",")}}`);
}

/**
 * DC-05 §7.1: create and sign a revocation record with the REVOKING
 * device's private key. The caller supplies the current HLC.
 */
export async function createRevocation(
  fields: Omit<RevocationRecord, "v"> & { v?: 1 },
  privateKey: Uint8Array,
): Promise<SignedRevocation> {
  const record = validateRevocationRecord({ ...fields, v: 1 });
  const signature = await signAsync(canonicalRevocationBytes(record), privateKey);
  return { record, signature };
}

export type VerificationResult =
  | { valid: true }
  | {
      valid: false;
      reason:
        | "malformed"
        | "unknown_revoker"
        | "revoker_not_trusted"
        | "self_signed"
        | "bad_signature";
    };

function signaturesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * DC-05 §7.2 authentication: (a) revoked_by_device_id is a locally TRUSTED
 * peer AND distinct from the revoked device, (b) the signature verifies
 * under that peer's STORED public key. Never throws — every failure mode
 * is reported as { valid: false, reason } (TRP-3: forged records are
 * dropped and logged by the caller, never stored, never re-forwarded).
 */
export async function verifyRevocation(
  signed: SignedRevocation,
  trustStoreLookup: TrustStoreLookup,
): Promise<VerificationResult> {
  try {
    let record: RevocationRecord;
    try {
      record = validateRevocationRecord(signed.record);
    } catch {
      return { valid: false, reason: "malformed" };
    }
    if (!(signed.signature instanceof Uint8Array) || signed.signature.length === 0) {
      return { valid: false, reason: "malformed" };
    }
    if (record.revoked_by_device_id === record.revoked_device_id) {
      // DC-05 §7.2: not signed by a DISTINCT trusted revoker -> ignored.
      return { valid: false, reason: "self_signed" };
    }
    const entry = trustStoreLookup(record.revoked_by_device_id);
    if (entry === undefined) {
      return { valid: false, reason: "unknown_revoker" };
    }
    if (entry.status !== "trusted") {
      return { valid: false, reason: "revoker_not_trusted" };
    }
    const ok = await verifyAsync(
      canonicalRevocationBytes(record),
      signed.signature,
      entry.publicKey,
    );
    return ok ? { valid: true } : { valid: false, reason: "bad_signature" };
  } catch {
    return { valid: false, reason: "malformed" };
  }
}

/** Stable key for the §2.5 triple (fixed field order, unambiguous join). */
export function revocationTripleKey(t: RevocationTriple): string {
  return `${t.revoked_device_id}\u0000${t.revoked_at_hlc}\u0000${t.revoked_by_device_id}`;
}

export function recordTriple(record: RevocationRecord): RevocationTriple {
  return {
    revoked_device_id: record.revoked_device_id,
    revoked_at_hlc: record.revoked_at_hlc,
    revoked_by_device_id: record.revoked_by_device_id,
  };
}

/**
 * Local record store (derived-state source for queues, DC-10 §2.1).
 * Keyed by the §2.5 triple. Durability wiring is a later task.
 */
export interface RevocationState {
  records: Map<string, SignedRevocation>;
}

export function createRevocationState(): RevocationState {
  return { records: new Map() };
}

export type AcceptResult =
  | { accepted: true; duplicate: false; valid: true }
  | { accepted: false; duplicate: true; valid: true }
  | { accepted: false; duplicate: false; valid: false; reason: string };

/**
 * Store-once acceptance (DC-05 §7.2/§7.3 + DC-10 §2.4 loop prevention):
 * - invalid records are NEVER stored (and therefore never queued);
 * - redelivery of an identical record is an idempotent no-op;
 * - a DIFFERENT record colliding on the same triple is impossible per
 *   §2.5; if observed anyway, the first-accepted dominates (§3 rules).
 * A record the device created itself enters via the same path — the
 * creator passes a lookup that trivially trusts itself (§2.1).
 */
export async function acceptRevocation(
  state: RevocationState,
  signed: SignedRevocation,
  trustStoreLookup: TrustStoreLookup,
): Promise<AcceptResult> {
  const key = revocationTripleKey(recordTriple(signed.record));
  const existing = state.records.get(key);
  if (existing !== undefined) {
    if (signaturesEqual(existing.signature, signed.signature)) {
      return { accepted: false, duplicate: true, valid: true };
    }
    return {
      accepted: false,
      duplicate: false,
      valid: false,
      reason: "conflicting_triple_first_accepted_dominates",
    };
  }
  const verdict = await verifyRevocation(signed, trustStoreLookup);
  if (!verdict.valid) {
    return { accepted: false, duplicate: false, valid: false, reason: verdict.reason };
  }
  state.records.set(key, signed);
  return { accepted: true, duplicate: false, valid: true };
}

/**
 * Per-peer ACK knowledge bookkeeping (DC-10 §2.5):
 *
 *     revocation_ack[peer][record_key] = true | unset
 *
 * Mirrors lastKnownClock bookkeeping (DC-02 §4). KNOWLEDGE ONLY: it never
 * feeds enforcement, compaction constraints, or clock arithmetic.
 * TTL-FREE: nothing here expires; acks are never reset except by explicit
 * local data loss (rebuild from scratch alongside the record store).
 *
 * queue(peer) = accepted_records \ ACKed, excluding records naming the
 * peer itself (a revoked peer is cut off by DC-08 TR-7 before it could
 * matter). Derived state, recomputed on demand — no separate durability.
 * Delivery discipline is AT-LEAST-ONCE (§3): an unacked record keeps
 * being re-sent every session until an ACK arrives.
 */
export class RevocationQueue {
  /** peer device_id -> set of acked triple keys */
  private readonly acks = new Map<string, Set<string>>();

  constructor(private readonly state: RevocationState) {}

  /** Records to send to `peer` on the next/current session (§2.2). */
  queue(peer: string): SignedRevocation[] {
    const out: SignedRevocation[] = [];
    const acked = this.acks.get(peer);
    for (const [key, signed] of this.state.records) {
      if (signed.record.revoked_device_id === peer) continue; // §2.1
      if (acked?.has(key)) continue;
      out.push(signed);
    }
    return out;
  }

  /**
   * Process an inbound REVOCATIONS_ACK (DC-10 §3): mark triples as known-
   * accepted by the sender. Idempotent — duplicate/replayed ACKs are no-ops
   * (INVARIANT 14). Acking a record we never held is harmless: it only
   * stops re-sending toward a peer claiming knowledge (a liar harms only
   * itself); we simply record the claim.
   */
  ackPeer(peer: string, triples: RevocationTriple[]): void {
    let set = this.acks.get(peer);
    if (set === undefined) {
      set = new Set();
      this.acks.set(peer, set);
    }
    for (const t of triples) set.add(revocationTripleKey(t));
  }

  hasAck(peer: string, triple: RevocationTriple): boolean {
    return this.acks.get(peer)?.has(revocationTripleKey(triple)) ?? false;
  }
}

export type SyncDecision = "ALLOW" | "DENY_UNPAIRED" | "DENY_REVOKED" | "DENY_KEY_MISMATCH";

/**
 * Constant-time-ish byte equality for key comparison.
 */
function keysEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

/**
 * DC-05 §3.3 enforcement gate (unit-level shape; the real one consults the
 * persisted trust store's FRESHEST entry per device_id, DC-10 E3).
 *
 * With `claimedPublicKey` provided, the impostor checks from the §3.3
 * pseudocode are enforced (Review-3 M-5):
 *   - SHA-256(claimedPublicKey) hex digest must reproduce `peerId`
 *     ("d-" + hex), i.e. the claimed key must hash to the claimed identity;
 *   - the STORED entry.publicKey must equal the claimed key byte-for-byte.
 * Any mismatch yields DENY_KEY_MISMATCH (impostor / substituted claim),
 * checked BEFORE any payload could flow and before status is consulted for
 * the digest check per §3.3's ordering.
 *
 * Without `claimedPublicKey`, behavior is unchanged: revoked => DENY_REVOKED,
 * unknown => DENY_UNPAIRED, else ALLOW. Pure function of its arguments —
 * propagation state never feeds it.
 */
export function canSynchronize(
  trustStore: ReadonlyMap<string, TrustStoreEntry>,
  peerId: string,
  claimedPublicKey?: Uint8Array,
): SyncDecision {
  const entry = trustStore.get(peerId);
  if (entry === undefined) return "DENY_UNPAIRED";
  if (claimedPublicKey !== undefined) {
    // §3.3 line 1: hash(remoteClaim.public_key) != idDigest(entry.device_id)
    const claimedId = deriveDeviceId(claimedPublicKey);
    if (claimedId !== peerId || !keysEqual(entry.publicKey, claimedPublicKey)) {
      return "DENY_KEY_MISMATCH";
    }
  }
  if (entry.status === "revoked") return "DENY_REVOKED";
  return "ALLOW";
}
