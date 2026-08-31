// DC-12 recurrence EDITING — user-facing rule builder + occurrence-scope
// helpers (frontend/recurrence_edit.ts). Pure, DOM-free:
//   * buildRRule: draft -> RFC 5545 RRULE (verbatim-storable, DC-12 §2.1);
//     WEEKLY defaults to the base date's weekday; NONE -> null (plain event)
//   * draftFromRule: builder-subset round-trip; COUNT/UNTIL/BYSETPOS rules
//     yield null so the dialog keeps the raw rule instead of misrepresenting
//   * deriveRecurrenceId: canonical "YYYYMMDDTHHMMSS" wall-clock form
//     (DC-12 §2.3), midnight convention for all-day series
//   * wallStamp: "YYYY-MM-DDTHH:MM" override wall form (DC-12 §5.3)
//   * R6: no "this and following" — no truncate/spawn API exists here at all
import { describe, expect, test } from "vitest";
import {
  buildRRule,
  draftFromRule,
  deriveRecurrenceId,
  wallStamp,
  weekdayCode,
} from "../frontend/recurrence_edit.ts";
import { describeRule } from "../frontend/recurrence.ts";

describe("buildRRule — draft to RRULE (DC-12 §2.1)", () => {
  const wed = new Date(2026, 8, 2); // Wednesday

  test("NONE builds no rule (plain single event)", () => {
    expect(buildRRule({ freq: "NONE", interval: 1, byDay: [] }, wed)).toBeNull();
  });

  test("weekly defaults to the base date's weekday", () => {
    expect(buildRRule({ freq: "WEEKLY", interval: 1, byDay: [] }, wed)).toBe(
      "FREQ=WEEKLY;BYDAY=WE",
    );
  });

  test("interval > 1 emits INTERVAL; BYDAY is canonically MO-first ordered", () => {
    expect(
      buildRRule({ freq: "WEEKLY", interval: 2, byDay: ["FR", "MO"] }, wed),
    ).toBe("FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,FR");
  });

  test("daily/monthly/yearly without interval emit FREQ only", () => {
    expect(buildRRule({ freq: "DAILY", interval: 1, byDay: [] }, wed)).toBe("FREQ=DAILY");
    expect(buildRRule({ freq: "MONTHLY", interval: 3, byDay: [] }, wed)).toBe(
      "FREQ=MONTHLY;INTERVAL=3",
    );
    expect(buildRRule({ freq: "YEARLY", interval: 1, byDay: [] }, wed)).toBe("FREQ=YEARLY");
  });

  test("generated rules are accepted by the read-side renderer", () => {
    const rule = buildRRule({ freq: "WEEKLY", interval: 2, byDay: ["MO", "WE"] }, wed)!;
    expect(describeRule(rule)).toBe("Repeats every 2 weeks on Monday, Wednesday");
  });

  test("weekdayCode maps JS getDay() to RFC 5545 codes", () => {
    expect(weekdayCode(0)).toBe("SU");
    expect(weekdayCode(1)).toBe("MO");
    expect(weekdayCode(6)).toBe("SA");
  });
});

describe("draftFromRule — round-trip + raw fallback", () => {
  test("common rules round-trip byte-stably", () => {
    const cases = ["FREQ=DAILY", "FREQ=WEEKLY;BYDAY=WE", "FREQ=MONTHLY;INTERVAL=2"];
    for (const rule of cases) {
      const draft = draftFromRule(rule)!;
      expect(buildRRule(draft, new Date(2026, 8, 2))).toBe(rule);
    }
  });

  test("rules outside the builder subset return null (kept verbatim upstream)", () => {
    expect(draftFromRule("FREQ=MONTHLY;BYDAY=MO;BYSETPOS=2")).toBeNull();
    expect(draftFromRule("FREQ=DAILY;COUNT=5")).toBeNull();
    expect(draftFromRule("FREQ=DAILY;UNTIL=20261231")).toBeNull();
    expect(draftFromRule("not a rule")).toBeNull();
  });
});

describe("deriveRecurrenceId — DC-12 §2.3 canonical form", () => {
  test("timed occurrence: local wall clock, no offset suffix", () => {
    // 2026-09-02 09:00 local
    const ms = new Date(2026, 8, 2, 9, 0, 0).getTime();
    expect(deriveRecurrenceId(ms, false)).toBe("20260902T090000");
  });

  test("all-day occurrence: midnight convention", () => {
    const ms = new Date(2026, 8, 2, 0, 0, 0).getTime();
    expect(deriveRecurrenceId(ms, true)).toBe("20260902T000000");
  });

  test("seconds are included in the canonical form", () => {
    const ms = new Date(2026, 8, 2, 9, 15, 30).getTime();
    expect(deriveRecurrenceId(ms, false)).toBe("20260902T091530");
  });

  test("R2 anchoring: the id names a wall-clock position, never an instant", () => {
    // Same wall clock on both sides of a DST boundary yields the same id —
    // the id is derived from wall fields only, never from UTC arithmetic.
    const a = deriveRecurrenceId(new Date(2026, 9, 25, 9, 0, 0).getTime(), false);
    expect(a).toBe("20261025T090000");
  });
});

describe("wallStamp — override wall form (DC-12 §5.3)", () => {
  test("formats YYYY-MM-DDTHH:MM in local wall clock", () => {
    const ms = new Date(2026, 8, 2, 14, 0, 0).getTime();
    expect(wallStamp(ms)).toBe("2026-09-02T14:00");
  });
});
