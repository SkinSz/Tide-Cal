// Delivery-order regression test (sync batch 1, item 1).
//
// WHAT THIS BUILDS
//   Three REAL devices (A, B, C): each is an EventCore (real SQLite database,
//   real change log, real applyRemoteChange / conflict detection / entity
//   mutator) and exchanges changes through the REAL sync engine
//   (createSyncEngine().runSession over the in-memory message pipes of
//   tests/probes/sync_probe_helpers.ts). No transport is invented here.
//
// TOPOLOGY (relay)
//   A -- B -- C. There is NO A<->C link. A's changes reach C only via B and
//   C's changes reach A only via B (B is a relay).
//
// WHAT A "DELIVERY STEP" IS
//   One engine pull session in which the destination device pulls ONE origin
//   device's change stream up to the sequence number produced by one scenario
//   operation: step = (dst <- src : origin @ operation). The sequence-position
//   pull per origin is how the protocol works, so any earlier sequence numbers
//   of that origin the destination still lacks travel in the same batch.
//   The harness restricts what a session may carry by rewriting the HELLO
//   clock the source advertises (only that origin, only up to that sequence)
//   and the destination advertises (nothing), so the engine itself requests
//   exactly that range. Everything else is the unmodified engine.
//
// WHAT IS ENUMERATED (exhaustively, per scenario)
//   Every ordering of the scenario's steps that is feasible, i.e. every linear
//   extension of: (1) operation preconditions (e.g. B edits only after B holds
//   the event; "concurrent" edits are made before either side receives the
//   other), and (2) relay preconditions (a source can only be pulled from for
//   a change it already holds). This covers: which device pulls from which, in
//   what order, relay hops, and the arrival order of dependent changes at C
//   (edit before create, etc.). The step counts per scenario are printed in
//   the test names and asserted not to exceed MAX_ORDERS.
//
// WHAT IS NOT ENUMERATED
//   - Each scenario starts from a fixed, unenumerated setup (every device's
//     bootstrap calendar change exchanged, and for S3/S4 the base event
//     created and fully synced). Seq-1 bootstrap changes are therefore not
//     part of the permutations.
//   - Batch splitting inside one origin's range, and interleaving of several
//     origins inside ONE session, are not enumerated (a step pulls one origin
//     up to one operation's sequence; each origin has at most one operation
//     per scenario after setup).
//   - Pull sessions run bidirectional engines but one direction is muted by
//     the HELLO rewrite; unfiltered full A<->B / B<->C sessions only occur in
//     the fixed setup, not as enumerated steps.
//   - Duplicate delivery, loss, restarts, snapshots/full-state.
//
// THE THREE CHECKS (reported as separate test cases per scenario and order set)
//   (a) change-set convergence: per device, the set of rows in `changes`,
//       keyed by (origin device_id, local_seq), compared with FULL content
//       (change_id, entity_id, entity_type, field_path, operation, payload,
//       hlc_timestamp, causality_clock, schema_version). Storage order
//       (rowid) is not compared.
//   (b) calendar-state convergence: materialized rows of calendars, events,
//       series, occurrence_overrides (tests/probes fingerprint(): semantic
//       columns only; created_hlc / updated_hlc and sync bookkeeping are
//       excluded as local-only).
//   (c) conflict convergence: per device, the set of conflicts keyed by
//       (entity_id, field_path) with status, resolved_value, and participants
//       (device_id, local_seq, causality_clock, payload). IGNORED as
//       local-only: conflicts.conflict_id (random UUID chosen by whichever
//       device detected it), conflict_participants.change_id is kept via
//       (device_id, local_seq) instead, detected_at_hlc and resolved_at_hlc
//       (local detection / resolution times).
//
// EXPECTED FAILURES use vitest test.fails and link to the owner's problem
// numbers (#1 dropped-but-acknowledged edits, #2 non-event types never written,
// #5 conflict contents depend on arrival order, #6-#10 resolution defects).
// Which checks are marked is determined empirically against cbce6a6; a check
// that passes there is a plain test.
import { afterAll, describe, expect, test } from "vitest";
import { rmSync } from "node:fs";
import {
  makeDevice,
  sessionOnce,
  fingerprint,
  guardProcess,
  type Device,
} from "./probes/sync_probe_helpers.ts";
import { createLocalChange } from "../src/persistence/database.ts";

guardProcess();

