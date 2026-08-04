# Inspect Retention Design

## Goal

Prevent old, unread `task_complete` events from resurfacing as actionable `inspect` rows while retaining a useful review window for newly completed work.

## Decision

An unread completion remains `inspect` for at most 12 hours, measured from its `task_complete` timestamp. At exactly 12 hours it remains `inspect`; after 12 hours it becomes `CompletedStale` and is shown as quiet `idle` state.

The existing completion acknowledgement flow remains unchanged:

- A successful `Jump back` records an acknowledgement.
- Acknowledged completion is shown as `follow-up` for 30 minutes.
- It then becomes quiet `idle`.

Pin and dismiss behavior is unchanged.

## Implementation

Replace the fixed migration-date check in `src-tauri/src/codex_source.rs` with a named 12-hour duration. The JSONL parser will classify a terminal, unread `task_complete` as `CompletedImmediate` only inside that duration. Older terminal completions and external imported completions remain `CompletedStale`.

## Verification

Add tests for a completion at 11 hours 59 minutes 59 seconds and one at 12 hours 0 minutes 1 second. Keep the acknowledgement-window test as the regression proof that read handling remains independent of the retention window.
