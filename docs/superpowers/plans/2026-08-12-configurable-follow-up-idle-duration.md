# Configurable Follow-up Idle Duration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the read-driven `follow-up` to `idle` duration configurable in the management view, with a 30-minute default, a 20-minute minimum, and no product maximum.

**Architecture:** The React configuration remains the user-facing persisted source of truth and is passed with every session-list and Jump back request. Rust normalizes the optional minutes argument, uses it for acknowledged and external-read completion classification, and separates cache entries by normalized duration. The JavaScript development-source mirror accepts the same option through its preview HTTP endpoints so preview behavior matches the Tauri app.

**Tech Stack:** React 19, TypeScript, Vitest, Tauri 2, Rust, Node.js HTTP preview server.

## Global Constraints

- Use `followUpToIdleMinutes` as the shared camelCase configuration and command-field name.
- Default to `30`; normalize a value below `20` to `20`; do not add a UI `max` attribute or a product-level upper clamp.
- Treat the setting as a whole number of minutes. Non-finite browser-storage values use the default; fractional finite values truncate to whole minutes before the minimum is applied.
- Apply the duration to both successful Jump back acknowledgement and SQLite `updated_at_ms` read evidence. Do not change the 12-hour unread window, the 5-minute immediate-completion window, or `PENDING_CLI_INPUT_FRESHNESS`.
- Keep follow-up quiet: `needsAttention` remains `follow-up`, with no alert count or auto-open behavior changes.
- Preserve existing unstaged work in `.gitignore`, `src/features/statusPanel/statusPanel.ts`, `src/features/statusPanel/statusPanel.test.ts`, and `src/features/statusPanel/StatusPanelView.test.tsx`. Do not stage unrelated hunks from those files.
- Work directly on local `master`, as explicitly authorized. No remote is configured.

---

### Task 1: Add the native duration contract and cache-aware acknowledgement logic

**Files:**
- Modify: `src-tauri/src/inbox_store.rs:18-145,307-404,514-685,2525-2565`
- Modify: `src-tauri/src/lib.rs:11-19,96-113,263-274`
- Test: `src-tauri/src/inbox_store.rs:2525-2565`

**Interfaces:**
- Produces: `pub const DEFAULT_FOLLOW_UP_TO_IDLE_MINUTES: u64 = 30` and `pub const MIN_FOLLOW_UP_TO_IDLE_MINUTES: u64 = 20` in `inbox_store`.
- Produces: `pub fn normalize_follow_up_to_idle_minutes(minutes: Option<u64>) -> u64`, returning 30 for `None`, 20 for values below 20, and the supplied value otherwise.
- Produces: `InboxStore::list_sessions_with_follow_up_to_idle_minutes(&self, minutes: Option<u64>) -> Vec<SessionRow>` and `InboxStore::jump_to_session(..., follow_up_to_idle_minutes: Option<u64>) -> JumpResult`.
- Consumes: the optional `followUpToIdleMinutes` Tauri command argument from Task 4.

- [ ] **Step 1: Write failing Rust tests for normalization and the configurable acknowledgement boundary**

Add tests beside `acknowledged_rows_become_needed_for_thirty_minutes_then_idle` that call the intended API:

```rust
#[test]
fn normalizes_follow_up_to_idle_minutes_without_a_product_maximum() {
    assert_eq!(super::normalize_follow_up_to_idle_minutes(None), 30);
    assert_eq!(super::normalize_follow_up_to_idle_minutes(Some(19)), 20);
    assert_eq!(super::normalize_follow_up_to_idle_minutes(Some(20)), 20);
    assert_eq!(super::normalize_follow_up_to_idle_minutes(Some(180)), 180);
}

#[test]
fn acknowledged_rows_use_the_configured_follow_up_boundary() {
    let row = SessionRow::new("s6", "Inspect", SessionState::Inspect, Confidence::Exact)
        .with_last_activity("2026-06-04T04:00:00.000Z");
    let acknowledged_at_ms = 1_780_000_000_000;
    let acknowledged = HashSet::from([super::AcknowledgedSignal::from_row_at(&row, acknowledged_at_ms)]);
    let duration_ms = 45 * 60 * 1000;

    let at_boundary = super::apply_acknowledged_session_state(
        row.clone(), &acknowledged, acknowledged_at_ms + duration_ms, duration_ms,
    );
    let after_boundary = super::apply_acknowledged_session_state(
        row, &acknowledged, acknowledged_at_ms + duration_ms + 1, duration_ms,
    );

    assert_eq!(at_boundary.state, SessionState::NeedsAttention);
    assert_eq!(after_boundary.state, SessionState::Idle);
}
```

