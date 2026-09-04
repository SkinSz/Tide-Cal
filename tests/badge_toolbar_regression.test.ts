// Regression test — Sync-Errors badge must update the TOOLBAR count, not a
// dialog-scoped lookup. Root cause (2026-08-29): refreshSyncErrorsBadge()
// wrote via el() = dlg().querySelector("#sync-errors-count"), but
// #sync-errors-count lives in the toolbar OUTSIDE the sync-errors dialog.
// The write hit null, threw inside a void-ed promise, and died silently —
// the badge stayed at its HTML default "0" while the dialog showed correct
// data. Only runtime (AT-SPI) testing caught it; this test pins the contract
// so a future scoping regression fails in CI instead.
//
// Uses the repo's minimal in-file DOM stub pattern (see
// tests/month_view_clicks.test.ts) — no jsdom in this repo. The stub
// deliberately has NO dialog scoping: if the badge code ever reverts to
// dialog-scoped lookup, getElementById-style access still works here; what
// it pins is that the update LANDS on the toolbar element and that the
// failure path degrades to "?" instead of dying silently.
import { describe, expect, test, beforeEach, afterEach, vi } from "vitest";

// Mock the Tauri IPC surface: sync_errors.ts reaches the sidecar through
// devices.ts syncOp. No real shell in vitest — feed canned stats.
vi.mock("../frontend/devices.ts", () => ({
  syncOp: vi.fn(),
}));

import { syncOp } from "../frontend/devices.ts";
import { refreshSyncErrorsBadge } from "../frontend/sync_errors.ts";

// ---------------------------------------------------------------------------
// Minimal DOM stub
// ---------------------------------------------------------------------------

class StubElement {
  id: string;
  textContent: string;
  title: string;
  hidden = false;
  constructor(id: string, initial = "") {
    this.id = id;
    this.textContent = initial;
    this.title = "";
  }
}

let elements: Map<string, StubElement>;

const docStub = {
  getElementById(id: string): StubElement | null {
    return elements.get(id) ?? null;
  },
};

beforeEach(() => {
  elements = new Map();
  // The badge lives in the TOOLBAR (frontend/index.html lines 26-30) —
  // deliberately NOT inside #sync-errors-dialog.
  elements.set("btn-sync-errors", new StubElement("btn-sync-errors"));
  elements.set(
    "sync-errors-count",
    new StubElement("sync-errors-count", "0"),
  );
  vi.stubGlobal("document", docStub);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Sync-Errors toolbar badge (toolbar-scope regression)", () => {
  test("writes stats.active to the toolbar count span", async () => {
    (syncOp as ReturnType<typeof vi.fn>).mockResolvedValue({
      active: 4,
      resolved: 2,
      total: 6,
      total_pruned: 0,
    });

    await refreshSyncErrorsBadge();

    expect(elements.get("sync-errors-count")!.textContent).toBe("4");
    expect(elements.get("btn-sync-errors")!.title).toContain(
      "4 items couldn't be synced — click to review",
    );
  });

  test("badge shows 0 when there are no active rows", async () => {
    (syncOp as ReturnType<typeof vi.fn>).mockResolvedValue({
      active: 0,
      resolved: 3,
      total: 3,
      total_pruned: 0,
    });

    await refreshSyncErrorsBadge();

    expect(elements.get("sync-errors-count")!.textContent).toBe("0");
    expect(elements.get("btn-sync-errors")!.title).toBe(
      "No sync problems",
    );
  });

  test("stats-op failure degrades to '…' then honest '?' after retries — never silent", async () => {
    // First quarantine_stats throws, then the list_quarantine fallback
    // throws too. TD-011: a channel failure is first treated as not-ready
    // ("…" + bounded retry); "?" only after every retry is exhausted.
    vi.useFakeTimers();
    (syncOp as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("sidecar gone"),
    );
    const done = refreshSyncErrorsBadge();
    await vi.advanceTimersByTimeAsync(0);
    expect(elements.get("sync-errors-count")!.textContent).toBe("…");
    let total = 0;
    for (const d of [250, 500, 1000, 2000, 4000, 8000]) total += d;
    await vi.advanceTimersByTimeAsync(total + 10);
    await done;
    vi.useRealTimers();
    expect(elements.get("sync-errors-count")!.textContent).toBe("?");
  });

  test("falls back to list_quarantine total when stats op is unavailable", async () => {
    // Pre-TD-005 sidecar: quarantine_stats rejected, list_quarantine works.
    (syncOp as ReturnType<typeof vi.fn>).mockImplementation(
      async (op: string) => {
        if (op === "quarantine_stats") throw new Error("unknown op");
        if (op === "list_quarantine") return { rows: [], total: 7 };
        throw new Error(`unexpected op: ${op}`);
      },
    );

    await refreshSyncErrorsBadge();

    expect(elements.get("sync-errors-count")!.textContent).toBe("7");
  });

  test("missing toolbar button is a safe no-op (not a throw)", async () => {
    elements.delete("btn-sync-errors");
    (syncOp as ReturnType<typeof vi.fn>).mockResolvedValue({
      active: 1,
      resolved: 0,
      total: 1,
      total_pruned: 0,
    });

    await expect(refreshSyncErrorsBadge()).resolves.toBeUndefined();
    // count span untouched (early return happens before any write)
    expect(elements.get("sync-errors-count")!.textContent).toBe("0");
  });
});
