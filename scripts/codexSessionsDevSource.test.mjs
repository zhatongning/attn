import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCodexSessionsDevSource, discoverCodexSessions } from "./codexSessionsDevSource.mjs";

const tempDirs = [];
const earlyTrackingStartMs = Date.parse("2026-06-01T00:00:00.000Z");

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("codexSessionsDevSource", () => {
  it("uses immediate SQLite threads and JSONL completion evidence like the Tauri source", () => {
    const temp = tempDir();
    const stateDb = path.join(temp, "state_5.sqlite");
    const sessionDir = path.join(temp, "sessions", "2026", "06", "03");
    fs.mkdirSync(sessionDir, { recursive: true });
    const rolloutPath = path.join(sessionDir, "rollout-2026-06-03T10-00-00-019desktop.jsonl");
    fs.writeFileSync(
      rolloutPath,
      [
        '{"timestamp":"2026-06-03T02:00:00.000Z","type":"session_meta","payload":{"id":"019desktop","cwd":"/Users/edy/wmhcar","originator":"Codex Desktop","source":"vscode","agent_nickname":"Averroes"}}',
        '{"timestamp":"2026-06-03T02:01:00.000Z","type":"event_msg","payload":{"type":"user_message","message":"排查用车详情地图卡顿\\n"}}',
        '{"timestamp":"2026-06-03T02:20:00.000Z","type":"event_msg","payload":{"type":"task_complete"}}',
        "",
      ].join("\n"),
    );
    createThreadsTable(stateDb);
    insertThread({
      stateDb,
      id: "019desktop",
      rolloutPath,
      cwd: "/Users/edy/wmhcar",
      title: "",
      source: "vscode",
      threadSource: "user",
      preview: "SQLite preview should be second choice",
    });

    const rows = discoverCodexSessions({
      stateDbPath: stateDb,
      sessionsRoot: path.join(temp, "sessions"),
      nowMs: Date.parse("2026-06-03T02:23:00.000Z"),
      unreadCompletionTrackingStartMs: earlyTrackingStartMs,
      limit: 20,
      liveCliTtyForWorkspace: () => undefined,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sessionId: "019desktop",
      label: "SQLite preview should be second choice",
      agentName: "Averroes",
      projectName: "wmhcar",
      workspacePath: "/Users/edy/wmhcar",
      lastActivityAt: "2026-06-03T02:20:00.000Z",
      state: "inspect",
      confidence: "exact",
      statusReason: "completed task ready to inspect; open it to mark read",
      jumpAvailability: "exact",
      jumpTarget: "desktop",
    });
  });

  it("keeps unread completed sessions in inspect even after the old inspect window", () => {
    const temp = tempDir();
    const sessionDir = path.join(temp, "sessions", "2026", "06", "03");
    fs.mkdirSync(sessionDir, { recursive: true });
    const rolloutPath = path.join(sessionDir, "rollout-2026-06-03T10-00-00-019desktop-needed.jsonl");
    fs.writeFileSync(
      rolloutPath,
      [
        '{"timestamp":"2026-06-03T02:00:00.000Z","type":"session_meta","payload":{"id":"019desktop-needed","cwd":"/Users/edy/wmhcar","originator":"Codex Desktop","source":"vscode"}}',
        '{"timestamp":"2026-06-03T02:20:00.000Z","type":"event_msg","payload":{"type":"task_complete"}}',
        "",
      ].join("\n"),
    );

    const rows = discoverCodexSessions({
      stateDbPath: path.join(temp, "missing.sqlite"),
      sessionsRoot: path.join(temp, "sessions"),
      nowMs: Date.parse("2026-06-03T02:40:00.000Z"),
      unreadCompletionTrackingStartMs: earlyTrackingStartMs,
      limit: 20,
      liveCliTtyForWorkspace: () => undefined,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sessionId: "019desktop-needed",
      state: "inspect",
      confidence: "exact",
      statusReason: "completed task ready to inspect; open it to mark read",
    });
  });

  it("keeps old unread JSONL completion evidence in inspect", () => {
    const temp = tempDir();
    const sessionDir = path.join(temp, "sessions", "2026", "06", "03");
    fs.mkdirSync(sessionDir, { recursive: true });
    const rolloutPath = path.join(sessionDir, "rollout-2026-06-03T10-00-00-019desktop-old.jsonl");
    fs.writeFileSync(
      rolloutPath,
      [
        '{"timestamp":"2026-06-03T02:00:00.000Z","type":"session_meta","payload":{"id":"019desktop-old","cwd":"/Users/edy/wmhcar","originator":"Codex Desktop","source":"vscode"}}',
        '{"timestamp":"2026-06-03T02:20:00.000Z","type":"event_msg","payload":{"type":"task_complete"}}',
        "",
      ].join("\n"),
    );

    const rows = discoverCodexSessions({
      stateDbPath: path.join(temp, "missing.sqlite"),
      sessionsRoot: path.join(temp, "sessions"),
      nowMs: Date.parse("2026-06-03T06:00:00.000Z"),
      unreadCompletionTrackingStartMs: earlyTrackingStartMs,
      limit: 20,
      liveCliTtyForWorkspace: () => undefined,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sessionId: "019desktop-old",
      state: "inspect",
      confidence: "exact",
      statusReason: "completed task ready to inspect; open it to mark read",
    });
  });

  it("treats completion history before the default tracking baseline as idle", () => {
    const temp = tempDir();
    const sessionDir = path.join(temp, "sessions", "2026", "06", "03");
    fs.mkdirSync(sessionDir, { recursive: true });
    const rolloutPath = path.join(sessionDir, "rollout-2026-06-03T10-00-00-019history.jsonl");
    fs.writeFileSync(
      rolloutPath,
      [
        '{"timestamp":"2026-06-03T02:00:00.000Z","type":"session_meta","payload":{"id":"019history","cwd":"/Users/edy/wmhcar","originator":"Codex Desktop","source":"vscode"}}',
        '{"timestamp":"2026-06-03T02:20:00.000Z","type":"event_msg","payload":{"type":"task_complete"}}',
        "",
      ].join("\n"),
    );

    const rows = discoverCodexSessions({
      stateDbPath: path.join(temp, "missing.sqlite"),
      sessionsRoot: path.join(temp, "sessions"),
      nowMs: Date.parse("2026-06-05T08:00:00.000Z"),
      limit: 20,
      liveCliTtyForWorkspace: () => undefined,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sessionId: "019history",
      state: "idle",
      confidence: "inferred",
      statusReason: "completed task is no longer recent; idle until the next source signal",
    });
  });

  it("moves read completed sessions to needed for 30 minutes, then idle", async () => {
    const temp = tempDir();
    const stateDb = path.join(temp, "missing.sqlite");
    const sessionDir = path.join(temp, "sessions", "2026", "06", "03");
    fs.mkdirSync(sessionDir, { recursive: true });
    const rolloutPath = path.join(sessionDir, "rollout-2026-06-03T10-00-00-019read-window.jsonl");
    fs.writeFileSync(
      rolloutPath,
      [
        '{"timestamp":"2026-06-03T02:00:00.000Z","type":"session_meta","payload":{"id":"019read-window","cwd":"/Users/edy/wmhcar","originator":"Codex Desktop","source":"vscode"}}',
        '{"timestamp":"2026-06-03T02:20:00.000Z","type":"event_msg","payload":{"type":"task_complete"}}',
        "",
      ].join("\n"),
    );
    let nowMs = Date.parse("2026-06-03T06:00:00.000Z");
    const source = createCodexSessionsDevSource({
      stateDbPath: stateDb,
      sessionsRoot: path.join(temp, "sessions"),
      nowMs: () => nowMs,
      unreadCompletionTrackingStartMs: earlyTrackingStartMs,
      limit: 20,
      liveCliTtyForWorkspace: () => undefined,
      executeJump: async () => undefined,
    });

    expect(source.discoverCodexSessions()[0]).toMatchObject({
      sessionId: "019read-window",
      state: "inspect",
    });

    await source.jumpToSession("019read-window");
    expect(source.discoverCodexSessions()[0]).toMatchObject({
      sessionId: "019read-window",
      state: "needsAttention",
      statusReason: "Read recently; keep in needed state until 30 minutes pass.",
      handled: true,
    });

    nowMs = Date.parse("2026-06-03T06:31:00.000Z");
    expect(source.discoverCodexSessions()[0]).toMatchObject({
      sessionId: "019read-window",
      state: "idle",
      statusReason: "Read window expired; idle until the next source signal.",
      handled: true,
    });
  });

  it("treats old archived threads without completion evidence as idle instead of requiring attention", () => {
    const temp = tempDir();
    const stateDb = path.join(temp, "state_5.sqlite");
    const sessionDir = path.join(temp, "sessions", "2026", "05", "26");
    fs.mkdirSync(sessionDir, { recursive: true });
    const rolloutPath = path.join(sessionDir, "rollout-2026-05-26T15-00-00-019archived-old.jsonl");
    fs.writeFileSync(
      rolloutPath,
      [
        '{"timestamp":"2026-05-26T07:00:00.000Z","type":"session_meta","payload":{"id":"019archived-old","cwd":"/Users/edy/wmhcar","originator":"Codex Desktop","source":"vscode"}}',
        '{"timestamp":"2026-05-26T07:01:00.000Z","type":"event_msg","payload":{"type":"user_message","message":"构建发版分支\\n"}}',
        '{"timestamp":"2026-05-26T07:20:00.000Z","type":"event_msg","payload":{"type":"turn_aborted","reason":"interrupted"}}',
        "",
      ].join("\n"),
    );
    createThreadsTable(stateDb);
    insertThread({
      stateDb,
      id: "019archived-old",
      rolloutPath,
      cwd: "/Users/edy/wmhcar",
      title: "构建发版分支",
      source: "vscode",
      threadSource: "user",
      preview: "构建发版分支",
      updatedAtMs: Date.parse("2026-05-26T07:20:00.000Z"),
      archived: 1,
    });

    const rows = discoverCodexSessions({
      stateDbPath: stateDb,
      sessionsRoot: path.join(temp, "sessions"),
      nowMs: Date.parse("2026-06-05T08:00:00.000Z"),
      limit: 20,
      liveCliTtyForWorkspace: () => undefined,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sessionId: "019archived-old",
      state: "idle",
      confidence: "inferred",
      statusReason: "completed task is no longer recent; idle until the next source signal",
    });
  });

  it("treats a newer user message after task_complete as active work", () => {
    const temp = tempDir();
    const sessionDir = path.join(temp, "sessions", "2026", "06", "03");
    fs.mkdirSync(sessionDir, { recursive: true });
    const rolloutPath = path.join(sessionDir, "rollout-2026-06-03T10-00-00-019continued.jsonl");
    fs.writeFileSync(
      rolloutPath,
      [
        '{"timestamp":"2026-06-03T02:00:00.000Z","type":"session_meta","payload":{"id":"019continued","cwd":"/Users/edy/wmhcar","originator":"Codex CLI","source":"cli"}}',
        '{"timestamp":"2026-06-03T02:20:00.000Z","type":"event_msg","payload":{"type":"task_complete"}}',
        '{"timestamp":"2026-06-03T02:30:00.000Z","type":"event_msg","payload":{"type":"user_message","message":"继续\\n"}}',
        "",
      ].join("\n"),
    );

    const rows = discoverCodexSessions({
      stateDbPath: path.join(temp, "missing.sqlite"),
      sessionsRoot: path.join(temp, "sessions"),
      nowMs: Date.parse("2026-06-03T02:35:00.000Z"),
      unreadCompletionTrackingStartMs: earlyTrackingStartMs,
      limit: 20,
      liveCliTtyForWorkspace: () => undefined,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sessionId: "019continued",
      state: "running",
      statusReason: "running signal observed",
      lastActivityAt: "2026-06-03T02:30:00.000Z",
    });
  });

  it("treats stale unarchived Desktop threads as idle", () => {
    const temp = tempDir();
    const stateDb = path.join(temp, "state_5.sqlite");
    const sessionDir = path.join(temp, "sessions", "2026", "06", "03");
    fs.mkdirSync(sessionDir, { recursive: true });
    const rolloutPath = path.join(sessionDir, "rollout-2026-06-03T02-00-00-019stale.jsonl");
    fs.writeFileSync(
      rolloutPath,
      [
        '{"timestamp":"2026-06-03T02:00:00.000Z","type":"session_meta","payload":{"id":"019stale","cwd":"/Users/edy/wmmeal","originator":"Codex Desktop","source":"vscode"}}',
        "",
      ].join("\n"),
    );
    createThreadsTable(stateDb);
    insertThread({
      stateDb,
      id: "019stale",
      rolloutPath,
      cwd: "/Users/edy/wmmeal",
      title: "update the dep @hosemall/mall-component@2.7.44",
      source: "vscode",
      threadSource: "user",
      preview: "update the dep @hosemall/mall-component@2.7.44",
      updatedAtMs: Date.parse("2026-06-03T02:00:00.000Z"),
    });

    const rows = discoverCodexSessions({
      stateDbPath: stateDb,
      sessionsRoot: path.join(temp, "sessions"),
      nowMs: Date.parse("2026-06-03T06:00:00.000Z"),
      limit: 20,
      liveCliTtyForWorkspace: () => undefined,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sessionId: "019stale",
      state: "idle",
      statusReason: "no recent activity observed; idle until the next source signal",
    });
  });
});

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-source-"));
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
  updatedAtMs = 1780453200000,
  archived = 0,
}) {
  execFileSync("sqlite3", [
    stateDb,
    `insert into threads (id, rollout_path, created_at, updated_at, source, model_provider, cwd, title, sandbox_policy, approval_mode, updated_at_ms, thread_source, preview, archived)
     values (${sql(id)}, ${sql(rolloutPath)}, 1780452000, 1780453200, ${sql(source)}, 'OpenAI', ${sql(cwd)}, ${sql(title)}, '{"type":"disabled"}', 'never', ${updatedAtMs}, ${sql(threadSource)}, ${sql(preview)}, ${archived});`,
  ]);
}

function sql(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}
