// DC-14 Appendix A — readable conflict presentation (TD-030).
// Pure presentation helpers from frontend/conflicts.ts, plus the view-model
// pieces they rely on: entity_title for series/calendars (value only; the
// §3.2/§5.2 RPC shapes are unchanged) and one consistent "local" side.
// Zone and "now" are pinned for determinism.
import { describe, expect, test } from "vitest";
import Database from "better-sqlite3";
import { openDatabase, createLocalChange } from "../src/persistence/database.ts";
import {
  ConflictsViewModel,
  type CandidateView,
  type ConflictDetailView,
  type ConflictListItem,
} from "../src/application/conflicts_ui.ts";
import {
  FALLBACK_TEXT,
  MAX_TEXT,
  capText,
  classifyField,
  describeCandidateSide,
  describeConflict,
  describeRepeat,
  inferEntityKind,
  fieldLabel,
  formatCandidateValue,
  formatSchedule,
  formatWhen,
  keepButtonLabel,
  presentConflict,
  renderValue,
  resolutionOptionFor,
  shortDeviceId,
  type FormatOptions,
} from "../frontend/conflicts.ts";

const TZ = "Europe/Berlin";
// Sun 15 Nov 2026 11:00 Berlin.
const NOW = Date.UTC(2026, 10, 15, 10, 0);
const H24: FormatOptions = { locale: "en-GB", timeFormat: "24h", timeZone: TZ, now: NOW };
const H12: FormatOptions = { ...H24, timeFormat: "12h" };
/** Event ids the dialog knows from the event list (kind inference). */
const EV: ReadonlySet<string> = new Set(["e-1"]);

// Sync device ids are "d-" + 64 hex chars.
const OTHER_ID = "d-2ee25c62" + "0123456789abcdef".repeat(3) + "01234567";
// 19:00–20:00 Berlin on Sun 15 Nov 2026 (the A.1 remote side).
const REMOTE_SCHEDULE = {
  startMs: Date.UTC(2026, 10, 15, 18, 0),
  endMs: Date.UTC(2026, 10, 15, 19, 0),
  allDay: false,
};
const LOCAL_SCHEDULE = {
  startMs: Date.UTC(2026, 10, 15, 8, 0),
  endMs: Date.UTC(2026, 10, 15, 9, 0),
  allDay: false,
};

function cand(over: Partial<CandidateView> & { change_id: string }): CandidateView {
  return {
    device_id: "self-device-id-0000",
    device_name: "This device",
    deleted: false,
    value: undefined,
    hlc_timestamp: 0,
    ...over,
  };
}

function detailOf(
  fieldPath: string,
  localValue: unknown,
  remoteValue: unknown,
  extra: Partial<ConflictDetailView> = {},
  remoteDeleted = false,
): ConflictDetailView {
  return {
    conflict_id: "cf-1",
    entity_id: "e-1",
    entity_title: "Test-Windoof",
    field_path: fieldPath,
    status: "unresolved",
    local_change_id: "c-local",
    candidates: [
      cand({
        change_id: "c-local",
        value: localValue,
        hlc_timestamp: Date.UTC(2026, 10, 14, 23, 23), // 00:23 Berlin, 15 Nov
      }),
      cand({
        change_id: "c-remote",
        device_id: OTHER_ID,
        device_name: "Other Tablet",
        value: remoteDeleted ? undefined : remoteValue,
        deleted: remoteDeleted,
        hlc_timestamp: Date.UTC(2026, 10, 14, 23, 30), // 00:30 Berlin, 15 Nov
      }),
    ],
    ...extra,
  };
}

/** Everything a presentation exposes by default (not Technical details). */
function visibleText(d: ConflictDetailView, o: FormatOptions): string {
  const v = presentConflict(d, o, EV);
  return [
    v.title,
    v.header,
    ...v.candidates.flatMap((c) => [c.side, c.keepLabel, c.changed ?? "", ...c.lines.map((l) => `${l.label ?? ""} ${l.text}`)]),
  ].join("\n");
}

