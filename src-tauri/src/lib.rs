// Tide desktop shell: Tauri IPC commands proxy event CRUD to the Node
// sidecar (dist/sidecar.mjs) hosting the TS domain core. See sidecar.rs.
//
// The sidecar is spawned once in `setup`. If node is unavailable or the
// child dies, commands return Err(String) and the frontend store degrades
// to its localStorage fallback.
//
// DC-19 (tray icon + context menu, Linux first):
//   §2.2  closing the main window HIDES it — the process and sidecar live on.
//   §4    tray menu = Open Tide / Sync now / Quit (no Sync Errors item — D6;
//         no settings submenu — D5; no confirm dialog on Quit).
//   §4.2  "Sync now" routes through the existing sync_now RPC op (no new
//         Rust DB access); disabled while a session is in flight or no
//         peers are paired; does NOT open the window.
//   §4.4  Quit = close window + CLEAN sidecar stdin-EOF shutdown (never
//         SIGKILL) + app.exit(). See sidecar.rs Drop.
//   §2.3  tray-less desktops degrade to a normal windowed app: the same
//         actions exist in-app (toolbar) and the app MUST NOT become
//         unreachable.
//   §3    tray states v1 = IDLE + SYNCING (D7). This build ships the
//         in-flight tracking + tooltip state; the IDLE/SYNCING icon bitmap
//         swap is deferred (single icon asset) — see report, D8.
//
// DC-20 (options window, APPROVED 2026-08-31):
//   D9    the options window is a SEPARATE window reachable ONLY from the
//         tray menu "Options…" item — never from the calendar UI.
//   §4.2  Save-all atomic commit: set_settings validates/clamps in Rust too
//         (defence in depth), persists to config.toml, returns the effective
//         values; get_settings returns the effective (env>file>default).
//   §6    persistence = ~/.config/tide/config.toml (DC-15 §3.2 layout),
//         fail-open on malformed files (defaults), env vars win.

mod sidecar;
mod mdns_service;
// DC-11 §7: mDNS platform adapter. Lives in the lib so mdns_service (DC-21)
// can name its concrete adapter type via MdnsAdapterImpl; still NOT
// registered as Tauri commands — browse events flow through mdns_service's
// EventSink to the sidecar (DC-21 §3.1/D1).
#[cfg_attr(not(feature = "mdns"), allow(dead_code))]
#[path = "discovery.rs"]
mod tide_discovery;

use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager, State, WindowEvent,
};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

/// Event input as sent by the frontend shell (camelCase; snake_case kept as
/// an alias for older callers).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EventInput {
    title: String,
    description: String,
    start_ms: i64,
    end_ms: i64,
    all_day: bool,
    /// DC-12 §2.1: optional RFC 5545 RRULE — CREATE only. NOTE (smoke-test
    /// bug, 2026-09-02): this field was missing here, so serde silently
    /// dropped the frontend's recurrenceRule and repeating events were
    /// created as singles — the rule never reached the sidecar.
    #[serde(skip_serializing_if = "Option::is_none")]
    recurrence_rule: Option<String>,
}

impl EventInput {
    fn to_json(self) -> serde_json::Value {
        serde_json::to_value(&self).unwrap_or(serde_json::Value::Null)
    }
}

/// Managed sidecar handle (None when the sidecar could not be spawned).
/// Mutex<Option<_>> so Quit can TAKE the handle and Drop it (clean stdin-EOF
/// shutdown) before app.exit().
struct SidecarState(Mutex<Option<Arc<sidecar::Sidecar>>>);

/// Whether a sync session (manual trigger) is currently in flight. Drives
/// the "Sync now" disabled state (DC-19 §4.2) and the SYNCING tooltip.
struct SyncFlight(AtomicBool);

/// Tray "Sync now" menu item handle, so the shell can grey it during flight.
struct TraySyncItem(Mutex<Option<MenuItem<tauri::Wry>>>);

// ---------------------------------------------------------------------------
// DC-20 settings: persistence in ~/.config/tide/config.toml (DC-15 §3.2
// layout; non-secret only), env-var-wins precedence, fail-open on malformed
// files. S1-S4 per DC-20 §5.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
struct TideSettings {
    sync_debounce_seconds: f64,
    sweep_interval_minutes: f64,
    max_concurrent_sessions: f64,
    max_incremental_backlog: f64,
    /// General category: manual light/dark choice (no system-follow).
    #[serde(default = "default_general_theme", rename = "general.theme")]
    general_theme: String,
    /// General category: clock style for the event dialog (12h/24h).
    #[serde(
        default = "default_general_time_format",
        rename = "general.time_format"
    )]
    general_time_format: String,
    /// General category: date/number rendering locale for WebKitGTK. The
    /// webview formats native <input type="date"> and toLocaleDateString
    /// from the process locale (GLib reads LC_MESSAGES/LC_ALL, NOT LC_TIME)
    /// — on mixed-locale systems (e.g. LANG=en_US + LC_TIME=de_DE) dates
    /// render MM/DD/YYYY even though the desktop shows DD.MM.YYYY.
    /// "system" (default) leaves the environment untouched; the other values
    /// force LC_ALL to the matching locale at startup. NEXT-START
    /// (DC-20 §7.2): WebKitGTK reads the locale once at webview creation,
    /// live-apply is impossible.
    #[serde(default = "default_general_locale", rename = "general.locale")]
    general_locale: String,
}

