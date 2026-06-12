import type { Confidence, SessionRow } from "../../shared/types/session";

export type InterventionStatus = "blocked" | "input" | "inspect" | "stopped" | "needed" | "working" | "idle";

export interface StatusPanelConfig {
  styleFamily: "atom";
  palette: "oneDark";
  language: "en" | "zh";
  visibleItemCount: number;
  panelMode: "auto" | "persistent";
  autoCollapseDelayMs: number;
  preventAutoCollapseStatuses: InterventionStatus[];
  statusColors: Record<InterventionStatus, string>;
}

export interface InterventionStatusToken {
  label: string;
  marker: "●" | "○";
  color: string;
}

export interface AtomInterventionTheme {
  styleFamily: StatusPanelConfig["styleFamily"];
  palette: StatusPanelConfig["palette"];
  status: Record<InterventionStatus, InterventionStatusToken>;
}

export interface StatusPanelRow extends SessionRow {
  displayStatus: InterventionStatus;
  statusLabel: string;
  statusMarker: "●" | "○";
  statusColor: string;
  statusTone: "alert" | "quiet";
  interventionReason: string;
  evidenceTooltip: string;
  subtaskSummary?: string;
  jumpSessionId?: string;
}

export interface StatusPanelModel {
  visibleRows: StatusPanelRow[];
  hiddenRows: StatusPanelRow[];
  expandableHiddenRows: StatusPanelRow[];
  hiddenCount: number;
  quietHiddenCount: number;
  expandableHiddenCount: number;
  interventionCount: number;
  workingCount: number;
  idleCount: number;
  theme: AtomInterventionTheme;
  copy: StatusPanelCopy;
}

export interface StatusPanelCopy {
  alertsLabel: string;
  workingLabel: string;
  idleLabel: string;
  quietLabel: string;
  hiddenAlertsLabel: string;
  collapseLabel: string;
  managementTitle: string;
  languageLabel: string;
  styleFamilyLabel: string;
  paletteLabel: string;
  visibleItemsLabel: string;
  panelDisplayLabel: string;
  autoCollapseLabel: string;
  persistentLabel: string;
  alertDisplaySecondsLabel: string;
  preventAutoCollapseStatusesLabel: string;
  statusColorsLabel: string;
  blockedColorLabel: string;
  inspectColorLabel: string;
  stoppedColorLabel: string;
  followUpColorLabel: string;
  workingColorLabel: string;
  idleColorLabel: string;
  codexHooksLabel: string;
  checkingCodexHooksLabel: string;
  installCodexHooksLabel: string;
  installingLabel: string;
  codexHooksInstalledLabel: string;
  applySettingsLabel: string;
  backLabel: string;
  emptyPanelLabel: string;
  localDataLabel: string;
  expandPanelLabel: string;
  collapsePanelLabel: string;
  jumpBackLabel: string;
  openingSessionLabel: string;
  dismissLabel: string;
  dismissingLabel: string;
  showEvidenceLabel: (label: string) => string;
  subtaskSummaryLabel: (summary: SubtaskSummary) => string;
  statusPrefix: string;
  evidencePrefix: string;
  lastActivityPrefix: string;
  jumpTargetPrefix: string;
  confidencePrefix: string;
  labelSeparator: string;
  confidenceLabels: Record<Confidence, string>;
  jumpTargetLabels: Record<SessionRow["jumpTarget"], string>;
  sourceStatusLabels: Record<"available" | "degraded" | "unknown", string>;
  sourceNameLabels: Record<string, string>;
}

interface SubtaskSummary {
  total: number;
  counts: Partial<Record<InterventionStatus, number>>;
  jumpRow?: StatusPanelRow;
}

export const defaultStatusPanelConfig: StatusPanelConfig = {
  styleFamily: "atom",
  palette: "oneDark",
  language: "en",
  visibleItemCount: 3,
  panelMode: "auto",
  autoCollapseDelayMs: 8000,
  preventAutoCollapseStatuses: ["inspect"],
  statusColors: {
    blocked: "#e06c75",
    input: "#c678dd",
    inspect: "#61afef",
    stopped: "#d19a66",
    needed: "#e5c07b",
    working: "#98c379",
    idle: "#5c6370",
  },
};