const ALL_KINDS: Array<{ path: string; kind?: "calendar" | "event" | "series"; label: string; internal: string[] }> = [
  { path: "schedule", label: "Date & time", internal: ["schedule"] },
  { path: "event", label: "Appointment", internal: [] },
  { path: "title", label: "Title", internal: [] },
  { path: "title", kind: "calendar", label: "Calendar name", internal: [] },
  { path: "recurrence_rule", kind: "series", label: "Repeat", internal: ["recurrence_rule"] },
  { path: "overrides.20261115T190000.title", kind: "series", label: "Title — only on Sun 15 Nov 2026", internal: ["overrides", "20261115T190000"] },
  { path: "overrides.20261115T190000.start_wall", kind: "series", label: "Start time — only on Sun 15 Nov 2026", internal: ["start_wall", "overrides"] },
  { path: "overrides.20261115T190000.end_wall", kind: "series", label: "End time — only on Sun 15 Nov 2026", internal: ["end_wall", "overrides"] },
  { path: "overrides.20261115T190000.cancelled", kind: "series", label: "Cancelled — only on Sun 15 Nov 2026", internal: ["overrides"] },
  { path: "reminders.rem-1234-abcd", label: "Reminder", internal: ["reminders.", "rem-1234"] },
  { path: "*", label: "Deleted", internal: ["*"] },
  { path: "weird.unknown.path", label: "Other change", internal: ["weird"] },
];

describe("TR-A1 field labels: A.2 label, no internal path", () => {
  for (const k of ALL_KINDS) {
    test(`${k.path}${k.kind ? ` (${k.kind})` : ""} -> "${k.label}"`, () => {
      const item: ConflictListItem = {
        conflict_id: "cf",
        entity_id: "e-1",
        field_path: k.path,
        status: "unresolved",
        participant_count: 2,
      };
      const row = describeConflict(item, H24, { entityKind: k.kind ?? "event", startMs: null });
      expect(row).toBe(k.label);
      const d = detailOf(k.path, "a", "b", k.kind === "calendar" ? { entity_id: "local" } : {});
      const header = presentConflict(d, H24, EV).header;
      expect(header).toContain(k.label);
      for (const bad of [...k.internal, "e-1", "field"]) {
        expect(row).not.toContain(bad);
        expect(header).not.toContain(bad);
      }
    });
  }

  test("A.1 list row: date + label, no device count", () => {
    const item: ConflictListItem = {
      conflict_id: "cf",
      entity_id: "e-1",
      field_path: "schedule",
      status: "unresolved",
      participant_count: 2,
    };
    expect(describeConflict(item, H24, { entityKind: "event", startMs: REMOTE_SCHEDULE.startMs })).toBe(
      "Sun 15 Nov · Date & time",
    );
  });
});

