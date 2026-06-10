import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import App from "./App";
import { StatusPanelView } from "./features/statusPanel/StatusPanelView";
import type { SessionRow, SourceHealth } from "./shared/types/session";

afterEach(() => {
  cleanup();
});

describe("App", () => {
  it("does not render fake seed sessions before the real source refreshes", () => {
    render(<App />);

    expect(screen.queryByText("AMap geolocation preload investigation")).toBeNull();
    expect(screen.queryByText("Codex: wmhcar")).toBeNull();
    expandPanel();
    expect(screen.getByText("no active Codex sessions")).toBeTruthy();
  });

  it("does not render stale unknown CLI sessions as intervention cards", () => {
    render(
      <StatusPanelView
        initialRows={[
          {
            ...baseRow,
            sessionId: "019e6d7a-0415-7b53-9238-cb859a00010c",
            label: "Codex: wmhcar",
            workspacePath: "/Users/edy/hose/tmc/wmhcar",
            state: "unknown",
            confidence: "inferred",
            statusReason: "No recent completion or activity signal found.",
            jumpAvailability: "approximate",
            jumpTarget: "cli",
            projectName: "wmhcar",
          },
        ]}
        sourceHealth={sourceHealth}
      />,
    );

    expect(screen.queryByText("Codex: wmhcar")).toBeNull();
    expandPanel();
    expect(screen.getByText("no active Codex sessions")).toBeTruthy();
  });
});

function expandPanel() {
  fireEvent.click(screen.getByRole("button", { name: "Expand status panel" }));
}

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

const sourceHealth: SourceHealth = {
  sourceName: "Codex desktop",
  status: "available",
  capabilities: [],
};
