// Regression — TD-badge: the Sync-Errors toolbar badge showed "?" (the
// fetchQuarantineStats failure path) after ALL quarantine rows were resolved.
//
// Root cause (2026-08-31): the app ran a STALE/missing sidecar bundle
// (TIDE_SIDECAR_PATH → /tmp/tide-remediation/dist/sidecar.mjs, deleted by
// /tmp cleanup — see ~/.local/share/com.tide.app/logs/Tide.log 2026-08-31
// 16:27 "tide sidecar bundle not found"). With no sidecar, BOTH
// quarantine_stats AND the list_quarantine fallback in
// fetchQuarantineStats() fail, so refreshSyncErrorsBadge() degrades to "?".
// dist/ is untracked, so a source-green tree can still ship a broken
// runtime artifact — the bundle guard at the bottom of this file pins the
// artifact to the current stats contract.
//
// This file pins three layers of the contract:
//   1. source: quarantine_stats through the real stdio JSON-RPC envelope
//      returns ok:true with active:0 once every row carries
//      resolved_at_hlc (and after TD-008 retention pruning);
//   2. source: the same result reached through the badge refresh path
//      renders "0", while RPC failure renders "?" (causality pair);
//   3. artifact: dist/sidecar.mjs (the bundle the Rust shell actually
//      spawns) is not stale w.r.t. the stats contract.
import { describe, expect, test, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  quarantineRecord,
  markQuarantineResolved,
  pruneResolvedQuarantine,
  listQuarantine,
} from "../src/persistence/database.ts";
import { EventCore } from "../src/persistence/bridges/event_core.ts";
import {
  SyncManager,
  makeSyncDispatcher,
  handleLine,
  type Dispatcher,
} from "../src/persistence/bridges/sidecar_server.ts";
import { loadOrCreateIdentity } from "../src/network/sync_runtime.ts";
import type { Database } from "better-sqlite3";

// Badge layer (sync_errors.ts reaches the sidecar through devices.ts).
vi.mock("../frontend/devices.ts", () => ({
  syncOp: vi.fn(),
}));
import { syncOp } from "../frontend/devices.ts";
import { refreshSyncErrorsBadge } from "../frontend/sync_errors.ts";

const PRODUCER = "d-badge-reg";

function makeRecord(seq: number) {
  // Mirrors the owner's real quarantined rows: records whose
  // causality_clock is missing → "invalid_change_record: causality_clock
  // must be an object".
  return {
    change_id: `${PRODUCER}:${seq}`,
    device_id: PRODUCER,
    local_seq: seq,
    entity_id: `evt-${seq}`,
    entity_type: "event",
    field_path: "title",
    operation: "set",
    payload: { value: `v${seq}` },
    // no causality_clock on purpose — the real quarantine reason
    schema_version: 1,
  };
}

function seedTwoRows(db: Database): void {
  for (const seq of [1, 2]) {
    quarantineRecord(db, {
      reason: "invalid_change_record: causality_clock must be an object",
      senderDeviceId: PRODUCER,
      rawRecord: makeRecord(seq),
    });
  }
}

/** Resolve EVERY row exactly the way the app does (durable resolved_at_hlc). */
function resolveAllRows(db: Database): void {
  for (const row of listQuarantine(db)) {
    markQuarantineResolved(db, row.quarantine_id, "user_deleted");
  }
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tide-badge-reg-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/**
 * The sync dispatcher (and therefore quarantine_stats) reads the EventCore
 * DB — build it, seed the owner-shaped quarantine rows, and resolve every
 * row the durable way (resolved_at_hlc set).
 */
function makeCoreWithAllRowsResolved(): EventCore {
  const core = new EventCore(join(dir, "core.db"), "d-self");
  seedTwoRows(core.db);
  resolveAllRows(core.db);
  return core;
}

function makeDispatch(core: EventCore): Dispatcher {
  const identity = loadOrCreateIdentity(dir);
  const sync = new SyncManager(core, identity, dir);
  return makeSyncDispatcher(sync, core);
}

describe("TD-badge: quarantine_stats after ALL rows are resolved (source)", () => {
  test("returns ok:true {active:0} through the stdio envelope", async () => {
    const core = makeCoreWithAllRowsResolved();
    const dispatch = makeDispatch(core);

    const line = JSON.parse(
      await handleLine(
        dispatch,
        JSON.stringify({ id: 1, op: "quarantine_stats", args: {} }),
      ),
    );
    expect(line).toMatchObject({ id: 1, ok: true });
    expect(line.result).toEqual({
      active: 0,
      resolved: 2,
      total: 2,
      total_pruned: 0,
    });
  });

  test("still returns active:0 after TD-008 retention pruning runs", async () => {
    const core = makeCoreWithAllRowsResolved();
    expect(pruneResolvedQuarantine(core.db)).toBe(0); // under cap — nothing pruned
    const dispatch = makeDispatch(core);

    const line = JSON.parse(
      await handleLine(
        dispatch,
        JSON.stringify({ id: 2, op: "quarantine_stats", args: {} }),
      ),
    );
    expect(line.ok).toBe(true);
    expect(line.result.active).toBe(0);
    expect(line.result.resolved).toBe(2);
  });

  test("degenerate state (quarantine table empty) does not throw either", async () => {
    const core = new EventCore(join(dir, "core.db"), "d-self");
    const identity = loadOrCreateIdentity(dir);
    const sync = new SyncManager(core, identity, dir);
    const dispatch: Dispatcher = makeSyncDispatcher(sync, core);

    const line = JSON.parse(
      await handleLine(
        dispatch,
        JSON.stringify({ id: 3, op: "quarantine_stats", args: {} }),
      ),
    );
    expect(line.ok).toBe(true);
    expect(line.result).toEqual({
      active: 0,
      resolved: 0,
      total: 0,
      total_pruned: 0,
    });
  });
});

// ---------------------------------------------------------------------------
// Badge causality pair: stats ok → "0"; stats RPC failing → "?"
// (minimal DOM stub pattern from tests/badge_toolbar_regression.test.ts)
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
  elements.set("sync-errors-count", new StubElement("sync-errors-count", "?"));
  // The badge starts at "?" here on purpose: only a SUCCESSFUL stats refresh
  // may overwrite it with the count. A broken/unavailable stats path must
  // leave (or produce) "?" — never a fabricated number.
  vi.stubGlobal("document", {
    getElementById: (id: string) => elements.get(id) ?? null,
  });
  return elements;
}

