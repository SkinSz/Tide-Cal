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

mod sidecar;

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
#[tauri::command]
async fn sync_op(
    sc: State<'_, SidecarState>,
    op: String,
    args: serde_json::Value,
) -> Result<serde_json::Value, String> {
    const ALLOWED: [&str; 18] = [
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
        // Pkg5 (QA M-2): read-only Conflicts surface (DC-14).
        "list_conflicts",
        "conflict_detail",
        // DC-14 §4.3 write path: conflict resolution actions.
        "resolve_conflict",
        "skip_conflict",
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
    dev.is_file().then_some(dev)
}

/// DC-19 §4: tray icon + context menu [Open Tide, Sync now, Quit].
/// Returns Err when the desktop has no StatusNotifier/AppIndicator support —
/// the caller degrades to a windowed app (§2.3).
fn build_tray(app: &tauri::AppHandle) -> Result<(), String> {
    let open_item = MenuItem::with_id(app, "open-tide", "Open Tide", true, None::<&str>)
        .map_err(|e| format!("menu item: {e}"))?;
    // Sync now starts ENABLED; the first trigger_sync_now adjusts it. The
    // no-peers-paired disable is enforced in trigger_sync_now (§4.2).
    let sync_item = MenuItem::with_id(app, "sync-now", "Sync now", true, None::<&str>)
        .map_err(|e| format!("menu item: {e}"))?;
    let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)
        .map_err(|e| format!("menu item: {e}"))?;
    // §4.5: at most one separator between the functional group and Quit.
    let separator = PredefinedMenuItem::separator(app).map_err(|e| format!("separator: {e}"))?;
    let menu = Menu::with_items(app, &[&open_item, &sync_item, &separator, &quit_item])
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
            "quit" => quit_app(app),
            _ => {}
        })
        .build(app)
        .map_err(|e| format!("tray build: {e}"))?;

    app.manage(TraySyncItem(Mutex::new(Some(sync_item))));
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
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
                            app.manage(SidecarState(Mutex::new(Some(Arc::new(sc)))));
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
            quit_tide
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
