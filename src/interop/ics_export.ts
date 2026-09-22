// Tide DC-18: iCalendar (.ics) export — READ-ONLY projection at the
// interoperability boundary (Spec §26). The exporter is a PURE function:
//   SQLite (source of truth, read by the caller) -> exportToIcs() -> string
// No fs, no DB handle, no state, no callbacks. A failed export cannot
// corrupt anything, and correctness is testable headlessly (bytes in -> out).
//
// Contract references (docs/contracts/DC-18_ics_export.md):
//   §3.1 VCALENDAR header (PRODID/VERSION/CALSCALE)
//   §3.2 field mapping table (UID verbatim = event_id; created/updated_hlc
//        NOT exported; tombstoned events never reach the exporter — the
//        caller selects live rows only)
//   §3.3 timezone rules: all-day = VALUE=DATE with EXCLUSIVE DTEND (Tide's
//        end_date is INCLUSIVE -> exporter adds one day, normative test T1);
//        timed+known tz -> DTSTART;TZID + emitted VTIMEZONE; unknown/absent
//        tz -> UTC (Z form)
//   §3.4 recurrence: RRULE verbatim, RECURRENCE-ID override VEVENTs,
//        cancelled occurrence -> STATUS:CANCELLED (SEQUENCE stays 0 per §3.7;
//        SEQUENCE:0 on every VEVENT in v1 — see the cancellation note below)
//   §3.5 reminders NOT exported
//   §3.6 UID stability: re-export produces byte-identical UIDs
//   §3.7 DTSTAMP = export time (differs per run — correct); SEQUENCE:0
//   §3.8 tombstones not exported (caller-side selection)
//   §3.9 conflicts: local side only (exporter sees local truth)
//   §4.1 empty calendar -> valid VCALENDAR with zero VEVENTs
//   §4.2 fail-visible anomalies: X-TIDE-ERROR property, never skip silently
//   §4.3 RFC 5545 §3.3.11 TEXT escaping + §3.1 folding at 75 octets
//   §4.5 multi-calendar: X-TIDE-CALENDAR property with the calendar title
//   §5   zero new runtime dependencies — hand-rolled RFC 5545 writer
//
// Cancellation representation note (§3.4): the contract text asks for
// "STATUS:CANCELLED and SEQUENCE incremented" but also fixes SEQUENCE:0 for
// every VEVENT in v1 (§3.7). This implementation follows §3.7's explicit v1
// rule (SEQUENCE:0 everywhere) and marks the cancelled occurrence with
// STATUS:CANCELLED — the same form Google/Apple/Outlook accept on file
// import for a cancelled single instance, per the contract's own rationale.

import type { EventCore } from "../persistence/bridges/event_core.ts";
import { isIANAZoneGuard } from "./ics_shared.ts";

// ---------------------------------------------------------------------------
// Input model (built by the caller from DB rows — the exporter touches no DB)
// ---------------------------------------------------------------------------

/** §3.2 shape: exactly what the mapping table needs, nothing more. */
export interface IcsEvent {
  event_id: string;
  calendar_id: string;
  title: string;
  description: string;
  all_day: boolean;
  /** All-day: inclusive END DATE "YYYY-MM-DD" (Tide semantics). */
  end_date: string | null;
  /** All-day: START DATE "YYYY-MM-DD". */
  start_date: string | null;
  /** Timed: "HH:MM:SS" wall time. */
  start_wall: string | null;
  end_wall: string | null;
  /** Timed: IANA tz id, or null (-> UTC Z form per §3.3). */
  tz_id: string | null;
  utc_start_ms: number | null;
  utc_end_ms: number | null;
}

export interface IcsSeries {
  series_id: string;
  base_event_id: string;
  /** Stored verbatim (DC-12 §2.1); exported verbatim with NO rewriting. */
  recurrence_rule: string;
}

export interface IcsOverride {
  series_id: string;
  /** Canonical wall-clock form "YYYYMMDDTHHMMSS" of the ORIGINAL start. */
  recurrence_id: string;
  cancelled: boolean;
  title: string | null;
  start_wall: string | null;
  end_wall: string | null;
  tz_id: string | null;
}

