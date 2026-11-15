// Tide pairing manager: binds the DC-05 §5/§6 PairingSession ceremony to a
// REAL Noise_XX session over TCP (via sync_runtime) and persists trust into
// the `peers` table. Composition only — all checks stay in the security layer.
//
// Flow (DC-05 §5 with Appendix B, v2 codes). Roles per B.11: the displayer
// LISTENS (Noise responder), the scanner CONNECTS (Noise initiator).
//   1. createPairingOffer()  -> v2 code (with a one-time secret) to show
//   2. the code is pasted on the scanner: acceptPairingPayload(code)
//   3. Noise_XX over TCP; the scanner checks the session key against the
//      code (S1) and sends PAIRING_PROOF = HMAC(secret, label || h) first
//   4. the displayer answers ONLY after a valid proof (B.4): its payload,
//      then the scanner's payload (after S2/S3), then PAIRING_OK/REFUSED
//   5. both sides strictly decode the received payload (B.7), bind it to
//      the session key (V2), transcript bound (V3), then store (V4).
import type { Database } from "better-sqlite3";
import {
  PairingError,
  PairingSession,
  PAIRING_SECRET_BYTES,
  decodeBase64Exact,
  decodeCeremonyPayload,
  decodePairingCode,
  encodePairingCode,
  freshNonce,
  freshPairingSecret,
  pairingProofFrame,
  verifyPairingProof,
  type PairingPayload,
} from "../security/pairing.ts";
import { ed25519ToX25519PublicKey } from "../network/noise_transport.ts";
import { isKnownRevoked } from "../security/revocation_store.ts";
import { announcedNameFromPeer, validateName } from "../domain/device_names.ts";
import {
  serveSync,
  connectSync,
  makePairingPayload,
  type InboundSession,
} from "./sync_runtime.ts";

export interface TrustedPeerStore {
  /** Upsert a verified peer; returns true when stored. */
  store(peer: {
    deviceId: string;
    publicKey: Uint8Array;
    /**
     * DC-28 §4.5: the name the peer announced in its ENCRYPTED payload,
     * already validated (§4.8) — or null. Display-only (D1). A re-pair
     * replaces it; the local nickname (display_name) is never touched.
     */
    announcedName: string | null;
    pairedAtMs: number;
  }): boolean;
  /**
   * DC-27 P10 / DC-10 Appendix A.1: true when `deviceId` is 'revoked' here.
   * A ceremony with such an id is refused before any trust is stored.
   */
  isRevoked?(deviceId: string): boolean;
}

/** DC-27 P10: the user-visible refusal (exact §4.13 wording). */
export const REVOKED_REPAIR_MESSAGE =
  "This device was unpaired earlier. To pair it again, start it fresh first.";

export class PairingRefusedError extends Error {
  constructor() {
    super(REVOKED_REPAIR_MESSAGE);
    this.name = "PairingRefusedError";
  }
}

/**
 * DC-05 Appendix B.10 (P13, owner decision B.D): ONE user-visible text for
 * every refused code (older format, expired, used up, ended by too many
 * bad proofs or by its lifetime, malformed).
 */
export const PAIRING_CODE_INVALID_MESSAGE =
  "This pairing code is no longer valid. Create a new one.";

/**
 * A refused code. The message is always the single P13 text; `reason` is a
 * fixed machine token for logs and tests (never a field value, never the
 * secret or the proof).
 */
/**
 * The other device could not be reached for a reason other than a refused
 * or closed connection (EHOSTUNREACH, ETIMEDOUT, a name that does not
 * resolve, ...). Plain text only; the detail goes to the log.
 */
export const PAIRING_UNREACHABLE_MESSAGE =
  "The other device could not be reached. Check that both devices are on the same network, then try again.";

export class PairingUnreachableError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(PAIRING_UNREACHABLE_MESSAGE);
    this.name = "PairingUnreachableError";
    this.reason = reason;
  }
}

export class PairingCodeInvalidError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(PAIRING_CODE_INVALID_MESSAGE);
    this.name = "PairingCodeInvalidError";
    this.reason = reason;
  }
}

/** B.6 bounds of an open offer (P6, P7, P8). */
export interface PairingOfferBounds {
  /** P6: a handshaken connection must deliver its proof within this time. */
  proofWaitMs: number;
  /** P7: the offer ends after this many bad proofs. */
  maxBadProofs: number;
  /** P8: the offer ends this long after it was created. */
  lifetimeMs: number;
}

