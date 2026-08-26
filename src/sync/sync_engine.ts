// Tide DC-08 §4: Sync engine — canonical anti-entropy session flow.
// Transport-agnostic: a SyncTransport delivers JSON messages between two
// endpoints. The engine implements HELLO -> REQUEST/BATCH/ACK with the
// DC-02/DC-03/DC-04 receive pipeline.

import type { ChangeRecord, VectorClock } from "../sync/change_record.ts";
import { validateChangeRecord } from "../sync/change_record.ts";
type VC = VectorClock;
import {
  advanceByMerge,
} from "../sync/vector_clock.ts";
import {
  neededRanges,
  appliedThrough,
  emptyKnowledge,
} from "../sync/knowledge_state.ts";
import { applyRemoteChange, quarantineRecord } from "../persistence/database.ts";
import type { Database } from "better-sqlite3";
// DC-09 full-state snapshot construction/application (M-7 trigger layer).
import { applySnapshot, buildSnapshot, type Snapshot, type SnapshotEntry } from "./full_state.ts";
import {
  OfferDedup,
  TriggerStateTracker,
  offerSessionKey,
  resolveOfferRace,
} from "./full_state_triggers.ts";
// DC-10: revocation propagation rides every sync session as piggyback
// traffic (§2.2) with per-peer ACK bookkeeping (§2.5/§3).
import type {
  RevocationTriple,
  SignedRevocation,
} from "../security/revocation.ts";

function sigToHex(sig: Uint8Array): string {
  return Array.from(sig, (b) => b.toString(16).padStart(2, "0")).join("");
}

function sigFromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export type SyncMessage =
  | { v: 1; type: "HELLO"; device_clock: VC }
  | {
      v: 1;
      type: "CHANGES_REQUEST";
      ranges: Array<{ device_id: string; lo: number; hi: number }>;
    }
  | {
      v: 1;
      type: "CHANGES_BATCH";
      changes: ChangeRecord[];
      remaining_ranges?: Array<{ device_id: string; lo: number; hi: number }>;
    }
  | { v: 1; type: "CHANGES_ACK"; applied_upto: Record<string, number> }
  // --- DC-08 §3.6 full-state handshake carriers (DC-09 owns WHEN) ---
  | {
      v: 1;
      type: "FULL_STATE_OFFER";
      snapshot_clock: VC;
      snapshot_size_hint_bytes?: number;
      /** DC-09 §3.2: set on user-initiated offers (diagnostics only). */
      user_initiated?: boolean;
      /**
       * Engine extension: sender device id so the receiver can run the
       * deterministic §7.3 race resolution without transport-level context.
       */
      sender_device_id?: string;
    }
  | { v: 1; type: "FULL_STATE_ACCEPT"; offer_snapshot_clock_digest?: string }
  | {
      v: 1;
      type: "FULL_STATE_SNAPSHOT";
      snapshot_clock: VC;
      entities: SnapshotEntry[];
      tombstones?: Snapshot["tombstones"];
      /** Engine extension: marks the last message of the snapshot stream. */
      final?: boolean;
    }
  // --- DC-08 §3.7 / DC-10 §2.2–§3 revocation piggyback carriers ---
  | {
      v: 1;
      type: "REVOCATION_RECORDS";
      /** Hex-encoded detached signatures over canonical record bytes. */
      records: Array<{ record: SignedRevocation["record"]; signature_hex: string }>;
    }
  | { v: 1; type: "REVOCATIONS_ACK"; accepted: RevocationTriple[] };

/**
 * DC-10 boundary adapter handed to the engine by the composition root.
 * The engine calls it at the right points in the session flow; all trust
 * decisions stay inside the security layer (DC-10 §4).
 */
export interface RevocationChannel {
  /** §2.2: ALL accepted records not yet ACKed by this peer. */
  queueFor(peerDeviceId: string): SignedRevocation[];
  /** DC-05 §7.2 verify + store-once acceptance of one inbound record. */
  acceptInbound(signed: SignedRevocation, fromPeer: string): Promise<boolean>;
  /** Triples this device has ACCEPTED (sent as REVOCATIONS_ACK, §3). */
  acceptedTriples(): RevocationTriple[];
  /** §2.5: mark the peer's ack claims; stops re-sending to them. */
  recordAck(fromPeer: string, triples: RevocationTriple[]): void;
}

