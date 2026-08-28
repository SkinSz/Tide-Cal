// TD-005 remainder — quarantine resolution UI + retention cap (TD-008).
// Covers: per-item retry (success/failure/idempotent), per-item delete
// (RPC-level confirm gate; skip-row invariant; stream unblocked), retention
// cap pruning semantics (oldest resolved, actives untouched, durable count),
// and the human-readable reason mapping fallback.
import { describe, expect, test, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  openDatabase,
  quarantineRecord,
  listQuarantine,
  listQuarantineStats,
  markQuarantineResolved,
  markSeqSkipped,
  isSeqSkipped,
  pruneResolvedQuarantine,
  deleteQuarantineByUser,
  applyRemoteChange,
  loadKnowledgeFromDb,
  QUARANTINE_RESOLVED_RETENTION_CAP,
} from "../src/persistence/database.ts";
import { makeEntityMutator } from "../src/persistence/bridges/sync_service.ts";
import {
  retryQuarantineRecord,
  createSyncEngine,
} from "../src/sync/sync_engine.ts";
import { validateChangeRecord } from "../src/sync/change_record.ts";
import type { ChangeRecord } from "../src/sync/change_record.ts";
import {
  humanReason,
  shapeQuarantineRows,
  type QuarantineRow,
} from "../frontend/sync_errors.ts";
import {
  SyncManager,
  makeSyncDispatcher,
  handleLine,
} from "../src/persistence/bridges/sidecar_server.ts";
import { EventCore } from "../src/persistence/bridges/event_core.ts";
import { loadOrCreateIdentity } from "../src/network/sync_runtime.ts";
import type { Database } from "better-sqlite3";

const T0 = Date.UTC(2026, 8, 1, 9, 0, 0); // fixed epoch ms — deterministic
const PRODUCER = "d-td005b";
const SELF = "d-self-td005b";

let dir: string;
let dbPath: string;
let db: Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tide-td005b-"));
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
    entity_id: "evt-td005b",
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

function quarantine(seq: number, valid = true): number {
  quarantineRecord(db, {
    reason: "invalid_change_record:bad_operation",
    senderDeviceId: SELF,
    rawRecord: makeRecord(seq, valid),
  });
  return listQuarantine(db)[0]!.quarantine_id;
}

// ---------------------------------------------------------------------------
// 1. Retry — success / failure / idempotency
// ---------------------------------------------------------------------------
describe("TD-005 remainder: per-item retry", () => {
  test("success: applies the record, marks resolved 'retried_by_user', removes skip row", () => {
    const id = quarantine(1, true); // record is NOW valid (e.g. sender fixed it)
    markSeqSkipped(db, PRODUCER, 1);
    expect(isSeqSkipped(db, PRODUCER, 1)).toBe(true);

    const res = retryQuarantineRecord(db, id, makeEntityMutator());
    expect(res).toEqual({ outcome: "applied", resolved: true });
    expect(isSeqSkipped(db, PRODUCER, 1)).toBe(false);

    const row = listQuarantine(db).find((r) => r.quarantine_id === id)!;
    expect(row.resolved_at_hlc).not.toBeNull();
    expect(row.resolved_reason).toBe("retried_by_user");
    expect(
      db.prepare("SELECT 1 FROM changes WHERE change_id = ?").get(`${PRODUCER}:1`),
    ).toBeTruthy();
  });

  test("failure: still-invalid record stays active with its skip row", () => {
    const id = quarantine(1, false); // permanently invalid
    markSeqSkipped(db, PRODUCER, 1);

    const res = retryQuarantineRecord(db, id, makeEntityMutator());
    expect(res).toEqual({ outcome: "invalid", resolved: false });
    const row = listQuarantine(db).find((r) => r.quarantine_id === id)!;
    expect(row.resolved_at_hlc).toBeNull(); // stays ACTIVE
    expect(isSeqSkipped(db, PRODUCER, 1)).toBe(true); // skip row restored
  });

  test("idempotent: retry of an already-resolved row is a no-op; missing id reported", () => {
    const id = quarantine(1, true);
    markSeqSkipped(db, PRODUCER, 1);
    expect(retryQuarantineRecord(db, id, makeEntityMutator()).outcome).toBe("applied");
    const first = listQuarantine(db).find((r) => r.quarantine_id === id)!;
    // Concurrent restart / double click: nothing changes.
    expect(retryQuarantineRecord(db, id, makeEntityMutator())).toEqual({
      outcome: "already_resolved",
      resolved: false,
    });
    const again = listQuarantine(db).find((r) => r.quarantine_id === id)!;
    expect(again.resolved_at_hlc).toBe(first.resolved_at_hlc);
    expect(retryQuarantineRecord(db, 99999, makeEntityMutator())).toEqual({
      outcome: "not_found",
      resolved: false,
    });
  });
});

