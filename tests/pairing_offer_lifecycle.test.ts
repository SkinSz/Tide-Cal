// Regression tests — pairing-offer listener lifecycle.
//
// Root cause context (2026-08-29 review finding): createPairingOffer()
// serves its OWN one-shot listener on an ephemeral port, outside
// SyncManager.host. Nothing cancelled it: a GUI crash left a LIVE pairing
// listener behind (security surface — it still accepts handshakes from
// anyone holding the QR payload). Now offers are tracked on the SyncManager,
// closed on stdin-EOF shutdown, superseded one-for-one, and cancellable via
// the explicit cancel_pairing_offer op (allow-listed in lib.rs).
import { describe, expect, test } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, connect } from "node:net";

const SIDE_BUNDLE = join(import.meta.dirname, "..", "dist", "sidecar.mjs");

function spawnSidecar(dbDir: string): ChildProcess {
  // loadOrCreateIdentity writes device_identity.key under TIDE_DATA_DIR and
  // expects it to exist (lib.rs does create_dir_all for the real GUI).
  mkdirSync(join(dbDir, "data"), { recursive: true });
  const env = { ...process.env };
  delete env.VITEST; // sidecar auto-run guard checks process.env.VITEST
  env.TIDE_DB_PATH = join(dbDir, "tide-domain.db");
  env.TIDE_DATA_DIR = join(dbDir, "data");
  // Random port for the MAIN sync listener — this file exercises the
  // pairing-offer listener (ephemeral), so no contention by construction.
  env.TIDE_SYNC_PORT = String(40000 + Math.floor(Math.random() * 20000));
  return spawn("node", [SIDE_BUNDLE], {
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

/** Line-based NDJSON RPC client over the sidecar's stdio. */
class Rpc {
  private buf = "";
  private next = 1;
  private pending = new Map<number, (v: unknown) => void>();
  constructor(private child: ChildProcess) {
    child.stdout!.on("data", (c: Buffer) => {
      this.buf += c.toString("utf8");
      let idx: number;
      while ((idx = this.buf.indexOf("\n")) !== -1) {
        const line = this.buf.slice(0, idx);
        this.buf = this.buf.slice(idx + 1);
        try {
          const msg = JSON.parse(line) as { id: number; result?: unknown };
          const res = this.pending.get(msg.id);
          if (res) {
            this.pending.delete(msg.id);
            res(msg.result);
          }
        } catch {
          // ignore non-JSON noise
        }
      }
    });
  }
  call(op: string, args: Record<string, unknown> = {}): Promise<unknown> {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, resolve);
      const t = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC ${op} timed out`));
      }, 8000);
      this.child.stdout!.once("close", () => {
        clearTimeout(t);
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`sidecar died during ${op}`));
        }
      });
      this.child.stdin!.write(
        JSON.stringify({ id, op, args }) + "\n",
        () => clearTimeout(t),
      );
    });
  }
}

/** Is a TCP port accepting connections (i.e. still bound by a listener)? */
async function portAccepting(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = connect({ host: "127.0.0.1", port }, () => {
      s.destroy();
      resolve(true);
    });
    s.once("error", () => resolve(false));
  });
}

describe("pairing-offer listener lifecycle", () => {
  test("cancel_pairing_offer closes the offer's ephemeral listener", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tide-offer-cancel-"));
    const child = spawnSidecar(dir);
    try {
      const rpc = new Rpc(child);
      const res = (await rpc.call("pairing_offer")) as { qr_text: string };
      expect(res.qr_text).toBeTruthy();
      const qr = JSON.parse(res.qr_text) as { connect: { port: number } };
      const offerPort = qr.connect.port;
      expect(offerPort).toBeGreaterThan(0);
      // The offer listener IS live right now.
      expect(await portAccepting(offerPort)).toBe(true);

      await rpc.call("cancel_pairing_offer");
      // Listener must be gone shortly after.
      for (let i = 0; i < 10; i++) {
        if (!(await portAccepting(offerPort))) break;
        await new Promise((r) => setTimeout(r, 200));
      }
      expect(await portAccepting(offerPort)).toBe(false);
    } finally {
      child.kill("SIGKILL");
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20000);

  test("stdin EOF closes a pending pairing offer (no orphaned pairing surface)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tide-offer-eof-"));
    const child = spawnSidecar(dir);
    try {
      const rpc = new Rpc(child);
      const res = (await rpc.call("pairing_offer")) as { qr_text: string };
      const qr = JSON.parse(res.qr_text) as { connect: { port: number } };
      const offerPort = qr.connect.port;
      expect(await portAccepting(offerPort)).toBe(true);

      // Simulate GUI death: close stdin. Sidecar exits (prior fix) AND the
      // pairing listener must not linger even briefly past exit.
      child.stdin!.end();
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(
          () => reject(new Error("sidecar still alive 10s after EOF")),
          10000,
        );
        child.once("exit", () => {
          clearTimeout(t);
          resolve();
        });
      });
      // Process gone -> every listener gone, by definition. Assert anyway.
      expect(await portAccepting(offerPort)).toBe(false);
    } finally {
      child.kill("SIGKILL");
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20000);

  test("a newer pairing offer supersedes (closes) the previous listener", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tide-offer-supersede-"));
    const child = spawnSidecar(dir);
    try {
      const rpc = new Rpc(child);
      const first = (await rpc.call("pairing_offer")) as { qr_text: string };
      const p1 = (JSON.parse(first.qr_text) as { connect: { port: number } })
        .connect.port;
      const second = (await rpc.call("pairing_offer")) as { qr_text: string };
      const p2 = (JSON.parse(second.qr_text) as { connect: { port: number } })
        .connect.port;

      for (let i = 0; i < 10; i++) {
        if (!(await portAccepting(p1))) break;
        await new Promise((r) => setTimeout(r, 200));
      }
      expect(await portAccepting(p1)).toBe(false); // superseded -> closed
      expect(await portAccepting(p2)).toBe(true); // current -> live

      // Cleanup: cancel the surviving offer so the child stays killable-clean.
      await rpc.call("cancel_pairing_offer");
    } finally {
      child.kill("SIGKILL");
      rmSync(dir, { recursive: true, force: true });
    }
  }, 25000);
});

// Static guard: the ephemeral-port server created in createPairingOffer is
// described here so future refactors keep the invariant: every serveSync
// host must be reachable from SyncManager shutdown paths.
describe("invariants (documentation tests)", () => {
  test("cancel_pairing_offer is allow-listed in the Tauri sync_op gate", async () => {
    const fs = await import("node:fs");
    const lib = fs.readFileSync(
      join(import.meta.dirname, "..", "src-tauri", "src", "lib.rs"),
      "utf8",
    );
    expect(lib).toContain('"cancel_pairing_offer"');
  });
});