export const atomInterventionTheme: AtomInterventionTheme = {
  styleFamily: "atom",
  palette: "oneDark",
  status: {
    blocked: {
      label: "blocked",
      marker: "●",
      color: defaultStatusPanelConfig.statusColors.blocked,
    },
    input: {
      label: "input",
      marker: "●",
      color: defaultStatusPanelConfig.statusColors.input,
    },
    inspect: {
      label: "inspect",
      marker: "●",
      color: defaultStatusPanelConfig.statusColors.inspect,
    },
    stopped: {
      label: "stopped",
      marker: "●",
      color: defaultStatusPanelConfig.statusColors.stopped,
    },
    needed: {
      label: "follow-up",
      marker: "●",
      color: defaultStatusPanelConfig.statusColors.needed,
    },
    working: {
      label: "working",
      marker: "○",
      color: defaultStatusPanelConfig.statusColors.working,
    },
    idle: {
      label: "idle",
      marker: "○",
      color: defaultStatusPanelConfig.statusColors.idle,
    },
  },
};

const statusPriority: Record<InterventionStatus, number> = {
  blocked: 0,
  input: 1,
  inspect: 2,
  stopped: 3,
  working: 4,
  needed: 5,
  idle: 6,
};

const statusLabels: Record<StatusPanelConfig["language"], Record<InterventionStatus, string>> = {
  en: {
    blocked: "blocked",
    input: "input",
    inspect: "inspect",
    stopped: "stopped",
    needed: "follow-up",
    working: "working",
    idle: "idle",
  },
  zh: {
    blocked: "受阻",
    input: "待介入",
    inspect: "待检查",
    stopped: "已停止",
    needed: "待跟进",
    working: "进行中",
    idle: "空闲",
  },
};

const panelCopy: Record<StatusPanelConfig["language"], StatusPanelCopy> = {
  en: {
    alertsLabel: "alerts",
    workingLabel: "working",
    idleLabel: "idle",
    quietLabel: "quiet",
    hiddenAlertsLabel: "alerts",
    collapseLabel: "collapse",
    managementTitle: "management",
    languageLabel: "Language",
    styleFamilyLabel: "Style family",
    paletteLabel: "Palette",
    visibleItemsLabel: "Visible items",
    panelDisplayLabel: "Panel display",
    autoCollapseLabel: "Auto collapse",
    persistentLabel: "Persistent",
    alertDisplaySecondsLabel: "Alert display seconds",
    preventAutoCollapseStatusesLabel: "Keep open for statuses",
    statusColorsLabel: "Status colors",
    blockedColorLabel: "Blocked color",
    inspectColorLabel: "Inspect color",
    stoppedColorLabel: "Stopped color",
    followUpColorLabel: "Follow-up color",
    workingColorLabel: "Working color",
    idleColorLabel: "Idle color",
    codexHooksLabel: "Codex hooks",
    checkingCodexHooksLabel: "Checking Codex hook status...",
    installCodexHooksLabel: "Install Codex hooks",
    installingLabel: "Installing...",
    codexHooksInstalledLabel: "Codex hooks installed",
    applySettingsLabel: "Apply settings",
    backLabel: "Back",
    emptyPanelLabel: "no active Codex sessions",
    localDataLabel: "local data",
    expandPanelLabel: "Expand status panel",
    collapsePanelLabel: "Collapse status panel",
    jumpBackLabel: "Jump back",
    openingSessionLabel: "Opening session",
    dismissLabel: "Dismiss",
    dismissingLabel: "Dismissing session",
    showEvidenceLabel: (label) => `Show status evidence for ${label}`,
    subtaskSummaryLabel: (summary) => {
      const parts = subtaskSummaryParts(summary, {
        blocked: "blocked",
        input: "input",
        inspect: "inspect",
        stopped: "stopped",
        needed: "follow-up",
        working: "working",
        idle: "idle",
      });
      return `${summary.total} ${summary.total === 1 ? "subtask" : "subtasks"}${parts.length > 0 ? `: ${parts.join(", ")}` : ""}`;
    },
    statusPrefix: "Status",
    evidencePrefix: "Evidence",
    lastActivityPrefix: "Last activity",
    jumpTargetPrefix: "Jump target",
    confidencePrefix: "Confidence",
    labelSeparator: ": ",
    confidenceLabels: {
      exact: "exact",
      inferred: "inferred",
      unknown: "unknown",
      unavailable: "unavailable",
    },
    jumpTargetLabels: {
      desktop: "desktop",
      cli: "cli",
      unknown: "unknown",
    },
    sourceStatusLabels: {
      available: "available",
      degraded: "degraded",
      unknown: "unknown",
    },
    sourceNameLabels: {
      "Codex desktop": "Codex desktop",
    },
  },
  zh: {
    alertsLabel: "需关注",
    workingLabel: "进行中",
    idleLabel: "空闲",
    quietLabel: "安静",
    hiddenAlertsLabel: "需关注",
    collapseLabel: "收起",
    managementTitle: "设置",
    languageLabel: "语言",
    styleFamilyLabel: "样式",
    paletteLabel: "配色",
    visibleItemsLabel: "显示条数",
    panelDisplayLabel: "面板显示",
    autoCollapseLabel: "自动收起",
    persistentLabel: "常驻",
    alertDisplaySecondsLabel: "提醒显示秒数",
    preventAutoCollapseStatusesLabel: "包含这些状态时不收起",
    statusColorsLabel: "状态颜色",
    blockedColorLabel: "受阻颜色",
    inspectColorLabel: "待检查颜色",
    stoppedColorLabel: "已停止颜色",
    followUpColorLabel: "待跟进颜色",
    workingColorLabel: "进行中颜色",
    idleColorLabel: "空闲颜色",
    codexHooksLabel: "Codex 钩子",
    checkingCodexHooksLabel: "正在检查 Codex hook 状态...",
    installCodexHooksLabel: "安装 Codex 钩子",
    installingLabel: "安装中...",
    codexHooksInstalledLabel: "Codex 钩子已安装",
    applySettingsLabel: "应用设置",
    backLabel: "返回",
    emptyPanelLabel: "没有活跃的 Codex 会话",
    localDataLabel: "本地数据",
    expandPanelLabel: "展开状态面板",
    collapsePanelLabel: "收起状态面板",
    jumpBackLabel: "返回会话",
    openingSessionLabel: "正在打开会话",
    dismissLabel: "忽略",
    dismissingLabel: "正在忽略",
    showEvidenceLabel: (label) => `查看 ${label} 的状态依据`,
    subtaskSummaryLabel: (summary) => {
      const parts = subtaskSummaryParts(summary, statusLabels.zh);
      return `${summary.total} 个子任务${parts.length > 0 ? `：${parts.join("，")}` : ""}`;
    },
    statusPrefix: "状态",
    evidencePrefix: "依据",
    lastActivityPrefix: "最后活动",
    jumpTargetPrefix: "跳转目标",
    confidencePrefix: "置信度",
    labelSeparator: "：",
    confidenceLabels: {
      exact: "精确",
      inferred: "推断",
      unknown: "未知",
      unavailable: "不可用",
    },
    jumpTargetLabels: {
      desktop: "桌面端",
      cli: "命令行",
      unknown: "未知",
    },
    sourceStatusLabels: {
      available: "可用",
      degraded: "降级",
      unknown: "未知",
    },
    sourceNameLabels: {
      "Codex desktop": "Codex 桌面端",
    },
  },
};

