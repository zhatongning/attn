use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

const HOOK_EVENTS: [&str; 5] = [
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "Stop",
];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CodexHookIntegrationStatus {
    pub installed: bool,
    pub hooks_path: PathBuf,
    pub event_store_path: PathBuf,
    pub detail: String,
}

pub fn codex_hook_integration_status() -> CodexHookIntegrationStatus {
    codex_hook_integration_status_at(&codex_hooks_path(), &attn_hook_script_path())
}

pub fn install_codex_hooks() -> Result<CodexHookIntegrationStatus, String> {
    install_codex_hooks_at(&codex_hooks_path(), &attn_hook_script_path())
}

fn codex_hook_integration_status_at(
    hooks_path: &Path,
    script_path: &Path,
) -> CodexHookIntegrationStatus {
    let installed = hooks_file_has_attn_hooks(hooks_path, script_path);

    CodexHookIntegrationStatus {
        installed,
        hooks_path: hooks_path.to_path_buf(),
        event_store_path: codex_hook_events_path(),
        detail: if installed {
            "Attn hook commands are installed.".to_string()
        } else if hooks_path.exists() {
            "Attn hook commands are not installed.".to_string()
        } else {
            "Codex hooks.json was not found; Attn can create it.".to_string()
        },
    }
}

fn install_codex_hooks_at(
    hooks_path: &Path,
    script_path: &Path,
) -> Result<CodexHookIntegrationStatus, String> {
    let mut root = read_hooks_json(hooks_path)?;
    ensure_hooks_object(&mut root)?;

    for event_name in HOOK_EVENTS {
        ensure_attn_hook_for_event(&mut root, event_name, script_path)?;
    }

    if let Some(parent) = hooks_path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("create hooks directory failed: {error}"))?;
    }

    let serialized = serde_json::to_string_pretty(&root)
        .map_err(|error| format!("serialize hooks.json failed: {error}"))?;
    fs::write(hooks_path, format!("{serialized}\n"))
        .map_err(|error| format!("write hooks.json failed: {error}"))?;

    Ok(codex_hook_integration_status_at(hooks_path, script_path))
}

fn read_hooks_json(path: &Path) -> Result<Value, String> {
    if !path.exists() {
        return Ok(json!({ "hooks": {} }));
    }

    let content = fs::read_to_string(path).map_err(|error| format!("read hooks.json failed: {error}"))?;
    if content.trim().is_empty() {
        return Ok(json!({ "hooks": {} }));
    }

    serde_json::from_str(&content).map_err(|error| format!("parse hooks.json failed: {error}"))
}

fn ensure_hooks_object(root: &mut Value) -> Result<&mut Map<String, Value>, String> {
    if !root.is_object() {
        *root = json!({});
    }

    let object = root.as_object_mut().expect("root normalized to object");
    if !object.get("hooks").is_some_and(Value::is_object) {
        object.insert("hooks".to_string(), json!({}));
    }

    object
        .get_mut("hooks")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| "hooks object unavailable".to_string())
}

fn ensure_attn_hook_for_event(
    root: &mut Value,
    event_name: &str,
    script_path: &Path,
) -> Result<(), String> {
    let hooks = ensure_hooks_object(root)?;
    let event_entries = hooks
        .entry(event_name.to_string())
        .or_insert_with(|| Value::Array(Vec::new()));

    if !event_entries.is_array() {
        *event_entries = Value::Array(Vec::new());
    }

    let entries = event_entries
        .as_array_mut()
        .ok_or_else(|| format!("{event_name} hook entries unavailable"))?;
    let command = attn_hook_command(script_path, event_name);

    if entries.iter().any(|entry| entry_contains_command(entry, &command)) {
        return Ok(());
    }

    let mut entry = json!({
        "hooks": [
            {
                "type": "command",
                "command": command,
                "timeout": 2,
                "statusMessage": "Updating Attn status..."
            }
        ]
    });

    if matches!(event_name, "SessionStart") {
        entry["matcher"] = Value::String("startup|resume".to_string());
    }

    entries.push(entry);
    Ok(())
}

