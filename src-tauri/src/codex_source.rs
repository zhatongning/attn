use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::time::{Duration, SystemTime};

use serde_json::Value;

use crate::domain::session::{JumpTarget, ObservationKind, SourceObservation};

const UNREAD_COMPLETION_RETENTION: Duration = Duration::from_secs(12 * 60 * 60);
const SESSION_TAIL_READ_BYTES: u64 = 128 * 1024;
const SESSION_HEADER_READ_BYTES: usize = 32 * 1024;
const HOOK_ACTIVITY_FRESHNESS: Duration = Duration::from_secs(15 * 60);
const DEFAULT_FOLLOW_UP_WINDOW: Duration = Duration::from_secs(30 * 60);

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ObservationSnapshotSource {
    Sqlite { state_db_path: PathBuf },
    JsonlFallback { state_db_path: PathBuf, sqlite_error: String },
}

impl ObservationSnapshotSource {
    pub fn is_degraded(&self) -> bool {
        matches!(self, Self::JsonlFallback { .. })
    }

    pub fn sqlite_error(&self) -> Option<&str> {
        match self {
            Self::Sqlite { .. } => None,
            Self::JsonlFallback { sqlite_error, .. } => Some(sqlite_error),
        }
    }
}

#[derive(Debug, Clone)]
pub struct ObservationSnapshot {
    pub observations: Vec<SourceObservation>,
    pub source: ObservationSnapshotSource,
}

#[derive(Debug, Clone)]
struct SessionFileSummary {
    path: PathBuf,
    modified_at: Option<std::time::SystemTime>,
}

#[derive(Debug, Clone)]
struct ParsedSessionObservation {
    observation: SourceObservation,
    task_completed_at: Option<SystemTime>,
}

#[derive(Debug, Clone)]
struct SessionHeaderMetadata {
    session_id: String,
    parent_session_id: Option<String>,
    thread_source: Option<String>,
    workspace_path: Option<String>,
    agent_name: Option<String>,
    jump_target: Option<JumpTarget>,
}

#[derive(Debug, Clone)]
struct CodexHookSignal {
    event_name: String,
    timestamp: String,
    timestamp_time: SystemTime,
    session_id: Option<String>,
    workspace_path: Option<String>,
}

#[derive(Debug, Clone)]
struct PendingToolApproval {
    call_id: Option<String>,
    timestamp: Option<String>,
    evidence_summary: String,
}

#[derive(Debug, Clone)]
struct PendingStructuredUserInput {
    call_id: Option<String>,
    timestamp: Option<String>,
    evidence_summary: String,
}

pub fn discover_codex_observations(sessions_root: &Path, limit: usize) -> Vec<SourceObservation> {
    let state_db = codex_state_db_path();
    if state_db.exists() {
        discover_codex_observations_with_state_db(&state_db, sessions_root, limit, SystemTime::now())
    } else {
        discover_codex_observations_with_now(sessions_root, limit, SystemTime::now())
    }
}

pub fn discover_codex_observations_with_state_db(
    state_db: &Path,
    sessions_root: &Path,
    limit: usize,
    now: SystemTime,
) -> Vec<SourceObservation> {
    discover_codex_observations_with_state_db_and_follow_up_window(
        state_db,
        sessions_root,
        limit,
        now,
        DEFAULT_FOLLOW_UP_WINDOW,
    )
}

pub fn discover_codex_observations_with_state_db_and_follow_up_window(
    state_db: &Path,
    sessions_root: &Path,
    limit: usize,
    now: SystemTime,
    follow_up_window: Duration,
) -> Vec<SourceObservation> {
    discover_codex_observation_snapshot_with_state_db_and_follow_up_window(
        state_db,
        sessions_root,
        limit,
        now,
        follow_up_window,
    )
    .observations
}

pub fn discover_codex_observation_snapshot_with_state_db_and_follow_up_window(
    state_db: &Path,
    sessions_root: &Path,
    limit: usize,
    now: SystemTime,
    follow_up_window: Duration,
) -> ObservationSnapshot {
    discover_codex_observation_snapshot_with_state_db_and_hooks_and_follow_up_window(
        state_db,
        sessions_root,
        &codex_hook_events_path(),
        limit,
        now,
        follow_up_window,
    )
}

pub fn discover_codex_observations_with_state_db_and_hooks(
    state_db: &Path,
    sessions_root: &Path,
    hook_events_path: &Path,
    limit: usize,
    now: SystemTime,
) -> Vec<SourceObservation> {
    discover_codex_observation_snapshot_with_state_db_and_hooks_and_follow_up_window(
        state_db,
        sessions_root,
        hook_events_path,
        limit,
        now,
        DEFAULT_FOLLOW_UP_WINDOW,
    )
    .observations
}

fn discover_codex_observation_snapshot_with_state_db_and_hooks_and_follow_up_window(
    state_db: &Path,
    sessions_root: &Path,
    hook_events_path: &Path,
    limit: usize,
    now: SystemTime,
    follow_up_window: Duration,
) -> ObservationSnapshot {
    let threads = match discover_threads_from_state_db(state_db) {
        Ok(threads) => threads,
        Err(sqlite_error) => {
            return ObservationSnapshot {
                observations: discover_codex_observations_with_now(sessions_root, limit, now),
                source: ObservationSnapshotSource::JsonlFallback {
                    state_db_path: state_db.to_path_buf(),
                    sqlite_error,
                },
            };
        }
    };

    let hook_signals = load_latest_hook_signals(hook_events_path);

    ObservationSnapshot {
        observations: threads
            .into_iter()
            .filter_map(|thread| {
                let hook_signal = hook_signal_for_thread(&hook_signals, &thread);
                observation_from_thread(thread, hook_signal, now, follow_up_window)
            })
            .filter(|observation| !is_subagent_observation(observation))
            .take(limit)
            .collect(),
        source: ObservationSnapshotSource::Sqlite {
            state_db_path: state_db.to_path_buf(),
        },
    }
}

pub fn discover_codex_observation_by_id(
    state_db: &Path,
    session_id: &str,
    now: SystemTime,
) -> Option<SourceObservation> {
    discover_codex_observation_by_id_and_follow_up_window(
        state_db,
        session_id,
        now,
        DEFAULT_FOLLOW_UP_WINDOW,
    )
}

pub fn discover_codex_observation_by_id_and_follow_up_window(
    state_db: &Path,
    session_id: &str,
    now: SystemTime,
    follow_up_window: Duration,
) -> Option<SourceObservation> {
    let thread = discover_thread_from_state_db_by_id(state_db, session_id)?;
    let hook_signals = load_latest_hook_signals(&codex_hook_events_path());
    let hook_signal = hook_signal_for_thread(&hook_signals, &thread);
    observation_from_thread(thread, hook_signal, now, follow_up_window)
}

pub fn discover_codex_observations_with_now(
    sessions_root: &Path,
    limit: usize,
    now: SystemTime,
) -> Vec<SourceObservation> {
    let mut summaries = Vec::new();
    collect_session_files(sessions_root, &mut summaries);

    summaries.sort_by(|left, right| right.modified_at.cmp(&left.modified_at));

    let mut observed_session_ids = HashSet::new();

    summaries
        .into_iter()
        .filter_map(|summary| parse_session_file(&summary.path, now).ok().flatten())
        .filter(|observation| observed_session_ids.insert(observation.session_id.clone()))
        .filter(|observation| !is_subagent_observation(observation))
        .take(limit)
        .collect()
}

fn is_subagent_observation(observation: &SourceObservation) -> bool {
    is_subagent_thread_source(observation.thread_source.as_deref())
        || observation.parent_session_id.is_some()
}

fn is_subagent_thread_source(thread_source: Option<&str>) -> bool {
    thread_source.is_some_and(|source| source.eq_ignore_ascii_case("subagent"))
}

fn effective_thread_source(
    primary_thread_source: Option<String>,
    secondary_thread_source: Option<String>,
) -> Option<String> {
    if is_subagent_thread_source(primary_thread_source.as_deref())
        || is_subagent_thread_source(secondary_thread_source.as_deref())
    {
        Some("subagent".to_string())
    } else {
        primary_thread_source.or(secondary_thread_source)
    }
}

fn collect_session_files(dir: &Path, summaries: &mut Vec<SessionFileSummary>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_session_files(&path, summaries);
            continue;
        }

        if path.extension().and_then(|value| value.to_str()) != Some("jsonl") {
            continue;
        }

        let modified_at = entry
            .metadata()
            .and_then(|metadata| metadata.modified())
            .ok();
        summaries.push(SessionFileSummary { path, modified_at });
    }
}

fn parse_session_file(
    path: &Path,
    now: SystemTime,
) -> Result<Option<SourceObservation>, std::io::Error> {
    parse_session_file_detailed(path, now).map(|parsed| parsed.map(|parsed| parsed.observation))
}

fn parse_session_file_detailed(
    path: &Path,
    now: SystemTime,
) -> Result<Option<ParsedSessionObservation>, std::io::Error> {
    let content = fs::read_to_string(path)?;
    parse_session_content(path, &content, now)
}

fn parse_session_file_tail_detailed(
    path: &Path,
    now: SystemTime,
) -> Result<Option<ParsedSessionObservation>, std::io::Error> {
    let file_len = fs::metadata(path)?.len();
    let content = read_file_tail(path, SESSION_TAIL_READ_BYTES)?;
    let parsed = parse_session_content(path, &content, now)?;
    if file_len <= SESSION_TAIL_READ_BYTES {
        return Ok(parsed);
    }

    let header_metadata = parse_session_header_metadata(path)?;
    Ok(parsed.map(|parsed| merge_session_header_metadata(parsed, header_metadata)))
}

fn parse_session_header_metadata(
    path: &Path,
) -> Result<Option<SessionHeaderMetadata>, std::io::Error> {
    let content = read_file_head(path, SESSION_HEADER_READ_BYTES)?;
    let expected_session_id =
        session_id_from_path(path).filter(|value| looks_like_codex_session_id(value));

    for line in content.lines() {
        if !line.contains("\"type\":\"session_meta\"")
            && !line.contains("\"type\": \"session_meta\"")
        {
            continue;
        }

        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let Some(payload) = value.get("payload") else {
            continue;
        };
        let Some(metadata_session_id) = payload
            .get("id")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
        else {
            continue;
        };
        if expected_session_id
            .as_deref()
            .is_some_and(|session_id| session_id != metadata_session_id)
        {
            continue;
        }

        return Ok(Some(SessionHeaderMetadata {
            session_id: metadata_session_id.to_string(),
            parent_session_id: parent_thread_id_from_session_meta(payload),
            thread_source: payload
                .get("thread_source")
                .and_then(Value::as_str)
                .or_else(|| value.get("thread_source").and_then(Value::as_str))
                .filter(|value| !value.is_empty())
                .map(ToString::to_string),
            workspace_path: payload
                .get("cwd")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .map(ToString::to_string),
            agent_name: payload
                .get("agent_nickname")
                .and_then(Value::as_str)
                .or_else(|| payload.get("originator").and_then(Value::as_str))
                .filter(|value| !value.is_empty())
                .map(ToString::to_string),
            jump_target: jump_target_from_session_meta(payload),
        }));
    }

    Ok(None)
}

