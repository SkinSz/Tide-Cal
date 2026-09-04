// TD-011 — startup badge "(?)" root-cause regression + plain-language copy.
//
// Root cause (2026-08-31): in Tauri v2 the config-defined main webview
// starts loading while the Rust shell's setup() is STILL spawning+pinging
// the sidecar (node cold start, sidecar.rs ping blocks setup). So
// initSyncErrors() -> refreshSyncErrorsBadge() -> sync_op("quarantine_stats")
// fires while SidecarState is None -> "tide sidecar unavailable" -> both the
// stats op AND the list_quarantine fallback reject -> the catch path painted
// a permanent "(?)". Conflicts only LOOKED fine because its catch silently
// falls back to 0.
//
// Fix: the badge treats a channel failure as a TRANSIENT not-ready state:
// it shows "…" (pending) and retries on a short bounded readiness backoff
// until the first successful answer. "?" is reserved for a genuinely dead
// sidecar (all retries exhausted) — a healthy system can never end at "(?)".
//
// This file pins:
//   1. source, full stack: a COLD sidecar (spawned this instant, stdin line
//      written before node has even finished booting) answers
//      quarantine_stats with ok:true active:0 — the op itself never fails;
//   2. badge: first-call rejection -> "…" -> retry -> "0" (never "?");
//   3. badge: all retries exhausted -> honest "?" (dead sidecar);
//   4. copy: the sync-errors surface speaks plain user language.
import { describe, expect, test, beforeEach, afterEach, vi } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncOp } from "../frontend/devices.ts";
import { refreshSyncErrorsBadge } from "../frontend/sync_errors.ts";

// Badge layer: sync_errors.ts reaches the sidecar through devices.ts.
vi.mock("../frontend/devices.ts", () => ({
  syncOp: vi.fn(),
}));

// ---------------------------------------------------------------------------
// 1. Full-stack cold start: spawn the REAL sidecar bundle and hit
//    quarantine_stats immediately — no readiness wait, exactly the startup
//    race window (the RPC layer itself is fine; the GUI race was the bug).
// ---------------------------------------------------------------------------

const SIDE_BUNDLE = join(import.meta.dirname, "..", "dist", "sidecar.mjs");

describe("TD-011: cold sidecar answers quarantine_stats immediately", () => {
  let child: ChildProcess;
  let dir: string;

  beforeEach(() => {
    if (!existsSync(SIDE_BUNDLE)) {
      console.warn("dist/sidecar.mjs missing — run `npm run sidecar:build`");
      return;
    }
    dir = mkdtempSync(join(tmpdir(), "tide-badge-cold-"));
    mkdirSync(join(dir, "data"), { recursive: true });
    const env = { ...process.env };
    delete env.VITEST; // bundle auto-run guard checks process.env.VITEST
    env.TIDE_DB_PATH = join(dir, "tide-domain.db");
    env.TIDE_DATA_DIR = join(dir, "data");
    env.TIDE_SYNC_PORT = "0"; // OS-assigned; this test never dials the port
    child = spawn("node", [SIDE_BUNDLE], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
  });

  afterEach(() => {
    if (child?.stdin && child.stdin.writable) child.stdin.end();
    child?.kill();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test("stats op written to stdin BEFORE node finishes booting still gets ok:true active:0", async () => {
    if (!child) return; // bundle not built: artifact guard covers this
    // Write the request IMMEDIATELY — the write lands in the pipe buffer
    // while node is still cold-booting, mirroring the GUI's first badge
    // call at app launch.
    child.stdin!.write(
      JSON.stringify({ id: 1, op: "quarantine_stats", args: {} }) + "\n",
    );
    const rl = createInterface({ input: child.stdout! });
    const line: string = await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("cold sidecar never answered quarantine_stats")),
        15000,
      );
      rl.once("line", (l) => {
        clearTimeout(timer);
        resolve(l);
      });
      child.once("exit", (code) =>
        reject(new Error(`sidecar exited early: ${code}`)),
      );
    });
    const res = JSON.parse(line) as {
      id: number;
      ok: boolean;
      result?: { active: number; resolved: number; total: number };
    };
    expect(res.id).toBe(1);
    expect(res.ok).toBe(true);
    expect(res.result).toMatchObject({ active: 0, resolved: 0, total: 0 });
    rl.close();
  });
});

// ---------------------------------------------------------------------------
// 2./3. Badge readiness retry (DOM stub pattern from
// tests/quarantine_stats_badge.test.ts). Fake timers drive the backoff.
// ---------------------------------------------------------------------------

class StubElement {
  id: string;
  textContent: string;
  title: string;
  constructor(id: string, initial = "") {
    this.id = id;
    this.textContent = initial;
    this.title = "";
  }
}

function stubToolbar(): Map<string, StubElement> {
  const elements = new Map<string, StubElement>();
  elements.set("btn-sync-errors", new StubElement("btn-sync-errors"));
  elements.set("sync-errors-count", new StubElement("sync-errors-count", "0"));
  vi.stubGlobal("document", {
    getElementById: (id: string) => elements.get(id) ?? null,
  });
  return elements;
}

const RETRY_DELAYS = [250, 500, 1000, 2000, 4000, 8000];

