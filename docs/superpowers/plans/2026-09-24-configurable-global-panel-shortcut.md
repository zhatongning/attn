# Configurable Global Panel Shortcut Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a configurable global shortcut that expands or collapses the whole Attn panel, including a real key recorder, clear/restore controls, conflict reporting, and behavior that does not steal focus from another application.

**Architecture:** Rust owns one process-wide global shortcut registration through `tauri-plugin-global-shortcut`; React owns the existing `panelOpen` state, resize effect, recorder, and persisted settings. A Rust event carries only the shortcut action and whether the native window was hidden, so the existing React state machine remains the single owner of panel height and automatic-collapse timers.

**Tech Stack:** React 19, TypeScript, Vitest, Tauri 2.0, Rust, `tauri-plugin-global-shortcut` 2.0, CSS, localStorage.

**Spec:** `docs/superpowers/specs/2026-09-24-configurable-global-panel-shortcut-design.md`

## Global Constraints

- Store the canonical accelerator in `StatusPanelConfig.panelToggleShortcut` as `string | null`; `null` disables the shortcut.
- Use `shift+alt+super+space` as the canonical form of the default `Alt+Shift+Command+Space`; display a human-readable platform label separately.
- Target `panelOpen` (the whole content panel), never `expanded` (the hidden-session-row list).
- Register globally in Rust with `tauri-plugin-global-shortcut = "=2.0.0"`; do not add the JavaScript global-shortcut package or new global-shortcut IPC capabilities.
- Register the new shortcut before unregistering the old one; on an unregister failure, mark native state uncertain, attempt to unregister the new value, and reject subsequent changes until restart.
- Require Alt, Control, or Command as a primary modifier (Shift may supplement); support only F1-F20. Reject Shift-only and F21-F24 in TypeScript and Rust.
- Process only `ShortcutState::Pressed`; a release event must not produce a second toggle.
- If the native window is hidden, call `show()` best effort and emit the toggle event with `wasHidden = true`; never call `set_focus` from the shortcut path.
- Missing or malformed persisted shortcut values normalize to the default; an explicit `null` remains disabled.
- The browser/Vite preview has no native manager; its API wrapper is a successful no-op that returns the requested value.
- A new-registration conflict leaves the known active shortcut intact and reports it separately from the persisted request or attempted draft. Unregister failures cannot make that guarantee and require a restart.
- Return structured native errors `{ code, activeShortcut, stateUncertain }` captured under the native lock; do not expose platform error text or query native state after failure.
- A visible shortcut in Settings leaves Settings and its draft open while toggling the underlying `panelOpen`; Back reveals that state. A hidden-window shortcut returns to the expanded panel.
- Preserve all unrelated dirty work in the current `master` worktree; stage only shortcut files and intended hunks. Do not create a branch or rebuild/replace the installed Attn application for this change.

## Review Focus

- Modifier-only, modifier-free, repeated, or layout-dependent key events must stay in recording mode without changing the saved shortcut; `Escape` must cancel. Test in Task 1 and Task 6.
- A new-registration conflict must leave the previous known registration active. Old-registration removal failure must poison native state despite the rollback attempt; every later configure call must fail before registrar operations. Test in Task 2.
- A hidden-window press must show and expand without focusing Attn, while a visible press must toggle exactly once and cancel an auto-collapse timer. Test in Task 3 and Task 5.
- React StrictMode/unmount timing must not leave duplicate native listeners or an unlisten callback that runs after unmount. Test in Task 5.
- Legacy, missing, malformed, and explicitly disabled localStorage values must normalize deterministically in desktop and preview paths. Test in Task 1, Task 4, and Task 6.

---

## File Map