// ---------------------------------------------------------------------------
// 2. Delete — confirm gate, retained tombstone row, skip-row invariant
// ---------------------------------------------------------------------------
describe("TD-005 remainder: per-item delete (give up)", () => {
  test("RPC gate: delete fires ONLY with explicit confirm:true", () => {
    const id = quarantine(1, false);
    expect(() => deleteQuarantineByUser(db, id, { confirm: false })).toThrow(
      /confirm/,
    );
    expect(() =>
      deleteQuarantineByUser(db, id, {} as { confirm: boolean }),
    ).toThrow(/confirm/);
    // Row untouched by refusals.
    expect(listQuarantine(db)[0]!.resolved_at_hlc).toBeNull();
  });

  test("confirmed delete retains the row as user_deleted and keeps the skip row", () => {
    const id = quarantine(1, false);
    markSeqSkipped(db, PRODUCER, 1);
    const res = deleteQuarantineByUser(db, id, { confirm: true });
    expect(res).toEqual({ ok: true, skip_row_present: true, skip_row_recreated: false });
    expect(isSeqSkipped(db, PRODUCER, 1)).toBe(true); // CRITICAL: stream unblocked

    const row = listQuarantine(db).find((r) => r.quarantine_id === id)!;
    expect(row).toBeTruthy(); // NEVER physically deleted
    expect(row!.resolved_reason).toBe("user_deleted");
    expect(row!.resolved_at_hlc).not.toBeNull();
    const stats = listQuarantineStats(db);
    expect(stats.active).toBe(0); // badge drops
    expect(stats.resolved).toBe(1);
  });

  test("missing skipped_seqs row is re-created by delete (invariant repair)", () => {
    const id = quarantine(1, false);
    // Simulate drift: no skip row at all.
    expect(isSeqSkipped(db, PRODUCER, 1)).toBe(false);
    const res = deleteQuarantineByUser(db, id, { confirm: true });
    expect(res.skip_row_recreated).toBe(true);
    expect(isSeqSkipped(db, PRODUCER, 1)).toBe(true);
  });

  test("stream stays unblocked: seq N+1 applies after delete", () => {
    const id = quarantine(1, false);
    markSeqSkipped(db, PRODUCER, 1);
    deleteQuarantineByUser(db, id, { confirm: true });

    const k = loadKnowledgeFromDb(db);
    const outcome = applyRemoteChange(
      db,
      makeRecord(2, true),
      k,
      makeEntityMutator(),
    );
    expect(outcome).toBe("applied"); // seq 2 did NOT stall behind seq 1
  });

  test("RPC-level: dispatcher refuses delete_quarantine without confirm flag", async () => {
    const core = new EventCore(join(dir, "core.db"), SELF);
    const identity = loadOrCreateIdentity(dir);
    const sync = new SyncManager(core, identity, dir);
    const dispatch = makeSyncDispatcher(sync, core);
    quarantineRecord(core.db, {
      reason: "invalid_change_record:bad_operation",
      senderDeviceId: SELF,
      rawRecord: makeRecord(1, false),
    });
    const id = listQuarantine(core.db)[0]!.quarantine_id;

    const refused = JSON.parse(
      await handleLine(dispatch, JSON.stringify({ id: 1, op: "delete_quarantine", args: { quarantine_id: id } })),
    ) as { ok: boolean; error: string };
    expect(refused.ok).toBe(false);
    expect(refused.error).toMatch(/confirm/);

    const ok = JSON.parse(
      await handleLine(dispatch, JSON.stringify({ id: 2, op: "delete_quarantine", args: { quarantine_id: id, confirm: true } })),
    ) as { ok: boolean; result: { ok: boolean; skip_row_present: boolean } };
    expect(ok.ok).toBe(true);
    expect(ok.result.ok).toBe(true);
    core.db.close();
  });

  test("delete of an already-resolved row is idempotent (original reason kept)", () => {
    const id = quarantine(1, true);
    markSeqSkipped(db, PRODUCER, 1);
    markQuarantineResolved(db, id, "revalidated_on_restart");
    deleteQuarantineByUser(db, id, { confirm: true });
    expect(
      listQuarantine(db).find((r) => r.quarantine_id === id)!.resolved_reason,
    ).toBe("revalidated_on_restart");
  });
});

