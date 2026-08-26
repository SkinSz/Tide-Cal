// Tide sync service: bridges the sync engine (DC-08) to the sidecar's
// EventCore so remote change records mutate local entity rows through the
// SAME write path the UI uses (DC-07 T1 atomicity, one row-write shape).
//
// Composition only:
//   engine   src/sync/sync_engine.ts      createSyncEngine().runSession()
//   store    EventCore (this package)     owns the SQLite handle + row writes
//   crypto   noise_transport/pairing_manager/session hosting
import type { Database } from "better-sqlite3";
import { createSyncEngine } from "../../sync/sync_engine.ts";
import type { ChangeRecord } from "../../sync/change_record.ts";
import {
  insertEventRow,
  eventFields,
} from "./event_core.ts";

/**
 * Entity mutation for applied remote changes. Mirrors EventCore's own row
 * writes: an event entity payload {value: CalendarEvent} upserts the row;
 * a remove deletes it. Other entity types are accepted-and-ignored for now
 * (the change record is still stored by applyRemoteChange either way).
 */
export function makeEntityMutator(): (
  db: Database,
  record: ChangeRecord,
) => void {
  return (db, record) => {
    if (record.entity_type !== "event") return;

    if (record.operation === "remove") {
      db.prepare("DELETE FROM events WHERE event_id = ?").run(record.entity_id);
      return;
    }

    const value = (record.payload as { value?: Record<string, unknown> }).value;
    if (!value || typeof value !== "object") return;
    const v = value as {
      id?: string;
      title?: unknown;
      description?: unknown;
      startMs?: unknown;
      endMs?: unknown;
      allDay?: unknown;
    };
    if (
      typeof v.title !== "string" ||
      typeof v.startMs !== "number" ||
      typeof v.endMs !== "number"
    ) {
      return; // malformed; storage layer keeps the raw record regardless
    }
    const allDay = v.allDay === true;
    insertEventRow(
      db,
      {
        id: typeof v.id === "string" ? v.id : record.entity_id,
        title: v.title,
        description: typeof v.description === "string" ? v.description : "",
        startMs: v.startMs,
        endMs: Math.max(v.endMs, v.startMs),
        allDay,
      },
      record.hlc_timestamp,
      true, // upsert
    );
    void eventFields;
  };
}

export interface SyncSessionResult {
  sent: number;
  receivedApplied: number;
  receivedBuffered: number;
  receivedDuplicate: number;
}

export { createSyncEngine };
