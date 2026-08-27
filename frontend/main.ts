// Tide app-shell entry: toolbar wiring + calendar render loop.
import { getViewMode, navigate, render, setViewMode } from "./calendar.ts";
import { initDialog } from "./dialog.ts";
import { initConflicts } from "./conflicts.ts";
import { initDevices } from "./devices.ts";
import { initSyncErrors } from "./sync_errors.ts";

function wire(id: string, fn: () => void): void {
  document.getElementById(id)?.addEventListener("click", fn);
}

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
if (getViewMode() === "week") setMode("week");
else setMode("month");
