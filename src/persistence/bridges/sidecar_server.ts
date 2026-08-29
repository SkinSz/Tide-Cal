// Tide sidecar: stdio JSON-RPC host for the TS domain core.
//
// The Tauri (Rust) layer spawns this process with Node >= 23 (native TS type
// stripping) and speaks newline-delimited JSON over stdin/stdout. Every
// mutation is executed by src/persistence/database.ts's DC-07 ops, keeping
// change records + HLC/vector clocks authoritative in one place.
//
// Protocol (one JSON object per line):
//   request:  {"id": <num|string>, "op": "<name>", "args": {...}}
//   response: {"id": ..., "ok": true, "result": ...}
//             {"id": ..., "ok": false, "error": "..."}
//
// Ops:
//   ping                      -> {"pong": true, "device_id": "..."}
//   list_events {from_ms?, to_ms?}            -> CalendarEvent[]
//   create_event {input: EventInput}          -> CalendarEvent
//   update_event {id, input: EventInput}      -> CalendarEvent
//   delete_event {id}                         -> null

import { createInterface } from "node:readline";
import { EventCore } from "./event_core.ts";
import {
  loadOrCreateIdentity,
  serveSync,
  connectSync,
  SYNC_DEFAULT_PORT,
  type InboundSession,
} from "../../network/sync_runtime.ts";
import type { DeviceIdentity } from "../../security/identity.ts";
import {
  createPairingOffer,
  acceptPairingPayload,
  sqlPeerStore,
  listTrustedPeers,
} from "../../network/pairing_manager.ts";
import {
  makeEntityMutator,
  createSyncEngine,
} from "./sync_service.ts";
import {
  listQuarantine,
  countQuarantined,
  listQuarantineStats,
  listHardBlocks,
  unhardBlockProducer,
  listPeerInvalidTally,
  // TD-005 remainder: per-item retry/delete + resolved-row retention cap.
  deleteQuarantineByUser,
  pruneResolvedQuarantine,
} from "../database.ts";
// TD-005 remainder: per-item Retry shares the restart revalidation apply path.
import { retryQuarantineRecord } from "../../sync/sync_engine.ts";
// TD-006 / DC-16: Tier-1 tracker (in-memory) + state surface for the UI.
import {
  PeerMisbehaviorTracker,
  LADDER_LABELS,
  type PeerTier1State,
} from "../../sync/misbehavior.ts";

type Json = Record<string, unknown>;

export type Dispatcher = (op: string, args: Json) => unknown;

/**
 * Sync runtime state for one sidecar process: identity + optional listener.
 * Data dir defaults to beside the DB (identity key must persist per install).
 */
export class SyncManager {
  readonly identity;
  /**
   * TD-006 / DC-16: process-wide Tier-1 tracker, shared by every engine
   * session this sidecar runs, so ladder state persists across sessions.
   * In-memory ONLY — a sidecar restart fails OPEN back to Level 0 (§2.3).
   */
  readonly misbehavior = new PeerMisbehaviorTracker();
  private host: { actualPort: number; close(): void } | null = null;

  constructor(
    private readonly core: EventCore,
    /** Pre-loaded identity; must be the SAME one EventCore was built with. */
    identity?: DeviceIdentity,
    dataDir?: string,
  ) {
    this.identity =
      identity ??
      loadOrCreateIdentity(
        dataDir ?? core.dbPath.replace(/[/\\][^/\\]+$/, "") ?? ".",
      );
  }

  get deviceId(): string {
    return this.identity.deviceId;
  }

  /** The port this sidecar will listen on (requested, if binding pending). */
  private resolvedPort(requested?: number): number {
    return requested ??
      (process.env.TIDE_SYNC_PORT
        ? Number(process.env.TIDE_SYNC_PORT)
        : SYNC_DEFAULT_PORT);
  }

  ensureListener(port?: number): number {
    if (!this.host) {
      // Root-cause fix (2026-08-27 smoke test): serveSync rejects with
      // EADDRINUSE when the default sync port is already held (typically by
      // a sidecar from a previous session that outlived its GUI). The old
      // fire-and-forget chain had no catch, so the rejection went unhandled
      // and Node exited with code 1 — killing the sidecar and taking every
      // RPC surface down with it. Now: log, leave this.host null, and retry
      // on the next ensureListener() call.
      void serveSync(
        this.identity.privateKey,
        this.resolvedPort(port),
        (session) => this.onInbound(session),
      ).then(
        (h) => {
          this.host = h;
        },
        (err: unknown) => {
          console.error(
            `[tide] sync listener failed to start on port ${this.resolvedPort(port)}:`,
            err instanceof Error ? err.message : err,
          );
          console.error(
            "[tide] sync inbound connections are unavailable until the port frees up; the calendar itself is unaffected.",
          );
        },
      );
      // First listener creation is async; port is served shortly after.
      return this.resolvedPort();
    }
    return this.host.actualPort;
  }

