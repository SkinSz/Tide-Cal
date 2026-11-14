// Tide DC-14 Conflicts surface — toolbar badge + resolution dialog.
//
// Data access goes through the same Tauri `sync_op` passthrough the Devices
// view uses (frontend/devices.ts syncOp). The sidecar dispatcher
// (src/persistence/bridges/sidecar_server.ts) implements the ops against
// ConflictsViewModel (src/application/conflicts_ui.ts):
//   list_conflicts     -> { total_unresolved, conflicts: ConflictListItem[] }
//   conflict_detail    -> ConflictDetailView
//   resolve_conflict   -> {conflict_id, option} -> the winning ChangeRecord
//   skip_conflict      -> {conflict_id} -> null (TR-2 intentional no-op)
// The Rust proxy allowlist (src-tauri/src/lib.rs sync_op ALLOWED) forwards
// these to the sidecar. No window injection: in a plain browser (vite dev
// without the shell) syncOp degrades honestly by throwing, and the dialog
// surfaces the error inline.
//
// The DOM-free helpers (presentConflict, formatCandidateValue,
// describeConflict, describeCandidateSide, ...) implement DC-14 Appendix A
// (readable conflict presentation) and are exported for headless vitest
// coverage (tests/dc14_readable_conflicts.test.ts).
import type {
  CandidateView,
  ConflictDetailView,
  ConflictEntityKind,
  ConflictListItem,
  ListFilter,
  ResolutionOption,
} from "../src/application/conflicts_ui.ts";
import { syncOp } from "./devices.ts";
import { formatTimeLabel, getTimeFormat, type TimeFormat } from "./theme.ts";

/**
 * Contract mirroring the relevant slice of ConflictsViewModel
 * (src/application/conflicts_ui.ts), implemented over the sidecar RPC.
 */
export interface ConflictsBridge {
  totalUnresolved(): number | Promise<number>;
  listUnresolved(filter?: ListFilter):
    | ConflictListItem[]
    | Promise<ConflictListItem[]>;
  /** Event id -> start instant (list-row date + kind inference, Appendix A). */
  eventStarts(): Map<string, number> | Promise<Map<string, number>>;
  getDetail(
    conflictId: string,
  ): ConflictDetailView | Promise<ConflictDetailView>;
  /** Resolves; returns true when the status flip actually happened. */
  resolve(
    conflictId: string,
    option: ResolutionOption,
  ): boolean | Promise<boolean>;
  skip(conflictId: string): void;
}

type Json = Record<string, unknown>;

/** ConflictsBridge over the sidecar RPC (sync_op passthrough). */
function store(): ConflictsBridge {
  return {
    totalUnresolved: async () => {
      const res = await syncOp<{ total_unresolved: number }>(
        "list_conflicts",
        {},
      );
      return res.total_unresolved;
    },
    listUnresolved: async (filter?: ListFilter) => {
      const res = await syncOp<{
        conflicts: ConflictListItem[];
      }>("list_conflicts", filter ? (filter as Json) : {});
      return res.conflicts;
    },
    eventStarts: async () => {
      // Events are already listed over RPC (list_events); read the start
      // client-side instead of inventing a new op for one list-row date.
      const events = await syncOp<Array<{ id: string; startMs: number }>>(
        "list_events",
      );
      return new Map(events.map((e) => [e.id, e.startMs]));
    },
    getDetail: (conflictId) =>
      syncOp<ConflictDetailView>("conflict_detail", { conflict_id: conflictId }),
    resolve: async (conflictId, option) => {
      await syncOp("resolve_conflict", { conflict_id: conflictId, option });
      return true;
    },
    skip: async (conflictId) => {
      await syncOp("skip_conflict", { conflict_id: conflictId });
    },
  };
}

// --- DOM-free presentation helpers (DC-14 Appendix A) ----------------------
//
// Everything below is PRESENTATION ONLY: it formats the data the detail
// view already receives. Nothing here orders, ranks or pre-selects a side
// (§3.2b P4). All output is plain text and is only ever assigned through
// textContent by the DOM code further down (never parsed as HTML).

/** Locale / clock / zone context for the formatters (injected for tests). */
export interface FormatOptions {
  /** BCP-47 locale; undefined = the webview's locale (General setting). */
  locale?: string;
  /** General setting: 24h or 12h clock. */
  timeFormat: TimeFormat;
  /** IANA zone; undefined = the local zone. */
  timeZone?: string;
  /** "now" in epoch ms for "today"/"yesterday" (defaults to Date.now()). */
  now?: number;
}

/** Runtime options: webview locale (set at startup) + the clock setting. */
export function runtimeFormatOptions(): FormatOptions {
  return { timeFormat: getTimeFormat() };
}

/** A.5 fallback text for a value that matches no A.3 class. */
export const FALLBACK_TEXT = "This change can't be shown in detail";

const DAY_MS = 86_400_000;
const pad2 = (n: number): string => String(n).padStart(2, "0");

interface ZonedParts {
  y: number;
  m: number;
  d: number;
  hh: number;
  mm: number;
}

function zoned(ms: number, o: FormatOptions): ZonedParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: o.timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(ms);
  const get = (t: string): number =>
    Number(parts.find((p) => p.type === t)?.value ?? NaN);
  return { y: get("year"), m: get("month"), d: get("day"), hh: get("hour") % 24, mm: get("minute") };
}

