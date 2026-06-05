use std::collections::HashSet;
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::domain::classification::classify_observation;
use crate::domain::confidence::Confidence;
use crate::domain::dismissability::evaluate_dismissability;
use crate::codex_source::{discover_codex_observation_by_id, discover_codex_observations};
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
    acknowledged_signals: Mutex<HashSet<AcknowledgedSignal>>,
}

#[derive(Debug, Clone, Eq, Serialize, Deserialize)]
struct AcknowledgedSignal {
    session_id: String,
    last_activity_at: Option<String>,
    #[serde(default)]
    acknowledged_at_ms: Option<u64>,
}

impl PartialEq for AcknowledgedSignal {
    fn eq(&self, other: &Self) -> bool {
        self.session_id == other.session_id && self.last_activity_at == other.last_activity_at
    }
}

impl Hash for AcknowledgedSignal {
    fn hash<H: Hasher>(&self, state: &mut H) {
        self.session_id.hash(state);
        self.last_activity_at.hash(state);
    }
}

impl AcknowledgedSignal {
    fn from_row(row: &SessionRow) -> Self {
        Self {
            session_id: row.session_id.clone(),
            last_activity_at: row.last_activity_at.clone(),
            acknowledged_at_ms: None,
        }
    }

    fn from_row_at(row: &SessionRow, acknowledged_at_ms: u64) -> Self {
        Self {
            session_id: row.session_id.clone(),
            last_activity_at: row.last_activity_at.clone(),
            acknowledged_at_ms: Some(acknowledged_at_ms),
        }
    }
}

impl InboxStore {
    pub fn list_sessions(&self) -> Vec<SessionRow> {
        self.refresh_persisted_acknowledged_signals();
        let dismissed_session_ids = self
            .dismissed_session_ids
            .lock()
            .expect("dismissed session store lock poisoned");
        let acknowledged_signals = self
            .acknowledged_signals
            .lock()
            .expect("acknowledged signal store lock poisoned");

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

                row = apply_acknowledged_session_state(row, &acknowledged_signals, current_time_millis());
                apply_dismissed_session_state(row, &dismissed_session_ids)
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
            .fast_session_row_for_jump(session_id)
            .or_else(|| {
                self.list_sessions()
                    .into_iter()
                    .find(|row| row.session_id == session_id)
            });
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
        if matches!(execution, Some(Ok(()))) {
            if let Some(row) = row.as_ref() {
                self.acknowledge_session_signal(row);
            }
        }
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

    fn acknowledge_session_signal(&self, row: &SessionRow) {
        let mut acknowledged_signals = self
            .acknowledged_signals
            .lock()
            .expect("acknowledged signal store lock poisoned");
        acknowledged_signals.replace(AcknowledgedSignal::from_row_at(row, current_time_millis()));
        let _ = save_acknowledged_signals(&acknowledged_signals_path(), &acknowledged_signals);
    }

    fn fast_session_row_for_jump(&self, session_id: &str) -> Option<SessionRow> {
        let observation = discover_codex_observation_by_id(
            &codex_state_db_path(),
            session_id,
            std::time::SystemTime::now(),
        )?;
        let mut row = classify_observation(observation);
        row = apply_live_cli_activity_signal(row, live_cli_tty_for_row);
        let jump_availability = if row.workspace_path.is_some() {
            if matches!(row.jump_target, JumpTarget::Desktop) {
                JumpAvailability::Exact
            } else {
                JumpAvailability::Approximate
            }
        } else {
            JumpAvailability::Unavailable
        };

        Some(row.with_jump_availability(jump_availability))
    }

    fn refresh_persisted_acknowledged_signals(&self) {
        let loaded = load_acknowledged_signals(&acknowledged_signals_path());
        if loaded.is_empty() {
            return;
        }

        let mut acknowledged_signals = self
            .acknowledged_signals
            .lock()
            .expect("acknowledged signal store lock poisoned");
        acknowledged_signals.extend(loaded);
    }
}

fn load_acknowledged_signals(path: &std::path::Path) -> HashSet<AcknowledgedSignal> {
    let Ok(content) = fs::read_to_string(path) else {
        return HashSet::new();
    };

    serde_json::from_str(&content).unwrap_or_default()
}

fn save_acknowledged_signals(
    path: &std::path::Path,
    signals: &HashSet<AcknowledgedSignal>,
) -> Result<(), std::io::Error> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }

    let content = serde_json::to_string_pretty(signals)
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))?;
    fs::write(path, content)
}