describe("TR-A2 Date & time rendering (12h / 24h / locales, no epoch)", () => {
  test("A.1 detail reads as specified (24h)", () => {
    const d = detailOf("schedule", LOCAL_SCHEDULE, REMOTE_SCHEDULE);
    const v = presentConflict(d, H24, EV);
    expect(v.header).toBe('"Test-Windoof" — Date & time was changed on two devices at the same time.');
    expect(v.candidates.map((c) => c.side)).toEqual(["This device (local)", "Device 2ee25c62"]);
    expect(v.candidates[0]!.lines.map((l) => l.text)).toEqual(["Sun 15 Nov 2026, 09:00 – 10:00"]);
    expect(v.candidates[1]!.lines.map((l) => l.text)).toEqual(["Sun 15 Nov 2026, 19:00 – 20:00"]);
    expect(v.candidates.map((c) => c.changed)).toEqual(["changed today 00:23", "changed today 00:30"]);
    expect(v.candidates.map((c) => c.keepLabel)).toEqual(["Keep this device's", "Keep Device 2ee25c62's"]);
  });

  test("12h setting", () => {
    expect(formatSchedule(REMOTE_SCHEDULE, H12)).toBe("Sun 15 Nov 2026, 7:00 PM – 8:00 PM");
    expect(formatWhen(Date.UTC(2026, 10, 14, 23, 30), H12)).toBe("today 12:30 AM");
  });

  test("each supported locale; no epoch number in output", () => {
    const outs = {
      "en-GB": formatSchedule(REMOTE_SCHEDULE, H24),
      "en-US": formatSchedule(REMOTE_SCHEDULE, { ...H24, locale: "en-US" }),
      de: formatSchedule(REMOTE_SCHEDULE, { ...H24, locale: "de" }),
      "en-US 12h": formatSchedule(REMOTE_SCHEDULE, { ...H12, locale: "en-US" }),
    };
    expect(outs["en-GB"]).toBe("Sun 15 Nov 2026, 19:00 – 20:00");
    expect(outs["en-US"]).toBe("Sun Nov 15, 2026, 19:00 – 20:00");
    expect(outs.de).toBe("So. 15. Nov. 2026, 19:00 – 20:00");
    expect(outs["en-US 12h"]).toBe("Sun Nov 15, 2026, 7:00 PM – 8:00 PM");
    for (const s of Object.values(outs)) {
      expect(s).not.toMatch(/\d{10,}/);
      expect(s).not.toContain("startMs");
    }
  });

  test("all-day single day and multi-day span (exclusive end)", () => {
    const oneDay = { startMs: Date.UTC(2026, 10, 14, 23, 0), endMs: Date.UTC(2026, 10, 15, 23, 0), allDay: true };
    expect(formatSchedule(oneDay, H24)).toBe("Sun 15 Nov 2026, all day");
    const span = { startMs: Date.UTC(2026, 10, 14, 23, 0), endMs: Date.UTC(2026, 10, 17, 23, 0), allDay: true };
    expect(formatSchedule(span, H24)).toBe("Sun 15 Nov – Tue 17 Nov 2026");
  });

  test("timed event across midnight names both days", () => {
    const s = { startMs: Date.UTC(2026, 10, 15, 21, 0), endMs: Date.UTC(2026, 10, 16, 0, 30), allDay: false };
    expect(formatSchedule(s, H24)).toBe("Sun 15 Nov 2026, 22:00 – Mon 16 Nov 2026, 01:30");
  });

  test("P2 absolute short 'when': today / yesterday / older / unknown", () => {
    expect(formatWhen(Date.UTC(2026, 10, 14, 17, 12), H24)).toBe("yesterday 18:12");
    expect(formatWhen(Date.UTC(2026, 10, 7, 13, 5), H24)).toBe("Sat 7 Nov 14:05");
    expect(formatWhen(Date.UTC(2025, 10, 7, 13, 5), H24)).toBe("Fri 7 Nov 2025 14:05");
    expect(formatWhen(0, H24)).toBeNull();
  });
});

describe("TR-A3 whole-record (Appointment): only differing sub-fields (P1)", () => {
  const base = { title: "Test-Windoof", description: "", ...LOCAL_SCHEDULE };
  test("only the differing sub-field is shown; all lines available on expand", () => {
    const d = detailOf("event", base, { ...base, ...REMOTE_SCHEDULE });
    const v = presentConflict(d, H24, EV);
    expect(v.hasHidden).toBe(true);
    expect(v.candidates[1]!.lines).toEqual([
      { key: "when", label: "Date & time", text: "Sun 15 Nov 2026, 19:00 – 20:00" },
    ]);
    expect(v.candidates[1]!.allLines.map((l) => l.label)).toEqual(["Title", "Date & time", "Description"]);
    expect(v.candidates[1]!.allLines[2]!.text).toBe("(empty)");
  });

  test("two differing sub-fields both shown", () => {
    const d = detailOf("event", base, { ...base, title: "Renamed", description: "Room 4" });
    const v = presentConflict(d, H24, EV);
    expect(v.candidates[0]!.lines.map((l) => l.key)).toEqual(["title", "description"]);
  });
});

