// The "waiting on a change" notice counts sessions in which a change was still
// held at session end. The count is stored in the database (held_changes) and
// must survive a restart; entries are removed when the change applies, is
// counted done, is quarantined or is skipped.
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "better-sqlite3";
import {
  openDatabase,
  listQuarantine,
  markSeqSkipped,
  deleteQuarantineByUser,
  WAITING_ON_CHANGE_REASON,
} from "../src/persistence/database.ts";
import { makeEntityMutator } from "../src/persistence/bridges/sync_service.ts";
import { createSyncEngine, HELD_SESSIONS_BEFORE_NOTICE } from "../src/sync/sync_engine.ts";
import type { SyncMessage, SyncTransport } from "../src/sync/sync_engine.ts";
import type { ChangeRecord } from "../src/sync/change_record.ts";
import { resolvedHint, humanReason } from "../frontend/sync_errors.ts";

const SELF = "d-self", P = "d-editor", GHOST = "d-ghost";
let dir: string;
let dbPath: string;
let db: Database;
let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tide-held-"));
  dbPath = join(dir, "tide.db");
  db = openDatabase({ path: dbPath });
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  warn.mockRestore();
  try { db.close(); } catch { /* closed */ }
  rmSync(dir, { recursive: true, force: true });
});

/** An edit of an event that does not exist here, citing a change (GHOST:5) that never arrives. */
const heldEdit = (seq = 1): ChangeRecord => ({
  change_id: `${P}:${seq}`, device_id: P, local_seq: seq, entity_id: "evt-x", entity_type: "event",
  field_path: "title", operation: "set", payload: { value: "edit" }, hlc_timestamp: 1_000 + seq,
  causality_clock: { [P]: seq, [GHOST]: 5 }, schema_version: 1,
} as ChangeRecord);

function peer(records: ChangeRecord[], clock: Record<string, number>): SyncTransport {
  const queue: SyncMessage[] = [{ v: 1, type: "HELLO", device_clock: clock }];
  return {
    async send(m: SyncMessage) {
      if (m.type === "CHANGES_REQUEST") queue.push({ v: 1, type: "CHANGES_BATCH", changes: records });
      if (m.type === "CHANGES_ACK") queue.push({ v: 1, type: "CHANGES_ACK", applied_upto: {} });
    },
    async receive() { return queue.shift() ?? null; },
  };
}
const session = (records: ChangeRecord[] = [heldEdit()]) =>
  createSyncEngine({ db, selfDeviceId: SELF, mutateEntity: makeEntityMutator(), peerDeviceId: P })
    .runSession(peer(records, { [P]: records.length === 0 ? 0 : records[records.length - 1]!.local_seq }));
const notices = () =>
  (listQuarantine(db) as Array<{ quarantine_reason: string; resolved_at_hlc: number | null }>).filter(
    (r) => r.quarantine_reason === WAITING_ON_CHANGE_REASON,
  );
const heldRows = () => db.prepare("SELECT * FROM held_changes").all() as Array<{ sessions_held: number; first_held_at: number }>;
function restart(): void {
  db.close();
  db = openDatabase({ path: dbPath });
}

test("the hold count survives a restart: 2 sessions, restart, 1 more session -> the notice appears", async () => {
  for (let i = 1; i < HELD_SESSIONS_BEFORE_NOTICE; i++) {
    await session();
    expect(notices(), `no notice after ${i} session(s)`).toHaveLength(0);
  }
  expect(heldRows()[0]!.sessions_held).toBe(HELD_SESSIONS_BEFORE_NOTICE - 1);
  restart();
  expect(heldRows()[0]!.sessions_held, "persisted across the restart").toBe(HELD_SESSIONS_BEFORE_NOTICE - 1);
  await session();
  expect(notices()).toHaveLength(1);
  expect(notices()[0]!.resolved_at_hlc).toBeNull();
});

