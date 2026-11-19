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
  deleteEventRows,
  DEFAULT_CALENDAR_ID,
  OVERRIDE_FIELDS,
} from "./event_core.ts";
import { prerequisiteState } from "../database.ts";
import { applyReminderChange } from "./reminder_apply.ts";
import { replayReminderHistory } from "../reminder_replay.ts";
import type { EntityMutator, MutateResult } from "../database.ts";

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

/** Edit/remove of an entity row that is not here (decision: see MutateResult). */
const ABSENT = "target_absent" as const;
const OVERRIDE_FIELD_SET: ReadonlySet<string> = new Set(OVERRIDE_FIELDS);

function seriesRowExists(db: Database, seriesId: string): boolean {
  return !!db.prepare("SELECT 1 FROM series WHERE series_id = ?").get(seriesId);
}

/** Series, occurrence overrides and calendars: the same row writes as EventCore's local paths. */
function applySeries(db: Database, record: ChangeRecord): MutateResult {
  const id = record.entity_id;
  if (record.operation === "remove") {
    if (seriesRowExists(db, id)) {
      db.prepare("DELETE FROM occurrence_overrides WHERE series_id = ?").run(id);
      db.prepare("DELETE FROM series WHERE series_id = ?").run(id);
      return;
    }
    return ABSENT;
  }
  if (record.field_path !== "recurrence_rule") return;
  const p = record.payload as { value?: unknown; base_event_id?: unknown };
  if (typeof p.value !== "string") return;
  if (typeof p.base_event_id === "string") {
    // Creating change (carries the base event id, like the local INSERT).
    if (seriesRowExists(db, id)) return;
    if (!eventRowExists(db, p.base_event_id)) {
      return ABSENT; // the base event is gone: nothing to attach the series to
    }
    if (db.prepare("SELECT 1 FROM series WHERE base_event_id = ?").get(p.base_event_id)) return;
    db.prepare(
      `INSERT INTO series (series_id, base_event_id, recurrence_rule, created_hlc, updated_hlc)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(id, p.base_event_id, p.value, record.hlc_timestamp, record.hlc_timestamp);
    return;
  }
  // Rule edit (updateSeriesRule): UPDATE of the existing row. Without a
  // base_event_id an absent row is either an old-format series create (written
  // before the field existed) or an edit of a deleted series: not
  // distinguishable, so both follow the one rule (counted done, no row).
  if (!seriesRowExists(db, id)) return ABSENT;
  db.prepare("UPDATE series SET recurrence_rule = ?, updated_hlc = ? WHERE series_id = ?").run(
    p.value,
    record.hlc_timestamp,
    id,
  );
}

function applyOverride(db: Database, record: ChangeRecord): MutateResult {
  const m = /^overrides\.([^.]+)\.([a-z_]+)$/.exec(record.field_path);
  if (!m || record.operation !== "set") return;
  const [, rid, field] = m as unknown as [string, string, string];
  if (!OVERRIDE_FIELD_SET.has(field)) return;
  const seriesId = record.entity_id;
  if (!seriesRowExists(db, seriesId)) return ABSENT;
  const value = (record.payload as { value?: unknown }).value;
  const col = field === "cancelled" ? (value === true ? 1 : value === false ? 0 : null) : value;
  if (col === null && field === "cancelled") return;
  if (field !== "cancelled" && typeof col !== "string") return;
  db.prepare(
    `INSERT INTO occurrence_overrides (series_id, recurrence_id, updated_hlc)
     VALUES (?, ?, ?) ON CONFLICT(series_id, recurrence_id) DO NOTHING`,
  ).run(seriesId, rid, record.hlc_timestamp);
  db.prepare(
    `UPDATE occurrence_overrides SET ${field} = ?, updated_hlc = ?
     WHERE series_id = ? AND recurrence_id = ?`,
  ).run(col, record.hlc_timestamp, seriesId, rid);
}

function applyCalendar(db: Database, record: ChangeRecord): MutateResult {
  if (record.operation !== "set") return;
  if (record.field_path !== "title" && record.field_path !== "color") return;
  const value = (record.payload as { value?: unknown }).value;
  if (typeof value !== "string" && !(record.field_path === "color" && value === null)) return;
  const id = record.entity_id;
  const exists = !!db.prepare("SELECT 1 FROM calendars WHERE calendar_id = ?").get(id);
  if (exists) {
    db.prepare(`UPDATE calendars SET ${record.field_path} = ?, updated_hlc = ? WHERE calendar_id = ?`).run(
      value,
      record.hlc_timestamp,
      id,
    );
    return;
  }
  // A title set on an absent calendar is how a calendar is created
  // (EventCore.ensureDefaultCalendar), but a rename has the same shape. So a
  // title set creates the row only when every change it cites is already in
  // and none of another device's cited changes was rejected; otherwise it may
  // be a rename whose create is still on its way or was rejected (ABSENT makes
  // applyRemoteChangeDetailed hold or quarantine it by the one rule). The
  // creator's own earlier changes never block its create. A color set on an
  // absent calendar is an edit of a missing target.
  if (record.field_path !== "title") return ABSENT;
  const pre = prerequisiteState(db, record, { rejectionIgnoresOwnOrigin: true });
  if (pre.missingOrigin !== null || pre.rejectedPrerequisite) return ABSENT;
  db.prepare(
    `INSERT INTO calendars (calendar_id, title, color, created_hlc, updated_hlc)
     VALUES (?, ?, NULL, ?, ?) ON CONFLICT(calendar_id) DO NOTHING`,
  ).run(id, value, record.hlc_timestamp, record.hlc_timestamp);
}

/**
 * Entity mutation for applied remote changes. Mirrors the row writes of
 * EventCore: event / series / occurrence_override / calendar changes write
 * their rows. Returns "target_absent" for an edit or remove whose target row is
 * missing; applyRemoteChangeDetailed decides what that means (readiness is
 * checked before the mutator runs). Reminder changes are applied by
 * applyReminderChange (target = the event row, same prerequisite rule). Other
 * entity types are still accepted-and-ignored.
 */
export function makeEntityMutator(): EntityMutator {
  return (db, record) => {
    if (record.entity_type === "series") return applySeries(db, record);
    if (record.entity_type === "occurrence_override") return applyOverride(db, record);
    if (record.entity_type === "calendar") return applyCalendar(db, record);
    if (record.entity_type === "reminder") return applyReminderChange(db, record);
    if (record.entity_type !== "event") return;

    const absent = (): MutateResult => ABSENT;

    if (record.operation === "remove") {
      if (!eventRowExists(db, record.entity_id)) return absent();
      const series = db
        .prepare("SELECT series_id FROM series WHERE base_event_id = ?")
        .get(record.entity_id) as { series_id: string } | undefined;
      deleteEventRows(db, record.entity_id, series?.series_id);
      return;
    }

    // Field-level change (DC-01 §2 / EventCore.updateEvent groups):
    //   payload.value is a SCALAR for 'title' | 'description',
    //   an object {startMs,endMs,allDay} for 'schedule',
    //   or the full event object for field_path 'event'.
    if (record.field_path === "title") {
      if (typeof record.payload.value !== "string") return;
      if (!eventRowExists(db, record.entity_id)) return absent();
      db.prepare(
        "UPDATE events SET title = ?, updated_hlc = ? WHERE event_id = ?",
      ).run(record.payload.value, record.hlc_timestamp, record.entity_id);
      return;
    }
    if (record.field_path === "description") {
      if (typeof record.payload.value !== "string") return;
      if (!eventRowExists(db, record.entity_id)) return absent();
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
      if (!eventRowExists(db, record.entity_id)) return absent();
      // Regression fix (allDay-flip crash): derive ALL schema columns
      // (date/wall/tz + utc) consistently via insertEventRow's derivation.
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
    // An event row references its calendar (events.calendar_id, always the
    // default calendar today: change records carry no calendar id). A missing
    // calendar would fail the foreign key; treat it as a missing target so the
    // one prerequisite rule decides (hold, or counted done).
    if (!db.prepare("SELECT 1 FROM calendars WHERE calendar_id = ?").get(DEFAULT_CALENDAR_ID)) {
      return ABSENT;
    }
    const restoring = !eventRowExists(db, record.entity_id);
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
    // An event row that comes back (e.g. a conflict resolution that keeps the
    // edit over a delete) brings its reminders back: the delete removed them
    // locally, their changes are still in history. Same replay as startup,
    // scoped to this event.
    if (restoring) replayReminderHistory(db, { eventId: record.entity_id });
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
