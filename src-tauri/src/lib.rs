pub mod codex_source;
pub mod domain;
pub mod inbox_store;

#[tauri::command]
fn list_sessions(state: tauri::State<inbox_store::InboxStore>) -> Vec<domain::session::SessionRow> {
    state.list_sessions()
}

#[tauri::command]
fn dismiss_session(
    state: tauri::State<inbox_store::InboxStore>,
    session_id: String,
) -> Vec<domain::session::SessionRow> {
    state.dismiss_session(&session_id)
}

#[tauri::command]
fn restore_session(
    state: tauri::State<inbox_store::InboxStore>,
    session_id: String,
) -> Vec<domain::session::SessionRow> {
    state.restore_session(&session_id)
}

#[tauri::command]
fn source_health(
    state: tauri::State<inbox_store::InboxStore>,
) -> domain::source_health::SourceHealth {
    state.source_health()
}

#[tauri::command]
fn jump_to_session(
    state: tauri::State<inbox_store::InboxStore>,
    session_id: String,
) -> inbox_store::JumpResult {
    state.jump_to_session(&session_id)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(inbox_store::InboxStore::default())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            list_sessions,
            dismiss_session,
            restore_session,
            source_health,
            jump_to_session
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
