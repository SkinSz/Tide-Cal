// Tide DC-23 §13: parser/planner unit tests (pure — no fs, no DB).
// Each test cites its contract clause / instruction item.

import { describe, expect, test } from "vitest";
import { parseIcs, planImport, type ExistingIndex } from "../src/interop/ics_import.ts";

const EMPTY: ExistingIndex = { liveIds: new Set(), tombstonedIds: new Set(), seriesByBase: new Map(), tzByBase: new Map() };

function icsOf(vevent: string): string {
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Test//Test//EN",
    vevent,
    "END:VCALENDAR",
    "",
  ].join("\r\n");
}

// ---------------------------------------------------------------------------
// T1 — §3.5: all-day EXCLUSIVE DTEND -> INCLUSIVE Tide end_date
// ---------------------------------------------------------------------------

describe("T1: all-day exclusive -> inclusive conversion", () => {
  test("single-day: DTEND 20260903 -> Tide end 2026-09-02 (round-trips DC-18 T1)", () => {
    const { events } = parseIcs(icsOf(
      "BEGIN:VEVENT\r\nUID:evt-11111111-1111-4111-8111-111111111111\r\nDTSTART;VALUE=DATE:20260902\r\nDTEND;VALUE=DATE:20260903\r\nSUMMARY:One day\r\nEND:VEVENT",
    ));
    expect(events).toHaveLength(1);
    expect(events[0]!.allDay).toBe(true);
    expect(events[0]!.startDate).toBe("2026-09-02");
    expect(events[0]!.endDate).toBe("2026-09-02"); // inclusive
  });

  test("multi-day: DTEND 20260906 -> inclusive 2026-09-05", () => {
    const { events } = parseIcs(icsOf(
      "BEGIN:VEVENT\r\nUID:evt-22222222-2222-4222-8222-222222222222\r\nDTSTART;VALUE=DATE:20260902\r\nDTEND;VALUE=DATE:20260906\r\nSUMMARY:Trip\r\nEND:VEVENT",
    ));
    expect(events[0]!.endDate).toBe("2026-09-05");
  });

  test("month boundary: DTEND 20260901 on start 20260831 -> end 2026-08-31", () => {
    const { events } = parseIcs(icsOf(
      "BEGIN:VEVENT\r\nUID:evt-33333333-3333-4333-8333-333333333333\r\nDTSTART;VALUE=DATE:20260831\r\nDTEND;VALUE=DATE:20260901\r\nSUMMARY:Month end\r\nEND:VEVENT",
    ));
    expect(events[0]!.endDate).toBe("2026-08-31");
  });

  test("year + leap boundaries", () => {
    const { events } = parseIcs(icsOf(
      "BEGIN:VEVENT\r\nUID:evt-44444444-4444-4444-8444-444444444444\r\nDTSTART;VALUE=DATE:20261231\r\nDTEND;VALUE=DATE:20270101\r\nSUMMARY:New year\r\nEND:VEVENT",
    ));
    expect(events[0]!.endDate).toBe("2026-12-31");
    const { events: leap } = parseIcs(icsOf(
      "BEGIN:VEVENT\r\nUID:evt-55555555-5555-4555-8555-555555555555\r\nDTSTART;VALUE=DATE:20280228\r\nDTEND;VALUE=DATE:20280301\r\nSUMMARY:Leap\r\nEND:VEVENT",
    ));
    // DTEND Mar 1 exclusive -> inclusive Feb 29 (leap day).
    expect(leap[0]!.endDate).toBe("2028-02-29");
  });
});

// ---------------------------------------------------------------------------
// T2 — §3.4/D3: timezone handling
// ---------------------------------------------------------------------------

