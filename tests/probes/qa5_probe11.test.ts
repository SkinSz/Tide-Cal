// P11 (PROMOTED as a pinned observation, 2026-08-30): TRUE causal-before via
// gap-drain — a's local row value comes from D (delivered from c), then the
// stale causal-before record C arrives and is drained from the gap buffer.
// ADJUDICATED (pkg5-review §6.1, TRACEABILITY-REPORT P11 row): the stale
// value DOES overwrite the newer local row — this is DC-03 §3.3 contract-
// literal ("conflicting is empty → apply C normally") fall-through into the
// unconditional mutator; identical pre-Pkg5, NOT a regression. Recorded as
// tech debt / candidate DC-02/DC-03 clarification. This test PINS the
// contract-literal behavior so any silent change to it is caught.
import { describe, expect, test, afterEach } from "vitest";
import { guardProcess } from "./sync_probe_helpers.ts";
import { makeDevice, closeDevices, convergeRound, type Device } from "../pkg1_helpers.ts";
import { makeEntityMutator } from "../../src/persistence/bridges/sync_service.ts";
import { applyRemoteChange, loadKnowledgeFromDb } from "../../src/persistence/database.ts";
import type { ChangeRecord } from "../../src/sync/change_record.ts";

const T0 = 1_756_000_000_000;
let devices: Device[] = [];
afterEach(() => closeDevices(devices));

function inputOf(title: string) {
  return { title, description: "Base description", startMs: T0, endMs: T0 + 3_600_000, allDay: false };
}

function deliver(dst: Device, src: Device, changeId: string): string {
  const row = src.db.prepare("SELECT * FROM changes WHERE change_id = ?").get(changeId) as any;
  const record: ChangeRecord = {
    change_id: row.change_id, device_id: row.device_id, local_seq: row.local_seq,
    entity_id: row.entity_id, entity_type: row.entity_type, field_path: row.field_path,
    operation: row.operation, payload: JSON.parse(row.payload), hlc_timestamp: row.hlc_timestamp,
    causality_clock: JSON.parse(row.causality_clock), schema_version: row.schema_version,
  };
  return applyRemoteChange(dst.db, record, loadKnowledgeFromDb(dst.db), makeEntityMutator());
}

guardProcess();

test("P11: causal-before record drained from gap — stale value vs newer local row", async () => {
  const a = makeDevice("a");
  const b = makeDevice("b");
  const c = makeDevice("c");
  devices = [a, b, c];
  const ev = a.core.createEvent(inputOf("Base"));
  const id = ev.id;
  await convergeRound([a, b, c]);

  // b edits title → record C (producer b).
  b.core.updateEvent(id, inputOf("B stale"));
  const recC = (b.db.prepare(
    "SELECT change_id FROM changes WHERE entity_id = ? AND field_path='title' ORDER BY local_seq DESC LIMIT 1",
  ).get(id) as any).change_id;

  // c receives C directly, then edits → record D descending from C.
  expect(deliver(c, b, recC)).toBe("applied");
  c.core.updateEvent(id, inputOf("C later"));
  const recD = (c.db.prepare(
    "SELECT change_id FROM changes WHERE entity_id = ? AND field_path='title' ORDER BY local_seq DESC LIMIT 1",
  ).get(id) as any).change_id;

  // a receives ONLY D (skip C — no relay): D is c's next seq → contiguous.
  expect(deliver(a, c, recD)).toBe("applied");
  // NOTE: after D, a's row may already read "B stale" — D descends from C
  // which was authored from b's "B stale" state. The decisive pin is below.
  const afterD = (a.db.prepare("SELECT title FROM events WHERE event_id = ?").get(id) as any).title;
  expect(["C later", "B stale"]).toContain(afterD);

  // NOW the stale causal-before C arrives at a → drained/applied.
  // PINNED contract-literal behavior (see header): the stale value overwrites
  // the newer row. If this ever changes (DC-02/03 clarification), update BOTH
  // this pin and the tech-debt registry entry.
  const res = deliver(a, b, recC);
  const title = (a.db.prepare("SELECT title FROM events WHERE event_id = ?").get(id) as any).title;
  const conflicts = (a.db.prepare("SELECT COUNT(*) c FROM conflicts").get() as any).c;
  expect(["applied", "duplicate"]).toContain(res);
  expect(title).toBe("B stale"); // contract-literal fall-through (see header)
  expect(conflicts).toBe(0);     // no conflict row: §3.3 conflicting set empty
});
