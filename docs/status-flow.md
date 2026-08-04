# Status Flow Rules

This document is the working specification for session status classification and state transitions.
The status model is the core product behavior of Agent Session Inbox. Treat this file as the source of truth while we refine the design.

## Product Goal

Agent Session Inbox is not a dashboard. It should keep multiple agent sessions visible only when that helps the user decide where to intervene.

The status model should answer one question:

> Do I need to do anything with this agent session right now?

Subagent sessions follow the same rule. They should be discovered and preserved, but the panel should not become a flat list of every internal worker session. When JSONL `session_meta.payload.parent_thread_id` links a subagent to a parent thread, normal subagent rows are summarized on that parent row. If the parent id is missing or the parent row is not currently visible, the panel may fall back to the same-workspace parent heuristic. Subagent rows are promoted back into the top-level list only when they need direct intervention, currently `attention`, `stopped`, or `blocked`.

## State Layers

The implementation currently has three layers. Keeping them separate prevents most confusion.

| Layer | Examples | Purpose |
| --- | --- | --- |
| Source observation | `Running`, `Stopped`, `Idle`, `Completed`, `CompletedStale`, `WaitingForInput`, `Failed`, `InsufficientEvidence` | Raw or inferred evidence from SQLite, JSONL, and process checks. |
| Internal row state | `running`, `stopped`, `idle`, `needsAttention`, `dismissable`, `unknown` | Normalized state used by commands and storage. |
| Display status | `blocked`, `attention`, `inspect`, `running`, `follow-up`, `stopped`, `idle` | User-facing status used by the panel and documentation. |

## Event Sources

The status model should use multiple event sources with different responsibilities.

| Source | Role | Strength | Weakness |
| --- | --- | --- | --- |
| Codex hooks | Real-time lifecycle signal | Best source for "something is happening now." | Only works for sessions that have hooks installed and trusted. Does not replay old history. |
| JSONL | Persistent event evidence | Best source for durable task events such as `task_complete` and conversation messages. | Requires parsing and can lag behind runtime. |
| SQLite thread DB | Persistent session index | Best source for thread discovery, workspace, title, archive status, and updated time. | Thread metadata alone is not enough to prove semantic status. |
| Live process scan | Runtime fallback | Can prove a CLI session is still running. | Process matching is approximate and platform-specific. |

The intended model is:

- Hooks provide real-time status edges.
- JSONL provides durable status facts.
- SQLite provides discovery and metadata.
- Process checks fill gaps when hook data is missing.

## Current Display Statuses

| Display status | Marker | Meaning | Should user act? |
| --- | --- | --- | --- |
| `blocked` | `● blocked` | The agent cannot continue because of missing evidence, unavailable source, or an actionable failure signal. | Yes. |
| `attention` | `● attention` | The agent is waiting for user intervention, such as approval, confirmation, or additional information. | Yes. |
| `inspect` | `● inspect` | The agent just produced a result that should be checked while context is fresh. | Yes. |
| `running` | `○ running` | The agent is actively executing work now. | No. Keep visible as quiet context. |
| `follow-up` | `● follow-up` | The session was opened recently and may still need a short follow-up before it settles. | Yes. |
| `stopped` | `● stopped` | The run was manually stopped or aborted before a completion signal. | Yes. Decide whether to continue, inspect, or dismiss it. |
| `idle` | `○ idle` | No active work is happening and no user action is required. | No. Count it as quiet context, but do not spend a card on it by default. |

### Display Name Rationale

`inspect` replaces `review` because the expected action is "check what happened", not necessarily approve or code-review the result.
`review` carried an acceptance/assessment implication that was broader than this product needs.

`follow-up` is the display status for the internal `needsAttention` row state.
It means "keep this session in short-term attention after it was opened" without implying the agent has a response to read, that the only possible action is text input, or that the user must personally complete the underlying task.

`running` is the display status for active execution.

Chinese labels, if the UI becomes localized:

