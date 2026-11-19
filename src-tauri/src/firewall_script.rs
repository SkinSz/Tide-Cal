// DC-24 §6.3/§6.4: platform-neutral builder for the elevated firewall-rule
// creation command. Pure functions only, so Linux CI tests them; the
// Windows-only caller lives in firewall.rs.
//
// Why this exists (bug #1b, 2026-11-13): the previous wrapper passed the
// netsh lines through FOUR parsers (Rust argv quoting → powershell -Command
// → Start-Process -ArgumentList string → cmd /c "… && …") and threw away the
// elevated child's output. On a real Windows 11 PC the UAC prompt appeared,
// the child "succeeded", and no rule existed, while the SAME netsh lines
// typed into an elevated cmd worked. Now:
//   - the elevated program is powershell.exe with -EncodedCommand (Base64 of
//     UTF-16LE): no quoting layer can reinterpret a character, any Unicode
//     path (user names with spaces/umlauts) survives;
//   - inside, netsh is called directly; each rule's netsh exit code becomes
//     the process exit code, which Tide logs (fail-visible);
//   - only the MISSING rules are created (idempotent, no duplicates).

#![allow(dead_code)] // the caller is Windows-only

use std::path::{Path, PathBuf};

/// A rule to create: (marker name, protocol, local port, program path).
pub struct RuleSpec<'a> {
    pub name: &'a str,
    pub protocol: &'a str,
    pub port: u16,
    pub program: &'a Path,
}

/// `\\?\C:\x` → `C:\x`, `\\?\UNC\srv\x` → `\\srv\x`. Windows Firewall
/// matches rules against the plain DOS path of the running image; a
/// verbatim-prefixed path (what Tauri's resource_dir() returns) would
/// never match.
pub fn plain_windows_path(p: &Path) -> PathBuf {
    let s = p.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        PathBuf::from(format!(r"\\{rest}"))
    } else if let Some(rest) = s.strip_prefix(r"\\?\") {
        PathBuf::from(rest.to_string())
    } else {
        p.to_path_buf()
    }
}

/// PowerShell expression that yields `s` without `s` ever touching the
/// PowerShell parser: Base64 of UTF-16LE, decoded at run time. A quoting
/// approach is not enough: PowerShell also treats U+2018..U+201B as
/// single quotes, so a path like `C:\Users\O’Neil` would break out of a
/// '…' literal (review 2026-11-14, finding 2). Base64 has no quote chars.
fn ps_decoded(s: &str) -> String {
    format!(
        "([Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('{}')))",
        encode_command(s)
    )
}

/// The script run ELEVATED. Exit code: 0 = all requested rules added;
/// 10 + i = netsh failed on rule i (0-based), with netsh's own code lost
/// only in the sense that it is non-zero.
pub fn elevated_script(rules: &[RuleSpec]) -> Result<String, String> {
    let mut out = String::new();
    for (i, r) in rules.iter().enumerate() {
        let program = plain_windows_path(r.program);
        let program = program.to_string_lossy();
        if program.is_empty() || program.contains(['"', '\r', '\n']) {
            return Err(format!("unusable program path for rule \"{}\"", r.name));
        }
        if !matches!(r.protocol, "tcp" | "udp") {
            return Err(format!("bad protocol {}", r.protocol));
        }
        out.push_str(&format!(
            "& netsh.exe advfirewall firewall add rule {} dir=in action=allow {} protocol={} localport={} enable=yes profile=any\r\nif ($LASTEXITCODE -ne 0) {{ exit {} }}\r\n",
            ps_decoded(&format!("name={}", r.name)),
            ps_decoded(&format!("program={program}")),
            r.protocol,
            r.port,
            10 + i
        ));
    }
    out.push_str("exit 0\r\n");
    Ok(out)
}

/// `-EncodedCommand` payload: Base64 of the UTF-16LE script.
pub fn encode_command(script: &str) -> String {
    let bytes: Vec<u8> = script.encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
    base64(&bytes)
}

/// Non-elevated launcher command (argument to `powershell.exe -Command`).
/// It contains ONLY fixed text plus Base64 ([A-Za-z0-9+/=]), so no quoting
/// layer can alter it. Start-Process -Verb RunAs = ShellExecute "runas"
/// (DC-24 §6.4, one UAC prompt); -PassThru + exit propagates the elevated
/// script's exit code; a refused UAC prompt throws → exit 1223
/// (ERROR_CANCELLED).
pub fn launcher_command(encoded: &str) -> String {
    debug_assert!(encoded.bytes().all(|b| b.is_ascii_alphanumeric() || b"+/=".contains(&b)));
    format!(
        "try {{ $p = Start-Process -FilePath 'powershell.exe' -ArgumentList '-NoProfile','-NonInteractive','-EncodedCommand','{encoded}' -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ErrorAction Stop; exit $p.ExitCode }} catch {{ exit 1223 }}"
    )
}

