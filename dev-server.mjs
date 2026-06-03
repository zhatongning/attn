import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn, spawnSync } from "node:child_process";

const port = 1420;
const root = process.cwd();

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);

  if (url.pathname === "/api/sessions") {
    return sendJson(res, discoverCodexSessions());
  }

  if (url.pathname === "/api/source-health") {
    const sessionsRoot = codexSessionsRoot();
    return sendJson(res, {
      sourceName: "Codex desktop",
      status: fs.existsSync(sessionsRoot) ? "available" : "unknown",
      capabilities: [
        {
          name: "Thread discovery",
          availability: fs.existsSync(codexStateDbPath()) ? "inferred" : "unavailable",
          detail: `Reads local Codex thread state from ${codexStateDbPath()}.`,
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
            "Routes Jump back to Codex Desktop, a live iTerm Codex session, or a Terminal resume fallback.",
        },
      ],
    });
  }

  if (url.pathname === "/api/jump" && req.method === "POST") {
    return readJsonBody(req)
      .then(({ sessionId }) => jumpToSession(sessionId))
      .then((result) => sendJson(res, result))
      .catch((error) => {
        res.statusCode = 500;
        sendJson(res, {
          sessionId: "",
          availability: "unavailable",
          target: "unknown",
          message: error instanceof Error ? error.message : "Jump command failed.",
        });
      });
  }

  const filePath = staticFilePath(url.pathname);
  if (!filePath) {
    res.statusCode = 404;
    return res.end("Not found");
  }

  res.statusCode = 200;
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", contentType(filePath));
  fs.createReadStream(filePath).pipe(res);
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Agent Session Inbox preview: http://127.0.0.1:${port}/`);
});

