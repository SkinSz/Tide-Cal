// Tide DC-23: iCalendar (.ics) import — CONTROLLED INGEST at the
// interoperability boundary (Spec §26 inverse). Architecture:
//
//   .ics bytes -> parseIcs() [pure] -> planImport() [pure] -> applyImportPlan()
//   (applier writes EXCLUSIVELY through EventCore — normal change records,
//   device-clock advances, validation; imported edits are indistinguishable
//   from ordinary local edits to sync peers)
//
// Contract (docs/contracts/DC-23_ics_import.md, owner-approved 2026-09-08):
//   §1.1  plan-then-apply atomicity: full plan parsed+validated before any
//         mutation; each applied entity is its own T1; a mid-apply failure
//         is reported and application continues; NO whole-file transaction.
//   §1.2  hostile-input posture: parser executes/fetches/touches nothing;
//         bounded parsing (§10.2 caps); accepted grammar = §3.1 subset only.
//   §3.1  accepted: VCALENDAR/VEVENT with DTSTART/DTEND (DATE + DATE-TIME,
//         TZID), SUMMARY, DESCRIPTION, UID, RRULE, RECURRENCE-ID,
//         STATUS:CANCELLED, SEQUENCE, DTSTAMP. Everything else (VTODO,
//         VJOURNAL, VFREEBUSY, VALARM, ATTENDEE, ORGANIZER, EXDATE, RDATE,
//         X- props, unknown props) is ignored WITH a report entry.
//   §3.2  CRLF + bare-LF + folding tolerance; non-calendar input = hard
//         error, no application at all.
//   §3.3  duplicate UID inside one file: first wins, rest skipped+reported.
//   §3.4  TZID known IANA -> tz_id+wall+UTC stored; unknown -> UTC fallback
//         (visible in report); embedded VTIMEZONE never authoritative (D3).
//   §3.5  all-day EXCLUSIVE DTEND -> Tide INCLUSIVE end_date (−1 day).
//   §4    identity resolution in the PLANNER: A match->UPDATE via normal
//         path (D1); B canonical evt-<uuid> absent -> CREATE with that id;
//         C foreign UID -> FRESH Tide id, foreign UID never persisted (D2);
//         D tombstone match -> SKIP+report (never resurrect).
//   §4.5  RRULE inside the DC-12 subset -> verbatim through createEvent's
//         recurrenceRule path; outside -> non-recurring single event +
//         visible "recurrence simplified" report entry; validator NEVER
//         weakened (D4).
//   §4.6  RECURRENCE-ID overrides via updateOccurrence; cancelled ->
//         cancelled: true; overrides of failed/skipped series -> skipped.
//   §4.7  ordering: bases before overrides regardless of file order.
//   §5    applier uses EventCore methods only, no raw SQL; report is the
//         truth surface (created/updated/skipped/failed with reasons).

import { randomUUID } from "node:crypto";
import type { EventCore } from "../persistence/bridges/event_core.ts";
import { validateRRule } from "../persistence/bridges/event_core.ts";
import { isIANAZoneGuard } from "./ics_shared.ts";

// ---------------------------------------------------------------------------
// Pure data model
// ---------------------------------------------------------------------------

/** §3.1: exactly the VEVENT properties DC-23 accepts; all else ignored. */
export interface ParsedEvent {
  uid: string;
  summary: string;
  description: string;
  allDay: boolean;
  /** All-day: DATE "YYYY-MM-DD" strings. */
  startDate: string | null;
  /** All-day: Tide-INCLUSIVE end date (converted from EXCLUSIVE DTEND). */
  endDate: string | null;
  /** Timed: UTC epoch ms. */
  utcStartMs: number | null;
  utcEndMs: number | null;
  /** Timed: IANA zone id (resolved; null = no/unknown zone). */
  tzId: string | null;
  /** Wall times "HH:MM(:SS)" for the timed form. */
  startWall: string | null;
  endWall: string | null;
  rrule: string | null;
  recurrenceId: string | null;
  cancelled: boolean;
  /** §3.3: true for duplicate-UID VEVENTs (first-wins; planner skips). */
  duplicate?: boolean;
}

export interface ParseResult {
  events: ParsedEvent[];
  /** §3.2/§3.1: every ignored/malformed thing, visible. */
  skipped: Array<{ kind: string; detail: string }>;
}

export interface ImportPlan {
  /** Order matters: bases first, then overrides (§4.7). */
  actions: ImportAction[];
}