function dayKey(p: { y: number; m: number; d: number }): string {
  return `${p.y}-${pad2(p.m)}-${pad2(p.d)}`;
}

/**
 * Locale-formatted calendar date of an instant: "Sun 15 Nov 2026" (en-GB),
 * "Sun Nov 15, 2026" (en-US), "So. 15. Nov. 2026" (de). The separator
 * right after the weekday is collapsed to a space (A.1 wording).
 */
export function formatDate(
  ms: number,
  o: FormatOptions,
  opts: { weekday?: boolean; year?: boolean } = {},
): string {
  const weekday = opts.weekday ?? true;
  const year = opts.year ?? true;
  const parts = new Intl.DateTimeFormat(o.locale, {
    timeZone: o.timeZone,
    ...(weekday ? { weekday: "short" as const } : {}),
    day: "numeric",
    month: "short",
    ...(year ? { year: "numeric" as const } : {}),
  }).formatToParts(ms);
  let out = "";
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    if (p.type === "literal" && parts[i - 1]?.type === "weekday") {
      out += " ";
    } else {
      out += p.value;
    }
  }
  return out.trim();
}

/** "19:00" / "7:00 PM" for an instant, per the clock setting. */
export function formatTime(ms: number, o: FormatOptions): string {
  const z = zoned(ms, o);
  return formatTimeLabel(`${pad2(z.hh)}:${pad2(z.mm)}`, o.timeFormat);
}

/** Calendar date given as y/m/d (no zone shift): used for "YYYYMMDD" forms. */
function formatCivilDate(
  y: number,
  m: number,
  d: number,
  o: FormatOptions,
  opts: { weekday?: boolean; year?: boolean } = {},
): string {
  return formatDate(Date.UTC(y, m - 1, d, 12), { ...o, timeZone: "UTC" }, opts);
}

function isInt(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && Number.isInteger(n);
}

/**
 * JS Date covers ±8.64e15 ms; Intl throws RangeError beyond it. A peer can
 * send any number, so every instant is checked (one day of margin for the
 * "-1 ms" / "yesterday" arithmetic) before it reaches a formatter.
 */
const MAX_MS = 8.64e15 - DAY_MS;
function isMs(n: unknown): n is number {
  return isInt(n) && Math.abs(n) <= MAX_MS;
}

