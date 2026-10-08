#[cfg(target_os = "macos")]
use objc2::MainThreadMarker;
#[cfg(target_os = "macos")]
use objc2_app_kit::{NSApplication, NSWindow};
use serde::Serialize;
use std::error::Error;
use std::fmt::{self, Display, Formatter};
use std::str::FromStr;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, EventTarget, Manager, Runtime};

pub use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutEvent, ShortcutState};

pub const DEFAULT_PANEL_SHORTCUT: &str = "shift+alt+super+space";
pub const TOGGLE_PANEL_EVENT: &str = "agent-session-inbox://toggle-panel";

#[derive(Default)]
pub struct PanelShortcutState {
    active: Mutex<PanelShortcutRegistrations>,
}

#[derive(Default)]
struct PanelShortcutRegistrations {
    toggle: ShortcutRegistrationState,
    position: ShortcutRegistrationState,
}

#[derive(Clone, Copy)]
enum ShortcutAction {
    Toggle,
    Position,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum ShortcutRegistrationState {
    Known(Option<String>),
    Uncertain,
}

impl Default for ShortcutRegistrationState {
    fn default() -> Self {
        Self::Known(None)
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PanelShortcutUpdate {
    pub active_shortcut: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PanelShortcutErrorCode {
    InvalidShortcut,
    RegistrationFailed,
    RollbackFailed,
    RegistrationUncertain,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PanelShortcutError {
    code: PanelShortcutErrorCode,
    active_shortcut: Option<String>,
    state_uncertain: bool,
}

impl PanelShortcutError {
    fn from_state(code: PanelShortcutErrorCode, state: &ShortcutRegistrationState) -> Self {
        match state {
            ShortcutRegistrationState::Known(active_shortcut) => Self {
                code,
                active_shortcut: active_shortcut.clone(),
                state_uncertain: false,
            },
            ShortcutRegistrationState::Uncertain => Self {
                code,
                active_shortcut: None,
                state_uncertain: true,
            },
        }
    }
}

impl Display for PanelShortcutError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self.code {
            PanelShortcutErrorCode::InvalidShortcut => "invalid_shortcut",
            PanelShortcutErrorCode::RegistrationFailed => "registration_failed",
            PanelShortcutErrorCode::RollbackFailed => "rollback_failed",
            PanelShortcutErrorCode::RegistrationUncertain => "registration_uncertain",
        })
    }
}

impl Error for PanelShortcutError {}

pub trait ShortcutRegistrar {
    fn register(&mut self, shortcut: &str) -> Result<(), ()>;
    fn unregister(&mut self, shortcut: &str) -> Result<(), ()>;
}

struct NativeShortcutRegistrar<'a, R: Runtime> {
    app: &'a AppHandle<R>,
    handler: fn(&AppHandle<R>, &Shortcut, ShortcutEvent),
}

impl<R: Runtime> ShortcutRegistrar for NativeShortcutRegistrar<'_, R> {
    fn register(&mut self, shortcut: &str) -> Result<(), ()> {
        let shortcut = Shortcut::from_str(shortcut).map_err(|_| ())?;
        self.app
            .global_shortcut()
            .on_shortcut(shortcut, self.handler)
            .map_err(|_| ())
    }

    fn unregister(&mut self, shortcut: &str) -> Result<(), ()> {
        let shortcut = Shortcut::from_str(shortcut).map_err(|_| ())?;
        self.app.global_shortcut().unregister(shortcut).map_err(|_| ())
    }
}

fn update_native_shortcut<R: Runtime>(
    app: &AppHandle<R>,
    state: &PanelShortcutState,
    action: ShortcutAction,
    requested: Option<&str>,
) -> Result<PanelShortcutUpdate, PanelShortcutError> {
    let handler: fn(&AppHandle<R>, &Shortcut, ShortcutEvent) = match action {
        ShortcutAction::Toggle => handle_panel_shortcut_event::<R>,
        ShortcutAction::Position => handle_position_shortcut_event::<R>,
    };
    let mut registrar = NativeShortcutRegistrar { app, handler };
    update_action_shortcut(state, action, requested, &mut registrar, || {
        if let Some(placement) = app.try_state::<crate::panel_placement::PanelPlacement>() {
            if let Err(error) = placement.on_position_shortcut(ShortcutState::Released) {
                eprintln!("failed to release panel position shortcut: {error}");
            }
        }
    })
}

