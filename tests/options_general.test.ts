// DC-20 General options: theme (manual Light/Dark), time format (12h/24h).
// Covers: settings round-trip keys, theme application, time-format rendering,
// and the options-window wiring that live-applies both on Save.
import { describe, expect, it, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// theme.ts: functional tests against a minimal document/localStorage stub.
// ---------------------------------------------------------------------------
type Listener = (e: unknown) => void;

function installDomStub(): {
  documentElement: { dataset: Record<string, string>; lang: string };
  store: Map<string, string>;
  listeners: Map<string, Set<Listener>>;
} {
  const documentElement = { dataset: {} as Record<string, string>, lang: "" };
  const store = new Map<string, string>();
  const listeners = new Map<string, Set<Listener>>();
  vi.stubGlobal("document", {
    documentElement,
    addEventListener: (t: string, fn: Listener) => {
      if (!listeners.has(t)) listeners.set(t, new Set());
      listeners.get(t)!.add(fn);
    },
  });
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  });
  vi.stubGlobal("window", { setTimeout, clearTimeout });
  return { documentElement, store, listeners };
}

let dom: ReturnType<typeof installDomStub>;

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
  dom = installDomStub();
});

async function themeModule() {
  return import("../frontend/theme.ts");
}

describe("theme: manual light/dark choice", () => {
  it("defaults to dark when nothing is stored", async () => {
    const t = await themeModule();
    expect(t.getTheme()).toBe("dark");
  });

  it("setTheme persists to the frontend cache and stamps <html>", async () => {
    const t = await themeModule();
    t.setTheme("light");
    expect(dom.store.get("tide.theme")).toBe("light");
    expect(dom.documentElement.dataset.theme).toBe("light");
    t.setTheme("dark");
    expect(dom.documentElement.dataset.theme).toBe("dark");
  });

  it("applyTheme stamps the attribute without touching storage", async () => {
    const t = await themeModule();
    t.applyTheme("light");
    expect(dom.documentElement.dataset.theme).toBe("light");
    expect(dom.store.has("tide.theme")).toBe(false);
  });

  it("round-trips: stored value is read back at startup", async () => {
    dom.store.set("tide.theme", "light");
    const t = await themeModule();
    expect(t.getTheme()).toBe("light");
    expect(dom.documentElement.dataset.theme).toBe("light");
  });
});

describe("time format: 12h rendering, 24h internal", () => {
  it("defaults to 24h", async () => {
    const t = await themeModule();
    expect(t.getTimeFormat()).toBe("24h");
  });

  it("labels render as h:mm AM/PM in 12h mode", async () => {
    const t = await themeModule();
    expect(t.formatTimeLabel("09:00", "12h")).toBe("9:00 AM");
    expect(t.formatTimeLabel("00:15", "12h")).toBe("12:15 AM");
    expect(t.formatTimeLabel("12:00", "12h")).toBe("12:00 PM");
    expect(t.formatTimeLabel("13:45", "12h")).toBe("1:45 PM");
    expect(t.formatTimeLabel("23:59", "12h")).toBe("11:59 PM");
  });

  it("24h labels keep the internal HH:MM string verbatim", async () => {
    const t = await themeModule();
    for (const v of ["00:00", "09:00", "13:45", "23:45"]) {
      expect(t.formatTimeLabel(v, "24h")).toBe(v);
    }
  });

  it("applyTimeFormat stamps the mode; lang stays 24h-friendly (AM/PM is a button)", async () => {
    const t = await themeModule();
    t.applyTimeFormat("12h");
    expect(dom.documentElement.dataset.timeFormat).toBe("12h");
    // 12h presentation is carried by the .ampm-toggle button + dropdown;
    // the document language stays en-GB so the native suffix never renders.
    expect(dom.documentElement.lang).toBe("en-GB");
    t.applyTimeFormat("24h");
    expect(dom.documentElement.dataset.timeFormat).toBe("24h");
    expect(dom.documentElement.lang).toBe("en-GB");
  });

  it("setTimeFormat persists to the frontend cache", async () => {
    const t = await themeModule();
    t.setTimeFormat("12h");
    expect(dom.store.get("tide.time_format")).toBe("12h");
    expect(t.getTimeFormat()).toBe("12h");
  });

  it("startup applies both stored preferences", async () => {
    dom.store.set("tide.theme", "light");
    dom.store.set("tide.time_format", "12h");
    await themeModule();
    expect(dom.documentElement.dataset.theme).toBe("light");
    expect(dom.documentElement.dataset.timeFormat).toBe("12h");
    expect(dom.documentElement.lang).toBe("en-GB");
  });
});

