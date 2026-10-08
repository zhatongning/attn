pub mod codex_source;
pub mod codex_hooks;
pub mod domain;
pub mod inbox_store;
pub mod panel_placement;
#[cfg(desktop)]
pub mod panel_shortcut;

use std::sync::Arc;

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{Emitter, Manager, Runtime, WebviewWindow};
use panel_placement::{Corner, PanelPlacement};

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
            succeeded: false,
            message: format!("Jump-back unavailable: {error}"),
        }))
}

fn corner_from_menu_id(menu_id: &str) -> Option<Corner> {
    match menu_id {
        "position_top_left" => Some(Corner::TopLeft),
        "position_top_right" => Some(Corner::TopRight),
        "position_bottom_left" => Some(Corner::BottomLeft),
        "position_bottom_right" => Some(Corner::BottomRight),
        _ => None,
    }
}

fn apply_panel_window_behavior<R: Runtime>(window: &WebviewWindow<R>) {
    let _ = window.set_always_on_top(true);
    let _ = window.set_visible_on_all_workspaces(true);
}

#[cfg(desktop)]
#[tauri::command]
fn anchor_panel_position(state: tauri::State<'_, PanelPlacement>, anchor: String) -> Result<(), String> {
    // Temporary accepted-intent compatibility for the WIP frontend (Task 5).
    // A null response carries no coordinates and cannot claim OS completion.
    let corner: Corner = serde_json::from_value(serde_json::Value::String(anchor))
        .map_err(|_| "invalid corner".to_owned())?;
    state.snap(corner)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .manage(Arc::new(inbox_store::InboxStore::default()))
        .plugin(tauri_plugin_opener::init());
    #[cfg(desktop)]
    let builder = builder
        .manage(panel_shortcut::PanelShortcutState::default())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build());

    let builder = builder
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
                let placement = PanelPlacement::new(window.clone())?;
                let observer = placement.clone();
                window.on_window_event(move |event| {
                    if let Err(error) = observer.on_window_event(event) {
                        eprintln!("panel placement observation rejected: {error}");
                    }
                });
                app.manage(placement);
                app.state::<PanelPlacement>().snap(Corner::TopRight)?;
            }

            #[cfg(desktop)]
            if let Err(error) = panel_shortcut::register_default(app.handle()) {
                eprintln!("failed to register default panel shortcut: {error}");
            }
            app.handle().on_menu_event(|app, event| {
                let menu_id = event.id().as_ref();
                if menu_id == "open_management" {
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.show();
                        let _ = window.set_focus();
                        let _ = window.emit("agent-session-inbox://open-management", "management");
                    }
                } else if let Some(corner) = corner_from_menu_id(menu_id) {
                    if let Some(placement) = app.try_state::<PanelPlacement>() {
                        if let Err(error) = placement.snap(corner) {
                            eprintln!("panel placement request rejected: {error}");
                        }
                    }
                }
            });

            Ok(())
        });

    #[cfg(desktop)]
    let builder = builder.invoke_handler(tauri::generate_handler![
        list_sessions,
        dismiss_session,
        dismiss_sessions,
        restore_session,
        pin_session,
        unpin_session,
        source_health,
        codex_hook_integration_status,
        install_codex_hooks,
        jump_to_session,
        panel_shortcut::configure_panel_shortcut,
        anchor_panel_position,
        panel_placement::adapter::resize_panel,
        panel_placement::adapter::restore_panel_placement,
        panel_placement::adapter::begin_panel_drag
    ]);
    #[cfg(not(desktop))]
    let builder = builder.invoke_handler(tauri::generate_handler![
        list_sessions,
        dismiss_session,
        dismiss_sessions,
        restore_session,
        pin_session,
        unpin_session,
        source_health,
        codex_hook_integration_status,
        install_codex_hooks,
        jump_to_session,
        panel_placement::adapter::resize_panel,
        panel_placement::adapter::restore_panel_placement,
        panel_placement::adapter::begin_panel_drag
    ]);

    builder
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
