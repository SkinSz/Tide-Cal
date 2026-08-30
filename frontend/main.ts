// Tide app-shell entry: toolbar wiring + calendar render loop.
import { getViewMode, navigate, render, setViewMode } from "./calendar.ts";
import { initDialog } from "./dialog.ts";
import { initConflicts } from "./conflicts.ts";
import { initDevices } from "./devices.ts";
import { initSyncErrors } from "./sync_errors.ts";
import { initPairedDevices } from "./paired_devices.ts";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

function wire(id: string, fn: () => void): void {
  document.getElementById(id)?.addEventListener("click", fn);
}

// DC-19 §4.6 fallback surface: when no tray is available, the SAME actions
// (except window-show) live in the toolbar. "Sync now" routes through the
// same shell command the tray menu uses (manual_sync_now → sync_now RPC with
// manual intent); it is disabled while a sync session is in flight
// (tide://sync-state events from the Rust shell, DC-19 §4.2). Quit runs the
// tray Quit's clean sidecar stdin-EOF shutdown (§4.4).
function initManualSync(): void {
  const btn = document.getElementById("btn-manual-sync");
  const flightEl = document.getElementById("btn-manual-sync");
  const setFlight = (inFlight: boolean): void => {
    if (btn instanceof HTMLButtonElement) btn.disabled = inFlight;
    if (flightEl instanceof HTMLElement) flightEl.title = inFlight ? "Sync in flight…" : "Sync now";
  };
  btn?.addEventListener("click", () => {
    if (!("__TAURI_INTERNALS__" in globalThis)) return;
    void invoke("manual_sync_now").catch((err: unknown) => {
      console.warn("[tide] sync now skipped:", err);
    });
  });
  if ("__TAURI_INTERNALS__" in globalThis) {
    void listen<boolean>("tide://sync-state", (e) => setFlight(!e.payload));
  }
}

function initQuit(): void {
  document.getElementById("btn-quit")?.addEventListener("click", () => {
    if (!("__TAURI_INTERNALS__" in globalThis)) return;
    void invoke("quit_tide").catch(() => {});
  });
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
initManualSync();
initQuit();
initConflicts();
initDevices();
initSyncErrors();
initPairedDevices();
if (getViewMode() === "week") setMode("week");
else setMode("month");
