// ONE prerequisite rule for a change whose target row is absent.
//   need[d] = clock[d] (own origin: seq - 1); a removed device only up to its
//   effective cutoff. A seq counts as in when applied or skipped (quarantined).
//   1. a prerequisite not in            -> HOLD (not applicable yet)
//   2. all in, target absent, a prerequisite skipped/quarantined here
//                                       -> quarantine "depends_on_quarantined_change"
//   3. all in, target absent otherwise  -> COUNT AS DONE (history, no row)
// A target that exists applies as before; a create applies.
// Scenarios: create from a removed device in flight, unrelated quarantined edit,
// quarantined prerequisite and Retry, snapshots, a prerequisite from a removed
// device that never arrives, and the retry rule.
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
  listQuarantine,
  WAITING_ON_CHANGE_REASON,
  DEPENDS_ON_QUARANTINED_REASON,
  DUPLICATE_DIFFERENT_CONTENT_REASON,
} from "../src/persistence/database.ts";
import { makeEntityMutator } from "../src/persistence/bridges/sync_service.ts";
import {
  retryQuarantineRecord,
  revalidateQuarantine,
  HELD_SESSIONS_BEFORE_NOTICE,
} from "../src/sync/sync_engine.ts";
import type { ChangeRecord, VectorClock } from "../src/sync/change_record.ts";
import { buildSnapshot, applySnapshot } from "../src/sync/full_state.ts";
import { makeDevice, sessionOnce, guardProcess, type Device } from "./probes/sync_probe_helpers.ts";
import { seedEvent } from "./sync_seed_helpers.ts";
import { humanReason } from "../frontend/sync_errors.ts";

guardProcess();
const W = "d-removed", T = "d-trusted", P = "d-editor", Q = "d-other";
const dbs: Array<{ db: Database; dir: string }> = [];
const devs: Device[] = [];

