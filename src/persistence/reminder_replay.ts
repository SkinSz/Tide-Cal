// DC-22 (TD-073): rebuild the reminders table from reminder
// changes already in history.
//
// Why: before this batch a device stored remote reminder changes in `changes`
// but never wrote the reminders rows. Logs are never truncated, so history
// still holds everything needed to repair that.
//
// What it does: walks the stored reminder changes in storage order (rowid, which
// reproduces arrival order on this device, so the result equals what a device
// that received them normally would hold) and applies each through
// applyReminderChange, the same code the live sync mutator uses (the event row is
// the target; an absent event is judged by prerequisiteState, the batch 1 rule).
//
// Properties:
//   - the result reproduces live sync: causally later changes win (the generic
//     stale rule, database.ts isCausallyStale), concurrent changes are
//     last-arrival (TD-070), removals and the event's delete are respected;
//   - NO timestamp (hlc) is compared anywhere to pick a winner (DC-03 section 5);
//   - idempotent, and a row is written only when the result differs from the row,
//     so a repeat run at every start rewrites nothing;
//   - writes NO history, quarantine or conflict rows;
//   - a member with an unresolved conflict is left as it is (the conflict, not the
//     replay, decides it);
//   - a change whose event is absent AND whose prerequisite is still missing or
//     was skipped/quarantined here cannot be applied now. It is not dropped: it
//     stays in history untouched, is counted in the result, logged (ids only), and
//     retried by the next run (startup runs this every time).
//
// Trigger: sidecar startup (sidecar_server.ts main), and scoped to one event when
// that event row is brought back (sync_service.ts). No one-time marker: the run
// is idempotent and cheap, so a schema step is not needed.
import type { Database } from "better-sqlite3";
import { deserializeChangeRow, isCausallyStale, prerequisiteState, type ChangeRow } from "./database.ts";
import { applyReminderChangeDetailed, reminderMemberId } from "./bridges/reminder_apply.ts";

export interface ReplayResult {
  /** reminder changes examined */
  examined: number;
  /** reminder rows that differ after the replay (added, changed or deleted) */
  applied: number;
  /** skipped by the causal stale rule (a causally later change is stored) */
  skippedStale: number;
  /** event absent and nothing pending: counted done (event deleted) */
  eventGone: number;
  /** member has an unresolved conflict: left alone */
  inConflict: number;
  /** could not be decided now (prerequisite missing / skipped / quarantined); kept for the next run */
  unresolved: number;
}

class NoNetChange extends Error {}

type RowKey = string;
function snapshot(db: Database, eventId: string | undefined): Map<string, RowKey> {
  const rows = (
    eventId === undefined
      ? db.prepare("SELECT member_id, entity_id, minutes_before, enabled, updated_hlc FROM reminders").all()
      : db
          .prepare("SELECT member_id, entity_id, minutes_before, enabled, updated_hlc FROM reminders WHERE entity_id = ?")
          .all(eventId)
  ) as Array<{ member_id: string; entity_id: string; minutes_before: number; enabled: number | null; updated_hlc: number }>;
  return new Map(
    rows.map((r) => [r.member_id, `${r.entity_id}|${r.minutes_before}|${r.enabled}|${r.updated_hlc}`]),
  );
}

export function replayReminderHistory(
  db: Database,
  opts: { eventId?: string } = {},
): ReplayResult {
  const res: ReplayResult = { examined: 0, applied: 0, skippedStale: 0, eventGone: 0, inConflict: 0, unresolved: 0 };
  const rows = (
    opts.eventId === undefined
      ? db.prepare("SELECT * FROM changes WHERE entity_type = 'reminder' ORDER BY rowid")
      : db.prepare("SELECT * FROM changes WHERE entity_type = 'reminder' AND entity_id = ? ORDER BY rowid")
  ).all(...(opts.eventId === undefined ? [] : [opts.eventId])) as ChangeRow[];
  if (rows.length === 0) return res;

  const conflicted = db.prepare(
    "SELECT 1 FROM conflicts WHERE entity_id = ? AND field_path = ? AND status = 'unresolved' LIMIT 1",
  );
  const unresolved: string[] = [];

  try {
    db.transaction(() => {
      const before = snapshot(db, opts.eventId);
      // Storage order (rowid) is arrival order, so applying in that order through
      // the same apply code reproduces what live sync wrote.
      for (const r of rows) {
        res.examined++;
        const rec = deserializeChangeRow(r);
        if (reminderMemberId(rec.field_path) === null) continue;
        if (conflicted.get(rec.entity_id, rec.field_path) !== undefined) {
          res.inConflict++;
          continue;
        }
        if (isCausallyStale(db, rec)) {
          res.skippedStale++;
          continue;
        }
        if (applyReminderChangeDetailed(db, rec) === "target_absent") {
          const pre = prerequisiteState(db, rec);
          if (pre.missingOrigin !== null || pre.rejectedPrerequisite) {
            res.unresolved++;
            unresolved.push(rec.change_id);
          } else {
            res.eventGone++;
          }
        }
      }
      const after = snapshot(db, opts.eventId);
      for (const [id, v] of after) if (before.get(id) !== v) res.applied++;
      for (const id of before.keys()) if (!after.has(id)) res.applied++;
      // Intermediate writes of a multi-change history must not persist when the
      // end result is the table that was already there.
      if (res.applied === 0) throw new NoNetChange();
    })();
  } catch (e) {
    if (!(e instanceof NoNetChange)) throw e;
  }

  if (unresolved.length > 0) {
    // ids only, no calendar content
    console.error(
      `[tide] reminder replay: ${unresolved.length} change(s) not applicable now, kept in history for the next run: ${unresolved.slice(0, 10).join(", ")}`,
    );
  }
  return res;
}
