// Old-format series creates and duplicate-content detection.
//  B3: a series-create written before base_event_id existed can never be
//      materialized. It does not block the stream: it follows the one
//      prerequisite rule (counted done), later changes of the origin apply.
//  B5: the same (origin device, seq) arriving again with DIFFERENT content is
//      detected (log, counter, quarantine row with its own reason); the stored
//      copy is untouched. An identical re-delivery produces no warning.
import { afterAll, expect, test } from "vitest";
import { rmSync } from "node:fs";
import { makeDevice, sessionOnce, fingerprint, guardProcess, type Device } from "./probes/sync_probe_helpers.ts";
import { createLocalChange, applyRemoteChangeDetailed, loadKnowledgeFromDb, listQuarantine, reconcileQuarantineResolutions } from "../src/persistence/database.ts";
import { makeEntityMutator } from "../src/persistence/bridges/sync_service.ts";
import { createSyncEngine } from "../src/sync/sync_engine.ts";
import type { SyncMessage, SyncTransport } from "../src/sync/sync_engine.ts";
import type { ChangeRecord } from "../src/sync/change_record.ts";
import { humanReason } from "../frontend/sync_errors.ts";

guardProcess();
const T0 = 1_800_000_000_000;
const ev = (t: string) => ({ title: t, description: "d", startMs: T0, endMs: T0 + 3_600_000, allDay: false });
const made: Device[] = [];
const dev = (t: string): Device => {
  const d = makeDevice(t);
  made.push(d);
  return d;
};
afterAll(() => {
  for (const d of made) {
    try { d.db.close(); } catch { /* closed */ }
    try { rmSync(d.dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

const q = (d: Device) => listQuarantine(d.db) as Array<{ quarantine_reason: string; raw_record: string; resolved_at_hlc: number | null }>;
const frontier = (d: Device, o: Device): number =>
  (d.db.prepare("SELECT applied_through v FROM applied_upto WHERE producer_device_id = ?").get(o.identity.deviceId) as { v: number } | undefined)?.v ?? 0;

test("old-shape series create (no base_event_id) does not block the stream: counted done under the prerequisite rule, later seq applies", async () => {
  const a = dev("A"), b = dev("B");
  const e = a.core.createEvent(ev("base"));
  // Old-shape series create: payload has only the rule (no base_event_id).
  const hlc = a.core.hlcNow();
  createLocalChange(
    a.db, a.identity.deviceId,
    { entity_id: "ser-old", entity_type: "series", field_path: "recurrence_rule", operation: "set", payload: { value: "FREQ=DAILY" }, hlc_now: () => hlc },
    (db) => {
      db.prepare("INSERT INTO series (series_id, base_event_id, recurrence_rule, created_hlc, updated_hlc) VALUES ('ser-old', ?, 'FREQ=DAILY', ?, ?)").run(e.id, hlc, hlc);
    },
  );
  a.core.updateEvent(e.id, ev("later")); // seq after the old series create
  const r = await sessionOnce(a, b);
  expect(r.error).toBeUndefined();
  expect(r.toStats.receivedTargetGone, "counted done (no row can be built)").toBe(1);
  expect(q(b)).toHaveLength(0);
  expect(frontier(b, a), "read position moved past it").toBe(4);
  expect((fingerprint(b.db).events[0] as { title: string }).title, "later seq applied").toBe("later");
  expect(fingerprint(b.db).series).toHaveLength(0);
});

function storedRecord(d: Device, origin: Device, seq: number): ChangeRecord {
  const r = d.db.prepare("SELECT * FROM changes WHERE device_id = ? AND local_seq = ?").get(origin.identity.deviceId, seq) as Record<string, unknown>;
  return { ...(r as unknown as ChangeRecord), payload: JSON.parse(r.payload as string), causality_clock: JSON.parse(r.causality_clock as string) };
}

test("same (origin, seq) with different content: warning row + outcome, stored copy untouched; identical re-delivery silent", async () => {
  const a = dev("A"), b = dev("B");
  a.core.createEvent(ev("orig"));
  await sessionOnce(a, b);
  const stored = storedRecord(b, a, 2);
  const before = JSON.stringify(stored);

  // identical re-delivery: no warning
  const same = applyRemoteChangeDetailed(b.db, stored, loadKnowledgeFromDb(b.db), makeEntityMutator());
  expect(same).toBe("duplicate");
  expect(q(b)).toHaveLength(0);

  // different content, same (origin, seq)
  const forged: ChangeRecord = { ...stored, payload: { value: { ...(stored.payload as { value: object }).value, title: "OTHER" } } as ChangeRecord["payload"] };
  const out = applyRemoteChangeDetailed(b.db, forged, loadKnowledgeFromDb(b.db), makeEntityMutator());
  expect(out).toBe("duplicate_different_content");
  const rows = q(b);
  expect(rows).toHaveLength(1);
  expect(rows[0]!.quarantine_reason).toBe("duplicate_seq_different_content");
  expect(JSON.parse(rows[0]!.raw_record).payload.value.title).toBe("OTHER");
  expect(JSON.stringify(storedRecord(b, a, 2)), "stored copy untouched").toBe(before);
  expect((fingerprint(b.db).events[0] as { title: string }).title).toBe("orig");
  // must not auto-resolve although the change_id exists in `changes`
  reconcileQuarantineResolutions(b.db);
  expect(q(b)[0]!.resolved_at_hlc).toBeNull();
  // repeating the same differing copy adds no second row
  applyRemoteChangeDetailed(b.db, forged, loadKnowledgeFromDb(b.db), makeEntityMutator());
  expect(q(b)).toHaveLength(1);
  expect(humanReason("duplicate_seq_different_content")).not.toBe("duplicate_seq_different_content");
});

test("engine counter on a differing copy delivered in a session", async () => {
  const a = dev("A"), b = dev("B");
  a.core.createEvent(ev("orig"));
  a.core.updateEvent(a.core.listEvents()[0]!.id, ev("v2"));
  await sessionOnce(a, b);
  const stored = storedRecord(b, a, 2);
  const forged: ChangeRecord = { ...stored, hlc_timestamp: stored.hlc_timestamp + 5 };
  const next = storedRecord(b, a, 3);
  const script: Array<SyncMessage> = [
    // peer advertises one seq more than b holds, so b requests and receives a batch
    { v: 1, type: "HELLO", device_clock: { [a.identity.deviceId]: 4 } },
    { v: 1, type: "CHANGES_BATCH", changes: [forged, { ...next, local_seq: 4, change_id: `${a.identity.deviceId}:4`, field_path: "description", payload: { value: "x" } }] },
  ];
  const t: SyncTransport = {
    async send() {},
    async receive() { return script.shift() ?? null; },
  };
  const eng = createSyncEngine({ db: b.db, selfDeviceId: b.identity.deviceId, mutateEntity: makeEntityMutator() });
  const stats = await eng.runSession(t);
  expect(stats.receivedDuplicateDifferentContent).toBe(1);
  expect(q(b).filter((r) => r.quarantine_reason === "duplicate_seq_different_content")).toHaveLength(1);
});
