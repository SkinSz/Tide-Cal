// Theme + general-look preferences. The options window (General category)
// owns the choice; both windows keep a localStorage cache so the look is
// right at startup, while config.toml (via Tauri settings) is the
// authoritative store. The theme is a plain manual Light/Dark choice —
// deliberately no system-follow, no auto-detection.
export type Theme = "dark" | "light";
export type TimeFormat = "24h" | "12h";

const LS_KEY = "tide.theme";
const TF_KEY = "tide.time_format";

export function getTheme(): Theme {
  return localStorage.getItem(LS_KEY) === "light" ? "light" : "dark";
}

export function setTheme(theme: Theme): void {
  localStorage.setItem(LS_KEY, theme);
  applyTheme(theme);
}

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
}

export function getTimeFormat(): TimeFormat {
  return localStorage.getItem(TF_KEY) === "12h" ? "12h" : "24h";
}

export function setTimeFormat(format: TimeFormat): void {
  localStorage.setItem(TF_KEY, format);
  applyTimeFormat(format);
}

/**
 * Stamp the clock style on <html>. The data attribute scopes the 24h CSS
 * backstops in style.css; the lang attribute drives WebKitGTK's native
 * <input type="time"> rendering (en-GB = 24h, en-US = AM/PM). The input's
 * value stays 24h "HH:MM" either way, so commit/read code is untouched.
 */
export function applyTimeFormat(format: TimeFormat): void {
  const root = document.documentElement;
  root.dataset.timeFormat = format;
  root.lang = format === "12h" ? "en-US" : "en-GB";
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