fn hooks_file_has_attn_hooks(hooks_path: &Path, script_path: &Path) -> bool {
    let Ok(root) = read_hooks_json(hooks_path) else {
        return false;
    };

    HOOK_EVENTS.iter().all(|event_name| {
        let command = attn_hook_command(script_path, event_name);
        root.get("hooks")
            .and_then(|hooks| hooks.get(event_name))
            .and_then(Value::as_array)
            .is_some_and(|entries| entries.iter().any(|entry| entry_contains_command(entry, &command)))
    })
}

fn entry_contains_command(entry: &Value, command: &str) -> bool {
    entry
        .get("hooks")
        .and_then(Value::as_array)
        .is_some_and(|hooks| {
            hooks
                .iter()
                .any(|hook| hook.get("command").and_then(Value::as_str) == Some(command))
        })
}

fn attn_hook_command(script_path: &Path, event_name: &str) -> String {
    format!("node '{}' {event_name}", script_path.display())
}

fn codex_hooks_path() -> PathBuf {
    home_dir()
        .join(".codex")
        .join("hooks.json")
}

fn codex_hook_events_path() -> PathBuf {
    home_dir()
        .join(".codex")
        .join("agent-session-inbox")
        .join("hook-events.jsonl")
}

fn attn_hook_script_path() -> PathBuf {
    if let Ok(current_exe) = std::env::current_exe() {
        let bundled_script = bundled_hook_script_path(&current_exe);
        if bundled_script.exists() {
            return bundled_script;
        }
    }

    PathBuf::from("/Users/edy/sofdev/agent-session-inbox")
        .join("scripts")
        .join("attn-codex-hook.cjs")
}

fn bundled_hook_script_path(current_exe: &Path) -> PathBuf {
    current_exe
        .parent()
        .and_then(Path::parent)
        .map(|contents_dir| {
            contents_dir
                .join("Resources")
                .join("scripts")
                .join("attn-codex-hook.cjs")
        })
        .unwrap_or_else(|| PathBuf::from("scripts").join("attn-codex-hook.cjs"))
}

fn home_dir() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

#[cfg(test)]
mod tests {
    use std::fs;

    use tempfile::tempdir;

    #[test]
    fn install_preserves_existing_hooks_and_adds_attn_commands() {
        let temp = tempdir().expect("temp dir");
        let hooks_path = temp.path().join("hooks.json");
        let script_path = temp.path().join("attn-codex-hook.cjs");
        fs::write(&script_path, "#!/usr/bin/env node\n").expect("script");
        fs::write(
            &hooks_path,
            r#"{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "node '/Users/edy/.codex/hooks/gitnexus/gitnexus-hook.cjs'",
            "timeout": 10
          }
        ]
      }
    ]
  }
}"#,
        )
        .expect("hooks file");

        super::install_codex_hooks_at(&hooks_path, &script_path).expect("install hooks");

        let hooks_json = fs::read_to_string(&hooks_path).expect("read hooks");
        let value: serde_json::Value = serde_json::from_str(&hooks_json).expect("json");
        let pre_tool = value["hooks"]["PreToolUse"].as_array().expect("pre tool");

        assert!(hooks_json.contains("gitnexus-hook.cjs"));
        assert!(hooks_json.contains("attn-codex-hook.cjs"));
        assert!(hooks_json.contains("PreToolUse"));
        assert!(hooks_json.contains("PostToolUse"));
        assert!(hooks_json.contains("UserPromptSubmit"));
        assert!(hooks_json.contains("SessionStart"));
        assert!(hooks_json.contains("Stop"));
        assert!(!hooks_json.contains("\"matcher\": \"*\""));
        assert!(pre_tool.len() >= 2);
    }

    #[test]
    fn bundled_hook_script_path_points_to_macos_resources() {
        let current_exe = std::path::Path::new(
            "/Applications/Attn.app/Contents/MacOS/Attn",
        );

        assert_eq!(
            super::bundled_hook_script_path(current_exe),
            std::path::PathBuf::from(
                "/Applications/Attn.app/Contents/Resources/scripts/attn-codex-hook.cjs",
            )
        );
    }
}