/** True when y-m-d is a real calendar date (no Date.UTC roll-over). */
function isCivilDate(y: number, m: number, d: number): boolean {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return false;
  if (y < 1 || y > 9999) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** Longest text shown for any single value (peer values are unbounded). */
export const MAX_TEXT = 2000;

/** Cap a string to MAX_TEXT characters, marking the cut with "…". */
export function capText(t: string): string {
  if (t.length <= MAX_TEXT) return t;
  let head = t.slice(0, MAX_TEXT);
  const last = head.charCodeAt(head.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) head = head.slice(0, -1); // no split pair
  return `${head}…`;
}

interface ScheduleValue {
  startMs: number;
  endMs: number;
  allDay: boolean;
}

function asSchedule(v: unknown): ScheduleValue | null {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  if (!isMs(r.startMs) || !isMs(r.endMs) || r.endMs < r.startMs) return null;
  if (r.allDay !== undefined && typeof r.allDay !== "boolean") return null;
  return { startMs: r.startMs, endMs: r.endMs, allDay: r.allDay === true };
}

/**
 * A.3 Date & time: "Sun 15 Nov 2026, 19:00 – 20:00"; all-day
 * "Sun 15 Nov 2026, all day"; multi-day all-day "Sun 15 Nov – Tue 17 Nov
 * 2026". All-day endMs is EXCLUSIVE (next midnight), so 1 ms is taken off
 * before deriving the last day. Returns null for an unrecognised shape.
 */
export function formatSchedule(v: unknown, o: FormatOptions): string | null {
  const s = asSchedule(v);
  if (s === null) return null;
  if (s.allDay) {
    const lastMs = s.endMs > s.startMs ? s.endMs - 1 : s.startMs;
    const a = zoned(s.startMs, o);
    const b = zoned(lastMs, o);
    if (dayKey(a) === dayKey(b)) return `${formatDate(s.startMs, o)}, all day`;
    const first = formatDate(s.startMs, o, { year: a.y !== b.y });
    return `${first} – ${formatDate(lastMs, o)}`;
  }
  const a = zoned(s.startMs, o);
  const b = zoned(s.endMs, o);
  const t1 = formatTime(s.startMs, o);
  const t2 = formatTime(s.endMs, o);
  if (dayKey(a) === dayKey(b)) return `${formatDate(s.startMs, o)}, ${t1} – ${t2}`;
  return `${formatDate(s.startMs, o)}, ${t1} – ${formatDate(s.endMs, o)}, ${t2}`;
}

/**
 * A.4 / P2: absolute short "when": "today 00:30", "yesterday 18:12",
 * "Sat 7 Nov 14:05" (year added when it is not the current year).
 * Returns null for a missing/zero timestamp (never prints 1970).
 */
export function formatWhen(ms: number, o: FormatOptions): string | null {
  if (!isMs(ms) || ms <= 0) return null;
  const now = isMs(o.now) ? o.now : Date.now();
  const at = zoned(ms, o);
  const today = zoned(now, o);
  const t = formatTimeLabel(`${pad2(at.hh)}:${pad2(at.mm)}`, o.timeFormat);
  if (dayKey(at) === dayKey(today)) return `today ${t}`;
  const y = new Date(Date.UTC(today.y, today.m - 1, today.d) - DAY_MS);
  const yKey = `${y.getUTCFullYear()}-${pad2(y.getUTCMonth() + 1)}-${pad2(y.getUTCDate())}`;
  if (dayKey(at) === yKey) return `yesterday ${t}`;
  return `${formatDate(ms, o, { year: at.y !== today.y })} ${t}`;
}

// --- Repeat rules (A.3 "Repeat") ---

const RULE_DAYS: Record<string, string> = {
  MO: "Monday",
  TU: "Tuesday",
  WE: "Wednesday",
  TH: "Thursday",
  FR: "Friday",
  SA: "Saturday",
  SU: "Sunday",
};

const RULE_UNIT: Record<string, [string, string]> = {
  DAILY: ["day", "days"],
  WEEKLY: ["week", "weeks"],
  MONTHLY: ["month", "months"],
  YEARLY: ["year", "years"],
};

function joinWords(words: string[]): string {
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

/**
 * A.3 Repeat in plain words: "Every week on Monday until 31 Dec 2026",
 * "Every day, 3 times". Covers FREQ (DAILY/WEEKLY/MONTHLY/YEARLY),
 * INTERVAL, BYDAY (plain weekdays, weekly rules only), UNTIL (date form)
 * and COUNT. Anything else returns null so the caller shows "Custom repeat
 * rule" (never a misleading paraphrase).
 */
export function describeRepeat(rule: unknown, o: FormatOptions): string | null {
  if (typeof rule !== "string") return null;
  const body = rule.trim().replace(/^RRULE:/i, "");
  if (body.length === 0) return null;
  const kv = new Map<string, string>();
  for (const seg of body.split(";")) {
    const i = seg.indexOf("=");
    if (i <= 0) return null;
    const key = seg.slice(0, i).trim().toUpperCase();
    const value = seg.slice(i + 1).trim().toUpperCase();
    if (!value || kv.has(key)) return null;
    if (!["FREQ", "INTERVAL", "BYDAY", "UNTIL", "COUNT", "WKST"].includes(key)) return null;
    kv.set(key, value);
  }
  const freq = kv.get("FREQ") ?? "";
  const unit = RULE_UNIT[freq];
  if (unit === undefined) return null;
  let interval = 1;
  if (kv.has("INTERVAL")) {
    interval = Number(kv.get("INTERVAL"));
    if (!Number.isInteger(interval) || interval < 1 || interval > 999) return null;
  }
  let text = interval === 1 ? `Every ${unit[0]}` : `Every ${interval} ${unit[1]}`;
  if (kv.has("BYDAY")) {
    if (freq !== "WEEKLY") return null;
    const days = (kv.get("BYDAY") ?? "").split(",").map((d) => d.trim());
    if (days.some((d) => RULE_DAYS[d] === undefined)) return null;
    text += ` on ${joinWords(days.map((d) => RULE_DAYS[d]!))}`;
  }
  if (kv.has("UNTIL") && kv.has("COUNT")) return null;
  if (kv.has("UNTIL")) {
    const u = kv.get("UNTIL") ?? "";
    if (!/^\d{8}$/.test(u)) return null;
    const y = Number(u.slice(0, 4));
    const m = Number(u.slice(4, 6));
    const d = Number(u.slice(6, 8));
    if (!isCivilDate(y, m, d)) return null;
    text += ` until ${formatCivilDate(y, m, d, o, { weekday: false })}`;
  }
  if (kv.has("COUNT")) {
    const n = Number(kv.get("COUNT"));
    if (!Number.isInteger(n) || n < 1 || n > 9999) return null;
    text += n === 1 ? ", once" : `, ${n} times`;
  }
  return text;
}

// --- Field kinds (A.2) ---

export type FieldKind =
  | { kind: "schedule" }
  | { kind: "event" }
  | { kind: "title" }
  | { kind: "calendar_title" }
  | { kind: "repeat" }
  | { kind: "override"; date: string | null; rid: string; field: string }
  | { kind: "reminder" }
  | { kind: "deleted" }
  | { kind: "other" };

/** Classify a field_path (plus the entity kind, which tells "title" apart). */
export function classifyField(
  fieldPath: string | undefined,
  entityKind?: ConflictEntityKind,
): FieldKind {
  const fp = fieldPath ?? "";
  if (fp === "*") return { kind: "deleted" };
  if (fp === "schedule") return { kind: "schedule" };
  if (fp === "event") return { kind: "event" };
  if (fp === "recurrence_rule") return { kind: "repeat" };
  if (fp === "title") return entityKind === "calendar" ? { kind: "calendar_title" } : { kind: "title" };
  if (/^reminders\.[^.]+$/.test(fp)) return { kind: "reminder" };
  const ov = /^overrides\.((\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2}))\.(title|start_wall|end_wall|cancelled)$/.exec(fp);
  // The occurrence id must be a real date/time; garbage reads "Other change"
  // rather than a plausible rolled-over date.
  if (
    ov &&
    isCivilDate(Number(ov[2]), Number(ov[3]), Number(ov[4])) &&
    Number(ov[5]) <= 23 &&
    Number(ov[6]) <= 59 &&
    Number(ov[7]) <= 59
  ) {
    return { kind: "override", rid: ov[1]!, field: ov[8]!, date: ov[1]!.slice(0, 8) };
  }
  return { kind: "other" };
}

const OVERRIDE_LABEL: Record<string, string> = {
  title: "Title",
  start_wall: "Start time",
  end_wall: "End time",
  cancelled: "Cancelled",
};

/** "YYYYMMDD" -> the user's date format ("Sun 15 Nov 2026"). */
function formatYmd(ymd: string, o: FormatOptions): string {
  return formatCivilDate(
    Number(ymd.slice(0, 4)),
    Number(ymd.slice(4, 6)),
    Number(ymd.slice(6, 8)),
    o,
  );
}

/** A.2 label for a field kind. Never contains an internal path or id. */
export function fieldLabel(fk: FieldKind, o: FormatOptions): string {
  switch (fk.kind) {
    case "schedule":
      return "Date & time";
    case "event":
      return "Appointment";
    case "title":
      return "Title";
    case "calendar_title":
      return "Calendar name";
    case "repeat":
      return "Repeat";
    case "override":
      return `${OVERRIDE_LABEL[fk.field] ?? "Other change"} — only on ${formatYmd(fk.date ?? fk.rid, o)}`;
    case "reminder":
      return "Reminder";
    case "deleted":
      return "Deleted";
    case "other":
      return "Other change";
  }
}

// --- Value rendering (A.3) ---

/** Reminder payloads arrive as {minutes_before, enabled} or wrapped in {value}. */
function unwrapReminder(v: unknown): { minutes: number; enabled: boolean } | null {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return null;
  let r = v as Record<string, unknown>;
  if (r.minutes_before === undefined && r.value !== null && typeof r.value === "object") {
    r = r.value as Record<string, unknown>;
  }
  if (!isInt(r.minutes_before) || r.minutes_before < 0) return null;
  const en = r.enabled;
  const enabled = en === undefined || en === true || en === 1;
  return { minutes: r.minutes_before, enabled };
}

/** "15 minutes before", "2 hours before", "1 day before", "At the start". */
export function formatReminder(v: unknown): string | null {
  const r = unwrapReminder(v);
  if (r === null) return null;
  const n = r.minutes;
  const plural = (k: number, w: string): string => `${k} ${w}${k === 1 ? "" : "s"}`;
  let text: string;
  if (n === 0) text = "At the start";
  else if (n % 1440 === 0) text = `${plural(n / 1440, "day")} before`;
  else if (n % 60 === 0) text = `${plural(n / 60, "hour")} before`;
  else text = `${plural(n, "minute")} before`;
  return r.enabled ? text : `${text} (turned off)`;
}

/** Wall value "HH:MM[:SS]" or "YYYY-MM-DDTHH:MM[:SS]" -> time (+ date if another day). */
function formatWall(v: unknown, occurrenceYmd: string | null, o: FormatOptions): string | null {
  if (typeof v !== "string") return null;
  const m = /^(?:(\d{4})-(\d{2})-(\d{2})T)?(\d{2}):(\d{2})(?::\d{2})?$/.exec(v.trim());
  if (!m) return null;
  const hh = Number(m[4]);
  const mm = Number(m[5]);
  if (hh > 23 || mm > 59) return null;
  if (m[1] !== undefined && !isCivilDate(Number(m[1]), Number(m[2]), Number(m[3]))) return null;
  const t = formatTimeLabel(`${m[4]}:${m[5]}`, o.timeFormat);
  if (m[1] !== undefined && `${m[1]}${m[2]}${m[3]}` !== occurrenceYmd) {
    return `${formatCivilDate(Number(m[1]), Number(m[2]), Number(m[3]), o)}, ${t}`;
  }
  return t;
}

function textValue(v: unknown, empty: string): string | null {
  if (typeof v !== "string") return null;
  return v.trim().length === 0 ? empty : capText(v);
}

/** One rendered line of a candidate (label set for whole-record sub-fields). */
export interface ValueLine {
  /** Sub-field key for whole-record diffing (P1); absent for single values. */
  key?: string;
  label?: string;
  text: string;
}

/** Rendering result of one candidate value. */
export interface RenderedValue {
  lines: ValueLine[];
  /** True when the A.5 fallback was used (raw value only under Technical details). */
  fallback: boolean;
}

const EVENT_SUBFIELDS: Array<{ key: string; label: string }> = [
  { key: "title", label: "Title" },
  { key: "when", label: "Date & time" },
  { key: "description", label: "Description" },
];

function renderEvent(v: unknown, o: FormatOptions): ValueLine[] | null {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  const when = formatSchedule(r, o);
  if (when === null || typeof r.title !== "string") return null;
  if (r.description !== undefined && r.description !== null && typeof r.description !== "string") {
    return null;
  }
  const desc = typeof r.description === "string" ? r.description : "";
  const values: Record<string, string> = {
    title: textValue(r.title, "(no title)")!,
    when,
    description: desc.trim().length === 0 ? "(empty)" : capText(desc),
  };
  return EVENT_SUBFIELDS.map((f) => ({ key: f.key, label: f.label, text: values[f.key]! }));
}

/**
 * A.3 rendering of one candidate's effective value for a given field kind.
 * A deletion side renders "Deleted". Unknown shapes -> A.5 fallback text.
 */
export function renderValue(
  fk: FieldKind,
  deleted: boolean,
  value: unknown,
  o: FormatOptions,
): RenderedValue {
  const one = (text: string | null): RenderedValue =>
    text === null
      ? { lines: [{ text: FALLBACK_TEXT }], fallback: true }
      : { lines: [{ text }], fallback: false };
  if (deleted || fk.kind === "deleted") return { lines: [{ text: "Deleted" }], fallback: false };
  switch (fk.kind) {
    case "schedule":
      return one(formatSchedule(value, o));
    case "event": {
      const lines = renderEvent(value, o);
      return lines === null ? one(null) : { lines, fallback: false };
    }
    case "title":
      return one(textValue(value, "(no title)"));
    case "calendar_title":
      return one(textValue(value, "(empty)"));
    case "repeat": {
      const words = describeRepeat(value, o);
      return words === null
        ? { lines: [{ text: "Custom repeat rule" }], fallback: true }
        : one(words);
    }
    case "reminder":
      return one(formatReminder(value));
    case "override": {
      if (value === null || value === undefined) return one("Same as the series");
      if (fk.field === "cancelled") {
        if (value === true || value === 1) return one("Cancelled");
        if (value === false || value === 0) return one("Takes place");
        return one(null);
      }
      if (fk.field === "title") return one(textValue(value, "(no title)"));
      return one(formatWall(value, fk.date, o));
    }
    case "other":
      return one(typeof value === "string" ? textValue(value, "(empty)") : null);
  }
  return one(null);
}

/** Raw value for the collapsed Technical details disclosure (P3). */
export function rawValueText(c: CandidateView): string {
  if (c.deleted) return "(removed)";
  if (c.value === undefined) return "(no value)";
  try {
    return capText(JSON.stringify(c.value, null, 2) ?? String(c.value));
  } catch {
    return capText(String(c.value));
  }
}

// --- Who (A.4) and buttons (A.6) ---

function isLocalCandidate(detail: ConflictDetailView, c: CandidateView): boolean {
  return detail.local_change_id !== null && c.change_id === detail.local_change_id;
}

/**
 * A.4 short device token: the first 8 characters of the device id. Sync
 * device ids carry a "d-" type prefix ("d-2ee25c62…"); A.1's example
 * ("Device 2ee25c62") counts from after it, so the prefix is skipped.
 * Any other id shape uses its first 8 characters verbatim.
 */
export function shortDeviceId(deviceId: string): string {
  const id = deviceId ?? "";
  return /^d-[0-9a-f]/i.test(id) ? id.slice(2, 10) : id.slice(0, 8);
}

/**
 * A.4 interim device label: "This device (local)" for self, otherwise
 * "Device " + the short id. Never the full id, never truncated with "…".
 */
export function describeCandidateSide(
  detail: ConflictDetailView,
  candidate: CandidateView,
): string {
  if (isLocalCandidate(detail, candidate)) return "This device (local)";
  const short = shortDeviceId(candidate.device_id);
  return short.length > 0 ? `Device ${short}` : "Another device";
}

/** A.6 button wording: "Keep this device's" / "Keep Device 2ee25c62's". */
export function keepButtonLabel(detail: ConflictDetailView, c: CandidateView): string {
  if (isLocalCandidate(detail, c)) return "Keep this device's";
  return `Keep ${describeCandidateSide(detail, c)}'s`;
}

/** §4 mapping (unchanged by Appendix A): self -> keep_mine, else keep_theirs. */
export function resolutionOptionFor(
  detail: ConflictDetailView,
  c: CandidateView,
): ResolutionOption {
  return isLocalCandidate(detail, c)
    ? { kind: "keep_mine" }
    : { kind: "keep_theirs", change_id: c.change_id };
}

// --- Whole presentation ---

/**
 * Entity kind for labelling, inferred from data the dialog already has
 * (Appendix A is presentation only; the §3.2/§5.2 shapes carry no kind):
 *   recurrence_rule / overrides.*      -> series (only series have these)
 *   reminders.*                        -> event
 *   entity is in the event list        -> event
 *   "title", not an event, has a title -> calendar (series have no "title"
 *                                         field; a removed event has no title)
 *   other event fields                 -> event
 * `eventIds` null = event list unavailable (then "title" reads as Title).
 */
export function inferEntityKind(
  fieldPath: string,
  entityId: string,
  entityTitle: string | null | undefined,
  eventIds: ReadonlySet<string> | null,
): ConflictEntityKind {
  if (fieldPath === "recurrence_rule" || fieldPath.startsWith("overrides.")) return "series";
  if (fieldPath.startsWith("reminders.")) return "event";
  if (eventIds !== null && eventIds.has(entityId)) return "event";
  if (
    fieldPath === "title" &&
    eventIds !== null &&
    typeof entityTitle === "string"
  ) {
    return "calendar";
  }
  if (["title", "schedule", "event", "description"].includes(fieldPath)) return "event";
  return "unknown";
}

/**
 * Value of a non-deleted side in a whole-entity removal ("*") conflict: the
 * stored record does not say which field that side edited, so the value is
 * recognised by shape (date & time, whole appointment, reminder, text).
 */
function renderBySniffing(value: unknown, o: FormatOptions): RenderedValue {
  const when = formatSchedule(value, o);
  if (when !== null) {
    const ev = renderValue({ kind: "event" }, false, value, o);
    if (!ev.fallback) return ev;
    return { lines: [{ label: "Date & time", text: when }], fallback: false };
  }
  const rem = formatReminder(value);
  if (rem !== null) return { lines: [{ label: "Reminder", text: rem }], fallback: false };
  if (typeof value === "string") {
    return { lines: [{ text: textValue(value, "(empty)")! }], fallback: false };
  }
  return { lines: [{ text: FALLBACK_TEXT }], fallback: true };
}

/** Entity title for display; never an internal id. */
export function entityDisplayTitle(
  title: string | null | undefined,
  kind: ConflictEntityKind | undefined,
): string {
  if (typeof title === "string" && title.trim().length > 0) return capText(title);
  if (kind === "calendar") return "Calendar";
  if (kind === "series") return "Repeating appointment";
  if (kind === "event") return "(no title)";
  return "Unnamed item";
}

const COUNT_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];