- Create `src/features/statusPanel/panelShortcut.ts` for pure accelerator parsing, recording, canonicalization, and display formatting.
- Create `src/features/statusPanel/panelShortcut.test.ts` for the pure TypeScript contract.
- Modify `src/features/statusPanel/statusPanel.ts` and `src/features/statusPanel/statusPanel.test.ts` for the persisted config field, default, and localized copy labels.
- Modify `src/features/statusPanel/StatusPanelView.tsx`, `src/features/statusPanel/StatusPanelView.test.tsx`, and `src/App.css` for the native event bridge, shared panel toggle, recorder controls, async apply flow, and error presentation.
- Modify `src/features/inbox/inboxApi.ts` and `src/features/inbox/inboxApi.test.ts` for the desktop command wrapper and preview no-op.
- Create `src-tauri/src/panel_shortcut.rs` for canonical native parsing, transactional registration, state, command errors, and the pressed-event handler.
- Modify `src-tauri/src/lib.rs` to register managed state/plugin/setup/command wiring, and `src-tauri/Cargo.toml` plus `src-tauri/Cargo.lock` for the pinned desktop dependency.
- Do not modify `src-tauri/capabilities/default.json`, `package.json`, session classification, polling, placement, or the existing hidden-row `expanded` behavior.

### Task 1: Define the TypeScript shortcut contract and persisted configuration

**Files:**
- Create: `src/features/statusPanel/panelShortcut.ts`
- Create: `src/features/statusPanel/panelShortcut.test.ts`
- Modify: `src/features/statusPanel/statusPanel.ts:5-15,52-123,220-380`
- Modify: `src/features/statusPanel/statusPanel.test.ts`

**Interfaces:**
- Produces `DEFAULT_PANEL_TOGGLE_SHORTCUT: "shift+alt+super+space"`.
- Produces `interface PanelShortcutKeyboardEvent { code: string; altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; repeat: boolean }`.
- Produces `type PanelShortcutCapture = { status: "captured"; value: string } | { status: "cancelled" } | { status: "ignored" }`.
- Produces `capturePanelShortcut(event: PanelShortcutKeyboardEvent): PanelShortcutCapture`, `normalizePanelToggleShortcut(value: unknown): string | null`, and `formatPanelShortcut(value: string | null): string`.
- Extends `StatusPanelConfig` with `panelToggleShortcut: string | null` and extends `StatusPanelCopy` with labels for the shortcut, recording state, clear/restore actions, disabled state, and registration errors.

- [ ] **Step 1: Write failing pure-contract tests**

Add tests that pin the canonical order and all recorder branches:

```ts
expect(DEFAULT_PANEL_TOGGLE_SHORTCUT).toBe("shift+alt+super+space");
expect(capturePanelShortcut({ code: "Space", altKey: true, shiftKey: true, metaKey: true, ctrlKey: false, repeat: false }))
  .toEqual({ status: "captured", value: "shift+alt+super+space" });
expect(capturePanelShortcut({ code: "ShiftLeft", altKey: false, shiftKey: true, metaKey: false, ctrlKey: false, repeat: false }))
  .toEqual({ status: "ignored" });
expect(capturePanelShortcut({ code: "KeyA", altKey: false, shiftKey: false, metaKey: false, ctrlKey: false, repeat: false }))
  .toEqual({ status: "ignored" });
expect(capturePanelShortcut({ code: "Escape", altKey: false, shiftKey: false, metaKey: false, ctrlKey: false, repeat: false }))
  .toEqual({ status: "cancelled" });
expect(normalizePanelToggleShortcut(undefined)).toBe(DEFAULT_PANEL_TOGGLE_SHORTCUT);
expect(normalizePanelToggleShortcut("not-a-shortcut")).toBe(DEFAULT_PANEL_TOGGLE_SHORTCUT);
expect(normalizePanelToggleShortcut(null)).toBeNull();
expect(formatPanelShortcut(DEFAULT_PANEL_TOGGLE_SHORTCUT)).toBe("Option-Shift-Command-Space");
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
rtk npm test -- --run src/features/statusPanel/panelShortcut.test.ts
```

Expected: FAIL because the module, parser, and config field do not exist yet.

- [ ] **Step 3: Implement the pure parser and recorder**