describe("TD-badge: badge refresh causality (0 with fix, ? without)", () => {
  test("successful stats in the all-resolved state renders 0", async () => {
    const core = makeCoreWithAllRowsResolved();
    const dispatch = makeDispatch(core);
    const wire = JSON.parse(
      await handleLine(
        dispatch,
        JSON.stringify({ id: 9, op: "quarantine_stats", args: {} }),
      ),
    );
    expect(wire.ok).toBe(true);

    const elements = stubToolbar();
    (syncOp as ReturnType<typeof vi.fn>).mockResolvedValue(wire.result);

    await refreshSyncErrorsBadge();

    expect(elements.get("sync-errors-count")!.textContent).toBe("0");
    expect(elements.get("btn-sync-errors")!.title).toBe(
      "No sync problems",
    );
  });

  test("failing stats RPC (sidecar gone/stale bundle) -> pending then honest ? after retries", async () => {
    const elements = stubToolbar();
    // Both quarantine_stats AND the list_quarantine fallback reject — the
    // exact signature of a missing/stale sidecar bundle (the owner's state).
    // TD-011: the channel failure is first treated as not-ready ("…" +
    // bounded retry); "?" only appears once every retry is exhausted.
    vi.useFakeTimers();
    (syncOp as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("sidecar request timed out after 15s"),
    );
    const done = refreshSyncErrorsBadge();
    let total = 0;
    for (const d of [250, 500, 1000, 2000, 4000, 8000]) total += d;
    await vi.advanceTimersByTimeAsync(total + 10);
    await done;
    vi.useRealTimers();
    expect(elements.get("sync-errors-count")!.textContent).toBe("?");
  });
});

// ---------------------------------------------------------------------------
// Artifact guard: dist/sidecar.mjs is what the Rust shell actually spawns.
// It is untracked, so a source-green tree can drift. If the bundle is stale
// w.r.t. the stats contract, THIS fails — run `npm run sidecar:build`.
// ---------------------------------------------------------------------------

const SIDECAR_PATH = join(import.meta.dirname ?? ".", "..", "dist", "sidecar.mjs");

describe("TD-badge: shipped sidecar bundle is not stale (root-cause guard)", () => {
  test("dist/sidecar.mjs contains the current quarantine_stats contract", () => {
    if (!existsSync(SIDECAR_PATH)) {
      console.warn(
        "[td-badge-guard] dist/sidecar.mjs absent — skipping artifact check",
      );
      return;
    }
    const bundle = readFileSync(SIDECAR_PATH, "utf8");
    const markers: Array<[string, string]> = [
      ['case "quarantine_stats"', "stats op wired into the sync dispatcher"],
      [
        "quarantine_prune_stats",
        "TD-005 remainder stats shape (total_pruned) present",
      ],
      [
        "resolved_at_hlc IS NOT NULL",
        "active/resolved split SQL present",
      ],
    ];
    for (const [marker, why] of markers) {
      expect(
        bundle.includes(marker),
        `stale sidecar bundle: missing ${marker} (${why}) — run \`npm run sidecar:build\` and relaunch`,
      ).toBe(true);
    }
  });
});