export interface CandidatePresentation {
  change_id: string;
  side: string;
  keepLabel: string;
  deleted: boolean;
  /** Lines shown by default (P1: only differing sub-fields for whole records). */
  lines: ValueLine[];
  /** Every line ("Show all details"). Equal to `lines` when nothing is hidden. */
  allLines: ValueLine[];
  /** "changed today 00:23", or null when the time is unknown. */
  changed: string | null;
  fallback: boolean;
  /** Raw value for Technical details (P3, collapsed). */
  raw: string;
}

export interface ConflictPresentation {
  title: string;
  label: string;
  header: string;
  /** True when some lines are hidden until "Show all details". */
  hasHidden: boolean;
  candidates: CandidatePresentation[];
}

/** A.1/A.3/A.4/A.6 presentation of one conflict detail. Pure. */
export function presentConflict(
  detail: ConflictDetailView,
  o: FormatOptions,
  eventIds: ReadonlySet<string> | null = null,
): ConflictPresentation {
  const kind = inferEntityKind(detail.field_path, detail.entity_id, detail.entity_title, eventIds);
  const conflictFk = classifyField(detail.field_path, kind);
  const label = fieldLabel(conflictFk, o);
  const anyRemoved = detail.candidates.some((c) => c.deleted);
  // A removed appointment has no row left to read a title from; say so
  // neutrally instead of "(no title)" (and never pick one side's title).
  const title =
    (detail.entity_title === null || detail.entity_title === undefined) &&
    (conflictFk.kind === "deleted" || anyRemoved) &&
    kind !== "calendar"
      ? "Deleted appointment"
      : entityDisplayTitle(detail.entity_title, kind);

  const rendered = detail.candidates.map((c) => {
    const r =
      conflictFk.kind === "deleted" && !c.deleted
        ? renderBySniffing(c.value, o)
        : renderValue(conflictFk, c.deleted, c.value, o);
    return { c, lines: r.lines, fallback: r.fallback };
  });

  // P1: for whole-record values, show only sub-fields whose text differs.
  const keyed = rendered.filter((x) => x.lines.some((l) => l.key !== undefined));
  const differing = new Set<string>();
  if (keyed.length >= 2) {
    for (const f of EVENT_SUBFIELDS) {
      const texts = new Set(keyed.map((x) => x.lines.find((l) => l.key === f.key)?.text ?? ""));
      if (texts.size > 1) differing.add(f.key);
    }
  }
  const filterLines = (lines: ValueLine[]): ValueLine[] => {
    if (keyed.length < 2 || differing.size === 0) return lines;
    return lines.filter((l) => l.key === undefined || differing.has(l.key));
  };

  const candidates = rendered.map(({ c, lines, fallback }) => {
    const shown = filterLines(lines);
    const when = formatWhen(c.hlc_timestamp, o);
    return {
      change_id: c.change_id,
      side: describeCandidateSide(detail, c),
      keepLabel: keepButtonLabel(detail, c),
      deleted: c.deleted,
      lines: shown,
      allLines: lines,
      changed: when === null ? null : `changed ${when}`,
      fallback,
      raw: rawValueText(c),
    };
  });

  const n = new Set(detail.candidates.map((c) => c.device_id)).size;
  const nWords = `${COUNT_WORDS[n] ?? String(n)} devices`;
  let header: string;
  if (conflictFk.kind === "deleted") {
    header = `"${title}" — Deleted on one device and changed on another at the same time.`;
  } else if (anyRemoved) {
    header = `"${title}" — ${label} was removed on one device and changed on another at the same time.`;
  } else {
    header = `"${title}" — ${label} was changed on ${nWords} at the same time.`;
  }

  return {
    title,
    label,
    header,
    hasHidden: candidates.some((c) => c.lines.length !== c.allLines.length),
    candidates,
  };
}

