import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error This test reads local CSS without adding Node types to the app build.
import { readFileSync } from "node:fs";
// @ts-expect-error This test reads local CSS without adding Node types to the app build.
import { join } from "node:path";
import type { SessionRow } from "../../shared/types/session";
import { fakeSourceHealth, initialSessions } from "../inbox/fakeSessions";
import { StatusPanelView } from "./StatusPanelView";

const tauriWindowMock = vi.hoisted(() => ({
  setSize: vi.fn(async () => undefined),
  setPosition: vi.fn(async () => undefined),
  startDragging: vi.fn(async () => undefined),
  onMoved: vi.fn(async (_handler: unknown) => vi.fn()),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => vi.fn()),
}));

const tauriCoreMock = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: tauriCoreMock.invoke,
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: vi.fn(() => ({
    setSize: tauriWindowMock.setSize,
    setPosition: tauriWindowMock.setPosition,
    startDragging: tauriWindowMock.startDragging,
    onMoved: tauriWindowMock.onMoved,
  })),
}));

vi.mock("@tauri-apps/api/dpi", () => ({
  LogicalSize: class LogicalSize {
    type = "Logical";
    constructor(public width: number, public height: number) {}
  },
  PhysicalPosition: class PhysicalPosition {
    type = "Physical";
    constructor(public x: number, public y: number) {}
  },
}));

afterEach(() => {
  vi.useRealTimers();
  window.localStorage.clear();
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  tauriWindowMock.setSize.mockClear();
  tauriWindowMock.setPosition.mockClear();
  tauriWindowMock.startDragging.mockClear();
  tauriWindowMock.onMoved.mockReset();
  tauriWindowMock.onMoved.mockImplementation(async (_handler: unknown) => vi.fn());
  tauriCoreMock.invoke.mockReset();
  cleanup();
  vi.unstubAllGlobals();
});