fn read_file_head(path: &Path, max_bytes: usize) -> Result<String, std::io::Error> {
    let mut file = fs::File::open(path)?;
    let mut bytes = Vec::with_capacity(max_bytes);
    file.by_ref()
        .take(max_bytes as u64)
        .read_to_end(&mut bytes)?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

fn merge_session_header_metadata(
    mut parsed: ParsedSessionObservation,
    header_metadata: Option<SessionHeaderMetadata>,
) -> ParsedSessionObservation {
    let Some(header_metadata) = header_metadata else {
        return parsed;
    };
    if parsed.observation.session_id != header_metadata.session_id {
        return parsed;
    }

    parsed.observation.thread_source = effective_thread_source(
        parsed.observation.thread_source.take(),
        header_metadata.thread_source,
    );
    parsed.observation.parent_session_id = parsed
        .observation
        .parent_session_id
        .take()
        .or(header_metadata.parent_session_id);
    parsed.observation.workspace_path = parsed
        .observation
        .workspace_path
        .take()
        .or(header_metadata.workspace_path);
    parsed.observation.agent_name = parsed
        .observation
        .agent_name
        .take()
        .or(header_metadata.agent_name);
    if matches!(parsed.observation.jump_target, JumpTarget::Unknown) {
        parsed.observation.jump_target = header_metadata.jump_target.unwrap_or(JumpTarget::Unknown);
    }

    parsed
}

fn read_file_tail(path: &Path, max_bytes: u64) -> Result<String, std::io::Error> {
    let mut file = fs::File::open(path)?;
    let file_len = file.metadata()?.len();
    let start = file_len.saturating_sub(max_bytes);
    file.seek(SeekFrom::Start(start))?;

    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)?;

    if start > 0 {
        if let Some(first_line_end) = bytes.iter().position(|byte| *byte == b'\n') {
            bytes.drain(..=first_line_end);
        }
    }

    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

fn parse_session_content(
    path: &Path,
    content: &str,
    now: SystemTime,
) -> Result<Option<ParsedSessionObservation>, std::io::Error> {
    // Rollout files can embed metadata for a parent session. The rollout filename
    // identifies the session whose events this file belongs to, so keep that identity
    // and ignore foreign session metadata.
    let mut session_id = session_id_from_path(path).filter(|value| looks_like_codex_session_id(value));
    let mut parent_session_id = None;
    let mut thread_source = None;
    let mut cwd = None;
    let mut agent_name = None;
    let mut session_name = None;
    let mut jump_target = JumpTarget::Unknown;
    let mut latest_timestamp = None;
    let mut task_completed_at = None;
    let mut last_activity_kind = ObservationKind::InsufficientEvidence;
    let mut last_agent_message = None;
    let mut pending_tool_approval = None;
    let mut pending_structured_user_input = None;
    let mut external_import_session = false;

    for line in content
        .lines()
        .filter(|line| should_parse_session_status_line(line))
    {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };

        match value.get("type").and_then(Value::as_str) {
            Some("session_meta") => {
                if let Some(payload) = value.get("payload") {
                    let metadata_session_id = payload.get("id").and_then(Value::as_str);
                    let Some(metadata_session_id) = metadata_session_id.filter(|value| !value.is_empty()) else {
                        continue;
                    };
                    if session_id
                        .as_deref()
                        .is_some_and(|session_id| session_id != metadata_session_id)
                    {
                        continue;
                    }

                    session_id = Some(metadata_session_id.to_string());
                    parent_session_id =
                        parent_thread_id_from_session_meta(payload).or(parent_session_id);
                    thread_source = payload
                        .get("thread_source")
                        .and_then(Value::as_str)
                        .or_else(|| value.get("thread_source").and_then(Value::as_str))
                        .filter(|value| !value.is_empty())
                        .map(ToString::to_string)
                        .or(thread_source);
                    cwd = payload
                        .get("cwd")
                        .and_then(Value::as_str)
                        .map(ToString::to_string)
                        .or(cwd);
                    agent_name = payload
                        .get("agent_nickname")
                        .and_then(Value::as_str)
                        .or_else(|| payload.get("originator").and_then(Value::as_str))
                        .map(ToString::to_string)
                        .or(agent_name);
                    jump_target = jump_target_from_session_meta(payload).unwrap_or(jump_target);
                    if let Some(timestamp) = value.get("timestamp").and_then(Value::as_str) {
                        latest_timestamp = Some(timestamp.to_string());
                    }
                }
            }
            Some("event_msg") => {
                if let Some(timestamp) = value.get("timestamp").and_then(Value::as_str) {
                    latest_timestamp = Some(timestamp.to_string());
                }
                let event_type = value
                    .get("payload")
                    .and_then(|payload| payload.get("type"))
                    .and_then(Value::as_str);
                if value
                    .get("payload")
                    .and_then(|payload| payload.get("turn_id"))
                    .and_then(Value::as_str)
                    .is_some_and(|turn_id| turn_id.starts_with("external-import-turn-"))
                {
                    external_import_session = true;
                }

                if event_type == Some("task_complete") {
                    last_activity_kind = ObservationKind::Completed;
                    task_completed_at = value
                        .get("timestamp")
                        .and_then(Value::as_str)
                        .and_then(parse_utc_timestamp)
                        .or(task_completed_at);
                } else if event_type == Some("turn_aborted") {
                    pending_tool_approval = None;
                    pending_structured_user_input = None;
                    last_activity_kind = ObservationKind::Stopped;
                } else if matches!(event_type, Some("user_message" | "agent_message")) {
                    last_activity_kind = ObservationKind::Running;
                }

                if let Some(message) = value
                    .get("payload")
                    .and_then(|payload| payload.get("message"))
                    .and_then(Value::as_str)
                {
                    if message == "<EXTERNAL SESSION IMPORTED>" {
                        external_import_session = true;
                    }
                    if event_type == Some("user_message") && session_name.is_none() {
                        let trimmed = message.trim();
                        if !trimmed.is_empty() {
                            session_name = Some(truncate_for_summary(trimmed, 120));
                        }
                    } else {
                        last_agent_message = Some(message.to_string());
                    }
                }
            }
            Some("response_item") => {
                if let Some(timestamp) = value.get("timestamp").and_then(Value::as_str) {
                    latest_timestamp = Some(timestamp.to_string());
                }
                if let Some(approval) = pending_tool_approval_from_response_item(&value) {
                    last_activity_kind = ObservationKind::WaitingForInput;
                    pending_tool_approval = Some(approval);
                } else if let Some(request) = pending_structured_user_input_from_response_item(&value) {
                    last_activity_kind = ObservationKind::WaitingForInput;
                    pending_structured_user_input = Some(request);
                } else if response_item_payload_type(&value) == Some("function_call_output") {
                    if let Some(call_id) = response_item_call_id(&value) {
                        let resolves_pending_approval = pending_tool_approval
                            .as_ref()
                            .and_then(|approval: &PendingToolApproval| approval.call_id.as_deref())
                            .is_some_and(|pending_call_id| pending_call_id == call_id);
                        let resolves_pending_structured_user_input = pending_structured_user_input
                            .as_ref()
                            .and_then(|request: &PendingStructuredUserInput| request.call_id.as_deref())
                            .is_some_and(|pending_call_id| pending_call_id == call_id);
                        if resolves_pending_approval {
                            pending_tool_approval = None;
                        }
                        if resolves_pending_structured_user_input {
                            pending_structured_user_input = None;
                        }
                        if resolves_pending_approval || resolves_pending_structured_user_input {
                            last_activity_kind = ObservationKind::Running;
                        }
                    }
                }
            }
            _ => {}
        }
    }

    let Some(session_id) = session_id.or_else(|| session_id_from_path(path)) else {
        return Ok(None);
    };

    let is_recent = latest_timestamp
        .as_deref()
        .and_then(parse_utc_timestamp)
        .and_then(|last_activity| now.duration_since(last_activity).ok())
        .is_some_and(|age| age <= Duration::from_secs(2 * 60 * 60));
    let is_recent_unread_completion = latest_timestamp
        .as_deref()
        .and_then(parse_utc_timestamp)
        .and_then(|last_activity| now.duration_since(last_activity).ok())
        .is_some_and(|age| age <= UNREAD_COMPLETION_RETENTION);
    let pending_input = pending_structured_user_input
        .as_ref()
        .map(|request| (request.timestamp.clone(), request.evidence_summary.clone()))
        .or_else(|| {
            pending_tool_approval
                .as_ref()
                .map(|approval| (approval.timestamp.clone(), approval.evidence_summary.clone()))
        });
    let kind = if pending_input.is_some() {
        ObservationKind::WaitingForInput
    } else if matches!(last_activity_kind, ObservationKind::Completed) {
        if !external_import_session && is_recent_unread_completion {
            ObservationKind::CompletedImmediate
        } else {
            ObservationKind::CompletedStale
        }
    } else if matches!(last_activity_kind, ObservationKind::Stopped) {
        ObservationKind::Stopped
    } else if matches!(last_activity_kind, ObservationKind::Running) && is_recent {
        ObservationKind::Running
    } else if is_recent {
        ObservationKind::Running
    } else {
        ObservationKind::InsufficientEvidence
    };

    let project_name = cwd
        .as_deref()
        .and_then(|workspace| Path::new(workspace).file_name())
        .and_then(|name| name.to_str())
        .map(ToString::to_string);

    let label = session_name
        .or_else(|| project_name.as_ref().map(|name| format!("Codex: {name}")))
        .unwrap_or_else(|| format!("Codex session {session_id}"));

    let evidence_summary = pending_input
        .as_ref()
        .map(|(_, summary)| summary.clone())
        .or_else(|| last_agent_message.map(|message| truncate_for_summary(&message, 120)))
        .or_else(|| Some("local Codex JSONL activity observed".to_string()));

    let mut observation = SourceObservation::new(session_id, kind)
        .with_label(label)
        .with_jump_target(jump_target);

    if let Some(agent_name) = agent_name {
        observation = observation.with_agent_name(agent_name);
    }

    if let Some(thread_source) = thread_source {
        observation = observation.with_thread_source(thread_source);
    }

    if let Some(parent_session_id) = parent_session_id {
        observation = observation.with_parent_session_id(parent_session_id);
    }

    if let Some(project_name) = project_name {
        observation = observation.with_project_name(project_name);
    }

    if let Some(cwd) = cwd {
        observation = observation.with_workspace(cwd);
    }

    if let Some(timestamp) = pending_input
        .as_ref()
        .and_then(|(timestamp, _)| timestamp.clone())
        .or(latest_timestamp)
    {
        observation = observation.with_last_activity(timestamp);
    }

    observation.evidence_summary = evidence_summary;

    Ok(Some(ParsedSessionObservation {
        observation,
        task_completed_at,
    }))
}

fn should_parse_session_status_line(line: &str) -> bool {
    let line = line.trim();
    !line.is_empty()
        && (line.contains("\"type\":\"session_meta\"")
            || line.contains("\"type\": \"session_meta\"")
            || line.contains("\"type\":\"event_msg\"")
            || line.contains("\"type\": \"event_msg\"")
            || ((line.contains("\"type\":\"response_item\"")
                || line.contains("\"type\": \"response_item\""))
                && (line.contains("\"type\":\"function_call\"")
                    || line.contains("\"type\": \"function_call\"")
                    || line.contains("\"type\":\"function_call_output\"")
                    || line.contains("\"type\": \"function_call_output\""))))
}

fn pending_tool_approval_from_response_item(value: &Value) -> Option<PendingToolApproval> {
    if response_item_payload_type(value) != Some("function_call") {
        return None;
    }

    let payload = value.get("payload")?;
    let arguments = payload
        .get("arguments")
        .and_then(Value::as_str)
        .and_then(|arguments| serde_json::from_str::<Value>(arguments).ok())?;

    if arguments
        .get("sandbox_permissions")
        .and_then(Value::as_str)
        != Some("require_escalated")
    {
        return None;
    }

    let tool_name = payload
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("tool");
    let requested_action = arguments
        .get("cmd")
        .and_then(Value::as_str)
        .map(|command| truncate_for_summary(command.trim(), 120))
        .filter(|command| !command.is_empty())
        .unwrap_or_else(|| tool_name.to_string());
    let timestamp = value
        .get("timestamp")
        .and_then(Value::as_str)
        .map(ToString::to_string);

    Some(PendingToolApproval {
        call_id: response_item_call_id(value).map(ToString::to_string),
        timestamp,
        evidence_summary: format!("Codex is waiting for tool approval: {requested_action}"),
    })
}

fn pending_structured_user_input_from_response_item(
    value: &Value,
) -> Option<PendingStructuredUserInput> {
    if response_item_payload_type(value) != Some("function_call") {
        return None;
    }

    let payload = value.get("payload")?;
    if payload.get("name").and_then(Value::as_str) != Some("request_user_input") {
        return None;
    }

    let call_id = response_item_call_id(value)?.trim();
    if call_id.is_empty() {
        return None;
    }

    Some(PendingStructuredUserInput {
        call_id: Some(call_id.to_string()),
        timestamp: value
            .get("timestamp")
            .and_then(Value::as_str)
            .map(ToString::to_string),
        evidence_summary: "Codex is waiting for structured user input".to_string(),
    })
}

fn response_item_payload_type(value: &Value) -> Option<&str> {
    value
        .get("payload")
        .and_then(|payload| payload.get("type"))
        .and_then(Value::as_str)
}

fn response_item_call_id(value: &Value) -> Option<&str> {
    value
        .get("payload")
        .and_then(|payload| payload.get("call_id"))
        .and_then(Value::as_str)
}

#[derive(Debug, Clone)]
struct ThreadSummary {
    id: String,
    rollout_path: PathBuf,
    updated_at_ms: Option<i64>,
    source: String,
    cwd: String,
    title: String,
    archived: bool,
    agent_nickname: Option<String>,
    thread_source: Option<String>,
    preview: Option<String>,
    parent_session_id: Option<String>,
}

fn discover_threads_from_state_db(state_db: &Path) -> Result<Vec<ThreadSummary>, String> {
    let query = format!(
        "{} {} where threads.archived = 0 and coalesce(threads.thread_source, '') <> 'subagent' and thread_spawn_edges.parent_thread_id is null order by coalesce(threads.updated_at_ms, threads.updated_at * 1000) desc;",
        thread_summary_json_select(),
        thread_summary_from_clause()
    );
    let legacy_query = format!(
        "{} from threads where archived = 0 and coalesce(thread_source, '') <> 'subagent' order by coalesce(updated_at_ms, updated_at * 1000) desc;",
        legacy_thread_summary_json_select()
    );
    discover_thread_summaries_from_state_db(state_db, query, legacy_query)
}

fn discover_thread_from_state_db_by_id(state_db: &Path, session_id: &str) -> Option<ThreadSummary> {
    let query = format!(
        "{} {} where threads.id = '{}' limit 1;",
        thread_summary_json_select(),
        thread_summary_from_clause(),
        sqlite_string_literal(session_id)
    );
    let legacy_query = format!(
        "{} from threads where id = '{}' limit 1;",
        legacy_thread_summary_json_select(),
        sqlite_string_literal(session_id)
    );
    discover_thread_summaries_from_state_db(state_db, query, legacy_query)
        .ok()?
        .into_iter()
        .next()
}

fn discover_thread_summaries_from_state_db(
    state_db: &Path,
    query: String,
    legacy_query: String,
) -> Result<Vec<ThreadSummary>, String> {
    let output = run_sqlite_readonly_query(state_db, query)?;
    let output = if output.status.success() {
        output
    } else if incompatible_thread_spawn_edges_schema(&output) {
        let output = run_sqlite_readonly_query(state_db, legacy_query)?;
        if !output.status.success() {
            return Err(sqlite_query_error(state_db, &output));
        }
        output
    } else {
        return Err(sqlite_query_error(state_db, &output));
    };

    Ok(
        String::from_utf8_lossy(&output.stdout)
            .lines()
            .filter_map(parse_thread_summary_json)
            .collect(),
    )
}

fn run_sqlite_readonly_query(state_db: &Path, query: String) -> Result<Output, String> {
    Command::new("sqlite3")
        .arg("-batch")
        .arg("-readonly")
        .arg(state_db)
        .arg(query)
        .output()
        .map_err(|error| format!("failed to run sqlite3 for {}: {error}", state_db.display()))
}

fn sqlite_query_error(state_db: &Path, output: &Output) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if stderr.is_empty() {
        format!(
            "sqlite3 query for {} exited with {}",
            state_db.display(),
            output.status,
        )
    } else {
        format!(
            "sqlite3 query for {} exited with {}: {stderr}",
            state_db.display(),
            output.status,
        )
    }
}

fn incompatible_thread_spawn_edges_schema(output: &Output) -> bool {
    let stderr = String::from_utf8_lossy(&output.stderr);
    stderr.contains("no such table: thread_spawn_edges")
        || stderr.contains("no such column: thread_spawn_edges.")
}

fn legacy_thread_summary_json_select() -> &'static str {
    "select json_object(
        'id', id,
        'rollout_path', rollout_path,
        'updated_at_ms', updated_at_ms,
        'source', source,
        'cwd', cwd,
        'title', title,
        'archived', archived,
        'agent_nickname', agent_nickname,
        'thread_source', thread_source,
        'preview', preview,
        'parent_session_id', null
    )"
}

fn thread_summary_from_clause() -> &'static str {
    "from threads
    left join thread_spawn_edges
      on thread_spawn_edges.child_thread_id = threads.id"
}

fn thread_summary_json_select() -> &'static str {
    "select json_object(
        'id', threads.id,
        'rollout_path', threads.rollout_path,
        'updated_at_ms', threads.updated_at_ms,
        'source', threads.source,
        'cwd', threads.cwd,
        'title', threads.title,
        'archived', threads.archived,
        'agent_nickname', threads.agent_nickname,
        'thread_source', threads.thread_source,
        'preview', threads.preview,
        'parent_session_id', thread_spawn_edges.parent_thread_id
    )"
}

fn sqlite_string_literal(value: &str) -> String {
    value.replace('\'', "''")
}