describe("TR-A4 device attribution: never a full device id", () => {
  test("remote side is 'Device <8 chars>' even when a display name exists", () => {
    const d = detailOf("title", "a", "b");
    expect(describeCandidateSide(d, d.candidates[1]!)).toBe("Device 2ee25c62");
    expect(describeCandidateSide(d, d.candidates[0]!)).toBe("This device (local)");
    expect(keepButtonLabel(d, d.candidates[1]!)).toBe("Keep Device 2ee25c62's");
    const v = presentConflict(d, H24, EV);
    const all = visibleText(d, H24) + v.candidates.map((c) => c.raw).join("\n");
    expect(all).not.toContain(OTHER_ID);
    expect(all).not.toContain("self-device-id-0000");
    expect(all).not.toContain("…");
    expect(all).not.toContain("...");
  });

  test("short id skips the 'd-' type prefix; other id shapes use 8 chars verbatim", () => {
    expect(shortDeviceId(OTHER_ID)).toBe("2ee25c62");
    expect(shortDeviceId("dev-f6d77e6c-156a-4b7e")).toBe("dev-f6d7");
    const d = detailOf("title", "a", "b");
    d.candidates[1]!.device_id = "dev-f6d77e6c-156a-4b7e";
    expect(describeCandidateSide(d, d.candidates[1]!)).toBe("Device dev-f6d7");
  });

  test("A.6 buttons keep the §4 mapping", () => {
    const d = detailOf("title", "a", "b");
    expect(resolutionOptionFor(d, d.candidates[0]!)).toEqual({ kind: "keep_mine" });
    expect(resolutionOptionFor(d, d.candidates[1]!)).toEqual({ kind: "keep_theirs", change_id: "c-remote" });
  });
});

describe("TR-A5 unknown shapes: fallback text, raw only under Technical details", () => {
  test("unknown field kind with an object value", () => {
    const d = detailOf("weird.unknown.path", { a: 1 }, { a: 2 });
    const v = presentConflict(d, H24, EV);
    expect(v.label).toBe("Other change");
    expect(v.candidates[0]!.lines.map((l) => l.text)).toEqual([FALLBACK_TEXT]);
    expect(v.candidates[0]!.fallback).toBe(true);
    expect(visibleText(d, H24)).not.toContain('"a"');
    expect(v.candidates[0]!.raw).toContain('"a": 1');
  });

  test("unknown field kind with a string value renders the text", () => {
    const d = detailOf("description", "Room 4", "");
    const v = presentConflict(d, H24, EV);
    expect(v.label).toBe("Other change");
    expect(v.candidates.map((c) => c.lines[0]!.text)).toEqual(["Room 4", "(empty)"]);
  });

  test("schedule with a broken shape falls back (raw kept for diagnosis)", () => {
    const d = detailOf("schedule", { startMs: "soon" }, REMOTE_SCHEDULE);
    const v = presentConflict(d, H24, EV);
    expect(v.candidates[0]!.lines[0]!.text).toBe(FALLBACK_TEXT);
    expect(v.candidates[0]!.raw).toContain("soon");
  });

  test("candidate values are plain text (HTML is not interpreted here)", () => {
    const d = detailOf("title", "<img src=x onerror=alert(1)>", "b");
    expect(presentConflict(d, H24, EV).candidates[0]!.lines[0]!.text).toBe("<img src=x onerror=alert(1)>");
  });
});