fn update_action_shortcut(
    state: &PanelShortcutState,
    action: ShortcutAction,
    requested: Option<&str>,
    registrar: &mut impl ShortcutRegistrar,
    release_position: impl FnOnce(),
) -> Result<PanelShortcutUpdate, PanelShortcutError> {
    let mut active = state.active.lock().unwrap();
    let previous_position = active.position.clone();
    let result = apply_action_shortcut_update(
        &mut active,
        action,
        requested,
        registrar,
    );
    let position_changed = matches!(action, ShortcutAction::Position)
        && previous_position != active.position;
    drop(active);
    // Unregistering a held key can suppress its native Released event. The
    // placement reducer owns the latch; a no-op/rejected registration keeps it.
    // Never reenter placement while holding the registration mutex.
    if position_changed {
        release_position();
    }
    result.map(|active_shortcut| PanelShortcutUpdate { active_shortcut })
}

#[tauri::command]
pub fn configure_panel_shortcut(
    app: AppHandle,
    state: tauri::State<'_, PanelShortcutState>,
    shortcut: Option<String>,
) -> Result<PanelShortcutUpdate, PanelShortcutError> {
    update_native_shortcut(&app, state.inner(), ShortcutAction::Toggle, shortcut.as_deref())
}

#[tauri::command]
pub fn configure_position_shortcut(
    app: AppHandle,
    state: tauri::State<'_, PanelShortcutState>,
    shortcut: Option<String>,
) -> Result<PanelShortcutUpdate, PanelShortcutError> {
    update_native_shortcut(&app, state.inner(), ShortcutAction::Position, shortcut.as_deref())
}

pub fn register_default<R: Runtime>(app: &AppHandle<R>) -> Result<(), PanelShortcutError> {
    let state = app.state::<PanelShortcutState>();
    update_native_shortcut(
        app,
        state.inner(),
        ShortcutAction::Toggle,
        Some(DEFAULT_PANEL_SHORTCUT),
    )
    .map(|_| ())
}

pub fn canonicalize_shortcut(value: &str) -> Result<String, PanelShortcutErrorCode> {
    let shortcut = Shortcut::from_str(value)
        .map(|shortcut| canonicalize_native_shortcut(shortcut.into_string()))
        .map_err(|_| PanelShortcutErrorCode::InvalidShortcut)?;

    let parts = shortcut.split('+').collect::<Vec<_>>();
    let Some(key) = parts.last() else {
        return Err(PanelShortcutErrorCode::InvalidShortcut);
    };
    let modifiers = &parts[..parts.len() - 1];
    let primary_modifier = modifiers
        .iter()
        .any(|modifier| matches!(*modifier, "alt" | "control" | "super"));
    let supported_key = (key.len() == 1
        && key
            .chars()
            .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit()))
        || key
            .strip_prefix('f')
            .and_then(|number| number.parse::<u8>().ok().map(|value| (number, value)))
            .is_some_and(|(number, value)| (1..=20).contains(&value) && number == value.to_string())
        || matches!(
            *key,
            "space"
                | "down"
                | "left"
                | "right"
                | "up"
                | "backspace"
                | "delete"
                | "end"
                | "enter"
                | "home"
                | "insert"
                | "pagedown"
                | "pageup"
                | "tab"
        );
    if !primary_modifier || !supported_key {
        return Err(PanelShortcutErrorCode::InvalidShortcut);
    }
    Ok(shortcut)
}

fn canonicalize_native_shortcut(value: String) -> String {
    let mut parts = value.split('+').map(str::to_ascii_lowercase).collect::<Vec<_>>();
    let key = parts.pop().expect("native shortcuts always include a key");
    let key = key
        .strip_prefix("key")
        .filter(|key| key.len() == 1)
        .or_else(|| key.strip_prefix("digit").filter(|key| key.len() == 1))
        .map_or(key.as_str(), |key| key)
        .to_owned();
    let key = key.strip_prefix("arrow").unwrap_or(&key);
    parts.push(key.to_owned());
    parts.join("+")
}