const MAX_ORDERS = 400;
type Dev = "A" | "B" | "C";
const DEVS: Dev[] = ["A", "B", "C"];

// ---------------------------------------------------------------- scenario model

interface World {
  d: Record<Dev, Device>;
  ctx: Record<string, string>;
  /** last own sequence number of each origin after each operation */
  seqAfter: Record<string, number>;
}

interface OpStep {
  kind: "op";
  id: string;
  by: Dev;
  /** step ids that must already have run */
  after: string[];
  run(w: World): void;
}
interface PullStep {
  kind: "pull";
  id: string;
  dst: Dev;
  /** operation whose origin stream is pulled up to that operation's last seq */
  op: string;
  after: string[];
}
type Step = OpStep | PullStep;

interface Scenario {
  name: string;
  setup(w: World): Promise<void>;
  steps: Step[];
  /** causally ordered (no concurrent changes to one item) */
  causal: boolean;
}

function srcFor(dst: Dev, origin: Dev): Dev {
  if (dst === origin) throw new Error("pull from self");
  return dst === "B" ? origin : "B";
}

function pull(dst: Dev, op: string, after: string[] = []): PullStep {
  return { kind: "pull", id: `${dst}<-${op}`, dst, op, after };
}

/** Enumerate every feasible ordering (abstract model, no database). */
function enumerateOrders(sc: Scenario): string[][] {
  const opBy = new Map(sc.steps.filter((s): s is OpStep => s.kind === "op").map((s) => [s.id, s.by]));
  const out: string[][] = [];
  const done = new Set<string>();
  const hold: Record<Dev, Set<string>> = { A: new Set(), B: new Set(), C: new Set() };
  const seq: string[] = [];
  const enabled = (s: Step): boolean => {
    if (done.has(s.id)) return false;
    if (!s.after.every((a) => done.has(a))) return false;
    if (s.kind === "op") return true;
    const origin = opBy.get(s.op)!;
    if (!done.has(s.op)) return false;
    return hold[srcFor(s.dst, origin)].has(s.op);
  };
  const rec = (): void => {
    if (seq.length === sc.steps.length) {
      out.push([...seq]);
      if (out.length > MAX_ORDERS) throw new Error(`${sc.name}: more than ${MAX_ORDERS} orders`);
      return;
    }
    for (const s of sc.steps) {
      if (!enabled(s)) continue;
      done.add(s.id);
      seq.push(s.id);
      let undo: () => void;
      if (s.kind === "op") {
        const by = opBy.get(s.id)!;
        hold[by].add(s.id);
        undo = () => hold[by].delete(s.id);
      } else {
        const had = hold[s.dst].has(s.op);
        hold[s.dst].add(s.op);
        undo = () => {
          if (!had) hold[s.dst].delete(s.op);
        };
      }
      rec();
      undo();
      seq.pop();
      done.delete(s.id);
    }
  };
  rec();
  return out;
}

// ---------------------------------------------------------------- real sessions

function maxOwnSeq(d: Device): number {
  const r = d.db
    .prepare("SELECT MAX(local_seq) m FROM changes WHERE device_id = ?")
    .get(d.identity.deviceId) as { m: number | null };
  return r.m ?? 0;
}

/** Full, unfiltered bidirectional session (fixed setup only). */
async function fullSession(a: Device, b: Device): Promise<void> {
  await sessionOnce(a, b);
}

/** dst pulls `origin`'s stream up to `upto` from src through the real engine. */
async function pullSession(src: Device, dst: Device, origin: Device, upto: number): Promise<void> {
  const seen = new WeakSet<object>();
  await sessionOnce(src, dst, {
    filter: (msg, dir) => {
      const m = msg as { type?: string; device_clock?: Record<string, number> };
      if (m && m.type === "HELLO" && !seen.has(m)) {
        seen.add(m);
        // first sight is the SEND of that side's hello (sender side wins)
        m.device_clock = dir === "from" ? { [origin.identity.deviceId]: upto } : {};
      }
      return true;
    },
  });
}

async function settle(w: World): Promise<void> {
  // every device's bootstrap/prior changes reach every device (fixed, unenumerated)
  await fullSession(w.d.A, w.d.B);
  await fullSession(w.d.B, w.d.C);
  await fullSession(w.d.A, w.d.B);
}

const T0 = 1_800_000_000_000;
const ev = (title: string) => ({ title, description: "d", startMs: T0, endMs: T0 + 3_600_000, allDay: false });

