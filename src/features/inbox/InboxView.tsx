import { useEffect, useMemo, useState } from "react";
import type { SessionRow, SourceHealth } from "../../shared/types/session";
import {
  dismissSession as dismissSessionCommand,
  jumpToSession as jumpToSessionCommand,
  loadSessions,
  loadSourceHealth,
  restoreSession as restoreSessionCommand,
} from "./inboxApi";
import { groupLabels, groupSessions } from "./sessionGroups";

interface InboxViewProps {
  initialRows: SessionRow[];
  sourceHealth: SourceHealth;
}

export function InboxView({ initialRows, sourceHealth }: InboxViewProps) {
  const [rows, setRows] = useState(initialRows);
  const [health, setHealth] = useState(sourceHealth);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<string | null>(null);
  const [commandMessage, setCommandMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const groups = useMemo(() => groupSessions(rows), [rows]);
  const archivedRows = rows.filter((row) => row.dismissed);

  async function refreshInbox(isInitialLoad = false) {
    if (isInitialLoad) setIsLoading(true);
    return Promise.all([loadSessions(), loadSourceHealth()])
      .then(([loadedRows, loadedHealth]) => {
        setRows(loadedRows);
        setHealth(loadedHealth);
        setLastRefreshedAt(new Date().toLocaleTimeString());
        setErrorMessage(null);
      })
      .catch((error: unknown) => {
        setErrorMessage(error instanceof Error ? error.message : "Unable to load inbox source.");
      })
      .finally(() => {
        if (isInitialLoad) setIsLoading(false);
      });
  }

  useEffect(() => {
    void refreshInbox(true);
    const refreshTimer = window.setInterval(() => {
      void refreshInbox();
    }, 5000);

    return () => {
      window.clearInterval(refreshTimer);
    };
  }, []);

  async function dismissSession(sessionId: string) {
    try {
      const updatedRows = await dismissSessionCommand(sessionId, rows);
      setRows(updatedRows);
      setCommandMessage("Session dismissed.");
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Dismiss command failed.");
    }
  }

  async function restoreSession(sessionId: string) {
    try {
      const updatedRows = await restoreSessionCommand(sessionId, rows);
      setRows(updatedRows);
      setCommandMessage("Session restored.");
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Restore command failed.");
    }
  }

  async function jumpToSession(row: SessionRow) {
    try {
      const result = await jumpToSessionCommand(row.sessionId);
      setCommandMessage(result.message);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Jump command failed.");
    }
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Mac local MVP</p>
          <h1>Agent Session Inbox</h1>
        </div>
        <div className="topbar-actions">
          <button type="button" onClick={() => refreshInbox()}>
            Refresh
          </button>
          <div className={`source-pill source-pill--${health.status}`}>
            {health.sourceName}: {health.status}
          </div>
        </div>
      </header>

      <div className="status-strip" role="status">
        <span>{isLoading ? "Loading Codex source..." : `${rows.length} sessions observed`}</span>
        {lastRefreshedAt ? <span>Refreshed {lastRefreshedAt}</span> : null}
        {commandMessage ? <span>{commandMessage}</span> : null}
        {errorMessage ? <span className="status-strip__error">{errorMessage}</span> : null}
      </div>

      <section className="layout">
        <section className="inbox-panel" aria-label="Codex task inbox">
          {Object.entries(groups).map(([state, groupRows]) => (
            <section className="session-group" key={state}>
              <div className="group-heading">
                <h2>{groupLabels[state as keyof typeof groupLabels]}</h2>
                <span>{groupRows.length}</span>
              </div>
              {groupRows.length === 0 ? (
                <p className="empty-line">No sessions in this state.</p>
              ) : (
                <div className="session-list">
                  {groupRows.map((row) => (
                    <article className={`session-row session-row--${row.state}`} key={row.sessionId}>
                      <div className="row-main">
                        <div>
                          <h3>{row.label}</h3>
                          <p className="session-context">
                            <span>{row.agentName ?? "Agent unavailable"}</span>
                            <span>{row.projectName ?? "Project unavailable"}</span>
                          </p>
                          <p className="workspace">{row.workspacePath ?? "Workspace unavailable"}</p>
                        </div>
                        <span className={`confidence confidence--${row.confidence}`}>
                          {row.confidence}
                        </span>
                      </div>
                      <p className="reason">{row.statusReason}</p>
                      {row.dismissabilityReason ? (
                        <p className="dismiss-reason">{row.dismissabilityReason}</p>
                      ) : null}
                      <div className="row-meta">
                        <span>{row.lastActivityAt ?? "No activity time"}</span>
                        <span>Jump: {row.jumpTarget}</span>
                      </div>
                      <div className="row-actions">
                        <button type="button" onClick={() => jumpToSession(row)}>
                          Jump back
                        </button>
                        <button type="button" onClick={() => dismissSession(row.sessionId)}>
                          Dismiss
                        </button>
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </section>
          ))}
        </section>

        <aside className="side-panel">
          <section>
            <h2>Diagnostics</h2>
            <p className="panel-copy">
              Unknown state is preserved. Low-confidence rows cannot be auto-dismissed.
            </p>
            <div className="capability-list">
              {health.capabilities.map((capability) => (
                <div className="capability" key={capability.name}>
                  <div>
                    <strong>{capability.name}</strong>
                    <p>{capability.detail}</p>
                  </div>
                  <span>{capability.availability}</span>
                </div>
              ))}
            </div>
          </section>

          <section>
            <h2>Settings</h2>
            <label className="setting-row">
              <input type="checkbox" checked readOnly />
              Metadata-only storage
            </label>
            <label className="setting-row">
              <input type="checkbox" checked={false} readOnly />
              Scheduled cleanup disabled for MVP
            </label>
          </section>

          <section>
            <button
              className="secondary-action"
              type="button"
              onClick={() => setArchiveOpen((open) => !open)}
            >
              {archiveOpen ? "Hide archive" : `Show archive (${archivedRows.length})`}
            </button>
            {archiveOpen ? (
              <div className="archive-list">
                {archivedRows.length === 0 ? (
                  <p className="empty-line">No dismissed rows.</p>
                ) : (
                  archivedRows.map((row) => (
                    <div className="archive-row" key={row.sessionId}>
                      <span>{row.label}</span>
                      <button type="button" onClick={() => restoreSession(row.sessionId)}>
                        Restore
                      </button>
                    </div>
                  ))
                )}
              </div>
            ) : null}
          </section>
        </aside>
      </section>
    </main>
  );
}
