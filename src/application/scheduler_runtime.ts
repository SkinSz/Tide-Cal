// Tide DC-13 §5/§7 — scheduler RUNTIME wrapper (the thin timer layer).
//
// The decision logic lives in src/application/scheduler.ts (PURE, tested by
// tests/scheduler.test.ts). This module owns the real timers and translates
// Scheduler decisions into real sync sessions:
//
//   immediate-sync / push -> open engine sessions to paired peers, reusing
//     EXACTLY the sidecar's sync_now internals (connectSync + Noise handshake
//     bounded by withTimeout/SYNC_CONNECT_TIMEOUT_MS + SyncManager
//     .runEngineSession) — imported, not duplicated.
//   sweep  -> DELIBERATELY UNWIRED (standing constraint until the compaction
//     feature ships): scheduler may emit sweep actions; this runtime NO-OPs
//     them with a log line.
//   noop   -> nothing.
//
// Defaults per DC-13 §3.5: debounce 10s, sweep 10min, maxConcurrent 3.
// Backoff per DC-13 §6.1 (implemented in Scheduler); a manual trigger passes
// manualSyncBypassesBackoff=true (explicit human intent wins).
//
// WIRING STATUS (DC-13 runtime, this milestone): `startSchedulerRuntime()` is
// EXPORTED but NOT yet called from the sidecar's main() — sidecar_server.ts
// is under concurrent ownership (conflict-RPC work) and the 3-line startup
// call was deliberately deferred rather than collide with it. Wiring is a
// single guarded call at the end of sidecar main(): see startSchedulerRuntime.
//
// Endpoint note (honest v1): the DC-07 peers table stores NO host/port, and
// mDNS browse results are not yet plumbed into the sidecar. `listPeers`
// therefore supplies endpoints from whatever source the embedder has (v1
// production wiring: none yet — endpoints arrive with DC-11 wiring). Peers
// without an endpoint are skipped with a log line, never dialed blindly.

import {
  Scheduler,
  SWEEP_MINUTES_DEFAULT,
  type SchedulerSettings,
  type SyncDecision,
} from "./scheduler.ts";
import {
  SYNC_CONNECT_TIMEOUT_MS,
  withTimeout,
} from "../persistence/bridges/sidecar_server.ts";
import { connectSync } from "../network/sync_runtime.ts";

export interface PeerEndpoint {
  host: string;
  port: number;
}

export interface RuntimePeer {
  deviceId: string;
  /** null = no known endpoint (skipped with a log line, DC-11 wiring pending). */
  endpoint: PeerEndpoint | null;
}

export interface SessionOpenerArgs {
  deviceId: string;
  endpoint: PeerEndpoint;
}

export interface SchedulerRuntimeDeps {
  /** Injected pure scheduler (tests may share one; runtime only consumes). */
  scheduler: Scheduler;
  /** Injected clock, milliseconds (same domain as the scheduler's). */
  now(): number;
  /** Paired peers + currently known endpoints. Called per decision pass. */
  listPeers(): RuntimePeer[];
  /**
   * Opens ONE engine session to the peer. MUST throw or resolve false on
   * failure; the runtime maps either to scheduler.endSession(peer, false)
   * (exponential backoff, DC-13 §6.1).
   */
  openSession(args: SessionOpenerArgs): Promise<boolean>;
  /** Session-lifecycle observation hooks (tray SYNCING state, logs). */
  onSessionStart?(deviceId: string): void;
  onSessionEnd?(deviceId: string, success: boolean): void;
  log?(message: string): void;
}

const defaultLog = (message: string): void => {
  console.log(`[tide-scheduler] ${message}`);
};

/**
 * Production session opener: the SAME connect/handshake/session path the
 * sidecar's sync_now op runs (sidecar_server.ts case "sync_now"), reused via
 * its exported withTimeout/SYNC_CONNECT_TIMEOUT_MS + connectSync + the
 * SyncManager's engine session. Injected `runSession` is
 * SyncManager.runEngineSession bound to the live manager.
 */