// ---------------------------------------------------------------- scenarios

// B's edits in S2a/S2b are written with createLocalChange using EXACTLY the
// record shape of EventCore.updateSeriesRule / updateOccurrence (same
// entity_type, field_path, payload) and the same row write, guarded by "series
// row exists locally". The real EventCore methods cannot be used because on
// current code B never receives the series row (defect #2) and they throw
// "series not found" (OBSERVED in a first run). After fix #3 the guard is true
// and the row write happens, so the same op is the correct chain.
function seriesRuleWrite(d: Device, seriesId: string, rule: string): void {
  const hlc = d.core.hlcNow();
  createLocalChange(
    d.db, d.identity.deviceId,
    { entity_id: seriesId, entity_type: "series", field_path: "recurrence_rule", operation: "set", payload: { value: rule }, hlc_now: () => hlc },
    (db) => {
      db.prepare("UPDATE series SET recurrence_rule = ?, updated_hlc = ? WHERE series_id = ?").run(rule, hlc, seriesId);
    },
  );
}

function overrideWrite(d: Device, seriesId: string, rid: string, title: string): void {
  const hlc = d.core.hlcNow();
  createLocalChange(
    d.db, d.identity.deviceId,
    { entity_id: seriesId, entity_type: "occurrence_override", field_path: `overrides.${rid}.title`, operation: "set", payload: { value: title }, hlc_now: () => hlc },
    (db) => {
      if (!db.prepare("SELECT 1 FROM series WHERE series_id = ?").get(seriesId)) return;
      db.prepare(
        `INSERT INTO occurrence_overrides (series_id, recurrence_id, cancelled, title, start_wall, end_wall, tz_id, updated_hlc)
         VALUES (?, ?, 0, ?, NULL, NULL, NULL, ?)
         ON CONFLICT(series_id, recurrence_id) DO UPDATE SET title = excluded.title, updated_hlc = excluded.updated_hlc`,
      ).run(seriesId, rid, title, hlc);
    },
  );
}

const S1: Scenario = {
  name: "S1 event chain via relay (A creates, B edits, C receives)",
  causal: true,
  async setup(w) {
    await settle(w);
  },
  steps: [
    {
      kind: "op", id: "createA", by: "A", after: [],
      run: (w) => { w.ctx.eid = w.d.A.core.createEvent(ev("orig")).id; },
    },
    {
      kind: "op", id: "editB", by: "B", after: ["B<-createA"],
      run: (w) => { w.d.B.core.updateEvent(w.ctx.eid!, ev("edit-B")); },
    },
    pull("B", "createA"), pull("C", "createA"), pull("A", "editB"), pull("C", "editB"),
  ],
};

const S2a: Scenario = {
  name: "S2a series chain via relay (A creates recurring event, B edits rule)",
  causal: true,
  async setup(w) {
    await settle(w);
  },
  steps: [
    {
      kind: "op", id: "createA", by: "A", after: [],
      run: (w) => { w.d.A.core.createEvent({ ...ev("rec"), recurrenceRule: "FREQ=WEEKLY;BYDAY=MO" }); w.ctx.sid = w.d.A.core.listSeries()[0]!.seriesId; },
    },
    {
      kind: "op", id: "editB", by: "B", after: ["B<-createA"],
      run: (w) => seriesRuleWrite(w.d.B, w.ctx.sid!, "FREQ=WEEKLY;BYDAY=TU"),
    },
    pull("B", "createA"), pull("C", "createA"), pull("A", "editB"), pull("C", "editB"),
  ],
};

const S2b: Scenario = {
  name: "S2b occurrence_override chain via relay (A creates series, B overrides an occurrence)",
  causal: true,
  async setup(w) {
    await settle(w);
  },
  steps: [
    {
      kind: "op", id: "createA", by: "A", after: [],
      run: (w) => { w.d.A.core.createEvent({ ...ev("rec"), recurrenceRule: "FREQ=WEEKLY;BYDAY=MO" }); w.ctx.sid = w.d.A.core.listSeries()[0]!.seriesId; },
    },
    {
      kind: "op", id: "editB", by: "B", after: ["B<-createA"],
      run: (w) => overrideWrite(w.d.B, w.ctx.sid!, "20270118T090000", "override-B"),
    },
    pull("B", "createA"), pull("C", "createA"), pull("A", "editB"), pull("C", "editB"),
  ],
};

