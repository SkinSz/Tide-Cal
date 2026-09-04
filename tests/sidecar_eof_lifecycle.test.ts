// Regression test — sidecar must EXIT when stdin EOFs, even while its sync
// listener holds the TCP port. Root cause (2026-08-29, runtime-proven):
// rl.on("close") only closed the DB and relied on event-loop drain, but the
// net.Server from serveSync() keeps a live ref — after a GUI SIGKILL the
// sidecar orphaned forever, reparented to systemd --user, holding port
// 47471. Fix: stdin-close now closes the listener then process.exit(0).
//
// Pre-fix behavior: child hangs >10s with port bound. Post-fix: child exits
// within a few seconds and the port frees. Spawn pattern mirrors
// tests/ensure_listener_port.test.ts (real bundle as child process).
import { describe, expect, test } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, connect } from "node:net";

const SIDE_BUNDLE = join(import.meta.dirname, "..", "dist", "sidecar.mjs");

function dataEnv(dbDir: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    VITEST: undefined as unknown as string, // bundle auto-run guard strips this in-test
    TIDE_DB_PATH: join(dbDir, "tide-domain.db"),
    TIDE_DATA_DIR: join(dbDir, "data"),
  };
}

/** Wait until the TCP port accepts connections (sidecar listener up). */
async function waitPort(port: number, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const accepting = await new Promise<boolean>((resolve) => {
      const s = connect({ host: "127.0.0.1", port }, () => {
        s.destroy();
        resolve(true);
      });
      s.once("error", () => resolve(false));
    });
    if (accepting) return;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`sidecar did not start listening on ${port} in time`);
}

function spawnSidecar(dbDir: string, port: number): ChildProcess {
  // loadOrCreateIdentity writes device_identity.key under TIDE_DATA_DIR and
  // expects it to exist (lib.rs does create_dir_all for the real GUI).
  mkdirSync(join(dbDir, "data"), { recursive: true });
  const env = dataEnv(dbDir);
  delete env.VITEST; // sidecar auto-run guard checks process.env.VITEST
  // Random free port: prevents contention with the real GUI / any leaked
  // orphan / tests/ensure_listener_port.test.ts (which occupies 47471) —
  // vitest runs test files in parallel, so a fixed port would flake.
  env.TIDE_SYNC_PORT = String(port);
  return spawn("node", [SIDE_BUNDLE], {
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

describe("sidecar stdin-EOF lifecycle (orphan prevention)", () => {
  test("listening sidecar exits and frees the port when stdin closes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tide-eof-"));
    // Random free port (see spawnSidecar): grab an ephemeral port, release it,
    // hand it to the sidecar. Tiny race is acceptable for test purposes.
    const port = await new Promise<number>((resolve, reject) => {
      const s = createServer();
      s.once("error", reject);
      s.listen({ host: "127.0.0.1", port: 0 }, () => {
        const p = (s.address() as { port: number }).port;
        s.close(() => resolve(p));
      });
    });
    let child: ChildProcess | undefined;
    try {
      child = spawnSidecar(dir, port);
      // Trigger the sync listener exactly like the GUI does: device_info
      // calls ensureListener() on the default port.
      const ping = new Promise<string>((resolve, reject) => {
        let buf = "";
        child!.stdout!.on("data", (c: Buffer) => {
          buf += c.toString("utf8");
          if (buf.includes("\n")) resolve(buf);
        });
        child!.once("exit", (code) =>
          reject(new Error(`sidecar exited early: ${code}`)),
        );
      });
      child.stdin!.write(
        JSON.stringify({ id: 1, op: "device_info", args: {} }) + "\n",
      );
      const resp = await Promise.race([
        ping,
        new Promise<never>((_, rej) =>
          setTimeout(() => rej(new Error("no device_info reply")), 8000),
        ),
      ]);
      expect(resp).toContain('"ok":true');

      const reported = Number(JSON.parse(resp).result.listening_port);
      expect(reported).toBe(port);
      await waitPort(port);

      // THE CONTRACT: close stdin (as when the GUI is hard-killed) and the
      // sidecar must die on its own — no SIGTERM, no reaping.
      child.stdin!.end();
      const exitCode = await new Promise<number | null>((resolve, reject) => {
        const t = setTimeout(
          () => reject(new Error("sidecar still alive 10s after stdin EOF")),
          10000,
        );
        child!.once("exit", (code) => {
          clearTimeout(t);
          resolve(code);
        });
      });

      // Port must be freed (listener closed, process gone). Retry a few
      // times: the OS may briefly hold TIME_WAIT sockets from our own
      // probe connections; the LISTEN socket itself is gone on exit.
      let portFree = false;
      for (let i = 0; i < 10 && !portFree; i++) {
        await new Promise((r) => setTimeout(r, 300));
        portFree = await new Promise<boolean>((resolve) => {
          const s = createServer();
          s.once("error", () => resolve(false));
          s.listen({ port, host: "127.0.0.1" }, () =>
            s.close(() => resolve(true)),
          );
        });
      }
      expect(portFree).toBe(true);
      expect(exitCode).toBe(0);
    } finally {
      // Safety net so a failing run doesn't leak the orphan under test.
      child?.kill("SIGKILL");
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20000);
});
