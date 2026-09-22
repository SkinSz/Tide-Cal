// Tide DC-23 §8: import surface. User-invoked burger-menu action only.
// Flow: OS open dialog (approved plugin) -> read file via the shell command
// (the shell reads the file, sidecar stays fs-free) -> ImportReport shown.
import { open, message } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";

interface ImportReport {
  created: string[];
  updated: string[];
  skipped: Array<{ uid: string; reason: string }>;
  failed: Array<{ uid: string; reason: string }>;
  notices: string[];
}

let inFlight = false;

export async function importCalendar(): Promise<void> {
  if (inFlight) return; // debounce double-clicks
  inFlight = true;
  try {
    const source = await open({
      title: "Import calendar (.ics)",
      multiple: false,
      directory: false,
      filters: [{ name: "iCalendar", extensions: ["ics"] }],
    });
    if (!source || typeof source !== "string") return; // cancelled
    const res = await invoke<{ report: ImportReport }>("import_ics", { source_path: source });
    const r = res.report;
    const lines: string[] = [
      `Created: ${r.created.length}`,
      `Updated: ${r.updated.length}`,
      `Skipped: ${r.skipped.length}`,
      `Failed: ${r.failed.length}`,
    ];
    // §12 failure visibility: every lossy decision is in the report —
    // surface notices + skipped/failed reasons in the dialog.
    const details = [
      ...r.notices,
      ...r.skipped.map((s) => `skipped: ${s.reason}`),
      ...r.failed.map((f) => `failed: ${f.reason}`),
    ];
    if (details.length > 0) lines.push("", details.slice(0, 12).join("\n"));
    if (details.length > 12) lines.push(`… and ${details.length - 12} more (see log)`);
    await message(lines.join("\n"), {
      title: "Import complete",
      kind: r.failed.length > 0 ? "warning" : "info",
    });
    // The calendar store refreshes on its own change events (sidecar push);
    // imported edits are normal local changes, so no special reload here.
  } catch (e) {
    await message(`Import failed: ${String(e)}`, {
      title: "Import failed",
      kind: "error",
    });
  } finally {
    inFlight = false;
  }
}