  /**
   * Close the sync listener (if any). Called on stdin EOF: the parent GUI
   * is gone, so nothing can ever drain this listener again. NOTE: this
   * stops new accepts and drops the listen handle, but established peer
   * sockets and a pending pairing-offer listener (pairing_manager's own
   * serveSync host) are NOT touched — the process.exit(0) in the stdin
   * close handler is what guarantees teardown. Without that exit this
   * method alone would not drain the loop.
   * (investigation: docs/proposals/sidecar-orphan-investigation.md)
   */
  closeListener(): void {
    this.host?.close();
    this.host = null;
  }

  /** Run a sync engine session over an authenticated channel. */
  async runEngineSession(session: InboundSession): Promise<{
    sent: number;
    receivedApplied: number;
    receivedBuffered: number;
    receivedDuplicate: number;
    remote_device_id: string;
  }> {
    const engine = createSyncEngine({
      db: this.core.db,
      selfDeviceId: this.identity.deviceId,
      mutateEntity: makeEntityMutator(),
      misbehavior: this.misbehavior,
    });
    const stats = await engine.runSession(session.transport);
    session.done();
    return {
      ...stats,
      remote_device_id: Buffer.from(session.raw.remoteStaticKey()).length
        ? `x25519:${Buffer.from(session.raw.remoteStaticKey())
            .toString("hex")
            .slice(0, 16)}`
        : "unknown",
    };
  }

  private onInbound(session: InboundSession): void {
    // Inbound post-pairing sessions run an immediate sync session.
    void this.runEngineSession(session).catch(() => {
      /* fail-closed: logged by transport; session is dead */
    });
  }

  // ------------------------------------------------------------------
  // TD-006 / DC-16 §4: peer-state visibility + explicit recovery actions
  // ------------------------------------------------------------------

  /**
   * Per-peer misbehavior state for the UI (Sync-Errors badge + Paired
   * Devices). Merge of: paired peers, live Tier-1 ladder state, Tier-2
   * durable hard blocks, and the §2.3 durable invalid tally (history).
   */
  peerStateSnapshot(): Array<
    PeerTier1State & {
      paired: boolean;
      display_name: string | null;
      paired_at: number | null;
      ladder_label: string;
      hard_block:
        | {
            first_triggered_at: number;
            last_triggered_at: number;
            trigger_count: number;
          }
        | null;
      tally: { total_invalid: number; last_invalid_at: number } | null;
    }
  > {
    const peers = listTrustedPeers(this.core.db);
    const blocks = new Map(listHardBlocks(this.core.db).map((b) => [b.producer_device_id, b]));
    const tally = new Map(
      listPeerInvalidTally(this.core.db).map((t) => [t.producer_device_id, t]),
    );
    const known = new Set<string>([
      ...peers.map((p) => p.device_id),
      ...this.misbehavior.knownPeers(),
      ...blocks.keys(),
      ...tally.keys(),
    ]);
    const out = [];
    for (const id of Array.from(known).sort()) {
      const paired = peers.some((p) => p.device_id === id);
      const peer = peers.find((p) => p.device_id === id);
      const t1 = this.misbehavior.getState(id);
      const b = blocks.get(id) ?? null;
      const tl = tally.get(id) ?? null;
      out.push({
        ...t1,
        paired,
        display_name: peer?.display_name ?? null,
        paired_at: peer ? peer.paired_at * 1000 : null,
        ladder_label: LADDER_LABELS[t1.level],
        hard_block: b
          ? {
              first_triggered_at: b.first_triggered_at,
              last_triggered_at: b.last_triggered_at,
              trigger_count: b.trigger_count,
            }
          : null,
        tally: tl
          ? { total_invalid: tl.total_invalid, last_invalid_at: tl.last_invalid_at }
          : null,
      });
    }
    return out;
  }

  /** §4.2 Tier-1 manual override: one click, back to Level 0 immediately. */
  resetPeerState(deviceId: string): void {
    this.misbehavior.resetPeer(deviceId);
  }

  /**
   * §4.2 Tier-2 Unblock (the UI enforces the two-step confirmation; this is
   * the actual action). Clears the durable row and returns the peer to
   * Tier-1 Level 0 observation.
   */
  unblockPeer(deviceId: string): boolean {
    const cleared = unhardBlockProducer(this.core.db, deviceId);
    this.misbehavior.resetPeer(deviceId);
    return cleared;
  }
}