test("no notice after only (threshold - 1) sessions spread across a restart", async () => {
  await session();
  restart();
  for (let i = 2; i < HELD_SESSIONS_BEFORE_NOTICE; i++) await session();
  expect(notices()).toHaveLength(0);
  expect(heldRows()[0]!.sessions_held).toBe(HELD_SESSIONS_BEFORE_NOTICE - 1);
});

test("entries are removed when the change applies (no stale entries)", async () => {
  await session();
  expect(heldRows()).toHaveLength(1);
  // the missing change arrives: the held edit now counts done (target gone, all prerequisites in)
  db.prepare("INSERT INTO applied_upto (producer_device_id, applied_through) VALUES (?, 5)").run(GHOST);
  await session();
  expect(heldRows()).toHaveLength(0);
  expect(db.prepare("SELECT 1 FROM changes WHERE change_id = ?").get(`${P}:1`)).toBeTruthy();
});

test("entries are removed when the change is skipped", async () => {
  await session();
  expect(heldRows()).toHaveLength(1);
  markSeqSkipped(db, P, 1);
  expect(heldRows()).toHaveLength(0);
});

test("skipping a waiting notice: the seq is skipped, the counter is cleared, the skip is logged and stays visible as resolved; later changes apply", async () => {
  for (let i = 0; i < HELD_SESSIONS_BEFORE_NOTICE; i++) await session();
  const notice = (listQuarantine(db) as Array<{ quarantine_id: number; quarantine_reason: string }>).find(
    (r) => r.quarantine_reason === WAITING_ON_CHANGE_REASON,
  )!;
  warn.mockClear();
  deleteQuarantineByUser(db, notice.quarantine_id, { confirm: true });
  expect(warn.mock.calls.some((c) => String(c[0]).includes(`${P}#1 skipped on this device by the user`)), "stderr line").toBe(true);
  const row = (listQuarantine(db) as Array<{ quarantine_id: number; resolved_at_hlc: number | null; resolved_reason: string | null }>).find(
    (r) => r.quarantine_id === notice.quarantine_id,
  )!;
  expect(row.resolved_at_hlc).not.toBeNull();
  expect(row.resolved_reason).toBe("user_deleted");
  expect(resolvedHint(row.resolved_reason, WAITING_ON_CHANGE_REASON)).toMatch(/skipped on this device by you/);
  expect(db.prepare("SELECT 1 FROM skipped_seqs WHERE producer_device_id = ? AND local_seq = 1").get(P)).toBeTruthy();
  expect(heldRows()).toHaveLength(0);
  expect(humanReason(WAITING_ON_CHANGE_REASON)).not.toBe(WAITING_ON_CHANGE_REASON);
  // the stream carries on: the next change of the origin applies
  const later = { ...heldEdit(2), entity_id: "evt-y", causality_clock: { [P]: 2 } } as ChangeRecord;
  await session([later]);
  expect(db.prepare("SELECT applied_through v FROM applied_upto WHERE producer_device_id = ?").get(P)).toEqual({ v: 2 });
});

test("dismissing a duplicate-content warning is a dismissal, not a skip, and reads that way", () => {
  expect(resolvedHint("user_deleted", "duplicate_seq_different_content")).toMatch(/dismissed by you/);
  expect(resolvedHint("user_deleted", "invalid_change_record:synthetic")).toMatch(/skipped on this device by you/);
});

test("schema version 11: a v10 database gets held_changes on open (forward migration), and the == current version repair restores a missing table", () => {
  db.exec("DROP TABLE held_changes");
  db.prepare("UPDATE schema_version SET version = 10").run();
  restart();
  expect((db.prepare("SELECT version FROM schema_version").get() as { version: number }).version).toBe(11);
  expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'held_changes'").get()).toBeTruthy();
  db.exec("DROP TABLE held_changes"); // stamped 11 but the table is missing
  restart();
  expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'held_changes'").get()).toBeTruthy();
});
