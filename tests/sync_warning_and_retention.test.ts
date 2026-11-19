// Dismiss of a duplicate-content warning, Retry notes, retention-cap
// exemptions, calendar changes under the prerequisite rule, and the
// re-request of held changes in real sessions.
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
  deleteQuarantineByUser,
  dismissQuarantineWarning,
  pruneResolvedQuarantine,
  DUPLICATE_DIFFERENT_CONTENT_REASON,
} from "../src/persistence/database.ts";
import { makeEntityMutator } from "../src/persistence/bridges/sync_service.ts";
import { retryQuarantineRecord } from "../src/sync/sync_engine.ts";
import type { ChangeRecord, VectorClock } from "../src/sync/change_record.ts";
import { makeDevice, sessionOnce, guardProcess, type Device } from "./probes/sync_probe_helpers.ts";
import { retryNote, resolvedHint } from "../frontend/sync_errors.ts";

guardProcess();
const T = "d-t", P = "d-p", X = "d-x";
const dbs: Array<{ db: Database; dir: string }> = [];
const devs: Device[] = [];
function freshDb(): Database {
  const dir = mkdtempSync(join(tmpdir(), "tide-warn-"));
  const db = openDatabase({ path: join(dir, "tide.db") });
  dbs.push({ db, dir });
  db.prepare("INSERT INTO calendars (calendar_id,title,color,created_hlc,updated_hlc) VALUES ('local','My Calendar',NULL,1,1)").run();
  return db;
}
function dev(tag: string): Device {
  const d = makeDevice(tag);
  devs.push(d);
  return d;
}
afterEach(() => {
  for (const { db, dir } of dbs.splice(0)) {
    try { db.close(); } catch { /* closed */ }
    rmSync(dir, { recursive: true, force: true });
  }
  for (const d of devs.splice(0)) {
    try { d.db.close(); } catch { /* closed */ }
    try { rmSync(d.dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});
const rec = (device: string, seq: number, over: Partial<ChangeRecord>): ChangeRecord =>
  ({
    change_id: `${device}:${seq}`, device_id: device, local_seq: seq, entity_id: "evt-x",
    entity_type: "event", field_path: "title", operation: "set",
    payload: { value: `v${device}${seq}` }, hlc_timestamp: 1_000 + seq,
    causality_clock: { [device]: seq } as VectorClock, schema_version: 1, ...over,
  }) as ChangeRecord;
const evCreate = (device: string, seq: number, id: string, title: string): ChangeRecord =>
  rec(device, seq, {
    entity_id: id, field_path: "event",
    payload: { value: { id, title, description: "", startMs: 1_800_000_000_000, endMs: 1_800_003_600_000, allDay: false } },
  });
const apply = (db: Database, r: ChangeRecord) =>
  applyRemoteChangeDetailed(db, r, loadKnowledgeFromDb(db), makeEntityMutator());
const title = (db: Database, id: string): string | undefined =>
  (db.prepare("SELECT title FROM events WHERE event_id = ?").get(id) as { title: string } | undefined)?.title;
type QRow = { quarantine_id: number; quarantine_reason: string; resolved_at_hlc: number | null; resolved_reason: string | null };
const qrows = (db: Database) => listQuarantine(db, { limit: 10_000 }) as QRow[];
const count = (db: Database, table: string): number =>
  (db.prepare(`SELECT COUNT(*) c FROM ${table}`).get() as { c: number }).c;
const ev = (t: string) => ({ title: t, description: "d", startMs: 1_800_000_000_000, endMs: 1_800_003_600_000, allDay: false });

// ---------------------------------------------------------------- dismiss

function bufferedWarning(db: Database) {
  const c1 = evCreate(X, 1, "evt-1", "one");
  const c2 = evCreate(X, 2, "evt-2", "two-original");
  const c2b = evCreate(X, 2, "evt-2", "two-RESTORED");
  expect(apply(db, c2)).toBe("buffered"); // seq 2 waits for seq 1
  expect(apply(db, c2b)).toBe("duplicate_different_content");
  const w = qrows(db).find((r) => r.quarantine_reason === DUPLICATE_DIFFERENT_CONTENT_REASON)!;
  return { c1, w };
}

test("dismissing a warning while the kept copy is still buffered: the copy is still applied when its predecessor arrives", () => {
  const db = freshDb();
  const { c1, w } = bufferedWarning(db);
  dismissQuarantineWarning(db, w.quarantine_id);
  expect(count(db, "skipped_seqs"), "no skip row").toBe(0);
  expect(count(db, "pending_changes"), "buffered copy untouched").toBe(1);
  expect(apply(db, c1)).toBe("applied");
  expect(title(db, "evt-2")).toBe("two-original");
  expect(db.prepare("SELECT 1 FROM changes WHERE change_id = ?").get(`${X}:2`)).toBeTruthy();
  const after = qrows(db).find((r) => r.quarantine_id === w.quarantine_id)!;
  expect(after.resolved_reason).toBe("dismissed_by_user");
});

test("dismiss touches nothing but the warning row; a warning can never reach the skip path", () => {
  const db = freshDb();
  const { w } = bufferedWarning(db);
  const tables = ["skipped_seqs", "pending_changes", "changes", "applied_upto", "held_changes", "device_clock"];
  const before = tables.map((t) => JSON.stringify(db.prepare(`SELECT * FROM ${t}`).all()));
  dismissQuarantineWarning(db, w.quarantine_id);
  dismissQuarantineWarning(db, w.quarantine_id); // idempotent
  expect(tables.map((t) => JSON.stringify(db.prepare(`SELECT * FROM ${t}`).all()))).toEqual(before);
  expect(() => deleteQuarantineByUser(db, w.quarantine_id, { confirm: true })).toThrow(/warning cannot be skipped/);
  expect(count(db, "skipped_seqs")).toBe(0);
  // only warnings can be dismissed
  quarantineRecord(db, { reason: "invalid_change_record:synthetic", senderDeviceId: T, rawRecord: rec(T, 1, {}) });
  const other = qrows(db).find((r) => r.quarantine_reason === "invalid_change_record:synthetic")!;
  expect(() => dismissQuarantineWarning(db, other.quarantine_id)).toThrow(/only a duplicate-content warning/);
});

// ---------------------------------------------------------------- retry

test("Retry on a duplicate-content warning is an honest no-op", () => {
  const db = freshDb();
  db.prepare("INSERT INTO events (event_id, calendar_id, title, description, all_day, start_wall, end_wall, tz_id, utc_start_ms, utc_end_ms, created_hlc, updated_hlc) VALUES ('evt-x','local','t','',0,'09:00:00','10:00:00','UTC',1800000000000,1800003600000,1,1)").run();
  const r = rec(T, 1, {});
  expect(apply(db, r)).toBe("applied");
  expect(apply(db, { ...r, payload: { value: "RESTORED" } })).toBe("duplicate_different_content");
  const row = qrows(db).find((q) => q.quarantine_reason === DUPLICATE_DIFFERENT_CONTENT_REASON)!;
  const res = retryQuarantineRecord(db, row.quarantine_id, makeEntityMutator());
  expect(res.resolved).toBe(false);
  const after = qrows(db).find((q) => q.quarantine_id === row.quarantine_id)!;
  expect(after.resolved_at_hlc, "row stays active").toBeNull();
  expect(count(db, "skipped_seqs")).toBe(0);
});

test("Retry result texts: never claims an apply that did not happen; a waiting row says it is still waiting", () => {
  expect(retryNote("applied", "invalid_change_record:x")).toBe("Applied.");
  expect(retryNote("failed", "waiting_on_change")).toBe("Still waiting for the missing change.");
  expect(retryNote("failed", "depends_on_quarantined_change")).toMatch(/still set aside/);
  expect(retryNote("failed", "invalid_change_record:x")).toMatch(/Still invalid/);
  expect(resolvedHint("dismissed_by_user", DUPLICATE_DIFFERENT_CONTENT_REASON)).toMatch(/dismissed by you/);
  expect(resolvedHint("retried_by_user", "invalid_change_record:x")).toBe("applied after you clicked Retry");
});

// ---------------------------------------------------------------- calendar under the one rule

const calChange = (device: string, seq: number, id: string, field: "title" | "color", value: string, clock: VectorClock) =>
  rec(device, seq, { entity_type: "calendar", entity_id: id, field_path: field, payload: { value }, causality_clock: clock });

test("a calendar rename whose create was quarantined is quarantined, not turned into a create", () => {
  const db = freshDb();
  const create = calChange(T, 1, "cal-2", "title", "Work", { [T]: 1 });
  quarantineRecord(db, { reason: "invalid_change_record:synthetic", senderDeviceId: T, rawRecord: create });
  markSeqSkipped(db, T, 1);
  expect(apply(db, calChange(P, 1, "cal-2", "title", "Work renamed", { [P]: 1, [T]: 1 }))).toBe("quarantined");
  expect(apply(db, calChange(P, 2, "cal-3", "color", "#fff", { [P]: 2, [T]: 1 }))).toBe("quarantined");
  expect(db.prepare("SELECT COUNT(*) c FROM calendars WHERE calendar_id IN ('cal-2','cal-3')").get()).toEqual({ c: 0 });
  expect(qrows(db).filter((r) => r.quarantine_reason === "depends_on_quarantined_change")).toHaveLength(2);
});

test("a legitimate calendar create still applies, also when its own origin has an unrelated earlier quarantined change", () => {
  const db = freshDb();
  quarantineRecord(db, { reason: "invalid_change_record:synthetic", senderDeviceId: P, rawRecord: rec(P, 1, {}) });
  markSeqSkipped(db, P, 1);
  expect(apply(db, calChange(P, 2, "cal-new", "title", "Work", { [P]: 2 }))).toBe("applied");
  expect((db.prepare("SELECT title FROM calendars WHERE calendar_id = 'cal-new'").get() as { title: string }).title).toBe("Work");
});

// ---------------------------------------------------------------- retention cap

test("the retention cap spares user-skip records and rejection proofs; the decision does not flip once the cap is exceeded", () => {
  const db = freshDb();
  // T:1 is rejected (quarantined + skipped); T:2 applies, so the frontier passes the skipped seq
  quarantineRecord(db, { reason: "invalid_change_record:synthetic", senderDeviceId: T, rawRecord: { ...evCreate(T, 1, "evt-x", "created"), operation: "bogus" } });
  markSeqSkipped(db, T, 1);
  expect(apply(db, evCreate(T, 2, "evt-9", "n"))).toBe("applied");
  expect(count(db, "skipped_seqs")).toBe(0);
  const proof = qrows(db).find((r) => r.quarantine_reason === "invalid_change_record:synthetic")!;
  markQuarantineResolved(db, proof.quarantine_id, "retried_by_user"); // resolved without ever applying
  // a user skip record
  quarantineRecord(db, { reason: "invalid_change_record:synthetic", senderDeviceId: Q(), rawRecord: rec(Q(), 1, {}) });
  const skipRow = qrows(db).find((r) => r.resolved_at_hlc === null)!;
  deleteQuarantineByUser(db, skipRow.quarantine_id, { confirm: true });
  // plenty of prunable resolved rows (changes applied) beyond the cap
  for (let i = 0; i < 12; i++) {
    quarantineRecord(db, { reason: "invalid_change_record:synthetic", senderDeviceId: "d-n", rawRecord: rec("d-n", i + 1, {}) });
  }
  for (const r of qrows(db).filter((q) => q.resolved_at_hlc === null)) markQuarantineResolved(db, r.quarantine_id, "revalidated_on_restart");
  const pruned = pruneResolvedQuarantine(db, 3);
  expect(pruned).toBeGreaterThan(0);
  const left = qrows(db);
  expect(left.some((r) => r.quarantine_id === proof.quarantine_id), "rejection proof survives").toBe(true);
  expect(left.some((r) => r.quarantine_id === skipRow.quarantine_id), "user-skip record survives").toBe(true);
  // the decision does not flip from quarantined to counted done
  expect(apply(db, rec(P, 1, { causality_clock: { [P]: 1, [T]: 2 } }))).toBe("quarantined");
});
function Q(): string { return "d-q"; }

// ---------------------------------------------------------------- real sessions re-request a held change

test("real session: an edit that reaches C before its create is held, then applied in the same session", async () => {
  let withHold = 0;
  for (let i = 0; i < 12 && withHold < 2; i++) {
    const a = dev("A"), b = dev("B"), c = dev("C");
    await sessionOnce(a, b);
    const e = a.core.createEvent(ev("orig"));
    await sessionOnce(a, b);
    b.core.updateEvent(e.id, ev("edit-B"));
    const r = await sessionOnce(b, c);
    if ((r.toStats.receivedNotApplicableYet ?? 0) > 0) withHold++;
    expect((c.db.prepare("SELECT title FROM events WHERE event_id = ?").get(e.id) as { title: string }).title).toBe("edit-B");
  }
});

test("real session: a held change whose create was lost in transit is re-requested and applied in the next session", async () => {
  const a = dev("A"), b = dev("B"), c = dev("C");
  await sessionOnce(a, b);
  const e = a.core.createEvent(ev("orig"));
  await sessionOnce(a, b);
  b.core.updateEvent(e.id, ev("edit-B"));
  const aId = a.identity.deviceId;
  await sessionOnce(b, c, {
    filter: (m: unknown) => {
      const x = m as { type?: string; changes?: Array<{ device_id: string }> };
      if (x?.type === "CHANGES_BATCH" && x.changes) x.changes = x.changes.filter((ch) => ch.device_id !== aId);
      return true;
    },
  });
  await sessionOnce(b, c);
  expect((c.db.prepare("SELECT title FROM events WHERE event_id = ?").get(e.id) as { title: string }).title).toBe("edit-B");
});
