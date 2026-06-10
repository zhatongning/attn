import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { discoverCodexSessions } from "./codexSessionsDevSource.mjs";

export function explainCodexSession(
  sessionId,
  {
    stateDbPath = defaultCodexStateDbPath(),
    sessionsRoot = defaultCodexSessionsRoot(),
    appStateDir = defaultAttnStateDir(),
    nowMs = Date.now(),
    liveCliTtyForWorkspace,
  } = {},
) {
  const thread = readThreadById(stateDbPath, sessionId);
  if (!thread) {
    return {
      sessionId,
      found: false,
      error: `Session ${sessionId} was not found in ${stateDbPath}.`,
    };
  }

  const taskCompleteAt = readTaskCompleteAt(thread.rolloutPath);
  const row = discoverCodexSessions({
    stateDbPath,
    sessionsRoot,
    nowMs,
    limit: 200,
    liveCliTtyForWorkspace,
  }).find((candidate) => candidate.sessionId === sessionId);
  const sqliteUpdatedAt = isoFromMs(thread.updatedAtMs);
  const acknowledgedSignal = findAcknowledgedSignal(appStateDir, sessionId, row?.lastActivityAt);

  return {
    sessionId,
    found: true,
    title: thread.title,
    workspacePath: thread.cwd,
    rolloutPath: thread.rolloutPath,
    source: thread.source,
    threadSource: thread.threadSource,
    archived: Boolean(thread.archived),
    sqliteUpdatedAt,
    sqliteUpdatedAtMs: thread.updatedAtMs,
    taskCompleteAt,
    sqliteUpdatedAfterTaskComplete: Boolean(
      sqliteUpdatedAt && taskCompleteAt && Date.parse(sqliteUpdatedAt) > Date.parse(taskCompleteAt),
    ),
    attnAcknowledgedSignal: Boolean(acknowledgedSignal),
    attnAcknowledgedAt: isoFromMs(acknowledgedSignal?.acknowledged_at_ms),
    state: row?.state,
    confidence: row?.confidence,
    statusReason: row?.statusReason,
    lastActivityAt: row?.lastActivityAt,
    jumpTarget: row?.jumpTarget,
    jumpAvailability: row?.jumpAvailability,
    evidenceSummary: row?.evidenceSummary,
  };
}

function findAcknowledgedSignal(appStateDir, sessionId, lastActivityAt) {
  const pathToSignals = path.join(appStateDir, "acknowledged-signals.json");
  if (!fs.existsSync(pathToSignals)) return undefined;
  try {
    const signals = JSON.parse(fs.readFileSync(pathToSignals, "utf8"));
    if (!Array.isArray(signals)) return undefined;
    return signals.find((signal) => {
      return signal?.session_id === sessionId && signal?.last_activity_at === lastActivityAt;
    });
  } catch {
    return undefined;
  }
}

function readThreadById(stateDbPath, sessionId) {
  if (!fs.existsSync(stateDbPath)) return null;
  const query = `${threadSummaryJsonSelect()} from threads where id = '${sqliteStringLiteral(sessionId)}' limit 1;`;
  const output = execFileSync("sqlite3", ["-batch", "-readonly", stateDbPath, query], {
    encoding: "utf8",
  }).trim();
  if (!output) return null;

  const value = JSON.parse(output);
  return {
    id: value.id,
    rolloutPath: value.rollout_path,
    updatedAtMs: value.updated_at_ms,
    source: value.source,
    cwd: value.cwd,
    title: value.title,
    archived: value.archived,
    threadSource: value.thread_source,
    preview: value.preview,
  };
}

function readTaskCompleteAt(rolloutPath) {
  if (!rolloutPath || !fs.existsSync(rolloutPath)) return undefined;

  let taskCompleteAt;
  for (const line of fs.readFileSync(rolloutPath, "utf8").split("\n")) {
    if (!line.includes('"task_complete"')) continue;
    try {
      const value = JSON.parse(line);
      if (value.type === "event_msg" && value.payload?.type === "task_complete") {
        taskCompleteAt = value.timestamp;
      }
    } catch {
      // Ignore malformed historical lines; the debug report should still return other evidence.
    }
  }
  return taskCompleteAt;
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
    'thread_source', thread_source,
    'preview', preview
  )`;
}

function sqliteStringLiteral(value) {
  return String(value).replaceAll("'", "''");
}

function isoFromMs(value) {
  if (typeof value !== "number") return undefined;
  return new Date(value).toISOString();
}

function defaultCodexStateDbPath() {
  return path.join(os.homedir(), ".codex", "state_5.sqlite");
}

function defaultCodexSessionsRoot() {
  return path.join(os.homedir(), ".codex", "sessions");
}

function defaultAttnStateDir() {
  return path.join(os.homedir(), ".codex", "agent-session-inbox");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const sessionId = process.argv[2];
  if (!sessionId) {
    console.error("Usage: npm run explain:session -- <session-id>");
    process.exit(2);
  }
  console.log(JSON.stringify(explainCodexSession(sessionId), null, 2));
}
