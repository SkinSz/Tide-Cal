// Tide: burger-menu drawer (owner requests 2026-09-08, 2026-11-14). Slide-in
// navigation: calendar-data I/O (Export DC-18, Import DC-23) and app entries
// (Devices & sync, Options).
import { initExport, exportCalendar } from "./export.ts";
import { importCalendar } from "./import_dialog.ts";

let open = false;

async function openOptions(): Promise<void> {
  if (!("__TAURI_INTERNALS__" in globalThis)) return; // plain browser
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("open_options");
  } catch (err) {
    console.warn("[tide] open options failed:", err);
  }
}

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

  // Devices (owner 2026-11-14): devices.ts opens its dialog on this same
  // button; the drawer just gets out of the way first.
  document.getElementById("btn-devices")?.addEventListener("click", () => setOpen(false));
  // Options: the same window the tray's "Options" entry opens (DC-20 §2).
  document.getElementById("menu-options")?.addEventListener("click", () => {
    setOpen(false);
    void openOptions();
  });

  // Ensure export.ts's own (unused) toolbar wiring cannot break if the
  // toolbar button ever returns; initExport is idempotent.
  initExport();
}
