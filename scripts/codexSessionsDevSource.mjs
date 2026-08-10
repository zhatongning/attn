import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const defaultUnreadCompletionTrackingStartMs = Date.parse("2026-06-05T08:00:00.000Z");
const pendingCliInputFreshnessMs = 30 * 60 * 1000;
const defaultDevSource = createCodexSessionsDevSource();

export function defaultCodexSessionsRoot() {
  return path.join(os.homedir(), ".codex", "sessions");
}

export function defaultCodexStateDbPath(homeDir = os.homedir()) {
  const currentPath = path.join(homeDir, ".codex", "sqlite", "state_5.sqlite");
  const legacyPath = path.join(homeDir, ".codex", "state_5.sqlite");
  const currentExists = fs.existsSync(currentPath);
  const legacyExists = fs.existsSync(legacyPath);
  if (currentExists && legacyExists) {
    return fileModifiedMs(legacyPath) > fileModifiedMs(currentPath) ? legacyPath : currentPath;
  }
  if (currentExists) return currentPath;
  if (legacyExists) return legacyPath;

  return legacyPath;
}

function fileModifiedMs(filePath) {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

export function sourceHealth({
  stateDbPath = defaultCodexStateDbPath(),
  sessionsRoot = defaultCodexSessionsRoot(),
} = {}) {
  return {
    sourceName: "Codex sessions",
    status: fs.existsSync(sessionsRoot) ? "available" : "unknown",
    capabilities: [
      {
        name: "Thread discovery",
        availability: fs.existsSync(stateDbPath) ? "inferred" : "unavailable",
        detail: `Reads local Codex thread state from ${stateDbPath}.`,
      },
      {
        name: "Attention/completion status",
        availability: "inferred",
        detail: "Uses SQLite threads as primary state and JSONL as event evidence.",
      },
      {
        name: "Window jump-back",
        availability: "inferred",
        detail:
          "Routes Jump back to Codex Desktop, a live iTerm Codex session, a previous iTerm tab, or a resumed CLI item for that workspace.",
      },
    ],
  };
}

export function discoverCodexSessions({
  stateDbPath = defaultCodexStateDbPath(),
  sessionsRoot = defaultCodexSessionsRoot(),
  limit = 80,
  nowMs = Date.now(),
  unreadCompletionTrackingStartMs: trackingStartMs = defaultUnreadCompletionTrackingStartMs,
  liveCliTtyForWorkspace,
  liveCliSessions,
} = {}) {
  if (arguments.length === 0) return defaultDevSource.discoverCodexSessions();
  liveCliSessions ??= liveCliTtyForWorkspace ? [] : findLiveCodexCliSessions();

  const threadRows = discoverCodexThreads({
    stateDbPath,
    limit,
    nowMs,
    unreadCompletionTrackingStartMs: trackingStartMs,
    liveCliSessions,
    liveCliTtyForWorkspace,
  });
  if (threadRows !== null) {
    return sortAndLimitRows(
      mergeLiveCliSessions(threadRows, liveCliSessions, (liveSession) =>
        liveCliSessionRow(liveSession, {
          stateDbPath,
          nowMs,
          unreadCompletionTrackingStartMs: trackingStartMs,
          liveCliSessions,
          liveCliTtyForWorkspace,
        }),
      ),
      limit,
    );
  }

  const jsonlRows = collectJsonlFiles(sessionsRoot)
    .sort((left, right) => right.modifiedAt - left.modifiedAt)
    .slice(0, limit)
    .map((file) => parseSessionFile(file.path, { nowMs, unreadCompletionTrackingStartMs: trackingStartMs }))
    .filter(Boolean)
    .map((observation) => toSessionRow(observation, { liveCliSessions, liveCliTtyForWorkspace, nowMs }));
  return sortAndLimitRows(mergeLiveCliSessions(jsonlRows, liveCliSessions, fallbackLiveCliSessionRow), limit);
}

export function discoverCodexThreadById(sessionId, {
  stateDbPath = defaultCodexStateDbPath(),
  nowMs = Date.now(),
  unreadCompletionTrackingStartMs: trackingStartMs = defaultUnreadCompletionTrackingStartMs,
  liveCliTtyForWorkspace,
  liveCliSessions,
} = {}) {
  if (!fs.existsSync(stateDbPath)) return null;
  liveCliSessions ??= liveCliTtyForWorkspace ? [] : findLiveCodexCliSessions();

  const query = `${threadSummaryJsonSelect()} from threads where id = '${sqliteStringLiteral(sessionId)}' limit 1;`;
  const result = spawnSync("sqlite3", ["-batch", "-readonly", stateDbPath, query], { encoding: "utf8" });
  if (result.status !== 0) return null;

  return result.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => parseThreadRow(line, {
      nowMs,
      unreadCompletionTrackingStartMs: trackingStartMs,
      liveCliTtyForWorkspace,
      liveCliSessions,
    }))
    .find(Boolean) ?? null;
}

