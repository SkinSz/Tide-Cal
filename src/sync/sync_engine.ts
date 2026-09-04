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
import {
  applyRemoteChange,
  quarantineRecord,
  markSeqSkipped,
  isSeqSkipped,
  isHardBlocked,
  hardBlockProducer,
  appendInvalidTally,
  reconcileQuarantineResolutions,
  // TD-005 remainder (TD-008): silent resolved-row retention cap at startup.
  pruneResolvedQuarantine,
  markQuarantineResolved,
} from "../persistence/database.ts";
// TD-006 / DC-16: two-tier peer misbehavior handling (Tier-1 in-memory
// ladder + Tier-2 durable hard block via hardBlockProducer).
import {
  PeerMisbehaviorTracker,
  DEFAULT_MISBEHAVIOR_CONFIG,
} from "./misbehavior.ts";
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

/**
 * Pkg4 (QA M-3 / QA-1 F3, correlated BND-08): bounded per-message idle
 * timeout for the sync session's blocking receive points.
 *
 * SEMANTICS (deliberate, documented):
 *   - WHAT is timed: per-MESSAGE IDLE, not whole-session. The clock restarts
 *     on every received message, so a slow-but-alive peer that is actively
 *     transferring (e.g. a 60k-change migration batch arriving as ~235
 *     CHANGES_BATCH messages) can never false-time out, no matter how long
 *     the whole session runs.
 *   - VALUE (15s): the QA migration tests ran 60k changes over loopback at
 *     batch=256 (~235 batches); healthy per-message gaps there are
 *     milliseconds — three orders of magnitude below this bound — while a
 *     genuinely stalled/dead peer (laptop sleep, power loss, NAT timeout:
 *     no FIN, no data) is detected within 15s worst case. Consistent with
 *     the campaign's REQUEST_TIMEOUT (15s) convention; no literal constant
 *     of that name existed in the tree, so this is its canonical home.
 *   - TERMINATION: the initiator throws SyncIdleTimeoutError out of
 *     runSession. Applied batches stay committed (each batch is applied in
 *     its own transaction and is idempotent by change_id — nothing to roll
 *     back); unapplied ranges are simply not requested again this session.
 *   - RETRY: always safe. Sync is idempotent by change_id; the next sync
 *     recomputes neededRanges from knowledge state and re-requests exactly
 *     what is missing (applied_upto never regresses — it only advances
 *     transactionally per batch).
 *   - CALLER: the sidecar's sync_now surfaces the error as a deterministic
 *     ok:false ("sync session timed out waiting for peer ...") — it returns,
 *     never hangs, in every peer-failure mode (stall, power loss, FIN close,
 *     unroutable host — the last bounded separately by the sync_now connect
 *     watchdog in sidecar_server.ts).
 */
export const SYNC_IDLE_TIMEOUT_MS = 15_000;

/**
 * TD-020: bounded post-ACK drain length, in receiveWithTimeout polls.
 * Sibling messages (REVOCATIONS_ACK, late CHANGES_BATCH) sitting behind the
 * peer's CHANGES_ACK terminator are processed before the barrier exits; this
 * many consecutive quiet polls ends the drain. A poll-count bound (not a
 * time value): the idle/idle-bound semantics are untouched.
 */
const DRAIN_POST_ACK_POLLS = 10;

/** Sentinel for "the idle window elapsed" — distinct from null (peer closed). */
const IDLE_TICK = Symbol("pkg4-idle-timeout");

/**
 * Deterministic timeout failure for a stalled/dead peer. The message is
 * stable: it is the string sync_now callers see as ok:false error.
 */
export class SyncIdleTimeoutError extends Error {
  constructor(
    /** Which protocol point went idle (e.g. "HELLO", "pull/CHANGES_BATCH"). */
    readonly phase: string,
    readonly idleMs: number,
  ) {
    super(
      `sync session timed out waiting for peer (no message for ${idleMs}ms in ${phase})`,
    );
    this.name = "SyncIdleTimeoutError";
  }
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
       * Pkg1 (QA C-1): set when the offer is a DC-09 §3 Trigger A distress
       * signal (persistent unservable gaps). The receiver answers with its
       * own offer (a data request), never with the §7.3 device-id race —
       * the gapped side must RECEIVE full state, and when the gapped side
       * wins the id race it otherwise streams its own (useless) snapshot
       * instead, stranding the gap forever.
       */
      reason?: "GAP_ROUNDS";
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
  /**
   * TD-020: optional deterministic end-of-session signal. runSession invokes
   * this in a finally once the session is over so the PEER side's pending
   * receive resolves as clean EOF (null) instead of parking on an idle
   * bound. Implementations close the LOCAL inbound path and propagate EOF to
   * the peer per the carrier's semantics (FIN on TCP, waiter release on
   * in-memory pipes). Optional: test doubles without it are unaffected.
   */
  close?(): void;
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
  /**
   * TD-006 / DC-16: per-peer misbehavior tracker (Tier-1 in-memory ladder).
   * Shared instance across sessions keeps ladder state alive process-wide;
   * a fresh engine without one gets its own (in-memory fails OPEN either
   * way — restart always clears Tier-1 state, DC-16 §2.3).
   */
  misbehavior?: PeerMisbehaviorTracker;
  /**
   * Pkg4 (QA M-3): per-message idle bound in ms for the initiator's blocking
   * receive points (HELLO wait, pull-phase batch wait). Defaults to
   * SYNC_IDLE_TIMEOUT_MS (15s). Idle resets on EVERY received message, so
   * any value generous vs. per-message latency is safe for arbitrarily
   * large transfers. Tests inject small values (e.g. 300) for speed.
   */
  idleTimeoutMs?: number;
}

