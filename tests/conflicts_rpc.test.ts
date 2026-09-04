// DC-14 §4.3 resolve/skip over the sidecar RPC line protocol (conflicts_rpc).
// Asserts via TABLES (conflicts / changes / conflict_participants rows),
// never ConflictsViewModel internals, driving handleLine(makeDispatcher(core)).
import { describe, expect, test, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { EventCore } from "../src/persistence/bridges/event_core.ts";
import {
  makeDispatcher,
  handleLine,
} from "../src/persistence/bridges/sidecar_server.ts";
import { createLocalChange } from "../src/persistence/database.ts";
import type { ChangeRecord, VectorClock } from "../src/sync/change_record.ts";

const SELF = "d-self";
const OTHER = "d-other";

let dir: string;
let core: EventCore;
let db: Database.Database;
let hlc = 1000;

interface RpcResponse {
  id: unknown;
  ok: boolean;
  result?: unknown;
  error?: string;
}
async function rpc(op: string, args: unknown): Promise<RpcResponse> {
  return JSON.parse(
    await handleLine(
      makeDispatcher(core),
      JSON.stringify({ id: 1, op, args }),
    ),
  ) as RpcResponse;
}

const count = (sql: string): number =>
  (db.prepare<[], { c: number }>(sql).get() as { c: number }).c;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tide-conflicts-rpc-"));
  core = new EventCore(join(dir, "t.db"), SELF);
  db = core.db;
  db.prepare(
    "INSERT INTO peers (device_id, public_key, display_name, paired_at, status) VALUES (?, ?, 'Other Tablet', ?, 'trusted')",
  ).run(OTHER, Buffer.alloc(32, 7), Date.now());
  db.prepare(
    "INSERT INTO calendars (calendar_id, title, created_hlc, updated_hlc) VALUES ('cal-home', 'Home', 1, 1)",
  ).run();
  db.prepare(
    `INSERT INTO events (event_id, calendar_id, title, description, all_day,
       start_date, end_date, created_hlc, updated_hlc)
     VALUES ('e-1', 'cal-home', 'Standup', '', 1, '2026-09-01', '2026-09-01', 1, 1)`,
  ).run();
  hlc = 1000;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function makeConflict(): {
  conflictId: string;
  localChangeId: string;
  incomingChangeId: string;
} {
  const local = createLocalChange(db, SELF, {
    entity_id: "e-1",
    entity_type: "event",
    field_path: "title",
    operation: "set",
    payload: { value: "local title" },
    hlc_now: () => ++hlc,
  });
  const seq = 41;
  const incomingId = `${OTHER}:${seq}`;
  db.prepare(
    `INSERT INTO changes (change_id, device_id, local_seq, entity_id,
       entity_type, field_path, operation, payload, hlc_timestamp,
       causality_clock, schema_version)
     VALUES (?, ?, ?, 'e-1', 'event', 'title', 'set', ?, ?, ?, 1)`,
  ).run(
    incomingId,
    OTHER,
    seq,
    JSON.stringify({ value: "incoming title" }),
    ++hlc,
    JSON.stringify({ [OTHER]: seq } satisfies VectorClock),
  );
  const conflictId = "cf-rpc-" + Math.random().toString(36).slice(2, 10);
  db.prepare(
    `INSERT INTO conflicts (conflict_id, entity_id, field_path, status,
       detected_at_hlc) VALUES (?, 'e-1', 'title', 'unresolved', ?)`,
  ).run(conflictId, ++hlc);
  for (const p of [
    local,
    { change_id: incomingId, device_id: OTHER },
  ]) {
    const row = db
      .prepare<[string], { payload: string; causality_clock: string; local_seq: number }>(
        "SELECT payload, causality_clock, local_seq FROM changes WHERE change_id = ?",
      )
      .get(p.change_id)!;
    db.prepare(
      `INSERT INTO conflict_participants (conflict_id, change_id, device_id,
         local_seq, causality_clock, payload) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(conflictId, p.change_id, p.device_id, row.local_seq, row.causality_clock, row.payload);
  }
  return { conflictId, localChangeId: local.change_id, incomingChangeId: incomingId };
}

function conflictStatus(conflictId: string): string {
  return (
    db.prepare<[string], { status: string }>(
      "SELECT status FROM conflicts WHERE conflict_id = ?",
    ).get(conflictId) as { status: string }
  ).status;
}

describe("DC-14 §4.3 resolve_conflict over RPC", () => {
  test("keep_mine -> status resolved_keep_local, no new change row", async () => {
    const { conflictId, localChangeId } = makeConflict();
    const changesBefore = count("SELECT COUNT(*) AS c FROM changes");
    const res = await rpc("resolve_conflict", {
      conflict_id: conflictId,
      option: { kind: "keep_mine" },
    });
    expect(res.ok).toBe(true);
    expect(conflictStatus(conflictId)).toBe("resolved_keep_local");
    // Every resolution writes a NEW normal change record via T1 (§6.1/TR-1),
    // even for keep_mine (append-only history, DC-07).
    expect(count("SELECT COUNT(*) AS c FROM changes")).toBe(changesBefore + 1);
    const rows = db
      .prepare<[string], { payload: string; device_id: string }>(
        "SELECT payload, device_id FROM changes WHERE change_id = ?",
      )
      .all(localChangeId);
    expect(rows.length).toBe(1);
    expect(rows[0]!.device_id).toBe(SELF);
    expect(JSON.parse(rows[0]!.payload)).toEqual({ value: "local title" });
    expect(res.result).toBeDefined(); // winning ChangeRecord returned
  });

  test("keep_theirs -> winning value materialized as a NEW self change record so peers converge", async () => {
    const { conflictId, incomingChangeId } = makeConflict();
    const changesBefore = count("SELECT COUNT(*) AS c FROM changes");
    const res = await rpc("resolve_conflict", {
      conflict_id: conflictId,
      option: { kind: "keep_theirs", change_id: incomingChangeId },
    });
    expect(res.ok).toBe(true);
    expect(conflictStatus(conflictId)).toBe("resolved_keep_incoming");
    const record = res.result as ChangeRecord;
    expect(record.device_id).toBe(SELF);
    expect(record.payload).toEqual({ value: "incoming title" });
    const row = db
      .prepare<[string], { payload: string; device_id: string; local_seq: number }>(
        "SELECT payload, device_id, local_seq FROM changes WHERE change_id = ?",
      )
      .get(record.change_id);
    expect(row).toBeDefined();
    expect(row!.device_id).toBe(SELF);
    expect(JSON.parse(row!.payload)).toEqual({ value: "incoming title" });
    // fresh local_seq + HLC -> normal change record; no participant added
    expect(
      db.prepare<[string], { c: number }>(
        "SELECT COUNT(*) AS c FROM conflict_participants WHERE change_id = ?",
      ).get(record.change_id),
    ).toEqual({ c: 0 });
    expect(count("SELECT COUNT(*) AS c FROM changes")).toBe(changesBefore + 1);
  });

  test("skip -> zero writes anywhere (TR-2)", async () => {
    const { conflictId } = makeConflict();
    const before = {
      conflicts: count("SELECT COUNT(*) AS c FROM conflicts"),
      changes: count("SELECT COUNT(*) AS c FROM changes"),
      events: count("SELECT COUNT(*) AS c FROM events"),
      parts: count("SELECT COUNT(*) AS c FROM conflict_participants"),
    };
    const res = await rpc("skip_conflict", { conflict_id: conflictId });
    expect(res.ok).toBe(true);
    expect(res.result).toBeNull();
    expect(conflictStatus(conflictId)).toBe("unresolved");
    expect(count("SELECT COUNT(*) AS c FROM conflicts")).toBe(before.conflicts);
    expect(count("SELECT COUNT(*) AS c FROM changes")).toBe(before.changes);
    expect(count("SELECT COUNT(*) AS c FROM events")).toBe(before.events);
    expect(count("SELECT COUNT(*) AS c FROM conflict_participants")).toBe(before.parts);
  });

  test("double resolve -> ok:false, second resolve writes nothing", async () => {
    const { conflictId } = makeConflict();
    expect(
      (await rpc("resolve_conflict", {
        conflict_id: conflictId,
        option: { kind: "keep_mine" },
      })).ok,
    ).toBe(true);
    const changesAfterFirst = count("SELECT COUNT(*) AS c FROM changes");
    const second = await rpc("resolve_conflict", {
      conflict_id: conflictId,
      option: { kind: "keep_mine" },
    });
    expect(second.ok).toBe(false);
    expect(second.error).toMatch(/already/);
    expect(count("SELECT COUNT(*) AS c FROM changes")).toBe(changesAfterFirst);
    expect(conflictStatus(conflictId)).toBe("resolved_keep_local");
  });

  test("unknown conflict_id -> ok:false for resolve; skip stays a no-op", async () => {
    const { conflictId } = makeConflict();
    const res = await rpc("resolve_conflict", {
      conflict_id: "no-such-conflict",
      option: { kind: "keep_mine" },
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/no conflict/);
    const skip = await rpc("skip_conflict", { conflict_id: "no-such-conflict" });
    expect(skip.ok).toBe(true); // skip is a no-op regardless (TR-2)
    expect(count("SELECT COUNT(*) AS c FROM conflicts")).toBe(1);
  });

  test("malformed option shape -> ok:false, conflict stays unresolved", async () => {
    const { conflictId } = makeConflict();
    for (const option of [
      null,
      "keep_mine",
      {},
      { kind: "nonsense" },
      { kind: "keep_theirs", change_id: 123 },
      { kind: "resolved_custom" }, // missing value
    ]) {
      const res = await rpc("resolve_conflict", { conflict_id: conflictId, option });
      expect(res.ok).toBe(false);
      expect(conflictStatus(conflictId)).toBe("unresolved");
    }
    // "resolved_custom" (frontend alias) with a value -> resolved_custom
    const ok = await rpc("resolve_conflict", {
      conflict_id: conflictId,
      option: { kind: "resolved_custom", value: "merged title" },
    });
    expect(ok.ok).toBe(true);
    expect(conflictStatus(conflictId)).toBe("resolved_custom");
  });
});
