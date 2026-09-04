// Tide options window entry: Outlook-style settings (left nav pane + right
// content). Reachable ONLY from the tray menu "Options…" item — never from
// the calendar UI.
//
// Data flow: reads/writes settings through Tauri commands
// get_settings/set_settings (Rust shell persists to
// ~/.config/tide/config.toml). Save-all atomic commit: validate+clamp all
// fields -> one set_settings call -> applied live or marked next-start
// (backlog limit).

import { setTheme, setTimeFormat, type Theme, type TimeFormat } from "./theme.ts";

interface TideSettings {
  sync_debounce_seconds: number;
  sweep_interval_minutes: number;
  max_concurrent_sessions: number;
  max_incremental_backlog: number;
  general_theme: string;
  general_time_format: string;
  general_locale: string;
}

const DEFAULTS: TideSettings = {
  sync_debounce_seconds: 10,
  sweep_interval_minutes: 10,
  max_concurrent_sessions: 3,
  max_incremental_backlog: 1000,
  general_theme: "dark",
  general_time_format: "24h",
  general_locale: "system",
};

/**
 * TD-011: the Rust TideSettings persists the General category under dotted
 * TOML keys (`general.theme`, `general.time_format`), and its serde
 * `rename` applies to the JSON IPC shape too — so get_settings returns
 * `general.theme` (not `general_theme`) and set_settings only accepts
 * `general.theme`. The old flat mapping silently fell back to defaults on
 * load and never persisted the General choices at all. These helpers are
 * the single conversion point between the frontend's flat shape and the
 * shell's dotted wire shape (exported for tests).
 */
export type ShellSettings = Record<string, unknown>;

/** Flat frontend key -> dotted shell key (the General category only). */
const FLAT_TO_SHELL: Record<string, string> = {
  general_theme: "general.theme",
  general_time_format: "general.time_format",
  general_locale: "general.locale",
};

/** Shell -> frontend: accept the dotted IPC keys (fall back to flat keys). */
export function settingsFromShell(raw: ShellSettings): Partial<TideSettings> {
  const out: ShellSettings = {};
  for (const key of Object.keys(DEFAULTS)) {
    const dotted = FLAT_TO_SHELL[key];
    const value = (dotted !== undefined ? raw[dotted] : undefined) ?? raw[key];
    if (value !== undefined) out[key] = value;
  }
  return out as Partial<TideSettings>;
}

/** Frontend -> shell: send the dotted keys serde's rename expects. */
export function settingsToShell(s: TideSettings): ShellSettings {
  const out: ShellSettings = {};
  for (const key of Object.keys(s) as Array<keyof TideSettings>) {
    const dotted = FLAT_TO_SHELL[key];
    if (dotted) out[dotted] = s[key];
    else out[key] = s[key];
  }
  return out;
}

// Field id <-> setting key mapping, with the user-facing label used in
// validation errors. (General category radios are handled separately.)
type NumericSettingKey =
  | "sync_debounce_seconds"
  | "sweep_interval_minutes"
  | "max_concurrent_sessions"
  | "max_incremental_backlog";

const FIELDS: Array<{
  inputId: string;
  key: NumericSettingKey;
  label: string;
  min: number;
  max: number;
  restartNote?: boolean;
}> = [
  {
    inputId: "opt-sync-debounce",
    key: "sync_debounce_seconds",
    label: "Sync debounce",
    min: 5,
    max: 120,
  },
  {
    inputId: "opt-sweep-interval",
    key: "sweep_interval_minutes",
    label: "Sweep interval",
    min: 1,
    max: 1440,
  },
  {
    inputId: "opt-max-concurrent",
    key: "max_concurrent_sessions",
    label: "Max concurrent sync sessions",
    min: 1,
    max: 5,
  },
  {
    inputId: "opt-backlog",
    key: "max_incremental_backlog",
    label: "Incremental backlog limit",
    min: 100,
    max: 100000,
    restartNote: true, // restart-scoped for v1
  },
];

function field(id: string): HTMLInputElement {
  return document.getElementById(id) as HTMLInputElement;
}

function showErr(msg: string): void {
  const el = document.getElementById("options-error");
  if (!el) return;
  el.hidden = false;
  el.textContent = msg;
}

function clearErr(): void {
  const el = document.getElementById("options-error");
  if (el) el.hidden = true;
}

async function hasTauri(): Promise<boolean> {
  return "__TAURI_INTERNALS__" in globalThis;
}

/** Load settings from the shell and populate the inputs (fresh per open). */
async function loadSettings(): Promise<void> {
  clearErr();
  let current: TideSettings = { ...DEFAULTS };
  if (await hasTauri()) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const fromShell = await invoke<ShellSettings>("get_settings");
      current = { ...current, ...settingsFromShell(fromShell) };
    } catch (err) {
      console.warn("[tide-options] get_settings failed; showing defaults:", err);
      showErr(`Could not load settings: ${String(err)} (showing defaults)`);
    }
  }
  for (const f of FIELDS) {
    field(f.inputId).value = String(current[f.key]);
  }
  // General: radios (theme + clock style). Unknown saved values fall back
  // to the defaults here too.
  const theme: Theme = current.general_theme === "light" ? "light" : "dark";
  const fmt: TimeFormat = current.general_time_format === "12h" ? "12h" : "24h";
  for (const radio of document.querySelectorAll<HTMLInputElement>(
    'input[name="opt-theme"]',
  )) {
    radio.checked = radio.value === theme;
  }
  for (const radio of document.querySelectorAll<HTMLInputElement>(
    'input[name="opt-time-format"]',
  )) {
    radio.checked = radio.value === fmt;
  }
  // Locale radios: whitelist matches the Rust clamp (system/de/en-GB/en-US).
  const savedLocale = current.general_locale;
  const locale = ["system", "de", "en-GB", "en-US"].includes(savedLocale)
    ? savedLocale
    : "system";
  for (const radio of document.querySelectorAll<HTMLInputElement>(
    'input[name="opt-locale"]',
  )) {
    radio.checked = radio.value === locale;
  }
}

