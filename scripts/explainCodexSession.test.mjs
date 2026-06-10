import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { explainCodexSession } from "./explainCodexSession.mjs";

const tempDirs = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("explainCodexSession", () => {
  it("reports completion, sqlite update, inferred state, and reason for a session", () => {
    const temp = tempDir();
    const stateDb = path.join(temp, "state_5.sqlite");
    const sessionsRoot = path.join(temp, "sessions");
    const sessionDir = path.join(sessionsRoot, "2026", "06", "06");
    fs.mkdirSync(sessionDir, { recursive: true });
    const rolloutPath = path.join(sessionDir, "rollout-2026-06-06T12-00-00-019explain.jsonl");
    fs.writeFileSync(
      rolloutPath,
      [
        '{"timestamp":"2026-06-06T04:00:00.000Z","type":"session_meta","payload":{"id":"019explain","cwd":"/Users/edy/project","originator":"Codex Desktop","source":"vscode"}}',
        '{"timestamp":"2026-06-06T04:05:00.000Z","type":"event_msg","payload":{"type":"task_complete"}}',
        "",
      ].join("\n"),
    );
    createThreadsTable(stateDb);
    insertThread({
      stateDb,
      id: "019explain",
      rolloutPath,
      cwd: "/Users/edy/project",
      title: "Explain this state",
      source: "vscode",
      threadSource: "user",
      preview: "Explain this state",
      updatedAtMs: Date.parse("2026-06-06T04:10:00.000Z"),
    });

    const explanation = explainCodexSession("019explain", {
      stateDbPath: stateDb,
      sessionsRoot,
      nowMs: Date.parse("2026-06-06T04:20:00.000Z"),
      liveCliTtyForWorkspace: () => undefined,
    });

    expect(explanation).toMatchObject({
      sessionId: "019explain",
      title: "Explain this state",
      workspacePath: "/Users/edy/project",
      rolloutPath,
      taskCompleteAt: "2026-06-06T04:05:00.000Z",
      sqliteUpdatedAt: "2026-06-06T04:10:00.000Z",
      sqliteUpdatedAfterTaskComplete: true,
      state: "needsAttention",
      statusReason: "completed task still needs your attention",
      evidenceSummary: "local Codex JSONL activity observed",
    });
  });

  it("reports whether Attn has acknowledged the current source signal", () => {
    const temp = tempDir();
    const stateDb = path.join(temp, "state_5.sqlite");
    const sessionsRoot = path.join(temp, "sessions");
    const appStateDir = path.join(temp, "agent-session-inbox");
    const sessionDir = path.join(sessionsRoot, "2026", "06", "06");
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.mkdirSync(appStateDir, { recursive: true });
    const rolloutPath = path.join(sessionDir, "rollout-2026-06-06T12-00-00-019ack.jsonl");
    fs.writeFileSync(
      rolloutPath,
      [
        '{"timestamp":"2026-06-06T04:00:00.000Z","type":"session_meta","payload":{"id":"019ack","cwd":"/Users/edy/project","originator":"Codex Desktop","source":"vscode"}}',
        '{"timestamp":"2026-06-06T04:05:00.000Z","type":"event_msg","payload":{"type":"task_complete"}}',
        "",
      ].join("\n"),
    );
    fs.writeFileSync(
      path.join(appStateDir, "acknowledged-signals.json"),
      JSON.stringify([
        {
          session_id: "019ack",
          last_activity_at: "2026-06-06T04:05:00.000Z",
          acknowledged_at_ms: Date.parse("2026-06-06T04:10:00.000Z"),
        },
      ]),
    );
    createThreadsTable(stateDb);
    insertThread({
      stateDb,
      id: "019ack",
      rolloutPath,
      cwd: "/Users/edy/project",
      title: "Acknowledged session",
      source: "vscode",
      threadSource: "user",
      preview: "Acknowledged session",
      updatedAtMs: Date.parse("2026-06-06T04:05:00.000Z"),
    });

    const explanation = explainCodexSession("019ack", {
      stateDbPath: stateDb,
      sessionsRoot,
      appStateDir,
      nowMs: Date.parse("2026-06-06T04:20:00.000Z"),
      liveCliTtyForWorkspace: () => undefined,
    });

    expect(explanation).toMatchObject({
      attnAcknowledgedSignal: true,
      attnAcknowledgedAt: "2026-06-06T04:10:00.000Z",
    });
  });
});

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-explain-"));
  tempDirs.push(dir);
  return dir;
}

function createThreadsTable(stateDb) {
  execFileSync("sqlite3", [
    stateDb,
    "create table threads (id text primary key, rollout_path text not null, created_at integer not null, updated_at integer not null, source text not null, model_provider text not null, cwd text not null, title text not null, sandbox_policy text not null, approval_mode text not null, tokens_used integer not null default 0, has_user_event integer not null default 0, archived integer not null default 0, archived_at integer, git_sha text, git_branch text, git_origin_url text, cli_version text not null default '', first_user_message text not null default '', agent_nickname text, agent_role text, memory_mode text not null default 'enabled', model text, reasoning_effort text, agent_path text, created_at_ms integer, updated_at_ms integer, thread_source text, preview text not null default '');",
  ]);
}

function insertThread({
  stateDb,
  id,
  rolloutPath,
  cwd,
  title,
  source,
  threadSource,
  preview,
  updatedAtMs,
}) {
  execFileSync("sqlite3", [
    stateDb,
    `insert into threads (id, rollout_path, created_at, updated_at, source, model_provider, cwd, title, sandbox_policy, approval_mode, updated_at_ms, thread_source, preview)
     values (${sql(id)}, ${sql(rolloutPath)}, 1780718400, 1780718700, ${sql(source)}, 'OpenAI', ${sql(cwd)}, ${sql(title)}, '{"type":"disabled"}', 'never', ${updatedAtMs}, ${sql(threadSource)}, ${sql(preview)});`,
  ]);
}

function sql(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}
