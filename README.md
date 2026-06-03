# Agent Session Inbox

Mac local MVP for keeping active Codex desktop work visible until it is handled.

## Current MVP

- Lists observed Codex sessions in durable inbox groups: needs attention, running, unknown, dismissable.
- Supports manual dismiss and restore.
- Preserves low-confidence and unknown rows instead of auto-clearing them.
- Exposes Tauri commands for list, dismiss, restore, source health, and jump-back result reporting.
- Routes jump-back to Codex Desktop, a live iTerm Codex session when a matching process is found, or a Terminal resume fallback.
- Reads local Codex threads from `~/.codex/state_5.sqlite`, uses JSONL files under `~/.codex/sessions` as event evidence, and refreshes the inbox every 5 seconds.

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
- Activity state is inferred from SQLite thread metadata first. JSONL task events are supporting evidence, not the primary Desktop running state.
- CLI jump-back currently targets iTerm first by matching live Codex process cwd to tty.
- TODO: Add Warp live terminal targeting once its scriptability/API is defined.