export type ImportAction =
  | { kind: "create_event"; uid: string; eventId: string; allDay: boolean; title: string; description: string; startMs: number; endMs: number; rrule: string | null }
  | { kind: "update_event"; uid: string; eventId: string; title: string; description: string; startMs: number; endMs: number; allDay: boolean }
  | { kind: "create_series_base"; uid: string; eventId: string; allDay: boolean; title: string; description: string; startMs: number; endMs: number; rrule: string }
  | { kind: "update_series_base"; uid: string; eventId: string; title: string; description: string; startMs: number; endMs: number; allDay: boolean; rrule: string }
  | { kind: "override"; uid: string; seriesId: string | null; eventId: string; recurrenceId: string; cancelled: boolean; title: string | null; startWall: string | null; endWall: string | null }
  | { kind: "skip"; uid: string; reason: string };

export interface ImportReport {
  created: string[];
  updated: string[];
  skipped: Array<{ uid: string; reason: string }>;
  failed: Array<{ uid: string; reason: string }>;
  /** §3.1/§12: every ignored component/property, every lossy decision. */
  notices: string[];
}

// ---------------------------------------------------------------------------
// Bounded parsing helpers (§1.2/§10.2)
// ---------------------------------------------------------------------------

/** §10.2 resource bounds: hostile input cannot blow up the parser. */
const MAX_FILE_BYTES = 8 * 1024 * 1024; // 8 MiB
const MAX_LINES = 200_000;
const MAX_EVENTS = 50_000;

function failHard(reason: string): never {
  throw new Error(`ics import: ${reason}`);
}

// ---------------------------------------------------------------------------
// parseIcs — pure, bounded, tolerant (§3.1–§3.5, §10)
// ---------------------------------------------------------------------------

export function parseIcs(text: string): ParseResult {
  const bytes = new TextEncoder().encode(text).length;
  if (bytes > MAX_FILE_BYTES) failHard(`input too large (${bytes} bytes > ${MAX_FILE_BYTES})`);
  const lines0 = text.split(/\r?\n/);
  if (lines0.length > MAX_LINES) failHard(`too many lines (${lines0.length} > ${MAX_LINES})`);

  const skipped: ParseResult["skipped"] = [];
  if (!/\bBEGIN:VCALENDAR\b/.test(text)) {
    failHard("input is not a VCALENDAR (no BEGIN:VCALENDAR found) — nothing imported");
  }
  if (!/\bBEGIN:VEVENT\b/.test(text)) {
    failHard("VCALENDAR contains no VEVENT components — nothing imported");
  }

  // §10: unfold first (continuation = single leading space/tab).
  const lines: string[] = [];
  for (const raw of lines0) {
    if ((raw.startsWith(" ") || raw.startsWith("\t")) && lines.length > 0) {
      lines[lines.length - 1] += raw.slice(1);
    } else {
      lines.push(raw);
    }
  }

  // Walk components; only VEVENTs inside the (first) VCALENDAR are read.
  const events: ParsedEvent[] = [];
  let inVtimezone = false;
  let current: { props: Array<{ name: string; params: string; value: string }> } | null = null;
  let inForeignComponent = false;
  let foreignName = "";

  for (const line of lines) {
    if (line === "BEGIN:VTIMEZONE") { inVtimezone = true; continue; } // §3.4 D3: advisory only, not parsed
    if (line === "END:VTIMEZONE") { inVtimezone = false; continue; }
    if (inVtimezone) continue;

    if (line.startsWith("BEGIN:")) {
      const comp = line.slice(6).trim().toUpperCase();
      if (comp === "VEVENT" && current === null && !inForeignComponent) {
        if (events.length >= MAX_EVENTS) failHard(`too many VEVENTs (> ${MAX_EVENTS})`);
        current = { props: [] };
      } else if (comp === "VEVENT" && (current !== null || inForeignComponent)) {
        skipped.push({ kind: "VEVENT", detail: "nested or misplaced VEVENT ignored" });
      } else if (comp !== "VCALENDAR") {
        // §3.1: unsupported component (VTODO, VJOURNAL, VFREEBUSY, VALARM…)
        inForeignComponent = true;
        foreignName = comp;
      }
      continue;
    }
    if (line.startsWith("END:")) {
      const comp = line.slice(4).trim().toUpperCase();
      if (comp === "VEVENT" && current !== null) {
        const ev = buildParsedEvent(current.props, skipped);
        if (ev) events.push(ev);
        current = null;
      } else if (inForeignComponent && comp === foreignName) {
        inForeignComponent = false;
      }
      continue;
    }

    // Property line inside whatever component is open.
    const colon = propertyColon(line);
    if (colon < 0) {
      if (line.trim().length > 0) skipped.push({ kind: "line", detail: `unparseable line ignored: ${line.slice(0, 60)}` });
      continue;
    }
    const left = line.slice(0, colon);
    const value = line.slice(colon + 1);
    const semi = left.indexOf(";");
    const name = (semi >= 0 ? left.slice(0, semi) : left).trim().toUpperCase();
    const params = semi >= 0 ? left.slice(semi + 1) : "";
    if (inForeignComponent) {
      if (current === null) skipped.push({ kind: foreignName || "component", detail: `${name} inside unsupported component ignored` });
      continue;
    }
    if (current === null) {
      if (name !== "VERSION" && name !== "PRODID" && name !== "CALSCALE") {
        skipped.push({ kind: "property", detail: `${name} outside a component ignored` });
      }
      continue;
    }
    current.props.push({ name, params, value });
  }

  // §3.3: duplicate UIDs in one file — first wins, rest skipped+reported.
  // IMPORTANT: RECURRENCE-ID override VEVENTs legitimately SHARE their
  // base's UID (RFC 5545) — dedupe applies only to non-override VEVENTs.
  const seen = new Set<string>();
  const deduped: ParsedEvent[] = [];
  for (const e of events) {
    if (e.recurrenceId === null) {
      if (seen.has(e.uid)) {
        deduped.push({ ...e, duplicate: true }); // planner skips + reports
        continue;
      }
      seen.add(e.uid);
    }
    deduped.push(e);
  }
  return { events: deduped, skipped };
}

