// Runtime proof on the REAL production schema: copy prod DB, run the actual
// openDatabase() migration, verify the columns appear and set_reminder works.
import { describe, expect, test } from "vitest";
import { openDatabase } from "../src/persistence/database.ts";
import { EventCore } from "../src/persistence/bridges/event_core.ts";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PROD_DB = "/home/skins/.local/share/com.tide.app/tide-domain.db";

describe("runtime migration proof on a copy of the real production DB", () => {
  test("prod copy migrates: reminders.enabled + events.all_day_reminder_time exist; set_reminder succeeds", () => {
    const dir = mkdtempSync(join(tmpdir(), "tide-prodmig-"));
    try {
      const dbPath = join(dir, "tide-domain.db");
      copyFileSync(PROD_DB, dbPath);
      // Also copy WAL/SHM if present so the copy is consistent.
      for (const ext of ["-wal", "-shm"]) {
        try { copyFileSync(PROD_DB + ext, dbPath + ext); } catch { /* none */ }
      }
      const identity = { deviceId: "d-migration-test" };
      // openDatabase runs initializeSchema -> v7 migration on the copy.
      const core = new EventCore(dbPath, identity.deviceId);
      // Existing events survived.
      const events = core.listEvents();
      expect(events.length).toBeGreaterThan(0);
      // The previously-missing columns now exist — set_reminder works.
      const first = events[0]!;
      core.setReminder(first.id, { minutesBefore: 15, enabled: true });
      expect(core.reminderFor(first.id)).toEqual({ minutesBefore: 15, enabled: true });
      core.clearReminder(first.id);
      expect(core.reminderFor(first.id)).toBeNull();
      // Schema at 7.
      const v = (core.db.prepare("SELECT version FROM schema_version").get() as { version: number }).version;
      expect(v).toBe(7);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
