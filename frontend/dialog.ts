// Tide event create/edit/delete dialog (native <dialog>, minimal styling).
//
// UX model (per owner feedback, 2026-08-26): one Day + a "Whole day" toggle;
// when not whole-day, Start/End *times* within that day. This mirrors how
// people think about appointments (day → duration) instead of two raw
// datetime ranges. Internally everything still maps to startMs/endMs so the
// domain core / DC-07 payload shapes are untouched.
import {
  createEvent,
  deleteEvent,
  updateEvent,
  updateOccurrence,
  updateSeriesRule,
  listSeries,
  listEvents,
  getReminder,
  setReminder,
  clearReminder,
  type CalendarEvent,
  type EventInput,
  type SeriesRow,
} from "./store.ts";
import { getSelectedDate } from "./calendar.ts";
import { dialogRecurrenceLine, describeRule } from "./recurrence.ts";
import {
  buildRRule,
  draftFromRule,
  deriveRecurrenceId,
  terminateRuleAt,
  wallStamp,
} from "./recurrence_edit.ts";
import { formatTimeLabel, getTimeFormat } from "./theme.ts";
import { occurrenceOf } from "./calendar.ts";

const dlg = () => document.getElementById("event-dialog") as HTMLDialogElement;

function field<T extends HTMLElement>(id: string): T {
  return dlg().querySelector(`#${id}`) as T;
}

/**
 * In-app inline error line (replaces native alert() popups — owner flagged
 * the WebKit "javascript - HTTP URL" chrome as unacceptable). Shows above
 * the dialog footer; cleared on the next open/save.
 */
function showInlineError(msg: string): void {
  removeInlineErrorEl();
  const div = document.createElement("div");
  div.className = "dialog-error";
  div.setAttribute("role", "alert");
  div.textContent = msg;
  const menu = dlg().querySelector("menu");
  menu?.parentElement?.insertBefore(div, menu);
}

function removeInlineErrorEl(): void {
  // Tolerant removal: minimal test DOM stubs return node-like objects
  // without .remove(), and this must be a no-op there.
  const e = dlg().querySelector(".dialog-error") as
    | { remove?: () => void }
    | null;
  if (e && typeof e.remove === "function") e.remove();
}

function clearInlineError(): void {
  removeInlineErrorEl();
}

/**
 * Two-step inline destructive confirmation for Delete (same pattern as the
 * Sync-Errors "Discard" flow): first click arms ("Confirm delete?" + warning
 * line), second click executes; reverts after a timeout or Cancel.
 */
function armDeleteConfirm(
  btn: HTMLButtonElement,
  onConfirmed: () => void,
): void {
  if (btn.dataset.armed === "1") {
    btn.dataset.armed = "";
    clearDeleteArm(btn);
    onConfirmed();
    return;
  }
  btn.dataset.armed = "1";
  btn.textContent = "Confirm delete?";
  const warn = document.createElement("span");
  warn.className = "delete-warning";
  warn.textContent = "This event will be permanently deleted on this device.";
  btn.after(warn);
  btn.dataset.revertTimer = window.setTimeout(() => clearDeleteArm(btn), 8000).toString();
}

function clearDeleteArm(btn: HTMLButtonElement): void {
  btn.dataset.armed = "";
  if (btn.dataset.revertTimer) {
    clearTimeout(Number(btn.dataset.revertTimer));
    btn.dataset.revertTimer = "";
  }
  btn.textContent = "Delete";
  const warns = btn.parentElement?.querySelectorAll(".delete-warning") ?? [];
  for (const w of warns) {
    if (typeof (w as { remove?: () => void }).remove === "function")
      (w as HTMLElement).remove();
  }
}

const pad = (n: number): string => String(n).padStart(2, "0");

