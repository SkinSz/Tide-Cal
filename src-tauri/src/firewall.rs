// Tide DC-24 §6: Windows firewall ruleset check/create (Windows only).
//
// Binding facts (DC-24 §6, owner-approved 2026-10-11):
//   §6.1 Check mechanism: netsh child process, filtered for OUR marker rule
//        names ("Tide mDNS" / "Tide sync") — never a generic "mentions
//        tide.exe" heuristic (other software's uninstallers must not be
//        able to satisfy our check).
//   §6.2 Timing: called at app startup (tray up); re-checked lazily at
//        first sync enablement. Cheap (one netsh child), one log line.
//   §6.3 Scope: exactly TWO inbound allow rules, scoped to the tide
//        executable: "Tide mDNS" (inbound UDP 5353, DC-11 discovery) and
//        "Tide sync" (inbound TCP 47471 = SYNC_DEFAULT_PORT imported from
//        the shared constant — never re-hardcoded here). No outbound
//        rules (default outbound = allow), no modification of existing
//        rules. Idempotent: create only when absent.
//   §6.4 UAC: rule creation goes through ONE elevated child process
//        (ShellExecuteW "runas"); refusal → degraded mode (sync disabled,
//        persistent dismissible notice + explicit "Try again"; NEVER a
//        silent retry loop). netsh check failure → same degraded mode
//        (fail-visible, never fail-silent, never fail-open).
//   §6.5 Uninstall: NSIS uninstaller removes the owned rules (elevated).
//        This module exposes check/create only; deletion is uninstaller-
//        side (NSIS script).
//
// Failure posture: all paths log one line; the module never panics and
// never blocks app startup — the firewall check result only gates SYNC.

#![cfg(windows)]

use std::path::PathBuf;

/// Marker rule names owned by Tide (DC-24 §6.3). Other software must not
/// be able to satisfy our check, hence exact-name matching only.
pub const RULE_NAME_MDNS: &str = "Tide mDNS";
pub const RULE_NAME_SYNC: &str = "Tide sync";

/// Sync TCP port for the "Tide sync" rule. IMPORTED from the shared
/// constant (src/network/sync_runtime.ts SYNC_DEFAULT_PORT = 47471) —
/// DC-24 §6.3: never re-hardcoded. The sidecar contract is the source of
/// truth; the Rust side mirrors it via the same named constant in lib.rs.
///
/// Known divergence (review note #11): TIDE_SYNC_PORT env overrides the
/// sidecar's LISTEN port but the rule stays pinned at the default 47471.
/// The override is a power-user hook (DC-15 §3.3); power users manage
/// their own firewall. Documented, not silently wrong.
pub fn sync_default_port() -> u16 {
    crate::SYNC_PORT_DEFAULT
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FirewallState {
    /// Both marker rules present.
    RulesPresent,
    /// At least one marker rule missing → need creation.
    RulesMissing,
    /// The netsh check itself failed (missing/unparseable) → degraded.
    CheckFailed,
}

impl FirewallState {
    /// One log line per check (DC-24 §6.2).
    pub fn as_log_str(self) -> &'static str {
        match self {
            FirewallState::RulesPresent => "rules present",
            FirewallState::RulesMissing => "rules missing",
            FirewallState::CheckFailed => "check failed",
        }
    }
}

/// Parse `netsh advfirewall firewall show rule name=all` output for our
/// marker rules. The output is localized on non-English Windows, so we do
/// NOT parse field labels ("Rule Name:") — we match the rule-name VALUE
/// portion. Tightened per review fix #8: the name must appear as a LINE-
/// ANCHORED token — either the whole trimmed line (netsh prints the value
/// on the label line) or preceded by a colon/whitespace run and followed
/// by end-of-line. A rule name line contains our exact name; the
/// program-scoped check (rule applies to tide.exe) happens on creation,
/// and the marker names are unique to Tide by convention.
///
/// Honest limitation (documented): a hostile local process could pre-create
/// rules with these exact names to spoof "rules present". Same-user
/// attackers are out of scope per the DC-17 §7B custody assumption; the
/// consequence is bounded (sync stays enabled, rules don't actually point
/// at tide.exe) and detectable in `netsh` output. Not a security boundary.
fn parse_rule_names(output: &str) -> (bool, bool) {
    let name_anchored = |line: &str, name: &str| -> bool {
        let t = line.trim();
        // The value line may be "Rule Name:  Tide sync" (label + value) or
        // rarely the bare value. Accept: exact-equal trimmed line, or the
        // name preceded by "label:" + optional whitespace to end-of-line.
        t == name
            || t.rfind(':')
                .map(|i| t[i + 1..].trim() == name)
                .unwrap_or(false)
    };
    let mut mdns = false;
    let mut sync = false;
    for line in output.lines() {
        if name_anchored(line, RULE_NAME_MDNS) {
            mdns = true;
        }
        if name_anchored(line, RULE_NAME_SYNC) {
            sync = true;
        }
    }
    (mdns, sync)
}