/** Read the General radios into the pending settings (defaults if unset). */
function readGeneral(pending: TideSettings): void {
  const theme = document.querySelector<HTMLInputElement>(
    'input[name="opt-theme"]:checked',
  );
  const fmt = document.querySelector<HTMLInputElement>(
    'input[name="opt-time-format"]:checked',
  );
  pending.general_theme = theme?.value === "light" ? "light" : "dark";
  pending.general_time_format = fmt?.value === "12h" ? "12h" : "24h";
  const locale = document.querySelector<HTMLInputElement>(
    'input[name="opt-locale"]:checked',
  );
  pending.general_locale = ["de", "en-GB", "en-US"].includes(locale?.value ?? "")
    ? locale!.value
    : "system";
}

/**
 * Live-apply the General choices: update this window immediately, then tell
 * the main window (Tauri event when available, in-window event otherwise)
 * so the look and clock style change the moment Save is pressed.
 */
async function applyGeneralLive(pending: TideSettings): Promise<void> {
  setTheme(pending.general_theme === "light" ? "light" : "dark");
  setTimeFormat(pending.general_time_format === "12h" ? "12h" : "24h");
  const payload = {
    theme: pending.general_theme,
    time_format: pending.general_time_format,
  };
  document.dispatchEvent(
    new CustomEvent("tide:settings-changed", { detail: payload }),
  );
  if (await hasTauri()) {
    try {
      const { emit } = await import("@tauri-apps/api/event");
      await emit("tide:settings-changed", payload);
    } catch (err) {
      console.warn("[tide-options] live-apply emit failed:", err);
    }
  }
}

/**
 * Save-all atomic commit: validate+clamp every field FIRST; only if all
 * clean, one set_settings call persists; backend applies live where
 * applicable and marks the backlog limit next-start.
 */
async function saveSettings(): Promise<void> {
  clearErr();
  const pending: TideSettings = { ...DEFAULTS };
  for (const f of FIELDS) {
    const raw = field(f.inputId).value.trim();
    const n = Number(raw);
    if (!Number.isFinite(n) || raw === "") {
      showErr(`${f.label}: please enter a number.`);
      field(f.inputId).focus();
      return;
    }
    if (n < f.min || n > f.max) {
      showErr(`${f.label}: must be between ${f.min} and ${f.max}.`);
      field(f.inputId).focus();
      return;
    }
    pending[f.key] = Math.round(Math.min(f.max, Math.max(f.min, n)));
  }
  readGeneral(pending);
  if (await hasTauri()) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("set_settings", { settings: settingsToShell(pending) });
    } catch (err) {
      showErr(`Failed to save settings: ${String(err)}`);
      return;
    }
  }
  await applyGeneralLive(pending);
  if (Number(field("opt-backlog").value) !== Number(field("opt-backlog").dataset.savedAtLoad ?? "0")) {
    showErr("Saved. The backlog limit takes effect after you restart Tide.");
  } else {
    showErr("Saved.");
  }
  void refreshSavedMarker();
}

/** Track the persisted values so Cancel can restore them before closing. */
let savedSnapshot: TideSettings = { ...DEFAULTS };

async function refreshSavedMarker(): Promise<void> {
  // Update data-saved-at-load markers to the persisted values (best-effort).
  if (await hasTauri()) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const fromShell = await invoke<ShellSettings>("get_settings");
      savedSnapshot = { ...DEFAULTS, ...settingsFromShell(fromShell) };
      for (const f of FIELDS) {
        field(f.inputId).dataset.savedAtLoad = String(savedSnapshot[f.key]);
      }
    } catch {
      /* best-effort */
    }
  }
}

/** Cancel: discard edits (restore last-saved values), then close the window. */
async function cancelEdits(): Promise<void> {
  for (const f of FIELDS) {
    field(f.inputId).value = String(savedSnapshot[f.key]);
  }
  clearErr();
  if (await hasTauri()) {
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      getCurrentWindow().close();
    } catch (err) {
      console.warn("[tide-options] closing window failed:", err);
    }
  }
}

/** Left nav pane: category switching swaps only the right content. */
function initNav(): void {
  const items = document.querySelectorAll<HTMLButtonElement>(".options-nav-item");
  items.forEach((item) => {
    item.addEventListener("click", () => {
      const target = item.dataset.category;
      if (!target) return;
      // Switching categories discards in-window edits (values reload from
      // the saved snapshot); no native dialog is used.
      items.forEach((i) => i.classList.toggle("active", i === item));
      document.querySelectorAll<HTMLElement>(".options-category").forEach((sec) => {
        sec.hidden = sec.dataset.categoryContent !== target;
      });
      clearErr();
    });
  });
}

async function init(): Promise<void> {
  initNav();
  await loadSettings();
  await refreshSavedMarker();
  document.getElementById("options-save")?.addEventListener("click", () => void saveSettings());
  document.getElementById("options-cancel")?.addEventListener("click", () => void cancelEdits());
}

void init();
