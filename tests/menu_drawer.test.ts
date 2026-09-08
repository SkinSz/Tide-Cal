// Tide: burger-menu drawer — regression test for the hidden-attribute bug.
// The drawer's `display: flex` rule overrode the HTML `hidden` attribute
// (hidden only wins when no CSS display is set), leaving the drawer stuck
// open: X, Escape, and backdrop all ran setOpen(false) but the element kept
// painting. This test pins the guard rules that make hidden always win.
import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const css = readFileSync(join(import.meta.dirname, "../frontend/style.css"), "utf8");
const html = readFileSync(join(import.meta.dirname, "../frontend/index.html"), "utf8");
const menu = readFileSync(join(import.meta.dirname, "../frontend/menu.ts"), "utf8");

describe("burger drawer: hidden attribute must always win", () => {
  test("explicit [hidden] display:none guard exists for drawer and backdrop", () => {
    expect(css).toMatch(/#menu-drawer\[hidden\][^{]*\{[^}]*display:\s*none/);
    expect(css).toMatch(/#menu-backdrop\[hidden\][^{]*\{[^}]*display:\s*none/);
  });

  test("drawer and backdrop start hidden in the markup", () => {
    expect(html).toMatch(/<nav id="menu-drawer"[^>]*hidden/);
    expect(html).toMatch(/<div id="menu-backdrop"[^>]*hidden/);
  });

  test("setOpen toggles hidden on both elements (close paths wired)", () => {
    expect(menu).toMatch(/drawer\.hidden\s*=\s*!open/);
    expect(menu).toMatch(/backdrop\.hidden\s*=\s*!open/);
    // close paths: X button, backdrop click, Escape
    expect(menu).toMatch(/btn-menu-close/);
    expect(menu).toMatch(/menu-backdrop.*setOpen\(false\)/s);
    expect(menu).toMatch(/"Escape"/);
  });

  test("export moved into the drawer; toolbar export button removed", () => {
    expect(html).toMatch(/id="menu-export"/);
    expect(html).not.toMatch(/id="btn-export"/);
  });
});
