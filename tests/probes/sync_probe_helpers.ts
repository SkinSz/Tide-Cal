// QA Agent 1 harness: headless multi-device sync probes + convergence oracle.
// READ-ONLY wrt production code; all artifacts under /tmp/tide-qa-sync/qa-tmp.
import { mkdirSync, writeFileSync } from "node:fs";

// noise-c.wasm registers process.on('unhandledRejection') -> process.exit(1)
// lazily (at wasm init), which kills the vitest worker on any late transport
// rejection. Re-assert a logging guard at fault-injection boundaries so probes
// observe faults instead of dying.
export function guardProcess(): void {
  const p = process as unknown as { removeAllListeners: (s: string) => void };
  p.removeAllListeners("unhandledRejection");
  process.on("unhandledRejection", (e) => {
    console.error("[qa] unhandledRejection:", String((e as Error)?.stack ?? e));
  });
  p.removeAllListeners("uncaughtException");
  process.on("uncaughtException", (e) => {
    console.error("[qa] uncaughtException:", String((e as Error)?.stack ?? e));
  });
}
import { join } from "node:path";
import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { loadOrCreateIdentity } from "../../src/network/sync_runtime.ts";
import type { FramedByteTransport } from "../../src/network/noise_transport.ts";
import {
  handshakeOverTransport,
  type RawSessionHandle,
} from "../../src/network/noise_transport.ts";
import {
  PairingSession,
  freshNonce,
  type PairingPayload,
} from "../../src/security/pairing.ts";
import { sqlPeerStore } from "../../src/network/pairing_manager.ts";
import { makeEntityMutator } from "../../src/persistence/bridges/sync_service.ts";
import { createSyncEngine } from "../../src/sync/sync_engine.ts";
import { EventCore } from "../../src/persistence/bridges/event_core.ts";
import type { SyncTransport } from "../../src/sync/sync_engine.ts";

export const QA_TMP = join("/tmp", "tide-probe-qa", "qa-tmp");
export const RESULTS_DIR = join(QA_TMP, "results");

export interface Device {
  tag: string;
  dir: string;
  core: EventCore;
  db: Database.Database;
  identity: ReturnType<typeof loadOrCreateIdentity>;
}

let runCounter = 0;