describe("A.3 value classes per field kind", () => {
  test("text: title / calendar name, empty forms", () => {
    expect(formatCandidateValue(cand({ change_id: "x", value: "Lunch" }), "title", H24)).toBe("Lunch");
    expect(formatCandidateValue(cand({ change_id: "x", value: "" }), "title", H24)).toBe("(no title)");
    const cal = detailOf("title", "Work", "", { entity_title: "Work", entity_id: "local" });
    const v = presentConflict(cal, H24, EV);
    expect(v.label).toBe("Calendar name");
    expect(v.candidates.map((c) => c.lines[0]!.text)).toEqual(["Work", "(empty)"]);
  });

  test("repeat rules in plain words; unparseable -> Custom repeat rule", () => {
    expect(describeRepeat("FREQ=WEEKLY;BYDAY=MO;UNTIL=20261231", H24)).toBe("Every week on Monday until 31 Dec 2026");
    expect(describeRepeat("FREQ=DAILY;COUNT=3", H24)).toBe("Every day, 3 times");
    expect(describeRepeat("FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE", H24)).toBe("Every 2 weeks on Monday and Wednesday");
    expect(describeRepeat("RRULE:FREQ=YEARLY", H24)).toBe("Every year");
    expect(describeRepeat("FREQ=MONTHLY;BYDAY=2MO", H24)).toBeNull();
    const r = renderValue(classifyField("recurrence_rule", "series"), false, "FREQ=SECONDLY", H24);
    expect(r).toEqual({ lines: [{ text: "Custom repeat rule" }], fallback: true });
  });

  test("override title / start / end / cancelled", () => {
    const fk = (f: string) => classifyField(`overrides.20261115T190000.${f}`, "series");
    expect(renderValue(fk("title"), false, "Moved standup", H24).lines[0]!.text).toBe("Moved standup");
    expect(renderValue(fk("title"), false, null, H24).lines[0]!.text).toBe("Same as the series");
    expect(renderValue(fk("start_wall"), false, "2026-11-15T19:00", H24).lines[0]!.text).toBe("19:00");
    expect(renderValue(fk("start_wall"), false, "2026-11-15T19:00", H12).lines[0]!.text).toBe("7:00 PM");
    expect(renderValue(fk("end_wall"), false, "20:30:00", H24).lines[0]!.text).toBe("20:30");
    expect(renderValue(fk("end_wall"), false, "2026-11-16T00:30", H24).lines[0]!.text).toBe("Mon 16 Nov 2026, 00:30");
    expect(renderValue(fk("cancelled"), false, true, H24).lines[0]!.text).toBe("Cancelled");
    expect(renderValue(fk("cancelled"), false, false, H24).lines[0]!.text).toBe("Takes place");
    expect(fieldLabel(fk("cancelled"), { ...H24, locale: "en-US" })).toBe("Cancelled — only on Sun Nov 15, 2026");
  });

  test("reminders (plain and {value}-wrapped payloads)", () => {
    const fk = classifyField("reminders.rem-1");
    expect(renderValue(fk, false, { minutes_before: 15, enabled: 1 }, H24).lines[0]!.text).toBe("15 minutes before");
    expect(renderValue(fk, false, { value: { minutes_before: 1440, enabled: 1 } }, H24).lines[0]!.text).toBe("1 day before");
    expect(renderValue(fk, false, { minutes_before: 120, enabled: 0 }, H24).lines[0]!.text).toBe("2 hours before (turned off)");
    expect(renderValue(fk, false, { minutes_before: "x" }, H24).lines[0]!.text).toBe(FALLBACK_TEXT);
  });

  test("delete side renders 'Deleted'; the edited side of a removal conflict is recognised by shape", () => {
    const d = detailOf("*", "Renamed", undefined, {}, true);
    const v = presentConflict(d, H24, EV);
    expect(v.header).toBe('"Test-Windoof" — Deleted on one device and changed on another at the same time.');
    expect(v.candidates[0]!.lines).toEqual([{ text: "Renamed" }]);
    const sched = presentConflict(detailOf("*", REMOTE_SCHEDULE, undefined, {}, true), H24, EV);
    expect(sched.candidates[0]!.lines).toEqual([{ label: "Date & time", text: "Sun 15 Nov 2026, 19:00 – 20:00" }]);
    const odd = presentConflict(detailOf("*", { x: 1 }, undefined, {}, true), H24, EV);
    expect(odd.candidates[0]!.lines[0]!.text).toBe(FALLBACK_TEXT);
    expect(v.candidates[1]!.lines).toEqual([{ text: "Deleted" }]);
    expect(v.candidates[1]!.deleted).toBe(true);
    expect(v.candidates[1]!.raw).toBe("(removed)");
    const plainDelete = detailOf("title", "Renamed", undefined, {}, true);
    expect(presentConflict(plainDelete, H24, EV).candidates[1]!.lines[0]!.text).toBe("Deleted");
    // Removed appointment: no row left, so no title; neutral name, never "(no title)".
    const gone = presentConflict(detailOf("*", "Renamed", undefined, { entity_title: null, entity_id: "gone" }, true), H24, EV);
    expect(gone.title).toBe("Deleted appointment");
  });

  test("reminder removed on one side vs changed on the other: not an appointment deletion", () => {
    const d = detailOf("reminders.rem-1", { minutes_before: 15, enabled: 1 }, undefined, {}, true);
    const v = presentConflict(d, H24, EV);
    expect(v.header).toBe('"Test-Windoof" — Reminder was removed on one device and changed on another at the same time.');
    expect(v.candidates.map((c) => c.lines[0]!.text)).toEqual(["15 minutes before", "Deleted"]);
  });

  test("missing title never shows the internal id", () => {
    const d = detailOf("recurrence_rule", "FREQ=DAILY", "FREQ=WEEKLY", { entity_title: null, entity_id: "ser-123" });
    const v = presentConflict(d, H24, EV);
    expect(v.title).toBe("Repeating appointment");
    expect(visibleText(d, H24)).not.toContain("ser-123");
  });
});

