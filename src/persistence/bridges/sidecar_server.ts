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
//   list_series {}                            -> SeriesRow[] (read-only)
//   update_series_rule {series_id, rule}      -> {seriesId, recurrenceRule}
//   update_occurrence {series_id, recurrence_id, patch} -> {seriesId, recurrenceId, changed}

import { createInterface } from "node:readline";
import {
  EventCore,
  validateEventValues,
  validateRRule,
  validateRecurrenceId,
  OVERRIDE_FIELDS,
  type EventInput,
  type OverridePatch,
} from "./event_core.ts";
import {
  loadOrCreateIdentity,
  serveSync,
  connectSync,
  SYNC_DEFAULT_PORT,
  type InboundSession,
} from "../../network/sync_runtime.ts";
import { ed25519ToX25519PublicKey } from "../../network/noise_transport.ts";
import {
  EndpointCache,
  matchInstanceToPeer,
  resolveEndpoint,
  type MdnsEvent,
} from "../../network/endpoint_bridge.ts";
import { instancePrefix } from "../../network/discovery.ts";
import type { DeviceIdentity } from "../../security/identity.ts";
import {
  createPairingOffer,
  acceptPairingPayload,
  sqlPeerStore,
  listTrustedPeers,
  recordPeerEndpoint,
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
  rebuildSchedule,
  filterDelivered,
  markDelivered,
} from "../../application/reminder_engine.ts";
import { deliverNotification } from "../../application/notification_delivery.ts";
// Smoke-test fix (2026-09-03): reminders on series events fired against the
// BASE row's stored instant only — a reminder set on any occurrence chip
// fired for the series' first occurrence (or, worse, for a re-anchored base
// instant), never for the occurrence the user set it on. The tick now feeds
// the engine one synthetic event row PER OCCURRENCE in the reminder window
// (id `<base>#<recurrence_id>`), so per-occurrence reminders work without
// touching the replicated reminder member (still one per event, DC-22 D5).
import { expandOccurrences } from "../../domain/recurrence_conflicts.ts";

