use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, SystemTime};

use serde_json::Value;

use crate::domain::session::{JumpTarget, ObservationKind, SourceObservation};

#[derive(Debug, Clone)]
struct SessionFileSummary {
    path: PathBuf,
    modified_at: Option<std::time::SystemTime>,
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
    let threads = discover_threads_from_state_db(state_db, limit);
    if threads.is_empty() {
        return discover_codex_observations_with_now(sessions_root, limit, now);
    }

    threads
        .into_iter()
        .filter_map(|thread| observation_from_thread(thread, now))
        .collect()
}

pub fn discover_codex_observation_by_id(
    state_db: &Path,
    session_id: &str,
    now: SystemTime,
) -> Option<SourceObservation> {
    let thread = discover_thread_from_state_db_by_id(state_db, session_id)?;
    observation_from_thread(thread, now)
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
    let content = fs::read_to_string(path)?;
    let mut session_id = None;
    let mut cwd = None;
    let mut agent_name = None;
    let mut session_name = None;
    let mut jump_target = JumpTarget::Unknown;
    let mut latest_timestamp = None;
    let mut is_complete = false;
    let mut last_agent_message = None;

    for line in content.lines().filter(|line| !line.trim().is_empty()) {
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
                    is_complete = true;
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

    let kind = if is_complete {
        ObservationKind::Completed
    } else if latest_timestamp
        .as_deref()
        .and_then(parse_utc_timestamp)
        .and_then(|last_activity| now.duration_since(last_activity).ok())
        .is_some_and(|age| age <= Duration::from_secs(2 * 60 * 60))
    {
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

    Ok(Some(observation))
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

fn observation_from_thread(thread: ThreadSummary, now: SystemTime) -> Option<SourceObservation> {
    let jsonl_observation = parse_session_file(&thread.rollout_path, now).ok().flatten();
    let jump_target = jsonl_observation
        .as_ref()
        .map(|observation| observation.jump_target)
        .unwrap_or_else(|| jump_target_from_thread_source(&thread));
    let last_activity_at = jsonl_observation
        .as_ref()
        .and_then(|observation| observation.last_activity_at.clone())
        .or_else(|| thread.updated_at_ms.and_then(timestamp_ms_to_iso_utc));
    let kind = if thread.archived {
        jsonl_observation
            .as_ref()
            .map(|observation| observation.kind)
            .unwrap_or(ObservationKind::Completed)
    } else if matches!(jump_target, JumpTarget::Desktop) {
        ObservationKind::Running
    } else {
        jsonl_observation
            .as_ref()
            .map(|observation| observation.kind)
            .unwrap_or(ObservationKind::InsufficientEvidence)
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
    let evidence_summary = jsonl_observation
        .as_ref()
        .and_then(|observation| observation.evidence_summary.clone())
        .or_else(|| thread.preview.clone());

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

    if let Some(last_activity_at) = last_activity_at {
        observation = observation.with_last_activity(last_activity_at);
    }

    observation.evidence_summary = evidence_summary;
    Some(observation)
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
    let second = time_parts
        .next()?
        .split('.')
        .next()
        .and_then(|value| value.parse::<u32>().ok())?;

    let days = days_from_civil(year, month, day)?;
    let seconds = days
        .checked_mul(86_400)?
        .checked_add((hour as i64) * 3_600)?
        .checked_add((minute as i64) * 60)?
        .checked_add(second as i64)?;

    if seconds < 0 {
        return None;
    }

    Some(SystemTime::UNIX_EPOCH + Duration::from_secs(seconds as u64))
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
        let session_dir = temp.path().join("2026/06/03");
        fs::create_dir_all(&session_dir).expect("session dir");
        fs::write(
            session_dir.join("rollout-2026-06-03T11-00-00-019done.jsonl"),
            r#"{"timestamp":"2026-06-03T03:00:00.000Z","type":"session_meta","payload":{"id":"019done","cwd":"/Users/edy/project-b","originator":"Codex Desktop"}}"#
                .to_string()
                + "\n"
                + r#"{"timestamp":"2026-06-03T03:20:00.000Z","type":"event_msg","payload":{"type":"task_complete","completed_at":1780456800}}"#
                + "\n",
        )
        .expect("session file");

        let rows = discover_codex_observations_with_now(
            temp.path(),
            20,
            SystemTime::UNIX_EPOCH + Duration::from_secs(1_780_470_000),
        );

        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].kind, ObservationKind::Completed);
        assert_eq!(
            rows[0].last_activity_at.as_deref(),
            Some("2026-06-03T03:20:00.000Z")
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
    fn sqlite_threads_are_primary_and_task_complete_does_not_clear_desktop_thread() {
        let temp = tempdir().expect("temp dir");
        let state_db = temp.path().join("state_5.sqlite");
        let session_dir = temp.path().join("2026/06/03");
        fs::create_dir_all(&session_dir).expect("session dir");
        let rollout_path = session_dir.join("rollout-2026-06-03T10-00-00-019desktop.jsonl");
        fs::write(
            &rollout_path,
            r#"{"timestamp":"2026-06-03T02:00:00.000Z","type":"session_meta","payload":{"id":"019desktop","cwd":"/Users/edy/wmhcar","originator":"Codex Desktop","source":"vscode"}}"#
                .to_string()
                + "\n"
                + r#"{"timestamp":"2026-06-03T02:20:00.000Z","type":"event_msg","payload":{"type":"task_complete"}}"#
                + "\n",
        )
        .expect("session file");

        std::process::Command::new("sqlite3")
            .arg(&state_db)
            .arg(format!(
                "create table threads (id text primary key, rollout_path text not null, created_at integer not null, updated_at integer not null, source text not null, model_provider text not null, cwd text not null, title text not null, sandbox_policy text not null, approval_mode text not null, tokens_used integer not null default 0, has_user_event integer not null default 0, archived integer not null default 0, archived_at integer, git_sha text, git_branch text, git_origin_url text, cli_version text not null default '', first_user_message text not null default '', agent_nickname text, agent_role text, memory_mode text not null default 'enabled', model text, reasoning_effort text, agent_path text, created_at_ms integer, updated_at_ms integer, thread_source text, preview text not null default '');
                 insert into threads (id, rollout_path, created_at, updated_at, source, model_provider, cwd, title, sandbox_policy, approval_mode, updated_at_ms, thread_source, preview)
                 values ('019desktop', '{}', 1780452000, 1780453200, 'vscode', 'OpenAI', '/Users/edy/wmhcar', '排查用车详情地图卡顿', '{{\"type\":\"disabled\"}}', 'never', 1780453200000, 'user', '排查用车详情地图卡顿');",
                rollout_path.display()
            ))
            .status()
            .expect("create state db");

        let rows = discover_codex_observations_with_state_db(
            &state_db,
            temp.path(),
            20,
            SystemTime::UNIX_EPOCH + Duration::from_secs(1_780_470_000),
        );

        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].session_id, "019desktop");
        assert_eq!(rows[0].label.as_deref(), Some("排查用车详情地图卡顿"));
        assert_eq!(rows[0].kind, ObservationKind::Running);
        assert_eq!(rows[0].jump_target, JumpTarget::Desktop);
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
        );
        insert_thread(
            &state_db,
            "019other",
            "/tmp/missing-other.jsonl",
            "/Users/edy/other",
            "Other thread",
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
    ) {
        std::process::Command::new("sqlite3")
            .arg(state_db)
            .arg(format!(
                "insert into threads (id, rollout_path, created_at, updated_at, source, model_provider, cwd, title, sandbox_policy, approval_mode, updated_at_ms, thread_source, preview)
                 values ('{}', '{}', 1780452000, 1780453200, 'vscode', 'OpenAI', '{}', '{}', '{{\"type\":\"disabled\"}}', 'never', 1780453200000, 'user', '{}');",
                id, rollout_path, cwd, title, title
            ))
            .status()
            .expect("insert thread");
    }
}
