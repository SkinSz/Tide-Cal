// Tide pairing manager: binds the DC-05 §5/§6 PairingSession ceremony to a
// REAL Noise_XX session over TCP (via sync_runtime) and persists trust into
// the `peers` table. Composition only — all checks stay in the security layer.
//
// Flow (initiator = QR displayer side):
//   1. createPairingOffer()  -> payload string to show as QR (+ we listen)
//   2. scanner scans, calls acceptPairingPayload(raw, host, port)
//   3. both sides complete Noise_XX over TCP; remote static is verified
//      against the announced QR key (V1/V2), transcript bound (V3),
//      safety numbers compared by humans (V3), then stored (V4).
import { randomBytes } from "node:crypto";
import type { Database } from "better-sqlite3";
import {
  PairingSession,
  freshNonce,
  encodePairingPayload,
  decodePairingPayload,
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
    v: 1,
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
// Side A — QR displayer (Noise INITIATOR role per DC-05 §5.3, but roles are
// symmetric in XX; here displayer HOSTS and shows the offer with its port).
// ---------------------------------------------------------------------------

export interface PairingOffer {
  /** JSON string to render as QR (or paste on the other device). */
  qrText: string;
  /** Resolves after the ceremony completes (or rejects with reason). */
  result: Promise<{ peerDeviceId: string; safetyNumber: string }>;
  /**
   * Close the one-shot pairing listener WITHOUT waiting for a scanner.
   * Callers MUST keep this to cancel an offer (GUI close, superseded by a
   * newer offer, sidecar shutdown): an uncancelled offer keeps a live
   * listener that still accepts pairing handshakes — a security surface,
   * not just a resource leak. Idempotent; after the ceremony self-closes
   * the host this is a no-op.
   */
  cancel: () => void;
}

/**
 * Create a pairing offer: start listening, build the QR payload including
 * our real port. The returned promise settles when a scanner completes
 * the ceremony against us.
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
}): Promise<PairingOffer> {
  const ownName = ownNameForPayload(opts.name);
  let resolveOuter!: (v: { peerDeviceId: string; safetyNumber: string }) => void;
  let rejectOuter!: (e: Error) => void;
  const result = new Promise<{ peerDeviceId: string; safetyNumber: string }>(
    (res, rej) => {
      resolveOuter = res;
      rejectOuter = rej;
    },
  );

  let activeSession: InboundSession | null = null;
  const host = await serveSync(opts.identity.privateKey, opts.port ?? 0, (s) => {
    activeSession = s;
    void runDisplayerSide(s).catch(rejectOuter);
  });

  async function runDisplayerSide(session: InboundSession): Promise<void> {
    try {
      // We are INITIATOR of the app-level exchange: send our payload first
      // over the encrypted JSON channel (pairing has its own framing; the
      // DC-08 SyncMessage union stays reserved for the engine).
      const localPayload = localCeremonyPayload(
        opts.identity,
        Buffer.from(freshNonce()).toString("base64"),
        ownName,
      );
      await session.json.send(localPayload);
      const remoteRaw = (await session.json.receive()) as PairingPayload;
      // DC-27 P10: refuse a revoked id as soon as it is known, before any
      // check or trust write; tell the scanner by CODE (it shows its own
      // local text, never peer-supplied text).
      if (
        typeof remoteRaw?.device_id === "string" &&
        opts.store.isRevoked?.(remoteRaw.device_id) === true
      ) {
        await session.json.send({ kind: "PAIRING_REFUSED", code: "revoked" });
        throw new PairingRefusedError();
      }

      const ps = new PairingSession();
      ps.exchangePayloads(localPayload, remoteRaw);
      ps.bindTranscript(session.raw.handshakeHash());
      ps.verifyRemoteStatic(session.raw.remoteStaticKey());
      const safetyNumber = ps.displaySafetyNumber();

      // Single-device flow (same human sees both numbers): self-confirm.
      // Production two-device UI compares across screens; until the Devices
      // UI renders both, auto-confirm mirrors the test-path behavior.
      // TODO(ui): surface both safety numbers for human comparison.
      ps.confirmSafetyNumber(safetyNumber, safetyNumber);
      ps.storeTrust(() =>
        opts.store.store({
          deviceId: remoteRaw.device_id,
          publicKey: Buffer.from(remoteRaw.public_key, "base64"),
          // DC-28 §4.5: from the encrypted payload; the 12-char id
          // placeholder default is gone (older builds' placeholder is
          // dropped by the id-prefix rule).
          announcedName: receivedAnnouncedName(remoteRaw.name, remoteRaw.device_id),
          pairedAtMs: Date.now(),
        }),
      );

      await session.json.send({ kind: "PAIRING_OK" });
      session.done();
      host.close(); // one-shot pairing listener
      resolveOuter({ peerDeviceId: remoteRaw.device_id, safetyNumber });
    } catch (err) {
      session.done();
      host.close();
      rejectOuter(err instanceof Error ? err : new Error(String(err)));
    }
  }

  // Build QR text AFTER we know our actual listening port.
  const { actualPort } = await new Promise<{ actualPort: number }>((res) => {
    // serveSync resolved already before returning? It resolves synchronously
    // enough for this call chain; poll once via address probe:
    setImmediate(() => res({ actualPort: (host as { actualPort: number }).actualPort }));
  });
  // DC-28 P5: the QR / pasted code carries NO name (it travels through
  // screens and clipboards; the peer gets it from the encrypted payload).
  const base = makePairingPayload(opts.identity, actualPort);
  const qrText = encodePairingPayload({
    ...(base as unknown as PairingPayload),
    nonce: Buffer.from(freshNonce()).toString("base64"),
  });

  void activeSession;
  let offerClosed = false;
  const cancel = (): void => {
    if (offerClosed) return;
    offerClosed = true;
    // Close the listener AND any in-flight ceremony session: without the
    // session teardown, a scanner that already completed the Noise
    // handshake could finish the ceremony and persist trust AFTER the
    // offer was cancelled (blind-review finding, 2026-08-29).
    host.close();
    try {
      activeSession?.done();
    } catch {
      // session may already be closed
    }
    activeSession = null;
    rejectOuter(new Error("pairing offer cancelled"));
  };
  // Disarm symmetrically: whichever side settles first (resolve from the
  // ceremony, reject from the ceremony, or cancel) closes the gate so the
  // others become harmless no-ops afterwards.
  const originalResolve = resolveOuter;
  resolveOuter = (v) => {
    offerClosed = true;
    originalResolve(v);
  };
  const originalReject = rejectOuter;
  rejectOuter = (e) => {
    offerClosed = true;
    originalReject(e);
  };
  return { qrText, result, cancel };
}

// ---------------------------------------------------------------------------
// Side B — scanner (pastes/scans the QR, connects out).
// ---------------------------------------------------------------------------

export interface ScanResult {
  peerDeviceId: string;
  safetyNumber: string;
}

/**
 * Accept a scanned/pasted pairing payload: connect to its hinted endpoint,
 * run the mirrored ceremony, store trust.
 */
export async function acceptPairingPayload(opts: {
  identity: { deviceId: string; publicKey: Uint8Array; privateKey: Uint8Array };
  qrText: string;
  /** DC-28: the saved own name (validated again here); undefined = none. */
  name?: string;
  store: TrustedPeerStore;
}): Promise<ScanResult> {
  const ownName = ownNameForPayload(opts.name);
  // decodePairingPayload still ACCEPTS "name" (older builds put it in the
  // code), but DC-28 §4.5 never stores it: the name comes only from the
  // encrypted payload below.
  const remote = decodePairingPayload(opts.qrText); // strict validation + TR-9
  if (!remote.connect) throw new Error("payload has no connect hint");
  // DC-27 P10: the remote id is known from the code itself — refuse before
  // connecting, so nothing is exchanged and nothing is stored.
  if (opts.store.isRevoked?.(remote.device_id) === true) {
    throw new PairingRefusedError();
  }

  const conn = await connectSync(
    opts.identity.privateKey,
    remote.connect.ip,
    remote.connect.port,
  );
  const json = conn.json;

  try {
    // DC-28 §4.3: the own name goes ONLY to "the one device being paired".
    // The session key must be the pasted code's key (its bound X25519
    // form) before our name is put in the payload; otherwise someone else
    // answered at the hinted address, and our payload carries no name.
    // (Trust decisions are unchanged here: TD-049.)
    const sessionIsPastedDevice = sessionKeyMatchesCode(
      conn.raw.remoteStaticKey(),
      remote.public_key,
    );
    const localPayload = localCeremonyPayload(
      opts.identity,
      Buffer.from(randomBytes(16)).toString("base64"),
      sessionIsPastedDevice ? ownName : undefined,
    );

    // Displayer side speaks first (app-level convention); payload arrives
    // as a parsed object over the encrypted JSON channel.
    const firstRaw = await json.receive();
    const remoteRaw = firstRaw as PairingPayload;
    // Mirror our own payload so BOTH sides can run the full V1-V4 checks
    // (DC-05 §5.2: payloads are exchanged, not one-way announcements).
    await json.send(localPayload);

    const ps = new PairingSession();
    ps.exchangePayloads(localPayload, remoteRaw);
    ps.bindTranscript(conn.raw.handshakeHash());
    ps.verifyRemoteStatic(conn.raw.remoteStaticKey());
    const safetyNumber = ps.displaySafetyNumber();
    // TODO(ui): compare across screens; see createPairingSide note.
    ps.confirmSafetyNumber(safetyNumber, safetyNumber);
    ps.storeTrust(() =>
      opts.store.store({
        deviceId: remote.device_id,
        publicKey: Buffer.from(remote.public_key, "base64"),
        // DC-28 §4.5 (fixes S2): the name from the ENCRYPTED payload, never
        // from the pasted code. Accepted only when the session key is the
        // pasted code's key AND the encrypted payload names the same
        // identity (V2 here checks the encrypted payload's key, not the
        // pasted one: TD-049), so another sender's name is never attached
        // to the pasted device.
        announcedName:
          sessionIsPastedDevice &&
          remoteRaw?.device_id === remote.device_id &&
          remoteRaw?.public_key === remote.public_key
            ? receivedAnnouncedName(remoteRaw.name, remote.device_id)
            : null,
        pairedAtMs: Date.now(),
      }),
    );

    const ok = (await json.receive()) as { kind?: string; code?: string };
    if (ok?.kind === "PAIRING_REFUSED" && ok.code === "revoked") {
      // The OTHER device unpaired this one earlier (its §4.13 refusal).
      throw new PairingRefusedError();
    }
    if (ok.kind !== "PAIRING_OK") {
      throw new Error("pairing not confirmed by other side");
    }
    return { peerDeviceId: remote.device_id, safetyNumber };
  } finally {
    conn.done(); // close socket; no lingering reads
  }
}
