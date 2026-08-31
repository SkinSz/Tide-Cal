// TD-011 regression tests: options-window bugs.
//   * bug 1: theme live-apply — the on-demand "options" webview must be
//     covered by a Tauri capability (without one the ACL denies emit(), so
//     the main window never receives tide:settings-changed and the theme
//     only applied after a full restart). Pinned by reading the capability
//     file — the same source-file approach the contracts tests use.
//   * bug 2: options window must render persisted values on open. Root
//     cause: Rust TideSettings serde-renames the General keys to dotted
//     TOML names (`general.theme` / `general.time_format`), which also
//     shapes the JSON IPC — the old flat mapping silently fell back to
//     defaults on load AND never persisted the General choices on save.
//     Covers the settingsFromShell / settingsToShell round-trip.
//   * bug 3: Cancel must close the window — `core:window:allow-close` is
//     NOT part of core:window:default, so the options capability must grant
//     it explicitly. Pinned alongside bug 1 in the capability assertions.
//   * bug 4 (hard-to-click titlebar X) is upstream (tauri#13440 / tao#1218,
//     fixed in tao 0.36.0; tide pins tao 0.35 via tauri-runtime-wry) —
//     documented in src-tauri/src/lib.rs, not fixable here; the capability
//     assertions below at least guarantee the options window may close
//     itself via its own Cancel button.
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

// options.ts runs void init() at import time; stub a minimal DOM so the
// import is safe in the bare vitest environment (hasTauri() is false here,
// so init is a no-op apart from the stub calls).
type El = {
  value: string;
  dataset: Record<string, string>;
  hidden: boolean;
  textContent: string;
  checked: boolean;
  addEventListener: () => void;
  focus: () => void;
};
const stubEl = (): El => ({
  value: "",
  dataset: {},
  hidden: false,
  textContent: "",
  checked: false,
  addEventListener: () => {},
  focus: () => {},
});
vi.stubGlobal("document", {
  documentElement: { dataset: {} as Record<string, string>, lang: "" },
  getElementById: () => stubEl(),
  querySelectorAll: () => [],
  querySelector: () => null,
  addEventListener: () => {},
});

const optionsModule = (await import("../frontend/options.ts")) as unknown as {
  settingsFromShell: (raw: Record<string, unknown>) => Record<string, unknown>;
  settingsToShell: (s: Record<string, unknown>) => Record<string, unknown>;
};
const settingsFromShell = optionsModule.settingsFromShell;
const settingsToShell = optionsModule.settingsToShell;
type ShellSettings = Record<string, unknown>;

// ---------------------------------------------------------------------------
// bug 2: dotted <-> flat settings mapping
// ---------------------------------------------------------------------------

// Mirrors what Rust's TideSettings serializes to over IPC (serde rename).
function shellShape(
  generalTheme: string,
  generalTimeFormat: string,
): ShellSettings {
  return {
    sync_debounce_seconds: 15.0,
    sweep_interval_minutes: 20.0,
    max_concurrent_sessions: 2.0,
    max_incremental_backlog: 500.0,
    "general.theme": generalTheme,
    "general.time_format": generalTimeFormat,
  };
}

describe("TD-011: dotted shell-key mapping (bug 2)", () => {
  it("maps the dotted IPC keys to the flat frontend keys", () => {
    const flat = settingsFromShell(shellShape("light", "12h"));
    expect(flat).toEqual({
      sync_debounce_seconds: 15.0,
      sweep_interval_minutes: 20.0,
      max_concurrent_sessions: 2.0,
      max_incremental_backlog: 500.0,
      general_theme: "light",
      general_time_format: "12h",
    });
  });

  it("falls back to flat keys when the shell ever sends those", () => {
    const flat = settingsFromShell({
      general_theme: "light",
      general_time_format: "12h",
    });
    expect(flat.general_theme).toBe("light");
    expect(flat.general_time_format).toBe("12h");
  });

  it("omits absent keys so frontend defaults still apply", () => {
    const flat = settingsFromShell({ sync_debounce_seconds: 42 });
    expect(flat.sync_debounce_seconds).toBe(42);
    expect(flat.general_theme).toBeUndefined();
    expect(flat.general_time_format).toBeUndefined();
  });

  it("round-trips flat -> shell -> flat without loss", () => {
    const original = {
      sync_debounce_seconds: 30,
      sweep_interval_minutes: 60,
      max_concurrent_sessions: 4,
      max_incremental_backlog: 2000,
      general_theme: "light",
      general_time_format: "12h",
    };
    const back = settingsFromShell(settingsToShell(original));
    expect(back).toEqual(original);
  });

  it("sends the dotted keys set_settings (serde rename) expects", () => {
    const shell = settingsToShell({
      sync_debounce_seconds: 10,
      sweep_interval_minutes: 10,
      max_concurrent_sessions: 3,
      max_incremental_backlog: 1000,
      general_theme: "light",
      general_time_format: "12h",
    });
    expect(shell).not.toHaveProperty("general_theme");
    expect(shell).not.toHaveProperty("general_time_format");
    expect(shell["general.theme"]).toBe("light");
    expect(shell["general.time_format"]).toBe("12h");
    expect(shell.sync_debounce_seconds).toBe(10);
    expect(shell.max_incremental_backlog).toBe(1000);
  });
});

// ---------------------------------------------------------------------------
// bugs 1 + 3: the options window must have a capability granting event emit
// (live-apply) and window close (Cancel)
// ---------------------------------------------------------------------------

describe("TD-011: options-window Tauri capability (bugs 1 + 3)", () => {
  const cap = JSON.parse(
    readFileSync(new URL("../src-tauri/capabilities/options.json", import.meta.url), "utf8"),
  );

  it("covers the on-demand options window label", () => {
    expect(cap.windows).toContain("options");
  });

  it("grants core:default (includes core:event:default -> allow-emit)", () => {
    expect(cap.permissions).toContain("core:default");
  });

  it("grants core:window:allow-close explicitly (not in window:default)", () => {
    // This exact gap is why Cancel did nothing: core:window:default only
    // allows getters; close() needs an explicit permission.
    expect(cap.permissions).toContain("core:window:allow-close");
  });

  it("main-window default capability still exists", () => {
    const main = JSON.parse(
      readFileSync(new URL("../src-tauri/capabilities/default.json", import.meta.url), "utf8"),
    );
    expect(main.windows).toContain("main");
    expect(main.permissions).toContain("core:default");
  });
});
