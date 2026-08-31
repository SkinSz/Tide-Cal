// Theme infrastructure for the future light/dark setting (DC: General
// settings in the options window will own the toggle; for now we just read
// the stored preference and stamp <html data-theme="...">).
export type Theme = "dark" | "light";

const LS_KEY = "tide.theme";

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

// Startup hook: default (unset) keeps the current look (dark).
applyTheme(getTheme());
