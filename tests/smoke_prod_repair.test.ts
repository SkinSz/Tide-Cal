// Runtime proof: the REAL production DB (stamped v7, missing columns) is
// repaired by the initializeSchema repair path — set_reminder works after.
import { expect, test } from "vitest";
import { EventCore } from "../src/persistence/bridges/event_core.ts";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PROD_DB = "/home/skins/.local/share/com.tide.app/tide-domain.db";

test("prod DB (v7, missing columns) repaired on open; set_reminder succeeds", () => {
  const dir = mkdtempSync(join(tmpdir(), "tide-prod-repair-"));
  try {
    const dbPath = join(dir, "tide-domain.db");
    copyFileSync(PROD_DB, dbPath);
    for (const ext of ["-wal", "-shm"]) {
      try { copyFileSync(PROD_DB + ext, dbPath + ext); } catch { /* none */ }
    }
    const core = new EventCore(dbPath, "d-repair-test");
    // Columns now exist:
    const remCols = (core.db.prepare("PRAGMA table_info(reminders)").all() as Array<{ name: string }>).map((c) => c.name);
    expect(remCols).toContain("enabled");
    // Existing events intact:
    const events = core.listEvents();
    expect(events.length).toBeGreaterThan(0);
    // The exact operation that failed in the GUI ("table reminders has no
    // column named enabled") now succeeds:
    const first = events[0]!;
    core.setReminder(first.id, { minutesBefore: 15, enabled: true });
    expect(core.reminderFor(first.id)).toEqual({ minutesBefore: 15, enabled: true });
    core.clearReminder(first.id);
    expect(core.reminderFor(first.id)).toBeNull();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
