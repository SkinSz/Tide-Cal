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
  freq: "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";
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
        if (
          f === "DAILY" || f === "WEEKLY" || f === "MONTHLY" || f === "YEARLY"
        ) freq = f;
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
 *
 * TD-014 (independent review 2026-09-01 F1/F2/F3): rewritten as DIRECT PER-FREQ
 * stepping. The old implementation walked day-by-day with three separate
 * interval "hacks" that hung the renderer (DAILY/MONTHLY INTERVAL>1 never
 * re-derived their anchor), expanded WEEKLY-without-BYDAY to every day, and
 * misaligned WEEKLY INTERVAL>1 weeks. The new structure:
 *   - DAILY:  step `interval` days per occurrence (calendar-day stepping;
 *             wall-clock time-of-day preserved, INVARIANT 9).
 *   - WEEKLY: iterate weeks anchored to the base day (multiples of `interval`
 *             weeks); within an anchor week emit every BYDAY day (or the base
 *             weekday when BYDAY is absent — RFC 5545: the base weekday is
 *             implicitly in the BYDAY set); week boundaries are MO-first
 *             (RFC 5545 WKST default), computed from the base's own week.
 *   - MONTHLY: calendar-month stepping (multiples of `interval` months via
 *             UTC month arithmetic); emit the base day-of-month when the
 *             month HAS that day (RFC 5545: shorter months skip, they do not
 *             fold into the next month).
 * COUNT counts EMITTED occurrences (RFC 5545); UNTIL is an inclusive
 * date-only bound. A hardCap bounds open-ended rules identically to before.
 * All arithmetic is naive wall-clock on UTC calendar fields — no timezone
 * conversion anywhere (DC-12 §2.3/§R5, INVARIANT 9).
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

  // Window bounds compare on the DATE part only (occurrence ids carry a
  // wall-clock time that must not be excluded by a lexicographic accident —
  // 'T' (0x54) sorts above digits, which silently dropped any occurrence ON
  // the window-end date). End date is INCLUSIVE (DC-12: UNTIL semantics).
  const winLoDate = windowStartId.replace(/\D/g, "").slice(0, 8);
  const winHiDate = windowEndId.replace(/\D/g, "").slice(0, 8);
  const winLo = `${winLoDate}T000000`;
  const winHi = `${winHiDate}T235959`;

  const out: string[] = [];
  const hardCap = 10000; // safety bound for open-ended rules
  const maxOccurrences = rule.count ?? hardCap;
  /** A candidate counts toward COUNT only when it is a real occurrence. */
  let generated = 0;

  /** Emit one candidate occurrence if it fits window + bounds. True = stop. */
  const emit = (d: Date): boolean => {
    const id = formatId(d);
    generated++;
    if (id >= winLo && id <= winHi) out.push(id);
    return generated >= maxOccurrences;
  };

  /**
   * MO-first week index. Epoch day 0 (1970-01-01) is a THURSDAY, so the
   * first Monday is epoch day 4: week k spans epoch days [4+7k .. 10+7k].
   */
  const weekIndex = (d: Date): number =>
    Math.floor((d.getTime() / 86_400_000 - 4) / 7);
  const baseWeek = weekIndex(base);
  const baseDayName = JS_DAY_TO_NAME[base.getUTCDay()]!;
  // Time-of-day within the base day — week anchors carry it so every
  // occurrence id preserves the base wall-clock time (INVARIANT 9).
  const baseMidnight = Date.UTC(
    base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate(),
  );
  const baseTOD = base.getTime() - baseMidnight;

  if (rule.freq === "DAILY") {
    // Step `interval` calendar days per occurrence from the base.
    for (let step = 0; ; step += rule.interval) {
      const d = new Date(base.getTime() + step * 86_400_000);
      if (rule.until !== null && dateOnlyId(d) > rule.until) break;
      if (step > 0 && d.getTime() - base.getTime() > hardCap * 86_400_000) break;
      if (emit(d)) break;
    }
    return out;
  }

  if (rule.freq === "WEEKLY") {
    // RFC 5545: an empty BYDAY defaults to the base event's weekday.
    const days = rule.byDay.length > 0 ? rule.byDay : [baseDayName];
    // Map day names to offsets within the MO-first week (0=MO..6=SU).
    const nameToOffset: Record<string, number> = {
      MO: 0, TU: 1, WE: 2, TH: 3, FR: 4, SA: 5, SU: 6,
    };
    const offsets = days
      .map((n) => nameToOffset[n]!)
      .filter((o) => o !== undefined)
      .sort((a, b) => a - b);
    // Iterate anchor weeks in multiples of `interval` from the base's week.
    for (let w = 0; ; w += rule.interval) {
      // Monday of the anchor week (epoch day 4 + 7k), at base wall-time.
      const weekStart = new Date((4 + (baseWeek + w) * 7) * 86_400_000 + baseTOD);
      if (rule.until !== null) {
        // If the week STARTS beyond UNTIL, every candidate in it is too.
        if (dateOnlyId(weekStart) > rule.until) break;
      }
      if (weekStart.getTime() - base.getTime() > hardCap * 86_400_000) break;
      for (const off of offsets) {
        const d = new Date(weekStart.getTime() + off * 86_400_000);
        // Candidates before the base itself are not occurrences.
        if (d.getTime() < base.getTime()) continue;
        if (rule.until !== null && dateOnlyId(d) > rule.until) break;
        if (emit(d)) return out;
      }
    }
    return out;
  }

  // MONTHLY: calendar-month stepping; day-of-month from the base.
  const dayOfMonth = base.getUTCDate();
  for (let mi = 0; ; mi += rule.interval) {
    // UTC month arithmetic: month overflow rolls over automatically
    // (e.g. month 13 -> Jan of next year). Day clamping is manual — a
    // month without the base day-of-month SKIPS (RFC 5545), it never folds.
    const d = new Date(
      Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + mi, 1,
        base.getUTCHours(), base.getUTCMinutes(), base.getUTCSeconds()),
    );
    d.setUTCDate(dayOfMonth); // only valid if this month has that day
    if (d.getUTCDate() !== dayOfMonth) continue; // short month: skip
    if (rule.until !== null && dateOnlyId(d) > rule.until) break;
    // Pkg8 review F3: the cap for MONTHLY must be in MONTH units, not day
    // units — hardCap days ≈ 329 months would silently truncate long COUNT
    // rules. hardCap occurrences × interval months bounds the walk exactly.
    if (mi > hardCap * rule.interval) break;
    if (emit(d)) break;
  }
  // Smoke-test fix (2026-09-03): FREQ=YEARLY previously fell through the
  // if-chain into the MONTHLY branch (default freq was also DAILY), so a
  // yearly series expanded to monthly occurrences — every override became an
  // orphan and the chain rendered wrong. YEARLY = MONTHLY stepping with the
  // month FIXED to the base's month: step `interval` years, keep the base
  // day-of-month (short-month skip per RFC 5545, same as MONTHLY).
  if (rule.freq === "YEARLY") {
    for (let yi = 0; ; yi += rule.interval) {
      const d = new Date(
        Date.UTC(
          base.getUTCFullYear() + yi, base.getUTCMonth(), 1,
          base.getUTCHours(), base.getUTCMinutes(), base.getUTCSeconds(),
        ),
      );
      d.setUTCDate(base.getUTCDate());
      if (d.getUTCDate() !== base.getUTCDate()) continue; // Feb 29 on non-leap years: skip
      if (rule.until !== null && dateOnlyId(d) > rule.until) break;
      if (yi > hardCap * rule.interval) break;
      if (emit(d)) break;
    }
    return out;
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
      // endsWith, not includes: a hypothetical path like
      // "x.recurrence_rule_old" must not false-positive as a rule path
      // (blind-review finding F8).
      pathA.endsWith("recurrence_rule") || isSameOverrideEntity(pathA)
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
