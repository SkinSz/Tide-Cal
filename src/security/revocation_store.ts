// Tide DC-27 §4.3/§4.6: DB wiring of the DC-05 §7 / DC-10 revocation
// machinery over the DC-07 tables (revocation_records, revocation_acks,
// peers). revocation.ts stays pure; this module is the persisted record
// store, the persisted ACK store (P5), the local unpair transaction, and the
// RevocationChannel the sync engine is handed for every session.
//
// Logging (DC-27 P9 / §4.12): one info line per event, short ids only. Never
// logged: keys, signatures, record bytes, display names, addresses.
import { deviceNameViews } from "../domain/device_names.ts";
import type { Database } from "better-sqlite3";
import {
  canonicalRevocationBytes,
  createRevocation,
  recordTriple,
  shortDeviceId,
  validateRevocationRecord,
  verifyRevocation,
  type RevocationRecord,
  type RevocationTriple,
  type SignedRevocation,
  type TrustStoreEntry,
  type TrustStoreLookup,
} from "./revocation.ts";
import type { RevocationChannel } from "../sync/sync_engine.ts";

export type LogFn = (line: string) => void;

const defaultLog: LogFn = (line) => console.error(`[tide] ${line}`);

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** DC-05 §7.2 trust lookup over the persisted peers table (+ this device). */
export function dbTrustLookup(
  db: Database,
  self?: { deviceId: string; publicKey: Uint8Array },
): TrustStoreLookup {
  const stmt = db.prepare(
    "SELECT public_key, status FROM peers WHERE device_id = ?",
  );
  return (deviceId: string): TrustStoreEntry | undefined => {
    if (self !== undefined && deviceId === self.deviceId) {
      return { publicKey: self.publicKey, status: "trusted" };
    }
    const row = stmt.get(deviceId) as
      | { public_key: Buffer; status: "trusted" | "revoked" }
      | undefined;
    if (row === undefined) return undefined;
    return { publicKey: new Uint8Array(row.public_key), status: row.status };
  };
}

interface StoredRow {
  record_bytes: Buffer;
  signature: Buffer;
}

function rowToSigned(row: StoredRow): SignedRevocation | undefined {
  try {
    const record = validateRevocationRecord(
      JSON.parse(Buffer.from(row.record_bytes).toString("utf8")),
    );
    return { record, signature: new Uint8Array(row.signature) };
  } catch {
    return undefined; // never stored invalid; defensive only
  }
}

/** All stored VALID records (DC-10 TRP-3: only valid records are stored). */
export function listValidRevocations(db: Database): SignedRevocation[] {
  const rows = db
    .prepare(
      `SELECT record_bytes, signature FROM revocation_records
       WHERE verification_state = 'valid'
       ORDER BY received_at_hlc, revoked_device_id, revoked_by_device_id, revoked_at_hlc`,
    )
    .all() as StoredRow[];
  const out: SignedRevocation[] = [];
  for (const r of rows) {
    const s = rowToSigned(r);
    if (s !== undefined) out.push(s);
  }
  return out;
}

/**
 * DC-05 Appendix A.2: per revoked producer, the HIGHEST cutoff among the
 * valid records held. A record signed without revoked_after_seq contributes
 * 0 (no history accepted on its authority alone). Keyed by RECORDS, not by
 * peers.status, so a device that never paired the revoked id (fresh start,
 * new third device) applies the same rule (DC-27 TR-12).
 */
export function revokedCutoffs(db: Database): Map<string, number> {
  const rows = db
    .prepare(
      `SELECT revoked_device_id AS d, MAX(COALESCE(revoked_after_seq, 0)) AS c
       FROM revocation_records WHERE verification_state = 'valid'
       GROUP BY revoked_device_id`,
    )
    .all() as Array<{ d: string; c: number }>;
  return new Map(rows.map((r) => [r.d, r.c]));
}

