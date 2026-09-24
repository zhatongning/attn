import { afterEach, describe, expect, it, vi } from "vitest";
import { initialSessions } from "./fakeSessions";
import {
  PanelShortcutConfigureError,
  configurePanelShortcut,
  jumpToSession,
  loadSessions,
  loadSourceHealth,
} from "./inboxApi";

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

  it("configures the panel shortcut through the desktop runtime", async () => {
    enableTauriRuntime();
    tauriCoreMock.invoke.mockResolvedValue({ activeShortcut: "shift+alt+super+space" });

    await expect(configurePanelShortcut("shift+alt+super+space")).resolves.toEqual({
      activeShortcut: "shift+alt+super+space",
    });
    expect(tauriCoreMock.invoke).toHaveBeenCalledWith("configure_panel_shortcut", {
      shortcut: "shift+alt+super+space",
    });
  });

  it("returns the requested panel shortcut in preview mode without making a request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(configurePanelShortcut(null)).resolves.toEqual({ activeShortcut: null });
    expect(tauriCoreMock.invoke).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("propagates a rejected desktop shortcut configuration unchanged", async () => {
    enableTauriRuntime();
    const error = new Error("shortcut registration failed");
    tauriCoreMock.invoke.mockRejectedValueOnce(error);

    await expect(configurePanelShortcut("control+alt+super+p")).rejects.toBe(error);
  });

  it("normalizes a structured native shortcut rejection without losing the active snapshot", async () => {
    enableTauriRuntime();
    tauriCoreMock.invoke.mockRejectedValueOnce({
      code: "registration_failed",
      activeShortcut: "shift+alt+super+space",
      stateUncertain: false,
    });

    await expect(configurePanelShortcut("control+alt+super+p")).rejects.toMatchObject({
      code: "registration_failed",
      activeShortcut: "shift+alt+super+space",
      stateUncertain: false,
    });
  });

  it("preserves uncertain native status and leaves malformed or legacy rejections untouched", async () => {
    enableTauriRuntime();
    const uncertain = { code: "rollback_failed", activeShortcut: null, stateUncertain: true };
    tauriCoreMock.invoke.mockRejectedValueOnce(uncertain);
    try {
      await configurePanelShortcut(null);
      throw new Error("expected a rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(PanelShortcutConfigureError);
      expect(error).toMatchObject(uncertain);
    }

    const malformed = { code: "registration_failed", activeShortcut: 7, stateUncertain: false };
    tauriCoreMock.invoke.mockRejectedValueOnce(malformed);
    await expect(configurePanelShortcut(null)).rejects.toBe(malformed);
    tauriCoreMock.invoke.mockRejectedValueOnce("registration_failed");
    await expect(configurePanelShortcut(null)).rejects.toBe("registration_failed");
  });
});