export interface SyncTransport {
  /** Send one message to the peer; resolves when handed off. */
  send(msg: SyncMessage): Promise<void>;
  /** Resolve the next inbound message (or null when peer closes). */
  receive(): Promise<SyncMessage | null>;
}

export interface SyncEngineDeps {
  db: Database;
  selfDeviceId: string;
  knowledge?: import("../sync/knowledge_state.ts").KnowledgeState;
  /** Entity mutation for an applied change (domain layer hook). */
  mutateEntity?: (db: Database, record: ChangeRecord) => void;
  maxBatchRecords?: number;
  /**
   * DC-09 §3 trigger bookkeeping (streaks persist across sessions when
   * provided); a fresh per-engine tracker is used otherwise.
   */
  triggers?: TriggerStateTracker;
  /** Stable identity of the connected peer, when known at session level. */
  peerDeviceId?: string;
  /**
   * DC-10 revocation propagation adapter (§2.2/§2.5). When provided,
   * REVOCATION_RECORDS / REVOCATIONS_ACK piggyback on every session.
   */
  revocations?: RevocationChannel;
}

export interface SyncEngine {
  runSession(transport: SyncTransport): Promise<SessionStats>;
}

export interface SessionStats {
  sent: number;
  receivedApplied: number;
  receivedBuffered: number;
  receivedDuplicate: number;
}

interface KnowledgeHolder {
  knowledge: NonNullable<SyncEngineDeps["knowledge"]> & {
    /** lastKnownClock(peer): what each peer has advertised/ACKed (DC-06 §2.1) */
    peerAdvertised?: Record<string, number>;
  };
}

