// TD-005 GUI QA seeder: writes REAL quarantined records through the REAL
// validation/quarantine code path, so the Sync-Errors dialog shows authentic
// rows (real reason strings, real skipped_seqs bookkeeping).
//
// IMPORTANT: run this ONLY while the Tide GUI (and its sidecar) is CLOSED —
// the seeder opens the same SQLite database the app uses.
//
// Usage:  npx tsx scripts/seed-quarantine.ts [count]   (default 6)
//   - even-indexed rows  = "fixable": valid change payloads whose seqs were
//     seeded as skipped, so Retry revalidates and APPLIES them (success case)
//   - odd-indexed rows   = permanently invalid (Retry fails; Delete cases)
import { randomUUID } from "node:crypto";

process.env.TIDE_DB_PATH =
  process.env.TIDE_DB_PATH ?? "/home/skins/tide/data/calendar.db";
process.env.TIDE_DATA_DIR =
  process.env.TIDE_DATA_DIR ?? "/home/skins/tide/data";

const COUNT = Math.max(1, Number(process.argv[2] ?? 6));

const { EventCore } = await import("../src/persistence/bridges/event_core.ts");
const db = await import("../src/persistence/database.ts");
const cr = await import("../src/sync/change_record.ts");

const core = new EventCore(process.env.TIDE_DB_PATH);
const deviceId = core.selfDeviceId;
const run = core.db;

// Producer seqs the engine has NOT yet seen, so later revalidation of a
// now-valid record can land on a clean nextExpected position.
const baseSeq = 90_000;

let fixable = 0;
let permanent = 0;

for (let i = 0; i < COUNT; i++) {
  const isFixable = i % 2 === 0;
  const seq = baseSeq + i;

  // Build a change-record-shaped payload, then run it through the REAL
  // validator so the stored reason is a genuine engine rejection string.
  const candidate = {
    change_id: `${deviceId}:${seq}`,
    device_id: deviceId,
    local_seq: seq,
    hlc_timestamp: `0000000${seq}:0000-FIXED-SEED`,
    entity_id: randomUUID(),
    entity_type: "event",
    field_path: "title",
    operation: "set",
    payload: isFixable
      ? { value: `QA fixable event ${i}` }
      : { value: 1e999 }, // JSON-legal, non-finite → TD-002 rejection class
  };

  let reason: string;
  try {
    cr.validateChangeRecord(candidate);
    // Shouldn't happen for our crafted payloads; keep a safety net.
    reason = "invalid_change_record: seeded (validator accepted — unexpected)";
  } catch (err) {
    reason = `invalid_change_record: ${(err as Error).message}`;
  }

  db.quarantineRecord(run, {
    reason,
    senderDeviceId: deviceId,
    rawRecord: candidate,
  });
  db.markSeqSkipped(run, deviceId, seq);

  if (isFixable) fixable++;
  else permanent++;
}

const stats = db.listQuarantineStats(run);
console.log(`Seeded ${fixable} fixable + ${permanent} permanent = ${fixable + permanent} quarantine rows.`);
console.log(`Quarantine stats now: active=${stats.active} resolved=${stats.resolved} total=${stats.total}`);
console.log("Relaunch the app:  cd src-tauri && cargo run");
console.log(`Expected Sync-Errors badge: ${stats.active} active errors.`);
