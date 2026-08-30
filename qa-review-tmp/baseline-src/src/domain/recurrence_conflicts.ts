// Tide DC-12: Recurrence conflict logic (APPROVED contract).
// Pure functions — naive wall-clock arithmetic, NO timezone conversion.
// recurrence_id canonical form: 'YYYYMMDDTHHMMSS' (DC-12 §2.3).

export interface SeriesState {
  series_id: string;
  /** naive wall-clock start, e.g. '2026-09-02T09:00' */
  base_start_wall: string;
  tz_id: string;
  /** RRULE string, e.g. 'FREQ=WEEKLY;BYDAY=WE' */
  recurrence_rule: string;
}

export interface OccurrenceOverride {
  series_id: string;
  /** 'YYYYMMDDTHHMMSS', anchored to ORIGINAL occurrence (R2) */
  recurrence_id: string;
  cancelled: boolean;
  title?: string;
  start_wall?: string;
  end_wall?: string;
  tz_id?: string;
}

const DAY_NAMES = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"] as const;
// JS getDay(): 0=Sunday..6=Saturday -> map to our MO-first indices
const JS_DAY_TO_NAME = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

interface ParsedRule {
  freq: "DAILY" | "WEEKLY" | "MONTHLY";
  interval: number;
  byDay: string[]; // ['MO','FR'] normalized uppercase
  count: number | null;
  until: string | null; // 'YYYYMMDD'
}

export function parseRule(rule: string): ParsedRule {
  const parts = rule.split(";").map((p) => p.trim());
  let freq: ParsedRule["freq"] = "DAILY";
  let interval = 1;
  let byDay: string[] = [];
  let count: number | null = null;
  let until: string | null = null;
  for (const part of parts) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const key = part.slice(0, eq).toUpperCase();
    const value = part.slice(eq + 1).trim();
    switch (key) {
      case "FREQ": {
        const f = value.toUpperCase();
        if (f === "DAILY" || f === "WEEKLY" || f === "MONTHLY") freq = f;
        break;
      }
      case "INTERVAL":
        interval = Math.max(1, parseInt(value, 10) || 1);
        break;
      case "BYDAY":
        byDay = value
          .split(",")
          .map((d) => d.trim().toUpperCase())
          .filter((d) => (DAY_NAMES as readonly string[]).includes(d));
        break;
      case "COUNT":
        count = Math.max(1, parseInt(value, 10) || 1);
        break;
      case "UNTIL":
        until = value.replace(/[-T:]/g, "").slice(0, 8); // YYYYMMDD
        break;
    }
  }
  return { freq, interval, byDay, count, until };
}

/** Pad a number to fixed width. */
function pad(n: number, width: number): string {
  return String(n).padStart(width, "0");
}

/** Format a Date (UTC methods — pure wall-clock arithmetic). */
function formatId(d: Date): string {
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1, 2)}${pad(d.getUTCDate(), 2)}` +
    `T${pad(d.getUTCHours(), 2)}${pad(d.getUTCMinutes(), 2)}${pad(d.getUTCSeconds(), 2)}`
  );
}

function dateOnlyId(d: Date): string {
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1, 2)}${pad(d.getUTCDate(), 2)}`;
}

/**
 * Expand occurrences of the series within [windowStartId, windowEndId]
 * (both 'YYYYMMDDTHHMMSS' or 'YYYYMMDD'; compared lexically on the date part).
 * Deterministic; COUNT/UNTIL bound total generation regardless of window.
 */