fn parse_thread_summary_json(line: &str) -> Option<ThreadSummary> {
    let value = serde_json::from_str::<Value>(line).ok()?;
    let id = value.get("id")?.as_str()?.to_string();
    let rollout_path = PathBuf::from(value.get("rollout_path")?.as_str()?);
    let source = value.get("source")?.as_str()?.to_string();
    let cwd = value.get("cwd")?.as_str()?.to_string();
    let title = value.get("title")?.as_str()?.to_string();
    let archived = value
        .get("archived")
        .and_then(Value::as_i64)
        .is_some_and(|value| value != 0);
    let updated_at_ms = value.get("updated_at_ms").and_then(Value::as_i64);
    let agent_nickname = value
        .get("agent_nickname")
        .and_then(Value::as_str)
        .map(ToString::to_string);
    let thread_source = value
        .get("thread_source")
        .and_then(Value::as_str)
        .map(ToString::to_string);
    let preview = value
        .get("preview")
        .and_then(Value::as_str)
        .map(ToString::to_string);
    let parent_session_id = value
        .get("parent_session_id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string);

    Some(ThreadSummary {
        id,
        rollout_path,
        updated_at_ms,
        source,
        cwd,
        title,
        archived,
        agent_nickname,
        thread_source,
        preview,
        parent_session_id,
    })
}

fn observation_from_thread(
    thread: ThreadSummary,
    hook_signal: Option<&CodexHookSignal>,
    now: SystemTime,
    follow_up_window: Duration,
) -> Option<SourceObservation> {
    let parsed_jsonl = parse_session_file_tail_detailed(&thread.rollout_path, now).ok().flatten();
    let jsonl_observation = parsed_jsonl.as_ref().map(|parsed| &parsed.observation);
    let jump_target = jsonl_observation
        .as_ref()
        .and_then(|observation| {
            if matches!(observation.jump_target, JumpTarget::Unknown) {
                None
            } else {
                Some(observation.jump_target)
            }
        })
        .unwrap_or_else(|| jump_target_from_thread_source(&thread));
    let thread_updated_at = thread
        .updated_at_ms
        .and_then(|updated_at_ms| u64::try_from(updated_at_ms).ok())
        .map(|updated_at_ms| SystemTime::UNIX_EPOCH + Duration::from_millis(updated_at_ms));
    let thread_updated_after_task_complete = thread_updated_at
        .zip(parsed_jsonl.as_ref().and_then(|parsed| parsed.task_completed_at))
        .is_some_and(|(thread_updated_at, task_completed_at)| {
            thread_updated_at
                .duration_since(task_completed_at)
                .is_ok_and(|age| age > Duration::ZERO)
        });
    let last_activity_at = jsonl_observation
        .as_ref()
        .and_then(|observation| {
            if thread_updated_after_task_complete {
                None
            } else {
                observation.last_activity_at.clone()
            }
        })
        .or_else(|| thread.updated_at_ms.and_then(timestamp_ms_to_iso_utc));
    let has_recent_activity = last_activity_at
        .as_deref()
        .and_then(parse_utc_timestamp)
        .and_then(|last_activity| now.duration_since(last_activity).ok())
        .is_some_and(|age| age <= Duration::from_secs(2 * 60 * 60));
    let jsonl_kind = jsonl_observation.as_ref().map(|observation| observation.kind);
    let thread_completion_kind = completion_kind_from_last_activity_at(
        last_activity_at.as_deref(),
        now,
        follow_up_window,
    );
    let has_recent_hook_activity = hook_signal
        .filter(|signal| is_hook_activity_event(&signal.event_name))
        .and_then(|signal| now.duration_since(signal.timestamp_time).ok())
        .is_some_and(|age| age <= HOOK_ACTIVITY_FRESHNESS);
    let hook_activity_is_newer_than_jsonl = hook_signal
        .zip(last_activity_at.as_deref().and_then(parse_utc_timestamp))
        .is_some_and(|(signal, last_activity)| {
            signal
                .timestamp_time
                .duration_since(last_activity)
                .is_ok_and(|age| age > Duration::ZERO)
        });
    let hook_activity_can_override_terminal = !matches!(
        jsonl_kind,
        Some(
            ObservationKind::Completed
                | ObservationKind::CompletedImmediate
                | ObservationKind::CompletedStale
                | ObservationKind::Failed
                | ObservationKind::Stopped
                | ObservationKind::WaitingForInput
        )
    ) || hook_activity_is_newer_than_jsonl;
    let kind = if has_recent_hook_activity && hook_activity_can_override_terminal {
        ObservationKind::Running
    } else if thread_updated_after_task_complete && matches!(jsonl_kind, Some(ObservationKind::CompletedImmediate)) {
        thread_completion_kind
    } else if matches!(
        jsonl_kind,
        Some(
            ObservationKind::Completed
                | ObservationKind::CompletedImmediate
                | ObservationKind::CompletedStale
                | ObservationKind::Failed
                | ObservationKind::Stopped
                | ObservationKind::WaitingForInput
        )
    ) {
        jsonl_kind.expect("matched jsonl terminal or input state")
    } else if thread.archived {
        thread_completion_kind
    } else if matches!(jump_target, JumpTarget::Desktop) && has_recent_activity {
        ObservationKind::Running
    } else if matches!(jump_target, JumpTarget::Desktop) {
        ObservationKind::Idle
    } else {
        jsonl_kind.unwrap_or(ObservationKind::InsufficientEvidence)
    };
    let project_name = Path::new(&thread.cwd)
        .file_name()
        .and_then(|name| name.to_str())
        .map(ToString::to_string);
    let label = if !thread.title.trim().is_empty() {
        truncate_for_summary(thread.title.trim(), 120)
    } else if let Some(preview) = thread.preview.as_deref().filter(|value| !value.trim().is_empty()) {
        truncate_for_summary(preview.trim(), 120)
    } else if let Some(project_name) = project_name.as_deref() {
        format!("Codex: {project_name}")
    } else {
        format!("Codex session {}", thread.id)
    };
    let evidence_summary = if has_recent_hook_activity {
        hook_signal.map(|signal| format!("Codex hook {} observed.", signal.event_name))
    } else {
        None
    }
    .or_else(|| {
        jsonl_observation
            .as_ref()
            .and_then(|observation| observation.evidence_summary.clone())
    })
    .or_else(|| thread.preview.clone());

    let effective_last_activity_at = if has_recent_hook_activity {
        hook_signal.map(|signal| signal.timestamp.clone())
    } else {
        None
    }
    .or(last_activity_at);

    let mut observation = SourceObservation::new(thread.id, kind)
        .with_label(label)
        .with_workspace(thread.cwd)
        .with_jump_target(jump_target);

    let jsonl_thread_source = jsonl_observation
        .as_ref()
        .and_then(|observation| observation.thread_source.clone());
    let thread_source = effective_thread_source(thread.thread_source.clone(), jsonl_thread_source);
    if let Some(agent_name) = thread.agent_nickname.or(thread_source.clone()).or(Some(thread.source)) {
        observation = observation.with_agent_name(agent_name);
    }

    if let Some(thread_source) = thread_source {
        observation = observation.with_thread_source(thread_source);
    }

    if let Some(parent_session_id) = jsonl_observation
        .as_ref()
        .and_then(|observation| observation.parent_session_id.clone())
        .or(thread.parent_session_id)
    {
        observation = observation.with_parent_session_id(parent_session_id);
    }

    if let Some(project_name) = project_name {
        observation = observation.with_project_name(project_name);
    }

    if let Some(last_activity_at) = effective_last_activity_at {
        observation = observation.with_last_activity(last_activity_at);
    }

    observation.evidence_summary = evidence_summary;
    Some(observation)
}

fn completion_kind_from_last_activity_at(
    last_activity_at: Option<&str>,
    now: SystemTime,
    follow_up_window: Duration,
) -> ObservationKind {
    let completion_age = last_activity_at
        .and_then(parse_utc_timestamp)
        .and_then(|last_activity| now.duration_since(last_activity).ok());

    if completion_age.is_some_and(|age| age <= Duration::from_secs(5 * 60)) {
        ObservationKind::CompletedImmediate
    } else if completion_age.is_some_and(|age| age <= follow_up_window) {
        ObservationKind::Completed
    } else {
        ObservationKind::CompletedStale
    }
}

fn jump_target_from_thread_source(thread: &ThreadSummary) -> JumpTarget {
    let normalized = format!("{} {}", thread.source, thread.thread_source.as_deref().unwrap_or_default())
        .to_ascii_lowercase();
    if normalized.contains("cli") || normalized.contains("terminal") || normalized.contains("tui") {
        JumpTarget::Cli
    } else {
        JumpTarget::Desktop
    }
}

fn hook_signal_for_thread<'a>(
    hook_signals: &'a HashMap<String, CodexHookSignal>,
    thread: &ThreadSummary,
) -> Option<&'a CodexHookSignal> {
    hook_signals
        .get(&hook_session_key(&thread.id))
        .or_else(|| hook_signals.get(&hook_workspace_key(&thread.cwd)))
}

fn load_latest_hook_signals(path: &Path) -> HashMap<String, CodexHookSignal> {
    let Ok(content) = fs::read_to_string(path) else {
        return HashMap::new();
    };

    let mut signals = HashMap::new();
    for line in content.lines().filter(|line| !line.trim().is_empty()) {
        let Some(signal) = parse_hook_signal_line(line) else {
            continue;
        };

        if let Some(session_id) = signal.session_id.as_deref().filter(|value| !value.is_empty()) {
            upsert_latest_hook_signal(&mut signals, hook_session_key(session_id), signal.clone());
        }

        if let Some(workspace_path) = signal
            .workspace_path
            .as_deref()
            .filter(|value| !value.is_empty())
        {
            upsert_latest_hook_signal(&mut signals, hook_workspace_key(workspace_path), signal);
        }
    }

    signals
}

fn parse_hook_signal_line(line: &str) -> Option<CodexHookSignal> {
    let value = serde_json::from_str::<Value>(line).ok()?;
    let event_name = value
        .get("eventType")
        .or_else(|| value.get("hookEventName"))
        .or_else(|| value.get("hook_event_name"))
        .and_then(Value::as_str)?
        .to_string();
    let timestamp = value
        .get("timestamp")
        .and_then(Value::as_str)
        .map(ToString::to_string)?;
    let timestamp_time = parse_utc_timestamp(&timestamp)?;
    let session_id = value
        .get("sessionId")
        .or_else(|| value.get("session_id"))
        .or_else(|| value.get("threadId"))
        .or_else(|| value.get("thread_id"))
        .and_then(Value::as_str)
        .map(ToString::to_string);
    let workspace_path = value
        .get("workspacePath")
        .or_else(|| value.get("workspace_path"))
        .or_else(|| value.get("cwd"))
        .and_then(Value::as_str)
        .map(ToString::to_string);

    Some(CodexHookSignal {
        event_name,
        timestamp,
        timestamp_time,
        session_id,
        workspace_path,
    })
}

fn upsert_latest_hook_signal(
    signals: &mut HashMap<String, CodexHookSignal>,
    key: String,
    signal: CodexHookSignal,
) {
    let should_replace = signals
        .get(&key)
        .map(|existing| signal.timestamp_time.duration_since(existing.timestamp_time).is_ok())
        .unwrap_or(true);

    if should_replace {
        signals.insert(key, signal);
    }
}

fn hook_session_key(session_id: &str) -> String {
    format!("session:{session_id}")
}

fn hook_workspace_key(workspace_path: &str) -> String {
    format!("workspace:{workspace_path}")
}

fn is_hook_activity_event(event_name: &str) -> bool {
    matches!(
        event_name,
        "SessionStart" | "UserPromptSubmit" | "PreToolUse" | "PostToolUse"
    )
}

fn timestamp_ms_to_iso_utc(value: i64) -> Option<String> {
    let seconds = value.div_euclid(1000);
    let millis = value.rem_euclid(1000);
    let output = Command::new("date")
        .args([
            "-u",
            "-r",
            &seconds.to_string(),
            &format!("+%Y-%m-%dT%H:%M:%S.{millis:03}Z"),
        ])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn codex_state_db_path() -> PathBuf {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    codex_state_db_path_from_home(&home)
}

fn codex_state_db_path_from_home(home: &Path) -> PathBuf {
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

fn codex_state_db_modified_at(path: &Path) -> SystemTime {
    fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .unwrap_or(SystemTime::UNIX_EPOCH)
}

fn codex_hook_events_path() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".codex")
        .join("agent-session-inbox")
        .join("hook-events.jsonl")
}

fn jump_target_from_session_meta(payload: &Value) -> Option<JumpTarget> {
    let originator = payload
        .get("originator")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let source = payload
        .get("source")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let normalized = format!("{originator} {source}").to_ascii_lowercase();

    if normalized.contains("desktop") {
        Some(JumpTarget::Desktop)
    } else if normalized.contains("cli") || normalized.contains("terminal") || normalized.contains("tui") {
        Some(JumpTarget::Cli)
    } else {
        Some(JumpTarget::Unknown)
    }
}