fn apply_shortcut_update(
    active: &mut ShortcutRegistrationState,
    requested: Option<&str>,
    registrar: &mut impl ShortcutRegistrar,
) -> Result<Option<String>, PanelShortcutError> {
    let previous = match active {
        ShortcutRegistrationState::Known(previous) => previous.clone(),
        ShortcutRegistrationState::Uncertain => {
            return Err(PanelShortcutError::from_state(
                PanelShortcutErrorCode::RegistrationUncertain,
                active,
            ));
        }
    };
    let requested = requested
        .map(canonicalize_shortcut)
        .transpose()
        .map_err(|code| PanelShortcutError::from_state(code, active))?;

    if previous == requested {
        return Ok(previous);
    }

    match requested.as_deref() {
        Some(next) => {
            if registrar.register(next).is_err() {
                return Err(PanelShortcutError::from_state(
                    PanelShortcutErrorCode::RegistrationFailed,
                    active,
                ));
            }

            if let Some(previous) = previous.as_deref() {
                if registrar.unregister(previous).is_err() {
                    *active = ShortcutRegistrationState::Uncertain;
                    let code = if registrar.unregister(next).is_ok() {
                        PanelShortcutErrorCode::RegistrationUncertain
                    } else {
                        PanelShortcutErrorCode::RollbackFailed
                    };
                    return Err(PanelShortcutError::from_state(code, active));
                }
            }
        }
        None => {
            if let Some(previous) = previous.as_deref() {
                if registrar.unregister(previous).is_err() {
                    *active = ShortcutRegistrationState::Uncertain;
                    return Err(PanelShortcutError::from_state(
                        PanelShortcutErrorCode::RegistrationUncertain,
                        active,
                    ));
                }
            }
        }
    }

    *active = ShortcutRegistrationState::Known(requested.clone());
    Ok(requested)
}

fn apply_action_shortcut_update(
    registrations: &mut PanelShortcutRegistrations,
    action: ShortcutAction,
    requested: Option<&str>,
    registrar: &mut impl ShortcutRegistrar,
) -> Result<Option<String>, PanelShortcutError> {
    let (active, other) = match action {
        ShortcutAction::Toggle => (&mut registrations.toggle, &registrations.position),
        ShortcutAction::Position => (&mut registrations.position, &registrations.toggle),
    };
    if matches!(active, ShortcutRegistrationState::Uncertain)
        || matches!(other, ShortcutRegistrationState::Uncertain)
    {
        return Err(PanelShortcutError::from_state(
            PanelShortcutErrorCode::RegistrationUncertain,
            &ShortcutRegistrationState::Uncertain,
        ));
    }
    let canonical = requested
        .map(canonicalize_shortcut)
        .transpose()
        .map_err(|code| PanelShortcutError::from_state(code, active))?;
    if matches!(other, ShortcutRegistrationState::Known(Some(existing)) if canonical.as_ref() == Some(existing)) {
        return Err(PanelShortcutError::from_state(
            PanelShortcutErrorCode::RegistrationFailed,
            active,
        ));
    }
    apply_shortcut_update(active, canonical.as_deref(), registrar)
}

pub fn is_pressed(state: ShortcutState) -> bool {
    matches!(state, ShortcutState::Pressed)
}

fn handle_shortcut_event(state: ShortcutState, on_pressed: impl FnOnce()) {
    if is_pressed(state) {
        on_pressed();
    }
}

#[cfg(target_os = "macos")]
#[derive(Debug, PartialEq, Eq)]
struct RevealPlan {
    was_hidden: bool,
    unhide_app: bool,
    order_front: bool,
}

#[cfg(target_os = "macos")]
fn reveal_plan(app_hidden: bool, window_visible: bool) -> RevealPlan {
    let was_hidden = app_hidden || !window_visible;
    RevealPlan {
        was_hidden,
        unhide_app: app_hidden,
        order_front: was_hidden,
    }
}

#[cfg(target_os = "macos")]
fn reveal_then_emit<E>(
    reveal: impl FnOnce(std::sync::mpsc::SyncSender<bool>) -> Result<(), E>,
    emit: impl FnOnce(bool),
) -> Result<bool, E> {
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    reveal(sender)?;
    // with_webview runs synchronously on the macOS shortcut callback's main thread.
    // Its window-id lock must be released before emit_to evaluates JavaScript.
    if let Ok(was_hidden) = receiver.try_recv() {
        emit(was_hidden);
        Ok(true)
    } else {
        Ok(false)
    }
}