function calendarWrite(d: Device, field: "title" | "color", value: string): void {
  const hlc = d.core.hlcNow();
  createLocalChange(
    d.db,
    d.identity.deviceId,
    {
      entity_id: "cal-work",
      entity_type: "calendar",
      field_path: field,
      operation: "set",
      payload: { value },
      hlc_now: () => hlc,
    },
    (db) => {
      db.prepare(
        `INSERT INTO calendars (calendar_id, title, color, created_hlc, updated_hlc)
         VALUES ('cal-work', ?, NULL, ?, ?)
         ON CONFLICT(calendar_id) DO UPDATE SET ${field} = excluded.${field}, updated_hlc = excluded.updated_hlc`,
      ).run(field === "title" ? value : "Work", hlc, hlc);
    },
  );
}

const S2c: Scenario = {
  name: "S2c calendar chain via relay (A creates calendar, B renames it)",
  causal: true,
  async setup(w) {
    await settle(w);
  },
  steps: [
    { kind: "op", id: "createA", by: "A", after: [], run: (w) => calendarWrite(w.d.A, "title", "Work") },
    { kind: "op", id: "editB", by: "B", after: ["B<-createA"], run: (w) => calendarWrite(w.d.B, "title", "Work-B") },
    pull("B", "createA"), pull("C", "createA"), pull("A", "editB"), pull("C", "editB"),
  ],
};

async function setupSharedEvent(w: World): Promise<void> {
  w.ctx.eid = w.d.A.core.createEvent(ev("orig")).id;
  await settle(w);
}

const S3: Scenario = {
  name: "S3 concurrent edits of the same event field (A and B)",
  causal: false,
  setup: setupSharedEvent,
  steps: [
    { kind: "op", id: "editA", by: "A", after: [], run: (w) => { w.d.A.core.updateEvent(w.ctx.eid!, ev("edit-A")); } },
    { kind: "op", id: "editB", by: "B", after: [], run: (w) => { w.d.B.core.updateEvent(w.ctx.eid!, ev("edit-B")); } },
    // concurrency: each side makes its edit before it receives the other's
    pull("B", "editA", ["editB"]), pull("A", "editB", ["editA"]),
    pull("C", "editA"), pull("C", "editB"),
  ],
};

const S4: Scenario = {
  name: "S4 concurrent delete (A) vs edit (B) of one event",
  causal: false,
  setup: setupSharedEvent,
  steps: [
    { kind: "op", id: "deleteA", by: "A", after: [], run: (w) => { w.d.A.core.deleteEvent(w.ctx.eid!); } },
    { kind: "op", id: "editB", by: "B", after: [], run: (w) => { w.d.B.core.updateEvent(w.ctx.eid!, ev("edit-B")); } },
    pull("B", "deleteA", ["editB"]), pull("A", "editB", ["deleteA"]),
    pull("C", "deleteA"), pull("C", "editB"),
  ],
};

// S5: three concurrent producers, one of which supersedes its own earlier edit.
// Restriction (documented, not exhaustive): the four local edits are made in the
// FIXED order a1, b1, b2, c1, all before any change is exchanged (so all are
// concurrent across producers; b2 is causally after b1). B's two edits are
// delivered TOGETHER (one pull of origin B up to b2, b1 travels in the same
// batch); b1-alone deliveries are not enumerated. Every feasible order of the
// six pulls (B<-A, C<-A via B, A<-B, C<-B, A<-C via B, B<-C) IS enumerated.
const S5: Scenario = {
  name: "S5 three concurrent producers, B supersedes its own edit (a1 | b1->b2 | c1)",
  causal: false,
  setup: setupSharedEvent,
  steps: [
    { kind: "op", id: "editA", by: "A", after: [], run: (w) => { w.d.A.core.updateEvent(w.ctx.eid!, ev("a1")); } },
    { kind: "op", id: "editB1", by: "B", after: ["editA"], run: (w) => { w.d.B.core.updateEvent(w.ctx.eid!, ev("b1")); } },
    { kind: "op", id: "editB2", by: "B", after: ["editB1"], run: (w) => { w.d.B.core.updateEvent(w.ctx.eid!, ev("b2")); } },
    { kind: "op", id: "editC", by: "C", after: ["editB2"], run: (w) => { w.d.C.core.updateEvent(w.ctx.eid!, ev("c1")); } },
    pull("B", "editA", ["editC"]), pull("C", "editA", ["editC"]),
    pull("A", "editB2", ["editC"]), pull("C", "editB2", ["editC"]),
    pull("A", "editC", ["editC"]), pull("B", "editC", ["editC"]),
  ],
};

