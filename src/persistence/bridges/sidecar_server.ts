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

type Json = Record<string, unknown>;

export type Dispatcher = (op: string, args: Json) => unknown;

/**
 * Sync runtime state for one sidecar process: identity + optional listener.
 * Data dir defaults to beside the DB (identity key must persist per install).
 */
class SyncManager {
  readonly identity;
  private host: { actualPort: number; close(): void } | null = null;

  constructor(
    private readonly core: EventCore,
    dataDir?: string,
  ) {
    this.identity = loadOrCreateIdentity(
      dataDir ?? core.dbPath.replace(/[/\\][^/\\]+$/, "") ?? ".",
    );
  }

  get deviceId(): string {
    return this.identity.deviceId;
  }

  ensureListener(port?: number): number {
    if (!this.host) {
      void serveSync(
        this.identity.privateKey,
        port ?? SYNC_DEFAULT_PORT,
        (session) => this.onInbound(session),
      ).then((h) => {
        this.host = h;
      });
      // First listener creation is async; port is served shortly after.
      return port ?? SYNC_DEFAULT_PORT;
    }
    return this.host.actualPort;
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
      default:
        throw new Error(`unknown op: ${op}`);
    }
  };
}

export function handleLine(dispatcher: Dispatcher, line: string): string {
  let response: Json;
  try {
    const req = JSON.parse(line) as { id?: unknown; op?: string; args?: Json };
    if (typeof req.op !== "string") throw new Error("missing op");
    try {
      response = {
        id: req.id ?? null,
        ok: true,
        result: dispatcher(req.op, req.args ?? {}),
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
  const core = new EventCore(dbPath);
  const sync = new SyncManager(core, process.env.TIDE_DATA_DIR);
  const dispatch = makeDispatcher(core);
  const syncDispatch = makeSyncDispatcher(sync, core);
  const combined: Dispatcher = (op, args) =>
    op.startsWith("sync_") || op === "device_info" ||
    op === "pairing_offer" || op === "pairing_accept"
      ? syncDispatch(op, args)
      : dispatch(op, args);
  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    process.stdout.write(handleLine(combined, trimmed) + "\n");
  });
  rl.on("close", () => {
    // Do NOT process.exit() here: pending async pipe writes would be cut
    // off. Closing the DB and letting the event loop drain exits cleanly.
    core.db.close();
  });
}

// Only auto-run the stdio loop when executed as a script (not under vitest).
const self = process.argv[1] ?? "";
if (process.env.VITEST === undefined && /sidecar\.(mjs|ts|cjs)$/.test(self)) {
  main();
}
