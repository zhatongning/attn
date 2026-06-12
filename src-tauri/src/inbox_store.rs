use std::collections::{HashMap, HashSet};
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
use crate::codex_source::{discover_codex_observation_by_id, discover_codex_observations, parse_utc_timestamp};
use crate::domain::session::{JumpAvailability, JumpTarget, SessionRow, SessionState};
use crate::domain::source_health::{SourceCapability, SourceHealth, SourceStatus};

const SESSION_ROWS_CACHE_TTL: Duration = Duration::from_millis(5500);
const PENDING_CLI_INPUT_FRESHNESS: Duration = Duration::from_secs(30 * 60);

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
    ITermActivate { tty: String, live_codex: bool },
    ITermResume {
        thread_id: String,
        workspace_path: String,
        tty: Option<String>,
    },
}

#[derive(Debug, Default)]
pub struct InboxStore {
    dismissed_session_ids: Mutex<HashSet<String>>,
    acknowledged_signals: Mutex<HashSet<AcknowledgedSignal>>,
    session_rows_cache: Mutex<Option<CachedSessionRows>>,
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

#[derive(Debug, Clone)]
struct CachedSessionRows {
    rows: Vec<SessionRow>,
    loaded_at: Instant,
}

impl InboxStore {
    pub fn list_sessions(&self) -> Vec<SessionRow> {
        let mut cache = self
            .session_rows_cache
            .lock()
            .expect("session row cache lock poisoned");
        if let Some(cached) = cache.as_ref() {
            if cached.loaded_at.elapsed() <= SESSION_ROWS_CACHE_TTL {
                return cached.rows.clone();
            }
        }

        let rows = self.compute_session_rows();
        *cache = Some(CachedSessionRows {
            rows: rows.clone(),
            loaded_at: Instant::now(),
        });

        rows
    }

    fn compute_session_rows(&self) -> Vec<SessionRow> {
        self.refresh_persisted_acknowledged_signals();
        let dismissed_session_ids = self
            .dismissed_session_ids
            .lock()
            .expect("dismissed session store lock poisoned");
        let acknowledged_signals = self
            .acknowledged_signals
            .lock()
            .expect("acknowledged signal store lock poisoned");
        let now = SystemTime::now();
        let now_ms = current_time_millis();
        let live_cli_sessions = find_live_codex_cli_sessions();

        let rows = discover_codex_observations(&codex_sessions_root(), 80)
            .into_iter()
            .map(|observation| {
                let mut row = classify_observation(observation);
                row = apply_live_cli_activity_signal(
                    row,
                    |row| live_cli_tty_for_row_from_sessions(row, &live_cli_sessions),
                    now,
                );
                row
            })
            .collect();
        let rows = merge_live_cli_sessions_with_row_builder(rows, live_cli_sessions, |live_session| {
            live_cli_session_row(live_session, now)
        });

        let mut rows = rows
            .into_iter()
            .map(|row| {
                finalize_session_row(
                    row,
                    &acknowledged_signals,
                    &dismissed_session_ids,
                    now_ms,
                )
            })
            .collect::<Vec<_>>();
        rows.sort_by(compare_session_rows_for_store);
        rows.truncate(80);
        rows
    }

    pub fn dismiss_session(&self, session_id: &str) -> Vec<SessionRow> {
        self.dismissed_session_ids
            .lock()
            .expect("dismissed session store lock poisoned")
            .insert(session_id.to_string());
        self.invalidate_session_rows_cache();

        self.list_sessions()
    }