export interface SyncEngine {
  runSession(transport: SyncTransport): Promise<SessionStats>;
}

export interface SessionStats {
  sent: number;
  receivedApplied: number;
  receivedBuffered: number;
  receivedDuplicate: number;
  /** TD-001: records durably quarantined (outcome class is exclusive). */
  receivedQuarantined: number;
  /**
   * TD-006 / DC-16 §3: records dropped AT INTAKE while that producer was
   * throttled/suspended (one aggregated counter — no quarantine rows, skip
   * entries, or UI entries per packet). Hard-block drops are NOT counted
   * here (they cost nothing and are visible via the hard_blocks row).
   */
  receivedDroppedIntake: number;
  /**
   * Pkg6 (item 8): true when this session's HELLO carried the DC-02 §4.1
   * "impossible under honest operation" anomaly — the peer advertised a
   * clock component for OUR device id greater than our own (identity theft
   * or non-conformant same-id restore). Health cue only; also logged and
   * counted (getHelloClockAnomalyCount).
   */
  helloClockAnomaly?: boolean;
}

/**
 * Pkg6 (item 8, pkg5b-review §3/§6-A recommendation): process-lifetime count
 * of HELLO clock anomalies (see noteHelloClockAnomaly). A health cue for
 * operators/diagnostics — NOT enforcement (DC-16 v1: the misbehavior ladder
 * is deliberately not fed; a warning log accompanies every increment).
 */
let helloClockAnomalyCount = 0;

export function getHelloClockAnomalyCount(): number {
  return helloClockAnomalyCount;
}

interface KnowledgeHolder {
  knowledge: NonNullable<SyncEngineDeps["knowledge"]> & {
    /** lastKnownClock(peer): what each peer has advertised/ACKed (DC-06 §2.1) */
    peerAdvertised?: Record<string, number>;
  };
}

