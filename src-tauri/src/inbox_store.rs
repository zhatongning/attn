use std::collections::HashSet;
use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::domain::classification::classify_observation;
use crate::domain::confidence::Confidence;
use crate::domain::dismissability::evaluate_dismissability;
use crate::codex_source::discover_codex_observations;
use crate::domain::session::{JumpAvailability, JumpTarget, SessionRow, SessionState};
use crate::domain::source_health::{SourceCapability, SourceHealth, SourceStatus};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JumpResult {
    pub session_id: String,
    pub availability: JumpAvailability,
    pub target: JumpTarget,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum JumpCommandPlan {
    CodexDesktop {
        thread_id: String,
        workspace_path: String,
        deeplink_url: String,
        activate_bundle_id: String,
    },
    ITermActivate { tty: String },
    TerminalResume { session_id: String, workspace_path: String },
}

#[derive(Debug, Default)]
pub struct InboxStore {
    dismissed_session_ids: Mutex<HashSet<String>>,
}

impl InboxStore {
    pub fn list_sessions(&self) -> Vec<SessionRow> {
        let dismissed_session_ids = self
            .dismissed_session_ids
            .lock()
            .expect("dismissed session store lock poisoned");

        discover_codex_observations(&codex_sessions_root(), 80)
            .into_iter()
            .map(|observation| {
                let mut row = classify_observation(observation);
                row = apply_live_cli_activity_signal(row, live_cli_tty_for_row);
                let dismissability = evaluate_dismissability(&row);
                let jump_availability = if row.workspace_path.is_some() {
                    if matches!(row.jump_target, JumpTarget::Desktop) {
                        JumpAvailability::Exact
                    } else {
                        JumpAvailability::Approximate
                    }
                } else {
                    JumpAvailability::Unavailable
                };
                row = row
                    .with_dismissability_reason(Some(dismissability.reason))
                    .with_jump_availability(jump_availability);

                if dismissed_session_ids.contains(&row.session_id) {
                    row.mark_dismissed()
                } else {
                    row
                }
            })
            .collect()
    }

    pub fn dismiss_session(&self, session_id: &str) -> Vec<SessionRow> {
        self.dismissed_session_ids
            .lock()
            .expect("dismissed session store lock poisoned")
            .insert(session_id.to_string());

        self.list_sessions()
    }

    pub fn restore_session(&self, session_id: &str) -> Vec<SessionRow> {
        self.dismissed_session_ids
            .lock()
            .expect("dismissed session store lock poisoned")
            .remove(session_id);

        self.list_sessions()
    }

    pub fn source_health(&self) -> SourceHealth {
        SourceHealth {
            source_name: "Codex desktop".to_string(),
            status: if codex_sessions_root().exists() {
                SourceStatus::Available
            } else {
                SourceStatus::Unknown
            },
            capabilities: vec![
                SourceCapability {
                    name: "Thread discovery".to_string(),
                    availability: if codex_sessions_root().exists() {
                        Confidence::Inferred
                    } else {
                        Confidence::Unavailable
                    },
                    detail: format!(
                        "Reads local Codex thread state from {}.",
                        codex_state_db_path().display()
                    ),
                },
                SourceCapability {
                    name: "Attention/completion status".to_string(),
                    availability: Confidence::Inferred,
                    detail: "Uses SQLite threads as primary state and JSONL as event evidence.".to_string(),
                },
                SourceCapability {
                    name: "Window jump-back".to_string(),
                    availability: Confidence::Inferred,
                    detail:
                        "Routes one Jump back action to Codex Desktop, a live iTerm Codex session, or Terminal resume fallback."
                            .to_string(),
                },
            ],
        }
    }

    pub fn jump_to_session(&self, session_id: &str) -> JumpResult {
        let row = self
            .list_sessions()
            .into_iter()
            .find(|row| row.session_id == session_id);
        let availability = row
            .as_ref()
            .map(|row| row.jump_availability)
            .unwrap_or(JumpAvailability::Unavailable);
        let target = row
            .as_ref()
            .map(|row| row.jump_target)
            .unwrap_or(JumpTarget::Unknown);
        let plan = row
            .as_ref()
            .and_then(build_jump_command_plan);
        let execution = plan.clone().map(execute_jump_command_plan);
        let message = match availability {
            JumpAvailability::Exact | JumpAvailability::Approximate => match (target, plan, execution) {
                (
                    JumpTarget::Desktop | JumpTarget::Unknown,
                    Some(JumpCommandPlan::CodexDesktop { .. }),
                    Some(Ok(())),
                ) => {
                    "Opened Codex Desktop session.".to_string()
                }
                (JumpTarget::Cli, Some(JumpCommandPlan::ITermActivate { .. }), Some(Ok(()))) => {
                    "Focused live iTerm Codex session.".to_string()
                }
                (JumpTarget::Cli, Some(JumpCommandPlan::TerminalResume { .. }), Some(Ok(()))) => {
                    "Opened Terminal resume command.".to_string()
                }
                (_, _, Some(Err(error))) => format!("Jump-back failed: {error}"),
                _ => "Jump-back unavailable: missing reliable target signal.".to_string(),
            }
            JumpAvailability::Unavailable => {
                "Jump-back unavailable: missing reliable target signal.".to_string()
            }
        };

        JumpResult {
            session_id: session_id.to_string(),
            availability,
            target,
            message,
        }
    }
}

fn live_cli_tty_for_row(row: &SessionRow) -> Option<String> {
    match (row.jump_target, row.workspace_path.as_deref()) {
        (JumpTarget::Cli, Some(workspace_path)) => find_live_codex_tty_for_workspace(workspace_path),
        _ => None,
    }
}

fn apply_live_cli_activity_signal(
    row: SessionRow,
    live_tty_for_row: impl FnOnce(&SessionRow) -> Option<String>,
) -> SessionRow {
    if !matches!(row.state, SessionState::Unknown) || !matches!(row.jump_target, JumpTarget::Cli) {
        return row;
    }

    let Some(tty) = live_tty_for_row(&row) else {
        return row;
    };

    SessionRow {
        state: SessionState::Running,
        confidence: Confidence::Inferred,
        status_reason: format!("Live Codex CLI process observed on {tty}."),
        ..row
    }
}

fn build_jump_command_plan(row: &SessionRow) -> Option<JumpCommandPlan> {
    let live_tty = match row.jump_target {
        JumpTarget::Cli => row
            .workspace_path
            .as_deref()
            .and_then(find_live_codex_tty_for_workspace),
        JumpTarget::Desktop | JumpTarget::Unknown => None,
    };

    build_jump_command_plan_with_live_tty(row, live_tty)
}

fn build_jump_command_plan_with_live_tty(
    row: &SessionRow,
    live_tty: Option<String>,
) -> Option<JumpCommandPlan> {
    let workspace_path = row.workspace_path.clone()?;

    match row.jump_target {
        JumpTarget::Desktop | JumpTarget::Unknown => {
            Some(JumpCommandPlan::CodexDesktop {
                thread_id: row.session_id.clone(),
                deeplink_url: codex_thread_deeplink(&row.session_id),
                workspace_path,
                activate_bundle_id: codex_bundle_id().to_string(),
            })
        }
        JumpTarget::Cli => live_tty
            .map(|tty| JumpCommandPlan::ITermActivate { tty })
            .or_else(|| {
                Some(JumpCommandPlan::TerminalResume {
                    session_id: row.session_id.clone(),
                    workspace_path,
                })
            }),
    }
}

fn execute_jump_command_plan(plan: JumpCommandPlan) -> Result<(), String> {
    match plan {
        JumpCommandPlan::CodexDesktop {
            thread_id: _,
            workspace_path,
            deeplink_url,
            activate_bundle_id,
        } => {
            open_codex_thread_deeplink(&deeplink_url)
                .or_else(|_| open_codex_workspace(&workspace_path))?;

            activate_app(&activate_bundle_id)
        }
        JumpCommandPlan::ITermActivate { tty } => activate_iterm_tty(&tty),
        JumpCommandPlan::TerminalResume {
            session_id,
            workspace_path,
        } => {
            let command = format!(
                "{} resume {} --cd {}",
                shell_quote(&codex_cli_path().display().to_string()),
                shell_quote(&session_id),
                shell_quote(&workspace_path)
            );
            let script = format!(
                "tell application \"Terminal\"\nactivate\ndo script {quoted_command}\nend tell",
                quoted_command = applescript_string_literal(&command)
            );

            Command::new("osascript")
                .args(["-e", &script])
                .status()
                .map_err(|error| format!("failed to open Terminal: {error}"))
                .and_then(|status| {
                    if status.success() {
                        Ok(())
                    } else {
                        Err(format!("Terminal launcher exited with {status}"))
                    }
                })
        }
    }
}

fn find_live_codex_tty_for_workspace(workspace_path: &str) -> Option<String> {
    let output = Command::new("ps")
        .args(["-axo", "pid=,tty=,comm=,args="])
        .output()
        .ok()?;
    let stdout = String::from_utf8_lossy(&output.stdout);

    for line in stdout.lines() {
        let Some((pid, tty, args)) = parse_codex_process_line(line) else {
            continue;
        };
        let Some(cwd) = process_cwd(pid) else {
            continue;
        };
        if cwd == workspace_path && !args.contains(" app-server ") {
            return Some(tty.to_string());
        }
    }

    None
}

fn parse_codex_process_line(line: &str) -> Option<(&str, &str, &str)> {
    let mut parts = line.split_whitespace();
    let pid = parts.next()?;
    let tty = parts.next()?;
    let _comm = parts.next()?;
    let args_start = line.find(_comm)? + _comm.len();
    let args = line[args_start..].trim();

    if !tty.starts_with("ttys") || args.contains(" app-server ") || !args.contains("codex") {
        return None;
    }

    Some((pid, tty, args))
}

fn process_cwd(pid: &str) -> Option<String> {
    let output = Command::new("lsof")
        .args(["-a", "-p", pid, "-d", "cwd", "-Fn"])
        .output()
        .ok()?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    stdout
        .lines()
        .find_map(|line| line.strip_prefix('n').map(ToString::to_string))
}

fn activate_iterm_tty(tty: &str) -> Result<(), String> {
    // TODO: Add Warp live terminal targeting once its scriptability/API is defined.
    let tty_path = if tty.starts_with("/dev/") {
        tty.to_string()
    } else {
        format!("/dev/{tty}")
    };
    let script = format!(
        r#"with timeout of 3 seconds
tell application id "com.googlecode.iterm2"
activate
repeat with w in windows
repeat with t in tabs of w
repeat with s in sessions of t
try
set sessionTty to tty of s as text
if sessionTty is {quoted_tty} or sessionTty is {quoted_tty_path} then
select w
select t
select s
return "activated"
end if
end try
end repeat
end repeat
end repeat
end tell
end timeout"#,
        quoted_tty = applescript_string_literal(tty),
        quoted_tty_path = applescript_string_literal(&tty_path)
    );

    run_command_with_timeout("osascript", &["-e", &script], Duration::from_secs(4))
        .or_else(|_| activate_app("com.googlecode.iterm2"))
}

fn codex_cli_path() -> PathBuf {
    PathBuf::from("/Applications/Codex.app/Contents/Resources/codex")
}

fn codex_thread_deeplink(thread_id: &str) -> String {
    format!("codex://threads/{thread_id}")
}

fn open_codex_thread_deeplink(deeplink_url: &str) -> Result<(), String> {
    Command::new("open")
        .arg(deeplink_url)
        .status()
        .map_err(|error| format!("failed to open Codex thread deeplink: {error}"))
        .and_then(|status| {
            if status.success() {
                Ok(())
            } else {
                Err(format!("Codex thread deeplink opener exited with {status}"))
            }
        })
}

fn open_codex_workspace(workspace_path: &str) -> Result<(), String> {
    Command::new(codex_cli_path())
        .args(["app", workspace_path])
        .status()
        .map_err(|error| format!("failed to launch Codex Desktop: {error}"))
        .and_then(|status| {
            if status.success() {
                Ok(())
            } else {
                Err(format!("Codex Desktop launcher exited with {status}"))
            }
        })
}

fn codex_bundle_id() -> &'static str {
    "com.openai.codex"
}