/** Find the property-value colon (first colon outside a quoted param). */
function propertyColon(line: string): number {
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (c === '"') inQuote = !inQuote;
    else if (c === ":" && !inQuote) return i;
  }
  return -1;
}

/** Build one ParsedEvent from a VEVENT's property list (§3.1 subset). */
function buildParsedEvent(
  props: Array<{ name: string; params: string; value: string }>,
  skipped: ParseResult["skipped"],
): ParsedEvent | null {
  let uid = "";
  let summary = "";
  let description = "";
  let dtstart: { value: string; params: string } | null = null;
  let dtend: { value: string; params: string } | null = null;
  let rrule: string | null = null;
  let recurrenceId: string | null = null;
  let cancelled = false;

  for (const p of props) {
    switch (p.name) {
      case "UID": uid = p.value.trim(); break;
      case "SUMMARY": summary = unescapeText(p.value); break;
      case "DESCRIPTION": description = unescapeText(p.value); break;
      case "DTSTART": dtstart = { value: p.value, params: p.params }; break;
      case "DTEND": dtend = { value: p.value, params: p.params }; break;
      case "RRULE": rrule = p.value.trim(); break;
      case "RECURRENCE-ID": recurrenceId = p.value.trim(); break;
      case "STATUS":
        if (p.value.trim().toUpperCase() === "CANCELLED") cancelled = true;
        break;
      case "SEQUENCE":
      case "DTSTAMP":
        break; // accepted, unused (§3.1)
      default:
        skipped.push({ kind: "property", detail: `${p.name} not supported — ignored` });
    }
  }

  if (!uid) {
    skipped.push({ kind: "VEVENT", detail: "VEVENT without UID ignored" });
    return null;
  }
  if (!dtstart) {
    skipped.push({ kind: "VEVENT", detail: `VEVENT ${uid || "(duplicate)"} without DTSTART ignored` });
    return null;
  }

  // DTSTART/DTEND resolution (§3.4/§3.5).
  const allDay = (dtstart.params.match(/VALUE=DATE(?![T])/i) !== null) || /^\d{8}$/.test(dtstart.value.trim());
  let startDate: string | null = null;
  let endDate: string | null = null;
  let utcStartMs: number | null = null;
  let utcEndMs: number | null = null;
  let tzId: string | null = null;
  let startWall: string | null = null;
  let endWall: string | null = null;

  const tzParam = /TZID=([^;:]+)/i.exec(dtstart.params)?.[1]?.trim() ?? null;

  if (allDay) {
    startDate = dateFromIcs(dtstart.value);
    if (!startDate) {
      skipped.push({ kind: "VEVENT", detail: `VEVENT ${uid} has malformed all-day DTSTART — ignored` });
      return null;
    }
    // §3.5: EXCLUSIVE DTEND -> Tide INCLUSIVE end_date (−1 day).
    endDate = dtend ? inclusiveEndFromExclusive(dateFromIcs(dtend.value)) : startDate;
  } else {
    const knownTz = tzParam !== null && isIANAZoneGuard(tzParam);
    if (tzParam !== null && !knownTz) {
      // D3: visible fallback (report entry; the planner surfaces it too).
      skipped.push({ kind: "timezone", detail: `TZID "${tzParam}" unknown — falling back to UTC` });
    }
    tzId = knownTz ? tzParam : null;
    const s = parseDateTime(dtstart.value, tzId);
    const e = dtend ? parseDateTime(dtend.value, tzId) : null;
    if (s === null) {
      skipped.push({ kind: "VEVENT", detail: `VEVENT ${uid} has malformed DTSTART — ignored` });
      return null;
    }
    utcStartMs = s;
    utcEndMs = e ?? s;
    if (tzId) {
      // Wall times for the Tide timed representation (local date basis is
      // derived at plan time from the UTC instants, mirroring DC-18).
      startWall = wallFromUtc(utcStartMs, tzId);
      endWall = wallFromUtc(utcEndMs!, tzId);
    }
  }

  return {
    uid,
    summary,
    description,
    allDay,
    startDate,
    endDate,
    utcStartMs,
    utcEndMs,
    tzId,
    startWall,
    endWall,
    rrule,
    recurrenceId,
    cancelled,
  };
}