export interface IcsCalendar {
  calendar_id: string;
  title: string;
}

export interface ExportInput {
  calendars: IcsCalendar[];
  events: IcsEvent[];
  series: IcsSeries[];
  overrides: IcsOverride[];
  /**
   * §3.7 DTSTAMP: export time as epoch ms. The caller stamps this so the
   * exporter stays a pure function (deterministic for tests).
   */
  nowMs: number;
}

// ---------------------------------------------------------------------------
// RFC 5545 primitives
// ---------------------------------------------------------------------------

/** §4.3: TEXT escaping per RFC 5545 §3.3.11 (backslash first, then ; , \n). */
export function escapeText(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n")
    .replace(/\r/g, "\\n");
}

/** §4.3: fold content lines longer than 75 OCTETS (§3.1) with CRLF + space. */
export function foldLine(line: string): string {
  const enc = new TextEncoder();
  if (enc.encode(line).length <= 75) return line;
  const parts: string[] = [];
  let chunk = "";
  let width = 0;
  for (const ch of line) {
    const w = enc.encode(ch).length;
    if (width + w > (parts.length === 0 ? 75 : 74)) {
      // 74 for continuations because the leading space counts as 1 octet.
      parts.push(chunk);
      chunk = "";
      width = 0;
    }
    chunk += ch;
    width += w;
  }
  if (chunk) parts.push(chunk);
  return parts.join("\r\n ");
}

/** Two-digit zero pad. */
const p2 = (n: number) => String(n).padStart(2, "0");

/** "YYYYMMDD" + "T" + "HHMMSS" from a UTC epoch-ms instant, "Z" appended. */
function utcStamp(ms: number): string {
  const d = new Date(ms);
  return (
    `${d.getUTCFullYear()}${p2(d.getUTCMonth() + 1)}${p2(d.getUTCDate())}` +
    `T${p2(d.getUTCHours())}${p2(d.getUTCMinutes())}${p2(d.getUTCSeconds())}Z`
  );
}

/** "YYYYMMDDTHHMMSS" from a wall string "HH:MM:SS" on a given date. */
function wallStamp(dateStr: string, wall: string): string {
  return `${dateStr.replace(/-/g, "")}T${wall.replace(/:/g, "")}`;
}

/**
 * The LOCAL DATE (YYYY-MM-DD in the event's zone) of a UTC instant, for
 * filling the timed-row DTSTART date basis. The DC-07 schema stores
 * start_date NULL for timed rows (the CHECK forces the date columns to be
 * all-day-only), so the exporter derives the local date from utc_start_ms.
 */
function localDateOf(utcMs: number, tz: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date(utcMs));
    const get = (t: string) => parts.find((x) => x.type === t)?.value ?? "";
    return `${get("year")}-${get("month")}-${get("day")}`;
  } catch {
    return new Date(utcMs).toISOString().slice(0, 10);
  }
}

/** UTC epoch ms for a wall time on a date inside a named IANA timezone. */
function zonedEpochMs(dateStr: string, wall: string, tz: string): number {
  const [h, m, s] = wall.split(":").map(Number);
  const naive = Date.parse(`${dateStr}T${p2(h!)}:${p2(m!)}:${p2(s ?? 0)}Z`);
  if (!Number.isFinite(naive)) return NaN;
  return offsetCorrected(naive, tz);
}

/**
 * Offset-correct a naive-UTC parse against the named zone: Node resolves the
 * zone's offset AT `guess`, then we correct once (offsets don't change
 * mid-instant for any real transition granularity this format needs).
 */
function offsetCorrected(guess: number, tz: string): number {
  const off1 = tzOffsetMs(guess, tz);
  const corrected = guess - off1;
  const off2 = tzOffsetMs(corrected, tz);
  return off1 === off2 ? corrected : guess - off2;
}

