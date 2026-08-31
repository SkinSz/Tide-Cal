// Tide app-shell entry: toolbar wiring + calendar render loop.
import { getViewMode, navigate, render, setViewMode } from "./calendar.ts";
import { initDialog } from "./dialog.ts";
import { initConflicts } from "./conflicts.ts";
import { initDevices } from "./devices.ts";
import { initSyncErrors } from "./sync_errors.ts";
import { initPairedDevices } from "./paired_devices.ts";
import { applyTheme, getTheme } from "./theme.ts";

applyTheme(getTheme()); // theme layer ready; no UI toggle yet (options-owned)

function wire(id: string, fn: () => void): void {
  document.getElementById(id)?.addEventListener("click", fn);
}

// DC-19 §4.6 tray-less fallback: "Sync now"/"Quit" are TRAY menu items; when
// no tray is available the Rust shell logs the fallback and these toolbar
// buttons were the in-app equivalent. Owner decision 2026-08-31: even with a
// tray present the buttons duplicated the menu and cluttered the toolbar —
// removed. The fallback surface only matters on tray-less desktops; if we
// ever detect that case (tray build failure logged by the shell), re-add
// these two buttons behind that runtime condition.
wire("btn-prev", () => navigate(-1));
wire("btn-next", () => navigate(1));
wire("btn-today", () => navigate(0));
wire("btn-month", () => setMode("month"));
wire("btn-week", () => setMode("week"));

function setMode(m: "month" | "week"): void {
  setViewMode(m);
  document
    .getElementById(`btn-${m}`)
    ?.classList.add("active");
  const other = m === "month" ? "week" : "month";
  document.getElementById(`btn-${other}`)?.classList.remove("active");
}

document.addEventListener("tide:refresh", () => void render());
window.addEventListener("resize", () => {
  // cheap: only re-render if mode actually matters; keep simple debounce
});

initDialog();
initConflicts();
initDevices();
initSyncErrors();
initPairedDevices();
if (getViewMode() === "week") setMode("week");
else setMode("month");
