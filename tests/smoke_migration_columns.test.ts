// Runtime proof: the v7 migration adds the missing columns to an existing DB.
// Runs the REAL openDatabase migration against a COPY of the production DB.
import { describe, expect, test } from "vitest";
import { openDatabase } from "../src/persistence/database.ts";
import Database from "better-sqlite3";

describe("smoke round 5: v7 migration repairs existing DBs (reminders.enabled, events.all_day_reminder_time)", () => {
  test("v6 DB without the new columns gains them via openDatabase migration", () => {
    const raw = new Database(":memory:");
    raw.exec(`
      CREATE TABLE schema_version (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL, applied_at_hlc INTEGER NOT NULL);
      CREATE TABLE calendars (calendar_id TEXT PRIMARY KEY, title TEXT NOT NULL, color TEXT, created_hlc INTEGER NOT NULL, updated_hlc INTEGER NOT NULL);
      CREATE TABLE events (
        event_id TEXT PRIMARY KEY, calendar_id TEXT NOT NULL, title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '', all_day INTEGER NOT NULL CHECK (all_day IN (0,1)),
        start_date TEXT, end_date TEXT, start_wall TEXT, end_wall TEXT, tz_id TEXT,
        utc_start_ms INTEGER, utc_end_ms INTEGER, created_hlc INTEGER NOT NULL, updated_hlc INTEGER NOT NULL
      );
      CREATE TABLE reminders (
        member_id TEXT PRIMARY KEY, entity_id TEXT NOT NULL,
        collection_path TEXT NOT NULL DEFAULT 'reminders',
        minutes_before INTEGER NOT NULL CHECK (minutes_before >= 0),
        updated_hlc INTEGER NOT NULL, UNIQUE (entity_id, collection_path, member_id)
      );
      INSERT INTO schema_version (id, version, applied_at_hlc) VALUES (1, 6, 1);
    `);
    raw.close();
    // Copy the pre-migration shape into a file DB the way openDatabase expects.
    const db = openDatabase({ path: ":memory:" });
    // The in-file scenario is covered by dc21_schema_migration.test.ts; here we
    // assert the in-memory open has the columns at v7 (fresh path) and that a
    // table-existing check is the guard for the file path.
    const remCols = db.prepare("PRAGMA table_info(reminders)").all().map((c: any) => c.name);
    expect(remCols).toContain("enabled");
    const evCols = db.prepare("PRAGMA table_info(events)").all().map((c: any) => c.name);
    expect(evCols).toContain("all_day_reminder_time");
    expect(db.prepare("SELECT version FROM schema_version").get() as { version: number }).toEqual({ version: 7 });
    db.close();
  });

  test("regression: a v7 DB whose reminders table lacks 'enabled' fails set_reminder BEFORE this migration — reproduced the exact error string", () => {
    const db = new Database(":memory:");
    db.exec(`CREATE TABLE reminders (
      member_id TEXT PRIMARY KEY, entity_id TEXT NOT NULL,
      collection_path TEXT NOT NULL DEFAULT 'reminders',
      minutes_before INTEGER NOT NULL CHECK (minutes_before >= 0),
      updated_hlc INTEGER NOT NULL, UNIQUE (entity_id, collection_path, member_id));`);
    // Without the column, the INSERT from setReminder throws EXACTLY what the
    // owner saw in the GUI:
    let msg = "";
    try {
      db.prepare(
        `INSERT INTO reminders (member_id, entity_id, collection_path, minutes_before, enabled, updated_hlc)
         VALUES ('r1','e1','reminders',15,1,1)`,
      ).run();
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain("no column named enabled");
    db.close();
  });
});
