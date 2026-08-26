// Tide bridge: calendar event storage wired through the TS domain core.
//
// This is the desktop-runtime adapter between the shell-local event CRUD
// surface (Tauri commands / sidecar protocol) and the approved DC-07
// transactional core in src/persistence/database.ts. All mutations go
// through createLocalChange(), so every entity mutation lands atomically
// with its change record and the device_clock advance (DC-07 §7 T1).
// The domain core itself is NOT modified — this file only supplies the
// entity-row `mutate` callbacks and the mapping to/from CalendarEvent.

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { openDatabase, createLocalChange } from "../database.ts";

export interface CalendarEvent {
  id: string;
  title: string;
  description: string;
  /** epoch ms */
  startMs: number;
  /** epoch ms */
  endMs: number;
  allDay: boolean;
}

export interface EventInput {
  title: string;
  description: string;
  startMs: number;
  endMs: number;
  allDay: boolean;
}

const DEFAULT_CALENDAR_ID = "local";

/**
 * Monotone hybrid-logical-clock ticker (ms resolution, presentation-only
 * per DC-01 §4.4). Never goes backwards within a process lifetime.
 */
export class HlcTicker {
  private last = 0;

  now(): number {
    const wall = Date.now();
    this.last = wall > this.last ? wall : this.last + 1;
    return this.last;
  }
}

function loadOrCreateDeviceId(dbPath: string): string {
  const marker = `${dbPath}.device_id`;
  if (existsSync(marker)) {
    return readFileSync(marker, "utf8").trim();
  }
  const id = `dev-${randomUUID()}`;
  writeFileSync(marker, id, "utf8");
  return id;
}

