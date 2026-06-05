import { useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import type { SessionRow, SourceHealth } from "../../shared/types/session";
import {
  dismissSession as dismissSessionCommand,
  jumpToSession as jumpToSessionCommand,
  loadSessions,
  loadSourceHealth,
} from "../inbox/inboxApi";
import { buildStatusPanelModel, defaultStatusPanelConfig, type StatusPanelConfig } from "./statusPanel";

const STATUS_PANEL_CONFIG_STORAGE_KEY = "agent-session-inbox.statusPanelConfig";

interface StatusPanelViewProps {
  initialRows: SessionRow[];
  sourceHealth: SourceHealth;
}

export function StatusPanelView({ initialRows, sourceHealth }: StatusPanelViewProps) {
  const [rows, setRows] = useState(initialRows);
  const [health, setHealth] = useState(sourceHealth);
  const [config, setConfig] = useState<StatusPanelConfig>(() => loadInitialConfig());
  const [view, setView] = useState<"panel" | "management">("panel");
  const [expanded, setExpanded] = useState(false);
  const [commandMessage, setCommandMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const model = useMemo(() => buildStatusPanelModel(rows, config), [config, rows]);
  const displayedRows = expanded ? [...model.visibleRows, ...model.expandableHiddenRows] : model.visibleRows;

  async function refreshPanel() {
    try {
      const [loadedRows, loadedHealth] = await Promise.all([loadSessions(), loadSourceHealth()]);
      setRows(loadedRows);
      setHealth(loadedHealth);
      setErrorMessage(null);
    } catch (error: unknown) {
      setErrorMessage(error instanceof Error ? error.message : "Unable to load Codex source.");
    }
  }

  useEffect(() => {
    void refreshPanel();
    const refreshTimer = window.setInterval(() => {
      void refreshPanel();
    }, 5000);
    let unlistenMenu: (() => void) | undefined;

    void listen<string>("agent-session-inbox://open-management", (event) => {
      if (event.payload === "management") {
        setView("management");
      }
    }).then((unlisten) => {
      unlistenMenu = unlisten;
    }).catch(() => undefined);

    return () => {
      window.clearInterval(refreshTimer);
      unlistenMenu?.();
    };
  }, []);

  useEffect(() => {
    persistConfig(config);
  }, [config]);

  async function dismissSession(sessionId: string) {
    try {
      const updatedRows = await dismissSessionCommand(sessionId, rows);
      setRows(updatedRows);
      setCommandMessage("dismissed");
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Dismiss command failed.");
    }
  }

  async function jumpToSession(sessionId: string) {
    try {
      const result = await jumpToSessionCommand(sessionId);
      setCommandMessage(result.message);
      await refreshPanel();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Jump command failed.");
    }
  }

  if (view === "management") {
    return (
      <main className="panel-shell management-shell" data-theme={`${model.theme.styleFamily}-${model.theme.palette}`}>
        <header className="panel-header">
          <div className="panel-title">
            <span className="panel-prompt">$</span>
            <h1>management</h1>
          </div>
        <button type="button" className="icon-button icon-button--back" onClick={() => setView("panel")}>
          Back
        </button>
        </header>

        <section className="management-section" aria-label="Status panel settings">
          <label className="setting-field">
            <span>Language</span>
            <select
              aria-label="Language"
              value={config.language}
              onChange={(event) =>
                setConfig((current) => ({ ...current, language: event.target.value as StatusPanelConfig["language"] }))
              }
            >
              <option value="en">English</option>
              <option value="zh">中文</option>
            </select>
          </label>

          <label className="setting-field">
            <span>Style family</span>
            <select
              aria-label="Style family"
              value={config.styleFamily}
              onChange={(event) =>
                setConfig((current) => ({ ...current, styleFamily: event.target.value as StatusPanelConfig["styleFamily"] }))
              }
            >
              <option value="atom">Atom</option>
            </select>
          </label>

          <label className="setting-field">
            <span>Palette</span>
            <select
              aria-label="Palette"
              value={config.palette}
              onChange={(event) =>
                setConfig((current) => ({ ...current, palette: event.target.value as StatusPanelConfig["palette"] }))
              }
            >
              <option value="oneDark">One Dark</option>
            </select>
          </label>

          <label className="setting-field">
            <span>Visible items</span>
            <input
              aria-label="Visible items"
              type="number"
              min={1}
              max={8}
              value={config.visibleItemCount}
              onChange={(event) => {
                const nextCount = Number(event.target.value);
                if (!Number.isNaN(nextCount)) {
                  setConfig((current) => ({ ...current, visibleItemCount: nextCount }));
                }
              }}
            />
          </label>

          <fieldset className="status-color-settings">
            <legend>Status colors</legend>
            <ColorField
              label="Blocked color"
              value={config.statusColors.blocked}
              onChange={(value) => setStatusColor("blocked", value)}
            />
            <ColorField
              label="Inspect color"
              value={config.statusColors.inspect}
              onChange={(value) => setStatusColor("inspect", value)}
            />
            <ColorField
              label="Needed color"
              value={config.statusColors.needed}
              onChange={(value) => setStatusColor("needed", value)}
            />
            <ColorField
              label="Working color"
              value={config.statusColors.working}
              onChange={(value) => setStatusColor("working", value)}
            />
            <ColorField
              label="Idle color"
              value={config.statusColors.idle}
              onChange={(value) => setStatusColor("idle", value)}
            />
          </fieldset>
        </section>
      </main>
    );
  }

  return (
    <main className="panel-shell" data-theme={`${model.theme.styleFamily}-${model.theme.palette}`}>
      <header className="panel-header">
        <div className="panel-title">
          <span className="panel-prompt">$</span>
          <h1>codex attention</h1>
        </div>
        <div className="panel-counters" aria-label="Session counters">
          <span>{model.interventionCount} {model.copy.alertsLabel}</span>
          <span>{model.workingCount} {model.copy.workingLabel}</span>
          <span>{model.idleCount} {model.copy.idleLabel}</span>
        </div>
      </header>

      <section
        className={`status-list${expanded ? " status-list--expanded" : ""}`}
        aria-label="Codex status panel"
      >
        {displayedRows.length === 0 ? (
          <p className="empty-panel">no active Codex sessions</p>
        ) : (
          displayedRows.map((row) => (
            <article
              className={`status-row status-row--${row.displayStatus} status-row--${row.statusTone}`}
              key={row.sessionId}
            >
              <span
                className="status-code"
                style={{ "--status-color": row.statusColor } as React.CSSProperties}
              >
                <span aria-hidden="true">{row.statusMarker}</span>
                {" "}
                {row.statusLabel}
              </span>
              <div className="status-content">
                <h2>{row.label}</h2>
                <p title={row.interventionReason}>
                  {rowSubtitle(row)}
                  <span>{row.confidence}</span>
                </p>
              </div>
              <div className="status-actions">
                <button type="button" title="Jump back" onClick={() => jumpToSession(row.sessionId)}>
                  {"->"}
                </button>
                <button type="button" title="Dismiss" onClick={() => dismissSession(row.sessionId)}>
                  x
                </button>
              </div>
            </article>
          ))
        )}
      </section>

      <footer className="panel-footer">
        <span className={`source-dot source-dot--${health.status}`} />
        <span>{health.sourceName}</span>
        <span>{health.status}</span>
        <span>local data</span>
        {model.hiddenCount > 0 ? (
          <button
            type="button"
            className="hidden-toggle"
            disabled={model.expandableHiddenCount === 0}
            onClick={() => {
              if (model.expandableHiddenCount > 0) {
                setExpanded((value) => !value);
              }
            }}
          >
            {expanded ? model.copy.collapseLabel : hiddenToggleLabel()}
          </button>
        ) : null}
      </footer>

      {(commandMessage || errorMessage) && (
        <div className="panel-message" role="status">
          {errorMessage ?? commandMessage}
        </div>
      )}
    </main>
  );

  function setStatusColor(state: keyof StatusPanelConfig["statusColors"], value: string) {
    setConfig((current) => ({
      ...current,
      statusColors: {
        ...current.statusColors,
        [state]: value,
      },
    }));
  }

  function hiddenToggleLabel() {
    if (model.quietHiddenCount > 0 && model.quietHiddenCount === model.hiddenCount) {
      return `+${model.quietHiddenCount} ${model.copy.quietLabel}`;
    }

    if (model.quietHiddenCount > 0) {
      return `+${model.expandableHiddenCount} ${model.copy.hiddenAlertsLabel}`;
    }

    return `+${model.expandableHiddenCount}`;
  }
}

function loadInitialConfig(): StatusPanelConfig {
  if (typeof window === "undefined") return defaultStatusPanelConfig;

  try {
    const storedConfig = window.localStorage.getItem(STATUS_PANEL_CONFIG_STORAGE_KEY);
    if (!storedConfig) return defaultStatusPanelConfig;

    return normalizeConfig(JSON.parse(storedConfig));
  } catch {
    return defaultStatusPanelConfig;
  }
}

function persistConfig(config: StatusPanelConfig) {
  try {
    window.localStorage.setItem(STATUS_PANEL_CONFIG_STORAGE_KEY, JSON.stringify(config));
  } catch {
    // The panel should stay usable even when storage is unavailable.
  }
}

function normalizeConfig(value: unknown): StatusPanelConfig {
  if (!isObject(value)) return defaultStatusPanelConfig;

  const statusColors = isObject(value.statusColors) ? value.statusColors : {};
  const visibleItemCount = typeof value.visibleItemCount === "number"
    ? Math.min(8, Math.max(1, value.visibleItemCount))
    : defaultStatusPanelConfig.visibleItemCount;

  return {
    styleFamily: value.styleFamily === "atom" ? value.styleFamily : defaultStatusPanelConfig.styleFamily,
    palette: value.palette === "oneDark" ? value.palette : defaultStatusPanelConfig.palette,
    language: value.language === "zh" ? "zh" : "en",
    visibleItemCount,
    statusColors: {
      blocked: colorValue(statusColors.blocked, defaultStatusPanelConfig.statusColors.blocked),
      inspect: colorValue(statusColors.inspect, defaultStatusPanelConfig.statusColors.inspect),
      needed: colorValue(statusColors.needed, defaultStatusPanelConfig.statusColors.needed),
      working: colorValue(statusColors.working, defaultStatusPanelConfig.statusColors.working),
      idle: colorValue(statusColors.idle, defaultStatusPanelConfig.statusColors.idle),
    },
  };
}

function colorValue(value: unknown, fallback: string) {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function rowSubtitle(row: ReturnType<typeof buildStatusPanelModel>["visibleRows"][number]) {
  return row.projectName ?? row.workspacePath ?? row.interventionReason;
}

interface ColorFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
}

function ColorField({ label, value, onChange }: ColorFieldProps) {
  return (
    <label className="setting-field color-field">
      <span>{label}</span>
      <input
        aria-label={label}
        type="color"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}