describe("entity kind inference (no new data on the wire)", () => {
  test("series / reminder / event / calendar / unknown", () => {
    expect(inferEntityKind("recurrence_rule", "ser-1", "Standup", EV)).toBe("series");
    expect(inferEntityKind("overrides.20261115T190000.title", "ser-1", null, EV)).toBe("series");
    expect(inferEntityKind("reminders.rem-1", "e-1", "x", EV)).toBe("event");
    expect(inferEntityKind("title", "e-1", "Standup", EV)).toBe("event");
    expect(inferEntityKind("title", "local", "My Calendar", EV)).toBe("calendar");
    expect(inferEntityKind("title", "gone", null, EV)).toBe("event"); // removed event
    expect(inferEntityKind("title", "local", "My Calendar", null)).toBe("event"); // list unavailable
    expect(inferEntityKind("weird", "x", null, EV)).toBe("unknown");
  });
});

describe("view-model entity titles (value only, pure reads)", () => {
  test("titles for calendar/series/event; §5.2/§3.2 RPC shapes unchanged", () => {
    const db: Database.Database = openDatabase({ path: ":memory:" });
    const SELF = "self-0000-1111";
    db.prepare(
      "INSERT INTO calendars (calendar_id, title, created_hlc, updated_hlc) VALUES ('cal-1', 'Home', 1, 1)",
    ).run();
    db.prepare(
      `INSERT INTO events (event_id, calendar_id, title, description, all_day,
         start_date, end_date, created_hlc, updated_hlc)
       VALUES ('e-1', 'cal-1', 'Standup', '', 1, '2026-11-15', '2026-11-15', 1, 1)`,
    ).run();
    db.prepare(
      `INSERT INTO series (series_id, base_event_id, recurrence_rule, created_hlc, updated_hlc)
       VALUES ('ser-1', 'e-1', 'FREQ=DAILY', 1, 1)`,
    ).run();
    const local = createLocalChange(db, SELF, {
      entity_id: "cal-1",
      entity_type: "calendar",
      field_path: "title",
      operation: "set",
      payload: { value: "Work" },
      hlc_now: () => 5,
    });
    const mk = (id: string, entity: string, field: string) => {
      db.prepare(
        `INSERT INTO conflicts (conflict_id, entity_id, field_path, status, detected_at_hlc)
         VALUES (?, ?, ?, 'unresolved', 1)`,
      ).run(id, entity, field);
    };
    mk("cf-cal", "cal-1", "title");
    mk("cf-ser", "ser-1", "recurrence_rule");
    mk("cf-ev", "e-1", "schedule");
    db.prepare(
      `INSERT INTO conflict_participants (conflict_id, change_id, device_id, local_seq, causality_clock, payload)
       VALUES ('cf-cal', ?, ?, ?, '{}', ?)`,
    ).run(local.change_id, SELF, local.local_seq, JSON.stringify(local.payload));
    const vm = new ConflictsViewModel(db, SELF);
    for (const item of vm.listUnresolved()) {
      expect(Object.keys(item).sort()).toEqual(
        ["conflict_id", "entity_id", "field_path", "participant_count", "status"],
      );
    }
    expect(vm.getDetail("cf-ser").entity_title).toBe("Standup");
    expect(vm.getDetail("cf-ev").entity_title).toBe("Standup");
    const det = vm.getDetail("cf-cal");
    expect(det.entity_title).toBe("Home");
    expect(Object.keys(det).sort()).toEqual([
      "candidates", "conflict_id", "entity_id", "entity_title", "field_path", "local_change_id", "status",
    ]);
    expect(Object.keys(det.candidates[0]!).sort()).toEqual(
      ["change_id", "deleted", "device_id", "device_name", "hlc_timestamp", "value"],
    );
    expect(inferEntityKind(det.field_path, det.entity_id, det.entity_title, EV)).toBe("calendar");
    expect(presentConflict(det, H24, EV).label).toBe("Calendar name");
    db.close();
  });
});

