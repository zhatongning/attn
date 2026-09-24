# Configurable Global Panel Shortcut Design

Date: 2026-09-24

## Goal

Let users configure a keyboard shortcut that toggles the whole Attn panel
between its expanded content view and the 50 px status strip, even when
another application currently has focus.

This shortcut targets the existing title-bar `+`/`-` behavior. It does not
expand the separate list of hidden session rows.

## Confirmed behavior

- The shortcut is global and may fire while Attn is not focused.
- The default is `Alt+Shift+Command+Space`, displayed as `Option-Shift-Command-Space` or the platform-equivalent symbols.
- The settings view records a real key combination instead of accepting free-form text.
- Settings provide record, clear (disable), and restore-default actions.
- When Attn is visible, a shortcut press toggles the existing `panelOpen` state,
  cancels any pending automatic collapse, and lets the existing React resize
  effect choose the window height. If Settings is open, it stays open and keeps
  its draft; Back reveals the newly toggled panel state.
- When Attn is hidden, the native handler shows the window and asks React to
  expand it. It must not focus or activate Attn, so the user's current app is
  not interrupted.
- A key press produces one toggle. The release event is ignored.
- A registration conflict never silently substitutes another shortcut. The
  saved requested shortcut remains unchanged; Settings reports the known
  currently active shortcut (including Disabled) separately from the request.
- If native unregistration fails, the active state is uncertain for the rest
  of the process. Settings requires a restart and does not claim an active key.
- Setting `clear` disables the global shortcut. Missing shortcut data in an
  older local-storage record normalizes to the default.

## Architecture

### Configuration and recording

Extend `StatusPanelConfig` with:

```ts
panelToggleShortcut: string | null
```

The value is a canonical Tauri/global-hotkey accelerator string. `null`
represents a disabled shortcut. The existing `attn.statusPanelConfig`
local-storage record remains the source of persistence; `normalizeConfig`
supplies the default for missing or malformed values.

The settings UI owns a short recording state. While recording, it captures
`KeyboardEvent.code` plus the active modifiers, requires at least one of Alt,
Control, or Command (Shift may supplement), supports only F1-F20, prevents
the browser default, and lets Escape
cancel without changing the saved value. The recorder converts the result to
the canonical accelerator string and separately renders a user-facing label.
The recorder is not active while ordinary text/select controls are being used.

### Rust registration owner

Add the Tauri global-shortcut Rust plugin at the same major/minor line as the
existing Tauri 2.0 dependencies. The Rust side owns one registered shortcut
and a mutex-protected `Known(active)` or `Uncertain` registration state.

At application setup, register the default on a best-effort basis so the
shortcut is available as soon as the desktop process starts. A registration
failure must be logged and must not abort application startup. After React
loads the persisted config, it calls the configuration command to reconcile
the startup default with the user's saved value (including disabling it).

Expose a custom `configure_panel_shortcut` command for changes from Settings.
The command accepts `Option<String>` and applies an update transactionally:

1. Validate and parse the requested accelerator.
2. If it is unchanged, return success without touching the registration.
3. Register a new value before removing the old value.
4. If removing the old value fails, mark state `Uncertain`, attempt to
   unregister the new value, and reject all subsequent configuration calls
   until process restart. The pinned macOS registrar removes its internal
   pointer before reporting an unregister failure, so the old value cannot
   be claimed as active.
5. For `None`, unregister the old value and leave the manager empty only on
   success; failure likewise marks state `Uncertain`.

The command returns the active shortcut on success. On failure it serializes
`{ code, activeShortcut, stateUncertain }` while holding the state lock. Codes
are `invalid_shortcut`, `registration_failed`, `registration_uncertain`, and
`rollback_failed`; an uncertain state has `activeShortcut: null`. Raw platform
error text is not part of the UI contract.

The plugin handler responds only to `Pressed`. It checks whether the main
window was visible, calls `show()` when it was hidden, and emits
`agent-session-inbox://toggle-panel` with a flag indicating whether the
window had been hidden. It never calls `set_focus`.

Because registration and event handling stay in Rust, the React component
lifecycle and StrictMode do not create duplicate native registrations. The
implementation uses the Rust plugin API rather than the JavaScript guest
bindings, so no global-shortcut IPC permissions or JS dependency are needed.

### React event bridge and panel state

`StatusPanelView` listens for the new event in its existing mount-only native
event effect and removes the listener on unmount. The event handler funnels
through one state transition helper shared by the title-bar button and the
shortcut:

- clear the automatic-collapse timer;
- if the event says the window was hidden, switch back from Settings to the
  panel view and set `panelOpen` to `true`;
- otherwise use a functional state update to invert `panelOpen`.

The existing `panelOpen` resize effect remains the only code that chooses the
native window height. Rust never resizes the window and never owns the React
panel state.

Applying Settings first attempts the native shortcut update. A failed update
does not discard other valid display settings, but the saved shortcut field
stays at the prior requested value and the attempted draft remains available.
Startup reconciliation failure also leaves the persisted requested value
intact. Settings compares the request or draft with the known native active
value and displays that value explicitly when different. Dismissing an alert
does not erase this status. If native state is uncertain, Settings shows a
localized restart-required status instead. Successful registration clears
the mismatch and alert. Applying a clear operation succeeds only after the
old registration is removed.

## Failure and compatibility rules

- Browser/Vite preview has no global shortcut manager; the API wrapper is a
  no-op there, while component tests can still exercise recording and event
  behavior with mocks.
- Invalid persisted values normalize to the default; an explicit `null`
  remains disabled.
- Shift-only accelerators and F21-F24 are invalid in persisted data, the
  recorder, and the native command; malformed persisted values use the default.
- A shortcut already owned by macOS or another application is reported as a
  registration failure. The app does not probe or alter other applications'
  shortcuts.
- The default deliberately avoids common system combinations such as
  `Command-Space`, `Option-Command-Space`, and `Control-Command-Space`.
- Showing a hidden window is best effort. A show failure is surfaced as a
  native log entry, while the event is still emitted so a later visible state
  can reconcile normally.
- No tray, accessibility permission flow, focus-stealing behavior, or second
  shortcut for hidden-row expansion is included in this change.

## Verification

Add focused coverage for:

1. Default, missing, null, malformed, and normalized shortcut configuration.
2. Recording a valid combination, cancelling with Escape, rejecting invalid
   combinations, clearing, and restoring the default.
3. Applying a shortcut persists it and invokes the native command; a mocked
   registration conflict preserves the previous value while applying other
   settings.
4. A `toggle-panel` event toggles the same state as the `+`/`-` button, clears
   an auto-collapse timer, and handles the hidden-window flag by showing the
   panel without calling `set_focus`.
5. Event listeners and pending registration work are cleaned up on unmount.
6. Rust helper/command tests cover parser rejection, register-before-unregister
   ordering, poisoning and rollback attempts after an unregister failure,
   structured error snapshots, and the `Pressed`-only handler rule.
7. Startup and Apply conflicts show requested versus known active values;
   dismissal preserves a mismatch or restart status, and success clears it.
8. A visible shortcut in Settings keeps its draft and view, while Back reveals
   the toggled underlying panel state.

Run the focused frontend tests, the full frontend suite, Rust tests, the
production build, and `git diff --check`. Do not rebuild or replace the
installed Attn application as part of this code change.

## Scope boundary

This feature changes only the panel toggle path, its Settings controls, and
the native shortcut registration bridge. It does not change session
classification, polling, status-row ordering, panel placement, or the meaning
of the existing `expanded` hidden-row state.