// ---------------------------------------------------------------- execution + snapshots

interface Observed {
  changes: Record<Dev, Map<string, string>>;
  state: Record<Dev, string>;
  conflicts: Record<Dev, Map<string, string>>;
}

function snapChanges(d: Device): Map<string, string> {
  const rows = d.db
    .prepare(
      `SELECT device_id, local_seq, change_id, entity_id, entity_type, field_path, operation,
              payload, hlc_timestamp, causality_clock, schema_version FROM changes`,
    )
    .all() as Array<Record<string, unknown>>;
  const m = new Map<string, string>();
  for (const r of rows) {
    const key = `${r.device_id}#${r.local_seq}`;
    m.set(key, JSON.stringify([r.change_id, r.entity_id, r.entity_type, r.field_path, r.operation, r.payload, r.hlc_timestamp, r.causality_clock, r.schema_version]));
  }
  return m;
}

function snapConflicts(d: Device): Map<string, string> {
  const cs = d.db
    .prepare("SELECT conflict_id, entity_id, field_path, status, resolved_value FROM conflicts")
    .all() as Array<{ conflict_id: string; entity_id: string; field_path: string; status: string; resolved_value: string | null }>;
  const m = new Map<string, string>();
  for (const c of cs) {
    const ps = d.db
      .prepare("SELECT device_id, local_seq, causality_clock, payload FROM conflict_participants WHERE conflict_id = ?")
      .all(c.conflict_id) as Array<Record<string, unknown>>;
    const parts = ps.map((p) => JSON.stringify([p.device_id, p.local_seq, p.causality_clock, p.payload])).sort();
    // a second conflict with the same (entity, field) key gets a suffix so duplicates stay visible
    let key = `${c.entity_id}|${c.field_path}`;
    for (let i = 2; m.has(key); i++) key = `${c.entity_id}|${c.field_path}#${i}`;
    m.set(key, JSON.stringify([c.status, c.resolved_value, parts]));
  }
  return m;
}

async function runOrder(sc: Scenario, order: string[]): Promise<{ obs: Observed; devs: Device[] }> {
  const d = { A: makeDevice("A"), B: makeDevice("B"), C: makeDevice("C") };
  const w: World = { d, ctx: {}, seqAfter: {} };
  await sc.setup(w);
  const byId = new Map(sc.steps.map((s) => [s.id, s]));
  const opOwner = new Map(sc.steps.filter((s): s is OpStep => s.kind === "op").map((s) => [s.id, s.by]));
  for (const id of order) {
    const s = byId.get(id)!;
    if (s.kind === "op") {
      s.run(w);
      w.seqAfter[s.id] = maxOwnSeq(d[s.by]);
    } else {
      const origin = opOwner.get(s.op)!;
      await pullSession(d[srcFor(s.dst, origin)], d[s.dst], d[origin], w.seqAfter[s.op]!);
    }
  }
  const obs: Observed = {
    changes: {} as never, state: {} as never, conflicts: {} as never,
  };
  for (const k of DEVS) {
    obs.changes[k] = snapChanges(d[k]);
    obs.state[k] = JSON.stringify(
      (({ digest: _digest, ...rest }) => rest)(fingerprint(d[k].db)),
    );
    obs.conflicts[k] = snapConflicts(d[k]);
  }
  return { obs, devs: DEVS.map((k) => d[k]) };
}

// ---------------------------------------------------------------- reporting

function mapDiff(name: string, ref: Map<string, string>, other: Map<string, string>, refName: string, otherName: string): string[] {
  const out: string[] = [];
  for (const [k, v] of ref) {
    if (!other.has(k)) out.push(`${otherName} lacks ${k} (held by ${refName})`);
    else if (other.get(k) !== v) out.push(`${k} differs: ${refName}=${v} vs ${otherName}=${other.get(k)}`);
  }
  for (const k of other.keys()) if (!ref.has(k)) out.push(`${refName} lacks ${k} (held by ${otherName})`);
  return out;
}

interface Failure { order: string; detail: string[] }

