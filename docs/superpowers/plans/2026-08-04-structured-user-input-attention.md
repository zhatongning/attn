# Structured User Input Attention Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Classify an unresolved structured `request_user_input` tool call as exact `WaitingForInput` while clearing it after any matching tool output or aborted turn.

**Architecture:** Extend the JSONL parser's existing pending-call tracking in `codex_source.rs` with a separate pending structured-input record. Keep it independent from elevated tool approval tracking so either pending source can yield `WaitingForInput`, and use matching `call_id` outputs to clear only the matching record. The status-flow documentation will describe this as exact evidence and retain natural-language confirmation as unimplemented.

**Tech Stack:** Rust, serde_json JSONL parsing, Rust unit tests, Markdown.

---

## File Structure

- Modify: `src-tauri/src/codex_source.rs` - parse and classify structured input requests, with parser-level regression tests in the existing test module.
- Modify: `docs/status-flow.md` - record structured input requests as exact `attention` evidence and narrow the remaining natural-language TODO.

### Task 1: Lock the parser behavior with failing tests

**Files:**
- Modify: `src-tauri/src/codex_source.rs` near `command_approval_prompt_marks_desktop_and_cli_sessions_waiting_for_input`

- [ ] **Step 1: Add an unresolved structured-input fixture and assertion**

Add a test named `unresolved_structured_user_input_marks_session_waiting_for_input` that writes these JSONL records to a temp session file:

```rust
r#"{"timestamp":"2026-08-04T04:05:00.000Z","type":"response_item","payload":{"type":"function_call","name":"request_user_input","arguments":"{\\"questions\\":[{\\"id\\":\\"confirm\\",\\"question\\":\\"Continue?\\"}]}","call_id":"call_input"}}"#
```

Assert `ObservationKind::WaitingForInput`, last activity `2026-08-04T04:05:00.000Z`, and evidence summary `Codex is waiting for structured user input`.

- [ ] **Step 2: Run the new test and verify it fails**

Run:

```bash
rtk proxy cargo test --manifest-path src-tauri/Cargo.toml unresolved_structured_user_input_marks_session_waiting_for_input
```

Expected: FAIL because `request_user_input` is not currently recognized as pending input.

- [ ] **Step 3: Add outputs and abort regression fixtures**

Add three separate tests that each start with the same `request_user_input` call:

```rust
r#"{"timestamp":"2026-08-04T04:06:00.000Z","type":"response_item","payload":{"type":"function_call_output","call_id":"call_input","output":"{\\"confirm\\":\\"yes\\"}"}}"#
r#"{"timestamp":"2026-08-04T04:06:00.000Z","type":"response_item","payload":{"type":"function_call_output","call_id":"call_input","output":"request_user_input is unavailable in Default mode"}}"#
r#"{"timestamp":"2026-08-04T04:06:00.000Z","type":"event_msg","payload":{"type":"turn_aborted","reason":"interrupted"}}"#
```

Name them `structured_user_input_output_clears_waiting_for_input`, `unavailable_structured_user_input_is_not_waiting_for_input`, and `interrupted_structured_user_input_is_stopped`. Assert the first two are not `WaitingForInput` and the last is `Stopped`.

- [ ] **Step 4: Run the new test group and verify the unresolved case fails**

Run:

```bash
rtk proxy cargo test --manifest-path src-tauri/Cargo.toml structured_user_input
rtk proxy cargo test --manifest-path src-tauri/Cargo.toml unavailable_structured_user_input_is_not_waiting_for_input
rtk proxy cargo test --manifest-path src-tauri/Cargo.toml interrupted_structured_user_input_is_stopped
```

Expected: the unresolved-request test fails because no structured-input state machine exists. The output and abort cases may already pass because the old parser never marks the request pending; retain them as regression guards and rely on the unresolved case as the required red signal.

### Task 2: Implement the minimal independent pending-input state machine

**Files:**
- Modify: `src-tauri/src/codex_source.rs:193-381`

- [ ] **Step 1: Add a `PendingStructuredUserInput` value type**

Place it next to `PendingToolApproval` with the same fields needed to identify and explain an unresolved request:

```rust
#[derive(Debug, Clone)]
struct PendingStructuredUserInput {
    call_id: Option<String>,
    timestamp: Option<String>,
    evidence_summary: String,
}
```

- [ ] **Step 2: Track `request_user_input` calls separately from elevated approvals**

In `parse_session_content`, declare `pending_structured_user_input` beside `pending_tool_approval`. Add `pending_structured_user_input_from_response_item` which returns a value only when the response item is a `function_call` named exactly `request_user_input` with a nonempty `call_id`. Do not inspect assistant message text or parse questions for status classification.

- [ ] **Step 3: Clear only the matching pending record**

For every `function_call_output`, compare its `call_id` with both pending records. Clear the matching structured-input record regardless of output content. On `turn_aborted`, clear both records before assigning `ObservationKind::Stopped`.

- [ ] **Step 4: Give either unresolved record precedence at end-of-file**

Replace the final pending check with:

```rust
let pending_input = pending_structured_user_input
    .as_ref()
    .map(|request| (request.timestamp.clone(), request.evidence_summary.clone()))
    .or_else(|| pending_tool_approval.as_ref().map(|approval| {
        (approval.timestamp.clone(), approval.evidence_summary.clone())
    }));
```

Use `pending_input.is_some()` for `WaitingForInput`, its evidence summary for `observation.evidence_summary`, and its timestamp for `last_activity_at`. Keep terminal completion, stale completion, running, and stopped branches unchanged.

- [ ] **Step 5: Run focused tests and verify they pass**

Run:

```bash
rtk proxy cargo test --manifest-path src-tauri/Cargo.toml structured_user_input
rtk proxy cargo test --manifest-path src-tauri/Cargo.toml command_approval
rtk proxy cargo test --manifest-path src-tauri/Cargo.toml interrupted_command_approval_is_stopped
```

Expected: all new structured-input tests pass and existing approval behavior remains green.

### Task 3: Synchronize the status contract and verify the repository

**Files:**
- Modify: `docs/status-flow.md:238-239`

- [ ] **Step 1: Replace the broad confirmation TODO with the remaining boundary**

Document that unresolved `request_user_input` function calls are exact `attention` evidence, but prose such as `please confirm` remains intentionally unclassified. State that a matching function output, including `unavailable`, clears the structured wait.

- [ ] **Step 2: Run scoped and full verification**

Run:

```bash
rtk proxy cargo test --manifest-path src-tauri/Cargo.toml
rtk proxy npm test
rtk proxy npm run build
rtk git diff --check
```

Expected: Rust, frontend tests, and production build pass; diff check emits no output.

- [ ] **Step 3: Inspect the final change set and commit only owned files**

Run:

```bash
rtk git diff -- src-tauri/src/codex_source.rs docs/status-flow.md
rtk git status --short
```

Stage only `src-tauri/src/codex_source.rs` and `docs/status-flow.md`, preserving all unrelated dirty files and the already committed specification. Commit with:

```bash
rtk git commit -m "feat: detect structured user input requests"
```
