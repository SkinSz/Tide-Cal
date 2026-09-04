// DC-22 reminder member write path: set/clear/create through EventCore.
import { describe, expect, test } from "vitest";
import { EventCore } from "../src/persistence/bridges/event_core.ts";
import { loadOrCreateIdentity } from "../src/network/sync_runtime.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("DC-22: reminder member write path (set/clear replicate as members)", () => {
  test("setReminder adds a member row + change record; clearReminder removes it", () => {
    const dir = mkdtempSync(join(tmpdir(), "tide-rem-"));
    try {
      const identity = loadOrCreateIdentity(dir);
      const core = new EventCore(join(dir, "t.db"), identity.deviceId);
      const startMs = new Date(2026, 8, 10, 9, 0).getTime();
      const created = core.createEvent({
        title: "Gym",
        description: "",
        startMs,
        endMs: startMs + 3_600_000,
        allDay: false,
      });

      // No reminder initially.
      expect(core.reminderFor(created.id)).toBeNull();

      // Set: member row + replicable change record (member_add).
      core.setReminder(created.id, { minutesBefore: 15, enabled: true });
      const rem = core.reminderFor(created.id);
      expect(rem).toEqual({ minutesBefore: 15, enabled: true });

      // Update (same member identity, changed minutes).
      core.setReminder(created.id, { minutesBefore: 30, enabled: true });
      expect(core.reminderFor(created.id)!.minutesBefore).toBe(30);

      // Disabled reminder is stored-but-inactive (D5) and still present.
      core.setReminder(created.id, { minutesBefore: 30, enabled: false });
      expect(core.reminderFor(created.id)).toEqual({ minutesBefore: 30, enabled: false });

      // Clear: member_remove, idempotent.
      core.clearReminder(created.id);
      expect(core.reminderFor(created.id)).toBeNull();
      expect(() => core.clearReminder(created.id)).not.toThrow();

      // Reminder for a nonexistent event is rejected (no orphans).
      expect(() =>
        core.setReminder("evt-nope", { minutesBefore: 5, enabled: true }),
      ).toThrow(/not found/);

      // Negative minutes rejected.
      expect(() =>
        core.setReminder(created.id, { minutesBefore: -1, enabled: true }),
      ).toThrow(/non-negative/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