export async function jumpToSession(sessionId, options = {}) {
  if (arguments.length === 1) return defaultDevSource.jumpToSession(sessionId);

  const row = sessionId
    ? discoverCodexThreadById(sessionId, options)
      ?? discoverCodexSessions(options).find((session) => session.sessionId === sessionId)
    : null;
  if (!row || !row.workspacePath) {
    return {
      sessionId: sessionId ?? "",
      availability: "unavailable",
      target: row?.jumpTarget ?? "unknown",
      message: "Jump-back unavailable: missing reliable target signal.",
    };
  }

  const plan = buildJumpPlan(row, options);
  await (options.executeJump ?? executeJump)(row, plan);

  return {
    sessionId: row.sessionId,
    availability: row.jumpAvailability,
    target: row.jumpTarget,
    message: jumpMessage(plan),
  };
}

export function createCodexSessionsDevSource({
  stateDbPath = defaultCodexStateDbPath(),
  sessionsRoot = defaultCodexSessionsRoot(),
  limit = 80,
  nowMs = Date.now(),
  unreadCompletionTrackingStartMs: trackingStartMs = defaultUnreadCompletionTrackingStartMs,
  liveCliTtyForWorkspace = findLiveCodexTtyForWorkspace,
  liveCliSessions,
  previousITermTtyForWorkspace = findPreviousITermTtyForWorkspace,
  executeJump: executeJumpOverride,
} = {}) {
  const acknowledgedSignals = new Map();
  const options = () => ({
    stateDbPath,
    sessionsRoot,
    limit,
    nowMs: typeof nowMs === "function" ? nowMs() : nowMs,
    unreadCompletionTrackingStartMs: trackingStartMs,
    liveCliTtyForWorkspace,
    liveCliSessions,
    previousITermTtyForWorkspace,
  });

  return {
    discoverCodexSessions() {
      return discoverCodexSessions(options()).map((row) =>
        applyAcknowledgedSessionState(row, acknowledgedSignals, options().nowMs),
      );
    },
    async jumpToSession(sessionId) {
      const row = discoverCodexThreadById(sessionId, options())
        ?? discoverCodexSessions(options()).find((session) => session.sessionId === sessionId);
      const result = await jumpToSession(sessionId, {
        ...options(),
        executeJump: executeJumpOverride,
      });
      if (result.availability !== "unavailable" && !result.message.startsWith("Jump-back failed")) {
        if (row) acknowledgedSignals.set(acknowledgedSignal(row), options().nowMs);
      }
      return result;
    },
  };
}

function discoverCodexThreads({ stateDbPath, limit, nowMs, unreadCompletionTrackingStartMs, liveCliSessions, liveCliTtyForWorkspace }) {
  if (!fs.existsSync(stateDbPath)) return null;

  const query = `${threadSummaryJsonSelect()} from threads where archived = 0 order by coalesce(updated_at_ms, updated_at * 1000) desc limit ${limit};`;
  const result = spawnSync("sqlite3", ["-batch", "-readonly", stateDbPath, query], { encoding: "utf8" });
  if (result.status !== 0) return null;

  return result.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => parseThreadRow(line, { nowMs, unreadCompletionTrackingStartMs, liveCliSessions, liveCliTtyForWorkspace }))
    .filter(Boolean);
}

function threadSummaryJsonSelect() {
  return `select json_object(
    'id', id,
    'rollout_path', rollout_path,
    'updated_at_ms', updated_at_ms,
    'source', source,
    'cwd', cwd,
    'title', title,
    'archived', archived,
    'agent_nickname', agent_nickname,
    'thread_source', thread_source,
    'preview', preview
  )`;
}

function sqliteStringLiteral(value) {
  return String(value).replaceAll("'", "''");
}

function parseThreadRow(line, { nowMs, unreadCompletionTrackingStartMs, liveCliSessions, liveCliTtyForWorkspace }) {
  let thread;
  try {
    thread = JSON.parse(line);
  } catch {
    return null;
  }

  const jsonlObservation = typeof thread.rollout_path === "string"
    ? parseSessionFile(thread.rollout_path, { nowMs, unreadCompletionTrackingStartMs })
    : null;
  const workspacePath = thread.cwd || jsonlObservation?.workspacePath;
  const jumpTarget = jsonlObservation?.jumpTarget ?? jumpTargetFromThreadSource(thread);
  const jsonlKind = jsonlObservation?.kind;
  const threadUpdatedAfterTaskComplete = threadUpdatedAfterTaskCompleteFromThread(thread, jsonlObservation);
  const lastActivityAt = lastActivityAtFromThread(thread, jsonlObservation, threadUpdatedAfterTaskComplete);
  const hasRecentActivity = lastActivityAt
    ? nowMs - Date.parse(lastActivityAt) <= 2 * 60 * 60 * 1000
    : false;
  const threadCompletionKind = completionKindFromLastActivityAt(lastActivityAt, nowMs);
  const kind = threadUpdatedAfterTaskComplete && jsonlKind === "completedImmediate"
    ? threadCompletionKind
    : (terminalOrInputKind(jsonlKind)
      ? jsonlKind
      : jumpTarget === "desktop" && hasRecentActivity
        ? "running"
        : jumpTarget === "desktop"
          ? "idle"
          : jsonlKind ?? "insufficientEvidence");
  const workspaceName = workspacePath ? path.basename(workspacePath) : undefined;
  const label = firstNonEmpty(
    thread.title,
    thread.preview,
    jsonlObservation?.label,
    workspaceName ? `Codex: ${workspaceName}` : undefined,
    `Codex session ${thread.id}`,
  );

  return toSessionRow({
    sessionId: thread.id,
    kind,
    label: truncate(label, 120),
    agentName: firstNonEmpty(
      jsonlObservation?.agentName,
      thread.agent_nickname,
      thread.thread_source,
      thread.source,
    ),
    threadSource: emptyToUndefined(thread.thread_source),
    parentSessionId: jsonlObservation?.parentSessionId,
    projectName: workspaceName,
    workspacePath,
    lastActivityAt,
    evidenceSummary: jsonlObservation?.evidenceSummary ?? thread.preview,
    jumpTarget,
  }, { liveCliSessions, liveCliTtyForWorkspace, nowMs });
}

