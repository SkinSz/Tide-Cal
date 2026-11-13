// Tide sidecar client: spawns and speaks NDJSON over a persistent Node child
// process hosting the TS domain core (dist/sidecar.mjs).
//
// Protocol (one JSON object per line, matching sidecar_server.ts):
//   request:  {"id": <num>, "op": "<name>", "args": {...}}
//   response: {"id": ..., "ok": true, "result": ...}
//             {"id": ..., "ok": false, "error": "..."}
//
// Implementation notes:
// - A reader thread correlates responses to callers by numeric id via
//   one-shot channels held in a pending map.
// - All state is std-library (Mutex + mpsc); no extra runtime deps.
// - If node is missing or the child dies, `call()` returns Err(String) and
//   the frontend degrades to its localStorage fallback.

use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, ChildStderr, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{channel, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
/// Longest single sidecar stderr line forwarded to the log; longer lines are
/// clipped (a runaway payload dump must not blow up the log file).
const MAX_LOGGED_LINE_BYTES: usize = 2048;
/// Raw stdout lines logged on protocol errors may carry calendar payloads;
/// keep only a short prefix for diagnosis.
const MAX_LOGGED_STDOUT_BYTES: usize = 200;

type PendingTx = Sender<Result<Value, String>>;

struct Inner {
    /// Option so Drop can take() it: closing stdin is the sidecar's clean
    /// shutdown signal (readline EOF → its closeListener + exit path, per
    /// tests/sidecar_eof_lifecycle.test.ts). DC-19 §4.4: Quit MUST NOT
    /// SIGKILL the sidecar.
    stdin: Option<ChildStdin>,
}

/// Handle to a running sidecar process.
pub struct Sidecar {
    next_id: AtomicU64,
    inner: Mutex<Inner>,
    pending: Arc<Mutex<HashMap<u64, PendingTx>>>,
    child: Mutex<Child>,
}

impl Sidecar {
    /// Spawn `cmd` (stdin/stdout piped), start the reader thread.
    pub fn spawn(mut cmd: Command) -> Result<Self, String> {
        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        // DC-24 W1 (2026-10-12): on Windows a console-subsystem child (the
        // bundled node.exe) would otherwise pop up its own black console
        // window next to the GUI. CREATE_NO_WINDOW suppresses it; Linux is
        // untouched.
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        let mut child = cmd.spawn().map_err(|e| format!("spawn sidecar: {e}"))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "sidecar: no stdin".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "sidecar: no stdout".to_string())?;
        // Drain stderr into the app log. Previously piped but never read:
        // a full pipe would block the sidecar, and its diagnostics were lost.
        if let Some(stderr) = child.stderr.take() {
            std::thread::Builder::new()
                .name("tide-sidecar-stderr".into())
                .spawn(move || drain_stderr(stderr))
                .map_err(|e| format!("spawn stderr thread: {e}"))?;
        }

        let pending: Arc<Mutex<HashMap<u64, PendingTx>>> =
            Arc::new(Mutex::new(HashMap::new()));

        let reader_pending = Arc::clone(&pending);
        std::thread::Builder::new()
            .name("tide-sidecar-reader".into())
            .spawn(move || read_loop(stdout, reader_pending))
            .map_err(|e| format!("spawn reader thread: {e}"))?;

        Ok(Sidecar {
            next_id: AtomicU64::new(1),
            inner: Mutex::new(Inner { stdin: Some(stdin) }),
            pending,
            child: Mutex::new(child),
        })
    }

    /// Send one request line and await the correlated response.
    pub fn call(&self, op: &str, args: Value) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = channel();

        {
            if let Ok(Some(status)) = self.child.lock().unwrap().try_wait() {
                return Err(format!("sidecar exited: {status}"));
            }
            let mut inner = self.inner.lock().map_err(|_| "sidecar lock poisoned")?;
            let stdin = match inner.stdin.as_mut() {
                Some(s) => s,
                None => return Err("sidecar is shutting down (stdin closed)".to_string()),
            };
            self.pending.lock().unwrap().insert(id, tx);
            let line = json!({ "id": id, "op": op, "args": args }).to_string();
            if let Err(e) = writeln!(stdin, "{line}").and_then(|_| stdin.flush()) {
                self.pending.lock().unwrap().remove(&id);
                return Err(format!("sidecar write: {e}"));
            }
        }

        match rx.recv_timeout(REQUEST_TIMEOUT) {
            Ok(res) => res,
            Err(RecvTimeoutError::Timeout) => {
                self.pending.lock().unwrap().remove(&id);
                Err(format!("sidecar request timed out after {}s", REQUEST_TIMEOUT.as_secs()))
            }
            Err(RecvTimeoutError::Disconnected) => Err("sidecar reader died".to_string()),
        }
    }

    pub fn ping(&self) -> Result<Value, String> {
        self.call("ping", json!({}))
    }

    /// DC-21 §3.2(a): fire-and-forget mdns_event notification. Notifications
    /// carry NO id — they are one-way pushes the sidecar consumes without
    /// replying (same stderr-logging discipline as always; nothing on stdout
    /// but correlated responses).
    pub fn notify_mdns_event(
        &self,
        kind: &str,
        instance_name: &str,
        host: &str,
        port: u16,
        observed_at: u64,
        ttl_ms: u64,
    ) -> Result<(), String> {
        let mut inner = self.inner.lock().map_err(|_| "sidecar lock poisoned")?;
        let stdin = match inner.stdin.as_mut() {
            Some(s) => s,
            None => return Err("sidecar is shutting down (stdin closed)".to_string()),
        };
        let line = json!({
            "id": null,
            "notification": "mdns_event",
            "args": {
                "kind": kind,
                "instance_name": instance_name,
                "host": host,
                "port": port,
                "interface": "",
                "observed_at": observed_at,
                "ttl_ms": ttl_ms,
            }
        })
        .to_string();
        writeln!(stdin, "{line}").and_then(|_| stdin.flush()).map_err(|e| format!("sidecar write: {e}"))
    }

    /// True while the child process is still running (no exit reported).
    /// Used by the DC-21 mdns browse sink (feature-gated consumers only).
    #[cfg_attr(not(feature = "mdns"), allow(dead_code))]
    pub fn is_alive(&self) -> bool {
        matches!(self.child.lock().unwrap().try_wait(), Ok(None))
    }

    /// DC-20 §7.1 live-apply: push new scheduler settings to the sidecar.
    /// Fire-and-forget from the caller's perspective (errors logged there);
    /// the sidecar's update_settings op applies them to its scheduler runtime.
    pub fn notify_settings(&self, settings: Value) -> Result<(), String> {
        self.call("update_settings", settings).map(|_| ())
    }
}

