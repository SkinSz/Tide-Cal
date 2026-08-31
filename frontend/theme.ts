// Theme + general-look preferences. The options window (General category)
// owns the choice; both windows keep a localStorage cache so the look is
// right at startup, while config.toml (via Tauri settings) is the
// authoritative store. The theme is a plain manual Light/Dark choice —
// deliberately no system-follow, no auto-detection.
export type Theme = "dark" | "light";
export type TimeFormat = "24h" | "12h";

const LS_KEY = "tide.theme";
const TF_KEY = "tide.time_format";

/**
 * localStorage is unavailable in some bare test environments (and in
 * non-browser contexts generally); prefer a guarded accessor over an
 * import-time crash. The app always runs in a webview where it exists.
 */
function lsGet(key: string): string | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage.getItem(key);
  } catch {
    return null;
  }
}

function lsSet(key: string, value: string): void {
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(key, value);
  } catch {
    /* non-fatal: cache-only write */
  }
}

export function getTheme(): Theme {
  return lsGet(LS_KEY) === "light" ? "light" : "dark";
}

export function setTheme(theme: Theme): void {
  lsSet(LS_KEY, theme);
  applyTheme(theme);
}

export function applyTheme(theme: Theme): void {
  if (typeof document === "undefined") return; // bare test/non-DOM context
  document.documentElement.dataset.theme = theme;
}

export function getTimeFormat(): TimeFormat {
  return lsGet(TF_KEY) === "12h" ? "12h" : "24h";
}

export function setTimeFormat(format: TimeFormat): void {
  lsSet(TF_KEY, format);
  applyTimeFormat(format);
}

/**
 * Stamp the clock style on <html>. The data attribute scopes the 24h CSS
 * backstops in style.css; the lang attribute drives WebKitGTK's native
 * <input type="time"> rendering (en-GB = 24h, en-US = AM/PM). The input's
 * value stays 24h "HH:MM" either way, so commit/read code is untouched.
 */
export function applyTimeFormat(format: TimeFormat): void {
  if (typeof document === "undefined") return; // bare test/non-DOM context
  const root = document.documentElement;
  root.dataset.timeFormat = format;
  // Keep en-GB in both modes: the visible 12h presentation is carried by
  // the .ampm-toggle button + dropdown, not the native input's suffix
  // (which is CSS-suppressed; exactly one AM/PM surface, owner design).
  root.lang = "en-GB";
}

const pad = (n: number): string => String(n).padStart(2, "0");

/** Render a 24h "HH:MM" value for display in the chosen clock style. */
export function formatTimeLabel(hhmm: string, format: TimeFormat): string {
  if (format === "24h") return hhmm;
  const parts = hhmm.split(":");
  const h = Number(parts[0]);
  const m = Number(parts[1] ?? 0);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return hhmm;
  const period = h < 12 ? "AM" : "PM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${pad(m)} ${period}`;
}

// Startup hooks: defaults (unset) keep the current look (dark, 24h clock).
applyTheme(getTheme());
applyTimeFormat(getTimeFormat());
