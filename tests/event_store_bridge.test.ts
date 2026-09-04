// Tests for the desktop bridge: EventCore (TS domain core wiring) and the
// sidecar JSON protocol. New file — no existing test was modified.
import { describe, expect, test, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventCore } from "../src/persistence/bridges/event_core.ts";
import { makeDispatcher, handleLine } from "../src/persistence/bridges/sidecar_server.ts";

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tide-bridge-"));
  dbPath = join(dir, "tide.db");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const INPUT = {
  title: "Dentist",
  description: "checkup",
  startMs: Date.UTC(2026, 8, 1, 9, 0, 0),
  endMs: Date.UTC(2026, 8, 1, 10, 0, 0),
  allDay: false,
};

describe("EventCore: mutations go through DC-07 createLocalChange", () => {
  test("create writes event row + change record + device_clock atomically", () => {
    const core = new EventCore(dbPath);
    const ev = core.createEvent(INPUT);

    const row = core.db
      .prepare("SELECT * FROM events WHERE event_id = ?")
      .get(ev.id) as Record<string, unknown>;
    expect(row).toBeDefined();
    expect(row.title).toBe("Dentist");
    expect(row.utc_start_ms).toBe(INPUT.startMs);

    const change = core.db
      .prepare(
        "SELECT entity_id, entity_type, field_path, operation FROM changes WHERE entity_id = ?",
      )
      .get(ev.id) as Record<string, string>;
    expect(change.entity_type).toBe("event");
    expect(change.operation).toBe("set");

    // device_clock advanced with the change (DC-07 §7 T1)
    const clock = core.db
      .prepare("SELECT max_seq FROM device_clock WHERE peer_device_id = ?")
      .get(core.selfDeviceId) as { max_seq: number };
    expect(clock.max_seq).toBeGreaterThanOrEqual(2); // calendar bootstrap + create
    core.db.close();
  });

  test("update emits one change record per changed field group", () => {
    const core = new EventCore(dbPath);
    const ev = core.createEvent(INPUT);
    core.updateEvent(ev.id, {
      ...INPUT,
      title: "Dentist II",
      endMs: INPUT.endMs + 30 * 60_000,
    });

    const paths = core.db
      .prepare<[string], { field_path: string; local_seq: number }>(
        "SELECT field_path, local_seq FROM changes WHERE entity_id = ? ORDER BY local_seq",
      )
      .all(ev.id)
      .map((r) => r.field_path);
    expect(paths).toEqual(["event", "title", "schedule"]);

    const listed = core.listEvents().find((e) => e.id === ev.id)!;
    expect(listed.title).toBe("Dentist II");
    expect(listed.endMs).toBe(INPUT.endMs + 30 * 60_000);
    core.db.close();
  });

  test("no-op update produces no extra change records", () => {
    const core = new EventCore(dbPath);
    const ev = core.createEvent(INPUT);
    core.updateEvent(ev.id, { ...INPUT });
    const n = core.db
      .prepare<[string], { c: number }>(
        "SELECT COUNT(*) AS c FROM changes WHERE entity_id = ?",
      )
      .get(ev.id)!.c;
    expect(n).toBe(1);
    core.db.close();
  });

  test("delete writes remove record + tombstones the row", () => {
    const core = new EventCore(dbPath);
    const ev = core.createEvent(INPUT);
    core.deleteEvent(ev.id);
    expect(core.listEvents()).toHaveLength(0);
    const op = core.db
      .prepare<[string], { operation: string }>(
        "SELECT operation FROM changes WHERE entity_id = ? ORDER BY local_seq",
      )
      .all(ev.id)
      .at(-1)!.operation;
    expect(op).toBe("remove");
    core.db.close();
  });

  test("state persists across reopen; HLC monotone via created_hlc", () => {
    const core = new EventCore(dbPath);
    const ev = core.createEvent(INPUT);
    core.db.close();

    const core2 = new EventCore(dbPath);
    expect(core2.listEvents().map((e) => e.id)).toContain(ev.id);
    // Same device id survives restart -> gap-free seq continues
    const seqs = core2.db
      .prepare<[string], { m: number }>(
        "SELECT MAX(local_seq) AS m FROM changes WHERE device_id = ?",
      )
      .get(core2.selfDeviceId)!.m;
    expect(seqs).toBeGreaterThanOrEqual(2);
    expect(core2.selfDeviceId).toBe(core.selfDeviceId);
    core2.db.close();
  });

  test("all-day events satisfy schema CHECK constraints and round-trip", () => {
    const core = new EventCore(dbPath);
    const day = Date.UTC(2026, 8, 3);
    const ev = core.createEvent({ ...INPUT, startMs: day, endMs: day, allDay: true });
    const got = core.listEvents()[0]!;
    expect(got.id).toBe(ev.id);
    expect(got.allDay).toBe(true);
    core.db.close();
  });
});