export function makeDispatcher(core: EventCore, sync?: SyncManager): Dispatcher {
  return (op, args) => {
    switch (op) {
      case "ping":
        return { pong: true, device_id: core.selfDeviceId };
      case "list_events":
        return core.listEvents({
          fromMs: (args.from_ms as number | null | undefined) ?? null,
          toMs: (args.to_ms as number | null | undefined) ?? null,
        });
      case "create_event":
        return core.createEvent(args.input as never);
      case "update_event":
        return core.updateEvent(args.id as string, args.input as never);
      case "delete_event":
        core.deleteEvent(args.id as string);
        return null;
      default:
        throw new Error(`unknown op: ${op}`);
    }
  };
}

/** Sync-specific dispatcher ops (kept separate for testability). */
export function makeSyncDispatcher(
  sync: SyncManager,
  core: EventCore,
): Dispatcher {
  return (op, args) => {
    switch (op) {
      case "device_info": {
        const peers = listTrustedPeers(core.db);
        return {
          device_id: sync.identity.deviceId,
          paired_peers: peers.map((p) => ({
            device_id: p.device_id,
            display_name: p.display_name,
            paired_at: p.paired_at * 1000,
          })),
          listening_port: sync.ensureListener(),
        };
      }
      case "pairing_offer": {
        // NOTE: synchronous snapshot of an async ceremony — the offer object
        // keeps working after return; result arrives via pairing_status polls.
        const offerPromise = createPairingOffer({
          identity: sync.identity,
          port: typeof args.port === "number" ? args.port : undefined,
          name:
            typeof args.name === "string" ? args.name : sync.identity.deviceId.slice(0, 12),
          store: sqlPeerStore(core.db),
        });
        offerPromise.then((o) => o.result.catch(() => {})).catch(() => {});
        return offerPromise.then((o) => ({ qr_text: o.qrText }));
      }
      case "pairing_accept": {
        if (typeof args.qr_text !== "string")
          throw new Error("qr_text required");
        return acceptPairingPayload({
          identity: sync.identity,
          qr_text_text: undefined,
          qrText: args.qr_text,
          name: typeof args.name === "string" ? args.name : undefined,
          store: sqlPeerStore(core.db),
        } as never).then((r) => ({
          peer_device_id: r.peerDeviceId,
          safety_number: r.safetyNumber,
        }));
      }
      case "sync_now": {
        if (
          typeof args.host !== "string" ||
          typeof args.port !== "number"
        ) {
          throw new Error("host and port required");
        }
        return (async () => {
          const session = await connectSync(
            sync.identity.privateKey,
            args.host as string,
            args.port as number,
          );
          return sync.runEngineSession(session);
        })();
      }
      // TD-001 §2 Option A "Sync Errors": read-only quarantine listing for
      // the UI badge + dialog. No retry/delete surface exists by design.
      case "list_quarantine": {
        const limit =
          typeof args.limit === "number" && args.limit > 0
            ? Math.floor(args.limit)
            : undefined;
        return {
          rows: listQuarantine(core.db, { limit }),
          total: countQuarantined(core.db),
        };
      }
      // TD-005: active/resolved/total counts for the Sync-Errors badge
      // (badge counts ACTIVE only; resolved rows are archived diagnostics).
      case "quarantine_stats": {
        return listQuarantineStats(core.db);
      }
      // TD-005 remainder: per-item Retry — runs the single record through
      // the SAME revalidation apply path used at restart. Idempotent; safe
      // against concurrent restart (both paths are transactional and
      // dedupe on the changes UNIQUE key). Prune afterwards so the
      // resolved-row retention cap holds after each new resolution.
      case "retry_quarantine": {
        if (
          typeof args.quarantine_id !== "number" ||
          !Number.isInteger(args.quarantine_id)
        ) {
          throw new Error("quarantine_id required");
        }
        const result = retryQuarantineRecord(
          core.db,
          args.quarantine_id,
          makeEntityMutator(),
        );
        pruneResolvedQuarantine(core.db);
        return result;
      }
      // TD-005 remainder: per-item Delete (give up on record). Requires the
      // explicit confirm flag (defense-in-depth behind the UI's two-step
      // confirmation, DC-15 §3.5). Retains the row with
      // resolved_reason='user_deleted' and guarantees the skipped_seqs
      // entry exists so the stream stays unblocked.
      case "delete_quarantine": {
        if (
          typeof args.quarantine_id !== "number" ||
          !Number.isInteger(args.quarantine_id)
        ) {
          throw new Error("quarantine_id required");
        }
        const result = deleteQuarantineByUser(core.db, args.quarantine_id, {
          confirm: args.confirm === true,
        });
        pruneResolvedQuarantine(core.db);
        return result;
      }
      // --- TD-006 / DC-16 §4: peer misbehavior visibility + recovery ------
      // Read-only per-peer state (Sync-Errors badge section + Paired Devices).
      case "peer_state": {
        return { peers: sync.peerStateSnapshot() };
      }
      // O4 Paired Devices list: identity id, display name, paired-since,
      // last-seen (null: not tracked), Tier-1 + Tier-2 state per device.
      case "list_paired_devices": {
        return {
          self_device_id: sync.identity.deviceId,
          devices: sync.peerStateSnapshot().filter((p) => p.paired),
        };
      }
      // §4.2 Tier-1: "Reset peer state" — one click, no confirmation.
      case "reset_peer_state": {
        if (typeof args.device_id !== "string" || args.device_id.length === 0) {
          throw new Error("device_id required");
        }
        sync.resetPeerState(args.device_id);
        return { ok: true };
      }
      // §4.2 Tier-2: "Unblock" — two-step confirmation lives in the UI;
      // this executes the cleared action and returns to Level 0.
      case "unblock_peer": {
        if (typeof args.device_id !== "string" || args.device_id.length === 0) {
          throw new Error("device_id required");
        }
        return { ok: true, cleared: sync.unblockPeer(args.device_id) };
      }
      default:
        throw new Error(`unknown op: ${op}`);
    }
  };
}