fn emit_panel_toggle<R: Runtime>(app: &AppHandle<R>, was_hidden: bool) {
    if let Err(error) = app.emit_to(
        EventTarget::webview_window("main"),
        TOGGLE_PANEL_EVENT,
        was_hidden,
    ) {
        eprintln!("failed to emit global panel shortcut event: {error}");
    }
}

fn handle_panel_shortcut_event<R: Runtime>(
    app: &AppHandle<R>,
    _shortcut: &Shortcut,
    event: ShortcutEvent,
) {
    handle_shortcut_event(event.state, || {
        let Some(window) = app.get_webview_window("main") else {
            return;
        };

        #[cfg(target_os = "macos")]
        {
            match reveal_then_emit(
                |sender| {
                    window.with_webview(move |webview| {
                        let main_thread = MainThreadMarker::new()
                            .expect("Tauri with_webview callbacks run on the main thread");
                        let application = NSApplication::sharedApplication(main_thread);
                        let native_window = webview.ns_window();
                        if native_window.is_null() {
                            eprintln!("main panel has no native NSWindow for global shortcut");
                            return;
                        }
                        // Tauri owns the NSWindow; its pointer is valid for this main-thread callback.
                        let native_window: &NSWindow = unsafe { &*native_window.cast() };
                        let plan = reveal_plan(application.isHidden(), native_window.isVisible());

                        if plan.unhide_app {
                            application.unhideWithoutActivation();
                        }
                        if plan.order_front {
                            native_window.orderFrontRegardless();
                        }
                        let _ = sender.send(plan.was_hidden);
                    })
                },
                |was_hidden| emit_panel_toggle(app, was_hidden),
            ) {
                Ok(true) => {}
                Ok(false) => eprintln!("main panel shortcut reveal did not return a window state"),
                Err(error) => eprintln!("failed to access main panel for global shortcut: {error}"),
            }
        }

        #[cfg(not(target_os = "macos"))]
        {
            let was_hidden = match window.is_visible() {
                Ok(visible) => !visible,
                Err(error) => {
                    eprintln!("failed to read panel visibility for global shortcut: {error}");
                    return;
                }
            };

            if was_hidden {
                if let Err(error) = window.show() {
                    eprintln!("failed to show panel for global shortcut: {error}");
                }
            }
            emit_panel_toggle(app, was_hidden);
        }
    });
}

fn handle_position_shortcut_event<R: Runtime>(
    app: &AppHandle<R>,
    _shortcut: &Shortcut,
    event: ShortcutEvent,
) {
    if let Some(placement) = app.try_state::<crate::panel_placement::PanelPlacement>() {
        if let Err(error) = placement.on_position_shortcut(event.state) {
            eprintln!("failed to cycle panel position: {error}");
        }
    }
}

#[cfg(test)]
mod tests {
    #[cfg(target_os = "macos")]
    use super::{reveal_plan, reveal_then_emit};
    use super::{
        apply_shortcut_update, canonicalize_shortcut, handle_shortcut_event, is_pressed,
        PanelShortcutError, PanelShortcutErrorCode, PanelShortcutUpdate, ShortcutRegistrar,
        ShortcutRegistrationState,
    };
    use tauri_plugin_global_shortcut::ShortcutState;
    #[cfg(target_os = "macos")]
    use std::sync::Mutex;

    #[derive(Default)]
    struct FakeRegistrar {
        operations: Vec<String>,
        fail_register: bool,
        fail_unregister_for: Vec<String>,
    }

    impl ShortcutRegistrar for FakeRegistrar {
        fn register(&mut self, shortcut: &str) -> Result<(), ()> {
            self.operations.push(format!("register:{shortcut}"));
            if self.fail_register {
                Err(())
            } else {
                Ok(())
            }
        }

        fn unregister(&mut self, shortcut: &str) -> Result<(), ()> {
            self.operations.push(format!("unregister:{shortcut}"));
            if self.fail_unregister_for.iter().any(|value| value == shortcut) {
                Err(())
            } else {
                Ok(())
            }
        }
    }

