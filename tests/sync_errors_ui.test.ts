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
  relativeTime,
  isPermanentReason,
  affectedData,
  type QuarantineRow,
} from "../frontend/sync_errors.ts";
import {
  resolveDeviceLabel,
} from "../frontend/device-label.ts";
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
  test("returns {rows, total} through makeSyncDispatcher + handleLine", async () => {
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
      await handleLine(dispatch, JSON.stringify({ id: 7, op: "list_quarantine", args: {} })),
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

  test("views carry the full sender id for label resolution", () => {
    const views = shapeQuarantineRows([
      {
        quarantine_id: 1,
        quarantine_reason: "bad_seq",
        received_at_hlc: 1,
        sender_device_id: "dev-f6d77e6c-156xxxx",
        raw_record: "{}",
      },
    ]);
    expect(views[0]!.sender).toBe("dev-f6d77e6c-156xxxx");
  });
});

// ---------------------------------------------------------------------------
// Owner-approved card redesign (2026-08-27): pure shaping helpers
// ---------------------------------------------------------------------------
describe("Sync-Errors card redesign helpers", () => {
  test("relativeTime: deterministic buckets + absolute hover timestamp", () => {
    const now = Date.UTC(2026, 7, 27, 20, 0, 0);
    expect(relativeTime(now - 10_000, now).rel).toBe("just now");
    expect(relativeTime(now - 2 * 60_000, now).rel).toBe("2m ago");
    expect(relativeTime(now - 2 * 3_600_000, now).rel).toBe("2h ago");
    expect(relativeTime(now - 3 * 86_400_000, now).rel).toBe("3d ago");
    // Absolute time always present for the title attribute.
    expect(relativeTime(now - 2 * 3_600_000, now).abs).toContain("2026");
  });

  test("isPermanentReason: structural incompatibility vs transient", () => {
    // Permanent: retry can never fix these.
    expect(isPermanentReason("invalid_change_record:bad_operation")).toBe(true);
    expect(isPermanentReason("bad_operation")).toBe(true);
    expect(isPermanentReason("id_mismatch")).toBe(true);
    expect(isPermanentReason("invalid_change_record:invalid operation upsert")).toBe(true);
    expect(
      isPermanentReason("invalid_change_record:change_id a:1 != b:2"),
    ).toBe(true);
    // Transient / unknown: ⚠ (retry might help; never claim unprovable permanence).
    expect(
      isPermanentReason(
        "invalid_change_record: causality_clock must be an object",
      ),
    ).toBe(false);
    expect(isPermanentReason("bad_seq")).toBe(false);
    expect(isPermanentReason("some_future_code")).toBe(false);
  });

  test("affectedData: event title from payload.value, entity_id fallback, honest empty", () => {
    expect(
      affectedData(
        JSON.stringify({ payload: { value: "Dentist" }, entity_id: "evt-1" }),
      ),
    ).toBe("Dentist");
    expect(affectedData(JSON.stringify({ entity_id: "evt-1" }))).toBe("evt-1");
    expect(affectedData("not json")).toBe("");
    expect(affectedData(JSON.stringify({ payload: { value: 42 } }))).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Device-label helper (owner-approved UX package): adopted across sync surfaces
// ---------------------------------------------------------------------------
describe("resolveDeviceLabel", () => {
  const paired = [
    { device_id: "dev-paired-abcdef", display_name: "Laptop" },
  ];

  test("paired display_name wins", () => {
    expect(resolveDeviceLabel("dev-paired-abcdef", paired)).toBe("Laptop");
  });

  test("self id resolves to 'This device' when not in the paired list", () => {
    expect(resolveDeviceLabel("dev-self", paired, "dev-self")).toBe(
      "This device",
    );
  });

  test("fallback: truncated id, never invented names", () => {
    expect(resolveDeviceLabel("dev-f6d77e6c-156abcdef", paired, "dev-self")).toBe(
      "dev-f6d77e6c-156…",
    );
    expect(resolveDeviceLabel("short-id")).toBe("short-id");
  });

  test("empty paired display_name falls through to the id", () => {
    expect(
      resolveDeviceLabel(
        "dev-x",
        [{ device_id: "dev-x", display_name: "" }],
        "dev-self",
      ),
    ).toBe("dev-x");
  });
});
