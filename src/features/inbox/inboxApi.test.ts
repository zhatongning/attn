import { afterEach, describe, expect, it, vi } from "vitest";
import { initialSessions } from "./fakeSessions";
import { jumpToSession, loadSessions, loadSourceHealth } from "./inboxApi";

const tauriCoreMock = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: tauriCoreMock.invoke,
}));

function enableTauriRuntime() {
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    configurable: true,
    value: {},
  });
}

afterEach(() => {
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  tauriCoreMock.invoke.mockReset();
  vi.unstubAllGlobals();
});

describe("inboxApi", () => {
  it("does not replace a failed desktop session read with the development API", async () => {
    enableTauriRuntime();
    const error = new Error("native sessions unavailable");
    tauriCoreMock.invoke.mockRejectedValueOnce(error);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(loadSessions()).rejects.toBe(error);
    expect(tauriCoreMock.invoke).toHaveBeenCalledWith("list_sessions", {
      followUpToIdleMinutes: undefined,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not replace a failed desktop source-health read with the development API", async () => {
    enableTauriRuntime();
    const error = new Error("native health unavailable");
    tauriCoreMock.invoke.mockRejectedValueOnce(error);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(loadSourceHealth()).rejects.toBe(error);
    expect(tauriCoreMock.invoke).toHaveBeenCalledWith("source_health");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps a failed desktop jump native instead of calling the development jump API", async () => {
    enableTauriRuntime();
    const error = new Error("native jump unavailable");
    tauriCoreMock.invoke.mockRejectedValueOnce(error);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(jumpToSession("desktop-session")).rejects.toBe(error);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses the development sessions API outside the desktop runtime", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => ({
      ok: true,
      json: async () => initialSessions,
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(loadSessions()).resolves.toEqual(initialSessions);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/sessions");
    expect(tauriCoreMock.invoke).not.toHaveBeenCalled();
  });
});
