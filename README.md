# Agent Session Inbox

Mac local MVP for keeping active Codex desktop work visible until it is handled.

## Current MVP

- Lists observed Codex sessions in a compact floating status panel.
- Supports manual dismiss and restore.
- Preserves low-confidence and unknown rows instead of auto-clearing them.
- Exposes Tauri commands for list, dismiss, restore, source health, and jump-back result reporting.
- Routes jump-back to Codex Desktop, a live iTerm Codex session, or a previous iTerm tab for the same workspace.
- Reads local Codex threads from `~/.codex/state_5.sqlite`, uses JSONL files under `~/.codex/sessions` as event evidence, and refreshes the inbox every 5 seconds.
- Shows settings from the macOS app menu. The panel itself does not render a settings button.
- Floats above other windows and is configured to appear on all macOS Spaces.

## Status Tokens

The compact panel maps internal session evidence to intervention statuses:

| Token | Display status | Meaning |
| --- | --- | --- |
| `● blocked` | `blocked` | The agent appears stuck, hit a repeated failure, or needs a decision before it can continue. |
| `● input` | `input` | The agent is waiting for user input, confirmation, approval, or a choice. |
| `● review` | `review` | The agent produced a result that should be inspected or accepted. A completed task stays here until you confirm it. |
| `○ working` | `working` | The agent is actively executing work right now and does not need intervention. It stays visible with quiet styling. |
| `○ idle` | `idle` | The previous intervention or review was confirmed, or an old Desktop thread has no recent activity. It is quiet baseline state. |

Each row also carries a confidence value:

- `exact`: direct source evidence was found.
- `inferred`: the app inferred the state from local metadata or process evidence.
- `unknown` / `unavailable`: source evidence is missing or unavailable.

Dismissed rows stay hidden while they remain reviewed. If the same session becomes `input`, `blocked`, `review`, or actively `working` again, it returns to the panel. Clicking Jump back confirms the current intervention/review signal and moves that row to `idle` until newer source evidence arrives.

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
src-tauri/target/debug/bundle/macos/agent-session-inbox.app
```

The final `.dmg` packaging step may wait on macOS AppleScript window decoration; the `.app` build is sufficient for MVP validation.

## Scope Notes

- Codex desktop only for v1.
- Claude, phone workflows, scheduled cleanup, and real activity summarization are post-MVP.
- No raw prompt/output content is stored in this MVP; rows carry metadata and confidence only.
- Activity state is inferred from SQLite thread metadata first. JSONL task events are supporting evidence: `task_complete` becomes `review`; only user confirmation moves it to `idle`. Live Desktop or CLI activity becomes `working`.
- CLI jump-back targets iTerm first by matching live Codex process cwd to tty. If no live Codex process is found, it tries an iTerm tab whose shell cwd is the same workspace before falling back to the exact Codex Desktop thread deeplink.
- TODO: Add Warp live terminal targeting once its scriptability/API is defined.
