// Tide DC-22: reminder member write path (domain core methods).
//
// A reminder is a COLLECTION MEMBER (DC-07 `reminders` row: member_id UUIDv4,
// owning entity_id, minutes_before >= 0, enabled NULL/1). Reminder membership
// replicates like every other collection member (D5): disabled reminders are
// stored-but-inactive and still merge. The fire schedule is derived (DC-22
// §3.1/D8) and delivery is an ephemeral local side effect (D9) — nothing here
// schedules anything. All writes go through EventCore's createLocalChange (T1).

import { randomUUID } from "node:crypto";

export interface EventReminder {
  minutesBefore: number;
  enabled: boolean;
}

/** EventCore method implementations, mixed in via prototype assignment. */
export function wireReminderMembers(
  core: { db: import("better-sqlite3").Database; deviceId: string; hlc: { now(): number } },
): void {
  // Kept as a free function for clarity; actual methods are defined on
  // EventCore in event_core.ts (reminderFor / setReminder / clearReminder).
  void core;
}

export function newReminderMemberId(): string {
  return `rem-${randomUUID()}`;
}
