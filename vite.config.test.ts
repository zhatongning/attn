// @vitest-environment node

import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

const source = vi.hoisted(() => ({
  discoverCodexSessions: vi.fn(() => []),
  jumpToSession: vi.fn(async () => ({
    sessionId: "",
    availability: "unavailable",
    target: "unknown",
    message: "Jump-back unavailable.",
  })),
  sourceHealth: vi.fn(() => ({})),
}));

vi.mock("./scripts/codexSessionsDevSource.mjs", () => ({
  createCodexSessionsDevSource: () => ({
    discoverCodexSessions: source.discoverCodexSessions,
    jumpToSession: source.jumpToSession,
  }),
  defaultCodexSessionsRoot: "/tmp/codex-sessions",
  defaultCodexStateDbPath: "/tmp/state.sqlite",
  discoverCodexSessions: source.discoverCodexSessions,
  jumpToSession: source.jumpToSession,
  sourceHealth: source.sourceHealth,
}));

afterEach(() => {
  source.discoverCodexSessions.mockClear();
  source.jumpToSession.mockClear();
  source.sourceHealth.mockClear();
});

describe("Vite Codex sessions API", () => {
  it("forwards the follow-up duration query to session discovery", async () => {
    const handlers = await apiHandlers();

    await handlers.get("/api/sessions")?.(
      { url: "/?followUpToIdleMinutes=45" },
      response(),
    );

    expect(source.discoverCodexSessions).toHaveBeenCalledWith({ followUpToIdleMinutes: 45 });
  });

  it("forwards the follow-up duration body to Jump back", async () => {
    const handlers = await apiHandlers();
    const request = Readable.from([JSON.stringify({
      sessionId: "session-1",
      followUpToIdleMinutes: 45,
    })]);
    Object.assign(request, { method: "POST", url: "/" });

    await handlers.get("/api/jump")?.(request, response());

    expect(source.jumpToSession).toHaveBeenCalledWith(
      "session-1",
      { followUpToIdleMinutes: 45 },
    );
  });
});

async function apiHandlers() {
  const configModule = await import("./vite.config");
  const config = await configModule.default({
    command: "serve",
    mode: "test",
    isSsrBuild: false,
    isPreview: false,
  });
  const handlers = new Map<string, (request: Readable | { url: string }, reply: ReturnType<typeof response>) => unknown>();
  const plugin = config.plugins?.find((candidate) =>
    typeof candidate === "object" && candidate?.name === "codex-sessions-dev-api",
  );

  if (!plugin || typeof plugin === "function" || !plugin.configureServer) {
    throw new Error("Codex sessions Vite API plugin was not registered.");
  }

  plugin.configureServer({
    middlewares: {
      use(path: string, handler: (request: Readable | { url: string }, reply: ReturnType<typeof response>) => unknown) {
        handlers.set(path, handler);
      },
    },
  } as never);

  return handlers;
}

function response() {
  return {
    statusCode: 200,
    end: vi.fn(),
    setHeader: vi.fn(),
  };
}
