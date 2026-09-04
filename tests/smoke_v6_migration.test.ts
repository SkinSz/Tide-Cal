// Runtime proof: a DB stamped version=6 (no new columns) gains them via the
// openDatabase() migration. The prod-copy simulation lives at /tmp/tide-v6-copy.db
// (created by the test itself: copies the real prod DB, downgrades to v6).
import { expect, test } from "vitest";
import { openDatabase } from "../src/persistence/database.ts";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PROD_DB = "/home/skins/.local/share/com.tide.app/tide-domain.db";

test("v6-stamped prod copy migrates: reminders.enabled + events.all_day_reminder_time appear", () => {
  const dir = mkdtempSync(join(tmpdir(), "tide-v6-"));
  try {
    const dbPath = join(dir, "tide.db");
    copyFileSync(PROD_DB, dbPath);
    for (const ext of ["-wal", "-shm"]) {
      try { copyFileSync(PROD_DB + ext, dbPath + ext); } catch { /* none */ }
    }
    // Stamp it as v6: the exact state of a DB created before DC-22.
    const raw = new Database(dbPath);
    raw.prepare("UPDATE schema_version SET version = 6").run();
    raw.close();

    const db = openDatabase({ path: dbPath });
    const remCols = (db.prepare("PRAGMA table_info(reminders)").all() as Array<{ name: string }>).map((c) => c.name);
    expect(remCols).toContain("enabled");
    const evCols = (db.prepare("PRAGMA table_info(events)").all() as Array<{ name: string }>).map((c) => c.name);
    expect(evCols).toContain("all_day_reminder_time");
    const v = db.prepare("SELECT version FROM schema_version").get() as { version: number };
    expect(v.version).toBe(7);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