- [ ] **Step 2: Run the focused Rust test module and verify the expected compile failure**

Run:

```bash
rtk cargo test --manifest-path src-tauri/Cargo.toml acknowledged_rows_use_the_configured_follow_up_boundary
```

Expected: FAIL because `apply_acknowledged_session_state` does not accept the duration argument and `normalize_follow_up_to_idle_minutes` does not exist.

- [ ] **Step 3: Implement native normalization, cache separation, and acknowledgement timing**

At the top of `inbox_store.rs`, define the constants and helpers:

```rust
pub const DEFAULT_FOLLOW_UP_TO_IDLE_MINUTES: u64 = 30;
pub const MIN_FOLLOW_UP_TO_IDLE_MINUTES: u64 = 20;

pub fn normalize_follow_up_to_idle_minutes(minutes: Option<u64>) -> u64 {
    minutes
        .unwrap_or(DEFAULT_FOLLOW_UP_TO_IDLE_MINUTES)
        .max(MIN_FOLLOW_UP_TO_IDLE_MINUTES)
}

fn follow_up_window_millis(minutes: u64) -> u64 {
    minutes.saturating_mul(60).saturating_mul(1000)
}
```

Keep the existing no-argument `list_sessions()` as a default wrapper for internal callers. Add `list_sessions_with_follow_up_to_idle_minutes`, normalize once at its entry, store the normalized value in `CachedSessionRows`, and only reuse a cache entry when both TTL and normalized minutes match. Thread the resulting millisecond value through `compute_session_rows`, `finalize_session_row`, and `apply_acknowledged_session_state`.

Use the generic reason below so custom durations do not display a stale hard-coded value:

```rust
"Read recently; keep it quiet during the follow-up window."
```

Update `jump_to_session` and `fast_session_row_for_jump` to accept/pass the same optional minutes value, then use the cache-aware list method for its fallback lookup. Keep all existing callers on the default wrapper unless they receive an explicit command argument.

- [ ] **Step 4: Expose the optional setting through the Tauri commands**

Change the commands to accept optional minutes and call the new native methods:

```rust
#[tauri::command]
async fn list_sessions(
    state: tauri::State<'_, Arc<inbox_store::InboxStore>>,
    follow_up_to_idle_minutes: Option<u64>,
) -> Result<Vec<domain::session::SessionRow>, String> {
    let state = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || {
        state.list_sessions_with_follow_up_to_idle_minutes(follow_up_to_idle_minutes)
    })
    .await
    .map_err(|error| format!("session worker failed: {error}"))
}
```

Add the same `follow_up_to_idle_minutes: Option<u64>` argument to `jump_to_session` and forward it into `InboxStore::jump_to_session`. Tauri maps these snake_case parameters from the camelCase frontend payload.

- [ ] **Step 5: Run focused Rust tests and then the complete Rust suite**

Run:

```bash
rtk cargo test --manifest-path src-tauri/Cargo.toml acknowledged_rows_use_the_configured_follow_up_boundary
rtk npm run test:rust
```

Expected: Both pass; the second command confirms command/API signature changes did not break existing Rust callers.

- [ ] **Step 6: Commit the native contract**

```bash
git add src-tauri/src/inbox_store.rs src-tauri/src/lib.rs
git commit -m "feat: parameterize acknowledged follow-up duration"
```

### Task 2: Apply the native duration to SQLite read evidence

