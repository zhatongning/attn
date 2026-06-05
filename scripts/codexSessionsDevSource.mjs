import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const defaultUnreadCompletionTrackingStartMs = Date.parse("2026-06-05T08:00:00.000Z");
const defaultDevSource = createCodexSessionsDevSource();

export function defaultCodexSessionsRoot() {
  return path.join(os.homedir(), ".codex", "sessions");
}

export function defaultCodexStateDbPath() {
  return path.join(os.homedir(), ".codex", "state_5.sqlite");
}

export function sourceHealth({
  stateDbPath = defaultCodexStateDbPath(),
  sessionsRoot = defaultCodexSessionsRoot(),
} = {}) {
  return {
    sourceName: "Codex desktop",
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
          "Routes Jump back to Codex Desktop or a live iTerm Codex session.",
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
  liveCliTtyForWorkspace = findLiveCodexTtyForWorkspace,
} = {}) {
  if (arguments.length === 0) return defaultDevSource.discoverCodexSessions();

  const threadRows = discoverCodexThreads({
    stateDbPath,
    limit,
    nowMs,
    unreadCompletionTrackingStartMs: trackingStartMs,
    liveCliTtyForWorkspace,
  });
  if (threadRows.length > 0) return threadRows;

  return collectJsonlFiles(sessionsRoot)
    .sort((left, right) => right.modifiedAt - left.modifiedAt)
    .slice(0, limit)
    .map((file) => parseSessionFile(file.path, { nowMs, unreadCompletionTrackingStartMs: trackingStartMs }))
    .filter(Boolean)
    .map((observation) => toSessionRow(observation, liveCliTtyForWorkspace));
}

export function discoverCodexThreadById(sessionId, {
  stateDbPath = defaultCodexStateDbPath(),
  nowMs = Date.now(),
  unreadCompletionTrackingStartMs: trackingStartMs = defaultUnreadCompletionTrackingStartMs,
  liveCliTtyForWorkspace = findLiveCodexTtyForWorkspace,
} = {}) {
  if (!fs.existsSync(stateDbPath)) return null;

  const query = `${threadSummaryJsonSelect()} from threads where id = '${sqliteStringLiteral(sessionId)}' limit 1;`;
  const result = spawnSync("sqlite3", ["-batch", "-readonly", stateDbPath, query], { encoding: "utf8" });
  if (result.status !== 0) return null;

  return result.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => parseThreadRow(line, { nowMs, unreadCompletionTrackingStartMs: trackingStartMs, liveCliTtyForWorkspace }))
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

  const plan = buildJumpPlan(row);
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

function discoverCodexThreads({ stateDbPath, limit, nowMs, unreadCompletionTrackingStartMs, liveCliTtyForWorkspace }) {
  if (!fs.existsSync(stateDbPath)) return [];

  const query = `${threadSummaryJsonSelect()} from threads order by coalesce(updated_at_ms, updated_at * 1000) desc limit ${limit};`;
  const result = spawnSync("sqlite3", ["-batch", "-readonly", stateDbPath, query], { encoding: "utf8" });
  if (result.status !== 0) return [];

  return result.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => parseThreadRow(line, { nowMs, unreadCompletionTrackingStartMs, liveCliTtyForWorkspace }))
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

function parseThreadRow(line, { nowMs, unreadCompletionTrackingStartMs, liveCliTtyForWorkspace }) {
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
  const archived = Number(thread.archived) !== 0;
  const lastActivityAt = lastActivityAtFromThread(thread, jsonlObservation);
  const hasRecentActivity = lastActivityAt
    ? nowMs - Date.parse(lastActivityAt) <= 2 * 60 * 60 * 1000
    : false;
  const archivedCompletionKind = completionKindFromLastActivityAt(lastActivityAt, nowMs);
  const kind = terminalOrInputKind(jsonlKind)
    ? jsonlKind
    : archived
      ? archivedCompletionKind
      : jumpTarget === "desktop" && hasRecentActivity
        ? "running"
        : jumpTarget === "desktop"
          ? "idle"
          : jsonlKind ?? "insufficientEvidence";
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
    projectName: workspaceName,
    workspacePath,
    lastActivityAt,
    evidenceSummary: jsonlObservation?.evidenceSummary ?? thread.preview,
    jumpTarget,
  }, liveCliTtyForWorkspace);
}

function lastActivityAtFromThread(thread, jsonlObservation) {
  return jsonlObservation?.lastActivityAt ?? timestampMsToIsoUtc(Number(thread.updated_at_ms));
}