/**
 * Human-readable effective value of one candidate as a single string
 * (lines joined). Kept for callers that want one line of text.
 */
export function formatCandidateValue(
  c: CandidateView,
  fieldPath = "",
  o: FormatOptions = runtimeFormatOptions(),
  entityKind?: ConflictEntityKind,
): string {
  const fk = classifyField(fieldPath, entityKind);
  return renderValue(fk, c.deleted, c.value, o)
    .lines.map((l) => (l.label ? `${l.label}: ${l.text}` : l.text))
    .join("\n");
}

/**
 * A.1 list-row subtitle: "Sun 15 Nov · Date & time" (date only when the
 * entity is an event with a known start). No internal path, no count.
 * `ctx` carries what the §5.2 list item itself does not: the entity kind
 * (from the conflict detail) and the event start (from the event list).
 */
export function describeConflict(
  item: ConflictListItem,
  o: FormatOptions = runtimeFormatOptions(),
  ctx: { entityKind?: ConflictEntityKind; startMs?: number | null } = {},
): string {
  const label = fieldLabel(classifyField(item.field_path, ctx.entityKind), o);
  const start = ctx.startMs;
  if (isMs(start)) {
    return `${formatDate(start, o, { year: false })} · ${label}`;
  }
  return label;
}

// --- Badge ------------------------------------------------------------------