fn apply_acknowledged_session_state(
    row: SessionRow,
    acknowledged_signals: &HashSet<AcknowledgedSignal>,
    now_ms: u64,
) -> SessionRow {
    let Some(signal) = acknowledged_signals.get(&AcknowledgedSignal::from_row(&row)) else {
        return row;
    };

    if matches!(row.state, SessionState::Running | SessionState::Idle) {
        return row;
    }

    let Some(acknowledged_at_ms) = signal.acknowledged_at_ms else {
        return SessionRow {
            state: SessionState::Idle,
            confidence: Confidence::Inferred,
            status_reason: "User confirmed via Jump back; idle until the next source signal.".to_string(),
            handled: true,
            dismissed: false,
            ..row
        };
    };

    if now_ms.saturating_sub(acknowledged_at_ms) <= 30 * 60 * 1000 {
        return SessionRow {
            state: SessionState::NeedsAttention,
            confidence: Confidence::Exact,
            status_reason: "Read recently; keep in needed state until 30 minutes pass.".to_string(),
            handled: true,
            dismissed: false,
            ..row
        };
    }

    SessionRow {
        state: SessionState::Idle,
        confidence: Confidence::Inferred,
        status_reason: "Read window expired; idle until the next source signal.".to_string(),
        handled: true,
        dismissed: false,
        ..row
    }
}