Use `KeyboardEvent.code`, not `event.key`, so the recorded accelerator is independent of keyboard layout. Map `metaKey`, `altKey`, `ctrlKey`, and `shiftKey` to `super`, `alt`, `control`, and `shift`; map `Space`, `KeyA`-`KeyZ`, `Digit0`-`Digit9`, `F1`-`F20`, and the arrow/navigation codes to stable lower-case key names. Reject modifier-only codes, unknown codes, no-primary-modifier combinations (including Shift-only), and `event.repeat`. Emit modifiers in `shift`, `control`, `alt`, `super` order. Make `Escape` return `cancelled` before ordinary key validation.

`normalizePanelToggleShortcut` must accept only that same canonical grammar, return the default for `undefined`, non-string, empty, or malformed values, and return `null` only for an explicit `null`. `formatPanelShortcut` must render modifiers in `alt`, `shift`, `control`, `super` display order, map them to `Option`, `Shift`, `Control`, and `Command`, title-case the key, and join with `-`; `null` formats as `Disabled`.

- [ ] **Step 4: Add the config field, default, and bilingual copy**

Set `defaultStatusPanelConfig.panelToggleShortcut` to `DEFAULT_PANEL_TOGGLE_SHORTCUT`. Add matching English and Chinese copy for the field label, record button, recording prompt, clear button, restore-default button, disabled label, registration-conflict message, current-active label, and restart-required status. Keep the existing copy names and status text unchanged.

- [ ] **Step 5: Run the pure tests and existing status-model tests**

Run:

```bash
rtk npm test -- --run src/features/statusPanel/panelShortcut.test.ts src/features/statusPanel/statusPanel.test.ts
```

Expected: all new parser/default assertions and the existing status-model assertions pass.

- [ ] **Step 6: Commit the pure contract**

Stage the two new files normally, stage only the shortcut hunks from the two modified status-panel files with `git add -p`, inspect the staged patch, and run:

```bash
rtk git add src/features/statusPanel/panelShortcut.ts src/features/statusPanel/panelShortcut.test.ts
rtk git add -p src/features/statusPanel/statusPanel.ts src/features/statusPanel/statusPanel.test.ts
rtk git diff --cached --check
rtk git commit -m "feat: define configurable panel shortcut contract"
```

### Task 2: Build and test the native transactional shortcut manager

**Files:**
- Create: `src-tauri/src/panel_shortcut.rs`
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/Cargo.lock`
- Modify: `src-tauri/src/lib.rs:1-4` (desktop module declaration only)

**Interfaces:**
- Produces `PanelShortcutState` with mutex-protected `Known(Option<String>)` versus `Uncertain` registration state.
- Produces a serializable `PanelShortcutError` object with stable `code`, `activeShortcut`, and `stateUncertain` fields. Codes include `invalid_shortcut`, `registration_failed`, `registration_uncertain`, and `rollback_failed`.
- Produces `canonicalize_shortcut(value: &str)` and `apply_shortcut_update(active: &mut ShortcutRegistrationState, requested: Option<&str>, registrar: &mut impl ShortcutRegistrar)` with safe grammar and an atomic error snapshot.
- Produces `DEFAULT_PANEL_SHORTCUT`, `TOGGLE_PANEL_EVENT`, `ShortcutRegistrar`, and `is_pressed(state: ShortcutState) -> bool` used by the Tauri handler.

- [ ] **Step 1: Add failing Rust tests for parsing and update order**

Add a fake registrar that records `register`/`unregister` operations and can fail either operation. Test the exact cases below:

```rust
assert_eq!(canonicalize_shortcut("ALT+SHIFT+SUPER+SPACE")?, "shift+alt+super+space");
assert!(canonicalize_shortcut("space").is_err());
assert!(canonicalize_shortcut("shift+a").is_err());
assert_eq!(canonicalize_shortcut("super+f20")?, "super+f20");
assert!(canonicalize_shortcut("super+f21").is_err());

