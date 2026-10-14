use std::path::Path;
use std::sync::{mpsc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
#[cfg(test)]
use notify::{Config, PollWatcher};

const EVENT_COALESCE_WINDOW: Duration = Duration::from_millis(200);

pub struct CodexSourceWatcher<W: Watcher + Send + 'static> {
    _watcher: Mutex<W>,
}

pub fn watch_codex_sources(
    codex_root: &Path,
    on_change: impl Fn() + Send + 'static,
) -> Result<CodexSourceWatcher<RecommendedWatcher>, String> {
    let (sender, receiver) = mpsc::channel();
    let watcher = notify::recommended_watcher(move |event| {
        let _ = sender.send(event);
    })
    .map_err(|error| format!("create Codex source watcher failed: {error}"))?;
    start_codex_source_watcher(codex_root, watcher, receiver, on_change)
}

#[cfg(test)]
pub fn poll_watch_codex_sources(
    codex_root: &Path,
    on_change: impl Fn() + Send + 'static,
) -> Result<CodexSourceWatcher<PollWatcher>, String> {
    let (sender, receiver) = mpsc::channel();
    let watcher = PollWatcher::new(
        move |event| {
            let _ = sender.send(event);
        },
        Config::default().with_poll_interval(Duration::from_millis(100)),
    )
    .map_err(|error| format!("create Codex poll watcher failed: {error}"))?;
    start_codex_source_watcher(codex_root, watcher, receiver, on_change)
}

fn start_codex_source_watcher<W: Watcher + Send + 'static>(
    codex_root: &Path,
    mut watcher: W,
    receiver: mpsc::Receiver<notify::Result<Event>>,
    on_change: impl Fn() + Send + 'static,
) -> Result<CodexSourceWatcher<W>, String> {
    let root = codex_root
        .canonicalize()
        .map_err(|error| format!("resolve Codex source directory failed: {error}"))?;
    watcher
        .watch(&root, RecursiveMode::Recursive)
        .map_err(|error| format!("watch Codex source directory failed: {error}"))?;

    thread::spawn(move || {
        let mut deadline: Option<Instant> = None;
        loop {
            if deadline.is_some_and(|at| Instant::now() >= at) {
                deadline = None;
                on_change();
                continue;
            }

            let next = if let Some(at) = deadline {
                receiver.recv_timeout(at.saturating_duration_since(Instant::now()))
            } else {
                receiver.recv().map_err(|_| mpsc::RecvTimeoutError::Disconnected)
            };
            match next {
                Ok(Ok(event)) if is_relevant_event(&root, &event) => {
                    deadline.get_or_insert_with(|| Instant::now() + EVENT_COALESCE_WINDOW);
                }
                Ok(Err(error)) => eprintln!("Codex source watch event failed: {error}"),
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    deadline = None;
                    on_change();
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
                _ => {}
            }
        }
    });

    Ok(CodexSourceWatcher {
        _watcher: Mutex::new(watcher),
    })
}

fn is_relevant_event(root: &Path, event: &Event) -> bool {
    matches!(
        event.kind,
        EventKind::Any | EventKind::Create(_) | EventKind::Modify(_) | EventKind::Remove(_)
    ) && event.paths.iter().any(|path| is_relevant_source_path(root, path))
}

pub fn is_relevant_source_path(root: &Path, path: &Path) -> bool {
    let is_session_path = [root.join("sessions"), root.join("archived_sessions")]
        .iter()
        .any(|directory| {
            path.starts_with(directory)
                && (path.extension().is_none_or(|extension| extension == "jsonl"))
        });
    let is_hook_event = path == root.join("agent-session-inbox").join("hook-events.jsonl");
    let is_state_db = [root.to_path_buf(), root.join("sqlite")]
        .iter()
        .any(|directory| {
            ["state_5.sqlite", "state_5.sqlite-wal"]
                .iter()
                .any(|name| path == directory.join(name))
        });

    is_session_path || is_hook_event || is_state_db
}