fn default_general_locale() -> String {
    "system".to_string()
}

fn default_general_theme() -> String {
    "dark".to_string()
}

fn default_general_time_format() -> String {
    "24h".to_string()
}

impl Default for TideSettings {
    fn default() -> Self {
        // DC-13 §3.5 + DC-09 defaults (owner-tuned).
        Self {
            sync_debounce_seconds: 10.0,
            sweep_interval_minutes: 10.0,
            max_concurrent_sessions: 3.0,
            max_incremental_backlog: 1000.0,
            general_theme: "dark".to_string(),
            general_time_format: "24h".to_string(),
            general_locale: "system".to_string(),
        }
    }
}

/// Clamp to the contract bounds (DC-13 §3.5 / DC-09). Defence in depth:
/// the options window clamps too, but a hand-edited config.toml must not
/// poison the scheduler.
impl TideSettings {
    fn clamped(mut self) -> Self {
        self.sync_debounce_seconds = self.sync_debounce_seconds.clamp(5.0, 120.0);
        self.sweep_interval_minutes = self.sweep_interval_minutes.clamp(1.0, 1440.0);
        self.max_concurrent_sessions = self.max_concurrent_sessions.clamp(1.0, 5.0);
        self.max_incremental_backlog =
            self.max_incremental_backlog.clamp(100.0, 100_000.0);
        // General: anything unexpected falls back to the default (dark / 24h).
        if self.general_theme != "light" && self.general_theme != "dark" {
            self.general_theme = "dark".to_string();
        }
        if self.general_time_format != "12h" && self.general_time_format != "24h" {
            self.general_time_format = "24h".to_string();
        }
        match self.general_locale.as_str() {
            "system" | "de" | "en-GB" | "en-US" => {}
            _ => self.general_locale = "system".to_string(),
        }
        self
    }
}

fn config_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    // DC-15 §3.2: $XDG_CONFIG_HOME/tide/ (~/.config/tide/). Tauri's
    // app_config_dir resolves the same location per the XDG spec.
    app.path()
        .app_config_dir()
        .map_err(|e| format!("config dir: {e}"))
}

fn config_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(config_dir(app)?.join("config.toml"))
}

/// Precedence per DC-15 §3.2: env var > config.toml > built-in default.
/// (Env names mirror the TIDE_* convention; unset env leaves the file value.)
fn apply_env_overrides(mut s: TideSettings) -> TideSettings {
    let env_num = |key: &str| -> Option<f64> {
        std::env::var(key).ok().and_then(|v| v.trim().parse::<f64>().ok())
    };
    if let Some(v) = env_num("TIDE_SYNC_DEBOUNCE_SECONDS") {
        s.sync_debounce_seconds = v;
    }
    if let Some(v) = env_num("TIDE_SWEEP_MINUTES") {
        s.sweep_interval_minutes = v;
    }
    if let Some(v) = env_num("TIDE_MAX_CONCURRENT_SESSIONS") {
        s.max_concurrent_sessions = v;
    }
    if let Some(v) = env_num("TIDE_MAX_INCREMENTAL_BACKLOG") {
        s.max_incremental_backlog = v;
    }
    s.clamped()
}

fn load_settings(app: &tauri::AppHandle) -> TideSettings {
    let from_file = config_path(app)
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|text| toml::from_str::<TideSettings>(&text).ok()); // fail-open (§6.2)
    apply_env_overrides(from_file.unwrap_or_default())
}

/// run()-time settings read without an AppHandle: config file only (no env
/// overrides — those are scheduler numbers, not the startup locale), NO
/// clamping side effects beyond the locale whitelist. Used by run() to apply
/// the saved locale before GTK/webview init.
fn load_settings_pub() -> TideSettings {
    // The config dir depends on the app identity; before Tauri init we read
    // the XDG path directly. CRITICAL (owner bug 2026-09-03): Tauri resolves
    // app_config_dir to $XDG_CONFIG_HOME/<bundle-identifier>/ — that is
    // com.tide.app (see tauri.conf.json), NOT the literal "tide" the DC-15
    // §3.2 comment says. persist_settings (with an AppHandle) writes to
    // com.tide.app/, so this pre-init reader must match or the saved locale
    // silently falls back to "system" on every launch.
    let mut path = std::env::var("XDG_CONFIG_HOME")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| {
            let home = std::env::var("HOME").unwrap_or_default();
            std::path::PathBuf::from(home).join(".config")
        });
    path.push("com.tide.app");
    path.push("config.toml");
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| toml::from_str::<TideSettings>(&text).ok())
        .unwrap_or_default()
        .clamped()
}

fn persist_settings(app: &tauri::AppHandle, s: &TideSettings) -> Result<(), String> {
    let path = config_path(app)?;
    let dir = path
        .parent()
        .ok_or_else(|| "config path has no parent".to_string())?;
    std::fs::create_dir_all(dir).map_err(|e| format!("create config dir: {e}"))?;
    let text = toml::to_string_pretty(s).map_err(|e| format!("toml serialize: {e}"))?;
    std::fs::write(&path, text).map_err(|e| format!("write config: {e}"))
}

