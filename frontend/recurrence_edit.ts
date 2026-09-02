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
  /**
   * Mandatory end date, local "YYYY-MM-DD" (the last occurrence date,
   * INCLUSIVE — RFC 5545 UNTIL names the final occurrence). Required for
   * every rule (DC-12 owner decision, 2026-08-31): an open-ended rule can
   * no longer be built.
   */
  until: string | null;
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
 *
 * UNTIL is MANDATORY (owner decision, 2026-08-31): every built rule carries
 * `UNTIL=YYYYMMDD` derived from draft.until. The picked date is the last
 * occurrence, INCLUSIVE (RFC 5545 UNTIL semantics), so UNTIL equal to the
 * event's own day is valid and any earlier date is rejected. Throws a
 * user-presentable error when the end date is missing or before the event's
 * day — the dialog surfaces it as its friendly inline error.
 */
export function buildRRule(draft: RuleDraft, baseDate: Date): string | null {
  if (draft.freq === "NONE") return null;
  if (!draft.until || !/^\d{4}-\d{2}-\d{2}$/.test(draft.until)) {
    throw new Error("Choose an end date (Until) for the repeating event.");
  }
  const untilMs = new Date(`${draft.until}T00:00:00`).getTime();
  const baseMs = new Date(
    baseDate.getFullYear(),
    baseDate.getMonth(),
    baseDate.getDate(),
  ).getTime();
  if (!Number.isFinite(untilMs) || untilMs < baseMs) {
    throw new Error(
      "The end date must be on or after the event's own day.",
    );
  }
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
  parts.push(`UNTIL=${draft.until.replaceAll("-", "")}`);
  return parts.join(";");
}

/**
 * Recover an editable draft from a stored RRULE. Returns null when the rule
 * is not coverable by the builder subset (COUNT, exotic keys, bad values) —
 * the caller then shows the raw string and keeps it verbatim. UNTIL date
 * form round-trips ("YYYYMMDD" -> "YYYY-MM-DD"); datetime-form UNTIL is
 * outside the subset.
 */
export function draftFromRule(rule: string): RuleDraft | null {
  const parsed = parseRRule(rule);
  if (!parsed) return null;
  return {
    freq: parsed.freq,
    interval: parsed.interval,
    byDay: parsed.byday,
    until: parsed.until
      ? `${parsed.until.slice(0, 4)}-${parsed.until.slice(4, 6)}-${parsed.until.slice(6, 8)}`
      : null,
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

/**
 * TD-016 (owner decision, 2026-09-02, binding): terminate a series' rule at a
 * given occurrence by rewriting its UNTIL (inclusive last-occurrence date,
 * "YYYYMMDD"). Nothing is deleted: all occurrences before/at `untilDate`
 * remain generated by the rule; everything after it stops. All other rule
 * parts are preserved verbatim — the rule stays an RFC 5545 string the
 * domain validator accepts (FREQ/INTERVAL/BYDAY/UNTIL are form-checked, not
 * reordered). This is the "end recurrence here" mechanism behind unchecking
 * "Repeat"; it is NOT a truncate-and-spawn API (DC-12 §8 / R6 stands: no
 * new series is spawned, the chain just stops).
 *
 * Pkg8 review F4: an existing UNTIL is replaced ONLY by the EARLIER bound
 * (min of the two). "End recurrence here" must never EXTEND a series past an
 * already-ended date — that would resurrect occurrences the user ended long
 * ago. A later edit point on an earlier-terminated series is a no-op (the
 * series already ends before it).
 */
export function terminateRuleAt(rule: string, untilDate: string): string {
  if (!/^\d{8}$/.test(untilDate)) {
    throw new Error(`terminateRuleAt: untilDate must be YYYYMMDD, got ${JSON.stringify(untilDate)}`);
  }
  const existing = rule
    .split(";")
    .map((p) => p.trim())
    .filter((p) => /^UNTIL=/i.test(p))
    .map((p) => p.split("=")[1] ?? "")
    .find((u) => /^\d{8}$/.test(u));
  const effective =
    existing && existing < untilDate ? existing : untilDate; // earliest bound wins
  const parts = rule.split(";").filter((p) => !/^UNTIL=/i.test(p.trim()));
  parts.push(`UNTIL=${effective}`);
  return parts.join(";");
}
