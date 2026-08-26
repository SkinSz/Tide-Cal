use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{Manager, State};

/// A calendar event as stored in the local Tide database.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct Event {
    id: String,
    title: String,
    description: String,
    /// epoch milliseconds
    start_ms: i64,
    /// epoch milliseconds
    end_ms: i64,
    all_day: bool,
}

#[derive(Debug, Deserialize)]
struct EventInput {
    title: String,
    description: String,
    start_ms: i64,
    end_ms: i64,
    all_day: bool,
}

/// App state holding the SQLite connection (opened once in `setup`).
struct Db(Mutex<Connection>);

fn init_schema(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS events (
            id          TEXT PRIMARY KEY,
            title       TEXT NOT NULL,
            description TEXT NOT NULL DEFAULT '',
            start_ms    INTEGER NOT NULL,
            end_ms      INTEGER NOT NULL,
            all_day     INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_events_start ON events(start_ms);",
    )
}

fn row_to_event(row: &rusqlite::Row) -> rusqlite::Result<Event> {
    Ok(Event {
        id: row.get(0)?,
        title: row.get(1)?,
        description: row.get(2)?,
        start_ms: row.get(3)?,
        end_ms: row.get(4)?,
        all_day: row.get::<_, i64>(5)? != 0,
    })
}

// ---------------------------------------------------------------------------
// IPC commands
// ---------------------------------------------------------------------------

#[tauri::command]
fn list_events(
    db: State<Db>,
    from_ms: Option<i64>,
    to_ms: Option<i64>,
) -> Result<Vec<Event>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    // Overlap test: event.start < to AND event.end > from
    let sql = match (from_ms, to_ms) {
        (Some(from), Some(to)) => (
            "SELECT id,title,description,start_ms,end_ms,all_day FROM events \
             WHERE start_ms < ?1 AND end_ms > ?2 ORDER BY start_ms",
            vec![to, from],
        ),
        _ => ("SELECT id,title,description,start_ms,end_ms,all_day FROM events ORDER BY start_ms", vec![]),
    };
    let mut stmt = conn.prepare(sql.0).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params_from_iter(sql.1), row_to_event)
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

#[tauri::command]
fn create_event(db: State<Db>, input: EventInput) -> Result<Event, String> {
    let event = Event {
        id: format!(
            "{}-{}",
            chrono_millis(),
            &uuid_suffix()
        ),
        title: input.title,
        description: input.description,
        start_ms: input.start_ms,
        end_ms: input.end_ms,
        all_day: input.all_day,
    };
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO events (id,title,description,start_ms,end_ms,all_day) \
         VALUES (?1,?2,?3,?4,?5,?6)",
        rusqlite::params![
            event.id,
            event.title,
            event.description,
            event.start_ms,
            event.end_ms,
            event.all_day as i64
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(event)
}

#[tauri::command]
fn update_event(db: State<Db>, id: String, input: EventInput) -> Result<Event, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let n = conn
        .execute(
            "UPDATE events SET title=?2, description=?3, start_ms=?4, end_ms=?5, all_day=?6 \
             WHERE id=?1",
            rusqlite::params![
                id,
                input.title,
                input.description,
                input.start_ms,
                input.end_ms,
                input.all_day as i64
            ],
        )
        .map_err(|e| e.to_string())?;
    if n == 0 {
        return Err(format!("event not found: {id}"));
    }
    Ok(Event {
        id,
        title: input.title,
        description: input.description,
        start_ms: input.start_ms,
        end_ms: input.end_ms,
        all_day: input.all_day,
    })
}

#[tauri::command]
fn delete_event(db: State<Db>, id: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM events WHERE id=?1", [&id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn now_millis() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

fn chrono_millis() -> String {
    now_millis().to_string()
}

fn uuid_suffix() -> String {
    // 8 hex chars from a simple xorshift seeded by the clock — sufficient for
    // shell-phase local ids until the domain core's change-id generator lands.
    let mut x = now_millis() as u64 ^ 0x9E3779B97F4A7C15;
    let mut s = String::with_capacity(8);
    for _ in 0..4 {
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        s.push_str(&format!("{:04x}", (x & 0xFFFF) as u16));
    }
    s
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
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            let conn = Connection::open(dir.join("tide.db"))
                .map_err(|e| format!("open db: {e}"))?;
            conn.pragma_update(None, "journal_mode", "WAL")
                .map_err(|e| format!("wal: {e}"))?;
            init_schema(&conn).map_err(|e| format!("schema: {e}"))?;
            app.manage(Db(Mutex::new(conn)));
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
