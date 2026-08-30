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
import {
  EventCore,
  validateEventValues,
  type EventInput,
} from "./event_core.ts";
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
  startSchedulerRuntime,
  makeSessionOpener,
} from "../../application/scheduler_runtime.ts";
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
// Pkg5 (QA M-2): read-only Conflicts surface (DC-14 §3.2/§5) over the same
// DB handle — the view-model guarantees ConflictsViewModel-shaped responses.
import {
  ConflictsViewModel,
  type ResolutionOption,
} from "../../application/conflicts_ui.ts";
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
    // Also kill any pending pairing-offer listener (created by
    // createPairingOffer on an ephemeral port — outside this.host). An
    // uncancelled offer is a LIVE pairing surface that survives the GUI.
    this.cancelPendingOffer("sidecar listener shutdown");
  }

  /**
   * Registry of the current pending pairing offer (one at a time — creating
   * a new offer supersedes the previous one, matching the Devices UI flow).
   * Tracked so stdin-EOF shutdown and explicit cancel_pairing_offer can
   * close its listener. The stored promise is already caught by the
   * dispatcher; cancel() rejects it with a benign error.
   */
  private pendingOffer: {
    result: Promise<unknown>;
    cancel: () => void;
  } | null = null;

  trackPairingOffer(offer: {
    result: Promise<unknown>;
    cancel: () => void;
  }): void {
    // One live offer at a time: a newer offer supersedes (and closes) the
    // previous listener.
    this.cancelPendingOffer("superseded by a newer pairing offer");
    this.pendingOffer = offer;
  }

  cancelPendingOffer(_reason: string): void {
    const offer = this.pendingOffer;
    this.pendingOffer = null;
    if (!offer) return;
    try {
      offer.cancel();
    } catch {
      // never throw during shutdown paths
    }
  }

  /** True when `offer` is the currently tracked pending offer. */
  hasPendingOffer(offer: { cancel: () => void }): boolean {
    return this.pendingOffer === offer;
  }

  /** Drop the tracking entry without cancelling (ceremony completed). */
  untrackPairingOffer(offer: { cancel: () => void }): void {
    if (this.pendingOffer === offer) this.pendingOffer = null;
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
    let stats;
    try {
      stats = await engine.runSession(session.transport);
    } finally {
      // Pkg4 (QA M-3/BND-08): the socket must never dangle on a failed
      // session — a timed-out/stalled peer previously left this side's
      // connection open forever (session.done() was only reached on the
      // success path). done() is idempotent-safe on a dead socket (end()
      // on a destroyed socket is a no-op).
      session.done();
    }
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

// ---------------------------------------------------------------------------
// M-1 / BND-01 + BND-05: event identity & shape contract (authoritative
// sidecar boundary validation). All rejections are deterministic ok:false
// errors; a rejected request NEVER mutates state.
//
// Contract:
//   create_event: args.input must be exactly the five client-settable
//     fields; any `input.id` is rejected — ids are core-generated
//     (`evt-<uuid>`), client id allocation has no legitimate use because
//     the id IS the sync identity (change records, entity_versions, peer
//     convergence all key on it).
//   update_event: args.id (non-empty string) is the SOLE identity; any
//     `input.id` is rejected — even one equal to args.id — so the identity
//     channel is unambiguous. Clients that echo the full event back as
//     input must strip `id`.
//   delete_event: args.id must be a non-empty string.
//   Unknown/mistyped input fields are rejected (never echoed, never
//   persisted).
//
// Pkg 3 additions (same boundary, same rejection discipline):
//   - all five fields are REQUIRED on create AND update ("full input
//     required" — QA-2 F-2): partial input is a deterministic ok:false
//     naming the missing fields; nothing is defaulted (a missing allDay is
//     an error, never a silent false — BND-04) and no raw SQLite error can
//     surface over IPC.
//   - startMs/endMs: integral epoch ms, |v| <= MAX_EVENT_MS (8.64e15),
//     endMs >= startMs (BND-02/03) — shared canonical validator in
//     event_core.ts; binds to SQLite exactly as validated.
// ---------------------------------------------------------------------------

/** The only fields a client may set on an event. */
const EVENT_INPUT_KEYS: ReadonlySet<string> = new Set([
  "title",
  "description",
  "startMs",
  "endMs",
  "allDay",
]);

/** Same fields, in canonical contract order (error messages). */
const EVENT_INPUT_KEY_LIST = ["title", "description", "startMs", "endMs", "allDay"] as const;

function fail(msg: string): never {
  throw new Error(msg);
}

/**
 * Validate the raw `args.input` of create_event/update_event. Returns a
 * clean EventInput containing exactly the five known fields.
 *
 * Pkg 2 (M-1/BND-01): identity contract — input.id rejected, unknown fields
 * rejected, primitive types enforced.
 *
 * Pkg 3 (QA-2 F-2 / BND-02 / BND-03 / BND-04) extends, not replaces:
 *   - EVERY one of the five fields must be PRESENT. The contract is
 *     "full input required": partial input is a deterministic ok:false
 *     naming the missing fields (the shipped Rust EventInput always sends
 *     all five typed fields). Previously a partial update crashed later in
 *     the SQLite seam with `NOT NULL constraint failed: events.description`
 *     — that raw error can no longer surface over IPC. Nothing is
 *     defaulted: a missing allDay is an error, not a silent false (BND-04).
 *   - startMs/endMs must be integral epoch ms within +/-MAX_EVENT_MS with
 *     endMs >= startMs — delegated to the shared canonical validator in
 *     event_core.ts (validateEventValues) so the dispatcher and the domain
 *     core enforce IDENTICAL rules. No silent coercion anywhere: the values
 *     bound to SQLite are exactly the validated ones (integers, so INTEGER
 *     affinity is a no-op — the "42.5" REAL / 0-for-garbage BND-03 class is
 *     structurally closed).
 */
function validateEventInput(raw: unknown, op: string): EventInput {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    fail(
      `${op}: input must be an object with fields title, description, startMs, endMs, allDay`,
    );
  }
  const input = raw as Record<string, unknown>;
  if ("id" in input) {
    fail(
      `${op}: input.id is not accepted — event ids are assigned by the ` +
        `sidecar and are not client-settable (update_event targets the id ` +
        `in args.id); the request was rejected without any state change`,
    );
  }
  const unknown = Object.keys(input).filter((k) => !EVENT_INPUT_KEYS.has(k));
  if (unknown.length > 0) {
    fail(
      `${op}: unknown input field(s): ${unknown.join(", ")} — allowed: ` +
        `title, description, startMs, endMs, allDay`,
    );
  }
  const missing = EVENT_INPUT_KEY_LIST.filter((k) => !(k in input));
  if (missing.length > 0) {
    fail(
      `${op}: input is missing required field(s): ${missing.join(", ")} — ` +
        `the full event input (title, description, startMs, endMs, allDay) ` +
        `is required; partial updates are rejected without any state change`,
    );
  }
  if (typeof input.title !== "string") {
    fail(`${op}: input.title must be a string`);
  }
  if (typeof input.description !== "string") {
    fail(`${op}: input.description must be a string`);
  }
  for (const k of ["startMs", "endMs"] as const) {
    if (typeof input[k] !== "number" || !Number.isFinite(input[k])) {
      fail(`${op}: input.${k} must be a finite number`);
    }
  }
  if (typeof input.allDay !== "boolean") {
    fail(`${op}: input.allDay must be a boolean`);
  }
  const clean: EventInput = {
    title: input.title,
    description: input.description,
    startMs: input.startMs as number,
    endMs: input.endMs as number,
    allDay: input.allDay,
  };
  // Shared canonical value rules (integral, bounded, endMs >= startMs).
  validateEventValues(clean, op);
  return clean;
}

