import { useEffect, useMemo, useRef, useState } from "react";
import { LogicalSize, PhysicalPosition } from "@tauri-apps/api/dpi";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { CodexHookIntegrationStatus, SessionRow, SourceHealth } from "../../shared/types/session";
import {
  dismissSession as dismissSessionCommand,
  installCodexHooks,
  jumpToSession as jumpToSessionCommand,
  loadCodexHookIntegrationStatus,
  loadSessions,
  pinSession as pinSessionCommand,
  unpinSession as unpinSessionCommand,
} from "../inbox/inboxApi";
import {
  buildStatusPanelModel,
  defaultStatusPanelConfig,
  type InterventionStatus,
  type StatusPanelConfig,
  type StatusPanelCopy,
  type StatusPanelRow,
} from "./statusPanel";
import { normalizePanelToggleShortcut } from "./panelShortcut";

const STATUS_PANEL_CONFIG_STORAGE_KEY = "attn.statusPanelConfig";
const LEGACY_STATUS_PANEL_CONFIG_STORAGE_KEY = "agent-session-inbox.statusPanelConfig";
const PANEL_POSITION_STORAGE_KEY = "attn.panelPosition";
const PANEL_WIDTH = 420;
const MANAGEMENT_HEIGHT = 420;
const PANEL_BASE_HEIGHT = 128;
const PANEL_BASE_VISIBLE_ITEMS = 1;
const PANEL_EXTRA_ROW_HEIGHT = 49;
const PANEL_MIN_HEIGHT = PANEL_BASE_HEIGHT - (PANEL_BASE_VISIBLE_ITEMS - 1) * PANEL_EXTRA_ROW_HEIGHT;
const PANEL_MESSAGE_HEIGHT = 32;
const PANEL_MAX_HEIGHT = 420;
const PANEL_STRIP_HEIGHT = 50;
const COMMAND_MESSAGE_DISMISS_DELAY_MS = 3000;
const AUTO_COLLAPSE_STATUS_OPTIONS: InterventionStatus[] = ["blocked", "input", "inspect", "stopped", "working"];
const AUTO_COLLAPSE_STATUS_SET = new Set<InterventionStatus>(AUTO_COLLAPSE_STATUS_OPTIONS);

interface StatusPanelViewProps {
  initialRows: SessionRow[];
  sourceHealth: SourceHealth;
}

