// Tide: burger-menu drawer (owner request 2026-09-08). Slide-in navigation
// holding the calendar-data I/O actions: Export (DC-18) and Import (DC-23),
// both live.
import { initExport, exportCalendar } from "./export.ts";
import { importCalendar } from "./import_dialog.ts";

let open = false;

function setOpen(next: boolean): void {
  open = next;
  const drawer = document.getElementById("menu-drawer");
  const backdrop = document.getElementById("menu-backdrop");
  const burger = document.getElementById("btn-menu");
  if (!drawer || !backdrop || !burger) return;
  drawer.hidden = !open;
  backdrop.hidden = !open;
  burger.setAttribute("aria-expanded", open ? "true" : "false");
}

export function initMenu(): void {
  document.getElementById("btn-menu")?.addEventListener("click", () => setOpen(!open));
  document.getElementById("btn-menu-close")?.addEventListener("click", () => setOpen(false));
  document.getElementById("menu-backdrop")?.addEventListener("click", () => setOpen(false));
  // Escape closes the drawer (matches the event-dialog's dismissal habit).
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && open) setOpen(false);
  });

  // Data I/O entries. Export: close the drawer, then run the DC-18 flow.
  document.getElementById("menu-export")?.addEventListener("click", () => {
    setOpen(false);
    void exportCalendar();
  });
  // DC-23: import is now live (contract approved + implemented).
  document.getElementById("menu-import")?.addEventListener("click", () => {
    setOpen(false);
    void importCalendar();
  });

  // Ensure export.ts's own (unused) toolbar wiring cannot break if the
  // toolbar button ever returns; initExport is idempotent.
  initExport();
}
