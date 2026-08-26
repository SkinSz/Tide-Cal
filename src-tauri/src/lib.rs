// Tide desktop shell: Tauri IPC commands proxy event CRUD to the Node
// sidecar (dist/sidecar.mjs) hosting the TS domain core. See sidecar.rs.
//
// The sidecar is spawned once in `setup`. If node is unavailable or the
// child dies, commands return Err(String) and the frontend store degrades
// to its localStorage fallback.

mod sidecar;

use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{Manager, State};

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
/// Arc-wrapped so commands can clone it into blocking tasks.
struct SidecarState(std::sync::Arc<Option<sidecar::Sidecar>>);

// ---------------------------------------------------------------------------
// IPC commands (proxy to the sidecar)
// ---------------------------------------------------------------------------

fn proxy(
    sc: &std::sync::Arc<Option<sidecar::Sidecar>>,
    op: &str,
    args: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let sc: &sidecar::Sidecar = match sc.as_ref() {
        Some(s) => s,
        None => return Err("tide sidecar unavailable".to_string()),
    };
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
    let handle = std::sync::Arc::clone(&sc.0);
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
    let handle = std::sync::Arc::clone(&sc.0);
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
    let handle = std::sync::Arc::clone(&sc.0);
    tauri::async_runtime::spawn_blocking(move || proxy(&handle, "update_event", args))
        .await
        .map_err(|e| format!("join sidecar task: {e}"))?
}

#[tauri::command]
async fn delete_event(sc: State<'_, SidecarState>, id: String) -> Result<(), String> {
    let args = json!({ "id": id });
    let handle = std::sync::Arc::clone(&sc.0);
    tauri::async_runtime::spawn_blocking(move || proxy(&handle, "delete_event", args))
        .await
        .map_err(|e| format!("join sidecar task: {e}"))??;
    Ok(())
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
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
                            app.manage(SidecarState(std::sync::Arc::new(Some(sc))));
                        }
                        Err(e) => {
                            log::error!("failed to spawn tide sidecar: {e}");
                            app.manage(SidecarState(std::sync::Arc::new(None)));
                        }
                    }
                }
                None => {
                    log::error!(
                        "tide sidecar bundle not found \
                         (set TIDE_SIDECAR_PATH or run `npm run sidecar:build`); \
                         event CRUD will fall back client-side"
                    );
                    app.manage(SidecarState(std::sync::Arc::new(None)));
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_events,
            create_event,
            update_event,
            delete_event
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