fn parent_thread_id_from_session_meta(payload: &Value) -> Option<String> {
    payload
        .get("parent_thread_id")
        .and_then(Value::as_str)
        .or_else(|| {
            payload
                .get("source")
                .and_then(|source| source.get("subagent"))
                .and_then(|subagent| subagent.get("thread_spawn"))
                .and_then(|thread_spawn| thread_spawn.get("parent_thread_id"))
                .and_then(Value::as_str)
        })
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

fn session_id_from_path(path: &Path) -> Option<String> {
    let stem = path.file_stem()?.to_str()?;
    let parts = stem.split('-').collect::<Vec<_>>();
    parts
        .iter()
        .position(|part| part.starts_with("019"))
        .map(|session_start| parts[session_start..].join("-"))
        .or_else(|| stem.rsplit('-').next().map(ToString::to_string))
}

fn looks_like_codex_session_id(value: &str) -> bool {
    value.len() >= 20
        && value.contains('-')
        && value
            .chars()
            .all(|character| character.is_ascii_hexdigit() || character == '-')
}

fn truncate_for_summary(value: &str, max_chars: usize) -> String {
    let mut output = String::new();
    for ch in value.chars().take(max_chars) {
        output.push(ch);
    }
    if value.chars().count() > max_chars {
        output.push_str("...");
    }
    output
}

pub(crate) fn parse_utc_timestamp(value: &str) -> Option<SystemTime> {
    let (date, time) = value.split_once('T')?;
    let mut date_parts = date.split('-');
    let year = date_parts.next()?.parse::<i32>().ok()?;
    let month = date_parts.next()?.parse::<u32>().ok()?;
    let day = date_parts.next()?.parse::<u32>().ok()?;

    let time = time.trim_end_matches('Z');
    let mut time_parts = time.split(':');
    let hour = time_parts.next()?.parse::<u32>().ok()?;
    let minute = time_parts.next()?.parse::<u32>().ok()?;
    let second_with_fraction = time_parts.next()?;
    let (second_value, fractional_value) = second_with_fraction
        .split_once('.')
        .unwrap_or((second_with_fraction, ""));
    let second = second_value.parse::<u32>().ok()?;
    let milliseconds = parse_milliseconds(fractional_value)?;

    let days = days_from_civil(year, month, day)?;
    let seconds = days
        .checked_mul(86_400)?
        .checked_add((hour as i64) * 3_600)?
        .checked_add((minute as i64) * 60)?
        .checked_add(second as i64)?;

    if seconds < 0 {
        return None;
    }

    Some(
        SystemTime::UNIX_EPOCH
            + Duration::from_secs(seconds as u64)
            + Duration::from_millis(milliseconds),
    )
}

fn parse_milliseconds(value: &str) -> Option<u64> {
    if value.is_empty() {
        return Some(0);
    }

    let mut digits = String::new();
    for ch in value.chars().take(3) {
        if !ch.is_ascii_digit() {
            return None;
        }
        digits.push(ch);
    }

    while digits.len() < 3 {
        digits.push('0');
    }

    digits.parse::<u64>().ok()
}

fn days_from_civil(year: i32, month: u32, day: u32) -> Option<i64> {
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }

    let year = year - i32::from(month <= 2);
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let yoe = year - era * 400;
    let month = month as i32;
    let day = day as i32;
    let doy = (153 * (month + if month > 2 { -3 } else { 9 }) + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    Some((era * 146_097 + doe - 719_468) as i64)
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::time::{Duration, SystemTime};

    use tempfile::tempdir;

    use crate::codex_source::{
        discover_codex_observation_by_id, discover_codex_observations_with_now,
        discover_codex_observations_with_state_db,
        discover_codex_observation_snapshot_with_state_db_and_follow_up_window,
        discover_codex_observations_with_state_db_and_follow_up_window,
        discover_codex_observations_with_state_db_and_hooks,
        ObservationSnapshotSource,
    };
    use crate::domain::session::{JumpTarget, ObservationKind};

    #[test]
    fn discovers_recent_codex_session_metadata_from_jsonl() {
        let temp = tempdir().expect("temp dir");
        let session_dir = temp.path().join("2026/06/03");
        fs::create_dir_all(&session_dir).expect("session dir");
        fs::write(
            session_dir.join("rollout-2026-06-03T10-00-00-019example.jsonl"),
            r#"{"timestamp":"2026-06-03T02:00:00.000Z","type":"session_meta","payload":{"id":"019example","cwd":"/Users/edy/project-a","originator":"Codex Desktop"}}"#
                .to_string()
                + "\n"
                + r#"{"timestamp":"2026-06-03T02:10:00.000Z","type":"event_msg","payload":{"type":"agent_message","message":"working","phase":"commentary"}}"#
                + "\n",
        )
        .expect("session file");

        let rows = discover_codex_observations_with_now(
            temp.path(),
            20,
            SystemTime::UNIX_EPOCH + Duration::from_secs(1_780_459_000),
        );

        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].session_id, "019example");
        assert_eq!(rows[0].label.as_deref(), Some("Codex: project-a"));
        assert_eq!(rows[0].agent_name.as_deref(), Some("Codex Desktop"));
        assert_eq!(rows[0].project_name.as_deref(), Some("project-a"));
        assert_eq!(
            rows[0].workspace_path.as_deref(),
            Some("/Users/edy/project-a")
        );
        assert_eq!(
            rows[0].last_activity_at.as_deref(),
            Some("2026-06-03T02:10:00.000Z")
        );
        assert_eq!(rows[0].kind, ObservationKind::Running);
        assert_eq!(rows[0].jump_target, JumpTarget::Desktop);
    }

    #[test]
    fn records_jsonl_fallback_when_sqlite_thread_discovery_is_unavailable() {
        let temp = tempdir().expect("temp dir");
        let sessions_root = temp.path().join("sessions");
        let session_dir = sessions_root.join("2026/06/03");
        fs::create_dir_all(&session_dir).expect("session dir");
        fs::write(
            session_dir.join("rollout-2026-06-03T10-00-00-019fallback.jsonl"),
            r#"{"timestamp":"2026-06-03T02:00:00.000Z","type":"session_meta","payload":{"id":"019fallback","cwd":"/Users/edy/project-a","originator":"Codex Desktop"}}
{"timestamp":"2026-06-03T02:10:00.000Z","type":"event_msg","payload":{"type":"agent_message","message":"working"}}
"#,
        )
        .expect("session file");

        let state_db = temp.path().join("missing-state.sqlite");
        let snapshot = discover_codex_observation_snapshot_with_state_db_and_follow_up_window(
            &state_db,
            &sessions_root,
            20,
            SystemTime::UNIX_EPOCH + Duration::from_secs(1_780_459_000),
            Duration::from_secs(30 * 60),
        );

        assert!(matches!(
            snapshot.source,
            ObservationSnapshotSource::JsonlFallback { .. }
        ));
        assert_eq!(snapshot.observations.len(), 1);
        assert_eq!(snapshot.observations[0].session_id, "019fallback");
        assert_eq!(snapshot.observations[0].kind, ObservationKind::Running);
    }

    #[test]
    fn parses_parent_thread_id_from_subagent_session_metadata() {
        let temp = tempdir().expect("temp dir");
        let session_dir = temp.path().join("2026/06/11");
        fs::create_dir_all(&session_dir).expect("session dir");
        let child_path = session_dir.join("rollout-2026-06-11T17-00-00-019child.jsonl");
        fs::write(
            &child_path,
            r#"{"timestamp":"2026-06-11T09:00:00.000Z","type":"session_meta","payload":{"id":"019child","parent_thread_id":"019parent","cwd":"/Users/edy/project-a","originator":"codex-tui","source":{"subagent":{"thread_spawn":{"parent_thread_id":"019parent","depth":1}}},"thread_source":"subagent"}}"#
                .to_string()
                + "\n"
                + r#"{"timestamp":"2026-06-11T09:10:00.000Z","type":"event_msg","payload":{"type":"agent_message","message":"working","phase":"commentary"}}"#
                + "\n",
        )
        .expect("session file");

        let row = super::parse_session_file(
            &child_path,
            SystemTime::UNIX_EPOCH + Duration::from_secs(1_781_168_000),
        )
        .expect("parse session file")
        .expect("child observation");

        assert_eq!(row.session_id, "019child");
        assert_eq!(row.thread_source.as_deref(), Some("subagent"));
        assert_eq!(row.parent_session_id.as_deref(), Some("019parent"));
    }

    #[test]
    fn parser_keeps_child_identity_when_rollout_embeds_parent_metadata() {
        let temp = tempdir().expect("temp dir");
        let session_dir = temp.path().join("2026/08/13");
        fs::create_dir_all(&session_dir).expect("session dir");
        let child_path = session_dir.join("rollout-2026-08-13T10-00-00-019child-embedded.jsonl");
        fs::write(
            &child_path,
            r#"{"timestamp":"2026-08-13T02:00:00.000Z","type":"session_meta","payload":{"id":"019child-embedded","parent_thread_id":"019parent-embedded","cwd":"/Users/edy/project-child","originator":"codex-tui","thread_source":"subagent"}}"#
                .to_string()
                + "\n"
                + r#"{"timestamp":"2026-08-13T02:01:00.000Z","type":"session_meta","payload":{"id":"019parent-embedded","cwd":"/Users/edy/project-parent","originator":"Codex Desktop"}}"#
                + "\n"
                + r#"{"timestamp":"2026-08-13T02:02:00.000Z","type":"event_msg","payload":{"type":"agent_message","message":"child still working"}}"#
                + "\n",
        )
        .expect("session file");

        let row = super::parse_session_file(
            &child_path,
            SystemTime::UNIX_EPOCH + Duration::from_secs(1_786_052_000),
        )
        .expect("parse session file")
        .expect("child observation");

        assert_eq!(row.session_id, "019child-embedded");
        assert_eq!(
            row.parent_session_id.as_deref(),
            Some("019parent-embedded")
        );
    }

    #[test]
    fn jsonl_fallback_deduplicates_rollout_files_by_session_id_using_newest_observation() {
        let temp = tempdir().expect("temp dir");
        let session_dir = temp.path().join("2026/08/13");
        fs::create_dir_all(&session_dir).expect("session dir");
        let older_path = session_dir.join("rollout-2026-08-13T09-00-00-019duplicate.jsonl");
        let newer_path = session_dir.join("rollout-2026-08-13T10-00-00-019duplicate.jsonl");

        fs::write(
            &older_path,
            r#"{"timestamp":"2026-08-13T01:00:00.000Z","type":"session_meta","payload":{"id":"019duplicate","cwd":"/Users/edy/project-old","originator":"Codex Desktop"}}
{"timestamp":"2026-08-13T01:01:00.000Z","type":"event_msg","payload":{"type":"agent_message","message":"older observation"}}
"#,
        )
        .expect("older session file");
        fs::write(
            &newer_path,
            r#"{"timestamp":"2026-08-13T02:00:00.000Z","type":"session_meta","payload":{"id":"019duplicate","cwd":"/Users/edy/project-new","originator":"Codex Desktop"}}
{"timestamp":"2026-08-13T02:02:00.000Z","type":"event_msg","payload":{"type":"agent_message","message":"newer observation"}}
"#,
        )
        .expect("newer session file");

        fs::File::open(&older_path)
            .expect("open older session file")
            .set_times(
                fs::FileTimes::new().set_modified(
                    SystemTime::UNIX_EPOCH + Duration::from_secs(1_786_048_000),
                ),
            )
            .expect("set older session file time");
        fs::File::open(&newer_path)
            .expect("open newer session file")
            .set_times(
                fs::FileTimes::new().set_modified(
                    SystemTime::UNIX_EPOCH + Duration::from_secs(1_786_051_600),
                ),
            )
            .expect("set newer session file time");

        let rows = discover_codex_observations_with_now(
            temp.path(),
            20,
            SystemTime::UNIX_EPOCH + Duration::from_secs(1_786_052_000),
        );

        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].session_id, "019duplicate");
        assert_eq!(
            rows[0].workspace_path.as_deref(),
            Some("/Users/edy/project-new")
        );
        assert_eq!(
            rows[0].last_activity_at.as_deref(),
            Some("2026-08-13T02:02:00.000Z")
        );
    }

    #[test]
    fn jsonl_fallback_keeps_a_parent_when_newer_orphan_subagents_exceed_the_limit() {
        let temp = tempdir().expect("temp dir");
        let session_dir = temp.path().join("2026/08/13");
        fs::create_dir_all(&session_dir).expect("session dir");
        let parent_path = session_dir.join("rollout-2026-08-13T09-00-00-019parent-fallback.jsonl");
        let child_path = session_dir.join("rollout-2026-08-13T10-00-00-019orphan-child-fallback.jsonl");

        fs::write(
            &parent_path,
            r#"{"timestamp":"2026-08-13T01:00:00.000Z","type":"session_meta","payload":{"id":"019parent-fallback","cwd":"/Users/edy/project-parent","originator":"Codex Desktop","thread_source":"user"}}
{"timestamp":"2026-08-13T01:01:00.000Z","type":"event_msg","payload":{"type":"agent_message","message":"parent working"}}
"#,
        )
        .expect("parent session file");
        fs::write(
            &child_path,
            r#"{"timestamp":"2026-08-13T02:00:00.000Z","type":"session_meta","payload":{"id":"019orphan-child-fallback","cwd":"/Users/edy/project-child","originator":"codex-tui","thread_source":"subagent"}}
{"timestamp":"2026-08-13T02:01:00.000Z","type":"event_msg","payload":{"type":"agent_message","message":"child working"}}
"#,
        )
        .expect("child session file");
        fs::File::open(&parent_path)
            .expect("open parent session file")
            .set_times(
                fs::FileTimes::new().set_modified(
                    SystemTime::UNIX_EPOCH + Duration::from_secs(1_786_048_000),
                ),
            )
            .expect("set parent session file time");
        fs::File::open(&child_path)
            .expect("open child session file")
            .set_times(
                fs::FileTimes::new().set_modified(
                    SystemTime::UNIX_EPOCH + Duration::from_secs(1_786_051_600),
                ),
            )
            .expect("set child session file time");

        let rows = discover_codex_observations_with_now(
            temp.path(),
            1,
            SystemTime::UNIX_EPOCH + Duration::from_secs(1_786_052_000),
        );

        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].session_id, "019parent-fallback");
    }

    #[test]
    fn uses_first_user_message_as_session_label() {
        let temp = tempdir().expect("temp dir");
        let session_dir = temp.path().join("2026/06/03");
        fs::create_dir_all(&session_dir).expect("session dir");
        fs::write(
            session_dir.join("rollout-2026-06-03T10-00-00-019named.jsonl"),
            r#"{"timestamp":"2026-06-03T02:00:00.000Z","type":"session_meta","payload":{"id":"019named","cwd":"/Users/edy/project-a","originator":"Codex Desktop","agent_nickname":"Averroes"}}"#
                .to_string()
                + "\n"
                + r#"{"timestamp":"2026-06-03T02:01:00.000Z","type":"event_msg","payload":{"type":"user_message","message":"Add session titles to inbox\n"}}"#
                + "\n"
                + r#"{"timestamp":"2026-06-03T02:10:00.000Z","type":"event_msg","payload":{"type":"agent_message","message":"working","phase":"commentary"}}"#
                + "\n",
        )
        .expect("session file");

        let rows = discover_codex_observations_with_now(
            temp.path(),
            20,
            SystemTime::UNIX_EPOCH + Duration::from_secs(1_780_459_000),
        );

        assert_eq!(rows.len(), 1);
        assert_eq!(
            rows[0].label.as_deref(),
            Some("Add session titles to inbox")
        );
        assert_eq!(rows[0].agent_name.as_deref(), Some("Averroes"));
        assert_eq!(rows[0].project_name.as_deref(), Some("project-a"));
    }

    #[test]
    fn maps_cli_originator_to_cli_jump_target() {
        let temp = tempdir().expect("temp dir");
        let session_dir = temp.path().join("2026/06/03");
        fs::create_dir_all(&session_dir).expect("session dir");
        fs::write(
            session_dir.join("rollout-2026-06-03T10-00-00-019cli.jsonl"),
            r#"{"timestamp":"2026-06-03T02:00:00.000Z","type":"session_meta","payload":{"id":"019cli","cwd":"/Users/edy/project-cli","originator":"Codex CLI"}}"#
                .to_string()
                + "\n",
        )
        .expect("session file");

        let rows = discover_codex_observations_with_now(
            temp.path(),
            20,
            SystemTime::UNIX_EPOCH + Duration::from_secs(1_780_459_000),
        );

        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].jump_target, JumpTarget::Cli);
    }

    #[test]
    fn maps_tui_originator_and_cli_source_to_cli_jump_target() {
        let temp = tempdir().expect("temp dir");
        let session_dir = temp.path().join("2026/06/03");
        fs::create_dir_all(&session_dir).expect("session dir");
        fs::write(
            session_dir.join("rollout-2026-06-03T10-00-00-019tui.jsonl"),
            r#"{"timestamp":"2026-06-03T02:00:00.000Z","type":"session_meta","payload":{"id":"019tui","cwd":"/Users/edy/project-tui","originator":"codex-tui","source":"cli"}}"#
                .to_string()
                + "\n",
        )
        .expect("session file");

        let rows = discover_codex_observations_with_now(
            temp.path(),
            20,
            SystemTime::UNIX_EPOCH + Duration::from_secs(1_780_459_000),
        );

        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].jump_target, JumpTarget::Cli);
    }

    #[test]
    fn marks_task_complete_sessions_as_completed() {
        let temp = tempdir().expect("temp dir");
        let session_dir = temp.path().join("2026/06/05");
        fs::create_dir_all(&session_dir).expect("session dir");
        fs::write(
            session_dir.join("rollout-2026-06-05T16-00-00-019done.jsonl"),
            r#"{"timestamp":"2026-06-05T08:00:00.000Z","type":"session_meta","payload":{"id":"019done","cwd":"/Users/edy/project-b","originator":"Codex Desktop"}}"#
                .to_string()
                + "\n"
                + r#"{"timestamp":"2026-06-05T08:20:00.000Z","type":"event_msg","payload":{"type":"task_complete"}}"#
                + "\n",
        )
        .expect("session file");

        let rows = discover_codex_observations_with_now(
            temp.path(),
            20,
            SystemTime::UNIX_EPOCH + Duration::from_secs(1_780_650_980),
        );

        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].kind, ObservationKind::CompletedImmediate);
        assert_eq!(
            rows[0].last_activity_at.as_deref(),
            Some("2026-06-05T08:20:00.000Z")
        );
    }

    #[test]
    fn unread_task_complete_within_twelve_hours_stays_immediate() {
        let temp = tempdir().expect("temp dir");
        let session_dir = temp.path().join("2026/06/05");
        fs::create_dir_all(&session_dir).expect("session dir");
        fs::write(
            session_dir.join("rollout-2026-06-05T16-00-00-019done-needed.jsonl"),
            r#"{"timestamp":"2026-06-05T08:00:00.000Z","type":"session_meta","payload":{"id":"019done-needed","cwd":"/Users/edy/project-b","originator":"Codex Desktop"}}"#
                .to_string()
                + "\n"
                + r#"{"timestamp":"2026-06-05T08:20:00.000Z","type":"event_msg","payload":{"type":"task_complete"}}"#
                + "\n",
        )
        .expect("session file");

        let rows = discover_codex_observations_with_now(
            temp.path(),
            20,
            SystemTime::UNIX_EPOCH + Duration::from_secs(1_780_690_799),
        );

        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].kind, ObservationKind::CompletedImmediate);
    }

    #[test]
    fn unread_task_complete_after_twelve_hours_is_stale() {
        let temp = tempdir().expect("temp dir");
        let session_dir = temp.path().join("2026/06/05");
        fs::create_dir_all(&session_dir).expect("session dir");
        fs::write(
            session_dir.join("rollout-2026-06-05T16-00-00-019done-stale.jsonl"),
            r#"{"timestamp":"2026-06-05T08:00:00.000Z","type":"session_meta","payload":{"id":"019done-stale","cwd":"/Users/edy/project-b","originator":"Codex Desktop"}}"#
                .to_string()
                + "\n"
                + r#"{"timestamp":"2026-06-05T08:20:00.000Z","type":"event_msg","payload":{"type":"task_complete"}}"#
                + "\n",
        )
        .expect("session file");

        let rows = discover_codex_observations_with_now(
            temp.path(),
            20,
            SystemTime::UNIX_EPOCH + Duration::from_secs(1_780_690_801),
        );

        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].kind, ObservationKind::CompletedStale);
    }

    #[test]
    fn treats_external_import_completion_as_stale_history() {
        let temp = tempdir().expect("temp dir");
        let session_dir = temp.path().join("2026/06/12");
        fs::create_dir_all(&session_dir).expect("session dir");
        fs::write(
            session_dir.join("rollout-2026-06-12T10-31-55-019imported.jsonl"),
            r#"{"timestamp":"2026-06-12T02:31:55.949Z","type":"session_meta","payload":{"id":"019imported","cwd":"/Users/edy/project-b","originator":"codex-tui","source":"cli"}}"#
                .to_string()
                + "\n"
                + r#"{"timestamp":"2026-06-12T02:31:55.950Z","type":"event_msg","payload":{"type":"task_started","turn_id":"external-import-turn-1","started_at":1779083012}}"#
                + "\n"
                + r#"{"timestamp":"2026-06-12T02:31:55.951Z","type":"event_msg","payload":{"type":"user_message","message":"old imported prompt"}}"#
                + "\n"
                + r#"{"timestamp":"2026-06-12T02:31:55.952Z","type":"event_msg","payload":{"type":"agent_message","message":"<EXTERNAL SESSION IMPORTED>","phase":null}}"#
                + "\n"
                + r#"{"timestamp":"2026-06-12T02:31:55.953Z","type":"event_msg","payload":{"type":"task_complete","turn_id":"external-import-turn-1","last_agent_message":null,"completed_at":1779083012}}"#
                + "\n",
        )
        .expect("session file");

        let rows = discover_codex_observations_with_now(
            temp.path(),
            20,
            SystemTime::UNIX_EPOCH + Duration::from_secs(1_781_232_000),
        );

        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].kind, ObservationKind::CompletedStale);
        assert_eq!(
            rows[0].last_activity_at.as_deref(),
            Some("2026-06-12T02:31:55.953Z")
        );
    }

    #[test]
    fn treats_task_complete_after_unread_retention_as_stale_completed() {
        let temp = tempdir().expect("temp dir");
        let session_dir = temp.path().join("2026/06/03");
        fs::create_dir_all(&session_dir).expect("session dir");
        fs::write(
            session_dir.join("rollout-2026-06-03T11-00-00-019done-old.jsonl"),
            r#"{"timestamp":"2026-06-03T03:00:00.000Z","type":"session_meta","payload":{"id":"019done-old","cwd":"/Users/edy/project-b","originator":"Codex Desktop"}}"#
                .to_string()
                + "\n"
                + r#"{"timestamp":"2026-06-03T03:20:00.000Z","type":"event_msg","payload":{"type":"task_complete"}}"#
                + "\n",
        )
        .expect("session file");

        let rows = discover_codex_observations_with_now(
            temp.path(),
            20,
            SystemTime::UNIX_EPOCH + Duration::from_secs(1_780_500_001),
        );

        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].kind, ObservationKind::CompletedStale);
    }

    #[test]
    fn newer_user_message_after_task_complete_reopens_session_as_running() {
        let temp = tempdir().expect("temp dir");
        let session_dir = temp.path().join("2026/06/05");
        fs::create_dir_all(&session_dir).expect("session dir");
        fs::write(
            session_dir.join("rollout-2026-06-03T11-00-00-019continued.jsonl"),
            r#"{"timestamp":"2026-06-03T03:00:00.000Z","type":"session_meta","payload":{"id":"019continued","cwd":"/Users/edy/project-b","originator":"Codex Desktop"}}"#
                .to_string()
                + "\n"
                + r#"{"timestamp":"2026-06-03T03:20:00.000Z","type":"event_msg","payload":{"type":"task_complete"}}"#
                + "\n"
                + r#"{"timestamp":"2026-06-03T03:30:00.000Z","type":"event_msg","payload":{"type":"user_message","message":"continue\n"}}"#
                + "\n",
        )
        .expect("session file");

        let rows = discover_codex_observations_with_now(
            temp.path(),
            20,
            SystemTime::UNIX_EPOCH + Duration::from_secs(1_780_457_700),
        );

        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].kind, ObservationKind::Running);
        assert_eq!(
            rows[0].last_activity_at.as_deref(),
            Some("2026-06-03T03:30:00.000Z")
        );
    }

    #[test]
    fn command_approval_prompt_marks_desktop_and_cli_sessions_waiting_for_input() {
        let temp = tempdir().expect("temp dir");
        let session_dir = temp.path().join("2026/06/06");
        fs::create_dir_all(&session_dir).expect("session dir");
        fs::write(
            session_dir.join("rollout-2026-06-06T12-00-00-019desktop-approval.jsonl"),
            r#"{"timestamp":"2026-06-06T04:00:00.000Z","type":"session_meta","payload":{"id":"019desktop-approval","cwd":"/Users/edy/project-desktop","originator":"Codex Desktop","source":"vscode"}}"#
                .to_string()
                + "\n"
                + r#"{"timestamp":"2026-06-06T04:01:00.000Z","type":"event_msg","payload":{"type":"user_message","message":"build desktop\n"}}"#
                + "\n"
                + r#"{"timestamp":"2026-06-06T04:05:00.000Z","type":"response_item","payload":{"type":"function_call","name":"exec_command","arguments":"{\"cmd\":\"npm run build\",\"sandbox_permissions\":\"require_escalated\",\"justification\":\"Need network access\"}","call_id":"call_desktop"}}"#
                + "\n",
        )
        .expect("desktop session file");
        fs::write(
            session_dir.join("rollout-2026-06-06T12-00-00-019cli-approval.jsonl"),
            r#"{"timestamp":"2026-06-06T04:00:00.000Z","type":"session_meta","payload":{"id":"019cli-approval","cwd":"/Users/edy/project-cli","originator":"Codex CLI","source":"cli"}}"#
                .to_string()
                + "\n"
                + r#"{"timestamp":"2026-06-06T04:01:00.000Z","type":"event_msg","payload":{"type":"user_message","message":"build cli\n"}}"#
                + "\n"
                + r#"{"timestamp":"2026-06-06T04:06:00.000Z","type":"response_item","payload":{"type":"function_call","name":"exec_command","arguments":"{\"cmd\":\"npm run build\",\"sandbox_permissions\":\"require_escalated\",\"justification\":\"Need network access\"}","call_id":"call_cli"}}"#
                + "\n",
        )
        .expect("cli session file");

        let mut rows = discover_codex_observations_with_now(
            temp.path(),
            20,
            SystemTime::UNIX_EPOCH + Duration::from_secs(1_780_720_000),
        );
        rows.sort_by(|left, right| left.session_id.cmp(&right.session_id));

        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].session_id, "019cli-approval");
        assert_eq!(rows[0].kind, ObservationKind::WaitingForInput);
        assert_eq!(rows[0].jump_target, JumpTarget::Cli);
        assert_eq!(
            rows[0].last_activity_at.as_deref(),
            Some("2026-06-06T04:06:00.000Z")
        );
        assert_eq!(
            rows[0].evidence_summary.as_deref(),
            Some("Codex is waiting for tool approval: npm run build")
        );
        assert_eq!(rows[1].session_id, "019desktop-approval");
        assert_eq!(rows[1].kind, ObservationKind::WaitingForInput);
        assert_eq!(rows[1].jump_target, JumpTarget::Desktop);
        assert_eq!(
            rows[1].last_activity_at.as_deref(),
            Some("2026-06-06T04:05:00.000Z")
        );
    }

    #[test]
    fn unresolved_structured_user_input_marks_session_waiting_for_input() {
        let temp = tempdir().expect("temp dir");
        let session_dir = temp.path().join("2026/08/04");
        fs::create_dir_all(&session_dir).expect("session dir");
        fs::write(
            session_dir.join("rollout-2026-08-04T04-00-00-019structured-input.jsonl"),
            r#"{"timestamp":"2026-08-04T04:00:00.000Z","type":"session_meta","payload":{"id":"019structured-input","cwd":"/Users/edy/project-input","originator":"Codex Desktop","source":"vscode"}}"#
                .to_string()
                + "\n"
                + r#"{"timestamp":"2026-08-04T04:05:00.000Z","type":"response_item","payload":{"type":"function_call","name":"request_user_input","arguments":"{\"questions\":[{\"id\":\"confirm\",\"question\":\"Continue?\"}]}","call_id":"call_input"}}"#
                + "\n",
        )
        .expect("session file");

        let rows = discover_codex_observations_with_now(
            temp.path(),
            20,
            SystemTime::UNIX_EPOCH + Duration::from_secs(1_785_817_000),
        );

        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].kind, ObservationKind::WaitingForInput);
        assert_eq!(
            rows[0].last_activity_at.as_deref(),
            Some("2026-08-04T04:05:00.000Z")
        );
        assert_eq!(
            rows[0].evidence_summary.as_deref(),
            Some("Codex is waiting for structured user input")
        );
    }

    #[test]
    fn structured_user_input_output_clears_waiting_for_input() {
        let temp = tempdir().expect("temp dir");
        let session_dir = temp.path().join("2026/08/04");
        fs::create_dir_all(&session_dir).expect("session dir");
        fs::write(
            session_dir.join("rollout-2026-08-04T04-00-00-019structured-input-cleared.jsonl"),
            r#"{"timestamp":"2026-08-04T04:00:00.000Z","type":"session_meta","payload":{"id":"019structured-input-cleared","cwd":"/Users/edy/project-input","originator":"Codex Desktop","source":"vscode"}}"#
                .to_string()
                + "\n"
                + r#"{"timestamp":"2026-08-04T04:05:00.000Z","type":"response_item","payload":{"type":"function_call","name":"request_user_input","arguments":"{\"questions\":[{\"id\":\"confirm\",\"question\":\"Continue?\"}]}","call_id":"call_input"}}"#
                + "\n"
                + r#"{"timestamp":"2026-08-04T04:06:00.000Z","type":"response_item","payload":{"type":"function_call_output","call_id":"call_input","output":"{\"confirm\":\"yes\"}"}}"#
                + "\n",
        )
        .expect("session file");

        let rows = discover_codex_observations_with_now(
            temp.path(),
            20,
            SystemTime::UNIX_EPOCH + Duration::from_secs(1_785_817_000),
        );

        assert_eq!(rows.len(), 1);
        assert_ne!(rows[0].kind, ObservationKind::WaitingForInput);
        assert_eq!(rows[0].kind, ObservationKind::Running);
    }

    #[test]
    fn unavailable_structured_user_input_is_not_waiting_for_input() {
        let temp = tempdir().expect("temp dir");
        let session_dir = temp.path().join("2026/08/04");
        fs::create_dir_all(&session_dir).expect("session dir");
        fs::write(
            session_dir.join("rollout-2026-08-04T04-00-00-019structured-input-unavailable.jsonl"),
            r#"{"timestamp":"2026-08-04T04:00:00.000Z","type":"session_meta","payload":{"id":"019structured-input-unavailable","cwd":"/Users/edy/project-input","originator":"Codex Desktop","source":"vscode"}}"#
                .to_string()
                + "\n"
                + r#"{"timestamp":"2026-08-04T04:05:00.000Z","type":"response_item","payload":{"type":"function_call","name":"request_user_input","arguments":"{\"questions\":[{\"id\":\"confirm\",\"question\":\"Continue?\"}]}","call_id":"call_input"}}"#
                + "\n"
                + r#"{"timestamp":"2026-08-04T04:06:00.000Z","type":"response_item","payload":{"type":"function_call_output","call_id":"call_input","output":"request_user_input is unavailable in Default mode"}}"#
                + "\n",
        )
        .expect("session file");

        let rows = discover_codex_observations_with_now(
            temp.path(),
            20,
            SystemTime::UNIX_EPOCH + Duration::from_secs(1_785_817_000),
        );

        assert_eq!(rows.len(), 1);
        assert_ne!(rows[0].kind, ObservationKind::WaitingForInput);
        assert_eq!(rows[0].kind, ObservationKind::Running);
    }

    #[test]
    fn interrupted_structured_user_input_is_stopped() {
        let temp = tempdir().expect("temp dir");
        let session_dir = temp.path().join("2026/08/04");
        fs::create_dir_all(&session_dir).expect("session dir");
        fs::write(
            session_dir.join("rollout-2026-08-04T04-00-00-019structured-input-interrupted.jsonl"),
            r#"{"timestamp":"2026-08-04T04:00:00.000Z","type":"session_meta","payload":{"id":"019structured-input-interrupted","cwd":"/Users/edy/project-input","originator":"Codex Desktop","source":"vscode"}}"#
                .to_string()
                + "\n"
                + r#"{"timestamp":"2026-08-04T04:05:00.000Z","type":"response_item","payload":{"type":"function_call","name":"request_user_input","arguments":"{\"questions\":[{\"id\":\"confirm\",\"question\":\"Continue?\"}]}","call_id":"call_input"}}"#
                + "\n"
                + r#"{"timestamp":"2026-08-04T04:06:00.000Z","type":"event_msg","payload":{"type":"turn_aborted","reason":"interrupted"}}"#
                + "\n",
        )
        .expect("session file");

        let rows = discover_codex_observations_with_now(
            temp.path(),
            20,
            SystemTime::UNIX_EPOCH + Duration::from_secs(1_785_817_000),
        );

        assert_eq!(rows.len(), 1);
        assert_ne!(rows[0].kind, ObservationKind::WaitingForInput);
        assert_eq!(rows[0].kind, ObservationKind::Stopped);
    }

    #[test]
    fn command_approval_output_clears_waiting_for_input() {
        let temp = tempdir().expect("temp dir");
        let session_dir = temp.path().join("2026/06/06");
        fs::create_dir_all(&session_dir).expect("session dir");
        fs::write(
            session_dir.join("rollout-2026-06-06T12-00-00-019approval-cleared.jsonl"),
            r#"{"timestamp":"2026-06-06T04:00:00.000Z","type":"session_meta","payload":{"id":"019approval-cleared","cwd":"/Users/edy/project-cli","originator":"Codex CLI","source":"cli"}}"#
                .to_string()
                + "\n"
                + r#"{"timestamp":"2026-06-06T04:05:00.000Z","type":"response_item","payload":{"type":"function_call","name":"exec_command","arguments":"{\"cmd\":\"npm run build\",\"sandbox_permissions\":\"require_escalated\",\"justification\":\"Need network access\"}","call_id":"call_cli"}}"#
                + "\n"
                + r#"{"timestamp":"2026-06-06T04:06:00.000Z","type":"response_item","payload":{"type":"function_call_output","call_id":"call_cli","output":"approved"}}"#
                + "\n",
        )
        .expect("session file");

        let rows = discover_codex_observations_with_now(
            temp.path(),
            20,
            SystemTime::UNIX_EPOCH + Duration::from_secs(1_780_720_000),
        );

        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].kind, ObservationKind::Running);
        assert_eq!(
            rows[0].last_activity_at.as_deref(),
            Some("2026-06-06T04:06:00.000Z")
        );
        assert_eq!(
            rows[0].evidence_summary.as_deref(),
            Some("local Codex JSONL activity observed")
        );
    }

    #[test]
    fn interrupted_command_approval_is_stopped() {
        let temp = tempdir().expect("temp dir");
        let session_dir = temp.path().join("2026/06/06");
        fs::create_dir_all(&session_dir).expect("session dir");
        fs::write(
            session_dir.join("rollout-2026-06-06T12-00-00-019approval-interrupted.jsonl"),
            r#"{"timestamp":"2026-06-06T04:00:00.000Z","type":"session_meta","payload":{"id":"019approval-interrupted","cwd":"/Users/edy/project-cli","originator":"Codex CLI","source":"cli"}}"#
                .to_string()
                + "\n"
                + r#"{"timestamp":"2026-06-06T04:05:00.000Z","type":"response_item","payload":{"type":"function_call","name":"exec_command","arguments":"{\"cmd\":\"git pull --ff-only origin develop\",\"sandbox_permissions\":\"require_escalated\",\"justification\":\"Need approval\"}","call_id":"call_pending"}}"#
                + "\n"
                + r#"{"timestamp":"2026-06-06T04:06:00.000Z","type":"event_msg","payload":{"type":"turn_aborted","reason":"interrupted"}}"#
                + "\n",
        )
        .expect("session file");

        let rows = discover_codex_observations_with_now(
            temp.path(),
            20,
            SystemTime::UNIX_EPOCH + Duration::from_secs(1_780_720_000),
        );

        assert_eq!(rows.len(), 1);
        assert_ne!(rows[0].kind, ObservationKind::WaitingForInput);
        assert_eq!(rows[0].kind, ObservationKind::Stopped);
        assert_eq!(
            rows[0].evidence_summary.as_deref(),
            Some("local Codex JSONL activity observed")
        );
    }

    #[test]
    fn marks_old_incomplete_sessions_as_insufficient_evidence() {
        let temp = tempdir().expect("temp dir");
        let session_dir = temp.path().join("2026/06/03");
        fs::create_dir_all(&session_dir).expect("session dir");
        fs::write(
            session_dir.join("rollout-2026-06-03T01-00-00-019old.jsonl"),
            r#"{"timestamp":"2026-06-03T01:00:00.000Z","type":"session_meta","payload":{"id":"019old","cwd":"/Users/edy/project-c","originator":"Codex Desktop"}}"#
                .to_string()
                + "\n",
        )
        .expect("session file");

        let rows = discover_codex_observations_with_now(
            temp.path(),
            20,
            SystemTime::UNIX_EPOCH + Duration::from_secs(1_780_470_000),
        );

        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].kind, ObservationKind::InsufficientEvidence);
    }

    #[test]
    fn sqlite_threads_use_jsonl_task_complete_as_completion_signal() {
        let temp = tempdir().expect("temp dir");
        let state_db = temp.path().join("state_5.sqlite");
        let session_dir = temp.path().join("2026/06/03");
        fs::create_dir_all(&session_dir).expect("session dir");
        let rollout_path = session_dir.join("rollout-2026-06-05T16-00-00-019desktop.jsonl");
        fs::write(
            &rollout_path,
            r#"{"timestamp":"2026-06-05T08:00:00.000Z","type":"session_meta","payload":{"id":"019desktop","cwd":"/Users/edy/wmhcar","originator":"Codex Desktop","source":"vscode"}}"#
                .to_string()
                + "\n"
                + r#"{"timestamp":"2026-06-05T08:20:00.000Z","type":"event_msg","payload":{"type":"task_complete"}}"#
                + "\n",
        )
        .expect("session file");

        std::process::Command::new("sqlite3")
            .arg(&state_db)
            .arg(format!(
                "create table threads (id text primary key, rollout_path text not null, created_at integer not null, updated_at integer not null, source text not null, model_provider text not null, cwd text not null, title text not null, sandbox_policy text not null, approval_mode text not null, tokens_used integer not null default 0, has_user_event integer not null default 0, archived integer not null default 0, archived_at integer, git_sha text, git_branch text, git_origin_url text, cli_version text not null default '', first_user_message text not null default '', agent_nickname text, agent_role text, memory_mode text not null default 'enabled', model text, reasoning_effort text, agent_path text, created_at_ms integer, updated_at_ms integer, thread_source text, preview text not null default '');
                 insert into threads (id, rollout_path, created_at, updated_at, source, model_provider, cwd, title, sandbox_policy, approval_mode, updated_at_ms, thread_source, preview)
                 values ('019desktop', '{}', 1780646400, 1780647600, 'vscode', 'OpenAI', '/Users/edy/wmhcar', '排查用车详情地图卡顿', '{{\"type\":\"disabled\"}}', 'never', 1780647600000, 'user', '排查用车详情地图卡顿');",
                rollout_path.display()
            ))
            .status()
            .expect("create state db");

        let rows = discover_codex_observations_with_state_db(
            &state_db,
            temp.path(),
            20,
            SystemTime::UNIX_EPOCH + Duration::from_secs(1_780_652_000),
        );

        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].session_id, "019desktop");
        assert_eq!(rows[0].label.as_deref(), Some("排查用车详情地图卡顿"));
        assert_eq!(rows[0].kind, ObservationKind::CompletedImmediate);
        assert_eq!(rows[0].jump_target, JumpTarget::Desktop);
        assert_eq!(rows[0].thread_source.as_deref(), Some("user"));
    }

    #[test]
    fn sqlite_subagent_thread_by_id_preserves_parent_session_id_from_jsonl() {
        let temp = tempdir().expect("temp dir");
        let state_db = temp.path().join("state_5.sqlite");
        let session_dir = temp.path().join("2026/06/17");
        fs::create_dir_all(&session_dir).expect("session dir");
        let rollout_path = session_dir.join("rollout-2026-06-17T18-08-11-019child.jsonl");
        fs::write(
            &rollout_path,
            r#"{"timestamp":"2026-06-17T10:08:11.000Z","type":"session_meta","payload":{"id":"019child","parent_thread_id":"019parent","cwd":"/Users/edy/hose/tmc/MOS","originator":"codex-tui","source":{"subagent":{"thread_spawn":{"parent_thread_id":"019parent","depth":1}}}},"thread_source":"subagent"}"#
                .to_string()
                + "\n"
                + r#"{"timestamp":"2026-06-17T10:20:00.000Z","type":"event_msg","payload":{"type":"task_complete"}}"#
                + "\n",
        )
        .expect("session file");
        create_threads_table(&state_db);
        std::process::Command::new("sqlite3")
            .arg(&state_db)
            .arg(format!(
                "insert into threads (id, rollout_path, created_at, updated_at, source, model_provider, cwd, title, sandbox_policy, approval_mode, updated_at_ms, thread_source, preview)
                 values ('019child', '{}', 1781690891, 1781691600, 'vscode', 'OpenAI', '/Users/edy/hose/tmc/MOS', 'Review Task 2 implementation', '{{\"type\":\"disabled\"}}', 'never', 1781691600000, 'subagent', 'Review Task 2 implementation');",
                rollout_path.display()
            ))
            .status()
            .expect("insert thread");

        let row = discover_codex_observation_by_id(
            &state_db,
            "019child",
            SystemTime::UNIX_EPOCH + Duration::from_secs(1_781_692_000),
        )
        .expect("subagent observation");

        assert_eq!(row.thread_source.as_deref(), Some("subagent"));
        assert_eq!(row.parent_session_id.as_deref(), Some("019parent"));
    }

    #[test]
    fn sqlite_thread_discovery_keeps_a_parent_when_newer_subagents_exceed_the_limit() {
        let temp = tempdir().expect("temp dir");
        let state_db = temp.path().join("state_5.sqlite");
        create_threads_table(&state_db);
        insert_thread(
            &state_db,
            "019parent-capacity",
            "/tmp/missing-parent-capacity.jsonl",
            "/Users/edy/project-parent",
            "Parent session",
            1_781_692_000_000,
        );

        let child_ids = [
            "019child-capacity-a",
            "019child-capacity-b",
            "019child-capacity-c",
        ];
        for (offset, child_id) in child_ids.iter().enumerate() {
            insert_thread(
                &state_db,
                child_id,
                &format!("/tmp/missing-{child_id}.jsonl"),
                "/Users/edy/project-parent",
                "Child session",
                1_781_693_000_000 + offset as i64,
            );
        }
        std::process::Command::new("sqlite3")
            .arg(&state_db)
            .arg(
                "create table thread_spawn_edges (child_thread_id text primary key, parent_thread_id text not null);
                 update threads set thread_source = 'subagent' where id like '019child-capacity-%';
                 insert into thread_spawn_edges (child_thread_id, parent_thread_id) values
                    ('019child-capacity-a', '019parent-capacity'),
                    ('019child-capacity-b', '019parent-capacity'),
                    ('019child-capacity-c', '019parent-capacity');",
            )
            .status()
            .expect("create subagent edges");

        let rows = discover_codex_observations_with_state_db(
            &state_db,
            temp.path(),
            1,
            SystemTime::UNIX_EPOCH + Duration::from_secs(1_781_694_000),
        );

        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].session_id, "019parent-capacity");
        assert_eq!(rows[0].thread_source.as_deref(), Some("user"));
    }

    #[test]
    fn sqlite_thread_discovery_uses_spawn_edges_to_exclude_misclassified_children() {
        let temp = tempdir().expect("temp dir");
        let state_db = temp.path().join("state_5.sqlite");
        create_threads_table(&state_db);
        insert_thread(
            &state_db,
            "019parent-edge-capacity",
            "/tmp/missing-parent-edge-capacity.jsonl",
            "/Users/edy/project-parent",
            "Parent session",
            1_781_692_000_000,
        );
        insert_thread(
            &state_db,
            "019child-edge-capacity",
            "/tmp/missing-child-edge-capacity.jsonl",
            "/Users/edy/project-parent",
            "Misclassified child session",
            1_781_693_000_000,
        );
        std::process::Command::new("sqlite3")
            .arg(&state_db)
            .arg(
                "create table thread_spawn_edges (child_thread_id text primary key, parent_thread_id text not null);
                 insert into thread_spawn_edges (child_thread_id, parent_thread_id)
                    values ('019child-edge-capacity', '019parent-edge-capacity');",
            )
            .status()
            .expect("create child spawn edge");

        let rows = discover_codex_observations_with_state_db(
            &state_db,
            temp.path(),
            1,
            SystemTime::UNIX_EPOCH + Duration::from_secs(1_781_694_000),
        );

        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].session_id, "019parent-edge-capacity");
    }

    #[test]
    fn sqlite_list_uses_jsonl_subagent_metadata_and_refills_the_limit() {
        let temp = tempdir().expect("temp dir");
        let state_db = temp.path().join("state_5.sqlite");
        let session_dir = temp.path().join("2026/08/13");
        fs::create_dir_all(&session_dir).expect("session dir");
        let child_path = session_dir.join("rollout-2026-08-13T10-00-00-019child-jsonl-source.jsonl");
        let parent_path = session_dir.join("rollout-2026-08-13T09-00-00-019parent-jsonl-source.jsonl");
        fs::write(
            &child_path,
            r#"{"timestamp":"2026-08-13T02:00:00.000Z","type":"session_meta","payload":{"id":"019child-jsonl-source","cwd":"/Users/edy/project-child","originator":"codex-tui","thread_source":"subagent"}}
{"timestamp":"2026-08-13T02:01:00.000Z","type":"event_msg","payload":{"type":"agent_message","message":"child working"}}
"#,
        )
        .expect("child session file");
        fs::write(
            &parent_path,
            r#"{"timestamp":"2026-08-13T01:00:00.000Z","type":"session_meta","payload":{"id":"019parent-jsonl-source","cwd":"/Users/edy/project-parent","originator":"Codex Desktop","thread_source":"user"}}
{"timestamp":"2026-08-13T01:01:00.000Z","type":"event_msg","payload":{"type":"agent_message","message":"parent working"}}
"#,
        )
        .expect("parent session file");
        create_threads_table(&state_db);
        insert_thread(
            &state_db,
            "019child-jsonl-source",
            child_path.to_string_lossy().as_ref(),
            "/Users/edy/project-child",
            "Child session",
            1_786_051_600_000,
        );
        insert_thread(
            &state_db,
            "019parent-jsonl-source",
            parent_path.to_string_lossy().as_ref(),
            "/Users/edy/project-parent",
            "Parent session",
            1_786_048_000_000,
        );

        let rows = discover_codex_observations_with_state_db(
            &state_db,
            temp.path(),
            1,
            SystemTime::UNIX_EPOCH + Duration::from_secs(1_786_052_000),
        );

        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].session_id, "019parent-jsonl-source");
    }

    #[test]
    fn state_db_thread_summary_reads_spawn_edge_in_the_same_statement() {
        let from_clause = super::thread_summary_from_clause();
        assert!(from_clause.contains("left join thread_spawn_edges"));
        assert!(from_clause.contains("thread_spawn_edges.child_thread_id = threads.id"));

        let select = super::thread_summary_json_select();
        assert!(select.contains("'parent_session_id', thread_spawn_edges.parent_thread_id"));
    }

    #[test]
    fn state_db_thread_summary_preserves_spawn_edge_parent_id() {
        let thread = super::parse_thread_summary_json(
            r#"{"id":"019child","rollout_path":"/tmp/019child.jsonl","updated_at_ms":1781691600000,"source":"vscode","cwd":"/Users/edy/hose/tmc/MOS","title":"Child task","archived":0,"agent_nickname":"Averroes","thread_source":"subagent","preview":"Child task","parent_session_id":"019parent"}"#,
        )
        .expect("parse thread summary");

        assert_eq!(thread.parent_session_id.as_deref(), Some("019parent"));
    }

    #[test]
    fn sqlite_threads_with_incompatible_spawn_edge_schema_keep_thread_summaries() {
        let temp = tempdir().expect("temp dir");
        let state_db = temp.path().join("state_5.sqlite");
        create_threads_table(&state_db);
        insert_thread(
            &state_db,
            "019legacy-edge-schema",
            "/tmp/missing-legacy-edge-schema.jsonl",
            "/Users/edy/project",
            "Legacy edge schema",
            1_781_691_600_000,
        );
        std::process::Command::new("sqlite3")
            .arg(&state_db)
            .arg("create table thread_spawn_edges (child_thread_id text primary key);")
            .status()
            .expect("create incompatible spawn edge table");

        let rows = discover_codex_observations_with_state_db(
            &state_db,
            temp.path(),
            20,
            SystemTime::UNIX_EPOCH + Duration::from_secs(1_781_692_000),
        );

        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].session_id, "019legacy-edge-schema");
        assert_eq!(rows[0].parent_session_id, None);
    }

    #[test]
    fn sqlite_subagent_thread_by_id_uses_spawn_edge_when_tail_omits_session_metadata() {
        let temp = tempdir().expect("temp dir");
        let state_db = temp.path().join("state_5.sqlite");
        let session_dir = temp.path().join("2026/06/17");
        fs::create_dir_all(&session_dir).expect("session dir");
        let rollout_path = session_dir.join("rollout-2026-06-17T18-08-11-019child.jsonl");
        let mut session_content = r#"{"timestamp":"2026-06-17T10:08:11.000Z","type":"session_meta","payload":{"id":"019child","parent_thread_id":"019parent","cwd":"/Users/edy/hose/tmc/MOS","thread_source":"subagent"}}"#
            .to_string();
        session_content.push('\n');
        session_content.push_str(&"x".repeat(super::SESSION_TAIL_READ_BYTES as usize + 1));
        session_content.push('\n');
        session_content.push_str(
            r#"{"timestamp":"2026-06-17T10:20:00.000Z","type":"event_msg","payload":{"type":"turn_aborted"}}"#,
        );
        session_content.push('\n');
        fs::write(&rollout_path, session_content).expect("session file");

        create_threads_table(&state_db);
        insert_thread(
            &state_db,
            "019child",
            rollout_path.to_string_lossy().as_ref(),
            "/Users/edy/hose/tmc/MOS",
            "Review Task 2 implementation",
            1_781_691_600_000,
        );
        std::process::Command::new("sqlite3")
            .arg(&state_db)
            .arg(
                "create table thread_spawn_edges (child_thread_id text primary key, parent_thread_id text not null);\n                 insert into thread_spawn_edges (child_thread_id, parent_thread_id) values ('019child', '019parent');",
            )
            .status()
            .expect("create spawn edge");

        let row = discover_codex_observation_by_id(
            &state_db,
            "019child",
            SystemTime::UNIX_EPOCH + Duration::from_secs(1_781_692_000),
        )
        .expect("subagent observation");

        assert_eq!(row.kind, ObservationKind::Stopped);
        assert_eq!(row.parent_session_id.as_deref(), Some("019parent"));
    }

    #[test]
    fn sqlite_subagent_thread_by_id_reads_header_metadata_when_tail_omits_it() {
        let temp = tempdir().expect("temp dir");
        let state_db = temp.path().join("state_5.sqlite");
        let session_dir = temp.path().join("2026/08/13");
        fs::create_dir_all(&session_dir).expect("session dir");
        let rollout_path = session_dir.join("rollout-2026-08-13T10-00-00-019child-header.jsonl");
        let mut session_content = r#"{"timestamp":"2026-08-13T02:00:00.000Z","type":"session_meta","payload":{"id":"019child-header","parent_thread_id":"019parent-header","cwd":"/Users/edy/project-child","originator":"codex-tui","thread_source":"subagent"}}"#
            .to_string();
        session_content.push('\n');
        session_content.push_str(&"x".repeat(super::SESSION_TAIL_READ_BYTES as usize + 1));
        session_content.push('\n');
        session_content.push_str(
            r#"{"timestamp":"2026-08-13T02:20:00.000Z","type":"event_msg","payload":{"type":"turn_aborted"}}"#,
        );
        session_content.push('\n');
        fs::write(&rollout_path, session_content).expect("session file");

        create_threads_table(&state_db);
        insert_thread(
            &state_db,
            "019child-header",
            rollout_path.to_string_lossy().as_ref(),
            "/Users/edy/project-child",
            "Child task",
            1_786_052_000_000,
        );

        let row = discover_codex_observation_by_id(
            &state_db,
            "019child-header",
            SystemTime::UNIX_EPOCH + Duration::from_secs(1_786_052_100),
        )
        .expect("subagent observation");

        assert_eq!(row.kind, ObservationKind::Stopped);
        assert_eq!(row.thread_source.as_deref(), Some("subagent"));
        assert_eq!(row.parent_session_id.as_deref(), Some("019parent-header"));
    }

    #[test]
    fn sqlite_list_refills_after_header_only_subagent_metadata() {
        let temp = tempdir().expect("temp dir");
        let state_db = temp.path().join("state_5.sqlite");
        let session_dir = temp.path().join("2026/08/13");
        fs::create_dir_all(&session_dir).expect("session dir");
        let child_path = session_dir.join("rollout-2026-08-13T10-00-00-019child-header-list.jsonl");
        let parent_path = session_dir.join("rollout-2026-08-13T09-00-00-019parent-header-list.jsonl");
        let mut child_content = r#"{"timestamp":"2026-08-13T02:00:00.000Z","type":"session_meta","payload":{"id":"019child-header-list","cwd":"/Users/edy/project-child","originator":"codex-tui","thread_source":"subagent"}}"#
            .to_string();
        child_content.push('\n');
        child_content.push_str(&"x".repeat(super::SESSION_TAIL_READ_BYTES as usize + 1));
        child_content.push('\n');
        child_content.push_str(
            r#"{"timestamp":"2026-08-13T02:20:00.000Z","type":"event_msg","payload":{"type":"agent_message","message":"child working"}}"#,
        );
        child_content.push('\n');
        fs::write(&child_path, child_content).expect("child session file");
        fs::write(
            &parent_path,
            r#"{"timestamp":"2026-08-13T01:00:00.000Z","type":"session_meta","payload":{"id":"019parent-header-list","cwd":"/Users/edy/project-parent","originator":"Codex Desktop","thread_source":"user"}}
{"timestamp":"2026-08-13T01:20:00.000Z","type":"event_msg","payload":{"type":"agent_message","message":"parent working"}}
"#,
        )
        .expect("parent session file");

        create_threads_table(&state_db);
        insert_thread(
            &state_db,
            "019child-header-list",
            child_path.to_string_lossy().as_ref(),
            "/Users/edy/project-child",
            "Child task",
            1_786_052_000_000,
        );
        insert_thread(
            &state_db,
            "019parent-header-list",
            parent_path.to_string_lossy().as_ref(),
            "/Users/edy/project-parent",
            "Parent task",
            1_786_048_000_000,
        );

        let rows = discover_codex_observations_with_state_db(
            &state_db,
            temp.path(),
            1,
            SystemTime::UNIX_EPOCH + Duration::from_secs(1_786_052_100),
        );

        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].session_id, "019parent-header-list");
    }

    #[test]
    fn sqlite_thread_update_after_task_complete_marks_completion_as_read() {
        let temp = tempdir().expect("temp dir");
        let state_db = temp.path().join("state_5.sqlite");
        let session_dir = temp.path().join("2026/06/05");
        fs::create_dir_all(&session_dir).expect("session dir");
        let rollout_path = session_dir.join("rollout-2026-06-05T16-00-00-019read.jsonl");
        fs::write(
            &rollout_path,
            r#"{"timestamp":"2026-06-05T08:00:00.000Z","type":"session_meta","payload":{"id":"019read","cwd":"/Users/edy/agent-session-inbox","originator":"Codex Desktop","source":"vscode"}}"#
                .to_string()
                + "\n"
                + r#"{"timestamp":"2026-06-05T08:20:00.000Z","type":"event_msg","payload":{"type":"task_complete"}}"#
                + "\n",
        )
        .expect("session file");
        create_threads_table(&state_db);
        insert_thread(
            &state_db,
            "019read",
            rollout_path.to_string_lossy().as_ref(),
            "/Users/edy/agent-session-inbox",
            "按照迁移过来的文档继续吧",
            1_780_648_200_000,
        );

        let rows = discover_codex_observations_with_state_db(
            &state_db,
            temp.path(),
            20,
            SystemTime::UNIX_EPOCH + Duration::from_secs(1_780_648_800),
        );

        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].kind, ObservationKind::Completed);
        assert_eq!(
            rows[0].last_activity_at.as_deref(),
            Some("2026-06-05T08:30:00.000Z")
        );
    }

    #[test]
    fn sqlite_thread_update_uses_configured_follow_up_boundary() {
        let temp = tempdir().expect("temp dir");
        let state_db = temp.path().join("state_5.sqlite");
        let session_dir = temp.path().join("2026/06/05");
        fs::create_dir_all(&session_dir).expect("session dir");
        let rollout_path = session_dir.join("rollout-2026-06-05T16-00-00-019read.jsonl");
        fs::write(
            &rollout_path,
            r#"{"timestamp":"2026-06-05T08:00:00.000Z","type":"session_meta","payload":{"id":"019read","cwd":"/Users/edy/agent-session-inbox","originator":"Codex Desktop","source":"vscode"}}"#
                .to_string()
                + "\n"
                + r#"{"timestamp":"2026-06-05T08:20:00.000Z","type":"event_msg","payload":{"type":"task_complete"}}"#
                + "\n",
        )
        .expect("session file");
        create_threads_table(&state_db);
        insert_thread(
            &state_db,
            "019read",
            rollout_path.to_string_lossy().as_ref(),
            "/Users/edy/agent-session-inbox",
            "按照迁移过来的文档继续吧",
            1_780_648_200_000,
        );

        let at_boundary = discover_codex_observations_with_state_db_and_follow_up_window(
            &state_db,
            temp.path(),
            20,
            SystemTime::UNIX_EPOCH + Duration::from_secs(1_780_650_900),
            Duration::from_secs(45 * 60),
        );
        let after_boundary = discover_codex_observations_with_state_db_and_follow_up_window(
            &state_db,
            temp.path(),
            20,
            SystemTime::UNIX_EPOCH + Duration::from_millis(1_780_650_900_001),
            Duration::from_secs(45 * 60),
        );

        assert_eq!(at_boundary[0].kind, ObservationKind::Completed);
        assert_eq!(after_boundary[0].kind, ObservationKind::CompletedStale);
    }

    #[test]
    fn sqlite_thread_update_at_same_millisecond_as_task_complete_stays_unread() {
        let temp = tempdir().expect("temp dir");
        let state_db = temp.path().join("state_5.sqlite");
        let session_dir = temp.path().join("2026/06/06");
        fs::create_dir_all(&session_dir).expect("session dir");
        let rollout_path =
            session_dir.join("rollout-2026-06-06T12-24-30-019same-ms.jsonl");
        fs::write(
            &rollout_path,
            r#"{"timestamp":"2026-06-06T04:00:00.000Z","type":"session_meta","payload":{"id":"019same-ms","cwd":"/Users/edy/wmhcar","originator":"Codex Desktop","source":"vscode"}}"#
                .to_string()
                + "\n"
                + r#"{"timestamp":"2026-06-06T04:24:30.041Z","type":"event_msg","payload":{"type":"task_complete"}}"#
                + "\n",
        )
        .expect("session file");
        create_threads_table(&state_db);
        insert_thread(
            &state_db,
            "019same-ms",
            rollout_path.to_string_lossy().as_ref(),
            "/Users/edy/wmhcar",
            "限制步行导航2KM显示",
            1_780_719_870_041,
        );

        let rows = discover_codex_observations_with_state_db(
            &state_db,
            temp.path(),
            20,
            SystemTime::UNIX_EPOCH + Duration::from_secs(1_780_722_000),
        );

        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].kind, ObservationKind::CompletedImmediate);
        assert_eq!(
            rows[0].last_activity_at.as_deref(),
            Some("2026-06-06T04:24:30.041Z")
        );
    }

    #[test]
    fn stale_unarchived_desktop_threads_are_idle_not_running() {
        let temp = tempdir().expect("temp dir");
        let state_db = temp.path().join("state_5.sqlite");
        let session_dir = temp.path().join("2026/06/03");
        fs::create_dir_all(&session_dir).expect("session dir");
        let rollout_path = session_dir.join("rollout-2026-06-03T02-00-00-019stale.jsonl");
        fs::write(
            &rollout_path,
            r#"{"timestamp":"2026-06-03T02:00:00.000Z","type":"session_meta","payload":{"id":"019stale","cwd":"/Users/edy/wmmeal","originator":"Codex Desktop","source":"vscode"}}"#
                .to_string()
                + "\n",
        )
        .expect("session file");

        std::process::Command::new("sqlite3")
            .arg(&state_db)
            .arg(format!(
                "create table threads (id text primary key, rollout_path text not null, created_at integer not null, updated_at integer not null, source text not null, model_provider text not null, cwd text not null, title text not null, sandbox_policy text not null, approval_mode text not null, tokens_used integer not null default 0, has_user_event integer not null default 0, archived integer not null default 0, archived_at integer, git_sha text, git_branch text, git_origin_url text, cli_version text not null default '', first_user_message text not null default '', agent_nickname text, agent_role text, memory_mode text not null default 'enabled', model text, reasoning_effort text, agent_path text, created_at_ms integer, updated_at_ms integer, thread_source text, preview text not null default '');
                 insert into threads (id, rollout_path, created_at, updated_at, source, model_provider, cwd, title, sandbox_policy, approval_mode, updated_at_ms, thread_source, preview)
                 values ('019stale', '{}', 1780452000, 1780452000, 'vscode', 'OpenAI', '/Users/edy/wmmeal', 'update the dep @hosemall/mall-component@2.7.44', '{{\"type\":\"disabled\"}}', 'never', 1780452000000, 'user', 'update the dep @hosemall/mall-component@2.7.44');",
                rollout_path.display()
            ))
            .status()
            .expect("create state db");

        let rows = discover_codex_observations_with_state_db(
            &state_db,
            temp.path(),
            20,
            SystemTime::UNIX_EPOCH + Duration::from_secs(1_780_466_400),
        );

        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].kind, ObservationKind::Idle);
    }

    #[test]
    fn desktop_turn_aborted_thread_stays_stopped_despite_recent_sqlite_update() {
        let temp = tempdir().expect("temp dir");
        let state_db = temp.path().join("state_5.sqlite");
        let session_dir = temp.path().join("2026/06/15");
        fs::create_dir_all(&session_dir).expect("session dir");
        let rollout_path = session_dir.join("rollout-2026-06-15T11-07-35-019paused.jsonl");
        fs::write(
            &rollout_path,
            r#"{"timestamp":"2026-06-15T03:07:36.032Z","type":"session_meta","payload":{"id":"019paused","cwd":"/Users/edy/hose/tmc/wmhcar","originator":"Codex Desktop","source":"vscode"}}"#
                .to_string()
                + "\n"
                + r#"{"timestamp":"2026-06-15T03:30:56.909Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<turn_aborted>\nThe user interrupted the previous turn on purpose.\n</turn_aborted>"}]}}"#
                + "\n"
                + r#"{"timestamp":"2026-06-15T03:30:56.989Z","type":"event_msg","payload":{"type":"turn_aborted","reason":"interrupted"}}"#
                + "\n",
        )
        .expect("session file");
        create_threads_table(&state_db);
        insert_thread(
            &state_db,
            "019paused",
            rollout_path.to_string_lossy().as_ref(),
            "/Users/edy/hose/tmc/wmhcar",
            "调整 IM 接口实现",
            1_781_494_256_989,
        );

        let rows = discover_codex_observations_with_state_db(
            &state_db,
            temp.path(),
            20,
            SystemTime::UNIX_EPOCH + Duration::from_secs(1_781_494_400),
        );

        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].kind, ObservationKind::Stopped);
        assert_eq!(rows[0].jump_target, JumpTarget::Desktop);
    }

    #[test]
    fn recent_active_hook_event_promotes_stale_thread_to_running() {
        let temp = tempdir().expect("temp dir");
        let state_db = temp.path().join("state_5.sqlite");
        let hook_events = temp.path().join("hook-events.jsonl");
        let session_dir = temp.path().join("2026/06/03");
        fs::create_dir_all(&session_dir).expect("session dir");
        let rollout_path = session_dir.join("rollout-2026-06-03T02-00-00-019hook-running.jsonl");
        fs::write(
            &rollout_path,
            r#"{"timestamp":"2026-06-03T02:00:00.000Z","type":"session_meta","payload":{"id":"019hook-running","cwd":"/Users/edy/hook-project","originator":"Codex Desktop","source":"vscode"}}"#,
        )
        .expect("session file");
        create_threads_table(&state_db);
        insert_thread(
            &state_db,
            "019hook-running",
            rollout_path.to_string_lossy().as_ref(),
            "/Users/edy/hook-project",
            "Hook running thread",
            1_780_452_000_000,
        );
        fs::write(
            &hook_events,
            r#"{"timestamp":"2026-06-05T08:29:30.000Z","source":"codex-hook","eventType":"PreToolUse","sessionId":"019hook-running","workspacePath":"/Users/edy/hook-project"}"#,
        )
        .expect("hook events");

        let rows = discover_codex_observations_with_state_db_and_hooks(
            &state_db,
            temp.path(),
            &hook_events,
            20,
            SystemTime::UNIX_EPOCH + Duration::from_secs(1_780_648_800),
        );

        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].kind, ObservationKind::Running);
        assert_eq!(
            rows[0].last_activity_at.as_deref(),
            Some("2026-06-05T08:29:30.000Z")
        );
        assert_eq!(
            rows[0].evidence_summary.as_deref(),
            Some("Codex hook PreToolUse observed.")
        );
    }

    #[test]
    fn latest_stop_hook_does_not_promote_thread_to_running() {
        let temp = tempdir().expect("temp dir");
        let state_db = temp.path().join("state_5.sqlite");
        let hook_events = temp.path().join("hook-events.jsonl");
        let session_dir = temp.path().join("2026/06/03");
        fs::create_dir_all(&session_dir).expect("session dir");
        let rollout_path = session_dir.join("rollout-2026-06-03T02-00-00-019hook-stop.jsonl");
        fs::write(
            &rollout_path,
            r#"{"timestamp":"2026-06-03T02:00:00.000Z","type":"session_meta","payload":{"id":"019hook-stop","cwd":"/Users/edy/hook-project","originator":"Codex Desktop","source":"vscode"}}"#,
        )
        .expect("session file");
        create_threads_table(&state_db);
        insert_thread(
            &state_db,
            "019hook-stop",
            rollout_path.to_string_lossy().as_ref(),
            "/Users/edy/hook-project",
            "Hook stopped thread",
            1_780_452_000_000,
        );
        fs::write(
            &hook_events,
            r#"{"timestamp":"2026-06-05T08:28:30.000Z","source":"codex-hook","eventType":"PreToolUse","sessionId":"019hook-stop","workspacePath":"/Users/edy/hook-project"}
{"timestamp":"2026-06-05T08:29:30.000Z","source":"codex-hook","eventType":"Stop","sessionId":"019hook-stop","workspacePath":"/Users/edy/hook-project"}"#,
        )
        .expect("hook events");

        let rows = discover_codex_observations_with_state_db_and_hooks(
            &state_db,
            temp.path(),
            &hook_events,
            20,
            SystemTime::UNIX_EPOCH + Duration::from_secs(1_780_648_800),
        );

        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].kind, ObservationKind::Idle);
    }

    #[test]
    fn newer_hook_activity_reopens_completed_thread_as_running() {
        let temp = tempdir().expect("temp dir");
        let state_db = temp.path().join("state_5.sqlite");
        let hook_events = temp.path().join("hook-events.jsonl");
        let session_dir = temp.path().join("2026/06/05");
        fs::create_dir_all(&session_dir).expect("session dir");
        let rollout_path = session_dir.join("rollout-2026-06-05T08-00-00-019hook-newer.jsonl");
        fs::write(
            &rollout_path,
            r#"{"timestamp":"2026-06-05T08:00:00.000Z","type":"session_meta","payload":{"id":"019hook-newer","cwd":"/Users/edy/hook-project","originator":"Codex Desktop","source":"vscode"}}
{"timestamp":"2026-06-05T08:20:00.000Z","type":"event_msg","payload":{"type":"task_complete"}}"#,
        )
        .expect("session file");
        create_threads_table(&state_db);
        insert_thread(
            &state_db,
            "019hook-newer",
            rollout_path.to_string_lossy().as_ref(),
            "/Users/edy/hook-project",
            "Hook newer thread",
            1_780_648_000_000,
        );
        fs::write(
            &hook_events,
            r#"{"timestamp":"2026-06-05T08:29:30.000Z","source":"codex-hook","eventType":"UserPromptSubmit","sessionId":"019hook-newer","workspacePath":"/Users/edy/hook-project"}"#,
        )
        .expect("hook events");

        let rows = discover_codex_observations_with_state_db_and_hooks(
            &state_db,
            temp.path(),
            &hook_events,
            20,
            SystemTime::UNIX_EPOCH + Duration::from_secs(1_780_648_800),
        );

        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].kind, ObservationKind::Running);
        assert_eq!(
            rows[0].last_activity_at.as_deref(),
            Some("2026-06-05T08:29:30.000Z")
        );
    }

    #[test]
    fn older_hook_activity_does_not_hide_unread_completion() {
        let temp = tempdir().expect("temp dir");
        let state_db = temp.path().join("state_5.sqlite");
        let hook_events = temp.path().join("hook-events.jsonl");
        let session_dir = temp.path().join("2026/06/05");
        fs::create_dir_all(&session_dir).expect("session dir");
        let rollout_path = session_dir.join("rollout-2026-06-05T08-00-00-019hook-older.jsonl");
        fs::write(
            &rollout_path,
            r#"{"timestamp":"2026-06-05T08:00:00.000Z","type":"session_meta","payload":{"id":"019hook-older","cwd":"/Users/edy/hook-project","originator":"Codex Desktop","source":"vscode"}}
{"timestamp":"2026-06-05T08:20:00.000Z","type":"event_msg","payload":{"type":"task_complete"}}"#,
        )
        .expect("session file");
        create_threads_table(&state_db);
        insert_thread(
            &state_db,
            "019hook-older",
            rollout_path.to_string_lossy().as_ref(),
            "/Users/edy/hook-project",
            "Hook older thread",
            1_780_646_400_000,
        );
        fs::write(
            &hook_events,
            r#"{"timestamp":"2026-06-05T08:19:30.000Z","source":"codex-hook","eventType":"PreToolUse","sessionId":"019hook-older","workspacePath":"/Users/edy/hook-project"}"#,
        )
        .expect("hook events");

        let rows = discover_codex_observations_with_state_db_and_hooks(
            &state_db,
            temp.path(),
            &hook_events,
            20,
            SystemTime::UNIX_EPOCH + Duration::from_secs(1_780_648_800),
        );

        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].kind, ObservationKind::CompletedImmediate);
        assert_eq!(
            rows[0].last_activity_at.as_deref(),
            Some("2026-06-05T08:20:00.000Z")
        );
    }

    #[test]
    fn archived_threads_are_excluded_from_discovery() {
        let temp = tempdir().expect("temp dir");
        let state_db = temp.path().join("state_5.sqlite");
        let session_dir = temp.path().join("2026/05/26");
        fs::create_dir_all(&session_dir).expect("session dir");
        let rollout_path = session_dir.join("rollout-2026-05-26T15-00-00-019archived-old.jsonl");
        fs::write(
            &rollout_path,
            r#"{"timestamp":"2026-05-26T07:00:00.000Z","type":"session_meta","payload":{"id":"019archived-old","cwd":"/Users/edy/wmhcar","originator":"Codex Desktop","source":"vscode"}}"#
                .to_string()
                + "\n"
                + r#"{"timestamp":"2026-05-26T07:01:00.000Z","type":"event_msg","payload":{"type":"user_message","message":"构建发版分支\n"}}"#
                + "\n"
                + r#"{"timestamp":"2026-05-26T07:20:00.000Z","type":"event_msg","payload":{"type":"turn_aborted","reason":"interrupted"}}"#
                + "\n",
        )
        .expect("session file");

        std::process::Command::new("sqlite3")
            .arg(&state_db)
            .arg(format!(
                "create table threads (id text primary key, rollout_path text not null, created_at integer not null, updated_at integer not null, source text not null, model_provider text not null, cwd text not null, title text not null, sandbox_policy text not null, approval_mode text not null, tokens_used integer not null default 0, has_user_event integer not null default 0, archived integer not null default 0, archived_at integer, git_sha text, git_branch text, git_origin_url text, cli_version text not null default '', first_user_message text not null default '', agent_nickname text, agent_role text, memory_mode text not null default 'enabled', model text, reasoning_effort text, agent_path text, created_at_ms integer, updated_at_ms integer, thread_source text, preview text not null default '');
                 insert into threads (id, rollout_path, created_at, updated_at, source, model_provider, cwd, title, sandbox_policy, approval_mode, updated_at_ms, thread_source, preview, archived)
                 values ('019archived-old', '{}', 1779778800, 1779778800, 'vscode', 'OpenAI', '/Users/edy/wmhcar', '构建发版分支', '{{\"type\":\"disabled\"}}', 'never', 1779778800000, 'user', '构建发版分支', 1);",
                rollout_path.display()
            ))
            .status()
            .expect("create state db");

        let rows = discover_codex_observations_with_state_db(
            &state_db,
            temp.path(),
            20,
            SystemTime::UNIX_EPOCH + Duration::from_secs(1_780_646_400),
        );

        assert!(rows.is_empty());
    }

    #[test]
    fn tail_parser_reads_recent_completion_without_full_rollout_metadata() {
        let temp = tempdir().expect("temp dir");
        let rollout_path = temp.path().join("rollout-2026-06-05T16-00-00-019tail.jsonl");
        let mut content = String::from(
            r#"{"timestamp":"2026-06-05T08:00:00.000Z","type":"session_meta","payload":{"id":"019tail","cwd":"/Users/edy/large","originator":"Codex Desktop"}}"#,
        );
        content.push('\n');
        for index in 0..10_000 {
            content.push_str(&format!(
                r#"{{"timestamp":"2026-06-05T08:10:00.000Z","type":"response_item","payload":{{"index":{index},"message":"large historical payload with event_msg-like user text"}}}}"#
            ));
            content.push('\n');
        }
        content.push_str(
            r#"{"timestamp":"2026-06-05T08:20:00.000Z","type":"event_msg","payload":{"type":"task_complete"}}"#,
        );
        content.push('\n');
        fs::write(&rollout_path, content).expect("session file");

        let parsed = super::parse_session_file_tail_detailed(
            &rollout_path,
            SystemTime::UNIX_EPOCH + Duration::from_secs(1_780_648_800),
        )
        .expect("tail parse")
        .expect("tail observation");

        assert_eq!(parsed.observation.session_id, "019tail");
        assert_eq!(parsed.observation.kind, ObservationKind::CompletedImmediate);
        assert_eq!(
            parsed.observation.last_activity_at.as_deref(),
            Some("2026-06-05T08:20:00.000Z")
        );
        assert!(parsed.task_completed_at.is_some());
    }

    #[test]
    fn status_line_filter_skips_large_response_items() {
        assert!(super::should_parse_session_status_line(
            r#"{"timestamp":"2026-06-05T08:00:00.000Z","type":"session_meta","payload":{}}"#
        ));
        assert!(super::should_parse_session_status_line(
            r#"{"timestamp":"2026-06-05T08:20:00.000Z","type":"event_msg","payload":{"type":"task_complete"}}"#
        ));
        assert!(!super::should_parse_session_status_line(
            r#"{"timestamp":"2026-06-05T08:10:00.000Z","type":"response_item","payload":{"message":"large historical payload with event_msg-like user text"}}"#
        ));
        assert!(!super::should_parse_session_status_line(
            r#"{"timestamp":"2026-06-05T08:10:00.000Z","type":"response_item","payload":{"message":"literal \"type\":\"event_msg\" text"}}"#
        ));
    }

    #[test]
    fn looks_up_single_sqlite_thread_by_id_for_fast_jump() {
        let temp = tempdir().expect("temp dir");
        let state_db = temp.path().join("state_5.sqlite");
        create_threads_table(&state_db);
        insert_thread(
            &state_db,
            "019target",
            "/tmp/missing-target.jsonl",
            "/Users/edy/target",
            "Target thread",
            1_780_469_000_000,
        );
        insert_thread(
            &state_db,
            "019other",
            "/tmp/missing-other.jsonl",
            "/Users/edy/other",
            "Other thread",
            1_780_453_200_000,
        );

        let row = discover_codex_observation_by_id(
            &state_db,
            "019target",
            SystemTime::UNIX_EPOCH + Duration::from_secs(1_780_470_000),
        )
        .expect("target thread");

        assert_eq!(row.session_id, "019target");
        assert_eq!(row.label.as_deref(), Some("Target thread"));
        assert_eq!(row.workspace_path.as_deref(), Some("/Users/edy/target"));
        assert_eq!(row.kind, ObservationKind::Running);
        assert_eq!(row.jump_target, JumpTarget::Desktop);
    }

    #[test]
    fn sqlite_cli_thread_keeps_cli_jump_target_when_tail_lacks_session_meta() {
        let temp = tempdir().expect("temp dir");
        let state_db = temp.path().join("state_5.sqlite");
        let rollout_path = temp
            .path()
            .join("rollout-2026-06-06T12-00-00-019tail-cli-input.jsonl");
        fs::write(
            &rollout_path,
            r#"{"timestamp":"2026-06-06T04:05:00.000Z","type":"response_item","payload":{"type":"function_call","name":"exec_command","arguments":"{\"cmd\":\"git pull --ff-only origin develop\",\"sandbox_permissions\":\"require_escalated\",\"justification\":\"Need approval\"}","call_id":"call_cli"}}"#
                .to_string()
                + "\n",
        )
        .expect("session file");
        create_threads_table(&state_db);
        std::process::Command::new("sqlite3")
            .arg(&state_db)
            .arg(format!(
                "insert into threads (id, rollout_path, created_at, updated_at, source, model_provider, cwd, title, sandbox_policy, approval_mode, updated_at_ms, thread_source, preview)
                 values ('019tail-cli-input', '{}', 1780718400, 1780718700, 'cli', 'OpenAI', '/Users/edy/project-cli', 'CLI pending input', '{{\"type\":\"disabled\"}}', 'never', 1780718700000, 'user', 'CLI pending input');",
                rollout_path.display()
            ))
            .status()
            .expect("insert thread");

        let rows = discover_codex_observations_with_state_db(
            &state_db,
            temp.path(),
            20,
            SystemTime::UNIX_EPOCH + Duration::from_secs(1_780_720_801),
        );

        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].kind, ObservationKind::WaitingForInput);
        assert_eq!(rows[0].jump_target, JumpTarget::Cli);
    }

    #[test]
    fn default_state_db_path_prefers_newest_known_state_db() {
        let temp = tempdir().expect("temp dir");
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
        let temp = tempdir().expect("temp dir");
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

    fn create_threads_table(state_db: &std::path::Path) {
        std::process::Command::new("sqlite3")
            .arg(state_db)
            .arg("create table threads (id text primary key, rollout_path text not null, created_at integer not null, updated_at integer not null, source text not null, model_provider text not null, cwd text not null, title text not null, sandbox_policy text not null, approval_mode text not null, tokens_used integer not null default 0, has_user_event integer not null default 0, archived integer not null default 0, archived_at integer, git_sha text, git_branch text, git_origin_url text, cli_version text not null default '', first_user_message text not null default '', agent_nickname text, agent_role text, memory_mode text not null default 'enabled', model text, reasoning_effort text, agent_path text, created_at_ms integer, updated_at_ms integer, thread_source text, preview text not null default '');")
            .status()
            .expect("create threads table");
    }

    fn insert_thread(
        state_db: &std::path::Path,
        id: &str,
        rollout_path: &str,
        cwd: &str,
        title: &str,
        updated_at_ms: i64,
    ) {
        std::process::Command::new("sqlite3")
            .arg(state_db)
            .arg(format!(
                "insert into threads (id, rollout_path, created_at, updated_at, source, model_provider, cwd, title, sandbox_policy, approval_mode, updated_at_ms, thread_source, preview)
                 values ('{}', '{}', 1780452000, 1780453200, 'vscode', 'OpenAI', '{}', '{}', '{{\"type\":\"disabled\"}}', 'never', {}, 'user', '{}');",
                id, rollout_path, cwd, title, updated_at_ms, title
            ))
            .status()
            .expect("insert thread");
    }
}