export function makeDevice(tag: string): Device {
  runCounter++;
  const dir = join(QA_TMP, "devices", `${process.pid}-${tag}-${runCounter}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  const identity = loadOrCreateIdentity(dir);
  const core = new EventCore(join(dir, "tide.db"), identity.deviceId);
  return { tag, dir, core, db: core.db as Database.Database, identity };
}

// --- in-memory frame pipe (same semantics as the TCP runtime carrier) ---
function pipePair(): [FramedByteTransport, FramedByteTransport] {
  interface End {
    queue: Uint8Array[];
    waiter: ((f: Uint8Array | null) => void) | null;
    peer?: End;
  }
  const make = (): End => ({ queue: [], waiter: null });
  const x = make();
  const y = make();
  x.peer = y;
  y.peer = x;
  const wrap = (self: End): FramedByteTransport => ({
    async send(frame) {
      const p = self.peer!;
      if (p.waiter) {
        const w = p.waiter;
        p.waiter = null;
        w(frame);
      } else p.queue.push(frame);
    },
    async receive() {
      const next = self.queue.shift();
      if (next !== undefined) return next;
      return new Promise<Uint8Array | null>((resolve) => {
        self.waiter = resolve;
      });
    },
  });
  return [wrap(x), wrap(y)];
}

/** Pair two devices over an encrypted in-memory carrier (full DC-05 flow). */
export async function pairDevices(a: Device, b: Device): Promise<void> {
  const [innerA, innerB] = pipePair();
  const [rawA, rawB] = (await Promise.all([
    handshakeOverTransport("initiator", innerA, a.identity.privateKey),
    handshakeOverTransport("responder", innerB, b.identity.privateKey),
  ])) as [RawSessionHandle, RawSessionHandle];

  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const jsonOf = (raw: RawSessionHandle) => ({
    async send(o: unknown) {
      raw.outbound.push(
        raw.sendCipher.EncryptWithAd(new Uint8Array(0), enc.encode(JSON.stringify(o))),
      );
    },
    async receive() {
      const f = await raw.inbound.receive();
      if (f === null) throw new Error("closed");
      return JSON.parse(dec.decode(raw.receiveCipher.DecryptWithAd(new Uint8Array(0), f)));
    },
  });
  const payloadFor = (d: Device): PairingPayload => ({
    v: 1,
    device_id: d.identity.deviceId,
    public_key: Buffer.from(d.identity.publicKey).toString("base64"),
    nonce: Buffer.from(freshNonce()).toString("base64"),
  });

  const jA = jsonOf(rawA);
  const jB = jsonOf(rawB);
  const localA = payloadFor(a);
  const localB = payloadFor(b);
  const [, , remoteForA, remoteForB] = (await Promise.all([
    jA.send(localA),
    jB.send(localB),
    jA.receive(),
    jB.receive(),
  ])) as [void, void, PairingPayload, PairingPayload];

  const runCeremony = (self: Device, local: PairingPayload, remote: PairingPayload, raw: RawSessionHandle, remoteDeviceId: string) => {
    const ps = new PairingSession();
    ps.exchangePayloads(local, remote);
    ps.bindTranscript(raw.handshakeHash());
    ps.verifyRemoteStatic(raw.remoteStaticKey());
    const safety = ps.displaySafetyNumber();
    ps.confirmSafetyNumber(safety, safety);
    ps.storeTrust(() =>
      sqlPeerStore(self.db as never).store({
        deviceId: remoteDeviceId,
        publicKey: Buffer.from(remote.public_key, "base64"),
        displayName: remote.device_id.slice(0, 10),
        pairedAtMs: Date.now(),
      }),
    );
    return safety;
  };
  const sB = runCeremony(b, localB, remoteForB, rawB, a.identity.deviceId);
  const sA = runCeremony(a, localA, remoteForA, rawA, b.identity.deviceId);
  if (sA !== sB) throw new Error("safety number mismatch");
  rawA.sendCipher.free();
  rawA.receiveCipher.free();
  rawB.sendCipher.free();
  rawB.receiveCipher.free();
}

// --- message pipes for sync sessions ---
export interface MsgPipe {
  send(msg: unknown): Promise<void>;
  receive(): Promise<unknown>;
  close(): void;
  /** hooks for fault injection */
  sentLog: unknown[];
  dropNext?: boolean;
  closed: boolean;
}

export function msgPipePair(): [MsgPipe, MsgPipe] {
  interface End {
    queue: unknown[];
    waiter: ((m: unknown) => void) | null;
    closed: boolean;
    peer?: End;
  }
  const make = (): End => ({ queue: [], waiter: null, closed: false });
  const x = make();
  const y = make();
  x.peer = y;
  y.peer = x;
  const wrap = (self: End, sentLog: unknown[]): MsgPipe => ({
    sentLog,
    closed: false,
    async send(msg) {
      sentLog.push(msg);
      const p = self.peer!;
      if (p.closed) return;
      if (p.waiter) {
        const w = p.waiter;
        p.waiter = null;
        w(msg);
      } else p.queue.push(msg);
    },
    async receive() {
      const next = self.queue.shift();
      if (next !== undefined) return next;
      if (self.closed) return null;
      return new Promise((resolve) => {
        self.waiter = resolve;
      });
    },
    close() {
      self.closed = true;
      if (self.peer && self.peer.waiter) {
        const w = self.peer.waiter;
        self.peer.waiter = null;
        w(null);
      }
      if (self.waiter) {
        const w = self.waiter;
        self.waiter = null;
        w(null);
      }
    },
  });
  return [wrap(x, []), wrap(y, [])];
}

export interface SessionOpts {
  /** called per message before delivery; return false to drop it */
  filter?: (msg: unknown, dir: "from" | "to") => boolean;
  /** ignore errors from runSession instead of failing */
  tolerateError?: boolean;
  /** emulate abrupt peer death: close both pipes after this many ms */
  abortAfterMs?: number;
}

/**
 * Run one anti-entropy session from->to over in-memory pipes (engine on BOTH
 * ends — bidirectional pull/serve like the real runtime).
 */
export async function sessionOnce(
  from: Device,
  to: Device,
  opts: SessionOpts = {},
): Promise<{ fromStats: Record<string, number>; toStats: Record<string, number>; error?: string; fromLog: unknown[] }> {
  const [tFromRaw, tToRaw] = msgPipePair();
  const mkT = (raw: MsgPipe, dir: "from" | "to") => ({
    async send(msg: unknown) {
      if (opts.filter && !opts.filter(msg, dir)) return;
      await raw.send(msg);
    },
    async receive() {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const m = await raw.receive();
        if (m === null) return null;
        if (opts.filter && !opts.filter(m, dir)) continue;
        return m;
      }
    },
  });
  const engFrom = createSyncEngine({
    db: from.db,
    selfDeviceId: from.identity.deviceId,
    mutateEntity: makeEntityMutator(),
  });
  const engTo = createSyncEngine({
    db: to.db,
    selfDeviceId: to.identity.deviceId,
    mutateEntity: makeEntityMutator(),
  });
  let fromStats: Record<string, number> = {};
  let toStats: Record<string, number> = {};
  let error: string | undefined;
  let abortTimer: ReturnType<typeof setTimeout> | undefined;
  if (opts.abortAfterMs !== undefined) {
    guardProcess();
    abortTimer = setTimeout(() => {
      tFromRaw.close();
      tToRaw.close();
    }, opts.abortAfterMs);
  }
  const runF = engFrom
    .runSession(mkT(tFromRaw, "from") as never)
    .then(
      (st) => {
        fromStats = st as never;
        tToRaw.close();
      },
      (e) => {
        error = String(e);
        tToRaw.close();
        if (!opts.tolerateError) throw e;
      },
    );
  const runT = engTo.runSession(mkT(tToRaw, "to") as never).then(
    (st) => {
      toStats = st as never;
      tFromRaw.close();
    },
    (e) => {
      error = error ?? String(e);
      tFromRaw.close();
      if (!opts.tolerateError) throw e;
    },
  );
  await Promise.allSettled([runF, runT]);
  if (abortTimer !== undefined) clearTimeout(abortTimer);
  return { fromStats, toStats, error, fromLog: tFromRaw.sentLog };
}

// ---------------- convergence oracle ----------------

export interface Fingerprint {
  calendars: unknown[];
  events: unknown[];
  series: unknown[];
  occurrence_overrides: unknown[];
  digest: string;
}

/** Normalized semantic state; excludes ALL sync bookkeeping. */
export function fingerprint(db: Database.Database): Fingerprint {
  const calendars = db
    .prepare("SELECT calendar_id,title,color FROM calendars ORDER BY calendar_id")
    .all();
  const events = db
    .prepare(
      `SELECT event_id,calendar_id,title,description,all_day,start_date,end_date,
              start_wall,end_wall,tz_id,utc_start_ms,utc_end_ms
       FROM events ORDER BY event_id`,
    )
    .all();
  const series = db
    .prepare("SELECT series_id,base_event_id,recurrence_rule FROM series ORDER BY series_id")
    .all();
  const oo = db
    .prepare(
      "SELECT series_id,recurrence_id,cancelled,title,start_wall,end_wall,tz_id,utc_start_ms,utc_end_ms FROM occurrence_overrides ORDER BY series_id,recurrence_id",
    )
    .all();
  const body = { calendars, events, series, occurrence_overrides: oo };
  return { ...body, digest: sha(body) };
}

export function sha(x: unknown): string {
  return createHash("sha256").update(JSON.stringify(x)).digest("hex").slice(0, 16);
}

export interface ConvergenceResult {
  converged: boolean;
  digests: Record<string, string>;
  detail?: string;
}

export function oracle(devices: Device[]): ConvergenceResult {
  const fps = devices.map((d) => ({ tag: d.tag, fp: fingerprint(d.db) }));
  const digests: Record<string, string> = {};
  for (const { tag, fp } of fps) digests[tag] = fp.digest;
  const first = fps[0]!.fp;
  for (const { tag, fp } of fps) {
    for (const k of ["calendars", "events", "series", "occurrence_overrides"] as const) {
      if (JSON.stringify(fp[k]) !== JSON.stringify(first[k])) {
        return {
          converged: false,
          digests,
          detail: `table ${k} differs: ${JSON.stringify(first[k])} vs ${JSON.stringify(fp[k])} (${tag})`,
        };
      }
    }
  }
  return { converged: true, digests };
}

/** Symmetric convergence round-robin: each ordered pair gets one session. */
export async function convergeRound(devices: Device[], opts: SessionOpts = {}): Promise<void> {
  for (const a of devices) {
    for (const b of devices) {
      if (a === b) continue;
      await sessionOnce(a, b, opts);
    }
  }
}

// ---------------- state dump for evidence ----------------

export function dumpState(tag: string, d: Device): Record<string, unknown> {
  const q = (sql: string) => d.db.prepare(sql).all();
  return {
    tag,
    fingerprint: fingerprint(d.db),
    counts: {
      changes: (q("SELECT COUNT(*) c FROM changes")[0] as { c: number }).c,
      pending: (q("SELECT COUNT(*) c FROM pending_changes")[0] as { c: number }).c,
      quarantine: (q("SELECT COUNT(*) c FROM quarantine")[0] as { c: number }).c,
      skipped: (q("SELECT COUNT(*) c FROM skipped_seqs")[0] as { c: number }).c,
      conflicts: (q("SELECT COUNT(*) c FROM conflicts")[0] as { c: number }).c,
      tombstones: (q("SELECT COUNT(*) c FROM entities_tombstones")[0] as { c: number }).c,
    },
    applied_upto: q("SELECT producer_device_id, applied_through FROM applied_upto"),
    device_clock: q("SELECT peer_device_id, max_seq FROM device_clock"),
  };
}

export function saveResult(name: string, data: unknown): void {
  // Best-effort evidence dump: tests must never fail because evidence
  // persistence does (read-only FS, sandbox, etc.).
  try {
    mkdirSync(RESULTS_DIR, { recursive: true });
    writeFileSync(join(RESULTS_DIR, `${name}.json`), JSON.stringify(data, null, 2));
  } catch (e) {
    console.warn(`[probe] saveResult(${name}) skipped:`, String(e).slice(0, 120));
  }
}

export { createSyncEngine, makeEntityMutator };
export type SyncTransportT = SyncTransport;
