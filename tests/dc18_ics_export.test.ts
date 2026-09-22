// Tide DC-18 §6: headless unit tests over the PURE exporter (no GUI, no fs).
// Each test cites its contract clause. T10's "strict reference parser" gate
// is covered by the structural parser below (line grammar + folding +
// property syntax) plus the dispatcher integration test (dc18_export.test.ts
// seeded-DB round trip through the real sidecar dispatch path).

import { describe, expect, test } from "vitest";
import {
  exclusiveEndDate,
  exportToIcs,
  foldLine,
  escapeText,
  type ExportInput,
  type IcsEvent,
} from "../src/interop/ics_export.ts";

const NOW = Date.parse("2026-09-08T12:00:00Z");

function ev(p: Partial<IcsEvent> & { event_id: string }): IcsEvent {
  return {
    calendar_id: "local",
    title: "Event",
    description: "",
    all_day: false,
    start_date: null,
    end_date: null,
    start_wall: null,
    end_wall: null,
    tz_id: null,
    utc_start_ms: null,
    utc_end_ms: null,
    ...p,
  };
}

function base(events: IcsEvent[], extra: Partial<ExportInput> = {}): ExportInput {
  return {
    calendars: [{ calendar_id: "local", title: "My Calendar" }],
    events,
    series: [],
    overrides: [],
    nowMs: NOW,
    ...extra,
  };
}

/** Minimal structural RFC 5545 parser: grammar, folding, CRLF, ordering. */
function parseIcs(text: string): { props: string[]; vevents: number; raw: string } {
  // File form: CRLF endings, no bare LF.
  expect(text.endsWith("\r\n")).toBe(true);
  expect(text.includes("\n")).toBe(true); // CRLFs exist
  expect(/(^|[^\r])\n/.test(text)).toBe(false); // no bare LF
  // Unfold (§3.1: continuation lines start with a single space).
  const unfolded = text.replace(/\r\n /g, "");
  const lines = unfolded.split("\r\n").filter((l) => l.length > 0);
  for (const line of lines) {
    // NAME[;PARAM=VALUE...]:VALUE — param values may contain most chars
    // except : (quoted-string form exists in RFC 5545 but Tide never emits it).
    const m = /^([A-Za-z0-9-]+)((?:;[^:=]+=[^:]*)*):(.*)$/.exec(line);
    expect(m, `malformed line: ${JSON.stringify(line)}`).not.toBeNull();
  }
  const vevents = lines.filter((l) => l === "BEGIN:VEVENT").length;
  expect(lines[0]).toBe("BEGIN:VCALENDAR");
  expect(lines.at(-1)).toBe("END:VCALENDAR");
  expect(lines.filter((l) => l === "BEGIN:VCALENDAR").length).toBe(1);
  return { props: lines, vevents, raw: text };
}

function get(props: string[], name: string): string | undefined {
  return props.find((p) => p.startsWith(name + ":") || p.startsWith(name + ";"));
}

// ---------------------------------------------------------------------------
// T1 — §3.3: all-day inclusive -> exclusive DTEND conversion (the trap)
// ---------------------------------------------------------------------------

describe("T1: all-day exclusive DTEND", () => {
  test("Tide inclusive end_date 2026-09-02 exports DTEND 20260903", () => {
    const out = exportToIcs(
      base([
        ev({
          event_id: "evt-1",
          all_day: true,
          start_date: "2026-09-02",
          end_date: "2026-09-02",
        }),
      ]),
    );
    const { props } = parseIcs(out);
    expect(get(props, "DTSTART")).toBe("DTSTART;VALUE=DATE:20260902");
    expect(get(props, "DTEND")).toBe("DTEND;VALUE=DATE:20260903");
  });

  test("multi-day inclusive range converts correctly (Sep 2..4 -> DTEND Sep 5)", () => {
    const out = exportToIcs(
      base([
        ev({
          event_id: "evt-2",
          all_day: true,
          start_date: "2026-09-02",
          end_date: "2026-09-04",
        }),
      ]),
    );
    const { props } = parseIcs(out);
    expect(get(props, "DTEND")).toBe("DTEND;VALUE=DATE:20260905");
  });

  test("month/year boundary: Aug 31 -> Sep 1; Dec 31 2026 -> Jan 1 2027", () => {
    expect(exclusiveEndDate("2026-08-31")).toBe("2026-09-01");
    expect(exclusiveEndDate("2026-12-31")).toBe("2027-01-01");
    // Leap year: Feb 28 2028 -> Feb 29.
    expect(exclusiveEndDate("2028-02-28")).toBe("2028-02-29");
  });
});