    pub fn restore_session(&self, session_id: &str) -> Vec<SessionRow> {
        self.dismissed_session_ids
            .lock()
            .expect("dismissed session store lock poisoned")
            .remove(session_id);
        self.invalidate_session_rows_cache();

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
                        "Routes one Jump back action to Codex Desktop, a live iTerm Codex session, or a previous iTerm tab for that workspace."
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
                self.invalidate_session_rows_cache();
            }
        }
        let message = match availability {
            JumpAvailability::Exact | JumpAvailability::Approximate => match (plan, execution) {
                (Some(JumpCommandPlan::CodexDesktop { .. }), Some(Ok(()))) => {
                    "Opened Codex Desktop session.".to_string()
                }
                (
                    Some(JumpCommandPlan::ITermActivate {
                        live_codex: true, ..
                    }),
                    Some(Ok(())),
                ) => "Focused live iTerm Codex session.".to_string(),
                (
                    Some(JumpCommandPlan::ITermActivate {
                        live_codex: false,
                        ..
                    }),
                    Some(Ok(())),
                ) => "Focused previous iTerm session.".to_string(),
                (Some(JumpCommandPlan::ITermResume { tty: Some(_), .. }), Some(Ok(()))) => {
                    "Resumed Codex session in previous iTerm tab.".to_string()
                }
                (Some(JumpCommandPlan::ITermResume { tty: None, .. }), Some(Ok(()))) => {
                    "Started iTerm Codex resume session.".to_string()
                }
                (_, Some(Err(error))) => format!("Jump-back failed: {error}"),
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

    fn invalidate_session_rows_cache(&self) {
        *self
            .session_rows_cache
            .lock()
            .expect("session row cache lock poisoned") = None;
    }

    fn fast_session_row_for_jump(&self, session_id: &str) -> Option<SessionRow> {
        let now = SystemTime::now();
        let live_cli_sessions = find_live_codex_cli_sessions();
        let observation = discover_codex_observation_by_id(
            &codex_state_db_path(),
            session_id,
            now,
        )?;
        let mut row = classify_observation(observation);
        row = apply_live_cli_activity_signal(
            row,
            |row| live_cli_tty_for_row_from_sessions(row, &live_cli_sessions),
            now,
        );
        row = merge_live_cli_sessions_with_row_builder(vec![row], live_cli_sessions, |live_session| {
            live_cli_session_row(live_session, now)
        })
        .into_iter()
        .find(|row| row.session_id == session_id)?;
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

fn finalize_session_row(
    row: SessionRow,
    acknowledged_signals: &HashSet<AcknowledgedSignal>,
    dismissed_session_ids: &HashSet<String>,
    now_ms: u64,
) -> SessionRow {
    let dismissability = evaluate_dismissability(&row);
    let jump_availability = jump_availability_for_row(&row);
    let row = row
        .with_dismissability_reason(Some(dismissability.reason))
        .with_jump_availability(jump_availability);
    let row = apply_acknowledged_session_state(row, acknowledged_signals, now_ms);
    apply_dismissed_session_state(row, dismissed_session_ids)
}

fn jump_availability_for_row(row: &SessionRow) -> JumpAvailability {
    if row.workspace_path.is_none() {
        return JumpAvailability::Unavailable;
    }

    if matches!(row.jump_target, JumpTarget::Desktop) {
        JumpAvailability::Exact
    } else {
        JumpAvailability::Approximate
    }
}

fn compare_session_rows_for_store(left: &SessionRow, right: &SessionRow) -> std::cmp::Ordering {
    session_state_priority(left.state)
        .cmp(&session_state_priority(right.state))
        .then_with(|| {
            timestamp_value(right.last_activity_at.as_deref())
                .cmp(&timestamp_value(left.last_activity_at.as_deref()))
        })
}

fn session_state_priority(state: SessionState) -> u8 {
    match state {
        SessionState::WaitingForInput => 0,
        SessionState::Inspect | SessionState::Dismissable => 1,
        SessionState::Stopped => 2,
        SessionState::Running => 3,
        SessionState::NeedsAttention => 4,
        SessionState::Idle => 5,
        SessionState::Unknown => 6,
    }
}

fn timestamp_value(value: Option<&str>) -> u64 {
    value
        .and_then(parse_utc_timestamp)
        .and_then(|timestamp| timestamp.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or(0)
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

    if matches!(
        row.state,
        SessionState::Running | SessionState::Idle | SessionState::WaitingForInput
    ) {
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

    if matches!(row.state, SessionState::Running) {
        row.mark_restored()
    } else {
        row.mark_dismissed()
    }
}

fn live_cli_tty_for_row_from_sessions(
    row: &SessionRow,
    live_sessions: &[LiveCliSession],
) -> Option<String> {
    if !matches!(row.jump_target, JumpTarget::Cli) {
        return None;
    }

    if let Some(session) = live_sessions
        .iter()
        .find(|session| live_session_has_session_id(session, &row.session_id))
    {
        return Some(session.tty.clone());
    }

    row.workspace_path.as_deref().and_then(|workspace_path| {
        live_sessions
            .iter()
            .find(|session| session.session_id.is_none() && session.workspace_path == workspace_path)
            .map(|session| session.tty.clone())
    })
}

fn live_session_has_session_id(session: &LiveCliSession, session_id: &str) -> bool {
    session.session_id.as_deref() == Some(session_id)
        || session.session_ids.iter().any(|value| value == session_id)
}

fn apply_live_cli_activity_signal(
    row: SessionRow,
    live_tty_for_row: impl FnOnce(&SessionRow) -> Option<String>,
    now: SystemTime,
) -> SessionRow {
    if matches!(row.state, SessionState::WaitingForInput) && matches!(row.jump_target, JumpTarget::Cli) {
        let has_live_tty = live_tty_for_row(&row).is_some();
        if has_live_tty && row_has_fresh_activity(&row, now, PENDING_CLI_INPUT_FRESHNESS) {
            return row;
        }
        let status_reason = if has_live_tty {
            "Pending CLI input is stale; idle until the next source signal."
        } else {
            "No live Codex CLI process for pending input; idle until the next source signal."
        };

        return SessionRow {
            state: SessionState::Idle,
            confidence: Confidence::Inferred,
            status_reason: status_reason.to_string(),
            ..row
        };
    }

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

#[derive(Debug, Clone, PartialEq, Eq)]
struct LiveCliSession {
    session_id: Option<String>,
    session_ids: Vec<String>,
    workspace_path: String,
    tty: String,
}

#[cfg(test)]
fn merge_live_cli_sessions(rows: Vec<SessionRow>, live_sessions: Vec<LiveCliSession>) -> Vec<SessionRow> {
    merge_live_cli_sessions_with_row_builder(rows, live_sessions, fallback_live_cli_session_row)
}

fn merge_live_cli_sessions_with_row_builder(
    mut rows: Vec<SessionRow>,
    live_sessions: Vec<LiveCliSession>,
    missing_row: impl Fn(&LiveCliSession) -> SessionRow,
) -> Vec<SessionRow> {
    for live_session in live_sessions {
        if let Some(session_id) = live_session.session_id.as_deref() {
            let mut matched = false;
            for row in rows.iter_mut().filter(|row| row.session_id == session_id) {
                *row = mark_live_cli_session_running(row.clone(), &live_session.tty);
                matched = true;
            }
            if matched {
                continue;
            }
        }

        let row = missing_row(&live_session);
        if rows.iter().any(|existing| existing.session_id == row.session_id) {
            continue;
        }
        rows.push(mark_live_cli_session_running(row, &live_session.tty));
    }

    rows
}

fn mark_live_cli_session_running(row: SessionRow, tty: &str) -> SessionRow {
    if !should_promote_live_cli_row(row.state) {
        return row;
    }

    SessionRow {
        state: SessionState::Running,
        confidence: Confidence::Inferred,
        status_reason: format!("Live Codex CLI process observed on {tty}."),
        evidence_summary: row
            .evidence_summary
            .or_else(|| Some(format!("Live Codex CLI process observed on {tty}."))),
        handled: false,
        dismissed: false,
        jump_target: JumpTarget::Cli,
        ..row
    }
}

fn should_promote_live_cli_row(state: SessionState) -> bool {
    matches!(state, SessionState::Unknown | SessionState::Idle)
}

fn live_cli_session_row(live_session: &LiveCliSession, now: SystemTime) -> SessionRow {
    let row = live_session
        .session_id
        .as_deref()
        .and_then(|session_id| discover_codex_observation_by_id(&codex_state_db_path(), session_id, now))
        .map(classify_observation)
        .unwrap_or_else(|| fallback_live_cli_session_row(live_session));

    let project_name = live_session
        .workspace_path
        .rsplit('/')
        .next()
        .filter(|value| !value.is_empty())
        .map(ToString::to_string);

    let workspace_path = row
        .workspace_path
        .clone()
        .or_else(|| Some(live_session.workspace_path.clone()));
    let project_name = row.project_name.clone().or(project_name);

    row.with_workspace(workspace_path)
        .with_project_name(project_name)
        .with_jump_target(JumpTarget::Cli)
}

fn fallback_live_cli_session_row(live_session: &LiveCliSession) -> SessionRow {
    let session_id = live_session
        .session_id
        .clone()
        .unwrap_or_else(|| live_cli_synthetic_session_id(live_session));
    let project_name = live_session
        .workspace_path
        .rsplit('/')
        .next()
        .filter(|value| !value.is_empty())
        .map(ToString::to_string);
    let label = project_name
        .as_ref()
        .map(|name| format!("Codex CLI: {name}"))
        .unwrap_or_else(|| "Codex CLI session".to_string());

    SessionRow::new(session_id, label, SessionState::Running, Confidence::Inferred)
        .with_agent_name(Some("cli".to_string()))
        .with_project_name(project_name)
        .with_workspace(Some(live_session.workspace_path.clone()))
        .with_reason(format!("Live Codex CLI process observed on {}.", live_session.tty))
        .with_evidence_summary(Some(format!(
            "Live Codex CLI process observed on {}.",
            live_session.tty
        )))
        .with_jump_availability(JumpAvailability::Approximate)
        .with_jump_target(JumpTarget::Cli)
}

fn live_cli_synthetic_session_id(live_session: &LiveCliSession) -> String {
    format!(
        "live-cli:{}:{}",
        live_session.workspace_path, live_session.tty
    )
}

fn row_has_fresh_activity(row: &SessionRow, now: SystemTime, freshness: Duration) -> bool {
    row.last_activity_at
        .as_deref()
        .and_then(parse_utc_timestamp)
        .and_then(|last_activity| now.duration_since(last_activity).ok())
        .is_some_and(|age| age <= freshness)
}

fn build_jump_command_plan(row: &SessionRow) -> Option<JumpCommandPlan> {
    let live_sessions = find_live_codex_cli_sessions();
    build_jump_command_plan_with_live_sessions(
        row,
        &live_sessions,
        find_previous_iterm_tty_for_workspace,
    )
}

fn build_jump_command_plan_with_live_sessions(
    row: &SessionRow,
    live_sessions: &[LiveCliSession],
    previous_iterm_tty_for_workspace: impl FnOnce(&str) -> Option<String>,
) -> Option<JumpCommandPlan> {
    let Some(workspace_path) = row.workspace_path.as_deref() else {
        return build_jump_command_plan_with_cli_context(row, None, None);
    };
    let live_tty = live_cli_tty_for_jump_plan(row, live_sessions);
    let resume_tty = if live_tty.is_none() && matches!(row.jump_target, JumpTarget::Cli) {
        previous_iterm_tty_for_workspace(workspace_path)
    } else {
        None
    };

    build_jump_command_plan_with_cli_context(row, live_tty, resume_tty)
}

fn live_cli_tty_for_jump_plan(
    row: &SessionRow,
    live_sessions: &[LiveCliSession],
) -> Option<String> {
    if let Some(session) = live_sessions
        .iter()
        .find(|session| live_session_has_session_id(session, &row.session_id))
    {
        return Some(session.tty.clone());
    }

    let workspace_path = row.workspace_path.as_deref()?;
    if matches!(row.jump_target, JumpTarget::Cli) {
        return live_sessions
            .iter()
            .find(|session| session.session_id.is_none() && session.workspace_path == workspace_path)
            .map(|session| session.tty.clone());
    }

    live_sessions
        .iter()
        .find(|session| session.workspace_path == workspace_path)
        .map(|session| session.tty.clone())
}

fn build_jump_command_plan_with_cli_context(
    row: &SessionRow,
    live_tty: Option<String>,
    resume_tty: Option<String>,
) -> Option<JumpCommandPlan> {
    let workspace_path = row.workspace_path.clone()?;

    if let Some(tty) = live_tty {
        return Some(JumpCommandPlan::ITermActivate {
            tty,
            live_codex: true,
        });
    };

    match row.jump_target {
        JumpTarget::Desktop | JumpTarget::Unknown => Some(JumpCommandPlan::CodexDesktop {
            thread_id: row.session_id.clone(),
            deeplink_url: codex_thread_deeplink(&row.session_id),
            workspace_path,
            activate_bundle_id: codex_bundle_id().to_string(),
        }),
        JumpTarget::Cli => Some(JumpCommandPlan::ITermResume {
            thread_id: row.session_id.clone(),
            workspace_path,
            tty: resume_tty,
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
        JumpCommandPlan::ITermActivate { tty, .. } => activate_iterm_tty(&tty),
        JumpCommandPlan::ITermResume {
            thread_id,
            workspace_path,
            tty,
        } => open_iterm_codex_resume(&workspace_path, &thread_id, tty.as_deref()),
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

fn find_live_codex_cli_sessions() -> Vec<LiveCliSession> {
    let output = match Command::new("ps")
        .args(["-axo", "pid=,tty=,comm=,args="])
        .output()
    {
        Ok(output) => output,
        Err(_) => return Vec::new(),
    };
    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut sessions_by_terminal = HashMap::<(String, String), LiveCliSession>::new();

    for line in stdout.lines() {
        let Some((pid, tty, args)) = parse_codex_process_line(line) else {
            continue;
        };
        let Some(cwd) = process_cwd(pid) else {
            continue;
        };
        let session_ids = unique_session_ids(
            live_cli_session_ids_from_args(args)
                .into_iter()
                .chain(live_cli_session_ids_from_open_files(pid))
                .collect(),
        );
        let session_id = select_live_cli_primary_session_id(args, &session_ids);
        let key = (cwd.clone(), tty.to_string());
        sessions_by_terminal
            .entry(key)
            .and_modify(|existing| {
                if existing.session_id.is_none() {
                    existing.session_id = session_id.clone();
                }
                existing.session_ids = unique_session_ids(
                    existing
                        .session_ids
                        .iter()
                        .cloned()
                        .chain(session_ids.clone())
                        .collect(),
                );
            })
            .or_insert_with(|| LiveCliSession {
                session_id,
                session_ids,
                workspace_path: cwd,
                tty: tty.to_string(),
            });
    }

    let mut sessions = sessions_by_terminal.into_values().collect::<Vec<_>>();
    sessions.sort_by(|left, right| {
        left.workspace_path
            .cmp(&right.workspace_path)
            .then(left.tty.cmp(&right.tty))
            .then(left.session_id.cmp(&right.session_id))
    });
    sessions
}

fn find_previous_iterm_tty_for_workspace(workspace_path: &str) -> Option<String> {
    let workspace_shell_ttys = find_shell_ttys_for_workspace(workspace_path);
    if workspace_shell_ttys.is_empty() {
        return None;
    }

    let mut matching_sessions = list_iterm_sessions()
        .into_iter()
        .filter(|session| workspace_shell_ttys.contains(&normalize_tty(&session.tty)))
        .collect::<Vec<_>>();

    matching_sessions.sort_by_key(|session| {
        if session.name.to_ascii_lowercase().contains("codex") {
            0
        } else {
            1
        }
    });

    matching_sessions
        .into_iter()
        .next()
        .map(|session| normalize_tty(&session.tty))
}

fn find_shell_ttys_for_workspace(workspace_path: &str) -> HashSet<String> {
    let output = match Command::new("ps")
        .args(["-axo", "pid=,tty=,comm=,args="])
        .output()
    {
        Ok(output) => output,
        Err(_) => return HashSet::new(),
    };
    let stdout = String::from_utf8_lossy(&output.stdout);
    stdout
        .lines()
        .filter_map(parse_shell_process_line)
        .filter_map(|(pid, tty)| {
            process_cwd(pid)
                .filter(|cwd| cwd == workspace_path)
                .map(|_| tty.to_string())
        })
        .collect()
}

#[derive(Debug, Clone)]
struct ITermSession {
    tty: String,
    name: String,
}

fn list_iterm_sessions() -> Vec<ITermSession> {
    let script = r#"set rows to {}
tell application id "com.googlecode.iterm2"
repeat with w in windows
repeat with t in tabs of w
repeat with s in sessions of t
try
set end of rows to ((tty of s as text) & tab & (name of s as text))
end try
end repeat
end repeat
end repeat
end tell
set AppleScript's text item delimiters to linefeed
return rows as text"#;
    let output = match Command::new("osascript").args(["-e", script]).output() {
        Ok(output) if output.status.success() => output,
        _ => return Vec::new(),
    };
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| {
            let (tty, name) = line.split_once('\t')?;
            Some(ITermSession {
                tty: tty.to_string(),
                name: name.to_string(),
            })
        })
        .collect()
}

fn parse_codex_process_line(line: &str) -> Option<(&str, &str, &str)> {
    let mut parts = line.split_whitespace();
    let pid = parts.next()?;
    let tty = parts.next()?;
    let _comm = parts.next()?;
    let args_start = line.find(_comm)? + _comm.len();
    let args = line[args_start..].trim();

    if !tty.starts_with("ttys") || !is_codex_cli_args(args) {
        return None;
    }

    Some((pid, tty, args))
}

fn is_codex_cli_args(args: &str) -> bool {
    if args.contains(" app-server ") {
        return false;
    }

    let Some(executable) = args.split_whitespace().next() else {
        return false;
    };
    executable.rsplit('/').next().unwrap_or(executable) == "codex"
}

fn live_cli_session_id_from_args(args: &str) -> Option<String> {
    live_cli_session_ids_from_args(args).into_iter().next()
}

fn select_live_cli_primary_session_id(args: &str, session_ids: &[String]) -> Option<String> {
    live_cli_session_id_from_args(args).or_else(|| {
        if session_ids.len() == 1 {
            session_ids.first().cloned()
        } else {
            None
        }
    })
}

fn live_cli_session_ids_from_args(args: &str) -> Vec<String> {
    let parts = args.split_whitespace().collect::<Vec<_>>();
    let mut session_ids = Vec::new();
    for (index, part) in parts.iter().enumerate() {
        if matches!(*part, "resume" | "--resume") {
            let Some(candidate) = parts.get(index + 1) else {
                continue;
            };
            if looks_like_codex_session_id(candidate) {
                session_ids.push((*candidate).to_string());
            }
        }

        if let Some(candidate) = part.strip_prefix("--resume=") {
            if looks_like_codex_session_id(candidate) {
                session_ids.push(candidate.to_string());
            }
        }
    }

    unique_session_ids(session_ids)
}

fn live_cli_session_ids_from_open_files(pid: &str) -> Vec<String> {
    let Ok(output) = Command::new("lsof").arg("-p").arg(pid).output() else {
        return Vec::new();
    };
    let stdout = String::from_utf8_lossy(&output.stdout);
    unique_session_ids(stdout
        .lines()
        .filter_map(|line| {
            line.split_whitespace()
                .find(|part| part.contains("rollout-") && part.ends_with(".jsonl"))
        })
        .filter_map(session_id_from_jsonl_path)
        .collect())
}

fn unique_session_ids(session_ids: Vec<String>) -> Vec<String> {
    let mut unique = Vec::new();
    for session_id in session_ids {
        if !unique.contains(&session_id) {
            unique.push(session_id);
        }
    }
    unique
}

fn session_id_from_jsonl_path(path: &str) -> Option<String> {
    let file_name = path.rsplit('/').next()?;
    let stem = file_name.strip_suffix(".jsonl").unwrap_or(file_name);
    let parts = stem.split('-').collect::<Vec<_>>();
    let candidate = if parts.len() >= 5 {
        parts[parts.len() - 5..].join("-")
    } else {
        stem.rsplit('-').next().unwrap_or(stem).to_string()
    };
    let candidate = candidate.as_str();
    looks_like_codex_session_id(candidate).then(|| candidate.to_string())
}

fn looks_like_codex_session_id(value: &str) -> bool {
    value.len() >= 20
        && value.contains('-')
        && value
            .chars()
            .all(|ch| ch.is_ascii_hexdigit() || ch == '-')
}

fn parse_shell_process_line(line: &str) -> Option<(&str, &str)> {
    let mut parts = line.split_whitespace();
    let pid = parts.next()?;
    let tty = parts.next()?;
    let comm = parts.next()?;
    if !tty.starts_with("ttys") {
        return None;
    }
    let executable = comm
        .rsplit('/')
        .next()
        .unwrap_or(comm)
        .trim_start_matches('-')
        .to_ascii_lowercase();
    if matches!(executable.as_str(), "zsh" | "bash" | "fish") {
        Some((pid, tty))
    } else {
        None
    }
}

fn normalize_tty(tty: &str) -> String {
    tty.strip_prefix("/dev/").unwrap_or(tty).to_string()
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
}

fn open_iterm_codex_resume(
    workspace_path: &str,
    thread_id: &str,
    tty: Option<&str>,
) -> Result<(), String> {
    let command = format!(
        "cd {} && codex resume {}",
        shell_single_quote(workspace_path),
        shell_single_quote(thread_id),
    );

    let script = if let Some(tty) = tty {
        let tty_path = if tty.starts_with("/dev/") {
            tty.to_string()
        } else {
            format!("/dev/{tty}")
        };
        format!(
            r#"with timeout of 5 seconds
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
write text {quoted_command}
return "resumed"
end if
end try
end repeat
end repeat
end repeat
set newWindow to (create window with default profile)
tell current session of newWindow
write text {quoted_command}
end tell
end tell
end timeout"#,
            quoted_tty = applescript_string_literal(tty),
            quoted_tty_path = applescript_string_literal(&tty_path),
            quoted_command = applescript_string_literal(&command)
        )
    } else {
        format!(
            r#"with timeout of 5 seconds
tell application id "com.googlecode.iterm2"
activate
set newWindow to (create window with default profile)
tell current session of newWindow
write text {quoted_command}
end tell
end tell
end timeout"#,
            quoted_command = applescript_string_literal(&command)
        )
    };

    run_command_with_timeout("osascript", &["-e", &script], Duration::from_secs(6))
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

fn applescript_string_literal(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

fn shell_single_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
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
    use std::time::{Duration, UNIX_EPOCH};

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
            .find(|row| {
                !matches!(
                    row.state,
                    SessionState::Running | SessionState::NeedsAttention | SessionState::WaitingForInput
                )
            })
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
    fn live_cli_terminal_takes_precedence_over_desktop_jump_plan_for_same_workspace() {
        let row = SessionRow::new("s1", "Desktop row", SessionState::Running, Confidence::Exact)
            .with_workspace(Some("/Users/edy/project-a".to_string()))
            .with_jump_availability(JumpAvailability::Exact)
            .with_jump_target(JumpTarget::Desktop);

        let plan = super::build_jump_command_plan_with_cli_context(
            &row,
            Some("ttys009".to_string()),
            None,
        );

        assert_eq!(
            plan,
            Some(super::JumpCommandPlan::ITermActivate {
                tty: "ttys009".to_string(),
                live_codex: true
            })
        );
    }

    #[test]
    fn cli_sessions_with_live_tty_build_iterm_activate_jump_plan() {
        let row = SessionRow::new("s2", "CLI row", SessionState::Running, Confidence::Exact)
            .with_workspace(Some("/Users/edy/project-b".to_string()))
            .with_jump_availability(JumpAvailability::Approximate)
            .with_jump_target(JumpTarget::Cli);

        let plan = super::build_jump_command_plan_with_cli_context(
            &row,
            Some("ttys008".to_string()),
            None,
        );

        assert_eq!(
            plan,
            Some(super::JumpCommandPlan::ITermActivate {
                tty: "ttys008".to_string(),
                live_codex: true
            })
        );
    }

    #[test]
    fn cli_jump_plan_targets_matching_live_session_when_workspace_has_multiple_tabs() {
        let row = SessionRow::new(
            "019eaa00-0000-7000-8000-000000000002",
            "CLI row",
            SessionState::Running,
            Confidence::Inferred,
        )
        .with_workspace(Some("/Users/edy/hose/tmc_symposium/tmc_surprise".to_string()))
        .with_jump_availability(JumpAvailability::Approximate)
        .with_jump_target(JumpTarget::Cli);
        let live_sessions = vec![
            super::LiveCliSession {
                session_id: Some("019eaa00-0000-7000-8000-000000000001".to_string()),
                session_ids: vec!["019eaa00-0000-7000-8000-000000000001".to_string()],
                workspace_path: "/Users/edy/hose/tmc_symposium/tmc_surprise".to_string(),
                tty: "ttys001".to_string(),
            },
            super::LiveCliSession {
                session_id: Some("019eaa00-0000-7000-8000-000000000002".to_string()),
                session_ids: vec!["019eaa00-0000-7000-8000-000000000002".to_string()],
                workspace_path: "/Users/edy/hose/tmc_symposium/tmc_surprise".to_string(),
                tty: "ttys004".to_string(),
            },
        ];

        let plan = super::build_jump_command_plan_with_live_sessions(
            &row,
            &live_sessions,
            |_| None,
        );

        assert_eq!(
            plan,
            Some(super::JumpCommandPlan::ITermActivate {
                tty: "ttys004".to_string(),
                live_codex: true
            })
        );
    }

    #[test]
    fn cli_jump_plan_targets_parent_tty_when_live_process_also_has_subagent_files() {
        let row = SessionRow::new(
            "019eaa00-0000-7000-8000-000000000010",
            "CLI parent row",
            SessionState::Running,
            Confidence::Inferred,
        )
        .with_workspace(Some("/Users/edy/hose/tmc_symposium/tmc_surprise".to_string()))
        .with_jump_availability(JumpAvailability::Approximate)
        .with_jump_target(JumpTarget::Cli);
        let live_sessions = vec![super::LiveCliSession {
            session_id: Some("019eaa00-0000-7000-8000-000000000011".to_string()),
            session_ids: vec![
                "019eaa00-0000-7000-8000-000000000011".to_string(),
                "019eaa00-0000-7000-8000-000000000010".to_string(),
            ],
            workspace_path: "/Users/edy/hose/tmc_symposium/tmc_surprise".to_string(),
            tty: "ttys002".to_string(),
        }];

        let plan = super::build_jump_command_plan_with_live_sessions(
            &row,
            &live_sessions,
            |_| Some("ttys003".to_string()),
        );

        assert_eq!(
            plan,
            Some(super::JumpCommandPlan::ITermActivate {
                tty: "ttys002".to_string(),
                live_codex: true
            })
        );
    }

    #[test]
    fn parse_codex_process_line_only_accepts_actual_cli_executable() {
        let helper_line =
            "4576 ttys002 /Users/edy/.code /Users/edy/.codex/computer-use/Codex Computer Use.app/Contents/MacOS/SkyComputerUseClient turn-ended {\"client\":\"codex-tui\",\"thread-id\":\"019eb47b-a10e-7931-aae7-6a6118962db0\"}";
        let app_server_line =
            "14279 ttys002 /Applications/Co /Applications/Codex.app/Contents/Resources/codex app-server --listen stdio://";
        let cli_resume_line =
            "29457 ttys016 /Applications/Co /Applications/Codex.app/Contents/Resources/codex resume 019e9153-943a-7402-8e61-9e89cee5a6f4 --cd /Users/edy/hose/tmc_symposium/tmc_surprise";

        assert!(super::parse_codex_process_line(helper_line).is_none());
        assert!(super::parse_codex_process_line(app_server_line).is_none());
        assert_eq!(
            super::parse_codex_process_line(cli_resume_line),
            Some((
                "29457",
                "ttys016",
                "/Applications/Codex.app/Contents/Resources/codex resume 019e9153-943a-7402-8e61-9e89cee5a6f4 --cd /Users/edy/hose/tmc_symposium/tmc_surprise"
            ))
        );
    }

    #[test]
    fn live_cli_primary_session_from_open_files_requires_unique_rollout() {
        let child_id = "019eb66b-7687-7d33-9509-c3a024bab50e";
        let parent_id = "019eb47b-a10e-7931-aae7-6a6118962db0";
        let cli_args =
            "/Users/edy/.nvm/versions/node/v22.12.0/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex";

        assert_eq!(
            super::select_live_cli_primary_session_id(cli_args, &[child_id.to_string(), parent_id.to_string()]),
            None
        );
        assert_eq!(
            super::select_live_cli_primary_session_id(cli_args, &[child_id.to_string()]),
            Some(child_id.to_string())
        );
        assert_eq!(
            super::select_live_cli_primary_session_id(
                &format!("{cli_args} resume {parent_id}"),
                &[child_id.to_string()]
            ),
            Some(parent_id.to_string())
        );
    }

    #[test]
    fn cli_sessions_without_live_tty_resume_exact_session_in_previous_iterm_item() {
        let row = SessionRow::new("s2", "CLI row", SessionState::Running, Confidence::Exact)
            .with_workspace(Some("/Users/edy/project-b".to_string()))
            .with_jump_availability(JumpAvailability::Approximate)
            .with_jump_target(JumpTarget::Cli);

        let plan = super::build_jump_command_plan_with_cli_context(
            &row,
            None,
            Some("ttys002".to_string()),
        );

        assert_eq!(
            plan,
            Some(super::JumpCommandPlan::ITermResume {
                thread_id: "s2".to_string(),
                workspace_path: "/Users/edy/project-b".to_string(),
                tty: Some("ttys002".to_string()),
            })
        );
    }

    #[test]
    fn cli_sessions_without_any_terminal_resume_in_new_iterm_item() {
        let row = SessionRow::new("s2", "CLI row", SessionState::Running, Confidence::Exact)
            .with_workspace(Some("/Users/edy/project-b".to_string()))
            .with_jump_availability(JumpAvailability::Approximate)
            .with_jump_target(JumpTarget::Cli);

        let plan = super::build_jump_command_plan_with_cli_context(&row, None, None);

        assert_eq!(
            plan,
            Some(super::JumpCommandPlan::ITermResume {
                thread_id: "s2".to_string(),
                workspace_path: "/Users/edy/project-b".to_string(),
                tty: None,
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
    fn iterm_activation_failure_is_reported_instead_of_only_activating_app() {
        let result = super::run_command_with_timeout(
            "osascript",
            &["-e", "error \"missing target tty\""],
            std::time::Duration::from_secs(1),
        );

        assert!(result.is_err());
    }

    #[test]
    fn unknown_cli_rows_with_live_process_signal_are_promoted_to_running() {
        let row = SessionRow::new("s4", "CLI row", SessionState::Unknown, Confidence::Unknown)
            .with_workspace(Some("/Users/edy/project-d".to_string()))
            .with_reason("missing source evidence for status classification")
            .with_jump_target(JumpTarget::Cli);

        let row = super::apply_live_cli_activity_signal(
            row,
            |_| Some("ttys008".to_string()),
            UNIX_EPOCH + Duration::from_secs(1_780_720_000),
        );

        assert_eq!(row.state, SessionState::Running);
        assert_eq!(row.confidence, Confidence::Inferred);
        assert!(row.status_reason.contains("Live Codex CLI process"));
    }

    #[test]
    fn live_cli_sessions_missing_from_discovery_are_added_as_running_rows() {
        let rows = vec![SessionRow::new(
            "old",
            "Old CLI row",
            SessionState::Inspect,
            Confidence::Exact,
        )
        .with_workspace(Some("/repo".to_string()))
        .with_jump_target(JumpTarget::Cli)];
        let live_sessions = vec![super::LiveCliSession {
            session_id: Some("live-session".to_string()),
            session_ids: vec!["live-session".to_string()],
            workspace_path: "/repo".to_string(),
            tty: "ttys008".to_string(),
        }];

        let rows = super::merge_live_cli_sessions(rows, live_sessions);

        let live_row = rows
            .iter()
            .find(|row| row.session_id == "live-session")
            .expect("live CLI session row");
        assert_eq!(live_row.state, SessionState::Running);
        assert_eq!(live_row.jump_target, JumpTarget::Cli);
        assert_eq!(live_row.workspace_path.as_deref(), Some("/repo"));
        assert!(live_row.status_reason.contains("Live Codex CLI process observed on ttys008"));
        assert_eq!(
            rows.iter()
                .find(|row| row.session_id == "old")
                .expect("old row")
                .state,
            SessionState::Inspect
        );
    }

    #[test]
    fn live_cli_sessions_promote_matching_rows_without_adding_duplicates() {
        let rows = vec![SessionRow::new(
            "live-session",
            "Known CLI row",
            SessionState::Unknown,
            Confidence::Unknown,
        )
        .with_workspace(Some("/repo".to_string()))
        .with_jump_target(JumpTarget::Cli)];
        let live_sessions = vec![super::LiveCliSession {
            session_id: Some("live-session".to_string()),
            session_ids: vec!["live-session".to_string()],
            workspace_path: "/repo".to_string(),
            tty: "ttys008".to_string(),
        }];

        let rows = super::merge_live_cli_sessions(rows, live_sessions);

        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].state, SessionState::Running);
        assert_eq!(rows[0].confidence, Confidence::Inferred);
    }

    #[test]
    fn live_cli_sessions_keep_completed_matching_rows_in_inspect() {
        let rows = vec![SessionRow::new(
            "live-session",
            "Known completed CLI row",
            SessionState::Inspect,
            Confidence::Exact,
        )
        .with_workspace(Some("/repo".to_string()))
        .with_reason("completed task ready to inspect; open it to mark read")
        .with_jump_target(JumpTarget::Cli)];
        let live_sessions = vec![super::LiveCliSession {
            session_id: Some("live-session".to_string()),
            session_ids: vec!["live-session".to_string()],
            workspace_path: "/repo".to_string(),
            tty: "ttys008".to_string(),
        }];

        let rows = super::merge_live_cli_sessions(rows, live_sessions);

        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].state, SessionState::Inspect);
        assert_eq!(rows[0].confidence, Confidence::Exact);
        assert_eq!(
            rows[0].status_reason,
            "completed task ready to inspect; open it to mark read"
        );
    }

    #[test]
    fn parses_session_id_from_rollout_jsonl_path_with_uuid_segments() {
        assert_eq!(
            super::session_id_from_jsonl_path(
                "/Users/edy/.codex/archived_sessions/rollout-2026-06-04T14-30-34-019e9153-943a-7402-8e61-9e89cee5a6f4.jsonl"
            ),
            Some("019e9153-943a-7402-8e61-9e89cee5a6f4".to_string())
        );
    }

    #[test]
    fn stale_cli_waiting_for_input_without_live_process_is_idle() {
        let row = SessionRow::new(
            "s9",
            "CLI waiting row",
            SessionState::WaitingForInput,
            Confidence::Exact,
        )
        .with_workspace(Some("/repo".to_string()))
        .with_reason("waiting for user input")
        .with_evidence_summary(Some("Codex is waiting for tool approval: git pull".to_string()))
        .with_jump_target(JumpTarget::Cli);

        let row = super::apply_live_cli_activity_signal(
            row,
            |_| None,
            UNIX_EPOCH + Duration::from_secs(1_780_720_000),
        );

        assert_eq!(row.state, SessionState::Idle);
        assert_eq!(row.confidence, Confidence::Inferred);
        assert!(row.status_reason.contains("No live Codex CLI process"));
    }

    #[test]
    fn fresh_cli_waiting_for_input_with_live_process_stays_waiting() {
        let row = SessionRow::new(
            "s10",
            "CLI waiting row",
            SessionState::WaitingForInput,
            Confidence::Exact,
        )
        .with_workspace(Some("/repo".to_string()))
        .with_reason("waiting for user input")
        .with_last_activity("2026-06-06T04:05:00.000Z")
        .with_jump_target(JumpTarget::Cli);

        let row = super::apply_live_cli_activity_signal(
            row,
            |_| Some("ttys008".to_string()),
            UNIX_EPOCH + Duration::from_secs(1_780_719_000),
        );

        assert_eq!(row.state, SessionState::WaitingForInput);
        assert_eq!(row.confidence, Confidence::Exact);
    }

    #[test]
    fn stale_cli_waiting_for_input_with_live_process_is_idle() {
        let row = SessionRow::new(
            "s11",
            "CLI waiting row",
            SessionState::WaitingForInput,
            Confidence::Exact,
        )
        .with_workspace(Some("/repo".to_string()))
        .with_reason("waiting for user input")
        .with_last_activity("2026-06-06T04:05:00.000Z")
        .with_evidence_summary(Some("Codex is waiting for tool approval: git pull".to_string()))
        .with_jump_target(JumpTarget::Cli);

        let row = super::apply_live_cli_activity_signal(
            row,
            |_| Some("ttys008".to_string()),
            UNIX_EPOCH + Duration::from_secs(1_780_720_801),
        );

        assert_eq!(row.state, SessionState::Idle);
        assert_eq!(row.confidence, Confidence::Inferred);
        assert!(row.status_reason.contains("Pending CLI input is stale"));
    }

    #[test]
    fn dismissed_attention_rows_stay_hidden_until_they_run_again() {
        let dismissed_session_ids = HashSet::from(["s5".to_string()]);
        let inspect_row =
            SessionRow::new("s5", "Inspect row", SessionState::Inspect, Confidence::Exact);
        let running_row =
            SessionRow::new("s5", "Running row", SessionState::Running, Confidence::Exact);
        let attention_row =
            SessionRow::new("s5", "Input row", SessionState::NeedsAttention, Confidence::Exact);
        let input_row =
            SessionRow::new("s5", "Waiting row", SessionState::WaitingForInput, Confidence::Exact);

        let inspect_row = super::apply_dismissed_session_state(inspect_row, &dismissed_session_ids);
        let running_row = super::apply_dismissed_session_state(running_row, &dismissed_session_ids);
        let attention_row = super::apply_dismissed_session_state(attention_row, &dismissed_session_ids);
        let input_row = super::apply_dismissed_session_state(input_row, &dismissed_session_ids);

        assert!(inspect_row.dismissed);
        assert!(!running_row.dismissed);
        assert!(attention_row.dismissed);
        assert!(input_row.dismissed);
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
    fn fresh_session_rows_cache_short_circuits_local_discovery() {
        let cached_row = SessionRow::new(
            "cached-session",
            "Cached session",
            SessionState::Idle,
            Confidence::Exact,
        );
        let store = InboxStore {
            dismissed_session_ids: std::sync::Mutex::new(HashSet::new()),
            acknowledged_signals: std::sync::Mutex::new(HashSet::new()),
            session_rows_cache: std::sync::Mutex::new(Some(super::CachedSessionRows {
                rows: vec![cached_row.clone()],
                loaded_at: std::time::Instant::now(),
            })),
        };

        let rows = store.list_sessions();

        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].session_id, cached_row.session_id);
        assert_eq!(rows[0].label, cached_row.label);
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
    fn acknowledged_waiting_for_input_rows_stay_waiting_for_input() {
        let row = SessionRow::new(
            "s8",
            "Waiting row",
            SessionState::WaitingForInput,
            Confidence::Exact,
        )
        .with_reason("waiting for user input")
        .with_last_activity("2026-06-08T07:20:00.000Z");
        let acknowledged_at_ms = 1_780_000_000_000;
        let acknowledged = HashSet::from([super::AcknowledgedSignal::from_row_at(&row, acknowledged_at_ms)]);

        let confirmed_row = super::apply_acknowledged_session_state(
            row,
            &acknowledged,
            acknowledged_at_ms + 29 * 60 * 1000,
        );

        assert_eq!(confirmed_row.state, SessionState::WaitingForInput);
        assert_eq!(confirmed_row.status_reason, "waiting for user input");
        assert!(!confirmed_row.handled);
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