fn activate_app(bundle_id: &str) -> Result<(), String> {
    let script = format!(
        "tell application id {bundle_id} to activate",
        bundle_id = applescript_string_literal(bundle_id)
    );
    Command::new("osascript")
        .args(["-e", &script])
        .status()
        .map_err(|error| format!("failed to activate Codex Desktop: {error}"))
        .and_then(|status| {
            if status.success() {
                Ok(())
            } else {
                Err(format!("Codex Desktop activation exited with {status}"))
            }
        })
}

fn run_command_with_timeout(
    command: &str,
    args: &[&str],
    timeout: Duration,
) -> Result<(), String> {
    let mut child = Command::new(command)
        .args(args)
        .spawn()
        .map_err(|error| format!("failed to run {command}: {error}"))?;
    let started_at = Instant::now();

    loop {
        match child
            .try_wait()
            .map_err(|error| format!("failed to wait for {command}: {error}"))?
        {
            Some(status) if status.success() => return Ok(()),
            Some(status) => return Err(format!("{command} exited with {status}")),
            None if started_at.elapsed() >= timeout => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("{command} timed out"));
            }
            None => std::thread::sleep(Duration::from_millis(50)),
        }
    }
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn applescript_string_literal(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

fn codex_sessions_root() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".codex")
        .join("sessions")
}

