pub mod codex_source;
pub mod domain;
pub mod inbox_store;

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{Emitter, LogicalPosition, Manager, WebviewWindow};

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

fn apply_panel_window_behavior(window: &WebviewWindow) {
    let _ = window.set_always_on_top(true);
    let _ = window.set_visible_on_all_workspaces(true);
    let _ = move_panel_window(window, PanelPosition::TopRight);
}

fn move_panel_window(window: &WebviewWindow, position: PanelPosition) -> tauri::Result<()> {
    let Some(monitor) = window.current_monitor()? else {
        return Ok(());
    };
    let monitor_position = monitor.position();
    let monitor_size = monitor.size();
    let scale_factor = monitor.scale_factor();
    let window_size = window.outer_size()?;
    let margin = 16.0;
    let monitor_x = monitor_position.x as f64 / scale_factor;
    let monitor_y = monitor_position.y as f64 / scale_factor;
    let monitor_width = monitor_size.width as f64 / scale_factor;
    let monitor_height = monitor_size.height as f64 / scale_factor;
    let window_width = window_size.width as f64 / scale_factor;
    let window_height = window_size.height as f64 / scale_factor;
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

    window.set_position(LogicalPosition::new(x, y))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(inbox_store::InboxStore::default())
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
                "agent-session-inbox",
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
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = move_panel_window(&window, position);
                    }
                }
            });

            Ok(())
        })
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