describe("StatusPanelView", () => {
  it("renders an Atom intervention watchlist with a hidden quiet count", () => {
    render(
      <StatusPanelView
        initialRows={[
          ...initialSessions,
          {
            ...initialSessions[0],
            sessionId: "extra-working",
            label: "Extra working session",
            state: "running",
            statusReason: "running signal observed",
          },
        ]}
        sourceHealth={fakeSourceHealth}
      />,
    );
    expandPanel();

    const panel = screen.getByRole("main");
    const statusRows = within(panel).getAllByRole("article");

    expect(screen.getByText("Attn")).toBeTruthy();
    expect(screen.queryByText("$")).toBeNull();
    expect(statusRows).toHaveLength(3);
    expect(screen.getByText(/quiet/)).toBeTruthy();
  });

  it("starts collapsed as a compact status strip", () => {
    render(<StatusPanelView initialRows={initialSessions} sourceHealth={fakeSourceHealth} />);

    expect(screen.getByRole("main").className).toContain("panel-shell--collapsed");
    expect(screen.queryByRole("article")).toBeNull();
    expect(screen.getByText("Attn")).toBeTruthy();
    expect(screen.getByText("1 alerts")).toBeTruthy();
  });

  it("expands the compact strip when clicked", () => {
    render(<StatusPanelView initialRows={initialSessions} sourceHealth={fakeSourceHealth} />);

    fireEvent.click(screen.getByRole("button", { name: "Expand status panel" }));

    expect(screen.getByRole("main").className).not.toContain("panel-shell--collapsed");
    expect(screen.getAllByRole("article")).toHaveLength(2);
  });

  it("auto-expands when a new attention row appears after refresh", async () => {
    const firstRows = initialSessions.filter((row) => row.state !== "needsAttention");
    const nextRows = [
      ...firstRows,
      {
        ...initialSessions[0],
        sessionId: "new-inspect-row",
        label: "New inspect row",
        state: "inspect" as const,
        statusReason: "completed task ready to inspect; open it to mark read",
      },
    ];
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) => {
      const pathname = typeof url === "string" ? url : url instanceof URL ? url.pathname : url.url;
      if (pathname === "/api/sessions") {
        return jsonResponse(nextRows);
      }
      if (pathname === "/api/source-health") return jsonResponse(fakeSourceHealth);
      return jsonResponse({}, 404);
    }));

    render(<StatusPanelView initialRows={firstRows} sourceHealth={fakeSourceHealth} />);
    expect(screen.queryByRole("article")).toBeNull();

    await waitFor(() => {
      expect(screen.getByText("New inspect row")).toBeTruthy();
    });
    expect(screen.getByRole("main").className).not.toContain("panel-shell--collapsed");
  });

  it("auto-collapses after the configured alert display duration", async () => {
    const firstRows = initialSessions.filter((row) => row.state !== "needsAttention");
    const nextRows = [
      ...firstRows,
      {
        ...initialSessions[0],
        sessionId: "timed-follow-up-row",
        label: "Timed follow-up row",
        state: "needsAttention" as const,
        statusReason: "Read recently; keep in needed state until 30 minutes pass.",
      },
    ];
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) => {
      const pathname = typeof url === "string" ? url : url instanceof URL ? url.pathname : url.url;
      if (pathname === "/api/sessions") return jsonResponse(nextRows);
      if (pathname === "/api/source-health") return jsonResponse(fakeSourceHealth);
      return jsonResponse({}, 404);
    }));
    const originalSetTimeout = window.setTimeout.bind(window);
    let autoCollapseCallback: (() => void) | undefined;
    const setTimeoutSpy = vi.spyOn(window, "setTimeout").mockImplementation(((
      handler: TimerHandler,
      timeout?: number,
    ) => {
      if (timeout === 8000 && typeof handler === "function") {
        autoCollapseCallback = () => handler();
        return 8000;
      }

      return originalSetTimeout(handler, timeout);
    }) as typeof window.setTimeout);

    render(<StatusPanelView initialRows={firstRows} sourceHealth={fakeSourceHealth} />);

    await waitFor(() => {
      expect(screen.getByText("Timed follow-up row")).toBeTruthy();
    });
    expect(screen.getByRole("main").className).not.toContain("panel-shell--collapsed");
    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 8000);

    await act(async () => {
      autoCollapseCallback?.();
    });
    await waitFor(() => {
      expect(screen.getByRole("main").className).toContain("panel-shell--collapsed");
    });
    setTimeoutSpy.mockRestore();
  });

  it("keeps the panel open when a configured status is present", async () => {
    const firstRows = initialSessions.filter((row) => row.state !== "needsAttention");
    const nextRows = [
      ...firstRows,
      {
        ...initialSessions[0],
        sessionId: "sticky-inspect-row",
        label: "Sticky inspect row",
        state: "inspect" as const,
        statusReason: "completed task ready to inspect; open it to mark read",
      },
    ];
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) => {
      const pathname = typeof url === "string" ? url : url instanceof URL ? url.pathname : url.url;
      if (pathname === "/api/sessions") return jsonResponse(nextRows);
      if (pathname === "/api/source-health") return jsonResponse(fakeSourceHealth);
      return jsonResponse({}, 404);
    }));
    const originalSetTimeout = window.setTimeout.bind(window);
    const setTimeoutSpy = vi.spyOn(window, "setTimeout").mockImplementation(((
      handler: TimerHandler,
      timeout?: number,
    ) => originalSetTimeout(handler, timeout)) as typeof window.setTimeout);

    render(<StatusPanelView initialRows={firstRows} sourceHealth={fakeSourceHealth} />);

    await waitFor(() => {
      expect(screen.getByText("Sticky inspect row")).toBeTruthy();
    });
    expect(screen.getByRole("main").className).not.toContain("panel-shell--collapsed");
    expect(setTimeoutSpy).not.toHaveBeenCalledWith(expect.any(Function), 8000);

    setTimeoutSpy.mockRestore();
  });

  it("persists panel display behavior after management confirmation", async () => {
    const { listen } = await import("@tauri-apps/api/event");
    let handler: ((event: { payload: string }) => void) | undefined;
    vi.mocked(listen).mockImplementation(async (_event, callback) => {
      handler = callback as (event: { payload: string }) => void;
      return () => undefined;
    });

    const rendered = render(<StatusPanelView initialRows={initialSessions} sourceHealth={fakeSourceHealth} />);
    handler?.({ payload: "management" });

    expect(await screen.findByLabelText("Panel display")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Panel display"), { target: { value: "persistent" } });
    fireEvent.change(screen.getByLabelText("Alert display seconds"), { target: { value: "12" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply settings" }));

    expect(screen.getByRole("main").className).not.toContain("panel-shell--collapsed");
    rendered.unmount();

    render(<StatusPanelView initialRows={initialSessions} sourceHealth={fakeSourceHealth} />);
    expect(screen.getByRole("main").className).not.toContain("panel-shell--collapsed");

    const persistedConfig = JSON.parse(window.localStorage.getItem("attn.statusPanelConfig") ?? "{}");
    expect(persistedConfig.panelMode).toBe("persistent");
    expect(persistedConfig.autoCollapseDelayMs).toBe(12000);
  });

  it("persists statuses that keep the auto panel open after management confirmation", async () => {
    const { listen } = await import("@tauri-apps/api/event");
    let handler: ((event: { payload: string }) => void) | undefined;
    vi.mocked(listen).mockImplementation(async (_event, callback) => {
      handler = callback as (event: { payload: string }) => void;
      return () => undefined;
    });

    render(<StatusPanelView initialRows={initialSessions} sourceHealth={fakeSourceHealth} />);
    handler?.({ payload: "management" });

    expect(await screen.findByText("Keep open for statuses")).toBeTruthy();
    expect((screen.getByLabelText("inspect") as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText("follow-up") as HTMLInputElement).checked).toBe(false);

    fireEvent.click(screen.getByLabelText("follow-up"));
    fireEvent.click(screen.getByRole("button", { name: "Apply settings" }));

    const persistedConfig = JSON.parse(window.localStorage.getItem("attn.statusPanelConfig") ?? "{}");
    expect(persistedConfig.preventAutoCollapseStatuses).toEqual(["inspect", "needed"]);
  });

  it("shows source evidence from an info control beside the workspace name", () => {
    const row: SessionRow = {
      ...initialSessions[0],
      sessionId: "evidence-row",
      label: "Evidence row",
      state: "inspect",
      statusReason: "completed task ready to inspect; open it to mark read",
      evidenceSummary: "JSONL task_complete at 2026-06-06T04:24:30.041Z",
      lastActivityAt: "2026-06-06T04:24:30.041Z",
    };

    render(<StatusPanelView initialRows={[row]} sourceHealth={fakeSourceHealth} />);
    expandPanel();

    expect(screen.queryByRole("tooltip")).toBeNull();

    const infoButton = screen.getByLabelText("Show status evidence for Evidence row");

    fireEvent.click(infoButton);

    const tooltip = screen.getByRole("tooltip");
    expect(tooltip.getAttribute("tabindex")).toBe("0");
    expect(tooltip.textContent).toContain("Status: completed task ready to inspect; open it to mark read");
    expect(tooltip.textContent).toContain("Evidence: JSONL task_complete at 2026-06-06T04:24:30.041Z");
    expect(tooltip.textContent).toContain("Last activity: 2026-06-06T04:24:30.041Z");
    expect(tooltip.textContent).toContain("Jump target: desktop");
    expect(tooltip.textContent).toContain("Confidence: exact");

    fireEvent.click(infoButton);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("closes source evidence when clicking outside but keeps it open inside the popover", () => {
    const row: SessionRow = {
      ...initialSessions[0],
      sessionId: "evidence-outside",
      label: "Evidence outside row",
      state: "inspect",
      statusReason: "completed task ready to inspect; open it to mark read",
      evidenceSummary: "JSONL task_complete at 2026-06-06T04:24:30.041Z",
    };

    render(<StatusPanelView initialRows={[row]} sourceHealth={fakeSourceHealth} />);
    expandPanel();

    fireEvent.click(screen.getByLabelText("Show status evidence for Evidence outside row"));
    const tooltip = screen.getByRole("tooltip");

    fireEvent.pointerDown(tooltip);
    expect(screen.getByRole("tooltip")).toBeTruthy();

    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("keeps wheel scrolling inside the evidence popover", () => {
    const row: SessionRow = {
      ...initialSessions[0],
      sessionId: "evidence-wheel",
      label: "Evidence wheel row",
      state: "inspect",
      statusReason: "completed task ready to inspect; open it to mark read",
      evidenceSummary: "JSONL task_complete at 2026-06-06T04:24:30.041Z",
    };

    render(<StatusPanelView initialRows={[row]} sourceHealth={fakeSourceHealth} />);
    expandPanel();

    fireEvent.click(screen.getByLabelText("Show status evidence for Evidence wheel row"));
    const tooltip = screen.getByRole("tooltip");
    const wheelEvent = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 30 });
    const stopped = vi.spyOn(wheelEvent, "stopPropagation");

    tooltip.dispatchEvent(wheelEvent);

    expect(stopped).toHaveBeenCalled();
  });

  it("does not expand hidden quiet rows into the attention panel", () => {
    render(
      <StatusPanelView
        initialRows={[
          {
            ...initialSessions[0],
            sessionId: "review-1",
            label: "Review one",
            state: "dismissable",
            statusReason: "completed task ready to inspect; confirm to mark idle",
          },
          {
            ...initialSessions[0],
            sessionId: "review-2",
            label: "Review two",
            state: "dismissable",
            statusReason: "completed task ready to inspect; confirm to mark idle",
          },
          {
            ...initialSessions[0],
            sessionId: "review-3",
            label: "Review three",
            state: "dismissable",
            statusReason: "completed task ready to inspect; confirm to mark idle",
          },
          {
            ...initialSessions[0],
            sessionId: "extra-idle",
            label: "Quiet historical session",
            state: "idle",
            statusReason: "completed task is no longer recent; idle until the next source signal",
          },
        ]}
        sourceHealth={fakeSourceHealth}
      />,
    );
    expandPanel();

    fireEvent.click(screen.getByText(/\+\d+ quiet/));

    expect(screen.queryByText("Quiet historical session")).toBeNull();
    expect(screen.getAllByRole("article")).toHaveLength(3);
  });

  it("keeps configurable options off the status panel", () => {
    render(<StatusPanelView initialRows={initialSessions} sourceHealth={fakeSourceHealth} />);

    expect(screen.queryByLabelText("Visible items")).toBeNull();
    expect(screen.queryByRole("button", { name: "Manage settings" })).toBeNull();
  });

  it("starts native window dragging from the panel header", () => {
    const { container } = render(<StatusPanelView initialRows={initialSessions} sourceHealth={fakeSourceHealth} />);
    const header = container.querySelector(".panel-header");

    expect(header).toBeTruthy();
    fireEvent.pointerDown(header as Element, { button: 0 });

    expect(tauriWindowMock.startDragging).toHaveBeenCalledTimes(1);
  });

  it("restores a persisted panel position on mount", async () => {
    window.localStorage.setItem("attn.panelPosition", JSON.stringify({ x: 144, y: 88 }));

    render(<StatusPanelView initialRows={initialSessions} sourceHealth={fakeSourceHealth} />);

    await waitFor(() => {
      expect(tauriWindowMock.setPosition).toHaveBeenCalledWith(expect.objectContaining({
        x: 144,
        y: 88,
      }));
    });
  });

  it("persists the panel position after the native window moves", async () => {
    let movedHandler: ((event: { payload: { x: number; y: number } }) => void) | undefined;
    tauriWindowMock.onMoved.mockImplementation(async (handler) => {
      movedHandler = handler as (event: { payload: { x: number; y: number } }) => void;
      return vi.fn();
    });

    render(<StatusPanelView initialRows={initialSessions} sourceHealth={fakeSourceHealth} />);

    await waitFor(() => {
      expect(movedHandler).toBeTruthy();
    });

    movedHandler?.({ payload: { x: 256, y: 192 } });

    expect(window.localStorage.getItem("attn.panelPosition")).toBe(JSON.stringify({ x: 256, y: 192 }));
  });

  it("grants native window movement permissions to the single panel window", () => {
    // @ts-expect-error This test reads local config without adding Node types to the app build.
    const capability = JSON.parse(readFileSync(join(process.cwd(), "src-tauri/capabilities/default.json"), "utf8"));

    expect(capability.windows).toEqual(["main"]);
    expect(capability.permissions).toEqual(expect.arrayContaining([
      "core:window:allow-set-position",
      "core:window:allow-start-dragging",
    ]));
  });

  it("lets macOS Dock desktop assignment control where the panel appears", () => {
    // @ts-expect-error This test reads local config without adding Node types to the app build.
    const tauriConfig = JSON.parse(readFileSync(join(process.cwd(), "src-tauri/tauri.conf.json"), "utf8"));
    // @ts-expect-error This test reads local source without adding Node types to the app build.
    const tauriLib = readFileSync(join(process.cwd(), "src-tauri/src/lib.rs"), "utf8");

    expect(tauriConfig.app.windows[0].visibleOnAllWorkspaces).not.toBe(true);
    expect(tauriLib).not.toContain("set_visible_on_all_workspaces(true)");
  });

  it("does not create extra panel windows for secondary displays", () => {
    // @ts-expect-error This test reads local source without adding Node types to the app build.
    const tauriLib = readFileSync(join(process.cwd(), "src-tauri/src/lib.rs"), "utf8");

    expect(tauriLib).not.toContain("panel-display-");
    expect(tauriLib).not.toContain("All Displays");
    expect(tauriLib).not.toContain("Current Display");
  });

  it("keeps long real session titles inside the status rows", () => {
    render(
      <StatusPanelView
        initialRows={[
          {
            ...initialSessions[0],
            label:
              "收到一个工单反馈用车详情页面太卡，主要是地图没法进行缩放展示。这里有一段非常长的真实标题",
          },
        ]}
        sourceHealth={fakeSourceHealth}
      />,
    );
    expandPanel();

    expect(screen.getByText("收到一个工单反馈用车详情页面太卡，主要是地图没法进行缩放展示。这里有一段非常长的真实标题")).toBeTruthy();
  });

  it("uses workspace context instead of diagnostic reason as the row subtitle", () => {
    render(
      <StatusPanelView
        initialRows={[
          {
            ...initialSessions[0],
            label: "Investigate local session",
            projectName: "agent-session-inbox",
            workspacePath: "/Users/edy/sofdev/agent-session-inbox",
            state: "running",
            confidence: "exact",
            statusReason: "running signal observed",
          },
        ]}
        sourceHealth={fakeSourceHealth}
      />,
    );
    expandPanel();

    expect(screen.getByText("agent-session-inbox")).toBeTruthy();
    expect(screen.queryByText("running signal observed")).toBeNull();
  });

  it("adds a subtle attention cue when a working row becomes inspect", async () => {
    const workingRow: SessionRow = {
      ...initialSessions[1],
      sessionId: "transitioning-session",
      label: "Transitioning task",
      state: "running",
      statusReason: "running signal observed",
    };
    const inspectRow: SessionRow = {
      ...workingRow,
      state: "dismissable",
      statusReason: "completed task ready to inspect; confirm to mark idle",
    };
    vi.stubGlobal("fetch", vi.fn((url: string | URL | Request) => {
      const pathname = typeof url === "string" ? url : url instanceof URL ? url.pathname : url.url;
      if (pathname === "/api/source-health") return Promise.resolve(jsonResponse(fakeSourceHealth));
      if (pathname === "/api/sessions") {
        return Promise.resolve(jsonResponse([inspectRow]));
      }
      return Promise.resolve(jsonResponse({}, 404));
    }));

    render(<StatusPanelView initialRows={[workingRow]} sourceHealth={fakeSourceHealth} />);

    const cuedRow = await screen.findByTestId("status-row-transitioning-session");

    await waitFor(() => {
      expect(cuedRow.className).toContain("status-row--attention-cue");
    });
  });

  it("opens management from a native menu event", async () => {
    const { listen } = await import("@tauri-apps/api/event");
    let handler: ((event: { payload: string }) => void) | undefined;
    vi.mocked(listen).mockImplementation(async (_event, callback) => {
      handler = callback as (event: { payload: string }) => void;
      return () => undefined;
    });

    render(<StatusPanelView initialRows={initialSessions} sourceHealth={fakeSourceHealth} />);

    handler?.({ payload: "management" });

    expect(await screen.findByText("management")).toBeTruthy();
    expect(screen.getByLabelText("Style family")).toBeTruthy();
    expect(screen.getByLabelText("Palette")).toBeTruthy();
    expect(screen.getByLabelText("Visible items")).toBeTruthy();
    expect(screen.getByLabelText("Blocked color")).toBeTruthy();
    expect(screen.getByLabelText("Inspect color")).toBeTruthy();
    expect(screen.getByLabelText("Follow-up color")).toBeTruthy();
  });

  it("applies management settings only after confirmation", async () => {
    const { listen } = await import("@tauri-apps/api/event");
    let handler: ((event: { payload: string }) => void) | undefined;
    vi.mocked(listen).mockImplementation(async (_event, callback) => {
      handler = callback as (event: { payload: string }) => void;
      return () => undefined;
    });

    render(<StatusPanelView initialRows={initialSessions} sourceHealth={fakeSourceHealth} />);
    handler?.({ payload: "management" });

    fireEvent.change(await screen.findByLabelText("Language"), { target: { value: "zh" } });
    fireEvent.click(screen.getByText("Back"));

    expect(screen.getByText("1 alerts")).toBeTruthy();
    expandPanel();
    expect(screen.getByText("follow-up")).toBeTruthy();

    handler?.({ payload: "management" });
    fireEvent.change(await screen.findByLabelText("Language"), { target: { value: "zh" } });
    fireEvent.click(await screen.findByRole("button", { name: "Apply settings" }));

    expect(screen.getByText("1 需关注")).toBeTruthy();
    expect(screen.getByText("1 进行中")).toBeTruthy();
    expect(screen.getByText("1 空闲")).toBeTruthy();
    expandPanel();
    expect(screen.getByText("待跟进")).toBeTruthy();
  });

  it("shows Codex hook integration status and installs only after confirmation", async () => {
    const { listen } = await import("@tauri-apps/api/event");
    let handler: ((event: { payload: string }) => void) | undefined;
    vi.mocked(listen).mockImplementation(async (_event, callback) => {
      handler = callback as (event: { payload: string }) => void;
      return () => undefined;
    });
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {},
    });
    tauriCoreMock.invoke.mockImplementation(async (command: string) => {
      if (command === "list_sessions") return initialSessions;
      if (command === "source_health") return fakeSourceHealth;
      if (command === "codex_hook_integration_status") {
        return {
          installed: false,
          hooksPath: "/Users/edy/.codex/hooks.json",
          eventStorePath: "/Users/edy/.codex/agent-session-inbox/hook-events.jsonl",
          detail: "Attn hook commands are not installed.",
        };
      }
      if (command === "install_codex_hooks") {
        return {
          installed: true,
          hooksPath: "/Users/edy/.codex/hooks.json",
          eventStorePath: "/Users/edy/.codex/agent-session-inbox/hook-events.jsonl",
          detail: "Attn hook commands are installed.",
        };
      }
      return null;
    });

    render(<StatusPanelView initialRows={initialSessions} sourceHealth={fakeSourceHealth} />);
    handler?.({ payload: "management" });

    expect(await screen.findByText("Codex hooks")).toBeTruthy();
    expect(await screen.findByText("Attn hook commands are not installed.")).toBeTruthy();
    expect(tauriCoreMock.invoke).not.toHaveBeenCalledWith("install_codex_hooks");

    fireEvent.click(screen.getByRole("button", { name: "Install Codex hooks" }));

    expect(await screen.findByText("Attn hook commands are installed.")).toBeTruthy();
    expect(tauriCoreMock.invoke).toHaveBeenCalledWith("install_codex_hooks");
  });

  it("persists language settings across panel remounts", async () => {
    const { listen } = await import("@tauri-apps/api/event");
    let handler: ((event: { payload: string }) => void) | undefined;
    vi.mocked(listen).mockImplementation(async (_event, callback) => {
      handler = callback as (event: { payload: string }) => void;
      return () => undefined;
    });

    const rendered = render(<StatusPanelView initialRows={initialSessions} sourceHealth={fakeSourceHealth} />);
    handler?.({ payload: "management" });
    fireEvent.change(await screen.findByLabelText("Language"), { target: { value: "zh" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply settings" }));
    rendered.unmount();

    render(<StatusPanelView initialRows={initialSessions} sourceHealth={fakeSourceHealth} />);
    expandPanel();

    expect(screen.getByText("1 需关注")).toBeTruthy();
    expect(screen.getByText("待跟进")).toBeTruthy();
  });

  it("localizes built-in panel and management copy when Chinese is selected", async () => {
    const { listen } = await import("@tauri-apps/api/event");
    let handler: ((event: { payload: string }) => void) | undefined;
    vi.mocked(listen).mockImplementation(async (_event, callback) => {
      handler = callback as (event: { payload: string }) => void;
      return () => undefined;
    });
    window.localStorage.setItem("attn.statusPanelConfig", JSON.stringify({
      ...defaultZhConfig(),
      panelMode: "persistent",
    }));

    render(<StatusPanelView initialRows={initialSessions} sourceHealth={fakeSourceHealth} />);

    expect(screen.getByText("Attn")).toBeTruthy();
    expect(screen.getByText("1 需关注")).toBeTruthy();
    expect(screen.getByText("1 进行中")).toBeTruthy();
    expect(screen.getByText("1 空闲")).toBeTruthy();
    expect(screen.getByText("Codex 桌面端")).toBeTruthy();
    expect(screen.getByText("本地数据")).toBeTruthy();
    expect(screen.getByText("降级")).toBeTruthy();
    expect(screen.getByText("精确")).toBeTruthy();
    expect(screen.getAllByTitle("返回会话")).toHaveLength(2);
    expect(screen.getAllByTitle("忽略")).toHaveLength(2);
    expect(screen.queryByText("local data")).toBeNull();
    expect(screen.queryByText("degraded")).toBeNull();

    fireEvent.click(screen.getByLabelText("查看 AMap geolocation preload investigation 的状态依据"));
    expect(screen.getByRole("tooltip").textContent).toContain("状态：Codex reports the task is waiting for user input.");
    expect(screen.getByRole("tooltip").textContent).toContain("跳转目标：桌面端");
    expect(screen.getByRole("tooltip").textContent).toContain("置信度：精确");

    handler?.({ payload: "management" });

    expect(await screen.findByText("设置")).toBeTruthy();
    expect(screen.getByLabelText("语言")).toBeTruthy();
    expect(screen.getByLabelText("显示条数")).toBeTruthy();
    expect(screen.getByLabelText("面板显示")).toBeTruthy();
    expect(screen.getByLabelText("提醒显示秒数")).toBeTruthy();
    expect(screen.getByText("包含这些状态时不收起")).toBeTruthy();
    expect((screen.getByLabelText("待检查") as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText("状态颜色")).toBeTruthy();
    expect(screen.getByRole("button", { name: "应用设置" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "返回" })).toBeTruthy();
    expect(screen.queryByText("Language")).toBeNull();
    expect(screen.queryByText("Apply settings")).toBeNull();
  });

  it("loads settings from the legacy agent-session-inbox storage key", () => {
    window.localStorage.setItem("agent-session-inbox.statusPanelConfig", JSON.stringify({
      styleFamily: "atom",
      palette: "oneDark",
      language: "zh",
      visibleItemCount: 3,
      statusColors: {
        blocked: "#e06c75",
        inspect: "#61afef",
        stopped: "#d19a66",
        needed: "#e5c07b",
        working: "#98c379",
        idle: "#5c6370",
      },
    }));

    render(<StatusPanelView initialRows={initialSessions} sourceHealth={fakeSourceHealth} />);

    expect(screen.getByText("1 需关注")).toBeTruthy();
    expect(window.localStorage.getItem("attn.statusPanelConfig")).toBeTruthy();
    expect(window.localStorage.getItem("agent-session-inbox.statusPanelConfig")).toBeNull();
  });

  it("shows five rows only after visible-item settings are confirmed", async () => {
    const { listen } = await import("@tauri-apps/api/event");
    let handler: ((event: { payload: string }) => void) | undefined;
    vi.mocked(listen).mockImplementation(async (_event, callback) => {
      handler = callback as (event: { payload: string }) => void;
      return () => undefined;
    });
    const rows: SessionRow[] = Array.from({ length: 5 }, (_, index) => ({
      ...initialSessions[0],
      sessionId: `row-${index + 1}`,
      label: `Visible row ${index + 1}`,
      state: "running",
      statusReason: "running signal observed",
    }));
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) => {
      const pathname = typeof url === "string" ? url : url instanceof URL ? url.pathname : url.url;
      if (pathname === "/api/sessions") return jsonResponse(rows);
      if (pathname === "/api/source-health") return jsonResponse(fakeSourceHealth);
      return jsonResponse({}, 404);
    }));

    render(<StatusPanelView initialRows={rows} sourceHealth={fakeSourceHealth} />);
    expandPanel();
    expect(screen.getAllByRole("article")).toHaveLength(3);

    handler?.({ payload: "management" });
    fireEvent.change(await screen.findByLabelText("Visible items"), { target: { value: "5" } });
    fireEvent.click(screen.getByText("Back"));
    expect(screen.getAllByRole("article")).toHaveLength(3);

    handler?.({ payload: "management" });
    fireEvent.change(await screen.findByLabelText("Visible items"), { target: { value: "5" } });
    fireEvent.click(await screen.findByRole("button", { name: "Apply settings" }));
    expandPanel();
    await waitFor(() => {
      expect(screen.getAllByRole("article")).toHaveLength(5);
    });
    await waitFor(() => {
      expect(tauriWindowMock.setSize).toHaveBeenCalledWith(expect.objectContaining({
        height: 348,
        width: 560,
      }));
    });
  });

  it("sizes the transparent window to the actual rendered row count", async () => {
    const rows: SessionRow[] = [
      {
        ...initialSessions[0],
        sessionId: "single-row",
        label: "Single visible row",
        state: "inspect",
        statusReason: "completed task ready to inspect; open it to mark read",
      },
    ];
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) => {
      const pathname = typeof url === "string" ? url : url instanceof URL ? url.pathname : url.url;
      if (pathname === "/api/sessions") return jsonResponse(rows);
      if (pathname === "/api/source-health") return jsonResponse(fakeSourceHealth);
      return jsonResponse({}, 404);
    }));

    render(<StatusPanelView initialRows={rows} sourceHealth={fakeSourceHealth} />);

    await waitFor(() => {
      expect(tauriWindowMock.setSize).toHaveBeenCalledWith(expect.objectContaining({
        height: 60,
        width: 560,
      }));
    });
    expandPanel();
    await waitFor(() => {
      expect(tauriWindowMock.setSize).toHaveBeenCalledWith(expect.objectContaining({
        height: 156,
        width: 560,
      }));
    });
  });

  it("reserves panel height for jump command feedback", async () => {
    const row: SessionRow = {
      ...initialSessions[0],
      sessionId: "jump-message-row",
      label: "Jump message row",
      state: "inspect",
      statusReason: "completed task ready to inspect; open it to mark read",
    };
    let resolveJump: ((response: Response) => void) | undefined;
    vi.stubGlobal("fetch", vi.fn((url: string | URL | Request, init?: RequestInit) => {
      const pathname = typeof url === "string" ? url : url instanceof URL ? url.pathname : url.url;
      if (pathname === "/api/jump" && init?.method === "POST") {
        return new Promise<Response>((resolve) => {
          resolveJump = resolve;
        });
      }
      if (pathname === "/api/sessions") return Promise.resolve(jsonResponse([row]));
      if (pathname === "/api/source-health") return Promise.resolve(jsonResponse(fakeSourceHealth));
      return Promise.resolve(jsonResponse({}, 404));
    }));

    render(<StatusPanelView initialRows={[row]} sourceHealth={fakeSourceHealth} />);
    expandPanel();
    fireEvent.click(screen.getByTitle("Jump back"));

    resolveJump?.(jsonResponse({
      sessionId: row.sessionId,
      availability: "exact",
      target: "desktop",
      message: "Opened Codex Desktop session.",
    }));

    expect(await screen.findByText("Opened Codex Desktop session.")).toBeTruthy();
    await waitFor(() => {
      expect(tauriWindowMock.setSize).toHaveBeenCalledWith(expect.objectContaining({
        height: 186,
        width: 560,
      }));
    });
  });

  it("uses small Atom status markers for visible rows", () => {
    const rows: SessionRow[] = [
      { ...initialSessions[0], sessionId: "blocked", state: "unknown", statusReason: "source status unavailable" },
      { ...initialSessions[0], sessionId: "input", state: "waitingForInput", statusReason: "waiting for user input" },
      { ...initialSessions[0], sessionId: "inspect", state: "inspect", statusReason: "ready to inspect" },
      { ...initialSessions[0], sessionId: "working", state: "running", statusReason: "running signal observed" },
      { ...initialSessions[0], sessionId: "idle", state: "idle", statusReason: "completed task observed; idle until the next source signal" },
    ];
    const { container } = render(<StatusPanelView initialRows={rows} sourceHealth={fakeSourceHealth} />);
    expandPanel();

    const statusTexts = Array.from(container.querySelectorAll(".status-code")).map((element) =>
      element.textContent?.replace(/\s+/g, " ").trim(),
    );

    expect(statusTexts).toEqual(["● blocked", "● input", "○ working"]);
  });

  it("shows a parent subtask summary while only promoting intervention subagents", () => {
    const rows: SessionRow[] = [
      {
        ...initialSessions[0],
        sessionId: "parent",
        label: "Parent task",
        state: "running",
        workspacePath: "/Users/edy/project",
        threadSource: "user",
        statusReason: "running signal observed",
      },
      {
        ...initialSessions[0],
        sessionId: "child-working",
        label: "Quiet child task",
        state: "running",
        workspacePath: "/Users/edy/project",
        threadSource: "subagent",
        statusReason: "running signal observed",
      },
      {
        ...initialSessions[0],
        sessionId: "child-inspect",
        label: "Inspect child task",
        state: "inspect",
        workspacePath: "/Users/edy/project",
        threadSource: "subagent",
        statusReason: "completed task ready to inspect; open it to mark read",
      },
      {
        ...initialSessions[0],
        sessionId: "child-input",
        label: "Input child task",
        state: "waitingForInput",
        workspacePath: "/Users/edy/project",
        threadSource: "subagent",
        statusReason: "waiting for user input",
      },
    ];

    render(<StatusPanelView initialRows={rows} sourceHealth={fakeSourceHealth} />);
    expandPanel();

    expect(screen.getByText("Parent task")).toBeTruthy();
    expect(screen.getByText("2 subtasks: 1 inspect, 1 working")).toBeTruthy();
    expect(screen.getByText("Input child task")).toBeTruthy();
    expect(screen.queryByText("Quiet child task")).toBeNull();
    expect(screen.queryByText("Inspect child task")).toBeNull();
    expect(screen.getAllByRole("article")).toHaveLength(2);
  });

  it("keeps an opened intervention row as needed during the read window", async () => {
    const attentionRow: SessionRow = {
      ...initialSessions[0],
      sessionId: "needs-input",
      state: "inspect",
      confidence: "exact",
      statusReason: "completed task ready to inspect; open it to mark read",
    };
    const confirmedRow: SessionRow = {
      ...attentionRow,
      state: "needsAttention",
      confidence: "exact",
      statusReason: "Read recently; keep in needed state until 30 minutes pass.",
      handled: true,
      dismissed: false,
    };
    let jumped = false;
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) => {
      const pathname = typeof url === "string" ? url : url instanceof URL ? url.pathname : url.url;
      if (pathname === "/api/jump") {
        jumped = true;
        return jsonResponse({
          sessionId: attentionRow.sessionId,
          availability: "exact",
          target: "desktop",
          message: "Opened Codex Desktop session.",
        });
      }
      if (pathname === "/api/sessions") {
        return jsonResponse(jumped ? [confirmedRow] : [attentionRow]);
      }
      if (pathname === "/api/source-health") {
        return jsonResponse(fakeSourceHealth);
      }
      return jsonResponse({}, 404);
    }));

    render(<StatusPanelView initialRows={[attentionRow]} sourceHealth={fakeSourceHealth} />);
    expandPanel();

    expect(await screen.findByText("inspect")).toBeTruthy();

    fireEvent.click(screen.getByTitle("Jump back"));

    await waitFor(() => {
      expect(screen.getByLabelText("Show status evidence for AMap geolocation preload investigation")).toBeTruthy();
    });
    fireEvent.click(screen.getByLabelText("Show status evidence for AMap geolocation preload investigation"));
    expect(screen.getByRole("tooltip").textContent).toContain(
      "Status: Read recently; keep in needed state until 30 minutes pass.",
    );
    expect(screen.getByText("follow-up")).toBeTruthy();
  });

  it("removes a dismissed row immediately while the command is still running", async () => {
    const row = { ...initialSessions[0], sessionId: "dismiss-lag", label: "Dismiss lag row" };
    let resolveDismiss: ((response: Response) => void) | undefined;
    vi.stubGlobal("fetch", vi.fn((url: string | URL | Request) => {
      const pathname = typeof url === "string" ? url : url instanceof URL ? url.pathname : url.url;
      if (pathname === "/api/sessions") return Promise.resolve(jsonResponse([row]));
      if (pathname === "/api/source-health") return Promise.resolve(jsonResponse(fakeSourceHealth));
      if (pathname === "/api/dismiss") {
        return new Promise<Response>((resolve) => {
          resolveDismiss = resolve;
        });
      }
      return Promise.resolve(jsonResponse({}, 404));
    }));

    render(<StatusPanelView initialRows={[row]} sourceHealth={fakeSourceHealth} />);
    expandPanel();

    fireEvent.click(screen.getByTitle("Dismiss"));

    expect(screen.queryByText("Dismiss lag row")).toBeNull();

    resolveDismiss?.(jsonResponse([]));
    await waitFor(() => {
      expect(screen.queryByText("Dismiss lag row")).toBeNull();
    });
  });

  it("shows immediate pending feedback when jump is running", async () => {
    const row = { ...initialSessions[0], sessionId: "jump-lag", label: "Jump lag row" };
    let resolveJump: ((response: Response) => void) | undefined;
    vi.stubGlobal("fetch", vi.fn((url: string | URL | Request) => {
      const pathname = typeof url === "string" ? url : url instanceof URL ? url.pathname : url.url;
      if (pathname === "/api/jump") {
        return new Promise<Response>((resolve) => {
          resolveJump = resolve;
        });
      }
      if (pathname === "/api/sessions") return Promise.resolve(jsonResponse([row]));
      if (pathname === "/api/source-health") return Promise.resolve(jsonResponse(fakeSourceHealth));
      return Promise.resolve(jsonResponse({}, 404));
    }));

    render(<StatusPanelView initialRows={[row]} sourceHealth={fakeSourceHealth} />);
    expandPanel();

    const jumpButton = screen.getByTitle("Jump back");
    fireEvent.click(jumpButton);

    expect((jumpButton as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTitle("Opening session")).toBeTruthy();

    resolveJump?.(jsonResponse({
      sessionId: row.sessionId,
      availability: "exact",
      target: "desktop",
      message: "Opened Codex Desktop session.",
    }));
    await waitFor(() => {
      expect((jumpButton as HTMLButtonElement).disabled).toBe(false);
    });
  });

  it("uses styled SVG action icons instead of text glyphs", () => {
    render(<StatusPanelView initialRows={initialSessions} sourceHealth={fakeSourceHealth} />);
    expandPanel();

    const jumpButton = screen.getAllByTitle("Jump back")[0];
    const dismissButton = screen.getAllByTitle("Dismiss")[0];

    expect(jumpButton.querySelector("svg")).toBeTruthy();
    expect(dismissButton.querySelector("svg")).toBeTruthy();
    expect(jumpButton.textContent?.trim()).toBe("");
    expect(dismissButton.textContent?.trim()).toBe("");
  });

  it("keeps transparent window breathing room around the rounded shell", () => {
    // @ts-expect-error This test runs in Node and does not need app-level Node globals.
    const css = readFileSync(join(process.cwd(), "src/App.css"), "utf8");

    expect(css).toContain("padding: 8px;");
    expect(css).toContain("width: min(100vw - 12px, 540px);");
    expect(css).toContain("max-height: calc(100vh - 12px);");
    expect(css).toContain("inset 0 1px 0 rgba(171, 178, 191, 0.08);");
  });

  it("keeps the strip toggle from shifting header layout", () => {
    // @ts-expect-error This test reads local CSS without adding Node types to the app build.
    const css = readFileSync(join(process.cwd(), "src/App.css"), "utf8");
    const collapsedBlock = css.match(/\.panel-shell--collapsed \{[^}]+\}/)?.[0];
    const stripToggleBlock = css.match(/\.strip-toggle \{[^}]+\}/)?.[0];

    expect(collapsedBlock).not.toContain("padding:");
    expect(stripToggleBlock).toContain("width: 22px;");
    expect(stripToggleBlock).toContain("line-height: 20px;");
  });

  it("defines a non-looping inspect attention cue animation", () => {
    // @ts-expect-error This test reads local CSS without adding Node types to the app build.
    const css = readFileSync(join(process.cwd(), "src/App.css"), "utf8");

    expect(css).toContain(".status-row--attention-cue");
    expect(css).toContain("animation: inspect-attention-cue 1800ms ease-out both;");
    expect(css).toContain("@keyframes inspect-attention-sweep");
  });

  it("gives inspect rows stronger visual priority than working rows", () => {
    // @ts-expect-error This test reads local CSS without adding Node types to the app build.
    const css = readFileSync(join(process.cwd(), "src/App.css"), "utf8");
    const inspectBlock = css.match(/\.status-row--inspect \{[^}]+\}/)?.[0];
    const workingBlock = css.match(/\.status-row--working \{[^}]+\}/)?.[0];

    expect(inspectBlock).toContain("background: #222d39;");
    expect(inspectBlock).toContain("--row-border-color: #31536b;");
    expect(workingBlock).toContain("border-left-color: var(--status-color);");
    expect(workingBlock).toContain("background: #24292e;");
  });

  it("keeps localized status labels from crowding the left column", () => {
    // @ts-expect-error This test reads local CSS without adding Node types to the app build.
    const css = readFileSync(join(process.cwd(), "src/App.css"), "utf8");
    const rowBlock = css.match(/\.status-row \{[^}]+\}/)?.[0];
    const statusCodeBlock = css.match(/\.status-code \{[^}]+\}/)?.[0];
    const statusMarkerBlock = css.match(/\.status-code span \{[^}]+\}/)?.[0];

    expect(rowBlock).toContain("grid-template-columns: 96px minmax(0, 1fr) auto;");
    expect(rowBlock).toContain("padding: 6px 7px 6px 12px;");
    expect(statusCodeBlock).toContain("align-items: center;");
    expect(statusCodeBlock).toContain("display: flex;");
    expect(statusCodeBlock).toContain("min-width: 76px;");
    expect(statusMarkerBlock).toContain("margin-right: 8px;");
  });

  it("keeps status row left borders inside the clipped panel area", () => {
    // @ts-expect-error This test reads local CSS without adding Node types to the app build.
    const css = readFileSync(join(process.cwd(), "src/App.css"), "utf8");
    const listBlock = css.match(/\.status-list \{[^}]+\}/)?.[0];
    const rowBlock = css.match(/\.status-row \{[^}]+\}/)?.[0];

    expect(listBlock).toContain("padding-left: 4px;");
    expect(rowBlock).toContain("width: calc(100% - 4px);");
  });

  it("draws the status accent inside a complete row outline", () => {
    // @ts-expect-error This test reads local CSS without adding Node types to the app build.
    const css = readFileSync(join(process.cwd(), "src/App.css"), "utf8");
    const rowBlock = css.match(/\.status-row \{[^}]+\}/)?.[0];
    const accentBlock = css.match(/\.status-row::before \{[^}]+\}/)?.[0];

    expect(rowBlock).toContain("border: 1px solid var(--row-border-color);");
    expect(rowBlock).not.toContain("border-left: 3px solid var(--status-color);");
    expect(accentBlock).toContain("background: var(--status-color);");
    expect(accentBlock).toContain("left: 1px;");
  });

  it("uses the complete left border for quiet working rows", () => {
    // @ts-expect-error This test reads local CSS without adding Node types to the app build.
    const css = readFileSync(join(process.cwd(), "src/App.css"), "utf8");
    const workingBlock = css.match(/\.status-row--working \{[^}]+\}/)?.[0];
    const workingBeforeBlock = css.match(/\.status-row--working::before \{[^}]+\}/)?.[0];

    expect(workingBlock).toContain("border-left-color: var(--status-color);");
    expect(workingBlock).not.toContain("--status-accent-width: 1px;");
    expect(workingBeforeBlock).toContain("content: none;");
  });

  it("allows the evidence popover to escape the status content clipping area", () => {
    // @ts-expect-error This test reads local CSS without adding Node types to the app build.
    const css = readFileSync(join(process.cwd(), "src/App.css"), "utf8");
    const statusContentBlock = css.match(/\.status-content \{[^}]+\}/)?.[0];

    expect(statusContentBlock).toBeTruthy();
    expect(statusContentBlock).not.toContain("overflow: hidden");
    expect(css).toContain(".status-evidence-popover");
    expect(css).toContain("position: absolute;");
    expect(css).toContain("max-height: 160px;");
    expect(css).toContain("overflow-y: auto;");
    expect(css).toContain("overscroll-behavior: contain;");
    expect(css).toContain("scrollbar-width: thin;");
    expect(css).toContain(".status-row:last-child .status-evidence-popover");
    expect(css).toContain("bottom: calc(100% + 5px);");
  });

  it("raises the row that owns an open evidence popover above later rows", () => {
    // @ts-expect-error This test reads local CSS without adding Node types to the app build.
    const css = readFileSync(join(process.cwd(), "src/App.css"), "utf8");
    const rowBlock = css.match(/\.status-row \{[^}]+\}/)?.[0];
    const evidenceOpenBlock = css.match(/\.status-row--evidence-open \{[^}]+\}/)?.[0];
    const popoverBlock = css.match(/\.status-evidence-popover \{[^}]+\}/)?.[0];

    expect(rowBlock).toContain("position: relative;");
    expect(rowBlock).toContain("z-index: 0;");
    expect(evidenceOpenBlock).toContain("z-index: 20;");
    expect(popoverBlock).toContain("z-index: 10;");
  });
});

function expandPanel() {
  const expandButton = screen.queryByRole("button", { name: "Expand status panel" })
    ?? screen.queryByRole("button", { name: "展开状态面板" });
  if (expandButton) {
    fireEvent.click(expandButton);
  }
}

function defaultZhConfig() {
  return {
    styleFamily: "atom",
    palette: "oneDark",
    language: "zh",
    visibleItemCount: 3,
    panelMode: "auto",
    autoCollapseDelayMs: 8000,
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
}

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