impl Drop for Sidecar {
    fn drop(&mut self) {
        // DC-19 §4.4 clean shutdown: close stdin (EOF) so the sidecar runs
        // its own closeListener + exit path — NOT kill(). Fall back to kill
        // only if the child ignores EOF for SHUTDOWN_GRACE.
        self.inner
            .lock()
            .map(|mut inner| inner.stdin.take())
            .map(|stdin| drop(stdin))
            .ok();
        const SHUTDOWN_GRACE: Duration = Duration::from_secs(5);
        let deadline = std::time::Instant::now() + SHUTDOWN_GRACE;
        loop {
            match self.child.lock().unwrap().try_wait() {
                Ok(Some(_status)) => return, // exited cleanly on EOF
                Ok(None) => {
                    if std::time::Instant::now() >= deadline {
                        log::warn!("sidecar ignored stdin EOF for {}s; killing", SHUTDOWN_GRACE.as_secs());
                        let _ = self.child.lock().unwrap().kill();
                        let _ = self.child.lock().unwrap().wait();
                        return;
                    }
                    std::thread::sleep(Duration::from_millis(50));
                }
                Err(_) => return,
            }
        }
    }
}

fn read_loop(stdout: std::process::ChildStdout, pending: Arc<Mutex<HashMap<u64, PendingTx>>>) {
    let reader = BufReader::new(stdout);
    for line in reader.lines() {
        let Ok(line) = line else { break };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(msg) = serde_json::from_str::<Value>(trimmed) else {
            log::warn!("sidecar sent non-JSON line: {}", clip(trimmed, MAX_LOGGED_STDOUT_BYTES));
            continue;
        };
        // Ids are numbers per protocol; tolerate string ids defensively.
        let Some(id) = msg.get("id").and_then(parse_id) else {
            log::warn!("sidecar response missing id: {}", clip(trimmed, MAX_LOGGED_STDOUT_BYTES));
            continue;
        };
        let reply = if msg.get("ok").and_then(Value::as_bool).unwrap_or(false) {
            Ok(msg.get("result").cloned().unwrap_or(Value::Null))
        } else {
            Err(msg
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("unknown sidecar error")
                .to_string())
        };
        let tx = pending.lock().unwrap().remove(&id);
        if let Some(tx) = tx {
            let _ = tx.send(reply);
        } else {
            log::warn!("sidecar response for unknown/expired id {id}");
        }
    }
    // Reader EOF: fail every outstanding caller.
    let waiting: Vec<PendingTx> = pending.lock().unwrap().drain().map(|(_, tx)| tx).collect();
    for tx in waiting {
        let _ = tx.send(Err("sidecar terminated".to_string()));
    }
}

/// Forward each stderr line to the log (target "sidecar"). Lines longer
/// than MAX_LOGGED_LINE_BYTES keep their head; the rest of that line is
/// discarded and counted, so memory and log volume stay bounded.
fn drain_stderr(stderr: ChildStderr) {
    let mut reader = BufReader::new(stderr);
    while let Some((head, dropped)) = read_bounded_line(&mut reader, MAX_LOGGED_LINE_BYTES) {
        let text = String::from_utf8_lossy(&head);
        let line = text.trim_end();
        if line.is_empty() && dropped == 0 {
            continue;
        }
        if dropped > 0 {
            log::info!(target: "sidecar", "{line}… [clipped {dropped} bytes]");
        } else {
            log::info!(target: "sidecar", "{line}");
        }
    }
}

