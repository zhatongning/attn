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
  succeeded: boolean;
  message: string;
}

export interface PanelShortcutUpdate {
  activeShortcut: string | null;
}

export type PanelShortcutErrorCode =
  | "invalid_shortcut"
  | "registration_failed"
  | "rollback_failed"
  | "registration_uncertain";

export class PanelShortcutConfigureError extends Error {
  constructor(
    readonly code: PanelShortcutErrorCode,
    readonly activeShortcut: string | null,
    readonly stateUncertain: boolean,
  ) {
    super(code);
    this.name = "PanelShortcutConfigureError";
  }
}

function normalizePanelShortcutError(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return value;
  const error = value as Record<string, unknown>;
  if (
    typeof error.code !== "string"
    || !["invalid_shortcut", "registration_failed", "rollback_failed", "registration_uncertain"].includes(error.code)
    || (error.activeShortcut !== null && typeof error.activeShortcut !== "string")
    || typeof error.stateUncertain !== "boolean"
    || (error.stateUncertain && error.activeShortcut !== null)
    || (["rollback_failed", "registration_uncertain"].includes(error.code) !== error.stateUncertain)
  ) return value;
  return new PanelShortcutConfigureError(
    error.code as PanelShortcutErrorCode,
    error.activeShortcut,
    error.stateUncertain,
  );
}

function hasTauriRuntime() {
  return "__TAURI_INTERNALS__" in window;
}

export async function loadSessions(followUpToIdleMinutes?: number): Promise<SessionRow[]> {
  if (!hasTauriRuntime()) {
    return fetchDevJson<SessionRow[]>(
      sessionsPreviewUrl(followUpToIdleMinutes),
      initialSessions,
    );
  }

  return invoke<SessionRow[]>("list_sessions", { followUpToIdleMinutes });
}

function sessionsPreviewUrl(followUpToIdleMinutes?: number) {
  if (followUpToIdleMinutes === undefined) return "/api/sessions";
  return `/api/sessions?followUpToIdleMinutes=${encodeURIComponent(String(followUpToIdleMinutes))}`;
}

export async function loadSourceHealth(): Promise<SourceHealth> {
  if (!hasTauriRuntime()) {
    return fetchDevJson<SourceHealth>("/api/source-health", fakeSourceHealth);
  }

  return invoke<SourceHealth>("source_health");
}

export async function configurePanelShortcut(shortcut: string | null): Promise<PanelShortcutUpdate> {
  if (!hasTauriRuntime()) return { activeShortcut: shortcut };
  try {
    return await invoke<PanelShortcutUpdate>("configure_panel_shortcut", { shortcut });
  } catch (error) {
    throw normalizePanelShortcutError(error);
  }
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

export async function dismissSession(
  sessionId: string,
  currentRows: SessionRow[],
  sessionIds = [sessionId],
): Promise<SessionRow[]> {
  const dismissedIds = new Set(sessionIds);
  const fallbackRows = () => currentRows.map((row) =>
    dismissedIds.has(row.sessionId) ? { ...row, dismissed: true, handled: true } : row,
  );

  if (!hasTauriRuntime()) {
    return fallbackRows();
  }

  return invoke<SessionRow[]>("dismiss_sessions", { sessionIds })
    .catch(() => invoke<SessionRow[]>("dismiss_session", { sessionId }))
    .catch(fallbackRows);
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

export async function pinSession(sessionId: string, currentRows: SessionRow[]): Promise<SessionRow[]> {
  if (!hasTauriRuntime()) {
    return currentRows.map((row) =>
      row.sessionId === sessionId ? { ...row, pinned: true } : row,
    );
  }

  return invoke<SessionRow[]>("pin_session", { sessionId }).catch(() =>
    currentRows.map((row) =>
      row.sessionId === sessionId ? { ...row, pinned: true } : row,
    ),
  );
}

export async function unpinSession(sessionId: string, currentRows: SessionRow[]): Promise<SessionRow[]> {
  if (!hasTauriRuntime()) {
    return currentRows.map((row) =>
      row.sessionId === sessionId ? { ...row, pinned: false } : row,
    );
  }

  return invoke<SessionRow[]>("unpin_session", { sessionId }).catch(() =>
    currentRows.map((row) =>
      row.sessionId === sessionId ? { ...row, pinned: false } : row,
    ),
  );
}

export async function jumpToSession(
  sessionId: string,
  acknowledgedSessionIds = [sessionId],
  followUpToIdleMinutes?: number,
): Promise<JumpResult> {
  if (!hasTauriRuntime()) {
    return fetchDevJson<JumpResult>("/api/jump", {
      sessionId,
      availability: "unavailable",
      target: "unknown",
      succeeded: false,
      message: "Jump-back unavailable: local preview API is not connected.",
    }, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, acknowledgedSessionIds, followUpToIdleMinutes }),
    });
  }

  return invoke<JumpResult>("jump_to_session", {
    sessionId,
    acknowledgedSessionIds,
    followUpToIdleMinutes,
  });
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
