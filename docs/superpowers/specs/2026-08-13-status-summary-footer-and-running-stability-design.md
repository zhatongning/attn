# Status Summary Footer and Running Stability Design

Date: 2026-08-13

## Goal

Improve the expanded Attn panel's use of vertical space and prevent an active Codex Desktop session from briefly disappearing when one status refresh produces an unreliable snapshot.

## Confirmed UI Behavior

- In the expanded panel, keep only the `Attn` title and collapse control in the header.
- Move the intervention and working counters into the existing footer and align them to the right.
- Keep footer feedback and the hidden-row toggle on the left. The counters remain the rightmost footer content and must not overlap either control.
- In the collapsed 50 px strip, keep the counters in the header so the compact view still communicates the current totals.
- Do not change counter definitions, status colors, row ordering, or the configured number of visible rows.
- Preserve the existing panel height calculation. The footer already participates in the base-height contract, so moving existing content into it must not add another row of window height.

## Running Flicker Root Cause

The affected Desktop thread remains present in Codex `state_5.sqlite`. The visible disappearance is caused by status classification, not deletion or a React-only rendering effect:

1. The panel replaces its row set from `list_sessions` every five seconds.
2. One unreliable source snapshot can classify a previously running Desktop session as idle or omit it while SQLite falls back to incomplete JSONL evidence.
3. Idle rows are not selected for the expanded panel's primary visible set.
4. A later healthy snapshot classifies the same session as running again, so the row reappears.

Late completion of an older frontend refresh is a separate known risk, but the current `latestRefreshIdRef` guard already rejects stale refresh results. The observed state transition therefore belongs to source snapshot stability.

## Stability Rule

- Track the latest known running row only for Codex Desktop sessions.
- If SQLite is degraded and the fallback snapshot reports idle, insufficient evidence, or omits that session, retain the latest running row for the first degraded snapshot.
- If degradation continues, expose the row as source unavailable rather than claiming that it is still actively running indefinitely.
- For healthy SQLite snapshots, require two consecutive non-running observations before changing a previously running Desktop row to idle or removing it. A reported idle and an omitted row both count as non-running observations.
- If a degraded snapshot occurs between those observations, discard the pending confirmation and wait for healthy evidence again.
- Do not delay explicit terminal states such as completed, waiting for input, blocked, or stopped.
- Do not apply the Desktop confirmation rule to CLI sessions, where process exit is a direct signal.
- Apply the same rule to the native Tauri store and the development preview source so both environments behave consistently.

## Error and Evidence Handling

- A failed frontend refresh keeps the last rendered rows and shows the existing source error message.
- A degraded retained row includes the SQLite fallback reason in its status reason and evidence details.
- Source health reports degraded status when JSONL fallback is active.
- No new user-facing status category or counter is introduced.

## Verification

- Component test: expanded mode renders counters in the footer and not in the header.
- Component test: collapsed mode retains counters in the header and does not render the footer.
- Component test: footer counters coexist with jump feedback and the hidden-row toggle.
- Component test: a failed refresh preserves the rendered row.
- Component test: an older overlapping refresh cannot overwrite a newer running snapshot.
- Native and preview tests: degraded missing snapshots retain a recent Desktop running row.
- Native and preview tests: healthy idle requires a confirming snapshot before the row becomes idle.
- Native and preview tests: CLI and explicit terminal states are not delayed.
- Run the focused component, preview-source, and Rust tests, then the full frontend suite, Rust suite, production build, and `git diff --check`.

## Scope Boundary

This change does not redesign row cards, alter subagent visibility, change follow-up semantics, migrate persisted settings, rebuild/install Attn.app, or create a Git branch. Runtime rebuild or restart is a separate delivery action after code verification.