export async function refreshBadge(): Promise<void> {
  const btn = document.getElementById("btn-conflicts");
  if (!btn) return;
  let total = 0;
  try {
    total = await store().totalUnresolved();
  } catch (err) {
    console.warn("[tide] conflicts badge unavailable:", err);
  }
  const label = btn.querySelector(".conflicts-label") as HTMLElement | null;
  if (label) label.textContent = `⚠ Conflicts (${total})`;
  btn.classList.toggle("has-conflicts", total > 0);
  btn.title =
    total > 0 ? `${total} unresolved conflict(s)` : "No unresolved conflicts";
}

// --- Dialog -----------------------------------------------------------------

function dlg(): HTMLDialogElement {
  return document.getElementById("conflict-dialog") as HTMLDialogElement;
}

function el<T extends HTMLElement>(id: string): T {
  return dlg().querySelector(`#${id}`) as T;
}

async function renderList(): Promise<void> {
  const listEl = el<HTMLDivElement>("conflict-list");
  const detailEl = el<HTMLDivElement>("conflict-detail");
  detailEl.replaceChildren(emptyNote("Select a conflict to compare the versions."));
  let items: ConflictListItem[] = [];
  try {
    items = await store().listUnresolved();
  } catch (err) {
    console.warn("[tide] conflict list unavailable:", err);
  }
  listEl.replaceChildren();
  if (items.length === 0) {
    listEl.replaceChildren(emptyNote("No unresolved conflicts."));
    return;
  }
  const o = runtimeFormatOptions();
  const starts = await loadEventStarts();
  const eventIds = starts === null ? null : new Set(starts.keys());
  for (const item of items) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "conflict-row";
    row.dataset.conflictId = item.conflict_id;
    const titleSpan = document.createElement("span");
    titleSpan.className = "conflict-row-title";
    const subSpan = document.createElement("span");
    subSpan.className = "muted";
    const startMs = starts?.get(item.entity_id) ?? null;
    subSpan.textContent = describeConflict(item, o, { startMs });
    titleSpan.textContent = "";
    // §5.2 list shows the ENTITY TITLE; the detail read (pure, no mutation)
    // carries the title and the kind ("Calendar name" vs "Title"). Never
    // the internal id (Appendix A.2).
    void Promise.resolve(store().getDetail(item.conflict_id))
      .then((d) => {
        const entityKind = inferEntityKind(d.field_path, d.entity_id, d.entity_title, eventIds);
        titleSpan.textContent = entityDisplayTitle(d.entity_title, entityKind);
        subSpan.textContent = describeConflict(item, o, { entityKind, startMs });
      })
      .catch(() => {
        /* keep the neutral fallback */
      });
    row.append(titleSpan, subSpan);
    row.addEventListener("click", () => void selectConflict(item.conflict_id));
    listEl.appendChild(row);
  }
}

