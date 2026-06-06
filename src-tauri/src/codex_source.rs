use std::collections::HashMap;
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, SystemTime};

use serde_json::Value;

use crate::domain::session::{JumpTarget, ObservationKind, SourceObservation};

const UNREAD_COMPLETION_TRACKING_START: &str = "2026-06-05T08:00:00.000Z";
const SESSION_TAIL_READ_BYTES: u64 = 128 * 1024;
const HOOK_ACTIVITY_FRESHNESS: Duration = Duration::from_secs(15 * 60);

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
struct CodexHookSignal {
    event_name: String,
    timestamp: String,
    timestamp_time: SystemTime,
    session_id: Option<String>,
    workspace_path: Option<String>,
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
    discover_codex_observations_with_state_db_and_hooks(
        state_db,
        sessions_root,
        &codex_hook_events_path(),
        limit,
        now,
    )
}

pub fn discover_codex_observations_with_state_db_and_hooks(
    state_db: &Path,
    sessions_root: &Path,
    hook_events_path: &Path,
    limit: usize,
    now: SystemTime,
) -> Vec<SourceObservation> {
    let threads = discover_threads_from_state_db(state_db, limit);
    if threads.is_empty() {
        return discover_codex_observations_with_now(sessions_root, limit, now);
    }

    let hook_signals = load_latest_hook_signals(hook_events_path);

    threads
        .into_iter()
        .filter_map(|thread| {
            let hook_signal = hook_signal_for_thread(&hook_signals, &thread);
            observation_from_thread(thread, hook_signal, now)
        })
        .collect()
}

pub fn discover_codex_observation_by_id(
    state_db: &Path,
    session_id: &str,
    now: SystemTime,
) -> Option<SourceObservation> {
    let thread = discover_thread_from_state_db_by_id(state_db, session_id)?;
    let hook_signals = load_latest_hook_signals(&codex_hook_events_path());
    let hook_signal = hook_signal_for_thread(&hook_signals, &thread);
    observation_from_thread(thread, hook_signal, now)
}

