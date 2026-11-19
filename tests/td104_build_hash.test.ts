// TD-104: the app logs its git commit hash at startup and shows it in an
// About screen, so a stale or modified build is visible immediately.
//
// INTENDED DESIGN (tests are written against this interface; none exists yet):
//   * scripts/build_info.mjs exports readBuildInfo(cwd) -> { commit, dirty, label }
//       commit: full 40-hex HEAD hash; dirty: working tree differs from HEAD
//       (tracked changes, staged changes, or untracked non-ignored files);
//       label: short hash, with "-dirty" appended when dirty.
//     It is used by BOTH builds: `sidecar:build` passes it to esbuild as
//     --define (compiled into dist/sidecar.mjs), and src-tauri/build.rs
//     does the equivalent (git rev-parse / git status) and emits
//     `cargo:rustc-env=TIDE_BUILD_COMMIT=<label>`.
//   * the sidecar logs "[tide] build <label>" to stderr at startup and
//     answers the new op `build_info` -> { version, commit, dirty, label }.
//   * options window: an "About" category shows the sidecar label AND the
//     shell label (two values: a stale Rust binary vs a stale sidecar copy
//     show up as different labels).
//   * the new op needs all three seams: sidecar case, Rust sync_op ALLOWED.
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  REPO_ROOT,
  RealSidecar,
  buildSidecar,
  freePort,
  removeBuild,
} from "./real_sidecar.ts";

const LABEL_RE = /^[0-9a-f]{7,40}(-dirty)?$/;
const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

// ---------------------------------------------------------------------------
// (c) dirty marking, against real temporary git repositories
// ---------------------------------------------------------------------------
describe("TD-104 (c): readBuildInfo marks a modified tree", () => {
  let repo: string;
  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "tide-td104-repo-"));
    git(repo, "init", "-q");
    git(repo, "config", "user.email", "t@example.invalid");
    git(repo, "config", "user.name", "t");
    writeFileSync(join(repo, "a.txt"), "one\n");
    git(repo, "add", "a.txt");
    git(repo, "commit", "-q", "-m", "init");
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  // Dynamic import with a variable path: the module does not exist yet, so
  // tsc must not try to resolve it; at runtime the import fails (red).
  const load = async (): Promise<{
    readBuildInfo(cwd: string): { commit: string; dirty: boolean; label: string };
  }> => {
    const p = join(REPO_ROOT, "scripts", "build_info.mjs");
    return import(/* @vite-ignore */ p);
  };

  test("clean tree: label is the short hash of HEAD, no suffix", async () => {
    const { readBuildInfo } = await load();
    const head = git(repo, "rev-parse", "HEAD");
    const info = readBuildInfo(repo);
    expect(info.commit).toBe(head);
    expect(info.dirty).toBe(false);
    expect(info.label).toMatch(LABEL_RE);
    expect(info.label.endsWith("-dirty")).toBe(false);
    expect(head.startsWith(info.label)).toBe(true);
  });

  test("modified tracked file: label ends with -dirty, hash unchanged", async () => {
    const { readBuildInfo } = await load();
    writeFileSync(join(repo, "a.txt"), "two\n");
    const info = readBuildInfo(repo);
    expect(info.commit).toBe(git(repo, "rev-parse", "HEAD"));
    expect(info.dirty).toBe(true);
    expect(info.label.endsWith("-dirty")).toBe(true);
    git(repo, "checkout", "--", "a.txt");
  });

  test("untracked new file also counts as dirty; back to clean afterwards", async () => {
    const { readBuildInfo } = await load();
    writeFileSync(join(repo, "new.txt"), "x\n");
    expect(readBuildInfo(repo).label.endsWith("-dirty")).toBe(true);
    rmSync(join(repo, "new.txt"));
    expect(readBuildInfo(repo).label.endsWith("-dirty")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// (a) startup log and (b) the info op, on a REAL built sidecar
// ---------------------------------------------------------------------------
describe("TD-104 (a)/(b): the built sidecar reports the commit it was built from", () => {
  const TAG = "td104-build";
  let bundle = "";
  let sc: RealSidecar;
  beforeAll(async () => {
    bundle = buildSidecar(TAG);
    sc = new RealSidecar("td104", bundle, await freePort());
    sc.start();
    await sc.ready();
  }, 120_000);
  afterAll(async () => {
    await sc?.stop();
    removeBuild(TAG);
  });

  // Independent oracle: ask git directly, never the code under test.
  const headFull = (): string => git(REPO_ROOT, "rev-parse", "HEAD");
  const treeDirty = (): boolean => git(REPO_ROOT, "status", "--porcelain").length > 0;

  test("(a) startup writes the build label to stderr (not stdout)", () => {
    const line = sc.stderr.find((l) => /^\[tide\] build /.test(l));
    expect(line, `no "[tide] build <label>" line in stderr:\n${sc.stderr.join("\n")}`).toBeDefined();
    const label = line!.replace(/^\[tide\] build /, "").trim().split(/\s+/)[0]!;
    expect(label).toMatch(LABEL_RE);
    expect(headFull().startsWith(label.replace(/-dirty$/, ""))).toBe(true);
    expect(label.endsWith("-dirty")).toBe(treeDirty());
  });

  test("(b) build_info op returns version, full commit, dirty flag and label", async () => {
    const info = await sc.rpc("build_info");
    expect(info.commit).toBe(headFull());
    expect(info.dirty).toBe(treeDirty());
    expect(info.label).toMatch(LABEL_RE);
    expect(info.label).toBe(info.commit.slice(0, info.label.replace(/-dirty$/, "").length) + (info.dirty ? "-dirty" : ""));
    expect(info.version).toBe(JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")).version);
  });
});

// ---------------------------------------------------------------------------
// (b) UI wiring and the shell (source-level: no GUI/Tauri runtime in vitest)
// ---------------------------------------------------------------------------
describe("TD-104 (b): About screen and shell wiring", () => {
  const read = (p: string) => readFileSync(join(REPO_ROOT, p), "utf8");

  test("options window has an About category with a build label element", () => {
    const html = read("frontend/options.html");
    expect(html).toMatch(/data-category="about"/);
    expect(html).toMatch(/data-category-content="about"/);
    expect(html).toMatch(/id="about-build"/);
    expect(html).toMatch(/id="about-shell-build"/);
  });

  test("options.ts fills it from the build_info op", () => {
    const ts = read("frontend/options.ts");
    expect(ts).toMatch(/build_info/);
    expect(ts).toMatch(/about-build/);
  });

  test("shell: build_info is in the sync_op allow-list (seam 2)", () => {
    const src = read("src-tauri/src/lib.rs");
    const start = src.indexOf("const ALLOWED: [&str; ");
    const list = src.slice(start, start + src.slice(start).indexOf("];"));
    expect(list).toContain('"build_info",');
  });

  test("shell: build.rs embeds the commit label for the Rust binary", () => {
    const rs = read("src-tauri/build.rs");
    expect(rs).toMatch(/rev-parse/);
    expect(rs).toMatch(/cargo:rustc-env=TIDE_BUILD_COMMIT=/);
    expect(rs).toMatch(/-dirty/);
  });

  test("About text has no internal jargon", () => {
    const html = read("frontend/options.html");
    const about = html.match(/data-category-content="about"[\s\S]*?<\/section>/);
    expect(about, "About section missing").not.toBeNull();
    expect(about![0]).not.toMatch(/sidecar|DC-|§|contract/i);
  });
});