let mut active = ShortcutRegistrationState::Known(Some("shift+alt+super+space".to_owned()));
let mut registrar = FakeRegistrar::default();
let next = apply_shortcut_update(&mut active, Some("control+alt+super+p"), &mut registrar)?;
assert_eq!(next.as_deref(), Some("control+alt+super+p"));
assert_eq!(registrar.operations, vec![
    "register:control+alt+super+p".to_owned(),
    "unregister:shift+alt+super+space".to_owned(),
]);
```

Also assert that an old-unregister failure triggers `unregister:new` and poisons state, that a clear-unregister failure poisons state, that subsequent calls perform no registrar operations, and that an unchanged known value performs no operation. Add a pure assertion that only `ShortcutState::Pressed` is handled.

Add the desktop-only `panel_shortcut` module declaration to `lib.rs` before running the test command so Cargo compiles the new file and exposes the intended missing-dependency/type failures.

- [ ] **Step 2: Run the focused Rust tests and verify RED**

Run:

```bash
rtk cargo test --manifest-path src-tauri/Cargo.toml panel_shortcut
```

Expected: FAIL because the module and dependency are not present.

- [ ] **Step 3: Add the pinned desktop dependency, module declaration, and native data types**

Add this target-specific dependency so mobile builds do not attempt to compile the desktop plugin:

```toml
[target."cfg(not(any(target_os = \"android\", target_os = \"ios\")))".dependencies]
tauri-plugin-global-shortcut = "=2.0.0"
```

Use `tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutEvent, ShortcutState}` and `std::str::FromStr`. Parse with `Shortcut::from_str`, canonicalize it, then enforce a primary modifier and F1-F20 limit. Keep the mutex-protected `Known`/`Uncertain` state as the only logical active-state source. Define `PanelShortcutError` with `Serialize`, `Display`, and `Error` implementations so the Tauri command can return a structured snapshot without exposing platform error text.

Keep the `#[cfg(desktop)] pub mod panel_shortcut;` declaration added in Step 1 so the unit tests in the new file are compiled. The later wiring task adds the plugin, state, setup, and command references without adding a second module declaration.

- [ ] **Step 4: Implement register-before-unregister and rollback**

Implement `apply_shortcut_update` exactly in this order:

1. Reject calls in `Uncertain` state before parsing or touching the registrar; otherwise canonicalize the requested value.
2. Return the current value unchanged when it equals the request.
3. Register the new value first; on failure return `RegistrationFailed` and keep the current value.
4. Unregister the old value; if that fails, mark `Uncertain`, attempt to unregister the new value, and return `RegistrationUncertain` or `RollbackFailed` when that rollback itself fails. Do not claim the old value remains active.
5. For `None`, unregister the old value and set the logical value to `None` only after success; failure marks `Uncertain`.

Keep the mutex locked through the transition and error snapshot; the production registrar must not call back into the command while the lock is held.

- [ ] **Step 5: Run the manager tests and commit the native core**

Run:

```bash
rtk cargo test --manifest-path src-tauri/Cargo.toml panel_shortcut
```

Expected: parser, ordering, conflict, rollback, clear, no-op, and pressed-state tests pass. Then stage only `panel_shortcut.rs`, `Cargo.toml`, and the lockfile and commit:

```bash
rtk git add src-tauri/src/panel_shortcut.rs src-tauri/Cargo.toml src-tauri/Cargo.lock
rtk git add -p src-tauri/src/lib.rs
rtk git diff --cached --check
rtk git commit -m "feat: add transactional native panel shortcut manager"
```

### Task 3: Wire the native manager into Tauri without focus stealing

**Files:**
- Modify: `src-tauri/src/panel_shortcut.rs`
- Modify: `src-tauri/src/lib.rs:1-130,217-300`

**Interfaces:**
- Produces `#[tauri::command] configure_panel_shortcut(shortcut: Option<String>) -> Result<PanelShortcutUpdate, PanelShortcutError>`.
- Produces `register_default<R: Runtime>(app: &AppHandle<R>) -> Result<(), PanelShortcutError>` for best-effort startup registration.
- Consumes `PanelShortcutState`, `ShortcutRegistrar`, `TOGGLE_PANEL_EVENT`, and the plugin API from Task 2.

