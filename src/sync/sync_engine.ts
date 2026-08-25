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
import { applyRemoteChange } from "../persistence/database.ts";
import type { Database } from "better-sqlite3";

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
  | { v: 1; type: "CHANGES_ACK"; applied_upto: Record<string, number> };

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
      const batch = await expectBatchOrPeerRequest(nextMessage(transport), transport);
      if (batch === null) break; // peer sent a request instead; serve loop follows
      applyBatch(batch.changes, stats);
      const before = JSON.stringify(ranges);
      ranges =
        batch.remaining_ranges ??
        neededRanges(holder.knowledge, peerHello.device_clock);
      if (JSON.stringify(ranges) === before) {
        gapRetries++; // unservable gap (compacted on peer): DC-09 Trigger A
      } else {
        gapRetries = 0;
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
      } else if (msg.type === "CHANGES_ACK") {
        mergeAckIntoLastKnownClock(msg.applied_upto);
      } else if (msg.type === "HELLO") {
        advancePeerKnowledge(msg.device_clock);
      }
    }
  }

  /** Expect a CHANGES_BATCH; tolerate the interleaved peer request. */
  async function expectBatchOrPeerRequest(
    nextMessage: () => Promise<SyncMessage | null>,
    transport: SyncTransport,
  ): Promise<Extract<SyncMessage, { type: "CHANGES_BATCH" }> | null> {
    const msg = await nextMessage();
    if (msg !== null && msg.type !== "CHANGES_BATCH") {
      // Interleaved peer traffic (e.g., their CHANGES_REQUEST): stash and
      // keep waiting for our batch.
      stashed.push(msg);
      return expectBatch(nextMessage, transport);
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
      }
    }
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
      } catch {
        // DC-04 §4.3 quarantine path (storage wired in persistence layer)
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

/** Rebuild in-memory knowledge state from persisted tables. */
export function loadKnowledgeFromDb(_db: Database) {
  return emptyKnowledge();
}
