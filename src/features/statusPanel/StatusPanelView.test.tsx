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
  setSize: vi.fn<(size: { width: number; height: number }) => Promise<void>>(async () => undefined),
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
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
  window.localStorage.clear();
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  tauriWindowMock.setSize.mockClear();
  tauriWindowMock.setPosition.mockClear();
  tauriWindowMock.startDragging.mockClear();
  tauriWindowMock.onMoved.mockReset();
  tauriWindowMock.onMoved.mockImplementation(async (_handler: unknown) => vi.fn());
  tauriCoreMock.invoke.mockReset();
  vi.unstubAllGlobals();
});

describe("StatusPanelView", () => {
  it("keeps quiet-only overflow out of the compact watchlist", () => {
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
    expect(statusRows).toHaveLength(1);
    expect(screen.queryByText("1 idle")).toBeNull();
    expect(document.querySelector(".panel-footer .hidden-toggle")).toBeNull();
  });

  it("starts collapsed as a compact status strip", () => {
    render(<StatusPanelView initialRows={initialSessions} sourceHealth={fakeSourceHealth} />);

    expect(screen.getByRole("main").className).toContain("panel-shell--collapsed");
    expect(screen.queryByRole("article")).toBeNull();
    expect(screen.getByText("Attn")).toBeTruthy();
    expect(screen.getByText("1 alerts")).toBeTruthy();
    expect(document.querySelector(".panel-header .panel-counters")).toBeTruthy();
    expect(document.querySelector(".panel-footer")).toBeNull();
  });

  it("places session counters at the bottom right when expanded", () => {
    window.localStorage.setItem("attn.statusPanelConfig", JSON.stringify({ panelMode: "persistent" }));

    render(<StatusPanelView initialRows={initialSessions} sourceHealth={fakeSourceHealth} />);

    expect(document.querySelector(".panel-header .panel-counters")).toBeNull();
    const footerCounters = document.querySelector(".panel-footer .panel-counters");
    expect(footerCounters).toBeTruthy();
    expect(within(footerCounters as HTMLElement).getByText("1 alerts")).toBeTruthy();
    expect(within(footerCounters as HTMLElement).getByText("1 running")).toBeTruthy();
  });

  it("expands the compact strip when clicked", () => {
    render(<StatusPanelView initialRows={initialSessions} sourceHealth={fakeSourceHealth} />);

    fireEvent.click(screen.getByRole("button", { name: "Expand status panel" }));

    expect(screen.getByRole("main").className).not.toContain("panel-shell--collapsed");
    expect(screen.getAllByRole("article")).toHaveLength(1);
  });

  it("auto-expands when a new attention row appears after refresh", async () => {
    const firstRows = initialSessions.filter((row) => row.state !== "waitingForInput");
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
      const pathname = requestPath(url);
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

  it("keeps the rendered session when the packaged refresh fails", async () => {
    const retainedRow: SessionRow = {
      ...initialSessions[0],
      sessionId: "retain-on-refresh-failure",
      label: "Retained refresh task",
      state: "needsAttention",
      statusReason: "Read recently; keep it quiet during the 30-minute follow-up window.",
    };
    window.localStorage.setItem("attn.statusPanelConfig", JSON.stringify({ panelMode: "persistent" }));
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
    tauriCoreMock.invoke.mockImplementation(async (command: string) => {
      if (command === "list_sessions") throw new Error("list_sessions unavailable");
      if (command === "source_health") return fakeSourceHealth;
      return null;
    });
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("preview API is unavailable in the packaged app");
    }));

    render(<StatusPanelView initialRows={[retainedRow]} sourceHealth={fakeSourceHealth} />);

    expect(screen.getByText("Retained refresh task")).toBeTruthy();
    expect(await screen.findByText("list_sessions unavailable")).toBeTruthy();
    expect(screen.getByText("Retained refresh task")).toBeTruthy();
  });

  it("keeps the newer running snapshot when an older refresh completes later", async () => {
    const followUpRow: SessionRow = {
      ...initialSessions[0],
      sessionId: "refresh-ordering-session",
      label: "Refresh ordering task",
      state: "needsAttention",
      statusReason: "Read recently; keep it quiet during the 30-minute follow-up window.",
    };
    const runningRow: SessionRow = {
      ...followUpRow,
      state: "running",
      statusReason: "running signal observed",
    };
    window.localStorage.setItem("attn.statusPanelConfig", JSON.stringify({ panelMode: "persistent" }));
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });

    let resolveOlderRefresh: ((rows: SessionRow[]) => void) | undefined;
    const olderRefresh = new Promise<SessionRow[]>((resolve) => {
      resolveOlderRefresh = resolve;
    });
    let listRequestCount = 0;
    tauriCoreMock.invoke.mockImplementation((command: string) => {
      if (command === "list_sessions") {
        listRequestCount += 1;
        return listRequestCount === 1 ? olderRefresh : Promise.resolve([runningRow]);
      }
      if (command === "source_health") return Promise.resolve(fakeSourceHealth);
      return Promise.resolve(null);
    });

    const originalSetInterval = window.setInterval.bind(window);
    let refreshTimer: (() => void) | undefined;
    vi.spyOn(window, "setInterval").mockImplementation(((handler: TimerHandler, timeout?: number) => {
      if (timeout === 5000 && typeof handler === "function") {
        refreshTimer = () => handler();
        return 1;
      }

      return originalSetInterval(handler, timeout);
    }) as typeof window.setInterval);

    render(<StatusPanelView initialRows={[followUpRow]} sourceHealth={fakeSourceHealth} />);

    await waitFor(() => {
      expect(listRequestCount).toBe(1);
    });
    await act(async () => {
      refreshTimer?.();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(screen.getByTestId("status-row-refresh-ordering-session").className).toContain("status-row--working");
    });

    await act(async () => {
      resolveOlderRefresh?.([followUpRow]);
      await Promise.resolve();
    });

    expect(screen.getByTestId("status-row-refresh-ordering-session").className).toContain("status-row--working");
  });

  it("shows a newly refreshed follow-up in an unused slot without treating it as an alert", async () => {
    const firstRows = initialSessions.filter((row) => row.state !== "waitingForInput");
    const nextRows = [
      ...firstRows,
      {
        ...initialSessions[0],
        sessionId: "timed-follow-up-row",
        label: "Timed follow-up row",
        state: "needsAttention" as const,
        statusReason: "Read recently; keep it quiet during the 30-minute follow-up window.",
      },
    ];
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) => {
      const pathname = requestPath(url);
      if (pathname === "/api/sessions") return jsonResponse(nextRows);
      if (pathname === "/api/source-health") return jsonResponse(fakeSourceHealth);
      return jsonResponse({}, 404);
    }));
    window.localStorage.setItem("attn.statusPanelConfig", JSON.stringify({ visibleItemCount: 2 }));

    render(<StatusPanelView initialRows={firstRows} sourceHealth={fakeSourceHealth} />);

    expect(screen.getByRole("main").className).toContain("panel-shell--collapsed");
    fireEvent.click(screen.getByRole("button", { name: "Expand status panel" }));
    expect(await screen.findByText("Timed follow-up row")).toBeTruthy();
    expect(screen.getByText("0 alerts")).toBeTruthy();
    expect(document.querySelector(".panel-footer .hidden-toggle")).toBeNull();
    expect(screen.getByText("follow-up")).toBeTruthy();
  });

  it("auto-collapses inspect rows after the 30-second default", async () => {
    const firstRows = initialSessions.filter((row) => row.state !== "waitingForInput");
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
      const pathname = requestPath(url);
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
      if (timeout === 30000 && typeof handler === "function") {
        autoCollapseCallback = () => handler();
        return 30000;
      }

      return originalSetTimeout(handler, timeout);
    }) as typeof window.setTimeout);

    render(<StatusPanelView initialRows={firstRows} sourceHealth={fakeSourceHealth} />);

    await waitFor(() => {
      expect(screen.getByText("Sticky inspect row")).toBeTruthy();
    });
    expect(screen.getByRole("main").className).not.toContain("panel-shell--collapsed");
    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 30000);

    await act(async () => {
      autoCollapseCallback?.();
    });
    await waitFor(() => {
      expect(screen.getByRole("main").className).toContain("panel-shell--collapsed");
    });
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

  it("does not offer follow-up as a keep-open status", async () => {
    const { listen } = await import("@tauri-apps/api/event");
    let handler: ((event: { payload: string }) => void) | undefined;
    vi.mocked(listen).mockImplementation(async (_event, callback) => {
      handler = callback as (event: { payload: string }) => void;
      return () => undefined;
    });

    render(<StatusPanelView initialRows={initialSessions} sourceHealth={fakeSourceHealth} />);
    handler?.({ payload: "management" });

    expect(await screen.findByText("Keep open for statuses")).toBeTruthy();
    expect((screen.getByLabelText("inspect") as HTMLInputElement).checked).toBe(false);
    expect(screen.queryByLabelText("follow-up")).toBeNull();

    fireEvent.click(screen.getByLabelText("stopped"));
    fireEvent.click(screen.getByRole("button", { name: "Apply settings" }));

    const persistedConfig = JSON.parse(window.localStorage.getItem("attn.statusPanelConfig") ?? "{}");
    expect(persistedConfig.preventAutoCollapseStatuses).toEqual(["stopped"]);
  });

  it("applies the configured follow-up idle duration and refreshes immediately", async () => {
    const { listen } = await import("@tauri-apps/api/event");
    let handler: ((event: { payload: string }) => void) | undefined;
    vi.mocked(listen).mockImplementation(async (_event, callback) => {
      handler = callback as (event: { payload: string }) => void;
      return () => undefined;
    });
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
    tauriCoreMock.invoke.mockImplementation(async (command: string) => {
      if (command === "list_sessions") return initialSessions;
      if (command === "source_health") return fakeSourceHealth;
      if (command === "codex_hook_integration_status") {
        return { installed: false, hooksPath: "", eventStorePath: "", detail: "" };
      }
      return null;
    });

    render(<StatusPanelView initialRows={initialSessions} sourceHealth={fakeSourceHealth} />);
    handler?.({ payload: "management" });

    const input = await screen.findByLabelText("Follow-up to idle minutes") as HTMLInputElement;
    expect(input.min).toBe("20");
    expect(input.step).toBe("1");
    expect(input.getAttribute("max")).toBeNull();
    fireEvent.change(input, { target: { value: "45" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply settings" }));

    await waitFor(() => {
      expect(lastInvokeCall("list_sessions")).toEqual([
        "list_sessions",
        { followUpToIdleMinutes: 45 },
      ]);
    });
    expect(readPersistedConfig().followUpToIdleMinutes).toBe(45);
  });

  it("normalizes persisted follow-up idle duration to the minimum without capping valid values", async () => {
    const { listen } = await import("@tauri-apps/api/event");
    let handler: ((event: { payload: string }) => void) | undefined;
    vi.mocked(listen).mockImplementation(async (_event, callback) => {
      handler = callback as (event: { payload: string }) => void;
      return () => undefined;
    });
    window.localStorage.setItem("attn.statusPanelConfig", JSON.stringify({ followUpToIdleMinutes: 12 }));

    const rendered = render(<StatusPanelView initialRows={initialSessions} sourceHealth={fakeSourceHealth} />);
    handler?.({ payload: "management" });
    expect((await screen.findByLabelText("Follow-up to idle minutes") as HTMLInputElement).value).toBe("20");
    rendered.unmount();

    window.localStorage.clear();
    window.localStorage.setItem("attn.statusPanelConfig", JSON.stringify({ followUpToIdleMinutes: 180 }));
    render(<StatusPanelView initialRows={initialSessions} sourceHealth={fakeSourceHealth} />);
    handler?.({ payload: "management" });
    expect((await screen.findByLabelText("Follow-up to idle minutes") as HTMLInputElement).value).toBe("180");
  });

  it("drops legacy follow-up keep-open settings when applying management changes", async () => {
    window.localStorage.setItem("attn.statusPanelConfig", JSON.stringify({
      preventAutoCollapseStatuses: ["inspect", "needed"],
    }));
    const { listen } = await import("@tauri-apps/api/event");
    let handler: ((event: { payload: string }) => void) | undefined;
    vi.mocked(listen).mockImplementation(async (_event, callback) => {
      handler = callback as (event: { payload: string }) => void;
      return () => undefined;
    });

    render(<StatusPanelView initialRows={initialSessions} sourceHealth={fakeSourceHealth} />);
    handler?.({ payload: "management" });

    expect((await screen.findByLabelText("inspect") as HTMLInputElement).checked).toBe(true);
    expect(screen.queryByLabelText("follow-up")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Apply settings" }));

    const persistedConfig = JSON.parse(window.localStorage.getItem("attn.statusPanelConfig") ?? "{}");
    expect(persistedConfig.preventAutoCollapseStatuses).toEqual(["inspect"]);
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
        sourceHealth={{ ...fakeSourceHealth, status: "available" }}
      />,
    );
    expandPanel();

    const footer = document.querySelector(".panel-footer");
    expect(footer).toBeTruthy();
    expect(within(footer as HTMLElement).queryByText("Codex desktop")).toBeNull();
    expect(within(footer as HTMLElement).queryByText("available")).toBeNull();
    expect(within(footer as HTMLElement).queryByText("local data")).toBeNull();
    fireEvent.click(within(footer as HTMLElement).getByRole("button", { name: "+2 alerts" }));

    expect(screen.queryByText("Quiet historical session")).toBeNull();
    expect(screen.getAllByRole("article")).toHaveLength(3);
  });

  it("keeps hidden pinned quiet rows reachable from the panel", () => {
    window.localStorage.setItem("attn.statusPanelConfig", JSON.stringify({ visibleItemCount: 1 }));
    render(
      <StatusPanelView
        initialRows={[
          {
            ...initialSessions[0],
            sessionId: "pinned-follow-up-new",
            label: "Pinned follow-up new",
            state: "needsAttention",
            pinned: true,
            lastActivityAt: "2026-06-15T03:46:00.000Z",
            statusReason: "Read recently; keep it quiet during the 30-minute follow-up window.",
          },
          {
            ...initialSessions[0],
            sessionId: "pinned-follow-up-old",
            label: "Pinned follow-up old",
            state: "needsAttention",
            pinned: true,
            lastActivityAt: "2026-06-15T03:20:00.000Z",
            statusReason: "Read recently; keep it quiet during the 30-minute follow-up window.",
          },
        ]}
        sourceHealth={fakeSourceHealth}
      />,
    );
    expandPanel();

    const hiddenRowsButton = screen.getByRole("button", { name: "+1 pinned" });
    expect((hiddenRowsButton as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(hiddenRowsButton);

    expect(screen.getByText("Pinned follow-up old")).toBeTruthy();
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

  it("keeps the macOS panel visible across Spaces", () => {
    // @ts-expect-error This test reads local config without adding Node types to the app build.
    const tauriConfig = JSON.parse(readFileSync(join(process.cwd(), "src-tauri/tauri.conf.json"), "utf8"));
    // @ts-expect-error This test reads local source without adding Node types to the app build.
    const tauriLib = readFileSync(join(process.cwd(), "src-tauri/src/lib.rs"), "utf8");

    expect(tauriConfig.app.windows[0].visibleOnAllWorkspaces).toBe(true);
    expect(tauriLib).toContain("set_visible_on_all_workspaces(true)");
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
      const pathname = requestPath(url);
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

  it("toggles the panel when the visible-window shortcut fires", async () => {
    const { listen } = await import("@tauri-apps/api/event");
    let toggleHandler: ((event: { payload: boolean }) => void) | undefined;
    vi.mocked(listen).mockImplementation(async (event, callback) => {
      if (event === "agent-session-inbox://toggle-panel") {
        toggleHandler = callback as (event: { payload: boolean }) => void;
      }
      return () => undefined;
    });

    render(<StatusPanelView initialRows={initialSessions} sourceHealth={fakeSourceHealth} />);

    await act(async () => {
      toggleHandler?.({ payload: false });
    });
    expect(document.querySelector(".panel-shell--collapsed")).toBeNull();

    await act(async () => {
      toggleHandler?.({ payload: false });
    });
    expect(document.querySelector(".panel-shell--collapsed")).not.toBeNull();
  });

  it("restores the expanded panel from management when the shortcut reveals a hidden window", async () => {
    const { listen } = await import("@tauri-apps/api/event");
    let menuHandler: ((event: { payload: string }) => void) | undefined;
    let toggleHandler: ((event: { payload: boolean }) => void) | undefined;
    vi.mocked(listen).mockImplementation(async (event, callback) => {
      if (event === "agent-session-inbox://open-management") {
        menuHandler = callback as (event: { payload: string }) => void;
      }
      if (event === "agent-session-inbox://toggle-panel") {
        toggleHandler = callback as (event: { payload: boolean }) => void;
      }
      return () => undefined;
    });

    render(<StatusPanelView initialRows={initialSessions} sourceHealth={fakeSourceHealth} />);

    await act(async () => {
      menuHandler?.({ payload: "management" });
    });
    expect(await screen.findByText("management")).toBeTruthy();

    await act(async () => {
      toggleHandler?.({ payload: true });
    });
    expect(screen.queryByText("management")).toBeNull();
    expect(document.querySelector(".panel-shell--collapsed")).toBeNull();
    expect(screen.getByRole("article")).toBeTruthy();
  });

  it("keeps the visible shortcut selection after the old auto-collapse delay", async () => {
    vi.useFakeTimers();
    const firstRows = initialSessions.filter((row) => row.state !== "waitingForInput");
    const nextRows = [
      ...firstRows,
      {
        ...initialSessions[0],
        sessionId: "shortcut-auto-collapse-row",
        label: "Shortcut auto-collapse row",
        state: "inspect" as const,
        statusReason: "completed task ready to inspect; open it to mark read",
      },
    ];
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) => {
      const pathname = requestPath(url);
      if (pathname === "/api/sessions") return jsonResponse(nextRows);
      if (pathname === "/api/source-health") return jsonResponse(fakeSourceHealth);
      return jsonResponse({}, 404);
    }));
    const { listen } = await import("@tauri-apps/api/event");
    let toggleHandler: ((event: { payload: boolean }) => void) | undefined;
    vi.mocked(listen).mockImplementation(async (event, callback) => {
      if (event === "agent-session-inbox://toggle-panel") {
        toggleHandler = callback as (event: { payload: boolean }) => void;
      }
      return () => undefined;
    });

    render(<StatusPanelView initialRows={firstRows} sourceHealth={fakeSourceHealth} />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByText("Shortcut auto-collapse row")).toBeTruthy();
    expect(document.querySelector(".panel-shell--collapsed")).toBeNull();

    await act(async () => {
      toggleHandler?.({ payload: false });
      toggleHandler?.({ payload: false });
    });
    expect(document.querySelector(".panel-shell--collapsed")).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30001);
    });
    expect(document.querySelector(".panel-shell--collapsed")).toBeNull();
  });

  it("unlistens a shortcut registration that resolves after panel cleanup", async () => {
    const { listen } = await import("@tauri-apps/api/event");
    let resolveToggleListen: ((unlisten: () => void) => void) | undefined;
    const unlistenToggle = vi.fn();
    vi.mocked(listen).mockImplementation((event) => {
      if (event === "agent-session-inbox://toggle-panel") {
        return new Promise((resolve) => {
          resolveToggleListen = resolve;
        });
      }
      return Promise.resolve(() => undefined);
    });

    const rendered = render(<StatusPanelView initialRows={initialSessions} sourceHealth={fakeSourceHealth} />);
    rendered.unmount();

    await act(async () => {
      resolveToggleListen?.(unlistenToggle);
      await Promise.resolve();
    });
    expect(unlistenToggle).toHaveBeenCalledTimes(1);
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
    expect(screen.getByText("attention")).toBeTruthy();

    handler?.({ payload: "management" });
    fireEvent.change(await screen.findByLabelText("Language"), { target: { value: "zh" } });
    fireEvent.click(await screen.findByRole("button", { name: "Apply settings" }));

    expect(screen.getByText("1 需关注")).toBeTruthy();
    expect(screen.getByText("1 进行中")).toBeTruthy();
    expect(screen.queryByText("1 空闲")).toBeNull();
    expandPanel();
    expect(screen.getByText("待介入")).toBeTruthy();
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
    expect(screen.getByText("待介入")).toBeTruthy();
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
      visibleItemCount: 2,
    }));

    render(<StatusPanelView initialRows={initialSessions} sourceHealth={fakeSourceHealth} />);

    expect(screen.getByText("Attn")).toBeTruthy();
    expect(screen.getByText("1 需关注")).toBeTruthy();
    expect(screen.getByText("1 进行中")).toBeTruthy();
    expect(screen.queryByText("1 空闲")).toBeNull();
    expect(screen.queryByText("Codex 桌面端")).toBeNull();
    expect(screen.queryByText("本地数据")).toBeNull();
    expect(screen.queryByText("降级")).toBeNull();
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
    expect((screen.getByLabelText("待检查") as HTMLInputElement).checked).toBe(false);
    expect(screen.getByText("状态颜色")).toBeTruthy();
    expect(screen.getByRole("button", { name: "应用设置" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "返回" })).toBeTruthy();
    expect(screen.queryByText("Language")).toBeNull();
    expect(screen.queryByText("Apply settings")).toBeNull();
  });

  it("localizes jump feedback when Chinese is selected", async () => {
    const row: SessionRow = {
      ...initialSessions[0],
      sessionId: "zh-jump-feedback",
      label: "Chinese jump feedback",
      state: "inspect",
      statusReason: "completed task ready to inspect; open it to mark read",
    };
    let resolveJump: ((response: Response) => void) | undefined;
    window.localStorage.setItem("attn.statusPanelConfig", JSON.stringify({
      ...defaultZhConfig(),
      panelMode: "persistent",
    }));
    vi.stubGlobal("fetch", vi.fn((url: string | URL | Request) => {
      const pathname = requestPath(url);
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

    fireEvent.click(await screen.findByTitle("返回会话"));
    expect(screen.getByTitle("正在打开会话")).toBeTruthy();
    expect(within(document.querySelector(".panel-footer") as HTMLElement).getByText("正在打开会话")).toBeTruthy();

    resolveJump?.(jsonResponse({
      sessionId: row.sessionId,
      availability: "exact",
      target: "desktop",
      succeeded: true,
      message: "Opened Codex Desktop session.",
    }));

    expect(await screen.findByText("已打开 Codex 桌面端会话。")).toBeTruthy();
  });

  it("uses Chinese feedback for an unavailable jump target", async () => {
    const row: SessionRow = {
      ...initialSessions[0],
      sessionId: "zh-jump-unavailable",
      label: "Chinese unavailable jump",
      state: "inspect",
      statusReason: "completed task ready to inspect; open it to mark read",
    };
    window.localStorage.setItem("attn.statusPanelConfig", JSON.stringify({
      ...defaultZhConfig(),
      panelMode: "persistent",
    }));
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) => {
      const pathname = requestPath(url);
      if (pathname === "/api/jump") {
        return jsonResponse({
          sessionId: row.sessionId,
          availability: "unavailable",
          target: "unknown",
          succeeded: false,
          message: "Jump-back unavailable: missing reliable target signal.",
        });
      }
      if (pathname === "/api/sessions") return jsonResponse([row]);
      if (pathname === "/api/source-health") return jsonResponse(fakeSourceHealth);
      return jsonResponse({}, 404);
    }));

    render(<StatusPanelView initialRows={[row]} sourceHealth={fakeSourceHealth} />);

    fireEvent.click(await screen.findByTitle("返回会话"));

    expect(await screen.findByText("无法打开会话。")).toBeTruthy();
    expect(screen.queryByText("Jump-back unavailable: missing reliable target signal.")).toBeNull();
  });

  it("localizes completed pin feedback when Chinese is selected", async () => {
    const row: SessionRow = {
      ...initialSessions[0],
      sessionId: "zh-pin-feedback",
      label: "Chinese pin feedback",
      state: "inspect",
      statusReason: "completed task ready to inspect; open it to mark read",
    };
    window.localStorage.setItem("attn.statusPanelConfig", JSON.stringify({
      ...defaultZhConfig(),
      panelMode: "persistent",
    }));
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
    let pinned = false;
    tauriCoreMock.invoke.mockImplementation(async (command: string) => {
      if (command === "list_sessions") return [{ ...row, pinned }];
      if (command === "pin_session") {
        pinned = true;
        return [{ ...row, pinned }];
      }
      return null;
    });

    render(<StatusPanelView initialRows={[row]} sourceHealth={fakeSourceHealth} />);

    fireEvent.click(await screen.findByTitle("固定会话"));

    expect(await screen.findByText("已固定会话")).toBeTruthy();
  });

  it("uses Chinese feedback after installing Codex hooks", async () => {
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
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
    tauriCoreMock.invoke.mockImplementation(async (command: string) => {
      if (command === "list_sessions") return initialSessions;
      if (command === "codex_hook_integration_status") {
        return { installed: false, hooksPath: "", eventStorePath: "", detail: "Attn hook commands are not installed." };
      }
      if (command === "install_codex_hooks") {
        return { installed: true, hooksPath: "", eventStorePath: "", detail: "Attn hook commands are installed." };
      }
      return null;
    });

    render(<StatusPanelView initialRows={initialSessions} sourceHealth={fakeSourceHealth} />);
    handler?.({ payload: "management" });

    expect(await screen.findByText("尚未安装 Codex 钩子")).toBeTruthy();

    fireEvent.click(await screen.findByRole("button", { name: "安装 Codex 钩子" }));

    expect((await screen.findAllByText("Codex 钩子已安装")).length).toBe(2);
    expect(screen.queryByText("Attn hook commands are installed.")).toBeNull();
  });

  it("keeps an unexpected Codex hook diagnostic visible in Chinese", async () => {
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
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
    tauriCoreMock.invoke.mockImplementation(async (command: string) => {
      if (command === "list_sessions") return initialSessions;
      if (command === "codex_hook_integration_status") {
        return { installed: false, hooksPath: "", eventStorePath: "", detail: "read hooks failed: permission denied" };
      }
      return null;
    });

    render(<StatusPanelView initialRows={initialSessions} sourceHealth={fakeSourceHealth} />);
    handler?.({ payload: "management" });

    expect(await screen.findByText("read hooks failed: permission denied")).toBeTruthy();
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

  it.each([
    ["legacy storage without a shortcut", "agent-session-inbox.statusPanelConfig", {}, "shift+alt+super+space"],
    ["malformed shortcut", "attn.statusPanelConfig", { panelToggleShortcut: "not-a-shortcut" }, "shift+alt+super+space"],
    ["valid shortcut", "attn.statusPanelConfig", { panelToggleShortcut: "control+alt+super+p" }, "control+alt+super+p"],
    ["explicitly disabled shortcut", "attn.statusPanelConfig", { panelToggleShortcut: null }, null],
  ])("normalizes %s storage", async (_label, storageKey, config, expectedShortcut) => {
    window.localStorage.setItem(storageKey, JSON.stringify(config));

    render(<StatusPanelView initialRows={initialSessions} sourceHealth={fakeSourceHealth} />);

    await waitFor(() => {
      expect(readPersistedConfig().panelToggleShortcut).toBe(expectedShortcut);
    });
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
      const pathname = requestPath(url);
      if (pathname === "/api/sessions") return jsonResponse(rows);
      if (pathname === "/api/source-health") return jsonResponse(fakeSourceHealth);
      return jsonResponse({}, 404);
    }));

    render(<StatusPanelView initialRows={rows} sourceHealth={fakeSourceHealth} />);
    expandPanel();
    expect(screen.getAllByRole("article")).toHaveLength(1);

    handler?.({ payload: "management" });
    fireEvent.change(await screen.findByLabelText("Visible items"), { target: { value: "5" } });
    fireEvent.click(screen.getByText("Back"));
    expect(screen.getAllByRole("article")).toHaveLength(1);

    handler?.({ payload: "management" });
    fireEvent.change(await screen.findByLabelText("Visible items"), { target: { value: "5" } });
    fireEvent.click(await screen.findByRole("button", { name: "Apply settings" }));
    expandPanel();
    await waitFor(() => {
      expect(screen.getAllByRole("article")).toHaveLength(5);
    });
    await waitFor(() => {
      expect(tauriWindowMock.setSize).toHaveBeenCalledWith(expect.objectContaining({
        height: 324,
        width: 420,
      }));
    });
  });

  it("makes the status list scrollable when configured rows reach the window height cap", async () => {
    window.localStorage.setItem("attn.statusPanelConfig", JSON.stringify({ visibleItemCount: 8 }));
    const rows: SessionRow[] = Array.from({ length: 8 }, (_, index) => ({
      ...initialSessions[0],
      sessionId: `capped-row-${index + 1}`,
      label: `Capped row ${index + 1}`,
      state: "running",
      statusReason: "running signal observed",
    }));

    render(<StatusPanelView initialRows={rows} sourceHealth={fakeSourceHealth} />);
    expandPanel();

    expect(screen.getByLabelText("Codex status panel").className).toContain("status-list--scrollable");
    await waitFor(() => {
      expect(tauriWindowMock.setSize).toHaveBeenCalledWith(expect.objectContaining({
        height: 420,
        width: 420,
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
      const pathname = requestPath(url);
      if (pathname === "/api/sessions") return jsonResponse(rows);
      if (pathname === "/api/source-health") return jsonResponse(fakeSourceHealth);
      return jsonResponse({}, 404);
    }));

    render(<StatusPanelView initialRows={rows} sourceHealth={fakeSourceHealth} />);

    await waitFor(() => {
      expect(tauriWindowMock.setSize).toHaveBeenCalledWith(expect.objectContaining({
        height: 50,
        width: 420,
      }));
    });
    expandPanel();
    await waitFor(() => {
      expect(tauriWindowMock.setSize).toHaveBeenCalledWith(expect.objectContaining({
        height: 128,
        width: 420,
      }));
    });
  });

  it("keeps the latest multi-row native height when an earlier resize resolves late", async () => {
    window.localStorage.setItem("attn.statusPanelConfig", JSON.stringify({
      visibleItemCount: 2,
      panelMode: "persistent",
    }));
    const initialRow: SessionRow = {
      ...initialSessions[0],
      sessionId: "initial-resize-row",
      label: "Initial resize row",
      state: "running",
      statusReason: "running signal observed",
    };
    const refreshedRows: SessionRow[] = [
      initialRow,
      {
        ...initialSessions[0],
        sessionId: "refreshed-resize-row",
        label: "Refreshed resize row",
        state: "inspect",
        statusReason: "completed task ready to inspect; open it to mark read",
      },
    ];
    let resolveInitialNativeResize: (() => void) | undefined;
    let nativeWindowHeight: number | undefined;
    let resizeCallCount = 0;
    tauriWindowMock.setSize.mockImplementation((size: { height: number }) => {
      resizeCallCount += 1;
      if (resizeCallCount === 1) {
        return new Promise<void>((resolve) => {
          resolveInitialNativeResize = () => {
            nativeWindowHeight = size.height;
            resolve();
          };
        });
      }

      nativeWindowHeight = size.height;
      return Promise.resolve();
    });
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) => {
      const pathname = typeof url === "string" ? url : url instanceof URL ? url.pathname : url.url;
      if (pathname === "/api/sessions") return jsonResponse(refreshedRows);
      return jsonResponse({}, 404);
    }));

    render(<StatusPanelView initialRows={[initialRow]} sourceHealth={fakeSourceHealth} />);

    await waitFor(() => {
      expect(screen.getAllByRole("article")).toHaveLength(2);
    });
    await waitFor(() => {
      expect(resolveInitialNativeResize).toBeTypeOf("function");
      expect(tauriWindowMock.setSize).toHaveBeenCalledWith(expect.objectContaining({
        height: 128,
        width: 420,
      }));
    });

    await act(async () => {
      resolveInitialNativeResize?.();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(nativeWindowHeight).toBe(177);
    });
  });

  it("reserves a footer track so jump feedback cannot add a grid row", () => {
    // @ts-expect-error This test reads local CSS without adding Node types to the app build.
    const css = readFileSync(join(process.cwd(), "src/App.css"), "utf8");
    const panelShellBlock = css.match(/\.panel-shell \{[^}]+\}/)?.[0];

    expect(panelShellBlock).toContain("grid-template-rows: 28px minmax(0, auto) 22px;");
  });

  it("keeps jump feedback inline without a quiet overflow control or resize", async () => {
    const row: SessionRow = {
      ...initialSessions[0],
      sessionId: "jump-message-row",
      label: "Jump message row",
      state: "inspect",
      statusReason: "completed task ready to inspect; open it to mark read",
    };
    const quietRow: SessionRow = {
      ...initialSessions[2],
      sessionId: "quiet-after-jump",
      label: "Quiet after jump",
      state: "idle",
      statusReason: "completed task observed; idle until the next source signal",
    };
    let resolveJump: ((response: Response) => void) | undefined;
    vi.stubGlobal("fetch", vi.fn((url: string | URL | Request, init?: RequestInit) => {
      const pathname = requestPath(url);
      if (pathname === "/api/jump" && init?.method === "POST") {
        return new Promise<Response>((resolve) => {
          resolveJump = resolve;
        });
      }
      if (pathname === "/api/sessions") return Promise.resolve(jsonResponse([row, quietRow]));
      if (pathname === "/api/source-health") return Promise.resolve(jsonResponse(fakeSourceHealth));
      return Promise.resolve(jsonResponse({}, 404));
    }));

    render(<StatusPanelView initialRows={[row, quietRow]} sourceHealth={fakeSourceHealth} />);
    expandPanel();
    const footer = document.querySelector(".panel-footer") as HTMLElement;
    expect(within(footer).queryByRole("button")).toBeNull();
    await waitFor(() => {
      expect(tauriWindowMock.setSize).toHaveBeenCalledWith(expect.objectContaining({
        height: 128,
        width: 420,
      }));
    });
    tauriWindowMock.setSize.mockClear();

    fireEvent.click(screen.getByTitle("Jump back"));

    expect(within(footer).getByText("Opening session")).toBeTruthy();
    expect(document.querySelector(".panel-message")).toBeNull();

    resolveJump?.(jsonResponse({
      sessionId: row.sessionId,
      availability: "exact",
      target: "desktop",
      succeeded: true,
      message: "Opened Codex Desktop session.",
    }));

    expect(await screen.findByText("Opened Codex Desktop session.")).toBeTruthy();
    expect(Array.from(footer.children)).toHaveLength(2);
    expect(footer.firstElementChild?.textContent).toBe("Opened Codex Desktop session.");
    expect(footer.lastElementChild?.className).toContain("panel-counters");
    expect(within(footer).queryByRole("button")).toBeNull();
    expect(document.querySelector(".panel-message")).toBeNull();
    expect(tauriWindowMock.setSize).not.toHaveBeenCalled();
  });

  it("keeps jump feedback, hidden alerts, and counters in one footer row", async () => {
    window.localStorage.setItem("attn.statusPanelConfig", JSON.stringify({
      panelMode: "persistent",
      visibleItemCount: 1,
    }));
    const visibleRow: SessionRow = {
      ...initialSessions[0],
      sessionId: "footer-visible-alert",
      label: "Footer visible alert",
      state: "inspect",
      statusReason: "completed task ready to inspect; open it to mark read",
    };
    const hiddenRow: SessionRow = {
      ...visibleRow,
      sessionId: "footer-hidden-alert",
      label: "Footer hidden alert",
      lastActivityAt: "2026-06-15T03:20:00.000Z",
    };
    let resolveJump: ((response: Response) => void) | undefined;
    vi.stubGlobal("fetch", vi.fn((url: string | URL | Request, init?: RequestInit) => {
      const pathname = requestPath(url);
      if (pathname === "/api/jump" && init?.method === "POST") {
        return new Promise<Response>((resolve) => {
          resolveJump = resolve;
        });
      }
      if (pathname === "/api/sessions") return Promise.resolve(jsonResponse([visibleRow, hiddenRow]));
      if (pathname === "/api/source-health") return Promise.resolve(jsonResponse(fakeSourceHealth));
      return Promise.resolve(jsonResponse({}, 404));
    }));

    render(<StatusPanelView initialRows={[visibleRow, hiddenRow]} sourceHealth={fakeSourceHealth} />);
    const footer = document.querySelector(".panel-footer") as HTMLElement;
    expect(within(footer).getByRole("button", { name: "+1 alerts" })).toBeTruthy();
    tauriWindowMock.setSize.mockClear();

    fireEvent.click(screen.getByTitle("Jump back"));
    expect(within(footer).queryByRole("button", { name: "+1 alerts" })).toBeNull();

    resolveJump?.(jsonResponse({
      sessionId: visibleRow.sessionId,
      availability: "exact",
      target: "desktop",
      succeeded: true,
      message: "Opened Codex Desktop session.",
    }));

    expect(await within(footer).findByText("Opened Codex Desktop session.")).toBeTruthy();
    expect(Array.from(footer.children).map((element) => element.className)).toEqual([
      "jump-notice",
      "hidden-toggle",
      "panel-counters",
    ]);
    expect(within(footer).getByRole("button", { name: "+1 alerts" })).toBeTruthy();
    expect(footer.lastElementChild?.getAttribute("aria-label")).toBe("Session counters");
    expect(tauriWindowMock.setSize).not.toHaveBeenCalled();
  });

  it("clears completed jump feedback after three seconds", async () => {
    vi.useFakeTimers();
    const row: SessionRow = {
      ...initialSessions[0],
      sessionId: "jump-feedback-timeout",
      label: "Jump feedback timeout row",
      state: "inspect",
      statusReason: "completed task ready to inspect; open it to mark read",
    };
    let resolveJump: ((response: Response) => void) | undefined;
    let resolveRefresh: ((response: Response) => void) | undefined;
    let sessionRequestCount = 0;
    vi.stubGlobal("fetch", vi.fn((url: string | URL | Request) => {
      const pathname = requestPath(url);
      if (pathname === "/api/jump") {
        return new Promise<Response>((resolve) => {
          resolveJump = resolve;
        });
      }
      if (pathname === "/api/sessions") {
        sessionRequestCount += 1;
        if (sessionRequestCount === 1) return Promise.resolve(jsonResponse([row]));
        return new Promise<Response>((resolve) => {
          resolveRefresh = resolve;
        });
      }
      if (pathname === "/api/source-health") return Promise.resolve(jsonResponse(fakeSourceHealth));
      return Promise.resolve(jsonResponse({}, 404));
    }));

    render(<StatusPanelView initialRows={[row]} sourceHealth={fakeSourceHealth} />);
    expandPanel();
    await act(async () => {
      await Promise.resolve();
    });
    const jumpButton = screen.getByTitle("Jump back");
    tauriWindowMock.setSize.mockClear();
    fireEvent.click(jumpButton);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect((jumpButton as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTitle("Opening session")).toBeTruthy();
    const pendingFooter = document.querySelector(".panel-footer") as HTMLElement;
    expect(within(pendingFooter).getByText("Opening session")).toBeTruthy();
    expect(within(pendingFooter).queryByRole("button")).toBeNull();
    expect(document.querySelector(".panel-message")).toBeNull();
    expect(tauriWindowMock.setSize).not.toHaveBeenCalled();

    await act(async () => {
      resolveJump?.(jsonResponse({
        sessionId: row.sessionId,
        availability: "exact",
        target: "desktop",
        succeeded: true,
        message: "Opened Codex Desktop session.",
      }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(sessionRequestCount).toBe(2);
    expect(resolveRefresh).toBeTruthy();
    const resolveJumpRefresh = resolveRefresh;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(screen.getByText("Opening session")).toBeTruthy();
    expect((jumpButton as HTMLButtonElement).disabled).toBe(true);

    await act(async () => {
      resolveJumpRefresh?.(jsonResponse([row]));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByText("Opened Codex Desktop session.")).toBeTruthy();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2999);
    });
    expect(screen.getByText("Opened Codex Desktop session.")).toBeTruthy();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(screen.queryByText("Opened Codex Desktop session.")).toBeNull();
    const footer = document.querySelector(".panel-footer") as HTMLElement;
    expect(footer).toBeTruthy();
    expect(within(footer).queryByText("Opened Codex Desktop session.")).toBeNull();
    expect(tauriWindowMock.setSize).not.toHaveBeenCalled();
  });

  it("keeps failed jump feedback visible when its target is exact", async () => {
    vi.useFakeTimers();
    const row: SessionRow = {
      ...initialSessions[0],
      sessionId: "jump-feedback-failed",
      label: "Jump feedback failed row",
      state: "inspect",
      statusReason: "completed task ready to inspect; open it to mark read",
    };
    vi.stubGlobal("fetch", vi.fn((url: string | URL | Request) => {
      const pathname = typeof url === "string" ? url : url instanceof URL ? url.pathname : url.url;
      if (pathname === "/api/jump") {
        return Promise.resolve(jsonResponse({
          sessionId: row.sessionId,
          availability: "exact",
          target: "desktop",
          succeeded: false,
          message: "Jump-back failed: open failed.",
        }));
      }
      if (pathname === "/api/sessions") return Promise.resolve(jsonResponse([row]));
      return Promise.resolve(jsonResponse({}, 404));
    }));

    render(<StatusPanelView initialRows={[row]} sourceHealth={fakeSourceHealth} />);
    expandPanel();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(tauriWindowMock.setSize).toHaveBeenCalledWith(expect.objectContaining({
      height: 128,
      width: 420,
    }));
    tauriWindowMock.setSize.mockClear();
    fireEvent.click(screen.getByTitle("Jump back"));

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const footer = document.querySelector(".panel-footer") as HTMLElement;
    expect(within(footer).getByText("Jump-back failed: open failed.")).toBeTruthy();
    expect(document.querySelector(".panel-message")).toBeNull();
    expect(tauriWindowMock.setSize).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(within(footer).getByText("Jump-back failed: open failed.")).toBeTruthy();
  });

  it("shows a Tauri session-loading string rejection verbatim", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {},
    });
    tauriCoreMock.invoke.mockRejectedValue("Native session source is unavailable.");

    render(<StatusPanelView initialRows={initialSessions} sourceHealth={fakeSourceHealth} />);
    expandPanel();

    expect(await screen.findByText("Native session source is unavailable.")).toBeTruthy();
  });

  it("shows a Tauri jump string rejection verbatim", async () => {
    const row: SessionRow = {
      ...initialSessions[0],
      sessionId: "native-jump-error",
      label: "Native jump error",
      state: "inspect",
      statusReason: "completed task ready to inspect; open it to mark read",
    };
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {},
    });
    tauriCoreMock.invoke.mockImplementation(async (command: string) => {
      if (command === "list_sessions") return [row];
      if (command === "jump_to_session") throw "Native desktop jump was rejected.";
      return null;
    });

    render(<StatusPanelView initialRows={[row]} sourceHealth={fakeSourceHealth} />);
    expandPanel();
    fireEvent.click(await screen.findByTitle("Jump back"));

    expect(await screen.findByText("Native desktop jump was rejected.")).toBeTruthy();
  });

  it("keeps the latest jump result when multiple rows open concurrently", async () => {
    window.localStorage.setItem("attn.statusPanelConfig", JSON.stringify({ visibleItemCount: 2 }));
    const firstRow: SessionRow = {
      ...initialSessions[0],
      sessionId: "first-concurrent-jump",
      label: "First concurrent jump",
      state: "inspect",
      statusReason: "completed task ready to inspect; open it to mark read",
    };
    const secondRow: SessionRow = {
      ...initialSessions[0],
      sessionId: "second-concurrent-jump",
      label: "Second concurrent jump",
      state: "inspect",
      statusReason: "completed task ready to inspect; open it to mark read",
    };
    const resolveJump = new Map<string, (response: Response) => void>();
    vi.stubGlobal("fetch", vi.fn((url: string | URL | Request, init?: RequestInit) => {
      const pathname = typeof url === "string" ? url : url instanceof URL ? url.pathname : url.url;
      if (pathname === "/api/jump") {
        const { sessionId } = JSON.parse(String(init?.body)) as { sessionId: string };
        return new Promise<Response>((resolve) => {
          resolveJump.set(sessionId, resolve);
        });
      }
      if (pathname === "/api/sessions") return Promise.resolve(jsonResponse([firstRow, secondRow]));
      return Promise.resolve(jsonResponse({}, 404));
    }));

    render(<StatusPanelView initialRows={[firstRow, secondRow]} sourceHealth={fakeSourceHealth} />);
    expandPanel();

    fireEvent.click(within(screen.getByTestId(`status-row-${firstRow.sessionId}`)).getByTitle("Jump back"));
    fireEvent.click(within(screen.getByTestId(`status-row-${secondRow.sessionId}`)).getByTitle("Jump back"));

    await act(async () => {
      resolveJump.get(secondRow.sessionId)?.(jsonResponse({
        sessionId: secondRow.sessionId,
        availability: "exact",
        target: "desktop",
        succeeded: true,
        message: "Opened second session.",
      }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(await screen.findByText("Opened second session.")).toBeTruthy();

    await act(async () => {
      resolveJump.get(firstRow.sessionId)?.(jsonResponse({
        sessionId: firstRow.sessionId,
        availability: "exact",
        target: "desktop",
        succeeded: true,
        message: "Opened first session.",
      }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByText("Opened second session.")).toBeTruthy();
    expect(screen.queryByText("Opened first session.")).toBeNull();
  });

  it("does not schedule jump feedback after the panel unmounts", async () => {
    vi.useFakeTimers();
    const row: SessionRow = {
      ...initialSessions[0],
      sessionId: "jump-after-unmount",
      label: "Jump after unmount",
      state: "inspect",
      statusReason: "completed task ready to inspect; open it to mark read",
    };
    let resolveJump: ((response: Response) => void) | undefined;
    vi.stubGlobal("fetch", vi.fn((url: string | URL | Request) => {
      const pathname = typeof url === "string" ? url : url instanceof URL ? url.pathname : url.url;
      if (pathname === "/api/jump") {
        return new Promise<Response>((resolve) => {
          resolveJump = resolve;
        });
      }
      if (pathname === "/api/sessions") return Promise.resolve(jsonResponse([row]));
      return Promise.resolve(jsonResponse({}, 404));
    }));
    const setTimeoutSpy = vi.spyOn(window, "setTimeout");

    const { unmount } = render(<StatusPanelView initialRows={[row]} sourceHealth={fakeSourceHealth} />);
    expandPanel();
    fireEvent.click(screen.getByTitle("Jump back"));
    const timersBeforeUnmount = setTimeoutSpy.mock.calls.length;
    unmount();

    await act(async () => {
      resolveJump?.(jsonResponse({
        sessionId: row.sessionId,
        availability: "exact",
        target: "desktop",
        succeeded: true,
        message: "Opened Codex Desktop session.",
      }));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(setTimeoutSpy).toHaveBeenCalledTimes(timersBeforeUnmount);
  });

  it("uses small Atom status markers for visible rows", () => {
    window.localStorage.setItem("attn.statusPanelConfig", JSON.stringify({ visibleItemCount: 3 }));
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

    expect(statusTexts).toEqual(["● blocked", "● attention", "● inspect"]);
  });

  it("does not render subagent rows or a parent subtask summary", () => {
    window.localStorage.setItem("attn.statusPanelConfig", JSON.stringify({ visibleItemCount: 2 }));
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
        parentSessionId: "parent",
        statusReason: "running signal observed",
      },
      {
        ...initialSessions[0],
        sessionId: "child-inspect",
        label: "Inspect child task",
        state: "inspect",
        workspacePath: "/Users/edy/project",
        threadSource: "subagent",
        parentSessionId: "parent",
        statusReason: "completed task ready to inspect; open it to mark read",
      },
      {
        ...initialSessions[0],
        sessionId: "child-input",
        label: "Input child task",
        state: "waitingForInput",
        workspacePath: "/Users/edy/project",
        parentSessionId: "parent",
        statusReason: "waiting for user input",
      },
      {
        ...initialSessions[0],
        sessionId: "child-stopped",
        label: "Stopped child task",
        state: "stopped",
        workspacePath: "/Users/edy/project",
        threadSource: "subagent",
        parentSessionId: "parent",
        statusReason: "stopped before completion",
      },
    ];

    render(<StatusPanelView initialRows={rows} sourceHealth={fakeSourceHealth} />);
    expandPanel();

    expect(screen.getByText("Parent task")).toBeTruthy();
    expect(screen.getByText("0 alerts")).toBeTruthy();
    expect(screen.queryByText("Quiet child task")).toBeNull();
    expect(screen.queryByText("Inspect child task")).toBeNull();
    expect(screen.queryByText("Input child task")).toBeNull();
    expect(screen.queryByText("Stopped child task")).toBeNull();
    expect(screen.queryByText(/subtasks?/)).toBeNull();
    expect(screen.queryByText("subagent anomaly")).toBeNull();
    expect(screen.getAllByRole("article")).toHaveLength(1);
  });

  it("keeps an opened intervention row quiet but visible during the follow-up read window", async () => {
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
      statusReason: "Read recently; keep it quiet during the 30-minute follow-up window.",
      handled: true,
      dismissed: false,
    };
    let jumped = false;
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) => {
      const pathname = requestPath(url);
      if (pathname === "/api/jump") {
        jumped = true;
        return jsonResponse({
          sessionId: attentionRow.sessionId,
          availability: "exact",
          target: "desktop",
          succeeded: true,
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
      expect(screen.getByText("0 alerts")).toBeTruthy();
    });
    expect(screen.getByLabelText("Show status evidence for AMap geolocation preload investigation")).toBeTruthy();
    expect(screen.getByText("follow-up")).toBeTruthy();
    expect(screen.queryByText("+1 quiet")).toBeNull();
  });

  it("sends the configured follow-up idle duration to preview list and jump requests", async () => {
    const row = { ...initialSessions[0], sessionId: "preview-duration-row", label: "Preview duration row" };
    window.localStorage.setItem("attn.statusPanelConfig", JSON.stringify({
      followUpToIdleMinutes: 45,
      panelMode: "persistent",
    }));
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const pathname = requestPath(url);
      if (pathname === "/api/sessions") return jsonResponse([row]);
      if (pathname === "/api/source-health") return jsonResponse(fakeSourceHealth);
      if (pathname === "/api/jump") {
        return jsonResponse({
          sessionId: row.sessionId,
          availability: "exact",
          target: "desktop",
          message: "Opened Codex Desktop session.",
        });
      }
      return jsonResponse({}, 404);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<StatusPanelView initialRows={[row]} sourceHealth={fakeSourceHealth} />);
    fireEvent.click(await screen.findByTitle("Jump back"));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/sessions?followUpToIdleMinutes=45",
        undefined,
      );
      expect(fetchMock).toHaveBeenCalledWith("/api/jump", expect.objectContaining({
        body: JSON.stringify({
          sessionId: row.sessionId,
          acknowledgedSessionIds: [row.sessionId],
          followUpToIdleMinutes: 45,
        }),
      }));
    });
  });

  it("pins and unpins a row from the status panel", async () => {
    const row: SessionRow = {
      ...initialSessions[0],
      sessionId: "pin-row",
      label: "Pin row",
      state: "inspect",
      pinned: false,
      statusReason: "completed task ready to inspect; open it to mark read",
    };
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {},
    });
    let pinned = false;
    tauriCoreMock.invoke.mockImplementation(async (command: string) => {
      if (command === "list_sessions") return [{ ...row, pinned }];
      if (command === "source_health") return fakeSourceHealth;
      if (command === "pin_session") {
        pinned = true;
        return [{ ...row, pinned }];
      }
      if (command === "unpin_session") {
        pinned = false;
        return [{ ...row, pinned }];
      }
      return null;
    });

    render(<StatusPanelView initialRows={[row]} sourceHealth={fakeSourceHealth} />);
    expandPanel();

    fireEvent.click(await screen.findByTitle("Pin session"));

    expect(tauriCoreMock.invoke).toHaveBeenCalledWith("pin_session", { sessionId: "pin-row" });
    expect(await screen.findByTitle("Unpin session")).toBeTruthy();

    fireEvent.click(screen.getByTitle("Unpin session"));

    expect(tauriCoreMock.invoke).toHaveBeenCalledWith("unpin_session", { sessionId: "pin-row" });
    expect(await screen.findByTitle("Pin session")).toBeTruthy();
  });

  it("refreshes mutation results with the configured follow-up idle duration", async () => {
    const row: SessionRow = {
      ...initialSessions[0],
      sessionId: "configured-duration-row",
      label: "Configured duration row",
      state: "inspect",
      statusReason: "completed task ready to inspect; open it to mark read",
    };
    window.localStorage.setItem("attn.statusPanelConfig", JSON.stringify({
      followUpToIdleMinutes: 45,
      panelMode: "persistent",
    }));
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
    let pinned = false;
    let dismissed = false;
    tauriCoreMock.invoke.mockImplementation(async (command: string) => {
      if (command === "list_sessions") return [{ ...row, pinned, dismissed, handled: dismissed }];
      if (command === "source_health") return fakeSourceHealth;
      if (command === "pin_session") {
        pinned = true;
        return [{ ...row, pinned }];
      }
      if (command === "unpin_session") {
        pinned = false;
        return [{ ...row, pinned }];
      }
      if (command === "dismiss_sessions") {
        dismissed = true;
        return [{ ...row, dismissed, handled: dismissed }];
      }
      return null;
    });

    render(<StatusPanelView initialRows={[row]} sourceHealth={fakeSourceHealth} />);
    await waitFor(() => {
      expect(lastInvokeCall("list_sessions")).toEqual([
        "list_sessions",
        { followUpToIdleMinutes: 45 },
      ]);
    });
    tauriCoreMock.invoke.mockClear();

    fireEvent.click(await screen.findByTitle("Pin session"));
    await waitFor(() => {
      expect(tauriCoreMock.invoke).toHaveBeenCalledWith("pin_session", { sessionId: row.sessionId });
      expect(lastInvokeCall("list_sessions")).toEqual([
        "list_sessions",
        { followUpToIdleMinutes: 45 },
      ]);
    });

    tauriCoreMock.invoke.mockClear();
    fireEvent.click(await screen.findByTitle("Unpin session"));
    await waitFor(() => {
      expect(tauriCoreMock.invoke).toHaveBeenCalledWith("unpin_session", { sessionId: row.sessionId });
      expect(lastInvokeCall("list_sessions")).toEqual([
        "list_sessions",
        { followUpToIdleMinutes: 45 },
      ]);
    });

    tauriCoreMock.invoke.mockClear();
    fireEvent.click(await screen.findByTitle("Dismiss"));
    await waitFor(() => {
      expect(tauriCoreMock.invoke).toHaveBeenCalledWith("dismiss_sessions", { sessionIds: [row.sessionId] });
      expect(lastInvokeCall("list_sessions")).toEqual([
        "list_sessions",
        { followUpToIdleMinutes: 45 },
      ]);
    });
  });

  it("does not let a pre-mutation refresh overwrite the post-mutation snapshot", async () => {
    const initialRow: SessionRow = {
      ...initialSessions[0],
      sessionId: "mutation-refresh-row",
      label: "Initial mutation row",
      state: "inspect",
      pinned: false,
      statusReason: "completed task ready to inspect; open it to mark read",
    };
    const staleRow: SessionRow = {
      ...initialRow,
      label: "Stale pre-mutation row",
      pinned: false,
    };
    const freshRow: SessionRow = {
      ...initialRow,
      label: "Post-mutation row",
      pinned: true,
    };
    let resolveStaleRefresh: ((rows: SessionRow[]) => void) | undefined;
    const staleRefresh = new Promise<SessionRow[]>((resolve) => {
      resolveStaleRefresh = resolve;
    });
    let listCallCount = 0;

    window.localStorage.setItem("attn.statusPanelConfig", JSON.stringify({
      followUpToIdleMinutes: 45,
      panelMode: "persistent",
    }));
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
    tauriCoreMock.invoke.mockImplementation((command: string) => {
      if (command === "list_sessions") {
        listCallCount += 1;
        return listCallCount === 1 ? staleRefresh : Promise.resolve([freshRow]);
      }
      if (command === "pin_session") return Promise.resolve([freshRow]);
      return Promise.resolve(null);
    });

    render(<StatusPanelView initialRows={[initialRow]} sourceHealth={fakeSourceHealth} />);
    await waitFor(() => {
      expect(listCallCount).toBe(1);
    });
    expandPanel();

    fireEvent.click(await screen.findByTitle("Pin session"));

    await waitFor(() => {
      expect(listCallCount).toBe(2);
    });
    expect(await screen.findByText("Post-mutation row")).toBeTruthy();
    expect(screen.getByTitle("Unpin session")).toBeTruthy();

    await act(async () => {
      resolveStaleRefresh?.([staleRow]);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByText("Post-mutation row")).toBeTruthy();
    expect(screen.getByTitle("Unpin session")).toBeTruthy();
    expect(screen.queryByText("Stale pre-mutation row")).toBeNull();
  });

  it("keeps pinned rows in inspect after jump refresh returns acknowledged state", async () => {
    const pinnedRow: SessionRow = {
      ...initialSessions[0],
      sessionId: "pinned-jump-row",
      label: "Pinned jump row",
      state: "inspect",
      pinned: true,
      statusReason: "completed task ready to inspect; open it to mark read",
    };
    const acknowledgedButPinnedRow: SessionRow = {
      ...pinnedRow,
      state: "inspect",
      handled: false,
      statusReason: "completed task ready to inspect; open it to mark read",
    };
    let jumped = false;
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {},
    });
    tauriCoreMock.invoke.mockImplementation(async (command: string) => {
      if (command === "list_sessions") return jumped ? [acknowledgedButPinnedRow] : [pinnedRow];
      if (command === "source_health") return fakeSourceHealth;
      if (command === "jump_to_session") {
        jumped = true;
        return {
          sessionId: pinnedRow.sessionId,
          availability: "exact",
          target: "desktop",
          succeeded: true,
          message: "Opened Codex Desktop session.",
        };
      }
      return null;
    });

    render(<StatusPanelView initialRows={[pinnedRow]} sourceHealth={fakeSourceHealth} />);
    expandPanel();

    fireEvent.click(await screen.findByTitle("Jump back"));

    expect(await screen.findByText("inspect")).toBeTruthy();
    expect(screen.queryByText("follow-up")).toBeNull();
    expect(screen.getByTitle("Unpin session")).toBeTruthy();
  });

  it("removes a dismissed row immediately while the command is still running", async () => {
    const row = { ...initialSessions[0], sessionId: "dismiss-lag", label: "Dismiss lag row" };
    let resolveDismiss: ((response: Response) => void) | undefined;
    vi.stubGlobal("fetch", vi.fn((url: string | URL | Request) => {
      const pathname = requestPath(url);
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
      const pathname = requestPath(url);
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
      succeeded: true,
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

    expect(css).toContain("padding: 6px;");
    expect(css).toContain("width: min(100vw - 8px, 412px);");
    expect(css).toContain("max-height: calc(100vh - 8px);");
    expect(css).toContain("inset 0 1px 0 rgba(171, 178, 191, 0.08);");
  });

  it("keeps the native minimum height aligned with the collapsed strip", () => {
    // @ts-expect-error This test reads local JSON without adding Node types to the app build.
    const tauriConfig = JSON.parse(readFileSync(join(process.cwd(), "src-tauri/tauri.conf.json"), "utf8"));

    expect(tauriConfig.app.windows[0].minHeight).toBe(50);
    expect(tauriConfig.app.windows[0].maxHeight).toBe(420);
  });

  it("keeps the strip toggle from shifting header layout", () => {
    // @ts-expect-error This test reads local CSS without adding Node types to the app build.
    const css = readFileSync(join(process.cwd(), "src/App.css"), "utf8");
    const collapsedBlock = css.match(/\.panel-shell--collapsed \{[^}]+\}/)?.[0];
    const stripToggleBlock = css.match(/\.strip-toggle \{[^}]+\}/)?.[0];

    expect(collapsedBlock).not.toContain("padding:");
    expect(stripToggleBlock).toContain("width: 20px;");
    expect(stripToggleBlock).toContain("line-height: 18px;");
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

    expect(rowBlock).toContain("grid-template-columns: 78px minmax(0, 1fr) auto;");
    expect(rowBlock).toContain("padding: 4px 5px 4px 9px;");
    expect(statusCodeBlock).toContain("align-items: center;");
    expect(statusCodeBlock).toContain("display: flex;");
    expect(statusCodeBlock).toContain("min-width: 62px;");
    expect(statusMarkerBlock).toContain("margin-right: 6px;");
  });

  it("keeps status row left borders inside the clipped panel area", () => {
    // @ts-expect-error This test reads local CSS without adding Node types to the app build.
    const css = readFileSync(join(process.cwd(), "src/App.css"), "utf8");
    const listBlock = css.match(/\.status-list \{[^}]+\}/)?.[0];
    const rowBlock = css.match(/\.status-row \{[^}]+\}/)?.[0];

    expect(listBlock).toContain("padding-left: 2px;");
    expect(rowBlock).toContain("width: calc(100% - 2px);");
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
    visibleItemCount: 1,
    panelMode: "auto",
    autoCollapseDelayMs: 30000,
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

function lastInvokeCall(command: string) {
  const matchingCalls = tauriCoreMock.invoke.mock.calls.filter(([name]) => name === command);
  return matchingCalls[matchingCalls.length - 1];
}

function readPersistedConfig() {
  return JSON.parse(window.localStorage.getItem("attn.statusPanelConfig") ?? "{}");
}

function requestPath(url: string | URL | Request) {
  const rawUrl = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
  return new URL(rawUrl, window.location.origin).pathname;
}

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