    #[test]
    fn canonicalizes_native_shortcuts_and_rejects_unsafe_values() {
        assert_eq!(
            canonicalize_shortcut("ALT+SHIFT+SUPER+SPACE").unwrap(),
            "shift+alt+super+space"
        );
        assert_eq!(
            canonicalize_shortcut("space").unwrap_err(),
            PanelShortcutErrorCode::InvalidShortcut
        );
        assert_eq!(
            canonicalize_shortcut("shift+a").unwrap_err(),
            PanelShortcutErrorCode::InvalidShortcut
        );
        assert_eq!(canonicalize_shortcut("super+f20").unwrap(), "super+f20");
        assert_eq!(
            canonicalize_shortcut("super+f21").unwrap_err(),
            PanelShortcutErrorCode::InvalidShortcut
        );
    }

    #[test]
    fn serializes_errors_with_stable_code_and_locked_state_snapshot() {
        let known = ShortcutRegistrationState::Known(Some("shift+alt+super+space".into()));
        assert_eq!(
            serde_json::to_value(PanelShortcutError::from_state(
                PanelShortcutErrorCode::InvalidShortcut,
                &known,
            ))
            .unwrap(),
            serde_json::json!({
                "code": "invalid_shortcut",
                "activeShortcut": "shift+alt+super+space",
                "stateUncertain": false,
            })
        );
        assert_eq!(
            serde_json::to_value(PanelShortcutError::from_state(
                PanelShortcutErrorCode::RegistrationUncertain,
                &ShortcutRegistrationState::Uncertain,
            ))
            .unwrap(),
            serde_json::json!({
                "code": "registration_uncertain",
                "activeShortcut": null,
                "stateUncertain": true,
            })
        );
        assert_eq!(
            PanelShortcutError::from_state(
                PanelShortcutErrorCode::RollbackFailed,
                &ShortcutRegistrationState::Uncertain,
            )
            .to_string(),
            "rollback_failed"
        );
    }

    #[test]
    fn serializes_update_as_camel_case() {
        let update = PanelShortcutUpdate {
            active_shortcut: Some("shift+alt+super+space".to_owned()),
        };

        assert_eq!(
            serde_json::to_value(update).unwrap(),
            serde_json::json!({ "activeShortcut": "shift+alt+super+space" })
        );
    }

    #[test]
    fn registers_new_shortcut_before_unregistering_old_shortcut() {
        let mut active = ShortcutRegistrationState::Known(Some("shift+alt+super+space".to_owned()));
        let mut registrar = FakeRegistrar::default();

        let next = apply_shortcut_update(
            &mut active,
            Some("control+alt+super+p"),
            &mut registrar,
        )
        .unwrap();

        assert_eq!(next.as_deref(), Some("control+alt+super+p"));
        assert_eq!(active, ShortcutRegistrationState::Known(next));
        assert_eq!(
            registrar.operations,
            vec![
                "register:control+alt+super+p".to_owned(),
                "unregister:shift+alt+super+space".to_owned(),
            ]
        );
    }

    #[test]
    fn preserves_active_shortcut_when_new_registration_fails() {
        let mut active = ShortcutRegistrationState::Known(Some("shift+alt+super+space".to_owned()));
        let mut registrar = FakeRegistrar {
            fail_register: true,
            ..Default::default()
        };

        let error = apply_shortcut_update(
            &mut active,
            Some("control+alt+super+p"),
            &mut registrar,
        )
        .unwrap_err();

        assert_eq!(error.code, PanelShortcutErrorCode::RegistrationFailed);
        assert_eq!(
            error.active_shortcut.as_deref(),
            Some("shift+alt+super+space")
        );
        assert!(!error.state_uncertain);
        assert_eq!(
            active,
            ShortcutRegistrationState::Known(Some("shift+alt+super+space".into()))
        );
        assert_eq!(
            registrar.operations,
            vec!["register:control+alt+super+p".to_owned()]
        );

        registrar.fail_register = false;
        let retried = apply_shortcut_update(
            &mut active,
            Some("control+alt+super+p"),
            &mut registrar,
        )
        .unwrap();
        assert_eq!(retried.as_deref(), Some("control+alt+super+p"));
        assert_eq!(active, ShortcutRegistrationState::Known(retried));
    }

