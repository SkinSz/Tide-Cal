// DC-12 recurrence write-path regression tests (APPROVED contract
// docs/contracts/DC-12_recurrence_conflicts.md):
//   * recurring-event creation: create_event + recurrenceRule -> series row +
//     verbatim RRULE change record (§2.1, own conflict entity §3)
//   * series rule edit: update_series_rule / updateSeriesRule
//   * occurrence-override editing: update_occurrence per-field change records
//     with the exact DC-12 §2.2/DC-01 §3.1 entity naming, R2 anchoring of
//     recurrence_id, §4.1 cancellation semantics
//   * D7 (§4.2): deleting the series' base event removes the series + all
//     overrides deterministically
//   * validation: deterministic rejections leave state byte-identical
//   * idempotence (TR-8): re-delivering the same edit changes nothing
import { describe, expect, test, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/persistence/database.ts";
import {
  EventCore,
  validateRRule,
  validateRecurrenceId,
} from "../src/persistence/bridges/event_core.ts";
import { makeDispatcher } from "../src/persistence/bridges/sidecar_server.ts";

let dir: string;
let dbPath: string;
let core: EventCore;
let db: ReturnType<typeof openDatabase>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tide-dc12-"));
  dbPath = join(dir, "tide.db");
  core = new EventCore(dbPath, "test-device");
  db = core.db;
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const TIMED = {
  title: "Standup",
  description: "",
  // 2026-09-02 09:00 local
  startMs: new Date(2026, 8, 2, 9, 0, 0).getTime(),
  endMs: new Date(2026, 8, 2, 10, 0, 0).getTime(),
  allDay: false,
};

function changesFor(entityId: string) {
  return db
    .prepare(
      `SELECT entity_type, field_path, operation, payload
       FROM changes WHERE entity_id = ? ORDER BY local_seq`,
    )
    .all(entityId as never) as Array<{
    entity_type: string;
    field_path: string;
    operation: string;
    payload: string;
  }>;
}

describe("recurring-event creation (DC-12 §2.1)", () => {
  test("createEvent with recurrenceRule writes event + series + verbatim rule record", () => {
    const ev = core.createEvent({ ...TIMED, recurrenceRule: "FREQ=WEEKLY;BYDAY=WE" });
    const series = core.listSeries();
    expect(series).toHaveLength(1);
    expect(series[0]!.baseEventId).toBe(ev.id);
    expect(series[0]!.recurrenceRule).toBe("FREQ=WEEKLY;BYDAY=WE");
    // Rule is its own conflict entity on the series id (DC-12 §3).
    const rec = changesFor(series[0]!.seriesId);
    expect(rec).toHaveLength(1);
    expect(rec[0]).toMatchObject({
      entity_type: "series",
      field_path: "recurrence_rule",
      operation: "set",
    });
    expect(JSON.parse(rec[0]!.payload)).toEqual({
      value: "FREQ=WEEKLY;BYDAY=WE",
    });
    // No override rows yet.
    expect(series[0]!.overrides).toEqual([]);
  });

  test("createEvent without a rule creates no series (plain event)", () => {
    core.createEvent(TIMED);
    expect(core.listSeries()).toEqual([]);
  });

  test("invalid RRULE is rejected before any state change", () => {
    const before = db
      .prepare("SELECT COUNT(*) AS c FROM changes")
      .get() as { c: number };
    for (const bad of [
      "FREQ=SECONDLY",
      "WEEKLY",
      "FREQ=WEEKLY;BYSETPOS=2",
      "FREQ=WEEKLY;INTERVAL=0",
      "FREQ=DAILY;UNTIL=2026-13-40",
      "FREQ=WEEKLY;BYDAY=XX",
      "",
    ]) {
      expect(() =>
        core.createEvent({ ...TIMED, recurrenceRule: bad }),
      ).toThrow();
    }
    const after = db
      .prepare("SELECT COUNT(*) AS c FROM changes")
      .get() as { c: number };
    expect(after.c).toBe(before.c); // no partial writes
    expect(core.listSeries()).toEqual([]);
  });

  test("YEARLY and COUNT/UNTIL rules are accepted and stored verbatim", () => {
    core.createEvent({
      ...TIMED,
      recurrenceRule: "FREQ=MONTHLY;INTERVAL=2;COUNT=6",
    });
    core.createEvent({ ...TIMED, recurrenceRule: "FREQ=YEARLY;UNTIL=20301231" });
    const rules = core.listSeries().map((s) => s.recurrenceRule);
    expect(rules).toContain("FREQ=MONTHLY;INTERVAL=2;COUNT=6");
    expect(rules).toContain("FREQ=YEARLY;UNTIL=20301231");
  });
});

describe("series rule editing (DC-12 §2.1/§3)", () => {
  test("updateSeriesRule rewrites the rule + emits a series change record", () => {
    const ev = core.createEvent({ ...TIMED, recurrenceRule: "FREQ=WEEKLY;BYDAY=WE" });
    const sid = core.listSeries()[0]!.seriesId;
    core.updateSeriesRule(sid, "FREQ=DAILY");
    expect(core.listSeries()[0]!.recurrenceRule).toBe("FREQ=DAILY");
    const recs = changesFor(sid).filter((r) => r.field_path === "recurrence_rule");
    expect(recs).toHaveLength(2);
    expect(JSON.parse(recs[1]!.payload).value).toBe("FREQ=DAILY");
    void ev;
  });

  test("updateSeriesRule is idempotent on an identical rule (no new records)", () => {
    core.createEvent({ ...TIMED, recurrenceRule: "FREQ=DAILY" });
    const sid = core.listSeries()[0]!.seriesId;
    const res = core.updateSeriesRule(sid, "FREQ=DAILY");
    expect(res.recurrenceRule).toBe("FREQ=DAILY");
    expect(changesFor(sid)).toHaveLength(1);
  });

  test("updateSeriesRule on an unknown series throws without writing", () => {
    expect(() => core.updateSeriesRule("nope", "FREQ=DAILY")).toThrow(
      /series not found/,
    );
        expect(() => core.updateSeriesRule("x", "FREQ=BAD")).toThrow(/FREQ/);
  });
});

describe("occurrence-override editing (DC-12 §2.2/§2.3/§4.1)", () => {
  test("cancel + title + move write one change record per field with exact entity naming", () => {
    core.createEvent({ ...TIMED, recurrenceRule: "FREQ=WEEKLY;BYDAY=WE" });
    const sid = core.listSeries()[0]!.seriesId;
    const rid = "20260902T090000";
    const res = core.updateOccurrence(sid, rid, {
      cancelled: true,
      title: "Dentist",
    });
    expect(res.changed.sort()).toEqual(["cancelled", "title"]);
    // Per-field DC-03 conflict entities (DC-12 §2.2 / DC-01 §3.1).
    const paths = changesFor(sid)
      .filter((r) => r.entity_type === "occurrence_override")
      .map((r) => r.field_path);
    expect(paths).toContain(`overrides.${rid}.cancelled`);
    expect(paths).toContain(`overrides.${rid}.title`);
    const cancelRec = changesFor(sid).find(
      (r) => r.field_path === `overrides.${rid}.cancelled`,
    )!;
    expect(JSON.parse(cancelRec.payload)).toEqual({ value: true });
    // Row state.
    const s = core.listSeries().find((x) => x.seriesId === sid)!;
    expect(s.overrides).toEqual([
      {
        recurrenceId: rid,
        cancelled: true,
        title: "Dentist",
        startWall: null,
        endWall: null,
        tzId: null,
      },
    ]);
  });

  test("second patch merges fields; recurrence_id is never rewritten (R2)", () => {
    core.createEvent({ ...TIMED, recurrenceRule: "FREQ=DAILY" });
    const sid = core.listSeries()[0]!.seriesId;
    core.updateOccurrence(sid, "20260902T090000", { title: "A" });
    core.updateOccurrence(sid, "20260902T090000", {
      start_wall: "2026-09-02T14:00",
    });
    const s = core.listSeries().find((x) => x.seriesId === sid)!;
    expect(s.overrides).toHaveLength(1);
    expect(s.overrides[0]).toMatchObject({
      recurrenceId: "20260902T090000",
      title: "A",
      startWall: "2026-09-02T14:00",
    });
  });

  test("re-delivering an identical override patch is a no-op (TR-8)", () => {
    core.createEvent({ ...TIMED, recurrenceRule: "FREQ=DAILY" });
    const sid = core.listSeries()[0]!.seriesId;
    core.updateOccurrence(sid, "20260902T090000", {
      cancelled: true,
      title: "Dentist",
    });
    const before = db.prepare("SELECT COUNT(*) AS c FROM changes").get();
    const res = core.updateOccurrence(sid, "20260902T090000", {
      cancelled: true,
      title: "Dentist",
    });
    expect(res.changed).toEqual([]);
    const after = db.prepare("SELECT COUNT(*) AS c FROM changes").get();
    expect(after).toEqual(before);
    expect(core.listSeries()[0]!.overrides).toHaveLength(1);
  });

  test("validation rejections are deterministic and state-free", () => {
    core.createEvent({ ...TIMED, recurrenceRule: "FREQ=DAILY" });
    const sid = core.listSeries()[0]!.seriesId;
    const before = db.prepare("SELECT COUNT(*) AS c FROM changes").get();
    expect(() =>
      core.updateOccurrence(sid, "20260902", { cancelled: true }),
    ).toThrow(/YYYYMMDDTHHMMSS/);
    expect(() => core.updateOccurrence(sid, "20260902T090000", {})).toThrow(
      /at least one field/,
    );
    expect(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      core.updateOccurrence(sid, "20260902T090000", { bogus: 1 } as any),
    ).toThrow(/unknown patch field/);
    expect(() =>
      core.updateOccurrence("missing", "20260902T090000", { title: "x" }),
    ).toThrow(/series not found/);
    expect(db.prepare("SELECT COUNT(*) AS c FROM changes").get()).toEqual(before);
  });
});

describe("D7 — series deletion dominates its overrides (DC-12 §4.2)", () => {
  test("deleting the base event removes series + overrides + writes both records", () => {
    const ev = core.createEvent({ ...TIMED, recurrenceRule: "FREQ=DAILY" });
    const sid = core.listSeries()[0]!.seriesId;
    core.updateOccurrence(sid, "20260902T090000", { cancelled: true });
    expect(core.listSeries()[0]!.overrides).toHaveLength(1);

    core.deleteEvent(ev.id);
    expect(core.listSeries()).toEqual([]);
    expect(
      db.prepare("SELECT COUNT(*) AS c FROM occurrence_overrides").get(),
    ).toEqual({ c: 0 });
    expect(db.prepare("SELECT COUNT(*) AS c FROM series").get()).toEqual({
      c: 0,
    });
    const types = changesFor(sid).map((r) => `${r.entity_type}:${r.field_path}`);
    expect(types).toContain("series:*"); // series tombstone (D7 structural)
    // Deleting again is idempotent.
    core.deleteEvent(ev.id);
    expect(core.listSeries()).toEqual([]);
  });

  test("deleting a plain event writes no series records", () => {
    const ev = core.createEvent(TIMED);
    core.deleteEvent(ev.id);
    const seriesRecs = db
      .prepare("SELECT COUNT(*) AS c FROM changes WHERE entity_type = 'series'")
      .get();
    expect(seriesRecs).toEqual({ c: 0 });
  });
});

describe("sidecar dispatcher: DC-12 ops", () => {
  const dispatch = () => makeDispatcher(core);

  test("create_event accepts recurrenceRule; update_event rejects it", () => {
    const d = dispatch();
    const ev = d("create_event", {
      input: { ...TIMED, recurrenceRule: "FREQ=DAILY" },
    }) as { id: string };
    expect(core.listSeries()).toHaveLength(1);
    expect(() =>
      d("update_event", {
        id: ev.id,
        input: { ...TIMED, recurrenceRule: "FREQ=DAILY" },
      }),
    ).toThrow(/update_series_rule/);
  });

  test("update_series_rule + update_occurrence round-trip and validate", () => {
    const d = dispatch();
    d("create_event", { input: { ...TIMED, recurrenceRule: "FREQ=DAILY" } });
    const sid = core.listSeries()[0]!.seriesId;
    expect(d("update_series_rule", { series_id: sid, rule: "FREQ=WEEKLY" })).toEqual({
      seriesId: sid,
      recurrenceRule: "FREQ=WEEKLY",
    });
    expect(() =>
      d("update_series_rule", { series_id: sid, rule: "GARBAGE" }),
    ).toThrow();
    const occ = d("update_occurrence", {
      series_id: sid,
      recurrence_id: "20260902T090000",
      patch: { cancelled: true },
    }) as { changed: string[] };
    expect(occ.changed).toEqual(["cancelled"]);
    expect(() =>
      d("update_occurrence", {
        series_id: sid,
        recurrence_id: "bad-rid",
        patch: { cancelled: true },
      }),
    ).toThrow(/YYYYMMDDTHHMMSS/);
    expect(() =>
      d("update_occurrence", {
        series_id: sid,
        recurrence_id: "20260902T090000",
        patch: {},
      }),
    ).toThrow(/at least one field/);
  });
});

describe("frontend/store.ts DC-12 write fns over an injected EventCore bridge", () => {
  test("createEvent with rule, updateSeriesRule and updateOccurrence route through EventCore", async () => {
    const { createEvent, updateSeriesRule, updateOccurrence, listSeries } =
      await import("../frontend/store.ts");
    const prevWindow = (globalThis as { window?: unknown }).window;
    (globalThis as { window?: unknown }).window = {
      __TIDE_EVENT_STORE__: {
        listEvents: () => core.listEvents(),
        createEvent: (input: never) => core.createEvent(input),
        updateEvent: (id: string, input: never) => core.updateEvent(id, input),
        deleteEvent: (id: string) => core.deleteEvent(id),
        listSeries: () => core.listSeries(),
        updateSeriesRule: (sid: string, rule: string) =>
          core.updateSeriesRule(sid, rule),
        updateOccurrence: (
          sid: string,
          rid: string,
          patch: never,
        ) => core.updateOccurrence(sid, rid, patch),
      },
    };
    try {
      const ev = await createEvent({
        ...TIMED,
        recurrenceRule: "FREQ=WEEKLY;BYDAY=WE",
      });
      let rows = await listSeries();
      expect(rows).toHaveLength(1);
      const sid = rows[0]!.seriesId;
      await updateSeriesRule(sid, "FREQ=DAILY");
      const rid = "20260902T090000";
      await updateOccurrence(sid, rid, { cancelled: true });
      rows = await listSeries();
      expect(rows[0]!.recurrenceRule).toBe("FREQ=DAILY");
      expect(rows[0]!.overrides[0]).toMatchObject({
        recurrenceId: rid,
        cancelled: true,
      });
      void ev;
    } finally {
      (globalThis as { window?: unknown }).window = prevWindow;
    }
  });
});

describe("validators", () => {
  test("validateRRule accepts the supported subset verbatim", () => {
    expect(validateRRule("FREQ=WEEKLY;BYDAY=MO,FR", "t")).toBe(
      "FREQ=WEEKLY;BYDAY=MO,FR",
    );
  });
  test("validateRecurrenceId enforces the canonical wall-clock form", () => {
    expect(validateRecurrenceId("20260902T090000", "t")).toBe("20260902T090000");
    expect(() => validateRecurrenceId("2026-09-02T09:00", "t")).toThrow();
    expect(() => validateRecurrenceId("20260902T09000Z", "t")).toThrow();
  });
});
