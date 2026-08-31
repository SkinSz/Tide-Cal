// Tide options window entry: Outlook-style settings (left nav pane + right
// content). Reachable ONLY from the tray menu "Options…" item — never from
// the calendar UI.
//
// Data flow: reads/writes settings through Tauri commands
// get_settings/set_settings (Rust shell persists to
// ~/.config/tide/config.toml). Save-all atomic commit: validate+clamp all
// fields -> one set_settings call -> applied live or marked next-start
// (backlog limit).

interface TideSettings {
  sync_debounce_seconds: number;
  sweep_interval_minutes: number;
  max_concurrent_sessions: number;
  max_incremental_backlog: number;
}

const DEFAULTS: TideSettings = {
  sync_debounce_seconds: 10,
  sweep_interval_minutes: 10,
  max_concurrent_sessions: 3,
  max_incremental_backlog: 1000,
};

// Field id <-> setting key mapping, with the user-facing label used in
// validation errors.
const FIELDS: Array<{
  inputId: string;
  key: keyof TideSettings;
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
      const fromShell = await invoke<Partial<TideSettings>>("get_settings");
      current = { ...current, ...fromShell };
    } catch (err) {
      console.warn("[tide-options] get_settings failed; showing defaults:", err);
      showErr(`Could not load settings: ${String(err)} (showing defaults)`);
    }
  }
  for (const f of FIELDS) {
    field(f.inputId).value = String(current[f.key]);
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
  if (await hasTauri()) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("set_settings", { settings: pending });
    } catch (err) {
      showErr(`Failed to save settings: ${String(err)}`);
      return;
    }
  }
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
      const fromShell = await invoke<Partial<TideSettings>>("get_settings");
      savedSnapshot = { ...DEFAULTS, ...fromShell };
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