export function StatusPanelView({ initialRows, sourceHealth: _sourceHealth }: StatusPanelViewProps) {
  const [rows, setRows] = useState(initialRows);
  const [config, setConfig] = useState<StatusPanelConfig>(() => loadInitialConfig());
  const [draftConfig, setDraftConfig] = useState<StatusPanelConfig>(() => config);
  const configRef = useRef(config);
  const draftConfigRef = useRef(draftConfig);
  const [view, setView] = useState<"panel" | "management">("panel");
  const [expanded, setExpanded] = useState(false);
  const [commandMessage, setCommandMessage] = useState<string | null>(null);
  const [jumpNotice, setJumpNotice] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [hookStatus, setHookStatus] = useState<CodexHookIntegrationStatus | null>(null);
  const [hookInstallPending, setHookInstallPending] = useState(false);
  const [pendingActions, setPendingActions] = useState<Record<string, "jump" | "dismiss" | "pin" | "unpin">>({});
  const [attentionCues, setAttentionCues] = useState<Record<string, boolean>>({});
  const [panelOpen, setPanelOpen] = useState(config.panelMode === "persistent");
  const alertSignatureRef = useRef<string | null>(null);
  const autoCollapseTimerRef = useRef<number | undefined>(undefined);
  const latestRefreshIdRef = useRef(0);
  const jumpNoticeTimerRef = useRef<number | undefined>(undefined);
  const actionFeedbackSequenceRef = useRef(0);
  const mountedRef = useRef(true);
  const resizeInFlightRef = useRef(false);
  const queuedResizeHeightRef = useRef<number | undefined>(undefined);
  const model = useMemo(() => buildStatusPanelModel(rows, config), [config, rows]);
  const displayedRows = expanded ? [...model.visibleRows, ...model.expandableHiddenRows] : model.visibleRows;
  const hasPendingJump = Object.values(pendingActions).includes("jump");
  const hasPanelMessage = commandMessage !== null || errorMessage !== null;
  const panelHeight = panelWindowHeight(displayedRows.length, hasPanelMessage);
  const shouldScrollStatusList = panelHeight >= PANEL_MAX_HEIGHT;
  const shouldKeepPanelOpenForStatus = useMemo(() => {
    return hasPreventAutoCollapseStatus(model, config);
  }, [config, model]);
  const alertSignature = useMemo(() => {
    return [...model.visibleRows, ...model.hiddenRows]
      .filter((row) => row.statusTone === "alert")
      .map((row) => `${row.sessionId}:${row.displayStatus}:${row.lastActivityAt ?? ""}`)
      .sort()
      .join("|");
  }, [model.hiddenRows, model.visibleRows]);
  const previousDisplayStatusRef = useRef<Record<string, string>>({});

  async function refreshPanel(followUpToIdleMinutes = configRef.current.followUpToIdleMinutes) {
    const refreshId = latestRefreshIdRef.current + 1;
    latestRefreshIdRef.current = refreshId;

    try {
      const loadedRows = await loadSessions(followUpToIdleMinutes);
      if (!mountedRef.current) {
        return;
      }
      if (refreshId !== latestRefreshIdRef.current) {
        return;
      }
      setRows(loadedRows);
      setErrorMessage(null);
    } catch (error: unknown) {
      if (!mountedRef.current) {
        return;
      }
      if (refreshId !== latestRefreshIdRef.current) {
        return;
      }
      setErrorMessage(messageFromUnknownError(error, model.copy.loadSourceFailedLabel));
    }
  }

  async function refreshHookStatus() {
    try {
      const status = await loadCodexHookIntegrationStatus();
      if (!mountedRef.current) {
        return;
      }
      setHookStatus(status);
    } catch (error) {
      if (!mountedRef.current) {
        return;
      }
      setHookStatus({
        installed: false,
        hooksPath: "~/.codex/hooks.json",
        eventStorePath: "~/.codex/agent-session-inbox/hook-events.jsonl",
          detail: messageFromUnknownError(error, model.copy.loadHookStatusFailedLabel),
      });
    }
  }

  useEffect(() => {
    mountedRef.current = true;
    let cancelled = false;
    void refreshPanel();
    const refreshTimer = window.setInterval(() => {
      void refreshPanel();
    }, 5000);
    let unlistenToggle: (() => void) | undefined;
    let unlistenMenu: (() => void) | undefined;

    void listen<boolean>("agent-session-inbox://toggle-panel", (event) => {
      togglePanelOpen(event.payload);
    }).then((unlisten) => {
      if (cancelled) {
        unlisten();
        return;
      }
      unlistenToggle = unlisten;
    }).catch(() => undefined);

    void listen<string>("agent-session-inbox://open-management", (event) => {
      if (event.payload === "management") {
        updateDraftConfig(configRef.current);
        void refreshHookStatus();
        setView("management");
      }
    }).then((unlisten) => {
      if (cancelled) {
        unlisten();
        return;
      }
      unlistenMenu = unlisten;
    }).catch(() => undefined);

    return () => {
      cancelled = true;
      mountedRef.current = false;
      actionFeedbackSequenceRef.current += 1;
      window.clearInterval(refreshTimer);
      clearJumpNoticeTimer();
      unlistenToggle?.();
      unlistenMenu?.();
    };
  }, []);

  useEffect(() => {
    configRef.current = config;
    persistConfig(config);
  }, [config]);

  useEffect(() => {
    try {
      const appWindow = getCurrentWindow();
      const savedPosition = loadPanelPosition();
      if (savedPosition) {
        void appWindow.setPosition(new PhysicalPosition(savedPosition.x, savedPosition.y)).catch(() => undefined);
      }

      let unlistenMoved: (() => void) | undefined;
      void appWindow.onMoved((event) => {
        persistPanelPosition(event.payload);
      }).then((unlisten) => {
        unlistenMoved = unlisten;
      }).catch(() => undefined);

      return () => {
        unlistenMoved?.();
      };
    } catch {
      return undefined;
    }
  }, []);

  useEffect(() => {
    const nextHeight = view === "management"
      ? MANAGEMENT_HEIGHT
      : panelOpen
        ? panelHeight
        : PANEL_STRIP_HEIGHT;
    queuePanelWindowResize(nextHeight);
  }, [panelHeight, panelOpen, view]);

  useEffect(() => {
    const previousSignature = alertSignatureRef.current;
    alertSignatureRef.current = alertSignature;

    if (previousSignature === null || previousSignature === alertSignature) {
      return;
    }

    if (alertSignature.length > 0) {
      openPanelTemporarily(shouldKeepPanelOpenForStatus);
    }
  }, [alertSignature, shouldKeepPanelOpenForStatus]);

  useEffect(() => {
    return () => {
      clearAutoCollapseTimer();
    };
  }, []);

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

  async function dismissSession(row: StatusPanelRow) {
    const actionFeedbackSequence = beginActionFeedback();
    const sessionId = row.sessionId;
    const sessionIds = [row.sessionId];
    const dismissedIds = new Set(sessionIds);
    const previousRows = rows;
    setPendingAction(sessionId, "dismiss");
    setRows((currentRows) =>
      currentRows.map((row) =>
        dismissedIds.has(row.sessionId) ? { ...row, dismissed: true, handled: true, pinned: false } : row,
      ),
    );
    try {
      const updatedRows = await dismissSessionCommand(sessionId, previousRows, sessionIds);
      if (!mountedRef.current) {
        return;
      }
      setRows(updatedRows);
      await refreshPanel(configRef.current.followUpToIdleMinutes);
      if (!mountedRef.current) {
        return;
      }
      if (isLatestActionFeedback(actionFeedbackSequence)) {
        showCommandMessage(model.copy.dismissedSessionLabel);
      }
    } catch (error) {
      if (!mountedRef.current) {
        return;
      }
      setRows(previousRows);
      if (isLatestActionFeedback(actionFeedbackSequence)) {
        setErrorMessage(messageFromUnknownError(error, model.copy.dismissFailedLabel));
      }
    } finally {
      clearPendingAction(sessionId);
    }
  }

  async function togglePinnedSession(row: ReturnType<typeof buildStatusPanelModel>["visibleRows"][number]) {
    const actionFeedbackSequence = beginActionFeedback();
    const previousRows = rows;
    const nextPinned = !row.pinned;
    setPendingAction(row.sessionId, nextPinned ? "pin" : "unpin");
    setRows((currentRows) =>
      currentRows.map((currentRow) =>
        currentRow.sessionId === row.sessionId ? { ...currentRow, pinned: nextPinned } : currentRow,
      ),
    );
    try {
      const updatedRows = nextPinned
        ? await pinSessionCommand(row.sessionId, previousRows)
        : await unpinSessionCommand(row.sessionId, previousRows);
      if (!mountedRef.current) {
        return;
      }
      setRows(updatedRows);
      await refreshPanel(configRef.current.followUpToIdleMinutes);
      if (!mountedRef.current) {
        return;
      }
      if (isLatestActionFeedback(actionFeedbackSequence)) {
        showCommandMessage(nextPinned ? model.copy.pinnedSessionLabel : model.copy.unpinnedSessionLabel);
      }
    } catch (error) {
      if (!mountedRef.current) {
        return;
      }
      setRows(previousRows);
      if (isLatestActionFeedback(actionFeedbackSequence)) {
        setErrorMessage(messageFromUnknownError(error, model.copy.pinFailedLabel));
      }
    } finally {
      clearPendingAction(row.sessionId);
    }
  }

  async function jumpToSession(sessionId: string, acknowledgedSessionIds = [sessionId]) {
    const actionFeedbackSequence = beginActionFeedback();
    setPendingAction(sessionId, "jump");
    showJumpNotice(model.copy.openingSessionLabel);

    try {
      const result = await jumpToSessionCommand(
        sessionId,
        acknowledgedSessionIds,
        configRef.current.followUpToIdleMinutes,
      );
      await refreshPanel();
      if (!isLatestActionFeedback(actionFeedbackSequence)) {
        return;
      }

      if (result.succeeded) {
        showTransientJumpNotice(
          configRef.current.language === "zh" ? successfulJumpNotice(result.target, model.copy) : result.message,
        );
      } else {
        const failureLabel = result.availability === "unavailable"
          ? model.copy.jumpUnavailableLabel
          : model.copy.jumpFailedLabel;
        showJumpNotice(configRef.current.language === "zh" ? failureLabel : result.message);
      }
    } catch (error) {
      if (isLatestActionFeedback(actionFeedbackSequence)) {
        showJumpNotice(messageFromUnknownError(error, model.copy.jumpFailedLabel));
      }
    } finally {
      clearPendingAction(sessionId);
    }
  }

  if (view === "management") {
    return (
      <main className="panel-shell management-shell" data-theme={`${model.theme.styleFamily}-${model.theme.palette}`}>
        <header className="panel-header panel-header--draggable" onPointerDown={startPanelDrag}>
          <div className="panel-title">
            <h1>{model.copy.managementTitle}</h1>
        </div>
        <button type="button" className="icon-button icon-button--back" data-no-window-drag onClick={() => {
          updateDraftConfig(configRef.current);
          setView("panel");
        }}>
          {model.copy.backLabel}
        </button>
        </header>

        <section className="management-section" aria-label={model.copy.managementTitle}>
          <label className="setting-field">
            <span>{model.copy.languageLabel}</span>
            <select
              aria-label={model.copy.languageLabel}
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
            <span>{model.copy.styleFamilyLabel}</span>
            <select
              aria-label={model.copy.styleFamilyLabel}
              value={draftConfig.styleFamily}
              onChange={(event) =>
                updateDraftConfig((current) => ({ ...current, styleFamily: event.target.value as StatusPanelConfig["styleFamily"] }))
              }
            >
              <option value="atom">Atom</option>
            </select>
          </label>

          <label className="setting-field">
            <span>{model.copy.paletteLabel}</span>
            <select
              aria-label={model.copy.paletteLabel}
              value={draftConfig.palette}
              onChange={(event) =>
                updateDraftConfig((current) => ({ ...current, palette: event.target.value as StatusPanelConfig["palette"] }))
              }
            >
              <option value="oneDark">One Dark</option>
            </select>
          </label>

          <label className="setting-field">
            <span>{model.copy.visibleItemsLabel}</span>
            <input
              aria-label={model.copy.visibleItemsLabel}
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

          <label className="setting-field">
            <span>{model.copy.panelDisplayLabel}</span>
            <select
              aria-label={model.copy.panelDisplayLabel}
              value={draftConfig.panelMode}
              onChange={(event) =>
                updateDraftConfig((current) => ({ ...current, panelMode: event.target.value as StatusPanelConfig["panelMode"] }))
              }
            >
              <option value="auto">{model.copy.autoCollapseLabel}</option>
              <option value="persistent">{model.copy.persistentLabel}</option>
            </select>
          </label>

          <label className="setting-field">
            <span>{model.copy.alertDisplaySecondsLabel}</span>
            <input
              aria-label={model.copy.alertDisplaySecondsLabel}
              type="number"
              min={1}
              max={120}
              value={Math.round(draftConfig.autoCollapseDelayMs / 1000)}
              disabled={draftConfig.panelMode === "persistent"}
              onChange={(event) => {
                const nextSeconds = Number(event.target.value);
                if (!Number.isNaN(nextSeconds)) {
                  updateDraftConfig((current) => ({ ...current, autoCollapseDelayMs: nextSeconds * 1000 }));
                }
              }}
            />
          </label>

          <label className="setting-field">
            <span>{model.copy.followUpToIdleMinutesLabel}</span>
            <input
              aria-label={model.copy.followUpToIdleMinutesLabel}
              type="number"
              min={20}
              step={1}
              value={draftConfig.followUpToIdleMinutes}
              onChange={(event) => {
                const nextMinutes = Number(event.target.value);
                if (!Number.isNaN(nextMinutes)) {
                  updateDraftConfig((current) => ({ ...current, followUpToIdleMinutes: nextMinutes }));
                }
              }}
            />
          </label>

          <fieldset className="status-checkbox-settings">
            <legend>{model.copy.preventAutoCollapseStatusesLabel}</legend>
            <div className="status-checkbox-grid">
              {AUTO_COLLAPSE_STATUS_OPTIONS.map((status) => (
                <label className="status-checkbox-field" key={status}>
                  <input
                    aria-label={model.theme.status[status].label}
                    type="checkbox"
                    checked={draftConfig.preventAutoCollapseStatuses.includes(status)}
                    onChange={(event) => setPreventAutoCollapseStatus(status, event.target.checked)}
                  />
                  <span>{model.theme.status[status].label}</span>
                </label>
              ))}
            </div>
          </fieldset>

          <fieldset className="status-color-settings">
            <legend>{model.copy.statusColorsLabel}</legend>
            <ColorField
              label={model.copy.blockedColorLabel}
              value={draftConfig.statusColors.blocked}
              onChange={(value) => setStatusColor("blocked", value)}
            />
            <ColorField
              label={model.copy.inspectColorLabel}
              value={draftConfig.statusColors.inspect}
              onChange={(value) => setStatusColor("inspect", value)}
            />
            <ColorField
              label={model.copy.stoppedColorLabel}
              value={draftConfig.statusColors.stopped}
              onChange={(value) => setStatusColor("stopped", value)}
            />
            <ColorField
              label={model.copy.followUpColorLabel}
              value={draftConfig.statusColors.needed}
              onChange={(value) => setStatusColor("needed", value)}
            />
            <ColorField
              label={model.copy.workingColorLabel}
              value={draftConfig.statusColors.working}
              onChange={(value) => setStatusColor("working", value)}
            />
            <ColorField
              label={model.copy.idleColorLabel}
              value={draftConfig.statusColors.idle}
              onChange={(value) => setStatusColor("idle", value)}
            />
          </fieldset>

          <section className="hook-settings" aria-label={model.copy.codexHooksLabel}>
            <div>
              <h2>{model.copy.codexHooksLabel}</h2>
              <p>{hookStatusDetail(hookStatus, configRef.current.language, model.copy)}</p>
              <code>{hookStatus?.hooksPath ?? "~/.codex/hooks.json"}</code>
            </div>
            <button
              type="button"
              disabled={hookInstallPending || hookStatus?.installed === true}
              onClick={installHooks}
            >
              {hookStatus?.installed
                ? model.copy.codexHooksInstalledLabel
                : hookInstallPending
                  ? model.copy.installingLabel
                  : model.copy.installCodexHooksLabel}
            </button>
          </section>

          <div className="management-actions">
            <button type="button" onClick={applyDraftConfig}>
              {model.copy.applySettingsLabel}
            </button>
          </div>
        </section>
      </main>
    );
  }

  function sessionCounters() {
    return (
      <div className="panel-counters" aria-label="Session counters">
        <span>{model.interventionCount} {model.copy.alertsLabel}</span>
        <span>{model.workingCount} {model.copy.workingLabel}</span>
      </div>
    );
  }

  return (
    <main
      className={`panel-shell${panelOpen ? "" : " panel-shell--collapsed"}`}
      data-theme={`${model.theme.styleFamily}-${model.theme.palette}`}
    >
      <header className="panel-header panel-header--draggable" onPointerDown={startPanelDrag}>
        <div className="panel-title">
          <h1>Attn</h1>
        </div>
        {!panelOpen ? sessionCounters() : null}
        <button
          type="button"
          className="strip-toggle"
          data-no-window-drag
          aria-label={panelOpen ? model.copy.collapsePanelLabel : model.copy.expandPanelLabel}
          onClick={() => togglePanelOpen()}
        >
          {panelOpen ? "-" : "+"}
        </button>
      </header>

      {panelOpen ? (
        <>
          <section
            className={`status-list${expanded ? " status-list--expanded" : ""}${shouldScrollStatusList ? " status-list--scrollable" : ""}`}
            aria-label="Codex status panel"
          >
            {displayedRows.length === 0 ? (
              <p className="empty-panel">{model.copy.emptyPanelLabel}</p>
            ) : (
              displayedRows.map((row) => (
                <StatusRow
                  key={row.sessionId}
                  row={row}
                  pendingAction={pendingActions[row.sessionId]}
                  attentionCue={attentionCues[row.sessionId] === true}
                  copy={model.copy}
                  onJump={jumpToSession}
                  onTogglePinned={togglePinnedSession}
                  onDismiss={dismissSession}
                />
              ))
            )}
          </section>

          <footer className="panel-footer">
            <span className="jump-notice" role="status" aria-atomic="true">{jumpNotice}</span>
            {!hasPendingJump && model.expandableHiddenCount > 0 ? (
              <button
                type="button"
                className="hidden-toggle"
                onClick={() => setExpanded((value) => !value)}
              >
                {expanded ? model.copy.collapseLabel : hiddenToggleLabel()}
              </button>
            ) : null}
            {sessionCounters()}
          </footer>

          {(commandMessage || errorMessage) && (
            <div className="panel-message" role="status">
              {errorMessage ?? commandMessage}
            </div>
          )}
        </>
      ) : null}
    </main>
  );

  function setPendingAction(sessionId: string, action: "jump" | "dismiss" | "pin" | "unpin") {
    setPendingActions((current) => ({ ...current, [sessionId]: action }));
  }

  function clearPendingAction(sessionId: string) {
    if (!mountedRef.current) {
      return;
    }
    setPendingActions((current) => {
      const next = { ...current };
      delete next[sessionId];
      return next;
    });
  }

  function queuePanelWindowResize(height: number) {
    if (resizeInFlightRef.current) {
      queuedResizeHeightRef.current = height;
      return;
    }

    void resizePanelWindowInOrder(height);
  }

  async function resizePanelWindowInOrder(height: number) {
    resizeInFlightRef.current = true;
    await resizePanelWindow(height);
    resizeInFlightRef.current = false;

    const queuedHeight = queuedResizeHeightRef.current;
    queuedResizeHeightRef.current = undefined;
    if (queuedHeight !== undefined) {
      void resizePanelWindowInOrder(queuedHeight);
    }
  }

  function clearJumpNoticeTimer() {
    if (jumpNoticeTimerRef.current === undefined) return;
    window.clearTimeout(jumpNoticeTimerRef.current);
    jumpNoticeTimerRef.current = undefined;
  }

  function clearJumpNotice() {
    clearJumpNoticeTimer();
    setJumpNotice(null);
  }

  function beginActionFeedback() {
    actionFeedbackSequenceRef.current += 1;
    clearJumpNotice();
    setCommandMessage(null);
    setErrorMessage(null);
    return actionFeedbackSequenceRef.current;
  }

  function isLatestActionFeedback(sequence: number) {
    return mountedRef.current && actionFeedbackSequenceRef.current === sequence;
  }

  function showCommandMessage(message: string) {
    clearJumpNotice();
    setCommandMessage(message);
  }

  function showJumpNotice(message: string) {
    clearJumpNoticeTimer();
    setCommandMessage(null);
    setJumpNotice(message);
  }

  function showTransientJumpNotice(message: string) {
    showJumpNotice(message);
    const timerId = window.setTimeout(() => {
      if (jumpNoticeTimerRef.current === timerId) {
        jumpNoticeTimerRef.current = undefined;
        setJumpNotice(null);
      }
    }, COMMAND_MESSAGE_DISMISS_DELAY_MS);
    jumpNoticeTimerRef.current = timerId;
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

  function setPreventAutoCollapseStatus(status: InterventionStatus, checked: boolean) {
    updateDraftConfig((current) => {
      const statuses = current.preventAutoCollapseStatuses.filter((item) => item !== status);
      return {
        ...current,
        preventAutoCollapseStatuses: checked ? [...statuses, status] : statuses,
      };
    });
  }

  function updateDraftConfig(nextConfig: StatusPanelConfig | ((current: StatusPanelConfig) => StatusPanelConfig)) {
    const resolvedConfig = typeof nextConfig === "function" ? nextConfig(draftConfigRef.current) : nextConfig;
    draftConfigRef.current = resolvedConfig;
    setDraftConfig(resolvedConfig);
  }

  function applyDraftConfig() {
    const nextConfig = normalizeConfig(draftConfigRef.current);
    const nextModel = buildStatusPanelModel(rows, nextConfig);
    clearAutoCollapseTimer();
    configRef.current = nextConfig;
    setConfig(nextConfig);
    setPanelOpen(nextConfig.panelMode === "persistent" || hasPreventAutoCollapseStatus(nextModel, nextConfig));
    updateDraftConfig(nextConfig);
    setView("panel");
    void refreshPanel(nextConfig.followUpToIdleMinutes);
  }

  async function installHooks() {
    const actionFeedbackSequence = beginActionFeedback();
    setHookInstallPending(true);
    try {
      const nextStatus = await installCodexHooks();
      if (!mountedRef.current) {
        return;
      }
      setHookStatus(nextStatus);
      if (isLatestActionFeedback(actionFeedbackSequence)) {
        showCommandMessage(
          configRef.current.language === "zh"
            ? nextStatus.installed ? model.copy.codexHooksInstalledLabel : model.copy.installHooksFailedLabel
            : nextStatus.detail,
        );
      }
    } catch (error) {
      if (!mountedRef.current) {
        return;
      }
      if (isLatestActionFeedback(actionFeedbackSequence)) {
        setErrorMessage(messageFromUnknownError(error, model.copy.installHooksFailedLabel));
      }
    } finally {
      if (mountedRef.current) {
        setHookInstallPending(false);
      }
    }
  }

  function hiddenToggleLabel() {
    const hiddenPinnedCount = model.expandableHiddenRows.filter(
      (row) => row.pinned && row.statusTone === "quiet",
    ).length;
    const hiddenAlertCount = model.expandableHiddenCount - hiddenPinnedCount;
    if (hiddenPinnedCount > 0) {
      const alertLabel = hiddenAlertCount > 0
        ? `+${hiddenAlertCount} ${model.copy.hiddenAlertsLabel}, `
        : "";
      return `${alertLabel}+${hiddenPinnedCount} ${model.copy.hiddenPinnedLabel}`;
    }

    return `+${hiddenAlertCount} ${model.copy.hiddenAlertsLabel}`;
  }

  function togglePanelOpen(wasHidden = false) {
    clearAutoCollapseTimer();
    if (wasHidden) {
      setView("panel");
      setPanelOpen(true);
      return;
    }
    setPanelOpen((current) => !current);
  }

  function openPanelTemporarily(keepOpenForStatus: boolean) {
    if (configRef.current.panelMode === "persistent") {
      setPanelOpen(true);
      return;
    }

    clearAutoCollapseTimer();
    setPanelOpen(true);
    if (keepOpenForStatus) {
      return;
    }

    autoCollapseTimerRef.current = window.setTimeout(() => {
      setPanelOpen(false);
    }, configRef.current.autoCollapseDelayMs);
  }

  function clearAutoCollapseTimer() {
    if (autoCollapseTimerRef.current === undefined) {
      return;
    }

    window.clearTimeout(autoCollapseTimerRef.current);
    autoCollapseTimerRef.current = undefined;
  }
}

interface StatusRowProps {
  row: StatusPanelRow;
  pendingAction?: "jump" | "dismiss" | "pin" | "unpin";
  attentionCue?: boolean;
  copy: ReturnType<typeof buildStatusPanelModel>["copy"];
  onJump: (sessionId: string) => void;
  onTogglePinned: (row: StatusPanelRow) => void;
  onDismiss: (row: StatusPanelRow) => void;
}

function StatusRow({
  row,
  pendingAction,
  attentionCue = false,
  copy,
  onJump,
  onTogglePinned,
  onDismiss,
}: StatusRowProps) {
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const evidenceRef = useRef<HTMLSpanElement | null>(null);
  const jumpTitle = pendingAction === "jump" ? copy.openingSessionLabel : copy.jumpBackLabel;
  const pinTitle = pendingAction === "pin"
    ? copy.pinningLabel
    : pendingAction === "unpin"
      ? copy.unpinningLabel
    : row.pinned
      ? copy.unpinLabel
      : copy.pinLabel;
  const dismissTitle = pendingAction === "dismiss" ? copy.dismissingLabel : copy.dismissLabel;
  const rowClassName = [
    "status-row",
    `status-row--${row.displayStatus}`,
    `status-row--${row.statusTone}`,
    row.pinned ? "status-row--pinned" : "",
    attentionCue ? "status-row--attention-cue" : "",
    evidenceOpen ? "status-row--evidence-open" : "",
  ].filter(Boolean).join(" ");

  useEffect(() => {
    if (!evidenceOpen) {
      return;
    }

    function closeEvidenceOnOutsidePointer(event: PointerEvent) {
      const target = event.target instanceof Node ? event.target : null;
      if (target && evidenceRef.current?.contains(target)) {
        return;
      }

      setEvidenceOpen(false);
    }

    document.addEventListener("pointerdown", closeEvidenceOnOutsidePointer);
    return () => {
      document.removeEventListener("pointerdown", closeEvidenceOnOutsidePointer);
    };
  }, [evidenceOpen]);

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
        <p className="status-meta">
          <span className="status-workspace">{rowSubtitle(row)}</span>
          <span className="status-confidence">{copy.confidenceLabels[row.confidence]}</span>
          <span className="status-evidence-anchor" ref={evidenceRef}>
            <button
              type="button"
              className="status-info"
              aria-label={copy.showEvidenceLabel(row.label)}
              aria-expanded={evidenceOpen}
              aria-describedby={evidenceOpen ? `status-evidence-${row.sessionId}` : undefined}
              onClick={() => setEvidenceOpen((current) => !current)}
            >
              i
            </button>
            {evidenceOpen ? (
              <span
                className="status-evidence-popover"
                id={`status-evidence-${row.sessionId}`}
                role="tooltip"
                tabIndex={0}
                onWheel={(event) => event.stopPropagation()}
              >
                {row.evidenceTooltip.split("\n").map((line) => (
                  <span key={line}>{line}</span>
                ))}
              </span>
            ) : null}
          </span>
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
          className="status-action status-action--pin"
          title={pinTitle}
          disabled={pendingAction === "pin" || pendingAction === "unpin"}
          aria-pressed={row.pinned}
          onClick={() => onTogglePinned(row)}
        >
          {pendingAction === "pin" || pendingAction === "unpin" ? <PendingIcon /> : <PinIcon pinned={row.pinned} />}
        </button>
        <button
          type="button"
          className="status-action status-action--dismiss"
          title={dismissTitle}
          disabled={pendingAction === "dismiss"}
          onClick={() => onDismiss(row)}
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

function PinIcon({ pinned }: { pinned: boolean }) {
  return (
    <svg
      aria-hidden="true"
      className={`status-action-icon${pinned ? " status-action-icon--pinned" : ""}`}
      viewBox="0 0 16 16"
    >
      <path d="M6 2h4" />
      <path d="M7 2l-.8 5L4 9h8L9.8 7 9 2" />
      <path d="M8 9v5" />
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

function panelWindowHeight(visibleItemCount: number, hasMessage = false) {
  const normalizedCount = Math.min(8, Math.max(1, visibleItemCount));
  const baseHeight = Math.max(
    PANEL_MIN_HEIGHT,
    PANEL_BASE_HEIGHT + (normalizedCount - PANEL_BASE_VISIBLE_ITEMS) * PANEL_EXTRA_ROW_HEIGHT,
  );

  return Math.min(
    PANEL_MAX_HEIGHT,
    baseHeight + (hasMessage ? PANEL_MESSAGE_HEIGHT : 0),
  );
}

function successfulJumpNotice(target: SessionRow["jumpTarget"], copy: StatusPanelCopy) {
  if (target === "desktop") return copy.openedDesktopSessionLabel;
  if (target === "cli") return copy.openedCliSessionLabel;
  return copy.openedSessionLabel;
}

function hookStatusDetail(
  status: CodexHookIntegrationStatus | null,
  language: StatusPanelConfig["language"],
  copy: StatusPanelCopy,
) {
  if (!status) return copy.checkingCodexHooksLabel;
  if (language !== "zh") return status.detail;
  if (status.detail === "Attn hook commands are installed.") {
    return copy.codexHooksInstalledLabel;
  }
  if (
    status.detail === "Attn hook commands are not installed."
    || status.detail === "Codex hooks.json was not found; Attn can create it."
  ) {
    return copy.codexHooksNotInstalledLabel;
  }
  return status.detail;
}

function messageFromUnknownError(error: unknown, fallback: string) {
  if (error instanceof Error) {
    return error.message;
  }

  return typeof error === "string" ? error : fallback;
}

async function resizePanelWindow(height: number) {
  try {
    await getCurrentWindow().setSize(new LogicalSize(PANEL_WIDTH, height));
  } catch {
    // Browser preview and restricted window capabilities should not block the panel.
  }
}

function startPanelDrag(event: React.PointerEvent<HTMLElement>) {
  if (event.button !== 0 || shouldSkipWindowDrag(event.target)) {
    return;
  }

  try {
    void getCurrentWindow().startDragging().catch(() => undefined);
  } catch {
    // Browser preview does not expose native window dragging.
  }
}

function shouldSkipWindowDrag(target: EventTarget | null) {
  if (!(target instanceof Element)) {
    return false;
  }

  return target.closest("button, input, select, textarea, a, [data-no-window-drag]") !== null;
}

function loadPanelPosition() {
  if (typeof window === "undefined") return null;

  try {
    const storedPosition = window.localStorage.getItem(PANEL_POSITION_STORAGE_KEY);
    if (!storedPosition) return null;
    const position = JSON.parse(storedPosition);
    if (!isPersistablePanelPosition(position)) return null;
    return position;
  } catch {
    return null;
  }
}

function persistPanelPosition(position: { x: number; y: number }) {
  try {
    if (!isPersistablePanelPosition(position)) {
      return;
    }

    window.localStorage.setItem(PANEL_POSITION_STORAGE_KEY, JSON.stringify({ x: position.x, y: position.y }));
  } catch {
    // Position persistence should not affect the panel itself.
  }
}

function isPersistablePanelPosition(value: unknown): value is { x: number; y: number } {
  if (!isObject(value)) return false;
  return Number.isFinite(value.x) && Number.isFinite(value.y);
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
  const preventAutoCollapseStatuses = Array.isArray(value.preventAutoCollapseStatuses)
    ? value.preventAutoCollapseStatuses.filter(isAutoCollapseStatus)
    : defaultStatusPanelConfig.preventAutoCollapseStatuses;
  const visibleItemCount = typeof value.visibleItemCount === "number"
    ? Math.min(8, Math.max(1, value.visibleItemCount))
    : defaultStatusPanelConfig.visibleItemCount;
  const autoCollapseDelayMs = typeof value.autoCollapseDelayMs === "number"
    ? Math.min(120000, Math.max(1000, value.autoCollapseDelayMs))
    : defaultStatusPanelConfig.autoCollapseDelayMs;
  const followUpToIdleMinutes = normalizeFollowUpToIdleMinutes(value.followUpToIdleMinutes);

  return {
    panelToggleShortcut: normalizePanelToggleShortcut(value.panelToggleShortcut),
    styleFamily: value.styleFamily === "atom" ? value.styleFamily : defaultStatusPanelConfig.styleFamily,
    palette: value.palette === "oneDark" ? value.palette : defaultStatusPanelConfig.palette,
    language: value.language === "zh" ? "zh" : "en",
    visibleItemCount,
    panelMode: value.panelMode === "persistent" ? "persistent" : "auto",
    autoCollapseDelayMs,
    followUpToIdleMinutes,
    preventAutoCollapseStatuses,
    statusColors: {
      blocked: colorValue(statusColors.blocked, defaultStatusPanelConfig.statusColors.blocked),
      input: colorValue(statusColors.input, defaultStatusPanelConfig.statusColors.input),
      inspect: colorValue(statusColors.inspect, defaultStatusPanelConfig.statusColors.inspect),
      stopped: colorValue(statusColors.stopped, defaultStatusPanelConfig.statusColors.stopped),
      needed: colorValue(statusColors.needed, defaultStatusPanelConfig.statusColors.needed),
      working: colorValue(statusColors.working, defaultStatusPanelConfig.statusColors.working),
      idle: colorValue(statusColors.idle, defaultStatusPanelConfig.statusColors.idle),
    },
  };
}

function normalizeFollowUpToIdleMinutes(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return defaultStatusPanelConfig.followUpToIdleMinutes;
  }
  return Math.max(20, Math.trunc(value));
}

function hasPreventAutoCollapseStatus(
  model: ReturnType<typeof buildStatusPanelModel>,
  config: StatusPanelConfig,
) {
  const statuses = new Set(config.preventAutoCollapseStatuses);
  return [...model.visibleRows, ...model.hiddenRows].some((row) => statuses.has(row.displayStatus));
}

function isAutoCollapseStatus(value: unknown): value is InterventionStatus {
  return typeof value === "string" && AUTO_COLLAPSE_STATUS_SET.has(value as InterventionStatus);
}

function colorValue(value: unknown, fallback: string) {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function rowSubtitle(row: StatusPanelRow) {
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
