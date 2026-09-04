// Tide bridge: calendar event storage wired through the TS domain core.
//
// This is the desktop-runtime adapter between the shell-local event CRUD
// surface (Tauri commands / sidecar protocol) and the approved DC-07
// transactional core in src/persistence/database.ts. All mutations go
// through createLocalChange(), so every entity mutation lands atomically
// with its change record and the device_clock advance (DC-07 §7 T1).
// The domain core itself is NOT modified — this file only supplies the
// entity-row `mutate` callbacks and the mapping to/from CalendarEvent.

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { openDatabase, createLocalChange } from "../database.ts";

export interface CalendarEvent {
  id: string;
  title: string;
  description: string;
  /** epoch ms */
  startMs: number;
  /** epoch ms */
  endMs: number;
  allDay: boolean;
}

export interface EventInput {
  title: string;
  description: string;
  startMs: number;
  endMs: number;
  allDay: boolean;
  /**
   * DC-12 §2.1: optional RFC 5545 RRULE (e.g. "FREQ=WEEKLY;BYDAY=MO").
   * Honored on CREATE only — its presence turns the event into the base
   * event of a recurring series (a `series` row + a verbatim stored rule).
   * Rule edits on an existing series go through updateSeriesRule / the
   * update_series_rule op (their own conflict entity per DC-12 §3).
   */
  recurrenceRule?: string;
}

const DEFAULT_CALENDAR_ID = "local";

/**
 * Monotone hybrid-logical-clock ticker (ms resolution, presentation-only
 * per DC-01 §4.4). Never goes backwards within a process lifetime.
 */
export class HlcTicker {
  private last = 0;

  now(): number {
    const wall = Date.now();
    this.last = wall > this.last ? wall : this.last + 1;
    return this.last;
  }
}

function loadOrCreateDeviceId(dbPath: string): string {
  const marker = `${dbPath}.device_id`;
  if (existsSync(marker)) {
    return readFileSync(marker, "utf8").trim();
  }
  const id = `dev-${randomUUID()}`;
  writeFileSync(marker, id, "utf8");
  return id;
}