function threadUpdatedAfterTaskCompleteFromThread(thread, jsonlObservation) {
  const updatedAt = timestampMsToIsoUtc(Number(thread.updated_at_ms));
  const taskCompleteAt = jsonlObservation?.taskCompleteAt;
  return Boolean(updatedAt && taskCompleteAt && Date.parse(updatedAt) > Date.parse(taskCompleteAt));
}

function lastActivityAtFromThread(thread, jsonlObservation, threadUpdatedAfterTaskComplete = false) {
  return threadUpdatedAfterTaskComplete
    ? timestampMsToIsoUtc(Number(thread.updated_at_ms))
    : jsonlObservation?.lastActivityAt ?? timestampMsToIsoUtc(Number(thread.updated_at_ms));
}

function terminalOrInputKind(kind) {
  return kind === "completedImmediate"
    || kind === "completed"
    || kind === "completedStale"
    || kind === "failed"
    || kind === "stopped"
    || kind === "waitingForInput";
}

function completionKindFromLastActivityAt(lastActivityAt, nowMs) {
  const ageMs = lastActivityAt ? nowMs - Date.parse(lastActivityAt) : Number.POSITIVE_INFINITY;
  if (ageMs <= 5 * 60 * 1000) return "completedImmediate";
  if (ageMs <= 30 * 60 * 1000) return "completed";
  return "completedStale";
}

function parseSessionFile(filePath, {
  nowMs,
  unreadCompletionTrackingStartMs = defaultUnreadCompletionTrackingStartMs,
}) {
  if (!fs.existsSync(filePath)) return null;

  let sessionId;
  let parentSessionId;
  let workspacePath;
  let agentName;
  let sessionName;
  let jumpTarget = "unknown";
  let lastActivityAt;
  let lastActivityKind = "insufficientEvidence";
  let lastMessage;
  let pendingToolApproval;
  let taskCompleteAt;
  let externalImportSession = false;

  for (const line of fs.readFileSync(filePath, "utf8").split("\n")) {
    if (!line.trim()) continue;

    let value;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }

    if (typeof value.timestamp === "string") {
      lastActivityAt = value.timestamp;
    }

    if (value.type === "session_meta") {
      sessionId = value.payload?.id ?? sessionId;
      parentSessionId = parentThreadIdFromSessionMeta(value.payload) ?? parentSessionId;
      workspacePath = value.payload?.cwd ?? workspacePath;
      agentName = firstNonEmpty(value.payload?.agent_nickname, value.payload?.originator, agentName);
      jumpTarget = jumpTargetFromSessionMeta(value.payload) ?? jumpTarget;
    }

    if (value.type === "event_msg") {
      const eventType = value.payload?.type;
      const turnId = typeof value.payload?.turn_id === "string" ? value.payload.turn_id : "";
      if (turnId.startsWith("external-import-turn-")) {
        externalImportSession = true;
      }
      if (eventType === "task_complete") {
        lastActivityKind = "completed";
        pendingToolApproval = undefined;
        taskCompleteAt = value.timestamp;
      } else if (eventType === "turn_aborted") {
        pendingToolApproval = undefined;
        lastActivityKind = "stopped";
      } else if (eventType === "user_message" || eventType === "agent_message") {
        lastActivityKind = "running";
      }
      if (typeof value.payload?.message === "string") {
        if (value.payload.message === "<EXTERNAL SESSION IMPORTED>") {
          externalImportSession = true;
        }
        if (eventType === "user_message" && !sessionName) {
          sessionName = truncate(value.payload.message.trim(), 120);
        } else {
          lastMessage = value.payload.message;
        }
      }
    }

    if (value.type === "response_item") {
      const approval = pendingToolApprovalFromResponseItem(value);
      if (approval) {
        lastActivityKind = "waitingForInput";
        pendingToolApproval = approval;
      } else if (value.payload?.type === "function_call_output") {
        const callId = value.payload?.call_id;
        if (callId && pendingToolApproval?.callId === callId) {
          pendingToolApproval = undefined;
          lastActivityKind = "running";
        }
      }
    }
  }

  sessionId ??= path.basename(filePath, ".jsonl").split("-").at(-1);
  if (!sessionId) return null;

  const ageMs = lastActivityAt ? nowMs - Date.parse(lastActivityAt) : Number.POSITIVE_INFINITY;
  const recent = ageMs <= 2 * 60 * 60 * 1000;
  const kind = pendingToolApproval
    ? "waitingForInput"
    : lastActivityKind === "completed"
    ? !externalImportSession && lastActivityAt && Date.parse(lastActivityAt) >= unreadCompletionTrackingStartMs
      ? "completedImmediate"
      : "completedStale"
    : lastActivityKind === "stopped"
      ? "stopped"
    : lastActivityKind === "running" && recent
      ? "running"
      : recent
        ? "running"
        : "insufficientEvidence";
  const projectName = workspacePath ? path.basename(workspacePath) : undefined;
  const label = firstNonEmpty(sessionName, projectName ? `Codex: ${projectName}` : undefined, `Codex session ${sessionId}`);

  return {
    sessionId,
    parentSessionId,
    kind,
    label,
    agentName,
    projectName,
    workspacePath,
    lastActivityAt: pendingToolApproval?.timestamp ?? lastActivityAt,
    taskCompleteAt,
    evidenceSummary: pendingToolApproval?.evidenceSummary
      ?? (lastMessage ? truncate(lastMessage, 120) : "local Codex JSONL activity observed"),
    jumpTarget,
  };
}