function staticFilePath(pathname) {
  if (pathname === "/") return existingFile(path.join(root, "dist", "index.html"), path.join(root, "index.html"));

  const normalized = path.normalize(pathname).replace(/^(\.\.[/\\])+/, "");
  const candidates = [
    path.join(root, "dist", normalized),
    path.join(root, normalized),
    path.join(root, "src", normalized.replace(/^\/src\//, "")),
    path.join(root, "public", normalized),
  ];

  return candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
}

function existingFile(...candidates) {
  return candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
}

function contentType(filePath) {
  if (filePath.endsWith(".html")) return "text/html";
  if (filePath.endsWith(".tsx") || filePath.endsWith(".ts") || filePath.endsWith(".js")) {
    return "application/javascript";
  }
  if (filePath.endsWith(".css")) return "text/css";
  if (filePath.endsWith(".svg")) return "image/svg+xml";
  return "application/octet-stream";
}

function sendJson(res, payload) {
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(payload));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function codexSessionsRoot() {
  return path.join(os.homedir(), ".codex", "sessions");
}

function codexStateDbPath() {
  return path.join(os.homedir(), ".codex", "state_5.sqlite");
}

function discoverCodexSessions() {
  const threadRows = discoverCodexThreads();
  if (threadRows.length > 0) return threadRows;

  const files = collectJsonlFiles(codexSessionsRoot())
    .sort((left, right) => right.modifiedAt - left.modifiedAt)
    .slice(0, 80);

  return files.map((file) => parseSessionFile(file.path)).filter(Boolean);
}

function discoverCodexThreads() {
  const stateDb = codexStateDbPath();
  if (!fs.existsSync(stateDb)) return [];

  const query = `select json_object(
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
  ) from threads order by coalesce(updated_at_ms, updated_at * 1000) desc limit 80;`;
  const result = spawnSync("sqlite3", ["-batch", "-readonly", stateDb, query], { encoding: "utf8" });
  if (result.status !== 0) return [];

  return result.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => parseThreadRow(line))
    .filter(Boolean);
}

function parseThreadRow(line) {
  let thread;
  try {
    thread = JSON.parse(line);
  } catch {
    return null;
  }

  const jsonl = typeof thread.rollout_path === "string" ? parseSessionFile(thread.rollout_path) : null;
  const workspacePath = thread.cwd || jsonl?.workspacePath;
  const jumpTarget = jsonl?.jumpTarget ?? jumpTargetFromThreadSource(thread);
  const archived = Number(thread.archived) !== 0;
  const state = archived ? jsonl?.state ?? "dismissable" : jumpTarget === "desktop" ? "running" : jsonl?.state ?? "unknown";
  const workspaceName = workspacePath ? path.basename(workspacePath) : undefined;
  const label = firstNonEmpty(thread.title, thread.preview, workspaceName ? `Codex: ${workspaceName}` : undefined, `Codex session ${thread.id}`);
  const lastActivityAt = jsonl?.lastActivityAt ?? timestampMsToIsoUtc(Number(thread.updated_at_ms));
  const jumpAvailability = workspacePath ? jumpTarget === "desktop" ? "exact" : "approximate" : "unavailable";

  return {
    sessionId: thread.id,
    label: truncate(label, 120),
    workspacePath,
    lastActivityAt,
    state,
    confidence: "inferred",
    statusReason:
      state === "running"
        ? "Active Codex thread observed in local SQLite state."
        : jsonl?.statusReason ?? "Codex thread observed in local SQLite state.",
    dismissabilityReason:
      state === "dismissable"
        ? "Completed row can be manually dismissed."
        : state === "unknown"
          ? "Unknown rows are never auto-dismissable."
          : "Row is not in a dismissable state.",
    handled: false,
    dismissed: false,
    jumpAvailability,
    jumpTarget,
    evidenceSummary: jsonl?.evidenceSummary ?? thread.preview,
    agentName: firstNonEmpty(thread.agent_nickname, thread.thread_source, thread.source),
    projectName: workspaceName,
  };
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

function parseSessionFile(filePath) {
  let sessionId;
  let workspacePath;
  let jumpTarget = "unknown";
  let lastActivityAt;
  let completed = false;
  let lastMessage;

  for (const line of fs.readFileSync(filePath, "utf8").split("\n")) {
    if (!line.trim()) continue;

    let value;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }

    if (typeof value.timestamp === "string") lastActivityAt = value.timestamp;
    if (value.type === "session_meta") {
      sessionId = value.payload?.id ?? sessionId;
      workspacePath = value.payload?.cwd ?? workspacePath;
      jumpTarget = jumpTargetFromSessionMeta(value.payload) ?? jumpTarget;
    }
    if (value.type === "event_msg" && value.payload?.type === "task_complete") completed = true;
    if (value.type === "event_msg" && typeof value.payload?.message === "string") {
      lastMessage = value.payload.message;
    }
  }

  sessionId ??= path.basename(filePath, ".jsonl").split("-").at(-1);
  if (!sessionId) return null;

  const recent = lastActivityAt ? Date.now() - Date.parse(lastActivityAt) <= 2 * 60 * 60 * 1000 : false;
  const liveCliTty = !completed && !recent && workspacePath && jumpTarget === "cli"
    ? findLiveCodexTtyForWorkspace(workspacePath)
    : undefined;
  const state = completed ? "dismissable" : recent || liveCliTty ? "running" : "unknown";
  const workspaceName = workspacePath ? path.basename(workspacePath) : undefined;
  const jumpAvailability = workspacePath ? jumpTarget === "desktop" ? "exact" : "approximate" : "unavailable";

  return {
    sessionId,
    label: workspaceName ? `Codex: ${workspaceName}` : `Codex session ${sessionId}`,
    workspacePath,
    lastActivityAt,
    state,
    confidence: completed || recent || liveCliTty ? "inferred" : "unknown",
    statusReason: completed
      ? "Task completion event observed in local Codex JSONL."
      : liveCliTty
        ? `Live Codex CLI process observed on ${liveCliTty}.`
      : recent
        ? "Recent local Codex JSONL activity observed."
        : "No recent completion or activity signal found.",
    dismissabilityReason:
      state === "dismissable"
        ? "Completed row can be manually dismissed."
        : state === "unknown"
          ? "Unknown rows are never auto-dismissable."
          : "Row is not in a dismissable state.",
    handled: false,
    dismissed: false,
    jumpAvailability,
    jumpTarget,
    evidenceSummary: lastMessage?.slice(0, 120),
  };
}

function jumpTargetFromSessionMeta(payload) {
  const originator = typeof payload?.originator === "string" ? payload.originator : "";
  const source = typeof payload?.source === "string" ? payload.source : "";
  const normalized = `${originator} ${source}`.toLowerCase();
  if (!normalized.trim()) return undefined;
  if (normalized.includes("desktop")) return "desktop";
  if (normalized.includes("cli") || normalized.includes("terminal") || normalized.includes("tui")) return "cli";
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

function truncate(value, maxLength) {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

async function jumpToSession(sessionId) {
  const row = discoverCodexSessions().find((session) => session.sessionId === sessionId);
  if (!row || !row.workspacePath) {
    return {
      sessionId: sessionId ?? "",
      availability: "unavailable",
      target: row?.jumpTarget ?? "unknown",
      message: "Jump-back unavailable: missing reliable target signal.",
    };
  }

  const plan = buildJumpPlan(row);
  await executeJump(row, plan);

  return {
    sessionId,
    availability: row.jumpAvailability,
    target: row.jumpTarget,
    message: jumpMessage(plan),
  };
}

function executeJump(row, plan) {
  if (plan.kind === "desktop") {
    return runDetached("open", [codexThreadDeeplink(row.sessionId)])
      .catch(() => runDetached(codexCliPath(), ["app", row.workspacePath]))
      .then(() => activateCodexDesktop());
  }
  if (plan.kind === "iterm") return activateITermTty(plan.tty);

  const command = `${shellQuote(codexCliPath())} resume ${shellQuote(row.sessionId)} --cd ${shellQuote(row.workspacePath)}`;
  const script = `tell application "Terminal"\nactivate\ndo script ${applescriptStringLiteral(command)}\nend tell`;
  return runDetached("osascript", ["-e", script]);
}

function buildJumpPlan(row) {
  if (row.jumpTarget === "desktop" || row.jumpTarget === "unknown") return { kind: "desktop" };

  const liveTty = findLiveCodexTtyForWorkspace(row.workspacePath);
  if (liveTty) return { kind: "iterm", tty: liveTty };
  return { kind: "terminal-resume" };
}

function jumpMessage(plan) {
  if (plan.kind === "iterm") return "Focused live iTerm Codex session.";
  if (plan.kind === "terminal-resume") return "Opened Terminal resume command.";
  return "Opened Codex Desktop session.";
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
  // TODO: Add Warp live terminal targeting once its scriptability/API is defined.
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

function activateCodexDesktop() {
  const script = `tell application id ${applescriptStringLiteral(codexBundleId())} to activate`;
  return runDetached("osascript", ["-e", script]);
}

function activateITerm() {
  const script = `tell application id ${applescriptStringLiteral("com.googlecode.iterm2")} to activate`;
  return runDetached("osascript", ["-e", script]);
}

function codexBundleId() {
  return "com.openai.codex";
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function applescriptStringLiteral(value) {
  return `"${String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}