- [ ] **Step 1: Add failing wiring checks**

Add a `serializes_update_as_camel_case` unit test that serializes `PanelShortcutUpdate { active_shortcut: Some("shift+alt+super+space".into()) }` and expects `{ "activeShortcut": "shift+alt+super+space" }`. Add a handler-seam test that sends `ShortcutState::Released` and asserts the injected window/event callback is not called. Keep actual `AppHandle` operations out of unit tests; the production handler remains a thin adapter around the tested seam.

- [ ] **Step 2: Implement the Tauri registrar and command**

Wrap `app.global_shortcut()` in a production `ShortcutRegistrar`: parse each canonical string into `Shortcut`, call `on_shortcut(shortcut, handle_panel_shortcut_event)` for registration, and call `unregister(shortcut)` for removal. Define:

```rust
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PanelShortcutUpdate {
    pub active_shortcut: Option<String>,
}

#[tauri::command]
pub fn configure_panel_shortcut(
    app: tauri::AppHandle,
    state: tauri::State<'_, PanelShortcutState>,
    shortcut: Option<String>,
) -> Result<PanelShortcutUpdate, PanelShortcutError>;
```

The command canonicalizes and applies the request, then returns the committed active value. Do not use `unregister_all`, because it could remove unrelated future accelerators.

- [ ] **Step 3: Implement the pressed event handler**

In `handle_panel_shortcut_event`, return immediately unless `event.state == ShortcutState::Pressed`. For the main window, read visibility, set `was_hidden = !visible`, call `show()` only when hidden, and emit `TOGGLE_PANEL_EVENT` with the boolean payload. Log show/emit failures and still attempt the event when a show call fails. Never call `set_focus`, `set_size`, or `set_position` in this handler.

- [ ] **Step 4: Register the plugin, state, default, and command in `lib.rs`**

Retain the `pub mod panel_shortcut` declaration added in Task 2 behind the desktop target guard. In the builder, add `manage(PanelShortcutState::default())` and `.plugin(tauri_plugin_global_shortcut::Builder::new().build())`. In the existing `setup`, call `register_default(app.handle())`; log a registration error and return `Ok(())` so startup remains usable. Include `configure_panel_shortcut` in `generate_handler![]`. Keep the existing Settings menu `set_focus` behavior unchanged; it is unrelated to the global shortcut path.

- [ ] **Step 5: Run native compile and unit verification**

Run:

```bash
rtk cargo test --manifest-path src-tauri/Cargo.toml panel_shortcut
rtk cargo check --manifest-path src-tauri/Cargo.toml
```

Expected: the manager tests and the full desktop crate compile, with no capability or JavaScript dependency changes. Commit only the Tauri wiring hunks:

```bash
rtk git add src-tauri/src/panel_shortcut.rs src-tauri/src/lib.rs
rtk git commit -m "feat: register global panel shortcut in Tauri"
```

### Task 4: Expose the command through the frontend API boundary

**Files:**
- Modify: `src/features/inbox/inboxApi.ts:1-45`
- Modify: `src/features/inbox/inboxApi.test.ts`

**Interfaces:**
- Produces `interface PanelShortcutUpdate { activeShortcut: string | null }` and `configurePanelShortcut(shortcut: string | null): Promise<PanelShortcutUpdate>`.
- Consumes the Rust command `configure_panel_shortcut` with payload `{ shortcut }`.

- [ ] **Step 1: Write failing desktop and preview tests**

Add tests that set `window.__TAURI_INTERNALS__` and assert:

```ts
tauriCoreMock.invoke.mockResolvedValue({ activeShortcut: "shift+alt+super+space" });
await expect(configurePanelShortcut("shift+alt+super+space")).resolves.toEqual({
  activeShortcut: "shift+alt+super+space",
});
expect(tauriCoreMock.invoke).toHaveBeenCalledWith("configure_panel_shortcut", {
  shortcut: "shift+alt+super+space",
});
```

