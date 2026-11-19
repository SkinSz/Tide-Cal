// Test setup helper: seed an event row (and its calendar) directly, WITHOUT
// writing any change record. Synthetic remote edits for an event are only
// applicable once the event exists locally; seeding the row keeps the change
// history (and every count derived from it) untouched.
import type { Database } from "better-sqlite3";
import { insertEventRow } from "../src/persistence/bridges/event_core.ts";

export function seedEvent(db: Database, eventId: string): void {
  db.prepare(
    `INSERT OR IGNORE INTO calendars (calendar_id, title, color, created_hlc, updated_hlc)
     VALUES ('local', 'My Calendar', NULL, 1, 1)`,
  ).run();
  insertEventRow(
    db,
    {
      id: eventId,
      title: "seed",
      description: "",
      startMs: Date.UTC(2026, 8, 1, 9, 0, 0),
      endMs: Date.UTC(2026, 8, 1, 10, 0, 0),
      allDay: false,
    },
    1,
  );
}
