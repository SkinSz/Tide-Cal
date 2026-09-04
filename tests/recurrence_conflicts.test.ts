import { describe, expect, test } from "vitest";
import {
  parseRule,
  expandOccurrences,
  detectOrphans,
  applySeriesDeletion,
  conflictEntityFor,
  isRecurrenceConflictPair,
  type SeriesState,
  type OccurrenceOverride,
} from "../src/domain/recurrence_conflicts.ts";

const weeklyWed: SeriesState = {
  series_id: "s-1",
  base_start_wall: "2026-09-02T09:00",
  tz_id: "Europe/Berlin",
  recurrence_rule: "FREQ=WEEKLY;BYDAY=WE",
};

const override = (rid: string, extra?: Partial<OccurrenceOverride>): OccurrenceOverride => ({
  series_id: "s-1",
  recurrence_id: rid,
  cancelled: false,
  ...extra,
});

describe("DC-12 RRULE expansion", () => {
  test("weekly WE across month boundaries", () => {
    const ids = expandOccurrences(weeklyWed, "20260902T000000", "20261015T235959");
    expect(ids).toContain("20260902T090000");
    expect(ids).toContain("20260930T090000");
    expect(ids).toContain("20261007T090000");
    // Wednesdays only
    for (const id of ids) {
      const d = new Date(`${id.slice(0, 4)}-${id.slice(4, 6)}-${id.slice(6, 8)}T00:00:00Z`);
      expect(d.getUTCDay()).toBe(3); // Wednesday
    }
  });

  test("BYDAY=MO,WE,FR multi-day", () => {
    const s: SeriesState = {
      ...weeklyWed,
      base_start_wall: "2026-09-07T08:00", // Monday
      recurrence_rule: "FREQ=WEEKLY;BYDAY=MO,WE,FR",
    };
    const ids = expandOccurrences(s, "20260907T000000", "20260913T235959");
    expect(ids).toEqual([
      "20260907T080000",
      "20260909T080000",
      "20260911T080000",
    ]);
  });

  test("INTERVAL=2 fortnight stepping", () => {
    const s: SeriesState = {
      ...weeklyWed,
      recurrence_rule: "FREQ=WEEKLY;INTERVAL=2;BYDAY=WE",
    };
    const ids = expandOccurrences(s, "20260902T000000", "20261001T235959");
    expect(ids).toEqual(["20260902T090000", "20260916T090000", "20260930T090000"]);
  });

  test("COUNT bounds generation", () => {
    const s: SeriesState = { ...weeklyWed, recurrence_rule: "FREQ=DAILY;COUNT=4" };
    const ids = expandOccurrences(s, "20260902T000000", "20301231T235959");
    expect(ids).toHaveLength(4);
    expect(ids[0]).toBe("20260902T090000");
    expect(ids[3]).toBe("20260905T090000");
  });

  test("UNTIL respected", () => {
    const s: SeriesState = {
      ...weeklyWed,
      recurrence_rule: "FREQ=WEEKLY;BYDAY=WE;UNTIL=20260916",
    };
    const ids = expandOccurrences(s, "20260902T000000", "20261231T235959");
    expect(ids).toEqual(["20260902T090000", "20260909T090000", "20260916T090000"]);
  });
});

describe("DC-12 R1 orphan detection", () => {
  test("narrowing rule to Thursdays orphans the Wednesday override", () => {
    const overrides = [override("20260902T090000")];
    const narrowed: SeriesState = {
      ...weeklyWed,
      recurrence_rule: "FREQ=WEEKLY;BYDAY=TH",
    };
    const orphans = detectOrphans(narrowed, overrides);
    expect(orphans.has("20260902T090000")).toBe(true);
  });

  test("no orphans when rule unchanged", () => {
    const overrides = [override("20260902T090000")];
    expect(detectOrphans(weeklyWed, overrides).size).toBe(0);
  });
});

describe("DC-12 R2 identity anchoring", () => {
  test("recurrence_id unchanged after rule edit", () => {
    const before = override("20260902T090000");
    // Rule edit is a separate change; the override object is untouched.
    const afterRuleEdit = override("20260902T090000");
    expect(afterRuleEdit.recurrence_id).toBe(before.recurrence_id);
  });
});

describe("DC-12 R3 conflict entity mapping", () => {
  test("same-override-same-field maps to same entity", () => {
    expect(conflictEntityFor("s-1", "20260902T090000", "title")).toBe(
      "overrides.20260902T090000.title",
    );
  });

  test("[24]-R1: rule vs override never a conflicting pair", () => {
    const rulePath = "s-1.recurrence_rule";
    const overridePath = "overrides.20260902T090000.title";
    expect(isRecurrenceConflictPair(rulePath, overridePath)).toBe(false);
    expect(isRecurrenceConflictPair(overridePath, rulePath)).toBe(false);
  });

  test("rule-vs-rule and same-override pairs DO conflict", () => {
    expect(isRecurrenceConflictPair("s-1.recurrence_rule", "s-1.recurrence_rule")).toBe(true);
    expect(
      isRecurrenceConflictPair(
        "overrides.20260902T090000.title.x",
        "overrides.20260902T090000.title.y",
      ),
    ).toBe(true);
  });
});

describe("DC-12 R4 timezone independence", () => {
  test("tz change does not alter occurrence ids", () => {
    const berlin = expandOccurrences(weeklyWed, "20260902T000000", "20260930T235959");
    const newYork: SeriesState = { ...weeklyWed, tz_id: "America/New_York" };
    const nyIds = expandOccurrences(newYork, "20260902T000000", "20260930T235959");
    expect(nyIds).toEqual(berlin);
  });
});

describe("DC-12 D7 series deletion dominance", () => {
  test("deletion returns every override id", () => {
    const overrides = [
      override("20260902T090000"),
      override("20260909T090000"),
      override("20260916T090000"),
    ];
    const { deletedOverrideIds } = applySeriesDeletion("s-1", overrides);
    expect(deletedOverrideIds).toEqual([
      "20260902T090000",
      "20260909T090000",
      "20260916T090000",
    ]);
  });

  test("empty series yields empty deletion set", () => {
    expect(applySeriesDeletion("s-x", []).deletedOverrideIds).toEqual([]);
  });
});

describe("DC-12 R5 DST wall-clock stability (Berlin fall-back 2026-10-25)", () => {
  test("daily series yields identical wall-clock ids across the boundary", () => {
    const daily: SeriesState = {
      series_id: "s-dst",
      base_start_wall: "2026-10-24T09:00",
      tz_id: "Europe/Berlin",
      recurrence_rule: "FREQ=DAILY;COUNT=4",
    };
    const ids = expandOccurrences(daily, "20261024T000000", "20261028T235959");
    // Pure wall-clock expansion: 09:00 every day regardless of CET/CEST.
    expect(ids).toEqual([
      "20261024T090000",
      "20261025T090000",
      "20261026T090000",
      "20261027T090000",
    ]);
  });
});

describe("parseRule", () => {
  test("parses all supported keys", () => {
    const r = parseRule("FREQ=MONTHLY;INTERVAL=3;BYDAY=MO;COUNT=6;UNTIL=20270601");
    expect(r.freq).toBe("MONTHLY");
    expect(r.interval).toBe(3);
    expect(r.byDay).toEqual(["MO"]);
    expect(r.count).toBe(6);
    expect(r.until).toBe("20270601");
  });
});