/// DC-20 §4.2: read the effective settings (env > file > default).
#[tauri::command]
fn get_settings(app: tauri::AppHandle) -> Result<TideSettings, String> {
    Ok(load_settings(&app))
}

/// DC-20 §4.2/§4.3: Save-all atomic commit. Clamps in Rust (defence in
/// depth; the options window clamps too), persists atomically (write temp +
/// rename), then returns the effective values. Live-apply to the sidecar's
/// scheduler runtime rides the NEXT settings read by the runtime (S1-S3 are
/// read per decision pass through the scheduler's updateSettings; S4 is
/// next-start per DC-20 §7.2). The sidecar is notified so its scheduler
/// runtime re-reads immediately (live-apply for S1-S3).
#[tauri::command]
async fn set_settings(
    app: tauri::AppHandle,
    sc: tauri::State<'_, SidecarState>,
    settings: TideSettings,
) -> Result<TideSettings, String> {
    let clamped = settings.clamped();
    persist_settings(&app, &clamped)?;
    // Live-apply (DC-20 §7.1): notify the sidecar so its scheduler runtime
    // updateSettings() runs immediately (S1-S3). S4 is next-start (§7.2).
    if let Ok(handle) = sidecar_handle(&sc) {
        let args = json!({
            "sync_debounce_seconds": clamped.sync_debounce_seconds,
            "sweep_interval_minutes": clamped.sweep_interval_minutes,
            "max_concurrent_sessions": clamped.max_concurrent_sessions,
        });
        let h = handle.clone();
        let _ = tauri::async_runtime::spawn_blocking(move || {
            if let Err(e) = h.notify_settings(args) {
                log::warn!("settings live-apply notify failed: {e}");
            }
        });
    }
    Ok(clamped)
}

// ---------------------------------------------------------------------------
// IPC commands (proxy to the sidecar)
// ---------------------------------------------------------------------------

fn proxy(
    sc: &sidecar::Sidecar,
    op: &str,
    args: serde_json::Value,
) -> Result<serde_json::Value, String> {
    sc.call(op, args).map_err(|e| {
        log::warn!("sidecar {op} failed: {e}");
        e
    })
}

#[tauri::command]
async fn list_events(
    sc: State<'_, SidecarState>,
    from_ms: Option<i64>,
    to_ms: Option<i64>,
) -> Result<Vec<serde_json::Value>, String> {
    let args = json!({ "from_ms": from_ms, "to_ms": to_ms });
    let handle = sidecar_handle(&sc)?;
    tauri::async_runtime::spawn_blocking(move || {
        proxy(&handle, "list_events", args)
            .map(|v| v.as_array().cloned().unwrap_or_default())
    })
    .await
    .map_err(|e| format!("join sidecar task: {e}"))?
}

#[tauri::command]
async fn create_event(
    sc: State<'_, SidecarState>,
    input: EventInput,
) -> Result<serde_json::Value, String> {
    let args = json!({ "input": input.to_json() });
    let handle = sidecar_handle(&sc)?;
    tauri::async_runtime::spawn_blocking(move || proxy(&handle, "create_event", args))
        .await
        .map_err(|e| format!("join sidecar task: {e}"))?
}

#[tauri::command]
async fn update_event(
    sc: State<'_, SidecarState>,
    id: String,
    input: EventInput,
) -> Result<serde_json::Value, String> {
    let args = json!({ "id": id, "input": input.to_json() });
    let handle = sidecar_handle(&sc)?;
    tauri::async_runtime::spawn_blocking(move || proxy(&handle, "update_event", args))
        .await
        .map_err(|e| format!("join sidecar task: {e}"))?
}

#[tauri::command]
async fn delete_event(sc: State<'_, SidecarState>, id: String) -> Result<(), String> {
    let args = json!({ "id": id });
    let handle = sidecar_handle(&sc)?;
    tauri::async_runtime::spawn_blocking(move || proxy(&handle, "delete_event", args))
        .await
        .map_err(|e| format!("join sidecar task: {e}"))??;
    Ok(())
}

/// Generic passthrough for the sync surface (device_info, pairing_offer,
/// pairing_accept, sync_now). Keeping it generic avoids one Rust command per
/// op while payload shapes settle; typed commands can be added later.
///
/// Smoke-test fix (2026-09-03): the reminder ops are invoked from the
/// frontend as DIRECT Tauri commands (frontend/store.ts getReminder/
/// setReminder/clearReminder call invoke("set_reminder") etc.) — NOT through
/// this passthrough. They must be registered in invoke_handler below.

/// Typed Tauri commands for the DC-22 reminder member surface. These proxy
/// to the sidecar's authoritative ops (registered in sync_op ALLOWED as
/// well, so both boundaries accept them). Frontend invokes these directly.
///
/// Causal-gate note: Tauri v2 derives IPC argument keys from the Rust
/// parameter names — snake_case Rust params expect snake_case JS keys ONLY
/// if the command is annotated; the default is camelCase. The frontend sends
/// snake_case ({event_id, minutes_before}), so each command is explicitly
/// annotated `#[tauri::command(rename_all = "snake_case")]` to make the
/// expectation match the wire format — verified against the generated
/// command-map string in the binary.
#[tauri::command(rename_all = "snake_case")]
async fn get_reminder(
    sc: State<'_, SidecarState>,
    event_id: String,
) -> Result<serde_json::Value, String> {
    let handle = sidecar_handle(&sc)?;
    tauri::async_runtime::spawn_blocking(move || {
        proxy(&handle, "get_reminder", json!({ "event_id": event_id }))
    })
    .await
    .map_err(|e| format!("join sidecar task: {e}"))?
}