function freshDb(cutoff?: number): Database {
  const dir = mkdtempSync(join(tmpdir(), "tide-prereq-"));
  const db = openDatabase({ path: join(dir, "tide.db") });
  dbs.push({ db, dir });
  db.prepare("INSERT INTO calendars (calendar_id,title,color,created_hlc,updated_hlc) VALUES ('local','My Calendar',NULL,1,1)").run();
  if (cutoff !== undefined) {
    db.prepare(
      `INSERT INTO revocation_records (revoked_device_id, revoked_by_device_id, revoked_at_hlc, record_bytes, signature, verification_state, received_at_hlc, revoked_after_seq)
       VALUES (?, 'd-revoker', 1, x'00', x'00', 'valid', 1, ?)`,
    ).run(W, cutoff);
  }
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

function rec(device: string, seq: number, over: Partial<ChangeRecord>): ChangeRecord {
  return {
    change_id: `${device}:${seq}`, device_id: device, local_seq: seq, entity_id: "evt-x",
    entity_type: "event", field_path: "title", operation: "set",
    payload: { value: `v${device}${seq}` }, hlc_timestamp: 1_000 + seq,
    causality_clock: { [device]: seq } as VectorClock, schema_version: 1, ...over,
  } as ChangeRecord;
}
const create = (device: string, seq: number, id: string, clock?: VectorClock): ChangeRecord =>
  rec(device, seq, {
    entity_id: id, field_path: "event",
    payload: { value: { id, title: "created", description: "", startMs: 1_800_000_000_000, endMs: 1_800_003_600_000, allDay: false } },
    causality_clock: clock ?? { [device]: seq },
  });
const apply = (db: Database, r: ChangeRecord) =>
  applyRemoteChangeDetailed(db, r, loadKnowledgeFromDb(db), makeEntityMutator());
const title = (db: Database, id: string): string | undefined =>
  (db.prepare("SELECT title FROM events WHERE event_id = ?").get(id) as { title: string } | undefined)?.title;
const frontier = (db: Database, d: string): number =>
  (db.prepare("SELECT applied_through v FROM applied_upto WHERE producer_device_id = ?").get(d) as { v: number } | undefined)?.v ?? 0;
const inChanges = (db: Database, id: string): boolean =>
  db.prepare("SELECT 1 FROM changes WHERE change_id = ?").get(id) !== undefined;
type QRow = { quarantine_id: number; quarantine_reason: string; sender_device_id: string; resolved_at_hlc: number | null; raw_record: string };
const qrows = (db: Database) => listQuarantine(db) as QRow[];
const ev = (t: string) => ({ title: t, description: "d", startMs: 1_800_000_000_000, endMs: 1_800_003_600_000, allDay: false });

// ---------------------------------------------------------------- step 1: hold

test("create still in flight from a trusted device (clock also cites a removed device above its cutoff): held, then applied", () => {
  const db = freshDb(1);
  const edit = rec(P, 1, { causality_clock: { [P]: 1, [W]: 3, [T]: 2 } });
  expect(apply(db, edit)).toBe("not_applicable");
  expect(qrows(db), "not quarantined").toHaveLength(0);
  expect(frontier(db, P), "read position held").toBe(0);
  expect(inChanges(db, `${P}:1`), "not stored").toBe(false);
  expect(apply(db, create(T, 1, "evt-other"))).toBe("applied");
  expect(apply(db, create(T, 2, "evt-x"))).toBe("applied");
  expect(apply(db, edit)).toBe("applied");
  expect(title(db, "evt-x")).toBe(`v${P}1`);
});

// Create from a removed device AT/BELOW the cutoff still in flight.
test("removed device's own seqs at/below the cutoff are prerequisites: both arrival orders converge", () => {
  const wCreate = create(W, 1, "evt-x");
  const w2 = create(W, 2, "evt-w2");
  const edit = rec(P, 1, { causality_clock: { [P]: 1, [W]: 3 } }); // need[W] = min(3, cutoff 2) = 2
  const X = freshDb(2);
  expect(apply(X, wCreate)).toBe("applied");
  expect(apply(X, edit), "target exists: applies").toBe("applied");
  const Y = freshDb(2);
  expect(apply(Y, edit)).toBe("not_applicable");
  expect(apply(Y, wCreate)).toBe("applied");
  expect(apply(X, w2)).toBe("applied");
  expect(apply(Y, w2)).toBe("applied");
  expect(apply(Y, edit), "now every prerequisite (W:1, W:2) is in").toBe("applied");
  expect(title(X, "evt-x")).toBe(`v${P}1`);
  expect(title(Y, "evt-x")).toBe(title(X, "evt-x"));
});

// An unrelated quarantined edit of the same entity must not capture a legit held edit.
test("unrelated quarantined edit of the same entity: legit edit is held, then applied; both orders converge", () => {
  const mk = () => {
    const db = freshDb();
    quarantineRecord(db, { reason: "invalid_change_record:synthetic", senderDeviceId: Q, rawRecord: { ...rec(Q, 1, { causality_clock: { [Q]: 1, [T]: 1 } }), operation: "bogus" } });
    markSeqSkipped(db, Q, 1);
    return db;
  };
  const tCreate = create(T, 1, "evt-x");
  const edit = rec(P, 1, { causality_clock: { [P]: 1, [T]: 1 } });
  const X = mk();
  expect([apply(X, tCreate), apply(X, edit)]).toEqual(["applied", "applied"]);
  const Y = mk();
  expect(apply(Y, edit)).toBe("not_applicable");
  expect(apply(Y, tCreate)).toBe("applied");
  expect(apply(Y, edit)).toBe("applied");
  expect(title(Y, "evt-x")).toBe(title(X, "evt-x"));
  expect(title(Y, "evt-x")).toBe(`v${P}1`);
  expect(qrows(Y).map((r) => r.quarantine_reason)).toEqual(["invalid_change_record:synthetic"]);
});

// ---------------------------------------------------------------- step 3(a) + D2 retry

test("quarantined prerequisite: a quarantined prerequisite quarantines the edit; Retry re-runs the rule and applies it for real once the prerequisite is applied", () => {
  const db = freshDb();
  quarantineRecord(db, { reason: "invalid_change_record:synthetic", senderDeviceId: T, rawRecord: create(T, 1, "evt-x") });
  markSeqSkipped(db, T, 1);
  const edit = rec(P, 1, { causality_clock: { [P]: 1, [T]: 1 } });
  expect(apply(db, edit)).toBe("quarantined");
  const dep = qrows(db).find((r) => r.quarantine_reason === DEPENDS_ON_QUARANTINED_REASON)!;
  expect(dep).toBeDefined();
  expect(frontier(db, P), "stream advanced").toBe(1);
  expect(inChanges(db, `${P}:1`)).toBe(false);
  // still blocked: the prerequisite is still quarantined -> Retry leaves the row ACTIVE
  const blocked = retryQuarantineRecord(db, dep.quarantine_id, makeEntityMutator());
  expect(blocked).toEqual({ outcome: "failed", resolved: false });
  expect(qrows(db).find((r) => r.quarantine_id === dep.quarantine_id)!.resolved_at_hlc).toBeNull();
  expect(inChanges(db, `${P}:1`)).toBe(false);
  // the prerequisite is retried and applies
  const tRow = qrows(db).find((r) => r.quarantine_reason === "invalid_change_record:synthetic")!;
  expect(retryQuarantineRecord(db, tRow.quarantine_id, makeEntityMutator()).resolved).toBe(true);
  expect(title(db, "evt-x")).toBe("created");
  // Retry now applies P:1 for real
  const done = retryQuarantineRecord(db, dep.quarantine_id, makeEntityMutator());
  expect(done).toEqual({ outcome: "applied", resolved: true });
  expect(inChanges(db, `${P}:1`), "history row written").toBe(true);
  expect(title(db, "evt-x"), "entity row written").toBe(`v${P}1`);
  expect(db.prepare("SELECT 1 FROM skipped_seqs WHERE producer_device_id = ? AND local_seq = 1").get(P)).toBeUndefined();
  expect(qrows(db).find((r) => r.quarantine_id === dep.quarantine_id)!.resolved_at_hlc).not.toBeNull();
});

// ---------------------------------------------------------------- step 3(b)

test("target gone, every prerequisite in: counted done (history stored, read position advances, no row)", () => {
  const db = freshDb();
  seedEvent(db, "evt-later");
  const edit = rec(P, 1, { causality_clock: { [P]: 1 } }); // evt-x never existed here, nothing else cited
  expect(apply(db, edit)).toBe("target_gone");
  expect(inChanges(db, `${P}:1`)).toBe(true);
  expect(frontier(db, P)).toBe(1);
  expect(title(db, "evt-x")).toBeUndefined();
  expect(apply(db, rec(P, 2, { entity_id: "evt-later" }))).toBe("applied");
  expect(qrows(db)).toHaveLength(0);
});

test("local delete path (no tombstone row): a concurrent edit arriving at the deleter behaves as before (stored, read position advances, no row)", async () => {
  const a = dev("A"), b = dev("B");
  const e = a.core.createEvent(ev("orig"));
  await sessionOnce(a, b);
  a.core.deleteEvent(e.id);
  b.core.updateEvent(e.id, ev("edit-B")); // concurrent with the delete
  await sessionOnce(b, a);
  expect(a.db.prepare("SELECT COUNT(*) c FROM events").get()).toEqual({ c: 0 });
  expect(inChanges(a.db, `${b.identity.deviceId}:2`)).toBe(true);
  expect(frontier(a.db, b.identity.deviceId)).toBe(2);
  expect(qrows(a.db)).toHaveLength(0);
});

test("DC-27 TR-8 shape: clock cites a removed device above its cutoff, everything covered applied: counted done", () => {
  const db = freshDb(1);
  expect(apply(db, create(W, 1, "evt-seen"))).toBe("applied");
  const edit = rec(P, 1, { causality_clock: { [P]: 1, [W]: 3 } }); // evt-x was created by W above the cutoff
  expect(apply(db, edit)).toBe("target_gone");
  expect(frontier(db, P)).toBe(1);
});

// ---------------------------------------------------------------- creates always apply

test("a calendar create applies on an absent target, also when its clock cites a removed device above the cutoff", () => {
  const db = freshDb(1);
  expect(apply(db, create(W, 1, "evt-seen"))).toBe("applied");
  const cal = (seq: number, clock: VectorClock) =>
    rec(P, seq, { entity_id: "cal-new", entity_type: "calendar", field_path: "title", payload: { value: "Work" }, causality_clock: clock });
  expect(apply(db, cal(1, { [P]: 1, [W]: 4 }))).toBe("applied");
  expect((db.prepare("SELECT title FROM calendars WHERE calendar_id = 'cal-new'").get() as { title: string }).title).toBe("Work");
});

test("an event create applies even when its clock cites changes that are not here", () => {
  const db = freshDb();
  expect(apply(db, create(P, 1, "evt-new", { [P]: 1, [T]: 7 }))).toBe("applied");
  expect(title(db, "evt-new")).toBe("created");
});

// ---------------------------------------------------------------- duplicate warning row

test("the duplicate-different-content warning appears even when an earlier quarantine row exists for that (origin, seq)", () => {
  const db = freshDb();
  seedEvent(db, "evt-x");
  const good = rec(T, 1, {});
  quarantineRecord(db, { reason: "invalid_change_record:synthetic", senderDeviceId: T, rawRecord: good });
  markSeqSkipped(db, T, 1);
  const id = qrows(db)[0]!.quarantine_id;
  expect(retryQuarantineRecord(db, id, makeEntityMutator()).resolved).toBe(true);
  const out = apply(db, { ...good, payload: { value: "RESTORED-DIFFERENT" } });
  expect(out).toBe("duplicate_different_content");
  expect(qrows(db).some((r) => r.quarantine_reason === DUPLICATE_DIFFERENT_CONTENT_REASON && r.resolved_at_hlc === null)).toBe(true);
});

// ---------------------------------------------------------------- snapshots

function snapshotInto(from: Device, to: Device): void {
  const snaps: unknown[] = [];
  buildSnapshot(from.db, (s: unknown) => snaps.push(s));
  for (const s of snaps) applySnapshot(to.db, s as never, loadKnowledgeFromDb(to.db));
}

test("after a snapshot, a concurrent edit of an event the sender had deleted does not stall the origin's stream", async () => {
  const a = dev("A"), b = dev("B"), c = dev("C");
  const e = a.core.createEvent(ev("orig"));
  await sessionOnce(a, b);
  b.core.updateEvent(e.id, ev("edit-B"));
  a.core.deleteEvent(e.id); // A has not seen B's edit
  snapshotInto(a, c);
  b.core.createEvent(ev("later-B"));
  for (let i = 0; i < 3; i++) await sessionOnce(b, c);
  const bMax = (b.db.prepare("SELECT MAX(local_seq) m FROM changes WHERE device_id = ?").get(b.identity.deviceId) as { m: number }).m;
  expect(c.db.prepare("SELECT 1 FROM events WHERE title = 'later-B'").get()).toBeDefined();
  expect(frontier(c.db, b.identity.deviceId)).toBe(bMax);
});

test("after a snapshot (series are not carried), an override edit of that series does not stall the origin's stream", async () => {
  const a = dev("A"), b = dev("B"), c = dev("C");
  a.core.createEvent({ ...ev("rec"), recurrenceRule: "FREQ=WEEKLY;BYDAY=MO" });
  await sessionOnce(a, b);
  const sid = (b.db.prepare("SELECT series_id FROM series").get() as { series_id: string }).series_id;
  snapshotInto(a, c);
  b.core.updateOccurrence(sid, "20270118T090000", { title: "ov" });
  b.core.createEvent(ev("later-B"));
  for (let i = 0; i < 3; i++) await sessionOnce(b, c);
  const bMax = (b.db.prepare("SELECT MAX(local_seq) m FROM changes WHERE device_id = ?").get(b.identity.deviceId) as { m: number }).m;
  expect(c.db.prepare("SELECT 1 FROM events WHERE title = 'later-B'").get()).toBeDefined();
  expect(frontier(c.db, b.identity.deviceId)).toBe(bMax);
  expect(qrows(c.db).filter((r) => r.quarantine_reason !== undefined && r.resolved_at_hlc === null)).toHaveLength(0);
});

// ---------------------------------------------------------------- unpairing record that is never accepted

/** C pulls ONLY origin `o` up to `upto` from `src` (real engine; HELLO restricted). */
async function pullOnly(src: Device, dst: Device, o: Device, upto: number) {
  const seen = new WeakSet<object>();
  return sessionOnce(src, dst, {
    filter: (msg, dir) => {
      const m = msg as { type?: string; device_clock?: Record<string, number> };
      if (m && m.type === "HELLO" && !seen.has(m)) {
        seen.add(m);
        m.device_clock = dir === "from" ? { [o.identity.deviceId]: upto } : {};
      }
      return true;
    },
  });
}

test("a prerequisite from a removed device that this device never learned about keeps the change held; a visible notice appears after the threshold; nothing is dropped, quarantined or skipped; it resolves when the change applies", async () => {
  const a = dev("A"), b = dev("B"), c = dev("C");
  const ghost = "d-ghost-removed";
  const e = a.core.createEvent(ev("orig"));
  await sessionOnce(a, b);
  // B has seen ghost:5 (a change of the removed device above A's cutoff that C will never receive)
  b.db.prepare("INSERT INTO device_clock (peer_device_id, max_seq) VALUES (?, 5)").run(ghost);
  b.core.updateEvent(e.id, ev("edit-B")); // clock cites A:2 and ghost:5
  a.core.deleteEvent(e.id); // C will have no row for the event
  // C catches up on A by snapshot (A's create and delete are covered, no row), but never gets ghost
  snapshotInto(a, c);
  const bId = b.identity.deviceId;
  const bSeq = (b.db.prepare("SELECT MAX(local_seq) m FROM changes WHERE device_id = ?").get(bId) as { m: number }).m;
  const heldNotices = () => qrows(c.db).filter((r) => r.quarantine_reason === WAITING_ON_CHANGE_REASON);
  for (let i = 1; i <= HELD_SESSIONS_BEFORE_NOTICE; i++) {
    const r = await pullOnly(b, c, b, bSeq);
    expect(r.toStats.receivedNotApplicableYet, `session ${i}: still held`).toBeGreaterThan(0);
    expect(frontier(c.db, bId), "read position held").toBe(bSeq - 1);
    expect(heldNotices(), `no notice before the threshold (session ${i})`).toHaveLength(i < HELD_SESSIONS_BEFORE_NOTICE ? 0 : 1);
  }
  const notice = heldNotices()[0]!;
  expect(notice.sender_device_id, "names the device whose change is missing").toBe(ghost);
  expect(qrows(c.db).filter((r) => r.quarantine_reason !== WAITING_ON_CHANGE_REASON), "nothing quarantined").toHaveLength(0);
  expect(c.db.prepare("SELECT COUNT(*) c FROM skipped_seqs").get(), "nothing skipped").toEqual({ c: 0 });
  expect(c.db.prepare("SELECT COUNT(*) c FROM peer_invalid_tally").get()).toEqual({ c: 0 });
  expect(humanReason(WAITING_ON_CHANGE_REASON)).not.toBe(WAITING_ON_CHANGE_REASON);
  await pullOnly(b, c, b, bSeq); // a fourth session adds no second notice
  expect(heldNotices()).toHaveLength(1);
  // Retry re-runs the rule: still blocked -> stays active, seq still not skipped
  expect(retryQuarantineRecord(c.db, notice.quarantine_id, makeEntityMutator())).toEqual({ outcome: "failed", resolved: false });
  expect(c.db.prepare("SELECT COUNT(*) c FROM skipped_seqs").get()).toEqual({ c: 0 });
  // restart-time revalidation leaves the notice alone
  revalidateQuarantine(c.db, makeEntityMutator());
  expect(heldNotices()[0]!.resolved_at_hlc).toBeNull();
  // the missing changes finally arrive: the held change applies and the notice resolves
  for (let s = 1; s <= 5; s++) {
    expect(apply(c.db, rec(ghost, s, { entity_id: `evt-g${s}`, field_path: "event", payload: { value: { id: `evt-g${s}`, title: "g", description: "", startMs: 1_800_000_000_000, endMs: 1_800_003_600_000, allDay: false } }, causality_clock: { [ghost]: s } }))).toBe("applied");
  }
  await pullOnly(b, c, b, bSeq);
  expect(frontier(c.db, bId)).toBe(bSeq);
  expect(heldNotices()[0]!.resolved_at_hlc, "resolved automatically").not.toBeNull();
});

// ---------------------------------------------------------------- referenced objects (second references)
// A change can name an object besides its target: a series create names its
// base event, an event create lands in its calendar (always the default one),
// an occurrence change belongs to a series (its target). When that object is
// absent, the same prerequisite rule decides: hold while a cited change is
// missing, otherwise counted done.

const seriesCreate = (seq: number, clock: VectorClock): ChangeRecord =>
  rec(P, seq, {
    entity_id: "ser-1", entity_type: "series", field_path: "recurrence_rule",
    payload: { value: "FREQ=DAILY", base_event_id: "evt-b" }, causality_clock: clock,
  });

test("series create whose base event is absent: held while a cited change is missing, applied once it arrives", () => {
  const db = freshDb();
  const sc = seriesCreate(1, { [P]: 1, [T]: 1 });
  expect(apply(db, sc)).toBe("not_applicable");
  expect(frontier(db, P)).toBe(0);
  expect(apply(db, create(T, 1, "evt-b"))).toBe("applied");
  expect(apply(db, sc)).toBe("applied");
  expect(db.prepare("SELECT base_event_id b FROM series WHERE series_id = 'ser-1'").get()).toEqual({ b: "evt-b" });
});

test("series create whose base event is absent and every prerequisite in: counted done, no row, no foreign-key error", () => {
  const db = freshDb();
  expect(apply(db, seriesCreate(1, { [P]: 1 }))).toBe("target_gone");
  expect(db.prepare("SELECT COUNT(*) c FROM series").get()).toEqual({ c: 0 });
  expect(frontier(db, P)).toBe(1);
});

const overrideEdit = (seq: number, clock: VectorClock): ChangeRecord =>
  rec(P, seq, {
    entity_id: "ser-2", entity_type: "occurrence_override", field_path: "overrides.20270118T090000.title",
    payload: { value: "ov" }, causality_clock: clock,
  });

test("occurrence change whose series is absent: held while a cited change is missing, counted done when all are in", () => {
  const db = freshDb();
  expect(apply(db, overrideEdit(1, { [P]: 1, [T]: 1 }))).toBe("not_applicable");
  expect(apply(db, overrideEdit(1, { [P]: 1 }))).toBe("target_gone");
  expect(db.prepare("SELECT COUNT(*) c FROM occurrence_overrides").get()).toEqual({ c: 0 });
});

test("event create whose calendar is absent: held while a cited change is missing, counted done when all are in (no foreign-key error)", () => {
  const dir = mkdtempSync(join(tmpdir(), "tide-nocal-"));
  const db = openDatabase({ path: join(dir, "tide.db") }); // no default calendar row
  dbs.push({ db, dir });
  expect(apply(db, create(P, 1, "evt-n", { [P]: 1, [T]: 1 }))).toBe("not_applicable");
  expect(apply(db, create(P, 1, "evt-n"))).toBe("target_gone");
  expect(db.prepare("SELECT COUNT(*) c FROM events").get()).toEqual({ c: 0 });
  expect(frontier(db, P)).toBe(1);
});
