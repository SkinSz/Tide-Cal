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
  listSeries,
  type CalendarEvent,
  type EventInput,
} from "./store.ts";
import { getSelectedDate } from "./calendar.ts";
import { dialogRecurrenceLine } from "./recurrence.ts";
import { formatTimeLabel, getTimeFormat } from "./theme.ts";

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

/** Epoch ms from a local YYYY-MM-DD date and optional HH:MM time. */
function localMs(date: string, time: string): number {
  return new Date(`${date}T${time || "00:00"}:00`).getTime();
}

function wholeDay(): boolean {
  return (field("ev-allday") as HTMLInputElement).checked;
}

/**
 * READ-ONLY recurrence info line (DC-12 §2 / deferred #12 surface): when the
 * edited event is a series' base event, state the rule in plain language and
 * make the THIS-occurrence-vs-SERIES distinction visible. v1 editing rewrites
 * the base event row only; the line says exactly that. Best-effort: failures
 * simply leave the line hidden.
 */
function syncRecurrenceLine(existing?: CalendarEvent): void {
  const line = document.getElementById("ev-recurrence-info");
  if (!line) return;
  line.hidden = true;
  line.textContent = "";
  if (!existing) return;
  listSeries()
    .then((rows) => {
      const info = rows.find((r) => r.baseEventId === existing.id);
      if (!info) return;
      line.textContent = dialogRecurrenceLine({
        seriesId: info.seriesId,
        baseEventId: info.baseEventId,
        rule: info.recurrenceRule,
        overrides: info.overrides,
      });
      line.hidden = false;
    })
    .catch((e) => console.warn("[tide] series lookup unavailable:", e));
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
  // Open scrolled so the currently selected value is visible.
  menu.querySelector(".picked")?.scrollIntoView({ block: "center" });
}

function closeTimeMenus(): void {
  document.getElementById("time-menu")?.remove();
}

function openFor(date: Date, existing?: CalendarEvent): void {
  const d = new Date(date);
  clearInlineError();

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
  syncRecurrenceLine(existing);
  (dlg().querySelector("#ev-delete") as HTMLButtonElement).hidden =
    !existing;
  syncTimeVisibility();
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
    const s = field<HTMLInputElement>("ev-start-t").value;
    let e = field<HTMLInputElement>("ev-end-t").value;
    startMs = localMs(day, s);
    if (!e || e <= s) e = "10:00";
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
  // Date picker: WebKit's popover only closes on blur, and Enter/ESC inside
  // it are swallowed by the popover itself. The "Done" escape hatch exists
  // ONLY while the Day field's picker is open (shown via .date-picking on
  // the dialog); auto-blur on change closes the popover in the normal case.
  const dateOk = document.getElementById("ev-date-ok");
  field("ev-date").addEventListener("focus", () => dlg().classList.add("date-picking"));
  field("ev-date").addEventListener("blur", () => dlg().classList.remove("date-picking"));
  field("ev-date").addEventListener("change", () => {
    commitDateField();
    dlg().classList.remove("date-picking");
  });
  dateOk?.addEventListener("click", commitDateField);

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
      try {
        if (id) await updateEvent(id, input);
        else await createEvent(input);
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
            await deleteEvent(id);
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