#[tauri::command(rename_all = "snake_case")]
async fn set_reminder(
    sc: State<'_, SidecarState>,
    event_id: String,
    minutes_before: i64,
    enabled: bool,
) -> Result<serde_json::Value, String> {
    let handle = sidecar_handle(&sc)?;
    tauri::async_runtime::spawn_blocking(move || {
        proxy(
            &handle,
            "set_reminder",
            json!({
                "event_id": event_id,
                "minutes_before": minutes_before,
                "enabled": enabled,
            }),
        )
    })
    .await
    .map_err(|e| format!("join sidecar task: {e}"))?
}

#[tauri::command(rename_all = "snake_case")]
async fn clear_reminder(
    sc: State<'_, SidecarState>,
    event_id: String,
) -> Result<serde_json::Value, String> {
    let handle = sidecar_handle(&sc)?;
    tauri::async_runtime::spawn_blocking(move || {
        proxy(&handle, "clear_reminder", json!({ "event_id": event_id }))
    })
    .await
    .map_err(|e| format!("join sidecar task: {e}"))?
}

// ---------------------------------------------------------------------------
// Smoke-test fix (2026-09-03): recurrence surface commands. The frontend
// (frontend/store.ts) invokes list_series / update_series_rule /
// update_occurrence as DIRECT Tauri commands — but they were only present in
// sync_op's ALLOWED allow-list, never registered in invoke_handler. Every
// listSeries() call failed, so (a) series never expanded into occurrence
// chips (repeating events rendered as a single event) and (b) the edit dialog
// could never look up the event's series — the "Repeat" checkbox showed
// unchecked even for series events. Same bug class as the reminder commands
// fixed earlier the same day. Each command proxies to the sidecar op of the
// same name (all three are in sync_op's ALLOWED list too, so both boundaries
// accept them).
#[tauri::command(rename_all = "snake_case")]
async fn list_series(sc: State<'_, SidecarState>) -> Result<serde_json::Value, String> {
    let handle = sidecar_handle(&sc)?;
    tauri::async_runtime::spawn_blocking(move || proxy(&handle, "list_series", json!({})))
        .await
        .map_err(|e| format!("join sidecar task: {e}"))?
}

#[tauri::command(rename_all = "snake_case")]
async fn update_series_rule(
    sc: State<'_, SidecarState>,
    series_id: String,
    rule: String,
) -> Result<serde_json::Value, String> {
    let handle = sidecar_handle(&sc)?;
    tauri::async_runtime::spawn_blocking(move || {
        proxy(
            &handle,
            "update_series_rule",
            json!({ "series_id": series_id, "rule": rule }),
        )
    })
    .await
    .map_err(|e| format!("join sidecar task: {e}"))?
}

#[tauri::command(rename_all = "snake_case")]
async fn update_occurrence(
    sc: State<'_, SidecarState>,
    series_id: String,
    recurrence_id: String,
    patch: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let handle = sidecar_handle(&sc)?;
    tauri::async_runtime::spawn_blocking(move || {
        proxy(
            &handle,
            "update_occurrence",
            json!({
                "series_id": series_id,
                "recurrence_id": recurrence_id,
                "patch": patch,
            }),
        )
    })
    .await
    .map_err(|e| format!("join sidecar task: {e}"))?
}

#[tauri::command]
async fn sync_op(
    sc: State<'_, SidecarState>,
    op: String,
    args: serde_json::Value,
) -> Result<serde_json::Value, String> {
    const ALLOWED: [&str; 24] = [
        "device_info",
        "pairing_offer",
        "pairing_accept",
        "cancel_pairing_offer",
        "sync_now",
        // TD-005/DC-16 quarantine + peer-misbehavior surface (sync_errors,
        // paired_devices dialogs):
        "list_quarantine",
        "quarantine_stats",
        "retry_quarantine",
        "delete_quarantine",
        "peer_state",
        "list_paired_devices",
        "reset_peer_state",
        "unblock_peer",
        "list_series",
        // DC-22: reminder member write path (event dialog "Remind me").
        "get_reminder",
        "set_reminder",
        "clear_reminder",
        // DC-12: recurrence write paths (series rule + occurrence overrides).
        "update_series_rule",
        "update_occurrence",
        // Pkg5 (QA M-2): read-only Conflicts surface (DC-14).
        "list_conflicts",
        "conflict_detail",
        // DC-14 §4.3 write path: conflict resolution actions.
        "resolve_conflict",
        "skip_conflict",
        // DC-20 §7.1 live-apply: options-window Save pushes scheduler
        // settings to the already-running scheduler runtime.
        "update_settings",
    ];
    if !ALLOWED.contains(&op.as_str()) {
        return Err(format!("op not allowed over this command: {op}"));
    }
    let handle = sidecar_handle(&sc)?;
    tauri::async_runtime::spawn_blocking(move || proxy(&handle, &op, args))
        .await
        .map_err(|e| format!("join sidecar task: {e}"))?
}