export function createSyncEngine(deps: SyncEngineDeps): SyncEngine {
  const knowledge = deps.knowledge ?? loadKnowledgeFromDb(deps.db);
  const holder: KnowledgeHolder = { knowledge };
  const maxBatch = deps.maxBatchRecords ?? 256;
  // DC-09 §3 trigger bookkeeping; streaks are per peer/direction. Session
  // start resets the Trigger-A streak (§3.1); dedup is per-session (§3.5).
  const triggers = deps.triggers ?? new TriggerStateTracker();
  let sessionDedup = new OfferDedup();

  /**
   * H-4: one cached pending receive per session/transport. Calling this
   * never starts a second overlapping transport.receive() while one is
   * already in flight; when it resolves (or rejects), the slot clears so
   * the next call starts a fresh receive.
   */
  function nextMessage(
    transport: SyncTransport,
  ): () => Promise<SyncMessage | null> {
    let pending: Promise<SyncMessage | null> | null = null;
    return (): Promise<SyncMessage | null> => {
      if (pending === null) {
        pending = transport.receive().then(
          (msg) => {
            pending = null;
            return msg;
          },
          (err) => {
            pending = null;
            throw err;
          },
        );
      }
      return pending;
    };
  }

  function getDeviceClockDb(): VC {
    const rows = deps.db
      .prepare("SELECT peer_device_id AS d, max_seq AS s FROM device_clock")
      .all() as Array<{ d: string; s: number }>;
    const clock: VC = {};
    for (const r of rows) clock[r.d] = r.s;
    return clock;
  }

  async function runSession(transport: SyncTransport): Promise<SessionStats> {
    const stats: SessionStats = {
      sent: 0,
      receivedApplied: 0,
      receivedBuffered: 0,
      receivedDuplicate: 0,
    };
    // DC-09 §3.5: offers_made_this_session is in-memory only; a new session
    // gets fresh dedup state.
    sessionDedup = new OfferDedup();

    // --- HELLO exchange ---
    const hello: SyncMessage = {
      v: 1,
      type: "HELLO",
      device_clock: getDeviceClockDb(),
    };
    await transport.send(hello);
    stats.sent++;

    const peerHello = await expectType(nextMessage(transport), "HELLO");
    advancePeerKnowledge(peerHello.device_clock);
    // Stable key for per-peer trigger state (§3.1: streaks are per-peer,
    // per-direction). Prefer the configured peer id; fall back to the
    // advertised clock's producer set.
    const peerKey =
      deps.peerDeviceId ?? derivePeerKey(peerHello.device_clock);
    triggers.resetStreak(peerKey); // §3.1: streak resets at session start

    // --- DC-10 §2.2: push our full revocation queue for this peer ---
    await pushRevocationQueue(transport, stats);

    // --- pull what we need ---
    let ranges = neededRanges(holder.knowledge, peerHello.device_clock);
    let gapRetries = 0;
    // M-5: absolute cap on total pull iterations. A peer that keeps changing
    // its advertised ranges must not extend the loop forever; gapRetries
    // still bounds consecutive no-progress rounds on top of this.
    let pullIterations = 0;
    while (
      ranges.length > 0 &&
      gapRetries < 2 &&
      pullIterations < 10
    ) {
      pullIterations++;
      await transport.send({ v: 1, type: "CHANGES_REQUEST", ranges });
      stats.sent++;
      const batch = await expectBatchOrPeerRequest(nextMessage(transport), transport, stats);
      if (batch === null) break; // peer sent a request instead; serve loop follows
      applyBatch(batch.changes, stats);
      const before = JSON.stringify(ranges);
      ranges =
        batch.remaining_ranges ??
        neededRanges(holder.knowledge, peerHello.device_clock);
      if (JSON.stringify(ranges) === before) {
        gapRetries++; // unservable gap (compacted on peer): DC-09 Trigger A
        triggers.recordGapRound(peerKey);
      } else {
        gapRetries = 0;
        triggers.resetStreak(peerKey); // servable outcome resets (§3.1)
      }
    }

    // --- DC-09 §3 Trigger A: persistent unservable gaps -> FULL_STATE_OFFER
    // (the once-per-session-per-direction dedup of §3.5 applies) ---
    if (gapRetries > 0 && triggers.shouldOfferTriggerA(peerKey)) {
      const key = offerSessionKey(deps.selfDeviceId, peerKey, "OUTGOING");
      if (sessionDedup.shouldOffer(key, "GAP_ROUNDS")) {
        sessionDedup.markOffered(key);
        await emitFullStateOffer(transport, stats);
        await driveFullStateOffer(nextMessage(transport), transport, stats);
      }
    }

    // --- serve the peer's pull ---
    await serveRequests(nextMessage(transport), transport, peerHello.device_clock, stats);

    // --- ACK our applied frontier ---
    const ack: SyncMessage = {
      v: 1,
      type: "CHANGES_ACK",
      applied_upto: snapshotAppliedUpto(),
    };
    await transport.send(ack);
    stats.sent++;

    return stats;
  }

  async function serveRequests(
    nextMessage: (t: SyncTransport) => Promise<SyncMessage | null>,
    transport: SyncTransport,
    peerClock: VC,
    stats: SessionStats,
    /** stop when the queue is quiet for this many poll ticks */
    quietTicks = 2,
  ): Promise<void> {
    let quiet = 0;
    while (quiet < quietTicks) {
      const msg = await receiveWithTimeout(() => nextMessage(transport), 5);
      if (msg === null) {
        quiet++;
        continue;
      }
      quiet = 0;
      if (msg.type === "CHANGES_REQUEST") {
        const changes = fetchRanges(msg.ranges);
        for (let i = 0; i < changes.length; i += maxBatch) {
          const slice = changes.slice(i, i + maxBatch);
          await transport.send({
            v: 1,
            type: "CHANGES_BATCH",
            changes: slice,
          });
          stats.sent++;
        }
        if (changes.length === 0) {
          await transport.send({ v: 1, type: "CHANGES_BATCH", changes: [] });
          stats.sent++;
        }
      } else if (msg.type === "CHANGES_BATCH") {
        applyBatch(msg.changes, stats);
      } else if (msg.type === "FULL_STATE_OFFER") {
        await handleIncomingOffer(msg, () => nextMessage(transport), transport, stats);
      } else if (msg.type === "FULL_STATE_SNAPSHOT") {
        applyIncomingSnapshot(msg, stats);
      } else if (msg.type === "CHANGES_ACK") {
        mergeAckIntoLastKnownClock(msg.applied_upto);
      } else if (msg.type === "HELLO") {
        advancePeerKnowledge(msg.device_clock);
      } else if (msg.type === "REVOCATION_RECORDS") {
        await handleRevocationRecords(msg, transport, stats);
      } else if (msg.type === "REVOCATIONS_ACK") {
        handleRevocationsAck(msg);
      }
    }
  }

  /** Expect a CHANGES_BATCH; tolerate the interleaved peer request. */
  async function expectBatchOrPeerRequest(
    nextMessage: () => Promise<SyncMessage | null>,
    transport: SyncTransport,
    stats: SessionStats,
  ): Promise<Extract<SyncMessage, { type: "CHANGES_BATCH" }> | null> {
    const msg = await nextMessage();
    if (msg !== null && msg.type !== "CHANGES_BATCH") {
      // Interleaved peer traffic (e.g., their CHANGES_REQUEST): stash and
      // keep waiting for our batch.
      stashed.push(msg);
      return expectBatch(nextMessage, transport, stats);
    }
    if (msg === null) return null;
    return msg;
  }

  const stashed: SyncMessage[] = [];

  function drainStashed(): SyncMessage | null {
    return stashed.shift() ?? null;
  }

  async function expectBatch(
    nextMessage: () => Promise<SyncMessage | null>,
    transport: SyncTransport,
    stats: SessionStats,
  ): Promise<Extract<SyncMessage, { type: "CHANGES_BATCH" }> | null> {
    for (;;) {
      const msg = stashed.length > 0 ? drainStashed() : await nextMessage();
      if (msg === null) return null;
      if (msg.type === "CHANGES_BATCH" && msg.v === 1) return msg;
      // any other message type while pulling: handle inline
      if (msg.type === "CHANGES_REQUEST") {
        const changes = fetchRanges(msg.ranges);
        for (const sliceStart of chunk(changes, maxBatch)) {
          await transport.send({ v: 1, type: "CHANGES_BATCH", changes: sliceStart });
        }
        if (changes.length === 0) {
          await transport.send({ v: 1, type: "CHANGES_BATCH", changes: [] });
        }
      } else if (msg.type === "HELLO") {
        advancePeerKnowledge(msg.device_clock);
      } else if (msg.type === "CHANGES_ACK") {
        mergeAckIntoLastKnownClock(msg.applied_upto);
      } else if (msg.type === "FULL_STATE_OFFER") {
        await handleIncomingOffer(msg, nextMessage, transport, stats);
      } else if (msg.type === "FULL_STATE_SNAPSHOT") {
        applyIncomingSnapshot(msg, stats);
      } else if (msg.type === "REVOCATION_RECORDS") {
        await handleRevocationRecords(msg, transport, stats);
      } else if (msg.type === "REVOCATIONS_ACK") {
        handleRevocationsAck(msg);
      }
    }
  }

  // -------------------------------------------------------------------------
  // DC-10 revocation piggyback (§2.2 push, §2.5 ack bookkeeping, §3 acks)
  // -------------------------------------------------------------------------

  function revocations(): RevocationChannel | undefined {
    return deps.revocations;
  }

  /** Send every record queued for the current peer (AT-LEAST-ONCE, §3). */
  async function pushRevocationQueue(
    transport: SyncTransport,
    stats: SessionStats,
  ): Promise<void> {
    const ch = revocations();
    if (ch === undefined) return;
    const peer = deps.peerDeviceId ?? "unknown";
    const queued = ch.queueFor(peer);
    if (queued.length === 0) return; // nothing to send — no message at all
    await transport.send({
      v: 1,
      type: "REVOCATION_RECORDS",
      records: queued.map((s) => ({
        record: s.record,
        signature_hex: sigToHex(s.signature),
      })),
    });
    stats.sent++;
  }

  /**
   * Accept each inbound record (DC-05 §7.2 verify + store-once), then ACK
   * everything we hold in the same session (§3 delivery discipline).
   */
  async function handleRevocationRecords(
    msg: Extract<SyncMessage, { type: "REVOCATION_RECORDS" }>,
    transport: SyncTransport,
    stats: SessionStats,
  ): Promise<void> {
    const ch = revocations();
    if (ch === undefined) return;
    const peer = deps.peerDeviceId ?? "unknown";
    for (const wire of msg.records) {
      await ch.acceptInbound(
        { record: wire.record, signature: sigFromHex(wire.signature_hex) },
        peer,
      );
    }
    await transport.send({
      v: 1,
      type: "REVOCATIONS_ACK",
      accepted: ch.acceptedTriples(),
    });
    stats.sent++;
  }

  function handleRevocationsAck(
    msg: Extract<SyncMessage, { type: "REVOCATIONS_ACK" }>,
  ): void {
    const ch = revocations();
    if (ch === undefined) return;
    ch.recordAck(deps.peerDeviceId ?? "unknown", msg.accepted);
  }

  // -------------------------------------------------------------------------
  // DC-09 full-state offer/accept/snapshot handling (M-7 trigger layer)
  // -------------------------------------------------------------------------

  /** Emit a FULL_STATE_OFFER carrying our current device clock (DC-08 §3.6). */
  async function emitFullStateOffer(
    transport: SyncTransport,
    stats: SessionStats,
    userInitiated = false,
  ): Promise<void> {
    await transport.send({
      v: 1,
      type: "FULL_STATE_OFFER",
      snapshot_clock: getDeviceClockDb(),
      sender_device_id: deps.selfDeviceId,
      ...(userInitiated ? { user_initiated: true } : {}),
    });
    stats.sent++;
  }

  /**
   * DC-09 §4/§4.4: stream current semantic state as FULL_STATE_SNAPSHOT
   * messages under the batch bound; identical snapshot_clock throughout,
   * `final` marks stream end (no resume tokens in v1).
   */
  async function streamFullStateSnapshot(
    transport: SyncTransport,
    stats: SessionStats,
  ): Promise<void> {
    const chunks: Snapshot[] = [];
    buildSnapshot(deps.db, (s) => chunks.push(s));
    if (chunks.length === 0) {
      chunks.push({ snapshot_clock: getDeviceClockDb(), entities: [], tombstones: [] });
    }
    for (let i = 0; i < chunks.length; i++) {
      const chunkMsg = chunks[i]!;
      await transport.send({
        v: 1,
        type: "FULL_STATE_SNAPSHOT",
        snapshot_clock: chunkMsg.snapshot_clock,
        entities: chunkMsg.entities,
        tombstones: chunkMsg.tombstones,
        final: i === chunks.length - 1,
      });
      stats.sent++;
    }
  }

  /** DC-09 §5: apply a received snapshot through the transactional pipeline. */
  function applyIncomingSnapshot(
    msg: Extract<SyncMessage, { type: "FULL_STATE_SNAPSHOT" }>,
    stats: SessionStats,
  ): void {
    const result = applySnapshot(
      deps.db,
      {
        snapshot_clock: msg.snapshot_clock,
        entities: msg.entities,
        tombstones: msg.tombstones ?? [],
      },
      holder.knowledge,
    );
    stats.receivedApplied += result.appliedEntities;
  }

  /** Send FULL_STATE_ACCEPT and consume the winner's snapshot stream. */
  async function acceptOffer(
    offer: Extract<SyncMessage, { type: "FULL_STATE_OFFER" }>,
    getNext: () => Promise<SyncMessage | null>,
    transport: SyncTransport,
    stats: SessionStats,
  ): Promise<void> {
    await transport.send({
      v: 1,
      type: "FULL_STATE_ACCEPT",
      offer_snapshot_clock_digest: JSON.stringify(offer.snapshot_clock),
    });
    stats.sent++;
    await receiveAndApplySnapshots(getNext, stats);
  }

  /** After ACCEPT was sent (or won race as loser): consume snapshots. */
  async function receiveAndApplySnapshots(
    getNext: () => Promise<SyncMessage | null>,
    stats: SessionStats,
  ): Promise<void> {
    for (let poll = 0; poll < 20; poll++) {
      const msg = await receiveWithTimeout(getNext, 5);
      if (msg === null) return;
      if (msg.type === "FULL_STATE_SNAPSHOT") {
        applyIncomingSnapshot(msg, stats);
        if (msg.final) return;
        continue;
      }
      stashed.push(msg); // unrelated traffic stays in order for later loops
    }
  }

  /**
   * After emitting our offer: wait briefly for an ACCEPT or a rival offer.
   * A silent decline/ignore (§7.4) just times out and ends the attempt.
   */
  async function driveFullStateOffer(
    getNext: () => Promise<SyncMessage | null>,
    transport: SyncTransport,
    stats: SessionStats,
  ): Promise<void> {
    for (let poll = 0; poll < 10; poll++) {
      const msg = await receiveWithTimeout(getNext, 5);
      if (msg === null) return;
      if (msg.type === "FULL_STATE_ACCEPT") {
        await streamFullStateSnapshot(transport, stats);
        return;
      }
      if (msg.type === "FULL_STATE_OFFER") {
        if (resolveOfferRace(deps.selfDeviceId, msg.sender_device_id ?? "")) {
          continue; // §7.3: ours stands; theirs declined silently
        }
        await acceptOffer(msg, getNext, transport, stats); // defer to winner
        return;
      }
      stashed.push(msg);
    }
  }

  /**
   * DC-09 §7.3 simultaneous-offer resolution for a RECEIVED offer:
   * higher device_id wins — proceed with OUR offer (declining theirs
   * silently); the lower side defers and accepts the winner's snapshot.
   */
  async function handleIncomingOffer(
    offer: Extract<SyncMessage, { type: "FULL_STATE_OFFER" }>,
    getNext: () => Promise<SyncMessage | null>,
    transport: SyncTransport,
    stats: SessionStats,
  ): Promise<void> {
    const sender = offer.sender_device_id;
    if (sender !== undefined && resolveOfferRace(deps.selfDeviceId, sender)) {
      // Race victory: proceeding with our own offer is mandated by §7.3 and
      // bypasses session dedup (recorded so later automatic offers dedup).
      sessionDedup.markOffered(
        offerSessionKey(deps.selfDeviceId, sender, "OUTGOING"),
      );
      await emitFullStateOffer(transport, stats);
      await driveFullStateOffer(getNext, transport, stats);
      return;
    }
    // Lower device_id defers: accept theirs.
    await acceptOffer(offer, getNext, transport, stats);
  }

  function chunk<T>(arr: T[], size: number): T[][] {
    const out: T[][] = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
  }

  /**
   * H-4: poll the cached pending receive with a timeout race, but when the
   * timeout wins the pending promise is KEPT — the next call awaits the very
   * same promise, so a message that arrives late is delivered on a later
   * poll instead of being swallowed by Promise.race against receive().
   */
  async function receiveWithTimeout(
    nextMessage: () => Promise<SyncMessage | null>,
    maxPolls: number,
  ): Promise<SyncMessage | null> {
    for (let i = 0; i < maxPolls; i++) {
      const msg = await Promise.race([
        nextMessage(),
        new Promise<"timeout">((resolve) =>
          setTimeout(() => resolve("timeout"), 2),
        ),
      ]);
      if (msg !== "timeout") return msg;
    }
    return null;
  }

  function applyBatch(changes: ChangeRecord[], stats: SessionStats): void {
    for (const raw of changes) {
      let record: ChangeRecord;
      try {
        record = validateChangeRecord(raw);
      } catch (e) {
        // DC-04 §4.3: durable quarantine before dropping. Countable and
        // inspectable; the session keeps going (never blocking).
        quarantineRecord(deps.db, {
          reason:
            "invalid_change_record:" +
            (e instanceof Error ? e.message.slice(0, 120) : String(e).slice(0, 120)),
          senderDeviceId: deps.selfDeviceId,
          rawRecord: raw,
        });
        continue;
      }
      const outcome = applyRemoteChange(
        deps.db,
        record,
        holder.knowledge,
        deps.mutateEntity,
      );
      if (outcome === "applied") stats.receivedApplied++;
      else if (outcome === "buffered") stats.receivedBuffered++;
      else stats.receivedDuplicate++;
    }
  }

  function fetchRanges(
    ranges: Array<{ device_id: string; lo: number; hi: number }>,
  ): ChangeRecord[] {
    const out: ChangeRecord[] = [];
    const stmt = deps.db.prepare(`
      SELECT change_id, device_id, local_seq, entity_id, entity_type,
             field_path, operation, payload, hlc_timestamp, causality_clock,
             schema_version
      FROM changes WHERE device_id = ? AND local_seq >= ? AND local_seq <= ?
      ORDER BY local_seq`);
    for (const r of ranges) {
      const rows = stmt.all(r.device_id, r.lo, r.hi) as Array<Record<string, unknown>>;
      for (const row of rows) {
        out.push({
          ...(row as unknown as ChangeRecord),
          payload: JSON.parse(row.payload as string),
          causality_clock: JSON.parse(row.causality_clock as string),
        });
      }
    }
    return out;
  }

  function advancePeerKnowledge(peerClock: VC): void {
    advanceByMerge(holder.knowledge.peerAdvertised ?? (holder.knowledge.peerAdvertised = {}), peerClock);
  }

  function mergeAckIntoLastKnownClock(applied: Record<string, number>): void {
    advanceByMerge(
      holder.knowledge.peerAdvertised ?? (holder.knowledge.peerAdvertised = {}),
      applied,
    );
  }

  function snapshotAppliedUpto(): Record<string, number> {
    const rows = deps.db
      .prepare("SELECT producer_device_id AS d, applied_through AS a FROM applied_upto")
      .all() as Array<{ d: string; a: number }>;
    const out: Record<string, number> = {};
    for (const r of rows) out[r.d] = r.a;
    return out;
  }

  return { runSession };
}

