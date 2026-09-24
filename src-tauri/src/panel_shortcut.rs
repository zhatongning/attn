use serde::Serialize;
use std::error::Error;
use std::fmt::{self, Display, Formatter};
use std::str::FromStr;
use std::sync::Mutex;

pub use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutEvent, ShortcutState};

pub const DEFAULT_PANEL_SHORTCUT: &str = "shift+alt+super+space";
pub const TOGGLE_PANEL_EVENT: &str = "agent-session-inbox://toggle-panel";

#[derive(Default)]
pub struct PanelShortcutState {
    pub active: Mutex<Option<String>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PanelShortcutError {
    InvalidShortcut,
    RegistrationFailed,
    RollbackFailed,
}

impl Display for PanelShortcutError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidShortcut => "invalid_shortcut",
            Self::RegistrationFailed => "registration_failed",
            Self::RollbackFailed => "rollback_failed",
        })
    }
}

impl Error for PanelShortcutError {}

pub trait ShortcutRegistrar {
    fn register(&mut self, shortcut: &str) -> Result<(), ()>;
    fn unregister(&mut self, shortcut: &str) -> Result<(), ()>;
}

pub fn canonicalize_shortcut(value: &str) -> Result<String, PanelShortcutError> {
    let shortcut = Shortcut::from_str(value)
        .map(|shortcut| canonicalize_native_shortcut(shortcut.into_string()))
        .map_err(|_| PanelShortcutError::InvalidShortcut)?;

    shortcut
        .contains('+')
        .then_some(shortcut)
        .ok_or(PanelShortcutError::InvalidShortcut)
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

pub fn apply_shortcut_update(
    active: &mut Option<String>,
    requested: Option<&str>,
    registrar: &mut impl ShortcutRegistrar,
) -> Result<Option<String>, PanelShortcutError> {
    let requested = requested.map(canonicalize_shortcut).transpose()?;

    if *active == requested {
        return Ok(active.clone());
    }

    match requested {
        Some(next) => {
            registrar
                .register(&next)
                .map_err(|_| PanelShortcutError::RegistrationFailed)?;

            if let Some(previous) = active.as_deref() {
                if registrar.unregister(previous).is_err() {
                    return if registrar.unregister(&next).is_ok() {
                        Err(PanelShortcutError::RegistrationFailed)
                    } else {
                        Err(PanelShortcutError::RollbackFailed)
                    };
                }
            }

            *active = Some(next);
        }
        None => {
            if let Some(previous) = active.as_deref() {
                registrar
                    .unregister(previous)
                    .map_err(|_| PanelShortcutError::RegistrationFailed)?;
                *active = None;
            }
        }
    }

    Ok(active.clone())
}

pub fn is_pressed(state: ShortcutState) -> bool {
    matches!(state, ShortcutState::Pressed)
}

#[cfg(test)]
mod tests {
    use super::{
        apply_shortcut_update, canonicalize_shortcut, is_pressed, PanelShortcutError,
        ShortcutRegistrar,
    };
    use tauri_plugin_global_shortcut::ShortcutState;

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
    fn canonicalizes_native_shortcuts_and_rejects_modifier_only_values() {
        assert_eq!(
            canonicalize_shortcut("ALT+SHIFT+SUPER+SPACE").unwrap(),
            "shift+alt+super+space"
        );
        assert_eq!(
            canonicalize_shortcut("space").unwrap_err(),
            PanelShortcutError::InvalidShortcut
        );
    }

    #[test]
    fn serializes_errors_as_stable_unit_strings() {
        assert_eq!(
            serde_json::to_string(&PanelShortcutError::InvalidShortcut).unwrap(),
            "\"invalid_shortcut\""
        );
        assert_eq!(
            serde_json::to_string(&PanelShortcutError::RegistrationFailed).unwrap(),
            "\"registration_failed\""
        );
        assert_eq!(
            serde_json::to_string(&PanelShortcutError::RollbackFailed).unwrap(),
            "\"rollback_failed\""
        );
        assert_eq!(PanelShortcutError::InvalidShortcut.to_string(), "invalid_shortcut");
    }

    #[test]
    fn registers_new_shortcut_before_unregistering_old_shortcut() {
        let mut active = Some("shift+alt+super+space".to_owned());
        let mut registrar = FakeRegistrar::default();

        let next = apply_shortcut_update(
            &mut active,
            Some("control+alt+super+p"),
            &mut registrar,
        )
        .unwrap();

        assert_eq!(next.as_deref(), Some("control+alt+super+p"));
        assert_eq!(active, next);
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
        let mut active = Some("shift+alt+super+space".to_owned());
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

        assert_eq!(error, PanelShortcutError::RegistrationFailed);
        assert_eq!(active.as_deref(), Some("shift+alt+super+space"));
        assert_eq!(
            registrar.operations,
            vec!["register:control+alt+super+p".to_owned()]
        );
    }

    #[test]
    fn rolls_back_new_shortcut_when_old_unregistration_fails() {
        let mut active = Some("shift+alt+super+space".to_owned());
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

        assert_eq!(error, PanelShortcutError::RegistrationFailed);
        assert_eq!(active.as_deref(), Some("shift+alt+super+space"));
        assert_eq!(
            registrar.operations,
            vec![
                "register:control+alt+super+p".to_owned(),
                "unregister:shift+alt+super+space".to_owned(),
                "unregister:control+alt+super+p".to_owned(),
            ]
        );
    }

    #[test]
    fn reports_rollback_failure_without_committing_new_shortcut() {
        let mut active = Some("shift+alt+super+space".to_owned());
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

        assert_eq!(error, PanelShortcutError::RollbackFailed);
        assert_eq!(active.as_deref(), Some("shift+alt+super+space"));
    }

    #[test]
    fn clears_only_after_unregistering_the_active_shortcut() {
        let mut active = Some("shift+alt+super+space".to_owned());
        let mut registrar = FakeRegistrar::default();

        let next = apply_shortcut_update(&mut active, None, &mut registrar).unwrap();

        assert_eq!(next, None);
        assert_eq!(active, None);
        assert_eq!(
            registrar.operations,
            vec!["unregister:shift+alt+super+space".to_owned()]
        );
    }

    #[test]
    fn skips_registrar_operations_when_requested_shortcut_is_unchanged() {
        let mut active = Some("shift+alt+super+space".to_owned());
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
}