export function buildStatusPanelModel(
  rows: SessionRow[],
  config = defaultStatusPanelConfig,
): StatusPanelModel {
  const theme = themeFromConfig(config);
  const copy = panelCopy[config.language];
  const panelRows = rows
    .filter((row) => !row.dismissed)
    .filter(shouldIncludeInWatchlist)
    .map((row) => toPanelRow(row, theme, copy))
  const rolledUpRows = rollUpSubagentRows(panelRows, copy).sort(comparePanelRows);
  const cardRows = rolledUpRows.filter((row) => row.displayStatus !== "idle");
  const quietRows = rolledUpRows.filter((row) => row.statusTone === "quiet");
  const visibleRows = cardRows.slice(0, config.visibleItemCount);
  const hiddenRows = cardRows.slice(config.visibleItemCount);
  const expandableHiddenRows = hiddenRows.filter((row) => row.statusTone === "alert");
  const hiddenCount = hiddenRows.length + rolledUpRows.filter((row) => row.displayStatus === "idle").length;
  const quietHiddenCount = hiddenRows.filter((row) => row.statusTone === "quiet").length
    + rolledUpRows.filter((row) => row.displayStatus === "idle").length;

  return {
    visibleRows,
    hiddenRows,
    expandableHiddenRows,
    hiddenCount,
    quietHiddenCount,
    expandableHiddenCount: expandableHiddenRows.length,
    interventionCount: rolledUpRows.filter((row) => row.statusTone === "alert").length,
    workingCount: quietRows.filter((row) => row.displayStatus === "working").length,
    idleCount: rolledUpRows.filter((row) => row.displayStatus === "idle").length,
    theme,
    copy,
  };
}