export function expandOccurrences(
  series: SeriesState,
  windowStartId: string,
  windowEndId: string,
): string[] {
  const rule = parseRule(series.recurrence_rule);
  // Base start as UTC-calendar fields (naive wall-clock semantics).
  const m = series.base_start_wall.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/,
  );
  if (!m) throw new Error(`bad base_start_wall: ${series.base_start_wall}`);
  const base = new Date(
    Date.UTC(
      +m[1]!,
      +m[2]! - 1,
      +m[3]!,
      +m[4]!,
      +m[5]!,
      m[6] ? +m[6] : 0,
    ),
  );

  const winLo = windowStartId.replace(/[-T:]/g, "").slice(0, 15);
  const winHi = windowEndId.replace(/[-T:]/g, "").slice(0, 15);

  const out: string[] = [];
  const occurrenceDate = new Date(base.getTime());
  let generated = 0;
  let weekCursor = new Date(base.getTime()); // interval anchor for WEEKLY
  const hardCap = 10000; // safety bound for open-ended rules
  const maxOccurrences = rule.count ?? hardCap;

  const inWindow = (id: string): boolean => {
    const datePart = id.slice(0, 8);
    return (
      datePart >= winLo.slice(0, 8) &&
      datePart <= winHi.slice(0, 8)
    );
  };

  while (generated < maxOccurrences && generated < hardCap) {
    if (rule.until !== null && dateOnlyId(occurrenceDate) > rule.until) break;

    // WEEKLY INTERVAL>1: if we've stepped past the current interval-week,
    // jump the anchor forward by (interval-1) extra weeks.
    if (rule.freq === "WEEKLY" && rule.interval > 1) {
      const weeksFromBase = Math.floor(
        (weekCursor.getTime() - base.getTime()) / (86400000 * 7),
      );
      const currentWeek = Math.floor(
        (occurrenceDate.getTime() - base.getTime()) / (86400000 * 7),
      );
      void weeksFromBase;
      // weekCursor advances in multiples of `interval` weeks from base.
      while (
        Math.floor((occurrenceDate.getTime() - weekCursor.getTime()) / (86400000 * 7)) >=
        rule.interval
      ) {
        weekCursor = new Date(weekCursor.getTime() + 7 * rule.interval * 86400000);
      }
      // Days beyond the anchor week (before next cursor) don't match.
      if (occurrenceDate.getTime() > weekCursor.getTime() + 6 * 86400000) {
        occurrenceDate.setUTCDate(occurrenceDate.getUTCDate() + 1);
        continue;
      }
      void currentWeek;
    }

    let matches = false;
    if (rule.freq === "DAILY") {
      matches = true;
    } else if (rule.freq === "WEEKLY") {
      if (rule.byDay.length === 0) {
        matches = true; // same weekday as base
      } else {
        const dayName = JS_DAY_TO_NAME[occurrenceDate.getUTCDay()]!;
        matches = rule.byDay.includes(dayName);
      }
    } else {
      // MONTHLY: same day-of-month as base
      matches = occurrenceDate.getUTCDate() === base.getUTCDate();
    }

    if (matches) {
      const id = formatId(occurrenceDate);
      if (id >= winLo && id <= winHi + "235959".slice(0, Math.max(0, 6))) {
        out.push(id);
      }
      generated++;
      if (generated >= maxOccurrences) break;
    }

    // Advance one day at a time; apply INTERVAL stepping per completed period.
    occurrenceDate.setUTCDate(occurrenceDate.getUTCDate() + 1);

    if (rule.interval > 1) {
      // Skip days not aligned to the interval period.
      const daysSinceBase = Math.floor(
        (occurrenceDate.getTime() - base.getTime()) / 86400000,
      );
      if (rule.freq === "DAILY" || rule.freq === "MONTHLY") {
        const periodDays = rule.freq === "DAILY" ? rule.interval : 28 * rule.interval;
        while (
          daysSinceBase % periodDays !== 0 &&
          generated < maxOccurrences &&
          !(rule.until !== null && dateOnlyId(occurrenceDate) > rule.until)
        ) {
          occurrenceDate.setUTCDate(occurrenceDate.getUTCDate() + 1);
        }
      }
      // WEEKLY with BYDAY handles interval via week-boundary checks below.
    }
  }
  return out;
}

/**
 * R1: override ids NOT matching any current-rule expansion are ORPHANED.
 * Detection is a pure function of stored state (DC-12 §3 R1).
 */
export function detectOrphans(
  series: SeriesState,
  overrides: OccurrenceOverride[],
): Set<string> {
  // Wide expansion window honoring COUNT/UNTIL; else 10 years from base.
  const rule = parseRule(series.recurrence_rule);
  const baseYear = +series.base_start_wall.slice(0, 4);
  const endYear = rule.until
    ? Math.max(baseYear, +rule.until.slice(0, 4)) + 1
    : baseYear + 10;
  const expansion = new Set(
    expandOccurrences(series, `${baseYear}0101T000000`, `${endYear}1231T235959`),
  );
  const orphans = new Set<string>();
  for (const o of overrides) {
    if (!expansion.has(o.recurrence_id)) orphans.add(o.recurrence_id);
  }
  return orphans;
}

/** D7: series deletion structurally removes ALL its overrides. */
export function applySeriesDeletion(
  _seriesId: string,
  overrides: OccurrenceOverride[],
): { deletedOverrideIds: string[] } {
  return { deletedOverrideIds: overrides.map((o) => o.recurrence_id) };
}

/** DC-03 conflict entity key for an override field (§2.1 mapping). */
export function conflictEntityFor(
  _seriesId: string,
  recurrenceId: string,
  field: string,
): string {
  return `overrides.${recurrenceId}.${field}`;
}

/**
 * [24]-R1 independence: a series-rule change and an override change are NEVER
 * a conflicting pair. Same-rule-vs-same-rule and same-override-entity pairs are.
 */
export function isRecurrenceConflictPair(pathA: string, pathB: string): boolean {
  if (pathA === pathB) {
    return (
      pathA.includes("recurrence_rule") || isSameOverrideEntity(pathA)
    );
  }
  const isRule = (p: string) => p.endsWith("recurrence_rule");
  const overrideEntity = (p: string): string | null => {
    const m = p.match(/^(overrides\.[^.]+\.[^]+?)(?:\.[^.]+)?$/);
    return m ? m[1]! : null;
  };
  if (isRule(pathA) && isRule(pathB)) return true;
  if (isRule(pathA) !== isRule(pathB)) return false; // rule vs override: independent
  const ea = overrideEntity(pathA);
  const eb = overrideEntity(pathB);
  return ea !== null && ea === eb;
}

function isSameOverrideEntity(p: string): boolean {
  return p.startsWith("overrides.");
}