export function makeSessionOpener(deps: {
  privateKey: Uint8Array;
  runSession: (session: unknown) => Promise<unknown>;
}): (args: SessionOpenerArgs) => Promise<boolean> {
  return async ({ deviceId, endpoint }) => {
    const session = await withTimeout(
      connectSync(deps.privateKey, endpoint.host, endpoint.port),
      SYNC_CONNECT_TIMEOUT_MS,
      `sync connect timed out waiting for peer ${endpoint.host}:${endpoint.port} ` +
        `(no TCP connect / Noise handshake within ${SYNC_CONNECT_TIMEOUT_MS}ms)`,
    );
    // DC-21 D6: the session records WHICH endpoint it dialed, so a successful
    // authenticated session can persist that endpoint as last-known. The
    // deviceId rides along for the D3 post-handshake identity check.
    (session as unknown as { dialEndpoint?: { host: string; port: number }; deviceId?: string }).dialEndpoint =
      { host: endpoint.host, port: endpoint.port };
    (session as unknown as { dialEndpoint?: { host: string; port: number }; deviceId?: string }).deviceId =
      deviceId;
    await deps.runSession(session);
    return true;
  };
}

export class SchedulerRuntime {
  private readonly scheduler: Scheduler;
  private readonly deps: SchedulerRuntimeDeps;
  private readonly log: (m: string) => void;

  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(deps: SchedulerRuntimeDeps) {
    this.deps = deps;
    this.scheduler = deps.scheduler;
    this.log = deps.log ?? defaultLog;
  }

  // ------------------------------------------------------------------
  // Lifecycle
  // ------------------------------------------------------------------

  start(): void {
    if (this.running) return;
    this.running = true;
    const sweepMinutes = this.scheduler.getSettings().sweepMinutes ?? SWEEP_MINUTES_DEFAULT;
    this.sweepTimer = setInterval(() => {
      this.consume(this.scheduler.onSweepTick(), { manual: false });
    }, sweepMinutes * 60_000);
    this.log(`runtime started (sweep every ${sweepMinutes}min; sweep is UNWIRED/no-op)`);
  }

  stop(): void {
    this.running = false;
    if (this.debounceTimer !== null) clearTimeout(this.debounceTimer);
    this.debounceTimer = null;
    if (this.sweepTimer !== null) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
  }

  get isRunning(): boolean {
    return this.running;
  }

  // ------------------------------------------------------------------
  // Trigger events (DC-13 §3.1) — thin timers over pure decisions
  // ------------------------------------------------------------------

