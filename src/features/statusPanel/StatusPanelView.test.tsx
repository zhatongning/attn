import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => vi.fn()),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: vi.fn(() => ({
    setSize: tauriWindowMock.setSize,
  })),
}));

vi.mock("@tauri-apps/api/dpi", () => ({
  LogicalSize: class LogicalSize {
    type = "Logical";
    constructor(public width: number, public height: number) {}
  },
}));

afterEach(() => {
  window.localStorage.clear();
  tauriWindowMock.setSize.mockClear();
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

    const panel = screen.getByRole("main");
    const statusRows = within(panel).getAllByRole("article");

    expect(screen.getByText("attn")).toBeTruthy();
    expect(statusRows).toHaveLength(3);
    expect(screen.getByText(/quiet/)).toBeTruthy();
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

    fireEvent.click(screen.getByText(/\+\d+ quiet/));

    expect(screen.queryByText("Quiet historical session")).toBeNull();
    expect(screen.getAllByRole("article")).toHaveLength(3);
  });

  it("keeps configurable options off the status panel", () => {
    render(<StatusPanelView initialRows={initialSessions} sourceHealth={fakeSourceHealth} />);

    expect(screen.queryByLabelText("Visible items")).toBeNull();
    expect(screen.queryByRole("button", { name: "Manage settings" })).toBeNull();
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
    expect(screen.getByText("follow-up")).toBeTruthy();

    handler?.({ payload: "management" });
    fireEvent.change(await screen.findByLabelText("Language"), { target: { value: "zh" } });
    fireEvent.click(await screen.findByRole("button", { name: "Apply settings" }));

    expect(screen.getByText("1 需关注")).toBeTruthy();
    expect(screen.getByText("1 进行中")).toBeTruthy();
    expect(screen.getByText("1 空闲")).toBeTruthy();
    expect(screen.getByText("待跟进")).toBeTruthy();
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

    expect(screen.getByText("1 需关注")).toBeTruthy();
    expect(screen.getByText("待跟进")).toBeTruthy();
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
    expect(screen.getAllByRole("article")).toHaveLength(3);

    handler?.({ payload: "management" });
    fireEvent.change(await screen.findByLabelText("Visible items"), { target: { value: "5" } });
    fireEvent.click(screen.getByText("Back"));
    expect(screen.getAllByRole("article")).toHaveLength(3);

    handler?.({ payload: "management" });
    fireEvent.change(await screen.findByLabelText("Visible items"), { target: { value: "5" } });
    fireEvent.click(await screen.findByRole("button", { name: "Apply settings" }));
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

  it("uses small Atom status markers", () => {
    const rows: SessionRow[] = [
      { ...initialSessions[0], sessionId: "blocked", state: "unknown", statusReason: "source status unavailable" },
      { ...initialSessions[0], sessionId: "needed", state: "needsAttention", statusReason: "waiting for user input" },
      { ...initialSessions[0], sessionId: "inspect", state: "inspect", statusReason: "ready to inspect" },
      { ...initialSessions[0], sessionId: "working", state: "running", statusReason: "running signal observed" },
      { ...initialSessions[0], sessionId: "idle", state: "idle", statusReason: "completed task observed; idle until the next source signal" },
    ];
    const { container } = render(<StatusPanelView initialRows={rows} sourceHealth={fakeSourceHealth} />);

    const statusTexts = Array.from(container.querySelectorAll(".status-code")).map((element) =>
      element.textContent?.replace(/\s+/g, " ").trim(),
    );

    expect(statusTexts).toEqual(["● blocked", "● inspect", "● follow-up"]);
  });

  it("keeps an opened intervention row as needed during the read window", async () => {
    const attentionRow: SessionRow = {
      ...initialSessions[0],
      sessionId: "needs-input",
      state: "needsAttention",
      confidence: "exact",
      statusReason: "waiting for user input",
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

    expect(await screen.findByText("follow-up")).toBeTruthy();

    fireEvent.click(screen.getByTitle("Jump back"));

    expect(await screen.findByTitle("Read recently; keep in needed state until 30 minutes pass.")).toBeTruthy();
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
    expect(css).toContain("width: min(100vw - 12px, 540px);");
    expect(css).toContain("max-height: calc(100vh - 12px);");
    expect(css).toContain("inset 0 1px 0 rgba(171, 178, 191, 0.08);");
  });

  it("defines a non-looping inspect attention cue animation", () => {
    // @ts-expect-error This test reads local CSS without adding Node types to the app build.
    const css = readFileSync(join(process.cwd(), "src/App.css"), "utf8");

    expect(css).toContain(".status-row--attention-cue");
    expect(css).toContain("animation: inspect-attention-cue 1800ms ease-out both;");
    expect(css).toContain("@keyframes inspect-attention-sweep");
  });
});

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