/** Local-timezone calendar day (YYYY-MM-DD) for an epoch-ms instant. */
function localDateStr(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Local wall-clock time HH:MM:SS for an epoch-ms instant. */
function localWallStr(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function timezoneId(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

interface EventRow {
  event_id: string;
  title: string;
  description: string;
  all_day: number;
  start_date: string | null;
  end_date: string | null;
  start_wall: string | null;
  end_wall: string | null;
  utc_start_ms: number | null;
  utc_end_ms: number | null;
}

/**
 * M-1 / BND-01 identity guard (defense-in-depth behind the sidecar
 * dispatcher's validation): an EventInput must NEVER carry an `id`.
 *
 * The event identity is owned by the domain core — `createEvent` generates
 * it, `updateEvent` takes it from the op's target argument. Historically
 * `updateEvent` built `{id, ...input}`, so a client-supplied `input.id`
 * silently overrode the real target: the row write (upsert) missed the
 * target and INSERTED a phantom row while the change records were still
 * written under the target's entity — record/row divergence that survives
 * restart and diverges sync peers. This guard makes the violation an
 * explicit, deterministic error at the domain layer too, so even callers
 * that bypass the sidecar dispatcher cannot corrupt state.
 */
function assertNoInjectedId(input: EventInput, op: "create" | "update"): void {
  if (input !== null && typeof input === "object" && "id" in input) {
    throw new Error(
      `${op}_event: input.id is not accepted — event ids are assigned by ` +
        `the sidecar (update targets come from the op's id argument) and a ` +
        `client-injected id is rejected without any state change`,
    );
  }
}

// ---------------------------------------------------------------------------
// Pkg 3 (QA M-5/BND-02, M-6/BND-03): canonical VALUE-level event validation.
//
// Single source of truth for the numeric/temporal rules, shared by the
// sidecar dispatcher (wire boundary) and the domain core itself
// (defense-in-depth, holds even if the dispatcher is bypassed). Every
// violation throws a deterministic error BEFORE any createLocalChange() /
// row write, so persistent state (rows + change log + entity_versions) is
// byte-identical after a rejected request.
//
// Rules (see docs/qa/remediation/pkg3-report.md §2):
//   - startMs/endMs must be INTEGRAL epoch milliseconds. Fractional values
//     are rejected, never rounded: the events table declares
//     utc_start_ms/utc_end_ms with INTEGER affinity, so binding 42.5 would
//     silently store a REAL — the BND-03 class of seam-level coercion.
//   - |startMs|/|endMs| <= MAX_EVENT_MS. The epoch-ms domain is bounded at
//     ±8.64e15 (ECMAScript Date range, ±100M days). Wider integers up to
//     2^53 would pass an integer check but make Date arithmetic return
//     Invalid Date, silently writing "NaN-NaN-NaN" into the derived
//     start_date/end_date columns — the same silent-garbage class. The
//     bound also guarantees exact JSON round-trips to sync peers.
//   - endMs >= startMs (BND-02). Inverted ranges are REJECTED, never
//     clamped: the baseline clamp made the response echo, the stored row,
//     and the change-record payload carry three different values.
//   - Negative timestamps and 0 are VALID (pre-1970 instants; epoch 0).
//     The domain has no historical lower bound, and every persistence,
//     derived-column, and sync path round-trips negatives exactly.
// ---------------------------------------------------------------------------

/** Inclusive |epoch ms| bound: ECMAScript Date range (±100,000,000 days). */
export const MAX_EVENT_MS = 8_640_000_000_000_000;

export function validateEventValues(input: EventInput, op: string): void {
  for (const k of ["startMs", "endMs"] as const) {
    const v = input[k];
    if (typeof v !== "number" || !Number.isInteger(v)) {
      throw new Error(
        `${op}: input.${k} must be an integer number of epoch ` +
          `milliseconds (fractional/non-numeric values are rejected, ` +
          `never coerced)`,
      );
    }
    if (Math.abs(v) > MAX_EVENT_MS) {
      throw new Error(
        `${op}: input.${k} ${v} is outside the epoch-ms domain ` +
          `(+/-${MAX_EVENT_MS}); values beyond it are rejected because ` +
          `Date-derived columns and exact JSON round-trips cannot represent them`,
      );
    }
  }
  if (input.endMs < input.startMs) {
    throw new Error(
      `${op}: input.endMs (${input.endMs}) must be >= input.startMs ` +
        `(${input.startMs}) — inverted ranges are rejected without any ` +
        `state change`,
    );
  }
}

// ---------------------------------------------------------------------------
// DC-12 §2.1: RRULE validation. Tide defines NO custom recurrence DSL — the
// RFC 5545 RRULE string is stored and exchanged VERBATIM. This validator is
// the write-path gate (create_event / update_series_rule): it accepts the
// common RFC 5545 subset the rule builder produces (FREQ required; optional
// INTERVAL, BYDAY, COUNT, UNTIL), rejects everything else deterministically
// BEFORE any change record / row write, and stores the string byte-identical.
// ---------------------------------------------------------------------------

const RRULE_FREQS = new Set(["DAILY", "WEEKLY", "MONTHLY", "YEARLY"]);
const RRULE_KEYS = new Set(["FREQ", "INTERVAL", "BYDAY", "COUNT", "UNTIL"]);
const RRULE_DAYS = new Set(["MO", "TU", "WE", "TH", "FR", "SA", "SU"]);

/** Canonical recurrence_id form (DC-12 §2.3): "YYYYMMDDTHHMMSS". */
const RECURRENCE_ID_RE = /^\d{8}T\d{6}$/;

/**
 * Validate an RRULE string (DC-12 §2.1). Returns the rule verbatim on
 * success; throws a deterministic error otherwise. Never rewrites the rule.
 */
export function validateRRule(rule: unknown, op: string): string {
  if (typeof rule !== "string" || rule.trim().length === 0) {
    throw new Error(`${op}: recurrence_rule must be a non-empty RRULE string`);
  }
  const segments = rule.split(";");
  let sawFreq = false;
  for (const seg of segments) {
    const eq = seg.indexOf("=");
    if (eq <= 0) {
      throw new Error(
        `${op}: recurrence_rule segment "${seg}" is not KEY=VALUE — ` +
          `the rule must be a semicolon-separated RFC 5545 RRULE`,
      );
    }
    const key = seg.slice(0, eq).trim().toUpperCase();
    const value = seg.slice(eq + 1).trim();
    if (!RRULE_KEYS.has(key)) {
      throw new Error(
        `${op}: recurrence_rule key "${key}" is not supported — allowed: ` +
          `FREQ, INTERVAL, BYDAY, COUNT, UNTIL`,
      );
    }
    if (value.length === 0) {
      throw new Error(`${op}: recurrence_rule key "${key}" has an empty value`);
    }
    switch (key) {
      case "FREQ": {
        const f = value.toUpperCase();
        if (!RRULE_FREQS.has(f)) {
          throw new Error(
            `${op}: recurrence_rule FREQ "${value}" is not supported — ` +
              `allowed: DAILY, WEEKLY, MONTHLY, YEARLY`,
          );
        }
        sawFreq = true;
        break;
      }
      case "INTERVAL": {
        const n = Number(value);
        if (!Number.isInteger(n) || n < 1) {
          throw new Error(
            `${op}: recurrence_rule INTERVAL "${value}" must be an integer >= 1`,
          );
        }
        break;
      }
      case "COUNT": {
        const n = Number(value);
        if (!Number.isInteger(n) || n < 1) {
          throw new Error(
            `${op}: recurrence_rule COUNT "${value}" must be an integer >= 1`,
          );
        }
        break;
      }
      case "UNTIL": {
        if (!/^\d{8}$/.test(value)) {
          throw new Error(
            `${op}: recurrence_rule UNTIL "${value}" must be the form YYYYMMDD`,
          );
        }
        break;
      }
      case "BYDAY": {
        for (const d of value.split(",")) {
          if (!RRULE_DAYS.has(d.trim().toUpperCase())) {
            throw new Error(
              `${op}: recurrence_rule BYDAY value "${d}" is not a weekday ` +
                `(MO TU WE TH FR SA SU)`,
            );
          }
        }
        break;
      }
    }
  }
  if (!sawFreq) {
    throw new Error(`${op}: recurrence_rule is missing required FREQ`);
  }
  return rule;
}

/** Validate a canonical recurrence_id (DC-12 §2.3 "YYYYMMDDTHHMMSS"). */
export function validateRecurrenceId(rid: unknown, op: string): string {
  if (typeof rid !== "string" || !RECURRENCE_ID_RE.test(rid)) {
    throw new Error(
      `${op}: recurrence_id must be the canonical wall-clock form ` +
        `"YYYYMMDDTHHMMSS" (DC-12 §2.3), got: ${JSON.stringify(rid)}`,
    );
  }
  return rid;
}

/** Override fields a client may set (DC-12 §2.2 / DC-07). */
export const OVERRIDE_FIELDS = [
  "cancelled",
  "title",
  "start_wall",
  "end_wall",
  "tz_id",
] as const;

export type OverridePatch = Partial<{
  cancelled: boolean;
  title: string;
  start_wall: string;
  end_wall: string;
  tz_id: string;
}>;

/** occurrence_overrides row shape (the fields this bridge reads/writes). */
interface OverrideRow {
  series_id: string;
  recurrence_id: string;
  cancelled: number;
  title: string | null;
  start_wall: string | null;
  end_wall: string | null;
  tz_id: string | null;
  updated_hlc?: number;
}

export class EventCore {
  readonly db: ReturnType<typeof openDatabase>;
  readonly dbPath: string;
  private readonly deviceId: string;
  private readonly hlc = new HlcTicker();

  constructor(dbPath: string, deviceId?: string) {
    this.dbPath = dbPath;
    this.db = openDatabase({ path: dbPath });
    // Explicit id keeps one device = ONE identity across core + sync engine;
    // the marker-file fallback stays for legacy/standalone constructions.
    this.deviceId = deviceId ?? loadOrCreateDeviceId(dbPath);
    this.ensureDefaultCalendar();
  }

  get selfDeviceId(): string {
    return this.deviceId;
  }

  // -------------------------------------------------------------------------
  // DC-22: reminder members (collection members; replicate per D5).
  // -------------------------------------------------------------------------

  /** Read one event's reminder member, or null. */
  reminderFor(eventId: string): { minutesBefore: number; enabled: boolean } | null {
    const row = this.db
      .prepare<[string], { minutes_before: number; enabled: number | null }>(
        "SELECT minutes_before, enabled FROM reminders WHERE entity_id = ?",
      )
      .get(eventId);
    if (row === undefined) return null;
    return { minutesBefore: row.minutes_before, enabled: row.enabled !== 0 };
  }

  /**
   * Create-or-update this event's reminder member (v1 UI: one member per
   * event). Replicates as member_add / member_update (D5: disabled members
   * are stored-but-inactive AND still replicate).
   */
  setReminder(eventId: string, reminder: { minutesBefore: number; enabled: boolean }): void {
    if (!Number.isInteger(reminder.minutesBefore) || reminder.minutesBefore < 0) {
      throw new Error("setReminder: minutes_before must be a non-negative integer");
    }
    // The event must exist — a reminder for a non-entity is an orphan.
    if (this.getEventRow(eventId) === undefined) {
      throw new Error(`setReminder: event not found: ${eventId}`);
    }
    const existing = this.db
      .prepare<[string], { member_id: string }>(
        "SELECT member_id FROM reminders WHERE entity_id = ?",
      )
      .get(eventId);
    const hlc = this.hlc.now();
    if (existing !== undefined) {
      createLocalChange(
        this.db,
        this.deviceId,
        {
          entity_id: eventId,
          entity_type: "reminder",
          field_path: `reminders.${existing.member_id}`,
          operation: "member_update",
          payload: {
            value: { minutes_before: reminder.minutesBefore, enabled: reminder.enabled ? 1 : 0 },
          },
          hlc_now: () => hlc,
        },
        (db) => {
          db.prepare(
            "UPDATE reminders SET minutes_before = ?, enabled = ?, updated_hlc = ? WHERE member_id = ?",
          ).run(reminder.minutesBefore, reminder.enabled ? 1 : 0, hlc, existing.member_id);
        },
      );
      return;
    }
    const memberId = `rem-${randomUUID()}`;
    createLocalChange(
      this.db,
      this.deviceId,
      {
        entity_id: eventId,
        entity_type: "reminder",
        field_path: `reminders.${memberId}`,
        operation: "member_add",
        payload: {
          value: { minutes_before: reminder.minutesBefore, enabled: reminder.enabled ? 1 : 0 },
        },
        hlc_now: () => hlc,
      },
      (db) => {
        db.prepare(
          `INSERT INTO reminders (member_id, entity_id, collection_path, minutes_before, enabled, updated_hlc)
           VALUES (?, ?, 'reminders', ?, ?, ?)`,
        ).run(memberId, eventId, reminder.minutesBefore, reminder.enabled ? 1 : 0, hlc);
      },
    );
  }

  /** Remove the event's reminder member (member_remove). Idempotent. */
  clearReminder(eventId: string): void {
    const existing = this.db
      .prepare<[string], { member_id: string }>(
        "SELECT member_id FROM reminders WHERE entity_id = ?",
      )
      .get(eventId);
    if (existing === undefined) return;
    const hlc = this.hlc.now();
    createLocalChange(
      this.db,
      this.deviceId,
      {
        entity_id: eventId,
        entity_type: "reminder",
        field_path: `reminders.${existing.member_id}`,
        operation: "member_remove",
        payload: { value: null },
        hlc_now: () => hlc,
      },
      (db) => {
        db.prepare("DELETE FROM reminders WHERE member_id = ?").run(existing.member_id);
      },
    );
  }

  /**
   * Bootstrap the shell-local calendar through the same T1 path so even
   * this bootstrap produces an auditable change record.
   *
   * Pkg6 (QA-2 F-1): the bootstrap change is emitted ONLY when the calendar
   * row is MISSING. Previously the T1 ran unconditionally, so every
   * sidecar restart emitted a fresh authoritative "title='My Calendar'"
   * change for an entity that already existed — a spurious change per
   * restart (QA-2 s5_cycles.json: changes_delta=1 x N). Beyond noise, that
   * is a latent LWW data-loss trap: once calendar rename ships, a restart
   * would re-assert the DEFAULT title over a peer-renamed calendar. An
   * existing row (local or synced) is left completely untouched — no
   * change record, no device_clock advance, no updated_hlc churn.
   */
  private ensureDefaultCalendar(): void {
    const exists = this.db
      .prepare<[string], unknown>(
        "SELECT 1 FROM calendars WHERE calendar_id = ?",
      )
      .get(DEFAULT_CALENDAR_ID);
    if (exists !== undefined) return; // already bootstrapped: no-op
    const hlc = this.hlc.now();
    createLocalChange(
      this.db,
      this.deviceId,
      {
        entity_id: DEFAULT_CALENDAR_ID,
        entity_type: "calendar",
        field_path: "title",
        operation: "set",
        payload: { value: "My Calendar" },
        hlc_now: () => hlc,
      },
      (db) => {
        db.prepare(
          `INSERT INTO calendars (calendar_id, title, color, created_hlc, updated_hlc)
           VALUES (?, ?, NULL, ?, ?)
           ON CONFLICT(calendar_id) DO NOTHING`,
        ).run(DEFAULT_CALENDAR_ID, "My Calendar", hlc, hlc);
      },
    );
  }

  listEvents(range?: { fromMs?: number | null; toMs?: number | null }): CalendarEvent[] {
    let rows: EventRow[];
    if (range?.fromMs != null && range?.toMs != null) {
      rows = this.db
        .prepare<[number, number], EventRow>(
          `SELECT event_id, title, description, all_day, start_date, end_date,
                  start_wall, end_wall, utc_start_ms, utc_end_ms
           FROM events WHERE utc_start_ms IS NOT NULL
             AND utc_start_ms < ? AND utc_end_ms > ?
           ORDER BY utc_start_ms`,
        )
        .all(range.toMs, range.fromMs);
    } else {
      rows = this.db
        .prepare<[], EventRow>(
          `SELECT event_id, title, description, all_day, start_date, end_date,
                  start_wall, end_wall, utc_start_ms, utc_end_ms
           FROM events ORDER BY utc_start_ms`,
        )
        .all();
    }
    return rows.map(rowToEvent).sort(byStart);
  }

  createEvent(input: EventInput): CalendarEvent {
    // M-1/BND-01: identity is core-owned. Explicit field pick instead of
    // `{id, ...input}` so a client-injected `input.id` can never override
    // the generated id even if the dispatcher guard were bypassed.
    assertNoInjectedId(input, "create");
    // DC-12 §2.1: validate the RRULE BEFORE any write so an invalid rule
    // leaves rows + change log byte-identical (no orphan series, no event).
    const rule =
      input.recurrenceRule !== undefined
        ? validateRRule(input.recurrenceRule, "create_event")
        : undefined;
    const event: CalendarEvent = {
      id: `evt-${randomUUID()}`,
      title: input.title,
      description: input.description,
      startMs: input.startMs,
      endMs: input.endMs,
      allDay: input.allDay,
    };
    // Pkg 3: canonical value validation BEFORE any change record / row write
    // (BND-02 inverted range, BND-03 non-integral timestamps) — a rejected
    // create leaves rows + change log + entity_versions byte-identical.
    validateEventValues(event, "create_event");
    const hlc = this.hlc.now();
    createLocalChange(
      this.db,
      this.deviceId,
      {
        entity_id: event.id,
        entity_type: "event",
        field_path: "event",
        operation: "set",
        payload: { value: eventFields(event) },
        hlc_now: () => hlc,
      },
      (db, _record) => {
        insertEventRow(db, event, hlc);
      },
    );
    // DC-12 §2.1: a create-time RRULE makes this event a series base event.
    // The series row + its change record land in a SECOND T1 (separate entity:
    // the rule is its own conflict entity, DC-12 §3) only after the event
    // write succeeded — a failed event create never leaves a dangling series.
    if (rule !== undefined) {
      const seriesId = `ser-${randomUUID()}`;
      const seriesHlc = this.hlc.now();
      createLocalChange(
        this.db,
        this.deviceId,
        {
          entity_id: seriesId,
          entity_type: "series",
          field_path: "recurrence_rule",
          operation: "set",
          payload: { value: rule },
          hlc_now: () => seriesHlc,
        },
        (db) => {
          db.prepare(
            `INSERT INTO series (series_id, base_event_id, recurrence_rule, created_hlc, updated_hlc)
             VALUES (?, ?, ?, ?, ?)`,
          ).run(seriesId, event.id, rule, seriesHlc, seriesHlc);
        },
      );
    }
    return event;
  }

  updateEvent(id: string, input: EventInput): CalendarEvent {
    // M-1/BND-01: the target identity is FROZEN to the op's `id` argument.
    // A client-supplied input.id is an explicit error (see
    // assertNoInjectedId) — never a silent re-target, and never a phantom
    // insert. The updated row/result are built by explicit field pick so
    // `input` cannot smuggle the identity (or any other field) in.
    assertNoInjectedId(input, "update");
    const existing = this.getEventRow(id);
    if (!existing) throw new Error(`event not found: ${id}`);
    const before = rowToEvent(existing);
    const updated: CalendarEvent = {
      id,
      title: input.title,
      description: input.description,
      startMs: input.startMs,
      endMs: input.endMs,
      allDay: input.allDay,
    };
    // Pkg 3: canonical value validation on the MERGED event (the full input
    // the dispatcher required) BEFORE any change record / row write —
    // BND-02's inverted-range clamp (and its response/row/record value
    // split) is now a deterministic rejection.
    validateEventValues(updated, "update_event");

    // One T1 record per logical field group that actually changed
    // (DC-01 field-level semantics: title / description / schedule).
    const groups: Array<{
      field_path: string;
      value: unknown;
      changed: boolean;
    }> = [
      {
        field_path: "title",
        value: input.title,
        changed: before.title !== input.title,
      },
      {
        field_path: "description",
        value: input.description,
        changed: before.description !== input.description,
      },
      {
        field_path: "schedule",
        value: { startMs: input.startMs, endMs: input.endMs, allDay: input.allDay },
        changed:
          before.startMs !== input.startMs ||
          before.endMs !== input.endMs ||
          before.allDay !== input.allDay,
      },
    ];

    for (const g of groups.filter((g) => g.changed)) {
      const hlc = this.hlc.now();
      createLocalChange(
        this.db,
        this.deviceId,
        {
          entity_id: id,
          entity_type: "event",
          field_path: g.field_path,
          operation: "set",
          payload: { value: g.value },
          hlc_now: () => hlc,
        },
        (db) => {
          // Row rewrite inside the same transaction as each change record;
          // updated_hlc mirrors the record's HLC timestamp.
          insertEventRow(db, updated, hlc, true);
        },
      );
    }
    return updated;
  }

  deleteEvent(id: string): void {
    const existing = this.getEventRow(id);
    if (!existing) return; // idempotent delete, matches shell-store behavior
    // Resolve the series identity BEFORE any delete (it is needed both for
    // the row cleanup below and for the D7 series tombstone record).
    const series = this.seriesForBaseEvent(id);
    const hlc = this.hlc.now();
    createLocalChange(
      this.db,
      this.deviceId,
      {
        entity_id: id,
        entity_type: "event",
        field_path: "*",
        operation: "remove",
        payload: {},
        hlc_now: () => hlc,
      },
      (db) => {
        // D7 delete order respects the FK graph (foreign_keys = ON):
        // overrides -> series -> base event, all in the one T1 transaction.
        // DC-12 §4.2 RULE D7: the series tombstone structurally dominates
        // its overrides — deterministic, NOT a conflict, even vs concurrent
        // override edits. One series-level remove record carries the
        // structure; no per-override records, no resurrection path.
        if (series) {
          db.prepare("DELETE FROM occurrence_overrides WHERE series_id = ?").run(
            series.series_id,
          );
          db.prepare("DELETE FROM series WHERE series_id = ?").run(
            series.series_id,
          );
        }
        db.prepare("DELETE FROM events WHERE event_id = ?").run(id);
      },
    );
    // D7 series-level tombstone (own entity per DC-01 §6 / DC-12 §4.2).
    if (series) {
      const seriesHlc = this.hlc.now();
      createLocalChange(
        this.db,
        this.deviceId,
        {
          entity_id: series.series_id,
          entity_type: "series",
          field_path: "*",
          operation: "remove",
          payload: {},
          hlc_now: () => seriesHlc,
        },
      );
    }
  }

  private getEventRow(id: string): EventRow | undefined {
    return this.db
      .prepare<[string], EventRow>(
        `SELECT event_id, title, description, all_day, start_date, end_date,
                start_wall, end_wall, utc_start_ms, utc_end_ms
         FROM events WHERE event_id = ?`,
      )
      .get(id);
  }

  private seriesForBaseEvent(
    baseEventId: string,
  ): { series_id: string; recurrence_rule: string } | undefined {
    return this.db
      .prepare<[string], { series_id: string; recurrence_rule: string }>(
        `SELECT series_id, recurrence_rule FROM series WHERE base_event_id = ?`,
      )
      .get(baseEventId);
  }

  /**
   * DC-12 §2.1 / §3: edit the series' recurrence rule. Its own conflict
   * entity (series_id, "recurrence_rule"); stored VERBATIM (validated first).
   * No-op (no change record) when the rule is byte-identical.
   */
  updateSeriesRule(seriesId: string, rule: string): { seriesId: string; recurrenceRule: string } {
    if (typeof seriesId !== "string" || seriesId.length === 0) {
      throw new Error("update_series_rule: series_id must be a non-empty string");
    }
    const validated = validateRRule(rule, "update_series_rule");
    const row = this.db
      .prepare<[string], { series_id: string; recurrence_rule: string }>(
        `SELECT series_id, recurrence_rule FROM series WHERE series_id = ?`,
      )
      .get(seriesId);
    if (!row) throw new Error(`series not found: ${seriesId}`);
    if (row.recurrence_rule === validated) {
      return { seriesId, recurrenceRule: validated }; // idempotent no-op
    }
    const hlc = this.hlc.now();
    createLocalChange(
      this.db,
      this.deviceId,
      {
        entity_id: seriesId,
        entity_type: "series",
        field_path: "recurrence_rule",
        operation: "set",
        payload: { value: validated },
        hlc_now: () => hlc,
      },
      (db) => {
        db.prepare(
          `UPDATE series SET recurrence_rule = ?, updated_hlc = ? WHERE series_id = ?`,
        ).run(validated, hlc, seriesId);
      },
    );
    return { seriesId, recurrenceRule: validated };
  }

  /**
   * DC-12 §2.2/§2.3/§4.1: create or edit ONE occurrence override, keyed
   * (series_id, recurrence_id). recurrence_id is the canonical wall-clock
   * form of the ORIGINAL occurrence start (never rewritten — R2). Each
   * changed field is its own DC-03 conflict entity
   * (series_id, "overrides.<rid>.<field>") — exactly one change record per
   * field per DC-01 §3.1. Unchanged fields produce nothing (TR-8 idempotence).
   */
  updateOccurrence(
    seriesId: string,
    recurrenceId: string,
    patch: OverridePatch,
  ): { seriesId: string; recurrenceId: string; changed: string[] } {
    if (typeof seriesId !== "string" || seriesId.length === 0) {
      throw new Error("update_occurrence: series_id must be a non-empty string");
    }
    const rid = validateRecurrenceId(recurrenceId, "update_occurrence");
    if (patch === null || typeof patch !== "object" || Array.isArray(patch)) {
      throw new Error("update_occurrence: patch must be an object");
    }
    const unknown = Object.keys(patch).filter(
      (k) => !(OVERRIDE_FIELDS as readonly string[]).includes(k),
    );
    if (unknown.length > 0) {
      throw new Error(
        `update_occurrence: unknown patch field(s): ${unknown.join(", ")} — ` +
          `allowed: ${OVERRIDE_FIELDS.join(", ")}`,
      );
    }
    if (Object.keys(patch).length === 0) {
      throw new Error("update_occurrence: patch must set at least one field");
    }
    for (const k of ["title", "start_wall", "end_wall", "tz_id"] as const) {
      const v = patch[k];
      if (v !== undefined && typeof v !== "string") {
        throw new Error(`update_occurrence: patch.${k} must be a string`);
      }
      if (typeof v === "string" && v.trim().length === 0) {
        throw new Error(`update_occurrence: patch.${k} must be a non-empty string`);
      }
    }
    if (
      patch.cancelled !== undefined &&
      typeof patch.cancelled !== "boolean"
    ) {
      throw new Error("update_occurrence: patch.cancelled must be a boolean");
    }
    const series = this.db
      .prepare<[string], { series_id: string }>(
        `SELECT series_id FROM series WHERE series_id = ?`,
      )
      .get(seriesId);
    if (!series) throw new Error(`series not found: ${seriesId}`);

    const existing = this.db
      .prepare<[string, string], OverrideRow>(
        `SELECT series_id, recurrence_id, cancelled, title, start_wall,
                end_wall, tz_id, updated_hlc
         FROM occurrence_overrides WHERE series_id = ? AND recurrence_id = ?`,
      )
      .get(seriesId, rid);

    // Normalize to column values; skip fields whose stored value is identical
    // (re-delivery of the same edit is a no-op beyond clock advancement).
    const wanted: OverridePatch = {};
    if (patch.cancelled !== undefined && (existing?.cancelled ?? 0) !== (patch.cancelled ? 1 : 0)) {
      wanted.cancelled = patch.cancelled;
    }
    for (const k of ["title", "start_wall", "end_wall", "tz_id"] as const) {
      if (patch[k] !== undefined && (existing?.[k] ?? null) !== patch[k]) {
        wanted[k] = patch[k] as string;
      }
    }
    if (Object.keys(wanted).length === 0) {
      return { seriesId, recurrenceId: rid, changed: [] }; // idempotent
    }

    const merged: OverrideRow = {
      series_id: seriesId,
      recurrence_id: rid,
      cancelled: wanted.cancelled !== undefined ? (wanted.cancelled ? 1 : 0) : (existing?.cancelled ?? 0),
      title: wanted.title ?? existing?.title ?? null,
      start_wall: wanted.start_wall ?? existing?.start_wall ?? null,
      end_wall: wanted.end_wall ?? existing?.end_wall ?? null,
      tz_id: wanted.tz_id ?? existing?.tz_id ?? null,
    };
    // One change record per changed field (DC-01 §3.1), each atomic with the
    // merged row write. Field names in the entity paths use the DC-07 column
    // names verbatim (cancelled/title/start_wall/end_wall/tz_id).
    for (const field of OVERRIDE_FIELDS) {
      if (!(field in wanted)) continue;
      const fieldHlc = this.hlc.now();
      const value = field === "cancelled" ? wanted.cancelled : wanted[field];
      createLocalChange(
        this.db,
        this.deviceId,
        {
          entity_id: seriesId,
          entity_type: "occurrence_override",
          field_path: `overrides.${rid}.${field}`,
          operation: "set",
          payload: { value },
          hlc_now: () => fieldHlc,
        },
        (db) => {
          db.prepare(
            `INSERT INTO occurrence_overrides (series_id, recurrence_id, cancelled,
                title, start_wall, end_wall, tz_id, updated_hlc)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(series_id, recurrence_id) DO UPDATE SET
                cancelled = excluded.cancelled,
                title = excluded.title,
                start_wall = excluded.start_wall,
                end_wall = excluded.end_wall,
                tz_id = excluded.tz_id,
                updated_hlc = excluded.updated_hlc`,
          ).run(
            seriesId,
            rid,
            merged.cancelled,
            merged.title,
            merged.start_wall,
            merged.end_wall,
            merged.tz_id,
            fieldHlc,
          );
        },
      );
    }
    return {
      seriesId,
      recurrenceId: rid,
      changed: Object.keys(wanted),
    };
  }

  /**
   * READ-ONLY series listing for recurrence surfacing (DC-12 §2): every
   * series row with its verbatim RRULE joined to its occurrence_overrides.
   * No change records, no mutation — pure SELECT over stored state.
   */
  listSeries(): Array<{
    seriesId: string;
    baseEventId: string;
    recurrenceRule: string;
    overrides: Array<{
      recurrenceId: string;
      cancelled: boolean;
      title: string | null;
      startWall: string | null;
      endWall: string | null;
      tzId: string | null;
    }>;
  }> {
    const rows = this.db
      .prepare<
        [],
        { series_id: string; base_event_id: string; recurrence_rule: string }
      >(`SELECT series_id, base_event_id, recurrence_rule FROM series`)
      .all();
    const overrides = this.db
      .prepare<
        [],
        {
          series_id: string;
          recurrence_id: string;
          cancelled: number;
          title: string | null;
          start_wall: string | null;
          end_wall: string | null;
          tz_id: string | null;
        }
      >(
        `SELECT series_id, recurrence_id, cancelled, title, start_wall,
                end_wall, tz_id
         FROM occurrence_overrides ORDER BY recurrence_id`,
      )
      .all();
    const bySeries = new Map<
      string,
      Array<{
        recurrenceId: string;
        cancelled: boolean;
        title: string | null;
        startWall: string | null;
        endWall: string | null;
        tzId: string | null;
      }>
    >();
    for (const o of overrides) {
      let list = bySeries.get(o.series_id);
      if (!list) bySeries.set(o.series_id, (list = []));
      list.push({
        recurrenceId: o.recurrence_id,
        cancelled: o.cancelled !== 0,
        title: o.title,
        startWall: o.start_wall,
        endWall: o.end_wall,
        tzId: o.tz_id,
      });
    }
    return rows.map((r) => ({
      seriesId: r.series_id,
      baseEventId: r.base_event_id,
      recurrenceRule: r.recurrence_rule,
      overrides: bySeries.get(r.series_id) ?? [],
    }));
  }
}

export function eventFields(e: CalendarEvent) {
  return {
    title: e.title,
    description: e.description,
    startMs: e.startMs,
    endMs: e.endMs,
    allDay: e.allDay,
  };
}

export function insertEventRow(
  db: ReturnType<typeof openDatabase>,
  e: CalendarEvent,
  hlc: number,
  upsert = false,
): void {
  const derived = derivedScheduleColumns(e);
  if (upsert) {
    // NOTE: INSERT ... ON CONFLICT DO UPDATE is NOT usable here — SQLite
    // evaluates table CHECK constraints during the INSERT phase, BEFORE the
    // conflict branch runs, so flipping all_day on an existing row (timed ->
    // all-day or the reverse) fails the CHECK no matter what values the
    // UPDATE would write. All-schedule-column UPDATEs are instead routed
    // through updateEventRowDerived / upsertEventRow.
    const exists = !!db
      .prepare("SELECT 1 FROM events WHERE event_id = ?")
      .get(e.id);
    if (!exists) {
      insertNewEventRow(db, e, hlc, derived);
    } else {
      updateEventRowDerived(db, e.id, e, hlc, derived);
    }
    return;
  }
  insertNewEventRow(db, e, hlc, derived);
}

/** Schedule-derived columns exactly as the schema CHECK requires them. */
export function derivedScheduleColumns(e: CalendarEvent): {
  all_day: number;
  start_date: string | null;
  end_date: string | null;
  start_wall: string | null;
  end_wall: string | null;
  tz_id: string | null;
  utc_start_ms: number;
  utc_end_ms: number;
} {
  return {
    all_day: e.allDay ? 1 : 0,
    start_date: e.allDay ? localDateStr(e.startMs) : null,
    end_date: e.allDay ? localDateStr(Math.max(e.endMs, e.startMs)) : null,
    start_wall: e.allDay ? null : localWallStr(e.startMs),
    end_wall: e.allDay ? null : localWallStr(e.endMs),
    tz_id: e.allDay ? null : timezoneId(),
    utc_start_ms: e.startMs,
    utc_end_ms: Math.max(e.endMs, e.startMs),
  };
}

function insertNewEventRow(
  db: ReturnType<typeof openDatabase>,
  e: CalendarEvent,
  hlc: number,
  d: ReturnType<typeof derivedScheduleColumns>,
): void {
  db.prepare(`INSERT INTO events (event_id, calendar_id, title, description,
      all_day, start_date, end_date, start_wall, end_wall, tz_id,
      utc_start_ms, utc_end_ms, created_hlc, updated_hlc)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    e.id,
    DEFAULT_CALENDAR_ID,
    e.title,
    e.description,
    d.all_day,
    d.start_date,
    d.end_date,
    d.start_wall,
    d.end_wall,
    d.tz_id,
    d.utc_start_ms,
    d.utc_end_ms,
    hlc,
    hlc,
  );
}

/**
 * Update ALL schedule-derived columns consistently. Because every column the
 * CHECK constraint inspects changes in one statement, allDay flips are safe.
 * Returns rows-affected so callers can detect "unknown event".
 */
export function updateEventRowDerived(
  db: ReturnType<typeof openDatabase>,
  eventId: string,
  e: CalendarEvent,
  hlc: number,
  d: ReturnType<typeof derivedScheduleColumns>,
): boolean {
  const info = db.prepare(`
    UPDATE events SET title = ?, description = ?, all_day = ?, start_date = ?,
      end_date = ?, start_wall = ?, end_wall = ?, tz_id = ?,
      utc_start_ms = ?, utc_end_ms = ?, updated_hlc = ?
    WHERE event_id = ?`).run(
    e.title,
    e.description,
    d.all_day,
    d.start_date,
    d.end_date,
    d.start_wall,
    d.end_wall,
    d.tz_id,
    d.utc_start_ms,
    d.utc_end_ms,
    hlc,
    eventId,
  );
  return info.changes > 0;
}

/** Insert-or-update with correct column derivation either way. */
export function upsertEventRow(
  db: ReturnType<typeof openDatabase>,
  e: CalendarEvent,
  hlc: number,
): void {
  const derived = derivedScheduleColumns(e);
  const updated = updateEventRowDerived(db, e.id, e, hlc, derived);
  if (!updated) {
    insertNewEventRow(db, e, hlc, derived);
  }
}

export function rowToEvent(r: EventRow): CalendarEvent {
  let startMs = r.utc_start_ms;
  let endMs = r.utc_end_ms;
  if (startMs == null || endMs == null) {
    // Legacy rows written by the pre-core shell store have no UTC columns;
    // reconstruct from wall/date fields in the local zone.
    if (r.all_day && r.start_date && r.end_date) {
      startMs = new Date(`${r.start_date}T00:00:00`).getTime();
      endMs = new Date(`${r.end_date}T23:59:59.999`).getTime();
    } else if (r.start_wall && r.end_wall && r.start_date) {
      startMs = new Date(`${r.start_date}T${r.start_wall}`).getTime();
      endMs = new Date(`${r.start_date}T${r.end_wall}`).getTime();
    } else {
      startMs = 0;
      endMs = 0;
    }
  }
  return {
    id: r.event_id,
    title: r.title,
    description: r.description,
    startMs: startMs!,
    endMs: endMs!,
    allDay: r.all_day !== 0,
  };
}

function byStart(a: CalendarEvent, b: CalendarEvent): number {
  return a.startMs - b.startMs || a.title.localeCompare(b.title);
}