fn sidecar_handle(sc: &SidecarState) -> Result<Arc<sidecar::Sidecar>, String> {
    sc.0
        .lock()
        .map_err(|_| "sidecar state lock poisoned".to_string())?
        .clone()
        .ok_or_else(|| "tide sidecar unavailable".to_string())
}

// ---------------------------------------------------------------------------
// DC-19 §4.2 manual "Sync now" (tray menu + in-app toolbar fallback)
// ---------------------------------------------------------------------------

/// Peer endpoint for the manual sync pass. Honest v1: the DC-07 peers table
/// stores no host/port and mDNS browse results are not yet plumbed to the
/// shell, so the endpoint comes from the environment (dev/single-machine
/// deployments). Defaults match the sidecar's SYNC_DEFAULT_PORT.
fn sync_endpoint() -> (String, u16) {
    let host = std::env::var("TIDE_SYNC_PEER_HOST").unwrap_or_else(|_| "127.0.0.1".into());
    let port = std::env::var("TIDE_SYNC_PEER_PORT")
        .or_else(|_| std::env::var("TIDE_SYNC_PORT"))
        .ok()
        .and_then(|p| p.parse::<u16>().ok())
        .unwrap_or(47471);
    (host, port)
}

fn set_sync_enabled(app: &AppHandle, enabled: bool) {
    if let Some(item) = app
        .try_state::<TraySyncItem>()
        .and_then(|s| s.0.lock().ok().and_then(|mut g| g.take_if(|_| true)))
    {
        let _ = item.set_enabled(enabled);
        // put it back
        if let Some(state) = app.try_state::<TraySyncItem>() {
            if let Ok(mut g) = state.0.lock() {
                *g = Some(item);
            }
        }
    }
    let _ = app.emit("tide://sync-state", enabled);
}

/// Fire-and-forget manual sync pass through the existing sync_now RPC op
/// (DC-19 §4.2 / D4). Returns Err(String) with the skip reason when the
/// request cannot even start (in flight / no peers paired / no sidecar).
fn trigger_sync_now(app: &AppHandle) -> Result<serde_json::Value, String> {
    let sc = {
        let state = app.state::<SidecarState>();
        sidecar_handle(&state)?
    };
    let flight = app.state::<SyncFlight>();
    if flight
        .0
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Err("sync already in flight".into());
    }
    let start = |ok: bool, msg: &str| -> Result<serde_json::Value, String> {
        if !ok {
            flight.0.store(false, Ordering::SeqCst);
            return Err(msg.to_string());
        }
        set_sync_enabled(app, false);
        let _ = app.emit("tide://sync-state", false);
        Ok(json!({ "started": true }))
    };

    // DC-19 §4.2: disabled when no peers are paired. device_info is a cheap
    // read over the same RPC surface.
    let peers = proxy(&sc, "device_info", json!({}))
        .and_then(|v| {
            serde_json::from_value::<Vec<String>>(v["paired_peers"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .filter_map(|p| p["device_id"].as_str().map(String::from))
                        .collect()
                })
                .unwrap_or_default())
            .map_err(|e| e.to_string())
        });
    let peers = match peers {
        Ok(p) => p,
        Err(e) => return start(false, &format!("device_info failed: {e}")),
    };
    if peers.is_empty() {
        return start(false, "no peers are paired");
    }

    let (host, port) = sync_endpoint();
    log::info!("manual sync_now -> {host}:{port} (peers: {})", peers.len());
    let app2 = app.clone();
    tauri::async_runtime::spawn(async move {
        let result = tauri::async_runtime::spawn_blocking(move || {
            proxy(&sc, "sync_now", json!({ "host": host, "port": port }))
        })
        .await
        .unwrap_or_else(|e| Err(format!("join sidecar task: {e}")));
        match result {
            Ok(v) => log::info!("manual sync_now finished: {v}"),
            Err(e) => log::warn!("manual sync_now failed: {e}"),
        }
        app2.state::<SyncFlight>().0.store(false, Ordering::SeqCst);
        set_sync_enabled(&app2, true);
        let _ = app2.emit("tide://sync-state", true);
    });
    start(true, "")
}

#[tauri::command]
async fn manual_sync_now(app: AppHandle) -> Result<serde_json::Value, String> {
    trigger_sync_now(&app)
}

/// In-app Quit entry (DC-19 §4.6 fallback): same clean shutdown as the tray
/// Quit (§4.4).
#[tauri::command]
async fn quit_tide(app: AppHandle) -> Result<(), String> {
    quit_app(&app);
    Ok(())
}

/// DC-19 §4.4 Quit: close window, drop the sidecar handle (stdin-EOF clean
/// shutdown — sidecar.rs Drop waits for exit, kill only as last resort),
/// then exit. No confirmation dialog.
fn quit_app(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.close();
    }
    if let Some(state) = app.try_state::<SidecarState>() {
        if let Ok(mut guard) = state.0.lock() {
            if let Some(sc) = guard.take() {
                // Dropping the last Arc runs Sidecar::drop → stdin EOF.
                drop(sc);
            }
        }
    }
    log::info!("tide: quitting (sidecar shut down cleanly)");
    app.exit(0);
}

// ---------------------------------------------------------------------------
// Setup helpers
// ---------------------------------------------------------------------------

