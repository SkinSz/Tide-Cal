// Pkg 2 (QA M-1 / BND-01 + BND-05): event identity & shape contract at the
// sidecar boundary.
//
// Baseline corruption (verified at 83dedbf, FINDINGS.md BND-01 / seam_deep
// E2): update_event {id, input:{id: ...}} built {id, ...input} so the client
// injected id won — ok:true returned, TARGET ROW UNTOUCHED, PHANTOM ROW
// INSERTED, and 3 change records written under the TARGET's entity claiming
// the update applied. Record/row divergence survives restart and diverges
// sync peers. Companion BND-05: create_event honored client input.id and
// echoed unknown fields.
//
// Contract enforced here (docs/qa/remediation/pkg2-report.md):
//   - create_event: input.id rejected (ids are core-generated sync identity)
//   - update_event: args.id is the SOLE identity; input.id rejected even
//     when equal to args.id; identity cannot be re-targeted or injected
//   - unknown/mistyped input fields rejected (never echoed/persisted)
//   - every rejection is deterministic ok:false and leaves persistent state
//     byte-identical (rows, change log, entity_versions)
//
// Coverage layers:
//   A. in-process dispatcher (makeDispatcher + handleLine) — fast matrix,
//      each rejection verified against a full state snapshot
//   B. RAW sidecar stdio (esbuild-bundled sidecar_server.ts main(), the same
//      artifact the Rust layer spawns) — the exact M-1 repro path, plus
//      restart persistence
//   C. sync divergence — update followed by engine sessions to a second
//      peer: no phantom propagation, full convergence
import { describe, expect, test, afterEach } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database as SqliteDatabase } from "better-sqlite3";
import { EventCore } from "../src/persistence/bridges/event_core.ts";
import { makeDispatcher, handleLine } from "../src/persistence/bridges/sidecar_server.ts";
import { makeEntityMutator } from "../src/persistence/bridges/sync_service.ts";
import { createSyncEngine } from "../src/sync/sync_engine.ts";
import { openDatabase } from "../src/persistence/database.ts";
import { loadOrCreateIdentity } from "../src/network/sync_runtime.ts";

const INPUT = {
  title: "Pkg2 probe",
  description: "identity contract",
  startMs: Date.UTC(2026, 8, 1, 12, 0, 0),
  endMs: Date.UTC(2026, 8, 1, 13, 0, 0),
  allDay: false,
};

const PHANTOM_ID = "evt-PHANTOM-9";

// ---------------------------------------------------------------------------
// State snapshot: rows + change log + entity_versions (Pkg1 state table).
// Every rejected request must leave this byte-identical.
// ---------------------------------------------------------------------------

interface StateSnapshot {
  events: Array<{ event_id: string; title: string }>;
  changes: Array<{ local_seq: number; entity_id: string; field_path: string; operation: string }>;
  versions: Array<{ entity_id: string; version: string }>;
}

function snapshot(db: SqliteDatabase): StateSnapshot {
  return {
    events: db
      .prepare("SELECT event_id, title FROM events ORDER BY event_id")
      .all() as StateSnapshot["events"],
    changes: db
      .prepare(
        "SELECT local_seq, entity_id, field_path, operation FROM changes ORDER BY local_seq",
      )
      .all() as StateSnapshot["changes"],
    versions: db
      .prepare("SELECT entity_id, version FROM entity_versions ORDER BY entity_id")
      .all() as StateSnapshot["versions"],
  };
}

function openSnapshot(dbPath: string): StateSnapshot {
  const db = openDatabase({ path: dbPath });
  try {
    return snapshot(db);
  } finally {
    db.close();
  }
}

function expectUnchanged(before: StateSnapshot, after: StateSnapshot): void {
  expect(after.events).toEqual(before.events);
  expect(after.changes).toEqual(before.changes);
  expect(after.versions).toEqual(before.versions);
}

// ---------------------------------------------------------------------------
// A. In-process dispatcher matrix
// ---------------------------------------------------------------------------