/** Local wall "YYYYMMDDTHHMMSS" -> epoch ms (same math as calendar.ts). */
function msFromWallId(id: string): number {
  const digits = id.replace(/\D/g, "");
  const y = +digits.slice(0, 4);
  const mo = +digits.slice(4, 6);
  const dd = +digits.slice(6, 8);
  const hh = +digits.slice(8, 10) || 0;
  const mi = +digits.slice(10, 12) || 0;
  const ss = +digits.slice(12, 14) || 0;
  return new Date(y, mo - 1, dd, hh, mi, ss, 0).getTime();
}
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

  /**
   * Run a sync engine session over an authenticated channel.
   *
   * DC-21 D3 (owner amendment, binding): BEFORE any session result is
   * trusted, the handshake's remote static key is verified against the trust
   * store row for `expectedDeviceId` (when the caller attributes the dial to
   * a paired peer — scheduler path). A mismatch throws BEFORE runSession, so
   * nothing is exchanged and nothing is persisted (DC-11 §4.6 silent drop).
   */
  async runEngineSession(session: InboundSession, expectedDeviceId?: string): Promise<{
    sent: number;
    receivedApplied: number;
    receivedBuffered: number;
    receivedDuplicate: number;
    remote_device_id: string;
  }> {
    const remoteKeyBuf = Buffer.from(session.raw.remoteStaticKey());
    try {
      if (expectedDeviceId !== undefined) {
        // D3: routing hints are NOT identity. Only the handshake result, checked
        // against the trust store, proves who is on the other end. This throw
        // is INSIDE the try below the finally scope guard (pkg10 F3): the
        // socket closes even on identity mismatch — no FD exhaustion via
        // repeated spoofed dials.
        const row = this.core.db
          .prepare(
            "SELECT public_key FROM peers WHERE device_id = ? AND status = 'trusted'",
          )
          .get(expectedDeviceId) as { public_key: Buffer } | undefined;
        const remoteX25519Hex = remoteKeyBuf.toString("hex");
        const trustedX25519Hex = row
          ? Buffer.from(
              ed25519ToX25519PublicKey(new Uint8Array(row.public_key)),
            ).toString("hex")
          : null;
        if (row === undefined || trustedX25519Hex !== remoteX25519Hex) {
          throw new Error(
            `DC-21 D3 identity mismatch: endpoint attributed to ${expectedDeviceId} ` +
              `presented remote static key ${remoteX25519Hex.slice(0, 16)}… — ` +
              `session aborted, endpoint NOT persisted (DC-11 §4.6 silent drop)`,
          );
        }
      }
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
      // DC-21 D6: record the endpoint only AFTER a successful authenticated
      // session with a KNOWN expected peer (scheduler path). Inbound sessions
      // (no expectedDeviceId) resolve identity from the trust store by key.
      const remoteDeviceId =
        expectedDeviceId ?? this.resolveDeviceIdByRemoteKey(remoteKeyBuf);
      if (remoteDeviceId !== undefined && session.dialEndpoint !== undefined) {
        recordPeerEndpoint(
          this.core.db,
          remoteDeviceId,
          session.dialEndpoint.host,
          session.dialEndpoint.port,
          Date.now(),
        );
      }
      return {
        ...stats,
        remote_device_id: remoteDeviceId ?? "unknown",
      };
    } catch (err) {
      // pkg10 F3: session.done() is idempotent-safe — always run it when the
      // pre-exchange identity check or anything else throws before the
      // inner finally was reached. Re-throw to preserve the loud failure.
      session.done();
      throw err;
    }
  }

  /**
   * DC-21 D3/D6: inbound sessions have no expectedDeviceId (the peer dialed
   * us); resolve identity by matching the handshake's remote static key
   * against the trust store. Unmatched keys return undefined — the session
   * stats still return (the engine already ran; the data flow was
   * authenticated by Noise against SOME paired key or rejected), but no
   * endpoint is recorded.
   */
  private resolveDeviceIdByRemoteKey(remoteKeyBuf: Buffer): string | undefined {
    const rows = this.core.db
      .prepare("SELECT device_id, public_key FROM peers WHERE status = 'trusted'")
      .all() as Array<{ device_id: string; public_key: Buffer }>;
    const remoteHex = remoteKeyBuf.toString("hex");
    for (const row of rows) {
      const x25519 = Buffer.from(
        ed25519ToX25519PublicKey(new Uint8Array(row.public_key)),
      );
      if (x25519.toString("hex") === remoteHex) return row.device_id;
    }
    return undefined;
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
  // DC-12: optional RRULE on CREATE (makes the event a series base event).
  // Rejected on update_event — series rule edits go through update_series_rule.
  "recurrenceRule",
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
  // DC-12: optional RRULE on create; deterministic rejection on update.
  if (input.recurrenceRule !== undefined) {
    if (op === "update_event") {
      fail(
        "update_event: input.recurrenceRule is not accepted — series rule " +
          "edits go through update_series_rule (the rule is its own DC-12 §3 " +
          "conflict entity)",
      );
    }
    if (typeof input.recurrenceRule !== "string") {
      fail("create_event: input.recurrenceRule must be a string");
    }
    clean.recurrenceRule = validateRRule(input.recurrenceRule, op);
  }
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
      // DC-22: reminder member write path (dialog "Remind me" checkbox).
      // Replicates as reminder member_add/update/remove (D5).
      case "get_reminder": {
        if (typeof args.event_id !== "string") fail("get_reminder: args.event_id required");
        return core.reminderFor(args.event_id as string);
      }
      case "set_reminder": {
        if (typeof args.event_id !== "string") fail("set_reminder: args.event_id required");
        if (typeof args.minutes_before !== "number" || !Number.isInteger(args.minutes_before) || args.minutes_before < 0) {
          fail("set_reminder: args.minutes_before must be a non-negative integer");
        }
        if (typeof args.enabled !== "boolean") fail("set_reminder: args.enabled must be a boolean");
        core.setReminder(args.event_id as string, {
          minutesBefore: args.minutes_before as number,
          enabled: args.enabled as boolean,
        });
        return { set: true };
      }
      case "clear_reminder": {
        if (typeof args.event_id !== "string") fail("clear_reminder: args.event_id required");
        core.clearReminder(args.event_id as string);
        return { cleared: true };
      }
      // --- DC-12 §2.1/§3: series write paths. The rule is its own conflict
      // entity (series_id, "recurrence_rule"); occurrence overrides are
      // keyed (series_id, recurrence_id) with per-field DC-03 entities
      // "overrides.<rid>.<field>" (§2.2). Deterministic ok:false on any
      // validation failure; a rejected request never mutates state.
      case "update_series_rule": {
        if (
          typeof args.series_id !== "string" ||
          args.series_id.length === 0
        ) {
          fail("update_series_rule: args.series_id must be a non-empty string");
        }
        if (typeof args.rule !== "string") {
          fail("update_series_rule: args.rule must be a string (RFC 5545 RRULE)");
        }
        return core.updateSeriesRule(args.series_id, args.rule);
      }
      case "update_occurrence": {
        if (
          typeof args.series_id !== "string" ||
          args.series_id.length === 0
        ) {
          fail("update_occurrence: args.series_id must be a non-empty string");
        }
        const rid = validateRecurrenceId(args.recurrence_id, "update_occurrence");
        const rawPatch = args.patch;
        if (rawPatch === null || typeof rawPatch !== "object" || Array.isArray(rawPatch)) {
          fail("update_occurrence: args.patch must be an object");
        }
        const patch = rawPatch as Record<string, unknown>;
        const unknown = Object.keys(patch).filter(
          (k) => !(OVERRIDE_FIELDS as readonly string[]).includes(k),
        );
        if (unknown.length > 0) {
          fail(
            `update_occurrence: unknown patch field(s): ${unknown.join(", ")} — ` +
              `allowed: ${OVERRIDE_FIELDS.join(", ")}`,
          );
        }
        if (Object.keys(patch).length === 0) {
          fail("update_occurrence: args.patch must set at least one field");
        }
        const clean: OverridePatch = {};
        if (patch.cancelled !== undefined) {
          if (typeof patch.cancelled !== "boolean") {
            fail("update_occurrence: patch.cancelled must be a boolean");
          }
          clean.cancelled = patch.cancelled;
        }
        for (const k of ["title", "start_wall", "end_wall", "tz_id"] as const) {
          const v = patch[k];
          if (v === undefined) continue;
          if (typeof v !== "string" || v.trim().length === 0) {
            fail(`update_occurrence: patch.${k} must be a non-empty string`);
          }
          clean[k] = v;
        }
        return core.updateOccurrence(args.series_id, rid, clean);
      }
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
          // DC-21 §3.4/D4: the shell registers mDNS on this port (and
          // re-registers goodbye-first on change).
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
    const req = JSON.parse(line) as {
      id?: unknown;
      op?: string;
      args?: Json;
      notification?: string;
    };
    // DC-21 §3.2(a): one-way notifications from Rust (no usable id, no
    // reply). Rust sends "id": null for notifications; anything null/absent
    // that carries a "notification" field is treated as one-way (pkg10 F2).
    // Currently only mdns_event; unknown notifications are logged and
    // dropped (fail-open, §6.1 Tier-1).
    if (req.id == null && typeof req.notification === "string") {
      if (req.notification === "mdns_event") {
        // The mdns dispatcher is registered by main() as a notification sink;
        // route through the dispatcher with a synthetic op name.
        void dispatcher("mdns_event", req.args ?? {});
      }
      return ""; // no reply line for notifications
    }
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
  // DC-20: the scheduler runtime handle is registered when main() wires the
  // runtime (below); update_settings live-applies S1-S3 through it.
  let schedulerHandle: ReturnType<typeof startSchedulerRuntime> | null = null;
  const combined: Dispatcher = (op, args) =>
    op === "update_settings"
      ? (() => {
          // DC-20 §7.1: live-apply scheduler settings (S1-S3). The Rust
          // shell has already persisted config.toml and clamped; clamp
          // again here (defence in depth) via Scheduler.updateSettings.
          if (schedulerHandle === null) {
            throw new Error("scheduler runtime not started");
          }
          const partial: Record<string, number> = {};
          for (const key of [
            "sync_debounce_seconds",
            "sweep_interval_minutes",
            "max_concurrent_sessions",
          ] as const) {
            const v = (args as Record<string, unknown>)[key];
            if (typeof v === "number" && Number.isFinite(v)) {
              partial[key] = v;
            }
          }
          schedulerHandle.updateSchedulerSettings(partial);
          return { applied: true, next_start_only: "max_incremental_backlog" };
        })()
      : op.startsWith("sync_") || op === "device_info" ||
    op === "pairing_offer" || op === "pairing_accept" ||
    op === "cancel_pairing_offer" ||
    op === "list_quarantine" || op === "quarantine_stats" ||
    op === "retry_quarantine" || op === "delete_quarantine" ||
    op === "peer_state" || op === "list_paired_devices" ||
    op === "reset_peer_state" || op === "unblock_peer"
      ? syncDispatch(op, args)
      : dispatch(op, args);
  // DC-21 §3.2/D2: the ONE endpoint cache (sidecar-side, in-memory, keyed by
  // instance_name). Fed by `mdns_event` pushes from Rust; seeded once at
  // startup by `mdns_snapshot`. Never persisted (§7 privacy).
  const endpointCache = new EndpointCache();
  // DC-21 §3.3/D3 prefilter source: paired, trusted peer device ids.
  const pairedDeviceIds = (): string[] =>
    listTrustedPeers(core.db).map((p) => p.device_id);
  const expectedPrefixes = (): Map<string, string> => {
    const map = new Map<string, string>();
    for (const deviceId of pairedDeviceIds()) {
      map.set(instancePrefix(deviceId), deviceId);
    }
    return map;
  };
  const combinedWithMdns: Dispatcher = (op, args) => {
    if (op === "mdns_event") {
      // DC-21 §3.2(a): push notification, one per browse transition.
      // Prefilter by instance prefix (D3): non-paired instances are dropped
      // here — sidecar-local, in-memory only, never logged above debug.
      const e = args as unknown as MdnsEvent;
      if (
        (e.kind !== "added" && e.kind !== "removed") ||
        typeof e.instance_name !== "string" ||
        typeof e.host !== "string" ||
        typeof e.port !== "number"
      ) {
        console.error("[tide] mdns_event: malformed event ignored");
        return { applied: false };
      }
      const deviceId = matchInstanceToPeer(e.instance_name, pairedDeviceIds());
      if (deviceId === undefined) {
        // Non-paired discovery result: ignored silently (privacy §7).
        return { applied: false };
      }
      endpointCache.applyEvent(e, deviceId);
      return { applied: true };
    }
    if (op === "mdns_snapshot") {
      // DC-21 §3.2(b): one-shot cache seed at sidecar start (§5.1/§6.3).
      // Rust returns its current browse cache; entries are prefiltered here.
      const entries = (args as { entries?: Array<Omit<MdnsEvent, "kind">> })
        .entries;
      if (!Array.isArray(entries)) {
        // §6.1: mdns unavailable/failed — explicit empty result; the sidecar
        // never guesses why (INVARIANT 12). Falls back to last-known only.
        return { applied: 0, available: false };
      }
      const applied = endpointCache.applySnapshot(entries, expectedPrefixes());
      return { applied, available: true };
    }
    return combined(op, args);
  };
  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    void handleLine(combinedWithMdns, trimmed).then((out) => {
      // DC-21 §3.2(a): notifications return "" — write nothing (an empty
      // stdout line would corrupt the request/response id correlation on
      // the Rust reader side).
      if (out !== "") process.stdout.write(out + "\n");
    });
  });
  // DC-13 §5/§7 runtime: timers drive the pure Scheduler (debounced push,
  // periodic sweep). DC-21 §4.3/D7: listPeers resolves each peer's endpoint
  // by precedence — live mDNS cache entry > last-known endpoint (peers
  // table) > skip with log. D6: successful sessions write last-known via
  // runEngineSession (dialEndpoint); failed dials write nothing (§6.2).
  // DC-22 §3.1/§3.2/§8: reminder engine — pure rebuild from local DB state,
  // evaluated on a 30s tick plus immediately at sidecar start (§3.2: nothing
  // persisted; restart rebuilds). Idempotency via deterministic schedule
  // keys + in-session delivered-once guard (D10); missed policy per D1;
  // delivery via the OS desktop notification service (D7), Tier-1 degraded
  // failures (§7.1/D11). Delivery is an EPHEMERAL LOCAL SIDE EFFECT (D9) —
  // nothing here ever enters the changelog.
  const deliveredReminderKeys = new Set<string>();
  // D1 on-time decision context (owner question 2026-09-04): epoch ms of the
  // previous tick, null until the second tick runs. rebuildSchedule uses it
  // to distinguish "fire moment passed while we were ticking" (on-time) from
  // "passed while down/suspended" (missed) — exact under arbitrary tick
  // delay, no grace constant. setInterval hands its callback no args, so the
  // timestamp is captured here before each tick runs.
  let lastTickMs: number | null = null;
  // pkg10 F5: bound the delivered set — prune keys older than 25h (no live
  // reminder key can predate that: future keys aren't in the set until
  // fired, and a fired key more than a day old can only re-derive if the
  // clock jumps BACKWARD more than a day, which D12's rebuild policy treats
  // as a fresh missed-surface anyway).
  const deliveredPrune = (): void => {
    const cutoff = Date.now() - 25 * 3_600_000;
    for (const key of deliveredReminderKeys) {
      const ms = Number(key.split("|")[2]);
      if (Number.isFinite(ms) && ms < cutoff) deliveredReminderKeys.delete(key);
    }
  };
  const reminderTick = (): void => {
    try {
      // Real events schema: timed events carry utc_start_ms/utc_end_ms (the
      // authoritative INSTANT — respects tz_id per DC-22 §5.1) plus wall
      // strings for labels; all-day events carry start_date/end_date
      // (midnight wall convention, local by definition).
      const baseEvents = core.db
        .prepare(
          `SELECT e.event_id AS entity_id, e.title,
                  e.utc_start_ms, e.utc_end_ms,
                  COALESCE(e.start_wall, e.start_date || 'T00:00') AS start_wall,
                  COALESCE(e.end_wall, e.end_date || 'T23:59')      AS end_wall,
                  e.all_day, e.all_day_reminder_time
           FROM events e`
        )
        .all() as never[];
      // Smoke-test fix (2026-09-03): expand each timed series into per-
      // occurrence synthetic rows so reminders fire for the OCCURRENCE the
      // reminder is due on — not just the base's first instant. All-day
      // series keep single-row semantics (D2: day-before fire, day-granular).
      // Window: 25h back (missed horizon, D1) to 1y forward — deterministic
      // and comfortably wider than any notify horizon. Overrides (moved/
      // retitled occurrences) apply via the same chip math the calendar uses.
      const events: never[] = [];
      const seriesRows = core.db
        .prepare(
          `SELECT s.series_id, s.base_event_id, s.recurrence_rule
           FROM series s`,
        )
        .all() as Array<{
        series_id: string;
        base_event_id: string;
        recurrence_rule: string;
      }>;
      const seriesByBase = new Map(seriesRows.map((s) => [s.base_event_id, s]));
      const now = Date.now();
      const WIN_LO = `${new Date(now - 25 * 3_600_000).getFullYear()}0101T000000`;
      for (const ev of baseEvents) {
        const row = seriesByBase.get((ev as { entity_id: string }).entity_id);
        const timed =
          (ev as { all_day: number }).all_day !== 1 &&
          (ev as { utc_start_ms: number | null }).utc_start_ms != null;
        if (!row || !timed) {
          events.push(ev);
          continue;
        }
        let occIds: string[] = [];
        try {
          occIds = expandOccurrences(
            {
              series_id: row.series_id,
              base_start_wall: (ev as { start_wall: string }).start_wall,
              tz_id: "local",
              recurrence_rule: row.recurrence_rule,
            },
            WIN_LO,
            `${new Date(now).getFullYear() + 1}1231T235959`,
          );
        } catch {
          events.push(ev); // expansion failure → base-row behavior (degraded)
          continue;
        }
        if (occIds.length === 0) {
          events.push(ev);
          continue;
        }
        const durMs =
          ((ev as { utc_end_ms: number }).utc_end_ms ?? 0) -
          (ev as { utc_start_ms: number }).utc_start_ms;
        for (const occId of occIds) {
          const startMs = msFromWallId(occId);
          events.push({
            ...(ev as Record<string, unknown>),
            entity_id: `${(ev as { entity_id: string }).entity_id}#${occId}`,
            utc_start_ms: startMs,
            utc_end_ms: startMs + Math.max(durMs, 0),
          } as never);
        }
      }
      const reminders = core.db
        .prepare(
          // DC-22 D5: disabled reminders (enabled = 0) are stored but INACTIVE
          // — the schedule engine never schedules them (NULL/1 = active).
          // updated_hlc feeds the late-configuration discard (reminder_engine).
          "SELECT member_id, entity_id, minutes_before, updated_hlc AS updated_hlc_ms FROM reminders WHERE enabled IS NULL OR enabled = 1",
        )
        .all() as never[];
      const schedule = rebuildSchedule(events, reminders, Date.now(), lastTickMs);
      deliveredPrune();
      // Smoke-test bug (2026-09-04, delegate investigation deleg_25c67eca):
      // filterDelivered only removes already-delivered keys — FUTURE fires
      // (fire_at_ms > now) passed straight through and were delivered on the
      // next 30s tick, then marked delivered, so the reminder NEVER fired at
      // its actual due time ("set 10min before, nothing at the time"). The
      // tick must deliver only fires that are DUE NOW; future ones stay in
      // the schedule and fire on a later tick.
      const due = filterDelivered(schedule, deliveredReminderKeys).filter(
        (f) => f.fire_at_ms <= Date.now(),
      );
      for (const fire of due) {
        // pkg10 F1: mark delivered ONLY on confirmed dispatch. A failed
        // delivery stays unmarked → §7.1 retry on the next rebuild tick.
        // Deleg_25c67eca recommendation: log every delivery outcome with the
        // schedule key — success AND failure. The eager-fire bug above was
        // undiagnosable for a day because delivery was fire-and-forget
        // silent; one observability line per dispatch makes the pipeline
        // auditable from the dev log alone.
        console.log(
          `[tide] reminder dispatch: key=${fire.key} missed=${fire.missed} title="${fire.title}"`,
        );
        deliverNotification(fire, (ok) => {
          if (ok) {
            markDelivered(deliveredReminderKeys, [fire]);
            console.log(`[tide] reminder delivered: key=${fire.key}`);
          } else {
            console.warn(
              `[tide] reminder delivery FAILED (will retry next tick): key=${fire.key}`,
            );
          }
        });
      }
    } catch (err) {
      // §7.4/D11: rebuild error logs, keeps previous state, retries next tick.
      console.error(
        "[tide] reminder rebuild failed (will retry):",
        err instanceof Error ? err.message : String(err),
      );
    }
  };
  // §3.2: initial rebuild immediately at start (missed policy D1 applies —
  // lastTickMs is null here, so anything already past its moment is by
  // definition "passed while not running" unless configured late).
  reminderTick();
  const reminderTimer = setInterval(() => {
    const started = Date.now();
    reminderTick();
    // Record THIS tick's start as the next tick's "previous tick" context.
    // (Started, not ended: a tick that overruns past a fire moment still
    // proves the engine was alive at that moment — the on-time test wants
    // the last moment we KNOW we were ticking, and tick start is exactly it.)
    lastTickMs = started;
  }, 30_000);
  void reminderTimer; // cleared implicitly at process exit

  const schedulerRuntime = startSchedulerRuntime({
    now: () => Date.now(),
    listPeers: () => {
      // pkg10 review F6: ONE query per decision pass, not N+1.
      const peers = listTrustedPeers(core.db);
      const byDevice = new Map(peers.map((p) => [p.device_id, p]));
      return peers.map((p) => ({
        deviceId: p.device_id,
        endpoint:
          resolveEndpoint(
            endpointCache,
            {
              deviceIds: () => peers.map((x) => x.device_id),
              lastKnown: (deviceId: string) => {
                const row = byDevice.get(deviceId);
                return row?.last_endpoint_host != null &&
                  row.last_endpoint_port != null &&
                  row.last_endpoint_seen != null
                  ? {
                      host: row.last_endpoint_host,
                      port: row.last_endpoint_port,
                      seen: row.last_endpoint_seen,
                    }
                  : null;
              },
            },
            p.device_id,
          )?.endpoint ?? null,
      }));
    },
    openSession: makeSessionOpener({
      privateKey: sync.identity.privateKey,
      runSession: (rawSession) => {
        // makeSessionOpener passes the InboundSession plus the deviceId the
        // scheduler attributed to the endpoint (SessionOpenerArgs.deviceId).
        const session = rawSession as InboundSession & { deviceId?: string };
        return sync.runEngineSession(session, session.deviceId);
      },
    }),
    log: (m: string) => console.error(`[tide] ${m}`),
  });
  // DC-20 §7.1: register the runtime handle so the update_settings op
  // (Rust shell, after an options-window Save) can live-apply S1-S3
  // without a restart.
  schedulerHandle = schedulerRuntime;
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
