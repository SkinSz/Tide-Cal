// Regression test for the sidecar stdio pipeline: handleLine must AWAIT
// promise results before serializing the JSON envelope. Previously, async ops
// (pairing_offer etc.) returned a Promise, and JSON.stringify(Promise) === {}
// — the GUI silently received {"ok":true,"result":{}} with no error.
// This test fails on the pre-fix code (result === {}) and passes after the fix.
import { describe, expect, test, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventCore } from "../src/persistence/bridges/event_core.ts";
import {
  SyncManager,
  makeSyncDispatcher,
  handleLine,
  type Dispatcher,
} from "../src/persistence/bridges/sidecar_server.ts";
import { loadOrCreateIdentity } from "../src/network/sync_runtime.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tide-pairing-stdio-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function pipeline(): { core: EventCore; dispatch: Dispatcher } {
  const core = new EventCore(join(dir, "tide.db"));
  const identity = loadOrCreateIdentity(dir);
  const sync = new SyncManager(core, identity, dir);
  return { core, dispatch: makeSyncDispatcher(sync, core) };
}

describe("sidecar stdio pipeline awaits async ops", () => {
  test("pairing_offer returns qr_text (not {}) through handleLine", async () => {
    const { core, dispatch } = pipeline();

    const raw = await handleLine(
      dispatch,
      JSON.stringify({ id: 1, op: "pairing_offer", args: {} }),
    );
    const res = JSON.parse(raw) as {
      id: number;
      ok: boolean;
      result: { qr_text?: string };
      error?: string;
    };
    expect(res.ok).toBe(true);
    expect(res.id).toBe(1);
    // The fail-first assertion: pre-fix this was {} because the Promise was
    // stringified directly.
    expect(typeof res.result.qr_text).toBe("string");
    expect(res.result.qr_text!.length).toBeGreaterThan(0);
    expect(res.result.qr_text!.startsWith('{"v":1')).toBe(true);
    core.db.close();
  });

  test("sync op list_quarantine still works through handleLine", async () => {
    const { core, dispatch } = pipeline();
    const res = JSON.parse(
      await handleLine(dispatch, JSON.stringify({ id: 2, op: "list_quarantine", args: {} })),
    ) as { ok: boolean; result: { rows: unknown[]; total: number } };
    expect(res.ok).toBe(true);
    expect(res.result.total).toBe(0);
    expect(res.result.rows).toHaveLength(0);
    core.db.close();
  });

  test("invalid op still returns ok:false", async () => {
    const { core, dispatch } = pipeline();
    const res = JSON.parse(
      await handleLine(dispatch, JSON.stringify({ id: 3, op: "nope", args: {} })),
    ) as { ok: boolean; error?: string };
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/unknown op/);
    core.db.close();
  });
});