describe("T2: timezone handling", () => {
  test("known TZID resolves UTC instants (Berlin 14:00 CEST = 12:00Z)", () => {
    const { events } = parseIcs(icsOf(
      "BEGIN:VEVENT\r\nUID:evt-66666666-6666-4666-8666-666666666666\r\nDTSTART;TZID=Europe/Berlin:20260910T140000\r\nDTEND;TZID=Europe/Berlin:20260910T150000\r\nSUMMARY:TZ test\r\nEND:VEVENT",
    ));
    expect(events[0]!.tzId).toBe("Europe/Berlin");
    expect(events[0]!.utcStartMs).toBe(Date.parse("2026-09-10T12:00:00Z"));
    expect(events[0]!.utcEndMs).toBe(Date.parse("2026-09-10T13:00:00Z"));
    expect(events[0]!.startWall).toBe("14:00:00");
  });

  test("unknown TZID falls back to UTC (D3)", () => {
    const { events, skipped } = parseIcs(icsOf(
      "BEGIN:VEVENT\r\nUID:evt-77777777-7777-4777-8777-777777777777\r\nDTSTART;TZID=Mars/Olympus:20260910T140000\r\nDTEND;TZID=Mars/Olympus:20260910T150000\r\nSUMMARY:Alien\r\nEND:VEVENT",
    ));
    expect(events[0]!.tzId).toBeNull();
    // 14:00 floating/UTC interpretation
    expect(events[0]!.utcStartMs).toBe(Date.parse("2026-09-10T14:00:00Z"));
    expect(skipped.some((s) => s.kind === "timezone" && s.detail.includes("Mars/Olympus"))).toBe(true);
  });

  test("UTC Z form parses directly; floating (no TZID) is UTC", () => {
    const { events } = parseIcs(icsOf(
      "BEGIN:VEVENT\r\nUID:evt-88888888-8888-4888-8888-888888888888\r\nDTSTART:20260910T120000Z\r\nDTEND:20260910T130000Z\r\nSUMMARY:UTC\r\nEND:VEVENT",
    ));
    expect(events[0]!.utcStartMs).toBe(Date.parse("2026-09-10T12:00:00Z"));
    expect(events[0]!.tzId).toBeNull();
  });

  test("embedded VTIMEZONE is ignored (advisory only, D3)", () => {
    const text = [
      "BEGIN:VCALENDAR", "VERSION:2.0",
      "BEGIN:VTIMEZONE", "TZID:Europe/Berlin", "BEGIN:STANDARD",
      "DTSTART:19700101T000000", "TZOFFSETFROM:+9999", "TZOFFSETTO:+9999",
      "END:STANDARD", "END:VTIMEZONE",
      "BEGIN:VEVENT",
      "UID:evt-99999999-9999-4999-8999-999999999999",
      "DTSTART;TZID=Europe/Berlin:20260910T140000",
      "DTEND;TZID=Europe/Berlin:20260910T150000",
      "SUMMARY:Real rules win",
      "END:VEVENT", "END:VCALENDAR", "",
    ].join("\r\n");
    const { events } = parseIcs(text);
    // The bogus +9999 embedded rule must NOT poison the resolution.
    expect(events[0]!.utcStartMs).toBe(Date.parse("2026-09-10T12:00:00Z"));
  });
});

// ---------------------------------------------------------------------------
// T3 — §4.5/D4: supported vs unsupported RRULE
// ---------------------------------------------------------------------------

