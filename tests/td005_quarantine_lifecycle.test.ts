// TD-005 — quarantine lifecycle tests: durable resolved/active distinction.
// Covers: resolution marking after successful revalidation apply, still-invalid
// rows staying active across restarts, reconcileQuarantineResolutions
// idempotency, mixed active/resolved stats, and durability of resolved flags
// across a full close/reopen cycle. No delete path exists or is exercised.
import { describe, expect, test, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  openDatabase,
  quarantineRecord,
  countQuarantined,
  listQuarantine,
  listQuarantineStats,
  markQuarantineResolved,
  reconcileQuarantineResolutions,
} from "../src/persistence/database.ts";
import { makeEntityMutator } from "../src/persistence/bridges/sync_service.ts";
import { revalidateQuarantine } from "../src/sync/sync_engine.ts";
import type { ChangeRecord } from "../src/sync/change_record.ts";
import {
  shapeQuarantineRows,
  type QuarantineRow,
} from "../frontend/sync_errors.ts";
import type { Database } from "better-sqlite3";

const T0 = Date.UTC(2026, 8, 1, 9, 0, 0); // fixed epoch ms — deterministic
const PRODUCER = "d-td005";

let dir: string;
let dbPath: string;
let db: Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tide-td005-"));
  dbPath = join(dir, "tide.db");
  db = openDatabase({ path: dbPath });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function makeRecord(seq: number, valid = true): ChangeRecord {
  const base: ChangeRecord = {
    change_id: `${PRODUCER}:${seq}`,
    device_id: PRODUCER,
    local_seq: seq,
    entity_id: "evt-td005",
    entity_type: "event",
    field_path: "title",
    operation: "set",
    payload: { value: `v${seq}` },
    hlc_timestamp: T0 + seq,
    causality_clock: { [PRODUCER]: seq },
    schema_version: 1,
  };
  if (valid) return base;
  return { ...base, operation: "upsert" as never } as ChangeRecord; // invalid op
}

function quarantine(seq: number, valid = true): void {
  quarantineRecord(db, {
    reason: "invalid_change_record:synthetic",
    senderDeviceId: PRODUCER,
    rawRecord: makeRecord(seq, valid),
  });
}

// ---------------------------------------------------------------------------
// 1. quarantine → revalidation applies → row marked resolved with reason
// ---------------------------------------------------------------------------
describe("TD-005: resolution via revalidation", () => {
  test("applied formerly-quarantined record is marked resolved", () => {
    quarantine(1, true); // will become valid
    expect(countQuarantined(db)).toBe(1);
    const before = listQuarantine(db)[0]!;
    expect(before.resolved_at_hlc).toBeNull();
    expect(before.resolved_reason).toBeNull();

    const res = revalidateQuarantine(db, makeEntityMutator());
    expect(res).toEqual({ examined: 1, revalidated: 1, stillInvalid: 0 });

    // Derive resolution from durable state (the sync_engine hook point).
    const rec = reconcileQuarantineResolutions(db);
    expect(rec).toEqual({ examined: 1, marked: 1 });

    const rows = listQuarantine(db);
    expect(rows).toHaveLength(1); // archived, NEVER deleted
    expect(rows[0]!.resolved_at_hlc).not.toBeNull();
    expect(rows[0]!.resolved_reason).toBe("revalidated_on_restart");

    const stats = listQuarantineStats(db);
    expect(stats).toEqual({ active: 0, resolved: 1, total: 1, total_pruned: 0 });
  });

  test("markQuarantineResolved is idempotent (original resolution wins)", () => {
    quarantine(1, true);
    const id = listQuarantine(db)[0]!.quarantine_id;
    expect(markQuarantineResolved(db, id, "first")).toBe(true);
    const first = listQuarantine(db)[0]!;
    expect(markQuarantineResolved(db, id, "second")).toBe(false);
    const after = listQuarantine(db)[0]!;
    expect(after.resolved_at_hlc).toBe(first.resolved_at_hlc);
    expect(after.resolved_reason).toBe("first");
  });
});

// ---------------------------------------------------------------------------
// 2. still-invalid rows stay active across restarts
// ---------------------------------------------------------------------------
describe("TD-005: still-invalid rows stay active", () => {
  test("revalidation failure leaves the row active through a restart", () => {
    quarantine(1, false); // permanently invalid (bad operation enum)
    const res = revalidateQuarantine(db, makeEntityMutator());
    expect(res).toEqual({ examined: 1, revalidated: 0, stillInvalid: 1 });
    expect(reconcileQuarantineResolutions(db).marked).toBe(0);

    // Restart: full close + reopen against the same file.
    db.close();
    db = openDatabase({ path: dbPath });
    const rows = listQuarantine(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.resolved_at_hlc).toBeNull();
    expect(listQuarantineStats(db)).toEqual({ active: 1, resolved: 0, total: 1, total_pruned: 0 });
  });
});

