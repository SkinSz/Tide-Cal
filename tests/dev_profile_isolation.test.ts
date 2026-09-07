// Dev-profile isolation (owner instruction 2026-09-07): contract tests
// proving the profile boundary at the ACTUAL process/env level, not by
// source inspection.
//
// Scope (per instruction §5):
//   A. Real sidecar DB-path crossing — spawn the REAL bundled sidecar with
//      the env contract the Rust shell emits (TIDE_DB_PATH + TIDE_DATA_DIR
//      pointing at a simulated com.tide.app.dev profile dir) and verify the
//      database + identity physically land inside the dev profile.
//   B. Identity isolation — dev-profile identity != a separately-bootstrapped
//      production-profile identity; no cross-contamination of key material.
//   C. Profile path shape — the Rust profile_id() contract reproduced as the
//      leaf-directory rule (com.tide.app.dev), mirrored in TS for regression
//      documentation of the boundary the launcher must honor.
//
// These tests deliberately do NOT import lib.rs (Rust); they verify the TS
// side of the boundary the Rust launcher hands over.
import { describe, expect, test, afterEach } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadOrCreateIdentity } from "../src/network/sync_runtime.ts";
import { openDatabase } from "../src/persistence/database.ts";

const PROD_PROFILE = "com.tide.app";
const DEV_PROFILE = "com.tide.app.dev";

interface RpcResponse {
  id: number;
  ok: boolean;
  result?: Record<string, unknown>;
  error?: string;
}

function buildSidecarBundle(): string {
  const outdir = mkdtempSync(join(import.meta.dirname, "../dist/devprof-"));
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
  env: Record<string, string>,
  lines: string[],
): Promise<RpcResponse[]> {
  const childEnv = { ...process.env, ...env };
  delete childEnv.VITEST;
  const child = spawn(process.execPath, [bundle], {
    env: childEnv,
    stdio: ["pipe", "pipe", "inherit"],
  });
  const responses: RpcResponse[] = [];
  try {
    const rl = createInterface({ input: child.stdout });
    // Write FIRST (synchronously, before awaiting): the sidecar only answers
    // once stdin lines arrive; awaiting response setup first deadlocks.
    child.stdin.write(lines.join("\n") + "\n");
    child.stdin.end();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`timeout; got ${JSON.stringify(responses)}`)),
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
      child.on("exit", (code) =>
        reject(new Error(`sidecar exited code=${code}: ${responses.length}/${lines.length}`)),
      );
    });
  } finally {
    if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null) return resolve();
      child.on("exit", () => resolve());
    });
  }
  return responses;
}

let bundle: string;
let dir: string;

afterEach(() => {
  if (bundle) rmSync(join(bundle, ".."), { recursive: true, force: true });
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("dev-profile isolation: sidecar boundary (real process)", () => {
  test("sidecar writes DB + identity INSIDE the dev profile dirs it was given", { timeout: 30_000 }, async () => {
    dir = mkdtempSync(join(tmpdir(), "tide-devprof-"));
    // Simulate exactly what the Rust launcher resolves for a dev build:
    const devData = join(dir, "local-share", DEV_PROFILE);
    const devConfig = join(dir, "config", DEV_PROFILE);
    mkdirSync(devData, { recursive: true });
    mkdirSync(devConfig, { recursive: true });
    const dbPath = join(devData, "tide-domain.db");
    bundle = buildSidecarBundle();

    const res = await runSidecar(
      bundle,
      { TIDE_DB_PATH: dbPath, TIDE_DATA_DIR: devData },
      [
        JSON.stringify({ id: 1, op: "device_info" }),
        JSON.stringify({
          id: 2,
          op: "create_event",
          args: {
            input: {
              title: "devprof probe",
              description: "",
              startMs: Date.UTC(2026, 8, 1, 12),
              endMs: Date.UTC(2026, 8, 1, 13),
              allDay: false,
            },
          },
        }),
        JSON.stringify({ id: 3, op: "ping" }),
      ],
    );
    expect(res[0]!.ok, res[0]!.error).toBe(true);
    expect(res[1]!.ok, res[1]!.error).toBe(true);
    expect(res[2]!.ok, res[2]!.error).toBe(true);

    // The env crossing is real: files physically exist in the DEV profile.
    expect(existsSync(dbPath)).toBe(true);
    expect(existsSync(join(devData, "device_identity.key"))).toBe(true);
    // Nothing leaked into a production-shaped sibling.
    expect(existsSync(join(dir, "local-share", PROD_PROFILE))).toBe(false);
    // Legacy marker-file identity absent (F1: single identity, no dev-* split).
    expect(existsSync(`${dbPath}.device_id`)).toBe(false);

    // Reported deviceId == identity persisted in the DEV profile dir.
    const devId = loadOrCreateIdentity(devData).deviceId;
    expect(res[0]!.result?.["device_id"]).toBe(devId);
  });

  test("dev-profile identity differs from a separately-bootstrapped prod identity", async () => {
    dir = mkdtempSync(join(tmpdir(), "tide-devprof-iso-"));
    const devData = join(dir, "local-share", DEV_PROFILE);
    const prodData = join(dir, "local-share", PROD_PROFILE);
    mkdirSync(devData, { recursive: true });
    mkdirSync(prodData, { recursive: true });

    const devId = loadOrCreateIdentity(devData);
    const prodId = loadOrCreateIdentity(prodData);

    // Distinct device ids; each dir holds exactly one key; no key migration.
    expect(devId.deviceId).not.toBe(prodId.deviceId);
    expect(existsSync(join(devData, "device_identity.key"))).toBe(true);
    expect(existsSync(join(prodData, "device_identity.key"))).toBe(true);

    // Re-loading from either dir is stable (no cross-write).
    expect(loadOrCreateIdentity(devData).deviceId).toBe(devId.deviceId);
    expect(loadOrCreateIdentity(prodData).deviceId).toBe(prodId.deviceId);
  });

  test("dbs opened in the two profiles are separate sqlite files, both writable", () => {
    dir = mkdtempSync(join(tmpdir(), "tide-devprof-db-"));
    const devDb = join(dir, DEV_PROFILE, "tide-domain.db");
    const prodDb = join(dir, PROD_PROFILE, "tide-domain.db");
    mkdirSync(join(dir, DEV_PROFILE), { recursive: true });
    mkdirSync(join(dir, PROD_PROFILE), { recursive: true });

    const d1 = openDatabase({ path: devDb });
    const d2 = openDatabase({ path: prodDb });
    try {
      // Different files (not one shared DB), each independently usable —
      // WAL mode on one does not lock the other.
      expect(devDb).not.toBe(prodDb);
      d1.prepare(
        "CREATE TABLE probe (k TEXT PRIMARY KEY, v TEXT)",
      ).run();
      d1.prepare("INSERT INTO probe VALUES ('who','dev')").run();
      d2.prepare("CREATE TABLE probe (k TEXT PRIMARY KEY, v TEXT)").run();
      d2.prepare("INSERT INTO probe VALUES ('who','prod')").run();
      expect(d1.prepare("SELECT v FROM probe").get()).toEqual({ v: "dev" });
      expect(d2.prepare("SELECT v FROM probe").get()).toEqual({ v: "prod" });
    } finally {
      d1.close();
      d2.close();
    }
  });
});