export const PAIRING_OFFER_BOUNDS: Readonly<PairingOfferBounds> = Object.freeze({
  proofWaitMs: 10_000,
  maxBadProofs: 3,
  lifetimeMs: 10 * 60_000,
});

/**
 * Ciphertext caps BEFORE decryption: the proof frame is ~70 bytes of JSON
 * plus the 16-byte tag; a ceremony payload with a DC-28 name stays well
 * under the payload cap.
 */
export const PAIRING_PROOF_MAX_CIPHER_BYTES = 256;
export const PAIRING_PAYLOAD_MAX_CIPHER_BYTES = 4096;

/** B.4: the one fixed line for a connection closed without a valid proof. */
export function badProofLogLine(count: number): string {
  return `[tide] pairing: connection without valid proof closed (${count})`;
}

/** SQL-backed store over the DC-07 peers table. */
export function sqlPeerStore(db: Database): TrustedPeerStore {
  return {
    store({ deviceId, publicKey, announcedName, pairedAtMs }): boolean {
      // DC-27 P10 (S8): the upsert can never flip a 'revoked' row back to
      // trusted — the WHERE guard makes it a no-op, and a no-op is refused.
      // An id named by a stored valid record is refused too (no peers row
      // needed: known-revoked by gossip, DC-05 §7.3).
      if (isKnownRevoked(db, deviceId)) throw new PairingRefusedError();
      const info = db
        .prepare(
          `INSERT INTO peers (device_id, public_key, display_name, announced_name,
                              paired_at, status, last_known_clock)
           VALUES (?, ?, '', ?, ?, 'trusted', '{}')
           ON CONFLICT(device_id) DO UPDATE SET
             public_key = excluded.public_key,
             announced_name = excluded.announced_name,
             paired_at = excluded.paired_at,
             status = 'trusted'
           WHERE peers.status = 'trusted'`,
        )
        .run(
          deviceId,
          Buffer.from(publicKey),
          announcedName,
          Math.floor(pairedAtMs / 1000),
        );
      if (info.changes === 0) throw new PairingRefusedError();
      return true;
    },
    isRevoked(deviceId: string): boolean {
      return isKnownRevoked(db, deviceId);
    },
  };
}

export function listTrustedPeers(db: Database): Array<{
  device_id: string;
  /** DC-28: the local nickname ("" = none). Render via deviceNameViews. */
  display_name: string;
  announced_name: string | null;
  paired_at: number;
  last_endpoint_host: string | null;
  last_endpoint_port: number | null;
  last_endpoint_seen: number | null;
}> {
  return db
    .prepare(
      `SELECT device_id, display_name, announced_name, paired_at,
              last_endpoint_host, last_endpoint_port, last_endpoint_seen
       FROM peers
       WHERE status = 'trusted' ORDER BY paired_at`,
    )
    .all() as Array<{
    device_id: string;
    display_name: string;
    announced_name: string | null;
    paired_at: number;
    last_endpoint_host: string | null;
    last_endpoint_port: number | null;
    last_endpoint_seen: number | null;
  }>;
}

// ---------------------------------------------------------------------------
// DC-21 §4: last-known endpoints (D5/D6). NON-AUTHORITATIVE connectivity
// conveniences: device-local, never replicated, never written from browse
// results — ONLY after a successful authenticated sync session (D6). Never
// cleared on browse removal (§4.2): a peer that said goodbye is merely gone
// right now; the last-known endpoint is exactly the fallback for that case.
// ---------------------------------------------------------------------------

export function recordPeerEndpoint(
  db: Database,
  deviceId: string,
  host: string,
  port: number,
  seenMs: number,
): void {
  db.prepare(
    `UPDATE peers
     SET last_endpoint_host = ?, last_endpoint_port = ?, last_endpoint_seen = ?
     WHERE device_id = ?`,
  ).run(host, port, seenMs, deviceId);
}

// ---------------------------------------------------------------------------
// DC-28 §4.3/§4.5: names in the ceremony. The own name leaves the device
// ONLY inside the encrypted payload, never in the QR / pasted code (P5).
// ---------------------------------------------------------------------------

