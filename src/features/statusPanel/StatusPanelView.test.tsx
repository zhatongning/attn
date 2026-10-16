import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error This test reads local CSS without adding Node types to the app build.
import { readFileSync } from "node:fs";
// @ts-expect-error This test reads local CSS without adding Node types to the app build.
import { join } from "node:path";
import type { SessionRow } from "../../shared/types/session";
import { fakeSourceHealth, initialSessions } from "../inbox/fakeSessions";
import { StatusPanelView } from "./StatusPanelView";
import type { PlacementSnapshot } from "../inbox/inboxApi";
import * as inboxApi from "../inbox/inboxApi";

const tauriWindowMock = vi.hoisted(() => ({
  setSize: vi.fn<(size: { width: number; height: number }) => Promise<void>>(async () => undefined),
  setPosition: vi.fn<(position: { x: number; y: number }) => Promise<void>>(async () => undefined),
  startDragging: vi.fn(async () => undefined),
  onMoved: vi.fn(async (_handler: unknown) => vi.fn()),
  show: vi.fn(async () => undefined),
  setFocus: vi.fn(async () => undefined),
}));

const tauriEventMock = vi.hoisted(() => ({
  listen: vi.fn<(event: string, callback: unknown) => Promise<() => void>>(async () => vi.fn<() => void>()),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: tauriEventMock.listen,
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
    show: tauriWindowMock.show,
    setFocus: tauriWindowMock.setFocus,
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
  tauriWindowMock.setSize.mockReset();
  tauriWindowMock.setSize.mockImplementation(async () => undefined);
  tauriWindowMock.setPosition.mockReset();
  tauriWindowMock.setPosition.mockImplementation(async () => undefined);
  tauriWindowMock.startDragging.mockClear();
  tauriWindowMock.onMoved.mockReset();
  tauriWindowMock.onMoved.mockImplementation(async (_handler: unknown) => vi.fn());
  tauriWindowMock.show.mockClear();
  tauriWindowMock.setFocus.mockClear();
  tauriEventMock.listen.mockReset();
  tauriEventMock.listen.mockImplementation(async () => vi.fn<() => void>());
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
    expect(statusRows).toHaveLength(3);
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

  it("identifies parent work driven by active subagents", () => {
    window.localStorage.setItem("attn.statusPanelConfig", JSON.stringify({
      language: "zh",
      panelMode: "persistent",
    }));
    const row: SessionRow = {
      ...initialSessions[1],
      sessionId: "parent-with-subagent",
      label: "Parent with active child",
      activeSubagentCount: 3,
    };

    render(<StatusPanelView initialRows={[row]} sourceHealth={fakeSourceHealth} />);

    const marker = screen.getByTestId("status-subagent-parent-with-subagent");
    expect(marker.textContent).toBe("子代理活动 · 3");
    expect(marker.getAttribute("aria-label")).toBe("子代理活动 · 3");
    expect(screen.getByTestId("status-row-parent-with-subagent").className)
      .toContain("status-row--subagent-active");
  });

  it("keeps the marker visible when a quiet parent has active subagents", () => {
    window.localStorage.setItem("attn.statusPanelConfig", JSON.stringify({
      language: "zh",
      panelMode: "persistent",
    }));
    const row: SessionRow = {
      ...initialSessions[1],
      sessionId: "quiet-parent-with-subagent",
      label: "Quiet parent with active child",
      state: "idle",
      activeSubagentCount: 1,
    };

    render(<StatusPanelView initialRows={[row]} sourceHealth={fakeSourceHealth} />);

    expect(screen.getByTestId("status-subagent-quiet-parent-with-subagent").textContent)
      .toBe("子代理活动 · 1");
    expect(screen.getByTestId("status-row-quiet-parent-with-subagent").className)
      .toContain("status-row--working");
  });

  it("does not render a subagent marker for ordinary parent rows", () => {
    window.localStorage.setItem("attn.statusPanelConfig", JSON.stringify({
      language: "zh",
      panelMode: "persistent",
    }));
    const row: SessionRow = {
      ...initialSessions[1],
      sessionId: "ordinary-parent",
    };

    render(<StatusPanelView initialRows={[row]} sourceHealth={fakeSourceHealth} />);

    expect(screen.queryByTestId("status-subagent-ordinary-parent")).toBeNull();
    expect(screen.getByTestId("status-row-ordinary-parent").className)
      .not.toContain("status-row--subagent-active");
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
    expect(screen.getAllByRole("article")).toHaveLength(2);
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
    expect(screen.getByText("Unable to load Codex source.")).toBeTruthy();
  });

  it("refreshes immediately when native source files change", async () => {
    const workingRow: SessionRow = {
      ...initialSessions[1],
      sessionId: "file-event-session",
      label: "File event session",
      state: "running",
      statusReason: "running signal observed",
    };
    const waitingRow: SessionRow = {
      ...workingRow,
      state: "waitingForInput",
      statusReason: "Codex is waiting for tool approval.",
    };
    window.localStorage.setItem("attn.statusPanelConfig", JSON.stringify({ panelMode: "persistent" }));
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
    let onSourcesChanged: (() => void) | undefined;
    tauriEventMock.listen.mockImplementation(async (event, handler) => {
      if (event === "agent-session-inbox://sources-changed") {
        onSourcesChanged = handler as () => void;
      }
      return vi.fn<() => void>();
    });
    let listRequestCount = 0;
    tauriCoreMock.invoke.mockImplementation(async (command: string) => {
      if (command === "list_sessions") {
        listRequestCount += 1;
        return listRequestCount === 1 ? [workingRow] : [waitingRow];
      }
      return null;
    });

    render(<StatusPanelView initialRows={[workingRow]} sourceHealth={fakeSourceHealth} />);
    await waitFor(() => {
      expect(onSourcesChanged).toBeTruthy();
      expect(listRequestCount).toBe(1);
    });
    await act(async () => {
      onSourcesChanged?.();
    });

    await waitFor(() => {
      expect(screen.getByTestId("status-row-file-event-session").className).toContain("status-row--input");
    });
    expect(listRequestCount).toBe(2);
  });

  it("keeps same-status rows in place across source refreshes and activity updates", async () => {
    const first: SessionRow = {
      ...initialSessions[1],
      sessionId: "stable-first",
      label: "First running task",
      state: "running",
      statusReason: "running signal observed",
      lastActivityAt: "2026-10-15T03:03:00.000Z",
    };
    const second = { ...first, sessionId: "stable-second", label: "Second running task", lastActivityAt: "2026-10-15T03:02:00.000Z" };
    const third = { ...first, sessionId: "stable-third", label: "Third running task", lastActivityAt: "2026-10-15T03:01:00.000Z" };
    const newcomer = { ...first, sessionId: "stable-new", label: "New running task", lastActivityAt: "2026-10-15T04:00:00.000Z" };
    let sourceRows = [first, second, third];
    window.localStorage.setItem("attn.statusPanelConfig", JSON.stringify({
      panelMode: "persistent",
      visibleItemCount: 2,
    }));
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
    let onSourcesChanged: (() => void) | undefined;
    tauriEventMock.listen.mockImplementation(async (event, handler) => {
      if (event === "agent-session-inbox://sources-changed") onSourcesChanged = handler as () => void;
      return vi.fn<() => void>();
    });
    tauriCoreMock.invoke.mockImplementation(async (command: string) =>
      command === "list_sessions" ? sourceRows : null,
    );
    const displayedIds = () => screen.getAllByRole("article").map((element) => element.getAttribute("data-testid"));

    render(<StatusPanelView initialRows={sourceRows} sourceHealth={fakeSourceHealth} />);
    await waitFor(() => expect(onSourcesChanged).toBeTruthy());
    expect(displayedIds()).toEqual(["status-row-stable-first", "status-row-stable-second"]);

    sourceRows = [
      newcomer,
      { ...third, lastActivityAt: "2026-10-15T03:59:00.000Z" },
      { ...second, label: "Second task updated", lastActivityAt: "2026-10-15T03:58:00.000Z", activeSubagentCount: 2 },
      first,
    ];
    await act(async () => onSourcesChanged?.());

    expect(displayedIds()).toEqual(["status-row-stable-first", "status-row-stable-second"]);
    expect(screen.getByText("Second task updated")).toBeTruthy();
    expect(screen.getByTestId("status-subagent-stable-second").textContent).toContain("2");

    sourceRows = [newcomer, third, first, { ...second, state: "waitingForInput" }];
    await act(async () => onSourcesChanged?.());
    expect(displayedIds()).toEqual(["status-row-stable-second", "status-row-stable-first"]);
    expect(screen.getByTestId("status-row-stable-second").className).toContain("status-row--input");

    sourceRows = [newcomer, third, first];
    await act(async () => onSourcesChanged?.());
    expect(displayedIds()).toEqual(["status-row-stable-first", "status-row-stable-third"]);
  });

  it("keeps a source change queued behind a slow refresh without showing stale rows", async () => {
    const workingRow: SessionRow = {
      ...initialSessions[1],
      sessionId: "slow-source-change",
      label: "Slow source change",
      state: "running",
      statusReason: "running signal observed",
    };
    const waitingRow: SessionRow = {
      ...workingRow,
      state: "waitingForInput",
      statusReason: "Codex is waiting for tool approval.",
    };
    window.localStorage.setItem("attn.statusPanelConfig", JSON.stringify({ panelMode: "persistent" }));
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
    let onSourcesChanged: (() => void) | undefined;
    tauriEventMock.listen.mockImplementation(async (event, handler) => {
      if (event === "agent-session-inbox://sources-changed") onSourcesChanged = handler as () => void;
      return vi.fn<() => void>();
    });
    let finishFirst: ((rows: SessionRow[]) => void) | undefined;
    const first = new Promise<SessionRow[]>((resolve) => { finishFirst = resolve; });
    let finishSecond: ((rows: SessionRow[]) => void) | undefined;
    const second = new Promise<SessionRow[]>((resolve) => { finishSecond = resolve; });
    let listRequestCount = 0;
    tauriCoreMock.invoke.mockImplementation((command: string) => {
      if (command === "list_sessions") {
        listRequestCount += 1;
        return listRequestCount === 1 ? first : second;
      }
      return Promise.resolve(null);
    });

    render(<StatusPanelView initialRows={[workingRow]} sourceHealth={fakeSourceHealth} />);
    await waitFor(() => {
      expect(onSourcesChanged).toBeTruthy();
      expect(listRequestCount).toBe(1);
    });
    await act(async () => {
      onSourcesChanged?.();
      onSourcesChanged?.();
      finishFirst?.([workingRow]);
      await Promise.resolve();
    });
    await waitFor(() => expect(listRequestCount).toBe(2));
    expect(screen.getByTestId("status-row-slow-source-change").className).toContain("status-row--working");

    await act(async () => {
      finishSecond?.([waitingRow]);
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(screen.getByTestId("status-row-slow-source-change").className).toContain("status-row--input");
    });
    expect(listRequestCount).toBe(2);
  });

  it("schedules the next poll only after a slow source request settles", async () => {
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
    let resolveNewerRefresh: ((rows: SessionRow[]) => void) | undefined;
    const newerRefresh = new Promise<SessionRow[]>((resolve) => {
      resolveNewerRefresh = resolve;
    });
    let listRequestCount = 0;
    tauriCoreMock.invoke.mockImplementation((command: string) => {
      if (command === "list_sessions") {
        listRequestCount += 1;
        return listRequestCount === 1 ? olderRefresh : newerRefresh;
      }
      if (command === "source_health") return Promise.resolve(fakeSourceHealth);
      return Promise.resolve(null);
    });

    const originalSetTimeout = window.setTimeout.bind(window);
    let refreshTimer: (() => void) | undefined;
    vi.spyOn(window, "setTimeout").mockImplementation(((handler: TimerHandler, timeout?: number) => {
      if (timeout === 30000 && typeof handler === "function") {
        refreshTimer = () => handler();
        return 1;
      }

      return originalSetTimeout(handler, timeout);
    }) as typeof window.setTimeout);

    render(<StatusPanelView initialRows={[followUpRow]} sourceHealth={fakeSourceHealth} />);

    await waitFor(() => {
      expect(listRequestCount).toBe(1);
    });
    expect(refreshTimer).toBeUndefined();

    await act(async () => {
      resolveOlderRefresh?.([followUpRow]);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.getByTestId("status-row-refresh-ordering-session").className).toContain("status-row--needed");
      expect(refreshTimer).toBeTruthy();
    });

    await act(async () => {
      refreshTimer?.();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(listRequestCount).toBe(2);
    });

    await act(async () => {
      resolveNewerRefresh?.([runningRow]);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.getByTestId("status-row-refresh-ordering-session").className).toContain("status-row--working");
    });
  });

  it("does not revive a completed polling loop after unmounting a pending refresh", async () => {
    let resolveInitialRefresh: ((rows: SessionRow[]) => void) | undefined;
    const initialRefresh = new Promise<SessionRow[]>((resolve) => {
      resolveInitialRefresh = resolve;
    });
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
    tauriCoreMock.invoke.mockImplementation((command: string) => {
      if (command === "list_sessions") return initialRefresh;
      return Promise.resolve(null);
    });
    const setTimeoutSpy = vi.spyOn(window, "setTimeout");

    const rendered = render(<StatusPanelView initialRows={initialSessions} sourceHealth={fakeSourceHealth} />);

    await waitFor(() => {
      expect(tauriCoreMock.invoke).toHaveBeenCalledWith("list_sessions", { followUpToIdleMinutes: 30 });
    });
    rendered.unmount();

    await act(async () => {
      resolveInitialRefresh?.(initialSessions);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(setTimeoutSpy).not.toHaveBeenCalledWith(expect.any(Function), 30000);
  });

  it("drops a queued direct refresh when the panel unmounts", async () => {
    const row: SessionRow = {
      ...initialSessions[0],
      sessionId: "unmount-queued-direct-refresh",
      label: "Queued direct refresh task",
      state: "inspect",
      pinned: false,
      statusReason: "completed task ready to inspect; open it to mark read",
    };
    const pinnedRow: SessionRow = { ...row, pinned: true };
    let resolveInitialRefresh: ((rows: SessionRow[]) => void) | undefined;
    const initialRefresh = new Promise<SessionRow[]>((resolve) => {
      resolveInitialRefresh = resolve;
    });
    let listRequestCount = 0;
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
    tauriCoreMock.invoke.mockImplementation((command: string) => {
      if (command === "list_sessions") {
        listRequestCount += 1;
        return initialRefresh;
      }
      if (command === "pin_session") return Promise.resolve([pinnedRow]);
      return Promise.resolve(null);
    });

    const rendered = render(<StatusPanelView initialRows={[row]} sourceHealth={fakeSourceHealth} />);
    await waitFor(() => {
      expect(listRequestCount).toBe(1);
    });
    expandPanel();
    fireEvent.click(await screen.findByTitle("Pin session"));
    expect(await screen.findByTitle("Unpin session")).toBeTruthy();

    rendered.unmount();
    await act(async () => {
      resolveInitialRefresh?.([row]);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(listRequestCount).toBe(1);
  });

  it("marks the source unavailable without clearing a stale running snapshot", async () => {
    const staleRunningRow: SessionRow = {
      ...initialSessions[0],
      sessionId: "clear-stale-running-on-failure",
      label: "Stale running task",
      state: "running",
      statusReason: "running signal observed",
    };
    window.localStorage.setItem("attn.statusPanelConfig", JSON.stringify({ panelMode: "persistent" }));
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
    tauriCoreMock.invoke.mockImplementation(async (command: string) => {
      if (command === "list_sessions") throw new Error("list_sessions unavailable");
      return null;
    });

    render(<StatusPanelView initialRows={[staleRunningRow]} sourceHealth={fakeSourceHealth} />);

    expect(await screen.findByText("list_sessions unavailable")).toBeTruthy();
    expect(screen.getByText("Unable to load Codex source.")).toBeTruthy();
    expect(screen.queryByText("0 alerts")).toBeNull();
    expect(screen.queryByText("1 running")).toBeNull();
    expect(screen.getByTestId("status-row-clear-stale-running-on-failure")).toBeTruthy();
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
    vi.mocked(listen).mockImplementation(async (event, callback) => {
      if (event === "agent-session-inbox://open-management") handler = callback as (event: { payload: string }) => void;
      return () => undefined;
    });

    const rendered = render(<StatusPanelView initialRows={initialSessions} sourceHealth={fakeSourceHealth} />);
    handler?.({ payload: "management" });

    expect(await screen.findByLabelText("Panel display")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Panel display"), { target: { value: "persistent" } });
    fireEvent.change(screen.getByLabelText("Alert display seconds"), { target: { value: "12" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply settings" }));

    await waitFor(() => expect(screen.getByRole("main").className).not.toContain("panel-shell--collapsed"));
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
    vi.mocked(listen).mockImplementation(async (event, callback) => {
      if (event === "agent-session-inbox://open-management") handler = callback as (event: { payload: string }) => void;
      return () => undefined;
    });

    render(<StatusPanelView initialRows={initialSessions} sourceHealth={fakeSourceHealth} />);
    handler?.({ payload: "management" });

    expect(await screen.findByText("Keep open for statuses")).toBeTruthy();
    expect((screen.getByLabelText("inspect") as HTMLInputElement).checked).toBe(false);
    expect(screen.queryByLabelText("follow-up")).toBeNull();

    fireEvent.click(screen.getByLabelText("stopped"));
    fireEvent.click(screen.getByRole("button", { name: "Apply settings" }));

    await waitFor(() => expect(readPersistedConfig().preventAutoCollapseStatuses).toEqual(["stopped"]));
  });

  it("applies the configured follow-up idle duration and refreshes immediately", async () => {
    const { listen } = await import("@tauri-apps/api/event");
    let handler: ((event: { payload: string }) => void) | undefined;
    vi.mocked(listen).mockImplementation(async (event, callback) => {
      if (event === "agent-session-inbox://open-management") handler = callback as (event: { payload: string }) => void;
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
    await waitFor(() => expect(readPersistedConfig().followUpToIdleMinutes).toBe(45));
  });

  it("normalizes persisted follow-up idle duration to the minimum without capping valid values", async () => {
    const { listen } = await import("@tauri-apps/api/event");
    let handler: ((event: { payload: string }) => void) | undefined;
    vi.mocked(listen).mockImplementation(async (event, callback) => {
      if (event === "agent-session-inbox://open-management") handler = callback as (event: { payload: string }) => void;
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
    vi.mocked(listen).mockImplementation(async (event, callback) => {
      if (event === "agent-session-inbox://open-management") handler = callback as (event: { payload: string }) => void;
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
    window.localStorage.setItem("attn.statusPanelConfig", JSON.stringify({ visibleItemCount: 1 }));
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

  it("subscribes all placement listeners before submitting legacy restore", async () => {
    enablePlacementRuntime();
    window.localStorage.setItem("attn.panelPosition", JSON.stringify({ x: -1904, y: 812 }));
    window.localStorage.setItem("attn.panelCorner", "bottom-left");
    const registrations: Array<{ event: string; resolve: (unlisten: () => void) => void }> = [];
    tauriEventMock.listen.mockImplementation((event) => event.includes("placement-")
      ? new Promise((resolve) => registrations.push({ event, resolve }))
      : Promise.resolve(vi.fn()));

    render(<StatusPanelView initialRows={initialSessions} sourceHealth={fakeSourceHealth} />);
    await waitFor(() => expect(registrations).toHaveLength(3));
    expect(tauriCoreMock.invoke.mock.calls.some(([command]) => command === "restore_panel_placement")).toBe(false);
    await act(async () => registrations[0].resolve(vi.fn()));
    expect(tauriCoreMock.invoke.mock.calls.some(([command]) => command === "restore_panel_placement")).toBe(false);
    await act(async () => registrations.slice(1).forEach(({ resolve }) => resolve(vi.fn())));
    await waitFor(() => expect(tauriCoreMock.invoke).toHaveBeenCalledWith("restore_panel_placement", {
      legacy: { position: { x: -1904, y: 812 }, corner: "bottom-left" },
    }));
    expect(tauriCoreMock.invoke.mock.calls.filter(([command]) => command === "restore_panel_placement")).toHaveLength(1);
    expect(tauriWindowMock.setPosition).not.toHaveBeenCalled();
  });

  it("keeps placement unknown after restore and resize acceptance until a confirmed event", async () => {
    const events = await capturePlacementEvents();
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    render(<StatusPanelView initialRows={initialSessions} sourceHealth={fakeSourceHealth} />);
    await openPlacementSettings(events);
    await waitFor(() => expect(tauriCoreMock.invoke).toHaveBeenCalledWith("resize_panel", { height: 420 }));
    expect(screen.getByRole("status", { name: "Panel position" }).textContent).toContain("Unknown");
    expect(setItem.mock.calls.filter(([key]) => key === "attn.panelPosition" || key === "attn.panelCorner")).toHaveLength(0);

    await act(async () => events.confirmed(10, "top-right"));
    expect(screen.getByRole("status", { name: "Panel position" }).textContent).toContain("Unknown");
    await act(async () => events.confirmed(11, "bottom-left"));
    expect(screen.getByRole("status", { name: "Panel position" }).textContent).toContain("Bottom Left");
    await act(async () => events.confirmed(10, "top-right"));
    expect(screen.getByRole("status", { name: "Panel position" }).textContent).toContain("Bottom Left");
    expect(setItem.mock.calls.filter(([key]) => key === "attn.panelPosition" || key === "attn.panelCorner")).toHaveLength(0);
    expect(tauriWindowMock.setSize).not.toHaveBeenCalled();
    expect(tauriWindowMock.onMoved).not.toHaveBeenCalled();
  });

  it("keeps the confirmed placement through a header click and waits for delayed drag confirmation", async () => {
    const events = await capturePlacementEvents();
    render(<StatusPanelView initialRows={initialSessions} sourceHealth={fakeSourceHealth} />);
    await act(async () => events.confirmed(11, "bottom-right"));
    fireEvent.pointerDown(document.querySelector(".panel-header") as Element, { button: 0 });
    fireEvent.pointerUp(document);
    await waitFor(() => expect(tauriCoreMock.invoke).toHaveBeenCalledWith("begin_panel_drag"));
    await openPlacementSettings(events);
    expect(screen.getByRole("status", { name: "Panel position" }).textContent).toContain("Bottom Right");
    await act(async () => events.confirmed(12, null));
    expect(screen.getByRole("status", { name: "Panel position" }).textContent).toContain("Free position");
    expect(tauriWindowMock.startDragging).not.toHaveBeenCalled();
    fireEvent.pointerDown(screen.getByRole("button", { name: "Apply settings" }), { button: 0 });
    expect(tauriCoreMock.invoke.mock.calls.filter(([command]) => command === "begin_panel_drag")).toHaveLength(1);
  });

  it.each([
    [12, "top-right", "Top Right"],
    [11, null, "Free position"],
  ] as const)("ignores a delayed resize rejection after a newer placement confirmation %s %s", async (generation, corner, label) => {
    const events = await capturePlacementEvents();
    let rejectResize: ((reason: unknown) => void) | undefined;
    tauriCoreMock.invoke.mockImplementation(async (command: string, args?: { shortcut?: string | null; height?: number }) => {
      if (command === "list_sessions") return initialSessions;
      if (command.startsWith("configure_")) return { activeShortcut: args?.shortcut ?? null };
      if (command === "resize_panel" && args?.height === 420) {
        return new Promise((_resolve, reject) => { rejectResize = reject; });
      }
      if (command === "resize_panel") return { generation: 11 };
      return undefined;
    });
    render(<StatusPanelView initialRows={initialSessions} sourceHealth={fakeSourceHealth} />);
    await openPlacementSettings(events);
    await waitFor(() => expect(rejectResize).toBeTypeOf("function"));

    await act(async () => events.confirmed(generation, corner));
    expect(screen.getByRole("status", { name: "Panel position" }).textContent).toContain(label);
    await act(async () => rejectResize?.("scale factor unavailable"));
    expect(screen.queryByText(/Panel position could not be confirmed/)).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("status", { name: "Panel position" }).textContent).toContain(label);
  });

  it("keeps native placement confirmed before its resize IPC receipt arrives", async () => {
    const events = await capturePlacementEvents();
    let acceptResize: ((receipt: { generation: number }) => void) | undefined;
    tauriCoreMock.invoke.mockImplementation(async (command: string, args?: { shortcut?: string | null; height?: number }) => {
      if (command === "list_sessions") return initialSessions;
      if (command.startsWith("configure_")) return { activeShortcut: args?.shortcut ?? null };
      if (command === "resize_panel" && args?.height === 420) {
        return new Promise((resolve) => { acceptResize = resolve; });
      }
      if (command === "resize_panel") return { generation: 11 };
      return undefined;
    });
    render(<StatusPanelView initialRows={initialSessions} sourceHealth={fakeSourceHealth} />);
    await openPlacementSettings(events);
    await waitFor(() => expect(acceptResize).toBeTypeOf("function"));

    await act(async () => events.confirmed(12, "bottom-right"));
    expect(screen.getByRole("status", { name: "Panel position" }).textContent).toContain("Bottom Right");
    await act(async () => acceptResize?.({ generation: 12 }));
    expect(screen.getByRole("status", { name: "Panel position" }).textContent).toContain("Bottom Right");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("still reports the current resize rejection when no later placement was confirmed", async () => {
    const events = await capturePlacementEvents();
    let rejectResize: ((reason: unknown) => void) | undefined;
    tauriCoreMock.invoke.mockImplementation(async (command: string, args?: { shortcut?: string | null; height?: number }) => {
      if (command === "list_sessions") return initialSessions;
      if (command.startsWith("configure_")) return { activeShortcut: args?.shortcut ?? null };
      if (command === "resize_panel" && args?.height === 420) {
        return new Promise((_resolve, reject) => { rejectResize = reject; });
      }
      if (command === "resize_panel") return { generation: 11 };
      return undefined;
    });
    render(<StatusPanelView initialRows={initialSessions} sourceHealth={fakeSourceHealth} />);
    await act(async () => events.confirmed(11, "bottom-left"));
    await openPlacementSettings(events);
    await waitFor(() => expect(rejectResize).toBeTypeOf("function"));

    await act(async () => rejectResize?.("scale factor unavailable"));
    expect(screen.getByRole("alert").textContent).toContain("Panel position could not be confirmed");
    expect(screen.getByRole("status", { name: "Panel position" }).textContent).toContain("Bottom Left");
  });

  it("retains confirmed placement when an unconfirmed request or persistence error arrives", async () => {
    const events = await capturePlacementEvents();
    render(<StatusPanelView initialRows={initialSessions} sourceHealth={fakeSourceHealth} />);
    await openPlacementSettings(events);
    await act(async () => events.confirmed(11, "bottom-left"));
    await act(async () => events.emit("placement-persistence-error", { generation: 11, reason: "write failed" }));
    expect(screen.getByRole("status", { name: "Panel position" }).textContent).toContain("Bottom Left");
    expect(screen.getByRole("alert").textContent).toContain("Unable to save panel position");
    await act(async () => events.emit("placement-unconfirmed", { generation: 12, reason: "timeout" }));
    expect(screen.getByText(/Panel position could not be confirmed/)).toBeTruthy();
    expect(screen.getByRole("status", { name: "Panel position" }).textContent).toContain("Bottom Left");
    await act(async () => events.confirmed(12, "top-left"));
    expect(screen.queryByText(/Panel position could not be confirmed/)).toBeNull();
    expect(screen.queryByText(/Unable to save panel position/)).toBeNull();
    await act(async () => events.emit("placement-persistence-error", { generation: 10, reason: "stale write" }));
    expect(screen.queryByText(/Unable to save panel position/)).toBeNull();
  });

  it("consumes hidden placement events without revealing or focusing the panel", async () => {
    const events = await capturePlacementEvents();
    render(<StatusPanelView initialRows={initialSessions} sourceHealth={fakeSourceHealth} />);
    vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      events.confirmed(15, "top-right");
    });
    expect(tauriWindowMock.show).not.toHaveBeenCalled();
    expect(tauriWindowMock.setFocus).not.toHaveBeenCalled();
    await openPlacementSettings(events);
    expect(screen.getByRole("status", { name: "Panel position" }).textContent).toContain("Top Right");
  });

  it("shows a persistence error for the confirmed placement while a newer resize awaits confirmation", async () => {
    const events = await capturePlacementEvents();
    let resizeGeneration = 11;
    tauriCoreMock.invoke.mockImplementation(async (command: string, args?: { shortcut?: string | null }) => {
      if (command === "list_sessions") return initialSessions;
      if (command.startsWith("configure_")) return { activeShortcut: args?.shortcut ?? null };
      if (command === "resize_panel") return { generation: resizeGeneration++ };
      return undefined;
    });
    render(<StatusPanelView initialRows={initialSessions} sourceHealth={fakeSourceHealth} />);
    await waitFor(() => expect(tauriCoreMock.invoke).toHaveBeenCalledWith("resize_panel", { height: 50 }));
    await act(async () => events.confirmed(11, "bottom-left"));
    await openPlacementSettings(events);
    await waitFor(() => expect(tauriCoreMock.invoke).toHaveBeenCalledWith("resize_panel", { height: 420 }));
    await act(async () => events.emit("placement-persistence-error", { generation: 11, reason: "write failed" }));
    expect(screen.getByText(/Unable to save panel position/)).toBeTruthy();
    expect(screen.getByRole("status", { name: "Panel position" }).textContent).toContain("Bottom Left");
  });

  it("releases successful placement listeners when a sibling listener registration fails", async () => {
    enablePlacementRuntime();
    const unlisten = vi.fn();
    tauriEventMock.listen.mockImplementation(async (event) => {
      if (event.endsWith("placement-unconfirmed")) throw new Error("listen failed");
      return event.includes("placement-") ? unlisten : vi.fn<() => void>();
    });
    render(<StatusPanelView initialRows={initialSessions} sourceHealth={fakeSourceHealth} />);
    await waitFor(() => expect(unlisten).toHaveBeenCalledTimes(2));
    expect(tauriCoreMock.invoke.mock.calls.some(([command]) => command === "restore_panel_placement")).toBe(false);
  });

  it.each(["{bad", '{"x":null,"y":812}', '{"x":1.5,"y":812}', '{"x":2147483648,"y":812}'])(
    "ignores malformed legacy placement %s rather than rejecting native restoration", async (saved) => {
      const events = await capturePlacementEvents();
      window.localStorage.setItem("attn.panelPosition", saved);
      window.localStorage.setItem("attn.panelCorner", "not-a-corner");
      render(<StatusPanelView initialRows={initialSessions} sourceHealth={fakeSourceHealth} />);
      await waitFor(() => expect(tauriCoreMock.invoke).toHaveBeenCalledWith("restore_panel_placement", { legacy: null }));
      await openPlacementSettings(events);
      expect(screen.getByRole("status", { name: "Panel position" }).textContent).toContain("Unknown");
      expect(window.localStorage.getItem("attn.panelPosition")).toBe(saved);
    },
  );

  it("keeps browser-preview placement unknown and never dispatches a native move", async () => {
    const { listen } = await import("@tauri-apps/api/event");
    let menu: ((event: { payload: string }) => void) | undefined;
    vi.mocked(listen).mockImplementation(async (event, callback) => {
      if (event.endsWith("open-management")) menu = callback as typeof menu;
      return vi.fn<() => void>();
    });
    window.localStorage.setItem("attn.panelPosition", JSON.stringify({ x: 144, y: 88 }));
    render(<StatusPanelView initialRows={initialSessions} sourceHealth={fakeSourceHealth} />);
    await act(async () => menu?.({ payload: "management" }));
    expect(screen.getByRole("status", { name: "Panel position" }).textContent).toContain("Unknown");
    expect(tauriCoreMock.invoke).not.toHaveBeenCalled();
    expect(tauriWindowMock.setPosition).not.toHaveBeenCalled();
  });

  it("unlistens late placement registrations from StrictMode cleanup without restoring", async () => {
    enablePlacementRuntime();
    const registrations: Array<{ resolve: (unlisten: () => void) => void }> = [];
    tauriEventMock.listen.mockImplementation((event) => event.includes("placement-")
      ? new Promise((resolve) => registrations.push({ resolve }))
      : Promise.resolve(vi.fn()));
    const rendered = render(<StrictMode><StatusPanelView initialRows={initialSessions} sourceHealth={fakeSourceHealth} /></StrictMode>);
    await waitFor(() => expect(registrations).toHaveLength(6));
    rendered.unmount();
    const unlisten = vi.fn();
    await act(async () => registrations.forEach(({ resolve }) => resolve(unlisten)));
    expect(unlisten).toHaveBeenCalledTimes(6);
    expect(tauriCoreMock.invoke.mock.calls.some(([command]) => command === "restore_panel_placement")).toBe(false);
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
    vi.mocked(listen).mockImplementation(async (event, callback) => {
      if (event === "agent-session-inbox://open-management") handler = callback as (event: { payload: string }) => void;
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

  it("records a shortcut settings combination and stops recording", async () => {
    const { listen } = await import("@tauri-apps/api/event");
    let openManagement: ((event: { payload: string }) => void) | undefined;
    vi.mocked(listen).mockImplementation(async (event, callback) => {
      if (event === "agent-session-inbox://open-management") {
        openManagement = callback as (event: { payload: string }) => void;
      }
      return () => undefined;
    });

    render(<StatusPanelView initialRows={initialSessions} sourceHealth={fakeSourceHealth} />);
    await act(async () => openManagement?.({ payload: "management" }));

    fireEvent.click(screen.getByRole("button", { name: "Record shortcut" }));
    expect(screen.getByRole("status", { name: "Panel shortcut" }).textContent).toBe("Press a key combination");
    fireEvent.keyDown(window, { code: "Digit9", key: "9", ctrlKey: true, metaKey: true });

    expect((screen.getByRole("textbox", { name: "Panel shortcut" }) as HTMLInputElement).value)
      .toBe("Control-Command-9");
    expect(screen.queryByText("Press a key combination")).toBeNull();
  });

  it("keeps recording through ignored keys and cancels without changing the shortcut", async () => {
    await renderShortcutSettings();
    const value = screen.getByRole("textbox", { name: "Panel shortcut" }) as HTMLInputElement;
    const previousValue = value.value;
    fireEvent.click(screen.getByRole("button", { name: "Record shortcut" }));

    const ignoredModifier = new KeyboardEvent("keydown", { code: "ShiftLeft", key: "Shift", shiftKey: true, cancelable: true });
    window.dispatchEvent(ignoredModifier);
    expect(ignoredModifier.defaultPrevented).toBe(true);
    fireEvent.keyDown(window, { code: "KeyA", key: "A", shiftKey: true });
    fireEvent.keyDown(window, { code: "KeyP", key: "p", metaKey: true, repeat: true });
    const editableKey = new KeyboardEvent("keydown", { code: "KeyP", key: "p", metaKey: true, cancelable: true, bubbles: true });
    screen.getByLabelText("Language").dispatchEvent(editableKey);
    expect(editableKey.defaultPrevented).toBe(false);
    expect(screen.getByText("Press a key combination")).toBeTruthy();
    expect(value.value).toBe(previousValue);

    fireEvent.keyDown(window, { code: "Escape", key: "Escape" });
    expect(value.value).toBe(previousValue);
    expect(screen.queryByText("Press a key combination")).toBeNull();
  });

  it("clears and restores the shortcut settings through Apply", async () => {
    const openSettings = await renderShortcutSettings();
    fireEvent.click(screen.getByRole("button", { name: "Clear shortcut" }));
    expect((screen.getByRole("textbox", { name: "Panel shortcut" }) as HTMLInputElement).value).toBe("Disabled");
    fireEvent.click(screen.getByRole("button", { name: "Apply settings" }));
    await waitFor(() => expect(readPersistedConfig().panelToggleShortcut).toBeNull());

    await openSettings();
    fireEvent.click(screen.getByRole("button", { name: "Restore default" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply settings" }));
    await waitFor(() => expect(readPersistedConfig().panelToggleShortcut).toBe("control+super+9"));
  });

  it("records and clears the position-cycle shortcut without changing the panel toggle shortcut", async () => {
    const openSettings = await renderShortcutSettings();
    expect((screen.getByRole("textbox", { name: "Cycle panel position" }) as HTMLInputElement).value)
      .toBe("Control-Command-P");

    fireEvent.click(screen.getByRole("button", { name: "Record position shortcut" }));
    fireEvent.keyDown(window, { code: "KeyP", key: "p", altKey: true, metaKey: true });
    fireEvent.click(screen.getByRole("button", { name: "Apply settings" }));
    await waitFor(() => expect(readPersistedConfig().positionCycleShortcut).toBe("alt+super+p"));
    expect(readPersistedConfig().panelToggleShortcut).toBe("control+super+9");

    await openSettings();
    fireEvent.click(screen.getByRole("button", { name: "Clear position shortcut" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply settings" }));
    await waitFor(() => expect(readPersistedConfig().positionCycleShortcut).toBeNull());
    await openSettings();
    fireEvent.click(screen.getByRole("button", { name: "Restore position default" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply settings" }));
    await waitFor(() => expect(readPersistedConfig().positionCycleShortcut).toBe("control+super+p"));
  });

  it.each([
    [undefined, "control+super+p"],
    [null, null],
    ["shift+p", "control+super+p"],
    ["CONTROL+SUPER+SHIFT+SPACE", "shift+control+super+space"],
  ])("normalizes a legacy position shortcut %s before saving other settings", async (saved, expected) => {
    window.localStorage.setItem("attn.statusPanelConfig", JSON.stringify({ positionCycleShortcut: saved }));
    await renderShortcutSettings();
    fireEvent.change(screen.getByLabelText("Language"), { target: { value: "zh" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply settings" }));
    await waitFor(() => expect(readPersistedConfig().language).toBe("zh"));
    expect(readPersistedConfig().positionCycleShortcut).toBe(expected);
  });

  it("reconciles the saved toggle before the position shortcut default and exposes its conflict", async () => {
    const savedToggle = "control+super+p";
    window.localStorage.setItem("attn.statusPanelConfig", JSON.stringify({ panelToggleShortcut: savedToggle }));
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
    let resolveToggle: (() => void) | undefined;
    const toggleRegistration = new Promise<void>((resolve) => { resolveToggle = resolve; });
    let activeToggle = "control+super+9";
    tauriCoreMock.invoke.mockImplementation(async (command: string, args?: { shortcut?: string | null }) => {
      if (command === "configure_panel_shortcut") {
        await toggleRegistration;
        activeToggle = args?.shortcut ?? "";
        return { activeShortcut: activeToggle };
      }
      if (command === "configure_position_shortcut") {
        if (args?.shortcut === activeToggle) throw {
          code: "registration_failed", activeShortcut: null, stateUncertain: false,
        };
        return { activeShortcut: args?.shortcut ?? null };
      }
      if (command === "list_sessions") return initialSessions;
      return undefined;
    });
    await renderShortcutSettings();
    expect(tauriCoreMock.invoke.mock.calls.filter(([command]) =>
      command === "configure_panel_shortcut" || command === "configure_position_shortcut"))
      .toEqual([["configure_panel_shortcut", { shortcut: savedToggle }]]);
    await act(async () => resolveToggle?.());
    await waitFor(() => expect(screen.getByRole("alert").textContent)
      .toBe("That shortcut could not be registered."));
    expect(tauriCoreMock.invoke.mock.calls.filter(([command]) =>
      command === "configure_panel_shortcut" || command === "configure_position_shortcut"))
      .toEqual([
        ["configure_panel_shortcut", { shortcut: savedToggle }],
        ["configure_position_shortcut", { shortcut: savedToggle }],
      ]);
    expect((screen.getByRole("textbox", { name: "Panel shortcut" }) as HTMLInputElement).value)
      .toBe("Control-Command-P");
    expect(screen.getByText("Currently active: Disabled")).toBeTruthy();
    expect(readPersistedConfig().panelToggleShortcut).toBe(savedToggle);
  });

  it("keeps the active panel shortcut when the new position shortcut conflicts with it", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
    tauriCoreMock.invoke.mockImplementation(async (command: string, args?: { shortcut?: string | null }) => {
      if (command === "configure_position_shortcut" && args?.shortcut === "control+super+9") {
        throw {
          code: "registration_failed",
          activeShortcut: "control+super+p",
          stateUncertain: false,
        };
      }
      if (command === "configure_panel_shortcut" || command === "configure_position_shortcut") {
        return { activeShortcut: args?.shortcut ?? null };
      }
      if (command === "list_sessions") return initialSessions;
      return undefined;
    });
    await renderShortcutSettings();

    fireEvent.click(screen.getByRole("button", { name: "Record position shortcut" }));
    fireEvent.keyDown(window, { code: "Digit9", key: "9", ctrlKey: true, metaKey: true });
    fireEvent.click(screen.getByRole("button", { name: "Apply settings" }));

    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("That shortcut could not be registered."));
    expect(readPersistedConfig().positionCycleShortcut).toBe("control+super+p");
    expect(readPersistedConfig().panelToggleShortcut).toBe("control+super+9");
    expect((screen.getByRole("textbox", { name: "Cycle panel position" }) as HTMLInputElement).value)
      .toBe("Control-Command-9");
  });

  it("commits a successful panel shortcut update when a position shortcut update fails", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
    window.localStorage.setItem("attn.statusPanelConfig", JSON.stringify({ visibleItemCount: 1 }));
    tauriCoreMock.invoke.mockImplementation(async (command: string, args?: { shortcut?: string | null }) => {
      if (command === "configure_position_shortcut" && args?.shortcut === "alt+super+p") {
        throw {
          code: "registration_failed",
          activeShortcut: "control+super+p",
          stateUncertain: false,
        };
      }
      if (command === "configure_panel_shortcut" || command === "configure_position_shortcut") {
        return { activeShortcut: args?.shortcut ?? null };
      }
      if (command === "list_sessions") return initialSessions;
      return undefined;
    });
    await renderShortcutSettings();

    fireEvent.click(screen.getByRole("button", { name: "Record shortcut" }));
    fireEvent.keyDown(window, { code: "KeyQ", key: "q", altKey: true, metaKey: true });
    fireEvent.click(screen.getByRole("button", { name: "Record position shortcut" }));
    fireEvent.keyDown(window, { code: "KeyP", key: "p", altKey: true, metaKey: true });
    fireEvent.click(screen.getByRole("button", { name: "Apply settings" }));

    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("That shortcut could not be registered."));
    expect(readPersistedConfig()).toMatchObject({
      panelToggleShortcut: "alt+super+q",
      positionCycleShortcut: "control+super+p",
    });
    expect((screen.getByRole("textbox", { name: "Cycle panel position" }) as HTMLInputElement).value)
      .toBe("Option-Command-P");
    expect((screen.getByRole("textbox", { name: "Panel shortcut" }) as HTMLInputElement).value)
      .toBe("Option-Command-Q");
  });

  it("keeps a shortcut conflict draft while persisting other settings, then retries", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
    let conflict = true;
    tauriCoreMock.invoke.mockImplementation(async (command: string, args?: { shortcut?: string | null }) => {
      if (command === "configure_panel_shortcut") {
        if (args?.shortcut === "alt+super+p" && conflict) throw {
          code: "registration_failed",
          activeShortcut: "control+super+9",
          stateUncertain: false,
        };
        return { activeShortcut: args?.shortcut ?? null };
      }
      if (command === "list_sessions") return initialSessions;
      return null;
    });
    const openSettings = await renderShortcutSettings();

    fireEvent.click(screen.getByRole("button", { name: "Record shortcut" }));
    fireEvent.keyDown(window, { code: "KeyP", key: "p", altKey: true, metaKey: true });
    fireEvent.change(screen.getByLabelText("Language"), { target: { value: "zh" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply settings" }));

    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("无法注册该快捷键。"));
    expect((screen.getByRole("textbox", { name: "面板快捷键" }) as HTMLInputElement).value).toBe("Option-Command-P");
    expect(screen.getByRole("status", { name: /Panel shortcut|面板快捷键/ }).textContent).toBe("当前生效: Control-Command-9");
    expect(readPersistedConfig()).toMatchObject({ language: "zh", panelToggleShortcut: "control+super+9" });
    expect(screen.getByRole("main").className).toContain("management-shell");

    conflict = false;
    fireEvent.click(screen.getByRole("button", { name: "应用设置" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(readPersistedConfig()).toMatchObject({ language: "zh", panelToggleShortcut: "alt+super+p" });
    expect(screen.getByRole("main").className).not.toContain("management-shell");
    await openSettings();
    expect(screen.queryByText(/当前生效:/)).toBeNull();
  });

  it.each([
    ["missing shortcut", undefined, "Control-Command-9", "control+super+9"],
    ["malformed shortcut", "not-a-shortcut", "Control-Command-9", "control+super+9"],
    ["saved four-key shortcut", "shift+alt+super+space", "Option-Shift-Command-Space", "shift+alt+super+space"],
    ["disabled shortcut", null, "Disabled", null],
  ])("reconciles a %s on startup", async (_caseName, savedShortcut, display, activeShortcut) => {
    if (savedShortcut !== undefined) {
      window.localStorage.setItem("attn.statusPanelConfig", JSON.stringify({ panelToggleShortcut: savedShortcut }));
    }
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
    tauriCoreMock.invoke.mockImplementation(async (command: string, args?: { shortcut?: string | null }) => {
      if (command === "configure_panel_shortcut") return { activeShortcut: args?.shortcut ?? null };
      if (command === "list_sessions") return initialSessions;
      return null;
    });

    await renderShortcutSettings();

    expect((screen.getByRole("textbox", { name: "Panel shortcut" }) as HTMLInputElement).value).toBe(display);
    expect(tauriCoreMock.invoke).toHaveBeenCalledWith("configure_panel_shortcut", { shortcut: activeShortcut });
    expect(readPersistedConfig().panelToggleShortcut).toBe(activeShortcut);
  });

  it.each([
    ["control+super+9", "Control-Command-9"],
    [null, "Disabled"],
  ])("keeps a saved custom shortcut after startup conflict with %s active", async (activeShortcut, activeLabel) => {
    window.localStorage.setItem("attn.statusPanelConfig", JSON.stringify({ panelToggleShortcut: "alt+super+p" }));
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
    tauriCoreMock.invoke.mockImplementation(async (command: string) => {
      if (command === "configure_panel_shortcut") throw {
        code: "registration_failed",
        activeShortcut,
        stateUncertain: false,
      };
      if (command === "list_sessions") return initialSessions;
      return null;
    });
    const openSettings = await renderShortcutSettings();

    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("That shortcut could not be registered."));
    expect((screen.getByRole("textbox", { name: "Panel shortcut" }) as HTMLInputElement).value).toBe("Option-Command-P");
    expect(screen.getByRole("status", { name: /Panel shortcut|面板快捷键/ }).textContent).toBe(`Currently active: ${activeLabel}`);
    expect(readPersistedConfig().panelToggleShortcut).toBe("alt+super+p");
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    await openSettings();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("status", { name: /Panel shortcut|面板快捷键/ }).textContent).toBe(`Currently active: ${activeLabel}`);
  });

  it("keeps restart-required status after an uncertain native failure is dismissed", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
    tauriCoreMock.invoke.mockImplementation(async (command: string) => {
      if (command === "configure_panel_shortcut") throw {
        code: "registration_uncertain",
        activeShortcut: null,
        stateUncertain: true,
      };
      if (command === "list_sessions") return initialSessions;
      return null;
    });
    const openSettings = await renderShortcutSettings();

    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.getByRole("status", { name: /Panel shortcut|面板快捷键/ }).textContent).toBe("Shortcut state is uncertain. Restart Attn to restore shortcut settings.");
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    await openSettings();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("status", { name: /Panel shortcut|面板快捷键/ }).textContent).toBe("Shortcut state is uncertain. Restart Attn to restore shortcut settings.");
  });

  it("continues shortcut settings Apply after a startup conflict without a stale alert", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
    let rejectStartup: ((reason: string) => void) | undefined;
    const startup = new Promise<never>((_resolve, reject) => { rejectStartup = reject; });
    let shortcutCalls = 0;
    tauriCoreMock.invoke.mockImplementation((command: string, args?: { shortcut?: string | null }) => {
      if (command === "configure_panel_shortcut") {
        shortcutCalls += 1;
        return shortcutCalls === 1 ? startup : Promise.resolve({ activeShortcut: args?.shortcut ?? null });
      }
      if (command === "list_sessions") return Promise.resolve(initialSessions);
      return Promise.resolve(null);
    });
    const openSettings = await renderShortcutSettings();
    fireEvent.click(screen.getByRole("button", { name: "Clear shortcut" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply settings" }));
    expect(readPersistedConfig().panelToggleShortcut).toBe("control+super+9");

    await act(async () => rejectStartup?.("registration_failed"));
    await waitFor(() => expect(readPersistedConfig().panelToggleShortcut).toBeNull());
    await openSettings();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("serializes startup reconciliation before shortcut settings Apply", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
    let resolveStartup: ((value: { activeShortcut: string | null }) => void) | undefined;
    const startup = new Promise<{ activeShortcut: string | null }>((resolve) => { resolveStartup = resolve; });
    tauriCoreMock.invoke.mockImplementation((command: string, args?: { shortcut?: string | null }) => {
      if (command === "configure_panel_shortcut") {
        return args?.shortcut === "control+super+9"
          ? startup
          : Promise.resolve({ activeShortcut: args?.shortcut ?? null });
      }
      if (command === "list_sessions") return Promise.resolve(initialSessions);
      return Promise.resolve(null);
    });
    await renderShortcutSettings();
    fireEvent.click(screen.getByRole("button", { name: "Clear shortcut" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply settings" }));

    expect(tauriCoreMock.invoke.mock.calls.filter(([command]) => command === "configure_panel_shortcut"))
      .toEqual([["configure_panel_shortcut", { shortcut: "control+super+9" }]]);
    expect((screen.getByRole("button", { name: "Back" }) as HTMLButtonElement).disabled).toBe(true);
    expect(readPersistedConfig().panelToggleShortcut).toBe("control+super+9");

    await act(async () => resolveStartup?.({ activeShortcut: "control+super+9" }));
    await waitFor(() => {
      expect(tauriCoreMock.invoke.mock.calls.filter(([command]) => command === "configure_panel_shortcut"))
        .toEqual([
          ["configure_panel_shortcut", { shortcut: "control+super+9" }],
          ["configure_panel_shortcut", { shortcut: null }],
        ]);
      expect(readPersistedConfig().panelToggleShortcut).toBeNull();
    });
  });

  it("does not revive a startup conflict after Back dismisses shortcut settings", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
    let rejectStartup: ((reason: string) => void) | undefined;
    const startup = new Promise<never>((_resolve, reject) => { rejectStartup = reject; });
    tauriCoreMock.invoke.mockImplementation((command: string) => {
      if (command === "configure_panel_shortcut") return startup;
      if (command === "list_sessions") return Promise.resolve(initialSessions);
      return Promise.resolve(null);
    });
    const openSettings = await renderShortcutSettings();

    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    await act(async () => rejectStartup?.("registration_failed"));
    await openSettings();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("does not revive a startup shortcut conflict after the document becomes hidden", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
    let rejectStartup: ((reason: string) => void) | undefined;
    const startup = new Promise<never>((_resolve, reject) => { rejectStartup = reject; });
    tauriCoreMock.invoke.mockImplementation((command: string) => {
      if (command === "configure_panel_shortcut") return startup;
      if (command === "list_sessions") return Promise.resolve(initialSessions);
      return Promise.resolve(null);
    });
    const openSettings = await renderShortcutSettings();

    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    fireEvent(document, new Event("visibilitychange"));
    await act(async () => rejectStartup?.("registration_failed"));
    await openSettings();

    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("stops shortcut recording when the document becomes hidden", async () => {
    const openSettings = await renderShortcutSettings();
    fireEvent.click(screen.getByRole("button", { name: "Record shortcut" }));
    expect(screen.getByRole("status", { name: "Panel shortcut" })).toBeTruthy();

    vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    fireEvent(document, new Event("visibilitychange"));
    await openSettings();
    fireEvent.keyDown(window, { code: "KeyP", key: "p", altKey: true, metaKey: true });

    expect(screen.queryByRole("status", { name: "Panel shortcut" })).toBeNull();
    expect((screen.getByRole("textbox", { name: "Panel shortcut" }) as HTMLInputElement).value)
      .toBe("Control-Command-9");
  });

  it("discards a pending failed shortcut draft after document visibility dismissal", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
    let rejectUpdate: ((reason: unknown) => void) | undefined;
    const update = new Promise<never>((_resolve, reject) => { rejectUpdate = reject; });
    tauriCoreMock.invoke.mockImplementation((command: string, args?: { shortcut?: string | null }) => {
      if (command === "configure_panel_shortcut") {
        return args?.shortcut === "alt+super+p" ? update : Promise.resolve({ activeShortcut: args?.shortcut ?? null });
      }
      if (command === "list_sessions") return Promise.resolve(initialSessions);
      return Promise.resolve(null);
    });
    const openSettings = await renderShortcutSettings();
    fireEvent.click(screen.getByRole("button", { name: "Record shortcut" }));
    fireEvent.keyDown(window, { code: "KeyP", key: "p", altKey: true, metaKey: true });
    fireEvent.change(screen.getByLabelText("Language"), { target: { value: "zh" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply settings" }));

    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    fireEvent(document, new Event("visibilitychange"));
    expect(screen.getByRole("main").className).not.toContain("management-shell");
    await act(async () => rejectUpdate?.({
      code: "registration_failed",
      activeShortcut: "control+super+9",
      stateUncertain: false,
    }));
    await waitFor(() => expect(readPersistedConfig()).toMatchObject({
      language: "zh",
      panelToggleShortcut: "control+super+9",
    }));
    await openSettings();

    expect(screen.queryByRole("alert")).toBeNull();
    expect((screen.getByRole("textbox", { name: "面板快捷键" }) as HTMLInputElement).value)
      .toBe("Control-Command-9");
  });

  it("keeps reopened shortcut settings visible after a hidden document's pending Apply succeeds", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
    let resolveUpdate: ((value: { activeShortcut: string | null }) => void) | undefined;
    const update = new Promise<{ activeShortcut: string | null }>((resolve) => { resolveUpdate = resolve; });
    tauriCoreMock.invoke.mockImplementation((command: string, args?: { shortcut?: string | null }) => {
      if (command === "configure_panel_shortcut") {
        return args?.shortcut === null ? update : Promise.resolve({ activeShortcut: args?.shortcut ?? null });
      }
      if (command === "list_sessions") return Promise.resolve(initialSessions);
      return Promise.resolve(null);
    });
    const openSettings = await renderShortcutSettings();
    fireEvent.click(screen.getByRole("button", { name: "Clear shortcut" }));
    fireEvent.change(screen.getByLabelText("Language"), { target: { value: "zh" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply settings" }));
    await waitFor(() => expect(tauriCoreMock.invoke).toHaveBeenCalledWith("configure_panel_shortcut", { shortcut: null }));

    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    fireEvent(document, new Event("visibilitychange"));
    hidden.mockReturnValue(false);
    await openSettings();
    expect((screen.getByRole("button", { name: "Apply settings" }) as HTMLButtonElement).disabled).toBe(true);

    await act(async () => resolveUpdate?.({ activeShortcut: null }));
    await waitFor(() => expect(readPersistedConfig()).toMatchObject({ language: "zh", panelToggleShortcut: null }));
    expect(screen.getByRole("main").className).toContain("management-shell");
    expect((screen.getByRole("button", { name: "应用设置" }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("textbox", { name: "面板快捷键" }) as HTMLInputElement).value).toBe("已禁用");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("removes document visibility handling on unmount", async () => {
    const addListener = vi.spyOn(document, "addEventListener");
    const removeListener = vi.spyOn(document, "removeEventListener");
    const rendered = render(<StatusPanelView initialRows={initialSessions} sourceHealth={fakeSourceHealth} />);
    const visibilityHandler = addListener.mock.calls.find(([type]) => type === "visibilitychange")?.[1];

    expect(visibilityHandler).toBeTruthy();
    rendered.unmount();
    expect(removeListener).toHaveBeenCalledWith("visibilitychange", visibilityHandler);
  });

  it("keeps a dismissed shortcut settings failure quiet while retaining the requested draft", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
    let rejectUpdate: ((reason: unknown) => void) | undefined;
    const update = new Promise<never>((_resolve, reject) => { rejectUpdate = reject; });
    tauriCoreMock.invoke.mockImplementation((command: string, args?: { shortcut?: string | null }) => {
      if (command === "configure_panel_shortcut") {
        return args?.shortcut === "alt+super+p" ? update : Promise.resolve({ activeShortcut: args?.shortcut ?? null });
      }
      if (command === "list_sessions") return Promise.resolve(initialSessions);
      return Promise.resolve(null);
    });
    const { listen } = await import("@tauri-apps/api/event");
    let openManagement: ((event: { payload: string }) => void) | undefined;
    let togglePanel: ((event: { payload: boolean }) => void) | undefined;
    vi.mocked(listen).mockImplementation(async (event, callback) => {
      if (event === "agent-session-inbox://open-management") openManagement = callback as typeof openManagement;
      if (event === "agent-session-inbox://toggle-panel") togglePanel = callback as typeof togglePanel;
      return () => undefined;
    });
    render(<StatusPanelView initialRows={initialSessions} sourceHealth={fakeSourceHealth} />);
    await act(async () => openManagement?.({ payload: "management" }));
    fireEvent.click(screen.getByRole("button", { name: "Record shortcut" }));
    fireEvent.keyDown(window, { code: "KeyP", key: "p", altKey: true, metaKey: true });
    fireEvent.change(screen.getByLabelText("Language"), { target: { value: "zh" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply settings" }));

    await act(async () => togglePanel?.({ payload: true }));
    expect(screen.getByRole("main").className).not.toContain("management-shell");
    await act(async () => rejectUpdate?.({
      code: "registration_failed",
      activeShortcut: "control+super+9",
      stateUncertain: false,
    }));
    await waitFor(() => expect(readPersistedConfig()).toMatchObject({
      language: "zh",
      panelToggleShortcut: "control+super+9",
    }));

    await act(async () => openManagement?.({ payload: "management" }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect((screen.getByRole("textbox", { name: "面板快捷键" }) as HTMLInputElement).value).toBe("Option-Command-P");
    expect(screen.getByRole("status", { name: /Panel shortcut|面板快捷键/ }).textContent).toBe("当前生效: Control-Command-9");
  });

  it("normalizes failed shortcut settings drafts and refreshes with the committed follow-up threshold", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
    tauriCoreMock.invoke.mockImplementation(async (command: string, args?: { shortcut?: string | null }) => {
      if (command === "configure_panel_shortcut") {
        if (args?.shortcut === "alt+super+p") throw "invalid_shortcut";
        return { activeShortcut: args?.shortcut ?? null };
      }
      if (command === "list_sessions") return initialSessions;
      return null;
    });
    await renderShortcutSettings();
    fireEvent.change(screen.getByLabelText("Visible items"), { target: { value: "9" } });
    fireEvent.change(screen.getByLabelText("Follow-up to idle minutes"), { target: { value: "12" } });
    fireEvent.click(screen.getByRole("button", { name: "Record shortcut" }));
    fireEvent.keyDown(window, { code: "KeyP", key: "p", altKey: true, metaKey: true });
    fireEvent.click(screen.getByRole("button", { name: "Apply settings" }));

    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("That shortcut could not be registered."));
    expect(readPersistedConfig()).toMatchObject({
      visibleItemCount: 8,
      followUpToIdleMinutes: 20,
      panelToggleShortcut: "control+super+9",
    });
    expect((screen.getByLabelText("Visible items") as HTMLInputElement).value).toBe("8");
    expect((screen.getByLabelText("Follow-up to idle minutes") as HTMLInputElement).value).toBe("20");
    expect((screen.getByRole("textbox", { name: "Panel shortcut" }) as HTMLInputElement).value).toBe("Option-Command-P");
    await waitFor(() => expect(lastInvokeCall("list_sessions")).toEqual([
      "list_sessions", { followUpToIdleMinutes: 20 },
    ]));
  });

  it("does not enqueue two shortcut settings updates from rapid Apply clicks", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
    let resolveUpdate: ((value: { activeShortcut: string | null }) => void) | undefined;
    const update = new Promise<{ activeShortcut: string | null }>((resolve) => { resolveUpdate = resolve; });
    tauriCoreMock.invoke.mockImplementation((command: string, args?: { shortcut?: string | null }) => {
      if (command === "configure_panel_shortcut") {
        return args?.shortcut === null ? update : Promise.resolve({ activeShortcut: args?.shortcut ?? null });
      }
      if (command === "list_sessions") return Promise.resolve(initialSessions);
      return Promise.resolve(null);
    });
    await renderShortcutSettings();
    fireEvent.click(screen.getByRole("button", { name: "Clear shortcut" }));
    const applyButton = screen.getByRole("button", { name: "Apply settings" });

    act(() => {
      applyButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      applyButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await waitFor(() => expect(tauriCoreMock.invoke.mock.calls.filter(([command]) => command === "configure_panel_shortcut"))
      .toHaveLength(2));
    expect((applyButton as HTMLButtonElement).disabled).toBe(true);
    await act(async () => resolveUpdate?.({ activeShortcut: null }));
    expect(tauriCoreMock.invoke.mock.calls.filter(([command]) => command === "configure_panel_shortcut"))
      .toHaveLength(2);
  });

  it("drops a queued shortcut settings Apply after unmount", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
    let resolveStartup: ((value: { activeShortcut: string | null }) => void) | undefined;
    const startup = new Promise<{ activeShortcut: string | null }>((resolve) => { resolveStartup = resolve; });
    tauriCoreMock.invoke.mockImplementation((command: string, args?: { shortcut?: string | null }) => {
      if (command === "configure_panel_shortcut") {
        return args?.shortcut === "control+super+9"
          ? startup
          : Promise.resolve({ activeShortcut: args?.shortcut ?? null });
      }
      if (command === "list_sessions") return Promise.resolve(initialSessions);
      return Promise.resolve(null);
    });
    await renderShortcutSettings();
    fireEvent.click(screen.getByRole("button", { name: "Clear shortcut" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply settings" }));
    cleanup();

    await act(async () => resolveStartup?.({ activeShortcut: "control+super+9" }));
    expect(tauriCoreMock.invoke.mock.calls.filter(([command]) => command === "configure_panel_shortcut"))
      .toHaveLength(1);
    expect(readPersistedConfig().panelToggleShortcut).toBe("control+super+9");
  });

  it("keeps reopened shortcut settings visible after hidden-window dismissal and successful Apply", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
    let resolveUpdate: ((value: { activeShortcut: string | null }) => void) | undefined;
    const update = new Promise<{ activeShortcut: string | null }>((resolve) => { resolveUpdate = resolve; });
    tauriCoreMock.invoke.mockImplementation((command: string, args?: { shortcut?: string | null }) => {
      if (command === "configure_panel_shortcut") {
        return args?.shortcut === null ? update : Promise.resolve({ activeShortcut: args?.shortcut ?? null });
      }
      if (command === "list_sessions") return Promise.resolve(initialSessions);
      return Promise.resolve(null);
    });
    const { listen } = await import("@tauri-apps/api/event");
    let openManagement: ((event: { payload: string }) => void) | undefined;
    let togglePanel: ((event: { payload: boolean }) => void) | undefined;
    vi.mocked(listen).mockImplementation(async (event, callback) => {
      if (event === "agent-session-inbox://open-management") openManagement = callback as typeof openManagement;
      if (event === "agent-session-inbox://toggle-panel") togglePanel = callback as typeof togglePanel;
      return () => undefined;
    });
    render(<StatusPanelView initialRows={initialSessions} sourceHealth={fakeSourceHealth} />);
    await act(async () => openManagement?.({ payload: "management" }));
    fireEvent.click(screen.getByRole("button", { name: "Clear shortcut" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply settings" }));

    await act(async () => togglePanel?.({ payload: true }));
    await act(async () => openManagement?.({ payload: "management" }));
    expect((screen.getByRole("button", { name: "Apply settings" }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => resolveUpdate?.({ activeShortcut: null }));
    await waitFor(() => expect(readPersistedConfig().panelToggleShortcut).toBeNull());
    expect(screen.getByRole("main").className).toContain("management-shell");
    expect((screen.getByRole("button", { name: "Apply settings" }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("textbox", { name: "Panel shortcut" }) as HTMLInputElement).value).toBe("Disabled");
  });

  it("disables shortcut actions while a native update is pending", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
    let resolveUpdate: ((value: { activeShortcut: string | null }) => void) | undefined;
    const update = new Promise<{ activeShortcut: string | null }>((resolve) => { resolveUpdate = resolve; });
    tauriCoreMock.invoke.mockImplementation((command: string, args?: { shortcut?: string | null }) => {
      if (command === "configure_panel_shortcut") {
        return args?.shortcut === null ? update : Promise.resolve({ activeShortcut: args?.shortcut ?? null });
      }
      if (command === "list_sessions") return Promise.resolve(initialSessions);
      return Promise.resolve(null);
    });
    await renderShortcutSettings();
    fireEvent.click(screen.getByRole("button", { name: "Clear shortcut" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply settings" }));

    for (const name of ["Apply settings", "Record shortcut", "Clear shortcut", "Restore default"]) {
      expect((screen.getByRole("button", { name }) as HTMLButtonElement).disabled).toBe(true);
    }
    expect(readPersistedConfig().panelToggleShortcut).toBe("control+super+9");

    await act(async () => resolveUpdate?.({ activeShortcut: null }));
    await waitFor(() => expect(readPersistedConfig().panelToggleShortcut).toBeNull());
  });

  it("freezes all management settings controls while shortcut Apply is pending", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
    let rejectUpdate: ((reason: string) => void) | undefined;
    const update = new Promise<never>((_resolve, reject) => { rejectUpdate = reject; });
    tauriCoreMock.invoke.mockImplementation((command: string, args?: { shortcut?: string | null }) => {
      if (command === "configure_panel_shortcut") {
        return args?.shortcut === null ? update : Promise.resolve({ activeShortcut: args?.shortcut ?? null });
      }
      if (command === "list_sessions") return Promise.resolve(initialSessions);
      return Promise.resolve(null);
    });
    await renderShortcutSettings();
    fireEvent.click(screen.getByRole("button", { name: "Clear shortcut" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply settings" }));

    for (const label of ["Language", "Style family", "Palette", "Visible items", "Panel display", "Alert display seconds", "Follow-up to idle minutes", "blocked", "Blocked color"]) {
      expect(screen.getByLabelText(label).matches(":disabled")).toBe(true);
    }
    expect(screen.getByRole("button", { name: "Install Codex hooks" }).matches(":disabled")).toBe(true);
    const blocked = screen.getByLabelText("blocked") as HTMLInputElement;
    const wasBlockedChecked = blocked.checked;
    blocked.click();
    expect(blocked.checked).toBe(wasBlockedChecked);
    expect((screen.getByLabelText("Language") as HTMLSelectElement).value).toBe("en");
    expect((screen.getByLabelText("Visible items") as HTMLInputElement).value).toBe("3");

    await act(async () => rejectUpdate?.("registration_failed"));
    expect(readPersistedConfig()).toMatchObject({ language: "en", visibleItemCount: 3 });
  });

  it("does not commit a shortcut update after unmount", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
    let resolveUpdate: ((value: { activeShortcut: string | null }) => void) | undefined;
    const update = new Promise<{ activeShortcut: string | null }>((resolve) => { resolveUpdate = resolve; });
    tauriCoreMock.invoke.mockImplementation((command: string, args?: { shortcut?: string | null }) => {
      if (command === "configure_panel_shortcut") {
        return args?.shortcut === null ? update : Promise.resolve({ activeShortcut: args?.shortcut ?? null });
      }
      if (command === "list_sessions") return Promise.resolve(initialSessions);
      return Promise.resolve(null);
    });
    await renderShortcutSettings();
    fireEvent.click(screen.getByRole("button", { name: "Clear shortcut" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply settings" }));
    cleanup();

    await act(async () => resolveUpdate?.({ activeShortcut: null }));
    expect(readPersistedConfig().panelToggleShortcut).toBe("control+super+9");
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

  it("keeps Settings and its draft open while a visible shortcut toggles the underlying panel", async () => {
    const { listen } = await import("@tauri-apps/api/event");
    let menuHandler: ((event: { payload: string }) => void) | undefined;
    let toggleHandler: ((event: { payload: boolean }) => void) | undefined;
    vi.mocked(listen).mockImplementation(async (event, callback) => {
      if (event === "agent-session-inbox://open-management") menuHandler = callback as typeof menuHandler;
      if (event === "agent-session-inbox://toggle-panel") toggleHandler = callback as typeof toggleHandler;
      return () => undefined;
    });

    render(<StatusPanelView initialRows={initialSessions} sourceHealth={fakeSourceHealth} />);
    await act(async () => menuHandler?.({ payload: "management" }));
    fireEvent.click(screen.getByRole("button", { name: "Record shortcut" }));
    fireEvent.keyDown(window, { code: "KeyP", key: "p", altKey: true, metaKey: true });

    await act(async () => toggleHandler?.({ payload: false }));
    expect(screen.getByRole("main").className).toContain("management-shell");
    expect((screen.getByRole("textbox", { name: "Panel shortcut" }) as HTMLInputElement).value).toBe("Option-Command-P");

    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(document.querySelector(".panel-shell--collapsed")).toBeNull();
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
    expect(screen.getAllByRole("article").length).toBeGreaterThan(0);
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
    const registrations: Array<{
      event: string;
      callback: (event: { payload: boolean | string | number }) => void;
      resolve: (unlisten: () => void) => void;
    }> = [];
    const unlistenToggle = vi.fn();
    const unlistenMenu = vi.fn();
    const unlistenSources = vi.fn();
    const unlistenSessionJump = vi.fn();
    vi.mocked(listen).mockImplementation((event, callback) => {
      return new Promise((resolve) => {
        registrations.push({
          event,
          callback: callback as (event: { payload: boolean | string | number }) => void,
          resolve,
        });
      });
    });

    const rendered = render(
      <StrictMode>
        <StatusPanelView initialRows={initialSessions} sourceHealth={fakeSourceHealth} />
      </StrictMode>,
    );

    await waitFor(() => {
      expect(registrations.filter(({ event }) => event === "agent-session-inbox://toggle-panel")).toHaveLength(2);
      expect(registrations.filter(({ event }) => event === "agent-session-inbox://open-management")).toHaveLength(2);
      expect(registrations.filter(({ event }) => event === "agent-session-inbox://sources-changed")).toHaveLength(2);
      expect(registrations.filter(({ event }) => event === "agent-session-inbox://jump-session")).toHaveLength(2);
    });

    const staleToggle = registrations.find(({ event }) => event === "agent-session-inbox://toggle-panel");
    const staleMenu = registrations.find(({ event }) => event === "agent-session-inbox://open-management");
    await act(async () => {
      staleToggle?.callback({ payload: false });
    });
    expect(document.querySelector(".panel-shell--collapsed")).not.toBeNull();

    await act(async () => {
      staleMenu?.callback({ payload: "management" });
    });
    expect(screen.queryByText("management")).toBeNull();

    rendered.unmount();

    await act(async () => {
      registrations.forEach(({ callback, event }) => {
        callback({ payload: event === "agent-session-inbox://toggle-panel" ? false : event === "agent-session-inbox://jump-session" ? 1 : "management" });
      });
      registrations.forEach(({ event, resolve }) => {
        resolve(
          event === "agent-session-inbox://toggle-panel"
            ? unlistenToggle
            : event === "agent-session-inbox://open-management"
              ? unlistenMenu
              : event === "agent-session-inbox://jump-session"
                ? unlistenSessionJump
              : unlistenSources,
        );
      });
      await Promise.resolve();
    });
    expect(unlistenToggle).toHaveBeenCalledTimes(2);
    expect(unlistenMenu).toHaveBeenCalledTimes(2);
    expect(unlistenSources).toHaveBeenCalledTimes(2);
    expect(unlistenSessionJump).toHaveBeenCalledTimes(2);
  });

  it("applies management settings only after confirmation", async () => {
    const { listen } = await import("@tauri-apps/api/event");
    let handler: ((event: { payload: string }) => void) | undefined;
    vi.mocked(listen).mockImplementation(async (event, callback) => {
      if (event === "agent-session-inbox://open-management") handler = callback as (event: { payload: string }) => void;
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

    expect(await screen.findByText("1 需关注")).toBeTruthy();
    expect(screen.getByText("1 进行中")).toBeTruthy();
    expect(screen.queryByText("1 空闲")).toBeNull();
    expandPanel();
    expect(screen.getByText("待介入")).toBeTruthy();
  });

  it("shows Codex hook integration status and installs only after confirmation", async () => {
    const { listen } = await import("@tauri-apps/api/event");
    let handler: ((event: { payload: string }) => void) | undefined;
    vi.mocked(listen).mockImplementation(async (event, callback) => {
      if (event === "agent-session-inbox://open-management") handler = callback as (event: { payload: string }) => void;
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
    vi.mocked(listen).mockImplementation(async (event, callback) => {
      if (event === "agent-session-inbox://open-management") handler = callback as (event: { payload: string }) => void;
      return () => undefined;
    });

    const rendered = render(<StatusPanelView initialRows={initialSessions} sourceHealth={fakeSourceHealth} />);
    handler?.({ payload: "management" });
    fireEvent.change(await screen.findByLabelText("Language"), { target: { value: "zh" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply settings" }));
    await waitFor(() => expect(readPersistedConfig().language).toBe("zh"));
    rendered.unmount();

    render(<StatusPanelView initialRows={initialSessions} sourceHealth={fakeSourceHealth} />);
    expandPanel();

    expect(screen.getByText("1 需关注")).toBeTruthy();
    expect(screen.getByText("待介入")).toBeTruthy();
  });

  it("localizes built-in panel and management copy when Chinese is selected", async () => {
    const { listen } = await import("@tauri-apps/api/event");
    let handler: ((event: { payload: string }) => void) | undefined;
    vi.mocked(listen).mockImplementation(async (event, callback) => {
      if (event === "agent-session-inbox://open-management") handler = callback as (event: { payload: string }) => void;
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
    vi.mocked(listen).mockImplementation(async (event, callback) => {
      if (event === "agent-session-inbox://open-management") handler = callback as (event: { payload: string }) => void;
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
    vi.mocked(listen).mockImplementation(async (event, callback) => {
      if (event === "agent-session-inbox://open-management") handler = callback as (event: { payload: string }) => void;
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
    ["legacy storage without a shortcut", "agent-session-inbox.statusPanelConfig", {}, "control+super+9"],
    ["malformed shortcut", "attn.statusPanelConfig", { panelToggleShortcut: "not-a-shortcut" }, "control+super+9"],
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
    const resize = mockPanelResize();
    const { listen } = await import("@tauri-apps/api/event");
    let handler: ((event: { payload: string }) => void) | undefined;
    vi.mocked(listen).mockImplementation(async (event, callback) => {
      if (event === "agent-session-inbox://open-management") handler = callback as (event: { payload: string }) => void;
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
    expect(screen.getAllByRole("article")).toHaveLength(3);

    handler?.({ payload: "management" });
    fireEvent.change(await screen.findByLabelText("Visible items"), { target: { value: "5" } });
    fireEvent.click(screen.getByText("Back"));
    expect(screen.getAllByRole("article")).toHaveLength(3);

    handler?.({ payload: "management" });
    fireEvent.change(await screen.findByLabelText("Visible items"), { target: { value: "5" } });
    fireEvent.click(await screen.findByRole("button", { name: "Apply settings" }));
    await waitFor(() => expect(readPersistedConfig().visibleItemCount).toBe(5));
    expandPanel();
    await waitFor(() => {
      expect(screen.getAllByRole("article")).toHaveLength(5);
    });
    await waitFor(() => {
      expect(resize).toHaveBeenCalledWith(324);
    });
  });

  it("makes the status list scrollable when configured rows reach the window height cap", async () => {
    const resize = mockPanelResize();
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
      expect(resize).toHaveBeenCalledWith(420);
    });
  });

  it("sizes the transparent window to the actual rendered row count", async () => {
    const resize = mockPanelResize();
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
      expect(resize).toHaveBeenCalledWith(50);
    });
    expandPanel();
    await waitFor(() => {
      expect(resize).toHaveBeenCalledWith(128);
    });
  });

  it("submits the latest multi-row height while earlier resize acceptance is delayed", async () => {
    const resize = mockPanelResize();
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
    let lastRequestedHeight: number | undefined;
    let resizeCallCount = 0;
    resize.mockImplementation((height: number) => {
      resizeCallCount += 1;
      lastRequestedHeight = height;
      if (resizeCallCount === 1) {
        return new Promise<{ generation: number }>((resolve) => {
          resolveInitialNativeResize = () => {
            resolve({ generation: 1 });
          };
        });
      }

      return Promise.resolve({ generation: 2 });
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
      expect(resize).toHaveBeenCalledWith(128);
      expect(resize).toHaveBeenCalledWith(177);
    });

    await act(async () => {
      resolveInitialNativeResize?.();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(lastRequestedHeight).toBe(177);
    });
  });

  it("reserves a footer track so jump feedback cannot add a grid row", () => {
    // @ts-expect-error This test reads local CSS without adding Node types to the app build.
    const css = readFileSync(join(process.cwd(), "src/App.css"), "utf8");
    const panelShellBlock = css.match(/\.panel-shell \{[^}]+\}/)?.[0];

    expect(panelShellBlock).toContain("grid-template-rows: 28px minmax(0, auto) 22px;");
  });

  it("keeps jump feedback inline without a quiet overflow control or resize", async () => {
    const resize = mockPanelResize();
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
      expect(resize).toHaveBeenCalledWith(128);
    });
    resize.mockClear();

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
    expect(resize).not.toHaveBeenCalled();
  });

  it("keeps jump feedback, hidden alerts, and counters in one footer row", async () => {
    const resize = mockPanelResize();
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
    await waitFor(() => expect(resize).toHaveBeenCalledWith(128));
    resize.mockClear();

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
    expect(resize).not.toHaveBeenCalled();
  });

  it("shows and clears jump feedback without waiting for a slow reconciliation", async () => {
    const resize = mockPanelResize();
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
    resize.mockClear();
    fireEvent.click(jumpButton);

    expect(resolveJump).toBeTruthy();
    expect(screen.getByText("Opening session")).toBeTruthy();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect((jumpButton as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTitle("Opening session")).toBeTruthy();
    const pendingFooter = document.querySelector(".panel-footer") as HTMLElement;
    expect(within(pendingFooter).getByText("Opening session")).toBeTruthy();
    expect(within(pendingFooter).queryByRole("button")).toBeNull();
    expect(document.querySelector(".panel-message")).toBeNull();
    expect(resize).not.toHaveBeenCalled();

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
    expect(screen.getByText("Opened Codex Desktop session.")).toBeTruthy();
    expect(screen.getByTitle("Jump back")).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2999);
    });
    expect(screen.getByText("Opened Codex Desktop session.")).toBeTruthy();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.queryByText("Opened Codex Desktop session.")).toBeNull();

    await act(async () => {
      resolveJumpRefresh?.(jsonResponse([row]));
      await Promise.resolve();
      await Promise.resolve();
    });
    const footer = document.querySelector(".panel-footer") as HTMLElement;
    expect(footer).toBeTruthy();
    expect(within(footer).queryByText("Opened Codex Desktop session.")).toBeNull();
    expect(resize).not.toHaveBeenCalled();
  });

  it("keeps failed jump feedback visible when its target is exact", async () => {
    const resize = mockPanelResize();
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

    window.localStorage.setItem("attn.statusPanelConfig", JSON.stringify({ visibleItemCount: 1 }));
    render(<StatusPanelView initialRows={[row]} sourceHealth={fakeSourceHealth} />);
    expandPanel();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(resize).toHaveBeenCalledWith(128);
    resize.mockClear();
    fireEvent.click(screen.getByTitle("Jump back"));

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const footer = document.querySelector(".panel-footer") as HTMLElement;
    expect(within(footer).getByText("Jump-back failed: open failed.")).toBeTruthy();
    expect(document.querySelector(".panel-message")).toBeNull();
    expect(resize).not.toHaveBeenCalled();

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

  it("runs Jump for the second current panel shortcut target", async () => {
    const firstRow: SessionRow = {
      ...initialSessions[0],
      sessionId: "shortcut-first-row",
      label: "First shortcut row",
      state: "inspect",
      statusReason: "completed task ready to inspect; open it to mark read",
    };
    const secondRow: SessionRow = {
      ...firstRow,
      sessionId: "shortcut-second-row",
      label: "Second shortcut row",
    };
    let triggerSessionJump: ((event: { payload: unknown }) => void) | undefined;
    const jumpedSessionIds: string[] = [];
    const { listen } = await import("@tauri-apps/api/event");
    vi.mocked(listen).mockImplementation(async (event, callback) => {
      if (event === "agent-session-inbox://jump-session") {
        triggerSessionJump = callback as typeof triggerSessionJump;
      }
      return vi.fn<() => void>();
    });
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const pathname = requestPath(url);
      if (pathname === "/api/sessions") return jsonResponse([firstRow, secondRow]);
      if (pathname === "/api/source-health") return jsonResponse(fakeSourceHealth);
      if (pathname === "/api/jump") {
        const { sessionId } = JSON.parse(String(init?.body)) as { sessionId: string };
        jumpedSessionIds.push(sessionId);
        return jsonResponse({
          sessionId,
          availability: "exact",
          target: "desktop",
          succeeded: true,
          message: "Opened Codex Desktop session.",
        });
      }
      return jsonResponse({}, 404);
    }));

    render(<StatusPanelView initialRows={[firstRow, secondRow]} sourceHealth={fakeSourceHealth} />);

    await waitFor(() => expect(triggerSessionJump).toBeTypeOf("function"));
    await act(async () => {
      triggerSessionJump?.({ payload: 2 });
      await Promise.resolve();
    });

    await waitFor(() => expect(jumpedSessionIds).toEqual(["shortcut-second-row"]));
  });

  it("runs Jump for the fifth target even when the panel shows three rows", async () => {
    const rows: SessionRow[] = ["first", "second", "third", "fourth", "fifth"].map((ordinal) => ({
      ...initialSessions[0],
      sessionId: `shortcut-${ordinal}-target`,
      label: `Shortcut ${ordinal} target`,
      state: "inspect",
      statusReason: "completed task ready to inspect; open it to mark read",
    }));
    let triggerSessionJump: ((event: { payload: unknown }) => void) | undefined;
    const jumpedSessionIds: string[] = [];
    const { listen } = await import("@tauri-apps/api/event");
    vi.mocked(listen).mockImplementation(async (event, callback) => {
      if (event === "agent-session-inbox://jump-session") {
        triggerSessionJump = callback as typeof triggerSessionJump;
      }
      return vi.fn<() => void>();
    });
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const pathname = requestPath(url);
      if (pathname === "/api/sessions") return jsonResponse(rows);
      if (pathname === "/api/source-health") return jsonResponse(fakeSourceHealth);
      if (pathname === "/api/jump") {
        const { sessionId } = JSON.parse(String(init?.body)) as { sessionId: string };
        jumpedSessionIds.push(sessionId);
        return jsonResponse({
          sessionId,
          availability: "exact",
          target: "desktop",
          succeeded: true,
          message: "Opened Codex Desktop session.",
        });
      }
      return jsonResponse({}, 404);
    }));
    window.localStorage.setItem("attn.statusPanelConfig", JSON.stringify({ panelMode: "persistent" }));

    render(<StatusPanelView initialRows={rows} sourceHealth={fakeSourceHealth} />);

    expect(await screen.findAllByRole("article")).toHaveLength(3);
    await waitFor(() => expect(triggerSessionJump).toBeTypeOf("function"));
    await act(async () => {
      triggerSessionJump?.({ payload: 5 });
      await Promise.resolve();
    });

    await waitFor(() => expect(jumpedSessionIds).toEqual(["shortcut-fifth-target"]));
  });

  it("uses the refreshed panel order for a session shortcut", async () => {
    const initialFirstRow: SessionRow = {
      ...initialSessions[0],
      sessionId: "initial-shortcut-first-row",
      label: "Initial shortcut first row",
      state: "inspect",
      statusReason: "completed task ready to inspect; open it to mark read",
    };
    const initialSecondRow: SessionRow = {
      ...initialFirstRow,
      sessionId: "initial-shortcut-second-row",
      label: "Initial shortcut second row",
    };
    const refreshedFirstRow: SessionRow = {
      ...initialFirstRow,
      sessionId: "refreshed-shortcut-first-row",
      label: "Refreshed shortcut first row",
    };
    const refreshedSecondRow: SessionRow = {
      ...initialSecondRow,
      sessionId: "refreshed-shortcut-second-row",
      label: "Refreshed shortcut second row",
    };
    let sourceRows = [initialFirstRow, initialSecondRow];
    let triggerSourcesChanged: ((event: { payload: unknown }) => void) | undefined;
    let triggerSessionJump: ((event: { payload: unknown }) => void) | undefined;
    const jumpedSessionIds: string[] = [];
    const { listen } = await import("@tauri-apps/api/event");
    vi.mocked(listen).mockImplementation(async (event, callback) => {
      if (event === "agent-session-inbox://sources-changed") {
        triggerSourcesChanged = callback as typeof triggerSourcesChanged;
      }
      if (event === "agent-session-inbox://jump-session") {
        triggerSessionJump = callback as typeof triggerSessionJump;
      }
      return vi.fn<() => void>();
    });
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const pathname = requestPath(url);
      if (pathname === "/api/sessions") return jsonResponse(sourceRows);
      if (pathname === "/api/source-health") return jsonResponse(fakeSourceHealth);
      if (pathname === "/api/jump") {
        const { sessionId } = JSON.parse(String(init?.body)) as { sessionId: string };
        jumpedSessionIds.push(sessionId);
        return jsonResponse({
          sessionId,
          availability: "exact",
          target: "desktop",
          succeeded: true,
          message: "Opened Codex Desktop session.",
        });
      }
      return jsonResponse({}, 404);
    }));

    window.localStorage.setItem("attn.statusPanelConfig", JSON.stringify({ panelMode: "persistent" }));

    render(<StatusPanelView initialRows={sourceRows} sourceHealth={fakeSourceHealth} />);

    await waitFor(() => {
      expect(triggerSourcesChanged).toBeTypeOf("function");
      expect(triggerSessionJump).toBeTypeOf("function");
    });
    sourceRows = [refreshedFirstRow, refreshedSecondRow];
    await act(async () => {
      triggerSourcesChanged?.({ payload: undefined });
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.getByText("Refreshed shortcut first row")).toBeTruthy());
    await act(async () => {
      triggerSessionJump?.({ payload: 1 });
      await Promise.resolve();
    });

    await waitFor(() => expect(jumpedSessionIds).toEqual(["refreshed-shortcut-first-row"]));
  });

  it("ignores a session shortcut outside the first five targets", async () => {
    const row: SessionRow = {
      ...initialSessions[0],
      sessionId: "shortcut-boundary-row",
      state: "inspect",
      statusReason: "completed task ready to inspect; open it to mark read",
    };
    let triggerSessionJump: ((event: { payload: unknown }) => void) | undefined;
    const { listen } = await import("@tauri-apps/api/event");
    vi.mocked(listen).mockImplementation(async (event, callback) => {
      if (event === "agent-session-inbox://jump-session") {
        triggerSessionJump = callback as typeof triggerSessionJump;
      }
      return vi.fn<() => void>();
    });
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const pathname = requestPath(url);
      if (pathname === "/api/sessions") return jsonResponse([row]);
      if (pathname === "/api/source-health") return jsonResponse(fakeSourceHealth);
      return jsonResponse({}, 404);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<StatusPanelView initialRows={[row]} sourceHealth={fakeSourceHealth} />);

    await waitFor(() => expect(triggerSessionJump).toBeTypeOf("function"));
    await act(async () => {
      triggerSessionJump?.({ payload: 6 });
      await Promise.resolve();
    });

    expect(fetchMock.mock.calls.filter(([url]) => requestPath(url) === "/api/jump")).toHaveLength(0);
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

  it("keeps peer order through pin, unpin, and dismiss snapshots", async () => {
    const row: SessionRow = {
      ...initialSessions[0],
      sessionId: "pin-row",
      label: "Pin row",
      state: "inspect",
      pinned: false,
      statusReason: "completed task ready to inspect; open it to mark read",
    };
    const before = { ...row, sessionId: "before-pin-row", label: "Before pin row" };
    const after = { ...row, sessionId: "after-pin-row", label: "After pin row" };
    const rows = [before, row, after];
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {},
    });
    let pinned = false;
    let dismissed = false;
    const snapshot = () => [...rows].reverse()
      .filter((item) => !dismissed || item.sessionId !== row.sessionId)
      .map((item) => item.sessionId === row.sessionId ? { ...item, pinned } : item);
    tauriCoreMock.invoke.mockImplementation(async (command: string) => {
      if (command === "list_sessions") return snapshot();
      if (command === "source_health") return fakeSourceHealth;
      if (command === "pin_session") {
        pinned = true;
        return snapshot();
      }
      if (command === "unpin_session") {
        pinned = false;
        return snapshot();
      }
      if (command === "dismiss_sessions") {
        dismissed = true;
        return snapshot();
      }
      return null;
    });

    render(<StatusPanelView initialRows={rows} sourceHealth={fakeSourceHealth} />);
    expandPanel();
    const displayedIds = () => screen.getAllByRole("article").map((element) => element.getAttribute("data-testid"));
    const target = () => within(screen.getByTestId("status-row-pin-row"));
    await waitFor(() => expect(tauriCoreMock.invoke).toHaveBeenCalledWith("list_sessions", expect.anything()));
    expect(displayedIds()).toEqual(["status-row-before-pin-row", "status-row-pin-row", "status-row-after-pin-row"]);

    fireEvent.click(target().getByTitle("Pin session"));

    expect(tauriCoreMock.invoke).toHaveBeenCalledWith("pin_session", { sessionId: "pin-row" });
    expect(await target().findByTitle("Unpin session")).toBeTruthy();
    expect(displayedIds()).toEqual(["status-row-pin-row", "status-row-before-pin-row", "status-row-after-pin-row"]);

    fireEvent.click(target().getByTitle("Unpin session"));

    expect(tauriCoreMock.invoke).toHaveBeenCalledWith("unpin_session", { sessionId: "pin-row" });
    expect(await target().findByTitle("Pin session")).toBeTruthy();
    expect(displayedIds()).toEqual(["status-row-before-pin-row", "status-row-pin-row", "status-row-after-pin-row"]);

    fireEvent.click(target().getByTitle("Dismiss"));
    await waitFor(() => expect(screen.queryByTestId("status-row-pin-row")).toBeNull());
    expect(tauriCoreMock.invoke).toHaveBeenCalledWith("dismiss_sessions", { sessionIds: ["pin-row"] });
    expect(displayedIds()).toEqual(["status-row-before-pin-row", "status-row-after-pin-row"]);
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

  it("does not let a pre-mutation refresh overwrite the post-mutation snapshot or block its controls", async () => {
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

    expect(await screen.findByText("Post-mutation row")).toBeTruthy();
    expect(screen.getByTitle("Unpin session")).toBeTruthy();
    expect(screen.getByText("Pinned session")).toBeTruthy();
    expect(listCallCount).toBe(1);

    await act(async () => {
      resolveStaleRefresh?.([staleRow]);
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(listCallCount).toBe(2);
      expect(screen.getByTitle("Unpin session")).toBeTruthy();
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
    expect(tauriConfig.app.windows[0].width).toBe(420);
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

function mockPanelResize() {
  return vi.spyOn(inboxApi, "resizePanel").mockResolvedValue({ generation: 0 });
}

function enablePlacementRuntime() {
  Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
  tauriCoreMock.invoke.mockImplementation(async (command: string, args?: { shortcut?: string | null }) => {
    if (command === "list_sessions") return initialSessions;
    if (command === "configure_panel_shortcut" || command === "configure_position_shortcut") {
      return { activeShortcut: args?.shortcut ?? null };
    }
    if (command === "resize_panel") return { generation: 11 };
    return undefined;
  });
}

async function capturePlacementEvents() {
  enablePlacementRuntime();
  const { listen } = await import("@tauri-apps/api/event");
  const handlers = new Map<string, (event: { payload: unknown }) => void>();
  vi.mocked(listen).mockImplementation(async (event, callback) => {
    handlers.set(event, callback as (event: { payload: unknown }) => void);
    return vi.fn<() => void>();
  });
  return {
    emit: (event: string, payload: unknown) => handlers.get(`agent-session-inbox://${event}`)?.({ payload }),
    confirmed: (generation: number, corner: PlacementSnapshot["corner"]) => {
      handlers.get("agent-session-inbox://placement-confirmed")?.({ payload: {
        generation, corner, frame: { x: -1904, y: 812, width: 420, height: 252 },
      } });
    },
  };
}

async function openPlacementSettings(events: Awaited<ReturnType<typeof capturePlacementEvents>>) {
  await act(async () => events.emit("open-management", "management"));
  await screen.findByRole("button", { name: "Apply settings" });
}

async function renderShortcutSettings() {
  const { listen } = await import("@tauri-apps/api/event");
  let openManagement: ((event: { payload: string }) => void) | undefined;
  vi.mocked(listen).mockImplementation(async (event, callback) => {
    if (event === "agent-session-inbox://open-management") {
      openManagement = callback as (event: { payload: string }) => void;
    }
    return () => undefined;
  });
  render(<StatusPanelView initialRows={initialSessions} sourceHealth={fakeSourceHealth} />);
  const openSettings = async () => {
    await act(async () => openManagement?.({ payload: "management" }));
  };
  await openSettings();
  return openSettings;
}

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