async function loadEventStarts(): Promise<Map<string, number> | null> {
  try {
    return await store().eventStarts();
  } catch (err) {
    console.warn("[tide] event list unavailable for conflict labels:", err);
    return null;
  }
}

function emptyNote(text: string): HTMLElement {
  const p = document.createElement("p");
  p.className = "conflict-empty";
  p.textContent = text;
  return p;
}

let selectSeq = 0;

async function selectConflict(conflictId: string): Promise<void> {
  const seq = ++selectSeq;
  // Build the whole presentation BEFORE touching the pane or the highlight:
  // if anything fails, the previous conflict's Keep buttons must not stay
  // on screen under another row's highlight (a click would resolve it).
  let detail: ConflictDetailView | null = null;
  let view: ConflictPresentation | null = null;
  try {
    detail = await store().getDetail(conflictId);
    const starts = await loadEventStarts();
    view = presentConflict(
      detail,
      runtimeFormatOptions(),
      starts === null ? null : new Set(starts.keys()),
    );
  } catch (err) {
    console.warn("[tide] conflict detail unavailable:", err);
  }
  if (seq !== selectSeq) return; // a later selection superseded this one

  for (const row of dlg().querySelectorAll(".conflict-row")) {
    row.classList.toggle(
      "selected",
      (row as HTMLElement).dataset.conflictId === conflictId,
    );
  }
  dlg().querySelector(".dialog-error")?.remove();

  const detailEl = el<HTMLDivElement>("conflict-detail");
  detailEl.replaceChildren();
  if (detail === null || view === null) {
    detailEl.appendChild(emptyNote("This conflict can't be shown right now."));
    return;
  }
  const d = detail;

  const heading = document.createElement("h3");
  heading.textContent = view.title;
  const headerLine = document.createElement("p");
  headerLine.className = "conflict-header";
  headerLine.textContent = view.header;
  detailEl.append(heading, headerLine);

  // A.1: the versions side by side, one column per device.
  const sides = document.createElement("div");
  sides.className = "conflict-sides";
  const valueBoxes: Array<{ box: HTMLElement; cp: CandidatePresentation }> = [];
  for (const cp of view.candidates) {
    const col = document.createElement("div");
    col.className = "conflict-candidate";
    const side = document.createElement("strong");
    side.className = "conflict-candidate-head";
    side.textContent = cp.side;
    const box = document.createElement("div");
    box.className = "conflict-value" + (cp.deleted ? " deleted" : "");
    fillLines(box, cp.lines);
    col.append(side, box);
    if (cp.changed !== null) {
      const when = document.createElement("div");
      when.className = "muted conflict-when";
      when.textContent = cp.changed;
      col.appendChild(when);
    }
    sides.appendChild(col);
    valueBoxes.push({ box, cp });
  }
  detailEl.appendChild(sides);

  // P1: "Show all details" expands whole-record sub-fields that are equal.
  if (view.hasHidden) {
    const more = document.createElement("button");
    more.type = "button";
    more.className = "conflict-show-all";
    more.textContent = "Show all details";
    let all = false;
    more.addEventListener("click", () => {
      all = !all;
      more.textContent = all ? "Show only differences" : "Show all details";
      for (const { box, cp } of valueBoxes) fillLines(box, all ? cp.allLines : cp.lines);
    });
    detailEl.appendChild(more);
  }

  // A.6: buttons name the side; §4 mapping unchanged.
  const actions = document.createElement("div");
  actions.className = "conflict-actions";
  d.candidates.forEach((c, i) => {
    const keep = document.createElement("button");
    keep.type = "button";
    keep.className = "primary";
    keep.textContent = view.candidates[i]!.keepLabel;
    keep.addEventListener("click", () => void actResolve(d, c));
    actions.appendChild(keep);
  });
  const later = document.createElement("button");
  later.type = "button";
  later.textContent = "Decide later";
  later.addEventListener("click", () => void actDecideLater(d));
  actions.appendChild(later);
  detailEl.appendChild(actions);

  // P3: raw values only inside a collapsed disclosure (never open by default).
  const tech = document.createElement("details");
  tech.className = "conflict-tech";
  const summary = document.createElement("summary");
  summary.textContent = "Technical details";
  tech.appendChild(summary);
  const pathLine = document.createElement("div");
  pathLine.className = "muted";
  pathLine.textContent = `Changed item: ${capText(d.field_path)}`;
  tech.appendChild(pathLine);
  for (const cp of view.candidates) {
    const label = document.createElement("div");
    label.className = "muted";
    label.textContent = cp.side;
    const pre = document.createElement("pre");
    pre.className = "conflict-raw";
    pre.textContent = cp.raw;
    tech.append(label, pre);
  }
  detailEl.appendChild(tech);
}

