pub mod codex_source;
pub mod codex_hooks;
pub mod domain;
pub mod inbox_store;

use std::sync::Arc;

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{Emitter, LogicalPosition, Manager, Monitor, Runtime, WebviewWindow};

#[tauri::command]
async fn list_sessions(
    state: tauri::State<'_, Arc<inbox_store::InboxStore>>,
    follow_up_to_idle_minutes: Option<f64>,
) -> Result<Vec<domain::session::SessionRow>, String> {
    let state = Arc::clone(state.inner());
    let follow_up_to_idle_minutes = Some(
        inbox_store::normalize_follow_up_to_idle_minutes_from_transport(
            follow_up_to_idle_minutes,
        ),
    );
    tauri::async_runtime::spawn_blocking(move || {
        state.list_sessions_with_follow_up_to_idle_minutes(follow_up_to_idle_minutes)
    })
        .await
        .map_err(|error| format!("session worker failed: {error}"))
}

#[tauri::command]
async fn dismiss_session(
    state: tauri::State<'_, Arc<inbox_store::InboxStore>>,
    session_id: String,
) -> Result<Vec<domain::session::SessionRow>, String> {
    let state = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || state.dismiss_session(&session_id))
        .await
        .map_err(|error| format!("dismiss worker failed: {error}"))
}

#[tauri::command]
async fn dismiss_sessions(
    state: tauri::State<'_, Arc<inbox_store::InboxStore>>,
    session_ids: Vec<String>,
) -> Result<Vec<domain::session::SessionRow>, String> {
    let state = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || state.dismiss_sessions(&session_ids))
        .await
        .map_err(|error| format!("dismiss worker failed: {error}"))
}

#[tauri::command]
async fn restore_session(
    state: tauri::State<'_, Arc<inbox_store::InboxStore>>,
    session_id: String,
) -> Result<Vec<domain::session::SessionRow>, String> {
    let state = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || state.restore_session(&session_id))
        .await
        .map_err(|error| format!("restore worker failed: {error}"))
}

#[tauri::command]
async fn pin_session(
    state: tauri::State<'_, Arc<inbox_store::InboxStore>>,
    session_id: String,
) -> Result<Vec<domain::session::SessionRow>, String> {
    let state = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || state.pin_session(&session_id))
        .await
        .map_err(|error| format!("pin worker failed: {error}"))
}

#[tauri::command]
async fn unpin_session(
    state: tauri::State<'_, Arc<inbox_store::InboxStore>>,
    session_id: String,
) -> Result<Vec<domain::session::SessionRow>, String> {
    let state = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || state.unpin_session(&session_id))
        .await
        .map_err(|error| format!("unpin worker failed: {error}"))
}

#[tauri::command]
fn source_health(
    state: tauri::State<Arc<inbox_store::InboxStore>>,
) -> domain::source_health::SourceHealth {
    state.source_health()
}

#[tauri::command]
fn codex_hook_integration_status() -> codex_hooks::CodexHookIntegrationStatus {
    codex_hooks::codex_hook_integration_status()
}

#[tauri::command]
async fn install_codex_hooks() -> Result<codex_hooks::CodexHookIntegrationStatus, String> {
    tauri::async_runtime::spawn_blocking(codex_hooks::install_codex_hooks)
        .await
        .map_err(|error| format!("install hook worker failed: {error}"))?
}

