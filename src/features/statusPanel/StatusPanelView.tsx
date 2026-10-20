import { useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import type { CodexHookIntegrationStatus, SessionRow, SourceHealth } from "../../shared/types/session";
import {
  beginPanelDrag,
  dismissSession as dismissSessionCommand,
  configurePanelShortcut,
  configurePositionShortcut,
  PanelShortcutConfigureError,
  installCodexHooks,
  jumpToSession as jumpToSessionCommand,
  loadCodexHookIntegrationStatus,
  loadSessions,
  resizePanel,
  restorePanelPlacement,
  pinSession as pinSessionCommand,
  unpinSession as unpinSessionCommand,
  type LegacyPlacement,
  type PanelCorner,
  type PlacementSnapshot,
  type PlacementFailure,
} from "../inbox/inboxApi";
import {
  buildStatusPanelModel,
  defaultStatusPanelConfig,
  reconcileStatusPanelRows,
  type InterventionStatus,
  type StatusPanelConfig,
  type StatusPanelCopy,
  type StatusPanelRow,
} from "./statusPanel";
import {
  capturePanelShortcut,
  DEFAULT_PANEL_TOGGLE_SHORTCUT,
  DEFAULT_POSITION_CYCLE_SHORTCUT,
  formatPanelShortcut,
  normalizePanelToggleShortcut,
  normalizePositionCycleShortcut,
} from "./panelShortcut";
import { tauriUpdateService } from "../updater/tauriUpdateService";
import { UpdateRestartError, type AvailableUpdate } from "../updater/updateService";
import { isPackagedUpdaterRuntime } from "../updater/updateRuntime";

const STATUS_PANEL_CONFIG_STORAGE_KEY = "attn.statusPanelConfig";
const LEGACY_STATUS_PANEL_CONFIG_STORAGE_KEY = "agent-session-inbox.statusPanelConfig";
const PANEL_POSITION_STORAGE_KEY = "attn.panelPosition";
const PANEL_CORNER_STORAGE_KEY = "attn.panelCorner";
const MANAGEMENT_HEIGHT = 420;
const PANEL_BASE_HEIGHT = 128;
const PANEL_BASE_VISIBLE_ITEMS = 1;
const PANEL_EXTRA_ROW_HEIGHT = 49;
const PANEL_MIN_HEIGHT = PANEL_BASE_HEIGHT - (PANEL_BASE_VISIBLE_ITEMS - 1) * PANEL_EXTRA_ROW_HEIGHT;
const PANEL_MESSAGE_HEIGHT = 32;
const PANEL_MAX_HEIGHT = 420;
const PANEL_STRIP_HEIGHT = 50;
const COMMAND_MESSAGE_DISMISS_DELAY_MS = 3000;
const PANEL_REFRESH_INTERVAL_MS = 30000;
const SESSION_JUMP_SHORTCUT_COUNT = 5;
const AUTO_COLLAPSE_STATUS_OPTIONS: InterventionStatus[] = ["blocked", "input", "inspect", "stopped", "working"];
const AUTO_COLLAPSE_STATUS_SET = new Set<InterventionStatus>(AUTO_COLLAPSE_STATUS_OPTIONS);

interface StatusPanelViewProps {
  initialRows: SessionRow[];
  sourceHealth: SourceHealth;
}

interface PendingPanelRefresh {
  followUpToIdleMinutes: number;
  refreshId: number;
}

interface RefreshPanelOptions {
  invalidateActiveRefresh?: boolean;
}

interface QueuedDirectPanelRefresh extends PendingPanelRefresh {
  completion: Promise<void>;
  resolve: () => void;
}

interface NativeShortcutStatus {
  activeShortcut: string | null;
  stateUncertain: boolean;
}

function nativeShortcutStatusFromError(error: unknown): NativeShortcutStatus {
  if (error instanceof PanelShortcutConfigureError) {
    return { activeShortcut: error.activeShortcut, stateUncertain: error.stateUncertain };
  }
  return { activeShortcut: null, stateUncertain: true };
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
  const [availableUpdate, setAvailableUpdate] = useState<AvailableUpdate | null>(null);
  const [updateInstallState, setUpdateInstallState] = useState<"idle" | "installing" | "restarting">("idle");
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [shortcutRegistrationError, setShortcutRegistrationError] = useState(false);
  const [positionShortcutRegistrationError, setPositionShortcutRegistrationError] = useState(false);
  const [nativeShortcutStatus, setNativeShortcutStatus] = useState<NativeShortcutStatus | null>(null);
  const [nativePositionShortcutStatus, setNativePositionShortcutStatus] = useState<NativeShortcutStatus | null>(null);
  const [shortcutRecording, setShortcutRecording] = useState(false);
  const [positionShortcutRecording, setPositionShortcutRecording] = useState(false);
  const [shortcutApplyPending, setShortcutApplyPending] = useState(false);
  const [sessionSourceUnavailable, setSessionSourceUnavailable] = useState(false);
  const [hookStatus, setHookStatus] = useState<CodexHookIntegrationStatus | null>(null);
  const [hookInstallPending, setHookInstallPending] = useState(false);
  const [pendingActions, setPendingActions] = useState<Record<string, "jump" | "dismiss" | "pin" | "unpin">>({});
  const [attentionCues, setAttentionCues] = useState<Record<string, boolean>>({});
  const [panelOpen, setPanelOpen] = useState(config.panelMode === "persistent");
  const alertSignatureRef = useRef<string | null>(null);
  const autoCollapseTimerRef = useRef<number | undefined>(undefined);
  const latestRefreshIdRef = useRef(0);
  const shortcutErrorGenerationRef = useRef(0);
  const managementPresentationGenerationRef = useRef(0);
  const shortcutUpdateQueueRef = useRef<Promise<void>>(Promise.resolve());
  const shortcutApplyPendingRef = useRef(false);
  const shortcutFailedWhileDismissedRef = useRef(false);
  const shortcutVisibilityDismissedRef = useRef(false);
  const activeRefreshPromiseRef = useRef<Promise<void> | null>(null);
  const queuedDirectRefreshRef = useRef<QueuedDirectPanelRefresh | null>(null);
  const jumpNoticeTimerRef = useRef<number | undefined>(undefined);
  const actionFeedbackSequenceRef = useRef(0);
  const mountedRef = useRef(true);
  const availableUpdateRef = useRef<AvailableUpdate | null>(null);
  const updateInstallPendingRef = useRef(false);
  const sessionShortcutRowsRef = useRef<StatusPanelRow[]>([]);
  const jumpToSessionRef = useRef<(sessionId: string) => void>(() => undefined);
  const [legacyPlacement] = useState(loadLegacyPlacement);
  const initialPlacementRestoreRef = useRef<Promise<boolean>>(Promise.resolve(true));
  const latestRequestedGenerationRef = useRef(0);
  const latestPlacementEventGenerationRef = useRef(0);
  const confirmedGenerationRef = useRef(-1);
  const confirmedPlacementSequenceRef = useRef(0);
  const latestPersistenceErrorGenerationRef = useRef(-1);
  const [confirmedPlacement, setConfirmedPlacement] = useState<PlacementSnapshot | null>(null);
  const [placementUnconfirmed, setPlacementUnconfirmed] = useState<PlacementFailure | null>(null);
  const [placementPersistenceError, setPlacementPersistenceError] = useState<PlacementFailure | null>(null);
  const model = useMemo(() => buildStatusPanelModel(rows, config), [config, rows]);
  const sessionShortcutRows = useMemo(() => {
    return buildStatusPanelModel(rows, { ...config, visibleItemCount: SESSION_JUMP_SHORTCUT_COUNT }).visibleRows;
  }, [config, rows]);
  sessionShortcutRowsRef.current = sessionShortcutRows;
  const displayedRows = expanded ? [...model.visibleRows, ...model.expandableHiddenRows] : model.visibleRows;
  const hasPendingJump = Object.values(pendingActions).includes("jump");
  const actionMessage = errorMessage ?? commandMessage;
  const updatePromptVisible = availableUpdate !== null || updateError !== null;
  const panelMessageCount = Number(actionMessage !== null) + Number(updatePromptVisible);
  const panelHeight = panelWindowHeight(displayedRows.length, panelMessageCount);
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

  function refreshPanel(
    followUpToIdleMinutes = configRef.current.followUpToIdleMinutes,
    { invalidateActiveRefresh = false }: RefreshPanelOptions = {},
  ) {
    if (invalidateActiveRefresh) {
      latestRefreshIdRef.current += 1;
    }
    const refresh = {
      followUpToIdleMinutes,
      refreshId: latestRefreshIdRef.current,
    };

    if (activeRefreshPromiseRef.current) {
      if (invalidateActiveRefresh) {
        return queueDirectPanelRefresh(refresh);
      }

      return queuedDirectRefreshRef.current?.completion ?? activeRefreshPromiseRef.current;
    }

    return startPanelRefresh(refresh);
  }

  function queueDirectPanelRefresh(refresh: PendingPanelRefresh) {
    const queuedRefresh = queuedDirectRefreshRef.current;
    if (queuedRefresh) {
      queuedRefresh.followUpToIdleMinutes = refresh.followUpToIdleMinutes;
      queuedRefresh.refreshId = refresh.refreshId;
      return queuedRefresh.completion;
    }

    let resolveQueuedRefresh: () => void = () => undefined;
    const completion = new Promise<void>((resolve) => {
      resolveQueuedRefresh = resolve;
    });
    queuedDirectRefreshRef.current = {
      ...refresh,
      completion,
      resolve: resolveQueuedRefresh,
    };
    return completion;
  }

  function settleQueuedDirectPanelRefresh() {
    const queuedRefresh = queuedDirectRefreshRef.current;
    queuedDirectRefreshRef.current = null;
    queuedRefresh?.resolve();
  }

  function startPanelRefresh(refresh: PendingPanelRefresh, onSettled?: () => void) {
    const activeRefresh = refreshPanelOnce(refresh);
    activeRefreshPromiseRef.current = activeRefresh;
    void activeRefresh.then(() => {
      onSettled?.();
      if (activeRefreshPromiseRef.current !== activeRefresh) {
        return;
      }

      const queuedRefresh = queuedDirectRefreshRef.current;
      queuedDirectRefreshRef.current = null;
      if (queuedRefresh) {
        startPanelRefresh(queuedRefresh, queuedRefresh.resolve);
        return;
      }

      if (activeRefreshPromiseRef.current === activeRefresh) {
        activeRefreshPromiseRef.current = null;
      }
    });
    return activeRefresh;
  }

  async function refreshPanelOnce({ followUpToIdleMinutes, refreshId }: PendingPanelRefresh) {
    try {
      const loadedRows = await loadSessions(followUpToIdleMinutes);
      if (!mountedRef.current) {
        return;
      }
      if (refreshId !== latestRefreshIdRef.current) {
        return;
      }
      setRows((currentRows) => reconcileStatusPanelRows(currentRows, loadedRows));
      setSessionSourceUnavailable(false);
      setErrorMessage(null);
    } catch (error: unknown) {
      if (!mountedRef.current) {
        return;
      }
      if (refreshId !== latestRefreshIdRef.current) {
        return;
      }
      setSessionSourceUnavailable(true);
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

  function configurePanelShortcutInOrder(shortcut: string | null, isCurrent: () => boolean) {
    const update = shortcutUpdateQueueRef.current.then(() => isCurrent()
      ? configurePanelShortcut(shortcut)
      : { activeShortcut: shortcut });
    shortcutUpdateQueueRef.current = update.then(() => undefined, () => undefined);
    return update;
  }

  function configurePositionShortcutInOrder(shortcut: string | null, isCurrent: () => boolean) {
    const update = shortcutUpdateQueueRef.current.then(() => isCurrent()
      ? configurePositionShortcut(shortcut)
      : { activeShortcut: shortcut });
    shortcutUpdateQueueRef.current = update.then(() => undefined, () => undefined);
    return update;
  }

  useEffect(() => {
    mountedRef.current = true;
    let cancelled = false;
    let refreshTimer: number | undefined;

    const pollAfterCurrentRefresh = async () => {
      await refreshPanel();
      if (cancelled) {
        return;
      }

      refreshTimer = window.setTimeout(() => {
        refreshTimer = undefined;
        void pollAfterCurrentRefresh();
      }, PANEL_REFRESH_INTERVAL_MS);
    };

    void pollAfterCurrentRefresh();
    const shortcutErrorGeneration = shortcutErrorGenerationRef.current;
    void configurePanelShortcutInOrder(configRef.current.panelToggleShortcut, () => !cancelled)
      .then((result) => {
        if (!cancelled) {
          setNativeShortcutStatus({ activeShortcut: result.activeShortcut, stateUncertain: false });
        }
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setNativeShortcutStatus(nativeShortcutStatusFromError(error));
        if (shortcutErrorGeneration === shortcutErrorGenerationRef.current) {
          setShortcutRegistrationError(true);
        }
      });
    void configurePositionShortcutInOrder(configRef.current.positionCycleShortcut, () => !cancelled)
      .then((result) => {
        if (!cancelled && result && (typeof result.activeShortcut === "string" || result.activeShortcut === null)) {
          setNativePositionShortcutStatus({ activeShortcut: result.activeShortcut, stateUncertain: false });
        }
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setNativePositionShortcutStatus(nativeShortcutStatusFromError(error));
        if (shortcutErrorGeneration === shortcutErrorGenerationRef.current) {
          setPositionShortcutRegistrationError(true);
        }
      });
    const dismissShortcutUiOnHide = () => {
      if (cancelled || (!document.hidden && document.visibilityState !== "hidden")) return;
      shortcutErrorGenerationRef.current += 1;
      managementPresentationGenerationRef.current += 1;
      shortcutFailedWhileDismissedRef.current = false;
      shortcutVisibilityDismissedRef.current = true;
      setShortcutRecording(false);
      setPositionShortcutRecording(false);
      setShortcutRegistrationError(false);
      setPositionShortcutRegistrationError(false);
      updateDraftConfig(configRef.current);
      setView("panel");
    };
    document.addEventListener("visibilitychange", dismissShortcutUiOnHide);
    let unlistenToggle: (() => void) | undefined;
    let unlistenMenu: (() => void) | undefined;
    let unlistenSources: (() => void) | undefined;
    let unlistenSessionJump: (() => void) | undefined;

    void listen("agent-session-inbox://sources-changed", () => {
      if (!cancelled) {
        void refreshPanel(configRef.current.followUpToIdleMinutes, { invalidateActiveRefresh: true });
      }
    }).then((unlisten) => {
      if (cancelled) {
        unlisten();
        return;
      }
      unlistenSources = unlisten;
    }).catch(() => undefined);

    void listen<boolean>("agent-session-inbox://toggle-panel", (event) => {
      if (cancelled) {
        return;
      }
      togglePanelOpen(event.payload);
    }).then((unlisten) => {
      if (cancelled) {
        unlisten();
        return;
      }
      unlistenToggle = unlisten;
    }).catch(() => undefined);

    void listen<number>("agent-session-inbox://jump-session", (event) => {
      if (
        cancelled
        || !Number.isInteger(event.payload)
        || event.payload < 1
        || event.payload > SESSION_JUMP_SHORTCUT_COUNT
      ) {
        return;
      }

      const row = sessionShortcutRowsRef.current[event.payload - 1];
      if (row) {
        jumpToSessionRef.current(row.sessionId);
      }
    }).then((unlisten) => {
      if (cancelled) {
        unlisten();
        return;
      }
      unlistenSessionJump = unlisten;
    }).catch(() => undefined);

    void listen<string>("agent-session-inbox://open-management", (event) => {
      if (cancelled) {
        return;
      }
      if (event.payload === "management") {
        setShortcutRecording(false);
        setPositionShortcutRecording(false);
        if (shortcutVisibilityDismissedRef.current || (!shortcutApplyPendingRef.current && !shortcutFailedWhileDismissedRef.current)) {
          updateDraftConfig(configRef.current);
        }
        if (!shortcutApplyPendingRef.current) shortcutVisibilityDismissedRef.current = false;
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
      settleQueuedDirectPanelRefresh();
      actionFeedbackSequenceRef.current += 1;
      if (refreshTimer !== undefined) {
        window.clearTimeout(refreshTimer);
      }
      clearJumpNoticeTimer();
      document.removeEventListener("visibilitychange", dismissShortcutUiOnHide);
      unlistenToggle?.();
      unlistenMenu?.();
      unlistenSources?.();
      unlistenSessionJump?.();
    };
  }, []);

  useEffect(() => {
    if (!isPackagedUpdaterRuntime()) return;

    let cancelled = false;
    void tauriUpdateService.checkForUpdate()
      .then((update) => {
        if (!update) return;
        if (cancelled || !mountedRef.current) {
          void update.close().catch(() => undefined);
          return;
        }

        clearAutoCollapseTimer();
        availableUpdateRef.current = update;
        setAvailableUpdate(update);
        setUpdateError(null);
        setPanelOpen(true);
      })
      // Network and release-channel problems must not interrupt the status panel.
      .catch(() => undefined);

    return () => {
      cancelled = true;
      const update = availableUpdateRef.current;
      availableUpdateRef.current = null;
      if (update) {
        void update.close().catch(() => undefined);
      }
    };
  }, []);

  useEffect(() => {
    if ((!shortcutRecording && !positionShortcutRecording) || view !== "management") return;

    const recordKeydown = (event: KeyboardEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest('input, select, textarea, [contenteditable]:not([contenteditable="false"])')) {
        return;
      }
      event.preventDefault();
      const captured = capturePanelShortcut(event);
      if (captured.status === "captured") {
        updateDraftConfig((current) => ({
          ...current,
          [positionShortcutRecording ? "positionCycleShortcut" : "panelToggleShortcut"]: captured.value,
        }));
      }
      if (captured.status !== "ignored") {
        setShortcutRecording(false);
        setPositionShortcutRecording(false);
      }
    };
    window.addEventListener("keydown", recordKeydown, true);
    return () => window.removeEventListener("keydown", recordKeydown, true);
  }, [shortcutRecording, positionShortcutRecording, view]);

  useEffect(() => {
    configRef.current = config;
    persistConfig(config);
  }, [config]);

  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    let cancelled = false;
    let listeningFailed = false;
    let subscribed = false;
    const unlisteners: Array<() => void> = [];
    const keepListener = (unlisten: () => void) => {
      if (cancelled || listeningFailed) unlisten();
      else unlisteners.push(unlisten);
    };
    const isCurrentGeneration = (generation: number) => generation >= Math.max(
      latestRequestedGenerationRef.current, latestPlacementEventGenerationRef.current,
    );
    const subscribe = async () => {
      try {
        await Promise.all([
          listen<PlacementSnapshot>("agent-session-inbox://placement-confirmed", ({ payload }) => {
            if (cancelled || listeningFailed || !isPlacementSnapshot(payload) || !isCurrentGeneration(payload.generation)) return;
            latestPlacementEventGenerationRef.current = payload.generation;
            confirmedGenerationRef.current = payload.generation;
            confirmedPlacementSequenceRef.current += 1;
            setConfirmedPlacement(payload);
            setPlacementUnconfirmed(null);
            setPlacementPersistenceError((failure) => failure && failure.generation >= payload.generation ? failure : null);
          }).then(keepListener),
          listen<PlacementFailure>("agent-session-inbox://placement-unconfirmed", ({ payload }) => {
            if (cancelled || listeningFailed || !isPlacementFailure(payload) || !isCurrentGeneration(payload.generation)
              || payload.generation <= confirmedGenerationRef.current) return;
            latestPlacementEventGenerationRef.current = payload.generation;
            setPlacementUnconfirmed(payload);
          }).then(keepListener),
          listen<PlacementFailure>("agent-session-inbox://placement-persistence-error", ({ payload }) => {
            if (cancelled || listeningFailed || !isPlacementFailure(payload)
              || payload.generation < Math.max(confirmedGenerationRef.current, latestPersistenceErrorGenerationRef.current)) return;
            // A newer accepted request does not resolve a failed save of the last confirmed move.
            latestPersistenceErrorGenerationRef.current = payload.generation;
            latestPlacementEventGenerationRef.current = Math.max(latestPlacementEventGenerationRef.current, payload.generation);
            setPlacementPersistenceError(payload);
          }).then(keepListener),
        ]);
        subscribed = true;
        if (cancelled) return false;
        await restorePanelPlacement(legacyPlacement);
        return !cancelled;
      } catch {
        if (!subscribed) {
          listeningFailed = true;
          unlisteners.splice(0).forEach((unlisten) => unlisten());
        }
        if (!cancelled) setPlacementUnconfirmed({ generation: latestRequestedGenerationRef.current, reason: "restore failed" });
        return false;
      }
    };
    initialPlacementRestoreRef.current = subscribe();
    return () => {
      cancelled = true;
      unlisteners.forEach((unlisten) => unlisten());
    };
  }, []);

  useEffect(() => {
    const nextHeight = view === "management"
      ? MANAGEMENT_HEIGHT
      : panelOpen
        ? panelHeight
        : PANEL_STRIP_HEIGHT;
    let cancelled = false;
    let confirmationSequenceAtRequest: number | undefined;
    void initialPlacementRestoreRef.current.then(async (ready) => {
      if (!ready || cancelled) return;
      confirmationSequenceAtRequest = confirmedPlacementSequenceRef.current;
      const accepted = await resizePanel(nextHeight);
      if (!cancelled && isPlacementGeneration(accepted?.generation)) {
        latestRequestedGenerationRef.current = Math.max(latestRequestedGenerationRef.current, accepted.generation);
      }
    }).catch(() => {
      // A pre-acceptance rejection has no native generation. A later confirmation supersedes it.
      if (!cancelled && confirmationSequenceAtRequest === confirmedPlacementSequenceRef.current) {
        setPlacementUnconfirmed({ generation: latestRequestedGenerationRef.current, reason: "resize failed" });
      }
    });
    return () => { cancelled = true; };
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
      setRows((currentRows) => reconcileStatusPanelRows(currentRows, updatedRows));
      void refreshPanel(configRef.current.followUpToIdleMinutes, { invalidateActiveRefresh: true });
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
      setRows((currentRows) => reconcileStatusPanelRows(currentRows, previousRows));
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
      setRows((currentRows) => reconcileStatusPanelRows(currentRows, updatedRows));
      void refreshPanel(configRef.current.followUpToIdleMinutes, { invalidateActiveRefresh: true });
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
      setRows((currentRows) => reconcileStatusPanelRows(currentRows, previousRows));
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
      void refreshPanel(configRef.current.followUpToIdleMinutes, { invalidateActiveRefresh: true });
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
  jumpToSessionRef.current = (sessionId) => {
    void jumpToSession(sessionId);
  };

  if (view === "management") {
    return (
      <main className="panel-shell management-shell" data-theme={`${model.theme.styleFamily}-${model.theme.palette}`}>
        <header className="panel-header panel-header--draggable" onPointerDown={startPanelDrag}>
          <div className="panel-title">
            <h1>{model.copy.managementTitle}</h1>
        </div>
        <button type="button" className="icon-button icon-button--back" data-no-window-drag disabled={shortcutApplyPending} onClick={() => {
          if (shortcutApplyPendingRef.current) return;
          shortcutErrorGenerationRef.current += 1;
          managementPresentationGenerationRef.current += 1;
          shortcutFailedWhileDismissedRef.current = false;
          shortcutVisibilityDismissedRef.current = false;
          setShortcutRecording(false);
          setShortcutRegistrationError(false);
          updateDraftConfig(configRef.current);
          setView("panel");
        }}>
          {model.copy.backLabel}
        </button>
        </header>

        <fieldset className="management-section" aria-label={model.copy.managementTitle} disabled={shortcutApplyPending}>
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

          <div className="shortcut-settings" data-no-window-drag>
            <label className="setting-field" htmlFor="panel-toggle-shortcut">
              <span>{model.copy.panelToggleShortcutLabel}</span>
            </label>
            <input
              id="panel-toggle-shortcut"
              className="shortcut-settings__value"
              type="text"
              aria-label={model.copy.panelToggleShortcutLabel}
              readOnly
              value={draftConfig.panelToggleShortcut === null
                ? model.copy.disabledPanelShortcutLabel
                : formatPanelShortcut(draftConfig.panelToggleShortcut)}
            />
            <div className="shortcut-settings__actions">
              <button type="button" data-no-window-drag disabled={shortcutApplyPending} onClick={() => {
                setPositionShortcutRecording(false);
                setShortcutRecording(true);
              }}>
                {model.copy.recordPanelShortcutLabel}
              </button>
              <button type="button" data-no-window-drag disabled={shortcutApplyPending} onClick={() => {
                setShortcutRecording(false);
                updateDraftConfig((current) => ({ ...current, panelToggleShortcut: null }));
              }}>
                {model.copy.clearPanelShortcutLabel}
              </button>
              <button type="button" data-no-window-drag disabled={shortcutApplyPending} onClick={() => {
                setShortcutRecording(false);
                updateDraftConfig((current) => ({ ...current, panelToggleShortcut: DEFAULT_PANEL_TOGGLE_SHORTCUT }));
              }}>
                {model.copy.restorePanelShortcutLabel}
              </button>
            </div>
            {shortcutRecording ? <span className="shortcut-settings__recording" role="status" aria-live="polite" aria-label={model.copy.panelToggleShortcutLabel}>{model.copy.recordingPanelShortcutLabel}</span> : null}
            {shortcutRegistrationError ? <span className="shortcut-settings__error" role="alert">{model.copy.panelShortcutRegistrationErrorLabel}</span> : null}
            {nativeShortcutStatus?.stateUncertain ? (
              <span className="shortcut-settings__error" role="status" aria-label={model.copy.panelToggleShortcutLabel}>{model.copy.panelShortcutRestartRequiredLabel}</span>
            ) : nativeShortcutStatus && nativeShortcutStatus.activeShortcut !== draftConfig.panelToggleShortcut ? (
              <span className="shortcut-settings__active" role="status" aria-label={model.copy.panelToggleShortcutLabel}>
                {model.copy.currentActivePanelShortcutLabel}: {nativeShortcutStatus.activeShortcut === null
                  ? model.copy.disabledPanelShortcutLabel
                  : formatPanelShortcut(nativeShortcutStatus.activeShortcut)}
              </span>
            ) : null}
          </div>

          <div className="shortcut-settings" data-no-window-drag>
            <label className="setting-field" htmlFor="position-cycle-shortcut">
              <span>{model.copy.positionCycleShortcutLabel}</span>
            </label>
            <input
              id="position-cycle-shortcut"
              className="shortcut-settings__value"
              type="text"
              aria-label={model.copy.positionCycleShortcutLabel}
              readOnly
              value={draftConfig.positionCycleShortcut === null
                ? model.copy.disabledPanelShortcutLabel
                : formatPanelShortcut(draftConfig.positionCycleShortcut)}
            />
            <div className="shortcut-settings__actions">
              <button type="button" data-no-window-drag disabled={shortcutApplyPending} onClick={() => {
                setShortcutRecording(false);
                setPositionShortcutRecording(true);
              }}>
                {model.copy.recordPositionShortcutLabel}
              </button>
              <button type="button" data-no-window-drag disabled={shortcutApplyPending} onClick={() => {
                setPositionShortcutRecording(false);
                updateDraftConfig((current) => ({ ...current, positionCycleShortcut: null }));
              }}>
                {model.copy.clearPositionShortcutLabel}
              </button>
              <button type="button" data-no-window-drag disabled={shortcutApplyPending} onClick={() => {
                setPositionShortcutRecording(false);
                updateDraftConfig((current) => ({ ...current, positionCycleShortcut: DEFAULT_POSITION_CYCLE_SHORTCUT }));
              }}>
                {model.copy.restorePositionShortcutLabel}
              </button>
            </div>
            {positionShortcutRecording ? <span className="shortcut-settings__recording" role="status" aria-live="polite" aria-label={model.copy.positionCycleShortcutLabel}>{model.copy.recordingPanelShortcutLabel}</span> : null}
            {positionShortcutRegistrationError ? <span className="shortcut-settings__error" role="alert">{model.copy.panelShortcutRegistrationErrorLabel}</span> : null}
            {nativePositionShortcutStatus?.stateUncertain ? (
              <span className="shortcut-settings__error" role="status">{model.copy.panelShortcutRestartRequiredLabel}</span>
            ) : nativePositionShortcutStatus && nativePositionShortcutStatus.activeShortcut !== draftConfig.positionCycleShortcut ? (
              <span className="shortcut-settings__active" role="status">
                {model.copy.currentActivePanelShortcutLabel}: {nativePositionShortcutStatus.activeShortcut === null
                  ? model.copy.disabledPanelShortcutLabel
                  : formatPanelShortcut(nativePositionShortcutStatus.activeShortcut)}
              </span>
            ) : null}
            <span role="status" aria-live="polite" aria-label={config.language === "zh" ? "面板位置" : "Panel position"}>
              {panelPlacementLabel(confirmedPlacement, config.language)}
            </span>
            {placementUnconfirmed ? <span className="shortcut-settings__error" role="alert">
              {config.language === "zh" ? "面板位置未能确认，保留上次确认的位置。" : "Panel position could not be confirmed. Last confirmed position retained."}
            </span> : null}
            {placementPersistenceError ? <span className="shortcut-settings__error" role="alert">
              {config.language === "zh" ? "无法保存面板位置。" : "Unable to save panel position."}
            </span> : null}
          </div>

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
            <button type="button" disabled={shortcutApplyPending} onClick={applyDraftConfig}>
              {model.copy.applySettingsLabel}
            </button>
          </div>
        </fieldset>
      </main>
    );
  }

  function sessionCounters() {
    if (sessionSourceUnavailable) {
      return (
        <div className="panel-counters" aria-label="Session counters">
          <span className="panel-counter--unavailable">{model.copy.loadSourceFailedLabel}</span>
        </div>
      );
    }

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

          {actionMessage ? (
            <div className="panel-message" role="status">
              {actionMessage}
            </div>
          ) : null}
          {updatePromptVisible ? (
            <UpdatePrompt
              update={availableUpdate}
              installState={updateInstallState}
              error={updateError}
              language={config.language}
              onInstall={installAvailableUpdate}
              onDismiss={dismissUpdatePrompt}
            />
          ) : null}
        </>
      ) : null}
    </main>
  );

  async function installAvailableUpdate() {
    const update = availableUpdate;
    if (!update || updateInstallState !== "idle" || updateInstallPendingRef.current) return;

    availableUpdateRef.current = null;
    updateInstallPendingRef.current = true;
    setUpdateError(null);
    setUpdateInstallState("installing");
    try {
      await tauriUpdateService.installAndRelaunch(update);
      if (mountedRef.current) {
        setUpdateInstallState("restarting");
      }
    } catch (error) {
      if (!mountedRef.current) return;
      setAvailableUpdate(null);
      setUpdateInstallState("idle");
      setUpdateError(updateInstallFailureMessage(error, configRef.current.language));
      updateInstallPendingRef.current = false;
    }
  }

  function dismissUpdatePrompt() {
    if (updateInstallState !== "idle" || updateInstallPendingRef.current) return;

    const update = availableUpdate;
    availableUpdateRef.current = null;
    setAvailableUpdate(null);
    setUpdateError(null);
    if (update) {
      void update.close().catch(() => undefined);
    }
  }

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

  async function applyDraftConfig() {
    if (shortcutApplyPendingRef.current) return;
    shortcutApplyPendingRef.current = true;
    shortcutFailedWhileDismissedRef.current = false;
    shortcutVisibilityDismissedRef.current = false;
    shortcutErrorGenerationRef.current += 1;
    const shortcutErrorGeneration = shortcutErrorGenerationRef.current;
    const managementPresentationGeneration = managementPresentationGenerationRef.current;
    const nextConfig = normalizeConfig(draftConfigRef.current);
    setShortcutRecording(false);
    setPositionShortcutRecording(false);
    setShortcutApplyPending(true);
    try {
      const [toggleUpdate, positionUpdate] = await Promise.allSettled([
        configurePanelShortcutInOrder(nextConfig.panelToggleShortcut, () => mountedRef.current),
        configurePositionShortcutInOrder(nextConfig.positionCycleShortcut, () => mountedRef.current),
      ]);
      if (!mountedRef.current) return;
      if (toggleUpdate.status === "fulfilled" && toggleUpdate.value) {
        setNativeShortcutStatus({ activeShortcut: toggleUpdate.value.activeShortcut, stateUncertain: false });
      } else if (toggleUpdate.status === "rejected") {
        setNativeShortcutStatus(nativeShortcutStatusFromError(toggleUpdate.reason));
      }
      if (positionUpdate.status === "fulfilled" && positionUpdate.value) {
        setNativePositionShortcutStatus({ activeShortcut: positionUpdate.value.activeShortcut, stateUncertain: false });
      } else if (positionUpdate.status === "rejected") {
        setNativePositionShortcutStatus(nativeShortcutStatusFromError(positionUpdate.reason));
      }
      const committedConfig = {
        ...nextConfig,
        panelToggleShortcut: toggleUpdate.status === "rejected"
          ? configRef.current.panelToggleShortcut
          : toggleUpdate.value?.activeShortcut === undefined
          ? nextConfig.panelToggleShortcut
          : toggleUpdate.value.activeShortcut,
        positionCycleShortcut: positionUpdate.status === "rejected"
          ? configRef.current.positionCycleShortcut
          : positionUpdate.value?.activeShortcut === undefined
          ? nextConfig.positionCycleShortcut
          : positionUpdate.value.activeShortcut,
      };
      commitConfig(committedConfig);
      const failed = toggleUpdate.status === "rejected" || positionUpdate.status === "rejected";
      updateDraftConfig(shortcutVisibilityDismissedRef.current
        ? committedConfig
        : {
          ...committedConfig,
          panelToggleShortcut: toggleUpdate.status === "rejected"
            ? nextConfig.panelToggleShortcut : committedConfig.panelToggleShortcut,
          positionCycleShortcut: positionUpdate.status === "rejected"
            ? nextConfig.positionCycleShortcut : committedConfig.positionCycleShortcut,
        });
      shortcutFailedWhileDismissedRef.current = failed
        && shortcutErrorGeneration !== shortcutErrorGenerationRef.current
        && !shortcutVisibilityDismissedRef.current;
      if (shortcutErrorGeneration === shortcutErrorGenerationRef.current) {
        setShortcutRegistrationError(toggleUpdate.status === "rejected");
        setPositionShortcutRegistrationError(positionUpdate.status === "rejected");
      }
      shortcutVisibilityDismissedRef.current = false;
      if (!failed && managementPresentationGeneration === managementPresentationGenerationRef.current) {
        setView("panel");
      }
      void refreshPanel(committedConfig.followUpToIdleMinutes, { invalidateActiveRefresh: true });
    } finally {
      shortcutApplyPendingRef.current = false;
      if (mountedRef.current) setShortcutApplyPending(false);
    }
  }

  function commitConfig(nextConfig: StatusPanelConfig) {
    const nextModel = buildStatusPanelModel(rows, nextConfig);
    clearAutoCollapseTimer();
    configRef.current = nextConfig;
    setConfig(nextConfig);
    setPanelOpen(nextConfig.panelMode === "persistent" || hasPreventAutoCollapseStatus(nextModel, nextConfig));
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
      shortcutErrorGenerationRef.current += 1;
      managementPresentationGenerationRef.current += 1;
      setShortcutRecording(false);
      setPositionShortcutRecording(false);
      setShortcutRegistrationError(false);
      setPositionShortcutRegistrationError(false);
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

interface UpdatePromptProps {
  update: AvailableUpdate | null;
  installState: "idle" | "installing" | "restarting";
  error: string | null;
  language: StatusPanelConfig["language"];
  onInstall: () => void;
  onDismiss: () => void;
}

function UpdatePrompt({ update, installState, error, language, onInstall, onDismiss }: UpdatePromptProps) {
  const message = updatePromptMessage(update, installState, error, language);
  const canConfirm = update !== null && installState === "idle" && error === null;
  const canDismiss = installState === "idle";
  const installLabel = language === "zh" ? "更新" : "Update";
  const dismissLabel = error ? (language === "zh" ? "关闭" : "Dismiss") : (language === "zh" ? "稍后" : "Later");
  const installAriaLabel = update
    ? language === "zh" ? `下载 ${update.version} 并重启 Attn` : `Download ${update.version} and restart Attn`
    : installLabel;

  return (
    <div className={`panel-message update-prompt${error ? " update-prompt--error" : ""}`} role="status" aria-live="polite">
      <span className="update-prompt__message" title={message}>{message}</span>
      <span className="update-prompt__actions">
        {canConfirm ? (
          <button type="button" aria-label={installAriaLabel} title={installAriaLabel} onClick={onInstall}>
            {installLabel}
          </button>
        ) : null}
        {canDismiss ? (
          <button type="button" aria-label={dismissLabel} onClick={onDismiss}>
            {dismissLabel}
          </button>
        ) : null}
      </span>
    </div>
  );
}

function updatePromptMessage(
  update: AvailableUpdate | null,
  installState: UpdatePromptProps["installState"],
  error: string | null,
  language: StatusPanelConfig["language"],
) {
  if (error) return error;
  if (!update) return language === "zh" ? "无法检查更新。" : "Unable to check for updates.";
  if (installState === "installing") {
    return language === "zh"
      ? `正在下载并安装 ${update.version}...`
      : `Downloading and installing ${update.version}...`;
  }
  if (installState === "restarting") {
    return language === "zh" ? "正在重启 Attn..." : "Restarting Attn...";
  }
  return language === "zh" ? `发现新版本 ${update.version}` : `Update ${update.version} is ready`;
}

function updateInstallFailureMessage(error: unknown, language: StatusPanelConfig["language"]) {
  if (error instanceof UpdateRestartError) {
    return language === "zh" ? "更新已安装，但 Attn 无法重启。" : error.message;
  }

  const detail = messageFromUnknownError(
    error,
    language === "zh" ? "更新下载或安装失败。" : "Update download or installation failed.",
  );
  return language === "zh" ? `无法安装更新：${detail}` : `Unable to install update: ${detail}`;
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
  const activeSubagentCount = row.activeSubagentCount ?? 0;
  const hasActiveSubagents = activeSubagentCount > 0;
  const rowClassName = [
    "status-row",
    `status-row--${row.displayStatus}`,
    `status-row--${row.statusTone}`,
    hasActiveSubagents ? "status-row--subagent-active" : "",
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
          {hasActiveSubagents ? (
            <span
              className="status-subagent-badge"
              aria-label={copy.subagentActivityLabel(activeSubagentCount)}
              data-testid={`status-subagent-${row.sessionId}`}
              title={copy.subagentActivityLabel(activeSubagentCount)}
            >
              {copy.subagentActivityLabel(activeSubagentCount)}
            </span>
          ) : null}
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

function panelWindowHeight(visibleItemCount: number, messageCount = 0) {
  const normalizedCount = Math.min(8, Math.max(1, visibleItemCount));
  const baseHeight = Math.max(
    PANEL_MIN_HEIGHT,
    PANEL_BASE_HEIGHT + (normalizedCount - PANEL_BASE_VISIBLE_ITEMS) * PANEL_EXTRA_ROW_HEIGHT,
  );

  return Math.min(
    PANEL_MAX_HEIGHT,
    baseHeight + Math.max(0, messageCount) * PANEL_MESSAGE_HEIGHT,
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

function startPanelDrag(event: React.PointerEvent<HTMLElement>) {
  if (event.button !== 0 || shouldSkipWindowDrag(event.target)) {
    return;
  }

  void beginPanelDrag().catch(() => undefined);
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

function loadPanelCorner(): PanelCorner | null {
  if (typeof window === "undefined") return null;
  try {
    const value = window.localStorage.getItem(PANEL_CORNER_STORAGE_KEY);
    return isPanelCorner(value) ? value : null;
  } catch {
    return null;
  }
}

function loadLegacyPlacement(): LegacyPlacement | null {
  const position = loadPanelPosition();
  return position ? { position, corner: loadPanelCorner() } : null;
}

function isPanelCorner(value: unknown): value is PanelCorner {
  return value === "top-left" || value === "top-right" || value === "bottom-right" || value === "bottom-left";
}

function isPersistablePanelPosition(value: unknown): value is { x: number; y: number } {
  if (!isObject(value)) return false;
  const isPhysicalCoordinate = (coordinate: unknown) => typeof coordinate === "number"
    && Number.isInteger(coordinate) && coordinate >= -2147483648 && coordinate <= 2147483647;
  return isPhysicalCoordinate(value.x) && isPhysicalCoordinate(value.y);
}

function isPlacementGeneration(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPlacementSnapshot(value: unknown): value is PlacementSnapshot {
  if (!isObject(value) || !isPlacementGeneration(value.generation)
    || (value.corner !== null && !isPanelCorner(value.corner))
    || !isPersistablePanelPosition(value.frame)) return false;
  const frame = value.frame as Record<string, unknown>;
  return typeof frame.width === "number" && Number.isInteger(frame.width) && frame.width > 0
    && typeof frame.height === "number" && Number.isInteger(frame.height) && frame.height > 0;
}

function isPlacementFailure(value: unknown): value is PlacementFailure {
  return isObject(value) && isPlacementGeneration(value.generation) && typeof value.reason === "string";
}

function panelPlacementLabel(placement: PlacementSnapshot | null, language: StatusPanelConfig["language"]) {
  if (!placement) return language === "zh" ? "未知（等待确认）" : "Unknown (awaiting confirmation)";
  if (placement.corner === null) return language === "zh" ? "自由位置" : "Free position";
  const labels = {
    "top-left": ["Top Left", "左上角"],
    "top-right": ["Top Right", "右上角"],
    "bottom-right": ["Bottom Right", "右下角"],
    "bottom-left": ["Bottom Left", "左下角"],
  };
  return labels[placement.corner][language === "zh" ? 1 : 0];
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
    positionCycleShortcut: normalizePositionCycleShortcut(value.positionCycleShortcut),
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