fn apply_dismissed_session_state(
    row: SessionRow,
    dismissed_session_ids: &HashSet<String>,
) -> SessionRow {
    if !dismissed_session_ids.contains(&row.session_id) {
        return row;
    }

    if matches!(row.state, SessionState::Running | SessionState::NeedsAttention) {
        row.mark_restored()
    } else {
        row.mark_dismissed()
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
            execute_codex_desktop_jump(
                &deeplink_url,
                &workspace_path,
                &activate_bundle_id,
                open_codex_thread_deeplink,
                open_codex_workspace,
                activate_app,
            )
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

fn execute_codex_desktop_jump(
    deeplink_url: &str,
    _workspace_path: &str,
    _activate_bundle_id: &str,
    open_deeplink: impl FnOnce(&str) -> Result<(), String>,
    _open_workspace: impl FnOnce(&str) -> Result<(), String>,
    _activate: impl FnOnce(&str) -> Result<(), String>,
) -> Result<(), String> {
    open_deeplink(deeplink_url)
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

fn acknowledged_signals_path() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".codex")
        .join("agent-session-inbox")
        .join("acknowledged-signals.json")
}

fn current_time_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;
    use std::fs;

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

        let Some(session_id) = store
            .list_sessions()
            .into_iter()
            .find(|row| !matches!(row.state, SessionState::Running | SessionState::NeedsAttention))
            .map(|row| row.session_id)
        else {
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
    fn desktop_deeplink_success_does_not_run_extra_activation() {
        let calls = std::cell::RefCell::new(Vec::new());

        let result = super::execute_codex_desktop_jump(
            "codex://threads/s1",
            "/Users/edy/project-a",
            "com.openai.codex",
            |url| {
                calls.borrow_mut().push(format!("deeplink:{url}"));
                Ok(())
            },
            |workspace| {
                calls.borrow_mut().push(format!("workspace:{workspace}"));
                Ok(())
            },
            |bundle_id| {
                calls.borrow_mut().push(format!("activate:{bundle_id}"));
                Ok(())
            },
        );

        assert_eq!(result, Ok(()));
        assert_eq!(*calls.borrow(), vec!["deeplink:codex://threads/s1"]);
    }

    #[test]
    fn desktop_deeplink_failure_does_not_open_workspace_fallback() {
        let calls = std::cell::RefCell::new(Vec::new());

        let result = super::execute_codex_desktop_jump(
            "codex://threads/s1",
            "/Users/edy/project-a",
            "com.openai.codex",
            |url| {
                calls.borrow_mut().push(format!("deeplink:{url}"));
                Err("deeplink failed".to_string())
            },
            |workspace| {
                calls.borrow_mut().push(format!("workspace:{workspace}"));
                Ok(())
            },
            |bundle_id| {
                calls.borrow_mut().push(format!("activate:{bundle_id}"));
                Ok(())
            },
        );

        assert_eq!(result, Err("deeplink failed".to_string()));
        assert_eq!(
            *calls.borrow(),
            vec!["deeplink:codex://threads/s1"]
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

    #[test]
    fn dismissed_inspect_rows_stay_hidden_until_they_run_again() {
        let dismissed_session_ids = HashSet::from(["s5".to_string()]);
        let inspect_row =
            SessionRow::new("s5", "Inspect row", SessionState::Inspect, Confidence::Exact);
        let running_row =
            SessionRow::new("s5", "Running row", SessionState::Running, Confidence::Exact);
        let attention_row =
            SessionRow::new("s5", "Input row", SessionState::NeedsAttention, Confidence::Exact);

        let inspect_row = super::apply_dismissed_session_state(inspect_row, &dismissed_session_ids);
        let running_row = super::apply_dismissed_session_state(running_row, &dismissed_session_ids);
        let attention_row = super::apply_dismissed_session_state(attention_row, &dismissed_session_ids);

        assert!(inspect_row.dismissed);
        assert!(!running_row.dismissed);
        assert!(!attention_row.dismissed);
    }

    #[test]
    fn current_completed_threads_are_quiet_rows() {
        let store = InboxStore::default();
        let Some(row) = store
            .list_sessions()
            .into_iter()
            .find(|row| row.workspace_path.as_deref() == Some("/Users/edy/sofdev/agent-session-inbox"))
        else {
            return;
        };

        match row.state {
            SessionState::Idle => {
                assert_eq!(row.confidence, Confidence::Inferred);
                assert!(row.status_reason.contains("completed task observed"));
            }
            SessionState::Running => {
                assert!(matches!(row.confidence, Confidence::Exact | Confidence::Inferred));
                assert!(
                    row.status_reason.contains("running signal observed")
                        || row.status_reason.contains("Live Codex CLI process")
                );
            }
            _ => panic!("current project row should be active or idle"),
        }
    }

    #[test]
    fn acknowledged_rows_become_needed_for_thirty_minutes_then_idle() {
        let row = SessionRow::new("s6", "Needs input", SessionState::Inspect, Confidence::Exact)
            .with_last_activity("2026-06-04T04:00:00.000Z");
        let acknowledged_at_ms = 1_780_000_000_000;
        let acknowledged = HashSet::from([super::AcknowledgedSignal::from_row_at(&row, acknowledged_at_ms)]);

        let confirmed_row = super::apply_acknowledged_session_state(
            row,
            &acknowledged,
            acknowledged_at_ms + 29 * 60 * 1000,
        );

        assert_eq!(confirmed_row.state, SessionState::NeedsAttention);
        assert_eq!(confirmed_row.confidence, Confidence::Exact);
        assert!(confirmed_row.handled);
        assert!(!confirmed_row.dismissed);
        assert!(confirmed_row.status_reason.contains("Read recently"));

        let row = SessionRow::new("s6", "Needs input", SessionState::Inspect, Confidence::Exact)
            .with_last_activity("2026-06-04T04:00:00.000Z");
        let expired_row = super::apply_acknowledged_session_state(
            row,
            &acknowledged,
            acknowledged_at_ms + 31 * 60 * 1000,
        );

        assert_eq!(expired_row.state, SessionState::Idle);
        assert_eq!(expired_row.confidence, Confidence::Inferred);
        assert!(expired_row.handled);
        assert!(expired_row.status_reason.contains("Read window expired"));

        let changed_row = SessionRow::new("s6", "Needs input", SessionState::Inspect, Confidence::Exact)
            .with_last_activity("2026-06-04T04:01:00.000Z");
        let changed_row = super::apply_acknowledged_session_state(changed_row, &acknowledged, acknowledged_at_ms);

        assert_eq!(changed_row.state, SessionState::Inspect);
        assert!(!changed_row.handled);
    }

    #[test]
    fn acknowledged_signals_round_trip_to_disk() {
        let temp = tempfile::tempdir().expect("temp dir");
        let path = temp.path().join("acknowledged-signals.json");
        let signal = super::AcknowledgedSignal {
            session_id: "s7".to_string(),
            last_activity_at: Some("2026-06-05T07:22:45.199Z".to_string()),
            acknowledged_at_ms: Some(1_780_647_765_000),
        };
        let signals = HashSet::from([signal.clone()]);

        super::save_acknowledged_signals(&path, &signals).expect("save signals");
        let loaded = super::load_acknowledged_signals(&path);

        assert_eq!(loaded, signals);
        assert!(fs::read_to_string(path).expect("signal file").contains("2026-06-05T07:22:45.199Z"));
    }
}
