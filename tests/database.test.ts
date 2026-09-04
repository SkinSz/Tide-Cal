import { describe, expect, test, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { openDatabase, createLocalChange, applyRemoteChange, loadKnowledgeFromDb, quarantineRecord, countQuarantined } from "../src/persistence/database.ts";
import { SCHEMA_VERSION } from "../src/persistence/schema.ts";
import { makeChange } from "./change_record.test.ts";
import { emptyKnowledge } from "../src/sync/knowledge_state.ts";
import type { ChangeRecord } from "../src/sync/change_record.ts";

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tide-db-"));
  path = join(dir, "tide.db");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("DC-07 TR-1 clean create", () => {
  test("schema initializes once with version row", () => {
    const db = openDatabase({ path });
    const v = db.prepare("SELECT version FROM schema_version").get() as { version: number };
    expect(v.version).toBe(SCHEMA_VERSION);
    // idempotent reopen
    const db2 = openDatabase({ path });
    const count = db2.prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table'").get() as { c: number };
    expect(count.c).toBeGreaterThan(15);
    db.close();
    db2.close();
  });

  test("rejects newer schema version (fail closed)", () => {
    let db = openDatabase({ path });
    db.prepare("UPDATE schema_version SET version = 99").run();
    db.close();
    expect(() => openDatabase({ path })).toThrowError(/newer than supported/);
  });
});

describe("DC-07 §7 T1 local change creation", () => {
  test("atomic: change row + device_clock advance together", () => {
    const db = openDatabase({ path });
    const r1 = createLocalChange(db, "d-self", {
      entity_id: "e-1",
      entity_type: "event",
      field_path: "title",
      operation: "set",
      payload: { value: "Dentist" },
      hlc_now: () => 1000,
    });
    expect(r1.local_seq).toBe(1);
    expect(r1.change_id).toBe("d-self:1");

    const r2 = createLocalChange(db, "d-self", {
      entity_id: "e-1",
      entity_type: "event",
      field_path: "title",
      operation: "set",
      payload: { value: "Doctor" },
      hlc_now: () => 2000,
    });
    expect(r2.local_seq).toBe(2);

    // gap-free local_seq per producer (DC-01 TR-2)
    const seqs = db
      .prepare<[string], { m: number }>("SELECT COUNT(DISTINCT local_seq) AS m FROM changes WHERE device_id=?")
      .get("d-self")!.m;
    expect(seqs).toBe(2);

    const clock = db
      .prepare<[string], { max_seq: number }>("SELECT max_seq FROM device_clock WHERE peer_device_id = ?")
      .get("d-self");
    expect(clock?.max_seq).toBe(2);
    db.close();
  });

  test("mutate callback runs in same transaction", () => {
    const db = openDatabase({ path });
    createLocalChange(
      db,
      "d-self",
      {
        entity_id: "c-1",
        entity_type: "calendar",
        field_path: "title",
        operation: "set",
        payload: { value: "Home" },
        hlc_now: () => 1,
      },
      (db2) => {
        db2.prepare(
          "INSERT INTO calendars (calendar_id,title,created_hlc,updated_hlc) VALUES ('c-1','Home',1,1)",
        ).run();
      },
    );
    expect((db.prepare("SELECT COUNT(*) c FROM calendars").get() as { c: number }).c).toBe(1);
    db.close();
  });

  test("TR-3: UNIQUE(device_id,local_seq) rejects duplicates", () => {
    const db = openDatabase({ path });
    const insert = db.prepare(`
      INSERT INTO changes (change_id,device_id,local_seq,entity_id,entity_type,
        field_path,operation,payload,hlc_timestamp,causality_clock,schema_version)
      VALUES ('x','d-x',5,'e','event','t','set','{}',0,'{}',1)`);
    insert.run();
    expect(() => insert.run()).toThrowError(/UNIQUE/);
    db.close();
  });

  test("TR-4: CHECK constraints reject bad enums", () => {
    const db = openDatabase({ path });
    const insert = db.prepare(`
      INSERT INTO changes (change_id,device_id,local_seq,entity_id,entity_type,
        field_path,operation,payload,hlc_timestamp,causality_clock,schema_version)
      VALUES ('y','d-y',1,'e','blob','t','set','{}',0,'{}',1)`);
    expect(() => insert.run()).toThrowError(/CHECK|constraint/i);
    db.close();
  });
});

describe("DC-07 §7 T2 remote apply", () => {
  test("applies contiguous remote change and advances applied_upto + clock merge", () => {
    const db = openDatabase({ path });
    const k = emptyKnowledge();
    const rec = makeChange({ device_id: "d-phone", local_seq: 1, clock: { "d-phone": 1, "d-desktop": 7 } });
    const out = applyRemoteChange(db, rec, k);
    expect(out).toBe("applied");
    expect(k.appliedUpto["d-phone"]).toBe(1);
    const storedClock = JSON.parse(
      (db.prepare("SELECT causality_clock FROM changes WHERE change_id=?").get(rec.change_id) as { causality_clock: string }).causality_clock,
    );
    expect(storedClock).toEqual({ "d-phone": 1, "d-desktop": 7 });
    // element-wise max merged into device_clock
    expect((db.prepare("SELECT max_seq m FROM device_clock WHERE peer_device_id='d-desktop'").get() as { m: number }).m).toBe(7);
    db.close();
  });

  test("out-of-order buffers, then drains on gap fill (single transaction)", () => {
    const db = openDatabase({ path });
    const k = emptyKnowledge();
    const applied: ChangeRecord[] = [];
    const mutate = (_db: unknown, r: ChangeRecord) => applied.push(r);

    const third = makeChange({ device_id: "d-p", local_seq: 3, value: "third" });
    expect(applyRemoteChange(db, third, k, mutate as never)).toBe("buffered");
    expect(applied).toHaveLength(0);
    expect((db.prepare("SELECT COUNT(*) c FROM pending_changes").get() as { c: number }).c).toBe(1);

    const first = makeChange({ device_id: "d-p", local_seq: 1, value: "first" });
    expect(applyRemoteChange(db, first, k, mutate as never)).toBe("applied");

    const second = makeChange({ device_id: "d-p", local_seq: 2, value: "second" });
    expect(applyRemoteChange(db, second, k, mutate as never)).toBe("applied");

    // drained 2 AND buffered 3
    expect(applied.map((r) => r.local_seq)).toEqual([1, 2, 3]);
    expect(k.appliedUpto["d-p"]).toBe(3);
    expect((db.prepare("SELECT COUNT(*) c FROM pending_changes").get() as { c: number }).c).toBe(0);
    db.close();
  });

  test("duplicate is a no-op but still merges clocks", () => {
    const db = openDatabase({ path });
    const k = emptyKnowledge();
    const rec = makeChange({ device_id: "d-p", local_seq: 1, clock: { "d-p": 1, "d-q": 42 } });
    applyRemoteChange(db, rec, k);
    const before = (db.prepare("SELECT COUNT(*) c FROM changes").get() as { c: number }).c;
    const out = applyRemoteChange(db, makeChange(rec), k);
    expect(out).toBe("duplicate");
    expect((db.prepare("SELECT COUNT(*) c FROM changes").get() as { c: number }).c).toBe(before);
    expect((db.prepare("SELECT max_seq m FROM device_clock WHERE peer_device_id='d-q'").get() as { m: number }).m).toBe(42);
    db.close();
  });
});

describe("DC-04 §4.3 / DC-08 §5 Stage 2 durable quarantine (H-3)", () => {
  test("TR-10: quarantined record persists across close/reopen", () => {
    let db = openDatabase({ path });
    quarantineRecord(db, {
      reason: "invalid_member_id",
      senderDeviceId: "d-rogue",
      rawRecord: { change_id: "d-rogue:9", bogus: true },
    });
    db.close();

    // Reopen (schema init must be idempotent; quarantine row survives WAL).
    db = openDatabase({ path });
    expect(countQuarantined(db)).toBe(1);
    const row = db
      .prepare<[], { quarantine_reason: string; sender_device_id: string }>(
        "SELECT quarantine_reason, sender_device_id FROM quarantine",
      )
      .get();
    expect(row?.quarantine_reason).toBe("invalid_member_id");
    expect(row?.sender_device_id).toBe("d-rogue");
    db.close();
  });

  test("countQuarantined filters by reason (DC-04 §4.3c countable surface)", () => {
    const db = openDatabase({ path });
    quarantineRecord(db, { reason: "invalid_member_id", senderDeviceId: "d-a", rawRecord: { i: 1 } });
    quarantineRecord(db, { reason: "invalid_member_id", senderDeviceId: "d-b", rawRecord: { i: 2 } });
    quarantineRecord(db, { reason: "whole_collection_replacement", senderDeviceId: "d-c", rawRecord: { i: 3 } });

    expect(countQuarantined(db)).toBe(3);
    expect(countQuarantined(db, "invalid_member_id")).toBe(2);
    expect(countQuarantined(db, "whole_collection_replacement")).toBe(1);
    expect(countQuarantined(db, "nonexistent_reason")).toBe(0);
    db.close();
  });

  test("raw_record round-trips byte-identical JSON", () => {
    const db = openDatabase({ path });
    // Key order + unicode + numbers chosen so any re-serialization drift shows.
    const record = {
      zeta: 1,
      alpha: [1, 2.5, 1e21],
      text: "üñïçøde ✓ \"quoted\"",
      nested: { b: null, a: true },
    };
    const expected = JSON.stringify(record);
    quarantineRecord(db, {
      reason: "member_id_mismatch",
      senderDeviceId: "d-x",
      rawRecord: record,
    });

    const stored = (
      db.prepare("SELECT raw_record FROM quarantine").get() as { raw_record: string }
    ).raw_record;
    expect(stored).toBe(expected); // byte-identical on disk
    expect(JSON.parse(stored)).toEqual(record); // parses back to same value
    expect(JSON.stringify(JSON.parse(stored))).toBe(expected); // stable re-encode
    db.close();
  });
});

// ---------------------------------------------------------------------------
// Review 2 criticals C1/C2/C3 — persistence durability & atomicity
// ---------------------------------------------------------------------------

describe("C1 restart durability (loadKnowledgeFromDb + idempotent redelivery)", () => {
  test("rebuilds appliedUpto from DB; redelivery after reopen is duplicate", () => {
    let db = openDatabase({ path });
    const k = emptyKnowledge();
    for (let seq = 1; seq <= 3; seq++) {
      expect(
        applyRemoteChange(db, makeChange({ device_id: "d-p", local_seq: seq }), k),
      ).toBe("applied");
    }
    db.close();

    // Simulate process restart: reopen and rebuild knowledge purely from disk.
    db = openDatabase({ path });
    const k2 = loadKnowledgeFromDb(db);
    expect(k2.appliedUpto["d-p"]).toBe(3);

    // Redelivering an already-applied record must be a clean no-op duplicate,
    // not a UNIQUE-constraint crash (DC-02 §7.1 / DC-03 TR-8).
    const before = (db.prepare("SELECT COUNT(*) c FROM changes").get() as { c: number }).c;
    const out = applyRemoteChange(db, makeChange({ device_id: "d-p", local_seq: 2 }), k2);
    expect(out).toBe("duplicate");
    expect((db.prepare("SELECT COUNT(*) c FROM changes").get() as { c: number }).c).toBe(before);
    db.close();
  });
});

describe("C1 pending survives restart", () => {
  test("buffered gap fills correctly from DB-rebuilt state after reopen", () => {
    let db = openDatabase({ path });
    const k = emptyKnowledge();
    expect(applyRemoteChange(db, makeChange({ device_id: "d-p", local_seq: 1 }), k)).toBe("applied");
    expect(applyRemoteChange(db, makeChange({ device_id: "d-p", local_seq: 2 }), k)).toBe("applied");
    expect(applyRemoteChange(db, makeChange({ device_id: "d-p", local_seq: 4 }), k)).toBe("buffered");
    expect((db.prepare("SELECT COUNT(*) c FROM pending_changes").get() as { c: number }).c).toBe(1);
    db.close();

    // Restart: pending_changes table is the only memory of seq 4.
    db = openDatabase({ path });
    const k2 = loadKnowledgeFromDb(db);
    expect(k2.appliedUpto["d-p"]).toBe(2);
    expect(k2.pending.get("d-p")?.has(4)).toBe(true);

    // Deliver the missing seq 3 -> drains 3 AND the buffered 4.
    const out = applyRemoteChange(db, makeChange({ device_id: "d-p", local_seq: 3 }), k2);
    expect(out).toBe("applied");
    const rows = db
      .prepare<[], { local_seq: number }>(
        "SELECT local_seq FROM changes WHERE device_id = 'd-p' ORDER BY local_seq",
      )
      .all()
      .map((r) => r.local_seq);
    expect(rows).toEqual([1, 2, 3, 4]);
    expect((db.prepare("SELECT COUNT(*) c FROM pending_changes").get() as { c: number }).c).toBe(0);
    db.close();
  });
});

describe("C2 T2 atomicity on mutate failure", () => {
  test("throwing mutate leaves no partial state; retry applies exactly once", () => {
    const db = openDatabase({ path });
    const k = emptyKnowledge();
    let attempts = 0;
    const failingMutate = () => {
      attempts += 1;
      throw new Error("mutate boom");
    };

    const rec = makeChange({ device_id: "d-p", local_seq: 1 });
    expect(() => applyRemoteChange(db, rec, k, failingMutate as never)).toThrowError(/mutate boom/);
    expect(attempts).toBe(1);

    // Nothing may have leaked into the DB mid-failure...
    expect((db.prepare("SELECT COUNT(*) c FROM changes").get() as { c: number }).c).toBe(0);
    expect((db.prepare("SELECT COUNT(*) c FROM pending_changes").get() as { c: number }).c).toBe(0);
    // ...and caller-visible knowledge stays at pre-call values (no phantom advance).
    expect(k.appliedUpto["d-p"] ?? 0).toBeLessThan(1);

    // Retry with a working mutate: must classify "applied" (not silent-loss
    // "duplicate") and produce exactly ONE row.
    const out = applyRemoteChange(db, makeChange(rec), k);
    expect(out).toBe("applied");
    expect((db.prepare("SELECT COUNT(*) c FROM changes").get() as { c: number }).c).toBe(1);
    expect(k.appliedUpto["d-p"]).toBe(1);
    db.close();
  });
});

describe("C3 sequence allocation survives compaction of own rows", () => {
  test("seq never reused after manual delete; device_clock never regresses", () => {
    const db = openDatabase({ path });
    const input = () => ({
      entity_id: "e-1",
      entity_type: "event" as const,
      field_path: "title",
      operation: "set" as const,
      payload: { value: "v" },
      hlc_now: () => Date.now(),
    });
    createLocalChange(db, "d-self", input()); // seq 1
    createLocalChange(db, "d-self", input()); // seq 2

    // Simulate post-compaction removal of own old rows while device_clock row
    // remains at 2.
    db.prepare("DELETE FROM changes WHERE device_id = 'd-self' AND local_seq <= 2").run();
    expect((db.prepare("SELECT MAX(local_seq) m FROM changes WHERE device_id='d-self'").get() as { m: number | null }).m).toBeNull();

    const r3 = createLocalChange(db, "d-self", input());
    expect(r3.local_seq).toBe(3); // NOT 1 — clock, not table max, is authoritative floor
    expect(r3.causality_clock["d-self"]).toBe(3);
    expect(r3.change_id).toBe("d-self:3");

    const storedClock = (
      db.prepare("SELECT max_seq m FROM device_clock WHERE peer_device_id = 'd-self'").get() as { m: number }
    ).m;
    expect(storedClock).toBeGreaterThanOrEqual(3);
    db.close();
  });

  test("device_clock upserts are element-wise MAX (stale writer cannot regress)", () => {
    const db = openDatabase({ path });
    db.prepare("INSERT INTO device_clock (peer_device_id, max_seq) VALUES ('d-p', 9)").run();
    // A stale peer advertises causality with d-p:4 — merge must keep 9.
    applyRemoteChange(
      db,
      makeChange({ device_id: "d-q", local_seq: 1, clock: { "d-q": 1, "d-p": 4 } }),
      emptyKnowledge(),
    );
    expect((db.prepare("SELECT max_seq m FROM device_clock WHERE peer_device_id='d-p'").get() as { m: number }).m).toBe(9);
    db.close();
  });
});