/** The own name as it may go into our encrypted payload (§4.8), or undefined. */
export function ownNameForPayload(name: unknown): string | undefined {
  if (name === undefined || name === null) return undefined;
  const r = validateName(name);
  if (!r.ok) {
    console.error(`[tide] pairing: own name not sent (${r.rule})`);
    return undefined;
  }
  return r.name ?? undefined;
}

/** True when a Noise remote static is the bound X25519 form of `edPublicKeyB64`. */
function sessionKeyMatchesCode(remoteStatic: Uint8Array, edPublicKeyB64: string): boolean {
  try {
    const x = ed25519ToX25519PublicKey(Buffer.from(edPublicKeyB64, "base64"));
    return Buffer.from(x).equals(Buffer.from(remoteStatic));
  } catch {
    return false;
  }
}

/** Our encrypted-channel payload; carries "name" only when one is set. */
function localCeremonyPayload(
  identity: { deviceId: string; publicKey: Uint8Array },
  nonce: string,
  name: string | undefined,
): PairingPayload {
  const p: PairingPayload = {
    v: 2,
    device_id: identity.deviceId,
    public_key: Buffer.from(identity.publicKey).toString("base64"),
    nonce,
  };
  if (name !== undefined) p.name = name;
  return p;
}

/**
 * §4.5 on receive (both sides): validate the ENCRYPTED payload's name; an
 * invalid one is dropped and pairing still succeeds. The debug line carries
 * the rule only, never any part of the name (TR-4).
 */
export function receivedAnnouncedName(raw: unknown, senderDeviceId: string): string | null {
  const r = announcedNameFromPeer(raw, senderDeviceId);
  if (r.ignored !== undefined) console.error(`[tide] pairing: peer name ignored (${r.ignored})`);
  return r.name;
}

// ---------------------------------------------------------------------------
// Side A — displayer (shows the code, LISTENS: Noise responder, B.11).
// ---------------------------------------------------------------------------

/**
 * open      listening, waiting for a valid proof
 * pairing   a valid proof was accepted; the ceremony runs on that connection
 * paired    trust stored, PAIRING_OK sent
 * ended     the code is no longer valid (P7 bad proofs, P8 lifetime, or a
 *           failed ceremony after the proof, B.5)
 * cancelled cancelled, superseded or shut down
 */
export type PairingOfferStatus = "open" | "pairing" | "paired" | "ended" | "cancelled";

export interface PairingOffer {
  /** The v2 code to show (paste on the other device). Contains the secret. */
  qrText: string;
  /** Resolves after the ceremony completes (or rejects with reason). */
  result: Promise<{ peerDeviceId: string; safetyNumber: string }>;
  /**
   * Close the offer WITHOUT waiting for a scanner: the listener, every open
   * connection, and the secret. Callers MUST keep this to cancel an offer
   * (GUI close, superseded by a newer offer, sidecar shutdown): an
   * uncancelled offer keeps a live listener. Idempotent; a no-op once the
   * offer has ended.
   */
  cancel: () => void;
  /** Current state of the offer (for the displayer's UI, P7/P8). */
  status: () => PairingOfferStatus;
}

/**
 * Create a pairing offer: start listening, build the v2 code including our
 * real port and a fresh one-time secret (B.2). The returned promise settles
 * when the ceremony ends.
 *
 * Appendix B rules enforced here:
 *   B.4  nothing is sent, parsed or looked up on a connection before a
 *        valid proof; a bad proof gets a silent close and one counter line;
 *   B.5  the first valid proof consumes the secret in the same synchronous
 *        step that verifies it, stops the listener and closes every other
 *        connection without a message;
 *   B.6  P6 proof wait, P7 bad-proof limit, P8 lifetime; every end
 *        destroys the secret.
 */
