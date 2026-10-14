# Attn

[English](README.md) | [简体中文](README.zh-CN.md)

[Download latest build](https://github.com/zhatongning/attn/releases/latest) | [All builds](https://github.com/zhatongning/attn/releases)

> A local macOS attention panel for Codex sessions that need a human decision, review, or recovery.

Attn is a small, always-available status panel for people who work across several Codex sessions. It turns local session evidence into a short answer to one question: **do I need to do anything with this session now?**

It is an MVP for local use. Its primary focus is Codex Desktop, with limited Codex CLI jump-back support through iTerm.

## The Problem

When several agent sessions run in parallel, important moments are easy to miss:

- An agent needs structured input, confirmation, or another intervention.
- A task completed and its result should be checked while the context is still fresh.
- A run stopped before completing.
- A session looks active, but the available evidence is incomplete or degraded.

Codex has useful session history, but it does not provide a single local, actionable watchlist for these situations. Attn brings the relevant local signals into one compact panel without becoming a full session dashboard.

## What Attn Does

- Observes local Codex sessions and presents only parent sessions in a compact floating panel.
- Classifies sessions as `blocked`, `attention`, `inspect`, `running`, `follow-up`, `stopped`, or `idle`.
- Keeps actionable rows ahead of quiet context and lets users expand the panel when they need more detail.
- Supports Jump back, pin, dismiss, and restore actions.
- Routes Desktop-sourced sessions to their exact thread. For CLI-sourced sessions, it follows Codex Desktop when that app owns the thread; otherwise it focuses a matching live iTerm session or resumes the CLI session there.
- Refreshes the panel every five seconds and keeps the panel visible across macOS Spaces.
- Lets the user position the single panel by dragging it or through the macOS app menu.

## Keyboard Shortcuts

| Action | Default macOS shortcut |
| --- | --- |
| Expand or collapse the panel | **Control-Command-9** (`⌃⌘9`) |
| Cycle the panel clockwise through its four corner positions | **Control-Command-P** (`⌃⌘P`) |

Both shortcuts work while another app has focus and can be customized or disabled in **Attn -> Settings**. Saved shortcuts are preserved on upgrade. To adopt the new defaults, use **Restore default** for the panel shortcut and **Restore position default** for the position shortcut, then **Apply settings**.

## How It Works

Attn combines several local evidence sources instead of treating one timestamp as definitive:

| Source | What Attn uses it for |
| --- | --- |
| Codex hooks | Strong live evidence that a session is active when the optional hooks are installed. |
| Codex session JSONL | Durable task events, including completion, stop, and structured input evidence. |
| Codex SQLite thread database | Session discovery, titles, workspaces, archival state, and metadata. |
| Live CLI process scan | A fallback signal that a matching Codex CLI session is still running. |

The Rust source layer collects observations, normalizes them into session rows, and passes them to the React status-panel model. The panel ranks rows, renders actions, and persists only its local configuration and user choices.

For the detailed state machine, evidence rules, and transition rationale, see [Status Flow](docs/status-flow.md). For macOS display behavior, see [Window Placement](docs/window-placement.md).

## Statuses

| Status | Meaning | Expected action |
| --- | --- | --- |
| `blocked` | The evidence indicates an actionable source problem or unresolved failure. | Investigate the source or decide how to continue. |
| `attention` | The agent is waiting for structured user input. | Provide the required input or resolve the request. |
| `inspect` | A recent, unread task completion or reviewable failure needs checking. | Open the session and inspect the result. |
| `running` | The session has current activity evidence. | No action required; it remains visible as context. |
| `follow-up` | Attn recorded a successful acknowledgement of a completed result. | No immediate action required. |
| `stopped` | The run ended before a completion signal. | Continue, inspect, or dismiss it. |
| `idle` | The session is old or no action is currently required. | No action required. |

Selecting **Jump back** from an `inspect` row is Attn's reliable acknowledgement action. It changes that exact completion signal to the quiet `follow-up` state for the configured window, then to `idle`. Opening the same Codex Desktop thread outside Attn does not currently acknowledge it because Codex does not expose a reliable per-thread read/open signal to this app.

## Data And Privacy

Attn operates on local Codex data. It reads:

- Codex thread metadata from the local SQLite state database.
- Session JSONL files under `~/.codex/sessions` for status evidence.
- Optional hook events from `~/.codex/agent-session-inbox/hook-events.jsonl`, including a `PermissionRequest` signal before a shell approval prompt.

The hook writer records only the metadata needed for state transitions: event type, timestamp, session ID when supplied, workspace path, and tool name. It does not write raw prompts or model output. The panel displays status metadata and evidence confidence rather than conversation content.
The desktop panel refreshes when Codex session, state database, or hook files change, with a 30-second calibration refresh if an event is missed. An approval event is scoped to its session and never automatically approves or denies the request.

Hook installation is explicit. From **Attn -> Settings**, choose **Install Codex hooks** to merge Attn commands into the existing user-level Codex hook configuration. Existing hook commands are preserved and duplicate Attn commands are avoided.

## Requirements

- macOS. The native app uses macOS-specific Tauri APIs and exposes a macOS app-menu workflow.
- Node.js and npm.
- A Rust toolchain and the platform dependencies required by Tauri.
- Local Codex Desktop or Codex CLI session data.

Automated builds use Node.js 24.20.0 and Rust 1.96.0 on macOS 15 runners for Apple Silicon and Intel. See [GitHub Builds](#github-builds) for downloadable builds; source builds remain available for development.

## Run Locally

```bash
git clone <repository-url> attn
cd attn
npm ci
npm run tauri dev
```

Use the browser preview for UI work only:

```bash
npm run dev
```

It is served at `http://127.0.0.1:1420/`. Native window management, hook installation, and Jump back need the Tauri desktop runtime.

## Verify And Build

```bash
npm test
npm run test:rust
npm run build
```

To build a debug macOS app bundle:

```bash
npm run tauri build -- --debug
```

## GitHub Builds

Every push to `master` automatically runs the **Build Attn** GitHub Actions workflow. Each architecture installs dependencies with `npm ci`, runs the frontend and Rust tests, and builds a release `.app` and `.dmg` using the committed lockfiles. After both architectures succeed, the workflow publishes a GitHub Release. Manual runs are optional; choose `master` to publish a release, or another branch for build artifacts only.

| Version | Runner | Rust target |
| --- | --- | --- |
| Apple Silicon | `macos-15` | `aarch64-apple-darwin` |
| Intel | `macos-15-intel` | `x86_64-apple-darwin` |

Use the fixed [latest download page](https://github.com/zhatongning/attn/releases/latest) or the direct package links below. Public Release downloads do not require visiting Actions or signing into GitHub.

| Mac | Installer | App archive | Checksums |
| --- | --- | --- | --- |
| Apple Silicon | [DMG](https://github.com/zhatongning/attn/releases/latest/download/Attn-macOS-arm64.dmg) | [ZIP](https://github.com/zhatongning/attn/releases/latest/download/Attn-macOS-arm64.app.zip) | [SHA-256](https://github.com/zhatongning/attn/releases/latest/download/Attn-macOS-arm64.SHA256SUMS.txt) |
| Intel | [DMG](https://github.com/zhatongning/attn/releases/latest/download/Attn-macOS-x64.dmg) | [ZIP](https://github.com/zhatongning/attn/releases/latest/download/Attn-macOS-x64.app.zip) | [SHA-256](https://github.com/zhatongning/attn/releases/latest/download/Attn-macOS-x64.SHA256SUMS.txt) |

Each published build has an independent `build-<commit-sha>` tag. Release assets are kept beyond the 30-day Actions artifact retention window, and older builds remain available on the Releases page. The publisher uploads and verifies both architectures before making a draft public. Late older builds do not replace a newer latest download, and reruns preserve already published packages.

Actions also retains packages for 30 days under **Actions -> Build Attn -> run -> Artifacts**. Each architecture's artifact includes its `.dmg`, permission-preserving `.app.zip`, and checksum file. Reruns replace that architecture's artifact for the same run so failed-job retries can reuse the other successful architecture.

These builds use ad-hoc signing and do not require Apple developer credentials. They are not notarized; macOS may require approval in **System Settings -> Privacy & Security** when opening a downloaded build. Developer ID signing and Apple notarization are needed for trusted public distribution.

## Project Map

| Area | Main location |
| --- | --- |
| Codex data discovery and JSONL parsing | `src-tauri/src/codex_source.rs` |
| Observation-to-session classification | `src-tauri/src/domain/classification.rs` |
| Acknowledgement, pin, dismiss, and Jump back behavior | `src-tauri/src/inbox_store.rs` |
| Tauri commands and macOS window setup | `src-tauri/src/lib.rs` |
| Status ranking and display model | `src/features/statusPanel/statusPanel.ts` |
| Panel UI and local settings | `src/features/statusPanel/StatusPanelView.tsx` |

## Known Limitations

These are current product and technical boundaries, not guarantees that the panel can infer every session state correctly.

1. **No reliable external read signal for Codex Desktop.** Attn can acknowledge an `inspect` row after its own successful Jump back action, but it cannot prove that a user opened or read the same historical thread directly in Codex Desktop.
2. **Live status is stronger with hooks installed.** Without optional Codex hooks, Attn falls back to JSONL, SQLite, and process evidence; some `running` states are therefore inferred rather than directly observed.
3. **Some lifecycle windows are technical defaults.** Recent activity is currently two hours, unread completed work remains `inspect` for up to 12 hours, and the post-acknowledgement `follow-up` window defaults to 30 minutes with a 20-minute minimum. These values need continued product validation.
4. **Some quiet and review states are intentionally broad.** `inspect` can represent either a successful completion or a reviewable failure, while `idle` can mean either old inactivity or a result that has already been acknowledged.
5. **The product scope is narrow.** v1 does not support other agent providers, mobile workflows, scheduled cleanup, real activity summaries, or Warp terminal targeting.
6. **Public contribution and compatibility coverage are still incomplete.** A dedicated contribution policy and broader compatibility matrix are still needed.

## Contributing

Contributions should preserve the distinction between evidence and inference. When changing session behavior:

1. Describe the source event or metadata that supports the new state.
2. Add or update the focused JavaScript and Rust tests.
3. Update [Status Flow](docs/status-flow.md) when transition or acknowledgement semantics change.
4. Do not add raw prompts, model output, or private session data to tests, issues, or examples.

Before accepting external contributions, maintainers should add a dedicated contribution policy.

## License

Attn is licensed under the [MIT License](LICENSE).
