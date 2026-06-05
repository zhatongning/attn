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
  jumpAvailability: "exact",
  jumpTarget: "desktop",
};

describe("buildStatusPanelModel", () => {
  it("maps source states to intervention display statuses", () => {
    const model = buildStatusPanelModel([
      row("needs-input", "needsAttention", "waiting for user input"),
      row("active", "running", "running signal observed"),
      row("complete", "dismissable", "completed task ready for inspect; confirm to mark idle"),
      row("unknown", "unknown", "source status unavailable"),
    ]);

    expect(model.visibleRows.map((item) => [item.sessionId, item.statusLabel])).toEqual([
      ["unknown", "blocked"],
      ["complete", "inspect"],
      ["needs-input", "needed"],
    ]);
    expect(model.hiddenRows.map((item) => [item.sessionId, item.statusLabel])).toEqual([
      ["active", "working"],
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

  it("uses the configured visible item count from management settings", () => {
    const model = buildStatusPanelModel(
      [
        row("blocked", "unknown", "source status unavailable"),
        row("input", "needsAttention", "waiting for user input"),
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
        row("needed", "needsAttention", "waiting for user input"),
        row("idle", "idle", "completed task is no longer recent; idle until the next source signal"),
      ],
      { ...defaultStatusPanelConfig, language: "zh" },
    );

    expect(model.visibleRows.map((item) => item.statusLabel)).toEqual(["受阻", "待检查", "需处理"]);
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

  it("sorts blocked, inspect, needed, working, then idle", () => {
    const model = buildStatusPanelModel([
      row("idle", "idle", "completed task observed; idle until the next source signal"),
      row("working", "running", "running signal observed"),
      row("inspect", "dismissable", "failed task can be manually reviewed and cleared"),
      row("needed", "needsAttention", "waiting for user input"),
      row("blocked", "unknown", "source status unavailable"),
    ], { ...defaultStatusPanelConfig, visibleItemCount: 5 });

    expect(model.visibleRows.map((item) => item.sessionId)).toEqual([
      "blocked",
      "inspect",
      "needed",
      "working",
      "idle",
    ]);
  });

  it("uses the Atom intervention theme", () => {
    const model = buildStatusPanelModel([row("input", "needsAttention", "waiting for user input")]);

    expect(model.theme.styleFamily).toBe("atom");
    expect(model.visibleRows[0].statusMarker).toBe("●");
    expect(model.visibleRows[0].statusLabel).toBe("needed");
    expect(model.visibleRows[0].statusColor).toBe(atomInterventionTheme.status.needed.color);
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
