import { invoke } from "@tauri-apps/api/core";
import type {
  CodexHookIntegrationStatus,
  JumpAvailability,
  JumpTarget,
  SessionRow,
  SourceHealth,
} from "../../shared/types/session";
import { fakeSourceHealth, initialSessions } from "./fakeSessions";

interface JumpResult {
  sessionId: string;
  availability: JumpAvailability;
  target: JumpTarget;
  message: string;
}

function hasTauriRuntime() {
  return "__TAURI_INTERNALS__" in window;
}

export async function loadSessions(): Promise<SessionRow[]> {
  if (!hasTauriRuntime()) {
    return fetchDevJson<SessionRow[]>("/api/sessions", initialSessions);
  }

  return invoke<SessionRow[]>("list_sessions").catch(() =>
    fetchDevJson<SessionRow[]>("/api/sessions", initialSessions),
  );
}

export async function loadSourceHealth(): Promise<SourceHealth> {
  if (!hasTauriRuntime()) {
    return fetchDevJson<SourceHealth>("/api/source-health", fakeSourceHealth);
  }

  return invoke<SourceHealth>("source_health").catch(() =>
    fetchDevJson<SourceHealth>("/api/source-health", fakeSourceHealth),
  );
}

export async function loadCodexHookIntegrationStatus(): Promise<CodexHookIntegrationStatus> {
  const fallback: CodexHookIntegrationStatus = {
    installed: false,
    hooksPath: "~/.codex/hooks.json",
    eventStorePath: "~/.codex/agent-session-inbox/hook-events.jsonl",
    detail: "Codex hook status is only available in the desktop app.",
  };

  if (!hasTauriRuntime()) {
    return fallback;
  }

  return invoke<CodexHookIntegrationStatus>("codex_hook_integration_status").catch(() => fallback);
}

export async function installCodexHooks(): Promise<CodexHookIntegrationStatus> {
  if (!hasTauriRuntime()) {
    return {
      installed: false,
      hooksPath: "~/.codex/hooks.json",
      eventStorePath: "~/.codex/agent-session-inbox/hook-events.jsonl",
      detail: "Codex hooks can be installed from the desktop app.",
    };
  }

  return invoke<CodexHookIntegrationStatus>("install_codex_hooks");
}

export async function dismissSession(sessionId: string, currentRows: SessionRow[]): Promise<SessionRow[]> {
  if (!hasTauriRuntime()) {
    return currentRows.map((row) =>
      row.sessionId === sessionId ? { ...row, dismissed: true, handled: true } : row,
    );
  }

  return invoke<SessionRow[]>("dismiss_session", { sessionId }).catch(() =>
    currentRows.map((row) =>
      row.sessionId === sessionId ? { ...row, dismissed: true, handled: true } : row,
    ),
  );
}

export async function restoreSession(sessionId: string, currentRows: SessionRow[]): Promise<SessionRow[]> {
  if (!hasTauriRuntime()) {
    return currentRows.map((row) =>
      row.sessionId === sessionId ? { ...row, dismissed: false, handled: false } : row,
    );
  }

  return invoke<SessionRow[]>("restore_session", { sessionId }).catch(() =>
    currentRows.map((row) =>
      row.sessionId === sessionId ? { ...row, dismissed: false, handled: false } : row,
    ),
  );
}

export async function jumpToSession(sessionId: string): Promise<JumpResult> {
  if (!hasTauriRuntime()) {
    return fetchDevJson<JumpResult>("/api/jump", {
      sessionId,
      availability: "unavailable",
      target: "unknown",
      message: "Jump-back unavailable: local preview API is not connected.",
    }, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId }),
    });
  }

  return invoke<JumpResult>("jump_to_session", { sessionId }).catch(() =>
    fetchDevJson<JumpResult>("/api/jump", {
      sessionId,
      availability: "unavailable",
      target: "unknown",
      message: "Jump-back unavailable: local preview API is not connected.",
    }, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId }),
    }),
  );
}

async function fetchDevJson<T>(url: string, fallback: T, init?: RequestInit): Promise<T> {
  try {
    const response = await fetch(url, init);
    if (!response.ok) return fallback;
    return (await response.json()) as T;
  } catch {
    return fallback;
  }
}