fn codex_state_db_path() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".codex")
        .join("state_5.sqlite")
}

#[cfg(test)]
mod tests {
    use crate::domain::confidence::Confidence;
    use crate::domain::session::{JumpAvailability, JumpTarget, SessionRow, SessionState};
    use crate::inbox_store::InboxStore;

    #[test]
    fn lists_seed_sessions_with_safety_metadata() {
        let store = InboxStore::default();

        let rows = store.list_sessions();

        assert!(rows.len() <= 80);
        assert!(rows.iter().all(|row| !row.session_id.is_empty()));
    }

    #[test]
    fn dismiss_and_restore_round_trips_row_state() {
        let store = InboxStore::default();

        let Some(session_id) = store.list_sessions().first().map(|row| row.session_id.clone()) else {
            return;
        };

        let dismissed = store.dismiss_session(&session_id);
        assert!(dismissed
            .iter()
            .find(|row| row.session_id == session_id)
            .expect("row should exist")
            .dismissed);

        let restored = store.restore_session(&session_id);
        assert!(!restored
            .iter()
            .find(|row| row.session_id == session_id)
            .expect("row should exist")
            .dismissed);
    }

    #[test]
    fn jump_reports_unavailable_for_unknown_rows() {
        let store = InboxStore::default();

        let result = store.jump_to_session("missing");

        assert_eq!(result.availability, JumpAvailability::Unavailable);
        assert_eq!(result.target, JumpTarget::Unknown);
    }

