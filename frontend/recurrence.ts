// Tide recurrence surfacing — read-only display helpers (DC-12 §2).
//
// Everything here is DERIVED from stored data: the series row's verbatim
// RFC 5545 RRULE string (DC-12 §2.1: Tide defines NO custom recurrence DSL;
// the rule is stored and exchanged verbatim) and the occurrence_overrides
// rows keyed (series_id, recurrence_id) (DC-12 §2.2).
//
// Design rules:
//   - Plain-language rendering covers ONLY the common cases
//     (FREQ=DAILY/WEEKLY/MONTHLY/YEARLY, INTERVAL, BYDAY). Anything else —
//     unknown params (COUNT/UNTIL/BYSETPOS/...), unparsable strings — falls
//     back to the RAW RRULE string. We never misrepresent a rule.
//   - Pure functions, DOM-free, so vitest (node env) can cover them
//     directly (tests/recurrence_ui.test.ts) like conflicts_ui.ts.

export interface OccurrenceOverrideInfo {
  recurrenceId: string;
  cancelled: boolean;
}

/** Display shape of one series, joined to its overrides. */
export interface SeriesInfo {
  seriesId: string;
  baseEventId: string;
  /** RFC 5545 RRULE string, stored verbatim (DC-12 §2.1). */
  rule: string;
  overrides: OccurrenceOverrideInfo[];
}

interface RRuleParts {
  freq: "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";
  interval: number;
  byday: string[];
  /** UNTIL date form "YYYYMMDD" (inclusive end), or null when open-ended. */
  until: string | null;
}

const DAY_NAMES: Record<string, string> = {
  MO: "Monday",
  TU: "Tuesday",
  WE: "Wednesday",
  TH: "Thursday",
  FR: "Friday",
  SA: "Saturday",
  SU: "Sunday",
};

const FREQ_LABEL: Record<RRuleParts["freq"], string> = {
  DAILY: "daily",
  WEEKLY: "weekly",
  MONTHLY: "monthly",
  YEARLY: "yearly",
};

/** Supported RRULE keys for structured rendering; anything else → raw fallback. */
const SUPPORTED_KEYS = new Set(["FREQ", "INTERVAL", "BYDAY", "UNTIL"]);

/** En-GB short month names for the "until 5 Oct 2026" rendering. */
const MONTHS_SHORT = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/** UNTIL date form "YYYYMMDD" (RFC 5545 DATE; datetime forms stay raw). */
function parseUntilDate(value: string): string | null {
  if (!/^\d{8}$/.test(value)) return null;
  const y = Number(value.slice(0, 4));
  const m = Number(value.slice(4, 6));
  const d = Number(value.slice(6, 8));
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (
    dt.getUTCFullYear() !== y ||
    dt.getUTCMonth() !== m - 1 ||
    dt.getUTCDate() !== d
  ) {
    return null;
  }
  return value;
}

/** "YYYYMMDD" -> "5 Oct 2026" (plain-language, en-GB day-first). */
export function formatUntilDate(until: string): string {
  const day = Number(until.slice(6, 8));
  const month = Number(until.slice(4, 6));
  const year = until.slice(0, 4);
  return `${day} ${MONTHS_SHORT[month - 1] ?? month} ${year}`;
}

/**
 * Parse an RRULE string into the common-case subset we render in plain
 * language. Returns null when the rule is not fully coverable by that
 * subset (unknown keys, bad values) — callers then show the raw string.
 */
export function parseRRule(rule: string): RRuleParts | null {
  if (typeof rule !== "string" || rule.length === 0) return null;
  const kv = new Map<string, string>();
  for (const seg of rule.split(";")) {
    const i = seg.indexOf("=");
    if (i <= 0) return null;
    const key = seg.slice(0, i).trim().toUpperCase();
    const value = seg.slice(i + 1).trim();
    if (!value) return null;
    kv.set(key, value);
  }
  const freqRaw = (kv.get("FREQ") ?? "").toUpperCase();
  if (!Object.prototype.hasOwnProperty.call(FREQ_LABEL, freqRaw)) return null;
  for (const key of kv.keys()) {
    if (!SUPPORTED_KEYS.has(key)) return null;
  }
  let interval = 1;
  if (kv.has("INTERVAL")) {
    const n = Number(kv.get("INTERVAL"));
    if (!Number.isInteger(n) || n < 1) return null;
    interval = n;
  }
  let byday: string[] = [];
  if (kv.has("BYDAY")) {
    byday = (kv.get("BYDAY") ?? "")
      .split(",")
      .map((d) => d.trim().toUpperCase());
    // Ordinal prefixes (e.g. "2MO" = second Monday) are NOT a common case we
    // render; bail to raw rather than drop the qualifier.
    for (const d of byday) {
      if (!Object.prototype.hasOwnProperty.call(DAY_NAMES, d)) return null;
    }
  }
  let until: string | null = null;
  if (kv.has("UNTIL")) {
    // Only the DATE form ("YYYYMMDD") is rendered in plain language —
    // datetime forms (…T000000Z) stay raw so nothing is misrepresented.
    until = parseUntilDate(kv.get("UNTIL") ?? "");
    if (!until) return null;
  }
  return {
    freq: freqRaw as RRuleParts["freq"],
    interval,
    byday,
    until,
  };
}

