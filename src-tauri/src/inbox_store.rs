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

#[derive(Debug)]
pub struct InboxStore {
    dismissed_session_ids: Mutex<HashSet<String>>,
    pinned_session_ids: Mutex<HashSet<String>>,
    acknowledged_signals: Mutex<HashSet<AcknowledgedSignal>>,
    session_rows_cache: Mutex<Option<CachedSessionRows>>,
    dismissed_sessions_path: PathBuf,
}

impl Default for InboxStore {
    fn default() -> Self {
        Self {
            dismissed_session_ids: Mutex::new(HashSet::new()),
            pinned_session_ids: Mutex::new(HashSet::new()),
            acknowledged_signals: Mutex::new(HashSet::new()),
            session_rows_cache: Mutex::new(None),
            dismissed_sessions_path: dismissed_sessions_path(),
        }
    }
}

impl InboxStore {
    #[cfg(test)]
    fn with_dismissed_sessions_path(dismissed_sessions_path: PathBuf) -> Self {
        Self {
            dismissed_session_ids: Mutex::new(HashSet::new()),
            pinned_session_ids: Mutex::new(HashSet::new()),
            acknowledged_signals: Mutex::new(HashSet::new()),
            session_rows_cache: Mutex::new(None),
            dismissed_sessions_path,
        }
    }
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
        self.refresh_persisted_pinned_session_ids();
        self.refresh_persisted_dismissed_session_ids();
        let dismissed_session_ids = self
            .dismissed_session_ids
            .lock()
            .expect("dismissed session store lock poisoned")
            .clone();
        let pinned_session_ids = self
            .pinned_session_ids
            .lock()
            .expect("pinned session store lock poisoned")
            .clone();
        let acknowledged_signals = self
            .acknowledged_signals
            .lock()
            .expect("acknowledged signal store lock poisoned")
            .clone();
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
                    &pinned_session_ids,
                    now_ms,
                )
            })
            .collect::<Vec<_>>();
        self.restore_running_dismissed_session_ids(&rows, &dismissed_session_ids);
        rows.sort_by(compare_session_rows_for_store);
        rows.truncate(80);
        rows
    }

    pub fn dismiss_session(&self, session_id: &str) -> Vec<SessionRow> {
        self.dismiss_sessions(&[session_id.to_string()])
    }

    pub fn dismiss_sessions(&self, session_ids: &[String]) -> Vec<SessionRow> {
        let mut dismissed_session_ids = self
            .dismissed_session_ids
            .lock()
            .expect("dismissed session store lock poisoned");
        dismissed_session_ids.extend(session_ids.iter().cloned());
        let _ = save_dismissed_session_ids(&self.dismissed_sessions_path, &dismissed_session_ids);
        drop(dismissed_session_ids);

        let mut pinned_session_ids = self
            .pinned_session_ids
            .lock()
            .expect("pinned session store lock poisoned");
        for session_id in session_ids {
            pinned_session_ids.remove(session_id);
        }
        let _ = save_pinned_session_ids(&pinned_session_ids_path(), &pinned_session_ids);
        drop(pinned_session_ids);
        self.invalidate_session_rows_cache();

        self.list_sessions()
    }

    pub fn restore_session(&self, session_id: &str) -> Vec<SessionRow> {
        let mut dismissed_session_ids = self
            .dismissed_session_ids
            .lock()
            .expect("dismissed session store lock poisoned");
        dismissed_session_ids.remove(session_id);
        let _ = save_dismissed_session_ids(&self.dismissed_sessions_path, &dismissed_session_ids);
        drop(dismissed_session_ids);
        self.invalidate_session_rows_cache();

        self.list_sessions()
    }

    pub fn pin_session(&self, session_id: &str) -> Vec<SessionRow> {
        let mut pinned_session_ids = self
            .pinned_session_ids
            .lock()
            .expect("pinned session store lock poisoned");
        pinned_session_ids.insert(session_id.to_string());
        let _ = save_pinned_session_ids(&pinned_session_ids_path(), &pinned_session_ids);
        drop(pinned_session_ids);
        self.invalidate_session_rows_cache();

        self.list_sessions()
    }

    pub fn unpin_session(&self, session_id: &str) -> Vec<SessionRow> {
        let mut pinned_session_ids = self
            .pinned_session_ids
            .lock()
            .expect("pinned session store lock poisoned");
        pinned_session_ids.remove(session_id);
        let _ = save_pinned_session_ids(&pinned_session_ids_path(), &pinned_session_ids);
        drop(pinned_session_ids);
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

    pub fn jump_to_session(
        &self,
        session_id: &str,
        acknowledged_session_ids: Option<&[String]>,
    ) -> JumpResult {
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
                self.acknowledge_session_signals(row, acknowledged_session_ids);
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

    fn acknowledge_session_signals(
        &self,
        row: &SessionRow,
        acknowledged_session_ids: Option<&[String]>,
    ) {
        let mut acknowledged_signals = self
            .acknowledged_signals
            .lock()
            .expect("acknowledged signal store lock poisoned");
        let acknowledged_at_ms = current_time_millis();
        acknowledged_signals.replace(AcknowledgedSignal::from_row_at(row, acknowledged_at_ms));
        if let Some(session_ids) = acknowledged_session_ids {
            for session_id in session_ids {
                if session_id == &row.session_id {
                    continue;
                }
                let Some(row) = self.fast_session_row_for_jump(session_id) else {
                    continue;
                };
                acknowledged_signals.replace(AcknowledgedSignal::from_row_at(&row, acknowledged_at_ms));
            }
        }
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
        let pinned_session_ids = self
            .pinned_session_ids
            .lock()
            .expect("pinned session store lock poisoned");

        Some(apply_pinned_session_state(
            row.with_jump_availability(jump_availability),
            &pinned_session_ids,
        ))
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

    fn refresh_persisted_pinned_session_ids(&self) {
        let loaded = load_pinned_session_ids(&pinned_session_ids_path());
        if loaded.is_empty() {
            return;
        }

        let mut pinned_session_ids = self
            .pinned_session_ids
            .lock()
            .expect("pinned session store lock poisoned");
        pinned_session_ids.extend(loaded);
    }

    fn refresh_persisted_dismissed_session_ids(&self) {
        let loaded = load_dismissed_session_ids(&self.dismissed_sessions_path);
        if loaded.is_empty() {
            return;
        }

        let mut dismissed_session_ids = self
            .dismissed_session_ids
            .lock()
            .expect("dismissed session store lock poisoned");
        dismissed_session_ids.extend(loaded);
    }

    fn restore_running_dismissed_session_ids(
        &self,
        rows: &[SessionRow],
        dismissed_session_ids: &HashSet<String>,
    ) {
        let running_dismissed_ids = rows
            .iter()
            .filter(|row| row.state == SessionState::Running && dismissed_session_ids.contains(&row.session_id))
            .map(|row| row.session_id.clone())
            .collect::<Vec<_>>();
        if running_dismissed_ids.is_empty() {
            return;
        }

        let mut dismissed_session_ids = self
            .dismissed_session_ids
            .lock()
            .expect("dismissed session store lock poisoned");
        for session_id in running_dismissed_ids {
            dismissed_session_ids.remove(&session_id);
        }
        let _ = save_dismissed_session_ids(&self.dismissed_sessions_path, &dismissed_session_ids);
    }
}

fn finalize_session_row(
    row: SessionRow,
    acknowledged_signals: &HashSet<AcknowledgedSignal>,
    dismissed_session_ids: &HashSet<String>,
    pinned_session_ids: &HashSet<String>,
    now_ms: u64,
) -> SessionRow {
    let dismissability = evaluate_dismissability(&row);
    let jump_availability = jump_availability_for_row(&row);
    let row = row
        .with_dismissability_reason(Some(dismissability.reason))
        .with_jump_availability(jump_availability);
    let row = apply_pinned_session_state(row, pinned_session_ids);
    let row = if row.pinned {
        row
    } else {
        apply_acknowledged_session_state(row, acknowledged_signals, now_ms)
    };
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
        SessionState::Running => 2,
        SessionState::NeedsAttention => 3,
        SessionState::Stopped => 4,
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

fn load_pinned_session_ids(path: &std::path::Path) -> HashSet<String> {
    load_session_id_set(path)
}

fn load_dismissed_session_ids(path: &std::path::Path) -> HashSet<String> {
    load_session_id_set(path)
}

fn load_session_id_set(path: &std::path::Path) -> HashSet<String> {
    let Ok(content) = fs::read_to_string(path) else {
        return HashSet::new();
    };

    serde_json::from_str(&content).unwrap_or_default()
}

fn save_pinned_session_ids(
    path: &std::path::Path,
    session_ids: &HashSet<String>,
) -> Result<(), std::io::Error> {
    save_session_id_set(path, session_ids)
}

fn save_dismissed_session_ids(
    path: &std::path::Path,
    session_ids: &HashSet<String>,
) -> Result<(), std::io::Error> {
    save_session_id_set(path, session_ids)
}

fn save_session_id_set(
    path: &std::path::Path,
    session_ids: &HashSet<String>,
) -> Result<(), std::io::Error> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }

    let content = serde_json::to_string_pretty(session_ids)
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

fn apply_pinned_session_state(
    row: SessionRow,
    pinned_session_ids: &HashSet<String>,
) -> SessionRow {
    if !pinned_session_ids.contains(&row.session_id) {
        return row;
    }

    SessionRow {
        pinned: true,
        dismissed: false,
        ..row
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
    let app_thread_ids = find_live_codex_app_thread_ids();
    build_jump_command_plan_with_runtime_signals(
        row,
        &live_sessions,
        &app_thread_ids,
        find_previous_iterm_tty_for_workspace,
    )
}

#[cfg(test)]
fn build_jump_command_plan_with_live_sessions(
    row: &SessionRow,
    live_sessions: &[LiveCliSession],
    previous_iterm_tty_for_workspace: impl FnOnce(&str) -> Option<String>,
) -> Option<JumpCommandPlan> {
    build_jump_command_plan_with_runtime_signals(
        row,
        live_sessions,
        &HashSet::new(),
        previous_iterm_tty_for_workspace,
    )
}

fn build_jump_command_plan_with_runtime_signals(
    row: &SessionRow,
    live_sessions: &[LiveCliSession],
    app_thread_ids: &HashSet<String>,
    previous_iterm_tty_for_workspace: impl FnOnce(&str) -> Option<String>,
) -> Option<JumpCommandPlan> {
    let Some(workspace_path) = row.workspace_path.as_deref() else {
        return build_jump_command_plan_with_cli_context(row, None, None);
    };
    let exact_live_tty = live_cli_exact_tty_for_jump_plan(row, live_sessions);
    if let Some(tty) = exact_live_tty {
        return Some(JumpCommandPlan::ITermActivate {
            tty,
            live_codex: true,
        });
    }

    if app_thread_ids.contains(&row.session_id) {
        return Some(codex_desktop_jump_command_plan(row, workspace_path));
    }

    let live_tty = live_cli_workspace_tty_for_jump_plan(row, live_sessions);
    let resume_tty = if live_tty.is_none() && matches!(row.jump_target, JumpTarget::Cli) {
        previous_iterm_tty_for_workspace(workspace_path)
    } else {
        None
    };

    build_jump_command_plan_with_cli_context(row, live_tty, resume_tty)
}

fn live_cli_exact_tty_for_jump_plan(
    row: &SessionRow,
    live_sessions: &[LiveCliSession],
) -> Option<String> {
    if !matches!(row.jump_target, JumpTarget::Cli) {
        return None;
    }

    live_sessions
        .iter()
        .find(|session| live_session_has_session_id(session, &row.session_id))
        .map(|session| session.tty.clone())
}

fn live_cli_workspace_tty_for_jump_plan(
    row: &SessionRow,
    live_sessions: &[LiveCliSession],
) -> Option<String> {
    if !matches!(row.jump_target, JumpTarget::Cli) {
        return None;
    }

    let workspace_path = row.workspace_path.as_deref()?;
    live_sessions
        .iter()
        .find(|session| session.session_id.is_none() && session.workspace_path == workspace_path)
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
        JumpTarget::Desktop | JumpTarget::Unknown => {
            Some(codex_desktop_jump_command_plan(row, &workspace_path))
        }
        JumpTarget::Cli => Some(JumpCommandPlan::ITermResume {
            thread_id: row.session_id.clone(),
            workspace_path,
            tty: resume_tty,
        }),
    }
}

fn codex_desktop_jump_command_plan(row: &SessionRow, workspace_path: &str) -> JumpCommandPlan {
    JumpCommandPlan::CodexDesktop {
        thread_id: row.session_id.clone(),
        deeplink_url: codex_thread_deeplink(&row.session_id),
        workspace_path: workspace_path.to_string(),
        activate_bundle_id: codex_bundle_id().to_string(),
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

fn find_live_codex_app_thread_ids() -> HashSet<String> {
    let output = match Command::new("ps").args(["-axo", "pid=,comm=,args="]).output() {
        Ok(output) => output,
        Err(_) => return HashSet::new(),
    };
    let stdout = String::from_utf8_lossy(&output.stdout);

    stdout
        .lines()
        .filter_map(parse_codex_app_server_process_line)
        .flat_map(live_cli_session_ids_from_open_files)
        .collect()
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

fn parse_codex_app_server_process_line(line: &str) -> Option<&str> {
    let mut parts = line.split_whitespace();
    let pid = parts.next()?;
    let _comm = parts.next()?;
    let args_start = line.find(_comm)? + _comm.len();
    let args = line[args_start..].trim();

    is_codex_app_server_args(args).then_some(pid)
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

fn is_codex_app_server_args(args: &str) -> bool {
    let parts = args.split_whitespace().collect::<Vec<_>>();
    let Some(executable) = parts.first() else {
        return false;
    };

    executable.rsplit('/').next().unwrap_or(executable) == "codex"
        && parts.get(1) == Some(&"app-server")
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
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    codex_state_db_path_from_home(&home)
}

fn codex_state_db_path_from_home(home: &std::path::Path) -> PathBuf {
    let current_path = home
        .join(".codex")
        .join("sqlite")
        .join("state_5.sqlite");
    let legacy_path = home.join(".codex").join("state_5.sqlite");
    let current_exists = current_path.exists();
    let legacy_exists = legacy_path.exists();
    if current_exists && legacy_exists {
        if codex_state_db_modified_at(&legacy_path) > codex_state_db_modified_at(&current_path) {
            return legacy_path;
        }
        return current_path;
    }
    if current_exists {
        return current_path;
    }
    if legacy_exists {
        return legacy_path;
    }

    legacy_path
}

fn codex_state_db_modified_at(path: &std::path::Path) -> SystemTime {
    fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .unwrap_or(SystemTime::UNIX_EPOCH)
}

fn acknowledged_signals_path() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".codex")
        .join("agent-session-inbox")
        .join("acknowledged-signals.json")
}

fn pinned_session_ids_path() -> PathBuf {
    agent_session_inbox_state_path("pinned-sessions.json")
}

fn dismissed_sessions_path() -> PathBuf {
    agent_session_inbox_state_path("dismissed-sessions.json")
}

fn agent_session_inbox_state_path(file_name: &str) -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".codex")
        .join("agent-session-inbox")
        .join(file_name)
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
        let temp = tempfile::tempdir().expect("temp dir");
        let store = InboxStore::with_dismissed_sessions_path(temp.path().join("dismissed-sessions.json"));

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
    fn dismiss_sessions_records_every_group_member() {
        let temp = tempfile::tempdir().expect("temp dir");
        let store = InboxStore::with_dismissed_sessions_path(temp.path().join("dismissed-sessions.json"));

        let _ = store.dismiss_sessions(&["parent".to_string(), "child".to_string()]);
        let dismissed_session_ids = store
            .dismissed_session_ids
            .lock()
            .expect("dismissed session ids");

        assert!(dismissed_session_ids.contains("parent"));
        assert!(dismissed_session_ids.contains("child"));
    }

    #[test]
    fn jump_reports_unavailable_for_unknown_rows() {
        let store = InboxStore::default();

        let result = store.jump_to_session("missing", None);

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
    fn desktop_jump_plan_ignores_live_cli_from_same_workspace() {
        let row = SessionRow::new("s1", "Desktop row", SessionState::Running, Confidence::Exact)
            .with_workspace(Some("/Users/edy/project-a".to_string()))
            .with_jump_availability(JumpAvailability::Exact)
            .with_jump_target(JumpTarget::Desktop);
        let live_sessions = vec![super::LiveCliSession {
            session_id: Some("other-session".to_string()),
            session_ids: vec!["other-session".to_string()],
            workspace_path: "/Users/edy/project-a".to_string(),
            tty: "ttys009".to_string(),
        }];

        let plan = super::build_jump_command_plan_with_live_sessions(
            &row,
            &live_sessions,
            |_| None,
        );

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
    fn cli_session_open_in_codex_app_builds_desktop_jump_plan() {
        let row = SessionRow::new(
            "019e8c3e-f343-78d2-a7be-90f318bf303c",
            "CLI row continued in app",
            SessionState::Running,
            Confidence::Exact,
        )
        .with_workspace(Some("/Users/edy/project-b".to_string()))
        .with_jump_availability(JumpAvailability::Approximate)
        .with_jump_target(JumpTarget::Cli);
        let app_thread_ids = HashSet::from(["019e8c3e-f343-78d2-a7be-90f318bf303c".to_string()]);

        let plan = super::build_jump_command_plan_with_runtime_signals(
            &row,
            &[],
            &app_thread_ids,
            |_| Some("ttys002".to_string()),
        );

        assert_eq!(
            plan,
            Some(super::JumpCommandPlan::CodexDesktop {
                thread_id: "019e8c3e-f343-78d2-a7be-90f318bf303c".to_string(),
                workspace_path: "/Users/edy/project-b".to_string(),
                deeplink_url: "codex://threads/019e8c3e-f343-78d2-a7be-90f318bf303c".to_string(),
                activate_bundle_id: "com.openai.codex".to_string()
            })
        );
    }

    #[test]
    fn matching_live_cli_session_takes_precedence_over_codex_app_signal() {
        let row = SessionRow::new(
            "019e8c3e-f343-78d2-a7be-90f318bf303c",
            "CLI row still live",
            SessionState::Running,
            Confidence::Exact,
        )
        .with_workspace(Some("/Users/edy/project-b".to_string()))
        .with_jump_availability(JumpAvailability::Approximate)
        .with_jump_target(JumpTarget::Cli);
        let live_sessions = vec![super::LiveCliSession {
            session_id: Some("019e8c3e-f343-78d2-a7be-90f318bf303c".to_string()),
            session_ids: vec!["019e8c3e-f343-78d2-a7be-90f318bf303c".to_string()],
            workspace_path: "/Users/edy/project-b".to_string(),
            tty: "ttys008".to_string(),
        }];
        let app_thread_ids = HashSet::from(["019e8c3e-f343-78d2-a7be-90f318bf303c".to_string()]);

        let plan = super::build_jump_command_plan_with_runtime_signals(
            &row,
            &live_sessions,
            &app_thread_ids,
            |_| Some("ttys002".to_string()),
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
    fn parse_codex_app_server_process_line_only_accepts_app_server() {
        let app_server_line =
            "59618 /Applications/Co /Applications/Codex.app/Contents/Resources/codex app-server --analytics-default-enabled";
        let cli_resume_line =
            "29457 /Applications/Co /Applications/Codex.app/Contents/Resources/codex resume 019e9153-943a-7402-8e61-9e89cee5a6f4 --cd /Users/edy/project";
        let helper_line =
            "4576 /Users/edy/.code /Users/edy/.codex/computer-use/Codex Computer Use.app/Contents/MacOS/SkyComputerUseClient turn-ended";

        assert_eq!(
            super::parse_codex_app_server_process_line(app_server_line),
            Some("59618")
        );
        assert!(super::parse_codex_app_server_process_line(cli_resume_line).is_none());
        assert!(super::parse_codex_app_server_process_line(helper_line).is_none());
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
    fn pinned_rows_are_marked_on_finalize_without_changing_source_state() {
        let acknowledged_signals = HashSet::new();
        let dismissed_session_ids = HashSet::new();
        let pinned_session_ids = HashSet::from(["s9".to_string()]);

        let row = super::finalize_session_row(
            SessionRow::new("s9", "Pinned inspect", SessionState::Inspect, Confidence::Exact)
                .with_workspace(Some("/repo".to_string()))
                .with_jump_target(JumpTarget::Desktop),
            &acknowledged_signals,
            &dismissed_session_ids,
            &pinned_session_ids,
            1_780_000_000_000,
        );

        assert_eq!(row.state, SessionState::Inspect);
        assert!(row.pinned);
        assert!(!row.dismissed);
    }

    #[test]
    fn pinned_rows_ignore_acknowledged_signals_until_unpinned() {
        let row = SessionRow::new("s13", "Pinned inspect", SessionState::Inspect, Confidence::Exact)
            .with_last_activity("2026-06-04T04:00:00.000Z");
        let acknowledged_at_ms = 1_780_000_000_000;
        let acknowledged_signals = HashSet::from([super::AcknowledgedSignal::from_row_at(
            &row,
            acknowledged_at_ms,
        )]);
        let dismissed_session_ids = HashSet::new();
        let pinned_session_ids = HashSet::from(["s13".to_string()]);

        let row = super::finalize_session_row(
            row,
            &acknowledged_signals,
            &dismissed_session_ids,
            &pinned_session_ids,
            acknowledged_at_ms + 29 * 60 * 1000,
        );

        assert_eq!(row.state, SessionState::Inspect);
        assert!(!row.handled);
        assert!(row.pinned);
    }

    #[test]
    fn dismissed_rows_clear_pinned_state() {
        let dismissed_session_ids = HashSet::from(["s10".to_string()]);
        let pinned_session_ids = HashSet::from(["s10".to_string()]);
        let row = SessionRow::new("s10", "Pinned inspect", SessionState::Inspect, Confidence::Exact);

        let row = super::apply_pinned_session_state(row, &pinned_session_ids);
        let row = super::apply_dismissed_session_state(row, &dismissed_session_ids);

        assert!(row.dismissed);
        assert!(!row.pinned);
    }

    #[test]
    fn completed_threads_are_sorted_as_quiet_rows() {
        let acknowledged_signals = HashSet::new();
        let dismissed_session_ids = HashSet::new();
        let pinned_session_ids = HashSet::new();
        let mut rows = vec![
            SessionRow::new("idle", "Completed", SessionState::Idle, Confidence::Inferred)
                .with_workspace(Some("/repo".to_string()))
                .with_jump_target(JumpTarget::Desktop)
                .with_reason("completed task observed; idle until the next source signal")
                .with_last_activity("2026-06-06T04:00:00.000Z"),
            SessionRow::new("running", "Active", SessionState::Running, Confidence::Exact)
                .with_workspace(Some("/repo".to_string()))
                .with_jump_target(JumpTarget::Desktop)
                .with_reason("running signal observed")
                .with_last_activity("2026-06-06T04:01:00.000Z"),
            SessionRow::new("needed", "Follow-up", SessionState::NeedsAttention, Confidence::Exact)
                .with_workspace(Some("/repo".to_string()))
                .with_jump_target(JumpTarget::Desktop)
                .with_reason("Read recently; keep in needed state until 30 minutes pass.")
                .with_last_activity("2026-06-06T04:03:00.000Z"),
            SessionRow::new("stopped", "Stopped", SessionState::Stopped, Confidence::Exact)
                .with_workspace(Some("/repo".to_string()))
                .with_jump_target(JumpTarget::Desktop)
                .with_reason("stopped before completion; decide whether to continue, inspect, or dismiss")
                .with_last_activity("2026-06-06T04:04:00.000Z"),
            SessionRow::new("inspect", "Inspect", SessionState::Inspect, Confidence::Exact)
                .with_workspace(Some("/repo".to_string()))
                .with_jump_target(JumpTarget::Desktop)
                .with_reason("completed task ready to inspect; open it to mark read")
                .with_last_activity("2026-06-06T04:02:00.000Z"),
        ]
        .into_iter()
        .map(|row| {
            super::finalize_session_row(
                row,
                &acknowledged_signals,
                &dismissed_session_ids,
                &pinned_session_ids,
                1_780_000_000_000,
            )
        })
        .collect::<Vec<_>>();

        rows.sort_by(super::compare_session_rows_for_store);

        assert_eq!(
            rows.iter()
                .map(|row| row.session_id.as_str())
                .collect::<Vec<_>>(),
            ["inspect", "running", "needed", "stopped", "idle"]
        );
        let idle_row = rows
            .iter()
            .find(|row| row.session_id == "idle")
            .expect("idle row");
        assert_eq!(idle_row.state, SessionState::Idle);
        assert_eq!(idle_row.confidence, Confidence::Inferred);
        assert!(!idle_row.dismissed);
        assert_eq!(idle_row.jump_availability, JumpAvailability::Exact);
    }

    #[test]
    fn fresh_session_rows_cache_short_circuits_local_discovery() {
        let temp = tempfile::tempdir().expect("temp dir");
        let cached_row = SessionRow::new(
            "cached-session",
            "Cached session",
            SessionState::Idle,
            Confidence::Exact,
        );
        let store = InboxStore {
            dismissed_session_ids: std::sync::Mutex::new(HashSet::new()),
            pinned_session_ids: std::sync::Mutex::new(HashSet::new()),
            acknowledged_signals: std::sync::Mutex::new(HashSet::new()),
            session_rows_cache: std::sync::Mutex::new(Some(super::CachedSessionRows {
                rows: vec![cached_row.clone()],
                loaded_at: std::time::Instant::now(),
            })),
            dismissed_sessions_path: temp.path().join("dismissed-sessions.json"),
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
    fn batch_acknowledged_rows_become_needed_together() {
        let parent = SessionRow::new("parent", "Parent", SessionState::Inspect, Confidence::Exact)
            .with_last_activity("2026-06-04T04:00:00.000Z");
        let child = SessionRow::new("child", "Child", SessionState::Inspect, Confidence::Exact)
            .with_last_activity("2026-06-04T04:01:00.000Z");
        let acknowledged_at_ms = 1_780_000_000_000;
        let acknowledged = HashSet::from([
            super::AcknowledgedSignal::from_row_at(&parent, acknowledged_at_ms),
            super::AcknowledgedSignal::from_row_at(&child, acknowledged_at_ms),
        ]);

        let confirmed_parent = super::apply_acknowledged_session_state(
            parent,
            &acknowledged,
            acknowledged_at_ms + 5 * 60 * 1000,
        );
        let confirmed_child = super::apply_acknowledged_session_state(
            child,
            &acknowledged,
            acknowledged_at_ms + 5 * 60 * 1000,
        );

        assert_eq!(confirmed_parent.state, SessionState::NeedsAttention);
        assert_eq!(confirmed_child.state, SessionState::NeedsAttention);
        assert!(confirmed_parent.handled);
        assert!(confirmed_child.handled);
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
    fn default_state_db_path_prefers_newest_known_state_db() {
        let temp = tempfile::tempdir().expect("temp dir");
        let legacy_db = temp.path().join(".codex/state_5.sqlite");
        let current_db = temp.path().join(".codex/sqlite/state_5.sqlite");
        fs::create_dir_all(current_db.parent().expect("current db parent")).expect("current db dir");
        fs::create_dir_all(legacy_db.parent().expect("legacy db parent")).expect("legacy db dir");
        fs::write(&legacy_db, "").expect("legacy db");
        fs::write(&current_db, "").expect("current db");
        std::process::Command::new("touch")
            .args(["-t", "202606171800"])
            .arg(&legacy_db)
            .status()
            .expect("set legacy mtime");
        std::process::Command::new("touch")
            .args(["-t", "202606171500"])
            .arg(&current_db)
            .status()
            .expect("set current mtime");

        let selected = super::codex_state_db_path_from_home(temp.path());

        assert_eq!(selected, legacy_db);
    }

    #[test]
    fn default_state_db_path_keeps_current_sqlite_when_at_least_as_new() {
        let temp = tempfile::tempdir().expect("temp dir");
        let legacy_db = temp.path().join(".codex/state_5.sqlite");
        let current_db = temp.path().join(".codex/sqlite/state_5.sqlite");
        fs::create_dir_all(current_db.parent().expect("current db parent")).expect("current db dir");
        fs::create_dir_all(legacy_db.parent().expect("legacy db parent")).expect("legacy db dir");
        fs::write(&legacy_db, "").expect("legacy db");
        fs::write(&current_db, "").expect("current db");
        std::process::Command::new("touch")
            .args(["-t", "202606171500"])
            .arg(&legacy_db)
            .status()
            .expect("set legacy mtime");
        std::process::Command::new("touch")
            .args(["-t", "202606171800"])
            .arg(&current_db)
            .status()
            .expect("set current mtime");

        let selected = super::codex_state_db_path_from_home(temp.path());

        assert_eq!(selected, current_db);
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

    #[test]
    fn pinned_session_ids_round_trip_to_disk() {
        let temp = tempfile::tempdir().expect("temp dir");
        let path = temp.path().join("pinned-sessions.json");
        let session_ids = HashSet::from(["s11".to_string(), "s12".to_string()]);

        super::save_pinned_session_ids(&path, &session_ids).expect("save pinned sessions");
        let loaded = super::load_pinned_session_ids(&path);

        assert_eq!(loaded, session_ids);
        assert!(fs::read_to_string(path).expect("pinned file").contains("s11"));
    }

    #[test]
    fn dismissed_session_ids_round_trip_to_disk() {
        let temp = tempfile::tempdir().expect("temp dir");
        let path = temp.path().join("dismissed-sessions.json");
        let session_ids = HashSet::from(["parent".to_string(), "child".to_string()]);

        super::save_dismissed_session_ids(&path, &session_ids).expect("save dismissed sessions");
        let loaded = super::load_dismissed_session_ids(&path);

        assert_eq!(loaded, session_ids);
        assert!(fs::read_to_string(path).expect("dismissed file").contains("parent"));
    }
}