/**
 * DC-05 §7.3 "locally known-revoked": a device id is known-revoked when its
 * peers row says 'revoked' OR this device holds a VALID record naming it. The
 * second half matters on devices that never paired the id (a fresh start, a
 * device paired after the unpair): they learn the record by gossip but have
 * no peers row to flip (DC-27 TR-11/TR-12).
 */
export function isKnownRevoked(db: Database, deviceId: string): boolean {
  const row = db
    .prepare(
      `SELECT 1 FROM peers WHERE device_id = @id AND status = 'revoked'
       UNION ALL
       SELECT 1 FROM revocation_records
        WHERE revoked_device_id = @id AND verification_state = 'valid'
       LIMIT 1`,
    )
    .get({ id: deviceId });
  return row !== undefined;
}

function insertRecordStmt(db: Database) {
  return db.prepare(
    `INSERT INTO revocation_records
       (revoked_device_id, revoked_by_device_id, revoked_at_hlc, reason,
        record_bytes, signature, verification_state, received_at_hlc,
        revoked_after_seq)
     VALUES (?, ?, ?, NULL, ?, ?, 'valid', ?, ?)`,
  );
}

/**
 * DC-27 §4.4/§4.14: buffered changes of a revoked producer above the
 * cutoff may never apply. Deleted in the same transaction that makes the
 * producer known-revoked (local unpair AND inbound acceptance), so a later
 * gap fill cannot drain them through applyRemoteChange.
 */
function deletePendingAboveCutoff(db: Database, producer: string): void {
  const cutoff = revokedCutoffs(db).get(producer) ?? 0;
  db.prepare(
    "DELETE FROM pending_changes WHERE device_id = ? AND local_seq > ?",
  ).run(producer, cutoff);
}

/**
 * DC-27 §4.3/§4.4 (DC-16 §2.4: "removed ... by unpair/revocation"): per-peer
 * state a revoked device no longer needs. Runs inside the transaction that
 * makes it known-revoked, on the local unpair AND the inbound acceptance
 * path. Tier-1 in-memory state is dropped by the caller after the commit.
 */
function clearRevokedPeerState(db: Database, deviceId: string): void {
  db.prepare(
    `UPDATE peers SET last_endpoint_host = NULL, last_endpoint_port = NULL,
            last_endpoint_seen = NULL
     WHERE device_id = ?`,
  ).run(deviceId);
  db.prepare("DELETE FROM hard_blocks WHERE producer_device_id = ?").run(deviceId);
  db.prepare("DELETE FROM peer_invalid_tally WHERE producer_device_id = ?").run(deviceId);
}

export interface DbRevocationChannelOptions {
  selfDeviceId: string;
  selfPublicKey: Uint8Array;
  /** Same clock as change records (EventCore HLC, DC-27 V3). */
  hlcNow: () => number;
  log?: LogFn;
  /** Called after an inbound record naming a KNOWN peer flipped it to revoked. */
  onPeerRevoked?: (deviceId: string) => void;
}

export type DbRevocationChannel = RevocationChannel & {
  revokedCutoffs(): Map<string, number>;
};

/**
 * DC-27 §4.6 dbRevocationChannel: RevocationChannel over the persisted
 * record store and the persisted ACK store.
 */