Without Tauri runtime, assert that the function resolves to the requested value and never calls `invoke` or `fetch`. Assert that a recognized structured desktop rejection becomes a typed error with the native snapshot, while unrelated or legacy unknown rejections propagate unchanged.

- [ ] **Step 2: Run the focused API tests and verify RED**

Run:

```bash
rtk npm test -- --run src/features/inbox/inboxApi.test.ts
```

Expected: FAIL because the wrapper is not exported.

- [ ] **Step 3: Implement the wrapper**

Use the existing `hasTauriRuntime()` branch:

```ts
export async function configurePanelShortcut(shortcut: string | null): Promise<PanelShortcutUpdate> {
  if (!hasTauriRuntime()) return { activeShortcut: shortcut };
  try {
    return await invoke<PanelShortcutUpdate>("configure_panel_shortcut", { shortcut });
  } catch (error) {
    throw normalizePanelShortcutError(error);
  }
}
```

Normalize only the recognized `{ code, activeShortcut, stateUncertain }` native shape; preserve unrelated/legacy rejections and do not fall back to a preview request.

- [ ] **Step 4: Run API tests and commit**

Run:

```bash
rtk npm test -- --run src/features/inbox/inboxApi.test.ts
```

Expected: all API tests pass. Stage and commit only the API files:

```bash
rtk git add src/features/inbox/inboxApi.ts src/features/inbox/inboxApi.test.ts
rtk git commit -m "feat: expose panel shortcut configuration command"
```

### Task 5: Bridge the native event to the existing panel state

**Files:**
- Modify: `src/features/statusPanel/StatusPanelView.tsx:1-310,690-710,900-945`
- Modify: `src/features/statusPanel/StatusPanelView.test.tsx`

**Interfaces:**
- Produces one `togglePanelOpen(wasHidden?: boolean)` helper shared by the title-bar button and the native event.
- Consumes `agent-session-inbox://toggle-panel` with a boolean payload and the existing `panelOpen`/auto-collapse state.

- [ ] **Step 1: Add failing event/state tests**

Capture the `listen` callback using the existing test mock and assert:

```tsx
await act(async () => { await toggleHandler?.({ payload: false }); });
expect(document.querySelector(".panel-shell--collapsed")).toBeNull();
await act(async () => { await toggleHandler?.({ payload: false }); });
expect(document.querySelector(".panel-shell--collapsed")).not.toBeNull();
```

Add a hidden-window case that starts in management view, sends `{ payload: true }`, and asserts the panel view is rendered expanded. Add a visible-window case in Settings that preserves its draft and view while toggling the underlying panel; Back reveals the toggled state. Start an auto-collapse timer, send a visible toggle, advance fake timers beyond the old delay, and assert the user-selected state remains. Add an unmount case where the asynchronous `listen` promise resolves after cleanup and assert its unlisten function is called immediately.

- [ ] **Step 2: Run the focused component tests and verify RED**

Run:

```bash
rtk npm test -- --run src/features/statusPanel/StatusPanelView.test.tsx -t "toggle-panel|shortcut|unlisten"
```

Expected: FAIL because no toggle event is registered.

- [ ] **Step 3: Implement the shared functional toggle**

Implement:

```ts
function togglePanelOpen(wasHidden = false) {
  clearAutoCollapseTimer();
  if (wasHidden) {
    setView("panel");
    setPanelOpen(true);
    return;
  }
  setPanelOpen((current) => !current);
}
```

Change the title-bar button to call `togglePanelOpen()` rather than closing over `panelOpen`. In the existing mount-only effect, listen for `agent-session-inbox://toggle-panel`; use a `cancelled` flag so a late-resolving promise immediately invokes its unlisten callback, and call the saved callback during cleanup. A visible event leaves the management view alone, while a hidden event returns to the panel as specified.

