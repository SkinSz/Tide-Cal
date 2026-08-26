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
  type CalendarEvent,
  type EventInput,
} from "./store.ts";
import { getSelectedDate } from "./calendar.ts";

const dlg = () => document.getElementById("event-dialog") as HTMLDialogElement;

function field<T extends HTMLElement>(id: string): T {
  return dlg().querySelector(`#${id}`) as T;
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

function syncTimeVisibility(): void {
  const row = field<HTMLDivElement>("ev-time-row");
  row.style.display = wholeDay() ? "none" : "";
}

function commitDateField(): void {
  field<HTMLInputElement>("ev-date").blur();
}

/**
 * Outlook-style dropdown: 15-minute slots (00:00–23:45) as buttons that set
 * the paired <input type="time">. Complements free typing rather than
 * replacing it — the native time input stays editable.
 */
const TIME_SLOTS: string[] = Array.from(
  { length: 24 * 4 },
  (_, i) => `${pad(Math.floor(i / 4))}:${pad((i % 4) * 15)}`,
);

function openTimeMenu(inputId: string): void {
  const inp = field<HTMLInputElement>(inputId);
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
    const opt = document.createElement("button");
    opt.type = "button";
    opt.className = "time-option" + (inp.value === slot ? " picked" : "");
    opt.textContent = slot;
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
  // it are swallowed by the popover itself. So: auto-blur as soon as a value
  // is committed, plus the "Done" menu button as the visible escape hatch.
  field("ev-date").addEventListener("change", commitDateField);
  document
    .getElementById("ev-date-ok")
    ?.addEventListener("click", commitDateField);

  // Time fields: free typing in the native input OR the ▾ 15-min dropdown.
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
        alert(`Failed to save event: ${String(err)}`);
      }
    });

  document
    .getElementById("ev-delete")
    ?.addEventListener("click", async () => {
      const id = field<HTMLInputElement>("ev-id").value;
      if (!id || !confirm("Delete this event?")) return;
      try {
        await deleteEvent(id);
        dlg().close();
        document.dispatchEvent(new CustomEvent("tide:refresh"));
      } catch (err) {
        alert(`Failed to delete event: ${String(err)}`);
      }
    });

  document
    .getElementById("ev-cancel")
    ?.addEventListener("click", () => dlg().close());
}