    #[test]
    fn poisons_state_and_attempts_rollback_when_old_unregistration_fails() {
        let mut active = ShortcutRegistrationState::Known(Some("shift+alt+super+space".to_owned()));
        let mut registrar = FakeRegistrar {
            fail_unregister_for: vec!["shift+alt+super+space".to_owned()],
            ..Default::default()
        };

        let error = apply_shortcut_update(
            &mut active,
            Some("control+alt+super+p"),
            &mut registrar,
        )
        .unwrap_err();

        assert_eq!(error.code, PanelShortcutErrorCode::RegistrationUncertain);
        assert_eq!(error.active_shortcut, None);
        assert!(error.state_uncertain);
        assert_eq!(active, ShortcutRegistrationState::Uncertain);
        assert_eq!(
            registrar.operations,
            vec![
                "register:control+alt+super+p".to_owned(),
                "unregister:shift+alt+super+space".to_owned(),
                "unregister:control+alt+super+p".to_owned(),
            ]
        );
        let operations = registrar.operations.clone();
        let retry = apply_shortcut_update(
            &mut active,
            Some("control+alt+super+p"),
            &mut registrar,
        )
        .unwrap_err();
        assert_eq!(retry.code, PanelShortcutErrorCode::RegistrationUncertain);
        assert!(retry.state_uncertain);
        assert_eq!(registrar.operations, operations);
    }

    #[test]
    fn reports_rollback_failure_with_uncertain_state() {
        let mut active = ShortcutRegistrationState::Known(Some("shift+alt+super+space".to_owned()));
        let mut registrar = FakeRegistrar {
            fail_unregister_for: vec![
                "shift+alt+super+space".to_owned(),
                "control+alt+super+p".to_owned(),
            ],
            ..Default::default()
        };

        let error = apply_shortcut_update(
            &mut active,
            Some("control+alt+super+p"),
            &mut registrar,
        )
        .unwrap_err();

        assert_eq!(error.code, PanelShortcutErrorCode::RollbackFailed);
        assert!(error.state_uncertain);
        assert_eq!(error.active_shortcut, None);
        assert_eq!(active, ShortcutRegistrationState::Uncertain);
        assert_eq!(
            registrar.operations.last().map(String::as_str),
            Some("unregister:control+alt+super+p")
        );
    }

    #[test]
    fn clears_only_after_unregistering_the_active_shortcut() {
        let mut active = ShortcutRegistrationState::Known(Some("shift+alt+super+space".to_owned()));
        let mut registrar = FakeRegistrar::default();

        let next = apply_shortcut_update(&mut active, None, &mut registrar).unwrap();

        assert_eq!(next, None);
        assert_eq!(active, ShortcutRegistrationState::Known(None));
        assert_eq!(
            registrar.operations,
            vec!["unregister:shift+alt+super+space".to_owned()]
        );
    }

    #[test]
    fn poisons_state_when_clearing_cannot_unregister_it() {
        let mut active = ShortcutRegistrationState::Known(Some("shift+alt+super+space".to_owned()));
        let mut registrar = FakeRegistrar {
            fail_unregister_for: vec!["shift+alt+super+space".to_owned()],
            ..Default::default()
        };

        let error = apply_shortcut_update(&mut active, None, &mut registrar).unwrap_err();

        assert_eq!(error.code, PanelShortcutErrorCode::RegistrationUncertain);
        assert_eq!(error.active_shortcut, None);
        assert!(error.state_uncertain);
        assert_eq!(active, ShortcutRegistrationState::Uncertain);
        assert_eq!(
            registrar.operations,
            vec!["unregister:shift+alt+super+space".to_owned()]
        );
        let retry = apply_shortcut_update(&mut active, None, &mut registrar).unwrap_err();
        assert_eq!(retry.code, PanelShortcutErrorCode::RegistrationUncertain);
        assert_eq!(registrar.operations.len(), 1);
    }

    #[test]
    fn skips_registrar_operations_when_requested_shortcut_is_unchanged() {
        let mut active = ShortcutRegistrationState::Known(Some("shift+alt+super+space".to_owned()));
        let mut registrar = FakeRegistrar::default();

        let next = apply_shortcut_update(
            &mut active,
            Some("ALT+SHIFT+SUPER+SPACE"),
            &mut registrar,
        )
        .unwrap();

        assert_eq!(next.as_deref(), Some("shift+alt+super+space"));
        assert!(registrar.operations.is_empty());
    }

    #[test]
    fn handles_only_pressed_shortcut_events() {
        assert!(is_pressed(ShortcutState::Pressed));
        assert!(!is_pressed(ShortcutState::Released));
    }

