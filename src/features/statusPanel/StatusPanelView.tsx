import { useEffect, useMemo, useRef, useState } from "react";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { SessionRow, SourceHealth } from "../../shared/types/session";
import {
  dismissSession as dismissSessionCommand,
  jumpToSession as jumpToSessionCommand,
  loadSessions,
  loadSourceHealth,
} from "../inbox/inboxApi";
import { buildStatusPanelModel, defaultStatusPanelConfig, type StatusPanelConfig } from "./statusPanel";

const STATUS_PANEL_CONFIG_STORAGE_KEY = "attn.statusPanelConfig";
const LEGACY_STATUS_PANEL_CONFIG_STORAGE_KEY = "agent-session-inbox.statusPanelConfig";
const PANEL_WIDTH = 560;
const MANAGEMENT_HEIGHT = 420;
const PANEL_BASE_HEIGHT = 252;
const PANEL_BASE_VISIBLE_ITEMS = 3;
const PANEL_EXTRA_ROW_HEIGHT = 48;

interface StatusPanelViewProps {
  initialRows: SessionRow[];
  sourceHealth: SourceHealth;
}

export function StatusPanelView({ initialRows, sourceHealth }: StatusPanelViewProps) {
  const [rows, setRows] = useState(initialRows);
  const [health, setHealth] = useState(sourceHealth);
  const [config, setConfig] = useState<StatusPanelConfig>(() => loadInitialConfig());
  const [draftConfig, setDraftConfig] = useState<StatusPanelConfig>(() => config);
  const configRef = useRef(config);
  const draftConfigRef = useRef(draftConfig);
  const [view, setView] = useState<"panel" | "management">("panel");
  const [expanded, setExpanded] = useState(false);
  const [commandMessage, setCommandMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [pendingActions, setPendingActions] = useState<Record<string, "jump" | "dismiss">>({});
  const [attentionCues, setAttentionCues] = useState<Record<string, boolean>>({});
  const model = useMemo(() => buildStatusPanelModel(rows, config), [config, rows]);
  const displayedRows = expanded ? [...model.visibleRows, ...model.expandableHiddenRows] : model.visibleRows;
  const previousDisplayStatusRef = useRef<Record<string, string>>({});

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
        updateDraftConfig(configRef.current);
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
    configRef.current = config;
    persistConfig(config);
  }, [config]);

  useEffect(() => {
    void resizePanelWindow(view === "management" ? MANAGEMENT_HEIGHT : panelWindowHeight(config.visibleItemCount));
  }, [config.visibleItemCount, view]);

  useEffect(() => {
    const previousDisplayStatuses = previousDisplayStatusRef.current;
    const nextDisplayStatuses = Object.fromEntries(
      [...model.visibleRows, ...model.hiddenRows].map((row) => [row.sessionId, row.displayStatus]),
    );
    const newlyInspectSessionIds = [...model.visibleRows, ...model.hiddenRows]
      .filter((row) => previousDisplayStatuses[row.sessionId] === "working" && row.displayStatus === "inspect")
      .map((row) => row.sessionId);

    previousDisplayStatusRef.current = nextDisplayStatuses;

    if (newlyInspectSessionIds.length === 0) {
      return;
    }

    setAttentionCues((current) => {
      const next = { ...current };
      newlyInspectSessionIds.forEach((sessionId) => {
        next[sessionId] = true;
      });
      return next;
    });

    const timers = newlyInspectSessionIds.map((sessionId) =>
      window.setTimeout(() => {
        setAttentionCues((current) => {
          const next = { ...current };
          delete next[sessionId];
          return next;
        });
      }, 1800),
    );

    return () => {
      timers.forEach(window.clearTimeout);
    };
  }, [model.visibleRows, model.hiddenRows]);

  async function dismissSession(sessionId: string) {
    const previousRows = rows;
    setPendingAction(sessionId, "dismiss");
    setRows((currentRows) =>
      currentRows.map((row) =>
        row.sessionId === sessionId ? { ...row, dismissed: true, handled: true } : row,
      ),
    );
    setErrorMessage(null);

    try {
      const updatedRows = await dismissSessionCommand(sessionId, previousRows);
      setRows(updatedRows);
      setCommandMessage("dismissed");
    } catch (error) {
      setRows(previousRows);
      setErrorMessage(error instanceof Error ? error.message : "Dismiss command failed.");
    } finally {
      clearPendingAction(sessionId);
    }
  }

  async function jumpToSession(sessionId: string) {
    setPendingAction(sessionId, "jump");
    setCommandMessage("opening session");
    setErrorMessage(null);

    try {
      const result = await jumpToSessionCommand(sessionId);
      setCommandMessage(result.message);
      await refreshPanel();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Jump command failed.");
    } finally {
      clearPendingAction(sessionId);
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
        <button type="button" className="icon-button icon-button--back" onClick={() => {
          updateDraftConfig(configRef.current);
          setView("panel");
        }}>
          Back
        </button>
        </header>

        <section className="management-section" aria-label="Status panel settings">
          <label className="setting-field">
            <span>Language</span>
            <select
              aria-label="Language"
              value={draftConfig.language}
              onChange={(event) =>
                updateDraftConfig((current) => ({ ...current, language: event.target.value as StatusPanelConfig["language"] }))
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
              value={draftConfig.styleFamily}
              onChange={(event) =>
                updateDraftConfig((current) => ({ ...current, styleFamily: event.target.value as StatusPanelConfig["styleFamily"] }))
              }
            >
              <option value="atom">Atom</option>
            </select>
          </label>

          <label className="setting-field">
            <span>Palette</span>
            <select
              aria-label="Palette"
              value={draftConfig.palette}
              onChange={(event) =>
                updateDraftConfig((current) => ({ ...current, palette: event.target.value as StatusPanelConfig["palette"] }))
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
              value={draftConfig.visibleItemCount}
              onChange={(event) => {
                const nextCount = Number(event.target.value);
                if (!Number.isNaN(nextCount)) {
                  updateDraftConfig((current) => ({ ...current, visibleItemCount: nextCount }));
                }
              }}
            />
          </label>

          <fieldset className="status-color-settings">
            <legend>Status colors</legend>
            <ColorField
              label="Blocked color"
              value={draftConfig.statusColors.blocked}
              onChange={(value) => setStatusColor("blocked", value)}
            />
            <ColorField
              label="Inspect color"
              value={draftConfig.statusColors.inspect}
              onChange={(value) => setStatusColor("inspect", value)}
            />
            <ColorField
              label="Follow-up color"
              value={draftConfig.statusColors.needed}
              onChange={(value) => setStatusColor("needed", value)}
            />
            <ColorField
              label="Working color"
              value={draftConfig.statusColors.working}
              onChange={(value) => setStatusColor("working", value)}
            />
            <ColorField
              label="Idle color"
              value={draftConfig.statusColors.idle}
              onChange={(value) => setStatusColor("idle", value)}
            />
          </fieldset>

          <div className="management-actions">
            <button type="button" onClick={applyDraftConfig}>
              Apply settings
            </button>
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className="panel-shell" data-theme={`${model.theme.styleFamily}-${model.theme.palette}`}>
      <header className="panel-header">
        <div className="panel-title">
          <span className="panel-prompt">$</span>
          <h1>attn</h1>
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
            <StatusRow
              key={row.sessionId}
              row={row}
              pendingAction={pendingActions[row.sessionId]}
              attentionCue={attentionCues[row.sessionId] === true}
              onJump={jumpToSession}
              onDismiss={dismissSession}
            />
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

  function setPendingAction(sessionId: string, action: "jump" | "dismiss") {
    setPendingActions((current) => ({ ...current, [sessionId]: action }));
  }

  function clearPendingAction(sessionId: string) {
    setPendingActions((current) => {
      const next = { ...current };
      delete next[sessionId];
      return next;
    });
  }

  function setStatusColor(state: keyof StatusPanelConfig["statusColors"], value: string) {
    updateDraftConfig((current) => ({
      ...current,
      statusColors: {
        ...current.statusColors,
        [state]: value,
      },
    }));
  }

  function updateDraftConfig(nextConfig: StatusPanelConfig | ((current: StatusPanelConfig) => StatusPanelConfig)) {
    const resolvedConfig = typeof nextConfig === "function" ? nextConfig(draftConfigRef.current) : nextConfig;
    draftConfigRef.current = resolvedConfig;
    setDraftConfig(resolvedConfig);
  }

  function applyDraftConfig() {
    const nextConfig = normalizeConfig(draftConfigRef.current);
    setConfig(nextConfig);
    updateDraftConfig(nextConfig);
    setView("panel");
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

interface StatusRowProps {
  row: ReturnType<typeof buildStatusPanelModel>["visibleRows"][number];
  pendingAction?: "jump" | "dismiss";
  attentionCue?: boolean;
  onJump: (sessionId: string) => void;
  onDismiss: (sessionId: string) => void;
}

function StatusRow({ row, pendingAction, attentionCue = false, onJump, onDismiss }: StatusRowProps) {
  const jumpTitle = pendingAction === "jump" ? "Opening session" : "Jump back";
  const dismissTitle = pendingAction === "dismiss" ? "Dismissing session" : "Dismiss";
  const rowClassName = [
    "status-row",
    `status-row--${row.displayStatus}`,
    `status-row--${row.statusTone}`,
    attentionCue ? "status-row--attention-cue" : "",
  ].filter(Boolean).join(" ");

  return (
    <article
      className={rowClassName}
      data-action-pending={pendingAction ?? undefined}
      data-testid={`status-row-${row.sessionId}`}
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
        <button
          type="button"
          className="status-action status-action--jump"
          title={jumpTitle}
          disabled={pendingAction === "jump"}
          onClick={() => onJump(row.sessionId)}
        >
          {pendingAction === "jump" ? <PendingIcon /> : <JumpIcon />}
        </button>
        <button
          type="button"
          className="status-action status-action--dismiss"
          title={dismissTitle}
          disabled={pendingAction === "dismiss"}
          onClick={() => onDismiss(row.sessionId)}
        >
          {pendingAction === "dismiss" ? <PendingIcon /> : <DismissIcon />}
        </button>
      </div>
    </article>
  );
}

function JumpIcon() {
  return (
    <svg aria-hidden="true" className="status-action-icon" viewBox="0 0 16 16">
      <path d="M3 8h8" />
      <path d="M8 5l3 3-3 3" />
    </svg>
  );
}

function DismissIcon() {
  return (
    <svg aria-hidden="true" className="status-action-icon" viewBox="0 0 16 16">
      <path d="M5 5l6 6" />
      <path d="M11 5l-6 6" />
    </svg>
  );
}

function PendingIcon() {
  return (
    <svg aria-hidden="true" className="status-action-icon status-action-icon--pending" viewBox="0 0 16 16">
      <path d="M8 3a5 5 0 1 1-3.5 8.6" />
    </svg>
  );
}

function panelWindowHeight(visibleItemCount: number) {
  const normalizedCount = Math.min(8, Math.max(1, visibleItemCount));
  return Math.min(420, PANEL_BASE_HEIGHT + Math.max(0, normalizedCount - PANEL_BASE_VISIBLE_ITEMS) * PANEL_EXTRA_ROW_HEIGHT);
}

async function resizePanelWindow(height: number) {
  try {
    await getCurrentWindow().setSize(new LogicalSize(PANEL_WIDTH, height));
  } catch {
    // Browser preview and restricted window capabilities should not block the panel.
  }
}

function loadInitialConfig(): StatusPanelConfig {
  if (typeof window === "undefined") return defaultStatusPanelConfig;

  try {
    const storedConfig = window.localStorage.getItem(STATUS_PANEL_CONFIG_STORAGE_KEY)
      ?? window.localStorage.getItem(LEGACY_STATUS_PANEL_CONFIG_STORAGE_KEY);
    if (!storedConfig) return defaultStatusPanelConfig;

    return normalizeConfig(JSON.parse(storedConfig));
  } catch {
    return defaultStatusPanelConfig;
  }
}

function persistConfig(config: StatusPanelConfig) {
  try {
    window.localStorage.setItem(STATUS_PANEL_CONFIG_STORAGE_KEY, JSON.stringify(config));
    window.localStorage.removeItem(LEGACY_STATUS_PANEL_CONFIG_STORAGE_KEY);
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
