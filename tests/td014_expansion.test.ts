// TD-014 regression tests: recurrence expansion FREQ x INTERVAL x BYDAY
// semantics. Findings F1/F2/F3 from the 2026-09-01 independent review,
// with the reviewer's empirical probe cases as ground truth.
// INVARIANT 9 (wall-clock preservation): pure arithmetic, no tz conversion.
import { describe, expect, test } from "vitest";
import { expandOccurrences, type SeriesState } from "../src/domain/recurrence_conflicts.ts";

const series = (rule: string, base = "2026-09-02T09:00"): SeriesState => ({
  series_id: "s-td14",
  base_start_wall: base,
  tz_id: "Europe/Berlin",
  recurrence_rule: rule,
});

// Wednesday 2026-09-02 (base weekday for most cases).
describe("TD-014 F1: DAILY;INTERVAL>1 must not hang or collapse", () => {
  test("DAILY;INTERVAL=2;COUNT=5 returns 5 occurrences on alternate days", () => {
    const ids = expandOccurrences(series("FREQ=DAILY;INTERVAL=2;COUNT=5"), "20260902T000000", "20301231T235959");
    expect(ids).toEqual([
      "20260902T090000",
      "20260904T090000",
      "20260906T090000",
      "20260908T090000",
      "20260910T090000",
    ]);
  });

  test("DAILY;INTERVAL=3;UNTIL bounds correctly", () => {
    const ids = expandOccurrences(series("FREQ=DAILY;INTERVAL=3;UNTIL=20260912"), "20260902T000000", "20301231T235959");
    // 2, 5, 8, 11 September — 12th is beyond UNTIL.
    expect(ids).toEqual([
      "20260902T090000",
      "20260905T090000",
      "20260908T090000",
      "20260911T090000",
    ]);
  });

  test("MONTHLY;INTERVAL=2;COUNT=4 lands on the same day-of-month, calendar months apart", () => {
    const ids = expandOccurrences(series("FREQ=MONTHLY;INTERVAL=2;COUNT=4"), "20260902T000000", "20301231T235959");
    // Sep 2, Nov 2, Jan 2, Mar 2 — calendar months, NOT 28*interval approximations.
    expect(ids).toEqual([
      "20260902T090000",
      "20261102T090000",
      "20270102T090000",
      "20270302T090000",
    ]);
  });

  test("MONTHLY;INTERVAL=1 respects month lengths (Jan 31 -> Mar 31, not Mar 3)", () => {
    const ids = expandOccurrences(
      series("FREQ=MONTHLY;COUNT=3", "2027-01-31T10:00"),
      "20270131T000000",
      "20301231T235959",
    );
    // RFC 5545: months lacking day 31 skip (no Feb 31 / Apr 31) and do NOT
    // count toward COUNT — COUNT bounds EMITTED occurrences.
    expect(ids).toEqual(["20270131T100000", "20270331T100000", "20270531T100000"]);
  });
});

describe("TD-014 F2: WEEKLY without BYDAY must be weekly on base weekday, not daily", () => {
  test("FREQ=WEEKLY alone from a Wednesday base yields Wednesdays only", () => {
    const ids = expandOccurrences(series("FREQ=WEEKLY;COUNT=4"), "20260902T000000", "20301231T235959");
    expect(ids).toEqual([
      "20260902T090000",
      "20260909T090000",
      "20260916T090000",
      "20260923T090000",
    ]);
  });

  test("1-week window from Wednesday base yields exactly ONE chip (reviewer probe: 14 daily chips on current code)", () => {
    const ids = expandOccurrences(series("FREQ=WEEKLY"), "20260902T000000", "20260908T235959");
    expect(ids).toEqual(["20260902T090000"]);
  });
});

describe("TD-014 F3: WEEKLY;INTERVAL>1 with BYDAY lands in-correct-weeks", () => {
  test("INTERVAL=2;BYDAY=MO,WE from Monday base: both days only in odd weeks from base", () => {
    // Base Monday 2026-09-07. Weeks: [Sep7..13] occ, [14..20] skip, [21..27] occ.
    const s = series("FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE", "2026-09-07T08:00");
    const ids = expandOccurrences(s, "20260907T000000", "20260927T235959");
    expect(ids).toEqual([
      "20260907T080000",
      "20260909T080000",
      "20260921T080000",
      "20260923T080000",
    ]);
  });

  test("INTERVAL=3;BYDAY=TU,TH from Tuesday base", () => {
    // Base Tue 2026-09-01. Weeks: [Sep1..7] occ, [8..14,15..21] skip, [22..28] occ.
    const s = series("FREQ=WEEKLY;INTERVAL=3;BYDAY=TU,TH", "2026-09-01T07:30");
    const ids = expandOccurrences(s, "20260901T000000", "20260930T235959");
    expect(ids).toEqual([
      "20260901T073000",
      "20260903T073000",
      "20260922T073000",
      "20260924T073000",
    ]);
  });
});

describe("TD-014 regression: previously-correct behavior must stay", () => {
  test("DAILY;INTERVAL=1 unchanged", () => {
    const ids = expandOccurrences(series("FREQ=DAILY;COUNT=4"), "20260902T000000", "20301231T235959");
    expect(ids).toEqual([
      "20260902T090000",
      "20260903T090000",
      "20260904T090000",
      "20260905T090000",
    ]);
  });

  test("MONTHLY;INTERVAL=1 crosses short months correctly", () => {
    const ids = expandOccurrences(
      series("FREQ=MONTHLY;COUNT=4", "2026-01-31T10:00"),
      "20260131T000000",
      "20301231T235959",
    );
    // Jan 31, (Feb skip), Mar 31, (Apr skip), May 31, Jul 31.
    expect(ids).toEqual([
      "20260131T100000",
      "20260331T100000",
      "20260531T100000",
      "20260731T100000",
    ]);
  });

  test("window filtering still inclusive of window-end date", () => {
    const ids = expandOccurrences(series("FREQ=WEEKLY;BYDAY=WE"), "20260902T000000", "20260930T235959");
    expect(ids).toContain("20260930T090000");
  });
});