function evaluate(
  sc: Scenario,
  results: Array<{ order: string[]; obs: Observed }>,
  check: "changes" | "state" | "conflicts",
): Failure[] {
  const fails: Failure[] = [];
  for (const { order, obs } of results) {
    const detail: string[] = [];
    for (const k of ["B", "C"] as const) {
      if (check === "state") {
        if (obs.state.A !== obs.state[k]) detail.push(`device ${k} calendar state differs from A:\n    A=${obs.state.A}\n    ${k}=${obs.state[k]}`);
      } else {
        const src = check === "changes" ? obs.changes : obs.conflicts;
        for (const line of mapDiff(check, src.A, src[k], "A", k)) detail.push(`device ${k}: ${line}`);
      }
    }
    if (detail.length > 0) fails.push({ order: order.join(" > "), detail });
  }
  void sc;
  return fails;
}

function report(sc: Scenario, check: string, total: number, fails: Failure[]): string {
  if (fails.length === 0) return "";
  const shown = fails.slice(0, 3).map((f) => `  order [${f.order}]\n  - ${f.detail.join("\n  - ")}`).join("\n");
  return `${sc.name} / ${check}: ${fails.length} of ${total} delivery orders diverge.\n${shown}`;
}

// ---------------------------------------------------------------- test registration

const allDevices: Device[] = [];
afterAll(() => {
  for (const d of allDevices) {
    try { d.db.close(); } catch { /* already closed */ }
    try { rmSync(d.dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

/** Expectation per check: "pass" = plain test, "fail" = vitest test.fails (expected failure). */
type Expect = "pass" | "fail";
interface Marks {
  changes: Expect;
  state: Expect;
  conflicts: Expect;
}

function register(sc: Scenario, marks: Marks, notes: { state?: string; conflicts?: string }): void {
  const orders = enumerateOrders(sc);
  let cache: Promise<Array<{ order: string[]; obs: Observed }>> | undefined;
  const results = (): Promise<Array<{ order: string[]; obs: Observed }>> => {
    cache ??= (async () => {
      const r: Array<{ order: string[]; obs: Observed }> = [];
      for (const order of orders) {
        const { obs, devs } = await runOrder(sc, order);
        allDevices.push(...devs);
        r.push({ order, obs });
      }
      return r;
    })();
    return cache;
  };
  describe(`${sc.name} [${orders.length} delivery orders]`, () => {
    const mk = (check: "changes" | "state" | "conflicts", label: string, note?: string) => {
      const fn = marks[check] === "fail" ? test.fails : test;
      // note: expected-failure evidence links, see comments at the registration site
      void note;
      fn(label, { timeout: 120_000 }, async () => {
        const r = await results();
        const fails = evaluate(sc, r, check);
        expect(fails.length, report(sc, label, r.length, fails)).toBe(0);
      });
    };
    mk("changes", "(a) change-set convergence");
    mk("state", "(b) calendar-state convergence", notes.state);
    mk("conflicts", "(c) conflict convergence", notes.conflicts);
  });
}

// Marks were set from a run against cbce6a6. "pass" = plain test. For the
// causally ordered scenarios (S1, S2a-c) check (b) is deliberately a PLAIN test:
// it FAILS on current code (S1: defect #1, S2a-c: defect #2) and must pass after
// fixes 2 and 3. "fail" = vitest test.fails (expected failure, evidence).
register(S1, { changes: "pass", state: "pass", conflicts: "pass" }, {});
register(S2a, { changes: "pass", state: "pass", conflicts: "pass" }, {});
register(S2b, { changes: "pass", state: "pass", conflicts: "pass" }, {});
register(S2c, { changes: "pass", state: "pass", conflicts: "pass" }, {});
// S3: concurrent same-field edits. (b) EXPECTED FAILURE, problems #5-#10 (each
// device keeps its own edit; the conflict never changes the materialized row).
// (c) PASSES on current code (conflict records agree), so it is a plain test.
register(S3, { changes: "pass", state: "fail", conflicts: "pass" }, {});
// S4: concurrent delete vs edit. (b) EXPECTED FAILURE (#9/#10 family: devices
// disagree on whether the event exists). (c) EXPECTED FAILURE: evidence for
// problem #5 (A holds a conflict that B lacks, and vice versa).
register(S4, { changes: "pass", state: "fail", conflicts: "fail" }, {});
// S5: (b) EXPECTED FAILURE, problems #5-#10 family (180 of 180 orders: each
// device keeps its own latest edit, the conflict never reaches the row).
// (a) and (c) PASS on current code, so they are plain tests.
register(S5, { changes: "pass", state: "fail", conflicts: "pass" }, {});