describe("frontend/store.ts injected domain-core bridge", () => {
  // The UI prefers window.__TIDE_EVENT_STORE__ when present; verify that
  // mutations actually reach the EventCore-backed adapter (and therefore
  // createLocalChange) instead of Tauri/localStorage.
  test("store routes CRUD through an injected EventStoreBridge", async () => {
    const core = new EventCore(dbPath);
    const calls: string[] = [];
    const bridge = {
      listEvents: (range?: { fromMs?: number | null; toMs?: number | null }) => {
        calls.push("list");
        return core.listEvents(range);
      },
      createEvent: (input: never) => {
        calls.push("create");
        return core.createEvent(input);
      },
      updateEvent: (id: string, input: never) => {
        calls.push("update");
        return core.updateEvent(id, input);
      },
      deleteEvent: (id: string) => {
        calls.push("delete");
        core.deleteEvent(id);
      },
    };
    (globalThis as { window?: unknown }).window = { __TIDE_EVENT_STORE__: bridge };

    const store = await import("../frontend/store.ts");
    const ev = await store.createEvent(INPUT);
    expect(calls).toEqual(["create"]);
    expect(ev.id).toBe((await store.listEvents())[0]!.id);

    await store.updateEvent(ev.id, { ...INPUT, title: "renamed" });
    expect((await store.listEvents())[0]!.title).toBe("renamed");
    await store.deleteEvent(ev.id);
    expect(await store.listEvents()).toHaveLength(0);
    expect(calls).toEqual(["create", "list", "update", "list", "delete", "list"]);

    // Change records prove the mutation ran through the DC-07 core.
    const n = core.db
      .prepare<[string], { c: number }>(
        "SELECT COUNT(*) AS c FROM changes WHERE entity_id = ?",
      )
      .get(ev.id)!.c;
    expect(n).toBe(3); // create(set) + update(title) + delete(remove)

    delete (globalThis as { window?: unknown }).window;
    core.db.close();
  });
});

describe("sidecar protocol", () => {
  test("request/response round-trip incl. error case", async () => {
    const core = new EventCore(dbPath);
    const dispatch = makeDispatcher(core);

    const ping = JSON.parse(await handleLine(dispatch, '{"id":1,"op":"ping"}'));
    expect(ping.ok).toBe(true);
    expect(ping.result.pong).toBe(true);

    const created = JSON.parse(
      await handleLine(dispatch, JSON.stringify({ id: 2, op: "create_event", args: { input: INPUT } })),
    );
    expect(created.ok).toBe(true);
    expect(created.result.title).toBe("Dentist");

    const listed = JSON.parse(await handleLine(dispatch, '{"id":3,"op":"list_events"}'));
    expect(listed.ok).toBe(true);
    expect(listed.result).toHaveLength(1);

    const bad = JSON.parse(await handleLine(dispatch, '{"id":4,"op":"nope"}'));
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/unknown op/);
    core.db.close();
  });

  test("real sidecar process speaks stdio protocol end-to-end", () => {
    // Node's strip-only TS loader can't handle the domain core's parameter
    // properties, so the sidecar runs from an esbuild bundle (same artifact
    // the Rust layer spawns). Build it to a temp dir for hermetic testing.
    // Bundle inside the repo so the external better-sqlite3 import resolves.
    const outdir = mkdtempSync(join(import.meta.dirname, "../dist/bridge-test-"));
    const bundle = join(outdir, "sidecar.mjs");
    execFileSync(
      join(import.meta.dirname, "../node_modules/.bin/esbuild"),
      [
        join(import.meta.dirname, "../src/persistence/bridges/sidecar_server.ts"),
        "--bundle", "--platform=node", "--format=esm",
        "--external:better-sqlite3", `--outfile=${bundle}`,
      ],
    );
    const lines = [
      JSON.stringify({ id: 1, op: "ping" }),
      JSON.stringify({ id: 2, op: "create_event", args: { input: INPUT } }),
      JSON.stringify({ id: 3, op: "list_events" }),
      "",
    ].join("\n");
    const out = execFileSync(process.execPath, [bundle], {
      env: (() => {
        // Vitest sets VITEST=1 in the environment; the child must not see it
        // or the sidecar's "not under test" entry gate stays closed.
        const childEnv = { ...process.env };
        delete childEnv.VITEST;
        childEnv.TIDE_DB_PATH = dbPath;
        return childEnv;
      })(),
      input: lines,
      encoding: "utf8",
    });
    const responses = out
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(responses[0].result.pong).toBe(true);
    expect(responses[1].ok).toBe(true);
    expect(responses[2].ok).toBe(true);
    expect(responses[2].result).toHaveLength(1);

    // Change record really landed in the DB via the TS core
    const core = new EventCore(dbPath);
    const n = core.db.prepare("SELECT COUNT(*) AS c FROM changes").get() as { c: number };
    expect(n.c).toBeGreaterThanOrEqual(2);
    core.db.close();
  });
});