    #[test]
    fn released_event_does_not_call_handler() {
        let mut called = false;

        handle_shortcut_event(ShortcutState::Released, || called = true);

        assert!(!called);
    }

    #[test]
    fn position_shortcut_cannot_replace_the_existing_panel_toggle_binding() {
        let mut registrations = super::PanelShortcutRegistrations {
            toggle: ShortcutRegistrationState::Known(Some("shift+alt+super+space".into())),
            position: ShortcutRegistrationState::Known(Some("shift+control+super+space".into())),
        };
        let mut registrar = FakeRegistrar::default();

        let error = super::apply_action_shortcut_update(
            &mut registrations,
            super::ShortcutAction::Position,
            Some("shift+alt+super+space"),
            &mut registrar,
        )
        .unwrap_err();

        assert_eq!(error.code, PanelShortcutErrorCode::RegistrationFailed);
        assert_eq!(
            error.active_shortcut.as_deref(),
            Some("shift+control+super+space")
        );
        assert!(registrar.operations.is_empty());
    }

    fn held_position_fixture() -> (
        super::PanelShortcutState,
        crate::panel_placement::state::PlacementMachine,
        [crate::panel_placement::state::DisplayFrame; 1],
    ) {
        use crate::panel_placement::state::{DisplayFrame, PhysicalFrame, PlacementInput, PlacementMachine};
        let state = super::PanelShortcutState {
            active: std::sync::Mutex::new(super::PanelShortcutRegistrations {
                toggle: ShortcutRegistrationState::Known(Some("shift+alt+super+space".into())),
                position: ShortcutRegistrationState::Known(Some("shift+control+super+space".into())),
            }),
        };
        let displays = [DisplayFrame { x: 0, y: 0, width: 1920, height: 1080, scale_factor: 1.0 }];
        let mut placement = PlacementMachine::new(
            PhysicalFrame { x: 16, y: 16, width: 420, height: 50 }, None,
        );
        assert!(placement.reduce(PlacementInput::CyclePressed, &displays).iter().any(|effect|
            matches!(effect, crate::panel_placement::state::PlacementEffect::SetPosition { x: 1484, y: 16, .. })));
        (state, placement, displays)
    }

    #[test]
    fn position_shortcut_rebinding_releases_held_cycle_outside_registration_lock() {
        use crate::panel_placement::state::{PlacementEffect, PlacementInput};
        for requested in [Some("alt+super+p"), None] {
            let (state, mut placement, displays) = held_position_fixture();
            let mut registrar = FakeRegistrar::default();
            let next = super::update_action_shortcut(
                &state, super::ShortcutAction::Position, requested, &mut registrar,
                || {
                    assert!(state.active.try_lock().is_ok(), "placement must run after unlocking registration");
                    placement.reduce(PlacementInput::CycleReleased, &displays);
                },
            ).unwrap();
            assert_eq!(next.active_shortcut.as_deref(), requested);
            assert_eq!(state.active.lock().unwrap().toggle,
                ShortcutRegistrationState::Known(Some("shift+alt+super+space".into())));
            // The old binding's Released may never arrive after unregistering it.
            // A press on the replacement/re-enabled key must still advance.
            let effects = placement.reduce(PlacementInput::CyclePressed, &displays);
            assert!(effects.iter().any(|effect|
                matches!(effect, PlacementEffect::SetPosition { x: 1484, y: 1014, .. })),
                "changing or clearing a held shortcut must allow the next cycle");
        }
    }

    #[test]
    fn position_shortcut_noop_apply_preserves_held_cycle() {
        use crate::panel_placement::state::PlacementInput;
        let (state, mut placement, displays) = held_position_fixture();
        let mut registrar = FakeRegistrar::default();
        super::update_action_shortcut(
            &state, super::ShortcutAction::Position, Some("CONTROL+SUPER+SHIFT+SPACE"),
            &mut registrar, || { placement.reduce(PlacementInput::CycleReleased, &displays); },
        ).unwrap();
        assert!(registrar.operations.is_empty());
        assert!(placement.reduce(PlacementInput::CyclePressed, &displays).is_empty());
        placement.reduce(PlacementInput::CycleReleased, &displays);
        assert!(!placement.reduce(PlacementInput::CyclePressed, &displays).is_empty());
    }