**Files:**
- Modify: `src-tauri/src/codex_source.rs:51-105,702-773,861-872,1893-1931`
- Modify: `src-tauri/src/inbox_store.rs:420-450`
- Modify: `src-tauri/src/domain/classification.rs:25-35,145-159`
- Test: `src-tauri/src/codex_source.rs:1893-1931`
- Test: `src-tauri/src/domain/classification.rs:145-159`

**Interfaces:**
- Consumes: normalized minutes from `InboxStore::list_sessions_with_follow_up_to_idle_minutes`.
- Produces: a duration-aware internal Codex-source discovery path used by both bulk list discovery and `fast_session_row_for_jump`.
- Produces: generic `Completed` status text: `completed task was opened; keep it quiet during the follow-up window`.

- [ ] **Step 1: Write a failing source-level boundary test for external read evidence**

Add a test that builds the same `threads` row as `sqlite_thread_update_after_task_complete_marks_completion_as_read`, but invokes the new duration-aware discovery function at exactly 45 minutes and one millisecond later:

```rust
let at_boundary = discover_codex_observations_with_state_db_and_follow_up_window(
    &state_db, temp.path(), 20,
    SystemTime::UNIX_EPOCH + Duration::from_secs(1_780_650_900),
    Duration::from_secs(45 * 60),
);
let after_boundary = discover_codex_observations_with_state_db_and_follow_up_window(
    &state_db, temp.path(), 20,
    SystemTime::UNIX_EPOCH + Duration::from_millis(1_780_650_900_001),
    Duration::from_secs(45 * 60),
);

assert_eq!(at_boundary[0].kind, ObservationKind::Completed);
assert_eq!(after_boundary[0].kind, ObservationKind::CompletedStale);
```

Use test timestamps derived from the inserted thread's `updated_at_ms`; the exact boundary must equal `updated_at_ms + 45 minutes`.

- [ ] **Step 2: Run the new test and verify it fails because the duration-aware API is absent**

Run:

```bash
rtk cargo test --manifest-path src-tauri/Cargo.toml sqlite_thread_update_uses_configured_follow_up_boundary
```

Expected: FAIL at compile time because `discover_codex_observations_with_state_db_and_follow_up_window` is not defined.

- [ ] **Step 3: Implement duration-aware discovery without changing default callers**

Keep the existing public discovery functions as default-30-minute wrappers. Add internal/public-for-crate variants that take a `Duration`, and route their thread parsing through it:

```rust
pub fn discover_codex_observations_with_state_db_and_follow_up_window(
    state_db: &Path,
    sessions_root: &Path,
    limit: usize,
    now: SystemTime,
    follow_up_window: Duration,
) -> Vec<SourceObservation> {
    discover_codex_observations_with_state_db_and_hooks_and_follow_up_window(
        state_db, sessions_root, &codex_hook_events_path(), limit, now, follow_up_window,
    )
}
```

Add `follow_up_window: Duration` to `observation_from_thread` and change only this branch:

```rust
let thread_completion_kind = completion_kind_from_last_activity_at(
    last_activity_at.as_deref(), now, follow_up_window,
);
```

`completion_kind_from_last_activity_at` must retain the fixed 5-minute `CompletedImmediate` check and use the passed duration only for `Completed` versus `CompletedStale`. Do not pass it to JSONL unread completion parsing.

In `InboxStore`, convert normalized minutes with the Task 1 millisecond helper and use `Duration::from_millis(...)` when calling the duration-aware bulk and by-id source functions.

- [ ] **Step 4: Remove stale 30-minute wording from classification**

Change the `ObservationKind::Completed` reason and its test assertion to:

```rust
"completed task was opened; keep it quiet during the follow-up window"
```

This avoids reporting 30 minutes when the configured window is different.

- [ ] **Step 5: Run affected Rust tests and the full Rust suite**

Run:

```bash
rtk cargo test --manifest-path src-tauri/Cargo.toml sqlite_thread_update_uses_configured_follow_up_boundary
rtk cargo test --manifest-path src-tauri/Cargo.toml classifies_completed_observation_as_needing_attention
rtk npm run test:rust
```

Expected: exact-boundary source evidence remains `Completed`, one millisecond later is `CompletedStale`, and all Rust tests pass.

