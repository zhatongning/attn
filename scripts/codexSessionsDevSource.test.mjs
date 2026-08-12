import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createCodexSessionsDevSource,
  defaultCodexStateDbPath,
  discoverCodexSessions,
  jumpToSession,
  normalizeFollowUpToIdleMinutes,
  parseCodexProcessLine,
  selectLiveCliPrimarySessionId,
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

  it("sorts running ahead of follow-up and stopped rows", () => {
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
        id: "019needed",
        event: '{"timestamp":"2026-06-17T01:01:00.000Z","type":"event_msg","payload":{"type":"task_complete"}}',
        updatedAtMs: Date.parse("2026-06-17T01:01:30.000Z"),
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
      "running",
      "needsAttention",
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

  it("reads parent thread ids from subagent session metadata", () => {
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

    const rows = discoverCodexSessions({
      stateDbPath: stateDb,
      sessionsRoot: path.join(temp, "sessions"),
      nowMs: Date.parse("2026-06-11T09:20:00.000Z"),
      unreadCompletionTrackingStartMs: earlyTrackingStartMs,
      limit: 20,
      liveCliTtyForWorkspace: () => undefined,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sessionId: "019child",
      threadSource: "subagent",
      parentSessionId: "019parent",
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

  it("uses the configured follow-up boundary for SQLite read signals", () => {
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
      state: "needsAttention",
      statusReason: "completed task was opened; keep it quiet during the follow-up window",
      lastActivityAt: "2026-06-06T04:10:00.000Z",
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
      state: "idle",
      statusReason: "completed task is no longer recent; idle until the next source signal",
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

    await source.jumpToSession("019read-window");
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

  it("jumps Desktop-sourced rows to a live CLI terminal in the same workspace", async () => {
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

    expect(executed).toEqual([{ kind: "iterm", tty: "ttys009", liveCodex: true }]);
    expect(result.message).toBe("Focused live iTerm Codex session.");
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
