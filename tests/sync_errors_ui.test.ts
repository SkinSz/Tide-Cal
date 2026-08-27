// TD-001 Phase 2 — Option A "Sync Errors" UI tests (alongside
// tests/conflicts_ui.test.ts). Covers the dispatcher op, the
// database listing surface, and the pure display-shaping layer.
// Read-only by design: no retry/delete op exists to test.
import { describe, expect, test, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  openDatabase,
  quarantineRecord,
  countQuarantined,
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
import {
  shapeQuarantineRows,
  type QuarantineRow,
} from "../frontend/sync_errors.ts";
import type { Database } from "better-sqlite3";

let dir: string;
let db: Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tide-sync-errors-"));
  db = openDatabase({ path: join(dir, "t.db") });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function seedQuarantine(target: Database): void {
  quarantineRecord(target, {
    reason: "invalid_change_record:bad_operation",
    senderDeviceId: "d-self",
    rawRecord: {
      change_id: "d-bad:2",
      device_id: "d-bad",
      local_seq: 2,
      entity_id: "evt-x",
      operation: "upsert",
    },
  });
  quarantineRecord(target, {
    reason: "invalid_change_record:id_mismatch",
    senderDeviceId: "d-self",
    rawRecord: { change_id: "nope", device_id: "d-bad", local_seq: 3 },
  });
}

describe("listQuarantine (database surface)", () => {
  test("returns rows newest-first with verbatim raw_record", () => {
    expect(listQuarantine(db)).toEqual([]);
    seedQuarantine(db);
    const rows = listQuarantine(db);
    expect(rows).toHaveLength(2);
    // DESC order: newest (id 2) first.
    expect(rows[0]!.quarantine_id).toBeGreaterThan(rows[1]!.quarantine_id);
    expect(rows[0]!.quarantine_reason).toBe(
      "invalid_change_record:id_mismatch",
    );
    // Verbatim raw record round-trip (DC-04 TR-7).
    expect(JSON.parse(rows[1]!.raw_record)).toEqual({
      change_id: "d-bad:2",
      device_id: "d-bad",
      local_seq: 2,
      entity_id: "evt-x",
      operation: "upsert",
    });
  });

  test("limit option bounds the listing", () => {
    seedQuarantine(db);
    expect(listQuarantine(db, { limit: 1 })).toHaveLength(1);
  });
});

describe("list_quarantine dispatcher op", () => {
  test("returns {rows, total} through makeSyncDispatcher + handleLine", () => {
    const core = new EventCore(join(dir, "core.db"), "d-self");
    seedQuarantine(core.db); // the SyncManager reads core.db, not the outer db
    const identity = loadOrCreateIdentity(dir);
    const sync = new SyncManager(core, identity, dir);
    const dispatch: Dispatcher = makeSyncDispatcher(sync, core);

    const res = dispatch("list_quarantine", {}) as {
      rows: Array<Record<string, unknown>>;
      total: number;
    };
    expect(res.total).toBe(2);
    expect(res.rows).toHaveLength(2);

    // And through the stdio JSON-RPC envelope (sidecar wire shape).
    const line = JSON.parse(
      handleLine(dispatch, JSON.stringify({ id: 7, op: "list_quarantine", args: {} })),
    );
    expect(line.ok).toBe(true);
    expect(line.id).toBe(7);
    expect(line.result.total).toBe(2);
    expect(line.result.rows[0]!.raw_record).toBeTypeOf("string");

    // limit rides through args.
    expect((dispatch("list_quarantine", { limit: 1 }) as { rows: unknown[] }).rows).toHaveLength(1);
    expect(countQuarantined(core.db)).toBe(2);
  });
});

describe("Sync Errors display shaping (pure layer)", () => {
  test("truncated producer, parsed seq, verbatim reason, raw passthrough", () => {
    const rows: QuarantineRow[] = [
      {
        quarantine_id: 11,
        quarantine_reason: "invalid_change_record:bad_operation",
        received_at_hlc: 1234,
        sender_device_id: "d-self",
        raw_record: JSON.stringify({
          device_id: "x519deadbeef0123456789abcdefghij",
          local_seq: 2,
        }),
      },
      {
        quarantine_id: 12,
        quarantine_reason: "invalid_change_record:missing_field",
        received_at_hlc: 1235,
        sender_device_id: "d-self",
        raw_record: "not json at all",
      },
    ];
    const views = shapeQuarantineRows(rows);
    expect(views).toHaveLength(2);
    // Producer id truncated for display.
    expect(views[0]!.producer).toBe("x519deadbeef0123…");
    expect(views[0]!.seq).toBe(2);
    // Reason code shown VERBATIM — never interpreted or reworded.
    expect(views[0]!.reason).toBe("invalid_change_record:bad_operation");
    expect(views[0]!.raw).toBe(rows[0]!.raw_record);
    // Unparsable raw record degrades honestly; raw JSON stays expandable.
    expect(views[1]!.producer).toBe("(unknown)");
    expect(views[1]!.seq).toBe(-1);
    expect(views[1]!.raw).toBe("not json at all");
  });

  test("empty quarantine shapes to an empty view list", () => {
    expect(shapeQuarantineRows([])).toEqual([]);
  });
});