export function makeDbRevocationChannel(
  db: Database,
  opts: DbRevocationChannelOptions,
): DbRevocationChannel {
  const log = opts.log ?? defaultLog;
  const lookup = dbTrustLookup(db, {
    deviceId: opts.selfDeviceId,
    publicKey: opts.selfPublicKey,
  });
  const findStored = db.prepare(
    `SELECT signature FROM revocation_records
     WHERE revoked_device_id = ? AND revoked_by_device_id = ? AND revoked_at_hlc = ?
       AND verification_state = 'valid'`,
  );
  return {
    queueFor(peer: string): SignedRevocation[] {
      const rows = db
        .prepare(
          `SELECT r.record_bytes, r.signature FROM revocation_records r
           WHERE r.verification_state = 'valid'
             AND r.revoked_device_id != ?
             AND NOT EXISTS (
               SELECT 1 FROM revocation_acks a
               WHERE a.peer_device_id = ?
                 AND a.revoked_device_id = r.revoked_device_id
                 AND a.revoked_by_device_id = r.revoked_by_device_id
                 AND a.revoked_at_hlc = r.revoked_at_hlc)
           ORDER BY r.received_at_hlc`,
        )
        .all(peer, peer) as StoredRow[];
      const out: SignedRevocation[] = [];
      for (const r of rows) {
        const s = rowToSigned(r);
        if (s !== undefined) out.push(s);
      }
      return out;
    },

    async acceptInbound(signed: SignedRevocation, fromPeer: string): Promise<boolean> {
      const from = shortDeviceId(fromPeer);
      let record: RevocationRecord;
      try {
        record = validateRevocationRecord(signed.record);
      } catch {
        log(`revocation: rejected record (malformed) from ${from}`);
        return false;
      }
      // Store-once by triple BEFORE verification (DC-10 §2.4): our own
      // record echoed back by a relay is a duplicate, not a rejection.
      const existing = findStored.get(
        record.revoked_device_id,
        record.revoked_by_device_id,
        record.revoked_at_hlc,
      ) as { signature: Buffer } | undefined;
      if (existing !== undefined) {
        if (bytesEqual(new Uint8Array(existing.signature), signed.signature)) {
          return false; // duplicate: no-op, still ACKed by the engine
        }
        log(`revocation: rejected record (conflicting_triple) from ${from}`);
        return false;
      }
      const verdict = await verifyRevocation({ record, signature: signed.signature }, lookup);
      if (!verdict.valid) {
        log(`revocation: rejected record (${verdict.reason}) from ${from}`);
        return false;
      }
      // DC-07 T6: record insert and status flip in ONE transaction. The
      // revoker's trust is re-checked inside it: verification awaited, and a
      // local unpair of the revoker may have committed meanwhile.
      let flipped = false;
      const stored = db.transaction((): "stored" | "duplicate" | "untrusted" => {
        const revoker = lookup(record.revoked_by_device_id);
        if (revoker === undefined || revoker.status !== "trusted") return "untrusted";
        const dup = findStored.get(
          record.revoked_device_id,
          record.revoked_by_device_id,
          record.revoked_at_hlc,
        );
        if (dup !== undefined) return "duplicate";
        insertRecordStmt(db).run(
          record.revoked_device_id,
          record.revoked_by_device_id,
          record.revoked_at_hlc,
          Buffer.from(canonicalRevocationBytes(record)),
          Buffer.from(signed.signature),
          opts.hlcNow(),
          record.revoked_after_seq ?? null,
        );
        const res = db
          .prepare(
            "UPDATE peers SET status = 'revoked' WHERE device_id = ? AND status = 'trusted'",
          )
          .run(record.revoked_device_id);
        flipped = res.changes > 0;
        clearRevokedPeerState(db, record.revoked_device_id);
        deletePendingAboveCutoff(db, record.revoked_device_id);
        return "stored";
      })();
      if (stored === "duplicate") return false;
      if (stored === "untrusted") {
        log(`revocation: rejected record (revoker_not_trusted) from ${from}`);
        return false;
      }
      log(
        `revocation: accepted record for ${shortDeviceId(record.revoked_device_id)} ` +
          `from ${from}`,
      );
      if (flipped) {
        try {
          opts.onPeerRevoked?.(record.revoked_device_id);
        } catch {
          /* a hook must never fail acceptance */
        }
      }
      return true;
    },

    acceptedTriples(): RevocationTriple[] {
      return (
        db
          .prepare(
            `SELECT revoked_device_id, revoked_at_hlc, revoked_by_device_id
             FROM revocation_records WHERE verification_state = 'valid'`,
          )
          .all() as RevocationTriple[]
      ).map((t) => ({
        revoked_device_id: t.revoked_device_id,
        revoked_at_hlc: t.revoked_at_hlc,
        revoked_by_device_id: t.revoked_by_device_id,
      }));
    },

    recordAck(fromPeer: string, triples: RevocationTriple[]): void {
      if (!Array.isArray(triples)) return;
      // Only triples we hold are recorded: the queue only consults those,
      // and this keeps a chatty peer from growing the table (T-f).
      const ins = db.prepare(
        `INSERT OR IGNORE INTO revocation_acks
           (peer_device_id, revoked_device_id, revoked_by_device_id, revoked_at_hlc, acked_at)
         SELECT ?, revoked_device_id, revoked_by_device_id, revoked_at_hlc, ?
         FROM revocation_records
         WHERE revoked_device_id = ? AND revoked_by_device_id = ? AND revoked_at_hlc = ?
           AND verification_state = 'valid'`,
      );
      const now = Date.now();
      db.transaction(() => {
        for (const t of triples) {
          if (
            t === null ||
            typeof t !== "object" ||
            typeof t.revoked_device_id !== "string" ||
            typeof t.revoked_by_device_id !== "string" ||
            typeof t.revoked_at_hlc !== "number"
          ) {
            continue;
          }
          ins.run(fromPeer, now, t.revoked_device_id, t.revoked_by_device_id, t.revoked_at_hlc);
        }
      })();
    },

    revokedCutoffs(): Map<string, number> {
      return revokedCutoffs(db);
    },
  };
}