pub fn discover_codex_observations_with_now(
    sessions_root: &Path,
    limit: usize,
    now: SystemTime,
) -> Vec<SourceObservation> {
    let mut summaries = Vec::new();
    collect_session_files(sessions_root, &mut summaries);

    summaries.sort_by(|left, right| right.modified_at.cmp(&left.modified_at));

    summaries
        .into_iter()
        .filter_map(|summary| parse_session_file(&summary.path, now).ok().flatten())
        .take(limit)
        .collect()
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
    let content = read_file_tail(path, SESSION_TAIL_READ_BYTES)?;
    parse_session_content(path, &content, now)
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
    let mut session_id = None;
    let mut cwd = None;
    let mut agent_name = None;
    let mut session_name = None;
    let mut jump_target = JumpTarget::Unknown;
    let mut latest_timestamp = None;
    let mut task_completed_at = None;
    let mut last_activity_kind = ObservationKind::InsufficientEvidence;
    let mut last_agent_message = None;

    for line in content
        .lines()
        .filter(|line| should_parse_session_status_line(line))
    {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };

        if let Some(timestamp) = value.get("timestamp").and_then(Value::as_str) {
            latest_timestamp = Some(timestamp.to_string());
        }

        match value.get("type").and_then(Value::as_str) {
            Some("session_meta") => {
                if let Some(payload) = value.get("payload") {
                    session_id = payload
                        .get("id")
                        .and_then(Value::as_str)
                        .map(ToString::to_string)
                        .or(session_id);
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
                }
            }
            Some("event_msg") => {
                let event_type = value
                    .get("payload")
                    .and_then(|payload| payload.get("type"))
                    .and_then(Value::as_str);

                if event_type == Some("task_complete") {
                    last_activity_kind = ObservationKind::Completed;
                    task_completed_at = value
                        .get("timestamp")
                        .and_then(Value::as_str)
                        .and_then(parse_utc_timestamp)
                        .or(task_completed_at);
                } else if matches!(event_type, Some("user_message" | "agent_message")) {
                    last_activity_kind = ObservationKind::Running;
                }

                if let Some(message) = value
                    .get("payload")
                    .and_then(|payload| payload.get("message"))
                    .and_then(Value::as_str)
                {
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
    let is_tracked_unread_completion = latest_timestamp
        .as_deref()
        .zip(parse_utc_timestamp(UNREAD_COMPLETION_TRACKING_START))
        .and_then(|(last_activity_at, tracking_start)| {
            parse_utc_timestamp(last_activity_at)
                .map(|last_activity| last_activity.duration_since(tracking_start).is_ok())
        })
        .unwrap_or(false);
    let kind = if matches!(last_activity_kind, ObservationKind::Completed) {
        if is_tracked_unread_completion {
            ObservationKind::CompletedImmediate
        } else {
            ObservationKind::CompletedStale
        }
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

    let evidence_summary = last_agent_message
        .map(|message| truncate_for_summary(&message, 120))
        .or_else(|| Some("local Codex JSONL activity observed".to_string()));

    let mut observation = SourceObservation::new(session_id, kind)
        .with_label(label)
        .with_jump_target(jump_target);

    if let Some(agent_name) = agent_name {
        observation = observation.with_agent_name(agent_name);
    }

    if let Some(project_name) = project_name {
        observation = observation.with_project_name(project_name);
    }

    if let Some(cwd) = cwd {
        observation = observation.with_workspace(cwd);
    }

    if let Some(timestamp) = latest_timestamp {
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
            || line.contains("\"type\": \"event_msg\""))
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
}

fn discover_threads_from_state_db(state_db: &Path, limit: usize) -> Vec<ThreadSummary> {
    let query = format!(
        "{} from threads order by coalesce(updated_at_ms, updated_at * 1000) desc limit {};",
        thread_summary_json_select(),
        limit
    );
    let Ok(output) = Command::new("sqlite3")
        .arg("-batch")
        .arg("-readonly")
        .arg(state_db)
        .arg(query)
        .output()
    else {
        return Vec::new();
    };

    if !output.status.success() {
        return Vec::new();
    }

    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(parse_thread_summary_json)
        .collect()
}

fn discover_thread_from_state_db_by_id(state_db: &Path, session_id: &str) -> Option<ThreadSummary> {
    let query = format!(
        "{} from threads where id = '{}' limit 1;",
        thread_summary_json_select(),
        sqlite_string_literal(session_id)
    );
    let output = Command::new("sqlite3")
        .arg("-batch")
        .arg("-readonly")
        .arg(state_db)
        .arg(query)
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    String::from_utf8_lossy(&output.stdout)
        .lines()
        .find_map(parse_thread_summary_json)
}

fn thread_summary_json_select() -> &'static str {
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
        'preview', preview
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
    })
}

fn observation_from_thread(
    thread: ThreadSummary,
    hook_signal: Option<&CodexHookSignal>,
    now: SystemTime,
) -> Option<SourceObservation> {
    let parsed_jsonl = parse_session_file_tail_detailed(&thread.rollout_path, now).ok().flatten();
    let jsonl_observation = parsed_jsonl.as_ref().map(|parsed| &parsed.observation);
    let jump_target = jsonl_observation
        .as_ref()
        .map(|observation| observation.jump_target)
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
    let thread_completion_kind = completion_kind_from_last_activity_at(last_activity_at.as_deref(), now);
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

    if let Some(agent_name) = thread.agent_nickname.or(thread.thread_source).or(Some(thread.source)) {
        observation = observation.with_agent_name(agent_name);
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

fn completion_kind_from_last_activity_at(last_activity_at: Option<&str>, now: SystemTime) -> ObservationKind {
    let completion_age = last_activity_at
        .and_then(parse_utc_timestamp)
        .and_then(|last_activity| now.duration_since(last_activity).ok());

    if completion_age.is_some_and(|age| age <= Duration::from_secs(5 * 60)) {
        ObservationKind::CompletedImmediate
    } else if completion_age.is_some_and(|age| age <= Duration::from_secs(30 * 60)) {
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
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".codex")
        .join("state_5.sqlite")
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

fn session_id_from_path(path: &Path) -> Option<String> {
    let stem = path.file_stem()?.to_str()?;
    stem.rsplit('-').next().map(ToString::to_string)
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

fn parse_utc_timestamp(value: &str) -> Option<SystemTime> {
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
        discover_codex_observations_with_state_db_and_hooks,
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
    fn keeps_unread_task_complete_after_inspect_window_as_immediate_completion() {
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
            SystemTime::UNIX_EPOCH + Duration::from_secs(1_780_652_000),
        );

        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].kind, ObservationKind::CompletedImmediate);
    }

    #[test]
    fn treats_task_complete_before_tracking_baseline_as_stale_completed() {
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
            SystemTime::UNIX_EPOCH + Duration::from_secs(1_780_466_400),
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
    fn old_archived_threads_without_completion_evidence_are_idle() {
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

        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].kind, ObservationKind::CompletedStale);
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