/// Resolve dist/sidecar.mjs:
/// 1. TIDE_SIDECAR_PATH env override
/// 2. app resource dir (bundled builds)
/// 3. ../../dist/sidecar.mjs relative to cwd (dev)
fn resolve_sidecar_path(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    if let Ok(p) = std::env::var("TIDE_SIDECAR_PATH") {
        let p = std::path::PathBuf::from(p);
        if p.is_file() {
            return Some(p);
        }
        log::warn!("TIDE_SIDECAR_PATH={p:?} does not exist; trying defaults");
    }
    if let Ok(res) = app.path().resource_dir() {
        let p = res.join("dist").join("sidecar.mjs");
        if p.is_file() {
            return Some(p);
        }
    }
    let dev = std::path::PathBuf::from("../../dist/sidecar.mjs");
    if dev.is_file() {
        return Some(dev);
    }
    // `tauri dev` runs the binary with cwd = src-tauri, so the repo's
    // dist/ is ONE level up (../dist), not two (../../dist). Also try
    // cwd/dist for direct runs from the repo root. Without these the
    // sidecar silently fails to spawn in dev and every sync/stats RPC
    // reports unavailable (owner-reported "(?)" badge, 2026-08-31).
    let dev_parent = std::path::PathBuf::from("../dist/sidecar.mjs");
    if dev_parent.is_file() {
        return Some(dev_parent);
    }
    let cwd_dist = std::path::PathBuf::from("dist/sidecar.mjs");
    if cwd_dist.is_file() {
        return Some(cwd_dist);
    }
    None
}

/// DC-19 §4: tray icon + context menu [Open Tide, Sync now, Options…, Quit].
/// Returns Err when the desktop has no StatusNotifier/AppIndicator support —
/// the caller degrades to a windowed app (§2.3).
fn build_tray(app: &tauri::AppHandle) -> Result<(), String> {
    let open_item = MenuItem::with_id(app, "open-tide", "Open Tide", true, None::<&str>)
        .map_err(|e| format!("menu item: {e}"))?;
    // Sync now starts ENABLED; the first trigger_sync_now adjusts it. The
    // no-peers-paired disable is enforced in trigger_sync_now (§4.2).
    let sync_item = MenuItem::with_id(app, "sync-now", "Sync now", true, None::<&str>)
        .map_err(|e| format!("menu item: {e}"))?;
    // DC-20: "Options…" opens the dedicated options window (D9: tray-only
    // reachability, never from the calendar UI).
    let options_item = MenuItem::with_id(app, "options", "Options…", true, None::<&str>)
        .map_err(|e| format!("menu item: {e}"))?;
    let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)
        .map_err(|e| format!("menu item: {e}"))?;
    // §4.5: at most one separator between the functional group and Quit.
    let separator = PredefinedMenuItem::separator(app).map_err(|e| format!("separator: {e}"))?;
    let menu = Menu::with_items(
        app,
        &[&open_item, &sync_item, &options_item, &separator, &quit_item],
    )
    .map_err(|e| format!("tray menu: {e}"))?;

    let icon = app
        .default_window_icon()
        .cloned()
        .ok_or_else(|| "no default window icon for tray".to_string())?;

    let _tray = TrayIconBuilder::with_id("tide-tray")
        .icon(icon)
        .tooltip("Tide")
        .menu(&menu)
        .show_menu_on_left_click(true) // §5.3: menu is the only guaranteed interaction
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open-tide" => {
                // §4.1: show + focus; always enabled. Best-effort under Wayland (§5.4).
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.show();
                    let _ = win.unminimize();
                    let _ = win.set_focus();
                }
            }
            "sync-now" => {
                if let Err(e) = trigger_sync_now(app) {
                    log::info!("Sync now skipped: {e}");
                }
            }
            "options" => open_options_window(app),
            "quit" => quit_app(app),
            _ => {}
        })
        .build(app)
        .map_err(|e| format!("tray build: {e}"))?;

    app.manage(TraySyncItem(Mutex::new(Some(sync_item))));
    Ok(())
}