/** "YYYYMMDD" or "YYYY-MM-DD" -> "YYYY-MM-DD"; null on malformed. */
function dateFromIcs(v: string): string | null {
  const m = /^(\d{4})(\d{2})(\d{2})/.exec(v.trim().replace(/-/g, ""));
  if (!m) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

/** §3.5: EXCLUSIVE end DATE -> Tide INCLUSIVE end DATE (subtract a day). */
function inclusiveEndFromExclusive(excl: string | null): string {
  if (!excl) return "";
  const [y, m, d] = excl.split("-").map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1, d!));
  dt.setUTCDate(dt.getUTCDate() - 1);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${dt.getUTCFullYear()}-${p(dt.getUTCMonth() + 1)}-${p(dt.getUTCDate())}`;
}

/**
 * Parse a DATE-TIME value. Forms: UTC "…Z", floating (no TZID -> UTC per
 * §3.4), TZID-qualified (known zone -> resolve via Intl offset correction).
 */
function parseDateTime(v: string, tzId: string | null): number | null {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/.exec(v.trim());
  if (!m) return null;
  const [, Y, Mo, D, H, Mi, S, Z] = m;
  const utcMs = Date.UTC(+Y!, +Mo! - 1, +D!, +H!, +Mi!, S ? +S : 0);
  if (!Number.isFinite(utcMs)) return null;
  if (Z) return utcMs;
  if (!tzId) return utcMs; // floating: UTC (§3.4)
  // Known zone: naive-UTC guess then offset-correct (same math as DC-18).
  const withOffset = zonedEpoch(utcMs, tzId);
  return withOffset;
}

/** Offset-correct a naive-UTC parse against a known IANA zone. */
function zonedEpoch(naiveUtcMs: number, tz: string): number {
  const off1 = tzOffsetMs(naiveUtcMs, tz);
  const corrected = naiveUtcMs - off1;
  const off2 = tzOffsetMs(corrected, tz);
  return off1 === off2 ? corrected : naiveUtcMs - off2;
}

function tzOffsetMs(utcMs: number, tz: string): number {
  try {
    const t = Math.floor(utcMs / 1000) * 1000;
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hour12: false,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).formatToParts(new Date(t));
    const get = (type: string) => Number(parts.find((x) => x.type === type)?.value);
    return Date.UTC(get("year")!, get("month")! - 1, get("day")!, get("hour")! % 24, get("minute")!, get("second")!) - t;
  } catch {
    return NaN;
  }
}

/** Local wall "HH:MM:SS" of a UTC instant in the zone (for Tide columns). */
function wallFromUtc(utcMs: number, tz: string): string {
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hour12: false,
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(utcMs));
  const get = (t: string) => p.find((x) => x.type === t)?.value ?? "00";
  return `${get("hour") === "24" ? "00" : get("hour")}:${get("minute")}:${get("second")}`;
}

/**
 * Inverse of DC-18 escapeText (§T5): single-pass scan so an ESCAPED
 * backslash followed by a special char decodes correctly (blind-review
 * minor: sequential replace mis-decoded `\\n` as backslash+newline).
 */
function unescapeText(v: string): string {
  let out = "";
  for (let i = 0; i < v.length; i++) {
    const c = v[i]!;
    if (c === "\\" && i + 1 < v.length) {
      const n = v[++i]!;
      if (n === "n" || n === "N") out += "\n";
      else if (n === ";" || n === "," || n === "\\") out += n;
      else out += n; // unknown escape: pass the char through
    } else {
      out += c;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// planImport — pure; resolves identity A/B/C/D and recurrence D4 (§4)
// ---------------------------------------------------------------------------

/** Canonical Tide event_id shape: evt-<uuid> (DC-07; D2 keeps it unchanged). */
const TIDE_ID_RE = /^evt-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ExistingIndex {
  /** live event ids */
  liveIds: ReadonlySet<string>;
  /** tombstoned event/series entity ids (never resurrect) */
  tombstonedIds: ReadonlySet<string>;
  /** base_event_id -> series_id (live series) */
  seriesByBase: ReadonlyMap<string, string>;
  /** base_event_id -> tz_id of the live series base (for override walls) */
  tzByBase: ReadonlyMap<string, string>;
}

/** The series' zone for a uid: planned-in-this-file zone or the DB's. */
function tzByBaseOf(existing: ExistingIndex, uid: string): string | null {
  return existing.tzByBase.get(uid) ?? null;
}

/** Wall-clock "HH:MM:SS" -> absolute UTC ms in the given IANA zone, on the
 * local date of `anchorMs` interpreted in `tz`. */
function zonedEpochFromWall(anchorMs: number, wall: string, tz: string): number {
  const localDate = localDateOf(anchorMs, tz);
  return zonedEpochFromParts(localDate, wall, tz);
}

/** zonedEpoch on an explicit date (reuses the DC-18-style offset math). */
function zonedEpochFromParts(dateStr: string, wall: string, tz: string): number {
  const [h, m, s] = wall.split(":").map(Number);
  const naive = Date.parse(`${dateStr}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s ?? 0).padStart(2, "0")}Z`);
  if (!Number.isFinite(naive)) return NaN;
  const off1 = tzOffsetMs(naive, tz);
  const corrected = naive - off1;
  const off2 = tzOffsetMs(corrected, tz);
  return off1 === off2 ? corrected : naive - off2;
}

/** Local date (YYYY-MM-DD) of a UTC instant in the zone. */
function localDateOf(utcMs: number, tz: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    }).formatToParts(new Date(utcMs));
    const get = (t: string) => parts.find((x) => x.type === t)?.value ?? "";
    return `${get("year")}-${get("month")}-${get("day")}`;
  } catch {
    return new Date(utcMs).toISOString().slice(0, 10);
  }
}

/** All-day Tide row -> epoch ms at local midnight (matches event_core). */
function allDayStartMs(dateStr: string): number {
  return new Date(`${dateStr}T00:00:00`).getTime();
}
function allDayEndMs(dateStr: string): number {
  return new Date(`${dateStr}T23:59:59.999`).getTime();
}

/**
 * Build the ImportPlan. PURE: reads only (parsed, existing). The caller
 * (applyImportPlan's host) supplies `existing` from DB reads — the planner
 * itself touches nothing.
 */
export function planImport(
  parsed: ParseResult,
  existing: ExistingIndex,
): { plan: ImportPlan; notices: string[] } {
  const notices: string[] = [];
  const actions: ImportAction[] = [];
  // uid -> eventId assigned in this plan (bases first; overrides reference).
  const uidToEventId = new Map<string, string>();
  // series bases planned (eventId -> series known/created)
  const seriesBaseEventIds = new Set<string>();
  // uid -> {seriesId, ok} for override matching
  const plannedSeries = new Map<string, { seriesId: string | null; eventId: string; tzId: string | null }>();
  const skippedUids = new Set<string>();

  // Pass 1: non-override VEVENTs (bases and plain events), file order.
  for (const e of parsed.events) {
    if (e.recurrenceId !== null) continue; // pass 2
    if (e.duplicate) {
      // §3.3 first-wins: the duplicate itself is planned as an explicit
      // skip so the report counts it (fail-visible).
      actions.push({ kind: "skip", uid: e.uid, reason: "duplicate UID in file — occurrence after the first skipped" });
      continue;
    }
    planSingle(e, false);
  }
  // §3.3 duplicate-UID reporting: the parser flags duplicates (first wins).
  for (const e of parsed.events) {
    if (e.duplicate) {
      notices.push(`duplicate UID "${e.uid}" in file — occurrence after the first skipped`);
    }
  }

  // Pass 2: RECURRENCE-ID overrides. Duplicate (uid, recurrenceId) pairs
  // are deduped first-wins with a visible notice (blind-review minor;
  // RFC 5545 §3.8.4.4 says RECURRENCE-ID must uniquely identify).
  const seenOverrides = new Set<string>();
  for (const e of parsed.events) {
    if (e.recurrenceId === null) continue;
    if (e.duplicate) continue;
    const key = `${e.uid}|${e.recurrenceId}`;
    if (seenOverrides.has(key)) {
      notices.push(`duplicate override for UID "${e.uid}" RECURRENCE-ID ${e.recurrenceId} — occurrence after the first skipped`);
      continue;
    }
    seenOverrides.add(key);
    // The series base may exist in the DB (Case A/B match) or have been
    // planned in pass 1 (create_series_base). For a freshly-planned series
    // the concrete series_id is assigned by the core at apply time — the
    // applier resolves it by baseEventId (seriesId here may be null).
    const base = e.uid ? plannedSeries.get(e.uid) : undefined;
    const basePlanned = base !== undefined || existing.liveIds.has(e.uid);
    if (!basePlanned) {
      actions.push({
        kind: "skip", uid: e.uid,
        reason: `override for UID "${e.uid}" has no importable series base`,
      });
      continue;
    }
    // §4.6: cancelled -> cancelled override; else field override.
    // MAJOR-1 fix (blind review): Z-form override times (DTSTART:…Z, no
    // TZID — Google's typical export) carried only utcStartMs, so startWall
    // was null and the time move was silently dropped. Resolve the wall
    // times for such overrides in the BASE series' zone (existing series)
    // or the override's own UTC (no zone) — and mark the override with its
    // resolved zone so the applier can pass the correct tz context.
    let startWall: string | null = e.startWall;
    let endWall: string | null = e.endWall;
    let overrideTz: string | null = e.tzId;
    if (!e.allDay && startWall === null && e.utcStartMs != null) {
      const baseTz =
        base?.tzId ??
        existing.tzByBase.get(e.uid) ??
        null;
      const zone = baseTz ?? null;
      startWall = wallFromUtc(e.utcStartMs, zone ?? "UTC");
      endWall = wallFromUtc(e.utcEndMs!, zone ?? "UTC");
      overrideTz = zone;
      if (zone === null) {
        notices.push(
          `UID "${e.uid}": override ${e.recurrenceId} has UTC-form times — imported as UTC walls (no zone available)`,
        );
      }
    }
    // MAJOR-2 fix (blind review): an override whose TZID differs from the
    // base's must have its walls RE-EXPRESSED in the base's zone —
    // updateOccurrence interprets start_wall under the series' base tz.
    // Both zones are IANA-known here (unknown ones already fell back to
    // UTC at parse), so we resolve the override's absolute instant from
    // its own zone and re-derive the wall clock in the base's zone.
    if (
      !e.allDay &&
      startWall !== null &&
      e.tzId !== null &&
      base?.tzId !== undefined &&
      base?.tzId !== null &&
      overrideTz !== null &&
      overrideTz !== base.tzId
    ) {
      const absolute = zonedEpochFromWall(e.utcStartMs!, startWall, overrideTz!);
      startWall = wallFromUtc(absolute, base.tzId);
      endWall = wallFromUtc(absolute + (e.utcEndMs! - e.utcStartMs!), base.tzId);
      overrideTz = base.tzId;
      notices.push(
        `UID "${e.uid}": override ${e.recurrenceId} TZID "${e.tzId}" differs from the series zone "${base.tzId}" — times re-expressed in the series zone`,
      );
    }
    actions.push({
      kind: "override",
      uid: e.uid,
      seriesId: base?.seriesId ?? existing.seriesByBase.get(e.uid) ?? null,
      eventId: base?.eventId ?? e.uid,
      recurrenceId: e.recurrenceId,
      cancelled: e.cancelled,
      title: e.summary !== "" ? e.summary : null,
      startWall,
      endWall,
    });
    // NB: the applier resolves a null-ish seriesId for freshly-created
    // series by looking up series by baseEventId AFTER creation (see
    // applyImportPlan override case).
  }

  return { plan: { actions }, notices };

  // ---- inner: plan one non-override VEVENT (cases A–D + D4) ----
  function planSingle(e: ParsedEvent, isDuplicate: boolean): void {
    if (e.uid === "" || skippedUids.has(e.uid)) return;

    // Case D — tombstone: never resurrect.
    if (existing.tombstonedIds.has(e.uid)) {
      actions.push({ kind: "skip", uid: e.uid, reason: "matches a tombstoned (deleted) entity — never resurrected" });
      skippedUids.add(e.uid);
      return;
    }

    const match = existing.liveIds.has(e.uid);
    const canonical = TIDE_ID_RE.test(e.uid);

    // Time basis -> EventCore input (all-day uses local-midnight ms like
    // every other Tide event; timed uses the resolved UTC instants).
    let startMs: number;
    let endMs: number;
    if (e.allDay) {
      startMs = allDayStartMs(e.startDate!);
      endMs = allDayEndMs(e.endDate ?? e.startDate!);
    } else {
      startMs = e.utcStartMs!;
      endMs = e.utcEndMs!;
    }

    // D4: RRULE outside the DC-12 subset -> single event + visible notice.
    let rrule: string | null = null;
    if (e.rrule) {
      try {
        rrule = validateRRule(e.rrule, "import_ics"); // validate ONLY — no weakening
      } catch {
        rrule = null;
        notices.push(
          `UID "${e.uid}": RRULE "${e.rrule}" is outside Tide's supported subset — ` +
            `imported as a NON-RECURRING single event (recurrence simplified/lost)`,
        );
      }
    }

    if (match) {
      // Case A — UPDATE via the normal path. A series base stays a series
      // base; a plain event stays plain. Rule changes ride
      // update_series_rule (its own DC-12 conflict entity).
      const seriesId = existing.seriesByBase.get(e.uid);
      if (rrule !== null || seriesId !== undefined) {
        if (seriesId === undefined) {
          actions.push({ kind: "skip", uid: e.uid, reason: "existing event is a plain event but file has an RRULE — mixed identity not supported in v1" });
          skippedUids.add(e.uid);
          return;
        }
        plannedSeries.set(e.uid, { seriesId, eventId: e.uid, tzId: tzByBaseOf(existing, e.uid) });
        seriesBaseEventIds.add(e.uid);
        uidToEventId.set(e.uid, e.uid);
        actions.push({
          kind: "update_series_base", uid: e.uid, eventId: e.uid,
          title: e.summary, description: e.description,
          startMs, endMs, allDay: e.allDay, rrule: rrule ?? "",
        });
        return;
      }
      uidToEventId.set(e.uid, e.uid);
      actions.push({
        kind: "update_event", uid: e.uid, eventId: e.uid,
        title: e.summary, description: e.description,
        startMs, endMs, allDay: e.allDay,
      });
      return;
    }

    // Case B/C — CREATE. B keeps the canonical UID as the Tide id; C mints
    // a fresh one and drops the foreign UID (never persisted, D2).
    const eventId = canonical ? e.uid : `evt-${randomUUID()}`;
    if (!canonical) {
      notices.push(`UID "${e.uid}" is a foreign id — imported with a fresh Tide event_id (foreign UID not persisted; re-importing this file will duplicate it)`);
    }
    uidToEventId.set(e.uid, eventId);

    if (rrule !== null) {
      // The freshly-created series' zone = the base VEVENT's resolved zone.
      plannedSeries.set(e.uid, { seriesId: null, eventId, tzId: e.tzId }); // series id assigned at apply time
      actions.push({
        kind: "create_series_base", uid: e.uid, eventId,
        allDay: e.allDay, title: e.summary, description: e.description,
        startMs, endMs, rrule,
      });
      return;
    }
    actions.push({
      kind: "create_event", uid: e.uid, eventId,
      allDay: e.allDay, title: e.summary, description: e.description,
      startMs, endMs, rrule: null,
    });
  }
}

