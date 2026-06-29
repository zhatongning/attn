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
      ["active", "running"],
    ]);
    expect(model.hiddenRows.map((item) => [item.sessionId, item.statusLabel])).toEqual([
      ["stopped", "stopped"],
    ]);
  });

  it("shows three visible items by default and keeps the rest hidden", () => {
    const model = buildStatusPanelModel([
      row("s1", "running", "running signal observed"),
      row("s2", "running", "running signal observed"),
      row("s3", "running", "running signal observed"),
      row("s4", "running", "running signal observed"),
    ]);

    expect(defaultStatusPanelConfig.visibleItemCount).toBe(3);
    expect(model.visibleRows.map((item) => item.sessionId)).toEqual(["s1", "s2", "s3"]);
    expect(model.hiddenCount).toBe(1);
    expect(model.quietHiddenCount).toBe(1);
  });

  it("defaults to an auto-collapsing panel that stays open for eight seconds after alerts", () => {
    expect(defaultStatusPanelConfig.panelMode).toBe("auto");
    expect(defaultStatusPanelConfig.autoCollapseDelayMs).toBe(8000);
    expect(defaultStatusPanelConfig.preventAutoCollapseStatuses).toEqual(["inspect"]);
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
        row("needed", "needsAttention", "Read recently; keep in needed state until 30 minutes pass."),
        row("idle", "idle", "completed task is no longer recent; idle until the next source signal"),
      ],
      { ...defaultStatusPanelConfig, language: "zh" },
    );

    expect(model.visibleRows.map((item) => item.statusLabel)).toEqual(["受阻", "待介入", "待检查"]);
    expect(model.hiddenRows.map((item) => item.statusLabel)).toEqual(["待跟进"]);
    expect(model.copy.alertsLabel).toBe("需关注");
    expect(model.copy.workingLabel).toBe("进行中");
    expect(model.copy.idleLabel).toBe("空闲");
    expect(model.copy.quietLabel).toBe("安静");
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

  it("keeps running rows visible ahead of follow-up rows and moves idle rows into quiet count", () => {
    const model = buildStatusPanelModel([
      row("idle", "idle", "completed task observed; idle until the next source signal"),
      row("working", "running", "running signal observed"),
      row("inspect", "dismissable", "failed task can be manually reviewed and cleared"),
      row("needed", "needsAttention", "Read recently; keep in needed state until 30 minutes pass."),
      row("blocked", "unknown", "source status unavailable"),
    ], { ...defaultStatusPanelConfig, visibleItemCount: 5 });

    expect(model.visibleRows.map((item) => item.sessionId)).toEqual([
      "blocked",
      "inspect",
      "working",
      "needed",
    ]);
    expect(model.hiddenRows.map((item) => item.sessionId)).toEqual([]);
    expect(model.idleCount).toBe(1);
    expect(model.quietHiddenCount).toBe(1);
    expect(model.hiddenCount).toBe(1);
  });

  it("keeps inspect backlog visible ahead of active working sessions", () => {
    const model = buildStatusPanelModel([
      { ...row("inspect-old", "inspect", "completed task ready to inspect; open it to mark read"), lastActivityAt: "2026-06-15T03:20:00.000Z" },
      { ...row("inspect-mid", "inspect", "completed task ready to inspect; open it to mark read"), lastActivityAt: "2026-06-15T03:41:00.000Z" },
      { ...row("inspect-new", "inspect", "completed task ready to inspect; open it to mark read"), lastActivityAt: "2026-06-15T03:46:00.000Z" },
      { ...row("working-wmhcar", "running", "running signal observed"), lastActivityAt: "2026-06-15T03:30:00.000Z" },
      { ...row("working-mos", "running", "running signal observed"), lastActivityAt: "2026-06-15T03:54:00.000Z" },
    ]);

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
    ]);

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
    ]);

    expect(model.visibleRows.map((item) => [item.sessionId, item.displayStatus, item.pinned])).toEqual([
      ["pinned-idle", "idle", true],
      ["working", "working", false],
    ]);
    expect(model.hiddenRows).toEqual([]);
    expect(model.hiddenCount).toBe(0);
    expect(model.quietHiddenCount).toBe(0);
    expect(model.idleCount).toBe(1);
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

  it("rolls quiet subagent rows into a parent summary and promotes intervention subagents", () => {
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
        },
        {
          ...row("child-inspect", "inspect", "completed task ready to inspect; open it to mark read"),
          workspacePath: "/Users/edy/project",
          threadSource: "subagent",
        },
        {
          ...row("child-input", "waitingForInput", "waiting for user input"),
          workspacePath: "/Users/edy/project",
          threadSource: "subagent",
        },
      ],
      { ...defaultStatusPanelConfig, visibleItemCount: 4 },
    );

    expect(model.visibleRows.map((item) => item.sessionId)).toEqual(["child-input", "parent"]);
    expect(model.visibleRows.find((item) => item.sessionId === "parent")?.subtaskSummary).toBe(
      "2 subtasks: 1 inspect, 1 running",
    );
    expect(model.hiddenCount).toBe(0);
  });

  it("suppresses orphaned quiet subagents while promoting orphaned intervention subagents", () => {
    const model = buildStatusPanelModel(
      [
        {
          ...row("child-working", "running", "running signal observed"),
          workspacePath: "/Users/edy/project",
          threadSource: "subagent",
          parentSessionId: "missing-parent",
        },
        {
          ...row("child-inspect", "inspect", "completed task ready to inspect; open it to mark read"),
          workspacePath: "/Users/edy/project",
          threadSource: "subagent",
          parentSessionId: "missing-parent",
        },
        {
          ...row("child-input", "waitingForInput", "waiting for user input"),
          workspacePath: "/Users/edy/project",
          threadSource: "subagent",
          parentSessionId: "missing-parent",
        },
      ],
      { ...defaultStatusPanelConfig, visibleItemCount: 4 },
    );

    expect(model.visibleRows.map((item) => item.sessionId)).toEqual(["child-input"]);
    expect(model.visibleRows[0].subagentMarker).toBe("subagent anomaly");
    expect(model.hiddenRows.map((item) => item.sessionId)).toEqual([]);
  });

  it("keeps rolled-up subagent rows addressable for expansion and group dismiss", () => {
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
          lastActivityAt: "2026-06-15T03:40:00.000Z",
        },
        {
          ...row("child-inspect-old", "inspect", "completed task ready to inspect; open it to mark read"),
          workspacePath: "/Users/edy/project",
          threadSource: "subagent",
          parentSessionId: "parent",
          lastActivityAt: "2026-06-15T03:30:00.000Z",
        },
        {
          ...row("child-inspect-new", "inspect", "completed task ready to inspect; open it to mark read"),
          workspacePath: "/Users/edy/project",
          threadSource: "subagent",
          parentSessionId: "parent",
          lastActivityAt: "2026-06-15T03:50:00.000Z",
        },
      ],
      { ...defaultStatusPanelConfig, visibleItemCount: 4 },
    );

    const parent = model.visibleRows.find((item) => item.sessionId === "parent");

    expect(parent?.subtaskSummary).toBe("3 subtasks: 2 inspect, 1 running");
    expect(parent?.subtaskRows?.map((item) => item.sessionId)).toEqual([
      "child-inspect-new",
      "child-inspect-old",
      "child-working",
    ]);
    expect(parent?.dismissSessionIds).toEqual([
      "parent",
      "child-inspect-new",
      "child-inspect-old",
      "child-working",
    ]);
  });

  it("keeps rolled-up inspect subagents addressable for parent acknowledge", () => {
    const model = buildStatusPanelModel(
      [
        {
          ...row("parent", "inspect", "completed task ready to inspect; open it to mark read"),
          workspacePath: "/Users/edy/project",
          threadSource: "user",
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
          threadSource: "subagent",
          parentSessionId: "parent",
        },
      ],
      { ...defaultStatusPanelConfig, visibleItemCount: 4 },
    );

    const parent = model.visibleRows.find((item) => item.sessionId === "parent");
    const childInput = model.visibleRows.find((item) => item.sessionId === "child-input");

    expect(parent?.acknowledgeSessionIds).toEqual(["parent", "child-inspect"]);
    expect(childInput?.subagentMarker).toBe("subagent anomaly");
  });

  it("uses explicit parent session ids before falling back to workspace grouping", () => {
    const model = buildStatusPanelModel(
      [
        {
          ...row("newer-parent", "running", "running signal observed"),
          workspacePath: "/Users/edy/project",
          lastActivityAt: "2026-06-11T10:10:00.000Z",
          threadSource: "user",
        },
        {
          ...row("actual-parent", "running", "running signal observed"),
          workspacePath: "/Users/edy/project",
          lastActivityAt: "2026-06-11T10:00:00.000Z",
          threadSource: "user",
        },
        {
          ...row("child-working", "running", "running signal observed"),
          workspacePath: "/Users/edy/project",
          lastActivityAt: "2026-06-11T10:20:00.000Z",
          threadSource: "subagent",
          parentSessionId: "actual-parent",
        },
      ],
      { ...defaultStatusPanelConfig, visibleItemCount: 4 },
    );

    expect(model.visibleRows.find((item) => item.sessionId === "actual-parent")?.subtaskSummary).toBe(
      "1 subtask: 1 running",
    );
    expect(model.visibleRows.find((item) => item.sessionId === "newer-parent")?.subtaskSummary).toBeUndefined();
    expect(model.visibleRows.map((item) => item.sessionId)).not.toContain("child-working");
  });

  it("keeps the parent jump target when subagents roll up", () => {
    const model = buildStatusPanelModel(
      [
        {
          ...row("cli-parent", "running", "running signal observed"),
          label: "https://wiki.hosecloud.com/pages/viewpage.action?pageId=580026375",
          workspacePath: "/Users/edy/hose/tmc/wmhcar.feat-SCRD-19749",
          threadSource: "user",
          jumpTarget: "cli",
          jumpAvailability: "approximate",
          lastActivityAt: "2026-06-12T09:53:13.972Z",
        },
        {
          ...row("desktop-child", "running", "running signal observed"),
          workspacePath: "/Users/edy/hose/tmc/wmhcar.feat-SCRD-19749",
          threadSource: "subagent",
          parentSessionId: "cli-parent",
          jumpTarget: "desktop",
          jumpAvailability: "exact",
          lastActivityAt: "2026-06-12T10:02:27.864Z",
        },
      ],
      { ...defaultStatusPanelConfig, visibleItemCount: 4 },
    );

    expect(model.visibleRows).toHaveLength(1);
    expect(model.visibleRows[0]).toMatchObject({
      sessionId: "cli-parent",
      label: "https://wiki.hosecloud.com/pages/viewpage.action?pageId=580026375",
      subtaskSummary: "1 subtask: 1 running",
      jumpTarget: "cli",
      jumpAvailability: "approximate",
    });
    expect(model.visibleRows[0].jumpSessionId).toBeUndefined();
  });

  it("keeps an exact desktop parent as the jump target when desktop subagents roll up", () => {
    const model = buildStatusPanelModel(
      [
        {
          ...row("desktop-parent", "running", "running signal observed"),
          label: "使用hotfix构建发布分支",
          workspacePath: "/Users/edy/hose/tmc/MOS",
          threadSource: "user",
          jumpTarget: "desktop",
          jumpAvailability: "exact",
          lastActivityAt: "2026-06-12T10:34:51.872Z",
        },
        {
          ...row("desktop-child", "inspect", "completed task ready to inspect; open it to mark read"),
          workspacePath: "/Users/edy/hose/tmc/MOS",
          threadSource: "subagent",
          parentSessionId: "desktop-parent",
          jumpTarget: "desktop",
          jumpAvailability: "exact",
          lastActivityAt: "2026-06-12T10:34:52.140Z",
        },
      ],
      { ...defaultStatusPanelConfig, visibleItemCount: 4 },
    );

    expect(model.visibleRows).toHaveLength(1);
    expect(model.visibleRows[0]).toMatchObject({
      sessionId: "desktop-parent",
      label: "使用hotfix构建发布分支",
      subtaskSummary: "1 subtask: 1 inspect",
      jumpTarget: "desktop",
      jumpAvailability: "exact",
    });
    expect(model.visibleRows[0].jumpSessionId).toBeUndefined();
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