- [ ] **Step 4: Run the focused component tests and existing panel tests**

Run:

```bash
rtk npm test -- --run src/features/statusPanel/StatusPanelView.test.tsx -t "toggle-panel|shortcut|unlisten"
rtk npm test -- --run src/features/statusPanel/StatusPanelView.test.tsx
```

Expected: the new event/timer tests and all existing expand/collapse, polling, menu, and resize tests pass. Stage only the event/state hunks from the two modified files with `git add -p`, inspect the staged patch, and commit:

```bash
rtk git add -p src/features/statusPanel/StatusPanelView.tsx src/features/statusPanel/StatusPanelView.test.tsx
rtk git diff --cached --check
rtk git commit -m "feat: bridge global shortcut to panel toggle"
```

### Task 6: Add recording controls, async apply, persistence, and localized errors

**Files:**
- Modify: `src/features/statusPanel/StatusPanelView.tsx:60-80,450-670,850-900,1240-1320`
- Modify: `src/features/statusPanel/StatusPanelView.test.tsx`
- Modify: `src/App.css`

**Interfaces:**
- Consumes `capturePanelShortcut`, `formatPanelShortcut`, `normalizePanelToggleShortcut`, `configurePanelShortcut`, and the config/copy fields from Tasks 1 and 4.
- Produces a settings control with record, clear, restore-default, and disabled states; a localized registration error; and a persisted successful `panelToggleShortcut`.

- [ ] **Step 1: Add failing management tests**

Add tests for these user-visible flows:

1. Open Settings, click Record, dispatch `Alt+Shift+Meta+Space`, and assert the displayed value becomes `Option-Shift-Command-Space` while recording stops.
2. Start recording, dispatch `Escape`, and assert the previous value remains.
3. Start recording and dispatch a modifier-only or repeated key; assert the recorder remains active and the value is unchanged.
4. Click Clear and assert `null` is saved after Apply; click Restore default and assert the canonical default is saved.
5. Change a display setting, make `configure_panel_shortcut` reject with a structured active snapshot, click Apply, and assert the display setting is persisted while the prior requested shortcut remains, the draft is retained, and the localized conflict/current-active messages are visible.
6. Resolve the command successfully and assert the error/mismatch disappear and the settings close. Also cover startup conflict, dismissal/reopen, uncertain restart status, and a visible shortcut while Settings is open.
7. Seed localStorage with a missing, malformed, and explicit `null` shortcut in separate mounts and assert default/default/disabled behavior.

Use the existing Tauri `invoke` mock and event-listener capture; do not add a second global keyboard listener to the test harness.

- [ ] **Step 2: Run the new management tests and verify RED**

Run:

```bash
rtk npm test -- --run src/features/statusPanel/StatusPanelView.test.tsx -t "shortcut settings|record|restore|conflict|malformed"
```

Expected: FAIL because the field, recorder, and apply path do not exist.

- [ ] **Step 3: Implement the recorder lifecycle**

Add `shortcutRecording` and `shortcutApplyPending` state. When recording is active, install a capture-phase `keydown` listener on `window`; ignore events whose target is an input/select/textarea or contenteditable element, call `preventDefault()` for recorder-owned events, use `capturePanelShortcut`, update `draftConfig.panelToggleShortcut` only for `captured`, and stop recording for `captured` or `cancelled`. Keep malformed/ignored combinations active without changing the draft.

Render a `.shortcut-settings` field with a read-only formatted requested/draft value, a Record button, a Clear button, and a Restore default button. Mark `null` as `Disabled`, expose recording state via `aria-live`, and add `role="alert"` for the registration error. Show the separately tracked known active value when it differs from the draft, or a restart-required status when uncertain. Put all shortcut controls under `data-no-window-drag` so they do not start panel dragging.

- [ ] **Step 4: Implement startup reconciliation and transactional Apply**