fn base64(data: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        out.push(T[(n >> 18) as usize & 63] as char);
        out.push(T[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { T[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { T[n as usize & 63] as char } else { '=' });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_matches_rfc4648_vectors() {
        for (i, o) in [("", ""), ("f", "Zg=="), ("fo", "Zm8="), ("foo", "Zm9v"), ("foob", "Zm9vYg=="), ("fooba", "Zm9vYmE="), ("foobar", "Zm9vYmFy")] {
            assert_eq!(base64(i.as_bytes()), o);
        }
    }

    #[test]
    fn encoded_command_is_utf16le() {
        // PowerShell docs example: 'dir "c:\program files" ' encodes to this.
        assert_eq!(
            encode_command("dir \"c:\\program files\" "),
            "ZABpAHIAIAAiAGMAOgBcAHAAcgBvAGcAcgBhAG0AIABmAGkAbABlAHMAIgAgAA=="
        );
    }

    #[test]
    fn verbatim_prefix_is_stripped() {
        assert_eq!(plain_windows_path(Path::new(r"\\?\C:\Users\A B\Tide\node.exe")), PathBuf::from(r"C:\Users\A B\Tide\node.exe"));
        assert_eq!(plain_windows_path(Path::new(r"\\?\UNC\srv\share\t.exe")), PathBuf::from(r"\\srv\share\t.exe"));
        assert_eq!(plain_windows_path(Path::new(r"C:\x\tide.exe")), PathBuf::from(r"C:\x\tide.exe"));
    }

    #[test]
    fn script_scopes_each_rule_to_its_own_program() {
        let tide = PathBuf::from(r"C:\Users\Jörg O'Neil\AppData\Local\Tide\tide.exe");
        let node = PathBuf::from(r"\\?\C:\Users\Jörg O'Neil\AppData\Local\Tide\node.exe");
        let s = elevated_script(&[
            RuleSpec { name: "Tide mDNS", protocol: "udp", port: 5353, program: &tide },
            RuleSpec { name: "Tide sync", protocol: "tcp", port: 47471, program: &node },
        ])
        .unwrap();
        let arg = |v: &str| ps_decoded(v);
        assert!(s.contains(&format!("{} dir=in action=allow {} protocol=udp localport=5353", arg("name=Tide mDNS"), arg(r"program=C:\Users\Jörg O'Neil\AppData\Local\Tide\tide.exe"))), "{s}");
        assert!(s.contains(&format!("{} dir=in action=allow {} protocol=tcp localport=47471", arg("name=Tide sync"), arg(r"program=C:\Users\Jörg O'Neil\AppData\Local\Tide\node.exe"))), "{s}");
        assert!(s.contains("exit 10") && s.contains("exit 11") && s.ends_with("exit 0\r\n"));
        assert!(!s.contains(&encode_command(r"program=\\?\C:\Users\Jörg O'Neil\AppData\Local\Tide\node.exe")));
    }

    #[test]
    fn only_requested_rules_are_emitted() {
        let node = PathBuf::from(r"C:\T\node.exe");
        let s = elevated_script(&[RuleSpec { name: "Tide sync", protocol: "tcp", port: 47471, program: &node }]).unwrap();
        assert!(!s.contains("Tide mDNS"));
        assert_eq!(s.matches("netsh.exe").count(), 1);
    }

    #[test]
    fn no_path_character_reaches_the_powershell_parser() {
        // Curly quotes, $(), backticks, semicolons: none may appear
        // literally in the elevated script; only Base64 of them does.
        let evil = PathBuf::from("C:\\Users\\O\u{2019}Neil\u{2018} $(calc.exe) `; \u{201B}x\\node.exe");
        let s = elevated_script(&[RuleSpec { name: "Tide sync", protocol: "tcp", port: 47471, program: &evil }]).unwrap();
        for bad in ["\u{2018}", "\u{2019}", "\u{201B}", "$(calc", "`;", "Neil"] {
            assert!(!s.contains(bad), "{bad:?} leaked into {s}");
        }
        assert!(s.contains(&encode_command(&format!("program={}", evil.display()))));
    }

    #[test]
    fn hostile_paths_are_refused() {
        let bad = PathBuf::from("C:\\x\"\r\nexit 0\\t.exe");
        assert!(elevated_script(&[RuleSpec { name: "Tide sync", protocol: "tcp", port: 1, program: &bad }]).is_err());
    }

    #[test]
    fn launcher_is_quote_free_apart_from_fixed_literals() {
        let enc = encode_command("exit 0");
        let l = launcher_command(&enc);
        assert!(!l.contains('"'));
        assert!(l.contains(&format!("'{enc}'")) && l.contains("-Verb RunAs") && l.contains("exit 1223"));
    }
}