function pendingToolApprovalFromResponseItem(value) {
  if (value.payload?.type !== "function_call") return undefined;

  let args;
  try {
    args = JSON.parse(value.payload?.arguments ?? "");
  } catch {
    return undefined;
  }

  if (args?.sandbox_permissions !== "require_escalated") return undefined;

  const toolName = typeof value.payload?.name === "string" && value.payload.name.trim()
    ? value.payload.name.trim()
    : "tool";
  const requestedAction = typeof args.cmd === "string" && args.cmd.trim()
    ? truncate(args.cmd.trim(), 120)
    : toolName;

  return {
    callId: typeof value.payload?.call_id === "string" ? value.payload.call_id : undefined,
    timestamp: typeof value.timestamp === "string" ? value.timestamp : undefined,
    evidenceSummary: `Codex is waiting for tool approval: ${requestedAction}`,
  };
}

function parentThreadIdFromSessionMeta(payload) {
  return firstNonEmpty(
    payload?.parent_thread_id,
    payload?.source?.subagent?.thread_spawn?.parent_thread_id,
  );
}

function toSessionRow(observation, { liveCliSessions = [], liveCliTtyForWorkspace, nowMs = Date.now() }) {
  const classified = classifyObservation(observation);
  const row = applyLiveCliActivitySignal(classified, liveCliSessions, liveCliTtyForWorkspace, nowMs);
  return {
    ...row,
    dismissabilityReason: dismissabilityReason(row.state),
    jumpAvailability: row.workspacePath
      ? row.jumpTarget === "desktop" ? "exact" : "approximate"
      : "unavailable",
  };
}

function classifyObservation(observation) {
  const classification = classificationForKind(observation.kind);
  return {
    sessionId: observation.sessionId,
    label: observation.label ?? `Codex session ${observation.sessionId}`,
    agentName: emptyToUndefined(observation.agentName),
    threadSource: emptyToUndefined(observation.threadSource),
    parentSessionId: emptyToUndefined(observation.parentSessionId),
    projectName: emptyToUndefined(observation.projectName),
    workspacePath: observation.workspacePath,
    lastActivityAt: emptyToUndefined(observation.lastActivityAt),
    evidenceSummary: emptyToUndefined(observation.evidenceSummary),
    state: classification.state,
    confidence: classification.confidence,
    statusReason: classification.reason,
    handled: false,
    dismissed: false,
    jumpAvailability: "unavailable",
    jumpTarget: observation.jumpTarget ?? "unknown",
  };
}

function classificationForKind(kind) {
  if (kind === "running") {
    return { state: "running", confidence: "exact", reason: "running signal observed" };
  }
  if (kind === "idle") {
    return {
      state: "idle",
      confidence: "inferred",
      reason: "no recent activity observed; idle until the next source signal",
    };
  }
  if (kind === "waitingForInput") {
    return { state: "waitingForInput", confidence: "exact", reason: "waiting for user input" };
  }
  if (kind === "completedImmediate") {
    return {
      state: "inspect",
      confidence: "exact",
      reason: "completed task ready to inspect; open it to mark read",
    };
  }
  if (kind === "completed") {
    return {
      state: "needsAttention",
      confidence: "exact",
      reason: "completed task was opened; keep it quiet during the 30-minute follow-up window",
    };
  }
  if (kind === "completedStale") {
    return {
      state: "idle",
      confidence: "inferred",
      reason: "completed task is no longer recent; idle until the next source signal",
    };
  }
  if (kind === "failed") {
    return {
      state: "inspect",
      confidence: "exact",
      reason: "failed task can be manually reviewed and cleared",
    };
  }
  if (kind === "stopped") {
    return {
      state: "stopped",
      confidence: "exact",
      reason: "stopped before completion; decide whether to continue, inspect, or dismiss",
    };
  }
  return {
    state: "unknown",
    confidence: "unknown",
    reason: "missing source evidence for status classification",
  };
}

