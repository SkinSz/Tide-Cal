// Regression test for the ensureListener() occupied-port crash
// (root cause demonstrated 2026-08-27: serveSync rejection was fire-and-forget
// without a catch → unhandledRejection → sidecar exited code 1 → every RPC
// surface failed with "sidecar exited: exit status: 1").
//
// Design notes (why this shape):
// - We spawn a CHILD node process running the sidecar, because the failure
//   mode IS process death: an in-process test cannot observe the sidecar
//   exiting under vitest (it would kill the test runner itself pre-fix).
// - IMPORTANT: strip the VITEST env var from the child — the sidecar's
//   auto-run guard (sidecar_server.ts, main() gate) skips main() when VITEST
//   is set, so an inherited value makes the child exit 0 with no output.
// - We occupy the port first (dummy listener), then drive the sidecar over
//   stdio: device_info (triggers ensureListener), then a follow-up RPC.
// - PASS = child stays ALIVE through both RPCs. FAIL = the pre-fix crash
//   signature (child exits code 1 after the unhandled rejection).
// - Second test asserts normal binding still works on a free port.
import { describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";

const REPO = path.resolve(__dirname, "..");
const PORT = 47471; // SYNC_DEFAULT_PORT — the port whose occupancy caused the crash

function freeDir(): string {
  const dir = path.join(
    "/tmp",
    "tide-port-test-" + Math.random().toString(36).slice(2, 8),
  );
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function childEnv(dir: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.VITEST; // sidecar main() gate: must NOT inherit the test marker
  env.TIDE_DB_PATH = path.join(dir, "t.db");
  env.TIDE_DATA_DIR = dir;
  return env;
}

function rpc(child: ChildProcess, obj: unknown): void {
  child.stdin!.write(JSON.stringify(obj) + "\n");
}

describe("ensureListener occupied-port regression (sidecar crash)", () => {
  it("survives occupied sync port and keeps answering RPCs (pre-fix: exit 1)", async () => {
    const dummy = net.createServer();
    await new Promise<void>((res) => dummy.listen(PORT, () => res()));

    const dir = freeDir();
    const child = spawn("node", ["dist/sidecar.mjs"], {
      cwd: REPO,
      env: childEnv(dir),
    });

    const responses: string[] = [];
    child.stdout!.on("data", (d: Buffer) => {
      responses.push(...d.toString().split("\n").filter(Boolean));
    });
    const stderr: string[] = [];
    child.stderr!.on("data", (d: Buffer) =>
      stderr.push(...d.toString().split("\n").filter(Boolean)),
    );

    child.on("exit", (code) => {
      // Pre-fix signature: unhandledRejection → exit code 1.
      expect(code).toBeNull();
    });

    // RPC 1: device_info → triggers ensureListener() against the BUSY port.
    rpc(child, { id: 1, op: "device_info" });
    await new Promise((r) => setTimeout(r, 1500));

    // Pre-fix: the unhandled rejection killed the process here (exit code 1).
    expect(child.exitCode).toBeNull();
    expect(child.signalCode).toBeNull();

    // RPC 2: the sidecar must still answer after the failed bind.
    rpc(child, { id: 2, op: "list_quarantine" });
    await new Promise((r) => setTimeout(r, 1000));
    expect(child.exitCode).toBeNull();

    // The EADDRINUSE failure must be visible in stderr (logged, not silent).
    expect(stderr.join("\n")).toContain("EADDRINUSE");

    // Both RPCs answered.
    expect(responses.length).toBeGreaterThanOrEqual(2);

    child.kill();
    dummy.close();
  }, 15000);

  it("binds normally on a free port (listener answers with a real port)", async () => {
    const dir = freeDir();
    const child = spawn("node", ["dist/sidecar.mjs"], {
      cwd: REPO,
      env: childEnv(dir),
    });
    const responses: string[] = [];
    child.stdout!.on("data", (d: Buffer) => {
      responses.push(...d.toString().split("\n").filter(Boolean));
    });

    rpc(child, { id: 1, op: "device_info" });
    await new Promise((r) => setTimeout(r, 1200));

    expect(responses.length).toBeGreaterThanOrEqual(1);
    const parsed = JSON.parse(responses[0]!) as {
      ok: boolean;
      result: { listening_port: number };
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.result.listening_port).toBeGreaterThan(0);

    child.kill();
  }, 15000);
});
