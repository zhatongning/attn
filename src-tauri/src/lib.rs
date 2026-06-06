pub mod codex_source;
pub mod domain;
pub mod inbox_store;

use std::sync::Arc;

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{
    Emitter, LogicalPosition, Manager, Monitor, Runtime, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};

const PANEL_WINDOW_WIDTH: f64 = 560.0;
const PANEL_WINDOW_HEIGHT: f64 = 252.0;
const PANEL_WINDOW_MIN_WIDTH: f64 = 380.0;
const PANEL_WINDOW_MIN_HEIGHT: f64 = 188.0;
const PANEL_WINDOW_MAX_WIDTH: f64 = 640.0;
const PANEL_WINDOW_MAX_HEIGHT: f64 = 432.0;
const PANEL_REPLICA_LABEL_PREFIX: &str = "panel-display-";

#[tauri::command]
async fn list_sessions(
    state: tauri::State<'_, Arc<inbox_store::InboxStore>>,
) -> Result<Vec<domain::session::SessionRow>, String> {
    let state = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || state.list_sessions())
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
fn source_health(
    state: tauri::State<Arc<inbox_store::InboxStore>>,
) -> domain::source_health::SourceHealth {
    state.source_health()
}

#[tauri::command]
async fn jump_to_session(
    state: tauri::State<'_, Arc<inbox_store::InboxStore>>,
    session_id: String,
) -> Result<inbox_store::JumpResult, String> {
    let state = Arc::clone(state.inner());
    let fallback_session_id = session_id.clone();
    tauri::async_runtime::spawn_blocking(move || state.jump_to_session(&session_id))
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DisplayMode {
    Current,
    All,
}

impl DisplayMode {
    fn from_menu_id(menu_id: &str) -> Option<Self> {
        match menu_id {
            "display_current" => Some(Self::Current),
            "display_all" => Some(Self::All),
            _ => None,
        }
    }
}

fn apply_panel_window_behavior<R: Runtime>(window: &WebviewWindow<R>) {
    let _ = window.set_always_on_top(true);
    let _ = window.set_visible_on_all_workspaces(true);
    let _ = move_panel_window(window, PanelPosition::TopRight);
}

fn is_panel_replica(label: &str) -> bool {
    label.starts_with(PANEL_REPLICA_LABEL_PREFIX)
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

fn close_panel_replicas<R: Runtime>(app: &tauri::AppHandle<R>) {
    for (label, window) in app.webview_windows() {
        if is_panel_replica(&label) {
            let _ = window.close();
        }
    }
}

fn build_panel_window<'a, R: Runtime, M: Manager<R>>(
    manager: &'a M,
    label: &str,
    monitor: &Monitor,
    position: PanelPosition,
) -> tauri::Result<WebviewWindow<R>> {
    let window_position = position_on_monitor(
        monitor,
        PANEL_WINDOW_WIDTH,
        PANEL_WINDOW_HEIGHT,
        position,
    );

    WebviewWindowBuilder::new(manager, label, WebviewUrl::App("index.html".into()))
        .title("Attn")
        .inner_size(PANEL_WINDOW_WIDTH, PANEL_WINDOW_HEIGHT)
        .min_inner_size(PANEL_WINDOW_MIN_WIDTH, PANEL_WINDOW_MIN_HEIGHT)
        .max_inner_size(PANEL_WINDOW_MAX_WIDTH, PANEL_WINDOW_MAX_HEIGHT)
        .position(window_position.x, window_position.y)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .visible_on_all_workspaces(true)
        .skip_taskbar(true)
        .resizable(false)
        .focused(false)
        .build()
}

fn apply_display_mode<R: Runtime>(app: &tauri::AppHandle<R>, display_mode: DisplayMode) {
    close_panel_replicas(app);

    let Some(main_window) = app.get_webview_window("main") else {
        return;
    };

    let _ = main_window.show();
    let _ = move_panel_window(&main_window, PanelPosition::TopRight);

    if display_mode == DisplayMode::Current {
        return;
    }

    let current_monitor = main_window
        .current_monitor()
        .ok()
        .flatten()
        .map(|monitor| (*monitor.position(), *monitor.size()));

    let Ok(monitors) = main_window.available_monitors() else {
        return;
    };

    for (index, monitor) in monitors.iter().enumerate() {
        let monitor_key = (*monitor.position(), *monitor.size());
        if Some(monitor_key) == current_monitor {
            continue;
        }

        let label = format!("{PANEL_REPLICA_LABEL_PREFIX}{index}");
        if let Some(window) = app.get_webview_window(&label) {
            apply_panel_window_behavior(&window);
            continue;
        }

        match build_panel_window(app, &label, monitor, PanelPosition::TopRight) {
            Ok(window) => apply_panel_window_behavior(&window),
            Err(error) => eprintln!("failed to create panel window for display {index}: {error}"),
        }
    }
}

fn move_all_panel_windows<R: Runtime>(app: &tauri::AppHandle<R>, position: PanelPosition) {
    for (label, window) in app.webview_windows() {
        if label == "main" || is_panel_replica(&label) {
            let _ = move_panel_window(&window, position);
        }
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
            let display_current =
                MenuItem::with_id(handle, "display_current", "Current Display", true, None::<&str>)?;
            let display_all =
                MenuItem::with_id(handle, "display_all", "All Displays", true, None::<&str>)?;
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
            let display_menu = Submenu::with_items(
                handle,
                "Display",
                true,
                &[
                    &display_current,
                    &display_all,
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
                    &display_menu,
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
            apply_display_mode(app.handle(), DisplayMode::All);

            app.handle().on_menu_event(|app, event| {
                let menu_id = event.id().as_ref();
                if menu_id == "open_management" {
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.show();
                        let _ = window.set_focus();
                        let _ = window.emit("agent-session-inbox://open-management", "management");
                    }
                } else if let Some(position) = PanelPosition::from_menu_id(menu_id) {
                    move_all_panel_windows(app, position);
                } else if let Some(display_mode) = DisplayMode::from_menu_id(menu_id) {
                    apply_display_mode(app, display_mode);
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