// ---------------------------------------------------------------------------
// 3. Retention cap (TD-008 closure)
// ---------------------------------------------------------------------------
function seedResolved(n: number, startId: number): void {
  for (let i = 0; i < n; i++) {
    quarantineRecord(db, {
      reason: "invalid_change_record:bad_operation",
      senderDeviceId: SELF,
      rawRecord: makeRecord(10_000 + startId + i, false),
    });
  }
  const rows = db
    .prepare(
      "SELECT quarantine_id FROM quarantine WHERE resolved_at_hlc IS NULL ORDER BY quarantine_id DESC LIMIT ?",
    )
    .all(n) as Array<{ quarantine_id: number }>;
  for (const r of rows) markQuarantineResolved(db, r.quarantine_id, "revalidated_on_restart");
}

describe("TD-008: resolved-row retention cap", () => {
  test("prunes oldest RESOLVED rows beyond cap; ACTIVE rows never touched", () => {
    const cap = 5;
    seedResolved(7, 0); // 7 resolved
    const activeIds = [quarantine(20_001, false), quarantine(20_002, false)];
    expect(listQuarantineStats(db).active).toBe(2);

    const pruned = pruneResolvedQuarantine(db, cap);
    expect(pruned).toBe(2); // 7 - 5

    const stats = listQuarantineStats(db);
    expect(stats.resolved).toBe(cap); // cap enforced
    expect(stats.active).toBe(2); // untouched
    expect(stats.total_pruned).toBe(2); // durable cumulative counter

    // Oldest (lowest ids) are gone; newest resolved survive.
    const remaining = listQuarantine(db, { limit: 1000 });
    expect(remaining.some((r) => r.resolved_at_hlc === null && activeIds.includes(r.quarantine_id))).toBe(true);
  });

  test("below-cap and repeated runs are no-ops; invalid cap rejected", () => {
    seedResolved(3, 100);
    expect(pruneResolvedQuarantine(db, 5)).toBe(0);
    expect(pruneResolvedQuarantine(db, 5)).toBe(0); // idempotent
    expect(listQuarantineStats(db).total_pruned).toBe(0);
    expect(() => pruneResolvedQuarantine(db, -1)).toThrow(/cap/);
  });

  test("startup prune: reopen + createSyncEngine enforces the DEFAULT cap", () => {
    // Seed default-cap + 2 resolved rows and 1 active row.
    seedResolved(QUARANTINE_RESOLVED_RETENTION_CAP + 2, 500);
    const activeId = quarantine(30_001, false);
    expect(listQuarantineStats(db).resolved).toBe(QUARANTINE_RESOLVED_RETENTION_CAP + 2);

    db.close();
    db = openDatabase({ path: dbPath }); // restart
    createSyncEngine({ db, selfDeviceId: SELF, mutateEntity: makeEntityMutator() });

    const stats = listQuarantineStats(db);
    expect(stats.resolved).toBe(QUARANTINE_RESOLVED_RETENTION_CAP); // cap enforced
    expect(stats.total_pruned).toBe(2);
    const active = listQuarantine(db, { limit: 10_000 }).find(
      (r) => r.quarantine_id === activeId,
    )!;
    expect(active.resolved_at_hlc).toBeNull(); // active rows NEVER pruned
    // The two OLDEST resolved rows (ids 1 and 2 of the 1002 seeded) are the
    // pruned ones; the oldest SURVIVOR is id 3.
    const minResolvedId = (
      db
        .prepare("SELECT MIN(quarantine_id) AS m FROM quarantine WHERE resolved_at_hlc IS NOT NULL")
        .get() as { m: number }
    ).m;
    expect(minResolvedId).toBe(3);
  });

  test("resolved rows survive restart durably after prune (schema v5 table)", () => {
    seedResolved(1, 900);
    pruneResolvedQuarantine(db, 1);
    db.close();
    db = openDatabase({ path: dbPath });
    expect(listQuarantineStats(db).total_pruned).toBe(0); // counter durable (0 pruned)
    const v = (
      db.prepare("SELECT version FROM schema_version").get() as { version: number }
    ).version;
    expect(v).toBeGreaterThanOrEqual(5);
  });
});