export async function createPairingOffer(opts: {
  identity: {
    deviceId: string;
    publicKey: Uint8Array;
    privateKey: Uint8Array;
  };
  port?: number;
  /** DC-28: the saved own name (validated again here); undefined = none. */
  name?: string;
  store: TrustedPeerStore;
  /** B.6 bounds; tests only. Production uses PAIRING_OFFER_BOUNDS. */
  bounds?: Partial<PairingOfferBounds>;
  /** Tests only (TR-B9): observe that every end wipes the secret buffer. */
  testHooks?: { secretBuffer?: (secret: Buffer) => void };
}): Promise<PairingOffer> {
  const bounds: PairingOfferBounds = { ...PAIRING_OFFER_BOUNDS, ...opts.bounds };
  const ownName = ownNameForPayload(opts.name);
  let resolveOuter!: (v: { peerDeviceId: string; safetyNumber: string }) => void;
  let rejectOuter!: (e: Error) => void;
  const result = new Promise<{ peerDeviceId: string; safetyNumber: string }>(
    (res, rej) => {
      resolveOuter = res;
      rejectOuter = rej;
    },
  );

  // B.2: held in memory only; never persisted, logged or sent.
  let secret: Buffer | null = freshPairingSecret();
  opts.testHooks?.secretBuffer?.(secret);
  let status: PairingOfferStatus = "open";
  let badProofs = 0;
  /** Handshaken connections that have not delivered a valid proof yet. */
  const waiting = new Set<InboundSession>();
  /** The one connection that proved the secret (B.5). */
  let ceremony: InboundSession | null = null;
  let host: { actualPort: number; close(): void } | null = null;
  let lifetimeTimer: ReturnType<typeof setTimeout> | null = null;

  const destroySecret = (): void => {
    if (secret !== null) {
      secret.fill(0); // VB-6: overwrite in place, then drop the reference
      secret = null;
    }
  };
  const drop = (s: InboundSession): void => {
    try {
      s.destroy();
    } catch {
      /* already closed */
    }
  };
  const stopListening = (): void => {
    try {
      host?.close();
    } catch {
      /* already closed */
    }
  };
  /** Every end path: secret destroyed, timers cleared, listener closed. */
  const finish = (next: "paired" | "ended" | "cancelled", err?: Error): boolean => {
    if (status === "paired" || status === "ended" || status === "cancelled") return false;
    status = next;
    destroySecret();
    if (lifetimeTimer !== null) clearTimeout(lifetimeTimer);
    lifetimeTimer = null;
    stopListening();
    for (const s of waiting) drop(s);
    waiting.clear();
    if (next !== "paired") {
      if (ceremony !== null) drop(ceremony);
      rejectOuter(err ?? new PairingCodeInvalidError(next));
    }
    ceremony = null;
    return true;
  };

  const onSession = (s: InboundSession): void => {
    // A handshake that completes after the offer was consumed or ended
    // gets nothing (B.5); it is not counted.
    if (status !== "open") {
      drop(s);
      return;
    }
    waiting.add(s);
    void awaitProof(s);
  };

  async function awaitProof(s: InboundSession): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<{ ok: false }>((res) => {
      timer = setTimeout(() => res({ ok: false }), bounds.proofWaitMs);
      timer.unref?.();
    });
    const got = await Promise.race([
      s.json.receiveBounded(PAIRING_PROOF_MAX_CIPHER_BYTES).catch(() => ({ ok: false as const })),
      timeout,
    ]);
    clearTimeout(timer);
    // Closed meanwhile by B.5 (another connection proved) or by an end of
    // the offer: not counted.
    if (!waiting.has(s)) return;
    waiting.delete(s);
    // B.5: verify and consume in ONE synchronous step (no await between).
    if (
      status === "open" &&
      got.ok &&
      verifyPairingProof(got.value, secret, s.raw.handshakeHash())
    ) {
      status = "pairing";
      destroySecret();
      stopListening();
      for (const other of waiting) drop(other);
      waiting.clear();
      ceremony = s;
      void runCeremony(s);
      return;
    }
    // B.4: wrong, malformed, oversize or missing proof (also a clean close
    // or silence past the P6 wait): silent close, one fixed counter line.
    drop(s);
    badProofs++;
    console.error(badProofLogLine(badProofs));
    if (badProofs >= bounds.maxBadProofs) finish("ended", new PairingCodeInvalidError("bad_proofs"));
  }

  async function runCeremony(session: InboundSession): Promise<void> {
    try {
      // P4: after the proof the order is unchanged: our payload first.
      const localPayload = localCeremonyPayload(opts.identity, freshNonce(), ownName);
      await session.json.send(localPayload);
      const got = await session.json.receiveBounded(PAIRING_PAYLOAD_MAX_CIPHER_BYTES);
      if (!got.ok) throw new PairingCodeInvalidError("closed");
      // P10 step 1: strict decode (B.7).
      const remote = decodeCeremonyPayload(got.value);
      // P10 step 2: DC-27 A.2 refusal, reached only by a party that holds
      // the code. Tell the scanner by CODE (it shows its own local text).
      if (opts.store.isRevoked?.(remote.device_id) === true) {
        await session.json.send({ kind: "PAIRING_REFUSED", code: "revoked" });
        throw new PairingRefusedError();
      }
      // P10 step 3: binding (§6.1 V2 for the displayer is a real check:
      // remote_static == X25519(P.public_key)), V3, then trust.
      const ps = new PairingSession();
      ps.exchangePayloads(localPayload, remote);
      ps.bindTranscript(session.raw.handshakeHash());
      ps.verifyRemoteStatic(session.raw.remoteStaticKey());
      const safetyNumber = ps.displaySafetyNumber();

      // TODO(ui): surface both safety numbers for human comparison
      // (deferred, Appendix B.8 / P12).
      ps.confirmSafetyNumber(safetyNumber, safetyNumber);
      // Cancelled or expired while the ceremony ran: store nothing.
      if (status !== "pairing") throw new PairingCodeInvalidError("ended");
      ps.storeTrust(() =>
        opts.store.store({
          deviceId: remote.device_id,
          publicKey: Buffer.from(remote.public_key, "base64"),
          // DC-28 §4.5: from the encrypted payload.
          announcedName: receivedAnnouncedName(remote.name, remote.device_id),
          pairedAtMs: Date.now(),
        }),
      );

      await session.json.send({ kind: "PAIRING_OK" });
      session.done();
      if (finish("paired")) resolveOuter({ peerDeviceId: remote.device_id, safetyNumber });
    } catch (err) {
      // B.5 (P5): a failure after the proof ends the offer; a new code is needed.
      session.done();
      ceremony = null;
      finish("ended", err instanceof Error ? err : new Error(String(err)));
    }
  }

  try {
    host = await serveSync(opts.identity.privateKey, opts.port ?? 0, onSession);
  } catch (err) {
    // The listener could not start (e.g. EADDRINUSE on a given port): the
    // offer never existed, and its secret is wiped like on any end (B.2).
    status = "cancelled";
    destroySecret();
    throw err;
  }

  // P8: the offer ends `lifetimeMs` after it was created, also while a
  // ceremony runs (a stalled scanner cannot hold it open).
  lifetimeTimer = setTimeout(
    () => finish("ended", new PairingCodeInvalidError("expired")),
    bounds.lifetimeMs,
  );
  lifetimeTimer.unref?.();

  // DC-28 P5: the code carries NO name. B.2: the secret travels only here.
  const base = makePairingPayload(opts.identity, host.actualPort);
  const qrText = encodePairingCode({
    ...base,
    nonce: freshNonce(),
    secret: secret!.toString("base64"),
  });

  const cancel = (): void => {
    finish("cancelled", new Error("pairing offer cancelled"));
  };
  return { qrText, result, cancel, status: () => status };
}