/// Read one line: at most `max` bytes are returned (without the newline);
/// the remainder of an overlong line is consumed and its length returned.
/// None at EOF / read error.
fn read_bounded_line<R: BufRead>(reader: &mut R, max: usize) -> Option<(Vec<u8>, usize)> {
    let mut head = Vec::new();
    let n = reader.by_ref().take(max as u64).read_until(b'\n', &mut head).ok()?;
    if n == 0 {
        return None;
    }
    if head.last() == Some(&b'\n') {
        head.pop();
        return Some((head, 0));
    }
    let mut dropped = 0usize;
    if head.len() == max {
        // Overlong: discard up to and including the next newline.
        loop {
            let buf = match reader.fill_buf() {
                Ok(b) if !b.is_empty() => b,
                _ => break,
            };
            if let Some(pos) = buf.iter().position(|&c| c == b'\n') {
                dropped += pos;
                reader.consume(pos + 1);
                break;
            }
            let len = buf.len();
            dropped += len;
            reader.consume(len);
        }
    }
    Some((head, dropped))
}

/// Truncate to at most `max` bytes on a char boundary, marking the cut.
fn clip(s: &str, max: usize) -> std::borrow::Cow<'_, str> {
    if s.len() <= max {
        return std::borrow::Cow::Borrowed(s);
    }
    let mut end = max;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    std::borrow::Cow::Owned(format!("{}… [clipped {} bytes]", &s[..end], s.len() - end))
}

fn parse_id(v: &Value) -> Option<u64> {
    match v {
        Value::Number(n) => n.as_u64(),
        Value::String(s) => s.parse().ok(),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_echo() {
        // Fake sidecar: an sh loop that wraps each request line in an
        // ok:true response with an incrementing id.
        let script = "n=0; while IFS= read -r l; do \
                      n=$((n+1)); \
                      printf '{\"id\":%d,\"ok\":true,\"result\":%s}\\n' \"$n\" \"$l\"; \
                      done";
        let mut cmd = Command::new("/bin/sh");
        cmd.arg("-c").arg(script);
        let sc = Sidecar::spawn(cmd).expect("spawn fake sidecar");

        let pong = sc.ping().expect("roundtrip");
        assert_eq!(pong["op"], "ping");

        // Requests correlate correctly by id.
        let args = json!({ "input": { "title": "hi", "startMs": 5 } });
        let r = sc.call("create_event", args.clone()).expect("roundtrip 2");
        assert_eq!(r["op"], "create_event");
        assert_eq!(r["args"]["input"]["startMs"], 5);

        assert!(sc.call("boom", json!({})).is_ok());
    }

    #[test]
    fn clip_respects_char_boundaries() {
        assert_eq!(clip("short", 10), "short");
        let s = "ä".repeat(10); // 20 bytes, 2 per char
        let c = clip(&s, 5); // byte 5 is mid-char -> cut back to 4
        assert!(c.starts_with("ää…"), "{c}");
        assert!(c.ends_with("[clipped 16 bytes]"), "{c}");
    }

    #[test]
    fn bounded_line_reader_clips_and_counts_exactly() {
        let data = format!("short\r\n{}\nnext\ntail-no-newline", "z".repeat(5000));
        let mut r = BufReader::new(data.as_bytes());
        let (l, d) = read_bounded_line(&mut r, 2048).unwrap();
        assert_eq!((l.as_slice(), d), (&b"short\r"[..], 0)); // CR trimmed later by trim_end
        let (l, d) = read_bounded_line(&mut r, 2048).unwrap();
        assert_eq!((l.len(), d), (2048, 5000 - 2048));
        let (l, d) = read_bounded_line(&mut r, 2048).unwrap();
        assert_eq!((l.as_slice(), d), (&b"next"[..], 0));
        let (l, d) = read_bounded_line(&mut r, 2048).unwrap();
        assert_eq!((l.as_slice(), d), (&b"tail-no-newline"[..], 0));
        assert!(read_bounded_line(&mut r, 2048).is_none());
    }

    #[test]
    fn stderr_flood_does_not_block_the_sidecar() {
        // Pre-fix, stderr was piped but never read: once the OS pipe buffer
        // (~64 KiB) filled, the child blocked on write and stopped replying.
        // 1 MiB to stderr first, then the protocol must still answer.
        let script = "head -c 1048576 /dev/zero | tr '\\0' 'x' >&2; \
                      n=0; while IFS= read -r l; do n=$((n+1)); \
                      printf '{\"id\":%d,\"ok\":true,\"result\":1}\\n' \"$n\"; done";
        let mut cmd = Command::new("/bin/sh");
        cmd.arg("-c").arg(script);
        let sc = Sidecar::spawn(cmd).expect("spawn flooding sidecar");
        assert!(sc.ping().is_ok(), "sidecar blocked behind an undrained stderr pipe");
    }
}
