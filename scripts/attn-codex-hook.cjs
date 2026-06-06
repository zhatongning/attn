#!/usr/bin/env node

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const hookEventName = process.argv[2] || process.env.CODEX_HOOK_EVENT_NAME || "Unknown";
const outputPath =
  process.env.ATTN_HOOK_EVENTS_PATH ||
  path.join(os.homedir(), ".codex", "agent-session-inbox", "hook-events.jsonl");

function readHookInput() {
  try {
    const input = fs.readFileSync(0, "utf8").trim();
    return input ? JSON.parse(input) : {};
  } catch {
    return {};
  }
}

function firstString(...values) {
  return values.find((value) => typeof value === "string" && value.trim() !== "");
}

const input = readHookInput();
const event = {
  schemaVersion: 1,
  timestamp: new Date().toISOString(),
  source: "codex-hook",
  eventType: firstString(
    input.eventType,
    input.hookEventName,
    input.hook_event_name,
    hookEventName,
  ),
  sessionId: firstString(
    input.sessionId,
    input.session_id,
    input.threadId,
    input.thread_id,
    input.conversationId,
    input.conversation_id,
  ),
  workspacePath: firstString(
    input.workspacePath,
    input.workspace_path,
    input.cwd,
    input.project_dir,
    input.projectDir,
  ),
  toolName: firstString(input.toolName, input.tool_name),
};

try {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.appendFileSync(outputPath, `${JSON.stringify(event)}\n`, "utf8");
} catch (error) {
  console.error(`Attn hook write failed: ${error.message}`);
  process.exitCode = 1;
}