Update `normalizeConfig` to assign `panelToggleShortcut: normalizePanelToggleShortcut(value.panelToggleShortcut)`, then call `configurePanelShortcut(configRef.current.panelToggleShortcut)` once from the existing mount effect after the persisted config is loaded. Leave the saved value intact and show the localized error if registration fails. Do not register from a React render/effect other than this command call; Rust owns the native registration lifecycle.

Make `applyDraftConfig` async and disable its button while pending. Normalize the draft first, call `configurePanelShortcut(nextConfig.panelToggleShortcut)`, and then:

- on success, commit the returned `activeShortcut` together with all other normalized settings, update the separately tracked native active state, clear the shortcut error and mismatch, close Settings, recalculate `panelOpen`, and refresh sessions;
- on failure, commit all other normalized settings but retain `configRef.current.panelToggleShortcut` as the saved requested shortcut, keep Settings open, retain the attempted draft for editing/retry, and use the typed native error snapshot to display the known current-active value or a localized restart-required status when state is uncertain;
- clear a transient alert after a later successful apply or explicit dismissal/back navigation, while keeping current-active or uncertain status until success or process restart.

Startup reconciliation failure likewise keeps the saved requested shortcut intact and shows the native active snapshot (default or Disabled) in Settings. A failed clear caused by unregister failure leaves native state uncertain and must not be treated as success.

Do not let the existing `persistConfig` effect write the requested-but-unregistered value: only the committed `config` object may contain the saved shortcut.

- [ ] **Step 5: Add CSS for a stable, compact settings control**

Extend the existing settings styles with `.shortcut-settings`, `.shortcut-settings__value`, `.shortcut-settings__actions`, `.shortcut-settings__recording`, `.shortcut-settings__error`, and `.shortcut-settings__active`. Keep controls within the management panel width, use existing button/input colors, and avoid changing panel height constants or collapsed-strip geometry.

- [ ] **Step 6: Run management and full component tests**

Run:

```bash
rtk npm test -- --run src/features/statusPanel/StatusPanelView.test.tsx -t "shortcut settings|record|restore|conflict|malformed"
rtk npm test -- --run src/features/statusPanel/StatusPanelView.test.tsx
```

Expected: all recorder, persistence, conflict, event, and existing status-panel tests pass. Stage only the shortcut hunks in the three modified files with `git add -p`, inspect the staged patch, and commit:

```bash
rtk git add -p src/features/statusPanel/StatusPanelView.tsx src/features/statusPanel/StatusPanelView.test.tsx src/App.css
rtk git diff --cached --check
rtk git commit -m "feat: add panel shortcut settings and recording"
```

### Task 7: Run cross-layer verification and inspect the final diff

**Files:**
- Verify: all files listed above; no new unrelated files

**Interfaces:**
- Consumes the complete implementation from Tasks 1-6.
- Produces test/build evidence and a final diff whose scope matches the design spec.

- [ ] **Step 1: Run focused TypeScript and Rust suites**

Run:

```bash
rtk npm test -- --run src/features/statusPanel/panelShortcut.test.ts src/features/statusPanel/statusPanel.test.ts src/features/inbox/inboxApi.test.ts src/features/statusPanel/StatusPanelView.test.tsx
rtk cargo test --manifest-path src-tauri/Cargo.toml
```

Expected: all focused frontend tests and the complete native suite pass.

- [ ] **Step 2: Run the production frontend build**

Run:

```bash
rtk npm run build
```

Expected: TypeScript compilation and Vite production output succeed. Do not replace the installed application or add generated bundles to the feature commit.

- [ ] **Step 3: Check formatting, dependency/capability scope, and dirty-work preservation**

Run:

```bash
rtk git diff --check
rtk git status --short
rtk git diff -- src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/capabilities/default.json package.json
```

Confirm that only the pinned Rust dependency and lockfile changed in dependency metadata, `default.json` and `package.json` remain untouched, and pre-existing README/session/source changes remain unstaged or in their original commits. Review the final shortcut diff against `docs/superpowers/specs/2026-09-24-configurable-global-panel-shortcut-design.md` before handing it back.