    #[test]
    fn desktop_sessions_build_codex_app_jump_plan() {
        let row = SessionRow::new("s1", "Desktop row", SessionState::Running, Confidence::Exact)
            .with_workspace(Some("/Users/edy/project-a".to_string()))
            .with_jump_availability(JumpAvailability::Exact)
            .with_jump_target(JumpTarget::Desktop);

        let plan = super::build_jump_command_plan(&row);

        assert_eq!(
            plan,
            Some(super::JumpCommandPlan::CodexDesktop {
                thread_id: "s1".to_string(),
                workspace_path: "/Users/edy/project-a".to_string(),
                deeplink_url: "codex://threads/s1".to_string(),
                activate_bundle_id: "com.openai.codex".to_string()
            })
        );
    }

    #[test]
    fn cli_sessions_with_live_tty_build_iterm_activate_jump_plan() {
        let row = SessionRow::new("s2", "CLI row", SessionState::Running, Confidence::Exact)
            .with_workspace(Some("/Users/edy/project-b".to_string()))
            .with_jump_availability(JumpAvailability::Approximate)
            .with_jump_target(JumpTarget::Cli);

        let plan = super::build_jump_command_plan_with_live_tty(&row, Some("ttys008".to_string()));

        assert_eq!(
            plan,
            Some(super::JumpCommandPlan::ITermActivate {
                tty: "ttys008".to_string()
            })
        );
    }

    #[test]
    fn cli_sessions_without_live_tty_fall_back_to_terminal_resume_jump_plan() {
        let row = SessionRow::new("s2", "CLI row", SessionState::Running, Confidence::Exact)
            .with_workspace(Some("/Users/edy/project-b".to_string()))
            .with_jump_availability(JumpAvailability::Approximate)
            .with_jump_target(JumpTarget::Cli);

        let plan = super::build_jump_command_plan_with_live_tty(&row, None);

        assert_eq!(
            plan,
            Some(super::JumpCommandPlan::TerminalResume {
                session_id: "s2".to_string(),
                workspace_path: "/Users/edy/project-b".to_string()
            })
        );
    }

    #[test]
    fn unknown_target_with_workspace_falls_back_to_desktop_jump_plan() {
        let row = SessionRow::new("s3", "Unknown row", SessionState::Running, Confidence::Unknown)
            .with_workspace(Some("/Users/edy/project-c".to_string()))
            .with_jump_availability(JumpAvailability::Approximate)
            .with_jump_target(JumpTarget::Unknown);

        let plan = super::build_jump_command_plan(&row);

        assert_eq!(
            plan,
            Some(super::JumpCommandPlan::CodexDesktop {
                thread_id: "s3".to_string(),
                workspace_path: "/Users/edy/project-c".to_string(),
                deeplink_url: "codex://threads/s3".to_string(),
                activate_bundle_id: "com.openai.codex".to_string()
            })
        );
    }

    #[test]
    fn unknown_cli_rows_with_live_process_signal_are_promoted_to_running() {
        let row = SessionRow::new("s4", "CLI row", SessionState::Unknown, Confidence::Unknown)
            .with_workspace(Some("/Users/edy/project-d".to_string()))
            .with_reason("missing source evidence for status classification")
            .with_jump_target(JumpTarget::Cli);

        let row = super::apply_live_cli_activity_signal(row, |_| Some("ttys008".to_string()));

        assert_eq!(row.state, SessionState::Running);
        assert_eq!(row.confidence, Confidence::Inferred);
        assert!(row.status_reason.contains("Live Codex CLI process"));
    }
}