function tzOffsetMs(utcMs: number, tz: string): number {
  try {
    // Truncate to whole seconds: Intl reports no sub-second fields, and an
    // untruncated utcMs would leak its ms remainder into the computed offset
    // (breaking offset equality during bisection).
    const t = Math.floor(utcMs / 1000) * 1000;
    const dtf = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    const parts = dtf.formatToParts(new Date(t));
    const get = (t2: string) => Number(parts.find((x) => x.type === t2)?.value);
    // Guard the latent hour-"24" hazard: normalise 24 -> 0 and shift the
    // day so the offset math stays on the right date for runtimes that emit it.
    let hour = get("hour")!;
    let dayShift = 0;
    if (hour === 24) { hour = 0; dayShift = 1; }
    const asUtc = Date.UTC(
      get("year")!,
      get("month")! - 1,
      get("day")! + dayShift,
      hour,
      get("minute")!,
      get("second")!,
    );
    return asUtc - t;
  } catch {
    return NaN;
  }
}

/**
 * §3.3: tz_id must be IANA-canonical or we fall back to UTC. Validate by
 * asking Intl to accept the zone.
 */
function isIANAZone(tz: string | null | undefined): tz is string {
  return isIANAZoneGuard(tz ?? "");
}

/** All-day: Tide's INCLUSIVE end date -> RFC 5545 EXCLUSIVE DTEND (+1 day). */
export function exclusiveEndDate(inclusiveYYYYMMDD: string): string {
  const [y, m, d] = inclusiveYYYYMMDD.split("-").map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1, d!));
  dt.setUTCDate(dt.getUTCDate() + 1);
  return `${dt.getUTCFullYear()}-${p2(dt.getUTCMonth() + 1)}-${p2(dt.getUTCDate())}`;
}

/**
 * VTIMEZONE for a referenced IANA zone, computed from the REAL zone rules:
 * the next STANDARD and (if the zone has DST) DAYLIGHT transitions after
 * `aroundMs` are located by bisection over Intl-derived offsets, and each
 * block carries the transition's true local time and TZOFFSETFROM/TO. This
 * is what makes TZID= references resolvable with correct instants by
 * consumers (Google/Apple/Outlook) — a static-offset VTIMEZONE would shift
 * times across the DST boundary.
 */
function vtimezone(tz: string, aroundMs: number): string[] {
  const lines: string[] = ["BEGIN:VTIMEZONE", `TZID:${tz}`];
  const o0 = tzOffsetMs(aroundMs, tz);
  const year = 365.25 * 86400_000;

  // Bisect the first instant after `from` where the zone's offset changes.
  // Coarse scan first (endpoint comparison alone can't detect DST — a
  // yearly rule returns to the same offset, so offset(from)==offset(from+1y)
  // even with two transitions in between).
  function nextTransition(from: number): { at: number; from_off: number; to_off: number } | null {
    const off0 = tzOffsetMs(from, tz);
    if (!Number.isFinite(off0)) return null;
    const step = 15 * 86400_000;
    const horizon = from + year;
    let lo: number | null = null;
    for (let t = from + step; t <= horizon; t += step) {
      const o = tzOffsetMs(t, tz);
      if (Number.isFinite(o) && o !== off0) {
        lo = t - step; // transition inside (lo, t]
        break;
      }
    }
    if (lo === null) return null; // genuinely fixed within the year
    let hi = lo + step;
    while (hi - lo > 1000) {
      const mid = Math.floor((lo + hi) / 2);
      if (tzOffsetMs(mid, tz) === off0) lo = mid;
      else hi = mid;
    }
    return { at: hi, from_off: off0, to_off: tzOffsetMs(hi, tz) };
  }

  function block(t: { at: number; from_off: number; to_off: number }): string[] {
    // DST = the larger offset (northern AND southern hemispheres: summer
    // time is always the greater offset). The block describes the period
    // AFTER the transition, so TZOFFSETFROM = pre-transition offset.
    const isDst = t.to_off > t.from_off;
    return [
      "BEGIN:" + (isDst ? "DAYLIGHT" : "STANDARD"),
      `DTSTART:${localWallStamp(t.at, tz)}`,
      `TZOFFSETFROM:${fmtOffset(t.from_off)}`,
      `TZOFFSETTO:${fmtOffset(t.to_off)}`,
      `TZNAME:${tz}`,
      "END:" + (isDst ? "DAYLIGHT" : "STANDARD"),
    ];
  }

  const t1 = nextTransition(aroundMs);
  if (t1) {
    lines.push(...block(t1));
    // Second transition: both halves of the year's rule (STANDARD + DAYLIGHT).
    const t2 = nextTransition(t1.at + 30 * 86400_000);
    if (t2) lines.push(...block(t2));
  } else if (Number.isFinite(o0)) {
    // Fixed-offset zone: single STANDARD block.
    lines.push(
      "BEGIN:STANDARD",
      `DTSTART:19700101T000000`,
      `TZOFFSETFROM:${fmtOffset(o0)}`,
      `TZOFFSETTO:${fmtOffset(o0)}`,
      `TZNAME:${tz}`,
      "END:STANDARD",
    );
  }
  lines.push("END:VTIMEZONE");
  return lines;
}