/** Validate an op's target event id (update_event / delete_event). */
function requireEventId(raw: unknown, op: string): string {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    fail(`${op}: args.id must be a non-empty string`);
  }
  return raw;
}

export function makeDispatcher(core: EventCore, sync?: SyncManager): Dispatcher {
  return (op, args) => {
    switch (op) {
      case "ping":
        return { pong: true, device_id: core.selfDeviceId };
      case "list_events": {
        const { from_ms: f, to_ms: t } = args;
        for (const [k, v] of [
          ["from_ms", f],
          ["to_ms", t],
        ] as const) {
          if (v !== undefined && v !== null && typeof v !== "number") {
            fail(`list_events: args.${k} must be a number or null`);
          }
        }
        return core.listEvents({
          fromMs: (f as number | null | undefined) ?? null,
          toMs: (t as number | null | undefined) ?? null,
        });
      }
      case "create_event":
        return core.createEvent(validateEventInput(args.input, "create_event"));
      case "update_event": {
        const id = requireEventId(args.id, "update_event");
        return core.updateEvent(id, validateEventInput(args.input, "update_event"));
      }
      case "delete_event":
        core.deleteEvent(requireEventId(args.id, "delete_event"));
        return null;
      // Pkg6 (BND-06 allow-list drift): read-only series listing. The op was
      // in lib.rs sync_op's ALLOWED list but unimplemented here (fell through
      // to `unknown op`). Grep evidence (pkg6-report §3): frontend/store.ts
      // listSeries() invokes "list_series" on the desktop path — removal from
      // the allow-list would have permanently disabled the recurrence
      // indicator decoration (the store tolerates absence, but wiring the
      // trivially-listable read restores the intended feature). EventCore
      // listSeries() is a pure SELECT over series + occurrence_overrides
      // (DC-12 §2) — no change records, no mutation, no args.
      case "list_series":
        return core.listSeries();
      // --- Pkg5 (QA M-2): read-only Conflicts surface (DC-14 §3.1/§3.2/§5).
      // Delegates to ConflictsViewModel so response shapes are the exact
      // ConflictListItem / ConflictDetailView the frontend bridge consumes.
      // Deliberately READ-ONLY: resolve/skip are DC-14 §4.3 explicit user
      // actions and are NOT exposed over RPC in this package (the shell
      // bridge injection per frontend/conflicts.ts TODO(backend) is the
      // separate write-path work item).
      case "list_conflicts": {
        const vm = new ConflictsViewModel(core.db, core.selfDeviceId);
        const filter: { entity_id?: string } = {};
        if (
          args.entity_id !== undefined &&
          (typeof args.entity_id !== "string" || args.entity_id.length === 0)
        ) {
          fail("list_conflicts: args.entity_id must be a non-empty string");
        }
        if (typeof args.entity_id === "string" && args.entity_id.length > 0) {
          filter.entity_id = args.entity_id;
        }
        return {
          total_unresolved: vm.totalUnresolved(),
          conflicts: vm.listUnresolved(filter),
        };
      }
      case "conflict_detail": {
        if (
          typeof args.conflict_id !== "string" ||
          args.conflict_id.length === 0
        ) {
          fail("conflict_detail: args.conflict_id must be a non-empty string");
        }
        const vm = new ConflictsViewModel(core.db, core.selfDeviceId);
        return vm.getDetail(args.conflict_id);
      }
      // --- DC-14 §4.3 write path: resolve / skip over RPC. Both delegate to
      // ConflictsViewModel commands so the write transaction (winning-value
      // change record + status flip, §6.1) and the TR-2 skip no-op live in
      // exactly one place (the application layer).
      case "resolve_conflict": {
        if (
          typeof args.conflict_id !== "string" ||
          args.conflict_id.length === 0
        ) {
          fail("resolve_conflict: args.conflict_id must be a non-empty string");
        }
        const raw = args.option as Record<string, unknown> | undefined;
        if (raw === null || typeof raw !== "object") {
          fail("resolve_conflict: args.option must be an object");
        }
        let option: ResolutionOption;
        switch (raw.kind) {
          case "keep_mine":
            option = { kind: "keep_mine" };
            break;
          case "keep_theirs":
            if (
              raw.change_id !== undefined &&
              (typeof raw.change_id !== "string" || raw.change_id.length === 0)
            ) {
              fail(
                "resolve_conflict: args.option.change_id must be a non-empty string",
              );
            }
            option =
              raw.change_id === undefined
                ? { kind: "keep_theirs" }
                : { kind: "keep_theirs", change_id: raw.change_id };
            break;
          case "keep_both":
          case "resolved_custom": // frontend alias for resolved_custom value
            if (!("value" in raw)) {
              fail("resolve_conflict: args.option.value is required");
            }
            option = { kind: "keep_both", value: raw.value };
            break;
          default:
            fail(
              'resolve_conflict: args.option.kind must be "keep_mine" | "keep_theirs" | "resolved_custom"',
            );
        }
        const vm = new ConflictsViewModel(core.db, core.selfDeviceId);
        return vm.resolve(args.conflict_id, option);
      }
      case "skip_conflict": {
        if (
          typeof args.conflict_id !== "string" ||
          args.conflict_id.length === 0
        ) {
          fail("skip_conflict: args.conflict_id must be a non-empty string");
        }
        const vm = new ConflictsViewModel(core.db, core.selfDeviceId);
        vm.skip(args.conflict_id); // TR-2: intentional no-op, zero writes
        return null;
      }
      default:
        throw new Error(`unknown op: ${op}`);
    }
  };
}

