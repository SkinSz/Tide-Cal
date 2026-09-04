// TD-002: NaN/Infinity reachability investigation — regression tests.
//
// EMPIRICAL EVIDENCE (probes run 2026-08-27, node + repo HEAD 12a3073):
//  1. JSON.parse('{"startMs":1e999}') === { startMs: Infinity } — VALID JSON
//     number token overflowing to Infinity. JSON.parse rejects bare NaN /
//     Infinity literals per spec, but 1e999/-1e999 slips through.
//  2. validateChangeRecord's `typeof v === "number"` guards pass Infinity.
//  3. better-sqlite3 binds Infinity as REAL Infinity (durable!) and NaN as
//     NULL; derivedScheduleColumns derives wall strings like "NaN:NaN:NaN"
//     from non-finite epoch-ms values.
//  4. Fix: validateChangeRecord now deep-scans payload for non-finite numbers
//     and throws, so the sync engine durably quarantines the record (existing
//     DC-04 §4.3 machinery) — it is never bound to the DB.

import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ChangeRecordError,
  changeId,
  validateChangeRecord,
  type ChangeRecord,
} from "../src/sync/change_record.ts";
import { openDatabase } from "../src/persistence/database.ts";
import {
  derivedScheduleColumns,
  insertEventRow,
} from "../src/persistence/bridges/event_core.ts";

function baseRecord(overrides: Partial<ChangeRecord> = {}): ChangeRecord {
  return {
    change_id: "dev-a:1",
    device_id: "dev-a",
    local_seq: 1,
    entity_id: "evt-1",
    entity_type: "event",
    field_path: "schedule",
    operation: "set",
    payload: { value: { startMs: 1000, endMs: 2000, allDay: false } },
    hlc_timestamp: 1756000000000,
    causality_clock: { "dev-a": 1 },
    schema_version: 1,
    ...overrides,
  } as ChangeRecord;
}

describe("TD-002: non-finite numbers are unreachable through the sync path", () => {
  it("JSON.parse of a 1e999-bearing wire record yields Infinity (reachability premise)", () => {
    const wire = '{"startMs":1e999,"endMs":1e999,"allDay":false}';
    const v = JSON.parse(wire) as { startMs: number };
    expect(v.startMs).toBe(Infinity);
    expect(typeof v.startMs).toBe("number");
    expect(Number.isFinite(v.startMs)).toBe(false);
    // JSON.stringify round-trip can never legitimately produce non-finite:
    expect(JSON.stringify({ x: NaN, y: Infinity })).toBe('{"x":null,"y":null}');
    // and bare NaN / Infinity literals are rejected per spec:
    expect(() => JSON.parse('{"x": NaN}')).toThrow();
  });

  it("rejects a record whose schedule payload carries 1e999-derived Infinity", () => {
    const wire = JSON.parse(
      '{"change_id":"dev-a:1","device_id":"dev-a","local_seq":1,"entity_id":"evt-1",' +
        '"entity_type":"event","field_path":"schedule","operation":"set",' +
        '"payload":{"value":{"startMs":1e999,"endMs":1e999,"allDay":false}},' +
        `"hlc_timestamp":1756000000000,"causality_clock":{"dev-a":1},"schema_version":1}`,
    );
    expect(() => validateChangeRecord(wire)).toThrowError(ChangeRecordError);
  });

  it("rejects NaN payloads (nested) — typeof 'number' alone is insufficient", () => {
    const rec = baseRecord({
      payload: { value: { startMs: NaN, endMs: 2000, allDay: false } },
    });
    expect(() => validateChangeRecord(rec)).toThrowError(ChangeRecordError);
  });

  it("rejects non-finite numbers nested anywhere in the payload", () => {
    const rec = baseRecord({
      field_path: "event",
      payload: {
        value: {
          title: "t",
          reminders: [{ atMs: JSON.parse("1e999") as number }],
          startMs: 1000,
          endMs: 2000,
        },
      },
    });
    expect(() => validateChangeRecord(rec)).toThrowError(ChangeRecordError);
  });

  it("legitimate large-but-finite timestamps still validate and bind correctly", () => {
    const year9999 = 253402300799000; // finite, far beyond current epoch ms
    const rec = baseRecord({
      payload: { value: { startMs: year9999, endMs: year9999 + 1, allDay: false } },
    });
    expect(() => validateChangeRecord(rec)).not.toThrow();

    // and the same value binds to a real row without corruption:
    const db = openDatabase({ path: join(mkdtempSync(join(tmpdir(), "td002-")), "t.db") });
    db.prepare(
      "INSERT INTO calendars (calendar_id, title, created_hlc, updated_hlc) VALUES ('local', 'My Calendar', 1, 1)",
    ).run();
    insertEventRow(
      db,
      {
        id: "evt-big",
        title: "t",
        description: "",
        startMs: year9999,
        endMs: year9999 + 1,
        allDay: false,
      },
      rec.hlc_timestamp,
      true,
    );
    const row = db
      .prepare(
        "SELECT utc_start_ms, typeof(utc_start_ms) AS t, start_wall, all_day FROM events WHERE event_id = ?",
      )
      .get("evt-big") as {
      utc_start_ms: number;
      t: string;
      start_wall: string;
      all_day: number;
    };
    expect(row.t).toBe("integer");
    expect(row.utc_start_ms).toBe(year9999);
    expect(row.start_wall).not.toContain("NaN");
    expect(row.all_day).toBe(0);
  });

  it("proves the corruption the guard prevents: derived columns from Infinity are garbage", () => {
    // Documented demonstration (not a spec of desired behavior): pre-fix,
    // derivedScheduleColumns fed with Infinity produced non-finite/garbage
    // column values — exactly what the validation guard now makes
    // unreachable through the remote sync path.
    const inf = JSON.parse("1e999") as number;
    const derived = derivedScheduleColumns({
      id: "evt-x",
      title: "t",
      description: "",
      startMs: inf,
      endMs: inf,
      allDay: true,
    });
    expect(Number.isFinite(derived.utc_start_ms)).toBe(false);
    expect(derived.start_date).toMatch(/NaN|\d/) ; // derivation does not throw
  });

  it("change_id format rule is unaffected by the guard", () => {
    const rec = baseRecord({ change_id: "dev-a:2" });
    expect(() => validateChangeRecord(rec)).toThrowError(ChangeRecordError);
    expect(changeId("dev-a", 1)).toBe("dev-a:1");
  });
});
