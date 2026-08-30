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

/** Existing non-schedule fields of an event row ("" when absent). */
function existingText(db: Database, eventId: string, col: string): string {
  const row = db
    .prepare(`SELECT title, description FROM events WHERE event_id = ?`)
    .get(eventId) as { title: string; description: string } | undefined;
  void col;
  if (!row) return "";
  return col === "title" ? row.title : row.description;
}

/** True when the event row exists locally. */
function eventRowExists(db: Database, eventId: string): boolean {
  return !!db
    .prepare(`SELECT 1 FROM events WHERE event_id = ?`)
    .get(eventId);
}

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

    // Field-level change (DC-01 §2 / EventCore.updateEvent groups):
    //   payload.value is a SCALAR for 'title' | 'description',
    //   an object {startMs,endMs,allDay} for 'schedule',
    //   or the full event object for field_path 'event'.
    if (record.field_path === "title") {
      if (typeof record.payload.value !== "string") return;
      db.prepare(
        "UPDATE events SET title = ?, updated_hlc = ? WHERE event_id = ?",
      ).run(record.payload.value, record.hlc_timestamp, record.entity_id);
      return;
    }
    if (record.field_path === "description") {
      if (typeof record.payload.value !== "string") return;
      db.prepare(
        "UPDATE events SET description = ?, updated_hlc = ? WHERE event_id = ?",
      ).run(record.payload.value, record.hlc_timestamp, record.entity_id);
      return;
    }
    if (record.field_path === "schedule") {
      const v = record.payload.value as
        | { startMs?: unknown; endMs?: unknown; allDay?: unknown }
        | undefined;
      if (
        !v ||
        typeof v.startMs !== "number" ||
        typeof v.endMs !== "number"
      )
        return;
      // Regression fix (allDay-flip crash): derive ALL schema columns
      // (date/wall/tz + utc) consistently via insertEventRow's derivation.
      // The old UPDATE touched only utc_* and all_day, violating the schema
      // CHECK whenever allDay flipped while date/wall columns were non-null.
      if (!eventRowExists(db, record.entity_id)) return; // unknown entity: ignore
      insertEventRow(
        db,
        {
          id: record.entity_id,
          title: existingText(db, record.entity_id, "title"),
          description: existingText(db, record.entity_id, "description"),
          startMs: v.startMs,
          endMs: Math.max(v.endMs, v.startMs),
          allDay: v.allDay === true,
        },
        record.hlc_timestamp,
        true, // upsert
      );
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
