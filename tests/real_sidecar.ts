// Shared setup for tests that run the REAL built sidecar as a child process
// (real stdio NDJSON, real TCP + Noise_XX, real SQLite). Not a test file.
//
// Build rule (TD-082): these tests never trust a pre-existing dist/sidecar.mjs.
// Each caller builds its own bundle from the CURRENT source with the project's
// own `sidecar:build` script, into a private directory under dist/ (so
// better-sqlite3 still resolves from the repo's node_modules). dist/sidecar.mjs
// is left untouched, so this cannot make the TD-082 ordering problem worse.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer, connect } from "node:net";
import { mkdirSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const REPO_ROOT = join(import.meta.dirname, "..");

/** Build the sidecar from current source into dist/<tag>/sidecar.mjs; fails loudly. */
export function buildSidecar(tag: string, extraEnv: NodeJS.ProcessEnv = {}): string {
  const outDir = join(REPO_ROOT, "dist", tag);
  rmSync(outDir, { recursive: true, force: true });
  const outfile = join(outDir, "sidecar.mjs");
  const r = spawnSync("npm", ["run", "--silent", "sidecar:build", "--", `--outfile=${outfile}`], {
    cwd: REPO_ROOT,
    env: { ...process.env, ...extraEnv },
    encoding: "utf8",
  });
  if (r.status !== 0 || !existsSync(outfile)) {
    throw new Error(
      `sidecar build FAILED (exit ${r.status}); this test needs a freshly built sidecar.\n` +
        `stdout: ${r.stdout}\nstderr: ${r.stderr}`,
    );
  }
  return outfile;
}

export function removeBuild(tag: string): void {
  rmSync(join(REPO_ROOT, "dist", tag), { recursive: true, force: true });
}

/** A free loopback port in a band below the OS ephemeral range (never 47471). */
export async function freePort(): Promise<number> {
  for (let i = 0; i < 200; i++) {
    const port = 31000 + Math.floor(Math.random() * 900);
    const ok = await new Promise<boolean>((resolve) => {
      const s = createServer();
      s.once("error", () => resolve(false));
      s.listen(port, "127.0.0.1", () => s.close(() => resolve(true)));
    });
    if (ok) return port;
  }
  throw new Error("no free test port found");
}

export class RealSidecar {
  readonly dir: string;
  proc!: ChildProcess;
  stderr: string[] = [];
  private nextId = 1;
  private pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();
  exited!: Promise<{ code: number | null }>;
  deviceId = "";

  constructor(
    readonly name: string,
    readonly bundle: string,
    readonly port: number,
    readonly extraEnv: NodeJS.ProcessEnv = {},
  ) {
    this.dir = mkdtempSync(join(tmpdir(), `tide-${name}-`));
  }

  start(): void {
    mkdirSync(this.dir, { recursive: true });
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      TIDE_DB_PATH: join(this.dir, "tide.db"),
      TIDE_DATA_DIR: this.dir,
      TIDE_SYNC_PORT: String(this.port),
      TIDE_SYNC_CONNECT_TIMEOUT_MS: "3000",
      ...this.extraEnv,
    };
    delete env.VITEST; // the bundle's auto-run guard checks this
    this.proc = spawn(process.execPath, [this.bundle], { cwd: this.dir, env, stdio: ["pipe", "pipe", "pipe"] });
    this.proc.stdout!.setEncoding("utf8");
    let buf = "";
    this.proc.stdout!.on("data", (chunk: string) => {
      buf += chunk;
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let msg: { id?: number; ok?: boolean; result?: unknown; error?: string };
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        const p = msg.id === undefined ? undefined : this.pending.get(msg.id);
        if (!p) continue;
        this.pending.delete(msg.id!);
        if (msg.ok === false) p.reject(new Error(msg.error ?? "error"));
        else p.resolve(msg.result);
      }
    });
    this.proc.stderr!.setEncoding("utf8");
    this.proc.stderr!.on("data", (c: string) => this.stderr.push(...c.split("\n").filter((l) => l.trim())));
    this.exited = new Promise((res) => this.proc.once("exit", (code) => res({ code })));
  }

  rpc<T = any>(op: string, args: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const t = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${this.name}: ${op} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => (clearTimeout(t), resolve(v as T)),
        reject: (e) => (clearTimeout(t), reject(e)),
      });
      this.proc.stdin!.write(JSON.stringify({ id, op, args }) + "\n");
    });
  }

  /** device_info starts the sync listener; wait until it really accepts TCP. */
  async ready(): Promise<void> {
    const info = await this.rpc("device_info", {}, 10_000);
    this.deviceId = info.device_id;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const ok = await new Promise<boolean>((resolve) => {
        const s = connect({ host: "127.0.0.1", port: this.port }, () => (s.destroy(), resolve(true)));
        s.once("error", () => resolve(false));
      });
      if (ok) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`${this.name}: listener never accepted on ${this.port}`);
  }

  /** Stop the process but keep the data dir, then start again with extra env. */
  async restart(extraEnv: NodeJS.ProcessEnv): Promise<void> {
    await this.halt();
    Object.assign(this.extraEnv, extraEnv);
    this.stderr = [];
    this.start();
    await this.ready();
  }

  private async halt(): Promise<void> {
    if (this.proc && this.proc.exitCode === null) {
      this.proc.stdin!.end();
      const r = await Promise.race([this.exited, new Promise((res) => setTimeout(() => res("timeout"), 3000))]);
      if (r === "timeout") {
        this.proc.kill("SIGKILL");
        await this.exited;
      }
    }
  }

  async stop(): Promise<void> {
    await this.halt();
    rmSync(this.dir, { recursive: true, force: true });
  }
}

/** Real DC-05 pairing between two running sidecars (as three_device_harness does). */
export async function pairDevices(a: RealSidecar, b: RealSidecar): Promise<void> {
  const offer = await a.rpc("pairing_offer", { name: a.name });
  await b.rpc("pairing_accept", { qr_text: offer.qr_text, name: b.name });
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const ia = await a.rpc("device_info");
    const ib = await b.rpc("device_info");
    if (
      ia.paired_peers.some((p: { device_id: string }) => p.device_id === b.deviceId) &&
      ib.paired_peers.some((p: { device_id: string }) => p.device_id === a.deviceId)
    )
      return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("pairing trust not visible on both sides");
}