- [ ] **Step 6: Commit the external-read classification change**

```bash
git add src-tauri/src/codex_source.rs src-tauri/src/inbox_store.rs src-tauri/src/domain/classification.rs
git commit -m "feat: apply follow-up duration to read evidence"
```

### Task 3: Keep the development source and preview transport in lockstep

**Files:**
- Modify: `scripts/codexSessionsDevSource.mjs:6-205,245-322,717-742`
- Modify: `scripts/codexSessionsDevSource.test.mjs:313-466`
- Modify: `dev-server.mjs:13-38`
- Test: `scripts/codexSessionsDevSource.test.mjs:313-466`

**Interfaces:**
- Produces: `normalizeFollowUpToIdleMinutes(value)` in the development source, matching default 30/minimum 20/no product maximum.
- Consumes: `followUpToIdleMinutes` in `discoverCodexSessions`, `discoverCodexThreadById`, `jumpToSession`, and `createCodexSessionsDevSource` options.
- Consumes: `followUpToIdleMinutes` URL query/body values in the preview server without losing its in-memory Jump back acknowledgements.

- [ ] **Step 1: Write failing JavaScript mirror tests for a custom duration**

Replace the existing 30-minute-only acknowledgement test with a 45-minute custom configuration and assert both exact and post-boundary behavior:

```js
const source = createCodexSessionsDevSource({
  stateDbPath,
  sessionsRoot: path.join(temp, "sessions"),
  nowMs: () => nowMs,
  followUpToIdleMinutes: 45,
  unreadCompletionTrackingStartMs: earlyTrackingStartMs,
  executeJump: async () => undefined,
});

nowMs = acknowledgedAtMs + 45 * 60 * 1000;
expect(source.discoverCodexSessions()[0].state).toBe("needsAttention");
nowMs += 1;
expect(source.discoverCodexSessions()[0].state).toBe("idle");
```

Add a second SQLite-read fixture with `followUpToIdleMinutes: 45` at the same boundary, plus an assertion that `followUpToIdleMinutes: 12` normalizes to the 20-minute minimum.

- [ ] **Step 2: Run the mirror tests and verify the expected failure**

Run:

```bash
rtk npm test -- scripts/codexSessionsDevSource.test.mjs -t "uses the configured follow-up boundary"
```

Expected: FAIL because the options are ignored and the existing 30-minute hard-code expires at the wrong time.

- [ ] **Step 3: Implement a shared development-source duration option**

Near the existing source constants, add:

```js
export const defaultFollowUpToIdleMinutes = 30;
export const minFollowUpToIdleMinutes = 20;

export function normalizeFollowUpToIdleMinutes(value) {
  if (!Number.isFinite(value)) return defaultFollowUpToIdleMinutes;
  return Math.max(minFollowUpToIdleMinutes, Math.trunc(value));
}
```

Normalize once in each public options entry point, propagate the normalized minutes to `discoverCodexThreads`, `parseThreadRow`, and `completionKindFromLastActivityAt`, and compare the acknowledgement window against `followUpToIdleMinutes * 60 * 1000`. Replace both hard-coded follow-up reason strings with the generic wording used by Rust.

Make `createCodexSessionsDevSource` accept an optional runtime override for both
`discoverCodexSessions(overrides?)` and `jumpToSession(sessionId, overrides?)`.
Merge it with the instance defaults, normalize the resulting value, and retain
the instance's acknowledgement map. This lets an existing acknowledged row be
reclassified under a newly applied setting without losing the acknowledgement.

- [ ] **Step 4: Parse and forward preview request settings**

In `dev-server.mjs`, construct one module-level preview source so its
acknowledgement map survives independent HTTP requests:

```js
const previewSource = createCodexSessionsDevSource();
```

Read the sessions query parameter and Jump back body field through that source:

```js
if (url.pathname === "/api/sessions") {
  return sendJson(res, previewSource.discoverCodexSessions({
    followUpToIdleMinutes: Number(url.searchParams.get("followUpToIdleMinutes")),
  }));
}

if (url.pathname === "/api/jump" && req.method === "POST") {
  return readJsonBody(req)
    .then(({ sessionId, followUpToIdleMinutes }) =>
      previewSource.jumpToSession(sessionId, { followUpToIdleMinutes }),
    )
    .then((result) => sendJson(res, result));
}
```