function terminalOrInputKind(kind) {
  return kind === "completedImmediate"
    || kind === "completed"
    || kind === "completedStale"
    || kind === "failed"
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
  let workspacePath;
  let agentName;
  let sessionName;
  let jumpTarget = "unknown";
  let lastActivityAt;
  let lastActivityKind = "insufficientEvidence";
  let lastMessage;

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
      workspacePath = value.payload?.cwd ?? workspacePath;
      agentName = firstNonEmpty(value.payload?.agent_nickname, value.payload?.originator, agentName);
      jumpTarget = jumpTargetFromSessionMeta(value.payload) ?? jumpTarget;
    }

    if (value.type === "event_msg") {
      const eventType = value.payload?.type;
      if (eventType === "task_complete") {
        lastActivityKind = "completed";
      } else if (eventType === "user_message" || eventType === "agent_message") {
        lastActivityKind = "running";
      }
      if (typeof value.payload?.message === "string") {
        if (eventType === "user_message" && !sessionName) {
          sessionName = truncate(value.payload.message.trim(), 120);
        } else {
          lastMessage = value.payload.message;
        }
      }
    }
  }

  sessionId ??= path.basename(filePath, ".jsonl").split("-").at(-1);
  if (!sessionId) return null;

  const ageMs = lastActivityAt ? nowMs - Date.parse(lastActivityAt) : Number.POSITIVE_INFINITY;
  const recent = ageMs <= 2 * 60 * 60 * 1000;
  const kind = lastActivityKind === "completed"
    ? lastActivityAt && Date.parse(lastActivityAt) >= unreadCompletionTrackingStartMs
      ? "completedImmediate"
      : "completedStale"
    : lastActivityKind === "running" && recent
      ? "running"
      : recent
        ? "running"
        : "insufficientEvidence";
  const projectName = workspacePath ? path.basename(workspacePath) : undefined;
  const label = firstNonEmpty(sessionName, projectName ? `Codex: ${projectName}` : undefined, `Codex session ${sessionId}`);

  return {
    sessionId,
    kind,
    label,
    agentName,
    projectName,
    workspacePath,
    lastActivityAt,
    evidenceSummary: lastMessage ? truncate(lastMessage, 120) : "local Codex JSONL activity observed",
    jumpTarget,
  };
}

function toSessionRow(observation, liveCliTtyForWorkspace) {
  const classified = classifyObservation(observation);
  const row = applyLiveCliActivitySignal(classified, liveCliTtyForWorkspace);
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
    projectName: emptyToUndefined(observation.projectName),
    workspacePath: observation.workspacePath,
    lastActivityAt: emptyToUndefined(observation.lastActivityAt),
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
    return { state: "needsAttention", confidence: "exact", reason: "waiting for user input" };
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
      reason: "completed task still needs your attention",
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
  return {
    state: "unknown",
    confidence: "unknown",
    reason: "missing source evidence for status classification",
  };
}

function applyLiveCliActivitySignal(row, liveCliTtyForWorkspace) {
  if (row.state !== "unknown" || row.jumpTarget !== "cli" || !row.workspacePath) return row;

  const tty = liveCliTtyForWorkspace(row.workspacePath);
  if (!tty) return row;

  return {
    ...row,
    state: "running",
    confidence: "inferred",
    statusReason: `Live Codex CLI process observed on ${tty}.`,
  };
}

function applyAcknowledgedSessionState(row, acknowledgedSignals, nowMs = Date.now()) {
  if (!acknowledgedSignals.has(acknowledgedSignal(row))) return row;
  if (row.state === "running") return row;
  if (row.state === "idle") return row;

  const acknowledgedAtMs = acknowledgedSignals.get(acknowledgedSignal(row));
  if (typeof acknowledgedAtMs === "number" && nowMs - acknowledgedAtMs <= 30 * 60 * 1000) {
    return {
      ...row,
      state: "needsAttention",
      confidence: "exact",
      statusReason: "Read recently; keep in needed state until 30 minutes pass.",
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

function buildJumpPlan(row) {
  if (row.jumpTarget === "desktop" || row.jumpTarget === "unknown") return { kind: "desktop" };

  const liveTty = findLiveCodexTtyForWorkspace(row.workspacePath);
  if (liveTty) return { kind: "iterm", tty: liveTty };
  return { kind: "desktop" };
}

function jumpMessage(plan) {
  if (plan.kind === "iterm") return "Focused live iTerm Codex session.";
  return "Opened Codex Desktop session.";
}

async function executeJump(row, plan) {
  if (plan.kind === "iterm") return activateITermTty(plan.tty);

  return runDetached("open", [codexThreadDeeplink(row.sessionId)]);
}

function findLiveCodexTtyForWorkspace(workspacePath) {
  let output = "";
  try {
    output = execFileSync("ps", ["-axo", "pid=,tty=,comm=,args="], { encoding: "utf8" });
  } catch {
    return undefined;
  }

  for (const line of output.split("\n")) {
    const processInfo = parseCodexProcessLine(line);
    if (!processInfo) continue;
    const cwd = processCwd(processInfo.pid);
    if (cwd === workspacePath) return processInfo.tty;
  }

  return undefined;
}

function parseCodexProcessLine(line) {
  const match = line.trim().match(/^(\d+)\s+(ttys\d+)\s+\S+\s+(.+)$/);
  if (!match) return undefined;
  const [, pid, tty, args] = match;
  if (!args.includes("codex") || args.includes(" app-server ")) return undefined;
  return { pid, tty };
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

  return runWithTimeout("osascript", ["-e", script], 4_000).catch(() => activateITerm());
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
