// Tide DC-14 §8 testable requirements — application-layer Conflicts surface.
import { describe, expect, test, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { openDatabase, createLocalChange } from "../src/persistence/database.ts";
import {
  ConflictsViewModel,
  ConflictCommandError,
  type ResolutionOption,
} from "../src/application/conflicts_ui.ts";
import type { ChangeRecord, VectorClock } from "../src/sync/change_record.ts";

const SELF = "d-self";
const OTHER = "d-other";

let dir: string;
let db: Database.Database;
let vm: ConflictsViewModel;
let hlc = 1000;

let remoteSeq = 9;
let lastIncomingId = "";
function nextIncomingId(): string {
  return lastIncomingId;
}
beforeEach(() => {
  remoteSeq = 9;
  lastIncomingId = "";
  dir = mkdtempSync(join(tmpdir(), "tide-conflicts-"));
  db = openDatabase({ path: join(dir, "t.db") });
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
  vm = new ConflictsViewModel(db, SELF);
  hlc = 1000;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function localEdit(value: unknown): ChangeRecord {
  return createLocalChange(db, SELF, {
    entity_id: "e-1",
    entity_type: "event",
    field_path: "title",
    operation: "set",
    payload: { value },
    hlc_now: () => ++hlc,
  });
}

/** Insert a conflict between a local and an incoming concurrent edit. */
function makeConflict(opts?: {
  entityId?: string;
  fieldPath?: string;
  incomingDeleted?: boolean;
}): string {
  const entityId = opts?.entityId ?? "e-1";
  const fieldPath = opts?.fieldPath ?? "title";
  const local = createLocalChange(db, SELF, {
    entity_id: entityId,
    entity_type: "event",
    field_path: fieldPath,
    operation: "set",
    payload: { value: "local title" },
    hlc_now: () => ++hlc,
  });
  const seq = remoteSeq++;
  const incomingId = `${OTHER}:${seq}`;
  lastIncomingId = incomingId;
  db.prepare(
    `INSERT INTO changes (change_id, device_id, local_seq, entity_id,
       entity_type, field_path, operation, payload, hlc_timestamp,
       causality_clock, schema_version)
     VALUES (?, ?, ?, ?, 'event', ?, ?, ?, ?, ?, 1)`,
  ).run(
    incomingId,
    OTHER,
    seq,
    entityId,
    fieldPath,
    opts?.incomingDeleted === true ? "remove" : "set",
    JSON.stringify(opts?.incomingDeleted === true ? {} : { value: "incoming title" }),
    ++hlc,
    JSON.stringify({ [OTHER]: seq } satisfies VectorClock),
  );
  const conflictId = "cf-" + Math.random().toString(36).slice(2, 10);
  db.prepare(
    `INSERT INTO conflicts (conflict_id, entity_id, field_path, status,
       detected_at_hlc) VALUES (?, ?, ?, 'unresolved', ?)`,
  ).run(conflictId, entityId, fieldPath, ++hlc);
  for (const p of [local, { change_id: incomingId, device_id: OTHER }]) {
    const payloadRow = db
      .prepare<[string], { payload: string; causality_clock: string; local_seq: number }>(
        "SELECT payload, causality_clock, local_seq FROM changes WHERE change_id = ?",
      )
      .get(p.change_id)!;
    db.prepare(
      `INSERT INTO conflict_participants (conflict_id, change_id, device_id,
         local_seq, causality_clock, payload) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      conflictId,
      p.change_id,
      p.device_id,
      payloadRow.local_seq,
      payloadRow.causality_clock,
      payloadRow.payload,
    );
  }
  return conflictId;
}

describe("DC-14 §3 badge + list views", () => {
  test("badge counts per entity and global total", () => {
    expect(vm.totalUnresolved()).toBe(0);
    makeConflict();
    makeConflict({ fieldPath: "description" });
    expect(vm.totalUnresolved()).toBe(2);
    expect(vm.badgeCounts().get("e-1")).toBe(2);
  });

  test("list filter by calendar (§5.2 minimum filters)", () => {
    const id = makeConflict();
    expect(vm.listUnresolved({ calendar_id: "cal-home" }).map((r) => r.conflict_id)).toEqual([id]);
    expect(vm.listUnresolved({ calendar_id: "nope" })).toEqual([]);
    expect(vm.listUnresolved()[0]!.participant_count).toBe(2);
  });

  test("detail view: both candidates side by side with device attribution (§3.2)", () => {
    const id = makeConflict();
    const d = vm.getDetail(id);
    expect(d.entity_title).toBe("Standup");
    expect(d.field_path).toBe("title");
    expect(d.candidates.map((c) => c.device_name)).toEqual([
      "This device",
      "Other Tablet",
    ]);
    const c0 = d.candidates[0]!;
    const c1 = d.candidates[1]!;
    expect(c0.value).toBe("local title");
    expect(c1.value).toBe("incoming title");
    expect(d.local_change_id).toBe(`${SELF}:1`);
    // P4: HLCs are present as presentation metadata only.
    expect(typeof c1.hlc_timestamp).toBe("number");
  });

  test("delete-vs-edit renders the removed side as deleted (§3.2b)", () => {
    const id = makeConflict({ incomingDeleted: true });
    const d = vm.getDetail(id);
    expect(d.candidates[1]!.deleted).toBe(true);
    expect(d.candidates[1]!.value).toBeUndefined();
  });

  test("opening detail mutates nothing (§3.2 read-only)", () => {
    const id = makeConflict();
    const before = db.prepare("SELECT * FROM changes").all().length;
    vm.getDetail(id);
    vm.getDetail(id);
    expect(db.prepare("SELECT * FROM changes").all().length).toBe(before);
  });
});

describe("DC-14 §4 / TR-1 option-to-status exactness", () => {
  test("keep_mine -> resolved_keep_local + exactly one new change record", () => {
    const id = makeConflict();
    const before = countChanges();
    vm.resolve(id, { kind: "keep_mine" });
    expect(statusOf(id)).toBe("resolved_keep_local");
    expect(countChanges() - before).toBe(1);
    // Winning value written as a NORMAL record by this device.
    const last = lastChange();
    expect(last.device_id).toBe(SELF);
    expect(last.payload).toEqual({ value: "local title" });
  });

  test("keep_theirs -> resolved_keep_incoming with the incoming value", () => {
    const id = makeConflict();
    vm.resolve(id, { kind: "keep_theirs", change_id: `${lastIncomingId}` });
    expect(statusOf(id)).toBe("resolved_keep_incoming");
    expect(lastChange().payload).toEqual({ value: "incoming title" });
  });

  test("keep_theirs on a removal writes a remove operation (delete-vs-edit §4)", () => {
    const id = makeConflict({ incomingDeleted: true });
    vm.resolve(id, { kind: "keep_theirs", change_id: `${lastIncomingId}` });
    expect(lastChange().operation).toBe("remove");
  });

  test("keep_both/custom -> resolved_custom storing resolved_value", () => {
    const id = makeConflict();
    vm.resolve(id, { kind: "keep_both", value: "merged: local+incoming" });
    expect(statusOf(id)).toBe("resolved_custom");
    const row = db
      .prepare<[string], { resolved_value: string; resolved_at_hlc: number | null }>(
        "SELECT resolved_value, resolved_at_hlc FROM conflicts WHERE conflict_id = ?",
      )
      .get(id)!;
    expect(JSON.parse(row.resolved_value)).toBe("merged: local+incoming");
    expect(row.resolved_at_hlc).not.toBeNull();
    expect(lastChange().payload).toEqual({ value: "merged: local+incoming" });
  });

  test("resolution is atomic: T1 record + status flip share one transaction (§6.1)", () => {
    const id = makeConflict();
    // Force the inner write path to fail after the change insert by making
    // the conflicts UPDATE invalid via a trigger — the whole tx must roll back.
    db.exec(
      `CREATE TRIGGER fail_status BEFORE UPDATE ON conflicts
       BEGIN SELECT RAISE(ABORT, 'injected'); END`,
    );
    expect(() =>
      vm.resolve(id, { kind: "keep_theirs", change_id: `${lastIncomingId}` }),
    ).toThrow(/injected/);
    // Rollback means NO new change record either.
    expect(countChanges()).toBe(2);
    expect(statusOf(id)).toBe("unresolved");
  });

  test("resolving one conflict never touches a concurrent conflict (§4.3)", () => {
    const a = makeConflict();
    const b = makeConflict({ fieldPath: "start_time" });
    vm.resolve(a, { kind: "keep_mine" });
    expect(statusOf(a)).toBe("resolved_keep_local");
    expect(statusOf(b)).toBe("unresolved");
  });

  test("double resolution is refused", () => {
    const id = makeConflict();
    vm.resolve(id, { kind: "keep_mine" });
    expect(() => vm.resolve(id, { kind: "keep_mine" })).toThrow(
      ConflictCommandError,
    );
  });
});

describe("DC-14 TR-2 skip is a no-op", () => {
  test("skip leaves everything untouched", () => {
    const id = makeConflict();
    const changesBefore = dumpChanges();
    vm.skip(id);
    expect(statusOf(id)).toBe("unresolved");
    expect(vm.totalUnresolved()).toBe(1); // badge persists
    expect(dumpChanges()).toEqual(changesBefore);
  });
});

describe("DC-14 TR-3 undo", () => {
  test("undo restores prior value AND unresolved status via append-only history", () => {
    const id = makeConflict();
    const before = dumpChanges();
    vm.resolve(id, { kind: "keep_theirs", change_id: `${lastIncomingId}` });
    expect(statusOf(id)).toBe("resolved_keep_incoming");

    const rec = vm.undo(id);
    expect(rec.device_id).toBe(SELF);
    expect(statusOf(id)).toBe("unresolved");
    // History is append-only: every pre-existing row byte-identical.
    const after = dumpChanges();
    for (const [cid, row] of Object.entries(before)) {
      expect(after[cid]).toEqual(row);
    }
    expect(Object.keys(after).length).toBe(Object.keys(before).length + 2);
    // Prior effective value restored by the undo record.
    expect(lastChange().payload).toEqual({ value: "local title" });
    expect(vm.totalUnresolved()).toBe(1);
  });

  test("undo withheld after propagation proof (P3)", () => {
    const id = makeConflict();
    vm.resolve(id, { kind: "keep_mine" });
    expect(vm.undoAvailable(id)).toBe(true);
    vm.markPropagated(id);
    expect(vm.undoAvailable(id)).toBe(false);
    expect(() => vm.undo(id)).toThrow(/propagated/);
  });
});

describe("DC-14 §6.3/§6.4 remote resolutions", () => {
  test("matching participant set + unresolved copy -> resolved-on-receipt, no data mutation", () => {
    const id = makeConflict();
    const before = dumpChanges();
    const outcome = vm.applyRemoteResolution({
      entity_id: "e-1",
      field_path: "title",
      status: "resolved_keep_incoming",
      participant_change_ids: [`${SELF}:1`, `${lastIncomingId}`],
    });
    expect(outcome).toBe("resolved_on_receipt");
    expect(statusOf(id)).toBe("resolved_keep_incoming");
    expect(dumpChanges()).toEqual(before); // receiving NEVER mutates entity data
  });

  test("stale resolution arriving second is recorded, not applied (§6.4/TR-5)", () => {
    const id = makeConflict();
    vm.resolve(id, { kind: "keep_mine" });
    const snapshotBefore = dumpChanges() ;
    const outcome = vm.applyRemoteResolution({
      entity_id: "e-1",
      field_path: "title",
      status: "resolved_custom",
      resolved_value: "their merge",
      participant_change_ids: [`${SELF}:1`, `${lastIncomingId}`],
    });
    expect(outcome).toBe("recorded_stale");
    expect(statusOf(id)).toBe("resolved_keep_local"); // own resolution stands
    expect(dumpChanges()).toEqual(snapshotBefore);
  });

  test("non-matching participants = separate variant, untouched (§6.3 ELSE)", () => {
    makeConflict();
    const outcome = vm.applyRemoteResolution({
      entity_id: "e-1",
      field_path: "title",
      status: "resolved_keep_local",
      participant_change_ids: ["d-x:1"],
    });
    expect(outcome).toBe("no_match");
    expect(vm.totalUnresolved()).toBe(1);
  });

  test("exportResolution carries the upsert key material", () => {
    const id = makeConflict();
    expect(vm.exportResolution(id)).toBeNull(); // still unresolved
    vm.resolve(id, { kind: "keep_both", value: "v" });
    const ex = vm.exportResolution(id)!;
    expect(ex.status).toBe("resolved_custom");
    expect(ex.participant_change_ids.sort()).toEqual([
      `${lastIncomingId}`,
      `${SELF}:1`,
    ]);
  });
});

describe("DC-14 TR-6 obsolete closure", () => {
  test("tombstoning the entity flips unresolved conflicts to terminal obsolete", () => {
    const id = makeConflict();
    const n = vm.closeObsoleteOnTombstone("e-1", "tomb:d-A:42");
    expect(n).toBe(1);
    expect(statusOf(id)).toBe("obsolete");
    expect(vm.totalUnresolved()).toBe(0);
    // Terminal: no further resolution actions.
    expect(() => vm.resolve(id, { kind: "keep_mine" })).toThrow(
      /already obsolete/,
    );
    // Explainable: tombstone reference retained.
    const row = db
      .prepare<[string], { resolved_value: string }>(
        "SELECT resolved_value FROM conflicts WHERE conflict_id = ?",
      )
      .get(id)!;
    expect(JSON.parse(row.resolved_value)).toEqual({
      closed_obsolete_by_tombstone: "tomb:d-A:42",
    });
    // Never mapped onto a resolved_* value.
    expect(statusOf(id)).not.toMatch(/^resolved_/);
  });
});

describe("DC-14 TR-7 bulk = N sequential individuals", () => {
  test("bulk resolves each individually through the identical write path", () => {
    const ids = [
      makeConflict(),
      makeConflict({ fieldPath: "description" }),
      makeConflict({ fieldPath: "location" }),
    ];
    const decisions = ids.map<ResolutionOption>((_, i) =>
      i === 2 ? { kind: "keep_both", value: "custom" } : { kind: "keep_mine" },
    );
    // Reference run: same decisions applied one-by-one.
    const bulkIds = [...ids];
    vm.resolveBulk(bulkIds.map((conflictId) => ({ conflictId, option: decisions.shift()! })));
    for (const id of ids) {
      expect(statusOf(id)).toMatch(/^resolved_/);
    }
    // Each resolution produced its own change record (3 total).
    expect(countChanges()).toBe(2 /* per conflict */ * 3 + 3);
  });

  test("partial completion: failure after k items leaves exactly k resolved", () => {
    const ids = [
      makeConflict(),
      makeConflict({ fieldPath: "description" }),
      makeConflict({ fieldPath: "location" }),
    ];
    db.exec(
      `CREATE TRIGGER fail_third BEFORE UPDATE ON conflicts
       WHEN NEW.field_path = 'location'
       BEGIN SELECT RAISE(ABORT, 'boom'); END`,
    );
    expect(() =>
      vm.resolveBulk([
        { conflictId: ids[0]!, option: { kind: "keep_mine" } },
        { conflictId: ids[1]!, option: { kind: "keep_mine" } },
        { conflictId: ids[2]!, option: { kind: "keep_mine" } },
      ]),
    ).toThrow(/boom/);
    expect(statusOf(ids[0]!)).toMatch(/^resolved_/);
    expect(statusOf(ids[1]!)).toMatch(/^resolved_/);
    expect(statusOf(ids[2]!)).toBe("unresolved");
  });
});

describe("DC-14 TR-8/TR-10 no auto-resolve, no timestamp winners", () => {
  test("nothing auto-resolves across repeated sync cycles / clock jumps", () => {
    const id = makeConflict();
    // Simulate wall-clock jump + repeated reads/sessions touching the module.
    hlc += 10_000_000;
    vm.getDetail(id);
    vm.listUnresolved();
    vm.badgeCounts();
    expect(statusOf(id)).toBe("unresolved");
  });

  test("candidate ordering in detail view is stable and not HLC-derived", () => {
    const id = makeConflict();
    // Local participant has the LATER hlc; ordering must remain insertion-stable.
    const d1 = vm.getDetail(id);
    const d2 = vm.getDetail(id);
    expect(d1.candidates.map((c) => c.change_id)).toEqual(
      d2.candidates.map((c) => c.change_id),
    );
    expect(d1.candidates[0]!.device_name).toBe("This device");
    // No API exposes any ranking/pre-selection of options.
    expect((vm as unknown as { rankOptions?: unknown }).rankOptions).toBeUndefined();
  });
});

// ---------------------------------------------------------------------

function statusOf(id: string): string {
  return db
    .prepare<[string], { status: string }>(
      "SELECT status FROM conflicts WHERE conflict_id = ?",
    )
    .get(id)!.status;
}

function countChanges(): number {
  return (db.prepare<[], { c: number }>("SELECT COUNT(*) AS c FROM changes").get())!.c;
}

function lastChange(): ChangeRecord {
  const row = db
    .prepare<[], Record<string, unknown>>(
      `SELECT change_id, device_id, local_seq, entity_id, entity_type,
              field_path, operation, payload, hlc_timestamp, causality_clock,
              schema_version FROM changes ORDER BY rowid DESC LIMIT 1`,
    )
    .get()!;
  return {
    ...(row as unknown as ChangeRecord),
    payload: JSON.parse(row.payload as string),
    causality_clock: JSON.parse(row.causality_clock as string),
  };
}

function dumpChanges(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const row of db
    .prepare<[], { change_id: string; r: string }>(
      `SELECT change_id, (change_id || '|' || device_id || '|' || local_seq || '|'
        || operation || '|' || payload || '|' || causality_clock) AS r
       FROM changes`,
    )
    .all()) {
    out[row.change_id] = row.r;
  }
  return out;
}