    #[test]
    fn position_shortcut_failed_registration_preserves_toggle_and_held_cycle() {
        use crate::panel_placement::state::PlacementInput;
        let (state, mut placement, displays) = held_position_fixture();
        let mut registrar = FakeRegistrar { fail_register: true, ..Default::default() };
        let error = super::update_action_shortcut(
            &state, super::ShortcutAction::Position, Some("alt+super+p"),
            &mut registrar, || { placement.reduce(PlacementInput::CycleReleased, &displays); },
        ).unwrap_err();
        assert_eq!(error.active_shortcut.as_deref(), Some("shift+control+super+space"));
        assert_eq!(registrar.operations, vec!["register:alt+super+p"]);
        assert_eq!(state.active.lock().unwrap().toggle,
            ShortcutRegistrationState::Known(Some("shift+alt+super+space".into())));
        assert!(placement.reduce(PlacementInput::CyclePressed, &displays).is_empty());
    }

    #[test]
    fn position_shortcut_replacement_does_not_change_the_panel_toggle_binding() {
        let mut registrations = super::PanelShortcutRegistrations {
            toggle: ShortcutRegistrationState::Known(Some("shift+alt+super+space".into())),
            position: ShortcutRegistrationState::Known(Some("shift+control+super+space".into())),
        };
        let mut registrar = FakeRegistrar::default();

        let next = super::apply_action_shortcut_update(
            &mut registrations,
            super::ShortcutAction::Position,
            Some("alt+super+p"),
            &mut registrar,
        )
        .unwrap();

        assert_eq!(next.as_deref(), Some("alt+super+p"));
        assert_eq!(
            registrations.toggle,
            ShortcutRegistrationState::Known(Some("shift+alt+super+space".into()))
        );
        assert_eq!(
            registrar.operations,
            vec![
                "register:alt+super+p".to_owned(),
                "unregister:shift+control+super+space".to_owned(),
            ]
        );
    }

    #[test]
    fn existing_custom_toggle_takes_priority_over_position_default_at_startup() {
        let mut registrations = super::PanelShortcutRegistrations {
            toggle: ShortcutRegistrationState::Known(Some("shift+alt+super+space".into())),
            position: ShortcutRegistrationState::Known(None),
        };
        let mut registrar = FakeRegistrar::default();

        super::apply_action_shortcut_update(
            &mut registrations,
            super::ShortcutAction::Toggle,
            Some("shift+control+super+space"),
            &mut registrar,
        )
        .unwrap();
        let error = super::apply_action_shortcut_update(
            &mut registrations,
            super::ShortcutAction::Position,
            Some("shift+control+super+space"),
            &mut registrar,
        )
        .unwrap_err();

        assert_eq!(error.code, PanelShortcutErrorCode::RegistrationFailed);
        assert_eq!(error.active_shortcut, None);
        assert_eq!(registrar.operations.len(), 2);
        assert_eq!(
            registrations.toggle,
            ShortcutRegistrationState::Known(Some("shift+control+super+space".into()))
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn visible_app_and_window_need_no_reveal() {
        let plan = reveal_plan(false, true);
        assert!(!plan.was_hidden);
        assert!(!plan.unhide_app);
        assert!(!plan.order_front);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn hidden_app_needs_nonactivating_unhide_and_nonkey_reveal() {
        let plan = reveal_plan(true, true);
        assert!(plan.was_hidden);
        assert!(plan.unhide_app);
        assert!(plan.order_front);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn individually_hidden_window_needs_only_nonkey_reveal() {
        let plan = reveal_plan(false, false);
        assert!(plan.was_hidden);
        assert!(!plan.unhide_app);
        assert!(plan.order_front);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn emits_only_after_native_reveal_releases_its_callback_lock() {
        let callback_lock = Mutex::new(());
        let mut received = None;

        let delivered = reveal_then_emit(
            |sender| {
                let _guard = callback_lock.lock().unwrap();
                sender.send(false).unwrap();
                Ok::<(), ()>(())
            },
            |was_hidden| {
                assert!(
                    callback_lock.try_lock().is_ok(),
                    "emitting inside the native callback would reenter its lock"
                );
                received = Some(was_hidden);
            },
        )
        .unwrap();

        assert!(delivered);
        assert_eq!(received, Some(false));
    }
}
