// qa-review5c falsification probes (independent reviewer — read-only on src/).
// 1) SC8 conflict-row spot-check: delete-vs-edit divergence must be backed by
//    unresolved conflict rows on EVERY device (DC-03 §3.4), not silent loss.
// 2) Backup-restore attack on neededRanges self-exclusion (see test 2 below).
import { expect, test } from "vitest";
import { makeDevice, pairDevices, sessionOnce,
  guardProcess,
} from "./sync_probe_helpers.ts";
function mkEvent(d: any, title: string) {
  const t = Date.now();
  return d.core.createEvent({ title, description: "c", startMs: t, endMs: t + 3600000, allDay: false });
}
import { getDeviceClock, loadKnowledgeFromDb } from "../../src/persistence/database.ts";

function conflictsFor(db: any, entityId: string) {
  return db
    .prepare("SELECT conflict_id, entity_id, field_path, status FROM conflicts WHERE entity_id = ?")
    .all(entityId);
}

guardProcess();

test("SC8 delete-vs-edit: divergence backed by unresolved conflict rows on all devices", async () => {
  const a = makeDevice("HUB");
  const b = makeDevice("SAT1");
  const c = makeDevice("SAT2");
  pairDevices(a, b); pairDevices(a, c); pairDevices(b, c);
  const evB = mkEvent(b, "from-sat1");
  await sessionOnce(a, b); await sessionOnce(b, a);
  await sessionOnce(a, c); await sessionOnce(c, a);
  await sessionOnce(b, c); await sessionOnce(c, b);
  await sessionOnce(a, b); await sessionOnce(a, c);
  a.core.deleteEvent(evB.id);
  b.core.updateEvent(evB.id, { title: "edited-while-deleted", description: "c", startMs: evB.startMs, endMs: evB.endMs, allDay: false });
  await sessionOnce(a, b); await sessionOnce(b, a);
  await sessionOnce(a, c); await sessionOnce(c, a);
  await sessionOnce(b, c); await sessionOnce(c, b);
  await sessionOnce(a, b); await sessionOnce(a, c); await sessionOnce(b, c);
  const report: Record<string, unknown> = {};
  for (const [tag, d] of [["HUB", a], ["SAT1", b], ["SAT2", c]] as const) {
    const liveRow = (d.db.prepare("SELECT COUNT(*) c FROM events WHERE event_id=?").get(evB.id) as any).c;
    const tomb = (d.db.prepare("SELECT COUNT(*) c FROM entities_tombstones WHERE entity_id=?").get(evB.id) as any).c;
    report[tag] = { liveRow, tomb, conflicts: conflictsFor(d.db, evB.id) };
  }
  console.log("SC8-CONFLICTS", JSON.stringify(report, null, 1));
  // Every device must hold an UNRESOLVED conflict row for the delete-vs-edit.
  for (const t of ["HUB", "SAT1", "SAT2"]) {
    const r = report[t] as any;
    expect(r.conflicts.length, `${t} conflict row`).toBeGreaterThanOrEqual(1);
    expect(r.conflicts[0].status, `${t} unresolved`).toBe("unresolved");
  }
  // Divergence pattern: deleter keeps deletion, editor keeps edit.
  expect((report.HUB as any).liveRow).toBe(0);
  expect((report.SAT1 as any).liveRow).toBe(1);
});

// ---------------------------------------------------------------------------
// Backup-restore attack on neededRanges self-exclusion.
// Setup: device a produced 6 events (seqs 1..6), fully synced to peer b.
// "Restore": roll a's DB back — delete own changes rows 4..6 and their entity
// state, set device_clock[a]=3 (a consistent OLDER snapshot of the same
// device id, per the attack spec). Peer b still holds seqs 1..6 for a.
// Question: can a pull its own lost history back?
// ---------------------------------------------------------------------------
test("backup-restore attack: self-exclusion vs rolled-back own history", async () => {
  const a = makeDevice("a");
  const b = makeDevice("b");
  pairDevices(a, b);
  const ids: string[] = [];
  for (let i = 1; i <= 6; i++) ids.push(mkEvent(a, `ev-${i}`).id);
  await sessionOnce(a, b); await sessionOnce(b, a);
  // verify converged
  const bCount = (b.db.prepare("SELECT COUNT(*) c FROM changes WHERE device_id=?").get(a.identity.deviceId) as any).c;
  expect(bCount).toBeGreaterThanOrEqual(6);

  // --- simulate restore-from-older-backup on a (same device id) ---
  a.db.exec("BEGIN");
  a.db.prepare("DELETE FROM changes WHERE device_id=? AND local_seq>3").run(a.identity.deviceId);
  a.db.exec("DELETE FROM events WHERE event_id IN (SELECT entity_id FROM changes WHERE device_id='" + a.identity.deviceId + "' AND local_seq>3)");
  a.db.prepare("DELETE FROM entities_tombstones").run();
  a.db.prepare("UPDATE device_clock SET max_seq=3 WHERE peer_device_id=?").run(a.identity.deviceId);
  a.db.prepare("DELETE FROM applied_upto WHERE producer_device_id=?").run(a.identity.deviceId);
  a.db.prepare("DELETE FROM entity_versions WHERE entity_id IN (?,?,?)").run(ids[3], ids[4], ids[5]);
  a.db.prepare("DELETE FROM events WHERE event_id IN (?,?,?)").run(ids[3], ids[4], ids[5]);
  a.db.exec("COMMIT");
  expect((a.db.prepare("SELECT COUNT(*) c FROM changes WHERE device_id=?").get(a.identity.deviceId) as any).c).toBeLessThanOrEqual(4);
  expect((a.db.prepare("SELECT COUNT(*) c FROM events").get() as any).c).toBe(3);

  // session a -> b: does a recover its lost seqs 4..6?
  const stats = await sessionOnce(a, b);
  void stats;
  await sessionOnce(b, a);
  const afterChanges = (a.db.prepare("SELECT COUNT(*) c FROM changes WHERE device_id=?").get(a.identity.deviceId) as any).c;
  const afterEvents = (a.db.prepare("SELECT COUNT(*) c FROM events").get() as any).c;
  const clockA = getDeviceClock(a.db)[a.identity.deviceId];
  const knowledge = loadKnowledgeFromDb(a.db);
  console.log("RESTORE-ATTACK", JSON.stringify({
    
    afterChanges, afterEvents, clockA,
    appliedUptoSelf: knowledge.appliedUpto[a.identity.deviceId],
  }));

  // Attack verification: WITHOUT recovery, a is stuck at 3 own records while
  // b holds 6. Also probe the seq-reuse hazard: next local write allocates 4.
  a.core.createEvent({ title: "post-restore", description: "c", startMs: Date.now(), endMs: Date.now() + 3600000, allDay: false });
  const newSeq = (a.db.prepare("SELECT MAX(local_seq) m FROM changes WHERE device_id=?").get(a.identity.deviceId) as any).m;
  console.log("RESTORE-ATTACK next local_seq after restore:", newSeq, "(b already holds a#4 with different payload)");
  await sessionOnce(a, b); await sessionOnce(b, a);
  const bSeq4 = b.db.prepare("SELECT payload, change_id FROM changes WHERE device_id=? AND local_seq=4").all(a.identity.deviceId);
  console.log("RESTORE-ATTACK b's rows for a#4:", JSON.stringify(bSeq4));
});
