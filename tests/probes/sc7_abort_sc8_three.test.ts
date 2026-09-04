// SC7: abrupt abort mid-session x5 + restart -> must converge, no duplication.
// SC8: 3-device star topology with concurrent creates + delete-vs-edit conflict.
// PROMOTED (2026-08-30): SC8's old assertion (same-row-state-everywhere) pinned
// the implicit-LWW convergence that Pkg5/DC-03 §3.4 REPLACED. Rewritten to pin
// the CORRECT semantics: deleter keeps deletion, editor keeps edit, unresolved
// conflict rows on all devices (verified NOT data loss; pkg5b-review §5).
import { expect, test } from "vitest";
import type Database from "better-sqlite3";
import { join } from "node:path";
import { EventCore } from "../../src/persistence/bridges/event_core.ts";
import {
  makeDevice,
  pairDevices,
  sessionOnce,
  oracle,
  dumpState,
  saveResult,
  type Device,
  guardProcess,
} from "./sync_probe_helpers.ts";

function mkEvent(d: Device, title: string) {
  const t = Date.now();
  return d.core.createEvent({ title, description: "c", startMs: t, endMs: t + 3600_000, allDay: false });
}

guardProcess();

test("SC7 abrupt abort mid-session x5 + restart: converge, no duplication", async () => {
  const runs: unknown[] = [];
  for (let run = 0; run < 5; run++) {
    const a = makeDevice("A");
    const b = makeDevice("B");
    pairDevices(a, b);
    for (let i = 0; i < 12; i++) mkEvent(a, `r${run}-ev-${i}`);
    // abort mid-convergence (partial batch delivery), tolerate errors
    await sessionOnce(a, b, { tolerateError: true, abortAfterMs: 1 + run });
    // restart simulation: reopen both DBs
    a.core.db.close();
    b.core.db.close();
    const aR = new EventCore(join(a.dir, "tide.db"), a.identity.deviceId);
    const bR = new EventCore(join(b.dir, "tide.db"), b.identity.deviceId);
    const a2: Device = { ...a, core: aR, db: aR.db as Database.Database };
    const b2: Device = { ...b, core: bR, db: bR.db as Database.Database };
    await sessionOnce(a2, b2);
    await sessionOnce(b2, a2);
    await sessionOnce(a2, b2);
    const o = oracle([a2, b2]);
    const changesB = (b2.db.prepare("SELECT COUNT(*) c FROM changes").get() as { c: number }).c;
    const eventsB = (b2.db.prepare("SELECT COUNT(*) c FROM events").get() as { c: number }).c;
    const pendingB = (b2.db.prepare("SELECT COUNT(*) c FROM pending_changes").get() as { c: number }).c;
    const dupeRows = (b2.db.prepare(
      "SELECT COUNT(*) c FROM (SELECT device_id, local_seq, COUNT(*) n FROM changes GROUP BY 1,2 HAVING n > 1)",
    ).get() as { c: number }).c;
    const rec = { run, converged: o.converged, detail: o.detail, changesB, eventsB, pendingB, dupeRows };
    runs.push(rec);
    saveResult(`sc7-run${run}`, rec);
    a2.core.db.close();
    b2.core.db.close();
  }
  expect(runs.every((r) => (r as { converged: boolean }).converged), JSON.stringify(runs)).toBe(true);
  expect(runs.every((r) => (r as { pendingB: number }).pendingB === 0)).toBe(true);
  expect(runs.every((r) => (r as { dupeRows: number }).dupeRows === 0)).toBe(true);
}, 60000);

test("SC8 3-device star: concurrent creates on all 3 + delete-vs-edit, converge via hub", async () => {
  const a = makeDevice("HUB");
  const b = makeDevice("SAT1");
  const c = makeDevice("SAT2");
  pairDevices(a, b);
  pairDevices(a, c);
  pairDevices(b, c);

  // concurrent creates: one event per device, no sessions in between
  const evA = mkEvent(a, "from-hub");
  const evB = mkEvent(b, "from-sat1");
  const evC = mkEvent(c, "from-sat2");

  await sessionOnce(a, b); await sessionOnce(b, a);
  await sessionOnce(a, c); await sessionOnce(c, a);
  await sessionOnce(b, c); await sessionOnce(c, b);
  await sessionOnce(a, b); await sessionOnce(a, c);
  const o1 = oracle([a, b, c]);

  // delete-vs-edit: A deletes evB while B edits evB concurrently
  a.core.deleteEvent(evB.id);
  b.core.updateEvent(evB.id, { title: "edited-while-deleted", description: "c", startMs: evB.startMs, endMs: evB.endMs, allDay: false });

  await sessionOnce(a, b); await sessionOnce(b, a);
  await sessionOnce(a, c); await sessionOnce(c, a);
  await sessionOnce(b, c); await sessionOnce(c, b);
  await sessionOnce(a, b); await sessionOnce(a, c); await sessionOnce(b, c);
  const o2 = oracle([a, b, c]);
  const evbA = (a.db.prepare("SELECT COUNT(*) c FROM events WHERE event_id=?").get(evB.id) as { c: number }).c;
  const evbB = (b.db.prepare("SELECT COUNT(*) c FROM events WHERE event_id=?").get(evB.id) as { c: number }).c;
  const evbC = (c.db.prepare("SELECT COUNT(*) c FROM events WHERE event_id=?").get(evB.id) as { c: number }).c;
  const tombA = (a.db.prepare("SELECT COUNT(*) c FROM entities_tombstones WHERE entity_id=?").get(evB.id) as { c: number }).c;

  saveResult("sc8", {
    oracleAfterConcurrentCreates: o1,
    oracleAfterDeleteVsEdit: o2,
    deletedEventRows: { a: evbA, b: evbB, c: evbC },
    tombstonesA: tombA,
    stateA: dumpState("HUB", a),
  });
  expect(o1.converged, JSON.stringify(o1.detail)).toBe(true);
  // Post-Pkg5/DC-03 §3.4 semantics (PROMOTED pin): delete-vs-edit does NOT
  // converge to a single row state — the deleter keeps the deletion, the
  // editor keeps the edit, and an unresolved conflict row is recorded on
  // every device that saw both intents (verified NOT data loss:
  // pkg5b-review §5 SC8 replica).
  const unresolved = (d: Device) =>
    (d.db.prepare(
      "SELECT COUNT(*) c FROM conflicts WHERE entity_id=? AND status='unresolved'",
    ).get(evB.id) as { c: number }).c;
  expect(unresolved(a)).toBeGreaterThanOrEqual(1);
  expect(unresolved(b)).toBeGreaterThanOrEqual(1);
  expect(unresolved(c)).toBeGreaterThanOrEqual(1);
  const editorKept = (b.db.prepare("SELECT title FROM events WHERE event_id=?").get(evB.id) as { title: string }).title;
  expect(editorKept).toBe("edited-while-deleted");
}, 60000);
