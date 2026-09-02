// Tide app-shell entry: toolbar wiring + calendar render loop.
import { getViewMode, navigate, render, setViewMode } from "./calendar.ts";
import { initDialog } from "./dialog.ts";
import { initConflicts } from "./conflicts.ts";
import { initDevices } from "./devices.ts";
import { initSyncErrors } from "./sync_errors.ts";
import { initPairedDevices } from "./paired_devices.ts";
import { applyTheme, getTheme, setTheme, setTimeFormat, type Theme, type TimeFormat } from "./theme.ts";

applyTheme(getTheme()); // theme layer; the General options own the choice

// Smoke-test fix (2026-09-03): the clock style previously initialized ONLY
// from the localStorage cache — a stale "12h" cache survived even though
// config.toml (the authoritative store) says 24h. On startup in the desktop
// app, read the shell's effective settings and sync the cache before first
// render, so the options choice always wins.
if ("__TAURI_INTERNALS__" in globalThis) {
  void (async () => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const shell = await invoke<{ general_theme?: string; general_time_format?: string }>(
        "get_settings",
      );
      if (shell.general_theme === "light" || shell.general_theme === "dark") {
        setTheme(shell.general_theme);
      }
      if (shell.general_time_format === "12h" || shell.general_time_format === "24h") {
        setTimeFormat(shell.general_time_format);
        void render();
      }
    } catch (err) {
      console.warn("[tide] settings sync unavailable:", err);
    }
  })();
}

// General options live in a separate window. Live-apply (Save in the
// options window): Tauri event from there, mirrored as an in-window event
// for non-Tauri/test contexts. localStorage is kept in sync as the cache.
interface GeneralChange {
  theme?: string;
  time_format?: string;
}
function applyGeneralChange(msg: Partial<GeneralChange>): void {
  const theme: Theme = msg.theme === "light" ? "light" : "dark";
  const fmt: TimeFormat = msg.time_format === "12h" ? "12h" : "24h";
  setTheme(theme);
  setTimeFormat(fmt);
  // Time format is baked into rendered labels (chips, hour ruler), so the
  // calendar must re-render for it to show up without a restart (theme
  // applies via CSS alone and needs no repaint).
  void render();
}
document.addEventListener("tide:settings-changed", (e) => {
  applyGeneralChange((e as CustomEvent<GeneralChange>).detail ?? {});
});
if ("__TAURI_INTERNALS__" in globalThis) {
  void import("@tauri-apps/api/event")
    .then(({ listen }) =>
      listen<GeneralChange>("tide:settings-changed", (ev) =>
        applyGeneralChange(ev.payload),
      ),
    )
    .catch((err) => console.warn("[tide] event listen unavailable:", err));
}

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
