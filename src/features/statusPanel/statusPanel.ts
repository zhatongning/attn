import type { Confidence, SessionRow } from "../../shared/types/session";

export type InterventionStatus = "blocked" | "inspect" | "needed" | "working" | "idle";

export interface StatusPanelConfig {
  styleFamily: "atom";
  palette: "oneDark";
  language: "en" | "zh";
  visibleItemCount: number;
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
}

export const defaultStatusPanelConfig: StatusPanelConfig = {
  styleFamily: "atom",
  palette: "oneDark",
  language: "en",
  visibleItemCount: 3,
  statusColors: {
    blocked: "#e06c75",
    inspect: "#61afef",
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
    inspect: {
      label: "inspect",
      marker: "●",
      color: defaultStatusPanelConfig.statusColors.inspect,
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
  inspect: 1,
  needed: 2,
  working: 3,
  idle: 4,
};

const statusLabels: Record<StatusPanelConfig["language"], Record<InterventionStatus, string>> = {
  en: {
    blocked: "blocked",
    inspect: "inspect",
    needed: "follow-up",
    working: "working",
    idle: "idle",
  },
  zh: {
    blocked: "受阻",
    inspect: "待检查",
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
  },
  zh: {
    alertsLabel: "需关注",
    workingLabel: "进行中",
    idleLabel: "空闲",
    quietLabel: "安静",
    hiddenAlertsLabel: "需关注",
    collapseLabel: "收起",
  },
};

export function buildStatusPanelModel(
  rows: SessionRow[],
  config = defaultStatusPanelConfig,
): StatusPanelModel {
  const theme = themeFromConfig(config);
  const panelRows = rows
    .filter((row) => !row.dismissed)
    .filter(shouldIncludeInWatchlist)
    .map((row) => toPanelRow(row, theme))
    .sort(comparePanelRows);
  const visibleRows = panelRows.slice(0, config.visibleItemCount);
  const hiddenRows = panelRows.slice(config.visibleItemCount);
  const expandableHiddenRows = hiddenRows.filter((row) => row.statusTone === "alert");

  return {
    visibleRows,
    hiddenRows,
    expandableHiddenRows,
    hiddenCount: hiddenRows.length,
    quietHiddenCount: hiddenRows.filter((row) => row.statusTone === "quiet").length,
    expandableHiddenCount: expandableHiddenRows.length,
    interventionCount: panelRows.filter((row) => row.statusTone === "alert").length,
    workingCount: panelRows.filter((row) => row.displayStatus === "working").length,
    idleCount: panelRows.filter((row) => row.displayStatus === "idle").length,
    theme,
    copy: panelCopy[config.language],
  };
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
      inspect: {
        ...atomInterventionTheme.status.inspect,
        label: statusLabels[config.language].inspect,
        color: config.statusColors.inspect,
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

function toPanelRow(row: SessionRow, theme: AtomInterventionTheme): StatusPanelRow {
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
  };
}

function displayStatusForRow(row: SessionRow): InterventionStatus {
  if (row.state === "inspect" || row.state === "dismissable") return "inspect";
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
    case "inspect":
      return "ready to inspect";
    case "needed":
      return "needs your attention";
    case "working":
      return "working quietly";
    case "idle":
      return "last task completed";
  }
}