export async function handleLine(
  dispatcher: Dispatcher,
  line: string,
): Promise<string> {
  let response: Json;
  try {
    const req = JSON.parse(line) as { id?: unknown; op?: string; args?: Json };
    if (typeof req.op !== "string") throw new Error("missing op");
    try {
      // Await async op results BEFORE building the envelope: JSON.stringify
      // serializes a raw Promise as {}, which silently dropped results for
      // async ops (pairing_offer, pairing_accept, sync_now, ...). await also
      // propagates rejections into the catch below → ok:false.
      response = {
        id: req.id ?? null,
        ok: true,
        result: await Promise.resolve(dispatcher(req.op, req.args ?? {})),
      };
    } catch (e) {
      response = {
        id: req.id ?? null,
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  } catch (e) {
    response = {
      id: null,
      ok: false,
      error: `bad request line: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  return JSON.stringify(response);
}

function main(): void {
  const dbPath = process.env.TIDE_DB_PATH;
  if (!dbPath) {
    console.error("tide-sidecar: TIDE_DB_PATH is required");
    process.exit(2);
  }
  // F1 fix (identity split): construct EventCore WITH the persisted Ed25519
  // deviceId so domain records, the sync engine, and the pairing identity all
  // share ONE producer id. The marker-file fallback in EventCore is never
  // reached here — a single installation can no longer split identities.
  const syncIdentity = loadOrCreateIdentity(
    process.env.TIDE_DATA_DIR ??
      dbPath.replace(/[/\\][^/\\]+$/, "") ?? ".",
  );
  const core = new EventCore(dbPath, syncIdentity.deviceId);
  const sync = new SyncManager(core, syncIdentity);
  const dispatch = makeDispatcher(core);
  const syncDispatch = makeSyncDispatcher(sync, core);
  const combined: Dispatcher = (op, args) =>
    op.startsWith("sync_") || op === "device_info" ||
    op === "pairing_offer" || op === "pairing_accept" ||
    op === "list_quarantine" || op === "quarantine_stats" ||
    op === "retry_quarantine" || op === "delete_quarantine" ||
    op === "peer_state" || op === "list_paired_devices" ||
    op === "reset_peer_state" || op === "unblock_peer"
      ? syncDispatch(op, args)
      : dispatch(op, args);
  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    void handleLine(combined, trimmed).then((out) =>
      process.stdout.write(out + "\n"),
    );
  });
  rl.on("close", () => {
    // Parent GUI closed our stdin — it is dead or dying (hard kill included:
    // no Rust Drop runs there, but the pipe still EOFs). Close the sync
    // listener (hygiene; established sockets are NOT drained — see
    // SyncManager.closeListener), close the DB, then EXIT unconditionally.
    // The exit is the actual orphan fix: db.close() is synchronous
    // (better-sqlite3, WAL checkpoint included) and runs before the
    // scheduled exit fires; if the DB layer ever becomes async, move
    // exit into its completion callback.
    sync.closeListener();
    setImmediate(() => process.exit(0));
    core.db.close();
  });
}

// Only auto-run the stdio loop when executed as a script (not under vitest).
const self = process.argv[1] ?? "";
if (process.env.VITEST === undefined && /sidecar\.(mjs|ts|cjs)$/.test(self)) {
  main();
}
