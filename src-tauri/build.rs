// TD-104: embed the commit this shell was built from (TIDE_BUILD_COMMIT), in
// the same format as scripts/build_info.mjs: first 12 hex digits of HEAD,
// "-dirty" when the working tree has uncommitted changes (src-tauri/resources/
// is ignored: it holds staged build output), or "unknown" when git or the
// repository is not available. Never fails the build.
use std::process::Command;

fn git(args: &[&str]) -> Option<String> {
    let out = Command::new("git").args(args).output().ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

fn build_label() -> String {
    let commit = match git(&["rev-parse", "HEAD"]) {
        Some(c) if c.len() >= 40 && c.chars().all(|ch| ch.is_ascii_hexdigit()) => c,
        _ => return "unknown".to_string(),
    };
    let dirty = git(&["status", "--porcelain", "--", ":/", ":(exclude,top)src-tauri/resources"])
        .map(|s| !s.is_empty())
        .unwrap_or(false);
    format!("{}{}", &commit[..12], if dirty { "-dirty" } else { "" })
}

fn main() {
    println!("cargo:rustc-env=TIDE_BUILD_COMMIT={}", build_label());
    // Re-run when the commit or the sources change, so the label is not stale.
    for p in ["HEAD", "index"] {
        if let Some(path) = git(&["rev-parse", "--git-path", p]) {
            println!("cargo:rerun-if-changed={path}");
        }
    }
    for p in ["../src", "../frontend", "../scripts", "../package.json", "src"] {
        println!("cargo:rerun-if-changed={p}");
    }
    tauri_build::build()
}