function sameAs(a: { device_id: string }, b: { device_id: string }): boolean {
  return a.device_id === b.device_id;
}

async function expectType<T extends SyncMessage["type"]>(
  nextMessage: () => Promise<SyncMessage | null>,
  type: T,
): Promise<Extract<SyncMessage, { type: T }>> {
  const msg = await nextMessage();
  if (msg === null || msg.type !== type || (msg as { v?: number }).v !== 1) {
    throw new Error(`protocol violation: expected ${type}, got ${msg?.type ?? "closed"}`);
  }
  return msg as Extract<SyncMessage, { type: T }>;
}

/**
 * Rebuild in-memory knowledge state from persisted tables (F4 fix):
 * applied_upto rows restore the contiguous frontiers, pending_changes rows
 * restore buffered out-of-order seqs. Without this, a restart regenerates an
 * empty state and re-requests/over-applies records it already holds.
 */
export function loadKnowledgeFromDb(db: Database) {
  const k = emptyKnowledge();
  const upto = db
    .prepare(
      "SELECT producer_device_id AS d, applied_through AS a FROM applied_upto",
    )
    .all() as Array<{ d: string; a: number }>;
  for (const r of upto) k.appliedUpto[r.d] = r.a;
  const pend = db
    .prepare("SELECT device_id AS d, local_seq AS s FROM pending_changes")
    .all() as Array<{ d: string; s: number }>;
  for (const r of pend) {
    let set = k.pending.get(r.d);
    if (!set) {
      set = new Set<number>();
      k.pending.set(r.d, set);
    }
    set.add(r.s);
  }
  return k;
}

/** Fallback per-peer trigger key when no explicit peer id is configured. */
function derivePeerKey(clock: VC): string {
  const producers = Object.keys(clock).sort();
  return producers.length > 0 ? producers.join(",") : "unknown";
}
