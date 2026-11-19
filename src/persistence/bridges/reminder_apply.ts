// DC-22: apply ONE reminder change (member_add / member_update / member_remove)
// to the reminders table. Used by the sync mutator (sync_service.ts) and by the
// history replay (persistence/reminder_replay.ts), so a live change and a
// replayed one go through the same code.
//
// The target is the EVENT row. If it is absent the result is "target_absent"
// and applyRemoteChangeDetailed's one prerequisite rule decides (hold,
// quarantine, or counted done); reminders have no rule of their own.
// updated_hlc is the ORIGIN record's hlc, never "now".
import type { Database } from "better-sqlite3";
import type { ChangeRecord } from "../../sync/change_record.ts";
import type { MutateResult } from "../database.ts";
import { deleteReminderRow, upsertReminderRow } from "./event_core.ts";

const MEMBER_PATH = /^reminders\.(.+)$/;

export function reminderMemberId(fieldPath: string): string | null {
  const m = MEMBER_PATH.exec(fieldPath);
  return m ? m[1]! : null;
}

/** What applying one reminder change did to the reminders table. */
export type ReminderApplyResult = "target_absent" | "written" | "unchanged" | "ignored";

/**
 * Apply one change. "unchanged": the row already holds exactly this result (no
 * write is made). "ignored": not a reminder member path, wrong operation or a
 * malformed payload (the stored history keeps the record regardless).
 * Causal staleness is NOT decided here: that is the generic rule in
 * detectAndRecordConflict (database.ts, isCausallyStale).
 */
export function applyReminderChangeDetailed(db: Database, record: ChangeRecord): ReminderApplyResult {
  const memberId = reminderMemberId(record.field_path);
  if (memberId === null) return "ignored";
  const eventId = record.entity_id;
  if (!db.prepare("SELECT 1 FROM events WHERE event_id = ?").get(eventId)) {
    return "target_absent";
  }
  const row = db
    .prepare("SELECT entity_id, minutes_before, enabled, updated_hlc FROM reminders WHERE member_id = ?")
    .get(memberId) as
    | { entity_id: string; minutes_before: number; enabled: number | null; updated_hlc: number }
    | undefined;
  if (record.operation === "member_remove") {
    // Delete by member id, only if it belongs to this event.
    if (row === undefined || row.entity_id !== eventId) return "unchanged";
    deleteReminderRow(db, memberId);
    return "written";
  }
  if (record.operation !== "member_add" && record.operation !== "member_update") return "ignored";
  const v = (record.payload as { value?: { minutes_before?: unknown; enabled?: unknown } }).value;
  if (!v || typeof v !== "object") return "ignored";
  const minutes = v.minutes_before;
  if (typeof minutes !== "number" || !Number.isInteger(minutes) || minutes < 0) return "ignored";
  const enabled = v.enabled !== 0 && v.enabled !== false;
  if (row !== undefined) {
    if (row.entity_id !== eventId) return "ignored"; // a member id owned by another event is left alone
    if (row.minutes_before === minutes && (row.enabled !== 0) === enabled && row.updated_hlc === record.hlc_timestamp) {
      return "unchanged";
    }
  }
  upsertReminderRow(db, { memberId, eventId, minutesBefore: minutes, enabled, hlc: record.hlc_timestamp });
  return "written";
}

/** Mutator form (sync_service.ts): only the absent-target signal is returned. */
export function applyReminderChange(db: Database, record: ChangeRecord): MutateResult {
  return applyReminderChangeDetailed(db, record) === "target_absent" ? "target_absent" : undefined;
}
