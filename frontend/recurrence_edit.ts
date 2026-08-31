// Tide recurrence editing (DC-12) — user-facing rule builder + occurrence
// scope helpers. PURE, DOM-free (vitest node env), like recurrence.ts.
//
// The builder produces an RFC 5545 RRULE string (DC-12 §2.1: Tide defines NO
// custom recurrence DSL; the rule is stored and exchanged verbatim). The UI
// covers the common subset the domain validator accepts (FREQ, INTERVAL,
// BYDAY, COUNT, UNTIL); anything exotic is preserved via raw-string fallback
// in draftFromRule's null result (the dialog then shows the raw rule, exactly
// like the read side's describeRule fallback).
//
// "This and following" splits are EXPLICITLY OUT OF SCOPE (DC-12 §8 / R6):
// there is no truncate-and-spawn API here and none may be added.

import { parseRRule } from "./recurrence.ts";

/** Rule-builder draft: "NONE" = does not repeat. */
export interface RuleDraft {
  freq: "NONE" | "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";
  /** Every N periods (>= 1). */
  interval: number;
  /** WEEKLY only: selected weekday codes (MO..SU); empty = base weekday. */
  byDay: string[];
}

export const WEEKDAY_CODES = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"] as const;

/** JS getDay() (0=Sun) -> RFC 5545 day code. */
export function weekdayCode(jsDay: number): string {
  return ["SU", "MO", "TU", "WE", "TH", "FR", "SA"][jsDay] ?? "MO";
}

/**
 * Build an RRULE string from a draft. Returns null for "does not repeat"
 * (a plain single event — no series). WEEKLY with no selected day falls back
 * to the base date's weekday (the natural user intent).
 */
export function buildRRule(draft: RuleDraft, baseDate: Date): string | null {
  if (draft.freq === "NONE") return null;
  const interval = Number.isInteger(draft.interval) && draft.interval >= 1 ? draft.interval : 1;
  const parts: string[] = [`FREQ=${draft.freq}`];
  if (interval > 1) parts.push(`INTERVAL=${interval}`);
  if (draft.freq === "WEEKLY") {
    const days = draft.byDay.length > 0 ? [...draft.byDay] : [weekdayCode(baseDate.getDay())];
    // Canonical MO-first ordering so the same draft always builds the same
    // string (stable comparisons, deterministic conflict payloads).
    const ordered = WEEKDAY_CODES.filter((d) => days.includes(d));
    parts.push(`BYDAY=${ordered.join(",")}`);
  }
  return parts.join(";");
}

/**
 * Recover an editable draft from a stored RRULE. Returns null when the rule
 * is not coverable by the builder subset (COUNT/UNTIL, exotic keys, bad
 * values) — the caller then shows the raw string and keeps it verbatim.
 */
export function draftFromRule(rule: string): RuleDraft | null {
  const parsed = parseRRule(rule);
  if (!parsed) return null;
  return {
    freq: parsed.freq,
    interval: parsed.interval,
    byDay: parsed.byday,
  };
}

/**
 * Canonical recurrence_id (DC-12 §2.3): "YYYYMMDDTHHMMSS" wall-clock LOCAL
 * form of the occurrence's original start, in the series timezone. No offset
 * suffix — it names a wall-clock position, not an instant. All-day series
 * use the midnight convention "YYYYMMDDT000000".
 */
export function deriveRecurrenceId(startMs: number, allDay: boolean): string {
  const d = new Date(startMs);
  const p = (n: number): string => String(n).padStart(2, "0");
  const date = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
  const time = allDay ? "000000" : `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `${date}T${time}`;
}

/** Local wall string "YYYY-MM-DDTHH:MM" (override start_wall/end_wall form). */
export function wallStamp(ms: number): string {
  const d = new Date(ms);
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
