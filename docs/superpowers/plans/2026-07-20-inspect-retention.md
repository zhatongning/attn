# Inspect Retention Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Limit unacknowledged completed-session `inspect` reminders to 12 hours.

**Architecture:** `codex_source.rs` owns raw completion classification. It will use a 12-hour duration instead of a fixed migration timestamp; `inbox_store.rs` continues to own the existing acknowledgement and 30-minute follow-up window.

**Tech Stack:** Rust, Tauri, Cargo tests, Markdown.

## Global Constraints

- Keep the existing `Jump back`, Pin, and dismiss behaviors unchanged.
- Treat exactly 12 hours as still eligible for `inspect`.
- Update the product status-flow contract with the same 12-hour rule.

---

### Task 1: Bound Unread Completion Classification

**Files:**
- Modify: `src-tauri/src/codex_source.rs`
- Modify: `docs/status-flow.md`
- Test: `src-tauri/src/codex_source.rs`

**Interfaces:**
- Consumes: JSONL terminal event timestamp and `SystemTime` supplied to `parse_session_file`.
- Produces: `ObservationKind::CompletedImmediate` within 12 hours, otherwise `ObservationKind::CompletedStale`.

- [x] **Step 1: Write failing boundary tests**

Add tests with a `task_complete` timestamp of `2026-06-05T08:20:00.000Z`. Classify at `2026-06-05T20:19:59.000Z` as `CompletedImmediate` and at `2026-06-05T20:20:01.000Z` as `CompletedStale`.

- [x] **Step 2: Run the new tests to verify the stale-boundary expectation fails**

Run: `cargo test unread_task_complete_`

Expected: the over-12-hour case fails because the current fixed migration baseline still returns `CompletedImmediate`.

- [x] **Step 3: Implement the duration-based classification**

Replace `UNREAD_COMPLETION_TRACKING_START` with `UNREAD_COMPLETION_RETENTION: Duration = Duration::from_secs(12 * 60 * 60)`. Require the terminal completion age to be at most that duration before returning `CompletedImmediate`.

- [x] **Step 4: Synchronize the status-flow contract**

Replace the migration-baseline wording in `docs/status-flow.md` with the 12-hour unread-completion retention rule. State that the acknowledgement-driven 30-minute `follow-up` window remains separate.

- [x] **Step 5: Run verification**

Run: `cargo test`, `npm test`, `npm run build`, and `git diff --check`.

Expected: all commands exit successfully and no unrelated files change.