| English | Recommended Chinese | Rationale |
| --- | --- | --- |
| `blocked` | `受阻` | Short and clearly means the agent cannot continue. |
| `attention` | `待介入` | Broader than "typing input"; covers approval, confirmation, permission, or additional information. |
| `inspect` | `待检查` | Matches the action: open and inspect the result. |
| `follow-up` | `待跟进` | Matches the post-read window: the user may need to continue, confirm, or take over soon without implying an urgent blocker. |
| `running` | `进行中` | Clear active-work state. |
| `stopped` | `已停止` | Clear stopped-before-completion state. |
| `idle` | `空闲` | Quiet no-action state. |

The UI language is a display configuration, not a state-model change.
Internal states and persisted records should keep stable English identifiers; only user-facing labels and counters switch between English and Chinese.

## Current Source Rules

These are the rules implemented today.

### JSONL Event Rules

| JSONL evidence | Source observation |
| --- | --- |
| Last relevant event is `task_complete`, the signal is unread, and completion is at most 12 hours old | `CompletedImmediate` |
| Last relevant event is `turn_aborted` | `Stopped` |
| Last relevant event after `task_complete` is `user_message` or `agent_message`, and it is recent | `Running` |
| Recent activity but no terminal event | `Running` |
| Old activity with no terminal event | `InsufficientEvidence` |

Completion attention is time-bounded and read-driven:

- `inspect`: completed result is at most 12 hours old and has not been opened/read yet.
- `follow-up`: completed result was opened/read within the last 30 minutes.
- `idle`: completed result is older than 12 hours, or was opened/read more than 30 minutes ago.

Unread-completion retention is 12 hours. After this window, a terminal unread completion becomes `CompletedStale` and stays quiet unless newer source evidence appears.

Generic non-terminal activity is still considered recent for 2 hours.

### SQLite Thread Rules

| SQLite/thread evidence | Source observation |
| --- | --- |
| JSONL says `CompletedImmediate`, `Completed`, `Failed`, or `WaitingForInput` | Use JSONL terminal/input state. |
| JSONL says unread `task_complete` within 12 hours | Keep as `CompletedImmediate` until read or the 12-hour retention window expires. |
| SQLite `updated_at_ms` is strictly later than JSONL `task_complete` | Treat the completed result as read/opened and apply the 30-minute `follow-up` window from `updated_at_ms`. |
| Thread is archived without explicit unread completion evidence | Apply completion-age fallback, usually `CompletedStale` for old archived threads. |
| Desktop thread has recent activity | `Running` |
| Desktop thread is old and unarchived | `Idle` |
| CLI thread has no recent JSONL signal | `InsufficientEvidence`, unless a live CLI process is found. |

### Live CLI Process Rule

If a CLI row is `unknown` or `idle` and a live Codex process is found for the same session, the row can be promoted to `running`.
Terminal and intervention states such as `inspect`, `stopped`, `waitingForInput`, and `needsAttention` are stronger than process presence and must not be overwritten by a live process scan.

## Codex Hook Rules