function fillLines(box: HTMLElement, lines: ValueLine[]): void {
  box.replaceChildren();
  for (const l of lines) {
    const line = document.createElement("div");
    line.className = "conflict-line";
    if (l.label) {
      const lab = document.createElement("span");
      lab.className = "muted";
      lab.textContent = `${l.label}: `;
      line.appendChild(lab);
    }
    line.appendChild(document.createTextNode(l.text));
    box.appendChild(line);
  }
}

function showError(text: string): void {
  dlg().querySelector(".dialog-error")?.remove();
  const div = document.createElement("div");
  div.className = "dialog-error";
  div.setAttribute("role", "alert");
  div.textContent = text;
  el<HTMLDivElement>("conflict-detail").before(div);
}

/**
 * "Keep <side>'s": keep_mine for the local candidate, keep_theirs with the
 * candidate's change_id otherwise (N-way safe, §4; A.6 wording only).
 */
async function actResolve(
  detail: ConflictDetailView,
  c: CandidateView,
): Promise<void> {
  try {
    await store().resolve(detail.conflict_id, resolutionOptionFor(detail, c));
  } catch (err) {
    // In-app inline error (no native alert() — owner flagged the WebKit
    // popup chrome). Shown above the conflict detail; cleared on re-render.
    showError(`Failed to resolve conflict: ${String(err)}`);
    return;
  }
  await renderList(); // re-renders empty detail
  await refreshBadge();
}

/** "Decide later" = §4 skip: writes nothing (TR-2); moves to the next one. */
async function actDecideLater(detail: ConflictDetailView): Promise<void> {
  try {
    await store().skip(detail.conflict_id);
  } catch (err) {
    console.warn("[tide] skip_conflict failed:", err);
  }
  const rows = [...dlg().querySelectorAll<HTMLElement>(".conflict-row")];
  const idx = rows.findIndex((r) => r.dataset.conflictId === detail.conflict_id);
  const next = rows[idx + 1]?.dataset.conflictId;
  if (next !== undefined) {
    await selectConflict(next);
  } else {
    await renderList();
  }
}

export function openConflictsDialog(): void {
  dlg().showModal();
  void renderList();
}

export function initConflicts(): void {
  document
    .getElementById("btn-conflicts")
    ?.addEventListener("click", openConflictsDialog);
  document
    .getElementById("conflict-close")
    ?.addEventListener("click", () => dlg().close());
  // TD-031: the badge previously read its count only here (startup) and
  // after a resolution, so a conflict created later showed "(0)".
  document.addEventListener("tide:rendered", () => void refreshBadge());
  void refreshBadge();
}
