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
  // Mandatory end date (owner decision, 2026-08-31): the picked date is the
  // INCLUSIVE last occurrence; UNTIL=YYYYMMDD carries it in the rule.
  const until = "2026-10-05";

  test("NONE builds no rule (plain single event — opt-in off-path)", () => {
    expect(
      buildRRule({ freq: "NONE", interval: 1, byDay: [], until }, wed),
    ).toBeNull();
  });

  test("weekly defaults to the base date's weekday; UNTIL is appended last", () => {
    expect(
      buildRRule({ freq: "WEEKLY", interval: 1, byDay: [], until }, wed),
    ).toBe("FREQ=WEEKLY;BYDAY=WE;UNTIL=20261005");
  });

  test("interval > 1 emits INTERVAL; BYDAY is canonically MO-first ordered", () => {
    expect(
      buildRRule(
        { freq: "WEEKLY", interval: 2, byDay: ["FR", "MO"], until },
        wed,
      ),
    ).toBe("FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,FR;UNTIL=20261005");
  });

  test("daily/monthly/yearly without interval emit FREQ + UNTIL", () => {
    expect(
      buildRRule({ freq: "DAILY", interval: 1, byDay: [], until }, wed),
    ).toBe("FREQ=DAILY;UNTIL=20261005");
    expect(
      buildRRule({ freq: "MONTHLY", interval: 3, byDay: [], until }, wed),
    ).toBe("FREQ=MONTHLY;INTERVAL=3;UNTIL=20261005");
    expect(
      buildRRule({ freq: "YEARLY", interval: 1, byDay: [], until }, wed),
    ).toBe("FREQ=YEARLY;UNTIL=20261005");
  });

  test("generated rules are accepted by the read-side renderer", () => {
    const rule = buildRRule(
      { freq: "WEEKLY", interval: 2, byDay: ["MO", "WE"], until },
      wed,
    )!;
    expect(describeRule(rule)).toBe(
      "Repeats every 2 weeks on Monday, Wednesday, until 5 Oct 2026",
    );
  });

  test("weekdayCode maps JS getDay() to RFC 5545 codes", () => {
    expect(weekdayCode(0)).toBe("SU");
    expect(weekdayCode(1)).toBe("MO");
    expect(weekdayCode(6)).toBe("SA");
  });
});

describe("buildRRule — mandatory end date validation (DC-12 owner decision)", () => {
  const wed = new Date(2026, 8, 2); // Wednesday, 2 Sep 2026

  test("a rule without an end date is rejected with a friendly error", () => {
    expect(() =>
      buildRRule({ freq: "DAILY", interval: 1, byDay: [], until: null }, wed),
    ).toThrow(/end date \(Until\)/i);
    expect(() =>
      buildRRule({ freq: "WEEKLY", interval: 1, byDay: [], until: "" }, wed),
    ).toThrow(/end date/i);
  });

  test("an end date BEFORE the event's own day is rejected", () => {
    expect(() =>
      buildRRule(
        { freq: "DAILY", interval: 1, byDay: [], until: "2026-09-01" },
        wed,
      ),
    ).toThrow(/on or after the event's own day/);
  });

  test("an end date ON the event's own day is accepted (inclusive end)", () => {
    expect(
      buildRRule({ freq: "DAILY", interval: 1, byDay: [], until: "2026-09-02" }, wed),
    ).toBe("FREQ=DAILY;UNTIL=20260902");
  });

  test("a malformed end date is rejected", () => {
    expect(() =>
      buildRRule(
        { freq: "DAILY", interval: 1, byDay: [], until: "02/09/2026" },
        wed,
      ),
    ).toThrow(/end date/i);
  });
});

describe("draftFromRule — round-trip + raw fallback", () => {
  test("UNTIL-bearing rules round-trip byte-stably", () => {
    const cases = [
      "FREQ=WEEKLY;BYDAY=WE;UNTIL=20261005",
      "FREQ=DAILY;UNTIL=20261231",
      "FREQ=MONTHLY;INTERVAL=2;UNTIL=20270131",
    ];
    for (const rule of cases) {
      const draft = draftFromRule(rule)!;
      expect(buildRRule(draft, new Date(2026, 8, 2))).toBe(rule);
    }
    // Non-UNTIL rules still round-trip among themselves once an end date
    // is supplied (mandatory on build).
    const draft = draftFromRule("FREQ=WEEKLY;BYDAY=WE")!;
    expect(buildRRule({ ...draft, until: "2026-10-05" }, new Date(2026, 8, 2))).toBe(
      "FREQ=WEEKLY;BYDAY=WE;UNTIL=20261005",
    );
  });

  test("UNTIL date form converts to the input's YYYY-MM-DD (inclusive)", () => {
    expect(draftFromRule("FREQ=DAILY;UNTIL=20261005")).toMatchObject({
      freq: "DAILY",
      until: "2026-10-05",
    });
    // Open-ended legacy rules prefill with an empty Until field.
    expect(draftFromRule("FREQ=DAILY")).toMatchObject({ until: null });
  });

  test("rules outside the builder subset return null (kept verbatim upstream)", () => {
    expect(draftFromRule("FREQ=MONTHLY;BYDAY=MO;BYSETPOS=2")).toBeNull();
    expect(draftFromRule("FREQ=DAILY;COUNT=5")).toBeNull();
    expect(draftFromRule("FREQ=DAILY;UNTIL=20261231T000000Z")).toBeNull();
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

describe("describeRule — UNTIL surfaces in the live preview (DC-12 owner decision)", () => {
  test("the end date is stated in plain language, day-first", () => {
    expect(describeRule("FREQ=WEEKLY;BYDAY=MO;UNTIL=20261005")).toBe(
      "Repeats weekly on Monday, until 5 Oct 2026",
    );
    expect(describeRule("FREQ=DAILY;UNTIL=20261005")).toBe(
      "Repeats daily, until 5 Oct 2026",
    );
    expect(describeRule("FREQ=MONTHLY;INTERVAL=2;UNTIL=20270131")).toBe(
      "Repeats every 2 months, until 31 Jan 2027",
    );
  });

  test("open-ended rules render unchanged; datetime UNTIL stays raw", () => {
    expect(describeRule("FREQ=WEEKLY;BYDAY=MO")).toBe("Repeats weekly on Monday");
    const rule = "FREQ=WEEKLY;BYDAY=WE;UNTIL=20261231T000000Z";
    expect(describeRule(rule)).toBe(rule);
  });
});
