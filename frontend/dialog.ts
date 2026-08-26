// Tide event create/edit/delete dialog (native <dialog>, minimal styling).
import {
  createEvent,
  deleteEvent,
  updateEvent,
  type CalendarEvent,
  type EventInput,
} from "./store.ts";

const dlg = () => document.getElementById("event-dialog") as HTMLDialogElement;

function field<T extends HTMLElement>(id: string): T {
  return dlg().querySelector(`#${id}`) as T;
}

function openFor(date: Date, existing?: CalendarEvent): void {
  const d = new Date(date);
  if (!existing) d.setHours(9, 0, 0, 0);
  const end = new Date(existing ? existing.endMs : d.getTime() + 60 * 60_000);
  const toLocalInput = (v: Date) => {
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}T${pad(
      v.getHours(),
    )}:${pad(v.getMinutes())}`;
  };

  (field("ev-id") as HTMLInputElement).value = existing?.id ?? "";
  (field("ev-title") as HTMLInputElement).value = existing?.title ?? "";
  (field("ev-desc") as HTMLTextAreaElement).value = existing?.description ?? "";
  (field("ev-start") as HTMLInputElement).value = toLocalInput(
    new Date(existing?.startMs ?? d),
  );
  (field("ev-end") as HTMLInputElement).value = toLocalInput(end);
  (field("ev-allday") as HTMLInputElement).checked = existing?.allDay ?? false;
  (dlg().querySelector("#dialog-title") as HTMLElement).textContent = existing
    ? "Edit event"
    : "New event";
  (dlg().querySelector("#ev-delete") as HTMLButtonElement).hidden =
    !existing;
  dlg().showModal();
}

function readInput(): EventInput | null {
  const title = (field("ev-title") as HTMLInputElement).value.trim();
  if (!title) {
    (field("ev-title") as HTMLInputElement).focus();
    return null;
  }
  const startMs = new Date((field("ev-start") as HTMLInputElement).value).getTime();
  let endMs = new Date((field("ev-end") as HTMLInputElement).value).getTime();
  if (!Number.isFinite(startMs)) return null;
  if (!Number.isFinite(endMs) || endMs <= startMs) endMs = startMs + 60 * 60_000;
  return {
    title,
    description: (field("ev-desc") as HTMLTextAreaElement).value.trim(),
    startMs,
    endMs,
    allDay: (field("ev-allday") as HTMLInputElement).checked,
  };
}

export function initDialog(): void {
  // New-event button: uses the currently selected day.
  document.getElementById("btn-new")?.addEventListener("click", () => {
    document.dispatchEvent(new CustomEvent("tide:getselectedday"));
    const sel = document.querySelector<HTMLElement>(".day-selected");
    const date = sel?.dataset.date
      ? new Date(sel.dataset.date + "T00:00:00")
      : new Date();
    openFor(date);
  });

  document.addEventListener("tide:eventclick", (e) => {
    openFor(new Date(), (e as CustomEvent<CalendarEvent>).detail);
  });

  document
    .getElementById("ev-save")
    ?.addEventListener("click", async () => {
      const input = readInput();
      if (!input) return;
      const id = (field("ev-id") as HTMLInputElement).value;
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
      const id = (field("ev-id") as HTMLInputElement).value;
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