describe("Pkg2 A: dispatcher identity/shape contract (in-process)", () => {
  let dir: string;
  let dbPath: string;
  let core: EventCore;
  let dispatch: ReturnType<typeof makeDispatcher>;
  let reqId = 0;

  afterEach(() => {
    core?.db.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function setup(): void {
    dir = mkdtempSync(join(tmpdir(), "tide-pkg2-"));
    dbPath = join(dir, "tide.db");
    core = new EventCore(dbPath);
    dispatch = makeDispatcher(core);
  }

  async function rpc(op: string, args: Record<string, unknown>): Promise<{ ok: boolean; result?: unknown; error?: string }> {
    reqId += 1;
    const raw = JSON.parse(
      await handleLine(dispatch, JSON.stringify({ id: reqId, op, args })),
    ) as { ok: boolean; result?: unknown; error?: string };
    return raw;
  }

  test("normal update (no input.id) works and writes change records", async () => {
    setup();
    const created = await rpc("create_event", { input: INPUT });
    expect(created.ok).toBe(true);
    const id = (created.result as { id: string }).id;

    const updated = await rpc("update_event", {
      id,
      input: { ...INPUT, title: "renamed" },
    });
    expect(updated.ok).toBe(true);
    const result = updated.result as { id: string; title: string };
    expect(result.id).toBe(id); // identity preserved — never re-keyed
    expect(result.title).toBe("renamed");

    const after = openSnapshot(dbPath);
    expect(after.events).toEqual([{ event_id: id, title: "renamed" }]);
    // calendar bootstrap + create(event) + title update record
    const eventChanges = after.changes.filter((c) => c.entity_id === id);
    expect(eventChanges.map((c) => c.field_path)).toEqual(["event", "title"]);
  });

  test("update with arbitrary injected input.id → explicit error, NO state change", async () => {
    setup();
    const created = await rpc("create_event", { input: INPUT });
    const id = (created.result as { id: string }).id;
    const before = openSnapshot(dbPath);

    // The exact M-1/BND-01 baseline payload shape.
    const res = await rpc("update_event", {
      id,
      input: { ...INPUT, id: PHANTOM_ID, title: "HACKED" },
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/input\.id is not accepted/);
    expectUnchanged(before, openSnapshot(dbPath));

    // Target still reachable and untouched.
    const listed = await rpc("list_events", {});
    expect(listed.ok).toBe(true);
    expect(listed.result).toEqual([
      { id, title: "Pkg2 probe", description: INPUT.description, startMs: INPUT.startMs, endMs: INPUT.endMs, allDay: false },
    ]);
  });

  test("update with input.id EQUAL to target id → rejected (uniform contract), no state change", async () => {
    setup();
    const created = await rpc("create_event", { input: INPUT });
    const id = (created.result as { id: string }).id;
    const before = openSnapshot(dbPath);

    const res = await rpc("update_event", {
      id,
      input: { ...INPUT, id, title: "even-benign-echo-is-rejected" },
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/input\.id is not accepted/);
    expectUnchanged(before, openSnapshot(dbPath));
  });

  test("update with input.id = ANOTHER EXISTING event id → explicit error, no state change", async () => {
    setup();
    const a = (await rpc("create_event", { input: { ...INPUT, title: "A" } })).result as { id: string };
    const b = (await rpc("create_event", { input: { ...INPUT, title: "B" } })).result as { id: string };
    const before = openSnapshot(dbPath);

    const res = await rpc("update_event", {
      id: a.id,
      input: { ...INPUT, id: b.id, title: "cross-target attempt" },
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/input\.id is not accepted/);

    const after = openSnapshot(dbPath);
    expectUnchanged(before, after);
    // Both rows survive with their original titles.
    expect(after.events.map((e) => e.title).sort()).toEqual(["A", "B"]);
  });

  test("update without args.id / malformed id types → explicit error, no state change", async () => {
    setup();
    const created = await rpc("create_event", { input: INPUT });
    const id = (created.result as { id: string }).id;
    const before = openSnapshot(dbPath);

    for (const bad of [undefined, null, 42, { malicious: true }, "", "   "]) {
      const res = await rpc("update_event", {
        id: bad,
        input: { ...INPUT, title: "should-never-land" },
      });
      expect(res.ok, `id=${JSON.stringify(bad)} must be rejected`).toBe(false);
      expect(res.error).toMatch(/args\.id must be a non-empty string/);
    }
    expectUnchanged(before, openSnapshot(dbPath));

    // Target unaffected.
    const listed = await rpc("list_events", {});
    expect((listed.result as Array<{ id: string; title: string }>)[0]!.id).toBe(id);
    expect((listed.result as Array<{ title: string }>)[0]!.title).toBe("Pkg2 probe");
  });

  test("create with client-injected input.id → rejected per contract, no state change", async () => {
    setup();
    const before = openSnapshot(dbPath);

    const res = await rpc("create_event", { input: { ...INPUT, id: PHANTOM_ID } });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/input\.id is not accepted/);
    expectUnchanged(before, openSnapshot(dbPath));
  });

  test("unknown input fields rejected on create AND update (never echoed, never persisted)", async () => {
    setup();
    // create
    const beforeCreate = openSnapshot(dbPath);
    const badCreate = await rpc("create_event", {
      input: { ...INPUT, color: "red", recurrence: "FREQ=DAILY" },
    });
    expect(badCreate.ok).toBe(false);
    expect(badCreate.error).toMatch(/unknown input field\(s\): color, recurrence/);
    expectUnchanged(beforeCreate, openSnapshot(dbPath));

    // update
    const created = await rpc("create_event", { input: INPUT });
    const id = (created.result as { id: string }).id;
    const beforeUpdate = openSnapshot(dbPath);
    const badUpdate = await rpc("update_event", {
      id,
      input: { ...INPUT, title: "x", sneaky_extra: 1 },
    });
    expect(badUpdate.ok).toBe(false);
    expect(badUpdate.error).toMatch(/unknown input field\(s\): sneaky_extra/);
    expectUnchanged(beforeUpdate, openSnapshot(dbPath));
  });

  test("malformed input field types rejected (title/number/allDay/startMs)", async () => {
    setup();
    const created = await rpc("create_event", { input: INPUT });
    const id = (created.result as { id: string }).id;
    const before = openSnapshot(dbPath);

    const badInputs: Array<[string, Record<string, unknown>]> = [
      ["title", { ...INPUT, title: 7 }],
      ["description", { ...INPUT, description: null }],
      ["startMs", { ...INPUT, startMs: "2026-09-01" }],
      ["startMs-NaN", { ...INPUT, startMs: Number.NaN }],
      ["endMs", { ...INPUT, endMs: Infinity }],
      ["allDay", { ...INPUT, allDay: "yes" }],
      ["missing-allDay", { title: "t", description: "d", startMs: 1, endMs: 2 }],
    ];
    for (const [label, input] of badInputs) {
      const res = await rpc("update_event", { id, input });
      expect(res.ok, `${label} must be rejected`).toBe(false);
      expect(res.error).not.toMatch(/unknown op/);
    }
    expectUnchanged(before, openSnapshot(dbPath));

    const badCreate = await rpc("create_event", { input: { ...INPUT, allDay: 1 } });
    expect(badCreate.ok).toBe(false);
    expect(badCreate.error).toMatch(/input\.allDay must be a boolean/);
  });

  test("repeated updates: every round keeps identity and converges to last write", async () => {
    setup();
    const created = await rpc("create_event", { input: INPUT });
    const id = (created.result as { id: string }).id;

    for (let i = 1; i <= 5; i++) {
      const res = await rpc("update_event", {
        id,
        input: { ...INPUT, title: `round-${i}` },
      });
      expect(res.ok).toBe(true);
      expect((res.result as { id: string }).id).toBe(id);
    }
    const after = openSnapshot(dbPath);
    expect(after.events).toEqual([{ event_id: id, title: "round-5" }]);
    // create + exactly 5 title records (description/schedule never changed)
    const titles = after.changes.filter(
      (c) => c.entity_id === id && c.field_path === "title",
    );
    expect(titles).toHaveLength(5);
  });

  test("defense-in-depth: EventCore.updateEvent itself throws on input.id (dispatcher bypass)", () => {
    setup();
    const ev = core.createEvent(INPUT);
    const before = snapshot(core.db);
    expect(() =>
      core.updateEvent(ev.id, { ...INPUT, id: PHANTOM_ID } as never),
    ).toThrow(/input\.id is not accepted/);
    expect(() =>
      core.createEvent({ ...INPUT, id: PHANTOM_ID } as never),
    ).toThrow(/input\.id is not accepted/);
    expectUnchanged(before, snapshot(core.db));
    expect(core.listEvents()).toEqual([{ ...ev, title: "Pkg2 probe" }]);
  });
});

// ---------------------------------------------------------------------------
// B. Raw sidecar stdio E2E — the REAL M-1 path (bundled sidecar main()),
//    including restart persistence on the same DB.
// ---------------------------------------------------------------------------

interface RpcResponse {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
}

function buildSidecarBundle(): string {
  // Fresh-clone safe: dist/ is gitignored and may not exist yet.
  const distRoot = join(import.meta.dirname, "../dist");
  mkdirSync(distRoot, { recursive: true });
  const outdir = mkdtempSync(join(distRoot, "pkg2-"));
  const bundle = join(outdir, "sidecar.mjs");
  execFileSync(
    join(import.meta.dirname, "../node_modules/.bin/esbuild"),
    [
      join(import.meta.dirname, "../src/persistence/bridges/sidecar_server.ts"),
      "--bundle", "--platform=node", "--format=esm",
      "--external:better-sqlite3", `--outfile=${bundle}`,
    ],
  );
  return bundle;
}

async function runSidecar(
  bundle: string,
  dbPath: string,
  lines: string[],
): Promise<RpcResponse[]> {
  // Pkg6 (pkg2-review leftover, per Pkg3 agent's note): the sidecar answers
  // ASYNC — responses can arrive out of order. Correlate by request `id`
  // instead of arrival index, then return responses ordered by the requests'
  // ids so call-site index assertions keep their meaning.
  const requestIds: unknown[] = lines.map((l) => {
    try {
      return (JSON.parse(l) as { id?: unknown }).id;
    } catch {
      return undefined;
    }
  });
  const byId = new Map<unknown, RpcResponse>();
  const childEnv = { ...process.env };
  delete childEnv.VITEST;
  childEnv.TIDE_DB_PATH = dbPath;
  const child = spawn(process.execPath, [bundle], {
    env: childEnv,
    stdio: ["pipe", "pipe", "inherit"],
  });
  try {
    const rl = createInterface({ input: child.stdout });
    const done = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`timeout after responses: ${JSON.stringify([...byId.values()])}`)),
        20_000,
      );
      rl.on("line", (line) => {
        if (!line.trim()) return;
        const parsed = JSON.parse(line) as RpcResponse & { id?: unknown };
        byId.set(parsed.id, parsed);
        if (byId.size === lines.length) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.on("exit", (code: number | null) =>
        reject(new Error(`sidecar exited early code=${code}: ${byId.size}/${lines.length} responses`)),
      );
    });
    child.stdin.write(lines.join("\n") + "\n");
    child.stdin.end();
    await done;
  } finally {
    if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null) return resolve();
      child.on("exit", () => resolve());
    });
  }
  return requestIds.map((id) => {
    const r = byId.get(id);
    if (!r) throw new Error(`sidecar never answered request id=${JSON.stringify(id)}`);
    return r;
  });
}