// ---------------------------------------------------------------------------
// T2 — §3.3: timed event with tz_id -> TZID + emitted VTIMEZONE
// ---------------------------------------------------------------------------

describe("T2: timed event with tz", () => {
  test("Europe/Berlin event gets TZID params and a VTIMEZONE block", () => {
    const out = exportToIcs(
      base([
        ev({
          event_id: "evt-3",
          // Real DB rows: timed events carry UTC columns; start_date NULL.
          utc_start_ms: Date.parse("2026-09-10T12:00:00Z"),
          utc_end_ms: Date.parse("2026-09-10T13:00:00Z"),
          start_wall: "14:00:00",
          end_wall: "15:00:00",
          tz_id: "Europe/Berlin",
        }),
      ]),
    );
    const { props } = parseIcs(out);
    expect(props.some((p) => p.startsWith("DTSTART;TZID=Europe/Berlin:20260910T140000"))).toBe(true);
    expect(props.some((p) => p.startsWith("DTEND;TZID=Europe/Berlin:20260910T150000"))).toBe(true);
    expect(props.some((p) => p === "BEGIN:VTIMEZONE")).toBe(true);
    expect(props.some((p) => p === "TZID:Europe/Berlin")).toBe(true);
    // VTIMEZONE precedes the VEVENT that references it (consumers require it).
    expect(props.indexOf("BEGIN:VTIMEZONE")).toBeLessThan(props.indexOf("BEGIN:VEVENT"));
  });

  test("DST-correct offsets: a 14:00 Berlin summer time is 12:00 UTC", () => {
    // Validation of the zoned->UTC math via the no-tz path's sibling: the
    // override path reuses the same conversion; assert the offset correction
    // through a known pair (CEST = UTC+2 in September).
    const out = exportToIcs(
      base([
        ev({
          event_id: "evt-3b",
          start_date: "2026-09-10",
          start_wall: "14:00:00",
          end_wall: "15:00:00",
          tz_id: "Europe/Berlin",
        }),
      ]),
    );
    // The TZID form carries the wall time; the VTIMEZONE must carry the real
    // CEST offset +0200.
    const { props } = parseIcs(out);
    expect(props.some((p) => p === "TZOFFSETTO:+0200")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// T3 — §3.3: timed event without tz -> UTC Z form
// ---------------------------------------------------------------------------

describe("T3: timed event without tz -> UTC", () => {
  test("utc columns render as Z form; non-canonical tz falls back to UTC", () => {
    const out = exportToIcs(
      base([
        ev({
          event_id: "evt-4",
          utc_start_ms: Date.parse("2026-09-10T12:30:00Z"),
          utc_end_ms: Date.parse("2026-09-10T13:30:00Z"),
        }),
        ev({
          event_id: "evt-4b",
          tz_id: "Not/AZone",
          utc_start_ms: Date.parse("2026-09-10T12:30:00Z"),
          utc_end_ms: Date.parse("2026-09-10T13:30:00Z"),
        }),
      ]),
    );
    const { props } = parseIcs(out);
    expect(props.filter((p) => p === "DTSTART:20260910T123000Z").length).toBe(2);
    expect(props.some((p) => p.startsWith("DTSTART;TZID="))).toBe(false);
    // No VTIMEZONE for the bogus zone.
    expect(props.some((p) => p === "BEGIN:VTIMEZONE")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// T4 — §3.4: RRULE verbatim, override VEVENTs, cancelled form
// ---------------------------------------------------------------------------

describe("T4: recurrence", () => {
  const seriesBase = ev({
    event_id: "evt-ser",
    title: "Weekly standup",
    start_date: "2026-09-07",
    start_wall: "09:00:00",
    end_wall: "09:30:00",
    tz_id: "Europe/Berlin",
  });

  test("RRULE COUNT form passes through VERBATIM (no rewriting)", () => {
    const rule = "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;COUNT=6";
    const out = exportToIcs(
      base([seriesBase], { series: [{ series_id: "ser-1", base_event_id: "evt-ser", recurrence_rule: rule }] }),
    );
    const { props, vevents } = parseIcs(out);
    expect(vevents).toBe(1);
    expect(get(props, "RRULE")).toBe(`RRULE:${rule}`);
  });

  test("GATE: stored DATE-form UNTIL on a TIMED series exports as UTC DATE-TIME (RFC 5545 §3.3.10)", () => {
    // 2026-09-25 09:00 Berlin (= 07:00Z, per the gate series). Stored rule
    // carries UNTIL=20260927 (Tide's storage canon); the export must
    // re-express the last-occurrence wall start 2026-09-27 09:00 Berlin as
    // 20260927T070000Z — bare 20260927 (00:00Z = 02:00 Berlin) clipped the
    // last occurrence in Google Calendar.
    const timedBase = ev({
      event_id: "evt-daily",
      title: "Daily-Recurrence3",
      start_wall: "09:00:00",
      end_wall: "10:00:00",
      tz_id: "Europe/Berlin",
      utc_start_ms: Date.parse("2026-09-25T07:00:00Z"),
      utc_end_ms: Date.parse("2026-09-25T08:00:00Z"),
    });
    const out = exportToIcs(
      base([timedBase], {
        series: [{ series_id: "ser-2", base_event_id: "evt-daily", recurrence_rule: "FREQ=DAILY;UNTIL=20260927" }],
      }),
    );
    const { props } = parseIcs(out);
    expect(get(props, "RRULE")).toBe("RRULE:FREQ=DAILY;UNTIL=20260927T070000Z");
  });

  test("GATE: all-day series keeps DATE-form UNTIL (DTSTART is DATE there)", () => {
    const allDayBase = ev({
      event_id: "evt-ad-ser",
      title: "All-day series",
      all_day: true,
      start_date: "2026-09-23",
      end_date: "2026-09-23",
    });
    const out = exportToIcs(
      base([allDayBase], {
        series: [{ series_id: "ser-3", base_event_id: "evt-ad-ser", recurrence_rule: "FREQ=DAILY;UNTIL=20260927" }],
      }),
    );
    const { props } = parseIcs(out);
    expect(get(props, "RRULE")).toBe("RRULE:FREQ=DAILY;UNTIL=20260927");
  });

  test("GATE: UNTIL lands on a UTC-behind zone instant (America/New_York, no cross-DST)", () => {
    const nyBase = ev({
      event_id: "evt-ny",
      title: "NY daily",
      start_wall: "20:00:00",
      end_wall: "21:00:00",
      tz_id: "America/New_York",
      utc_start_ms: Date.parse("2026-09-25T00:00:00Z"), // 20:00 EDT (UTC-4)
      utc_end_ms: Date.parse("2026-09-25T01:00:00Z"),
    });
    const out = exportToIcs(
      base([nyBase], {
        series: [{ series_id: "ser-4", base_event_id: "evt-ny", recurrence_rule: "FREQ=DAILY;UNTIL=20260927" }],
      }),
    );
    const { props } = parseIcs(out);
    // 2026-09-27 20:00 EDT = 20260928T000000Z (UTC instant is next day).
    expect(get(props, "RRULE")).toBe("RRULE:FREQ=DAILY;UNTIL=20260928T000000Z");
  });

  test("modified occurrence -> same UID + RECURRENCE-ID + overridden values", () => {
    const out = exportToIcs(
      base([seriesBase], {
        series: [{ series_id: "ser-1", base_event_id: "evt-ser", recurrence_rule: "FREQ=WEEKLY" }],
        overrides: [
          {
            series_id: "ser-1",
            recurrence_id: "20260914T090000",
            cancelled: false,
            title: "Moved standup",
            start_wall: "10:00:00",
            end_wall: "10:30:00",
            tz_id: "Europe/Berlin",
          },
        ],
      }),
    );
    const { props, vevents } = parseIcs(out);
    expect(vevents).toBe(2);
    const uidLines = props.filter((p) => p === "UID:evt-ser");
    expect(uidLines.length).toBe(2);
    const rec = props.find((p) => p.startsWith("RECURRENCE-ID:"));
    expect(rec).toBe("RECURRENCE-ID:20260914T090000"); // ORIGINAL start (R2)
    expect(props.some((p) => p === "SUMMARY:Moved standup")).toBe(true);
    // Overridden start_wall 10:00 anchored on the RECURRENCE-ID's own date
    // (Sep 14 — the occurrence's date, NOT the base's Sep 7).
    expect(props.some((p) => p.startsWith("DTSTART;TZID=Europe/Berlin:20260914T100000"))).toBe(true);
  });

  test("cancelled occurrence -> STATUS:CANCELLED representation, still exported", () => {
    const out = exportToIcs(
      base([seriesBase], {
        series: [{ series_id: "ser-1", base_event_id: "evt-ser", recurrence_rule: "FREQ=WEEKLY" }],
        overrides: [
          {
            series_id: "ser-1",
            recurrence_id: "20260914T090000",
            cancelled: true,
            title: null,
            start_wall: null,
            end_wall: null,
            tz_id: null,
          },
        ],
      }),
    );
    const { props, vevents } = parseIcs(out);
    expect(vevents).toBe(2); // §3.8: cancelled OCCURRENCE is data, not deletion
    expect(props.some((p) => p === "STATUS:CANCELLED")).toBe(true);
    // SEQUENCE stays 0 in v1 (§3.7 v1 rule; see exporter header note).
    expect(props.every((p) => !p.startsWith("SEQUENCE:") || p === "SEQUENCE:0")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// T5 — §4.3: TEXT escaping
// ---------------------------------------------------------------------------

describe("T5: TEXT escaping", () => {
  test("backslash, semicolon, comma, newline escaped in SUMMARY/DESCRIPTION", () => {
    const out = exportToIcs(
      base([
        ev({
          event_id: "evt-5",
          title: 'Back\\slash; semi, comma\nsecond line',
          description: "A;B,C\\D\nE",
        }),
      ]),
    );
    const { props } = parseIcs(out);
    expect(get(props, "SUMMARY")).toBe(
      "SUMMARY:Back\\\\slash\\; semi\\, comma\\nsecond line",
    );
    expect(get(props, "DESCRIPTION")).toBe("DESCRIPTION:A\\;B\\,C\\\\D\\nE");
  });

  test("escapeText unit cases", () => {
    expect(escapeText("plain")).toBe("plain");
    expect(escapeText("a\\b")).toBe("a\\\\b");
    expect(escapeText("a;b,c\nd\re")).toBe("a\\;b\\,c\\nd\\ne");
    expect(escapeText("ünïcode ✓")).toBe("ünïcode ✓"); // UTF-8 passthrough
  });
});

// ---------------------------------------------------------------------------
// T6 — §4.3: folding at 75 octets incl. multi-byte UTF-8 boundary
// ---------------------------------------------------------------------------

describe("T6: line folding at 75 octets", () => {
  test("long ASCII line folds with CRLF + space continuations", () => {
    const long = "SUMMARY:" + "x".repeat(200);
    const folded = foldLine(long);
    for (const line of folded.split("\r\n")) {
      expect(Buffer.byteLength(line, "utf8")).toBeLessThanOrEqual(75);
    }
    expect(folded.replace(/\r\n /g, "")).toBe(long);
  });

  test("multi-byte UTF-8 boundary: folding counts OCTETS, never splits a rune", () => {
    // Each "é" is 2 octets; build a line whose 75-octet limit falls mid-rune.
    const long = "SUMMARY:" + "é".repeat(60); // 8 + 120 = 128 octets
    const folded = foldLine(long);
    for (const line of folded.split("\r\n")) {
      expect(Buffer.byteLength(line, "utf8")).toBeLessThanOrEqual(75);
      // No rune split: every chunk must re-encode losslessly.
      expect(new TextDecoder().decode(new TextEncoder().encode(line))).toBe(line);
    }
    expect(folded.replace(/\r\n /g, "")).toBe(long);
  });

  test("export applies folding end-to-end", () => {
    const out = exportToIcs(base([ev({ event_id: "evt-6", title: "y".repeat(300) })]));
    for (const line of out.split("\r\n")) {
      if (line) expect(Buffer.byteLength(line, "utf8")).toBeLessThanOrEqual(75);
    }
  });
});

// ---------------------------------------------------------------------------
// T7 — §4.1: empty calendar -> valid empty VCALENDAR
// ---------------------------------------------------------------------------

describe("T7: empty calendar", () => {
  test("zero events still yields a structurally valid VCALENDAR", () => {
    const out = exportToIcs(base([]));
    const { props, vevents } = parseIcs(out);
    expect(vevents).toBe(0);
    expect(get(props, "PRODID")).toBe("PRODID:-//Tide//Calendar Export//EN");
    expect(get(props, "VERSION")).toBe("VERSION:2.0");
    expect(get(props, "CALSCALE")).toBe("CALSCALE:GREGORIAN");
  });
});

// ---------------------------------------------------------------------------
// T8 — §4.2: anomaly event -> fail-visible X-TIDE-ERROR
// ---------------------------------------------------------------------------

describe("T8: fail-visible anomalies", () => {
  test("all-day event with missing dates -> X-TIDE-ERROR + epoch fallback, still parseable", () => {
    const out = exportToIcs(base([ev({ event_id: "evt-8", all_day: true })]));
    const { props } = parseIcs(out); // parseable
    expect(props.some((p) => p.startsWith("X-TIDE-ERROR:"))).toBe(true);
    expect(get(props, "DTSTART")).toBe("DTSTART;VALUE=DATE:19700101");
  });

  test("timed event with no time basis -> X-TIDE-ERROR + epoch-0 UTC DTSTART", () => {
    const out = exportToIcs(base([ev({ event_id: "evt-8b" })]));
    const { props } = parseIcs(out);
    expect(props.some((p) => p.startsWith("X-TIDE-ERROR:"))).toBe(true);
    expect(get(props, "DTSTART")).toBe("DTSTART:19700101T000000Z");
  });

  test("events are NEVER silently skipped: anomaly events still produce a VEVENT", () => {
    const out = exportToIcs(base([ev({ event_id: "evt-8c" }), ev({ event_id: "evt-8d" })]));
    expect(parseIcs(out).vevents).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// T9 — §3.6: UID verbatim stability
// ---------------------------------------------------------------------------

describe("T9: UID stability", () => {
  test("same event_id -> byte-identical UIDs across two export runs", () => {
    const id = "evt-9-uuid-with-dashes";
    const a = exportToIcs(base([ev({ event_id: id })]));
    const b = exportToIcs(base([ev({ event_id: id })]));
    const ua = parseIcs(a).props.filter((p) => p === `UID:${id}`);
    const ub = parseIcs(b).props.filter((p) => p === `UID:${id}`);
    expect(ua).toEqual([`UID:${id}`]);
    expect(ua).toEqual(ub);
  });
});

// ---------------------------------------------------------------------------
// T10 — §3.1/§3.3.11: CRLF everywhere + strict structure (see parser above)
// ---------------------------------------------------------------------------

describe("T10: CRLF + strict parse", () => {
  const seriesBase = ev({
    event_id: "evt-ser",
    title: "Weekly standup",
    start_date: "2026-09-07",
    start_wall: "09:00:00",
    end_wall: "09:30:00",
    tz_id: "Europe/Berlin",
  });

  test("no bare LF, final CRLF, all lines parse", () => {
    const out = exportToIcs(
      base(
        [seriesBase],
        {
          series: [{ series_id: "ser-1", base_event_id: "evt-ser", recurrence_rule: "FREQ=DAILY" }],
          overrides: [
            {
              series_id: "ser-1",
              recurrence_id: "20260914T090000",
              cancelled: true,
              title: null,
              start_wall: null,
              end_wall: null,
              tz_id: null,
            },
          ],
        },
      ),
    );
    const { props, vevents } = parseIcs(out);
    expect(vevents).toBe(2);
    // Property order in the FIRST VEVENT: UID before DTSTAMP before DTSTART.
    const slice = props.slice(props.indexOf("BEGIN:VEVENT"));
    const firstUid = slice.findIndex((p) => p.startsWith("UID:"));
    const firstDts = slice.findIndex((p) => p.startsWith("DTSTAMP:"));
    const firstDt = slice.findIndex((p) => p.startsWith("DTSTART"));
    expect(firstUid).toBeLessThan(firstDts);
    expect(firstDts).toBeLessThan(firstDt);
  });
});

// ---------------------------------------------------------------------------
// §4.5 multi-calendar grouping hint
// ---------------------------------------------------------------------------

describe("§4.5: X-TIDE-CALENDAR grouping", () => {
  test("each VEVENT carries its calendar title as an X- property", () => {
    const out = exportToIcs(
      base(
        [
          ev({ event_id: "e-a", calendar_id: "cal-1" }),
          ev({ event_id: "e-b", calendar_id: "cal-2" }),
        ],
        {
          calendars: [
            { calendar_id: "cal-1", title: "Work" },
            { calendar_id: "cal-2", title: "Private; stuff" },
          ],
        },
      ),
    );
    const { props } = parseIcs(out);
    expect(props.some((p) => p === "X-TIDE-CALENDAR:Work")).toBe(true);
    expect(props.some((p) => p === "X-TIDE-CALENDAR:Private\\; stuff")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// §3.7: DTSTAMP present, SEQUENCE:0
// ---------------------------------------------------------------------------

describe("§3.7: DTSTAMP/SEQUENCE", () => {
  test("every VEVENT carries DTSTAMP at export time and SEQUENCE:0", () => {
    const out = exportToIcs(base([ev({ event_id: "e-1" }), ev({ event_id: "e-2" })]));
    const { props } = parseIcs(out);
    expect(props.filter((p) => p === "DTSTAMP:20260908T120000Z").length).toBe(2);
    expect(props.filter((p) => p === "SEQUENCE:0").length).toBe(2);
  });
});
