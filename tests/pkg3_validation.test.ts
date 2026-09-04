// Pkg 3 (QA M-5/BND-02, M-6/BND-03, m-3/BND-04, QA-2 F-2): centralized
// authoritative event-input validation.
//
// Baseline defects (verified at cdece6f, CONSOLIDATION-REPORT.md §4):
//   BND-02 (M-5): endMs < startMs accepted; the response echoed the written
//     value, the row stored the clamp (startMs), and the change-record
//     payload carried a third value — reachable from the typed UI. Sync
//     peers then materialize yet another variant of "the same" event.
//   BND-03 (M-6): scalar type confusion silently transformed at the SQLite
//     seam: title:42 -> "42.0"; startMs:"abc"/null -> 0; 1e999 -> response
//     null, stored 0; fractional ms -> REAL stored under INTEGER affinity.
//   BND-04 (m-3): allDay accepted any value, silently normalized, echoed
//     raw; a missing allDay silently became false.
//   F-2 (QA-2): update_event with partial input surfaced the raw
//     `NOT NULL constraint failed: events.description` over IPC.
//
// Contract enforced here (docs/qa/remediation/pkg3-report.md):
//   - FULL INPUT REQUIRED on create_event AND update_event: all five fields
//     present; nothing defaulted; partial input is a deterministic ok:false
//     naming the missing fields (no raw SQLite errors over IPC).
//   - startMs/endMs: integral epoch ms, |v| <= MAX_EVENT_MS (8.64e15,
//     ECMAScript Date range), endMs >= startMs — REJECTED, never clamped
//     or coerced. 0 and negative timestamps are valid (documented).
//   - title/description: strings. allDay: strict boolean. (Pkg 2 rules.)
//   - Values bind to SQLite exactly as validated (integers -> INTEGER
//     affinity is a no-op) and the response echo, stored row, and change
//     record all carry the SAME values.
//   - Every rejection leaves persistent state byte-identical (rows +
//     change log + entity_versions) and never poisons the next request.
//
// Coverage layers (mirrors pkg2_identity.test.ts):
//   A. in-process dispatcher (makeDispatcher + handleLine) — full matrix
//   B. RAW sidecar stdio — dist/sidecar.mjs REBUILT via `npm run
//      sidecar:build` before probes (the exact artifact the Rust layer
//      spawns); the typed Rust EventInput cannot send any of these shapes
//      by construction (five typed fields, serde-typed), so the raw stdio
//      path IS the adversarial path
//   C. two-peer sync — peers materialize EXACTLY the values the
//      creating/updating device materialized (BND-02's sync-disagreement
//      mode closed)
import { describe, expect, test, afterEach, beforeAll } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database as SqliteDatabase } from "better-sqlite3";
import {
  EventCore,
  MAX_EVENT_MS,
} from "../src/persistence/bridges/event_core.ts";
import { makeDispatcher, handleLine } from "../src/persistence/bridges/sidecar_server.ts";
import { makeEntityMutator } from "../src/persistence/bridges/sync_service.ts";
import { createSyncEngine } from "../src/sync/sync_engine.ts";
import { openDatabase } from "../src/persistence/database.ts";
import { loadOrCreateIdentity } from "../src/network/sync_runtime.ts";

const REPO = join(import.meta.dirname, "..");

const START = Date.UTC(2026, 8, 1, 12, 0, 0);
const END = Date.UTC(2026, 8, 1, 13, 0, 0);

const INPUT = {
  title: "Pkg3 probe",
  description: "validation contract",
  startMs: START,
  endMs: END,
  allDay: false,
};

// ---------------------------------------------------------------------------
// Byte-identical state snapshot: FULL rows + FULL change log + versions.
// ---------------------------------------------------------------------------

function fullSnapshot(db: SqliteDatabase): {
  events: unknown[];
  changes: unknown[];
  versions: unknown[];
} {
  return {
    events: db.prepare("SELECT * FROM events ORDER BY event_id").all(),
    changes: db.prepare("SELECT * FROM changes ORDER BY local_seq").all(),
    versions: db
      .prepare("SELECT * FROM entity_versions ORDER BY entity_id")
      .all(),
  };
}