// ---------------------------------------------------------------------------
// Options window wiring + copy.
// ---------------------------------------------------------------------------
const optionsHtml = readFileSync(
  new URL("../frontend/options.html", import.meta.url),
  "utf8",
);
const optionsTs = readFileSync(
  new URL("../frontend/options.ts", import.meta.url),
  "utf8",
);
const dialogTs = readFileSync(
  new URL("../frontend/dialog.ts", import.meta.url),
  "utf8",
);
const mainTs = readFileSync(
  new URL("../frontend/main.ts", import.meta.url),
  "utf8",
);
const styleCss = readFileSync(
  new URL("../frontend/style.css", import.meta.url),
  "utf8",
);

describe("options window: General category", () => {
  it("offers a manual Light/Dark choice (no system-follow option)", () => {
    const group = optionsHtml.match(
      /<fieldset[^>]*id="opt-theme-group"[\s\S]*?<\/fieldset>/,
    );
    expect(group).toBeTruthy();
    expect(group![0]).toMatch(/value="dark"/);
    expect(group![0]).toMatch(/value="light"/);
    expect(group![0]).not.toMatch(/system|automatic/i);
    expect(group![0]).toMatch(/class="opt-hint"/);
  });

  it("offers a 12h/24h choice with a hint", () => {
    const group = optionsHtml.match(
      /<fieldset[^>]*id="opt-time-format-group"[\s\S]*?<\/fieldset>/,
    );
    expect(group).toBeTruthy();
    expect(group![0]).toMatch(/value="24h"/);
    expect(group![0]).toMatch(/value="12h"/);
    expect(group![0]).toMatch(/class="opt-hint"/);
  });

  it("General copy is plain English (no internal jargon)", () => {
    const general = optionsHtml.match(
      /<section class="options-category" data-category-content="general"[\s\S]*?<\/section>/,
    )!;
    for (const re of [/DC-\d+/i, /§/, /sidecar/i, /localStorage/i, /TIDE_/]) {
      expect(general[0], `jargon ${re}`).not.toMatch(re);
    }
  });

  it("Save round-trips the General settings keys", () => {
    expect(optionsTs).toMatch(/general_theme/);
    expect(optionsTs).toMatch(/general_time_format/);
    // read into pending before persisting, applied after a clean save
    expect(optionsTs).toMatch(/readGeneral\(pending\)/);
    expect(optionsTs.indexOf("readGeneral(pending)")).toBeLessThan(
      optionsTs.indexOf('invoke("set_settings"'),
    );
  });

  it("Save live-applies: this window immediately, main window via event", () => {
    expect(optionsTs).toMatch(/applyGeneralLive\(pending\)/);
    expect(optionsTs).toMatch(/setTheme\(/);
    expect(optionsTs).toMatch(/setTimeFormat\(/);
    expect(optionsTs).toMatch(/emit\("tide:settings-changed"/);
    // main window listens and re-applies (theme + time format)
    expect(mainTs).toMatch(/listen<GeneralChange>\("tide:settings-changed"/);
    expect(mainTs).toMatch(/setTheme\(/);
    expect(mainTs).toMatch(/setTimeFormat\(/);
  });

  it("Cancel restores saved General values (radios in the snapshot flow)", () => {
    expect(optionsTs).toMatch(/savedSnapshot/);
  });
});

describe("event dialog: 12h display, 24h storage", () => {
  it("dropdown labels render in the chosen clock style", () => {
    expect(dialogTs).toMatch(/formatTimeLabel\(slot, fmt\)/);
    expect(dialogTs).toMatch(/getTimeFormat\(\)/);
  });

  it("committed values stay internal 24h (option carries the slot value)", () => {
    expect(dialogTs).toMatch(/opt\.dataset\.value = slot/);
    expect(dialogTs).toMatch(/inp\.value = slot/);
  });

  it("AM/PM native suffix is suppressed unconditionally (toggle button owns it)", () => {
    // Owner design 2026-08-31: exactly one AM/PM surface — the
    // .ampm-toggle button; the native shadow-DOM field is always hidden.
    const rule = styleCss.match(
      /input\[type="time"\]::-webkit-datetime-edit-ampm-field\s*\{\s*display:\s*none/,
    );
    expect(rule).not.toBeNull();
    expect(styleCss).toMatch(/\.ampm-toggle\s*\{/);
  });

  it("index.html default document language remains 24h-friendly", () => {
    const html = readFileSync(
      new URL("../frontend/index.html", import.meta.url),
      "utf8",
    );
    expect(html).toMatch(/<html lang="en-GB"/);
  });
});
