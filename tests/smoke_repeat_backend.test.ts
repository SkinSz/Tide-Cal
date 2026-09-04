// Smoke-test follow-up: does a CREATE-time RRULE actually land in the series
// table through the domain core (the Rust shell now forwards recurrence_rule)?
import { describe, expect, test } from "vitest";
import { EventCore } from "../src/persistence/bridges/event_core.ts";
import {
  loadOrCreateIdentity,
} from "../src/network/sync_runtime.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expandOccurrences } from "../src/domain/recurrence_conflicts.ts";

describe("smoke bug: create-time repeat rule reaches the backend", () => {
  test("createEvent with recurrenceRule creates a series row + expands in month view", () => {
    const dir = mkdtempSync(join(tmpdir(), "tide-repeat-"));
    try {
      const identity = loadOrCreateIdentity(dir);
      const core = new EventCore(join(dir, "t.db"), identity.deviceId);
      const startMs = new Date(2026, 8, 10, 9, 0).getTime(); // Sep 10 09:00
      const created = core.createEvent({
        title: "Gym",
        description: "",
        startMs,
        endMs: startMs + 3_600_000,
        allDay: false,
        recurrenceRule: "FREQ=DAILY;UNTIL=20260920",
      });
      // Series row exists with the rule.
      const series = core.listSeries();
      expect(series).toHaveLength(1);
      expect(series[0]!.baseEventId).toBe(created.id);
      expect(series[0]!.recurrenceRule).toBe("FREQ=DAILY;UNTIL=20260920");
      // Expansion over a September window yields daily occurrences.
      const base = new Date(startMs);
      const wall = `${base.getFullYear()}-${String(base.getMonth() + 1).padStart(2, "0")}-${String(base.getDate()).padStart(2, "0")}T09:00`;
      const occIds = expandOccurrences(
        {
          series_id: series[0]!.seriesId,
          base_start_wall: wall,
          tz_id: "local",
          recurrence_rule: series[0]!.recurrenceRule,
        },
        "20260901T000000",
        "20260930T235959",
      );
      expect(occIds.length).toBe(11); // Sep 10..20 inclusive
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