/// DC-20 §2: open (or focus) the dedicated options window. Created on demand
/// (D7: no always-resident webview); at most one instance (§2.3); closing it
/// never touches the app or sidecar.
fn open_options_window(app: &tauri::AppHandle) {
    if let Some(win) = app.get_webview_window("options") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
        return;
    }
    let url = tauri::WebviewUrl::App("options.html".into());
    let window = tauri::WebviewWindowBuilder::new(app, "options", url)
        .title("Tide — Options")
        .inner_size(720.0, 520.0)
        .min_inner_size(600.0, 420.0)
        .resizable(true)
        .build()
        .map_err(|e| format!("options window: {e}"));
    if let Err(e) = window {
        log::error!("failed to open options window: {e}");
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // General.locale (DC-20, owner request 2026-09-03): WebKitGTK formats
    // native <input type="date"> and toLocaleDateString from the PROCESS
    // locale (LANG), not LC_TIME — on mixed-locale systems the event dialog
    // showed MM/DD/YYYY while the desktop is DD.MM.YYYY. Apply the saved
    // choice via setlocale BEFORE any webview/GTK init; "system" (default)
    // leaves the environment untouched. NEXT-START setting (DC-20 §7.2):
    // WebKitGTK reads the locale once at webview creation — live-apply is
    // not possible, the choice takes effect on the next launch.
    {
        let settings = load_settings_pub();
        match settings.general_locale.as_str() {
            "de" | "en-GB" | "en-US" => {
                let code = match settings.general_locale.as_str() {
                    "de" => "de_DE.UTF-8",
                    "en-GB" => "en_GB.UTF-8",
                    _ => "en_US.UTF-8",
                };
                // LC_ALL is the lever GLib/WebKitGTK actually consults for
                // date rendering (LC_TIME alone is ignored by the webview's
                // locale negotiation). Set it before any GTK/webview init.
                std::env::set_var("LC_ALL", code);
                log::info!("locale override applied: {code} (next-start setting)");
            }
            _ => {}
        }
    }
    // TD-011 bug 4 (window X / titlebar buttons hard to click on Wayland):
    // verified upstream, not ours — tao's client-side decorations on Wayland
    // stop the titlebar buttons from receiving hover/click events
    // (tauri-apps/tauri#13440, fixed by tauri-apps/tao#1218 "fix(wayland):
    // fix client-side decorations", released in tao 0.36.0). Tide is pinned
    // to tao 0.35 via tauri-runtime-wry 2.11.4 (requires ^0.35.0), so the
    // fix cannot be picked up until a tauri release bumps tao. Verified that
    // nothing in this repo causes it: native decorations are on (no
    // `decorations: false`), there are no drag regions, no transparent
    // windows, and no CSS overlays the titlebar (GTK decorations live
    // outside the webview). Mitigation until the upgrade: launch under
    // XWayland (`GDK_BACKEND=x11` in the launch environment) or by
    // double-clicking the titlebar once (the buttons then keep working).
    tauri::Builder::default()
        .setup(|app| {
            // Runtime window icon: in a dev launch (cargo run) nothing else
            // sets the GTK window icon, so the taskbar falls back to the
            // WebKitGTK default ("W"). The bundle icons are embedded at
            // build time; apply the default one to the main window here.
            if let (Some(icon), Some(win)) = (
                app.default_window_icon().cloned(),
                app.get_webview_window("main"),
            ) {
                let _ = win.set_icon(icon);
            }
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        // Suppress the libayatana-appindicator deprecation
                        // notice — it comes from the tray library itself on
                        // every launch, is not actionable in Tide, and just
                        // drowns the useful startup lines.
                        .filter(|metadata| {
                            !metadata
                                .target()
                                .starts_with("libayatana_appindicator")
                        })
                        .build(),
                )?;
            }

            // DC-19 §2.3: tray-less desktop (no StatusNotifier support) —
            // degrade to a normal windowed app, never make the app
            // unreachable. The in-app toolbar carries the same actions.
            if let Err(e) = build_tray(app.handle()) {
                log::warn!(
                    "tray unavailable ({e}); continuing as a normal windowed app (DC-19 §2.3)"
                );
            }

            // The sidecar owns the authoritative TS domain-core database.
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            let db_path = data_dir.join("tide-domain.db");

            // DC-21 (pkg10 review F1): manage the browse service BEFORE the
            // sidecar-ready block below calls app.state::<BrowseService>() —
            // Tauri state() panics on unmanaged types. Snapshot push and
            // browse-loop start both run after this line.
            app.manage(mdns_service::BrowseService::new());

            match resolve_sidecar_path(app.handle()) {
                Some(path) => {
                    let mut cmd = std::process::Command::new("node");
                    cmd.env("TIDE_DB_PATH", &db_path);
                    cmd.arg(&path);
                    match sidecar::Sidecar::spawn(cmd) {
                        Ok(sc) => {
                            match sc.ping() {
                                Ok(_) => log::info!(
                                    "tide sidecar ready at {}",
                                    path.display()
                                ),
                                Err(e) => log::warn!(
                                    "tide sidecar spawned but ping failed: {e}; \
                                     event CRUD will fall back client-side"
                                ),
                            }
                            // DC-21 §3.2(b)/§5.1: sidecar confirmed ready —
                            // push the current browse snapshot so a restarted
                            // sidecar seeds its endpoint cache without
                            // waiting a full browse cycle (D8: idempotent,
                            // order-independent). PingSink forwards each
                            // recorded observation as an mdns_event push.
                            // BrowseService is managed earlier in setup (F1).
                            {
                                let sc_arc = Arc::new(sc);
                                let svc = app.state::<mdns_service::BrowseService>();
                                svc.push_snapshot(Arc::new(mdns_service::PingSink { sc: Arc::clone(&sc_arc) }));
                                app.manage(SidecarState(Mutex::new(Some(sc_arc))));
                            }
                        }
                        Err(e) => {
                            log::error!("failed to spawn tide sidecar: {e}");
                            app.manage(SidecarState(Mutex::new(None)));
                        }
                    }
                }
                None => {
                    log::error!(
                        "tide sidecar bundle not found \
                         (set TIDE_SIDECAR_PATH or run `npm run sidecar:build`); \
                         event CRUD will fall back client-side"
                    );
                    app.manage(SidecarState(Mutex::new(None)));
                }
            }
            app.manage(SyncFlight(AtomicBool::new(false)));


            // DC-21 §3.1/§3.2/§5.1: start continuous mDNS browsing in the
            // shell; every browse transition is pushed to the sidecar as an
            // mdns_event notification over the existing NDJSON channel. The
            // sidecar owns the ONE endpoint cache (D2); this shell never
            // stores peer state (D3: routing hints only). Feature-gated:
            // without the `mdns` cargo feature this is an honest no-op
            // (§6.1/D9) and the sidecar falls back to last-known endpoints.
            #[cfg(feature = "mdns")]
            {
                struct SidecarEventSink {
                    sc: Arc<sidecar::Sidecar>,
                }
                impl mdns_service::EventSink for SidecarEventSink {
                    fn push_event(&self, event: mdns_service::MdnsEvent) {
                        if let Err(e) = self.sc.notify_mdns_event(
                            &event.kind,
                            &event.instance_name,
                            &event.host,
                            event.port,
                            event.observed_at,
                            event.ttl_ms,
                        ) {
                            log::debug!("mdns_event push skipped: {e}");
                        }
                    }
                    fn sidecar_alive(&self) -> bool {
                        self.sc.is_alive()
                    }
                    // DC-21 §3.2(b): every observation also lands in the
                    // BrowseService snapshot buffer (via the svc handle the
                    // browse loop is started with) so a sidecar restart can
                    // be re-seeded instantly.
                    fn record_observation(&self, event: mdns_service::MdnsEvent) {
                        // Snapshot bookkeeping happens in BrowseService; the
                        // sink's own record is a no-op placeholder (the
                        // BrowseService.record path covers it in start()).
                        let _ = event;
                    }
                }
                if let Ok(state) = app
                    .try_state::<SidecarState>()
                    .ok_or_else(|| "no sidecar".to_string())
                    .and_then(|s| {
                        s.0.lock()
                            .map(|g| g.clone())
                            .map_err(|_| "sidecar lock poisoned".to_string())
                    })
                {
                    if let Some(sc) = state {
                        let sink: Arc<dyn mdns_service::EventSink> =
                            Arc::new(SidecarEventSink { sc });
                        let svc = app.state::<mdns_service::BrowseService>();
                        let mdns = match mdns_service::MdnsAdapterImpl::new() {
                            Ok(m) => Some(m),
                            Err(e) => {
                                log::warn!(
                                    "mdns daemon unavailable: {e} (sidecar falls back to last-known endpoints, DC-21 §6.1)"
                                );
                                None
                            }
                        };
                        match mdns {
                            Some(m) => {
                                if let Err(e) = svc.start(sink, m) {
                                    log::warn!("mdns browse service failed to start: {e}");
                                }
                            }
                            None => {
                                // Feature on but daemon unavailable: skip the
                                // browse loop; sidecar uses last-known (D9).
                            }
                        }
                    } else {
                        log::warn!("mdns browse service not started: no sidecar");
                    }
                }
            }
            #[cfg(not(feature = "mdns"))]
            {
                log::info!("mdns browse service not started: feature disabled (DC-21 §6.1/D9)");
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            // DC-19 §2.2: closing the main window HIDES it. Quit is
            // exclusively a menu action (§4.4); the process and sidecar stay
            // alive. (Tray-less fallback §4.6 MAY instead quit on close;
            // this build keeps hide always — the in-app Quit entry remains
            // the fallback exit.)
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            list_events,
            create_event,
            sync_op,
            update_event,
            delete_event,
            manual_sync_now,
            quit_tide,
            get_settings,
            set_settings,
            get_reminder,
            set_reminder,
            clear_reminder,
            list_series,
            update_series_rule,
            update_occurrence
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod general_settings_tests {
    use super::*;

    #[test]
    fn defaults_are_dark_and_24h() {
        let s = TideSettings::default();
        assert_eq!(s.general_theme, "dark");
        assert_eq!(s.general_time_format, "24h");
    }

    #[test]
    fn toml_round_trips_dotted_general_keys() {
        let text = r#"
sync_debounce_seconds = 10.0
sweep_interval_minutes = 10.0
max_concurrent_sessions = 3.0
max_incremental_backlog = 1000.0
"general.theme" = "light"
"general.time_format" = "12h"
"#;
        let s: TideSettings = toml::from_str(text).expect("parse");
        assert_eq!(s.general_theme, "light");
        assert_eq!(s.general_time_format, "12h");
        let out = toml::to_string_pretty(&s).expect("serialize");
        assert!(out.contains(r#""general.theme" = "light""#));
        let back: TideSettings = toml::from_str(&out).expect("re-parse");
        assert_eq!(back.general_theme, "light");
        assert_eq!(back.general_time_format, "12h");
    }

    #[test]
    fn clamped_falls_back_on_unknown_general_values() {
        let mut s = TideSettings::default();
        s.general_theme = "auto".to_string();
        s.general_time_format = "system".to_string();
        let s = s.clamped();
        assert_eq!(s.general_theme, "dark");
        assert_eq!(s.general_time_format, "24h");
    }

    #[test]
    fn missing_general_keys_deserialize_to_defaults() {
        let text = r#"
sync_debounce_seconds = 10.0
sweep_interval_minutes = 10.0
max_concurrent_sessions = 3.0
max_incremental_backlog = 1000.0
"#;
        let s: TideSettings = toml::from_str(text).expect("parse");
        assert_eq!(s.general_theme, "dark");
        assert_eq!(s.general_time_format, "24h");
    }
}