/// Run the §6.1 check via one netsh child process.
pub fn check_rules() -> FirewallState {
    let output = match std::process::Command::new("netsh")
        .args(["advfirewall", "firewall", "show", "rule", "name=all"])
        .output()
    {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout).into_owned(),
        Ok(o) => {
            log::warn!(
                "firewall check: netsh exited {:?}; treating as CheckFailed (DC-24 §6.4)",
                o.status.code()
            );
            return FirewallState::CheckFailed;
        }
        Err(e) => {
            log::warn!("firewall check: netsh spawn failed: {e}; treating as CheckFailed (DC-24 §6.4)");
            return FirewallState::CheckFailed;
        }
    };
    let (mdns, sync) = parse_rule_names(&output);
    if mdns && sync {
        log::info!("firewall check: {}", FirewallState::RulesPresent.as_log_str());
        FirewallState::RulesPresent
    } else {
        log::info!(
            "firewall check: {} (mdns={mdns} sync={sync})",
            FirewallState::RulesMissing.as_log_str()
        );
        FirewallState::RulesMissing
    }
}

/// Build the netsh arg vector for ONE marker rule (idempotent: the caller
/// checks first; `new` naming is chosen so a duplicate create fails loudly
/// rather than silently replacing a foreign rule).
fn rule_args(name: &str, proto: &str, port: u16, exe: &PathBuf) -> Vec<String> {
    vec![
        "advfirewall".into(),
        "firewall".into(),
        "add".into(),
        "rule".into(),
        format!("name={name}"),
        "dir=in".into(),
        "action=allow".into(),
        format!("program={}", exe.display()),
        format!("protocol={proto}"),
        format!("localport={port}"),
        "enable=yes".into(),
        "profile=any".into(),
    ]
}

/// Create both marker rules through ONE UAC-elevated netsh invocation
/// (DC-24 §6.4: a single elevation, not per-rule). Returns Ok(()) when the
/// elevated child spawned AND the rules are subsequently present; any
/// refusal/failure maps to Err → the caller enters degraded mode.
pub fn create_rules(effective_exe: PathBuf) -> Result<(), FirewallError> {
    let port = sync_default_port();
    let script = format!(
        "netsh advfirewall firewall add rule {} && netsh advfirewall firewall add rule {}",
        shell_quote_args(&rule_args(RULE_NAME_MDNS, "udp", 5353, &effective_exe)),
        shell_quote_args(&rule_args(RULE_NAME_SYNC, "tcp", port, &effective_exe)),
    );

    // ShellExecuteW "runas" is the ONLY supported elevation prompt path.
    // We route through PowerShell Start-Process -Verb RunAs: a single
    // elevated cmd.exe running both netsh commands.
    let ps_script = format!(
        "Start-Process -FilePath 'cmd.exe' -ArgumentList '/c {}' -Verb RunAs -Wait -WindowStyle Hidden",
        script.replace('\'', "''")
    );
    let status = std::process::Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-WindowStyle",
            "Hidden",
            "-Command",
            &ps_script,
        ])
        .output();
    match status {
        Ok(o) if o.status.success() => {}
        Ok(o) => {
            log::warn!(
                "firewall create: elevated child exited {:?} (UAC refused or netsh error); degraded mode (DC-24 §6.4)",
                o.status.code()
            );
            return Err(FirewallError::ElevationRefused);
        }
        Err(e) => {
            log::warn!("firewall create: elevation spawn failed: {e}; degraded mode (DC-24 §6.4)");
            return Err(FirewallError::ElevationRefused);
        }
    }

    // Verify post-create (fail-visible): re-check; report honestly if the
    // rules STILL aren't there (some AV/endpoint tools block netsh writes).
    if check_rules() != FirewallState::RulesPresent {
        log::warn!("firewall create: elevation reported success but rules still absent; degraded mode (DC-24 §6.4)");
        return Err(FirewallError::CreateUnverified);
    }
    log::info!("firewall create: both rules present; sync inbound allowed");
    Ok(())
}

#[derive(Debug)]
pub enum FirewallError {
    /// UAC refused / elevation could not run → degraded mode.
    ElevationRefused,
    /// Elevation ran but verification found the rules absent.
    CreateUnverified,
}

/// Quote ONE argv vector for a cmd.exe /c line. cmd.exe metacharacters
/// (& | < > ^ %) inside the quoted program path would be interpreted by
/// cmd even inside double quotes (review fix #9): escape carets for every
/// cmd metachar, and double the double-quote per MSVCRT rules. Our arg
/// vectors are all self-generated constants except `program=<path>` —
/// this keeps a path with spaces (e.g. C:\Program Files\Tide\tide.exe)
/// or cmd-hostile characters intact as ONE argument.
fn shell_quote_args(args: &[String]) -> String {
    args.iter()
        .map(|a| {
            if a.is_empty() || a.contains(' ') || a.contains('"') {
                let inner = a
                    .replace('^', "^^")
                    .replace('&', "^&")
                    .replace('|', "^|")
                    .replace('<', "^<")
                    .replace('>', "^>")
                    .replace('%', "^%")
                    .replace('"', "\\\"");
                format!("\"{inner}\"")
            } else {
                a.clone()
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}
