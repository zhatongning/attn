import { describe, expect, it } from "vitest";
import type { SessionRow } from "../../shared/types/session";
import {
  atomInterventionTheme,
  buildStatusPanelModel,
  defaultStatusPanelConfig,
} from "./statusPanel";

const baseRow: SessionRow = {
  sessionId: "s1",
  label: "Task",
  state: "running",
  confidence: "exact",
  statusReason: "running signal observed",
  handled: false,
  dismissed: false,
  pinned: false,
  jumpAvailability: "exact",
  jumpTarget: "desktop",
};

describe("buildStatusPanelModel", () => {
  it("maps source states to intervention display statuses", () => {
    const model = buildStatusPanelModel([
      row("needs-input", "waitingForInput", "waiting for user input"),
      row("stopped", "stopped", "stopped before completion; decide whether to continue, inspect, or dismiss"),
      row("active", "running", "running signal observed"),
      row("complete", "dismissable", "completed task ready for inspect; confirm to mark idle"),
      row("unknown", "unknown", "source status unavailable"),
    ], { ...defaultStatusPanelConfig, visibleItemCount: 4 });

    expect(model.visibleRows.map((item) => [item.sessionId, item.statusLabel])).toEqual([
      ["unknown", "blocked"],
      ["needs-input", "attention"],
      ["complete", "inspect"],
      ["stopped", "stopped"],
    ]);
    expect(model.hiddenRows.map((item) => [item.sessionId, item.statusLabel])).toEqual([
      ["active", "running"],
    ]);
  });

  it("shows one visible item by default and keeps the rest hidden", () => {
    const model = buildStatusPanelModel([
      row("s1", "running", "running signal observed"),
      row("s2", "running", "running signal observed"),
      row("s3", "running", "running signal observed"),
      row("s4", "running", "running signal observed"),
    ]);

    expect(defaultStatusPanelConfig.visibleItemCount).toBe(1);
    expect(model.visibleRows.map((item) => item.sessionId)).toEqual(["s1"]);
    expect(model.hiddenCount).toBe(3);
    expect(model.quietHiddenCount).toBe(3);
  });

  it("defaults to an auto-collapsing panel that does not stay open for any status", () => {
    expect(defaultStatusPanelConfig.panelMode).toBe("auto");
    expect(defaultStatusPanelConfig.autoCollapseDelayMs).toBe(30000);
    expect(defaultStatusPanelConfig.followUpToIdleMinutes).toBe(30);
    expect(defaultStatusPanelConfig.preventAutoCollapseStatuses).toEqual([]);
  });

  it("defaults and localizes the panel shortcut settings contract", () => {
    expect(defaultStatusPanelConfig.panelToggleShortcut).toBe("shift+alt+super+space");

    const english = buildStatusPanelModel([]).copy;
    expect(english.panelToggleShortcutLabel).toBe("Panel shortcut");
    expect(english.recordPanelShortcutLabel).toBe("Record shortcut");
    expect(english.recordingPanelShortcutLabel).toBe("Press a key combination");
    expect(english.clearPanelShortcutLabel).toBe("Clear shortcut");
    expect(english.restorePanelShortcutLabel).toBe("Restore default");
    expect(english.disabledPanelShortcutLabel).toBe("Disabled");
    expect(english.panelShortcutRegistrationErrorLabel).toBe("That shortcut could not be registered.");
    expect(english.currentActivePanelShortcutLabel).toBe("Currently active");
    expect(english.panelShortcutRestartRequiredLabel).toBe("Shortcut state is uncertain. Restart Attn to restore shortcut settings.");

    const chinese = buildStatusPanelModel([], { ...defaultStatusPanelConfig, language: "zh" }).copy;
    expect(chinese.panelToggleShortcutLabel).toBe("面板快捷键");
    expect(chinese.recordPanelShortcutLabel).toBe("录制快捷键");
    expect(chinese.recordingPanelShortcutLabel).toBe("请按下组合键");
    expect(chinese.clearPanelShortcutLabel).toBe("清除快捷键");
    expect(chinese.restorePanelShortcutLabel).toBe("恢复默认");
    expect(chinese.disabledPanelShortcutLabel).toBe("已禁用");
    expect(chinese.panelShortcutRegistrationErrorLabel).toBe("无法注册该快捷键。");
    expect(chinese.currentActivePanelShortcutLabel).toBe("当前生效");
    expect(chinese.panelShortcutRestartRequiredLabel).toBe("快捷键状态不确定。请重启 Attn 后再设置快捷键。");
  });

  it("uses the configured visible item count from management settings", () => {
    const model = buildStatusPanelModel(
      [
        row("blocked", "unknown", "source status unavailable"),
        row("input", "waitingForInput", "waiting for user input"),
        row("working", "running", "running signal observed"),
      ],
      { ...defaultStatusPanelConfig, visibleItemCount: 2 },
    );

    expect(model.visibleRows.map((item) => item.sessionId)).toEqual(["blocked", "input"]);
    expect(model.hiddenCount).toBe(1);
  });

  it("localizes status labels and counters through display config", () => {
    const model = buildStatusPanelModel(
      [
        row("blocked", "unknown", "source status unavailable"),
        row("inspect", "inspect", "completed task ready to inspect; confirm to mark idle"),
        row("input", "waitingForInput", "waiting for user input"),
        row("needed", "needsAttention", "Read recently; keep it quiet during the 30-minute follow-up window."),
        row("idle", "idle", "completed task is no longer recent; idle until the next source signal"),
      ],
      { ...defaultStatusPanelConfig, language: "zh", visibleItemCount: 3 },
    );

    expect(model.visibleRows.map((item) => item.statusLabel)).toEqual(["受阻", "待介入", "待检查"]);
    expect(model.hiddenRows).toEqual([]);
    expect(model.hiddenCount).toBe(2);
    expect(model.quietHiddenCount).toBe(2);
    expect(model.copy.alertsLabel).toBe("需关注");
    expect(model.copy.workingLabel).toBe("进行中");
  });

  it("hides stale unknown sessions without intervention evidence", () => {
    const model = buildStatusPanelModel(
      [
        row("stale-cli", "unknown", "No recent completion or activity signal found."),
        row("working", "running", "running signal observed"),
      ],
      { ...defaultStatusPanelConfig, visibleItemCount: 4 },
    );

    expect([...model.visibleRows, ...model.hiddenRows].map((item) => item.sessionId)).toEqual([
      "working",
    ]);
    expect(model.interventionCount).toBe(0);
    expect(model.workingCount).toBe(1);
  });

  it("hides generic missing-evidence unknown sessions", () => {
    const model = buildStatusPanelModel(
      [
        row("unknown", "unknown", "missing source evidence for status classification"),
        row("working", "running", "running signal observed"),
      ],
      { ...defaultStatusPanelConfig, visibleItemCount: 4 },
    );

    expect([...model.visibleRows, ...model.hiddenRows].map((item) => item.sessionId)).toEqual([
      "working",
    ]);
    expect(model.interventionCount).toBe(0);
  });

  it("uses an unused configured slot for an unpinned quiet follow-up", () => {
    const model = buildStatusPanelModel([
      row("idle", "idle", "completed task observed; idle until the next source signal"),
      row("working", "running", "running signal observed"),
      row("inspect", "dismissable", "failed task can be manually reviewed and cleared"),
      row("needed", "needsAttention", "Read recently; keep it quiet during the 30-minute follow-up window."),
      row("blocked", "unknown", "source status unavailable"),
    ], { ...defaultStatusPanelConfig, visibleItemCount: 5 });

    expect(model.visibleRows.map((item) => item.sessionId)).toEqual([
      "blocked",
      "inspect",
      "working",
      "needed",
    ]);
    expect(model.hiddenRows.map((item) => item.sessionId)).toEqual([]);
    expect(model.visibleRows.find((item) => item.sessionId === "needed")?.statusTone).toBe("quiet");
    expect(model.quietHiddenCount).toBe(1);
    expect(model.hiddenCount).toBe(1);
    expect(model.interventionCount).toBe(2);
  });

  it("keeps an unpinned follow-up in quiet count when primary rows fill configured capacity", () => {
    const model = buildStatusPanelModel([
      row("blocked", "unknown", "source status unavailable"),
      row("working", "running", "running signal observed"),
      row("needed", "needsAttention", "Read recently; keep it quiet during the 30-minute follow-up window."),
    ], { ...defaultStatusPanelConfig, visibleItemCount: 2 });

    expect(model.visibleRows.map((item) => item.sessionId)).toEqual(["blocked", "working"]);
    expect(model.hiddenRows).toEqual([]);
    expect(model.hiddenCount).toBe(1);
    expect(model.quietHiddenCount).toBe(1);
    expect(model.interventionCount).toBe(1);
  });

  it("keeps a pinned follow-up row visible as quiet context", () => {
    const model = buildStatusPanelModel([
      {
        ...row("pinned-follow-up", "needsAttention", "Read recently; keep it quiet during the 30-minute follow-up window."),
        pinned: true,
      },
      row("working", "running", "running signal observed"),
    ], { ...defaultStatusPanelConfig, visibleItemCount: 2 });

    expect(model.visibleRows.map((item) => [item.sessionId, item.displayStatus, item.statusMarker, item.statusTone])).toEqual([
      ["pinned-follow-up", "needed", "○", "quiet"],
      ["working", "working", "○", "quiet"],
    ]);
    expect(model.interventionCount).toBe(0);
  });

  it("keeps an overflow pinned follow-up reachable through manual expansion", () => {
    const model = buildStatusPanelModel([
      {
        ...row("pinned-follow-up-new", "needsAttention", "Read recently; keep it quiet during the 30-minute follow-up window."),
        pinned: true,
        lastActivityAt: "2026-06-15T03:46:00.000Z",
      },
      {
        ...row("pinned-follow-up-old", "needsAttention", "Read recently; keep it quiet during the 30-minute follow-up window."),
        pinned: true,
        lastActivityAt: "2026-06-15T03:20:00.000Z",
      },
    ], { ...defaultStatusPanelConfig, visibleItemCount: 1 });

    expect(model.visibleRows.map((item) => item.sessionId)).toEqual(["pinned-follow-up-new"]);
    expect(model.hiddenRows.map((item) => item.sessionId)).toEqual(["pinned-follow-up-old"]);
    expect(model.expandableHiddenRows.map((item) => item.sessionId)).toEqual(["pinned-follow-up-old"]);
    expect(model.expandableHiddenCount).toBe(1);
    expect(model.quietHiddenCount).toBe(1);
    expect(model.interventionCount).toBe(0);
  });

  it("uses a quiet follow-up fallback when source evidence has no reason", () => {
    const model = buildStatusPanelModel([
      {
        ...row("pinned-follow-up", "needsAttention", ""),
        pinned: true,
      },
    ]);

    expect(model.visibleRows[0].interventionReason).toBe("recently opened; quiet during the follow-up window");
  });

  it("keeps inspect backlog visible ahead of active working sessions", () => {
    const model = buildStatusPanelModel([
      { ...row("inspect-old", "inspect", "completed task ready to inspect; open it to mark read"), lastActivityAt: "2026-06-15T03:20:00.000Z" },
      { ...row("inspect-mid", "inspect", "completed task ready to inspect; open it to mark read"), lastActivityAt: "2026-06-15T03:41:00.000Z" },
      { ...row("inspect-new", "inspect", "completed task ready to inspect; open it to mark read"), lastActivityAt: "2026-06-15T03:46:00.000Z" },
      { ...row("working-wmhcar", "running", "running signal observed"), lastActivityAt: "2026-06-15T03:30:00.000Z" },
      { ...row("working-mos", "running", "running signal observed"), lastActivityAt: "2026-06-15T03:54:00.000Z" },
    ], { ...defaultStatusPanelConfig, visibleItemCount: 3 });

    expect(model.visibleRows.map((item) => item.sessionId)).toEqual([
      "inspect-new",
      "inspect-mid",
      "inspect-old",
    ]);
    expect(model.hiddenRows.map((item) => item.sessionId)).toEqual(["working-mos", "working-wmhcar"]);
  });

  it("keeps pinned inspect rows visible ahead of working sessions and inspect backlog", () => {
    const model = buildStatusPanelModel([
      { ...row("inspect-old", "inspect", "completed task ready to inspect; open it to mark read"), lastActivityAt: "2026-06-15T03:20:00.000Z" },
      { ...row("inspect-new", "inspect", "completed task ready to inspect; open it to mark read"), lastActivityAt: "2026-06-15T03:46:00.000Z" },
      { ...row("working-new", "running", "running signal observed"), lastActivityAt: "2026-06-15T03:54:00.000Z" },
      {
        ...row("pinned-inspect", "inspect", "completed task ready to inspect; open it to mark read"),
        pinned: true,
        lastActivityAt: "2026-06-15T03:30:00.000Z",
      },
    ], { ...defaultStatusPanelConfig, visibleItemCount: 3 });

    expect(model.visibleRows.map((item) => [item.sessionId, item.pinned])).toEqual([
      ["pinned-inspect", true],
      ["inspect-new", false],
      ["inspect-old", false],
    ]);
    expect(model.hiddenRows.map((item) => item.sessionId)).toEqual(["working-new"]);
  });

  it("keeps pinned idle rows visible instead of folding them into quiet hidden count", () => {
    const model = buildStatusPanelModel([
      {
        ...row("pinned-idle", "idle", "Read window expired; idle until the next source signal."),
        pinned: true,
      },
      row("working", "running", "running signal observed"),
    ], { ...defaultStatusPanelConfig, visibleItemCount: 2 });

    expect(model.visibleRows.map((item) => [item.sessionId, item.displayStatus, item.pinned])).toEqual([
      ["pinned-idle", "idle", true],
      ["working", "working", false],
    ]);
    expect(model.hiddenRows).toEqual([]);
    expect(model.hiddenCount).toBe(0);
    expect(model.quietHiddenCount).toBe(0);
  });

  it("uses the Atom intervention theme", () => {
    const model = buildStatusPanelModel([row("input", "waitingForInput", "waiting for user input")]);

    expect(model.theme.styleFamily).toBe("atom");
    expect(model.visibleRows[0].statusMarker).toBe("●");
    expect(model.visibleRows[0].statusLabel).toBe("attention");
    expect(model.visibleRows[0].statusColor).toBe(atomInterventionTheme.status.input.color);
  });

  it("builds a compact source evidence tooltip for each row", () => {
    const model = buildStatusPanelModel([
      {
        ...row("inspect", "inspect", "completed task ready to inspect; open it to mark read"),
        evidenceSummary: "JSONL task_complete at 2026-06-06T04:24:30.041Z",
        lastActivityAt: "2026-06-06T04:24:30.041Z",
        jumpTarget: "desktop",
      },
    ]);

    expect(model.visibleRows[0].evidenceTooltip).toBe([
      "Status: completed task ready to inspect; open it to mark read",
      "Evidence: JSONL task_complete at 2026-06-06T04:24:30.041Z",
      "Last activity: 2026-06-06T04:24:30.041Z",
      "Jump target: desktop",
      "Confidence: exact",
    ].join("\n"));
  });

  it("marks a parent row when active subagents are driving its work", () => {
    const model = buildStatusPanelModel([
      {
        ...row("parent", "running", "running signal observed"),
        activeSubagentCount: 2,
      },
    ], { ...defaultStatusPanelConfig, language: "zh" });

    expect(model.visibleRows[0].activeSubagentCount).toBe(2);
    expect(model.copy.subagentActivityLabel(2)).toBe("子代理活动 · 2");
    expect(model.visibleRows[0].evidenceTooltip).toContain("活跃子代理：2");
  });

  it("keeps idle or non-actionable unknown parents visible while subagents run", () => {
    const model = buildStatusPanelModel([
      {
        ...row("idle-parent", "idle", "completed task is no longer recent"),
        activeSubagentCount: 1,
      },
      {
        ...row("unknown-parent", "unknown", "source status not available yet"),
        confidence: "unknown",
        activeSubagentCount: 1,
      },
    ], { ...defaultStatusPanelConfig, visibleItemCount: 2 });

    expect(model.visibleRows.map((item) => [item.sessionId, item.displayStatus])).toEqual([
      ["idle-parent", "working"],
      ["unknown-parent", "working"],
    ]);
  });

  it("does not mark rows when the active subagent count is absent or invalid", () => {
    const model = buildStatusPanelModel([
      row("missing", "running", "running signal observed"),
      {
        ...row("negative", "running", "running signal observed"),
        activeSubagentCount: -1,
      },
    ], { ...defaultStatusPanelConfig, visibleItemCount: 2 });

    expect(model.visibleRows.map((item) => item.activeSubagentCount)).toEqual([0, 0]);
    expect(model.visibleRows.every((item) => !item.evidenceTooltip.includes("Active subagents"))).toBe(true);
  });

  it("excludes subagent rows from panel cards, counters, and parent summaries", () => {
    const model = buildStatusPanelModel(
      [
        {
          ...row("parent", "running", "running signal observed"),
          workspacePath: "/Users/edy/project",
          threadSource: "user",
        },
        {
          ...row("child-working", "running", "running signal observed"),
          workspacePath: "/Users/edy/project",
          threadSource: "subagent",
          parentSessionId: "parent",
        },
        {
          ...row("child-inspect", "inspect", "completed task ready to inspect; open it to mark read"),
          workspacePath: "/Users/edy/project",
          threadSource: "subagent",
          parentSessionId: "parent",
        },
        {
          ...row("child-input", "waitingForInput", "waiting for user input"),
          workspacePath: "/Users/edy/project",
          parentSessionId: "parent",
        },
        {
          ...row("child-stopped", "stopped", "stopped before completion"),
          workspacePath: "/Users/edy/project",
          threadSource: "subagent",
          parentSessionId: "parent",
        },
        {
          ...row("user-input", "waitingForInput", "waiting for user input"),
          workspacePath: "/Users/edy/other-project",
          threadSource: "user",
        },
      ],
      { ...defaultStatusPanelConfig, visibleItemCount: 4 },
    );

    expect(model.visibleRows.map((item) => item.sessionId)).toEqual(["user-input", "parent"]);
    expect(model.hiddenRows).toEqual([]);
    expect(model.interventionCount).toBe(1);
    expect(model.workingCount).toBe(1);
    expect(model.hiddenCount).toBe(0);
    expect(model.quietHiddenCount).toBe(0);
    expect(model.visibleRows.find((item) => item.sessionId === "parent")).not.toHaveProperty("subtaskSummary");
  });

});

function row(
  sessionId: string,
  state: SessionRow["state"],
  statusReason: string,
): SessionRow {
  return {
    ...baseRow,
    sessionId,
    label: sessionId,
    state,
    statusReason,
  };
}