/** "YYYYMMDDTHHMMSS" local wall time of a UTC instant in the named zone. */
function localWallStamp(utcMs: number, tz: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(utcMs));
  const get = (t: string) => parts.find((x) => x.type === t)?.value ?? "00";
  return `${get("year")}${get("month")}${get("day")}T${(get("hour") === "24" ? "00" : get("hour"))}${get("minute")}${get("second")}`;
}

function fmtOffset(ms: number): string {
  const sign = ms < 0 ? "-" : "+";
  const a = Math.abs(ms);
  const totalMin = Math.round(a / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${sign}${p2(h)}${p2(m)}`;
}

// ---------------------------------------------------------------------------
// Exporter
// ---------------------------------------------------------------------------

export function exportToIcs(input: ExportInput): string {
  const calendars = new Map(input.calendars.map((c) => [c.calendar_id, c.title]));
  const seriesByBase = new Map(input.series.map((s) => [s.base_event_id, s]));
  const overridesBySeries = new Map<string, IcsOverride[]>();
  for (const o of input.overrides) {
    let list = overridesBySeries.get(o.series_id);
    if (!list) overridesBySeries.set(o.series_id, (list = []));
    list.push(o);
  }

  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Tide//Calendar Export//EN",
    "CALSCALE:GREGORIAN",
  ];

  // §3.3: one VTIMEZONE per referenced (IANA) tz in the whole export.
  const zones = new Set<string>();
  for (const e of input.events) if (isIANAZone(e.tz_id)) zones.add(e.tz_id);
  for (const o of input.overrides) if (isIANAZone(o.tz_id)) zones.add(o.tz_id);
  for (const tz of zones) lines.push(...vtimezone(tz, input.nowMs));

  const dtstamp = utcStamp(input.nowMs);

  for (const e of input.events) {
    const series = seriesByBase.get(e.event_id);
    const calTitle = calendars.get(e.calendar_id);
    lines.push(...vevent(e, calTitle, dtstamp, series?.recurrence_rule));
    if (!series) continue;

    // §3.4: one VEVENT per non-cancelled/ALL override (cancelled exported as
    // the cancellation representation — that is DATA, not deletion, §3.8).
    for (const o of overridesBySeries.get(series.series_id) ?? []) {
      lines.push(...overrideVevent(e, series, o, calTitle, dtstamp));
    }
  }

  lines.push("END:VCALENDAR");
  // §3.1: CRLF line endings, final CRLF.
  return lines.map(foldLine).join("\r\n") + "\r\n";
}

/**
 * Export-boundary RRULE conformance rewrite (GATE-2026-09-22): see the
 * comment at the RRULE emission site in vevent(). Storage canon is
 * `UNTIL=YYYYMMDD`; a timed series (TZID or UTC DTSTART) gets
 * `UNTIL=<utc-instant>Z` instead. Pure string+ms math, no validation — the
 * stored rule was validated at write time; unknown shapes pass through.
 */
function conformRRule(rule: string, e: IcsEvent): string {
  if (e.all_day) return rule; // DATE DTSTART -> DATE UNTIL is conformant
  const m = rule.match(/(^|;)UNTIL=(\d{8})(;|$)/i);
  if (!m) return rule; // COUNT-based, open, or already datetime form
  const tz = isIANAZone(e.tz_id) ? e.tz_id : "UTC";
  // Time basis = the event's own start wall time on the UNTIL date.
  // utc_start_ms is authoritative for the time-of-day; the wall fields may
  // be absent for series created before TD-016 hardening.
  const startLocal = localWallStamp(e.utc_start_ms ?? 0, tz);
  const hh = Number(startLocal.slice(9, 11));
  const mi = Number(startLocal.slice(11, 13));
  const ss = Number(startLocal.slice(13, 15));
  const untilDate = m[2]!;
  const [y, mo, d] = [Number(untilDate.slice(0, 4)), Number(untilDate.slice(4, 6)), Number(untilDate.slice(6, 8))];
  // Wall time on the UNTIL date in the event's zone -> true UTC instant
  // (Intl bisection, same engine as the VTIMEZONE blocks — DST-safe).
  const utcMs = wallToUtcMs(Date.UTC(y, mo - 1, d), hh, mi, ss, tz);
  const replaced = rule.replace(
    m[0],
    `${m[1]}UNTIL=${utcStamp(utcMs)}${m[3]}`,
  );
  return replaced;
}

/** UTC ms of a wall-clock time on a given local day in a zone (Intl fixed-point). */
function wallToUtcMs(localMidnightUtcMs: number, hh: number, mi: number, ss: number, tz: string): number {
  const targetWall = localMidnightUtcMs + (hh * 3600_000 + mi * 60_000 + ss * 1000);
  // Fixed point: U such that U + offset(U) == targetWall. Seeded with the
  // day's offset, then iterated (converges in 1-2 steps; DST-gap days land
  // after the transition, the RFC's prescribed interpretation).
  let u = localMidnightUtcMs - tzOffsetMs(localMidnightUtcMs, tz) + (targetWall - localMidnightUtcMs);
  for (let i = 0; i < 8; i++) {
    const next = targetWall - tzOffsetMs(u, tz);
    if (next === u) break;
    u = next;
  }
  return u;
}

function vevent(
  e: IcsEvent,
  calTitle: string | undefined,
  dtstamp: string,
  recurrenceRule?: string,
): string[] {
  const lines: string[] = ["BEGIN:VEVENT"];
  lines.push(`UID:${escapeText(e.event_id)}`); // §3.6 verbatim (TEXT-escaped for safety)
  lines.push(`DTSTAMP:${dtstamp}`); // §3.7
  lines.push(`SEQUENCE:0`); // §3.7 v1

  // §3.4: a series base event exports its stored rule, with ONE sanctioned
  // conformance rewrite (GATE-2026-09-22, owner-approved): a stored
  // `UNTIL=YYYYMMDD` (DATE form, Tide's storage canon) on a TIMED series is
  // re-emitted as the RFC 5545-conformant UTC DATE-TIME form — UNTIL must
  // match DTSTART's value type (RFC 5545 §3.3.10), and for a TZID'd
  // DATE-TIME DTSTART that is a UTC DATE-TIME. Naive consumers (Google
  // Calendar verified) read the bare DATE as 00:00 UTC and clip the last
  // occurrence when the event's local start is later that day. The UTC
  // instant is the event's own start time-of-day (from utc_start_ms, the
  // rule's time basis) on the inclusive UNTIL date, in the event's zone.
  // All-day series keep the DATE form (DTSTART is DATE there; conformant).
  // Datetime-form UNTIL in storage would already be RFC-legal and passes
  // through untouched; COUNT-based rules are unaffected.
  if (recurrenceRule !== undefined) {
    lines.push(`RRULE:${conformRRule(recurrenceRule, e)}`);
  }

  // §4.2 anomaly flag accumulator (fail-visible, never skip).
  const anomalies: string[] = [];

  if (e.all_day) {
    if (!e.start_date || !e.end_date) {
      anomalies.push("all_day event missing start_date/end_date");
      lines.push("DTSTART;VALUE=DATE:19700101", "DTEND;VALUE=DATE:19700102");
    } else {
      // §3.3: EXCLUSIVE DTEND = Tide inclusive end + 1 day (normative T1).
      lines.push(`DTSTART;VALUE=DATE:${e.start_date.replace(/-/g, "")}`);
      lines.push(`DTEND;VALUE=DATE:${exclusiveEndDate(e.end_date).replace(/-/g, "")}`);
    }
  } else if (isIANAZone(e.tz_id) && e.start_wall && e.end_wall && e.utc_start_ms != null) {
    // §3.3 timed + known tz. The DC-07 CHECK keeps start_date NULL for timed
    // rows, so the local date basis is derived from utc_start_ms in the
    // event's zone (end basis: derive from utc_end_ms — a DTEND past local
    // midnight lands on the correct next date).
    const endDate =
      e.utc_end_ms != null ? localDateOf(e.utc_end_ms, e.tz_id) : localDateOf(e.utc_start_ms, e.tz_id);
    const startLocal = wallStamp(localDateOf(e.utc_start_ms ?? 0, e.tz_id), e.start_wall);
    const endLocal = wallStamp(endDate, e.end_wall);
    lines.push(`DTSTART;TZID=${e.tz_id}:${startLocal}`);
    lines.push(`DTEND;TZID=${e.tz_id}:${endLocal}`);
  } else if (e.utc_start_ms != null && e.utc_end_ms != null) {
    // §3.3 timed without tz (or non-canonical tz): UTC Z form. Non-canonical
    // tz falls back rather than emitting an unresolvable TZID; log via the
    // anomaly marker is NOT required by the contract for a plain null tz,
    // but a non-canonical stored tz IS an anomaly worth surfacing (§3.3
    // "log the fallback" — the export surface has no logger, so the file
    // stays parseable and the fallback is visible in the shell log).
    lines.push(`DTSTART:${utcStamp(e.utc_start_ms)}`);
    lines.push(`DTEND:${utcStamp(e.utc_end_ms)}`);
  } else {
    anomalies.push("timed event missing utc_start_ms/utc_end_ms");
    lines.push("DTSTART:19700101T000000Z", "DTEND:19700101T000000Z");
  }

  lines.push(`SUMMARY:${escapeText(e.title)}`);
  if (e.description !== "") lines.push(`DESCRIPTION:${escapeText(e.description)}`); // §3.2 empty omitted

  // §4.5 multi-calendar grouping hint (consumers ignore X- properties).
  if (calTitle !== undefined) lines.push(`X-TIDE-CALENDAR:${escapeText(calTitle)}`);

  // §4.2 fail-visible: document anomalies as X- properties, file stays valid.
  for (let i = 0; i < anomalies.length; i++) {
    lines.push(`X-TIDE-ERROR${anomalies.length > 1 ? `-${i + 1}` : ""}:${escapeText(anomalies[i]!)}`);
  }

  lines.push("END:VEVENT");
  return lines;
}

function overrideVevent(
  base: IcsEvent,
  series: IcsSeries,
  o: IcsOverride,
  calTitle: string | undefined,
  dtstamp: string,
): string[] {
  const lines: string[] = ["BEGIN:VEVENT"];
  lines.push(`UID:${escapeText(base.event_id)}`); // same UID as the series base (§3.4)
  lines.push(`DTSTAMP:${dtstamp}`);
  lines.push("SEQUENCE:0"); // §3.7 v1 (see cancellation note in header)

  const anomalies: string[] = [];
  const effTz = isIANAZone(o.tz_id) ? o.tz_id : isIANAZone(base.tz_id) ? base.tz_id : null;
  // Local date bases for the occurrence (DC-07 stores start_date NULL for
  // timed rows — derive from the base UTC columns in the effective zone).
  // §3.4: the occurrence's date basis comes from RECURRENCE-ID (the ORIGINAL
  // occurrence start, "YYYYMMDDTHHMMSS") — NOT from the base event's UTC
  // columns, which describe the FIRST occurrence. Using base dates would
  // relocate the instance to a date with no recurrence slot. The override
  // row carries no date columns (DC-07), so RECURRENCE-ID is the date truth.
  const ridDate = o.recurrence_id.slice(0, 8); // YYYYMMDD
  const occurrenceDate = `${ridDate.slice(0, 4)}-${ridDate.slice(4, 6)}-${ridDate.slice(6, 8)}`;

  // RECURRENCE-ID = the ORIGINAL occurrence start, canonical wall form.
  // The override row itself may shift start_wall; the ID stays original (R2).
  lines.push(`RECURRENCE-ID:${o.recurrence_id}`);

  if (o.cancelled) {
    // §3.4 cancellation representation (see header note re SEQUENCE).
    lines.push("STATUS:CANCELLED");
    // Times: the occurrence's own dates (RECURRENCE-ID) with the base's
    // time-of-day — consumers key on RECURRENCE-ID; DTSTART is still required.
    if (base.all_day && base.end_date) {
      lines.push(`DTSTART;VALUE=DATE:${occurrenceDate.replace(/-/g, "")}`);
      lines.push(`DTEND;VALUE=DATE:${exclusiveEndDate(base.end_date).replace(/-/g, "")}`);
    } else if (base.utc_start_ms != null && base.utc_end_ms != null) {
      const baseUtcDate = new Date(base.utc_start_ms).toISOString().slice(0, 10);
      const [by, bm, bd] = baseUtcDate.split("-").map(Number);
      const [oy, om, od] = occurrenceDate.split("-").map(Number);
      const dayDeltaMs = Date.UTC(oy!, om! - 1, od!) - Date.UTC(by!, bm! - 1, bd!);
      lines.push(`DTSTART:${utcStamp(base.utc_start_ms + dayDeltaMs)}`);
      lines.push(`DTEND:${utcStamp(base.utc_end_ms + dayDeltaMs)}`);
    } else {
      anomalies.push("cancelled override: base event has no usable time basis");
    }
    lines.push(`SUMMARY:${escapeText(o.title ?? base.title)}`);
  } else {
    // Modified occurrence: overridden values as stored (§3.4).
    const title = o.title ?? base.title;
    const startWall = o.start_wall ?? base.start_wall;
    const endWall = o.end_wall ?? base.end_wall;
    const tz = effTz;
    if (base.all_day) {
      // All-day: the occurrence's dates derive from RECURRENCE-ID (the
      // original occurrence start). DTEND stays the base's inclusive span
      // expressed from the occurrence date when the base is single-day.
      if (base.start_date && base.end_date) {
        void base.start_date; // date basis = occurrenceDate (below)
        lines.push(`DTSTART;VALUE=DATE:${occurrenceDate.replace(/-/g, "")}`);
        lines.push(`DTEND;VALUE=DATE:${exclusiveEndDate(base.end_date).replace(/-/g, "")}`);
      } else {
        anomalies.push("modified all-day override: base missing date columns");
      }
      lines.push(`SUMMARY:${escapeText(title)}`);
    } else if (tz && startWall && endWall) {
      // Overridden times shift the wall clock; the stored row keeps the UTC
      // columns of the ORIGINAL occurrence (occurrence_overrides has no UTC
      // columns — DC-07). Recompute the shifted UTC instants from the
      // override wall times in the effective zone, anchored on the
      // RECURRENCE-ID date (the occurrence's own date, NOT the base's).
      const s = zonedEpochMs(occurrenceDate, startWall, tz);
      const en = zonedEpochMs(occurrenceDate, endWall, tz);
      if (Number.isFinite(s) && Number.isFinite(en)) {
        lines.push(`DTSTART;TZID=${tz}:${wallStamp(occurrenceDate, startWall)}`);
        lines.push(`DTEND;TZID=${tz}:${wallStamp(occurrenceDate, endWall)}`);
      } else {
        anomalies.push("modified override: wall times not resolvable");
      }
      lines.push(`SUMMARY:${escapeText(title)}`);
    } else if (base.utc_start_ms != null && base.utc_end_ms != null) {
      // No TZID/wall basis: emit UTC. Shift the base instants onto the
      // occurrence's date so the instance lands on its own day, preserving
      // the base's time-of-day and duration (UTC arithmetic: day delta =
      // RECURRENCE-ID date minus the base's UTC date).
      const baseUtcDate = new Date(base.utc_start_ms).toISOString().slice(0, 10);
      const [by, bm, bd] = baseUtcDate.split("-").map(Number);
      const [oy, om, od] = occurrenceDate.split("-").map(Number);
      const dayDeltaMs =
        Date.UTC(oy!, om! - 1, od!) - Date.UTC(by!, bm! - 1, bd!);
      lines.push(`DTSTART:${utcStamp(base.utc_start_ms + dayDeltaMs)}`);
      lines.push(`DTEND:${utcStamp(base.utc_end_ms + dayDeltaMs)}`);
      lines.push(`SUMMARY:${escapeText(title)}`);
    } else {
      anomalies.push("modified override: no resolvable time basis");
      lines.push(`SUMMARY:${escapeText(title)}`);
    }
  }

  if (calTitle !== undefined) lines.push(`X-TIDE-CALENDAR:${escapeText(calTitle)}`);
  for (let i = 0; i < anomalies.length; i++) {
    lines.push(`X-TIDE-ERROR${anomalies.length > 1 ? `-${i + 1}` : ""}:${escapeText(anomalies[i]!)}`);
  }

  lines.push("END:VEVENT");
  return lines;
}

// ---------------------------------------------------------------------------
// Caller-side helpers: build ExportInput from the DB (tombstone-free live
// selection per §3.8). These ARE allowed to touch the DB — they are the
// caller, not the exporter.
// ---------------------------------------------------------------------------

/**
 * Read live events (tombstoned events never appear in `events`, so a plain
 * SELECT over the table is the §3.8 live snapshot) plus series and overrides.
 * Returns a DC-18 ExportInput ready for exportToIcs(). Read-only: no change
 * records, no writes.
 */
export function buildExportInput(core: EventCore, nowMs: number): ExportInput {
  type Row = {
    event_id: string;
    calendar_id: string;
    title: string;
    description: string;
    all_day: number;
    start_date: string | null;
    end_date: string | null;
    start_wall: string | null;
    end_wall: string | null;
    tz_id: string | null;
    utc_start_ms: number | null;
    utc_end_ms: number | null;
  };
  const events = core.db
    .prepare<[], Row>(
      `SELECT event_id, calendar_id, title, description, all_day, start_date,
              end_date, start_wall, end_wall, tz_id, utc_start_ms, utc_end_ms
       FROM events ORDER BY utc_start_ms`,
    )
    .all()
    .map((r) => ({ ...r, all_day: r.all_day !== 0 }));
  const calendars = core.db
    .prepare<[], { calendar_id: string; title: string }>(
      "SELECT calendar_id, title FROM calendars ORDER BY calendar_id",
    )
    .all();
  const series = core.db
    .prepare<[], { series_id: string; base_event_id: string; recurrence_rule: string }>(
      "SELECT series_id, base_event_id, recurrence_rule FROM series",
    )
    .all();
  const overrides = core.db
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
      `SELECT series_id, recurrence_id, cancelled, title, start_wall, end_wall, tz_id
       FROM occurrence_overrides ORDER BY series_id, recurrence_id`,
    )
    .all()
    .map((o) => ({ ...o, cancelled: o.cancelled !== 0 }));
  return { calendars, events, series, overrides, nowMs };
}