// ---------------------------------------------------------------------------
// 3. reconcileQuarantineResolutions is idempotent (double-run safe)
// ---------------------------------------------------------------------------
describe("TD-005: reconcile idempotency", () => {
  test("double-run marks nothing new and preserves the first reason", () => {
    quarantine(1, true);
    quarantine(2, false);
    revalidateQuarantine(db, makeEntityMutator()); // applies #1 only

    const run1 = reconcileQuarantineResolutions(db);
    expect(run1).toEqual({ examined: 2, marked: 1 });
    const run2 = reconcileQuarantineResolutions(db);
    // examined counts ACTIVE rows only — after run1 the resolved row is
    // skipped, so only the still-invalid row is examined and nothing is marked.
    expect(run2).toEqual({ examined: 1, marked: 0 });

    const rows = listQuarantine(db);
    const resolved = rows.find((r) => r.resolved_at_hlc !== null)!;
    expect(resolved.resolved_reason).toBe("revalidated_on_restart");
    expect(rows.filter((r) => r.resolved_at_hlc === null)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 4. stats / badge counts with mixed active+resolved
// ---------------------------------------------------------------------------
describe("TD-005: stats and badge shaping", () => {
  test("mixed counts are exact and the view splits active/resolved", () => {
    quarantine(1, true);
    quarantine(2, false);
    quarantine(3, true);
    revalidateQuarantine(db, makeEntityMutator());
    reconcileQuarantineResolutions(db);
    // Manually resolve one more (e.g. a future owner-confirmed action path).
    quarantine(4, false);
    const id4 = listQuarantine(db).find((r) => r.quarantine_reason.length > 0)!
      .quarantine_id;
    markQuarantineResolved(db, id4, "manual_future_path");

    expect(listQuarantineStats(db)).toEqual({
      active: 2,
      resolved: 2,
      total: 4,
      total_pruned: 0,
    });

    // UI shaping: active rows on top, resolved flagged with their reason.
    const views = shapeQuarantineRows(
      listQuarantine(db) as QuarantineRow[],
    );
    const activeViews = views.filter((v) => !v.resolved);
    const resolvedViews = views.filter((v) => v.resolved);
    expect(activeViews).toHaveLength(2);
    expect(resolvedViews).toHaveLength(2);
    for (const v of resolvedViews) {
      expect(v.resolved_reason).toBeTruthy();
      expect(v.reason).toBe("invalid_change_record:synthetic"); // original reason kept
    }
  });
});

// ---------------------------------------------------------------------------
// 5. resolved rows survive restart durably
// ---------------------------------------------------------------------------
describe("TD-005: resolution durability", () => {
  test("resolved flag + reason persist across close/reopen", () => {
    quarantine(1, true);
    revalidateQuarantine(db, makeEntityMutator());
    reconcileQuarantineResolutions(db);
    const before = listQuarantine(db)[0]!;

    db.close();
    db = openDatabase({ path: dbPath });

    const after = listQuarantine(db)[0]!;
    expect(after.quarantine_id).toBe(before.quarantine_id);
    expect(after.resolved_at_hlc).toBe(before.resolved_at_hlc);
    expect(after.resolved_reason).toBe("revalidated_on_restart");
    expect(listQuarantineStats(db)).toEqual({ active: 0, resolved: 1, total: 1, total_pruned: 0 });
  });

  test("fresh database is created at schema v3+ with lifecycle columns", () => {
    const v = (
      db.prepare("SELECT version FROM schema_version").get() as { version: number }
    ).version;
    // >= 3: later packages (e.g. TD-006's v4) may have bumped SCHEMA_VERSION;
    // this test only owns the TD-005 v3 lifecycle columns.
    expect(v).toBeGreaterThanOrEqual(3);
    const cols = (
      db.prepare("PRAGMA table_info(quarantine)").all() as Array<{ name: string }>
    ).map((c) => c.name);
    expect(cols).toContain("resolved_at_hlc");
    expect(cols).toContain("resolved_reason");
  });

  test("v2 database migrates forward to v3 without data loss", () => {
    // Simulate a pre-TD-005 database: quarantine a row, then hand-rollback
    // the version so reopen runs the v3 migration over existing data.
    quarantine(1, false);
    const id = listQuarantine(db)[0]!.quarantine_id;
    db.exec("UPDATE schema_version SET version = 2");
    db.exec("ALTER TABLE quarantine DROP COLUMN resolved_at_hlc");
    db.exec("ALTER TABLE quarantine DROP COLUMN resolved_reason");
    db.close();
    db = openDatabase({ path: dbPath });
    const v = (
      db.prepare("SELECT version FROM schema_version").get() as { version: number }
    ).version;
    // Forward migration must reach at least TD-005's v3 (higher is fine).
    expect(v).toBeGreaterThanOrEqual(3);
    const rows = listQuarantine(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.quarantine_id).toBe(id); // pre-existing data intact, active
    expect(rows[0]!.resolved_at_hlc).toBeNull();
  });
});
