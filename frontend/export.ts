// Tide DC-18 §2: export surface + trigger. User-invoked toolbar action only
// (no background/scheduled export, §2.1). Flow:
//   OS save dialog (tauri-plugin-dialog, §2.4) -> invoke("export_ics",
//   { target_path }) -> shell writes the exporter's bytes.
// Scope selection (§2.2): v1 exports ALL calendars (the contract default;
// the app currently has a single shell-local calendar — per-calendar
// scope arrives with the multi-calendar UI).
import { save, message } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";

let inFlight = false;

export async function exportCalendar(): Promise<void> {
  if (inFlight) return; // debounce double-clicks
  inFlight = true;
  try {
    const target = await save({
      title: "Export calendar (.ics)",
      defaultPath: "tide-calendar.ics",
      filters: [{ name: "iCalendar", extensions: ["ics"] }],
    });
    if (!target) return; // user cancelled the save dialog
    const bytes: number = await invoke("export_ics", { target_path: target });
    await message(`Exported calendar to ${target} (${bytes} bytes).`, {
      title: "Export complete",
      kind: "info",
    });
  } catch (e) {
    await message(`Export failed: ${String(e)}`, {
      title: "Export failed",
      kind: "error",
    });
  } finally {
    inFlight = false;
  }
}

/** Wire the toolbar button (called once from the UI init path). */
export function initExport(): void {
  document.getElementById("btn-export")?.addEventListener("click", () => {
    void exportCalendar();
  });
}