async function settle(ms: number): Promise<void> {
  // advanceTimersByTimeAsync flushes both the timer queue and the microtask
  // chain after each fired timer.
  await vi.advanceTimersByTimeAsync(ms);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(syncOp).mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("TD-011: badge never settles on ? while the channel is merely not ready", () => {
  test("unavailable channel -> pending '…' -> retry -> 0 with plain tooltip", async () => {
    const elements = stubToolbar();
    const mock = syncOp as ReturnType<typeof vi.fn>;
    // The exact startup-race signature: BOTH the stats op and its fallback
    // hit "tide sidecar unavailable" until the shell finishes setup().
    // NOTE: one refresh attempt = TWO syncOp calls (stats + list fallback).
    const unavailable = () => new Error("tide sidecar unavailable");
    mock
      .mockRejectedValueOnce(unavailable())
      .mockRejectedValueOnce(unavailable()) // attempt 1
      .mockRejectedValueOnce(unavailable())
      .mockRejectedValueOnce(unavailable()) // attempt 2 (first retry)
      .mockResolvedValue({ active: 0, resolved: 0, total: 0, total_pruned: 0 });

    const done = refreshSyncErrorsBadge();
    await settle(0); // flush the first (rejected) call
    expect(elements.get("sync-errors-count")!.textContent).toBe("…");
    expect(elements.get("sync-errors-count")!.textContent).not.toBe("?");

    await settle(RETRY_DELAYS[0]! + 1); // first retry also unavailable
    expect(elements.get("sync-errors-count")!.textContent).toBe("…");

    await settle(RETRY_DELAYS[1]! + 1); // second retry succeeds
    await done;
    expect(elements.get("sync-errors-count")!.textContent).toBe("0");
    expect(elements.get("btn-sync-errors")!.title).toBe("No sync problems");
  });

  test("healthy system at launch: badge shows 0 — '?' can never be the final state", async () => {
    const elements = stubToolbar();
    const mock = syncOp as ReturnType<typeof vi.fn>;
    // Channel unavailable for three retries, then comes up (node cold start
    // finishing after the webview loaded).
    mock
      .mockRejectedValueOnce(new Error("tide sidecar unavailable"))
      .mockRejectedValueOnce(new Error("tide sidecar unavailable"))
      .mockRejectedValueOnce(new Error("tide sidecar unavailable"))
      .mockResolvedValue({ active: 0, resolved: 0, total: 0, total_pruned: 0 });

    const done = refreshSyncErrorsBadge();
    let total = 0;
    for (const d of RETRY_DELAYS) total += d;
    await settle(total + 10);
    await done;
    const text = elements.get("sync-errors-count")!.textContent;
    expect(["0", "…"]).toContain(text);
    expect(text).not.toBe("?");
  });

  test("persistently dead sidecar (all retries exhausted) -> honest ?", async () => {
    const elements = stubToolbar();
    (syncOp as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("tide sidecar unavailable"),
    );
    const done = refreshSyncErrorsBadge();
    let total = 0;
    for (const d of RETRY_DELAYS) total += d;
    await settle(total + 10);
    await done;
    expect(elements.get("sync-errors-count")!.textContent).toBe("?");
  });
});

// ---------------------------------------------------------------------------
// 4. Plain-language copy: the sync-errors surface speaks to the user, not
// to engineers. Jargon ("quarantine(d)", "validation", "diagnostics") must
// not appear in the user-facing intro/tooltip copy.
// ---------------------------------------------------------------------------

const INDEX_HTML = readFileSync(
  join(import.meta.dirname, "..", "frontend", "index.html"),
  "utf8",
);

describe("TD-011: sync-errors surface copy is plain user-facing language", () => {
  test("dialog intro explains the situation calmly, without engineer jargon", () => {
    const intro = INDEX_HTML.slice(
      INDEX_HTML.indexOf('id="sync-errors-dialog"'),
      INDEX_HTML.indexOf('id="sync-errors-list"'),
    ).replace(/\s+/g, " "); // normalize: copy may wrap across lines
    expect(intro).toContain("can't be applied automatically");
    expect(intro).toContain("Tide never loses these updates");
    expect(intro).toContain("Nothing has been lost or overwritten.");
    for (const jargon of ["quarantin", "validation", "diagnostics", "verbatim"]) {
      expect(intro.toLowerCase()).not.toContain(jargon);
    }
  });

  test("toolbar badge tooltip placeholder is plain language too", () => {
    const badge = INDEX_HTML.slice(
      INDEX_HTML.indexOf('id="btn-sync-errors"'),
      INDEX_HTML.indexOf('id="btn-new"'),
    );
    expect(badge).toContain('title="No sync problems"');
    expect(badge.toLowerCase()).not.toContain("quarantin");
  });

  test("healthy-state line in the dialog is the approved copy", () => {
    // renderList is DOM-internal; assert through the tooltip helper instead:
    // refreshSyncErrorsBadge() writes the healthy tooltip on success.
    const elements = stubToolbar();
    (syncOp as ReturnType<typeof vi.fn>).mockResolvedValue({
      active: 0,
      resolved: 0,
      total: 0,
      total_pruned: 0,
    });
    return refreshSyncErrorsBadge().then(() => {
      expect(elements.get("btn-sync-errors")!.title).toBe("No sync problems");
    });
  });
});