/** Local-timezone calendar day (YYYY-MM-DD) for an epoch-ms instant. */
function localDateStr(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Local wall-clock time HH:MM:SS for an epoch-ms instant. */
function localWallStr(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function timezoneId(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

interface EventRow {
  event_id: string;
  title: string;
  description: string;
  all_day: number;
  start_date: string | null;
  end_date: string | null;
  start_wall: string | null;
  end_wall: string | null;
  utc_start_ms: number | null;
  utc_end_ms: number | null;
}

export class EventCore {
  readonly db: ReturnType<typeof openDatabase>;
  private readonly deviceId: string;
  private readonly hlc = new HlcTicker();

  constructor(dbPath: string) {
    this.db = openDatabase({ path: dbPath });
    this.deviceId = loadOrCreateDeviceId(dbPath);
    this.ensureDefaultCalendar();
  }

  get selfDeviceId(): string {
    return this.deviceId;
  }

  /**
   * Bootstrap the shell-local calendar through the same T1 path so even
   * this bootstrap produces an auditable change record.
   */
  private ensureDefaultCalendar(): void {
    const hlc = this.hlc.now();
    createLocalChange(
      this.db,
      this.deviceId,
      {
        entity_id: DEFAULT_CALENDAR_ID,
        entity_type: "calendar",
        field_path: "title",
        operation: "set",
        payload: { value: "My Calendar" },
        hlc_now: () => hlc,
      },
      (db) => {
        db.prepare(
          `INSERT INTO calendars (calendar_id, title, color, created_hlc, updated_hlc)
           VALUES (?, ?, NULL, ?, ?)
           ON CONFLICT(calendar_id) DO NOTHING`,
        ).run(DEFAULT_CALENDAR_ID, "My Calendar", hlc, hlc);
      },
    );
  }

  listEvents(range?: { fromMs?: number | null; toMs?: number | null }): CalendarEvent[] {
    let rows: EventRow[];
    if (range?.fromMs != null && range?.toMs != null) {
      rows = this.db
        .prepare<[number, number], EventRow>(
          `SELECT event_id, title, description, all_day, start_date, end_date,
                  start_wall, end_wall, utc_start_ms, utc_end_ms
           FROM events WHERE utc_start_ms IS NOT NULL
             AND utc_start_ms < ? AND utc_end_ms > ?
           ORDER BY utc_start_ms`,
        )
        .all(range.toMs, range.fromMs);
    } else {
      rows = this.db
        .prepare<[], EventRow>(
          `SELECT event_id, title, description, all_day, start_date, end_date,
                  start_wall, end_wall, utc_start_ms, utc_end_ms
           FROM events ORDER BY utc_start_ms`,
        )
        .all();
    }
    return rows.map(rowToEvent).sort(byStart);
  }

  createEvent(input: EventInput): CalendarEvent {
    const event: CalendarEvent = {
      id: `evt-${randomUUID()}`,
      ...input,
    };
    const hlc = this.hlc.now();
    createLocalChange(
      this.db,
      this.deviceId,
      {
        entity_id: event.id,
        entity_type: "event",
        field_path: "event",
        operation: "set",
        payload: { value: eventFields(event) },
        hlc_now: () => hlc,
      },
      (db, _record) => {
        insertEventRow(db, event, hlc);
      },
    );
    return event;
  }

  updateEvent(id: string, input: EventInput): CalendarEvent {
    const existing = this.getEventRow(id);
    if (!existing) throw new Error(`event not found: ${id}`);
    const before = rowToEvent(existing);

    // One T1 record per logical field group that actually changed
    // (DC-01 field-level semantics: title / description / schedule).
    const groups: Array<{
      field_path: string;
      value: unknown;
      changed: boolean;
    }> = [
      {
        field_path: "title",
        value: input.title,
        changed: before.title !== input.title,
      },
      {
        field_path: "description",
        value: input.description,
        changed: before.description !== input.description,
      },
      {
        field_path: "schedule",
        value: { startMs: input.startMs, endMs: input.endMs, allDay: input.allDay },
        changed:
          before.startMs !== input.startMs ||
          before.endMs !== input.endMs ||
          before.allDay !== input.allDay,
      },
    ];

    for (const g of groups.filter((g) => g.changed)) {
      const hlc = this.hlc.now();
      createLocalChange(
        this.db,
        this.deviceId,
        {
          entity_id: id,
          entity_type: "event",
          field_path: g.field_path,
          operation: "set",
          payload: { value: g.value },
          hlc_now: () => hlc,
        },
        (db) => {
          // Row rewrite inside the same transaction as each change record;
          // updated_hlc mirrors the record's HLC timestamp.
          insertEventRow(
            db,
            { id, ...input },
            hlc,
            true,
          );
        },
      );
    }
    return { id, ...input };
  }

  deleteEvent(id: string): void {
    const existing = this.getEventRow(id);
    if (!existing) return; // idempotent delete, matches shell-store behavior
    const hlc = this.hlc.now();
    createLocalChange(
      this.db,
      this.deviceId,
      {
        entity_id: id,
        entity_type: "event",
        field_path: "*",
        operation: "remove",
        payload: {},
        hlc_now: () => hlc,
      },
      (db) => {
        db.prepare("DELETE FROM events WHERE event_id = ?").run(id);
      },
    );
  }

  private getEventRow(id: string): EventRow | undefined {
    return this.db
      .prepare<[string], EventRow>(
        `SELECT event_id, title, description, all_day, start_date, end_date,
                start_wall, end_wall, utc_start_ms, utc_end_ms
         FROM events WHERE event_id = ?`,
      )
      .get(id);
  }
}

function eventFields(e: CalendarEvent) {
  return {
    title: e.title,
    description: e.description,
    startMs: e.startMs,
    endMs: e.endMs,
    allDay: e.allDay,
  };
}

function insertEventRow(
  db: ReturnType<typeof openDatabase>,
  e: CalendarEvent,
  hlc: number,
  upsert = false,
): void {
  const sql = upsert
    ? `INSERT INTO events (event_id, calendar_id, title, description, all_day,
           start_date, end_date, start_wall, end_wall, tz_id,
           utc_start_ms, utc_end_ms, created_hlc, updated_hlc)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(event_id) DO UPDATE SET
           title = excluded.title, description = excluded.description,
           all_day = excluded.all_day, start_date = excluded.start_date,
           end_date = excluded.end_date, start_wall = excluded.start_wall,
           end_wall = excluded.end_wall, utc_start_ms = excluded.utc_start_ms,
           utc_end_ms = excluded.utc_end_ms, updated_hlc = excluded.updated_hlc`
    : `INSERT INTO events (event_id, calendar_id, title, description, all_day,
           start_date, end_date, start_wall, end_wall, tz_id,
           utc_start_ms, utc_end_ms, created_hlc, updated_hlc)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

  db.prepare(sql).run(
    e.id,
    DEFAULT_CALENDAR_ID,
    e.title,
    e.description,
    e.allDay ? 1 : 0,
    e.allDay ? localDateStr(e.startMs) : null,
    e.allDay ? localDateStr(Math.max(e.endMs, e.startMs)) : null,
    e.allDay ? null : localWallStr(e.startMs),
    e.allDay ? null : localWallStr(e.endMs),
    e.allDay ? null : timezoneId(),
    e.startMs,
    Math.max(e.endMs, e.startMs),
    hlc,
    hlc,
  );
}

function rowToEvent(r: EventRow): CalendarEvent {
  let startMs = r.utc_start_ms;
  let endMs = r.utc_end_ms;
  if (startMs == null || endMs == null) {
    // Legacy rows written by the pre-core shell store have no UTC columns;
    // reconstruct from wall/date fields in the local zone.
    if (r.all_day && r.start_date && r.end_date) {
      startMs = new Date(`${r.start_date}T00:00:00`).getTime();
      endMs = new Date(`${r.end_date}T23:59:59.999`).getTime();
    } else if (r.start_wall && r.end_wall && r.start_date) {
      startMs = new Date(`${r.start_date}T${r.start_wall}`).getTime();
      endMs = new Date(`${r.start_date}T${r.end_wall}`).getTime();
    } else {
      startMs = 0;
      endMs = 0;
    }
  }
  return {
    id: r.event_id,
    title: r.title,
    description: r.description,
    startMs: startMs!,
    endMs: endMs!,
    allDay: r.all_day !== 0,
  };
}

function byStart(a: CalendarEvent, b: CalendarEvent): number {
  return a.startMs - b.startMs || a.title.localeCompare(b.title);
}