// ---------------------------------------------------------------------------
// applyImportPlan — the ONLY writer (EventCore methods exclusively, §5)
// ---------------------------------------------------------------------------

/**
 * Caller-side helper (DB reads, like DC-18's buildExportInput): snapshot the
 * existing-identity index the planner needs — live ids, tombstoned ids
 * (deleted entities; never resurrect), and series-by-base. Tombstone
 * detection covers BOTH representations: the entities_tombstones table
 * (sync/full-state path) and the latest `remove` change record (the local
 * delete path — deleteEvent writes operation='remove', DC-01).
 */
export function buildExistingIndex(core: EventCore): ExistingIndex {
  const liveIds = new Set<string>();
  for (const e of core.listEvents()) liveIds.add(e.id);
  const tombstonedIds = new Set<string>(
    core.db
      .prepare<[], { entity_id: string }>(
        "SELECT DISTINCT entity_id FROM entities_tombstones WHERE entity_type IN ('event','series')",
      )
      .all()
      .map((r) => r.entity_id),
  );
  // Local deletes: an entity whose LATEST change record is operation='remove'
  // is deleted (a later 'set' would mean it is live again).
  const history = core.db
    .prepare<[], { entity_id: string; operation: string }>(
      `SELECT entity_id, operation FROM changes
       WHERE entity_type IN ('event','series')
       ORDER BY hlc_timestamp ASC`,
    )
    .all();
  const lastOp = new Map<string, string>();
  for (const row of history) lastOp.set(row.entity_id, row.operation);
  for (const [entityId, op] of lastOp) {
    if (op === "remove") {
      tombstonedIds.add(entityId);
      liveIds.delete(entityId);
    }
  }
  const seriesByBase = new Map<string, string>(
    core.listSeries().map((s) => [s.baseEventId, s.seriesId]),
  );
  // Series base zones (DC-07 events.tz_id) — for override wall resolution.
  const tzRows = core.db
    .prepare<[], { event_id: string; tz_id: string | null }>(
      "SELECT event_id, tz_id FROM events WHERE event_id IN (SELECT base_event_id FROM series)",
    )
    .all();
  const tzByBase = new Map<string, string>();
  for (const row of tzRows) {
    if (row.tz_id) tzByBase.set(row.event_id, row.tz_id);
  }
  return { liveIds, tombstonedIds, seriesByBase, tzByBase };
}