// ---------------------------------------------------------------------------
// DC-27 §4.3 local unpair transaction
// ---------------------------------------------------------------------------

export class UnpairError extends Error {
  constructor(
    readonly code: "ERR_CONFIRM" | "ERR_NOT_PAIRED" | "ERR_BUSY",
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "UnpairError";
  }
}

export type UnpairOutcome =
  | { already: true }
  | { already: false; triple: RevocationTriple; cutoff: number };

/**
 * DC-27 §4.3: sign a revocation for `deviceId` with the key this process
 * already holds (P7) and apply the local effect in ONE transaction (DC-07
 * T5). Any failure rolls back: no partial trust mutation.
 *
 * V4: the dispatcher does NOT serialize async ops (signing awaits), so the
 * status check is repeated INSIDE the synchronous transaction; a second
 * concurrent call sees 'revoked' there and returns {already: true} without
 * storing a record. The cutoff is also re-read there: if a session applied
 * more of the producer's changes while we signed, we sign again (bounded).
 */
export async function unpairLocal(
  db: Database,
  opts: {
    deviceId: string;
    selfDeviceId: string;
    privateKey: Uint8Array;
    hlcNow: () => number;
    /** Test-only fault injection: runs as the last step inside the transaction. */
    beforeCommit?: () => void;
  },
): Promise<UnpairOutcome> {
  const statusOf = db.prepare("SELECT status FROM peers WHERE device_id = ?");
  const cutoffOf = db.prepare(
    "SELECT applied_through FROM applied_upto WHERE producer_device_id = ?",
  );
  const readCutoff = (): number =>
    ((cutoffOf.get(opts.deviceId) as { applied_through: number } | undefined)
      ?.applied_through ?? 0);
  if (opts.deviceId === opts.selfDeviceId) {
    throw new UnpairError("ERR_NOT_PAIRED", "this device cannot unpair itself");
  }
  for (let attempt = 0; attempt < 5; attempt++) {
    const pre = statusOf.get(opts.deviceId) as { status: string } | undefined;
    if (pre === undefined) throw new UnpairError("ERR_NOT_PAIRED", "device is not paired");
    if (pre.status === "revoked") return { already: true };
    const hlc = opts.hlcNow();
    const cutoff = readCutoff();
    const signed = await createRevocation(
      {
        revoked_device_id: opts.deviceId,
        revoked_by_device_id: opts.selfDeviceId,
        revoked_at_hlc: hlc,
        revoked_after_seq: cutoff,
      },
      opts.privateKey,
    );
    const result = db.transaction((): UnpairOutcome | "retry" => {
      const row = statusOf.get(opts.deviceId) as { status: string } | undefined;
      if (row === undefined) throw new UnpairError("ERR_NOT_PAIRED", "device is not paired");
      if (row.status === "revoked") return { already: true };
      if (readCutoff() !== cutoff) return "retry";
      db.prepare("UPDATE peers SET status = 'revoked' WHERE device_id = ?").run(opts.deviceId);
      insertRecordStmt(db).run(
        signed.record.revoked_device_id,
        signed.record.revoked_by_device_id,
        signed.record.revoked_at_hlc,
        Buffer.from(canonicalRevocationBytes(signed.record)),
        Buffer.from(signed.signature),
        hlc,
        cutoff,
      );
      clearRevokedPeerState(db, opts.deviceId);
      db.prepare(
        "DELETE FROM pending_changes WHERE device_id = ? AND local_seq > ?",
      ).run(opts.deviceId, cutoff);
      opts.beforeCommit?.();
      return { already: false, triple: recordTriple(signed.record), cutoff };
    })();
    if (result !== "retry") return result;
  }
  throw new UnpairError("ERR_BUSY", "the device is still syncing; try again");
}

