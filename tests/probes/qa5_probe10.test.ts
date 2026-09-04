// P10: stale causal-before delivery — incoming record causally BEFORE local
// current state. DC-03's algorithm: not 3.1 (values differ), not 3.2 (C is
// not causal-AFTER), 3.3 conflicting set empty (not concurrent) → "apply C
// normally". Characterize actual behavior.
import { describe, expect, test, afterEach } from "vitest";
import { guardProcess } from "./sync_probe_helpers.ts";
import {
  makeDevice,
  closeDevices,
  convergeRound,
  type Device,
} from "../pkg1_helpers.ts";
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

test("P10: causal-before (stale) differing delivery — contract says apply; document actual result", async () => {
  const a = makeDevice("a");
  const b = makeDevice("b");
  devices = [a, b];
  const ev = a.core.createEvent(inputOf("Base"));
  await convergeRound([a, b]);
  const id = ev.id;

  // b edits title (record R_b). a does NOT receive it yet.
  b.core.updateEvent(id, inputOf("B first"));
  const bRec = (b.db.prepare(
    "SELECT change_id FROM changes WHERE entity_id = ? AND field_path='title' ORDER BY local_seq DESC LIMIT 1",
  ).get(id) as any).change_id;

  // a NOW edits title causally AFTER receiving everything except R_b…
  // (a cannot dominate R_b without seeing it; so instead: a edits title
  // concurrently-becoming-later is impossible — use the true causal-before
  // shape: c relay path. Simplest construction: a's edit clock must dominate
  // R_b's clock. Achieve by delivering R_b to a with mutate SKIPPED? Not
  // reachable through public API — instead assert the literal-algorithm
  // behavior on the direct shape that IS reachable: concurrent-with-row but
  // dominated-by-participant. Construct: b edits twice; deliver only the
  // FIRST to a; a then edits (dominates b#1, concurrent with b#2); then
  // deliver b#2 (concurrent with a's edit) — normal conflict. The pure
  // causal-before case (C dominated by all locals) requires C delayed past a
  // dominating local write, i.e. gap-buffered drain — drive via pending.
  //
  // Direct construction: deliver R_b to a while a's device_clock already
  // dominates it via a manual local edit after clock merge. We simulate by
  // merging R_b's clock through a duplicate-carrying record first.
  const c = makeDevice("c");
  devices = [a, b, c];
  // c receives R_b, then c edits (dominates R_b), a receives c's edit first.
  await convergeRound([b, c]);
  c.core.updateEvent(id, inputOf("C later"));
  await convergeRound([a, c]);
  // a's row now "C later"; a's clock dominates R_b. Deliver stale R_b.
  const res = deliver(a, b, bRec);
  const title = (a.db.prepare("SELECT title FROM events WHERE event_id = ?").get(id) as any).title;
  const conflicts = (a.db.prepare("SELECT COUNT(*) c FROM conflicts").all() as any[])[0].c;
  console.log("PROBE-P10: outcome=", res, "| title after stale delivery=", title, "| conflicts=", conflicts);
  // Document: whatever happened, no crash and conflicts count recorded.
  expect(["applied", "duplicate"]).toContain(res);
});