#[tauri::command]
async fn jump_to_session(
    state: tauri::State<'_, Arc<inbox_store::InboxStore>>,
    session_id: String,
    acknowledged_session_ids: Option<Vec<String>>,
    follow_up_to_idle_minutes: Option<f64>,
) -> Result<inbox_store::JumpResult, String> {
    let state = Arc::clone(state.inner());
    let fallback_session_id = session_id.clone();
    let follow_up_to_idle_minutes = Some(
        inbox_store::normalize_follow_up_to_idle_minutes_from_transport(
            follow_up_to_idle_minutes,
        ),
    );
    tauri::async_runtime::spawn_blocking(move || {
        state.jump_to_session(
            &session_id,
            acknowledged_session_ids.as_deref(),
            follow_up_to_idle_minutes,
        )
    })
        .await
        .map_err(|error| format!("jump worker failed: {error}"))
        .or_else(|error| Ok(inbox_store::JumpResult {
            session_id: fallback_session_id,
            availability: domain::session::JumpAvailability::Unavailable,
            target: domain::session::JumpTarget::Unknown,
            message: format!("Jump-back unavailable: {error}"),
        }))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PanelPosition {
    TopLeft,
    TopRight,
    BottomLeft,
    BottomRight,
}

impl PanelPosition {
    fn from_menu_id(menu_id: &str) -> Option<Self> {
        match menu_id {
            "position_top_left" => Some(Self::TopLeft),
            "position_top_right" => Some(Self::TopRight),
            "position_bottom_left" => Some(Self::BottomLeft),
            "position_bottom_right" => Some(Self::BottomRight),
            _ => None,
        }
    }
}

fn apply_panel_window_behavior<R: Runtime>(window: &WebviewWindow<R>) {
    let _ = window.set_always_on_top(true);
    let _ = window.set_visible_on_all_workspaces(true);
    let _ = move_panel_window(window, PanelPosition::TopRight);
}

fn position_on_monitor(
    monitor: &Monitor,
    window_width: f64,
    window_height: f64,
    position: PanelPosition,
) -> LogicalPosition<f64> {
    let monitor_position = monitor.position();
    let monitor_size = monitor.size();
    let scale_factor = monitor.scale_factor();
    let margin = 16.0;
    let monitor_x = monitor_position.x as f64 / scale_factor;
    let monitor_y = monitor_position.y as f64 / scale_factor;
    let monitor_width = monitor_size.width as f64 / scale_factor;
    let monitor_height = monitor_size.height as f64 / scale_factor;
    let x = match position {
        PanelPosition::TopLeft | PanelPosition::BottomLeft => monitor_x + margin,
        PanelPosition::TopRight | PanelPosition::BottomRight => {
            monitor_x + monitor_width - window_width - margin
        }
    };
    let y = match position {
        PanelPosition::TopLeft | PanelPosition::TopRight => monitor_y + margin,
        PanelPosition::BottomLeft | PanelPosition::BottomRight => {
            monitor_y + monitor_height - window_height - margin
        }
    };

    LogicalPosition::new(x, y)
}

fn move_panel_window<R: Runtime>(
    window: &WebviewWindow<R>,
    position: PanelPosition,
) -> tauri::Result<()> {
    let Some(monitor) = window.current_monitor()? else {
        return Ok(());
    };
    let window_size = window.outer_size()?;
    let scale_factor = monitor.scale_factor();
    let window_width = window_size.width as f64 / scale_factor;
    let window_height = window_size.height as f64 / scale_factor;
    window.set_position(position_on_monitor(
        &monitor,
        window_width,
        window_height,
        position,
    ))
}


fn move_main_panel_window<R: Runtime>(app: &tauri::AppHandle<R>, position: PanelPosition) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = move_panel_window(&window, position);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(Arc::new(inbox_store::InboxStore::default()))
        .plugin(tauri_plugin_opener::init())
        .menu(|handle| {
            let settings = MenuItem::with_id(handle, "open_management", "Settings...", true, Some(","))?;
            let position_top_left =
                MenuItem::with_id(handle, "position_top_left", "Top Left", true, None::<&str>)?;
            let position_top_right =
                MenuItem::with_id(handle, "position_top_right", "Top Right", true, None::<&str>)?;
            let position_bottom_left =
                MenuItem::with_id(handle, "position_bottom_left", "Bottom Left", true, None::<&str>)?;
            let position_bottom_right =
                MenuItem::with_id(handle, "position_bottom_right", "Bottom Right", true, None::<&str>)?;
            let position_menu = Submenu::with_items(
                handle,
                "Position",
                true,
                &[
                    &position_top_left,
                    &position_top_right,
                    &position_bottom_left,
                    &position_bottom_right,
                ],
            )?;
            let app_menu = Submenu::with_items(
                handle,
                "Attn",
                true,
                &[
                    &PredefinedMenuItem::about(handle, None, None)?,
                    &settings,
                    &position_menu,
                    &PredefinedMenuItem::separator(handle)?,
                    &PredefinedMenuItem::hide(handle, None)?,
                    &PredefinedMenuItem::hide_others(handle, None)?,
                    &PredefinedMenuItem::separator(handle)?,
                    &PredefinedMenuItem::quit(handle, None)?,
                ],
            )?;

            Menu::with_items(handle, &[&app_menu])
        })
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                apply_panel_window_behavior(&window);
            }

            app.handle().on_menu_event(|app, event| {
                let menu_id = event.id().as_ref();
                if menu_id == "open_management" {
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.show();
                        let _ = window.set_focus();
                        let _ = window.emit("agent-session-inbox://open-management", "management");
                    }
                } else if let Some(position) = PanelPosition::from_menu_id(menu_id) {
                    move_main_panel_window(app, position);
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_sessions,
            dismiss_session,
            dismiss_sessions,
            restore_session,
            pin_session,
            unpin_session,
            source_health,
            codex_hook_integration_status,
            install_codex_hooks,
            jump_to_session
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