describe("hostile / out-of-range peer values render as fallback, never as plausible data", () => {
  test("instants beyond the JS Date range do not throw", () => {
    expect(formatSchedule({ startMs: 9e15, endMs: 9e15, allDay: false }, H24)).toBeNull();
    expect(formatSchedule({ startMs: -9e15, endMs: 0, allDay: true }, H24)).toBeNull();
    expect(formatWhen(9e15, H24)).toBeNull();
    const d = detailOf("schedule", { startMs: 9e15, endMs: 9e15 }, REMOTE_SCHEDULE);
    d.candidates[0]!.hlc_timestamp = 9e15;
    const v = presentConflict(d, H24, EV);
    expect(v.candidates[0]!.lines[0]!.text).toBe(FALLBACK_TEXT);
    expect(v.candidates[0]!.changed).toBeNull();
    const item: ConflictListItem = {
      conflict_id: "cf", entity_id: "e-1", field_path: "schedule", status: "unresolved", participant_count: 2,
    };
    expect(describeConflict(item, H24, { entityKind: "event", startMs: 9e15 })).toBe("Date & time");
  });

  test("invalid occurrence ids / wall dates do not roll over", () => {
    expect(classifyField("overrides.20261399T000000.title", "series").kind).toBe("other");
    expect(classifyField("overrides.20261115T250000.title", "series").kind).toBe("other");
    const fk = classifyField("overrides.20261115T190000.start_wall", "series");
    expect(renderValue(fk, false, "2026-13-45T10:00", H24).lines[0]!.text).toBe(FALLBACK_TEXT);
    expect(renderValue(fk, false, "2026-02-30T10:00", H24).lines[0]!.text).toBe(FALLBACK_TEXT);
  });

  test("absurd INTERVAL / COUNT -> Custom repeat rule", () => {
    expect(describeRepeat("FREQ=DAILY;INTERVAL=1e300", H24)).toBeNull();
    expect(describeRepeat("FREQ=DAILY;INTERVAL=1000", H24)).toBeNull();
    expect(describeRepeat("FREQ=DAILY;INTERVAL=999", H24)).toBe("Every 999 days");
    expect(describeRepeat("FREQ=DAILY;COUNT=1e300", H24)).toBeNull();
    expect(describeRepeat("FREQ=DAILY;UNTIL=20261399", H24)).toBeNull();
  });

  test("long values are capped (text, title, raw Technical details)", () => {
    const big = "x".repeat(MAX_TEXT * 50);
    expect(capText(big)).toHaveLength(MAX_TEXT + 1);
    expect(capText(big).endsWith("…")).toBe(true);
    expect(capText("short")).toBe("short");
    const d = detailOf("title", big, "b", { entity_title: big });
    const v = presentConflict(d, H24, EV);
    expect(v.title).toHaveLength(MAX_TEXT + 1);
    expect(v.candidates[0]!.lines[0]!.text).toHaveLength(MAX_TEXT + 1);
    expect(v.candidates[0]!.raw.length).toBeLessThanOrEqual(MAX_TEXT + 1);
    const ev = presentConflict(detailOf("event", { title: "a", description: big, ...LOCAL_SCHEDULE }, { title: "a", description: "", ...LOCAL_SCHEDULE }), H24, EV);
    expect(ev.candidates[0]!.lines[0]!.text).toHaveLength(MAX_TEXT + 1);
  });
});

