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
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{channel, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);

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
        let mut child = cmd.spawn().map_err(|e| format!("spawn sidecar: {e}"))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "sidecar: no stdin".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "sidecar: no stdout".to_string())?;

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
            log::warn!("sidecar sent non-JSON line: {trimmed}");
            continue;
        };
        // Ids are numbers per protocol; tolerate string ids defensively.
        let Some(id) = msg.get("id").and_then(parse_id) else {
            log::warn!("sidecar response missing id: {trimmed}");
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
}
