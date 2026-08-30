// Pkg1 regression harness (QA C-1): compaction × full-state snapshot.
// Ported from the QA probe harness (qa-tmp/probes/helpers.ts) patterns —
// in-memory message pipes, engine-on-both-ends sessions, plus an
// INDEPENDENT expected-state oracle: the expected semantic state is computed
// by the test driver from its own operation log, never from
// buildSnapshot/applySnapshot/sweep outputs (see
// docs/qa/remediation/pkg1-diagnosis.md §6/§8).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { loadOrCreateIdentity } from "../src/network/sync_runtime.ts";
import { makeEntityMutator } from "../src/persistence/bridges/sync_service.ts";
import { createSyncEngine } from "../src/sync/sync_engine.ts";
import { EventCore, type CalendarEvent } from "../src/persistence/bridges/event_core.ts";
import { sweep, type SweepStats } from "../src/sync/compaction.ts";
import { createHash } from "node:crypto";

let runCounter = 0;

export interface Device {
  tag: string;
  dir: string;
  core: EventCore;
  db: Database.Database;
  identity: ReturnType<typeof loadOrCreateIdentity>;
}

export function makeDevice(tag: string): Device {
  runCounter++;
  const dir = mkdtempSync(join(tmpdir(), `tide-pkg1-${process.pid}-${tag}-${runCounter}-`));
  const identity = loadOrCreateIdentity(dir);
  const core = new EventCore(join(dir, "tide.db"), identity.deviceId);
  return { tag, dir, core, db: core.db as Database.Database, identity };
}

/** Restart a device: close the DB and reopen it under the same identity. */
export function restartDevice(d: Device): Device {
  d.core.db.close();
  const core = new EventCore(join(d.dir, "tide.db"), d.identity.deviceId);
  return { ...d, core, db: core.db as Database.Database };
}

export function closeDevices(devices: Device[]): void {
  for (const d of devices) {
    try {
      d.core.db.close();
    } catch {
      /* already closed */
    }
  }
}

// --- in-memory message pipes (same semantics as the probe harness) ---
export interface MsgPipe {
  send(msg: unknown): Promise<void>;
  receive(): Promise<unknown>;
  close(): void;
  sentLog: unknown[];
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

/** One anti-entropy session from->to, engine on BOTH ends. */
export async function sessionOnce(
  from: Device,
  to: Device,
): Promise<{ fromStats: Record<string, number>; toStats: Record<string, number>; fromLog: unknown[] }> {
  const [pFrom, pTo] = msgPipePair();
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
  const runF = engFrom
    .runSession(pFrom as never)
    .then((st) => {
      fromStats = st as never;
      pTo.close();
    })
    .catch((e) => {
      pTo.close();
      throw e;
    });
  const runT = engTo
    .runSession(pTo as never)
    .then((st) => {
      toStats = st as never;
      pFrom.close();
    })
    .catch((e) => {
      pFrom.close();
      throw e;
    });
  await Promise.allSettled([runF, runT]);
  return { fromStats, toStats, fromLog: pFrom.sentLog };
}

/** Symmetric round-robin: one session per ordered device pair. */
export async function convergeRound(devices: Device[]): Promise<void> {
  for (const a of devices) {
    for (const b of devices) {
      if (a === b) continue;
      await sessionOnce(a, b);
    }
  }
}

/** DC-06 sweep on `target` with constraint set = all other devices. */
export function sweepOn(target: Device, others: Device[]): SweepStats {
  const lastKnownClock: Record<string, Record<string, number>> = {};
  for (const p of others) {
    const rows = p.db
      .prepare(
        "SELECT producer_device_id d, applied_through s FROM applied_upto",
      )
      .all() as Array<{ d: string; s: number }>;
    lastKnownClock[p.identity.deviceId] = Object.fromEntries(
      rows.map((r) => [r.d, r.s]),
    );
  }
  return sweep({
    db: target.db,
    selfDeviceId: target.identity.deviceId,
    lastKnownClock,
    constraintSet: others.map((o) => o.identity.deviceId),
  });
}

// ---------------------------------------------------------------------------
// Independent expected-state oracle (pkg1-diagnosis.md §8)
// ---------------------------------------------------------------------------

export interface ExpectedEvent {
  title: string;
  description: string;
  startMs: number;
  endMs: number;
  allDay: boolean;
}

/**
 * Expected semantic state, maintained by the DRIVER from its own operation
 * log. Sequential mutation semantics: every mutation is followed by a
 * convergence barrier, so no conflict resolution is involved.
 */
export class ExpectedState {
  /** event_id -> current fields */
  readonly events = new Map<string, ExpectedEvent>();
  /** ids deleted via the driver's delete op (must be absent everywhere) */
  readonly deleted: string[] = [];
  /** event ids in creation order (for deterministic iteration) */
  readonly order: string[] = [];