The mirror normalization handles omitted, malformed, and below-minimum values.

- [ ] **Step 5: Run the development-source suite**

Run:

```bash
rtk npm test -- scripts/codexSessionsDevSource.test.mjs
```

Expected: PASS, including custom, minimum, external-read, and acknowledgement boundaries.

- [ ] **Step 6: Commit preview parity**

```bash
git add scripts/codexSessionsDevSource.mjs scripts/codexSessionsDevSource.test.mjs dev-server.mjs
git commit -m "feat: mirror configurable follow-up duration in preview"
```

### Task 4: Add the management setting and send it with every status request

**Files:**
- Modify: `src/features/statusPanel/statusPanel.ts:5-14,58-90,124-141,216-375`
- Modify: `src/features/statusPanel/statusPanel.test.ts:45-60`
- Modify: `src/features/statusPanel/StatusPanelView.tsx:76-85,267-285,391-437,699-713,1169-1200`
- Modify: `src/features/statusPanel/StatusPanelView.test.tsx:220-245,604-623,770-835,1920-1945`
- Modify: `src/features/inbox/inboxApi.ts:20-32,131-168`
- Test: `src/features/statusPanel/StatusPanelView.test.tsx:220-245,604-623,770-835`

**Interfaces:**
- Produces: `StatusPanelConfig.followUpToIdleMinutes: number`, defaulting to 30.
- Produces: `loadSessions(followUpToIdleMinutes?: number)` and `jumpToSession(sessionId, acknowledgedSessionIds?, followUpToIdleMinutes?)`.
- Consumes: optional native and preview command field `followUpToIdleMinutes` from Tasks 1 and 3.

- [ ] **Step 1: Write failing management and transport tests**

Add a management-view test that opens Settings, checks the new input, changes it to 45, applies it, and proves persistence plus immediate native refresh:

```tsx
expect((await screen.findByLabelText("Follow-up to idle minutes") as HTMLInputElement).min).toBe("20");
expect(screen.getByLabelText("Follow-up to idle minutes").getAttribute("max")).toBeNull();
fireEvent.change(screen.getByLabelText("Follow-up to idle minutes"), { target: { value: "45" } });
fireEvent.click(screen.getByRole("button", { name: "Apply settings" }));

await waitFor(() => {
  expect(lastInvokeCall("list_sessions")).toEqual([
    "list_sessions",
    { followUpToIdleMinutes: 45 },
  ]);
});
expect(readPersistedConfig().followUpToIdleMinutes).toBe(45);
```

Make `lastInvokeCall` a small local test helper that filters `tauriCoreMock.invoke.mock.calls` by command name. Add a separate persisted-config test with `followUpToIdleMinutes: 12` and assert the management input renders `20`; add `followUpToIdleMinutes: 180` and assert it remains `180`.

- [ ] **Step 2: Run the focused view test and verify it fails**

Run:

```bash
rtk npm test -- src/features/statusPanel/StatusPanelView.test.tsx -t "applies the configured follow-up idle duration"
```

Expected: FAIL because the input, config field, and `list_sessions` argument do not exist.

- [ ] **Step 3: Add the frontend configuration contract and localized field**

Extend `StatusPanelConfig`, `defaultStatusPanelConfig`, and `StatusPanelCopy`:

```ts
export interface StatusPanelConfig {
  // Existing fields...
  followUpToIdleMinutes: number;
}

export const defaultStatusPanelConfig: StatusPanelConfig = {
  // Existing defaults...
  followUpToIdleMinutes: 30,
};
```

Add localized labels `Follow-up to idle minutes` and `待跟进转空闲分钟`. In the management form, add a numeric input near `Alert display seconds` with `type="number"`, `min={20}`, `step={1}`, no `max`, and the normal draft-only update behavior.

In `normalizeConfig`, use this exact helper behavior:

```ts
function normalizeFollowUpToIdleMinutes(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return defaultStatusPanelConfig.followUpToIdleMinutes;
  }
  return Math.max(20, Math.trunc(value));
}
```

Return its result as `followUpToIdleMinutes`. Old local-storage records missing the field must receive the 30-minute default.

- [ ] **Step 4: Send the active duration through list refresh and Jump back**

Update API methods to accept the optional setting and include it in both runtime and preview requests:

```ts
export async function loadSessions(followUpToIdleMinutes?: number): Promise<SessionRow[]> {
  if (hasTauriRuntime()) {
    return invoke<SessionRow[]>("list_sessions", { followUpToIdleMinutes });
  }
  return fetchDevJson<SessionRow[]>(
    `/api/sessions?followUpToIdleMinutes=${encodeURIComponent(String(followUpToIdleMinutes ?? ""))}`,
    initialSessions,
  );
}
```

Pass the same setting in `jumpToSession` Tauri arguments and preview JSON body. In `StatusPanelView`, make `refreshPanel` read `configRef.current.followUpToIdleMinutes`; call it after Apply with the normalized next value so the native row state refreshes immediately rather than waiting for the five-second poll. Pass the active config value to `jumpToSessionCommand` as well.

Keep `InboxView` unchanged: its no-argument calls retain native/default behavior.

- [ ] **Step 5: Run focused frontend tests and the full frontend suite**

Run:

```bash
rtk npm test -- src/features/statusPanel/statusPanel.test.ts src/features/statusPanel/StatusPanelView.test.tsx
rtk npm test
```

Expected: PASS. Verify the existing user changes to the 30-second panel auto-collapse default still pass unchanged.

- [ ] **Step 6: Commit only the intended frontend/configuration files**

```bash
git add src/features/statusPanel/statusPanel.ts src/features/statusPanel/statusPanel.test.ts src/features/statusPanel/StatusPanelView.tsx src/features/statusPanel/StatusPanelView.test.tsx src/features/inbox/inboxApi.ts
git diff --cached --check
git commit -m "feat: configure follow-up idle duration"
```

Before this commit, inspect the staged diff and unstage any pre-existing `.gitignore` or unrelated status-panel hunks.

### Task 5: Document the configurable status contract and verify the integrated change

**Files:**
- Modify: `docs/status-flow.md:95-112,177-178,200-205,217-218,245-246,265-266,279-285,303-312`
- Modify: `scripts/explainCodexSession.test.mjs:55-63`
- Test: `scripts/explainCodexSession.test.mjs:1-100`

**Interfaces:**
- Consumes: the generic follow-up status reason from Tasks 1-3.
- Produces: documentation that names the setting as configurable, default 30 minutes, and minimum 20 minutes.

- [ ] **Step 1: Update documentation wording and the diagnostic expectation**

Replace all product-contract references that state a fixed 30-minute follow-up window with precise wording such as:

```markdown
`follow-up`: completed result was opened/read within the configured follow-up window (30 minutes by default; 20-minute minimum).
```

For transition rows, state `Read window exceeds the configured follow-up duration`. Keep the fixed 12-hour unread and fixed 5-minute immediate completion values distinct.

Update `scripts/explainCodexSession.test.mjs` to expect:

```js
statusReason: "completed task was opened; keep it quiet during the follow-up window",
```

- [ ] **Step 2: Run documentation-adjacent and full regression commands**

Run:

```bash
rtk npm test -- scripts/explainCodexSession.test.mjs scripts/codexSessionsDevSource.test.mjs
rtk npm run test:rust
rtk npm run build
rtk git diff --check
```

Expected: all commands pass and `git diff --check` produces no output.

- [ ] **Step 3: Review final scope and commit docs/tests**

Inspect:

```bash
git status --short
git diff -- docs/status-flow.md scripts/explainCodexSession.test.mjs
```

Then commit only the task files:

```bash
git add docs/status-flow.md scripts/explainCodexSession.test.mjs
git commit -m "docs: describe configurable follow-up duration"
```

Do not stage `.gitignore` or unrelated pre-existing work.