describe("Pkg2 B: raw sidecar stdio — M-1 repro + restart persistence", () => {
  let dir: string;
  let bundle: string;

  afterEach(() => {
    if (bundle) rmSync(join(bundle, ".."), { recursive: true, force: true });
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test("malicious update rejected over raw stdio; no phantom rows persist across restart", async () => {
    dir = mkdtempSync(join(tmpdir(), "tide-pkg2-e2e-"));
    const dbPath = join(dir, "tide.db");
    bundle = buildSidecarBundle();
    const env = { ...process.env };
    delete env.VITEST;
    env.TIDE_DB_PATH = dbPath;

    // Pass 1: create a real event, learn its server-assigned id.
    const pass1 = await runSidecar(bundle, dbPath, [
      JSON.stringify({ id: 1, op: "create_event", args: { input: INPUT } }),
    ]);
    expect(pass1[0]!.ok).toBe(true);
    const realId = (pass1[0]!.result as { id: string }).id;
    expect(realId).toMatch(/^evt-/);

    // Pass 2: the full BND-01 attack battery over the raw protocol.
    const responses = await runSidecar(bundle, dbPath, [
      // exact baseline repro shape: target realId, inject phantom id
      JSON.stringify({
        id: 1,
        op: "update_event",
        args: { id: realId, input: { ...INPUT, id: PHANTOM_ID, title: "HACKED" } },
      }),
      // conflicting existing id
      JSON.stringify({
        id: 2,
        op: "update_event",
        args: { id: realId, input: { ...INPUT, id: realId, title: "echo" } },
      }),
      // create with injected id
      JSON.stringify({ id: 3, op: "create_event", args: { input: { ...INPUT, id: PHANTOM_ID } } }),
      // create with unknown fields
      JSON.stringify({
        id: 4,
        op: "create_event",
        args: { input: { ...INPUT, bogus: true } },
      }),
      // malformed target id
      JSON.stringify({ id: 5, op: "update_event", args: { id: 42, input: INPUT } }),
      // one legitimate update
      JSON.stringify({
        id: 6,
        op: "update_event",
        args: { id: realId, input: { ...INPUT, title: "legit rename" } },
      }),
    ]);
    expect(responses).toHaveLength(6);
    for (let i = 0; i < 5; i++) {
      expect(responses[i]!.ok, `attack ${i + 1} must be rejected: ${JSON.stringify(responses[i])}`).toBe(false);
      expect(responses[i]!.error).toMatch(/input\.id is not accepted|unknown input field|args\.id must be a non-empty string/);
    }
    expect(responses[5]!.ok).toBe(true);
    expect((responses[5]!.result as { id: string }).id).toBe(realId);

    // Persistent state: exactly ONE event row, phantom absent, target renamed.
    const db = openDatabase({ path: dbPath });
    try {
      const after = snapshot(db);
      expect(after.events).toEqual([{ event_id: realId, title: "legit rename" }]);
      // No change record may reference the phantom id.
      expect(after.changes.some((c) => c.entity_id === PHANTOM_ID)).toBe(false);
      // Event change records only under the real id, and only plausible ones.
      const eventChanges = after.changes.filter((c) => c.entity_id === realId);
      expect(eventChanges.map((c) => `${c.operation}:${c.field_path}`)).toEqual([
        "set:event",
        "set:title",
      ]);
      expect(after.versions.map((v) => v.entity_id)).toContain(realId);
      expect(after.versions.map((v) => v.entity_id)).not.toContain(PHANTOM_ID);
    } finally {
      db.close();
    }

    // Pass 3: restart on the SAME db — record/row divergence must not exist.
    const restart = await runSidecar(bundle, dbPath, [
      JSON.stringify({ id: 1, op: "list_events", args: {} }),
    ]);
    expect(restart[0]!.ok).toBe(true);
    expect(restart[0]!.result).toEqual([
      { id: realId, title: "legit rename", description: INPUT.description, startMs: INPUT.startMs, endMs: INPUT.endMs, allDay: false },
    ]);
    const db2 = openDatabase({ path: dbPath });
    try {
      expect((db2.prepare("SELECT COUNT(*) AS c FROM events").get() as { c: number }).c).toBe(1);
      expect(
        (db2.prepare("SELECT COUNT(*) AS c FROM changes WHERE entity_id = ?").get(PHANTOM_ID) as { c: number }).c,
      ).toBe(0);
    } finally {
      db2.close();
    }
  });
});

// ---------------------------------------------------------------------------
// C. Update followed by sync to a second peer — no divergence
// ---------------------------------------------------------------------------

function msgPipePair(): [
  { send(m: unknown): Promise<void>; receive(): Promise<unknown>; close(): void },
  { send(m: unknown): Promise<void>; receive(): Promise<unknown>; close(): void },
] {
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
  const wrap = (self: End) => ({
    async send(msg: unknown): Promise<void> {
      const p = self.peer!;
      if (p.closed) return;
      if (p.waiter) {
        const w = p.waiter;
        p.waiter = null;
        w(msg);
      } else p.queue.push(msg);
    },
    async receive(): Promise<unknown> {
      const next = self.queue.shift();
      if (next !== undefined) return next;
      if (self.closed) return null;
      return await new Promise((resolve) => {
        self.waiter = resolve;
      });
    },
    close(): void {
      self.closed = true;
      if (self.peer?.waiter) {
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
  return [wrap(x), wrap(y)];
}

function eventRows(db: SqliteDatabase): Array<{ event_id: string; title: string }> {
  return db
    .prepare("SELECT event_id, title FROM events ORDER BY event_id")
    .all() as Array<{ event_id: string; title: string }>;
}

describe("Pkg2 C: updates sync to a second peer without divergence", () => {
  test("legit update converges to peer; injected-id attempt writes nothing syncable", async () => {
    const dirA = mkdtempSync(join(tmpdir(), "tide-pkg2-a-"));
    const dirB = mkdtempSync(join(tmpdir(), "tide-pkg2-b-"));
    const identityA = loadOrCreateIdentity(dirA);
    const identityB = loadOrCreateIdentity(dirB);
    const coreA = new EventCore(join(dirA, "tide.db"), identityA.deviceId);
    const coreB = new EventCore(join(dirB, "tide.db"), identityB.deviceId);

    try {
      // Legitimate create + update on A.
      const ev = coreA.createEvent(INPUT);
      coreA.updateEvent(ev.id, { ...INPUT, title: "renamed on A" });
      // Injected-id attempts are REJECTED at the domain core — nothing is
      // written, so there is nothing to propagate (this is the fix: the
      // baseline wrote 3 bogus records here and diverged peers).
      expect(() =>
        coreA.updateEvent(ev.id, { ...INPUT, id: PHANTOM_ID, title: "HACKED" } as never),
      ).toThrow(/input\.id is not accepted/);

      const engineA = createSyncEngine({
        db: coreA.db,
        selfDeviceId: identityA.deviceId,
        mutateEntity: makeEntityMutator(),
      });
      const engineB = createSyncEngine({
        db: coreB.db,
        selfDeviceId: identityB.deviceId,
        mutateEntity: makeEntityMutator(),
      });

      const runSession = async (): Promise<void> => {
        const [tA, tB] = msgPipePair();
        // When one engine's session ends, close the PEER's pipe so the other
        // engine observes EOF instead of idling forever (same pattern as
        // tests/two_instance_sync.test.ts sessionOnce).
        const closingA = engineA
          .runSession(tA as never)
          .then(
            () => tB.close(),
            (e) => {
              tB.close();
              throw e;
            },
          );
        const closingB = engineB
          .runSession(tB as never)
          .then(
            () => tA.close(),
            (e) => {
              tA.close();
              throw e;
            },
          );
        await Promise.all([closingA, closingB]);
      };
      await runSession(); // A -> B
      await runSession(); // reverse round-trip settles knowledge state

      // Peer B materialized exactly the real event, renamed — no phantom.
      expect(eventRows(coreB.db)).toEqual(eventRows(coreA.db));
      expect(eventRows(coreB.db)).toEqual([{ event_id: ev.id, title: "renamed on A" }]);
      expect(
        coreB.db.prepare("SELECT COUNT(*) AS c FROM changes WHERE entity_id = ?").get(PHANTOM_ID),
      ).toEqual({ c: 0 });
      // Reverse sync: B has nothing to push back; A unchanged.
      expect(eventRows(coreA.db)).toEqual([{ event_id: ev.id, title: "renamed on A" }]);
    } finally {
      coreA.db.close();
      coreB.db.close();
      rmSync(dirA, { recursive: true, force: true });
      rmSync(dirB, { recursive: true, force: true });
    }
  });
});