export function applyImportPlan(core: EventCore, plan: ImportPlan): ImportReport {
  const report: ImportReport = { created: [], updated: [], skipped: [], failed: [], notices: [] };
  for (const a of plan.actions) {
    try {
      switch (a.kind) {
        case "skip": {
          report.skipped.push({ uid: a.uid, reason: a.reason });
          break;
        }
        case "create_event": {
          // Case B (canonical id): createEventWithId preserves the Tide UID
          // as identity (round-trip §5). Case C (foreign UID): createEvent
          // mints a fresh core-owned id; the foreign UID is never persisted.
          const isCanonical = /^evt-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(a.eventId);
          if (isCanonical) {
            core.createEventWithId(a.eventId, {
              title: a.title, description: a.description,
              startMs: a.startMs, endMs: a.endMs, allDay: a.allDay,
            });
          } else {
            core.createEvent({
              title: a.title, description: a.description,
              startMs: a.startMs, endMs: a.endMs, allDay: a.allDay,
            });
          }
          report.created.push(a.uid);
          break;
        }
        case "update_event": {
          core.updateEvent(a.eventId, {
            title: a.title, description: a.description,
            startMs: a.startMs, endMs: a.endMs, allDay: a.allDay,
          });
          report.updated.push(a.uid);
          break;
        }
        case "create_series_base": {
          const isCanonical = /^evt-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(a.eventId);
          const input = {
            title: a.title, description: a.description,
            startMs: a.startMs, endMs: a.endMs, allDay: a.allDay,
            recurrenceRule: a.rrule,
          };
          if (isCanonical) {
            core.createEventWithId(a.eventId, input); // Case B: id preserved
          } else {
            core.createEvent(input); // Case C: fresh id
          }
          report.created.push(a.uid);
          break;
        }
        case "update_series_base": {
          core.updateEvent(a.eventId, {
            title: a.title, description: a.description,
            startMs: a.startMs, endMs: a.endMs, allDay: a.allDay,
          });
          // rrule === "" means the file's rule was absent or unsupported
          // (D4) — KEEP the existing series rule (never write an empty
          // rule; updateSeriesRule would throw and mislabel the entity
          // as failed although the base update committed). Blind-review
          // minor fix: visible via plan-time notice, applied as updated.
          if (a.rrule !== "") {
            const series = core.listSeries().find((s) => s.baseEventId === a.eventId);
            if (series && series.recurrenceRule !== a.rrule) {
              core.updateSeriesRule(series.seriesId, a.rrule);
            }
          }
          report.updated.push(a.uid);
          break;
        }
        case "override": {
          // For freshly-created series the planner had no seriesId yet —
          // resolve it NOW by baseEventId (the base was created earlier in
          // this same apply pass, §4.7 ordering guarantees that).
          const seriesId = a.seriesId
            ?? core.listSeries().find((s) => s.baseEventId === a.eventId)?.seriesId;
          if (!seriesId) {
            throw new Error(`override: no series found for base ${a.eventId}`);
          }
          core.updateOccurrence(seriesId, a.recurrenceId, {
            ...(a.cancelled ? { cancelled: true } : {}),
            ...(a.title !== null ? { title: a.title } : {}),
            ...(a.startWall !== null ? { start_wall: a.startWall } : {}),
            ...(a.endWall !== null ? { end_wall: a.endWall } : {}),
          });
          report.updated.push(a.uid); // overrides are edits to a live series
          break;
        }
      }
    } catch (err) {
      // §5.2: report + continue (per-entity atomicity, no rollback).
      report.failed.push({ uid: a.uid, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  return report;
}