export function createSyncEngine(deps: SyncEngineDeps): SyncEngine {
  const knowledge = deps.knowledge ?? loadKnowledgeFromDb(deps.db);
  // TD-001 (6): restart-time revalidation — every durable quarantine row is
  // re-checked against current state; now-valid records apply idempotently
  // (skip row removed, frontier may advance); still-invalid ones remain
  // quarantined with their skip row. Validation is NOT weakened.
  revalidateQuarantine(deps.db, deps.mutateEntity, knowledge);
  // TD-005 hook (one line, per integration note): after a revalidation pass
  // that applied formerly-quarantined records, mark those rows resolved.
  reconcileQuarantineResolutions(deps.db);
  // TD-008 closure: resolved-row retention cap (keep newest 1,000). Silent
  // by design — resolved rows are non-actionable. Also re-run after each new
  // resolution (retryQuarantineRecord / reconcile paths call prune at the
  // engine boundary; see sidecar retry_quarantine op). Active rows are
  // NEVER pruned.
  pruneResolvedQuarantine(deps.db);
  const holder: KnowledgeHolder = { knowledge };
  const maxBatch = deps.maxBatchRecords ?? 256;
  // Pkg4 (QA M-3): per-message idle bound (see SYNC_IDLE_TIMEOUT_MS docs).
  const idleTimeoutMs = deps.idleTimeoutMs ?? SYNC_IDLE_TIMEOUT_MS;
  // DC-09 §3 trigger bookkeeping; streaks are per peer/direction. Session
  // start resets the Trigger-A streak (§3.1); dedup is per-session (§3.5).
  const triggers = deps.triggers ?? new TriggerStateTracker();
  let sessionDedup = new OfferDedup();
  // TD-006 / DC-16: Tier-1 tracker (in-memory, fails OPEN). The Tier-2 hard
  // block is written durably through the onHardBlock hook; the intake gate
  // re-checks the DURABLE row on every record so a hard block applies
  // instantly from any ladder level and survives restarts.
  const misbehavior =
    deps.misbehavior ??
    new PeerMisbehaviorTracker(DEFAULT_MISBEHAVIOR_CONFIG, Date.now);
  // The durable Tier-2 write ALWAYS goes through this engine's database,
  // including for an injected tracker (hook is attached, not replaced).
  misbehavior.onHardBlock = (p) => hardBlockProducer(deps.db, p);
  // Pkg6 (QA-1 F-6): drain zombie pending rows left by an aborted session
  // (frontier already past them) BEFORE the engine's knowledge is first used.
  gcZombiePending();

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

  /**
   * Pkg4 (QA M-3): bounded receive for the session's BLOCKING await points —
   * the peer HELLO wait and the pull-phase CHANGES_BATCH wait. Races the
   * (H-4-cached) receive against ONE idle window of idleTimeoutMs.
   *
   *   - A received message resets the idle clock by definition: the window
   *     is per wait, so an actively progressing transfer never trips it.
   *   - null (peer closed cleanly) is returned as-is — existing null
   *     handling (break/return) is unchanged and remains deterministic.
   *   - On idle expiry we throw SyncIdleTimeoutError: the session terminates
   *     deterministically, applied batches stay committed, and the caller
   *     (sync_now) gets a deterministic error instead of hanging forever.
   *   - The abandoned pending receive gets a no-op catch so a late
   *     rejection (transport teardown) can never surface as an
   *     unhandledRejection after the session has terminated.
   */
  async function receiveIdleBounded(
    getNext: () => Promise<SyncMessage | null>,
    phase: string,
  ): Promise<SyncMessage | null> {
    const pending = getNext();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const idle = new Promise<typeof IDLE_TICK>((resolve) => {
      timer = setTimeout(() => resolve(IDLE_TICK), idleTimeoutMs);
    });
    let msg: SyncMessage | null | typeof IDLE_TICK;
    try {
      msg = await Promise.race([pending, idle]);
    } catch (e) {
      clearTimeout(timer);
      throw e;
    }
    clearTimeout(timer);
    if (msg === IDLE_TICK) {
      void pending.catch(() => {}); // late transport failure: not ours anymore
      throw new SyncIdleTimeoutError(phase, idleTimeoutMs);
    }
    return msg;
  }

  /**
   * Pkg6 (QA-1 F-6): zombie pending_changes GC. A pending row whose seq is
   * at/below the producer's durable applied_upto frontier can NEVER be
   * drained (drain only fires while the frontier advances through it; any
   * re-delivery at/below the frontier classifies as duplicate, and the
   * snapshot path's F3 cleanup covers only that one path) — a session
   * aborted mid-transfer leaves such zombies behind forever, polluting
   * post-restart knowledge. Delete every pending row at/below its producer
   * frontier; rows ABOVE the frontier (legitimately buffered, gap still
   * open) and rows for producers with no frontier row are untouched. The
   * in-memory knowledge mirror is refreshed from the DB only when something
   * was actually deleted. Runs at engine construction (covers the
   * abort-then-restart case) and at each session start (covers long-lived
   * engine instances whose frontier advanced past a buffered seq mid-life,
   * e.g. via snapshot application).
   */
  function gcZombiePending(): void {
    const res = deps.db
      .prepare(
        `DELETE FROM pending_changes WHERE (device_id, local_seq) IN (
           SELECT p.device_id, p.local_seq FROM pending_changes p
           JOIN applied_upto a ON a.producer_device_id = p.device_id
           WHERE p.local_seq <= a.applied_through)`,
      )
      .run();
    if (res.changes === 0) return;
    // Mirror the durable GC onto the caller-visible knowledge object.
    const fresh = loadKnowledgeFromDb(deps.db);
    holder.knowledge.pending = fresh.pending;
  }

  function getDeviceClockDb(): VC {
    const rows = deps.db
      .prepare("SELECT peer_device_id AS d, max_seq AS s FROM device_clock")
      .all() as Array<{ d: string; s: number }>;
    const clock: VC = {};
    for (const r of rows) clock[r.d] = r.s;
    return clock;
  }

  /**
   * Pkg6 (item 8, pkg5b-review §3/§6-A recommendation): HELLO clock-anomaly
   * signal. A peer advertising a clock component for OUR device id GREATER
   * than our own device_clock[self] is impossible under honest operation:
   * only our own T1 writes advance device_clock[self], so no honest peer can
   * know a higher self seq than we produced (DC-02 §4.1). Seeing one means
   * identity theft (another device operating under our id) or a
   * non-conformant raw same-id backup-restore (DC-05 §2.2 / DC-02 §4.3:
   * restore = new identity). v1 disposition per pkg5b-review: log a warning
   * + count it (getHelloClockAnomalyCount) + flag the session stats. This is
   * a HEALTH CUE ONLY, not enforcement: the misbehavior ladder is
   * deliberately NOT fed (an anomalous HELLO is not a record arrival), no
   * clock merge is skipped (the element-wise MAX merge makes inflation
   * harmless — pkg5b-review §4.3), and no session is terminated.
   */
  function noteHelloClockAnomaly(
    peerClock: VC,
    peerKey: string,
    stats: SessionStats,
  ): void {
    const advertised = peerClock[deps.selfDeviceId];
    if (typeof advertised !== "number" || !Number.isFinite(advertised)) return;
    const own = getDeviceClockDb()[deps.selfDeviceId] ?? 0;
    if (advertised <= own) return;
    helloClockAnomalyCount++;
    stats.helloClockAnomaly = true;
    console.warn(
      `[tide][health] HELLO clock anomaly: peer session (${peerKey}) ` +
        `advertises device_clock[${deps.selfDeviceId}] = ${advertised} > ` +
        `our own ${own}. Impossible under honest operation (DC-02 §4.1) — ` +
        `indicates identity theft or a non-conformant same-id restore. ` +
        `Health cue only; no enforcement action taken (DC-16 v1).`,
    );
  }

  function mergeDeviceClock(db: Database, clock: Record<string, number>): void {
    const upsert = db.prepare(`
      INSERT INTO device_clock (peer_device_id, max_seq) VALUES (?, ?)
      ON CONFLICT(peer_device_id) DO UPDATE SET
        max_seq = MAX(max_seq, excluded.max_seq)`);
    for (const [d, s] of Object.entries(clock)) upsert.run(d, s);
  }

  /**
   * Pkg5b (QA M-4 companion): seed the durable knowledge state with the
   * device's OWN contiguous frontier (applied_upto[self] = max own local_seq
   * across `changes` and `device_clock` — the same allocation rule T1 uses).
   *
   * A device has, by definition, applied every record it produced at T1
   * (the T1 transaction wrote both), so this is truthful knowledge, not a
   * shortcut. Before Pkg5b the value existed only by ACCIDENT: the
   * every-session Trigger A snapshot exchange merged snapshot_clock (which
   * contains self) into applied_upto. Fixing the trigger (neededRanges
   * excluding self) removed that accident, and T2 then misclassified
   * re-delivery of the device's OWN records (a peer echoing them back) as
   * buffer/apply instead of duplicate — qa5 probe P3 caught it. Seeding at
   * session start restores the correct dedup classification durably (T2
   * reloads knowledge from the DB inside its transaction) without a schema
   * or persistence-layer change. MAX-merge keeps it monotone with T2.
   */
  function seedSelfAppliedFrontier(): void {
    const row = deps.db
      .prepare<[string, string], { m: number | null }>(
        `SELECT MAX(s) AS m FROM (
           SELECT MAX(local_seq) AS s FROM changes WHERE device_id = ?
           UNION ALL
           SELECT (SELECT max_seq FROM device_clock WHERE peer_device_id = ?)
         )`,
      )
      .get(deps.selfDeviceId, deps.selfDeviceId);
    const frontier = row?.m ?? 0;
    if (!Number.isFinite(frontier) || frontier <= 0) return;
    deps.db
      .prepare(
        `INSERT INTO applied_upto (producer_device_id, applied_through) VALUES (?, ?)
         ON CONFLICT(producer_device_id) DO UPDATE SET
           applied_through = MAX(applied_through, excluded.applied_through)`,
      )
      .run(deps.selfDeviceId, frontier);
    if ((holder.knowledge.appliedUpto[deps.selfDeviceId] ?? 0) < frontier) {
      holder.knowledge.appliedUpto[deps.selfDeviceId] = frontier;
    }
  }

  async function runSession(transport: SyncTransport): Promise<SessionStats> {
    const stats: SessionStats = {
      sent: 0,
      receivedApplied: 0,
      receivedBuffered: 0,
      receivedDuplicate: 0,
      receivedQuarantined: 0,
      receivedDroppedIntake: 0,
    };
    // DC-09 §3.5: offers_made_this_session is in-memory only; a new session
    // gets fresh dedup state.
    sessionDedup = new OfferDedup();
    // Pkg7 review (finding 1, sev 4): the stash is engine-scoped and must be
    // per-session too. A stale stashed CHANGES_ACK from session N-1 would be
    // consumed by the new stash-first barrier consult and satisfy the
    // session-end terminator before the real peer ACK arrives (closing the
    // transport on a phantom ACK). Same root as TD-019 F3; fixed here.
    stashed.length = 0;
    // Pkg5b: truthful self-frontier seeding BEFORE the pull loop (see doc).
    seedSelfAppliedFrontier();
    // Pkg6 (QA-1 F-6): same GC for long-lived engine instances — a frontier
    // that advanced past a buffered seq mid-life (e.g. snapshot application)
    // must not leave the zombie behind until the next restart.
    gcZombiePending();

    // --- HELLO exchange ---
    const hello: SyncMessage = {
      v: 1,
      type: "HELLO",
      device_clock: getDeviceClockDb(),
    };
    await transport.send(hello);
    stats.sent++;

    // Pkg4 (QA M-3): bounded — a peer that never answers HELLO (silent
    // accept, half-open TCP) terminates the session deterministically.
    const peerHello = await expectType(
      () => receiveIdleBounded(nextMessage(transport), "HELLO"),
      "HELLO",
    );
    advancePeerKnowledge(peerHello.device_clock);
    // Stable key for per-peer trigger state (§3.1: streaks are per-peer,
    // per-direction). Prefer the configured peer id; fall back to the
    // advertised clock's producer set.
    const peerKey =
      deps.peerDeviceId ?? derivePeerKey(peerHello.device_clock);
    triggers.resetStreak(peerKey); // §3.1: streak resets at session start
    // Pkg6 (item 8): DC-02 §4.1 impossibility signal — health cue, not
    // enforcement (see noteHelloClockAnomaly doc).
    noteHelloClockAnomaly(peerHello.device_clock, peerKey, stats);

    // --- DC-10 §2.2: push our full revocation queue for this peer ---
    await pushRevocationQueue(transport, stats);

    // --- pull what we need ---
    // Pkg5b (QA M-4): exclude self-produced sequences — our own seqs are
    // local by definition, and requesting them back left the range
    // permanently unservable-by-advancement, firing Trigger A on every
    // session between converged peers (see neededRanges doc).
    let ranges = neededRanges(holder.knowledge, peerHello.device_clock, deps.selfDeviceId);
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
        neededRanges(holder.knowledge, peerHello.device_clock, deps.selfDeviceId);
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
        // Pkg1: marked GAP_ROUNDS — the receiver answers with its full
        // state instead of racing, and we accept a rival offer instead of
        // streaming our own (the gap is on OUR side; we need THEIR data).
        await emitFullStateOffer(transport, stats, false, "GAP_ROUNDS");
        await driveFullStateOffer(nextMessage(transport), transport, stats, true);
      }
    }

    // --- ACK our applied frontier ---
    // DC-08 amendment (root-cause doc 2026-08-31): CHANGES_ACK is the
    // BIDIRECTIONAL SESSION-END BARRIER. Each side sends its own ACK
    // immediately after its pull completes, then keeps serving until it
    // receives the peer's ACK (or a clean EOF). This joins the two engine
    // runs' lifetimes: a responder with nothing to pull can no longer tear
    // down the shared session inside the initiator's HELLO/pull setup
    // window, because it still owes the session its post-ACK serve phase.
    const ack: SyncMessage = {
      v: 1,
      type: "CHANGES_ACK",
      applied_upto: snapshotAppliedUpto(),
    };
    await transport.send(ack);
    stats.sent++;

    // --- serve the peer's pull until the peer's session-end ACK / EOF ---
    try {
      await serveRequests(nextMessage(transport), transport, peerHello.device_clock, stats, 2, true);
    } finally {
      // TD-020: deterministic end-of-session EOF. runSession never closed
      // the transport, so a side that finishes its barrier (peer ACK seen,
      // or EOF) left its PEER parked in receiveIdleBounded for the full
      // idle bound on transports without FIN propagation (in-memory pipes).
      // Signalling close here makes session end deterministic on every
      // transport shape. Never throws over session results; close() on an
      // already-dead session is a no-op by contract.
      try {
        transport.close?.();
      } catch {
        /* close must never mask the session's own outcome */
      }
    }

    return stats;
  }

  async function serveRequests(
    nextMessage: (t: SyncTransport) => Promise<SyncMessage | null>,
    transport: SyncTransport,
    peerClock: VC,
    stats: SessionStats,
    /** stop when the queue is quiet for this many poll ticks */
    quietTicks = 2,
    /**
     * DC-08 amendment (root-cause doc 2026-08-31): session-end barrier mode.
     * Our own CHANGES_ACK has already been sent; keep serving the peer's
     * pull until (a) the peer's CHANGES_ACK arrives — the joint terminator,
     * or (b) a clean EOF (peer closed). Uses the Pkg4 idle bound so a peer
     * that neither ACKs nor closes still terminates deterministically
     * (SyncIdleTimeoutError) instead of hanging. No timeout value is
     * changed: the barrier reuses SYNC_IDLE_TIMEOUT_MS as designed.
     *
     * TD-020 (TRP-1/TRP-4b regression): on CHANGES_ACK the barrier no longer
     * returns immediately. A REVOCATIONS_ACK or a late CHANGES_BATCH may sit
     * in the same pipe behind the terminator; exiting at first sight of the
     * ACK stranded those siblings (A's revocation queue never drained — got
     * 1, want 0). Instead the barrier performs a BOUNDED post-ACK drain
     * using the pre-existing receiveWithTimeout poll helper (no timeout
     * value changes, no arbitrary timeout workarounds). Deterministic: after `drainPolls` quiet
     * polls the drain returns regardless. INVARIANT 14 holds — duplicated
     * or reordered siblings are idempotent (recordAck / duplicate-apply are
     * byte-level no-ops), so draining a little or a lot is safe.
     */
    untilPeerAck = false,
  ): Promise<void> {
    let quiet = 0;
    while (quiet < quietTicks) {
      // TD-020: consult the session stash FIRST — traffic stashed by the
      // offer-exchange helpers (receiveAndApplySnapshots, driveFullStateOffer)
      // is invisible to transport.receive() but must still be processed here;
      // a stashed CHANGES_ACK used to be missed and the barrier hung on the
      // idle bound waiting for a terminator that had already arrived.
      const stashedMsg = drainStashed();
      if (stashedMsg !== null) {
        const ended = await handleBarrierMessage(
          stashedMsg, transport, stats, nextMessage, untilPeerAck,
        );
        if (ended) return;
        quiet = 0;
        continue;
      }
      const msg = untilPeerAck
        ? await receiveIdleBounded(() => nextMessage(transport), "serve/barrier")
        : await receiveWithTimeout(() => nextMessage(transport), 5);
      if (msg === null) {
        if (untilPeerAck) return; // clean EOF: peer closed after its ACK
        quiet++;
        continue;
      }
      quiet = 0;
      const ended = await handleBarrierMessage(
        msg, transport, stats, nextMessage, untilPeerAck,
      );
      if (ended) return;
    }
  }

  /**
   * TD-020: dispatch one message inside the barrier serve loop. Returns true
   * when the barrier has satisfied its terminator condition AND its bounded
   * post-ACK drain completed (barrier mode only).
   */
  async function handleBarrierMessage(
    msg: SyncMessage,
    transport: SyncTransport,
    stats: SessionStats,
    nextMessage: (t: SyncTransport) => Promise<SyncMessage | null>,
    barrierMode: boolean,
  ): Promise<boolean> {
    switch (msg.type) {
      case "CHANGES_REQUEST": {
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
        return false;
      }
      case "CHANGES_BATCH":
        applyBatch(msg.changes, stats);
        return false;
      case "FULL_STATE_OFFER":
        await handleIncomingOffer(msg, () => nextMessage(transport), transport, stats);
        return false;
      case "FULL_STATE_SNAPSHOT":
        applyIncomingSnapshot(msg, stats);
        return false;
      case "CHANGES_ACK":
        mergeAckIntoLastKnownClock(msg.applied_upto);
        if (barrierMode) {
          // TD-020: joint terminator seen — drain what remains (bounded)
          // so siblings (REVOCATIONS_ACK, late batches) are not stranded.
          await drainPostAck(nextMessage, transport, stats);
          return true;
        }
        return false;
      case "HELLO":
        advancePeerKnowledge(msg.device_clock);
        return false;
      case "REVOCATION_RECORDS":
        await handleRevocationRecords(msg, transport, stats);
        return false;
      case "REVOCATIONS_ACK":
        handleRevocationsAck(msg);
        return false;
      default:
        return false;
    }
  }

  /**
   * TD-020: bounded post-ACK drain. Processes whatever the peer sent behind
   * its terminator — sibling acks, late batches — until `drainPolls` quiet
   * polls elapse. Uses receiveWithTimeout's poll shape (the same helper the
   * GAP_ROUNDS exchange already uses); NO timeout value is changed and
   * nothing here can hang: the loop always terminates.
   */
  async function drainPostAck(
    nextMessage: (t: SyncTransport) => Promise<SyncMessage | null>,
    transport: SyncTransport,
    stats: SessionStats,
  ): Promise<void> {
    for (let poll = 0; poll < DRAIN_POST_ACK_POLLS; poll++) {
      const msg = await receiveWithTimeout(() => nextMessage(transport), 5);
      if (msg === null) return; // EOF: nothing further can arrive
      if (msg.type === "CHANGES_REQUEST") {
        const changes = fetchRanges(msg.ranges);
        for (let i = 0; i < changes.length; i += maxBatch) {
          await transport.send({ v: 1, type: "CHANGES_BATCH", changes: changes.slice(i, i + maxBatch) });
          stats.sent++; // Pkg7 review (finding 5): per-batch, like serveRequests
        }
        if (changes.length === 0) {
          await transport.send({ v: 1, type: "CHANGES_BATCH", changes: [] });
          stats.sent++;
        }
      } else if (msg.type === "CHANGES_BATCH") {
        applyBatch(msg.changes, stats);
      } else if (msg.type === "CHANGES_ACK") {
        mergeAckIntoLastKnownClock(msg.applied_upto); // duplicate terminator: no-op
      } else if (msg.type === "HELLO") {
        advancePeerKnowledge(msg.device_clock);
      } else if (msg.type === "REVOCATION_RECORDS") {
        await handleRevocationRecords(msg, transport, stats);
      } else if (msg.type === "REVOCATIONS_ACK") {
        handleRevocationsAck(msg); // THE stranded-sibling case TRP-1/4b caught
      } else if (msg.type === "FULL_STATE_SNAPSHOT") {
        applyIncomingSnapshot(msg, stats);
      } else if (msg.type === "FULL_STATE_OFFER") {
        // Pkg7 review (finding 4): the barrier exits immediately after the
        // drain, so stashing here would strand the offer until a LATER
        // session (the earlier comment overstated safety). Ignoring it is
        // safe by design: a dropped offer is re-triggered next session by
        // the same persistent-gap detection (DC-09 Trigger A), and INVARIANT
        // 14 makes the redelivery harmless.
      }
    }
  }

  /** Expect a CHANGES_BATCH; tolerate the interleaved peer request. */
  async function expectBatchOrPeerRequest(
    nextMessage: () => Promise<SyncMessage | null>,
    transport: SyncTransport,
    stats: SessionStats,
  ): Promise<Extract<SyncMessage, { type: "CHANGES_BATCH" }> | null> {
    // Pkg4 (QA M-3): bounded — this is THE defect point. After soliciting
    // CHANGES_REQUEST the initiator used to await the next message with no
    // timeout at all: a responder that stalls or dies without FIN (laptop
    // sleep, power loss, NAT timeout) hung runSession — and therefore
    // sync_now — forever. Now one idle window bounds the wait.
    const msg = await receiveIdleBounded(nextMessage, "pull/CHANGES_BATCH");
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
      // Pkg4 (QA M-3): bounded — the multi-round pull path (interleaved peer
      // traffic lands here too) must never block without an idle bound.
      const msg =
        stashed.length > 0
          ? drainStashed()
          : await receiveIdleBounded(nextMessage, "pull/CHANGES_BATCH");
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
    reason?: "GAP_ROUNDS",
  ): Promise<void> {
    await transport.send({
      v: 1,
      type: "FULL_STATE_OFFER",
      snapshot_clock: getDeviceClockDb(),
      sender_device_id: deps.selfDeviceId,
      ...(userInitiated ? { user_initiated: true } : {}),
      ...(reason ? { reason } : {}),
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
    ourOfferGapTriggered = false,
  ): Promise<void> {
    for (let poll = 0; poll < 10; poll++) {
      const msg = await receiveWithTimeout(getNext, 5);
      if (msg === null) return;
      if (msg.type === "FULL_STATE_ACCEPT") {
        await streamFullStateSnapshot(transport, stats);
        return;
      }
      if (msg.type === "FULL_STATE_OFFER") {
        // Pkg1 (QA C-1): our offer was a Trigger A distress signal — we have
        // persistent unservable gaps and need the PEER's full state. The
        // §7.3 device-id race must not stand between us and the data: when
        // the gapped side wins the race it would stream its own (useless)
        // snapshot and the gap strands forever. Accept the rival's offer.
        if (ourOfferGapTriggered) {
          await acceptOffer(msg, getNext, transport, stats);
          return;
        }
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
    // Pkg1 (QA C-1): a Trigger A (GAP_ROUNDS) offer is a request for OUR
    // full state, not a competing data offer. Answer with our own offer so
    // the gapped sender accepts and receives it — running the §7.3 race
    // here would let the id ordering decide whether the gap can ever close.
    if (offer.reason === "GAP_ROUNDS") {
      const key = offerSessionKey(deps.selfDeviceId, offer.sender_device_id ?? "", "OUTGOING");
      if (sessionDedup.shouldOffer(key, "GAP_ROUNDS")) {
        sessionDedup.markOffered(key);
        await emitFullStateOffer(transport, stats);
        await driveFullStateOffer(getNext, transport, stats);
        return;
      }
      // Already offered this session: fall through to race handling.
    }
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
      // TD-006 / DC-16 §2.1: per-PRODUCER key from the batch envelope's
      // record itself (cheap field read — no JSON parse / validation yet).
      const rawDevice: unknown = (raw as { device_id?: unknown } | null)
        ?.device_id;
      const producer: string =
        typeof rawDevice === "string" && rawDevice.length > 0
          ? rawDevice
          : (deps.peerDeviceId ?? "unknown");

      // --- TD-006 Tier 2 (durable): hard block drops EVERYTHING from this
      // producer BEFORE validation/parsing — bounded storage, near-zero
      // cost; nothing is quarantined, skipped, or listed while blocked.
      // Requests FROM the peer are still answered (serveRequests is
      // untouched; this gate is receive-of-data only).
      if (isHardBlocked(deps.db, producer)) continue;

      // --- TD-006 Tier 1 Level 2/3 (in-memory): throttle/suspend intake
      // drop. No quarantine rows, no skip entries, no per-packet UI
      // entries — one aggregated drop counter. Dropped arrivals still feed
      // the Tier-2 flood window (burst resistance, evaluated on ARRIVAL).
      if (misbehavior.isIntakeDropped(producer)) {
        misbehavior.recordDropped(producer);
        stats.receivedDroppedIntake++;
        continue;
      }

      // TD-001 (7): a seq that already carries a skip row is a duplicate
      // re-delivery of a previously quarantined record — drop silently and
      // merge clocks (DC-02 §7.1); never create a second quarantine row.
      const rawProducer = (raw as { device_id?: unknown } | null)?.device_id;
      const rawSeq = (raw as { local_seq?: unknown } | null)?.local_seq;
      if (
        typeof rawProducer === "string" &&
        rawProducer.length > 0 &&
        typeof rawSeq === "number" &&
        Number.isInteger(rawSeq) &&
        rawSeq > 0 &&
        isSeqSkipped(deps.db, rawProducer, rawSeq)
      ) {
        const cc = (raw as { causality_clock?: unknown }).causality_clock;
        if (
          typeof cc === "object" &&
          cc !== null &&
          !Array.isArray(cc) &&
          Object.values(cc).every(
            (v) => typeof v === "number" && Number.isInteger(v) && v >= 0,
          )
        ) {
          mergeDeviceClock(deps.db, cc as Record<string, number>);
        }
        stats.receivedDuplicate++;
        // TD-006: re-delivery of an already-skipped record is a normal
        // arrival (feeds the ratio denominator, never the invalid count).
        misbehavior.recordOk(producer);
        continue;
      }
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
        // TD-001 (3): the quarantined seq is resolved for sequence progress
        // so later valid seqs can apply and pending above them drains.
        const skippedProducer = (raw as { device_id?: unknown } | null)?.device_id;
        const seq = (raw as { local_seq?: unknown } | null)?.local_seq;
        if (
          typeof skippedProducer === "string" &&
          skippedProducer.length > 0 &&
          typeof seq === "number" &&
          Number.isInteger(seq) &&
          seq > 0
        ) {
          markSeqSkipped(deps.db, skippedProducer, seq);
          // Mirror onto the live knowledge so this session's neededRanges
          // stops re-requesting the skipped position immediately.
          if (!holder.knowledge.skipped) holder.knowledge.skipped = new Map();
          let set = holder.knowledge.skipped.get(skippedProducer);
          if (!set) {
            set = new Set<number>();
            holder.knowledge.skipped.set(skippedProducer, set);
          }
          set.add(seq);
        }
        stats.receivedQuarantined++;
        // TD-006 / DC-16 §2.1-2.2: this is the ONLY feed into the misbehavior
        // ladder — validation rejections reaching the quarantine branch.
        // Transport errors and snapshot-delivered records never reach here.
        misbehavior.recordInvalid(producer);
        appendInvalidTally(deps.db, producer); // §2.3 durable tally (informative only)
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
      // TD-006: a non-rejected outcome is a normal arrival — feeds the
      // window's ratio denominator (and can drive clean-window recovery).
      misbehavior.recordOk(producer);
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
 * TD-001 (5): rebuild in-memory knowledge from persisted tables (F4 fix):
 * applied_upto rows restore the contiguous frontiers, pending_changes rows
 * restore buffered out-of-order seqs, skipped_seqs rows restore the
 * quarantined-and-skipped positions. Without this, a restart regenerates an
 * empty state and re-requests/over-applies records it already holds.
 */
export function loadKnowledgeFromDb(db: Database) {
  const k = emptyKnowledge();
  k.skipped = new Map();
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
  const skipped = db
    .prepare(
      "SELECT producer_device_id AS d, local_seq AS s FROM skipped_seqs",
    )
    .all() as Array<{ d: string; s: number }>;
  for (const r of skipped) {
    let set = k.skipped.get(r.d);
    if (!set) {
      set = new Set<number>();
      k.skipped.set(r.d, set);
    }
    set.add(r.s);
  }
  return k;
}

export interface RevalidationResult {
  /** quarantine rows examined by this pass (DC-04 §4.3c countable) */
  examined: number;
  /** rows that became valid and were applied idempotently */
  revalidated: number;
  /** rows still invalid — remain quarantined with their skip row */
  stillInvalid: number;
}

/** Outcome of running ONE quarantined raw record through the apply path. */
type SingleRevalidation =
  | { outcome: "invalid" } // validateChangeRecord still rejects it
  | { outcome: "failed" } // apply path threw (e.g. domain mutation)
  | { outcome: "applied" }
  | { outcome: "duplicate" }
  | { outcome: "buffered" };

/**
 * TD-005 remainder: revalidation of a SINGLE quarantined raw record —
 * extracted verbatim from revalidateQuarantine's loop body so the per-item
 * Retry action and the restart pass share ONE implementation (same
 * validation, same atomic skip-row removal + apply, same restore-on-failure).
 * Idempotent: re-applying an already-applied record classifies as duplicate.
 */
function revalidateOneQuarantineRaw(
  db: Database,
  rawRecord: string,
  mutate?: (db: Database, record: ChangeRecord) => void,
  knowledge?: NonNullable<SyncEngineDeps["knowledge"]>,
): SingleRevalidation {
  let record: ChangeRecord;
  try {
    record = validateChangeRecord(JSON.parse(rawRecord));
  } catch {
    return { outcome: "invalid" }; // still invalid: quarantine + skip unchanged
  }
  try {
    let outcome: SingleRevalidation["outcome"] | undefined;
    // Atomic per row: the skip-row removal and the apply share one
    // transaction (applyRemoteChange's inner transaction nests safely).
    db.transaction(() => {
      db.prepare(
        "DELETE FROM skipped_seqs WHERE producer_device_id = ? AND local_seq = ?",
      ).run(record.device_id, record.local_seq);
      const k = knowledge ?? loadKnowledgeFromDb(db);
      const res = applyRemoteChange(db, record, k, mutate);
      outcome = res;
    })();
    if (outcome === "applied") return { outcome: "applied" };
    if (outcome === "buffered") return { outcome: "buffered" };
    // duplicate (already have it): the skip row is legitimately gone.
    return { outcome: "duplicate" };
  } catch {
    // Domain mutation failed: remain quarantined, restore the skip row.
    markSeqSkipped(db, record.device_id, record.local_seq);
    return { outcome: "failed" };
  }
}

export function retryQuarantineRecord(
  db: Database,
  quarantineId: number,
  mutate?: (db: Database, record: ChangeRecord) => void,
):
  | { outcome: "applied" | "duplicate" | "buffered"; resolved: boolean }
  | { outcome: "invalid" | "failed"; resolved: false }
  | { outcome: "already_resolved" | "not_found"; resolved: false } {
  const row = db
    .prepare(
      "SELECT raw_record, resolved_at_hlc FROM quarantine WHERE quarantine_id = ?",
    )
    .get(quarantineId) as
    | { raw_record: string; resolved_at_hlc: number | null }
    | undefined;
  if (!row) return { outcome: "not_found", resolved: false };
  if (row.resolved_at_hlc !== null) {
    return { outcome: "already_resolved", resolved: false }; // idempotent
  }
  const res = revalidateOneQuarantineRaw(db, row.raw_record, mutate);
  if (res.outcome === "invalid" || res.outcome === "failed") {
    return { outcome: res.outcome, resolved: false };
  }
  // Applied/duplicate/buffered: the record is now durably present (changes
  // row exists, or it is buffered waiting for a gap that reconcile will
  // close later). Mark resolved via the existing machinery; idempotent.
  const resolved = markQuarantineResolved(db, quarantineId, "retried_by_user");
  return { outcome: res.outcome, resolved };
}

/**
 * TD-001 (6): restart-time revalidation pass. Iterates EVERY quarantine row
 * and re-runs validateChangeRecord + the full apply path against current
 * durable state. Now-valid records apply idempotently (dedupe by changes
 * UNIQUE), their skipped_seqs row is removed, and if the stalled seq becomes
 * nextExpected the frontier advances honestly. Still-invalid records remain
 * quarantined and skipped. Validation is never weakened; quarantine rows are
 * never deleted (DC-04 §4.3b/TR-10).
 */
export function revalidateQuarantine(
  db: Database,
  mutate?: (db: Database, record: ChangeRecord) => void,
  knowledge?: NonNullable<SyncEngineDeps["knowledge"]>,
): RevalidationResult {
  const rows = db
    .prepare("SELECT raw_record FROM quarantine ORDER BY quarantine_id")
    .all() as Array<{ raw_record: string }>;
  const result: RevalidationResult = {
    examined: 0,
    revalidated: 0,
    stillInvalid: 0,
  };
  for (const row of rows) {
    result.examined++;
    // TD-005 remainder: single-record logic extracted and shared with the
    // per-item Retry action (retryQuarantineRecord) — one apply path, both
    // entry points.
    const res = revalidateOneQuarantineRaw(db, row.raw_record, mutate, knowledge);
    if (res.outcome === "applied") result.revalidated++;
    else if (res.outcome === "invalid" || res.outcome === "failed") {
      result.stillInvalid++; // remain quarantined with their skip row
    }
    // duplicate/buffered: skip row legitimately gone / gap still open.
  }
  return result;
}

/** Fallback per-peer trigger key when no explicit peer id is configured. */
function derivePeerKey(clock: VC): string {
  const producers = Object.keys(clock).sort();
  return producers.length > 0 ? producers.join(",") : "unknown";
}
