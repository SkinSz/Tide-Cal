// Build identity (TD-104): which commit a build was made from, and whether the
// working tree differed from it. Used by the sidecar bundle step (esbuild
// --define) and mirrored by src-tauri/build.rs for the desktop shell, so a
// stale or modified build is visible at a glance.
//
// label = first 12 hex digits of HEAD, plus "-dirty" when the tree has
// uncommitted changes (modified, staged or untracked-and-not-ignored files).
// src-tauri/resources/ is not counted: it holds staged copies of build output
// (the bundled backend, platform binaries), not source.
// Without git or without a repository, everything is "unknown" (never fails).
import { execFileSync } from "node:child_process";

const UNKNOWN = { commit: "unknown", dirty: false, label: "unknown" };

export function readBuildInfo(cwd = process.cwd()) {
  const git = (...args) =>
    execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  try {
    const commit = git("rev-parse", "HEAD");
    if (!/^[0-9a-f]{40,64}$/.test(commit)) return { ...UNKNOWN };
    const status = git("status", "--porcelain", "--", ":/", ":(exclude,top)src-tauri/resources");
    const dirty = status.length > 0;
    return { commit, dirty, label: commit.slice(0, 12) + (dirty ? "-dirty" : "") };
  } catch {
    return { ...UNKNOWN };
  }
}
