// Session-start re-check of the quarantine table is an ALLOW-LIST: only
// unresolved rows with a retryable reason are re-run. Warnings, waiting
// notices and every resolved row are never re-run. All tests cross a session
// boundary: the database is closed and reopened and a fresh engine is built.
import { afterEach, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "better-sqlite3";
import {
  openDatabase,
  applyRemoteChangeDetailed,
  loadKnowledgeFromDb,
  quarantineRecord,
  markSeqSkipped,
  markQuarantineResolved,
  listQuarantine,
  dismissQuarantineWarning,
  deleteQuarantineByUser,
  DEPENDS_ON_QUARANTINED_REASON,
  DUPLICATE_DIFFERENT_CONTENT_REASON,
  WAITING_ON_CHANGE_REASON,
} from "../src/persistence/database.ts";
import { makeEntityMutator } from "../src/persistence/bridges/sync_service.ts";
import { createSyncEngine, retryQuarantineRecord } from "../src/sync/sync_engine.ts";
import type { ChangeRecord, VectorClock } from "../src/sync/change_record.ts";

const X = "dev-x", Y = "dev-y", P = "d-editor", T = "d-trusted";
const dirs: string[] = [];
const open: Database[] = [];
let lastPath = "";

function freshDb(): Database {
  const dir = mkdtempSync(join(tmpdir(), "tide-recheck-"));
  dirs.push(dir);
  lastPath = join(dir, "tide.db");
  const db = openDatabase({ path: lastPath });
  open.push(db);
  db.prepare("INSERT INTO calendars (calendar_id,title,color,created_hlc,updated_hlc) VALUES ('local','My Calendar',NULL,1,1)").run();
  return db;
}
/** End the session (close the DB), reopen it and build a fresh engine, as a real restart does. */
function newSession(db: Database): Database {
  const path = lastPath;
  db.close();
  const db2 = openDatabase({ path });
  open.push(db2);
  createSyncEngine({ db: db2, selfDeviceId: "dev-r", mutateEntity: makeEntityMutator() });
  return db2;
}
afterEach(() => {
  for (const db of open.splice(0)) { try { db.close(); } catch { /* closed */ } }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const ev = (t: string) => ({ title: t, description: "d", startMs: 1_800_000_000_000, endMs: 1_800_003_600_000, allDay: false });
function rec(device: string, seq: number, over: Partial<ChangeRecord>): ChangeRecord {
  return {
    change_id: `${device}:${seq}`, device_id: device, local_seq: seq, entity_id: "evt-x",
    entity_type: "event", field_path: "title", operation: "set",
    payload: { value: `v${device}${seq}` }, hlc_timestamp: 1_000 + seq,
    causality_clock: { [device]: seq } as VectorClock, schema_version: 1, ...over,
  } as ChangeRecord;
}
const createEv = (device: string, seq: number, id: string): ChangeRecord =>
  rec(device, seq, { entity_id: id, field_path: "event", payload: { value: ev("created") } });
const createY1 = createEv(Y, 1, "evt-x");
const x1 = createEv(X, 1, "evt-other");
const x2 = rec(X, 2, { payload: { value: "edit-by-X (kept copy)" }, causality_clock: { [X]: 2, [Y]: 1 } });
const x2b = { ...x2, payload: { value: "RESTORED-BACKUP copy" } } as ChangeRecord;

const apply = (db: Database, r: ChangeRecord) =>
  applyRemoteChangeDetailed(db, r, loadKnowledgeFromDb(db), makeEntityMutator());
const title = (db: Database, id: string): string | undefined =>
  (db.prepare("SELECT title FROM events WHERE event_id = ?").get(id) as { title: string } | undefined)?.title;
const inChanges = (db: Database, id: string): boolean =>
  db.prepare("SELECT 1 FROM changes WHERE change_id = ?").get(id) !== undefined;
const skipped = (db: Database) =>
  db.prepare("SELECT producer_device_id p, local_seq s FROM skipped_seqs ORDER BY 1, 2").all();
const storedPayload = (db: Database, id: string): string | null =>
  (db.prepare("SELECT payload FROM changes WHERE change_id = ?").get(id) as { payload: string } | undefined)?.payload ?? null;
type QRow = { quarantine_id: number; quarantine_reason: string; resolved_at_hlc: number | null; resolved_reason: string | null; raw_record: string };
const qrows = (db: Database) => listQuarantine(db) as QRow[];

// ---------------------------------------------------------------- a skip stays a skip

test("a skip stays a skip: a skipped dependent change whose prerequisite later applies is not applied by the next session", () => {
  let db = freshDb();
  // T:1 (a create) is rejected, so P:1 (edit citing T:1) is quarantined as depending on it.
  quarantineRecord(db, { reason: "invalid_change_record:synthetic", senderDeviceId: T, rawRecord: createEv(T, 1, "evt-x") });
  markSeqSkipped(db, T, 1);
  const edit = rec(P, 1, { causality_clock: { [P]: 1, [T]: 1 } });
  expect(apply(db, edit)).toBe("quarantined");
  const dep = qrows(db).find((r) => r.quarantine_reason === DEPENDS_ON_QUARANTINED_REASON)!;
  // the user skips the dependent change
  deleteQuarantineByUser(db, dep.quarantine_id, { confirm: true });
  expect(skipped(db)).toContainEqual({ p: P, s: 1 });
  // the prerequisite is then retried and applies (the evt-x row now exists)
  const tRow = qrows(db).find((r) => r.quarantine_reason === "invalid_change_record:synthetic")!;
  expect(retryQuarantineRecord(db, tRow.quarantine_id, makeEntityMutator()).resolved).toBe(true);
  expect(title(db, "evt-x")).toBe("created");
  const before = skipped(db);
  // new session
  db = newSession(db);
  expect(skipped(db), "the skipped seq stays skipped").toEqual(before);
  expect(skipped(db)).toContainEqual({ p: P, s: 1 });
  expect(inChanges(db, `${P}:1`), "the skipped change is not applied").toBe(false);
  expect(title(db, "evt-x"), "entity untouched by the skipped change").toBe("created");
  const after = qrows(db).find((r) => r.quarantine_id === dep.quarantine_id)!;
  expect(after.resolved_reason).toBe("user_deleted");
  expect(after.resolved_at_hlc).not.toBeNull();
});

// ---------------------------------------------------------------- duplicate-content warning across a session

function heldKeptCopyWithWarning(db: Database): number {
  // x2 is held (its create from Y is not in), the other copy x2b raises a warning row
  apply(db, x2);
  apply(db, x2b);
  apply(db, x1);
  const w = qrows(db).find((r) => r.quarantine_reason === DUPLICATE_DIFFERENT_CONTENT_REASON);
  expect(w, "a warning row exists").toBeDefined();
  return w!.quarantine_id;
}

test("P1a: kept copy held, new session, then the create arrives: the real edit applies (not skipped, not lost)", () => {
  let db = freshDb();
  heldKeptCopyWithWarning(db);
  db = newSession(db);
  expect(skipped(db).filter((s) => (s as { p: string }).p === X), "no seq of X skipped by the new session").toEqual([]);
  expect(apply(db, createY1)).toBe("applied");
  apply(db, x2); // the held change is re-delivered, as a real session does
  expect(title(db, "evt-x")).toBe("edit-by-X (kept copy)");
  expect(JSON.parse(storedPayload(db, `${X}:2`)!).value).toBe("edit-by-X (kept copy)");
  expect(skipped(db).filter((s) => (s as { p: string }).p === X)).toEqual([]);
});

test("P1b: the create arrives before the next session: after it the real edit stands, never the backup copy", () => {
  let db = freshDb();
  heldKeptCopyWithWarning(db);
  expect(apply(db, createY1)).toBe("applied");
  db = newSession(db);
  apply(db, x2); // re-delivery of the real change
  expect(title(db, "evt-x")).toBe("edit-by-X (kept copy)");
  expect(JSON.parse(storedPayload(db, `${X}:2`)!).value, "stored row is the real copy").toBe("edit-by-X (kept copy)");
});

test("P2: dismiss while the kept copy is held, create arrives, new session: the real edit stands and the warning stays dismissed", () => {
  let db = freshDb();
  const wid = heldKeptCopyWithWarning(db);
  expect(dismissQuarantineWarning(db, wid)).toEqual({ ok: true });
  expect(apply(db, createY1)).toBe("applied");
  db = newSession(db);
  apply(db, x2);
  expect(title(db, "evt-x")).toBe("edit-by-X (kept copy)");
  expect(JSON.parse(storedPayload(db, `${X}:2`)!).value).toBe("edit-by-X (kept copy)");
  const w = qrows(db).find((r) => r.quarantine_id === wid)!;
  expect(w.resolved_reason).toBe("dismissed_by_user");
  expect(w.resolved_at_hlc).not.toBeNull();
});

// ---------------------------------------------------------------- resolved rows are never re-checked

test("a resolved row is never re-checked: resolved rows of every reason are not re-run by a new session", () => {
  let db = freshDb();
  const reasons = ["user_deleted", "dismissed_by_user", "revalidated_on_restart", "retried_by_user", "some_future_reason"];
  const reasonsUnderTest = ["invalid_change_record:synthetic", DEPENDS_ON_QUARANTINED_REASON, DUPLICATE_DIFFERENT_CONTENT_REASON, WAITING_ON_CHANGE_REASON];
  const ids: number[] = [];
  let n = 0;
  for (const reason of reasonsUnderTest) {
    for (const rr of reasons) {
      n++;
      // a perfectly valid, applicable create: if a new session re-ran the row it would apply
      const r = createEv(`d-r${n}`, 1, `evt-r${n}`);
      const id = quarantineRecord(db, { reason, senderDeviceId: `d-r${n}`, rawRecord: r }) as unknown as number;
      ids.push(id);
    }
  }
  const all = qrows(db);
  expect(all).toHaveLength(reasonsUnderTest.length * reasons.length);
  // resolve every row; seq skip rows for non-warning rows, as the skip path leaves them
  all.forEach((row, i) => {
    markQuarantineResolved(db, row.quarantine_id, reasons[i % reasons.length]!);
    if (row.quarantine_reason !== DUPLICATE_DIFFERENT_CONTENT_REASON && row.quarantine_reason !== WAITING_ON_CHANGE_REASON) {
      const raw = JSON.parse(row.raw_record) as { device_id: string; local_seq: number };
      markSeqSkipped(db, raw.device_id, raw.local_seq);
    }
  });
  const skipsBefore = skipped(db);
  const changesBefore = db.prepare("SELECT change_id FROM changes ORDER BY change_id").all();
  const rowsBefore = qrows(db).map((r) => ({ ...r }));
  db = newSession(db);
  expect(db.prepare("SELECT count(*) c FROM events WHERE event_id LIKE 'evt-r%'").get()).toEqual({ c: 0 });
  expect(skipped(db)).toEqual(skipsBefore);
  expect(db.prepare("SELECT change_id FROM changes ORDER BY change_id").all()).toEqual(changesBefore);
  const rowsAfter = qrows(db);
  expect(rowsAfter.map((r) => [r.quarantine_id, r.quarantine_reason, r.resolved_reason])).toEqual(
    rowsBefore.map((r) => [r.quarantine_id, r.quarantine_reason, r.resolved_reason]),
  );
});

// ---------------------------------------------------------------- unresolved retryable rows are still re-checked

test("an unresolved invalid-record row that is now valid is still revalidated by a new session", () => {
  let db = freshDb();
  const good = createEv(T, 1, "evt-ok");
  quarantineRecord(db, { reason: "invalid_change_record:synthetic", senderDeviceId: T, rawRecord: good });
  markSeqSkipped(db, T, 1);
  db = newSession(db);
  expect(title(db, "evt-ok")).toBe("created");
  expect(qrows(db)[0]!.resolved_reason).toBe("revalidated_on_restart");
});

test("a non-retryable unresolved row (unknown reason) is not re-run by a new session", () => {
  let db = freshDb();
  quarantineRecord(db, { reason: "some_future_reason", senderDeviceId: T, rawRecord: createEv(T, 1, "evt-f") });
  markSeqSkipped(db, T, 1);
  db = newSession(db);
  expect(title(db, "evt-f")).toBeUndefined();
  expect(skipped(db)).toContainEqual({ p: T, s: 1 });
});