// ---------------------------------------------------------------------------
// DC-27 §4.11 / P8: Removed devices listing
// ---------------------------------------------------------------------------

export interface RemovedDevice {
  device_id: string;
  label: string;
  removed_at: number;
  told: Array<{ device_id: string; label: string; done: boolean }>;
}

/**
 * Each revoked peer once, with per-OTHER-trusted-peer "told" state: done
 * when that peer ACKed any record naming the removed device (DC-10 §3).
 */
export function listRemovedDevices(db: Database, selfDeviceId: string): RemovedDevice[] {
  type NameRow = { device_id: string; display_name: string; announced_name: string | null };
  const revoked = db
    .prepare(
      "SELECT device_id, display_name, announced_name FROM peers WHERE status = 'revoked' ORDER BY device_id",
    )
    .all() as NameRow[];
  const trusted = db
    .prepare(
      "SELECT device_id, display_name, announced_name FROM peers WHERE status = 'trusted' ORDER BY paired_at, device_id",
    )
    .all() as NameRow[];
  // DC-28 §4.7/§4.10: revoked peers keep their label; each list (removed
  // devices, devices told) is disambiguated on its own (P7).
  const removedLabels = deviceNameViews(revoked, selfDeviceId);
  const toldLabels = new Map(
    deviceNameViews(trusted, selfDeviceId).map((v) => [v.device_id, v.label]),
  );
  const removedAt = db.prepare(
    `SELECT COALESCE(
        (SELECT MIN(revoked_at_hlc) FROM revocation_records
          WHERE revoked_device_id = @d AND revoked_by_device_id = @self
            AND verification_state = 'valid'),
        (SELECT MIN(received_at_hlc) FROM revocation_records
          WHERE revoked_device_id = @d AND verification_state = 'valid')) AS t`,
  );
  const acked = db.prepare(
    `SELECT 1 FROM revocation_acks a JOIN revocation_records r
       ON r.revoked_device_id = a.revoked_device_id
      AND r.revoked_by_device_id = a.revoked_by_device_id
      AND r.revoked_at_hlc = a.revoked_at_hlc
     WHERE a.peer_device_id = ? AND r.revoked_device_id = ? LIMIT 1`,
  );
  return revoked.map((p, i) => ({
    device_id: p.device_id,
    label: removedLabels[i]!.label,
    removed_at:
      (removedAt.get({ d: p.device_id, self: selfDeviceId }) as { t: number | null } | undefined)?.t ?? 0,
    told: trusted
      .filter((t) => t.device_id !== p.device_id)
      .map((t) => ({
        device_id: t.device_id,
        label: toldLabels.get(t.device_id)!,
        done: acked.get(t.device_id, p.device_id) !== undefined,
      })),
  }));
}