/** Local YYYY-MM-DD for an epoch-ms instant. */
function toDateInput(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Local HH:MM for an epoch-ms instant. */
function toTimeInput(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Normalize free-typed time text to strict "HH:MM" (24h). Accepts the forms
 * users actually type: "9", "9:5" (-> 09:05), "0930", "9.30", "9h30",
 * "9:30pm" (12h suffix). Returns null when unparsable or out of range —
 * readInput surfaces a friendly inline error instead of a broken date parse.
 */
export function normalizeTime(raw: string): string | null {
  const s = String(raw).trim().toLowerCase().replace(/\s+/g, "");
  if (!s) return null;
  const pm = /(?:pm|p\.m\.?)$/.test(s);
  const am = /(?:am|a\.m\.?)$/.test(s);
  const body = s.replace(/^(?:at)?/, "").replace(/(?:am|pm|a\.m\.?|p\.m\.?)$/, "");
  const m = body.match(/^(\d{1,2})(?:[:.h]?(\d{1,2}))?$/);
  if (!m) return null;
  let h = Number(m[1]);
  const min = m[2] !== undefined ? Number(m[2]) : 0;
  if (pm && h < 12) h += 12;
  if (am && h === 12) h = 0;
  if (h > 23 || min > 59) return null;
  return `${pad(h)}:${pad(min)}`;
}

/** Epoch ms from a local YYYY-MM-DD date and optional HH:MM time. */
function localMs(date: string, time: string): number {
  return new Date(`${date}T${time || "00:00"}:00`).getTime();
}

function wholeDay(): boolean {
  return (field("ev-allday") as HTMLInputElement).checked;
}

/**
 * The series the currently edited event belongs to (null: single event or
 * new event). Populated by syncRecurrenceLine's listSeries lookup; drives
 * the rule builder prefill and the occurrence-scope selector (DC-12).
 */
let currentSeries: SeriesRow | null = null;

/** The event currently being edited (null: create flow). */
let dialogEvent: CalendarEvent | undefined;

/**
 * TD-015 (DC-12 R2): the ORIGINAL recurrence_id of the occurrence the dialog
 * was opened on, when that event is a rendered series chip. expandSeriesEvents
 * attaches the authoritative id (occurrenceOf) — keyed at the occurrence's
 * ORIGINAL start, never the override's moved start. Null for plain events and
 * series bases; callers fall back to deriveRecurrenceId(dialogEvent.startMs).
 */
let dialogOccurrenceId: string | null = null;

/**
 * READ-ONLY recurrence info line (DC-12 §2 / deferred #12 surface): when the
 * edited event is a series' base event, state the rule in plain language and
 * make the THIS-occurrence-vs-SERIES distinction visible. Also drives the
 * rule-builder prefill + the Apply-to scope selector. Best-effort: failures
 * simply leave the line hidden and the builder in its default state.
 */
function syncRecurrenceLine(existing?: CalendarEvent): void {
  currentSeries = null;
  const line = document.getElementById("ev-recurrence-info");
  if (line) {
    line.hidden = true;
    line.textContent = "";
  }
  if (!existing) return;
  listSeries()
    .then((rows) => {
      const info = rows.find((r) => r.baseEventId === existing.id);
      if (!info) return;
      currentSeries = info;
      if (line) {
        line.textContent = dialogRecurrenceLine({
          seriesId: info.seriesId,
          baseEventId: info.baseEventId,
          rule: info.recurrenceRule,
          overrides: info.overrides,
        });
        line.hidden = false;
      }
      syncRecurrenceControls(existing);
    })
    .catch((e) => console.warn("[tide] series lookup unavailable:", e));
}

// ---------------------------------------------------------------------------
// DC-12: recurrence rule builder + occurrence-scope controls
// ---------------------------------------------------------------------------

/** Current builder draft as stored in the dialog controls. */
function readDraft(): {
  freq: "NONE" | "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";
  interval: number;
  byDay: string[];
  until: string | null;
} {
  const freq = (field<HTMLSelectElement>("ev-repeat").value || "NONE") as
    | "NONE"
    | "DAILY"
    | "WEEKLY"
    | "MONTHLY"
    | "YEARLY";
  const n = Number(field<HTMLInputElement>("ev-every").value);
  const interval = Number.isInteger(n) && n >= 1 ? Math.min(n, 999) : 1;
  const byDay = Array.from(
    dlg().querySelectorAll<HTMLButtonElement>(".byday-toggle.picked"),
  ).map((b) => b.dataset.day!);
  const until = field<HTMLInputElement>("ev-until").value || null;
  return { freq, interval, byDay, until };
}

/**
 * OPT-IN builder (owner feedback, 2026-08-31): the rule builder is shown
 * only when the "Repeat" checkbox (next to "Whole day") is checked.
 */
function repeatOn(): boolean {
  return (field<HTMLInputElement>("ev-repeat-on") as HTMLInputElement).checked;
}

/** Reset the builder draft to "does not repeat" (unchecked / fresh open). */
function clearRuleDraft(): void {
  field<HTMLSelectElement>("ev-repeat").value = "NONE";
  field<HTMLInputElement>("ev-every").value = "1";
  field<HTMLInputElement>("ev-until").value = "";
  for (const btn of dlg().querySelectorAll<HTMLButtonElement>(".byday-toggle")) {
    btn.classList.remove("picked");
  }
}

/** RRULE built from the dialog controls; null = does not repeat. */
function builderRule(): string | null {
  const d = readDraft();
  const dayStr = field<HTMLInputElement>("ev-date").value;
  const base = dayStr ? new Date(`${dayStr}T00:00:00`) : new Date();
  return buildRRule(d, base);
}

/** Show/hide the builder + interval/weekday/Until pickers for the current draft. */
function syncRepeatVisibility(): void {
  const on = repeatOn();
  field<HTMLDivElement>("ev-rule-builder").hidden = !on;
  const freq = readDraft().freq;
  field<HTMLDivElement>("ev-every-wrap").hidden = freq === "NONE";
  field<HTMLDivElement>("ev-until-wrap").hidden = freq === "NONE";
  field<HTMLDivElement>("ev-byday-row").hidden = freq !== "WEEKLY";
  const preview = document.getElementById("ev-rule-preview");
  if (!preview) return;
  if (!on || freq === "NONE") {
    preview.hidden = true;
    preview.textContent = "";
    return;
  }
  const rule = builderRule();
  preview.textContent = rule ? describeRule(rule) : "";
  preview.hidden = !rule;
}

/**
 * Prefill the builder from the edited event's series (draftFromRule null =
 * rule outside the builder subset → builder is disabled and the raw rule is
 * preserved verbatim on save; never misrepresented, never rewritten).
 */
function syncRecurrenceControls(existing: CalendarEvent): void {
  const repeatSel = field<HTMLSelectElement>("ev-repeat");
  const repeatBox = field<HTMLInputElement>("ev-repeat-on");
  const everyWrap = field<HTMLDivElement>("ev-every-wrap");
  const bydayRow = field<HTMLDivElement>("ev-byday-row");
  const scopeRow = field<HTMLDivElement>("ev-scope-row");
  if (!currentSeries) {
    // New / non-series event: builder stays hidden until "Repeat" is ticked.
    repeatSel.disabled = false;
    everyWrap.hidden = true;
    bydayRow.hidden = true;
    scopeRow.hidden = true;
    syncRepeatVisibility();
    return;
  }
  // Editing a series base event: the builder shows CHECKED (it IS a series)
  // and prefills from the stored rule.
  repeatBox.checked = true;
  scopeRow.hidden = false;
  field<HTMLSelectElement>("ev-scope").value = "series";
  const draft = draftFromRule(currentSeries.recurrenceRule);
  if (!draft) {
    // Exotic rule: keep the builder out of the way; rule stays verbatim.
    repeatSel.disabled = true;
    repeatSel.value = "NONE";
    everyWrap.hidden = true;
    bydayRow.hidden = true;
    syncRepeatVisibility();
    return;
  }
  repeatSel.disabled = false;
  // "Does not repeat" inside a checked builder would be a rule edit — the
  // series ENDING is handled by the TD-016 owner semantics on Save: Repeat
  // unchecked + Save terminates the rule at the edited occurrence (UNTIL),
  // keeping past occurrences and the edited occurrence (never a delete).
  repeatSel.querySelector<HTMLOptionElement>('option[value="NONE"]')!.disabled = true;
  repeatSel.value = draft.freq;
  field<HTMLInputElement>("ev-every").value = String(draft.interval);
  // Older series may predate the mandatory UNTIL (null): the Until field
  // starts empty and Save asks for an end date before writing.
  field<HTMLInputElement>("ev-until").value = draft.until ?? "";
  for (const btn of dlg().querySelectorAll<HTMLButtonElement>(".byday-toggle")) {
    btn.classList.toggle("picked", draft.byDay.includes(btn.dataset.day!));
  }
  void existing;
  syncRepeatVisibility();
}

/** True when the Save should write an occurrence override ("this occurrence"). */
function occurrenceScope(): boolean {
  return (
    currentSeries !== null &&
    field<HTMLSelectElement>("ev-scope").value === "occurrence"
  );
}

function syncTimeVisibility(): void {
  const row = field<HTMLDivElement>("ev-time-row");
  row.style.display = wholeDay() ? "none" : "";
  syncAmPmToggles();
}

/**
 * 12h-mode AM/PM toggles (owner design, 2026-08-31): in 12h mode each time
 * field gets a click-to-flip AM/PM button; the native input's own AM/PM
 * suffix is suppressed and the dropdown lists only the selected half. In
 * 24h mode the buttons are hidden entirely. The input's value stays the
 * internal 24h "HH:MM" — only the visible half-cycle changes.
 */
function syncAmPmToggles(): void {
  const twelve = getTimeFormat() === "12h";
  for (const btn of dlg().querySelectorAll<HTMLButtonElement>(".ampm-toggle")) {
    btn.hidden = !twelve || wholeDay();
    if (twelve) syncAmPmLabel(btn);
  }
}

/** Reflect (and flip) the half-cycle of one field's current 24h value. */
function syncAmPmLabel(btn: HTMLButtonElement): void {
  const inp = field<HTMLInputElement>(btn.dataset.for!);
  const h = Number(inp.value.split(":")[0]);
  const isPm = Number.isFinite(h) ? h >= 12 : false;
  btn.textContent = isPm ? "PM" : "AM";
}

function flipAmPm(btn: HTMLButtonElement): void {
  const inp = field<HTMLInputElement>(btn.dataset.for!);
  const parts = inp.value.split(":");
  const h = Number(parts[0]);
  if (!Number.isFinite(h) || !inp.value) return;
  const nh = h >= 12 ? h - 12 : h + 12;
  parts[0] = pad(nh);
  inp.value = parts.join(":");
  syncAmPmToggles();
}

function commitDateField(): void {
  field<HTMLInputElement>("ev-date").blur();
}

/**
 * DC-12 owner bug: the Until (end date) picker must behave like the Day
 * picker — WebKit's date popover only closes on blur, so auto-blur on change
 * closes it; the Done button stays available while the picker is open.
 */
function commitUntilField(): void {
  field<HTMLInputElement>("ev-until").blur();
}

/**
 * Outlook-style dropdown: 15-minute slots (00:00–23:45) as buttons that set
 * the paired <input type="time">. Complements free typing rather than
 * replacing it — the native time input stays editable. Slot strings are
 * always the internal 24h "HH:MM" (that's what lands in the input's value,
 * which the DOM keeps in 24h regardless of display format); the visible
 * label is rendered in the user's chosen clock style (General options).
 */
const TIME_SLOTS: string[] = Array.from(
  { length: 24 * 4 },
  (_, i) => `${pad(Math.floor(i / 4))}:${pad((i % 4) * 15)}`,
);

function openTimeMenu(inputId: string): void {
  const inp = field<HTMLInputElement>(inputId);
  const fmt = getTimeFormat();
  // 12h mode: list only the selected half-cycle (owner design: the AM/PM
  // button picks the half, the dropdown lists its times). Comparisons stay
  // on the internal 24h strings so End-field filtering is clock-independent.
  const twelve = fmt === "12h";
  const currentH = Number(inp.value.split(":")[0]);
  const halfFloor =
    twelve && Number.isFinite(currentH)
      ? currentH >= 12
        ? 12
        : 0
      : null;
  document.getElementById("time-menu")?.remove();
  const menu = document.createElement("div");
  menu.id = "time-menu";
  const wrap = inp.closest(".time-wrap")!;
  const rect = wrap.getBoundingClientRect();
  const dlgRect = dlg().getBoundingClientRect();
  // Position relative to the dialog so the dialog's own stacking/overflow
  // rules apply; menu opens below the field, capped to dialog height.
  menu.style.top = `${rect.bottom - dlgRect.top}px`;
  menu.style.left = `${rect.left - dlgRect.left}px`;
  for (const slot of TIME_SLOTS) {
    if (halfFloor !== null) {
      const sh = Math.floor(Number(slot.split(":")[0]));
      if (sh < halfFloor || sh >= halfFloor + 12) continue;
    }
    const opt = document.createElement("button");
    opt.type = "button";
    opt.className = "time-option" + (inp.value === slot ? " picked" : "");
    opt.textContent = formatTimeLabel(slot, fmt);
    // Comparisons use the internal 24h strings on both sides, so this
    // filter is clock-style independent.
    opt.dataset.value = slot;
    // For the End field, slots earlier than Start are omitted entirely
    // (owner preference: disappear rather than appear disabled).
    if (inputId === "ev-end-t") {
      const startVal = field<HTMLInputElement>("ev-start-t").value;
      if (startVal && slot <= startVal) continue;
    }
    opt.addEventListener("click", () => {
      inp.value = slot;
      menu.remove();
    });
    menu.appendChild(opt);
  }
  dlg().appendChild(menu);
  // Owner feedback (2026-09-04): the menu must open scrolled to the TOP —
  // the old scrollIntoView(center on picked) jumped deep into the list,
  // which reads as "the early times are missing". The picked entry stays
  // highlighted; the user simply starts browsing from 00:00.
  menu.scrollTop = 0;
}

function closeTimeMenus(): void {
  document.getElementById("time-menu")?.remove();
}

function openFor(date: Date, existing?: CalendarEvent): void {
  const d = new Date(date);
  clearInlineError();
  dialogEvent = existing;
  currentSeries = null;
  // TD-015: capture the chip's ORIGINAL occurrence id (see variable doc).
  // The chip object is replaced on every re-render, so this must be captured
  // at open time — the Save handler can no longer reach the WeakMap.
  dialogOccurrenceId = existing ? (occurrenceOf(existing)?.recurrenceId ?? null) : null;

  field<HTMLInputElement>("ev-id").value = existing?.id ?? "";
  field<HTMLInputElement>("ev-title").value = existing?.title ?? "";
  field<HTMLTextAreaElement>("ev-desc").value = existing?.description ?? "";

  if (existing) {
    // Split the stored epoch-ms instants back into day + times.
    field<HTMLInputElement>("ev-date").value = toDateInput(existing.startMs);
    const allDay = existing.allDay;
    field<HTMLInputElement>("ev-allday").checked = allDay;
    field<HTMLInputElement>("ev-start-t").value = toTimeInput(existing.startMs);
    // End may fall on the next day; show its wall-clock end only when it's
    // same-day (multi-day timed events are rare — TODO(ui) multi-day spans).
    const sameDay =
      toDateInput(existing.endMs) === toDateInput(existing.startMs);
    field<HTMLInputElement>("ev-end-t").value = sameDay
      ? toTimeInput(existing.endMs)
      : "23:59";
  } else {
    d.setHours(9, 0, 0, 0);
    field<HTMLInputElement>("ev-date").value = toDateInput(d.getTime());
    field<HTMLInputElement>("ev-allday").checked = false;
    field<HTMLInputElement>("ev-start-t").value = "09:00";
    field<HTMLInputElement>("ev-end-t").value = "10:00";
  }

  (dlg().querySelector("#dialog-title") as HTMLElement).textContent = existing
    ? "Edit event"
    : "New event";
  // DC-12 controls: reset the builder (OPT-IN: unchecked + draft cleared) +
  // scope BEFORE the series lookup may re-prefill them (listSeries is async).
  field<HTMLInputElement>("ev-repeat-on").checked = false;
  const repeatSel = field<HTMLSelectElement>("ev-repeat");
  repeatSel.disabled = false;
  const noneOpt = repeatSel.querySelector<HTMLOptionElement>('option[value="NONE"]');
  if (noneOpt) noneOpt.disabled = false;
  clearRuleDraft();
  syncRepeatVisibility();
  field<HTMLDivElement>("ev-scope-row").hidden = true;
  syncRecurrenceLine(existing);
  (dlg().querySelector("#ev-delete") as HTMLButtonElement).hidden =
    !existing;
  syncTimeVisibility();
  // DC-22: prefill the "Remind me" checkbox from the event's reminder member
  // (async — the checkbox shows the no-reminder state until the lookup lands;
  // Save writes whatever the checkbox shows at click time).
  field<HTMLInputElement>("ev-remind-on").checked = false;
  field<HTMLSelectElement>("ev-remind-minutes").value = "15";
  if (existing) {
    void getReminder(existing.id)
      .then((rem) => {
        if (rem && rem.enabled) {
          field<HTMLInputElement>("ev-remind-on").checked = true;
          field<HTMLSelectElement>("ev-remind-minutes").value = String(rem.minutesBefore);
        }
      })
      .catch((e) => console.warn("[tide] reminder lookup unavailable:", e));
  }
  dlg().showModal();
}

/**
 * Whole-day -> [00:00, next-day 00:00) so the grid paints it on exactly one
 * cell without clamping artifacts. Timed events use the chosen start/end
 * times; a cross-midnight or missing End falls back to start + 1h.
 */
function readInput(): EventInput | null {
  const title = field<HTMLInputElement>("ev-title").value.trim();
  const day = field<HTMLInputElement>("ev-date").value;
  if (!title) {
    field<HTMLInputElement>("ev-title").focus();
    return null;
  }
  if (!day) {
    field<HTMLInputElement>("ev-date").focus();
    return null;
  }

  let startMs: number;
  let endMs: number;

  if (wholeDay()) {
    startMs = localMs(day, "00:00");
    endMs = startMs + 86_400_000;
  } else {
    // Text time inputs (free-typed): normalize + validate BEFORE parsing.
    // An unparsable entry shows the friendly inline error and focuses the
    // field — never a NaN instant (the old native input guaranteed form, the
    // text replacement re-introduces typing, so the guarantee moves here).
    const sRaw = field<HTMLInputElement>("ev-start-t").value;
    const eRaw = field<HTMLInputElement>("ev-end-t").value;
    const s = normalizeTime(sRaw);
    if (s === null) {
      field<HTMLInputElement>("ev-start-t").focus();
      showInlineError("Start time must be a valid 24h time (HH:MM, e.g. 09:15).");
      return null;
    }
    field<HTMLInputElement>("ev-start-t").value = s;
    let e = eRaw.trim() ? normalizeTime(eRaw) : null;
    if (eRaw.trim() && e === null) {
      field<HTMLInputElement>("ev-end-t").focus();
      showInlineError("End time must be a valid 24h time (HH:MM, e.g. 10:00).");
      return null;
    }
    startMs = localMs(day, s);
    if (!e || e <= s) e = "10:00";
    field<HTMLInputElement>("ev-end-t").value = e;
    endMs = localMs(day, e);
    if (endMs <= startMs) endMs = startMs + 3_600_000;
  }
  return {
    title,
    description: field<HTMLTextAreaElement>("ev-desc").value.trim(),
    startMs,
    endMs,
    allDay: wholeDay(),
  };
}

export function initDialog(): void {
  // New-event button: uses the currently selected day.
  document.getElementById("btn-new")?.addEventListener("click", () => {
    openFor(getSelectedDate());
  });

  // Edit dialog: fired on event DOUBLE-click only (calendar.ts). Single click
  // selects (tide:eventselect) per the owner UX rule.
  document.addEventListener("tide:eventclick", (e) => {
    openFor(new Date(), (e as CustomEvent<CalendarEvent>).detail);
  });

  // Week view: double-click an empty hour band -> new event pre-seeded with
  // that day+hour. Single click just selects/highlights (see calendar.ts).
  document.addEventListener("tide:neweventat", (e) => {
    const d = new Date(
      (e as CustomEvent<string>).detail,
    );
    openFor(d);
  });

  field("ev-allday").addEventListener("change", syncTimeVisibility);

  // DC-12 rule builder: freq select, interval, weekday toggles.
  field("ev-repeat").addEventListener("change", syncRepeatVisibility);
  field("ev-every").addEventListener("input", syncRepeatVisibility);
  // OPT-IN builder (owner feedback, 2026-08-31): the "Repeat" checkbox next
  // to "Whole day" reveals the rule builder. Unchecking hides it and CLEARS
  // the draft rule; on Save with Repeat unchecked, a series event ENDS its
  // recurrence at the edited occurrence (TD-016 owner semantics, 2026-09-02)
  // — the rule is terminated via UNTIL, nothing is deleted.
  field("ev-repeat-on").addEventListener("change", () => {
    if (!repeatOn()) clearRuleDraft();
    syncRepeatVisibility();
  });
  // Mandatory end date: editing it refreshes the live preview.
  field("ev-until").addEventListener("input", syncRepeatVisibility);
  field("ev-until").addEventListener("change", syncRepeatVisibility);
  for (const btn of Array.from(
    dlg().querySelectorAll<HTMLButtonElement>(".byday-toggle"),
  )) {
    btn.addEventListener("click", () => {
      btn.classList.toggle("picked");
      syncRepeatVisibility();
    });
  }

  // Date picker: WebKit's popover only closes on blur; Enter/ESC inside it
  // are swallowed by the popover itself. Auto-blur on change closes the
  // popover in the normal case (owner 2026-09-03 removed the old "Done"
  // escape hatch — it appeared uselessly whenever the picker was open).
  field("ev-date").addEventListener("focus", () => dlg().classList.add("date-picking"));
  field("ev-date").addEventListener("blur", () => dlg().classList.remove("date-picking"));
  field("ev-date").addEventListener("change", () => {
    commitDateField();
    dlg().classList.remove("date-picking");
  });

  // Until picker: same WebKitGTK treatment as the Day picker (owner bug —
  // the popover stayed open after picking an end date). Auto-blur on change
  // closes it.
  field("ev-until").addEventListener("focus", () => dlg().classList.add("until-picking"));
  field("ev-until").addEventListener("blur", () => dlg().classList.remove("until-picking"));
  field("ev-until").addEventListener("change", () => {
    syncRepeatVisibility();
    commitUntilField();
    dlg().classList.remove("until-picking");
  });

  // Time fields: free typing in the native input OR the ▾ 15-min dropdown.
  // 12h mode: the AM/PM toggle flips the field's half-cycle in place.
  for (const btn of Array.from(
    dlg().querySelectorAll<HTMLButtonElement>(".ampm-toggle"),
  )) {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      flipAmPm(btn);
    });
  }
  for (const btn of Array.from(
    dlg().querySelectorAll<HTMLButtonElement>(".time-arrow"),
  )) {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const existing = document.getElementById("time-menu");
      if (existing) {
        existing.remove();
        return;
      }
      openTimeMenu(btn.dataset.for!);
    });
  }
  dlg().addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    if (!t.closest("#time-menu") && !t.closest(".time-arrow")) closeTimeMenus();
  });

  document
    .getElementById("ev-save")
    ?.addEventListener("click", async () => {
      const input = readInput();
      if (!input) return;
      const id = field<HTMLInputElement>("ev-id").value;
      const existing = dialogEvent;
      // Mandatory end date (owner decision, 2026-08-31): every built rule
      // carries UNTIL. Friendly inline validation before any write; the
      // picked date is INCLUSIVE (last occurrence) and must be on or after
      // the event's own day (buildRRule enforces the same, defensively).
      if (repeatOn() && readDraft().freq !== "NONE") {
        const until = field<HTMLInputElement>("ev-until").value;
        const day = field<HTMLInputElement>("ev-date").value;
        if (!until) {
          showInlineError("Choose an end date (Until) for the repeating event.");
          field<HTMLInputElement>("ev-until").focus();
          return;
        }
        if (day && until < day) {
          showInlineError("The end date must be on or after the event's own day.");
          field<HTMLInputElement>("ev-until").focus();
          return;
        }
      }
      try {
        if (id) {
          if (existing && currentSeries && !repeatOn() && !occurrenceScope()) {
            // TD-016 (owner decision, 2026-09-02, binding): unchecking
            // "Repeat" is NOT a delete. It means "END RECURRENCE AT THIS
            // POINT": the series rule is terminated (UNTIL = the edited
            // occurrence's ORIGINAL start date, inclusive — past occurrences
            // stay, nothing after the edit point is generated, no tombstones
            // are written) and the edited occurrence survives as a standalone
            // single event carrying the user's edits (updateEvent on the base
            // row). Whole-series deletion remains ONLY the explicit Delete
            // path below, behind the two-step confirm.
            //
            // Pkg8 review F1 (sev 9, BLOCKING): `input.startMs` is built from
            // ev-date, which openFor seeds with the CHIP's start. On any chip
            // that isn't the series' first occurrence, a naive updateEvent
            // would MOVE THE BASE ANCHOR to the edit point — every earlier
            // occurrence would silently vanish (violating the owner decision)
            // and remaining future occurrences would re-anchor from the wrong
            // day. dialogEvent IS the chip, so its startMs is NOT the base's.
            // Fix: re-read the authoritative BASE row from the store (chips
            // share the base id) and keep its original start/end — the chain
            // anchor is untouchable. ONLY non-anchoring fields (title,
            // description, allDay) carry the user's edits. The edited
            // occurrence's own date/time is preserved via the terminating
            // UNTIL + an override on the ORIGINAL occurrence id.
            const baseRow = (await listEvents({ fromMs: 0, toMs: Date.now() + 3_155_760_000_000 }))
              .find((e) => e.id === id);
            const baseStartMs = baseRow?.startMs ?? existing.startMs;
            const baseEndMs = baseRow?.endMs ?? existing.endMs;
            const baseKeepsSchedule: EventInput = {
              title: input.title,
              description: input.description,
              startMs: baseStartMs,
              endMs: baseEndMs,
              allDay: input.allDay,
            };
            await updateEvent(id, baseKeepsSchedule);
            // Pkg8 review F1 (secondary): derive the edit point from the
            // ORIGINAL occurrence id (dialogOccurrenceId, TD-015), never from
            // the chip's possibly-moved startMs.
            const editPointId =
              dialogOccurrenceId ??
              deriveRecurrenceId(baseStartMs, existing.allDay);
            const until = editPointId.slice(0, 8);
            // The terminating occurrence survives with the user's date/time
            // edits as an override on its ORIGINAL identity (R2: identity is
            // never rewritten). Written only when the user actually changed
            // the schedule relative to the rendered chip.
            if (
              input.startMs !== existing.startMs ||
              input.endMs !== existing.endMs
            ) {
              await updateOccurrence(currentSeries.seriesId, editPointId, {
                start_wall: wallStamp(input.startMs),
                end_wall: wallStamp(Math.max(input.endMs, input.startMs)),
              });
            }
            const terminated = terminateRuleAt(currentSeries.recurrenceRule, until);
            if (terminated !== currentSeries.recurrenceRule) {
              await updateSeriesRule(currentSeries.seriesId, terminated);
            }
            dlg().close();
            document.dispatchEvent(new CustomEvent("tide:refresh"));
            return;
          }
          if (existing && occurrenceScope()) {
            // DC-12 §2.2/§4.1: THIS-occurrence-only edit -> occurrence
            // override keyed (series_id, recurrence_id). TD-015: the id comes
            // from the chip's ORIGINAL occurrence (captured at open via
            // occurrenceOf) — NEVER from the chip's possibly-moved startMs,
            // which would key a phantom override and orphan the real one
            // (R2: identity derived once, never rewritten). For a series
            // BASE event (no chip meta) the start-derived id is correct.
            const series = currentSeries!;
            const rid =
              dialogOccurrenceId ??
              deriveRecurrenceId(existing.startMs, existing.allDay);
            const patch: Record<string, unknown> = {};
            if (input.title !== existing.title) patch.title = input.title;
            if (
              input.startMs !== existing.startMs ||
              input.endMs !== existing.endMs
            ) {
              patch.start_wall = wallStamp(input.startMs);
              patch.end_wall = wallStamp(Math.max(input.endMs, input.startMs));
            }
            if (Object.keys(patch).length > 0) {
              await updateOccurrence(series.seriesId, rid, patch);
            }
          } else {
            // Whole-series edit: base event row (ordinary per-field entities).
            // Smoke-test bug (2026-09-03, DB-evidenced): this path passed the
            // CHIP's startMs/endMs straight to updateEvent, so editing a chip
            // that isn't the series' first occurrence RE-ANCHORED the base to
            // that chip — every earlier occurrence silently vanished and any
            // occurrence overrides became orphans (their recurrence_ids no
            // longer generated → the "custom occurrence gets dropped" report;
            // the same mechanism dropped the chain when a reminder save rode
            // along on a whole-series edit). Same bug class as Pkg8 F1 (the
            // uncheck path), which already re-reads the authoritative base
            // row. Fix: schedule changes apply as a DELTA relative to the
            // chip the dialog rendered — user didn't touch the times → zero
            // delta → the base anchor and all overrides stay untouched.
            const baseRow = (await listEvents({ fromMs: 0, toMs: Date.now() + 3_155_760_000_000 }))
              .find((e) => e.id === id);
            const chip = existing!; // guarded: this branch requires existing && currentSeries
            const baseStartMs = baseRow?.startMs ?? chip.startMs;
            const baseEndMs = baseRow?.endMs ?? chip.endMs;
            const seriesInput: EventInput = {
              title: input.title,
              description: input.description,
              startMs: baseStartMs + (input.startMs - chip.startMs),
              endMs: baseEndMs + (input.endMs - chip.endMs),
              allDay: input.allDay,
            };
            await updateEvent(id, seriesInput);
            // DC-12 §3: rule edits go to their OWN conflict entity
            // (series_id, "recurrence_rule"); only when the builder produced
            // a different rule. Unparsable rules (builder disabled) are kept
            // verbatim — never rewritten.
            const rule = builderRule();
            if (currentSeries && rule && rule !== currentSeries.recurrenceRule) {
              await updateSeriesRule(currentSeries.seriesId, rule);
            }
          }
          // DC-22: reminder member follows the checkbox (update path).
          if (field<HTMLInputElement>("ev-remind-on").checked) {
            await setReminder(
              id,
              Number(field<HTMLSelectElement>("ev-remind-minutes").value),
            );
          } else {
            await clearReminder(id);
          }
        } else {
          // New event: optional create-time RRULE makes it a series (DC-12 §2.1).
          const rule = builderRule();
          const saved = await createEvent(
            rule ? { ...input, recurrenceRule: rule } : input,
          );
          // DC-22: reminder member follows the checkbox (create path).
          if (field<HTMLInputElement>("ev-remind-on").checked) {
            await setReminder(
              saved.id,
              Number(field<HTMLSelectElement>("ev-remind-minutes").value),
            );
          }
        }
        dlg().close();
        document.dispatchEvent(new CustomEvent("tide:refresh"));
      } catch (err) {
        showInlineError(`Failed to save event: ${String(err)}`);
      }
    });

  document
    .getElementById("ev-delete")
    ?.addEventListener("click", () => {
      const btn = document.getElementById("ev-delete") as HTMLButtonElement;
      const id = field<HTMLInputElement>("ev-id").value;
      if (!id) return;
      // Two-step in-app confirmation (no native confirm() — owner flagged
      // the WebKit popup chrome). Second click executes the delete.
      armDeleteConfirm(btn, () => {
        void (async () => {
          try {
            if (dialogEvent && occurrenceScope()) {
              // DC-12 §4.1: cancelling ONE occurrence writes the override
              // (series_id, "overrides.<rid>.cancelled") — the series and its
              // other occurrences are untouched. Whole-series delete (below)
              // is D7. TD-015: rid from the ORIGINAL occurrence (chip meta),
              // not the moved start — same identity rule as the Save path.
              const rid =
                dialogOccurrenceId ??
                deriveRecurrenceId(dialogEvent.startMs, dialogEvent.allDay);
              await updateOccurrence(currentSeries!.seriesId, rid, {
                cancelled: true,
              });
            } else {
              // Whole-series delete (or single event): EventCore applies D7 —
              // the series tombstone structurally removes all overrides.
              await deleteEvent(id);
            }
            dlg().close();
            document.dispatchEvent(new CustomEvent("tide:refresh"));
          } catch (err) {
            showInlineError(`Failed to delete event: ${String(err)}`);
          }
        })();
      });
    });

  document
    .getElementById("ev-cancel")
    ?.addEventListener("click", () => dlg().close());
}