Codex supports lifecycle hooks such as `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, and `Stop`.
These hooks are the preferred source for live status transitions when the app-owned hook writer is installed.

### Hook Event Semantics

| Hook event | Proposed source observation | Notes |
| --- | --- | --- |
| `SessionStart` with `startup` or `resume` | `Running` | A session has become active. |
| `UserPromptSubmit` | `Running` | A new user request starts active work. |
| `PreToolUse` | `Running` | The agent is about to execute a tool. |
| `PostToolUse` | `Running` | The agent just executed a tool; update last activity. |
| `Stop` | pending terminal check | A turn ended. Do not classify as `Completed` by itself. |

`Stop` is intentionally not a final state. It can mean success, waiting for input, interruption, tool failure, or a normal turn boundary.
After `Stop`, the app should consult JSONL and any hook payload to decide whether the row becomes `inspect`, `stopped`, `follow-up`, `blocked`, or `idle`.

### Hook Storage

The hook writer appends compact events to an app-owned local store.
It does not require the UI process to be running.

Current storage:

- JSONL file at `~/.codex/agent-session-inbox/hook-events.jsonl`.

Minimum event fields:

| Field | Purpose |
| --- | --- |
| `sessionId` | Join hook events to Codex sessions. |
| `workspacePath` | Fallback join key and display metadata. |
| `eventType` | Hook event such as `UserPromptSubmit` or `Stop`. |
| `timestamp` | Ordering and freshness. |
| `source` | `codex-hook`. |
| `schemaVersion` | Future migration safety. |

### Hook Trust and Scope

Codex hooks must be installed in a trusted hook source and reviewed/trusted by Codex before running.
Project-local hooks only load for trusted project `.codex/` layers.
User-level hooks under `~/.codex/hooks.json` can cover all sessions on this machine.

For this app, user-level hooks are likely the right default because the status panel watches sessions across many repos.

## Current Classification Rules

| Source observation | Internal row state | Confidence | Status reason |
| --- | --- | --- | --- |
| `Running` | `running` | `exact` | `running signal observed` |
| `Stopped` | `stopped` | `exact` | `stopped before completion; decide whether to continue, inspect, or dismiss` |
| `Idle` | `idle` | `inferred` | `no recent activity observed; idle until the next source signal` |
| `WaitingForInput` | `needsAttention` | `exact` | `waiting for user input` |
| `CompletedImmediate` | `inspect` | `exact` | `completed task ready to inspect; open it to mark read` |
| `Completed` | `needsAttention` | `exact` | `completed task still needs your attention` |
| `CompletedStale` | `idle` | `inferred` | `completed task is no longer recent; idle until the next source signal` |
| `Failed` | `inspect` | `exact` | `failed task can be manually reviewed and cleared` |
| `InsufficientEvidence` | `unknown` | `unknown` | `missing source evidence for status classification` |

## Current UI Mapping

| Internal row state | Display status |
| --- | --- |
| `running` | `running` |
| `stopped` | `stopped` |
| `idle` | `idle` |
| `waitingForInput` | `attention` |
| `needsAttention` | `follow-up` |
| `inspect` | `inspect` |
| legacy `dismissable` | `inspect` |
| `unknown` with actionable reason | `blocked` |
| `unknown` without actionable reason | hidden from watchlist |

Actionable unknown reasons currently match words such as `failed`, `unavailable`, `blocked`, `needs attention`, or `approval`.

## Current User Actions

| User action | Current transition |
| --- | --- |
| Click Jump back on an `inspect` row | Mark the current signal as read, then show it as `follow-up` for 30 minutes. |
| Open the same Codex Desktop thread outside this app | Only transitions if Codex advances SQLite `updated_at_ms` after `task_complete`; otherwise Attn has no reliable read evidence. |
| Unread completion exceeds 12 hours | Show the row as `idle` until newer source evidence arrives. |
| Read window exceeds 30 minutes | Show the row as `idle` until newer source evidence arrives. |
| Click Jump back on `running` or `idle` | No state transition. |
| Dismiss an `inspect`, `stopped`, or `unknown` row | Hide it until the display status becomes `running` or `follow-up`. |
| Dismiss a `running` or `follow-up` row | It is restored immediately on next list because active/intervention rows should not stay hidden. |

Read acknowledgement is keyed by `sessionId + lastActivityAt` and stores `acknowledgedAt`.
If the same session gets newer activity, the read acknowledgement no longer applies.

## Known Problems

These are the areas that currently feel wrong or need product decisions.

1. Completion attention is bounded by freshness and read state.
   A completed result stays `inspect` for at most 12 hours unless opened/read earlier; reading shows `follow-up` for 30 minutes, then `idle`.

2. `inspect` still combines successful completion and failure/manual-clear cases.
   These may need separate reasons later, but the shared user action is still "open and inspect."

3. `idle` has two meanings.
   It can mean "old inactive session" or "user confirmed this session." These are both quiet, but they may need different reasons or sorting.

4. Time windows are hard-coded.
   `recent = 2 hours` is a technical default, not yet a product decision.

5. The panel still behaves partly like a list of sessions.
   The product goal is an intervention watchlist. Old quiet rows should probably be hidden or collapsed more aggressively.

6. Hook reading is integrated, and hook installation is explicit from the management page.
   Without installed hooks, `running` still falls back to SQLite/JSONL/process inference.

7. TODO: Find a reliable read/open evidence source for Codex Desktop history navigation.
   Current local evidence is insufficient to prove an `inspect` row was read when the user opens that thread directly inside Codex Desktop. `threads.updated_at_ms` does not always advance, `threads` has no `read_at`/`seen_at` field, `logs_2.sqlite` has execution logs but no reliable post-completion read event, and generic UI click/Sentry data is not safely attributable to a specific session. Hooks are useful for execution lifecycle state, but they do not currently prove UI-level read/open actions.

8. TODO: Evaluate natural-language confirmation requests as weak `input` evidence.
   Assistant text such as "if you agree, I will..." or "please confirm before I continue" may indicate the session is waiting for user intervention. This should be treated as inferred evidence only, not as strong as tool approval or structured Codex events. Any implementation needs conservative wording rules to avoid confusing optional offers such as "if you want, I can also..." with true blockers.

## Open Product Decisions

We should decide these before more code changes.

1. When should `task_complete` become visible?
   Current decision: unread completed results stay `inspect`; reading them starts a 30-minute `follow-up` window, then they become `idle`.

2. What does `inspect` mean?
   It means a result was produced and should be checked while context is fresh.

3. What should be visible by default?
   Current decision:
   - `blocked`
   - `inspect`
   - current `running`
   - `follow-up`
   - `idle` only contributes to the quiet count and does not occupy a card

4. Should quiet states be visible at all?
   Current behavior keeps `running` visible because live work is important context, but moves `idle` into the quiet count because it does not require action.

5. What is the retention rule for completed sessions?
   Current decision: unread completions older than 12 hours become `idle`; acknowledged completions become `idle` after their 30-minute follow-up window.

6. How should the hook writer be installed?
   Current implementation provides `scripts/attn-codex-hook.cjs`, reads its output, and can merge user-level `~/.codex/hooks.json` after the user confirms from the management page.
   Open decision: whether a future plugin-bundled hook should replace the user-level install path.

## Proposed Direction

This is not final. It is a candidate rule set for the next implementation pass.

```mermaid
stateDiagram-v2
    [*] --> Working: recent live activity
    [*] --> Working: hook UserPromptSubmit/PreToolUse
    Working --> Inspect: unread task_complete
    Inspect --> Needed: user opens/reads result
    Inspect --> Needed: SQLite updated_at_ms advances after task_complete
    Inspect --> Idle: unread window exceeds 12 hours
    Needed --> Idle: read window exceeds 30 minutes
    Working --> Idle: task_complete older than 12 hours
    Working --> Idle: old activity without intervention signal
    Working --> Input: waiting for user intervention
    Working --> Blocked: actionable failure/source issue
    Blocked --> Idle: user confirms or issue clears
    Idle --> Working: new user_message or agent_message
```

Candidate principles:

- `running` means active execution, not merely "thread exists."
- Hook events should be the strongest proof of `running`.
- `idle` means no action required.
- `inspect` should be scarce. It should represent something the user is likely to care about now.
- Old completions should automatically become `idle`.
- `follow-up` and `blocked` are strong intervention states.
- Old historical sessions should not crowd the panel.

## Code Touchpoints

| Concern | File |
| --- | --- |
| Source and row type definitions | `src-tauri/src/domain/session.rs` |
| Observation-to-row classification | `src-tauri/src/domain/classification.rs` |
| SQLite/JSONL source extraction | `src-tauri/src/codex_source.rs` |
| Jump acknowledgement and dismiss behavior | `src-tauri/src/inbox_store.rs` |
| Browser/dev source mirror | `scripts/codexSessionsDevSource.mjs` |
| UI status model and sorting | `src/features/statusPanel/statusPanel.ts` |
| UI rendering and actions | `src/features/statusPanel/StatusPanelView.tsx` |