function openFullSnapshot(dbPath: string): ReturnType<typeof fullSnapshot> {
  const db = openDatabase({ path: dbPath });
  try {
    return fullSnapshot(db);
  } finally {
    db.close();
  }
}

function expectUnchanged(
  before: ReturnType<typeof fullSnapshot>,
  after: ReturnType<typeof fullSnapshot>,
): void {
  expect(after.events).toEqual(before.events);
  expect(after.changes).toEqual(before.changes);
  expect(after.versions).toEqual(before.versions);
}

/** SQLite storage type of a column across all rows — must be 'integer', never 'real'. */
function storageTypes(
  db: SqliteDatabase,
  column: string,
): string[] {
  return (
    db.prepare(`SELECT DISTINCT typeof(${column}) AS t FROM events`).all() as Array<{ t: string }>
  ).map((r) => r.t);
}

// ---------------------------------------------------------------------------
// A. In-process dispatcher matrix
// ---------------------------------------------------------------------------

describe("Pkg3 A: dispatcher validation contract (in-process)", () => {
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
    dir = mkdtempSync(join(tmpdir(), "tide-pkg3-"));
    dbPath = join(dir, "tide.db");
    core = new EventCore(dbPath);
    dispatch = makeDispatcher(core);
  }

  async function rpc(
    op: string,
    args: Record<string, unknown>,
  ): Promise<{ ok: boolean; result?: unknown; error?: string }> {
    reqId += 1;
    return JSON.parse(
      await handleLine(dispatch, JSON.stringify({ id: reqId, op, args })),
    ) as { ok: boolean; result?: unknown; error?: string };
  }

  /**
   * Assert a deterministic rejection that leaves the persistent state
   * byte-identical and does not poison the next valid request.
   */
  async function expectRejected(
    before: ReturnType<typeof fullSnapshot>,
    op: string,
    args: Record<string, unknown>,
    errorMatch: RegExp,
    label: string,
  ): Promise<void> {
    const res = await rpc(op, args);
    expect(res.ok, `${label}: expected ok:false, got ${JSON.stringify(res)}`).toBe(false);
    expect(res.error ?? "", `${label}: error message`).toMatch(errorMatch);
    expectUnchanged(before, openFullSnapshot(dbPath));
  }

  test("wrong scalar types per field rejected with zero state change", async () => {
    setup();
    await rpc("create_event", { input: INPUT });
    const before = openFullSnapshot(dbPath);

    const badInputs: Array<[string, Record<string, unknown>]> = [
      ["title/number", { ...INPUT, title: 42 }],
      ["title/float", { ...INPUT, title: 4.5 }],
      ["title/bool", { ...INPUT, title: true }],
      ["title/null", { ...INPUT, title: null }],
      ["description/number", { ...INPUT, description: 0 }],
      ["description/null", { ...INPUT, description: null }],
      ["startMs/string", { ...INPUT, startMs: "abc" }],
      ["startMs/numeric-string", { ...INPUT, startMs: String(START) }],
      ["startMs/null", { ...INPUT, startMs: null }],
      ["startMs/bool", { ...INPUT, startMs: true }],
      ["endMs/string", { ...INPUT, endMs: "abc" }],
      ["endMs/null", { ...INPUT, endMs: null }],
      ["endMs/bool", { ...INPUT, endMs: false }],
      ["startMs/fractional", { ...INPUT, startMs: START + 0.5 }],
      ["endMs/fractional", { ...INPUT, endMs: 42.5 }],
      ["startMs/Infinity(1e999)", { ...INPUT, startMs: Number("1e999") }],
      ["endMs/NaN", { ...INPUT, endMs: Number.NaN }],
      ["allDay/string", { ...INPUT, allDay: "yes" }],
      ["allDay/number-1", { ...INPUT, allDay: 1 }],
      ["allDay/number-0", { ...INPUT, allDay: 0 }],
      ["allDay/null", { ...INPUT, allDay: null }],
      ["input/null", null as unknown as Record<string, unknown>],
      ["input/string", "event" as unknown as Record<string, unknown>],
      ["input/array", [INPUT] as unknown as Record<string, unknown>],
    ];
    for (const [label, input] of badInputs) {
      await expectRejected(
        before,
        "create_event",
        { input },
        /must be a string|must be a finite number|must be an integer|must be a boolean|input must be an object/,
        `create ${label}`,
      );
      await expectRejected(
        before,
        "update_event",
        { id: "evt-nonexistent", input },
        /must be a string|must be a finite number|must be an integer|must be a boolean|input must be an object|event not found/,
        `update ${label}`,
      );
    }
  });

  test("missing required fields rejected on create AND update (full input required, F-2)", async () => {
    setup();
    const created = await rpc("create_event", { input: INPUT });
    expect(created.ok).toBe(true);
    const id = (created.result as { id: string }).id;
    const before = openFullSnapshot(dbPath);

    // Each field omitted in turn, on both ops.
    for (const field of ["title", "description", "startMs", "endMs", "allDay"] as const) {
      const partial: Record<string, unknown> = { ...INPUT };
      delete partial[field];
      const expectedMissing = new RegExp(`missing required field\\(s\\): .*${field}`);
      await expectRejected(before, "create_event", { input: partial }, expectedMissing, `create missing ${field}`);
      await expectRejected(before, "update_event", { id, input: partial }, expectedMissing, `update missing ${field}`);
    }

    // The exact F-2 baseline: partial update missing description used to
    // surface `NOT NULL constraint failed: events.description`.
    const noDescription = { title: "x", startMs: START, endMs: END, allDay: false };
    const res = await rpc("update_event", { id, input: noDescription });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/missing required field\(s\): description/);
    expect(res.error).toMatch(/full event input/);
    expect(res.error).not.toMatch(/NOT NULL/);
    expectUnchanged(before, openFullSnapshot(dbPath));

    // BND-04: a missing allDay is an explicit error, never a silent false.
    const noAllDay = { ...INPUT };
    delete (noAllDay as Record<string, unknown>).allDay;
    await expectRejected(
      before,
      "update_event",
      { id, input: noAllDay },
      /missing required field\(s\): allDay/,
      "update missing allDay",
    );

    // Nothing was defaulted or written by any of the partial attempts.
    const listed = await rpc("list_events", {});
    expect(listed.ok).toBe(true);
    expect(listed.result).toEqual([
      { id, ...INPUT },
    ]);
  });

  test("BND-02: endMs < startMs rejected on create AND update; response/row/record stay consistent", async () => {
    setup();
    const created = await rpc("create_event", { input: INPUT });
    const id = (created.result as { id: string }).id;
    const before = openFullSnapshot(dbPath);

    // The exact BND-02 repro shape (start 1000, end 500-clamp territory):
    const inverted = { ...INPUT, startMs: START, endMs: START - 4500 };
    await expectRejected(
      before,
      "create_event",
      { input: inverted },
      /endMs \(.*\) must be >= input.startMs/,
      "create inverted",
    );
    await expectRejected(
      before,
      "update_event",
      { id, input: inverted },
      /endMs \(.*\) must be >= input.startMs/,
      "update inverted",
    );

    // After a legitimate update the response echo, the stored row, and the
    // change-record payload carry the SAME schedule values (the baseline
    // carried three different ones).
    const newEnd = END + 3_600_000;
    const upd = await rpc("update_event", {
      id,
      input: { ...INPUT, endMs: newEnd },
    });
    expect(upd.ok).toBe(true);
    expect((upd.result as { startMs: number; endMs: number }).startMs).toBe(START);
    expect((upd.result as { endMs: number }).endMs).toBe(newEnd);

    const db = openDatabase({ path: dbPath });
    try {
      const row = db
        .prepare("SELECT utc_start_ms, utc_end_ms FROM events WHERE event_id = ?")
        .get(id) as { utc_start_ms: number; utc_end_ms: number };
      expect(row.utc_start_ms).toBe(START);
      expect(row.utc_end_ms).toBe(newEnd);
      const scheduleRecord = db
        .prepare(
          "SELECT payload FROM changes WHERE entity_id = ? AND field_path = 'schedule' ORDER BY local_seq DESC LIMIT 1",
        )
        .get(id) as { payload: string };
      const payload = JSON.parse(scheduleRecord.payload) as {
        value: { startMs: number; endMs: number };
      };
      expect(payload.value.startMs).toBe(START);
      expect(payload.value.endMs).toBe(newEnd);
      expect(storageTypes(db, "utc_start_ms")).toEqual(["integer"]);
      expect(storageTypes(db, "utc_end_ms")).toEqual(["integer"]);
    } finally {
      db.close();
    }
  });

  test("boundary values: endMs == startMs, 0, negative, and the epoch-ms domain bound", async () => {
    setup();

    // Zero-duration event accepted (endMs == startMs), values exact.
    const zero = await rpc("create_event", {
      input: { ...INPUT, startMs: START, endMs: START },
    });
    expect(zero.ok).toBe(true);
    expect(zero.result).toEqual({ id: expect.stringMatching(/^evt-/), ...INPUT, endMs: START });
    let db = openDatabase({ path: dbPath });
    try {
      const row = db
        .prepare("SELECT utc_start_ms, utc_end_ms, typeof(utc_start_ms) AS t FROM events")
        .get() as { utc_start_ms: number; utc_end_ms: number; t: string };
      expect(row.utc_start_ms).toBe(START);
      expect(row.utc_end_ms).toBe(START);
      expect(row.t).toBe("integer");
    } finally {
      db.close();
    }

    // startMs 0 and negative (pre-1970) timestamps are VALID per the
    // documented contract; stored and echoed exactly.
    const epochZero = await rpc("create_event", {
      input: { ...INPUT, title: "epoch", startMs: 0, endMs: 1 },
    });
    expect(epochZero.ok).toBe(true);
    const pre1970 = await rpc("create_event", {
      input: { ...INPUT, title: "pre-1970", startMs: -86400000, endMs: -3600000 },
    });
    expect(pre1970.ok).toBe(true);
    expect((pre1970.result as { startMs: number }).startMs).toBe(-86400000);

    // +/-MAX_EVENT_MS accepted (ECMAScript Date range boundary).
    const maxRange = await rpc("create_event", {
      input: { ...INPUT, title: "max", startMs: -MAX_EVENT_MS, endMs: MAX_EVENT_MS },
    });
    expect(maxRange.ok).toBe(true);
    expect((maxRange.result as { endMs: number }).endMs).toBe(MAX_EVENT_MS);

    db = openDatabase({ path: dbPath });
    try {
      expect(storageTypes(db, "utc_start_ms")).toEqual(["integer"]);
      expect(storageTypes(db, "utc_end_ms")).toEqual(["integer"]);
      const pre1970Row = db
        .prepare("SELECT utc_start_ms FROM events WHERE title = 'pre-1970'")
        .get() as { utc_start_ms: number };
      expect(pre1970Row.utc_start_ms).toBe(-86400000);
    } finally {
      db.close();
    }

    // Beyond the documented bound: rejected — including 2^53 and 2^53-1,
    // which ARE exact integers, because the epoch-ms domain ends at 8.64e15
    // (wider values yield Invalid Date in the derived columns; see report).
    const before = openFullSnapshot(dbPath);
    for (const [label, v] of [
      ["2^53", 2 ** 53],
      ["2^53-1", 2 ** 53 - 1],
      ["MAX_EVENT_MS+1", MAX_EVENT_MS + 1],
      ["-MAX_EVENT_MS-1", -MAX_EVENT_MS - 1],
    ] as Array<[string, number]>) {
      await expectRejected(
        before,
        "create_event",
        { input: { ...INPUT, endMs: v } },
        /outside the epoch-ms domain/,
        `endMs ${label}`,
      );
      await expectRejected(
        before,
        "create_event",
        { input: { ...INPUT, startMs: v, endMs: MAX_EVENT_MS } },
        /outside the epoch-ms domain/,
        `startMs ${label}`,
      );
    }
  });

  test("BND-03 regression: no silent transformation reaches the SQLite seam", async () => {
    setup();
    const before = openFullSnapshot(dbPath);
    // The exact baseline observations, now rejected BEFORE any write:
    // title:42 -> was stored "42.0"; startMs:"abc"/null -> was stored 0;
    // 1e999 -> was response null / stored 0.
    await expectRejected(before, "create_event", { input: { ...INPUT, title: 42 } }, /must be a string/, "title:42");
    await expectRejected(before, "create_event", { input: { ...INPUT, startMs: "abc" } }, /finite number/, "startMs:'abc'");
    await expectRejected(before, "create_event", { input: { ...INPUT, startMs: null } }, /finite number/, "startMs:null");
    const after = openFullSnapshot(dbPath);
    expect(after.events).toEqual([]); // zero rows written by any attempt
  });

  test("malformed ids still rejected (Pkg2 regression) with zero state change", async () => {
    setup();
    const created = await rpc("create_event", { input: INPUT });
    const id = (created.result as { id: string }).id;
    const before = openFullSnapshot(dbPath);
    for (const bad of [undefined, null, 42, { x: 1 }, "", "   "]) {
      await expectRejected(
        before,
        "update_event",
        { id: bad, input: INPUT },
        /args\.id must be a non-empty string/,
        `update id=${JSON.stringify(bad)}`,
      );
      await expectRejected(
        before,
        "create_event",
        { input: { ...INPUT, id: "evt-injected" } },
        /input\.id is not accepted/,
        "create injected id",
      );
    }
    expect((await rpc("list_events", {})).result).toEqual([{ id, ...INPUT }]);
  });

  test("rejections never poison the next valid request; state advances only via valid ops", async () => {
    setup();
    // Interleave invalid and valid ops from a cold DB; each invalid one must
    // leave the snapshot exactly as the previous valid op left it.
    let snap = openFullSnapshot(dbPath);

    const bad1 = await rpc("create_event", {
      input: { ...INPUT, startMs: START, endMs: START - 1 },
    });
    expect(bad1.ok).toBe(false);
    expectUnchanged(snap, openFullSnapshot(dbPath));

    const v1 = await rpc("create_event", { input: INPUT });
    expect(v1.ok).toBe(true);
    snap = openFullSnapshot(dbPath);
    expect(snap.changes.filter((c) => (c as { entity_id: string }).entity_id === "local").length).toBeGreaterThanOrEqual(0);

    const id = (v1.result as { id: string }).id;
    const bad2 = await rpc("update_event", { id, input: { ...INPUT, title: 42 } });
    expect(bad2.ok).toBe(false);
    expectUnchanged(snap, openFullSnapshot(dbPath));

    const bad3 = await rpc("update_event", { id, input: { title: "partial" } });
    expect(bad3.ok).toBe(false);
    expectUnchanged(snap, openFullSnapshot(dbPath));

    const v2 = await rpc("update_event", { id, input: { ...INPUT, title: "after-rejections" } });
    expect(v2.ok).toBe(true);
    expect((v2.result as { title: string }).title).toBe("after-rejections");
    snap = openFullSnapshot(dbPath);

    const bad4 = await rpc("delete_event", { id: 42 });
    expect(bad4.ok).toBe(false);
    expectUnchanged(snap, openFullSnapshot(dbPath));

    const v3 = await rpc("delete_event", { id });
    expect(v3.ok).toBe(true);
    expect((await rpc("list_events", {})).result).toEqual([]);
  });

  test("defense-in-depth: EventCore itself enforces the value rules (dispatcher bypass)", () => {
    setup();
    const ev = core.createEvent(INPUT);
    const before = fullSnapshot(core.db);

    expect(() =>
      core.createEvent({ ...INPUT, endMs: START - 1 }),
    ).toThrow(/endMs .* must be >= input.startMs/);
    expect(() =>
      core.updateEvent(ev.id, { ...INPUT, startMs: 42.5 }),
    ).toThrow(/must be an integer number of epoch/);
    expect(() =>
      core.updateEvent(ev.id, { ...INPUT, endMs: 2 ** 53 }),
    ).toThrow(/outside the epoch-ms domain/);
    expectUnchanged(before, fullSnapshot(core.db));
    // Valid boundary still accepted at the domain layer.
    expect(() => core.updateEvent(ev.id, { ...INPUT, endMs: START })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// B. Raw sidecar stdio — dist/sidecar.mjs REBUILT via `npm run
//    sidecar:build` (the artifact the Rust layer spawns). The typed Rust
//    EventInput is serde-typed to exactly five fields and CANNOT emit any
//    of the adversarial shapes below — raw stdio IS the attack path.
// ---------------------------------------------------------------------------

interface RpcResponse {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
}

async function runSidecar(
  bundle: string,
  dbPath: string,
  lines: string[],
): Promise<RpcResponse[]> {
  const childEnv = { ...process.env };
  delete childEnv.VITEST;
  childEnv.TIDE_DB_PATH = dbPath;
  const child = spawn(process.execPath, [bundle], {
    env: childEnv,
    stdio: ["pipe", "pipe", "inherit"],
  });
  const responses: RpcResponse[] = [];
  try {
    const rl = createInterface({ input: child.stdout });
    const done = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`timeout after responses: ${JSON.stringify(responses)}`)),
        20_000,
      );
      rl.on("line", (line) => {
        if (!line.trim()) return;
        responses.push(JSON.parse(line) as RpcResponse);
        if (responses.length === lines.length) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.on("exit", (code: number | null) =>
        reject(new Error(`sidecar exited early code=${code}: ${responses.length}/${lines.length} responses`)),
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
  // The dispatcher answers requests ASYNCHRONOUSLY (handleLine is fire-and-
  // forget per line), so responses can arrive out of order. Re-order by
  // request id — every probe in this file sends numeric ids.
  return responses.sort((a, b) => (a.id as number) - (b.id as number));
}

describe("Pkg3 B: raw sidecar stdio validation battery (rebuilt dist)", () => {
  let dir: string;

  beforeAll(() => {
    // REQUIRED probe hygiene: the raw path must exercise the CURRENT
    // sources — rebuild dist/sidecar.mjs before spawning it.
    execFileSync("npm", ["run", "sidecar:build"], { cwd: REPO, stdio: "inherit" });
  });

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test("adversarial battery rejected over raw stdio; adjacent valid ops land; state exact", async () => {
    dir = mkdtempSync(join(tmpdir(), "tide-pkg3-e2e-"));
    const dbPath = join(dir, "tide.db");
    const bundle = join(REPO, "dist", "sidecar.mjs");
    const line = (id: number, op: string, args: unknown): string =>
      JSON.stringify({ id, op, args });

    // Attack battery interleaved with valid ops (ids 1-8 invalid, 9 create,
    // 10 update — the create's generated id is unknowable upfront, so the
    // update uses a second pass; here the valid ops verify the sidecar
    // stays healthy and deterministic after the rejections).
    const responses = await runSidecar(bundle, dbPath, [
      // BND-02: inverted range on create
      line(1, "create_event", { input: { ...INPUT, startMs: START, endMs: START - 5000 } }),
      // BND-03 battery: title:42 / startMs:"abc" / startMs:null / 1e999
      line(2, "create_event", { input: { ...INPUT, title: 42 } }),
      line(3, "create_event", { input: { ...INPUT, startMs: "abc" } }),
      line(4, "create_event", { input: { ...INPUT, startMs: null } }),
      line(5, "create_event", { input: { ...INPUT, startMs: 1e999 } }),
      // BND-04: allDay garbage + missing allDay
      line(6, "create_event", { input: { ...INPUT, allDay: "yes" } }),
      line(7, "create_event", { input: { title: INPUT.title, description: INPUT.description, startMs: START, endMs: END } }),
      // F-2: partial update missing description
      line(8, "update_event", { id: "evt-whatever", input: { title: "partial", startMs: START, endMs: END, allDay: false } }),
      // valid, immediately adjacent to the rejections
      line(9, "create_event", { input: INPUT }),
      line(10, "update_event", { id: "evt-nonexistent", input: INPUT }),
    ]);

    expect(responses).toHaveLength(10);
    const expectedErrors = [
      /endMs .* must be >= input.startMs/,
      /input\.title must be a string/,
      /input\.startMs must be a finite number/,
      /input\.startMs must be a finite number/,
      /input\.startMs must be a finite number/,
      /input\.allDay must be a boolean/,
      /missing required field\(s\): allDay/,
      /missing required field\(s\): description/,
    ];
    for (let i = 0; i < 8; i++) {
      expect(responses[i]!.ok, `attack ${i + 1} must be rejected: ${JSON.stringify(responses[i])}`).toBe(false);
      expect(responses[i]!.error).toMatch(expectedErrors[i]!);
    }
    // No raw SQLite errors anywhere in the battery.
    for (const r of responses) {
      expect(r.error ?? "").not.toMatch(/NOT NULL|SQLITE|constraint failed/i);
    }
    // 9: valid create lands with the exact echoed values.
    expect(responses[8]!.ok).toBe(true);
    expect(responses[8]!.result).toEqual({ id: expect.stringMatching(/^evt-/), ...INPUT });
    // 10: update of an unknown id is the documented not-found error (also
    // deterministic, also zero side effects).
    expect(responses[9]!.ok).toBe(false);
    expect(responses[9]!.error).toMatch(/event not found/);

    // Persistent state: exactly ONE row with the exact values, integer
    // storage, and no change records from any rejected request.
    const db = openDatabase({ path: dbPath });
    try {
      const rows = db.prepare("SELECT * FROM events").all() as Array<{
        event_id: string;
        title: string;
        description: string;
        utc_start_ms: number;
        utc_end_ms: number;
        all_day: number;
      }>;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        title: INPUT.title,
        description: INPUT.description,
        utc_start_ms: START,
        utc_end_ms: END,
        all_day: 0,
      });
      expect(storageTypes(db, "utc_start_ms")).toEqual(["integer"]);
      expect(storageTypes(db, "utc_end_ms")).toEqual(["integer"]);
      // Exactly two records: the calendar bootstrap (entity 'local', written
      // once at first construction) + the ONE create record. No change
      // records from any rejected request.
      const eventChanges = db
        .prepare("SELECT entity_id, field_path, operation FROM changes ORDER BY local_seq")
        .all() as Array<{ entity_id: string; field_path: string; operation: string }>;
      expect(eventChanges).toEqual([
        { entity_id: "local", field_path: "title", operation: "set" },
        { entity_id: rows[0]!.event_id, field_path: "event", operation: "set" },
      ]);
    } finally {
      db.close();
    }

    // Follow-up session on the SAME db: valid update with the boundary
    // value endMs == startMs lands exactly; rejected garbage in between
    // changes nothing.
    const realId = (responses[8]!.result as { id: string }).id;
    const pass2 = await runSidecar(bundle, dbPath, [
      line(1, "update_event", { id: realId, input: { ...INPUT, startMs: START, endMs: START - 1 } }),
      line(2, "update_event", { id: realId, input: { ...INPUT, title: "updated", startMs: START, endMs: START } }),
      line(3, "list_events", {}),
    ]);
    expect(pass2[0]!.ok).toBe(false);
    expect(pass2[0]!.error).toMatch(/must be >= input.startMs/);
    expect(pass2[1]!.ok).toBe(true);
    expect(pass2[1]!.result).toEqual({ id: realId, ...INPUT, title: "updated", endMs: START });
    expect(pass2[2]!.result).toEqual([
      { id: realId, title: "updated", description: INPUT.description, startMs: START, endMs: START, allDay: false },
    ]);

    const db2 = openDatabase({ path: dbPath });
    try {
      const row = db2
        .prepare("SELECT utc_start_ms, utc_end_ms FROM events WHERE event_id = ?")
        .get(realId) as { utc_start_ms: number; utc_end_ms: number };
      expect(row.utc_start_ms).toBe(START);
      expect(row.utc_end_ms).toBe(START);
      const scheduleRecords = db2
        .prepare("SELECT payload FROM changes WHERE entity_id = ? AND field_path = 'schedule'")
        .all(realId) as Array<{ payload: string }>;
      expect(scheduleRecords).toHaveLength(1);
      const payload = JSON.parse(scheduleRecords[0]!.payload) as {
        value: { startMs: number; endMs: number; allDay: boolean };
      };
      expect(payload.value).toEqual({ startMs: START, endMs: START, allDay: false });
    } finally {
      db2.close();
    }
  });
});

// ---------------------------------------------------------------------------
// C. Two-peer sync — peers materialize EXACTLY the values the creating /
//    updating device materialized (BND-02's sync-disagreement mode closed).
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

describe("Pkg3 C: synced values are exactly the materialized values", () => {
  test("rejected inverted-range update writes nothing; legit update converges byte-exact on peer", async () => {
    const dirA = mkdtempSync(join(tmpdir(), "tide-pkg3-a-"));
    const dirB = mkdtempSync(join(tmpdir(), "tide-pkg3-b-"));
    const identityA = loadOrCreateIdentity(dirA);
    const identityB = loadOrCreateIdentity(dirB);
    const coreA = new EventCore(join(dirA, "tide.db"), identityA.deviceId);
    const coreB = new EventCore(join(dirB, "tide.db"), identityB.deviceId);

    try {
      // Create with boundary-exact values, then a legit update.
      const ev = coreA.createEvent({
        title: "sync probe",
        description: "exact values",
        startMs: 0,
        endMs: END,
        allDay: false,
      });
      const FINAL_START = START;
      const FINAL_END = END + 1_800_000;
      coreA.updateEvent(ev.id, {
        title: "sync probe",
        description: "exact values",
        startMs: FINAL_START,
        endMs: FINAL_END,
        allDay: true,
      });
      // The BND-02 attack: rejected at the domain core — NOTHING is written,
      // so peers can never see a clamped/divergent schedule.
      expect(() =>
        coreA.updateEvent(ev.id, {
          title: "sync probe",
          description: "exact values",
          startMs: FINAL_START,
          endMs: FINAL_START - 1,
          allDay: true,
        }),
      ).toThrow(/must be >= input.startMs/);

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

      // Peer B materialized the EXACT final schedule (allDay included).
      expect(coreB.listEvents()).toEqual(coreA.listEvents());
      expect(coreB.listEvents()).toEqual([
        {
          id: ev.id,
          title: "sync probe",
          description: "exact values",
          startMs: FINAL_START,
          endMs: FINAL_END,
          allDay: true,
        },
      ]);
      const bRow = coreB.db
        .prepare("SELECT utc_start_ms, utc_end_ms, all_day FROM events WHERE event_id = ?")
        .get(ev.id) as { utc_start_ms: number; utc_end_ms: number; all_day: number };
      expect(bRow).toEqual({ utc_start_ms: FINAL_START, utc_end_ms: FINAL_END, all_day: 1 });
      expect(typeof bRow.utc_end_ms).toBe("number");
      expect(Number.isInteger(bRow.utc_end_ms)).toBe(true);

      // No inverted/garbage records ever existed on either side.
      const aInverted = coreA.db
        .prepare(
          "SELECT COUNT(*) AS c FROM changes WHERE entity_id = ? AND payload LIKE '%-1,%'",
        )
        .get(ev.id) as { c: number };
      expect(aInverted.c).toBe(0);
    } finally {
      coreA.db.close();
      coreB.db.close();
      rmSync(dirA, { recursive: true, force: true });
      rmSync(dirB, { recursive: true, force: true });
    }
  });
});
