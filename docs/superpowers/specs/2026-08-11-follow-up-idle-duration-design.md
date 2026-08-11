# Configurable Follow-up Idle Duration

## Goal

Let a user choose how long a read follow-up remains visible before becoming
quiet `idle`. The default remains 30 minutes; the minimum is 20 minutes; there
is no maximum.

## Decision

Add a whole-minute `followUpToIdleMinutes` setting to the existing management
view and `StatusPanelConfig`.

- Default: `30`.
- Minimum: `20`.
- Maximum: none.
- Invalid or non-finite stored values fall back to the default. Values below
  20 normalize to 20.
- The setting stays in the existing `attn.statusPanelConfig` local storage
  record, so it survives application restarts and old records receive the
  default automatically.

Applying the setting refreshes session rows immediately. The backend also
validates the value because the browser-facing configuration is an input to a
native command.

## Scope

The duration applies consistently to both read-driven follow-up paths:

1. A successful `Jump back` acknowledgement, recorded in
   `acknowledged-signals.json`.
2. A Codex Desktop thread whose SQLite `updated_at_ms` advances after its
   `task_complete` event.

It does not change the 12-hour unread-completion retention window, the
5-minute immediate-completion window, or stale CLI input handling.

## Data Flow

```text
Settings input -> normalized local configuration -> list/jump native calls
  -> validated follow-up duration -> source classification and acknowledgement
  -> follow-up while inside the configured window, idle after it expires
```

The session-row cache must distinguish duration values so applying a new value
cannot return rows calculated with the old one. The development-source mirror
uses the same duration contract so preview and native behavior stay aligned.

## Verification

Add regression coverage for:

1. Default configuration uses 30 minutes.
2. Stored values below 20 normalize to 20, without imposing an upper bound.
3. Management Apply persists the setting and refreshes the session list with
   it.
4. Both native follow-up paths remain `follow-up` at the configured boundary
   and become `idle` after it.
5. The development-source mirror follows the same configured boundary.

Update `docs/status-flow.md` so its read-window descriptions state that the
duration is configurable and defaults to 30 minutes.