/**
 * Plain-language rendering of an RRULE ("Repeats weekly on Monday").
 * Falls back to the RAW rule string verbatim for anything not in the
 * supported common subset — the display must never misrepresent a rule.
 */
export function describeRule(rule: string): string {
  const parts = parseRRule(rule);
  if (!parts) return rule; // raw fallback, byte-identical
  const freq = FREQ_LABEL[parts.freq];
  const plural: Record<RRuleParts["freq"], string> = {
    DAILY: "days",
    WEEKLY: "weeks",
    MONTHLY: "months",
    YEARLY: "years",
  };
  const every =
    parts.interval === 1
      ? `Repeats ${freq}`
      : `Repeats every ${parts.interval} ${plural[parts.freq]}`;
  if (parts.byday.length > 0) {
    const days = parts.byday
      .map((d) => DAY_NAMES[d] ?? d)
      .join(", ");
    const base = `${every} on ${days}`;
    return parts.until ? `${base}, until ${formatUntilDate(parts.until)}` : base;
  }
  return parts.until ? `${every}, until ${formatUntilDate(parts.until)}` : every;
}

/**
 * Grid chip indicator for a series event: glyph + full tooltip text.
 * Returns null when the event is not a series base event.
 */
export function recurrenceBadge(info: SeriesInfo): {
  glyph: string;
  tooltip: string;
  hasOverride: boolean;
} {
  const ruleText = describeRule(info.rule);
  const changed = info.overrides.filter((o) => !o.cancelled).length;
  const cancelled = info.overrides.filter((o) => o.cancelled).length;
  let tooltip = `Recurring — ${ruleText}`;
  if (changed > 0 || cancelled > 0) {
    const bits: string[] = [];
    if (changed > 0)
      bits.push(
        `${changed} occurrence${changed === 1 ? "" : "s"} changed`,
      );
    if (cancelled > 0)
      bits.push(
        `${cancelled} occurrence${cancelled === 1 ? "" : "s"} cancelled`,
      );
    tooltip += ` · ${bits.join(", ")}`;
  }
  return {
    glyph: "🔁",
    tooltip,
    hasOverride: changed > 0 || cancelled > 0,
  };
}

/**
 * Short override marker text for a chip/tooltip ("changed occurrence").
 * Empty when there is no override to surface.
 */
export function overrideMarker(info: SeriesInfo): string {
  const changed = info.overrides.filter((o) => !o.cancelled).length;
  const cancelled = info.overrides.filter((o) => o.cancelled).length;
  if (changed === 0 && cancelled === 0) return "";
  const bits: string[] = [];
  if (changed > 0) bits.push(`${changed} changed occurrence${changed === 1 ? "" : "s"}`);
  if (cancelled > 0) bits.push(`${cancelled} cancelled occurrence${cancelled === 1 ? "" : "s"}`);
  return bits.join(", ");
}

/**
 * Edit-dialog info line (read-only, DC-12 §5.x / deferred #12 surface).
 * States series membership + the rule + the THIS-occurrence-vs-SERIES
 * distinction. v1 editing (frontend/store.ts updateEvent) rewrites the base
 * event row only — occurrence overrides are separate rows and are never
 * touched by it — so the line says exactly that, without overpromising a
 * "this and following"/per-occurrence editor that does not exist (DC-12 R6).
 * Returns "" when the event is not part of a series.
 */
export function dialogRecurrenceLine(info: SeriesInfo): string {
  const ruleText = describeRule(info.rule);
  const marker = overrideMarker(info);
  const overrideNote =
    marker !== ""
      ? ` Overrides on this series: ${marker}.`
      : "";
  return (
    `Part of a recurring series — ${ruleText}. ` +
    `“Apply to: Whole series” edits the series' base event (every occurrence); ` +
    `“This occurrence only” writes an override for just this occurrence ` +
    `(DC-12: the override keeps its original identity; no “this and following”).` +
    overrideNote
  );
}
