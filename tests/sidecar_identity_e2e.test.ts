// TD-004: E2E test driving the sidecar's REAL main() production startup.
//
// Unlike tests/event_store_bridge.test.ts (which exercises handleLine with a
// hand-built dispatcher) and tests/two_instance_sync.test.ts (in-process
// devices), this test spawns the actual esbuild-bundled sidecar process — the
// same artifact the Rust layer runs — with TIDE_DB_PATH / TIDE_DATA_DIR in a
// fresh temp dir and drives it purely over the stdio JSON-RPC surface.
//
// Verified wiring (F1 identity-split fix in sidecar_server.ts main()):
//   1. SyncManager's deviceId == the identity persisted in the data dir
//      (device_identity.key, loaded back via loadOrCreateIdentity);
//   2. EventCore change records carry that SAME device id (no legacy
//      `dev-` marker-file split identity);
//   3. killing the process and restarting on the SAME data dir yields the
//      identical deviceId and new records still carry it (stability).
//
// Deterministic: execFileSync round-trips (no sleeps/races); bounded runtime
// (one esbuild bundle + two short-lived processes).
import { describe, expect, test, afterEach } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadOrCreateIdentity } from "../src/network/sync_runtime.ts";
import { openDatabase } from "../src/persistence/database.ts";

const INPUT = {
  title: "TD-004 probe",
  description: "identity wiring e2e",
  startMs: Date.UTC(2026, 8, 1, 12, 0, 0),
  endMs: Date.UTC(2026, 8, 1, 13, 0, 0),
  allDay: false,
};

interface RpcResponse {
  id: number;
  ok: boolean;
  result?: Record<string, unknown>;
  error?: string;
}

function buildSidecarBundle(): string {
  // Bundle inside the repo so the external better-sqlite3 import resolves
  // (same pattern as tests/event_store_bridge.test.ts).
  const outdir = mkdtempSync(join(import.meta.dirname, "../dist/td004-"));
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

/**
 * Run the real sidecar main() over stdio with the given RPC lines.
 *
 * `device_info` starts the sync TCP listener, which intentionally keeps the
 * production process alive — so we cannot wait for child exit. Instead we
 * spawn, write the requests, collect the expected number of responses
 * (polling with a hard timeout — deterministic, no sleeps), then kill the
 * process to simulate a crash/kill between sessions.
 */
async function runSidecar(
  bundle: string,
  dbPath: string,
  dataDir: string,
  lines: string[],
): Promise<RpcResponse[]> {
  const childEnv = { ...process.env };
  // The sidecar's "not under vitest" entry gate must stay open.
  delete childEnv.VITEST;
  childEnv.TIDE_DB_PATH = dbPath;
  childEnv.TIDE_DATA_DIR = dataDir;
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
        15_000,
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
    await done;
  } finally {
    if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null) return resolve();
      child.on("exit", () => resolve());
    });
  }
  return responses;
}

function ok(res: RpcResponse, what: string): Record<string, unknown> {
  expect(res.ok, `${what} failed: ${res.error ?? ""}`).toBe(true);
  return res.result ?? {};
}

/** All distinct producer device_ids in the durable changes table. */
function changeDeviceIds(dbPath: string): string[] {
  const db = openDatabase({ path: dbPath });
  try {
    return (
      db.prepare("SELECT DISTINCT device_id FROM changes ORDER BY device_id")
        .all() as { device_id: string }[]
    ).map((r) => r.device_id);
  } finally {
    db.close();
  }
}

let dir: string;
let bundle: string;

afterEach(() => {
  if (bundle) rmSync(bundle, { force: true });
  if (bundle) rmSync(join(bundle, ".."), { recursive: true, force: true });
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("TD-004: sidecar main() production identity wiring (E2E)", () => {
  test("one identity across SyncManager, EventCore records, and restart", async () => {
    dir = mkdtempSync(join(tmpdir(), "tide-td004-"));
    const dbPath = join(dir, "tide.db");
    const dataDir = join(dir, "data");
    // The production launcher creates the data dir before spawning.
    mkdirSync(dataDir, { recursive: true });
    bundle = buildSidecarBundle();

    // ---- Session 1: real main() startup, identity exposed over RPC --------
    const r1 = await runSidecar(bundle, dbPath, dataDir, [
      JSON.stringify({ id: 1, op: "device_info" }),
      JSON.stringify({ id: 2, op: "create_event", args: { input: INPUT } }),
      JSON.stringify({ id: 3, op: "ping" }),
    ]);
    const [info1, created, ping1] = [r1[0]!, r1[1]!, r1[2]!];

    const deviceId: string = ok(info1, "device_info")["device_id"] as string;
    expect(deviceId).toMatch(/^d-/); // Ed25519-derived id, not legacy dev-*
    ok(created, "create_event");
    // (a) SyncManager id == EventCore id within the SAME process: ping
    // reports core.selfDeviceId and must equal the sync identity id.
    expect(ok(ping1, "ping")["device_id"]).toBe(deviceId);

    // (a) SyncManager id == the identity persisted in the data dir.
    expect(existsSync(join(dataDir, "device_identity.key"))).toBe(true);
    expect(loadOrCreateIdentity(dataDir).deviceId).toBe(deviceId);

    // The F1 fix means EventCore's legacy marker-file fallback is never
    // reached during main() startup — no `dev-*` split identity may exist.
    expect(existsSync(`${dbPath}.device_id`)).toBe(false);

    // (b) EventCore change records (created through the real dispatcher,
    // incl. the calendar bootstrap writes) carry that same id — and ONLY it.
    const ids1 = changeDeviceIds(dbPath);
    expect(ids1).toEqual([deviceId]);

    // ---- Session 2: kill (process exited) + restart on the SAME data dir --
    const r2 = await runSidecar(bundle, dbPath, dataDir, [
      JSON.stringify({ id: 1, op: "device_info" }),
      JSON.stringify({
        id: 2,
        op: "create_event",
        args: { input: { ...INPUT, title: "TD-004 probe II" } },
      }),
      JSON.stringify({ id: 3, op: "ping" }),
    ]);
    const [info2, created2, ping2] = [r2[0]!, r2[1]!, r2[2]!];

    // (c) identity is stable across restart.
    expect(ok(info2, "device_info#2")["device_id"]).toBe(deviceId);
    expect(ok(ping2, "ping#2")["device_id"]).toBe(deviceId);
    ok(created2, "create_event#2");

    // (b, c) all records — old and newly created after restart — still carry
    // exactly the one shared identity.
    expect(changeDeviceIds(dbPath)).toEqual([deviceId]);

    const db = openDatabase({ path: dbPath });
    try {
      const titles = (
        db.prepare("SELECT title FROM events ORDER BY title").all() as {
          title: string;
        }[]
      ).map((r) => r.title);
      expect(titles).toContain("TD-004 probe");
      expect(titles).toContain("TD-004 probe II");
    } finally {
      db.close();
    }

    // Data dir contains the identity key and nothing identity-splitting.
    expect(readdirSync(dataDir)).toContain("device_identity.key");
  });
});