function applyLiveCliActivitySignal(row, liveCliSessions, liveCliTtyForWorkspace, nowMs = Date.now()) {
  if (row.state === "waitingForInput" && row.jumpTarget === "cli") {
    const tty = liveCliTtyForRow(row, liveCliSessions, liveCliTtyForWorkspace);
    if (tty && rowHasFreshActivity(row, nowMs, pendingCliInputFreshnessMs)) return row;
    const statusReason = tty
      ? "Pending CLI input is stale; idle until the next source signal."
      : "No live Codex CLI process for pending input; idle until the next source signal.";

    return {
      ...row,
      state: "idle",
      confidence: "inferred",
      statusReason,
    };
  }

  if (row.state !== "unknown" || row.jumpTarget !== "cli" || !row.workspacePath) return row;

  const tty = liveCliTtyForRow(row, liveCliSessions, liveCliTtyForWorkspace);
  if (!tty) return row;

  return {
    ...row,
    state: "running",
    confidence: "inferred",
    statusReason: `Live Codex CLI process observed on ${tty}.`,
  };
}

function liveCliTtyForRow(row, liveCliSessions, liveCliTtyForWorkspace) {
  if (row.jumpTarget !== "cli") return undefined;
  return liveCliSessions.find((session) => session.sessionId === row.sessionId)?.tty
    ?? liveCliSessions.find((session) => !session.sessionId && session.workspacePath === row.workspacePath)?.tty
    ?? (row.workspacePath && liveCliTtyForWorkspace ? liveCliTtyForWorkspace(row.workspacePath) : undefined);
}

function mergeLiveCliSessions(rows, liveCliSessions, missingRow) {
  const merged = [...rows];

  for (const liveSession of liveCliSessions) {
    let matched = false;
    if (liveSession.sessionId) {
      for (let index = 0; index < merged.length; index += 1) {
        if (merged[index].sessionId !== liveSession.sessionId) continue;
        merged[index] = markLiveCliSessionRunning(merged[index], liveSession.tty);
        matched = true;
      }
    }

    if (matched) continue;

    const row = missingRow(liveSession);
    if (merged.some((existing) => existing.sessionId === row.sessionId)) continue;
    merged.push(markLiveCliSessionRunning(row, liveSession.tty));
  }

  return merged;
}

function markLiveCliSessionRunning(row, tty) {
  if (!shouldPromoteLiveCliRow(row.state)) return row;

  return {
    ...row,
    state: "running",
    confidence: "inferred",
    statusReason: `Live Codex CLI process observed on ${tty}.`,
    evidenceSummary: row.evidenceSummary ?? `Live Codex CLI process observed on ${tty}.`,
    handled: false,
    dismissed: false,
    jumpAvailability: row.workspacePath ? "approximate" : row.jumpAvailability,
    jumpTarget: "cli",
  };
}

function shouldPromoteLiveCliRow(state) {
  return state === "unknown" || state === "idle";
}

function liveCliSessionRow(liveSession, options) {
  if (liveSession.sessionId) {
    const row = discoverCodexThreadById(liveSession.sessionId, options);
    if (row) {
      return {
        ...row,
        workspacePath: row.workspacePath ?? liveSession.workspacePath,
        projectName: row.projectName ?? path.basename(liveSession.workspacePath),
        jumpTarget: "cli",
        jumpAvailability: "approximate",
      };
    }
  }

  return fallbackLiveCliSessionRow(liveSession);
}

function fallbackLiveCliSessionRow(liveSession) {
  const projectName = path.basename(liveSession.workspacePath);
  const sessionId = liveSession.sessionId ?? `live-cli:${liveSession.workspacePath}:${liveSession.tty}`;
  return {
    sessionId,
    label: projectName ? `Codex CLI: ${projectName}` : "Codex CLI session",
    agentName: "cli",
    projectName,
    workspacePath: liveSession.workspacePath,
    lastActivityAt: undefined,
    evidenceSummary: `Live Codex CLI process observed on ${liveSession.tty}.`,
    state: "running",
    confidence: "inferred",
    statusReason: `Live Codex CLI process observed on ${liveSession.tty}.`,
    handled: false,
    dismissed: false,
    dismissabilityReason: dismissabilityReason("running"),
    jumpAvailability: "approximate",
    jumpTarget: "cli",
  };
}

function sortAndLimitRows(rows, limit) {
  return [...rows]
    .sort(compareSessionRows)
    .slice(0, limit);
}

function compareSessionRows(left, right) {
  return sessionStatePriority(left.state) - sessionStatePriority(right.state)
    || timestampValue(right.lastActivityAt) - timestampValue(left.lastActivityAt);
}

function sessionStatePriority(state) {
  if (state === "waitingForInput") return 0;
  if (state === "inspect" || state === "dismissable") return 1;
  if (state === "running") return 2;
  if (state === "needsAttention") return 3;
  if (state === "stopped") return 4;
  if (state === "idle") return 5;
  return 6;
}

