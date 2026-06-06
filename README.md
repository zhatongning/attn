# Attn

Mac local attention panel for agent sessions that need intervention.

## Current MVP

- Lists observed Codex sessions in a compact floating status panel.
- Supports manual dismiss and restore.
- Preserves low-confidence and unknown rows instead of auto-clearing them.
- Exposes Tauri commands for list, dismiss, restore, source health, and jump-back result reporting.
- Routes jump-back to Codex Desktop, a live iTerm Codex session, or a previous iTerm tab for the same workspace.
- Reads local Codex threads from `~/.codex/state_5.sqlite`, uses JSONL files under `~/.codex/sessions` as durable event evidence, can consume compact Codex hook events from `~/.codex/agent-session-inbox/hook-events.jsonl`, and refreshes the inbox every 5 seconds.
- Shows settings from the macOS app menu. The panel itself does not render a settings button.
- Floats above other windows and is configured to appear on all macOS Spaces.

## Status Tokens

The compact panel maps internal session evidence to intervention statuses:

| Token | Display status | Meaning |
| --- | --- | --- |
| `● blocked` | `blocked` | The agent appears stuck, hit a repeated failure, or needs a decision before it can continue. |
| `● inspect` | `inspect` | The agent produced a result that should be checked while context is fresh. |
| `● follow-up` | `follow-up` | The session was opened recently and may still need a short follow-up before it settles. |
| `○ working` | `working` | The agent is actively executing work right now and does not need intervention. It stays visible with quiet styling. |
| `○ idle` | `idle` | The previous intervention or inspection was confirmed, or an old Desktop thread has no recent activity. It is quiet baseline state and contributes to the quiet count instead of occupying a card by default. |

Each row also carries a confidence value:

- `exact`: direct source evidence was found.
- `inferred`: the app inferred the state from local metadata or process evidence.
- `unknown` / `unavailable`: source evidence is missing or unavailable.

Dismissed rows stay hidden while they remain quiet. If the same session becomes `inspect`, `follow-up`, `blocked`, or actively `working` again, it returns to the panel. Clicking Jump back confirms the current inspect signal and starts the short follow-up window before the row settles back to `idle`.

## Codex Hook Events

Attn includes a lightweight Codex hook writer at `scripts/attn-codex-hook.cjs`.
When installed into Codex hooks, it appends compact lifecycle events to:

```text
~/.codex/agent-session-inbox/hook-events.jsonl
```

The writer stores only metadata needed for status transitions: hook event type, timestamp, session id when Codex provides it, workspace path, and tool name. It does not store raw prompt or model output.

Hook activity is used as strong live evidence for `working`:

- `SessionStart`
- `UserPromptSubmit`
- `PreToolUse`
- `PostToolUse`

`Stop` is recorded but does not by itself mean the session completed. After `Stop`, Attn falls back to JSONL and SQLite evidence to decide whether the row should become `inspect`, `follow-up`, `blocked`, or `idle`.

The app does not edit `~/.codex/hooks.json` automatically yet. To enable this globally, merge calls to this script into your existing user-level Codex hooks, passing the hook name as the first argument, for example:

```bash
node /Users/edy/sofdev/agent-session-inbox/scripts/attn-codex-hook.cjs PreToolUse
```

## Run

```bash
npm install
npm run dev
```

Open `http://127.0.0.1:1420/` for browser preview.

For desktop:

```bash
npm run tauri dev
```

## Verify

```bash
npm test
npm run build
npm run test:rust
```

`npm run tauri build -- --debug` builds the debug binary and `.app`. On this machine the `.app` is produced at:

```text
src-tauri/target/debug/bundle/macos/Attn.app
```

The final `.dmg` packaging step may wait on macOS AppleScript window decoration; the `.app` build is sufficient for MVP validation.

## Scope Notes

- Codex desktop only for v1.
- Claude, phone workflows, scheduled cleanup, and real activity summarization are post-MVP.
- No raw prompt/output content is stored in this MVP; rows carry metadata and confidence only.
- Activity state prefers recent Codex hook events when installed, then falls back to SQLite thread metadata and JSONL task events. Unread `task_complete` becomes `inspect`; opening it starts the short `follow-up` window before it moves to `idle`. Live Desktop or CLI activity becomes `working`.
- CLI jump-back targets iTerm first by matching live Codex process cwd to tty. If no live Codex process is found, it tries an iTerm tab whose shell cwd is the same workspace before falling back to the exact Codex Desktop thread deeplink.
- TODO: Add Warp live terminal targeting once its scriptability/API is defined.