function rollUpSubagentRows(rows: StatusPanelRow[], copy: StatusPanelCopy) {
  const parentBySessionId = new Map(rows.filter((row) => !isSubagentRow(row)).map((row) => [row.sessionId, row]));
  const parentByWorkspace = parentRowsByWorkspace(rows);
  const summaries = new Map<string, SubtaskSummary>();
  const visibleRows: StatusPanelRow[] = [];

  for (const row of rows) {
    const parent = isSubagentRow(row)
      ? parentForSubagentRow(row, parentBySessionId, parentByWorkspace)
      : undefined;
    if (!parent) {
      visibleRows.push(row);
      continue;
    }

    if (shouldPromoteSubagentRow(row)) {
      visibleRows.push(row);
      continue;
    }

    const summary = summaries.get(parent.sessionId) ?? { total: 0, counts: {} };
    summary.total += 1;
    summary.counts[row.displayStatus] = (summary.counts[row.displayStatus] ?? 0) + 1;
    summary.jumpRow = betterRollupJumpRow(summary.jumpRow, row);
    summaries.set(parent.sessionId, summary);
  }

  return visibleRows.map((row) => {
    const summary = summaries.get(row.sessionId);
    if (!summary) return row;
    const jumpRow = shouldUseRollupJumpRow(row, summary.jumpRow) ? summary.jumpRow : undefined;
    return {
      ...row,
      subtaskSummary: copy.subtaskSummaryLabel(summary),
      ...(jumpRow ? {
        jumpSessionId: jumpRow.sessionId,
        jumpTarget: jumpRow.jumpTarget,
        jumpAvailability: jumpRow.jumpAvailability,
      } : {}),
    };
  });
}

function shouldUseRollupJumpRow(parent: StatusPanelRow, child: StatusPanelRow | undefined) {
  if (!child) return false;
  return !(parent.jumpTarget === "desktop" && parent.jumpAvailability === "exact");
}

function betterRollupJumpRow(current: StatusPanelRow | undefined, candidate: StatusPanelRow) {
  if (!current) return candidate;
  return compareRollupJumpRows(candidate, current) < 0 ? candidate : current;
}

function compareRollupJumpRows(left: StatusPanelRow, right: StatusPanelRow) {
  return jumpTargetPriority(left.jumpTarget)
    - jumpTargetPriority(right.jumpTarget)
    || timestampValue(right.lastActivityAt) - timestampValue(left.lastActivityAt);
}

function jumpTargetPriority(jumpTarget: SessionRow["jumpTarget"]) {
  if (jumpTarget === "desktop") return 0;
  if (jumpTarget === "cli") return 1;
  return 2;
}

function parentForSubagentRow(
  row: StatusPanelRow,
  parentBySessionId: Map<string, StatusPanelRow>,
  parentByWorkspace: Map<string, StatusPanelRow>,
) {
  if (row.parentSessionId) {
    const parent = parentBySessionId.get(row.parentSessionId);
    if (parent) return parent;
  }

  return row.workspacePath ? parentByWorkspace.get(row.workspacePath) : undefined;
}

function parentRowsByWorkspace(rows: StatusPanelRow[]) {
  const parentByWorkspace = new Map<string, StatusPanelRow>();
  for (const row of rows) {
    if (isSubagentRow(row) || !row.workspacePath) continue;
    const current = parentByWorkspace.get(row.workspacePath);
    if (!current || timestampValue(row.lastActivityAt) > timestampValue(current.lastActivityAt)) {
      parentByWorkspace.set(row.workspacePath, row);
    }
  }
  return parentByWorkspace;
}

function isSubagentRow(row: SessionRow) {
  return row.threadSource === "subagent";
}

function shouldPromoteSubagentRow(row: StatusPanelRow) {
  return row.displayStatus === "blocked" || row.displayStatus === "input" || row.displayStatus === "stopped";
}

function subtaskSummaryParts(
  summary: SubtaskSummary,
  labels: Record<InterventionStatus, string>,
) {
  const statuses: InterventionStatus[] = ["blocked", "input", "stopped", "inspect", "needed", "working", "idle"];
  return statuses
    .flatMap((status) => {
      const count = summary.counts[status] ?? 0;
      return count > 0 ? [`${count} ${labels[status]}`] : [];
    });
}