function timestampValue(value) {
  if (!value) return 0;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

function rowHasFreshActivity(row, nowMs, freshnessMs) {
  return Boolean(row.lastActivityAt && nowMs - Date.parse(row.lastActivityAt) <= freshnessMs);
}

function applyAcknowledgedSessionState(row, acknowledgedSignals, nowMs = Date.now()) {
  if (!acknowledgedSignals.has(acknowledgedSignal(row))) return row;
  if (row.state === "running") return row;
  if (row.state === "idle") return row;
  if (row.state === "waitingForInput") return row;

  const acknowledgedAtMs = acknowledgedSignals.get(acknowledgedSignal(row));
  if (typeof acknowledgedAtMs === "number" && nowMs - acknowledgedAtMs <= 30 * 60 * 1000) {
    return {
      ...row,
      state: "needsAttention",
      confidence: "exact",
      statusReason: "Read recently; keep it quiet during the 30-minute follow-up window.",
      handled: true,
      dismissed: false,
    };
  }

  return {
    ...row,
    state: "idle",
    confidence: "inferred",
    statusReason: "Read window expired; idle until the next source signal.",
    handled: true,
    dismissed: false,
  };
}

function acknowledgedSignal(row) {
  return `${row.sessionId}\u0000${row.lastActivityAt ?? ""}`;
}

function dismissabilityReason(state) {
  if (state === "inspect") return "Inspect row can be manually dismissed.";
  if (state === "stopped") return "Stopped row can be manually dismissed.";
  if (state === "dismissable") return "Inspect row can be manually dismissed.";
  if (state === "unknown") return "Unknown rows are never auto-dismissable.";
  return "Row is not in a dismissable state.";
}

function collectJsonlFiles(dir) {
  if (!fs.existsSync(dir)) return [];

  const result = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      result.push(...collectJsonlFiles(entryPath));
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      result.push({ path: entryPath, modifiedAt: fs.statSync(entryPath).mtimeMs });
    }
  }

  return result;
}

function jumpTargetFromSessionMeta(payload) {
  const originator = typeof payload?.originator === "string" ? payload.originator : "";
  const source = typeof payload?.source === "string" ? payload.source : "";
  const normalized = `${originator} ${source}`.toLowerCase();
  if (!normalized.trim()) return undefined;
  if (normalized.includes("desktop")) return "desktop";
  if (normalized.includes("cli") || normalized.includes("terminal") || normalized.includes("tui")) {
    return "cli";
  }
  return "unknown";
}

function jumpTargetFromThreadSource(thread) {
  const normalized = `${thread.source ?? ""} ${thread.thread_source ?? ""}`.toLowerCase();
  if (normalized.includes("cli") || normalized.includes("terminal") || normalized.includes("tui")) return "cli";
  return "desktop";
}

function timestampMsToIsoUtc(value) {
  if (!Number.isFinite(value) || value <= 0) return undefined;
  return new Date(value).toISOString();
}

function firstNonEmpty(...values) {
  return values.find((value) => typeof value === "string" && value.trim().length > 0)?.trim() ?? "";
}