  create(ev: CalendarEvent): void {
    this.events.set(ev.id, {
      title: ev.title,
      description: ev.description,
      startMs: ev.startMs,
      endMs: ev.endMs,
      allDay: ev.allDay,
    });
    this.order.push(ev.id);
  }

  update(ev: CalendarEvent): void {
    this.events.set(ev.id, {
      title: ev.title,
      description: ev.description,
      startMs: ev.startMs,
      endMs: ev.endMs,
      allDay: ev.allDay,
    });
  }

  delete(id: string): void {
    this.events.delete(id);
    this.deleted.push(id);
  }
}

export interface SemanticRow {
  event_id: string;
  calendar_id: string;
  title: string;
  description: string;
  all_day: number;
  start_date: string | null;
  end_date: string | null;
  start_wall: string | null;
  end_wall: string | null;
  tz_id: string | null;
  utc_start_ms: number | null;
  utc_end_ms: number | null;
}

/** Normalized semantic rows for one device (excludes sync bookkeeping). */
export function semanticEvents(db: Database.Database): Map<string, SemanticRow> {
  const rows = db
    .prepare(
      `SELECT event_id, calendar_id, title, description, all_day, start_date,
              end_date, start_wall, end_wall, tz_id, utc_start_ms, utc_end_ms
       FROM events ORDER BY event_id`,
    )
    .all() as SemanticRow[];
  return new Map(rows.map((r) => [r.event_id, r]));
}

function rowMatchesExpected(
  row: SemanticRow,
  exp: ExpectedEvent,
): string | null {
  if (row.title !== exp.title) return `title ${row.title} != ${exp.title}`;
  if (row.description !== exp.description)
    return `description ${row.description} != ${exp.description}`;
  if (row.all_day !== (exp.allDay ? 1 : 0)) return `all_day mismatch`;
  if (row.utc_start_ms !== exp.startMs)
    return `utc_start_ms ${row.utc_start_ms} != ${exp.startMs}`;
  if (row.utc_end_ms !== exp.endMs)
    return `utc_end_ms ${row.utc_end_ms} != ${exp.endMs}`;
  if (exp.allDay) {
    if (row.start_date === null || row.end_date === null)
      return `all-day row missing date columns`;
  } else {
    if (row.start_wall === null || row.end_wall === null || row.tz_id === null)
      return `timed row missing wall/tz columns`;
    if (row.start_date !== null || row.end_date !== null)
      return `timed row has date columns`;
  }
  return null;
}

export interface OracleResult {
  ok: boolean;
  detail: string;
}

/**
 * Assert BOTH: (a) every device's semantic state equals Expected, and
 * (b) all devices pairwise equal (convergence). Expected is computed
 * independently of the implementation under test.
 */
export function assertAgainstOracle(
  expected: ExpectedState,
  devices: Device[],
): OracleResult {
  // (a) semantic correctness per device
  for (const d of devices) {
    const actual = semanticEvents(d.db);
    if (actual.size !== expected.events.size) {
      return {
        ok: false,
        detail: `${d.tag}: event count ${actual.size} != expected ${expected.events.size}`,
      };
    }
    for (const [id, exp] of expected.events) {
      const row = actual.get(id);
      if (!row) return { ok: false, detail: `${d.tag}: missing event ${id}` };
      const mismatch = rowMatchesExpected(row, exp);
      if (mismatch) return { ok: false, detail: `${d.tag}: ${id}: ${mismatch}` };
    }
    for (const id of expected.deleted) {
      if (actual.has(id))
        return { ok: false, detail: `${d.tag}: deleted event ${id} resurrected` };
    }
  }
  // (b) pairwise convergence (independent digest per device)
  const digests = new Map<string, string>();
  for (const d of devices) {
    const rows = [...semanticEvents(d.db).entries()].sort(([a], [b]) =>
      a < b ? -1 : 1,
    );
    digests.set(
      d.tag,
      createHash("sha256").update(JSON.stringify(rows)).digest("hex").slice(0, 16),
    );
  }
  const first = devices[0]!.tag;
  for (const [tag, digest] of digests) {
    if (digest !== digests.get(first)) {
      return { ok: false, detail: `digest mismatch ${tag} vs ${first}` };
    }
  }
  return { ok: true, detail: `${devices.length} peers == expected` };
}

export { makeEntityMutator, createSyncEngine };