// ---------------------------------------------------------------------------
// Side B — scanner (the code is pasted here; CONNECTS: Noise initiator).
// ---------------------------------------------------------------------------

export interface ScanResult {
  peerDeviceId: string;
  safetyNumber: string;
}

/** Fixed scanner-side line for a refused code: the reason token only. */
function refused(reason: string): PairingCodeInvalidError {
  console.error(`[tide] pairing: code refused (${reason})`);
  return new PairingCodeInvalidError(reason);
}

function isConnRefusedOrClosed(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  if (code === "ECONNREFUSED" || code === "ECONNRESET") return true;
  return err instanceof Error && err.message === "peer closed during handshake";
}

/**
 * Accept a pasted v2 code: connect to its hinted endpoint, bind the session
 * to the code (B.1), prove the secret (B.3), run the ceremony, store trust.
 *
 * Errors: PairingRefusedError (DC-27 text) when either side has the other
 * id revoked; PairingCodeInvalidError (the single P13 text) for every
 * refused code and for every abort of B.1/B.7; other errors unchanged.
 */
export async function acceptPairingPayload(opts: {
  identity: { deviceId: string; publicKey: Uint8Array; privateKey: Uint8Array };
  qrText: string;
  /** DC-28: the saved own name (validated again here); undefined = none. */
  name?: string;
  store: TrustedPeerStore;
}): Promise<ScanResult> {
  const ownName = ownNameForPayload(opts.name);
  let code;
  try {
    code = decodePairingCode(opts.qrText); // TR-9, TR-B5, TR-B6
  } catch (err) {
    if (err instanceof PairingError) throw refused(err.code);
    throw err;
  }
  // DC-27 P10: the remote id is known from the code itself — refuse before
  // connecting, so nothing is exchanged and nothing is stored.
  if (opts.store.isRevoked?.(code.device_id) === true) {
    throw new PairingRefusedError();
  }
  const secret = decodeBase64Exact(code.secret, PAIRING_SECRET_BYTES)!;
  const codeKey = Buffer.from(code.public_key, "base64");

  let conn: InboundSession;
  try {
    conn = await connectSync(opts.identity.privateKey, code.connect.ip, code.connect.port);
  } catch (err) {
    secret.fill(0);
    if (isConnRefusedOrClosed(err)) throw refused("unreachable");
    // Detail (error code) in the log only; the user sees a plain sentence.
    const errCode = (err as { code?: unknown } | null)?.code;
    const reason = typeof errCode === "string" && /^[A-Z_]+$/.test(errCode) ? errCode : "other";
    console.error(`[tide] pairing: connect failed (${reason})`);
    throw new PairingUnreachableError(reason);
  }
  const json = conn.json;

  try {
    // B.1 S1: before ANY frame, the session key must be the code's key.
    // Otherwise someone else answered: no proof, no payload, no name.
    if (!sessionKeyMatchesCode(conn.raw.remoteStaticKey(), code.public_key)) {
      throw refused("session_key");
    }
    const h = conn.raw.handshakeHash();
    // B.3: the proof is our FIRST frame; the secret is wiped right after.
    await json.send(pairingProofFrame(secret, h));
    secret.fill(0);

    // A displayer that refuses the proof (wrong, used up, expired) closes
    // without a message.
    const first = await json.receiveBounded(PAIRING_PAYLOAD_MAX_CIPHER_BYTES);
    if (!first.ok) throw refused("closed");
    // B.7 strict decode; VB-8: an older displayer's v1 payload fails here
    // (BAD_VERSION) and we send nothing more.
    const remote = decodeCeremonyPayload(first.value);
    // B.1 S2/S3: the payload names exactly the code's identity.
    if (
      remote.device_id !== code.device_id ||
      !Buffer.from(remote.public_key, "base64").equals(codeKey)
    ) {
      throw refused("payload_mismatch");
    }

    // DC-28 §4.3: our name goes only to the device being paired, which
    // S1-S3 have now established.
    const localPayload = localCeremonyPayload(opts.identity, freshNonce(), ownName);
    await json.send(localPayload);

    const ps = new PairingSession();
    ps.exchangePayloads(localPayload, remote);
    ps.bindTranscript(h);
    ps.verifyRemoteStatic(conn.raw.remoteStaticKey());
    const safetyNumber = ps.displaySafetyNumber();
    // TODO(ui): compare across screens (deferred, Appendix B.8 / P12).
    ps.confirmSafetyNumber(safetyNumber, safetyNumber);
    ps.storeTrust(() =>
      opts.store.store({
        // The code identity, which by S1-S3 equals the session identity.
        deviceId: code.device_id,
        publicKey: codeKey,
        // DC-28 §4.5: the name from the ENCRYPTED payload, never the code.
        announcedName: receivedAnnouncedName(remote.name, code.device_id),
        pairedAtMs: Date.now(),
      }),
    );

    const ok = await json.receiveBounded(PAIRING_PAYLOAD_MAX_CIPHER_BYTES);
    const msg = (ok.ok ? ok.value : null) as { kind?: unknown; code?: unknown } | null;
    if (msg?.kind === "PAIRING_REFUSED" && msg.code === "revoked") {
      // The OTHER device unpaired this one earlier (its §4.13 refusal).
      throw new PairingRefusedError();
    }
    if (msg?.kind !== "PAIRING_OK") {
      // The displayer closed after the proof (code used up, cancelled or
      // expired mid-ceremony) or answered something else: B.10 "used up".
      throw refused("not_confirmed");
    }
    return { peerDeviceId: code.device_id, safetyNumber };
  } catch (err) {
    if (err instanceof PairingError) throw refused(err.code);
    throw err;
  } finally {
    secret.fill(0);
    conn.done(); // close socket; no lingering reads
  }
}
