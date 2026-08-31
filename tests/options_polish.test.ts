// DC-20 polish regression: user-visible options copy must be free of
// internal design-contract jargon, and Cancel must close the window
// (restore values first) rather than just discarding edits.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const JARGON = [/DC-\d+/i, /§/, /contract/i, /sidecar/i, /clamped to their contract/i];

describe("options window public copy", () => {
  const html = readFileSync(new URL("../frontend/options.html", import.meta.url), "utf8");
  const ts = readFileSync(new URL("../frontend/options.ts", import.meta.url), "utf8");

  it("options.html has no internal jargon", () => {
    for (const re of JARGON) expect(html, `jargon ${re} in options.html`).not.toMatch(re);
  });

  it("options.ts has no internal jargon in user-visible strings", () => {
    // Extract every string literal (rough) and check user-facing ones.
    const literals = [...ts.matchAll(/"([^"\n]*)"|'([^'\n]*)'|`([^`\n]*)`/g)].map((m) =>
      m[1] ?? m[2] ?? m[3] ?? ""
    );
    for (const s of literals) {
      for (const re of JARGON) {
        expect(s, `jargon ${re} in options.ts string`).not.toMatch(re);
      }
    }
  });

  it("every Sync setting has a plain-English hint", () => {
    for (const id of ["opt-sync-debounce", "opt-sweep-interval", "opt-max-concurrent", "opt-backlog"]) {
      const field = html.match(new RegExp(`<label class="opt-field">[\\s\\S]*?id="${id}"[\\s\\S]*?</label>`));
      expect(field, `label for ${id}`).toBeTruthy();
      expect(field![0]).toMatch(/class="opt-hint"/);
    }
  });

  it("General category has no placeholder copy", () => {
    const general = html.match(/<section class="options-category" data-category-content="general"[\s\S]*?<\/section>/);
    expect(general).toBeTruthy();
    expect(general![0]).not.toMatch(/No general settings yet|contracts are approved|Future categories/);
  });

  it("Cancel restores values and closes the window under Tauri", () => {
    expect(ts).toMatch(/getCurrentWindow\(\)\.close\(\)/);
    // restore-before-close ordering: snapshot restore appears before close()
    const cancel = ts.slice(ts.indexOf("async function cancelEdits"));
    const restore = cancel.indexOf("savedSnapshot[f.key]");
    const close = cancel.indexOf(".close()");
    expect(restore).toBeGreaterThan(-1);
    expect(close).toBeGreaterThan(restore);
  });
});