function themeFromConfig(config: StatusPanelConfig): AtomInterventionTheme {
  return {
    styleFamily: config.styleFamily,
    palette: config.palette,
    status: {
      blocked: {
        ...atomInterventionTheme.status.blocked,
        label: statusLabels[config.language].blocked,
        color: config.statusColors.blocked,
      },
      input: {
        ...atomInterventionTheme.status.input,
        label: statusLabels[config.language].input,
        color: config.statusColors.input,
      },
      inspect: {
        ...atomInterventionTheme.status.inspect,
        label: statusLabels[config.language].inspect,
        color: config.statusColors.inspect,
      },
      stopped: {
        ...atomInterventionTheme.status.stopped,
        label: statusLabels[config.language].stopped,
        color: config.statusColors.stopped,
      },
      needed: {
        ...atomInterventionTheme.status.needed,
        label: statusLabels[config.language].needed,
        color: config.statusColors.needed,
      },
      working: {
        ...atomInterventionTheme.status.working,
        label: statusLabels[config.language].working,
        color: config.statusColors.working,
      },
      idle: {
        ...atomInterventionTheme.status.idle,
        label: statusLabels[config.language].idle,
        color: config.statusColors.idle,
      },
    },
  };
}

function comparePanelRows(left: StatusPanelRow, right: StatusPanelRow) {
  const priorityDelta = statusPriority[left.displayStatus] - statusPriority[right.displayStatus];
  if (priorityDelta !== 0) return priorityDelta;

  return timestampValue(right.lastActivityAt) - timestampValue(left.lastActivityAt);
}

function timestampValue(value?: string) {
  if (!value) return 0;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

function toPanelRow(row: SessionRow, theme: AtomInterventionTheme, copy: StatusPanelCopy): StatusPanelRow {
  const displayStatus = displayStatusForRow(row);
  const status = theme.status[displayStatus];

  return {
    ...row,
    displayStatus,
    statusLabel: status.label,
    statusMarker: status.marker,
    statusColor: status.color,
    statusTone: displayStatus === "working" || displayStatus === "idle" ? "quiet" : "alert",
    interventionReason: interventionReasonForRow(row, displayStatus),
    evidenceTooltip: evidenceTooltipForRow(row, copy),
  };
}

function displayStatusForRow(row: SessionRow): InterventionStatus {
  if (row.state === "inspect" || row.state === "dismissable") return "inspect";
  if (row.state === "waitingForInput") return "input";
  if (row.state === "stopped") return "stopped";
  if (row.state === "needsAttention") return "needed";
  if (row.state === "running") return "working";
  if (row.state === "idle") return "idle";
  if (row.state === "unknown" && isAttentionWorthyUnknown(row.confidence, row.statusReason)) {
    return "blocked";
  }

  return "working";
}

function shouldIncludeInWatchlist(row: SessionRow) {
  if (row.state !== "unknown") return true;
  return hasActionableUnknownEvidence(row.statusReason);
}

function isAttentionWorthyUnknown(confidence: Confidence, reason: string) {
  return confidence === "unavailable" || hasActionableUnknownEvidence(reason);
}

function hasActionableUnknownEvidence(reason: string) {
  return /failed|unavailable|blocked|needs attention|approval/i.test(reason);
}

function interventionReasonForRow(row: SessionRow, status: InterventionStatus) {
  if (row.statusReason) return row.statusReason;

  switch (status) {
    case "blocked":
      return "needs attention before work can continue";
    case "input":
      return "waiting for your input";
    case "inspect":
      return "ready to inspect";
    case "stopped":
      return "stopped before completion";
    case "needed":
      return "needs your attention";
    case "working":
      return "working quietly";
    case "idle":
      return "last task completed";
  }
}

function evidenceTooltipForRow(row: SessionRow, copy: StatusPanelCopy) {
  return [
    `${copy.statusPrefix}${copy.labelSeparator}${row.statusReason}`,
    row.evidenceSummary ? `${copy.evidencePrefix}${copy.labelSeparator}${row.evidenceSummary}` : undefined,
    row.lastActivityAt ? `${copy.lastActivityPrefix}${copy.labelSeparator}${row.lastActivityAt}` : undefined,
    `${copy.jumpTargetPrefix}${copy.labelSeparator}${copy.jumpTargetLabels[row.jumpTarget]}`,
    `${copy.confidencePrefix}${copy.labelSeparator}${copy.confidenceLabels[row.confidence]}`,
  ].filter(Boolean).join("\n");
}