  /** Local change applied: (re)arm the debounce timer (every change restarts). */
  onLocalChange(): void {
    const decision = this.scheduler.onLocalChange();
    if (this.debounceTimer !== null) clearTimeout(this.debounceTimer);
    const delay = Math.max(0, decision.fireAtMs - this.deps.now());
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      const availablePeers = this.deps
        .listPeers()
        .filter((p) => p.endpoint !== null)
        .map((p) => p.deviceId);
      this.consume(this.scheduler.onDebounceFired(availablePeers), { manual: false });
    }, delay);
  }

  /**
   * Manual "Sync now" (tray menu / toolbar, DC-19 §4.2): immediate-sync with
   * manualSyncBypassesBackoff=true. NOT debounced.
   */
  manualSyncNow(): void {
    this.consume({ action: "immediate-sync" }, { manual: true });
  }

  /** Exposed for tests/embedders that drive decisions directly. */
  consume(decision: SyncDecision, opts: { manual: boolean }): void {
    switch (decision.action) {
      case "noop":
        return;
      case "sweep":
        // Standing constraint: the sweep stays UNWIRED until the compaction
        // feature ships. The scheduler may emit sweep actions; the runtime
        // must not wire them. Log and do nothing.
        this.log("sweep action received: UNWIRED (compaction feature pending) — no-op");
        return;
      case "immediate-sync":
        for (const peer of this.deps.listPeers()) {
          void this.attempt(peer, opts.manual);
        }
        return;
      case "push": {
        const wanted = new Set(decision.peers);
        for (const peer of this.deps.listPeers()) {
          if (wanted.has(peer.deviceId)) void this.attempt(peer, opts.manual);
        }
        return;
      }
    }
  }

  // ------------------------------------------------------------------
  // Session lifecycle (§4.1 one session per peer, §4.2 concurrency cap)
  // ------------------------------------------------------------------

  private async attempt(peer: RuntimePeer, manual: boolean): Promise<void> {
    if (peer.endpoint === null) {
      this.log(`peer ${peer.deviceId}: no endpoint known (DC-11 wiring pending) — skipped`);
      return;
    }
    const ok = this.scheduler.tryBeginSession(peer.deviceId, {
      manualSyncBypassesBackoff: manual,
    });
    if (!ok) {
      this.log(
        `peer ${peer.deviceId}: session not started ` +
          `(active / backoff / concurrency cap${manual ? "; manual bypass did not apply" : ""})`,
      );
      return;
    }
    this.deps.onSessionStart?.(peer.deviceId);
    let success = false;
    try {
      success = await this.deps.openSession({
        deviceId: peer.deviceId,
        endpoint: peer.endpoint,
      });
    } catch (err) {
      this.log(
        `peer ${peer.deviceId}: session failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      success = false;
    } finally {
      this.scheduler.endSession(peer.deviceId, success);
      this.deps.onSessionEnd?.(peer.deviceId, success);
    }
    this.log(
      `peer ${peer.deviceId}: session ${success ? "succeeded" : "failed"}` +
        (success ? "" : " — exponential backoff armed (DC-13 §6.1)"),
    );
  }
}

export interface SchedulerRuntimeHandle {
  scheduler: Scheduler;
  runtime: SchedulerRuntime;
  manualSyncNow(): void;
  onLocalChange(): void;
  stop(): void;
  /**
   * DC-20 §7.1 live-apply: clamp+apply partial scheduler settings. The
   * runtime restarts its timers so the new intervals take effect without
   * an app restart (in-flight sessions are unaffected). Clamped to DC-13
   * §3.5 bounds by Scheduler.updateSettings.
   */
  updateSchedulerSettings(partial: Partial<SchedulerSettings>): void;
}

/**
 * Factory used by the sidecar main() (wiring deferred — see header note).
 * `settings` fall back to the DC-13 §3.5 defaults and clamp to bounds.
 */
export function startSchedulerRuntime(deps: {
  now(): number;
  listPeers(): RuntimePeer[];
  openSession(args: SessionOpenerArgs): Promise<boolean>;
  onSessionStart?(deviceId: string): void;
  onSessionEnd?(deviceId: string, success: boolean): void;
  log?(message: string): void;
  settings?: Partial<SchedulerSettings>;
}): SchedulerRuntimeHandle {
  const scheduler = new Scheduler({ now: deps.now, settings: deps.settings });
  const runtime = new SchedulerRuntime({ ...deps, scheduler });
  runtime.start();
  return {
    scheduler,
    runtime,
    manualSyncNow: () => runtime.manualSyncNow(),
    onLocalChange: () => runtime.onLocalChange(),
    stop: () => runtime.stop(),
    // DC-20 §7.1: live-apply — stop (clears timers), update the Scheduler's
    // clamped settings, restart (rebuilds the sweep interval timer; the
    // debounce timer is only armed by the next local change). In-flight
    // sessions are unaffected (beginSession/endSession bookkeeping lives in
    // the Scheduler, not the timers).
    updateSchedulerSettings: (partial) => {
      runtime.stop();
      scheduler.updateSettings(partial);
      runtime.start();
      const s = scheduler.getSettings();
      deps.log?.(
        `settings live-applied (debounce=${s.debounceSeconds}s, sweep=${s.sweepMinutes}min, maxConcurrent=${s.maxConcurrentSessions})`,
      );
    },
  };
}