describe("T3: RRULE subset", () => {
  test("supported rule plans a series base verbatim", () => {
    const parsed = parseIcs(icsOf(
      "BEGIN:VEVENT\r\nUID:evt-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\r\nDTSTART:20260907T090000Z\r\nDTEND:20260907T093000Z\r\nRRULE:FREQ=WEEKLY;BYDAY=MO\r\nSUMMARY:Standup\r\nEND:VEVENT",
    ));
    const { plan, notices } = planImport(parsed, EMPTY);
    expect(notices).toHaveLength(0);
    const a = plan.actions[0]!;
    expect(a.kind).toBe("create_series_base");
    expect((a as { rrule: string }).rrule).toBe("FREQ=WEEKLY;BYDAY=MO");
  });

  test("unsupported rule -> non-recurring single event + visible notice (D4)", () => {
    const parsed = parseIcs(icsOf(
      "BEGIN:VEVENT\r\nUID:evt-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb\r\nDTSTART:20260907T090000Z\r\nDTEND:20260907T093000Z\r\nRRULE:FREQ=MONTHLY;BYMONTHDAY=13\r\nSUMMARY:Friday 13th\r\nEND:VEVENT",
    ));
    const { plan, notices } = planImport(parsed, EMPTY);
    expect(plan.actions[0]!.kind).toBe("create_event");
    expect(notices.some((n) => n.includes("recurrence simplified") || n.includes("NON-RECURRING"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// T4 — §4.6/§4.7: overrides incl. file-order independence
// ---------------------------------------------------------------------------

describe("T4: recurrence overrides", () => {
  const base = "BEGIN:VEVENT\r\nUID:evt-cccccccc-cccc-4ccc-8ccc-cccccccccccc\r\nDTSTART:20260907T090000Z\r\nDTEND:20260907T093000Z\r\nRRULE:FREQ=WEEKLY;BYDAY=MO\r\nSUMMARY:Standup\r\nEND:VEVENT";
  const modified = "BEGIN:VEVENT\r\nUID:evt-cccccccc-cccc-4ccc-8ccc-cccccccccccc\r\nRECURRENCE-ID:20260914T090000\r\nDTSTART:20260914T100000Z\r\nDTEND:20260914T103000Z\r\nSUMMARY:Moved\r\nEND:VEVENT";
  const cancelled = "BEGIN:VEVENT\r\nUID:evt-cccccccc-cccc-4ccc-8ccc-cccccccccccc\r\nRECURRENCE-ID:20260921T090000\r\nSTATUS:CANCELLED\r\nDTSTART:20260921T090000Z\r\nDTEND:20260921T093000Z\r\nSUMMARY:Cancelled one\r\nEND:VEVENT";

  test("modified + cancelled occurrences plan as overrides", () => {
    const parsed = parseIcs(icsOf(base + "\r\n" + modified + "\r\n" + cancelled));
    const { plan } = planImport(parsed, EMPTY);
    const overrides = plan.actions.filter((a) => a.kind === "override");
    expect(overrides).toHaveLength(2);
    const kinds = overrides.map((o) => (o as { cancelled: boolean }).cancelled);
    expect(kinds).toEqual([false, true]); // file order preserved
  });

  test("overrides BEFORE the base in file order still plan correctly (§4.7)", () => {
    const parsed = parseIcs(icsOf(cancelled + "\r\n" + modified + "\r\n" + base));
    const { plan } = planImport(parsed, EMPTY);
    const kinds = plan.actions.map((a) => a.kind);
    // base first, then overrides
    expect(kinds[0]).toBe("create_series_base");
    expect(kinds.filter((k) => k === "override").length).toBe(2);
  });

  test("override referencing an unknown series -> skip with reason", () => {
    const parsed = parseIcs(icsOf(cancelled));
    const { plan } = planImport(parsed, EMPTY);
    expect(plan.actions[0]!.kind).toBe("skip");
  });
});

// ---------------------------------------------------------------------------
// T5 — TEXT unescaping (inverse of DC-18 T5)
// ---------------------------------------------------------------------------

describe("T5: TEXT unescaping", () => {
  test("backslash, semicolon, comma, \\n unescaped", () => {
    const { events } = parseIcs(icsOf(
      "BEGIN:VEVENT\r\nUID:evt-dddddddd-dddd-4ddd-8ddd-dddddddddddd\r\nDTSTART:20260910T120000Z\r\nDTEND:20260910T130000Z\r\nSUMMARY:Back\\\\slash\\; semi\\, comma\\nsecond\r\nDESCRIPTION:A\\;B\\,C\\\\D\\nE\r\nEND:VEVENT",
    ));
    expect(events[0]!.summary).toBe("Back\\slash; semi, comma\nsecond");
    expect(events[0]!.description).toBe("A;B,C\\D\nE");
  });
});

// ---------------------------------------------------------------------------
// T6 — §10: folding + UTF-8 boundary + bare LF
// ---------------------------------------------------------------------------

describe("T6: input tolerance", () => {
  test("folded lines unfold before parsing (multi-byte UTF-8 boundary)", () => {
    const long = "Sümmäry with ünïcode ✓ " + "x".repeat(60);
    // Fold at a byte boundary inside a multi-byte char is illegal in RFC, but
    // folding AFTER it must work: build a >75-octet SUMMARY and fold it.
    const summaryLine = "SUMMARY:" + "ü".repeat(60); // 8 + 120 = 128 octets
    const folded = summaryLine.slice(0, 70) + "\r\n " + summaryLine.slice(70);
    const text = [
      "BEGIN:VCALENDAR", "VERSION:2.0",
      "BEGIN:VEVENT",
      "UID:evt-eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      "DTSTART:20260910T120000Z",
      "DTEND:20260910T130000Z",
      folded,
      "END:VEVENT", "END:VCALENDAR", "",
    ].join("\r\n");
    const { events } = parseIcs(text);
    const expected = "ü".repeat(60);
    expect(events[0]!.summary).toBe(expected);
    void long;
  });

  test("bare LF line endings accepted", () => {
    const { events } = parseIcs(icsOf(
      "BEGIN:VEVENT\nUID:evt-ffffffff-ffff-4fff-8fff-ffffffffffff\nDTSTART:20260910T120000Z\nDTEND:20260910T130000Z\nSUMMARY:LF only\nEND:VEVENT",
    ));
    expect(events).toHaveLength(1);
    expect(events[0]!.summary).toBe("LF only");
  });
});

// ---------------------------------------------------------------------------
// T7 — §3.1/§3.2: unsupported components + hard failure
// ---------------------------------------------------------------------------

describe("T7: unsupported components / hard failure", () => {
  test("VTODO ignored with a report entry", () => {
    const text = [
      "BEGIN:VCALENDAR", "VERSION:2.0",
      "BEGIN:VTODO", "UID:todo-1", "SUMMARY:Some task", "END:VTODO",
      "BEGIN:VEVENT",
      "UID:evt-1a1a1a1a-1a1a-41a1-81a1-1a1a1a1a1a1a",
      "DTSTART:20260910T120000Z", "DTEND:20260910T130000Z", "SUMMARY:Real",
      "END:VEVENT", "END:VCALENDAR", "",
    ].join("\r\n");
    const { events, skipped } = parseIcs(text);
    expect(events).toHaveLength(1);
    expect(skipped.some((s) => s.kind === "VTODO")).toBe(true);
  });

  test("unsupported VEVENT properties (EXDATE, ATTENDEE, X-) reported, not fatal", () => {
    const { events, skipped } = parseIcs(icsOf(
      "BEGIN:VEVENT\r\nUID:evt-2b2b2b2b-2b2b-42b2-82b2-2b2b2b2b2b2b\r\nDTSTART:20260910T120000Z\r\nDTEND:20260910T130000Z\r\nSUMMARY:With extras\r\nEXDATE:20260917T120000Z\r\nATTENDEE:mailto:x@y.z\r\nX-FOO:bar\r\nEND:VEVENT",
    ));
    expect(events).toHaveLength(1);
    for (const name of ["EXDATE", "ATTENDEE", "X-FOO"]) {
      expect(skipped.some((s) => s.detail.startsWith(name))).toBe(true);
    }
  });

  test("no VEVENT at all -> hard error (nothing imported)", () => {
    expect(() => parseIcs("BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR")).toThrow(/no VEVENT/);
  });

  test("non-calendar garbage -> hard error", () => {
    expect(() => parseIcs("hello world this is not a calendar")).toThrow(/not a VCALENDAR/);
  });
});

// ---------------------------------------------------------------------------
// T8 — §3.3: duplicate UID first-wins
// ---------------------------------------------------------------------------

describe("T8: duplicate UIDs in one file", () => {
  test("first occurrence kept, later ones marked; planner skips with notice", () => {
    const v1 = "BEGIN:VEVENT\r\nUID:evt-3c3c3c3c-3c3c-43c3-83c3-3c3c3c3c3c3c\r\nDTSTART:20260910T120000Z\r\nDTEND:20260910T130000Z\r\nSUMMARY:First\r\nEND:VEVENT";
    const v2 = "BEGIN:VEVENT\r\nUID:evt-3c3c3c3c-3c3c-43c3-83c3-3c3c3c3c3c3c\r\nDTSTART:20260911T120000Z\r\nDTEND:20260911T130000Z\r\nSUMMARY:Second\r\nEND:VEVENT";
    const parsed = parseIcs(icsOf(v1 + "\r\n" + v2));
    // First-wins: first occurrence normal; duplicates flagged, kept visible.
    expect(parsed.events.filter((e) => !e.duplicate).length).toBe(1);
    expect(parsed.events.filter((e) => e.duplicate).length).toBe(1);
    const { plan, notices } = planImport(parsed, EMPTY);
    expect(plan.actions.filter((a) => a.kind !== "skip")).toHaveLength(1);
    expect(plan.actions.filter((a) => a.kind === "skip")).toHaveLength(1);
    expect(notices.some((n) => n.includes("duplicate UID"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// T9 — malformed properties never crash the parser
// ---------------------------------------------------------------------------

describe("T9: malformed input tolerance", () => {
  test("garbage lines and colon-in-param handled", () => {
    const { events, skipped } = parseIcs(icsOf(
      "BEGIN:VEVENT\r\nUID:evt-4d4d4d4d-4d4d-44d4-84d4-4d4d4d4d4d4d\r\nthis is not a property\r\nDTSTART;TZID=Europe/Berlin:20260910T140000\r\nDTEND;TZID=Europe/Berlin:20260910T150000\r\nSUMMARY:Survived:with:colons\r\nDESCRIPTION:param \"quoted:inside\" value\r\nEND:VEVENT",
    ));
    expect(events).toHaveLength(1);
    expect(skipped.some((s) => s.detail.includes("not a property"))).toBe(true);
    expect(events[0]!.summary).toBe("Survived:with:colons");
  });

  test("VEVENT without DTSTART ignored with report", () => {
    const { events, skipped } = parseIcs(icsOf(
      "BEGIN:VEVENT\r\nUID:evt-5e5e5e5e-5e5e-45e5-85e5-5e5e5e5e5e5e\r\nSUMMARY:No start\r\nEND:VEVENT",
    ));
    expect(events).toHaveLength(0);
    expect(skipped.some((s) => s.detail.includes("without DTSTART"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// T10 — determinism
// ---------------------------------------------------------------------------

describe("T10: deterministic plans", () => {
  test("same input -> identical plan structure (minus fresh foreign ids)", () => {
    const text = icsOf(
      "BEGIN:VEVENT\r\nUID:evt-6f6f6f6f-6f6f-46f6-86f6-6f6f6f6f6f6f\r\nDTSTART:20260910T120000Z\r\nDTEND:20260910T130000Z\r\nSUMMARY:Stable\r\nEND:VEVENT",
    );
    const a = planImport(parseIcs(text), EMPTY);
    const b = planImport(parseIcs(text), EMPTY);
    // Canonical Tide UID (Case B) -> planned id is the UID itself, so the
    // whole plan is byte-comparable.
    expect(JSON.stringify(a.plan.actions)).toBe(JSON.stringify(b.plan.actions));
    expect(JSON.stringify(a.notices)).toBe(JSON.stringify(b.notices));
  });
});

// ---------------------------------------------------------------------------
// Identity cases A–D at planner level (§4)
// ---------------------------------------------------------------------------

describe("identity resolution (§4 cases)", () => {
  const uid = "evt-7a7a7a7a-7a7a-47a7-87a7-7a7a7a7a7a7a";
  const vevent = (u: string, summary: string) =>
    `BEGIN:VEVENT\r\nUID:${u}\r\nDTSTART:20260910T120000Z\r\nDTEND:20260910T130000Z\r\nSUMMARY:${summary}\r\nEND:VEVENT`;

  test("Case A: live match -> update_event (D1)", () => {
    const parsed = parseIcs(icsOf(vevent(uid, "Changed")));
    const existing: ExistingIndex = { liveIds: new Set([uid]), tombstonedIds: new Set(), seriesByBase: new Map(), tzByBase: new Map() };
    const { plan } = planImport(parsed, existing);
    expect(plan.actions[0]!.kind).toBe("update_event");
    expect((plan.actions[0] as { eventId: string }).eventId).toBe(uid);
  });

  test("Case B: canonical Tide UID absent -> create with that id", () => {
    const parsed = parseIcs(icsOf(vevent(uid, "New")));
    const { plan } = planImport(parsed, EMPTY);
    const a = plan.actions[0] as { kind: string; eventId: string };
    expect(a.kind).toBe("create_event");
    expect(a.eventId).toBe(uid);
  });

  test("Case C: foreign UID -> fresh evt- id; foreign uid never in plan id", () => {
    const parsed = parseIcs(icsOf(vevent("abc123@group.calendar.google.com", "Foreign")));
    const { plan, notices } = planImport(parsed, EMPTY);
    const a = plan.actions[0] as { kind: string; eventId: string };
    expect(a.kind).toBe("create_event");
    expect(a.eventId).toMatch(/^evt-[0-9a-f-]{36}$/);
    expect(a.eventId).not.toBe("abc123@group.calendar.google.com");
    expect(notices.some((n) => n.includes("foreign id"))).toBe(true);
  });

  test("Case D: tombstone match -> skip, never resurrect", () => {
    const parsed = parseIcs(icsOf(vevent(uid, "Zombie")));
    const existing: ExistingIndex = { liveIds: new Set(), tombstonedIds: new Set([uid]), seriesByBase: new Map(), tzByBase: new Map() };
    const { plan } = planImport(parsed, existing);
    expect(plan.actions[0]!.kind).toBe("skip");
  });
});

// ---------------------------------------------------------------------------
// Blind-review MAJOR regressions: override time resolution (§4.6)
// ---------------------------------------------------------------------------

describe("override time resolution (blind-review majors)", () => {
  const baseUid = "evt-cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const base = `BEGIN:VEVENT\r\nUID:${baseUid}\r\nDTSTART;TZID=Europe/Berlin:20260907T090000\r\nDTEND;TZID=Europe/Berlin:20260907T093000\r\nRRULE:FREQ=WEEKLY;BYDAY=MO\r\nSUMMARY:Standup\r\nEND:VEVENT`;

  test("MAJOR-1: Z-form override times are NOT silently dropped", () => {
    // Google-style: base TZID-qualified, override in UTC Z form.
    const zOverride = `BEGIN:VEVENT\r\nUID:${baseUid}\r\nRECURRENCE-ID:20260914T090000\r\nDTSTART:20260914T100000Z\r\nDTEND:20260914T103000Z\r\nSUMMARY:Moved to UTC time\r\nEND:VEVENT`;
    const parsed = parseIcs(icsOf(base + "\r\n" + zOverride));
    const { plan } = planImport(parsed, EMPTY);
    const ov = plan.actions.find((a) => a.kind === "override") as
      | { startWall: string | null; endWall: string | null }
      | undefined;
    expect(ov).toBeDefined();
    // 10:00Z = 12:00 CEST on Sep 14. The wall times must be present.
    expect(ov!.startWall).toBe("12:00:00");
    expect(ov!.endWall).toBe("12:30:00");
  });

  test("MAJOR-2: override TZID differing from base tz is re-expressed in base zone", () => {
    // Base in Berlin; override says the same wall clock but in London.
    const londonOverride = `BEGIN:VEVENT\r\nUID:${baseUid}\r\nRECURRENCE-ID:20260914T090000\r\nDTSTART;TZID=Europe/London:20260914T090000\r\nDTEND;TZID=Europe/London:20260914T093000\r\nSUMMARY:London input\r\nEND:VEVENT`;
    const parsed = parseIcs(icsOf(base + "\r\n" + londonOverride));
    const { plan, notices } = planImport(parsed, EMPTY);
    const ov = plan.actions.find((a) => a.kind === "override") as
      | { startWall: string | null; endWall: string | null }
      | undefined;
    expect(ov).toBeDefined();
    // 09:00 London (BST, UTC+1) = 08:00Z = 10:00 CEST on Sep 14.
    expect(ov!.startWall).toBe("10:00:00");
    expect(ov!.endWall).toBe("10:30:00");
    expect(notices.some((n) => n.includes("re-expressed"))).toBe(true);
  });
});