function emptyToUndefined(value) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function truncate(value, maxLength) {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

function buildJumpPlan(row, options = {}) {
  const liveCliSessions = options.liveCliSessions ?? (options.liveCliTtyForWorkspace ? [] : findLiveCodexCliSessions());
  const liveTty = liveCliTtyForJumpPlan(
    row,
    liveCliSessions,
    options.liveCliTtyForWorkspace ?? findLiveCodexTtyForWorkspace,
  );
  if (liveTty) return { kind: "iterm", tty: liveTty, liveCodex: true };

  if (row.jumpTarget === "desktop" || row.jumpTarget === "unknown") return { kind: "desktop" };

  const resumeTty = row.workspacePath
    ? (options.previousITermTtyForWorkspace ?? findPreviousITermTtyForWorkspace)(row.workspacePath)
    : undefined;

  return {
    kind: "iterm-resume",
    threadId: row.sessionId,
    workspacePath: row.workspacePath,
    tty: resumeTty,
  };
}

function liveCliTtyForJumpPlan(row, liveCliSessions, liveCliTtyForWorkspace) {
  const exactSessionTty = liveCliSessions.find((session) => liveSessionHasSessionId(session, row.sessionId))?.tty;
  if (exactSessionTty) return exactSessionTty;

  if (row.jumpTarget === "cli") {
    return liveCliSessions.find((session) => !session.sessionId && session.workspacePath === row.workspacePath)?.tty;
  }

  return row.workspacePath && liveCliTtyForWorkspace ? liveCliTtyForWorkspace(row.workspacePath) : undefined;
}

function liveSessionHasSessionId(session, sessionId) {
  return session.sessionId === sessionId || session.sessionIds?.includes(sessionId);
}

function jumpMessage(plan) {
  if (plan.kind === "iterm" && plan.liveCodex) return "Focused live iTerm Codex session.";
  if (plan.kind === "iterm") return "Focused previous iTerm session.";
  if (plan.kind === "iterm-resume" && plan.tty) return "Resumed Codex session in previous iTerm tab.";
  if (plan.kind === "iterm-resume") return "Started iTerm Codex resume session.";
  return "Opened Codex Desktop session.";
}

async function executeJump(row, plan) {
  if (plan.kind === "iterm") return activateITermTty(plan.tty);
  if (plan.kind === "iterm-resume") return openITermCodexResume(plan.workspacePath, plan.threadId, plan.tty);

  return runDetached("open", [codexThreadDeeplink(row.sessionId)]);
}

function findLiveCodexTtyForWorkspace(workspacePath) {
  return findLiveCodexCliSessions()
    .find((session) => session.workspacePath === workspacePath)
    ?.tty;
}

function findLiveCodexCliSessions() {
  let output = "";
  try {
    output = execFileSync("ps", ["-axo", "pid=,tty=,comm=,args="], { encoding: "utf8" });
  } catch {
    return [];
  }

  const sessionsByTerminal = new Map();
  for (const line of output.split("\n")) {
    const processInfo = parseCodexProcessLine(line);
    if (!processInfo) continue;
    const cwd = processCwd(processInfo.pid);
    if (!cwd) continue;
    const sessionIds = unique([
      ...liveCliSessionIdsFromArgs(processInfo.args),
      ...liveCliSessionIdsFromOpenFiles(processInfo.pid),
    ]);
    const sessionId = selectLiveCliPrimarySessionId(processInfo.args, sessionIds);
    const key = `${cwd}\0${processInfo.tty}`;
    const existing = sessionsByTerminal.get(key);
    if (existing) {
      if (!existing.sessionId) existing.sessionId = sessionId;
      existing.sessionIds = unique([...existing.sessionIds, ...sessionIds]);
      continue;
    }
    sessionsByTerminal.set(key, {
      sessionId,
      sessionIds,
      workspacePath: cwd,
      tty: processInfo.tty,
    });
  }

  return [...sessionsByTerminal.values()].sort((left, right) =>
    left.workspacePath.localeCompare(right.workspacePath)
      || left.tty.localeCompare(right.tty)
      || String(left.sessionId ?? "").localeCompare(String(right.sessionId ?? "")),
  );
}

function findPreviousITermTtyForWorkspace(workspacePath) {
  const workspaceShellTtys = findShellTtysForWorkspace(workspacePath);
  if (workspaceShellTtys.size === 0) return undefined;

  return listITermSessions()
    .filter((session) => workspaceShellTtys.has(normalizeTty(session.tty)))
    .sort((a, b) => scoreITermSession(a) - scoreITermSession(b))
    .map((session) => normalizeTty(session.tty))[0];
}

function findShellTtysForWorkspace(workspacePath) {
  let output = "";
  try {
    output = execFileSync("ps", ["-axo", "pid=,tty=,comm=,args="], { encoding: "utf8" });
  } catch {
    return new Set();
  }

  const ttys = new Set();
  for (const line of output.split("\n")) {
    const shellInfo = parseShellProcessLine(line);
    if (!shellInfo) continue;
    const cwd = processCwd(shellInfo.pid);
    if (cwd === workspacePath) ttys.add(shellInfo.tty);
  }
  return ttys;
}

function listITermSessions() {
  const script = `set rows to {}
tell application id "com.googlecode.iterm2"
repeat with w in windows
repeat with t in tabs of w
repeat with s in sessions of t
try
set end of rows to ((tty of s as text) & tab & (name of s as text))
end try
end repeat
end repeat
end repeat
end tell
set AppleScript's text item delimiters to linefeed
return rows as text`;
  try {
    return execFileSync("osascript", ["-e", script], { encoding: "utf8" })
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [tty, name = ""] = line.split("\t");
        return { tty, name };
      });
  } catch {
    return [];
  }
}

export function parseCodexProcessLine(line) {
  const match = line.trim().match(/^(\d+)\s+(ttys\d+)\s+\S+\s+(.+)$/);
  if (!match) return undefined;
  const [, pid, tty, args] = match;
  if (!isCodexCliArgs(args)) return undefined;
  return { pid, tty, args };
}

function isCodexCliArgs(args) {
  if (args.includes(" app-server ")) return false;
  const executable = args.split(/\s+/).find(Boolean);
  if (!executable) return false;
  return path.basename(executable) === "codex";
}

function liveCliSessionIdFromArgs(args) {
  return liveCliSessionIdsFromArgs(args)[0];
}

function liveCliSessionIdsFromArgs(args) {
  const parts = args.split(/\s+/).filter(Boolean);
  const sessionIds = [];
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (part === "resume" || part === "--resume") {
      const candidate = parts[index + 1];
      if (looksLikeCodexSessionId(candidate)) sessionIds.push(candidate);
    }
    if (part.startsWith("--resume=")) {
      const candidate = part.slice("--resume=".length);
      if (looksLikeCodexSessionId(candidate)) sessionIds.push(candidate);
    }
  }
  return unique(sessionIds);
}