describe("§4 local side is one participant (getDetail == keep_mine)", () => {
  test("two self participants: local_change_id is the one keep_mine resolves to", () => {
    const db: Database.Database = openDatabase({ path: ":memory:" });
    const SELF = "d-self";
    db.prepare(
      "INSERT INTO calendars (calendar_id, title, created_hlc, updated_hlc) VALUES ('cal-1', 'Home', 1, 1)",
    ).run();
    db.prepare(
      `INSERT INTO events (event_id, calendar_id, title, description, all_day,
         start_date, end_date, created_hlc, updated_hlc)
       VALUES ('e-1', 'cal-1', 'Standup', '', 1, '2026-11-15', '2026-11-15', 1, 1)`,
    ).run();
    let h = 10;
    const mine = ["first local", "second local"].map((value) =>
      createLocalChange(db, SELF, {
        entity_id: "e-1",
        entity_type: "event",
        field_path: "title",
        operation: "set",
        payload: { value },
        hlc_now: () => ++h,
      }),
    );
    db.prepare(
      `INSERT INTO changes (change_id, device_id, local_seq, entity_id, entity_type, field_path,
         operation, payload, hlc_timestamp, causality_clock, schema_version)
       VALUES ('d-other:1', 'd-other', 1, 'e-1', 'event', 'title', 'set', ?, 50, '{"d-other":1}', 1)`,
    ).run(JSON.stringify({ value: "remote" }));
    db.prepare(
      `INSERT INTO conflicts (conflict_id, entity_id, field_path, status, detected_at_hlc)
       VALUES ('cf-2self', 'e-1', 'title', 'unresolved', 1)`,
    ).run();
    const ins = db.prepare(
      `INSERT INTO conflict_participants (conflict_id, change_id, device_id, local_seq, causality_clock, payload)
       VALUES ('cf-2self', ?, ?, ?, '{}', ?)`,
    );
    for (const c of mine) ins.run(c.change_id, SELF, c.local_seq, JSON.stringify(c.payload));
    ins.run("d-other:1", "d-other", 1, JSON.stringify({ value: "remote" }));

    const vm = new ConflictsViewModel(db, SELF);
    const det = vm.getDetail("cf-2self");
    const local = det.candidates.find((c) => c.change_id === det.local_change_id)!;
    // participantsOf order: self first, then change_id ascending.
    const expectedFirst = [...mine].map((c) => c.change_id).sort()[0];
    expect(det.local_change_id).toBe(expectedFirst);
    const rec = vm.resolve("cf-2self", { kind: "keep_mine" });
    expect(rec.payload).toEqual({ value: local.value });
    db.close();
  });
});