/** Sync-specific dispatcher ops (kept separate for testability). */

/**
 * Pkg4 (BND-08): bound on the sync_now connect + Noise handshake phase.
 * Default 15s, matching SYNC_IDLE_TIMEOUT_MS (sync_engine.ts). Env override
 * exists for ops and tests (e.g. TIDE_SYNC_CONNECT_TIMEOUT_MS=500).
 */
export const SYNC_CONNECT_TIMEOUT_MS = (() => {
  const raw = process.env.TIDE_SYNC_CONNECT_TIMEOUT_MS;
  const n = raw !== undefined ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 15_000;
})();

/**
 * Pkg4: race `p` against a rejection timer. On timeout the underlying
 * promise gets a no-op catch so a late rejection (EHOSTUNREACH, handshake
 * failure of the still-in-flight connect) can never surface as an
 * unhandledRejection after sync_now has already returned.
 */
export function withTimeout<T>(
  p: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return (async () => {
    try {
      return await Promise.race([p, guard]);
    } finally {
      clearTimeout(timer);
      void p.catch(() => {});
    }
  })();
}

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
        // The offer is TRACKED on the SyncManager: a newer offer supersedes
        // it, cancel_pairing_offer closes it, and stdin-EOF shutdown closes
        // it — an uncancelled offer would be a live pairing listener that
        // survives the GUI (security surface, not just a resource leak).
        const offerPromise = createPairingOffer({
          identity: sync.identity,
          port: typeof args.port === "number" ? args.port : undefined,
          name:
            typeof args.name === "string" ? args.name : sync.identity.deviceId.slice(0, 12),
          store: sqlPeerStore(core.db),
        });
        void offerPromise
          .then((o) => {
            sync.trackPairingOffer(o);
            // Self-untrack when the ceremony completes either way (paired,
            // errored, or cancelled): nothing left to cancel afterwards.
            o.result.catch(() => {}).finally(() => {
              if (sync.hasPendingOffer(o)) sync.untrackPairingOffer(o);
            });
            return o;
          })
          .catch(() => {});
        return offerPromise.then((o) => ({ qr_text: o.qrText }));
      }
      case "cancel_pairing_offer": {
        // Explicit user cancellation of the pending offer (Devices dialog).
        // Idempotent: no pending offer is a successful no-op.
        sync.cancelPendingOffer("user cancel");
        return { cancelled: true };
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
          // Pkg4 (BND-08): connect + Noise handshake are bounded by a
          // watchdog — an unroutable/dead host's TCP connect would otherwise
          // hang sync_now for minutes (the OS-level connect timeout). The
          // watchdog covers ONLY the pre-data phase; once connectSync
          // resolves, mid-session peer failures are bounded by the engine's
          // per-message idle timeout (SYNC_IDLE_TIMEOUT_MS, sync_engine.ts)
          // — a whole-session deadline here would false-timeout a
          // legitimately large/slow transfer.
          const session = await withTimeout(
            connectSync(
              sync.identity.privateKey,
              args.host as string,
              args.port as number,
            ),
            SYNC_CONNECT_TIMEOUT_MS,
            `sync connect timed out waiting for peer ${args.host}:${args.port} ` +
              `(no TCP connect / Noise handshake within ${SYNC_CONNECT_TIMEOUT_MS}ms)`,
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
    op === "cancel_pairing_offer" ||
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
  // DC-13 §5/§7 runtime: timers drive the pure Scheduler (debounced push,
  // periodic sweep). Sweep actions are NO-OPed inside the runtime (standing
  // constraint until the compaction feature ships). Endpoint note: the peers
  // table has no host/port and mDNS browse is not yet plumbed into the
  // sidecar, so every peer starts endpoint-less and is skipped with a log
  // line — automatic sessions begin once DC-11 endpoints arrive. Manual
  // sync_now (tray/toolbar) is unaffected: it takes its endpoint explicitly.
  startSchedulerRuntime({
    now: () => Date.now(),
    listPeers: () =>
      listTrustedPeers(core.db).map((p) => ({
        deviceId: p.device_id,
        endpoint: null,
      })),
    openSession: makeSessionOpener({
      privateKey: sync.identity.privateKey,
      runSession: (session) => sync.runEngineSession(session as never),
    }),
    log: (m: string) => console.error(`[tide] ${m}`),
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