export function selectLiveCliPrimarySessionId(args, sessionIds) {
  const argsSessionId = liveCliSessionIdFromArgs(args);
  if (argsSessionId) return argsSessionId;
  return sessionIds.length === 1 ? sessionIds[0] : undefined;
}

function liveCliSessionIdsFromOpenFiles(pid) {
  let output = "";
  try {
    output = execFileSync("lsof", ["-p", pid], { encoding: "utf8" });
  } catch {
    return [];
  }

  return output
    .split("\n")
    .flatMap((line) => line.split(/\s+/))
    .filter((part) => part.includes("rollout-") && part.endsWith(".jsonl"))
    .map(sessionIdFromJsonlPath)
    .filter(Boolean)
    .filter((value, index, values) => values.indexOf(value) === index);
}

function sessionIdFromJsonlPath(filePath) {
  const fileName = path.basename(filePath);
  const stem = fileName.endsWith(".jsonl") ? fileName.slice(0, -".jsonl".length) : fileName;
  const parts = stem.split("-");
  const candidate = parts.length >= 5
    ? parts.slice(-5).join("-")
    : parts.at(-1);
  return looksLikeCodexSessionId(candidate) ? candidate : undefined;
}

function looksLikeCodexSessionId(value) {
  return typeof value === "string"
    && value.length >= 20
    && value.includes("-")
    && /^[0-9a-f-]+$/i.test(value);
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function parseShellProcessLine(line) {
  const match = line.trim().match(/^(\d+)\s+(ttys\d+)\s+(\S+)\s+.*$/);
  if (!match) return undefined;
  const [, pid, tty, comm] = match;
  const executable = path.basename(comm).replace(/^-/, "").toLowerCase();
  if (!["zsh", "bash", "fish"].includes(executable)) return undefined;
  return { pid, tty };
}

function normalizeTty(tty) {
  return tty.startsWith("/dev/") ? tty.slice("/dev/".length) : tty;
}

function scoreITermSession(session) {
  return session.name.toLowerCase().includes("codex") ? 0 : 1;
}

function processCwd(pid) {
  try {
    const output = execFileSync("lsof", ["-a", "-p", pid, "-d", "cwd", "-Fn"], { encoding: "utf8" });
    return output
      .split("\n")
      .find((line) => line.startsWith("n"))
      ?.slice(1);
  } catch {
    return undefined;
  }
}

function activateITermTty(tty) {
  const ttyPath = tty.startsWith("/dev/") ? tty : `/dev/${tty}`;
  const script = `with timeout of 3 seconds
tell application id "com.googlecode.iterm2"
activate
repeat with w in windows
repeat with t in tabs of w
repeat with s in sessions of t
try
set sessionTty to tty of s as text
if sessionTty is ${applescriptStringLiteral(tty)} or sessionTty is ${applescriptStringLiteral(ttyPath)} then
select w
select t
select s
return "activated"
end if
end try
end repeat
end repeat
end repeat
end tell
end timeout`;

  return runWithTimeout("osascript", ["-e", script], 4_000);
}

function openITermCodexResume(workspacePath, threadId, tty) {
  const command = `cd ${shellSingleQuote(workspacePath)} && codex resume ${shellSingleQuote(threadId)}`;
  const script = tty ? resumeInExistingITermScript(tty, command) : `with timeout of 5 seconds
tell application id "com.googlecode.iterm2"
activate
set newWindow to (create window with default profile)
tell current session of newWindow
write text ${applescriptStringLiteral(command)}
end tell
end tell
end timeout`;

  return runWithTimeout("osascript", ["-e", script], 6_000);
}

function resumeInExistingITermScript(tty, command) {
  const ttyPath = tty.startsWith("/dev/") ? tty : `/dev/${tty}`;
  return `with timeout of 5 seconds
tell application id "com.googlecode.iterm2"
activate
repeat with w in windows
repeat with t in tabs of w
repeat with s in sessions of t
try
set sessionTty to tty of s as text
if sessionTty is ${applescriptStringLiteral(tty)} or sessionTty is ${applescriptStringLiteral(ttyPath)} then
select w
select t
select s
write text ${applescriptStringLiteral(command)}
return "resumed"
end if
end try
end repeat
end repeat
end repeat
set newWindow to (create window with default profile)
tell current session of newWindow
write text ${applescriptStringLiteral(command)}
end tell
end tell
end timeout`;
}

function runDetached(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore",
    });
    child.on("error", reject);
    child.unref();
    resolve();
  });
}

function runWithTimeout(command, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "ignore" });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${command} timed out`));
    }, timeoutMs);

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} exited with ${code}`));
      }
    });
  });
}

function codexCliPath() {
  return "/Applications/Codex.app/Contents/Resources/codex";
}

function codexThreadDeeplink(threadId) {
  return `codex://threads/${threadId}`;
}

function activateITerm() {
  const script = `tell application id ${applescriptStringLiteral("com.googlecode.iterm2")} to activate`;
  return runDetached("osascript", ["-e", script]);
}

function applescriptStringLiteral(value) {
  return `"${String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function shellSingleQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}
