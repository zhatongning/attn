import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createCodexSessionsDevSource,
  defaultCodexStateDbPath,
  discoverCodexThreadById,
  discoverCodexSessions,
  jumpToSession,
  normalizeFollowUpToIdleMinutes,
  parseCodexProcessLine,
  selectLiveCliPrimarySessionId,
  sourceHealth,
} from "./codexSessionsDevSource.mjs";

const tempDirs = [];
const earlyTrackingStartMs = Date.parse("2026-06-01T00:00:00.000Z");

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("codexSessionsDevSource", () => {
  it("prefers the newest Codex state DB when both known locations exist", () => {
    const temp = tempDir();
    const home = path.join(temp, "home");
    const legacyDb = path.join(home, ".codex", "state_5.sqlite");
    const currentDb = path.join(home, ".codex", "sqlite", "state_5.sqlite");
    fs.mkdirSync(path.dirname(legacyDb), { recursive: true });
    fs.mkdirSync(path.dirname(currentDb), { recursive: true });
    fs.writeFileSync(legacyDb, "");
    fs.writeFileSync(currentDb, "");
    fs.utimesSync(legacyDb, new Date("2026-06-17T10:00:00.000Z"), new Date("2026-06-17T10:00:00.000Z"));
    fs.utimesSync(currentDb, new Date("2026-06-17T09:00:00.000Z"), new Date("2026-06-17T09:00:00.000Z"));

    expect(defaultCodexStateDbPath(home)).toBe(legacyDb);
  });

  it("keeps the current Codex sqlite state DB when it is at least as new as legacy", () => {
    const temp = tempDir();
    const home = path.join(temp, "home");
    const legacyDb = path.join(home, ".codex", "state_5.sqlite");
    const currentDb = path.join(home, ".codex", "sqlite", "state_5.sqlite");
    fs.mkdirSync(path.dirname(legacyDb), { recursive: true });
    fs.mkdirSync(path.dirname(currentDb), { recursive: true });
    fs.writeFileSync(legacyDb, "");
    fs.writeFileSync(currentDb, "");
    fs.utimesSync(legacyDb, new Date("2026-06-17T09:00:00.000Z"), new Date("2026-06-17T09:00:00.000Z"));
    fs.utimesSync(currentDb, new Date("2026-06-17T10:00:00.000Z"), new Date("2026-06-17T10:00:00.000Z"));

    expect(defaultCodexStateDbPath(home)).toBe(currentDb);
  });

  it("only treats the actual codex CLI executable as a live CLI process", () => {
    const helperLine =
      '4576 ttys002 /Users/edy/.code /Users/edy/.codex/computer-use/Codex Computer Use.app/Contents/MacOS/SkyComputerUseClient turn-ended {"client":"codex-tui","thread-id":"019eb47b-a10e-7931-aae7-6a6118962db0"}';
    const appServerLine =
      "14279 ttys002 /Applications/Co /Applications/Codex.app/Contents/Resources/codex app-server --listen stdio://";
    const cliResumeLine =
      "29457 ttys016 /Applications/Co /Applications/Codex.app/Contents/Resources/codex resume 019e9153-943a-7402-8e61-9e89cee5a6f4 --cd /Users/edy/hose/tmc_symposium/tmc_surprise";

    expect(parseCodexProcessLine(helperLine)).toBeUndefined();
    expect(parseCodexProcessLine(appServerLine)).toBeUndefined();
    expect(parseCodexProcessLine(cliResumeLine)).toMatchObject({
      pid: "29457",
      tty: "ttys016",
      args: expect.stringContaining("/Applications/Codex.app/Contents/Resources/codex resume"),
    });
  });

  it("only chooses an open rollout file as the primary live session when it is unique", () => {
    const childId = "019eb66b-7687-7d33-9509-c3a024bab50e";
    const parentId = "019eb47b-a10e-7931-aae7-6a6118962db0";
    const cliArgs =
      "/Users/edy/.nvm/versions/node/v22.12.0/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex";

    expect(selectLiveCliPrimarySessionId(cliArgs, [childId, parentId])).toBeUndefined();
    expect(selectLiveCliPrimarySessionId(cliArgs, [childId])).toBe(childId);
    expect(selectLiveCliPrimarySessionId(`${cliArgs} resume ${parentId}`, [childId])).toBe(parentId);
  });

  it("keeps a completion inspectable when SQLite updates one millisecond later", () => {
    const temp = tempDir();
    const stateDb = path.join(temp, "state_5.sqlite");
    createThreadsTable(stateDb);
    const sessionsRoot = path.join(temp, "sessions", "2026", "06", "17");
    fs.mkdirSync(sessionsRoot, { recursive: true });
    const rows = [
      {
        id: "019stopped",
        event: '{"timestamp":"2026-06-17T01:03:00.000Z","type":"event_msg","payload":{"type":"turn_aborted","reason":"interrupted"}}',
      },
      {
        id: "019running",
        event: '{"timestamp":"2026-06-17T01:02:00.000Z","type":"event_msg","payload":{"type":"user_message","message":"continue"}}',
      },
      {
        id: "019inspect-after-sqlite-update",
        event: '{"timestamp":"2026-06-17T01:01:00.000Z","type":"event_msg","payload":{"type":"task_complete"}}',
        updatedAtMs: Date.parse("2026-06-17T01:01:00.001Z"),
      },
      {
        id: "019inspect",
        event: '{"timestamp":"2026-06-17T01:00:00.000Z","type":"event_msg","payload":{"type":"task_complete"}}',
      },
    ];

    for (const row of rows) {
      const rolloutPath = path.join(sessionsRoot, `rollout-2026-06-17T09-00-00-${row.id}.jsonl`);
      fs.writeFileSync(
        rolloutPath,
        [
          `{"timestamp":"2026-06-17T00:59:00.000Z","type":"session_meta","payload":{"id":"${row.id}","cwd":"/repo","originator":"Codex Desktop","source":"vscode"}}`,
          row.event,
          "",
        ].join("\n"),
      );
      insertThread({
        stateDb,
        id: row.id,
        rolloutPath,
        cwd: "/repo",
        title: row.id,
        source: "vscode",
        threadSource: "user",
        preview: row.id,
        updatedAtMs: row.updatedAtMs ?? Date.parse("2026-06-17T01:00:00.000Z"),
      });
    }

    const sessions = discoverCodexSessions({
      stateDbPath: stateDb,
      sessionsRoot: path.join(temp, "sessions"),
      nowMs: Date.parse("2026-06-17T01:10:00.000Z"),
      unreadCompletionTrackingStartMs: earlyTrackingStartMs,
      limit: 20,
      liveCliTtyForWorkspace: () => undefined,
    });

    expect(sessions.map((row) => row.state)).toEqual([
      "inspect",
      "inspect",
      "running",
      "stopped",
    ]);
  });

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
      threadSource: "user",
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

  it("prefers a persisted thread name over the initial title for listing and lookup", () => {
    const temp = tempDir();
    const stateDb = path.join(temp, "state_5.sqlite");
    createThreadsTable(stateDb);
    execFileSync("sqlite3", [
      stateDb,
      "alter table threads add column name text;",
    ]);
    insertThread({
      stateDb,
      id: "019renamed",
      rolloutPath: path.join(temp, "missing-renamed.jsonl"),
      cwd: "/Users/edy/project",
      title: "Initial prompt title",
      source: "vscode",
      threadSource: "user",
      preview: "Preview title",
      updatedAtMs: Date.parse("2026-06-03T02:00:00.000Z"),
    });
    execFileSync("sqlite3", [
      stateDb,
      "update threads set name = 'Renamed session' where id = '019renamed';",
    ]);

    const options = {
      stateDbPath: stateDb,
      sessionsRoot: path.join(temp, "sessions"),
      nowMs: Date.parse("2026-06-03T02:00:01.000Z"),
      unreadCompletionTrackingStartMs: earlyTrackingStartMs,
      liveCliTtyForWorkspace: () => undefined,
    };
    const [listed] = discoverCodexSessions(options);
    const lookedUp = discoverCodexThreadById("019renamed", options);

    expect(listed.label).toBe("Renamed session");
    expect(lookedUp?.label).toBe("Renamed session");
  });

  it("falls back to the title when a legacy database lacks names and spawn edges", () => {
    const temp = tempDir();
    const stateDb = path.join(temp, "state_5.sqlite");
    createThreadsTable(stateDb, { includeSpawnEdges: false });
    insertThread({
      stateDb,
      id: "019legacy-title",
      rolloutPath: path.join(temp, "missing-legacy.jsonl"),
      cwd: "/Users/edy/project",
      title: "Legacy title",
      source: "vscode",
      threadSource: "user",
      preview: "Legacy preview",
      updatedAtMs: Date.parse("2026-06-03T02:00:00.000Z"),
    });

    const options = {
      stateDbPath: stateDb,
      sessionsRoot: path.join(temp, "sessions"),
      nowMs: Date.parse("2026-06-03T02:00:01.000Z"),
      unreadCompletionTrackingStartMs: earlyTrackingStartMs,
      liveCliTtyForWorkspace: () => undefined,
    };
    const [listed] = discoverCodexSessions(options);
    const lookedUp = discoverCodexThreadById("019legacy-title", options);

    expect(listed.label).toBe("Legacy title");
    expect(lookedUp?.label).toBe("Legacy title");
  });

  it("reopens a completed session when a new tool turn starts", () => {
    const temp = tempDir();
    const stateDb = path.join(temp, "state_5.sqlite");
    const sessionDir = path.join(temp, "sessions", "2026", "06", "03");
    fs.mkdirSync(sessionDir, { recursive: true });
    const rolloutPath = path.join(sessionDir, "rollout-2026-06-03T10-00-00-019continued-tool.jsonl");
    fs.writeFileSync(
      rolloutPath,
      [
        '{"timestamp":"2026-06-03T02:00:00.000Z","type":"session_meta","payload":{"id":"019continued-tool","cwd":"/Users/edy/project","originator":"Codex Desktop","source":"vscode"}}',
        '{"timestamp":"2026-06-03T02:20:00.000Z","type":"event_msg","payload":{"type":"task_complete"}}',
        '{"timestamp":"2026-06-03T02:30:00.000Z","type":"event_msg","payload":{"type":"task_started"}}',
        '{"timestamp":"2026-06-03T02:30:01.000Z","type":"response_item","payload":{"type":"custom_tool_call","name":"exec","call_id":"call_tool"}}',
        '{"timestamp":"2026-06-03T02:30:02.000Z","type":"response_item","payload":{"type":"custom_tool_call_output","call_id":"call_tool"}}',
        "",
      ].join("\n"),
    );
    createThreadsTable(stateDb);
    insertThread({
      stateDb,
      id: "019continued-tool",
      rolloutPath,
      cwd: "/Users/edy/project",
      title: "Continued tool turn",
      source: "vscode",
      threadSource: "user",
      preview: "Continued tool turn",
      updatedAtMs: Date.parse("2026-06-03T02:30:02.000Z"),
    });

    const rows = discoverCodexSessions({
      stateDbPath: stateDb,
      sessionsRoot: path.join(temp, "sessions"),
      nowMs: Date.parse("2026-06-03T02:31:00.000Z"),
      unreadCompletionTrackingStartMs: earlyTrackingStartMs,
      limit: 20,
      liveCliTtyForWorkspace: () => undefined,
    });

    expect(rows[0]).toMatchObject({
      sessionId: "019continued-tool",
      state: "running",
      lastActivityAt: "2026-06-03T02:30:02.000Z",
    });
  });

  it("reads parent thread ids from subagent session metadata by id without listing the child", () => {
    const temp = tempDir();
    const stateDb = path.join(temp, "state_5.sqlite");
    const sessionDir = path.join(temp, "sessions", "2026", "06", "11");
    fs.mkdirSync(sessionDir, { recursive: true });
    const rolloutPath = path.join(sessionDir, "rollout-2026-06-11T17-00-00-019child.jsonl");
    fs.writeFileSync(
      rolloutPath,
      [
        '{"timestamp":"2026-06-11T09:00:00.000Z","type":"session_meta","payload":{"id":"019child","parent_thread_id":"019parent","cwd":"/Users/edy/project","originator":"codex-tui","source":{"subagent":{"thread_spawn":{"parent_thread_id":"019parent","depth":1}}},"thread_source":"subagent"}}',
        '{"timestamp":"2026-06-11T09:10:00.000Z","type":"event_msg","payload":{"type":"agent_message","message":"working"}}',
        "",
      ].join("\n"),
    );
    createThreadsTable(stateDb);
    insertThread({
      stateDb,
      id: "019child",
      rolloutPath,
      cwd: "/Users/edy/project",
      title: "Child task",
      source: "cli",
      threadSource: "subagent",
      preview: "Child task",
      updatedAtMs: Date.parse("2026-06-11T09:10:00.000Z"),
    });

    const row = discoverCodexThreadById("019child", {
      stateDbPath: stateDb,
      nowMs: Date.parse("2026-06-11T09:20:00.000Z"),
      unreadCompletionTrackingStartMs: earlyTrackingStartMs,
      liveCliTtyForWorkspace: () => undefined,
    });

    expect(row).toMatchObject({
      sessionId: "019child",
      threadSource: "subagent",
      parentSessionId: "019parent",
    });
  });

  it("keeps a parent discoverable when newer subagents exceed the SQLite limit", () => {
    const temp = tempDir();
    const stateDb = path.join(temp, "state_5.sqlite");
    createThreadsTable(stateDb);
    insertThread({
      stateDb,
      id: "019parent-capacity",
      rolloutPath: path.join(temp, "missing-parent-capacity.jsonl"),
      cwd: "/Users/edy/project-parent",
      title: "Parent session",
      source: "vscode",
      threadSource: "user",
      preview: "Parent session",
      updatedAtMs: Date.parse("2026-06-17T01:00:00.000Z"),
    });

    const childIds = [
      "019child-capacity-a",
      "019child-capacity-b",
      "019child-capacity-c",
    ];
    childIds.forEach((id, index) => {
      insertThread({
        stateDb,
        id,
        rolloutPath: path.join(temp, `missing-${id}.jsonl`),
        cwd: "/Users/edy/project-parent",
        title: "Child session",
        source: "vscode",
        threadSource: "subagent",
        preview: "Child session",
        updatedAtMs: Date.parse("2026-06-17T01:01:00.000Z") + index,
      });
    });
    execFileSync("sqlite3", [
      stateDb,
      `insert into thread_spawn_edges (child_thread_id, parent_thread_id) values
        ('019child-capacity-a', '019parent-capacity'),
        ('019child-capacity-b', '019parent-capacity'),
        ('019child-capacity-c', '019parent-capacity');`,
    ]);

    const rows = discoverCodexSessions({
      stateDbPath: stateDb,
      sessionsRoot: path.join(temp, "sessions"),
      nowMs: Date.parse("2026-06-17T01:10:00.000Z"),
      unreadCompletionTrackingStartMs: earlyTrackingStartMs,
      limit: 1,
      liveCliTtyForWorkspace: () => undefined,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sessionId: "019parent-capacity",
      threadSource: "user",
    });
  });

  it("marks a parent with active subagent count while hiding child rows", () => {
    const temp = tempDir();
    const stateDb = path.join(temp, "state_5.sqlite");
    const sessionDir = path.join(temp, "sessions", "2026", "06", "05");
    fs.mkdirSync(sessionDir, { recursive: true });
    const parentPath = path.join(sessionDir, "rollout-2026-06-05T08-00-00-019parent.jsonl");
    const runningChildPath = path.join(sessionDir, "rollout-2026-06-05T08-01-00-019running-child.jsonl");
    const completedChildPath = path.join(sessionDir, "rollout-2026-06-05T08-02-00-019completed-child.jsonl");
    fs.writeFileSync(parentPath, [
      '{"timestamp":"2026-06-05T08:00:00.000Z","type":"session_meta","payload":{"id":"019parent","cwd":"/Users/edy/project-parent","originator":"Codex Desktop","source":"vscode","thread_source":"user"}}',
      '{"timestamp":"2026-06-05T08:20:00.000Z","type":"event_msg","payload":{"type":"agent_message","message":"parent waiting on agents"}}',
      "",
    ].join("\n"));
    fs.writeFileSync(runningChildPath, [
      '{"timestamp":"2026-06-05T08:01:00.000Z","type":"session_meta","payload":{"id":"019running-child","parent_thread_id":"019parent","cwd":"/Users/edy/project-child","originator":"codex-tui","thread_source":"subagent"}}',
      '{"timestamp":"2026-06-05T08:25:00.000Z","type":"event_msg","payload":{"type":"agent_message","message":"child still working"}}',
      "",
    ].join("\n"));
    fs.writeFileSync(completedChildPath, [
      '{"timestamp":"2026-06-05T08:02:00.000Z","type":"session_meta","payload":{"id":"019completed-child","parent_thread_id":"019parent","cwd":"/Users/edy/project-child","originator":"codex-tui","thread_source":"subagent"}}',
      '{"timestamp":"2026-06-05T08:25:00.000Z","type":"event_msg","payload":{"type":"task_complete"}}',
      "",
    ].join("\n"));
    createThreadsTable(stateDb);
    insertThread({
      stateDb,
      id: "019parent",
      rolloutPath: parentPath,
      cwd: "/Users/edy/project-parent",
      title: "Parent session",
      source: "vscode",
      threadSource: "user",
      preview: "Parent session",
      updatedAtMs: Date.parse("2026-06-05T08:20:00.000Z"),
    });
    insertThread({
      stateDb,
      id: "019running-child",
      rolloutPath: runningChildPath,
      cwd: "/Users/edy/project-child",
      title: "Running child",
      source: "vscode",
      threadSource: "subagent",
      preview: "Running child",
      updatedAtMs: Date.parse("2026-06-05T08:25:00.000Z"),
    });
    insertThread({
      stateDb,
      id: "019completed-child",
      rolloutPath: completedChildPath,
      cwd: "/Users/edy/project-child",
      title: "Completed child",
      source: "vscode",
      threadSource: "subagent",
      preview: "Completed child",
      updatedAtMs: Date.parse("2026-06-05T08:25:00.000Z"),
    });
    execFileSync("sqlite3", [
      stateDb,
      "insert into thread_spawn_edges (child_thread_id, parent_thread_id) values ('019running-child', '019parent'), ('019completed-child', '019parent');",
    ]);

    const rows = discoverCodexSessions({
      stateDbPath: stateDb,
      sessionsRoot: path.join(temp, "sessions"),
      nowMs: Date.parse("2026-06-05T08:30:00.000Z"),
      unreadCompletionTrackingStartMs: earlyTrackingStartMs,
      limit: 20,
      liveCliTtyForWorkspace: () => undefined,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sessionId: "019parent",
      activeSubagentCount: 1,
    });
    expect(rows.some((row) => row.sessionId.endsWith("child"))).toBe(false);

    const lookedUp = discoverCodexThreadById("019parent", {
      stateDbPath: stateDb,
      nowMs: Date.parse("2026-06-05T08:30:00.000Z"),
      unreadCompletionTrackingStartMs: earlyTrackingStartMs,
      liveCliTtyForWorkspace: () => undefined,
    });
    expect(lookedUp).toMatchObject({
      sessionId: "019parent",
      activeSubagentCount: 1,
    });
  });

  it("uses spawn edges to keep a parent discoverable when a newer child is misclassified as user", () => {
    const temp = tempDir();
    const stateDb = path.join(temp, "state_5.sqlite");
    createThreadsTable(stateDb);
    insertThread({
      stateDb,
      id: "019parent-edge-capacity",
      rolloutPath: path.join(temp, "missing-parent-edge-capacity.jsonl"),
      cwd: "/Users/edy/project-parent",
      title: "Parent session",
      source: "vscode",
      threadSource: "user",
      preview: "Parent session",
      updatedAtMs: Date.parse("2026-06-17T01:00:00.000Z"),
    });
    insertThread({
      stateDb,
      id: "019child-edge-capacity",
      rolloutPath: path.join(temp, "missing-child-edge-capacity.jsonl"),
      cwd: "/Users/edy/project-parent",
      title: "Misclassified child session",
      source: "vscode",
      threadSource: "user",
      preview: "Misclassified child session",
      updatedAtMs: Date.parse("2026-06-17T01:01:00.000Z"),
    });
    execFileSync("sqlite3", [
      stateDb,
      "insert into thread_spawn_edges (child_thread_id, parent_thread_id) values ('019child-edge-capacity', '019parent-edge-capacity');",
    ]);

    const rows = discoverCodexSessions({
      stateDbPath: stateDb,
      sessionsRoot: path.join(temp, "sessions"),
      nowMs: Date.parse("2026-06-17T01:10:00.000Z"),
      unreadCompletionTrackingStartMs: earlyTrackingStartMs,
      limit: 1,
      liveCliTtyForWorkspace: () => undefined,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].sessionId).toBe("019parent-edge-capacity");
  });

  it("keeps child session metadata when a later embedded parent session metadata record appears", () => {
    const temp = tempDir();
    const sessionDir = path.join(temp, "sessions", "2026", "06", "18");
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionDir, "rollout-2026-06-18T09-00-00-019fallback-child.jsonl"),
      [
        '{"timestamp":"2026-06-18T01:00:00.000Z","type":"session_meta","payload":{"id":"019fallback-child","parent_thread_id":"019fallback-parent","cwd":"/Users/edy/project-child","originator":"codex-tui","agent_nickname":"Child Agent","thread_source":"subagent"}}',
        '{"timestamp":"2026-06-18T01:01:00.000Z","type":"session_meta","payload":{"id":"019fallback-parent","cwd":"/Users/edy/project-parent","originator":"Codex Desktop","agent_nickname":"Parent Agent"}}',
        '{"timestamp":"2026-06-18T01:02:00.000Z","type":"event_msg","payload":{"type":"agent_message","message":"child is working"}}',
        "",
      ].join("\n"),
    );

    const stateDb = path.join(temp, "state_5.sqlite");
    createThreadsTable(stateDb);
    insertThread({
      stateDb,
      id: "019fallback-child",
      rolloutPath: path.join(sessionDir, "rollout-2026-06-18T09-00-00-019fallback-child.jsonl"),
      cwd: "/Users/edy/project-child",
      title: "Child session",
      source: "cli",
      threadSource: "subagent",
      preview: "Child session",
      updatedAtMs: Date.parse("2026-06-18T01:02:00.000Z"),
    });

    const row = discoverCodexThreadById("019fallback-child", {
      stateDbPath: stateDb,
      nowMs: Date.parse("2026-06-18T01:05:00.000Z"),
      liveCliTtyForWorkspace: () => undefined,
    });

    expect(row).toMatchObject({
      sessionId: "019fallback-child",
      parentSessionId: "019fallback-parent",
      agentName: "Child Agent",
      workspacePath: "/Users/edy/project-child",
      jumpTarget: "cli",
    });
  });

  it("collapses duplicate session IDs from JSONL fallback files to the newest observation", () => {
    const temp = tempDir();
    const sessionDir = path.join(temp, "sessions", "2026", "06", "18");
    const olderPath = path.join(sessionDir, "rollout-2026-06-18T09-00-00-019fallback-duplicate.jsonl");
    const newerPath = path.join(sessionDir, "rollout-2026-06-18T09-05-00-019fallback-duplicate-copy.jsonl");
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(
      olderPath,
      [
        '{"timestamp":"2026-06-18T01:00:00.000Z","type":"session_meta","payload":{"id":"019fallback-duplicate","cwd":"/Users/edy/project-older","originator":"Codex Desktop"}}',
        '{"timestamp":"2026-06-18T01:01:00.000Z","type":"event_msg","payload":{"type":"user_message","message":"Older fallback copy"}}',
        "",
      ].join("\n"),
    );
    fs.writeFileSync(
      newerPath,
      [
        '{"timestamp":"2026-06-18T01:04:00.000Z","type":"session_meta","payload":{"id":"019fallback-duplicate","cwd":"/Users/edy/project-newer","originator":"Codex Desktop"}}',
        '{"timestamp":"2026-06-18T01:05:00.000Z","type":"event_msg","payload":{"type":"user_message","message":"Newer fallback copy"}}',
        "",
      ].join("\n"),
    );
    fs.utimesSync(olderPath, new Date("2026-06-18T01:02:00.000Z"), new Date("2026-06-18T01:02:00.000Z"));
    fs.utimesSync(newerPath, new Date("2026-06-18T01:06:00.000Z"), new Date("2026-06-18T01:06:00.000Z"));

    const rows = discoverCodexSessions({
      stateDbPath: path.join(temp, "missing-state.sqlite"),
      sessionsRoot: path.join(temp, "sessions"),
      nowMs: Date.parse("2026-06-18T01:10:00.000Z"),
      limit: 20,
      liveCliTtyForWorkspace: () => undefined,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sessionId: "019fallback-duplicate",
      label: "Newer fallback copy",
      workspacePath: "/Users/edy/project-newer",
      lastActivityAt: "2026-06-18T01:05:00.000Z",
    });
  });

  it("keeps a parent when newer orphan subagents exceed the JSONL fallback limit", () => {
    const temp = tempDir();
    const sessionDir = path.join(temp, "sessions", "2026", "06", "18");
    const parentPath = path.join(sessionDir, "rollout-2026-06-18T09-00-00-019parent-fallback.jsonl");
    const childPath = path.join(sessionDir, "rollout-2026-06-18T10-00-00-019orphan-child-fallback.jsonl");
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(
      parentPath,
      [
        '{"timestamp":"2026-06-18T01:00:00.000Z","type":"session_meta","payload":{"id":"019parent-fallback","cwd":"/Users/edy/project-parent","originator":"Codex Desktop","thread_source":"user"}}',
        '{"timestamp":"2026-06-18T01:01:00.000Z","type":"event_msg","payload":{"type":"agent_message","message":"parent working"}}',
        "",
      ].join("\n"),
    );
    fs.writeFileSync(
      childPath,
      [
        '{"timestamp":"2026-06-18T02:00:00.000Z","type":"session_meta","payload":{"id":"019orphan-child-fallback","cwd":"/Users/edy/project-child","originator":"codex-tui","thread_source":"subagent"}}',
        '{"timestamp":"2026-06-18T02:01:00.000Z","type":"event_msg","payload":{"type":"agent_message","message":"child working"}}',
        "",
      ].join("\n"),
    );
    fs.utimesSync(parentPath, new Date("2026-06-18T01:02:00.000Z"), new Date("2026-06-18T01:02:00.000Z"));
    fs.utimesSync(childPath, new Date("2026-06-18T01:06:00.000Z"), new Date("2026-06-18T01:06:00.000Z"));

    const rows = discoverCodexSessions({
      stateDbPath: path.join(temp, "missing-state.sqlite"),
      sessionsRoot: path.join(temp, "sessions"),
      nowMs: Date.parse("2026-06-18T01:10:00.000Z"),
      limit: 1,
      liveCliTtyForWorkspace: () => undefined,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].sessionId).toBe("019parent-fallback");
  });

  it("returns no JSONL fallback rows when the limit is zero", () => {
    const temp = tempDir();
    const sessionDir = path.join(temp, "sessions", "2026", "06", "18");
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionDir, "rollout-2026-06-18T09-00-00-019limit-zero.jsonl"),
      [
        '{"timestamp":"2026-06-18T01:00:00.000Z","type":"session_meta","payload":{"id":"019limit-zero","cwd":"/Users/edy/project","originator":"Codex Desktop"}}',
        '{"timestamp":"2026-06-18T01:01:00.000Z","type":"event_msg","payload":{"type":"agent_message","message":"working"}}',
        "",
      ].join("\n"),
    );

    const rows = discoverCodexSessions({
      stateDbPath: path.join(temp, "missing-state.sqlite"),
      sessionsRoot: path.join(temp, "sessions"),
      nowMs: Date.parse("2026-06-18T01:10:00.000Z"),
      limit: 0,
      liveCliTtyForWorkspace: () => undefined,
    });

    expect(rows).toEqual([]);
  });

  it("uses JSONL subagent metadata to refill a SQLite list after an unmarked child", () => {
    const temp = tempDir();
    const stateDb = path.join(temp, "state_5.sqlite");
    const sessionDir = path.join(temp, "sessions", "2026", "06", "18");
    const childPath = path.join(sessionDir, "rollout-2026-06-18T10-00-00-019child-jsonl-source.jsonl");
    const parentPath = path.join(sessionDir, "rollout-2026-06-18T09-00-00-019parent-jsonl-source.jsonl");
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(
      childPath,
      [
        '{"timestamp":"2026-06-18T02:00:00.000Z","type":"session_meta","payload":{"id":"019child-jsonl-source","cwd":"/Users/edy/project-child","originator":"codex-tui","thread_source":"subagent"}}',
        '{"timestamp":"2026-06-18T02:01:00.000Z","type":"event_msg","payload":{"type":"agent_message","message":"child working"}}',
        "",
      ].join("\n"),
    );
    fs.writeFileSync(
      parentPath,
      [
        '{"timestamp":"2026-06-18T01:00:00.000Z","type":"session_meta","payload":{"id":"019parent-jsonl-source","cwd":"/Users/edy/project-parent","originator":"Codex Desktop","thread_source":"user"}}',
        '{"timestamp":"2026-06-18T01:01:00.000Z","type":"event_msg","payload":{"type":"agent_message","message":"parent working"}}',
        "",
      ].join("\n"),
    );
    createThreadsTable(stateDb, { includeSpawnEdges: false });
    insertThread({
      stateDb,
      id: "019child-jsonl-source",
      rolloutPath: childPath,
      cwd: "/Users/edy/project-child",
      title: "Child session",
      source: "cli",
      threadSource: "user",
      preview: "Child session",
      updatedAtMs: Date.parse("2026-06-18T02:01:00.000Z"),
    });
    insertThread({
      stateDb,
      id: "019parent-jsonl-source",
      rolloutPath: parentPath,
      cwd: "/Users/edy/project-parent",
      title: "Parent session",
      source: "vscode",
      threadSource: "user",
      preview: "Parent session",
      updatedAtMs: Date.parse("2026-06-18T01:01:00.000Z"),
    });

    const rows = discoverCodexSessions({
      stateDbPath: stateDb,
      sessionsRoot: path.join(temp, "sessions"),
      nowMs: Date.parse("2026-06-18T01:10:00.000Z"),
      limit: 1,
      liveCliTtyForWorkspace: () => undefined,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].sessionId).toBe("019parent-jsonl-source");
  });

  it("does not add unverified live CLI sessions to the list", () => {
    const temp = tempDir();

    const rows = discoverCodexSessions({
      stateDbPath: path.join(temp, "missing-state.sqlite"),
      sessionsRoot: path.join(temp, "sessions"),
      nowMs: Date.parse("2026-06-18T01:10:00.000Z"),
      limit: 20,
      liveCliSessions: [
        { sessionId: "019unverified-live-cli", workspacePath: "/repo", tty: "ttys008" },
        { workspacePath: "/repo", tty: "ttys009" },
      ],
    });

    expect(rows).toEqual([]);
  });

  it.sequential("loads SQLite parent links by id while JSONL remains authoritative", () => {
    const temp = tempDir();
    const stateDb = path.join(temp, "state_5.sqlite");
    const sessionDir = path.join(temp, "sessions", "2026", "06", "17");
    const sqliteBinDir = path.join(temp, "bin");
    const sqliteCallLog = path.join(temp, "sqlite-calls.log");
    const sqliteQueryLog = path.join(temp, "sqlite-query.log");
    const originalEnvironment = Object.fromEntries(
      ["PATH", "SQLITE_CALL_LOG", "SQLITE_QUERY_LOG", "REAL_SQLITE3"].map((key) => [key, process.env[key]]),
    );
    const realSqlite3 = execFileSync("sh", ["-lc", "command -v sqlite3"], { encoding: "utf8" }).trim();
    const jsonlChildId = "019child-jsonl-parent";
    const sqliteChildId = "019child-sqlite-parent";
    const workspacePath = "/Users/edy/project";
    fs.mkdirSync(sessionDir, { recursive: true });
    createThreadsTable(stateDb);
    execFileSync("sqlite3", [stateDb, "alter table threads add column name text;"]);
    fs.mkdirSync(sqliteBinDir, { recursive: true });
    fs.writeFileSync(
      path.join(sqliteBinDir, "sqlite3"),
      [
        "#!/bin/sh",
        'printf "call\\n" >> "$SQLITE_CALL_LOG"',
        'printf "%s" "$4" > "$SQLITE_QUERY_LOG"',
        'exec "$REAL_SQLITE3" "$@"',
        "",
      ].join("\n"),
      { mode: 0o755 },
    );

    const jsonlParentRolloutPath = path.join(sessionDir, `rollout-2026-06-17T12-00-00-${jsonlChildId}.jsonl`);
    const sqliteParentRolloutPath = path.join(sessionDir, `rollout-2026-06-17T12-01-00-${sqliteChildId}.jsonl`);
    fs.writeFileSync(
      jsonlParentRolloutPath,
      [
        `{"timestamp":"2026-06-17T04:00:00.000Z","type":"session_meta","payload":{"id":"${jsonlChildId}","parent_thread_id":"019parent-jsonl","cwd":"${workspacePath}","originator":"codex-tui","source":"cli"}}`,
        '{"timestamp":"2026-06-17T04:01:00.000Z","type":"event_msg","payload":{"type":"user_message","message":"child"}}',
        "",
      ].join("\n"),
    );
    fs.writeFileSync(
      sqliteParentRolloutPath,
      [
        `{"timestamp":"2026-06-17T04:02:00.000Z","type":"session_meta","payload":{"id":"${sqliteChildId}","cwd":"${workspacePath}","originator":"codex-tui","source":"cli"}}`,
        '{"timestamp":"2026-06-17T04:03:00.000Z","type":"event_msg","payload":{"type":"user_message","message":"child"}}',
        "",
      ].join("\n"),
    );
    insertThread({
      stateDb,
      id: jsonlChildId,
      rolloutPath: jsonlParentRolloutPath,
      cwd: workspacePath,
      title: "JSONL child",
      source: "cli",
      threadSource: "subagent",
      preview: "JSONL child",
      updatedAtMs: Date.parse("2026-06-17T04:01:00.000Z"),
    });
    insertThread({
      stateDb,
      id: sqliteChildId,
      rolloutPath: sqliteParentRolloutPath,
      cwd: workspacePath,
      title: "SQLite child",
      source: "cli",
      threadSource: "subagent",
      preview: "SQLite child",
      updatedAtMs: Date.parse("2026-06-17T04:03:00.000Z"),
    });
    execFileSync("sqlite3", [
      stateDb,
      `insert into thread_spawn_edges (child_thread_id, parent_thread_id) values
        (${sql(jsonlChildId)}, '019parent-sqlite'),
        (${sql(sqliteChildId)}, '019parent-sqlite');`,
    ]);

    try {
      process.env.PATH = `${sqliteBinDir}:${originalEnvironment.PATH ?? ""}`;
      process.env.SQLITE_CALL_LOG = sqliteCallLog;
      process.env.SQLITE_QUERY_LOG = sqliteQueryLog;
      process.env.REAL_SQLITE3 = realSqlite3;

      const jsonlChild = discoverCodexThreadById(jsonlChildId, {
        stateDbPath: stateDb,
        nowMs: Date.parse("2026-06-17T04:10:00.000Z"),
        unreadCompletionTrackingStartMs: earlyTrackingStartMs,
        liveCliTtyForWorkspace: () => undefined,
      });
      const sqliteChild = discoverCodexThreadById(sqliteChildId, {
        stateDbPath: stateDb,
        nowMs: Date.parse("2026-06-17T04:10:00.000Z"),
        unreadCompletionTrackingStartMs: earlyTrackingStartMs,
        liveCliTtyForWorkspace: () => undefined,
      });

      expect(jsonlChild).toMatchObject({
        parentSessionId: "019parent-jsonl",
      });
      expect(sqliteChild).toMatchObject({
        parentSessionId: "019parent-sqlite",
      });
      expect(fs.readFileSync(sqliteCallLog, "utf8").trim().split("\n")).toHaveLength(2);
      expect(fs.readFileSync(sqliteQueryLog, "utf8").toLowerCase()).toContain(
        "left join thread_spawn_edges",
      );
    } finally {
      restoreEnvironmentVariables(originalEnvironment);
    }
  });

  it("lists no subagent rows when an older state DB lacks spawn edges", () => {
    const temp = tempDir();
    const stateDb = path.join(temp, "state_5.sqlite");
    createThreadsTable(stateDb, { includeSpawnEdges: false });
    insertThread({
      stateDb,
      id: "019legacy-state-db",
      rolloutPath: path.join(temp, "missing.jsonl"),
      cwd: "/Users/edy/project",
      title: "Legacy thread",
      source: "cli",
      threadSource: "subagent",
      preview: "Legacy thread",
      updatedAtMs: Date.parse("2026-06-17T04:03:00.000Z"),
    });

    const rows = discoverCodexSessions({
      stateDbPath: stateDb,
      sessionsRoot: path.join(temp, "missing-sessions"),
      nowMs: Date.parse("2026-06-17T04:10:00.000Z"),
      unreadCompletionTrackingStartMs: earlyTrackingStartMs,
      limit: 20,
      liveCliTtyForWorkspace: () => undefined,
    });

    expect(rows).toEqual([]);
  });

  it("lists no subagent rows when spawn edges omit a required column", () => {
    const temp = tempDir();
    const stateDb = path.join(temp, "state_5.sqlite");
    createThreadsTable(stateDb);
    execFileSync("sqlite3", [
      stateDb,
      "drop table thread_spawn_edges; create table thread_spawn_edges (child_thread_id text primary key);",
    ]);
    insertThread({
      stateDb,
      id: "019incompatible-edge-schema",
      rolloutPath: path.join(temp, "missing.jsonl"),
      cwd: "/Users/edy/project",
      title: "Incompatible edge schema",
      source: "cli",
      threadSource: "subagent",
      preview: "Incompatible edge schema",
      updatedAtMs: Date.parse("2026-06-17T04:03:00.000Z"),
    });

    const rows = discoverCodexSessions({
      stateDbPath: stateDb,
      sessionsRoot: path.join(temp, "missing-sessions"),
      nowMs: Date.parse("2026-06-17T04:10:00.000Z"),
      unreadCompletionTrackingStartMs: earlyTrackingStartMs,
      limit: 20,
      liveCliTtyForWorkspace: () => undefined,
    });

    expect(rows).toEqual([]);
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

  it("treats external import completion as stale history", () => {
    const temp = tempDir();
    const sessionDir = path.join(temp, "sessions", "2026", "06", "12");
    fs.mkdirSync(sessionDir, { recursive: true });
    const rolloutPath = path.join(sessionDir, "rollout-2026-06-12T10-31-55-019imported.jsonl");
    fs.writeFileSync(
      rolloutPath,
      [
        '{"timestamp":"2026-06-12T02:31:55.949Z","type":"session_meta","payload":{"id":"019imported","cwd":"/Users/edy/project-b","originator":"codex-tui","source":"cli"}}',
        '{"timestamp":"2026-06-12T02:31:55.950Z","type":"event_msg","payload":{"type":"task_started","turn_id":"external-import-turn-1","started_at":1779083012}}',
        '{"timestamp":"2026-06-12T02:31:55.951Z","type":"event_msg","payload":{"type":"user_message","message":"old imported prompt"}}',
        '{"timestamp":"2026-06-12T02:31:55.952Z","type":"event_msg","payload":{"type":"agent_message","message":"<EXTERNAL SESSION IMPORTED>","phase":null}}',
        '{"timestamp":"2026-06-12T02:31:55.953Z","type":"event_msg","payload":{"type":"task_complete","turn_id":"external-import-turn-1","last_agent_message":null,"completed_at":1779083012}}',
        "",
      ].join("\n"),
    );

    const rows = discoverCodexSessions({
      stateDbPath: path.join(temp, "missing.sqlite"),
      sessionsRoot: path.join(temp, "sessions"),
      nowMs: Date.parse("2026-06-12T03:00:00.000Z"),
      limit: 20,
      liveCliTtyForWorkspace: () => undefined,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sessionId: "019imported",
      state: "idle",
      confidence: "inferred",
      statusReason: "completed task is no longer recent; idle until the next source signal",
      lastActivityAt: "2026-06-12T02:31:55.953Z",
    });
  });

  it("does not treat SQLite updates as read signals at the follow-up boundary", () => {
    const temp = tempDir();
    const stateDb = path.join(temp, "state_5.sqlite");
    const sessionDir = path.join(temp, "sessions", "2026", "06", "06");
    fs.mkdirSync(sessionDir, { recursive: true });
    const rolloutPath = path.join(sessionDir, "rollout-2026-06-06T12-00-00-019read-signal.jsonl");
    fs.writeFileSync(
      rolloutPath,
      [
        '{"timestamp":"2026-06-06T04:00:00.000Z","type":"session_meta","payload":{"id":"019read-signal","cwd":"/Users/edy/project","originator":"Codex Desktop","source":"vscode"}}',
        '{"timestamp":"2026-06-06T04:05:00.000Z","type":"event_msg","payload":{"type":"task_complete"}}',
        "",
      ].join("\n"),
    );
    createThreadsTable(stateDb);
    insertThread({
      stateDb,
      id: "019read-signal",
      rolloutPath,
      cwd: "/Users/edy/project",
      title: "Read signal",
      source: "vscode",
      threadSource: "user",
      preview: "Read signal",
      updatedAtMs: Date.parse("2026-06-06T04:10:00.000Z"),
    });

    const atBoundaryRows = discoverCodexSessions({
      stateDbPath: stateDb,
      sessionsRoot: path.join(temp, "sessions"),
      nowMs: Date.parse("2026-06-06T04:55:00.000Z"),
      unreadCompletionTrackingStartMs: earlyTrackingStartMs,
      followUpToIdleMinutes: 45,
      limit: 20,
      liveCliTtyForWorkspace: () => undefined,
    });

    expect(atBoundaryRows).toHaveLength(1);
    expect(atBoundaryRows[0]).toMatchObject({
      sessionId: "019read-signal",
      state: "inspect",
      statusReason: "completed task ready to inspect; open it to mark read",
      lastActivityAt: "2026-06-06T04:05:00.000Z",
    });

    const afterBoundaryRows = discoverCodexSessions({
      stateDbPath: stateDb,
      sessionsRoot: path.join(temp, "sessions"),
      nowMs: Date.parse("2026-06-06T04:55:00.001Z"),
      unreadCompletionTrackingStartMs: earlyTrackingStartMs,
      followUpToIdleMinutes: 45,
      limit: 20,
      liveCliTtyForWorkspace: () => undefined,
    });

    expect(afterBoundaryRows[0]).toMatchObject({
      sessionId: "019read-signal",
      state: "inspect",
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

  it("uses the configured follow-up boundary without losing acknowledged state", async () => {
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
      followUpToIdleMinutes: 45,
      unreadCompletionTrackingStartMs: earlyTrackingStartMs,
      limit: 20,
      liveCliTtyForWorkspace: () => undefined,
      executeJump: async () => undefined,
    });

    expect(source.discoverCodexSessions()[0]).toMatchObject({
      sessionId: "019read-window",
      state: "inspect",
    });

    const result = await source.jumpToSession("019read-window");
    expect(result.succeeded).toBe(true);
    expect(source.discoverCodexSessions()[0]).toMatchObject({
      sessionId: "019read-window",
      state: "needsAttention",
      statusReason: "Read recently; keep it quiet during the follow-up window.",
      handled: true,
    });

    const acknowledgedAtMs = nowMs;
    nowMs = acknowledgedAtMs + 45 * 60 * 1000;
    expect(source.discoverCodexSessions()[0]).toMatchObject({
      sessionId: "019read-window",
      state: "needsAttention",
      handled: true,
    });

    nowMs += 1;
    expect(source.discoverCodexSessions()[0]).toMatchObject({
      sessionId: "019read-window",
      state: "idle",
      statusReason: "Read window expired; idle until the next source signal.",
      handled: true,
    });

    nowMs = acknowledgedAtMs + 20 * 60 * 1000;
    expect(source.discoverCodexSessions({ followUpToIdleMinutes: 12 })[0]).toMatchObject({
      sessionId: "019read-window",
      state: "needsAttention",
      handled: true,
    });
    nowMs += 1;
    expect(source.discoverCodexSessions({ followUpToIdleMinutes: 12 })[0]).toMatchObject({
      sessionId: "019read-window",
      state: "idle",
      handled: true,
    });
  });

  it("normalizes the follow-up duration without a product maximum", () => {
    expect(normalizeFollowUpToIdleMinutes()).toBe(30);
    expect(normalizeFollowUpToIdleMinutes(12)).toBe(20);
    expect(normalizeFollowUpToIdleMinutes(20)).toBe(20);
    expect(normalizeFollowUpToIdleMinutes(180.8)).toBe(180);
    expect(normalizeFollowUpToIdleMinutes(Number.POSITIVE_INFINITY)).toBe(30);
  });

  it("keeps acknowledged rows in the extreme finite follow-up window", async () => {
    const temp = tempDir();
    const acknowledgedAtMs = Date.parse("2026-06-06T04:00:00.000Z");
    const sessionDir = path.join(temp, "sessions", "2026", "06", "06");
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionDir, "rollout-2026-06-06T12-00-00-019extreme-window.jsonl"),
      [
        '{"timestamp":"2026-06-06T04:00:00.000Z","type":"session_meta","payload":{"id":"019extreme-window","cwd":"/Users/edy/wmhcar","originator":"Codex Desktop","source":"vscode"}}',
        '{"timestamp":"2026-06-06T04:00:00.000Z","type":"event_msg","payload":{"type":"task_complete"}}',
        "",
      ].join("\n"),
    );
    const source = createCodexSessionsDevSource({
      stateDbPath: path.join(temp, "missing.sqlite"),
      sessionsRoot: path.join(temp, "sessions"),
      nowMs: () => acknowledgedAtMs,
      unreadCompletionTrackingStartMs: earlyTrackingStartMs,
      liveCliTtyForWorkspace: () => undefined,
      executeJump: async () => undefined,
    });

    await source.jumpToSession("019extreme-window");
    const rows = source.discoverCodexSessions({
      nowMs: Number.MAX_SAFE_INTEGER,
      followUpToIdleMinutes: 1e20,
    });

    expect(normalizeFollowUpToIdleMinutes(1e20)).toBe(1e20);
    expect(rows[0]).toMatchObject({
      sessionId: "019extreme-window",
      state: "needsAttention",
      handled: true,
    });
  });

  it("does not acknowledge an inspect row when jump execution fails", async () => {
    const temp = tempDir();
    const sessionDir = path.join(temp, "sessions", "2026", "06", "03");
    fs.mkdirSync(sessionDir, { recursive: true });
    const rolloutPath = path.join(sessionDir, "rollout-2026-06-03T10-00-00-019failed-ack.jsonl");
    fs.writeFileSync(
      rolloutPath,
      [
        '{"timestamp":"2026-06-03T02:00:00.000Z","type":"session_meta","payload":{"id":"019failed-ack","cwd":"/Users/edy/wmhcar","originator":"Codex Desktop","source":"vscode"}}',
        '{"timestamp":"2026-06-03T02:20:00.000Z","type":"event_msg","payload":{"type":"task_complete"}}',
        "",
      ].join("\n"),
    );
    const source = createCodexSessionsDevSource({
      stateDbPath: path.join(temp, "missing.sqlite"),
      sessionsRoot: path.join(temp, "sessions"),
      nowMs: Date.parse("2026-06-03T06:00:00.000Z"),
      unreadCompletionTrackingStartMs: earlyTrackingStartMs,
      limit: 20,
      liveCliTtyForWorkspace: () => undefined,
      executeJump: async () => {
        throw new Error("activation failed");
      },
    });

    expect(source.discoverCodexSessions()[0]).toMatchObject({
      sessionId: "019failed-ack",
      state: "inspect",
      handled: false,
    });

    await expect(source.jumpToSession("019failed-ack")).resolves.toMatchObject({
      succeeded: false,
      message: "Jump-back failed: activation failed",
    });

    expect(source.discoverCodexSessions()[0]).toMatchObject({
      sessionId: "019failed-ack",
      state: "inspect",
      handled: false,
    });
  });

  it("resumes exact CLI sessions in a previous iTerm tab instead of only focusing it", async () => {
    const temp = tempDir();
    const sessionDir = path.join(temp, "sessions", "2026", "06", "03");
    fs.mkdirSync(sessionDir, { recursive: true });
    const rolloutPath = path.join(sessionDir, "rollout-2026-06-03T10-00-00-019cli.jsonl");
    fs.writeFileSync(
      rolloutPath,
      [
        '{"timestamp":"2026-06-03T02:00:00.000Z","type":"session_meta","payload":{"id":"019cli","cwd":"/Users/edy/wmhcar","originator":"codex-tui","source":"cli"}}',
        '{"timestamp":"2026-06-03T02:20:00.000Z","type":"event_msg","payload":{"type":"task_complete"}}',
        "",
      ].join("\n"),
    );
    const executed = [];
    const result = await jumpToSession("019cli", {
      stateDbPath: path.join(temp, "missing.sqlite"),
      sessionsRoot: path.join(temp, "sessions"),
      nowMs: Date.parse("2026-06-03T02:25:00.000Z"),
      unreadCompletionTrackingStartMs: earlyTrackingStartMs,
      limit: 20,
      liveCliTtyForWorkspace: () => undefined,
      previousITermTtyForWorkspace: () => "ttys002",
      executeJump: async (_row, plan) => executed.push(plan),
    });

    expect(executed).toEqual([
      {
        kind: "iterm-resume",
        threadId: "019cli",
        workspacePath: "/Users/edy/wmhcar",
        tty: "ttys002",
      },
    ]);
    expect(result.message).toBe("Resumed Codex session in previous iTerm tab.");
    expect(result.succeeded).toBe(true);
  });

  it("reports an unsuccessful outcome when no jump target is available", async () => {
    const result = await jumpToSession("missing", {
      stateDbPath: "/missing/state_5.sqlite",
      sessionsRoot: "/missing/sessions",
    });

    expect(result).toMatchObject({
      sessionId: "missing",
      availability: "unavailable",
      target: "unknown",
      succeeded: false,
      message: "Jump-back unavailable: missing reliable target signal.",
    });
  });

  it("reports an unsuccessful outcome when the desktop opener cannot start", async () => {
    const temp = tempDir();
    const sessionDir = path.join(temp, "sessions", "2026", "06", "03");
    fs.mkdirSync(sessionDir, { recursive: true });
    const rolloutPath = path.join(sessionDir, "rollout-2026-06-03T10-00-00-019jump-failed.jsonl");
    fs.writeFileSync(
      rolloutPath,
      [
        '{"timestamp":"2026-06-03T02:00:00.000Z","type":"session_meta","payload":{"id":"019jump-failed","cwd":"/Users/edy/wmhcar","originator":"Codex Desktop","source":"vscode"}}',
        '{"timestamp":"2026-06-03T02:20:00.000Z","type":"event_msg","payload":{"type":"task_complete"}}',
        "",
      ].join("\n"),
    );

    const originalPath = process.env.PATH;
    process.env.PATH = "/missing-command-path";
    try {
      await expect(jumpToSession("019jump-failed", {
        stateDbPath: path.join(temp, "missing.sqlite"),
        sessionsRoot: path.join(temp, "sessions"),
        nowMs: Date.parse("2026-06-03T02:25:00.000Z"),
        unreadCompletionTrackingStartMs: earlyTrackingStartMs,
        liveCliTtyForWorkspace: () => undefined,
      })).resolves.toMatchObject({
        sessionId: "019jump-failed",
        availability: "exact",
        target: "desktop",
        succeeded: false,
        message: expect.stringContaining("Jump-back failed:"),
      });
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
    }
  });

  it("reports an unsuccessful outcome when live iTerm Codex activation cannot start", async () => {
    const temp = tempDir();
    const sessionDir = path.join(temp, "sessions", "2026", "06", "03");
    fs.mkdirSync(sessionDir, { recursive: true });
    const rolloutPath = path.join(sessionDir, "rollout-2026-06-03T10-00-00-019iterm-failed.jsonl");
    fs.writeFileSync(
      rolloutPath,
      [
        '{"timestamp":"2026-06-03T02:00:00.000Z","type":"session_meta","payload":{"id":"019iterm-failed","cwd":"/Users/edy/wmhcar","originator":"Codex CLI","source":"cli"}}',
        '{"timestamp":"2026-06-03T02:20:00.000Z","type":"event_msg","payload":{"type":"task_complete"}}',
        "",
      ].join("\n"),
    );

    const originalPath = process.env.PATH;
    process.env.PATH = "/missing-command-path";
    try {
      await expect(jumpToSession("019iterm-failed", {
        stateDbPath: path.join(temp, "missing.sqlite"),
        sessionsRoot: path.join(temp, "sessions"),
        nowMs: Date.parse("2026-06-03T02:25:00.000Z"),
        unreadCompletionTrackingStartMs: earlyTrackingStartMs,
        liveCliTtyForWorkspace: () => "ttys009",
      })).resolves.toMatchObject({
        sessionId: "019iterm-failed",
        target: "cli",
        succeeded: false,
        message: expect.stringContaining("osascript"),
      });
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
    }
  });

  it("reports an unsuccessful outcome when iTerm resume cannot start", async () => {
    const temp = tempDir();
    const sessionDir = path.join(temp, "sessions", "2026", "06", "03");
    fs.mkdirSync(sessionDir, { recursive: true });
    const rolloutPath = path.join(sessionDir, "rollout-2026-06-03T10-00-00-019iterm-resume-failed.jsonl");
    fs.writeFileSync(
      rolloutPath,
      [
        '{"timestamp":"2026-06-03T02:00:00.000Z","type":"session_meta","payload":{"id":"019iterm-resume-failed","cwd":"/Users/edy/wmhcar","originator":"Codex CLI","source":"cli"}}',
        '{"timestamp":"2026-06-03T02:20:00.000Z","type":"event_msg","payload":{"type":"task_complete"}}',
        "",
      ].join("\n"),
    );

    const originalPath = process.env.PATH;
    process.env.PATH = "/missing-command-path";
    try {
      await expect(jumpToSession("019iterm-resume-failed", {
        stateDbPath: path.join(temp, "missing.sqlite"),
        sessionsRoot: path.join(temp, "sessions"),
        nowMs: Date.parse("2026-06-03T02:25:00.000Z"),
        unreadCompletionTrackingStartMs: earlyTrackingStartMs,
        liveCliTtyForWorkspace: () => undefined,
        previousITermTtyForWorkspace: () => undefined,
      })).resolves.toMatchObject({
        sessionId: "019iterm-resume-failed",
        succeeded: false,
        message: expect.stringContaining("Jump-back failed:"),
      });
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
    }
  });

  it("starts a CLI session with codex resume when no iTerm item is alive", async () => {
    const temp = tempDir();
    const sessionDir = path.join(temp, "sessions", "2026", "06", "03");
    fs.mkdirSync(sessionDir, { recursive: true });
    const rolloutPath = path.join(sessionDir, "rollout-2026-06-03T10-00-00-019cli-resume.jsonl");
    fs.writeFileSync(
      rolloutPath,
      [
        '{"timestamp":"2026-06-03T02:00:00.000Z","type":"session_meta","payload":{"id":"019cli-resume","cwd":"/Users/edy/wmhcar","originator":"Codex CLI","source":"cli"}}',
        '{"timestamp":"2026-06-03T02:20:00.000Z","type":"event_msg","payload":{"type":"task_complete"}}',
        "",
      ].join("\n"),
    );
    const executed = [];
    const result = await jumpToSession("019cli-resume", {
      stateDbPath: path.join(temp, "missing.sqlite"),
      sessionsRoot: path.join(temp, "sessions"),
      nowMs: Date.parse("2026-06-03T02:25:00.000Z"),
      unreadCompletionTrackingStartMs: earlyTrackingStartMs,
      limit: 20,
      liveCliTtyForWorkspace: () => undefined,
      previousITermTtyForWorkspace: () => undefined,
      executeJump: async (_row, plan) => executed.push(plan),
    });

    expect(executed).toEqual([
      {
        kind: "iterm-resume",
        threadId: "019cli-resume",
        workspacePath: "/Users/edy/wmhcar",
        tty: undefined,
      },
    ]);
    expect(result.message).toBe("Started iTerm Codex resume session.");
  });

  it("keeps Desktop-sourced rows on the Desktop when a live CLI shares the workspace", async () => {
    const temp = tempDir();
    const sessionDir = path.join(temp, "sessions", "2026", "06", "03");
    fs.mkdirSync(sessionDir, { recursive: true });
    const rolloutPath = path.join(sessionDir, "rollout-2026-06-03T10-00-00-019desktop-live-cli.jsonl");
    fs.writeFileSync(
      rolloutPath,
      [
        '{"timestamp":"2026-06-03T02:00:00.000Z","type":"session_meta","payload":{"id":"019desktop-live-cli","cwd":"/Users/edy/wmhcar","originator":"Codex Desktop","source":"vscode"}}',
        '{"timestamp":"2026-06-03T02:20:00.000Z","type":"event_msg","payload":{"type":"task_complete"}}',
        "",
      ].join("\n"),
    );
    const executed = [];
    const result = await jumpToSession("019desktop-live-cli", {
      stateDbPath: path.join(temp, "missing.sqlite"),
      sessionsRoot: path.join(temp, "sessions"),
      nowMs: Date.parse("2026-06-03T02:25:00.000Z"),
      unreadCompletionTrackingStartMs: earlyTrackingStartMs,
      limit: 20,
      liveCliTtyForWorkspace: () => "ttys009",
      previousITermTtyForWorkspace: () => undefined,
      executeJump: async (_row, plan) => executed.push(plan),
    });

    expect(executed).toEqual([{ kind: "desktop" }]);
    expect(result.message).toBe("Opened Codex Desktop session.");
  });

  it("targets the matching live CLI session when multiple sessions share a workspace", async () => {
    const temp = tempDir();
    const stateDb = path.join(temp, "state_5.sqlite");
    const sessionDir = path.join(temp, "sessions", "2026", "06", "10");
    fs.mkdirSync(sessionDir, { recursive: true });
    const workspacePath = "/Users/edy/hose/tmc_symposium/tmc_surprise";
    const firstId = "019eaa00-0000-7000-8000-000000000001";
    const secondId = "019eaa00-0000-7000-8000-000000000002";
    const firstRolloutPath = path.join(sessionDir, `rollout-2026-06-10T12-00-00-${firstId}.jsonl`);
    const secondRolloutPath = path.join(sessionDir, `rollout-2026-06-10T12-05-00-${secondId}.jsonl`);
    fs.writeFileSync(
      firstRolloutPath,
      [
        `{"timestamp":"2026-06-10T04:00:00.000Z","type":"session_meta","payload":{"id":"${firstId}","cwd":"${workspacePath}","originator":"Codex CLI","source":"cli"}}`,
        '{"timestamp":"2026-06-10T04:01:00.000Z","type":"event_msg","payload":{"type":"user_message","message":"first\\n"}}',
        "",
      ].join("\n"),
    );
    fs.writeFileSync(
      secondRolloutPath,
      [
        `{"timestamp":"2026-06-10T04:05:00.000Z","type":"session_meta","payload":{"id":"${secondId}","cwd":"${workspacePath}","originator":"Codex CLI","source":"cli"}}`,
        '{"timestamp":"2026-06-10T04:06:00.000Z","type":"event_msg","payload":{"type":"user_message","message":"second\\n"}}',
        "",
      ].join("\n"),
    );
    createThreadsTable(stateDb);
    insertThread({
      stateDb,
      id: firstId,
      rolloutPath: firstRolloutPath,
      cwd: workspacePath,
      title: "first",
      source: "cli",
      threadSource: "user",
      preview: "first",
      updatedAtMs: Date.parse("2026-06-10T04:01:00.000Z"),
    });
    insertThread({
      stateDb,
      id: secondId,
      rolloutPath: secondRolloutPath,
      cwd: workspacePath,
      title: "second",
      source: "cli",
      threadSource: "user",
      preview: "second",
      updatedAtMs: Date.parse("2026-06-10T04:06:00.000Z"),
    });
    const executed = [];

    await jumpToSession(secondId, {
      stateDbPath: stateDb,
      sessionsRoot: path.join(temp, "sessions"),
      nowMs: Date.parse("2026-06-10T04:10:00.000Z"),
      limit: 20,
      liveCliSessions: [
        { sessionId: firstId, workspacePath, tty: "ttys001" },
        { sessionId: secondId, workspacePath, tty: "ttys004" },
      ],
      previousITermTtyForWorkspace: () => undefined,
      executeJump: async (_row, plan) => executed.push(plan),
    });

    expect(executed).toEqual([{ kind: "iterm", tty: "ttys004", liveCodex: true }]);
  });

  it("focuses the live parent CLI tty when the process also has subagent files open", async () => {
    const temp = tempDir();
    const stateDb = path.join(temp, "state_5.sqlite");
    const sessionDir = path.join(temp, "sessions", "2026", "06", "11");
    fs.mkdirSync(sessionDir, { recursive: true });
    const workspacePath = "/Users/edy/hose/tmc_symposium/tmc_surprise";
    const parentId = "019eaa00-0000-7000-8000-000000000010";
    const childId = "019eaa00-0000-7000-8000-000000000011";
    const parentRolloutPath = path.join(sessionDir, `rollout-2026-06-11T12-00-00-${parentId}.jsonl`);
    const childRolloutPath = path.join(sessionDir, `rollout-2026-06-11T12-05-00-${childId}.jsonl`);
    fs.writeFileSync(
      parentRolloutPath,
      [
        `{"timestamp":"2026-06-11T04:00:00.000Z","type":"session_meta","payload":{"id":"${parentId}","cwd":"${workspacePath}","originator":"Codex CLI","source":"cli"}}`,
        '{"timestamp":"2026-06-11T04:01:00.000Z","type":"event_msg","payload":{"type":"user_message","message":"parent\\n"}}',
        "",
      ].join("\n"),
    );
    fs.writeFileSync(
      childRolloutPath,
      [
        `{"timestamp":"2026-06-11T04:05:00.000Z","type":"session_meta","payload":{"id":"${childId}","parent_thread_id":"${parentId}","cwd":"${workspacePath}","originator":"Codex CLI","source":"cli","thread_source":"subagent"}}`,
        '{"timestamp":"2026-06-11T04:06:00.000Z","type":"event_msg","payload":{"type":"user_message","message":"child\\n"}}',
        "",
      ].join("\n"),
    );
    createThreadsTable(stateDb);
    insertThread({
      stateDb,
      id: parentId,
      rolloutPath: parentRolloutPath,
      cwd: workspacePath,
      title: "Parent task",
      source: "cli",
      threadSource: "user",
      preview: "Parent task",
      updatedAtMs: Date.parse("2026-06-11T04:01:00.000Z"),
    });
    insertThread({
      stateDb,
      id: childId,
      rolloutPath: childRolloutPath,
      cwd: workspacePath,
      title: "Child task",
      source: "cli",
      threadSource: "subagent",
      preview: "Child task",
      updatedAtMs: Date.parse("2026-06-11T04:06:00.000Z"),
    });
    const executed = [];

    const result = await jumpToSession(parentId, {
      stateDbPath: stateDb,
      sessionsRoot: path.join(temp, "sessions"),
      nowMs: Date.parse("2026-06-11T04:10:00.000Z"),
      limit: 20,
      liveCliSessions: [{
        sessionId: childId,
        sessionIds: [childId, parentId],
        workspacePath,
        tty: "ttys002",
      }],
      previousITermTtyForWorkspace: () => "ttys003",
      executeJump: async (_row, plan) => executed.push(plan),
    });

    expect(executed).toEqual([{ kind: "iterm", tty: "ttys002", liveCodex: true }]);
    expect(result.message).toBe("Focused live iTerm Codex session.");
  });

  it("excludes archived SQLite threads from discovery", () => {
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

    expect(rows).toHaveLength(0);
  });

  it("adds archived CLI threads back when the exact session is live", () => {
    const temp = tempDir();
    const stateDb = path.join(temp, "state_5.sqlite");
    const archivedDir = path.join(temp, "archived_sessions");
    fs.mkdirSync(archivedDir, { recursive: true });
    const rolloutPath = path.join(archivedDir, "rollout-2026-06-04T14-30-34-019e9153-943a-7402-8e61-9e89cee5a6f4.jsonl");
    fs.writeFileSync(
      rolloutPath,
      [
        '{"timestamp":"2026-06-10T06:54:00.000Z","type":"session_meta","payload":{"id":"019e9153-943a-7402-8e61-9e89cee5a6f4","cwd":"/Users/edy/hose/tmc_symposium/tmc_surprise","originator":"Codex CLI","source":"cli"}}',
        '{"timestamp":"2026-06-10T06:55:00.000Z","type":"event_msg","payload":{"type":"user_message","message":"继续\\n"}}',
        "",
      ].join("\n"),
    );
    createThreadsTable(stateDb);
    insertThread({
      stateDb,
      id: "019e9153-943a-7402-8e61-9e89cee5a6f4",
      rolloutPath,
      cwd: "/Users/edy/hose/tmc_symposium/tmc_surprise",
      title: "commit the changes",
      source: "cli",
      threadSource: "user",
      preview: "commit the changes",
      updatedAtMs: Date.parse("2026-06-10T06:55:00.000Z"),
      archived: 1,
    });

    const rows = discoverCodexSessions({
      stateDbPath: stateDb,
      sessionsRoot: path.join(temp, "sessions"),
      nowMs: Date.parse("2026-06-10T07:00:00.000Z"),
      limit: 20,
      liveCliSessions: [{
        sessionId: "019e9153-943a-7402-8e61-9e89cee5a6f4",
        workspacePath: "/Users/edy/hose/tmc_symposium/tmc_surprise",
        tty: "ttys002",
      }],
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sessionId: "019e9153-943a-7402-8e61-9e89cee5a6f4",
      label: "commit the changes",
      state: "running",
      confidence: "exact",
      workspacePath: "/Users/edy/hose/tmc_symposium/tmc_surprise",
      jumpTarget: "cli",
      jumpAvailability: "approximate",
      statusReason: "running signal observed",
    });
  });

  it("keeps a completed matching live CLI row in inspect instead of marking it running", () => {
    const temp = tempDir();
    const stateDb = path.join(temp, "state_5.sqlite");
    const sessionDir = path.join(temp, "sessions", "2026", "06", "09");
    fs.mkdirSync(sessionDir, { recursive: true });
    const rolloutPath = path.join(sessionDir, "rollout-2026-06-09T15-55-11-019eab60-da30-7ea3-8b66-b53dd94db260.jsonl");
    fs.writeFileSync(
      rolloutPath,
      [
        '{"timestamp":"2026-06-09T07:55:00.000Z","type":"session_meta","payload":{"id":"019eab60-da30-7ea3-8b66-b53dd94db260","cwd":"/Users/edy/hose/tmc_symposium/tmc_surprise","originator":"Codex CLI","source":"cli"}}',
        '{"timestamp":"2026-06-09T08:07:25.205Z","type":"event_msg","payload":{"type":"task_complete"}}',
        "",
      ].join("\n"),
    );
    createThreadsTable(stateDb);
    insertThread({
      stateDb,
      id: "019eab60-da30-7ea3-8b66-b53dd94db260",
      rolloutPath,
      cwd: "/Users/edy/hose/tmc_symposium/tmc_surprise",
      title: "从master切一个新的workspace",
      source: "cli",
      threadSource: "user",
      preview: "从master切一个新的workspace",
      updatedAtMs: Date.parse("2026-06-09T08:07:25.205Z"),
    });

    const rows = discoverCodexSessions({
      stateDbPath: stateDb,
      sessionsRoot: path.join(temp, "sessions"),
      nowMs: Date.parse("2026-06-10T07:00:00.000Z"),
      limit: 20,
      liveCliSessions: [{
        sessionId: "019eab60-da30-7ea3-8b66-b53dd94db260",
        workspacePath: "/Users/edy/hose/tmc_symposium/tmc_surprise",
        tty: "ttys012",
      }],
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sessionId: "019eab60-da30-7ea3-8b66-b53dd94db260",
      state: "inspect",
      confidence: "exact",
      statusReason: "completed task ready to inspect; open it to mark read",
    });
  });

  it("keeps a stale completed matching live CLI row idle instead of marking it running", () => {
    const temp = tempDir();
    const stateDb = path.join(temp, "state_5.sqlite");
    const sessionDir = path.join(temp, "sessions", "2026", "06", "09");
    fs.mkdirSync(sessionDir, { recursive: true });
    const rolloutPath = path.join(sessionDir, "rollout-2026-06-09T15-55-11-019eab60-da30-7ea3-8b66-b53dd94db261.jsonl");
    fs.writeFileSync(
      rolloutPath,
      [
        '{"timestamp":"2026-06-09T07:55:00.000Z","type":"session_meta","payload":{"id":"019eab60-da30-7ea3-8b66-b53dd94db261","cwd":"/Users/edy/hose/tmc_symposium/tmc_surprise","originator":"Codex CLI","source":"cli"}}',
        '{"timestamp":"2026-06-09T08:07:25.205Z","type":"event_msg","payload":{"type":"task_complete","turn_id":"external-import-turn-1"}}',
        "",
      ].join("\n"),
    );
    createThreadsTable(stateDb);
    insertThread({
      stateDb,
      id: "019eab60-da30-7ea3-8b66-b53dd94db261",
      rolloutPath,
      cwd: "/Users/edy/hose/tmc_symposium/tmc_surprise",
      title: "外部终端完成的任务",
      source: "cli",
      threadSource: "user",
      preview: "外部终端完成的任务",
      updatedAtMs: Date.parse("2026-06-09T08:07:25.205Z"),
    });

    const rows = discoverCodexSessions({
      stateDbPath: stateDb,
      sessionsRoot: path.join(temp, "sessions"),
      nowMs: Date.parse("2026-06-10T07:00:00.000Z"),
      limit: 20,
      liveCliSessions: [{
        sessionId: "019eab60-da30-7ea3-8b66-b53dd94db261",
        workspacePath: "/Users/edy/hose/tmc_symposium/tmc_surprise",
        tty: "ttys012",
      }],
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sessionId: "019eab60-da30-7ea3-8b66-b53dd94db261",
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

  it("keeps a completed session terminal when a response item follows task_complete", () => {
    const temp = tempDir();
    const stateDb = path.join(temp, "state_5.sqlite");
    const sessionDir = path.join(temp, "sessions", "2026", "06", "03");
    fs.mkdirSync(sessionDir, { recursive: true });
    const rolloutPath = path.join(sessionDir, "rollout-2026-06-03T10-00-00-019done-response.jsonl");
    fs.writeFileSync(
      rolloutPath,
      [
        '{"timestamp":"2026-06-03T02:00:00.000Z","type":"session_meta","payload":{"id":"019done-response","cwd":"/Users/edy/wmhcar","originator":"Codex Desktop","source":"vscode"}}',
        '{"timestamp":"2026-06-03T02:20:00.000Z","type":"event_msg","payload":{"type":"task_complete"}}',
        '{"timestamp":"2026-06-03T02:21:00.000Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[]}}',
        "",
      ].join("\n"),
    );
    createThreadsTable(stateDb);
    insertThread({
      stateDb,
      id: "019done-response",
      rolloutPath,
      cwd: "/Users/edy/wmhcar",
      title: "Completed response item",
      updatedAtMs: Date.parse("2026-06-03T02:21:00.000Z"),
    });

    const rows = discoverCodexSessions({
      stateDbPath: stateDb,
      sessionsRoot: path.join(temp, "sessions"),
      nowMs: Date.parse("2026-06-03T02:25:00.000Z"),
      liveCliSessions: [],
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sessionId: "019done-response",
      state: "idle",
      lastActivityAt: "2026-06-03T02:20:00.000Z",
    });
  });

  it("marks Desktop and CLI command approval prompts as needing attention", () => {
    const temp = tempDir();
    const sessionDir = path.join(temp, "sessions", "2026", "06", "06");
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionDir, "rollout-2026-06-06T12-00-00-019desktop-approval.jsonl"),
      [
        '{"timestamp":"2026-06-06T04:00:00.000Z","type":"session_meta","payload":{"id":"019desktop-approval","cwd":"/Users/edy/project-desktop","originator":"Codex Desktop","source":"vscode"}}',
        '{"timestamp":"2026-06-06T04:01:00.000Z","type":"event_msg","payload":{"type":"user_message","message":"build desktop\\n"}}',
        '{"timestamp":"2026-06-06T04:05:00.000Z","type":"response_item","payload":{"type":"function_call","name":"exec_command","arguments":"{\\"cmd\\":\\"npm run build\\",\\"sandbox_permissions\\":\\"require_escalated\\",\\"justification\\":\\"Need network access\\"}","call_id":"call_desktop"}}',
        "",
      ].join("\n"),
    );
    fs.writeFileSync(
      path.join(sessionDir, "rollout-2026-06-06T12-00-00-019cli-approval.jsonl"),
      [
        '{"timestamp":"2026-06-06T04:00:00.000Z","type":"session_meta","payload":{"id":"019cli-approval","cwd":"/Users/edy/project-cli","originator":"Codex CLI","source":"cli"}}',
        '{"timestamp":"2026-06-06T04:01:00.000Z","type":"event_msg","payload":{"type":"user_message","message":"build cli\\n"}}',
        '{"timestamp":"2026-06-06T04:06:00.000Z","type":"response_item","payload":{"type":"function_call","name":"exec_command","arguments":"{\\"cmd\\":\\"npm run build\\",\\"sandbox_permissions\\":\\"require_escalated\\",\\"justification\\":\\"Need network access\\"}","call_id":"call_cli"}}',
        "",
      ].join("\n"),
    );

    const rows = discoverCodexSessions({
      stateDbPath: path.join(temp, "missing.sqlite"),
      sessionsRoot: path.join(temp, "sessions"),
      nowMs: Date.parse("2026-06-06T04:10:00.000Z"),
      limit: 20,
      liveCliTtyForWorkspace: () => undefined,
    }).sort((left, right) => left.sessionId.localeCompare(right.sessionId));

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      sessionId: "019cli-approval",
      state: "idle",
      confidence: "inferred",
      statusReason: "No live Codex CLI process for pending input; idle until the next source signal.",
      jumpTarget: "cli",
      lastActivityAt: "2026-06-06T04:06:00.000Z",
      evidenceSummary: "Codex is waiting for tool approval: npm run build",
    });
    expect(rows[1]).toMatchObject({
      sessionId: "019desktop-approval",
      state: "waitingForInput",
      confidence: "exact",
      jumpTarget: "desktop",
      lastActivityAt: "2026-06-06T04:05:00.000Z",
    });
  });

  it("keeps CLI command approval prompts waiting when a live CLI process exists", () => {
    const temp = tempDir();
    const sessionDir = path.join(temp, "sessions", "2026", "06", "06");
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionDir, "rollout-2026-06-06T12-00-00-019cli-live-approval.jsonl"),
      [
        '{"timestamp":"2026-06-06T04:00:00.000Z","type":"session_meta","payload":{"id":"019cli-live-approval","cwd":"/Users/edy/project-cli","originator":"Codex CLI","source":"cli"}}',
        '{"timestamp":"2026-06-06T04:06:00.000Z","type":"response_item","payload":{"type":"function_call","name":"exec_command","arguments":"{\\"cmd\\":\\"npm run build\\",\\"sandbox_permissions\\":\\"require_escalated\\",\\"justification\\":\\"Need network access\\"}","call_id":"call_cli"}}',
        "",
      ].join("\n"),
    );

    const rows = discoverCodexSessions({
      stateDbPath: path.join(temp, "missing.sqlite"),
      sessionsRoot: path.join(temp, "sessions"),
      nowMs: Date.parse("2026-06-06T04:10:00.000Z"),
      limit: 20,
      liveCliTtyForWorkspace: () => "ttys123",
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sessionId: "019cli-live-approval",
      state: "waitingForInput",
      confidence: "exact",
      statusReason: "waiting for user input",
      jumpTarget: "cli",
      evidenceSummary: "Codex is waiting for tool approval: npm run build",
    });
  });

  it("supersedes an unresolved Desktop approval when a newer user message starts a turn", () => {
    const temp = tempDir();
    const sessionDir = path.join(temp, "sessions", "2026", "06", "06");
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionDir, "rollout-2026-06-06T12-00-00-019approval-new-turn.jsonl"),
      [
        '{"timestamp":"2026-06-06T04:00:00.000Z","type":"session_meta","payload":{"id":"019approval-new-turn","cwd":"/Users/edy/project-desktop","originator":"Codex Desktop","source":"vscode"}}',
        '{"timestamp":"2026-06-06T04:05:00.000Z","type":"response_item","payload":{"type":"function_call","name":"exec_command","arguments":"{\\"cmd\\":\\"npm run build\\",\\"sandbox_permissions\\":\\"require_escalated\\",\\"justification\\":\\"Need approval\\"}","call_id":"call_desktop"}}',
        '{"timestamp":"2026-06-06T04:06:00.000Z","type":"event_msg","payload":{"type":"user_message","message":"Continue with another task"}}',
        "",
      ].join("\n"),
    );

    const rows = discoverCodexSessions({
      stateDbPath: path.join(temp, "missing.sqlite"),
      sessionsRoot: path.join(temp, "sessions"),
      nowMs: Date.parse("2026-06-06T04:10:00.000Z"),
      limit: 20,
      liveCliTtyForWorkspace: () => undefined,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sessionId: "019approval-new-turn",
      state: "running",
      jumpTarget: "desktop",
      lastActivityAt: "2026-06-06T04:06:00.000Z",
    });
  });

  it("does not supersede a Desktop approval with a delayed older user message", () => {
    const temp = tempDir();
    const sessionDir = path.join(temp, "sessions", "2026", "06", "06");
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionDir, "rollout-2026-06-06T12-00-00-019approval-older-turn.jsonl"),
      [
        '{"timestamp":"2026-06-06T04:00:00.000Z","type":"session_meta","payload":{"id":"019approval-older-turn","cwd":"/Users/edy/project-desktop","originator":"Codex Desktop","source":"vscode"}}',
        '{"timestamp":"2026-06-06T04:05:00.000Z","type":"response_item","payload":{"type":"function_call","name":"exec_command","arguments":"{\\"cmd\\":\\"npm run build\\",\\"sandbox_permissions\\":\\"require_escalated\\",\\"justification\\":\\"Need approval\\"}","call_id":"call_desktop"}}',
        '{"timestamp":"2026-06-06T04:04:00.000Z","type":"event_msg","payload":{"type":"user_message","message":"Delayed older message"}}',
        "",
      ].join("\n"),
    );

    const rows = discoverCodexSessions({
      stateDbPath: path.join(temp, "missing.sqlite"),
      sessionsRoot: path.join(temp, "sessions"),
      nowMs: Date.parse("2026-06-06T04:10:00.000Z"),
      limit: 20,
      liveCliTtyForWorkspace: () => undefined,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sessionId: "019approval-older-turn",
      state: "waitingForInput",
      jumpTarget: "desktop",
      lastActivityAt: "2026-06-06T04:05:00.000Z",
      evidenceSummary: "Codex is waiting for tool approval: npm run build",
    });
  });

  it("clears command approval attention after matching function output arrives", () => {
    const temp = tempDir();
    const sessionDir = path.join(temp, "sessions", "2026", "06", "06");
    fs.mkdirSync(sessionDir, { recursive: true });
    const rolloutPath = path.join(sessionDir, "rollout-2026-06-06T12-00-00-019approval-cleared.jsonl");
    fs.writeFileSync(
      rolloutPath,
      [
        '{"timestamp":"2026-06-06T04:00:00.000Z","type":"session_meta","payload":{"id":"019approval-cleared","cwd":"/Users/edy/project-cli","originator":"Codex CLI","source":"cli"}}',
        '{"timestamp":"2026-06-06T04:05:00.000Z","type":"response_item","payload":{"type":"function_call","name":"exec_command","arguments":"{\\"cmd\\":\\"npm run build\\",\\"sandbox_permissions\\":\\"require_escalated\\",\\"justification\\":\\"Need network access\\"}","call_id":"call_cli"}}',
        '{"timestamp":"2026-06-06T04:06:00.000Z","type":"response_item","payload":{"type":"function_call_output","call_id":"call_cli","output":"approved"}}',
        "",
      ].join("\n"),
    );

    const rows = discoverCodexSessions({
      stateDbPath: path.join(temp, "missing.sqlite"),
      sessionsRoot: path.join(temp, "sessions"),
      nowMs: Date.parse("2026-06-06T04:10:00.000Z"),
      limit: 20,
      liveCliTtyForWorkspace: () => undefined,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sessionId: "019approval-cleared",
      state: "running",
      statusReason: "running signal observed",
      lastActivityAt: "2026-06-06T04:06:00.000Z",
      evidenceSummary: "local Codex JSONL activity observed",
    });
  });

  it("marks interrupted command approval prompts as stopped", () => {
    const temp = tempDir();
    const sessionDir = path.join(temp, "sessions", "2026", "06", "06");
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionDir, "rollout-2026-06-06T12-00-00-019approval-interrupted.jsonl"),
      [
        '{"timestamp":"2026-06-06T04:00:00.000Z","type":"session_meta","payload":{"id":"019approval-interrupted","cwd":"/Users/edy/project-cli","originator":"Codex CLI","source":"cli"}}',
        '{"timestamp":"2026-06-06T04:05:00.000Z","type":"response_item","payload":{"type":"function_call","name":"exec_command","arguments":"{\\"cmd\\":\\"git pull --ff-only origin develop\\",\\"sandbox_permissions\\":\\"require_escalated\\",\\"justification\\":\\"Need approval\\"}","call_id":"call_cli"}}',
        '{"timestamp":"2026-06-06T04:06:00.000Z","type":"event_msg","payload":{"type":"turn_aborted","reason":"interrupted"}}',
        "",
      ].join("\n"),
    );

    const rows = discoverCodexSessions({
      stateDbPath: path.join(temp, "missing.sqlite"),
      sessionsRoot: path.join(temp, "sessions"),
      nowMs: Date.parse("2026-06-06T04:10:00.000Z"),
      limit: 20,
      liveCliTtyForWorkspace: () => undefined,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sessionId: "019approval-interrupted",
      state: "stopped",
      statusReason: "stopped before completion; decide whether to continue, inspect, or dismiss",
      evidenceSummary: "local Codex JSONL activity observed",
    });
  });

  it("keeps manually paused Desktop sessions stopped despite recent sqlite updates", () => {
    const temp = tempDir();
    const stateDb = path.join(temp, "state_5.sqlite");
    const sessionDir = path.join(temp, "sessions", "2026", "06", "15");
    fs.mkdirSync(sessionDir, { recursive: true });
    const rolloutPath = path.join(sessionDir, "rollout-2026-06-15T11-07-35-019paused.jsonl");
    fs.writeFileSync(
      rolloutPath,
      [
        '{"timestamp":"2026-06-15T03:07:36.032Z","type":"session_meta","payload":{"id":"019paused","cwd":"/Users/edy/hose/tmc/wmhcar","originator":"Codex Desktop","source":"vscode"}}',
        '{"timestamp":"2026-06-15T03:30:56.909Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<turn_aborted>\\nThe user interrupted the previous turn on purpose.\\n</turn_aborted>"}]}}',
        '{"timestamp":"2026-06-15T03:30:56.989Z","type":"event_msg","payload":{"type":"turn_aborted","reason":"interrupted"}}',
        "",
      ].join("\n"),
    );
    createThreadsTable(stateDb);
    insertThread({
      stateDb,
      id: "019paused",
      rolloutPath,
      cwd: "/Users/edy/hose/tmc/wmhcar",
      title: "调整 IM 接口实现",
      source: "vscode",
      threadSource: "user",
      preview: "调整 IM 接口实现",
      updatedAtMs: Date.parse("2026-06-15T03:30:56.989Z"),
    });

    const rows = discoverCodexSessions({
      stateDbPath: stateDb,
      sessionsRoot: path.join(temp, "sessions"),
      nowMs: Date.parse("2026-06-15T03:40:00.000Z"),
      limit: 20,
      liveCliTtyForWorkspace: () => undefined,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sessionId: "019paused",
      state: "stopped",
      statusReason: "stopped before completion; decide whether to continue, inspect, or dismiss",
      jumpTarget: "desktop",
      jumpAvailability: "exact",
    });
  });

  it("does not show stale CLI approval prompts as waiting for input without a live CLI process", () => {
    const temp = tempDir();
    const sessionDir = path.join(temp, "sessions", "2026", "06", "06");
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionDir, "rollout-2026-06-06T12-00-00-019stale-cli-approval.jsonl"),
      [
        '{"timestamp":"2026-06-06T04:00:00.000Z","type":"session_meta","payload":{"id":"019stale-cli-approval","cwd":"/Users/edy/project-cli","originator":"Codex CLI","source":"cli"}}',
        '{"timestamp":"2026-06-06T04:05:00.000Z","type":"response_item","payload":{"type":"function_call","name":"exec_command","arguments":"{\\"cmd\\":\\"git pull --ff-only origin develop\\",\\"sandbox_permissions\\":\\"require_escalated\\",\\"justification\\":\\"Need approval\\"}","call_id":"call_cli"}}',
        "",
      ].join("\n"),
    );

    const rows = discoverCodexSessions({
      stateDbPath: path.join(temp, "missing.sqlite"),
      sessionsRoot: path.join(temp, "sessions"),
      nowMs: Date.parse("2026-06-06T04:10:00.000Z"),
      limit: 20,
      liveCliTtyForWorkspace: () => undefined,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sessionId: "019stale-cli-approval",
      state: "idle",
      confidence: "inferred",
      statusReason: "No live Codex CLI process for pending input; idle until the next source signal.",
    });
  });

  it("does not show stale CLI approval prompts as waiting for input when another live CLI exists", () => {
    const temp = tempDir();
    const sessionDir = path.join(temp, "sessions", "2026", "06", "06");
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionDir, "rollout-2026-06-06T12-00-00-019stale-cli-live-approval.jsonl"),
      [
        '{"timestamp":"2026-06-06T04:00:00.000Z","type":"session_meta","payload":{"id":"019stale-cli-live-approval","cwd":"/Users/edy/project-cli","originator":"Codex CLI","source":"cli"}}',
        '{"timestamp":"2026-06-06T04:05:00.000Z","type":"response_item","payload":{"type":"function_call","name":"exec_command","arguments":"{\\"cmd\\":\\"git pull --ff-only origin develop\\",\\"sandbox_permissions\\":\\"require_escalated\\",\\"justification\\":\\"Need approval\\"}","call_id":"call_cli"}}',
        "",
      ].join("\n"),
    );

    const rows = discoverCodexSessions({
      stateDbPath: path.join(temp, "missing.sqlite"),
      sessionsRoot: path.join(temp, "sessions"),
      nowMs: Date.parse("2026-06-06T04:40:01.000Z"),
      limit: 20,
      liveCliTtyForWorkspace: () => "ttys123",
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sessionId: "019stale-cli-live-approval",
      state: "idle",
      confidence: "inferred",
      statusReason: "Pending CLI input is stale; idle until the next source signal.",
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

  it("reports a JSONL fallback snapshot as degraded source health", () => {
    const temp = tempDir();
    const stateDb = path.join(temp, "state_5.sqlite");
    const sessionsRoot = path.join(temp, "sessions");
    fs.mkdirSync(sessionsRoot, { recursive: true });

    const health = sourceHealth({
      stateDbPath: stateDb,
      sessionsRoot,
      snapshot: {
        isDegraded: true,
        sqliteError: "database is locked",
      },
    });

    expect(health.status).toBe("degraded");
    expect(health.capabilities.find((capability) => capability.name === "Thread discovery"))
      .toMatchObject({
        availability: "inferred",
        detail: expect.stringContaining("database is locked"),
      });
  });

  it("keeps missing SQLite discovery unavailable before the first source snapshot", () => {
    const temp = tempDir();
    const sessionsRoot = path.join(temp, "sessions");
    fs.mkdirSync(sessionsRoot, { recursive: true });

    const health = sourceHealth({
      stateDbPath: path.join(temp, "missing-state.sqlite"),
      sessionsRoot,
    });

    expect(health.status).toBe("available");
    expect(health.capabilities.find((capability) => capability.name === "Thread discovery"))
      .toMatchObject({ availability: "unavailable" });
  });

  it("retains the source instance's latest degraded snapshot for health reporting", () => {
    const temp = tempDir();
    const sessionsRoot = path.join(temp, "sessions");
    fs.mkdirSync(sessionsRoot, { recursive: true });
    const source = createCodexSessionsDevSource({
      stateDbPath: path.join(temp, "missing-state.sqlite"),
      sessionsRoot,
      liveCliTtyForWorkspace: () => undefined,
    });

    source.discoverCodexSessions();

    expect(source.sourceHealth()).toMatchObject({ status: "degraded" });
  });

  it("waits for a second healthy SQLite idle snapshot before hiding a Desktop running row", () => {
    const temp = tempDir();
    const stateDb = path.join(temp, "state_5.sqlite");
    const sessionsRoot = path.join(temp, "sessions");
    const sessionDir = path.join(sessionsRoot, "2026", "06", "17");
    const rolloutPath = path.join(sessionDir, "rollout-2026-06-17T09-00-00-019desktop-stability.jsonl");
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(
      rolloutPath,
      [
        '{"timestamp":"2026-06-17T00:00:00.000Z","type":"session_meta","payload":{"id":"019desktop-stability","cwd":"/Users/edy/project-desktop","originator":"Codex Desktop","source":"vscode"}}',
        "",
      ].join("\n"),
    );
    createThreadsTable(stateDb);
    insertThread({
      stateDb,
      id: "019desktop-stability",
      rolloutPath,
      cwd: "/Users/edy/project-desktop",
      title: "Desktop stability",
      source: "vscode",
      threadSource: "user",
      preview: "Desktop stability",
      updatedAtMs: Date.parse("2026-06-17T01:00:00.000Z"),
    });
    const source = createCodexSessionsDevSource({
      stateDbPath: stateDb,
      sessionsRoot,
      nowMs: Date.parse("2026-06-17T01:10:00.000Z"),
      limit: 20,
      liveCliTtyForWorkspace: () => undefined,
    });

    expect(source.discoverCodexSessions()[0]).toMatchObject({
      sessionId: "019desktop-stability",
      state: "running",
    });

    fs.writeFileSync(
      rolloutPath,
      [
        '{"timestamp":"2026-06-16T22:00:00.000Z","type":"session_meta","payload":{"id":"019desktop-stability","cwd":"/Users/edy/project-desktop","originator":"Codex Desktop","source":"vscode"}}',
        "",
      ].join("\n"),
    );
    execFileSync("sqlite3", [
      stateDb,
      `update threads set updated_at_ms = ${Date.parse("2026-06-16T22:00:00.000Z")} where id = '019desktop-stability';`,
    ]);

    expect(source.discoverCodexSessions()[0]).toMatchObject({
      sessionId: "019desktop-stability",
      state: "running",
    });
    expect(source.discoverCodexSessions({
      stateDbPath: path.join(temp, "missing-state.sqlite"),
      sessionsRoot: path.join(temp, "missing-sessions"),
    })[0]).toMatchObject({
      sessionId: "019desktop-stability",
      state: "running",
    });
    expect(source.discoverCodexSessions()[0]).toMatchObject({
      sessionId: "019desktop-stability",
      state: "running",
    });
    expect(source.discoverCodexSessions()[0]).toMatchObject({
      sessionId: "019desktop-stability",
      state: "idle",
    });
  });

  it("retains a Desktop running row through a degraded missing SQLite snapshot and reconfirms idle after recovery", () => {
    const temp = tempDir();
    const stateDb = path.join(temp, "state_5.sqlite");
    const sessionsRoot = path.join(temp, "sessions");
    const sessionDir = path.join(sessionsRoot, "2026", "06", "17");
    const rolloutPath = path.join(sessionDir, "rollout-2026-06-17T09-00-00-019desktop-recovery.jsonl");
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(
      rolloutPath,
      [
        '{"timestamp":"2026-06-17T00:00:00.000Z","type":"session_meta","payload":{"id":"019desktop-recovery","cwd":"/Users/edy/project-desktop","originator":"Codex Desktop","source":"vscode"}}',
        "",
      ].join("\n"),
    );
    createThreadsTable(stateDb);
    insertThread({
      stateDb,
      id: "019desktop-recovery",
      rolloutPath,
      cwd: "/Users/edy/project-desktop",
      title: "Desktop recovery",
      source: "vscode",
      threadSource: "user",
      preview: "Desktop recovery",
      updatedAtMs: Date.parse("2026-06-17T01:00:00.000Z"),
    });
    const source = createCodexSessionsDevSource({
      stateDbPath: stateDb,
      sessionsRoot,
      nowMs: Date.parse("2026-06-17T01:10:00.000Z"),
      limit: 20,
      liveCliTtyForWorkspace: () => undefined,
    });

    expect(source.discoverCodexSessions()[0]).toMatchObject({
      sessionId: "019desktop-recovery",
      state: "running",
    });

    const degradedRows = source.discoverCodexSessions({
      stateDbPath: path.join(temp, "missing-state.sqlite"),
      sessionsRoot: path.join(temp, "missing-sessions"),
    });
    expect(degradedRows).toHaveLength(1);
    expect(degradedRows[0]).toMatchObject({
      sessionId: "019desktop-recovery",
      state: "running",
    });
    expect(source.discoverCodexSessions({
      stateDbPath: path.join(temp, "missing-state.sqlite"),
      sessionsRoot: path.join(temp, "missing-sessions"),
    })[0]).toMatchObject({
      sessionId: "019desktop-recovery",
      state: "unknown",
      statusReason: expect.stringContaining("source unavailable"),
    });

    fs.writeFileSync(
      rolloutPath,
      [
        '{"timestamp":"2026-06-16T22:00:00.000Z","type":"session_meta","payload":{"id":"019desktop-recovery","cwd":"/Users/edy/project-desktop","originator":"Codex Desktop","source":"vscode"}}',
        "",
      ].join("\n"),
    );
    execFileSync("sqlite3", [
      stateDb,
      `update threads set updated_at_ms = ${Date.parse("2026-06-16T22:00:00.000Z")} where id = '019desktop-recovery';`,
    ]);

    expect(source.discoverCodexSessions()[0]).toMatchObject({
      sessionId: "019desktop-recovery",
      state: "running",
    });
    expect(source.discoverCodexSessions()[0]).toMatchObject({
      sessionId: "019desktop-recovery",
      state: "idle",
    });
  });

  it("waits for a second healthy missing snapshot before hiding a Desktop running row", () => {
    const temp = tempDir();
    const stateDb = path.join(temp, "state_5.sqlite");
    const sessionsRoot = path.join(temp, "sessions");
    const sessionDir = path.join(sessionsRoot, "2026", "06", "17");
    const rolloutPath = path.join(sessionDir, "rollout-2026-06-17T09-00-00-019desktop-missing.jsonl");
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(
      rolloutPath,
      [
        '{"timestamp":"2026-06-17T00:00:00.000Z","type":"session_meta","payload":{"id":"019desktop-missing","cwd":"/Users/edy/project-desktop","originator":"Codex Desktop","source":"vscode"}}',
        "",
      ].join("\n"),
    );
    createThreadsTable(stateDb);
    insertThread({
      stateDb,
      id: "019desktop-missing",
      rolloutPath,
      cwd: "/Users/edy/project-desktop",
      title: "Desktop missing",
      source: "vscode",
      threadSource: "user",
      preview: "Desktop missing",
      updatedAtMs: Date.parse("2026-06-17T01:00:00.000Z"),
    });
    const source = createCodexSessionsDevSource({
      stateDbPath: stateDb,
      sessionsRoot,
      nowMs: Date.parse("2026-06-17T01:10:00.000Z"),
      limit: 20,
      liveCliTtyForWorkspace: () => undefined,
    });

    expect(source.discoverCodexSessions()[0]).toMatchObject({
      sessionId: "019desktop-missing",
      state: "running",
    });

    execFileSync("sqlite3", [stateDb, "delete from threads where id = '019desktop-missing';"]);

    expect(source.discoverCodexSessions()[0]).toMatchObject({
      sessionId: "019desktop-missing",
      state: "running",
      statusReason: expect.stringContaining("missing from one SQLite snapshot"),
    });
    expect(source.discoverCodexSessions()).toHaveLength(0);
  });

  it("does not delay terminal completed-stale or CLI idle rows after a Desktop running row", () => {
    const temp = tempDir();
    const stateDb = path.join(temp, "state_5.sqlite");
    const sessionsRoot = path.join(temp, "sessions");
    const sessionDir = path.join(sessionsRoot, "2026", "06", "17");
    const desktopRolloutPath = path.join(sessionDir, "rollout-2026-06-17T09-00-00-019desktop-terminal.jsonl");
    const cliRolloutPath = path.join(sessionDir, "rollout-2026-06-17T09-00-00-019cli-idle.jsonl");
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(
      desktopRolloutPath,
      [
        '{"timestamp":"2026-06-17T00:00:00.000Z","type":"session_meta","payload":{"id":"019desktop-terminal","cwd":"/Users/edy/project-desktop","originator":"Codex Desktop","source":"vscode"}}',
        "",
      ].join("\n"),
    );
    fs.writeFileSync(
      cliRolloutPath,
      [
        '{"timestamp":"2026-06-17T00:00:00.000Z","type":"session_meta","payload":{"id":"019cli-idle","cwd":"/Users/edy/project-cli","originator":"Codex CLI","source":"cli"}}',
        '{"timestamp":"2026-06-17T00:01:00.000Z","type":"response_item","payload":{"type":"function_call","name":"exec_command","arguments":"{\\"cmd\\":\\"npm run build\\",\\"sandbox_permissions\\":\\"require_escalated\\"}","call_id":"call_cli_idle"}}',
        "",
      ].join("\n"),
    );
    createThreadsTable(stateDb);
    insertThread({
      stateDb,
      id: "019desktop-terminal",
      rolloutPath: desktopRolloutPath,
      cwd: "/Users/edy/project-desktop",
      title: "Desktop terminal",
      source: "vscode",
      threadSource: "user",
      preview: "Desktop terminal",
      updatedAtMs: Date.parse("2026-06-17T01:00:00.000Z"),
    });
    insertThread({
      stateDb,
      id: "019cli-idle",
      rolloutPath: cliRolloutPath,
      cwd: "/Users/edy/project-cli",
      title: "CLI idle",
      source: "cli",
      threadSource: "user",
      preview: "CLI idle",
      updatedAtMs: Date.parse("2026-06-17T00:01:00.000Z"),
    });
    const source = createCodexSessionsDevSource({
      stateDbPath: stateDb,
      sessionsRoot,
      nowMs: Date.parse("2026-06-17T01:10:00.000Z"),
      limit: 20,
      liveCliTtyForWorkspace: () => undefined,
    });

    expect(source.discoverCodexSessions().find((row) => row.sessionId === "019desktop-terminal")).toMatchObject({
      state: "running",
    });

    fs.writeFileSync(
      desktopRolloutPath,
      [
        '{"timestamp":"2026-05-31T00:00:00.000Z","type":"session_meta","payload":{"id":"019desktop-terminal","cwd":"/Users/edy/project-desktop","originator":"Codex Desktop","source":"vscode"}}',
        '{"timestamp":"2026-05-31T00:01:00.000Z","type":"event_msg","payload":{"type":"task_complete"}}',
        "",
      ].join("\n"),
    );
    execFileSync("sqlite3", [
      stateDb,
      `update threads set updated_at_ms = ${Date.parse("2026-06-01T00:01:00.000Z")} where id = '019desktop-terminal';`,
    ]);

    const rows = source.discoverCodexSessions();
    expect(rows.find((row) => row.sessionId === "019desktop-terminal")).toMatchObject({
      state: "idle",
      statusReason: "completed task is no longer recent; idle until the next source signal",
    });
    expect(rows.find((row) => row.sessionId === "019cli-idle")).toMatchObject({
      state: "idle",
      jumpTarget: "cli",
      statusReason: "No live Codex CLI process for pending input; idle until the next source signal.",
    });
  });
});

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-source-"));
  tempDirs.push(dir);
  return dir;
}

function createThreadsTable(stateDb, { includeSpawnEdges = true } = {}) {
  const spawnEdgesTable = includeSpawnEdges
    ? "\n     create table thread_spawn_edges (child_thread_id text primary key, parent_thread_id text not null);"
    : "";
  execFileSync("sqlite3", [
    stateDb,
    `create table threads (id text primary key, rollout_path text not null, created_at integer not null, updated_at integer not null, source text not null, model_provider text not null, cwd text not null, title text not null, sandbox_policy text not null, approval_mode text not null, tokens_used integer not null default 0, has_user_event integer not null default 0, archived integer not null default 0, archived_at integer, git_sha text, git_branch text, git_origin_url text, cli_version text not null default '', first_user_message text not null default '', agent_nickname text, agent_role text, memory_mode text not null default 'enabled', model text, reasoning_effort text, agent_path text, created_at_ms integer, updated_at_ms integer, thread_source text, preview text not null default '');${spawnEdgesTable}`,
  ]);
}

function restoreEnvironmentVariables(values) {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
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