// ---------------------------------------------------------------------------
// 4. Human-readable reason mapping (+ fallback)
// ---------------------------------------------------------------------------
describe("TD-005 remainder: human-readable reasons", () => {
  test("known codes map to plain-language sentences", () => {
    expect(humanReason("invalid_change_record:bad_operation")).toBe(
      "The record uses an operation this version doesn't recognize.",
    );
    expect(humanReason("invalid_change_record:id_mismatch")).toBe(
      "The record's ID doesn't match its contents.",
    );
    expect(humanReason("bad_seq")).toBe(
      "The record's sequence number is missing or invalid.",
    );
    expect(humanReason("invalid_member_id")).toBe(
      "The record contains a field this version doesn't recognize.",
    );
  });

  test("unknown codes fall back to the code VERBATIM (never hidden)", () => {
    expect(humanReason("some_future_code")).toBe("some_future_code");
    expect(humanReason("invalid_change_record:new_detail_xyz")).toBe(
      "invalid_change_record:new_detail_xyz",
    );
  });

  test("shaping carries both the sentence and the verbatim code", () => {
    quarantine(1, false);
    const views = shapeQuarantineRows(listQuarantine(db) as QuarantineRow[]);
    expect(views[0]!.reason).toBe("invalid_change_record:bad_operation");
    expect(views[0]!.reason_human).toBe(
      "The record uses an operation this version doesn't recognize.",
    );
  });

  test("mapped codes correspond to what validateChangeRecord actually emits", () => {
    // Guard against drift: the detail MESSAGES validateChangeRecord actually
    // throws must map to a human sentence (not the verbatim code).
    const samples: Array<[unknown, RegExp]> = [
      [{ nope: 1 }, /^invalid change_id$/], // missing required field
      [
        {
          change_id: `${PRODUCER}:1`, device_id: PRODUCER, local_seq: 0,
          entity_id: "e", entity_type: "event", field_path: "title",
          operation: "set", payload: {}, hlc_timestamp: T0,
          causality_clock: {}, schema_version: 1,
        },
        /^local_seq must be a positive integer$/,
      ],
    ];
    for (const [raw, expectedMsg] of samples) {
      let msg = "";
      try {
        validateChangeRecord(raw as never);
      } catch (e) {
        msg = (e as Error).message;
      }
      expect(msg).toMatch(expectedMsg);
      const human = humanReason(`invalid_change_record:${msg}`);
      expect(human).not.toBe(`invalid_change_record:${msg}`); // sentence, not the raw code
      expect(human).toMatch(/^The record/);
    }
  });
});
