# Structured User Input Attention

## Goal

Show an exact `attention` state only when a Codex session is genuinely waiting
for a structured user-input response. Do not infer this state from assistant
prose.

## Scope

The JSONL source parser will recognize a `response_item` with:

- `payload.type = "function_call"`
- `payload.name = "request_user_input"`

It records the call id, timestamp, and a concise evidence summary as a pending
input request. At end of file, an unresolved pending request maps to
`ObservationKind::WaitingForInput`.

Any matching `function_call_output` clears the pending request. This includes a
user answer, cancellation, or an unavailable-tool response. A `turn_aborted`
event also clears it and retains the existing stopped classification.

## Non-Goals

- Do not match natural-language confirmation wording.
- Do not change the existing elevated tool-approval detection.
- Do not change the 12-hour unread completion, acknowledgement, Pin, or
  subagent roll-up behavior.

## Data Flow

```text
request_user_input function_call
  -> pending structured-input request
  -> end of JSONL without matching output: WaitingForInput / attention
  -> matching function_call_output or turn_aborted: clear pending state
```

Only an unresolved request is actionable. A failed call in Default mode emits a
`function_call_output` and must remain non-actionable.

## Tests

Add parser-level regression coverage for:

1. Unresolved `request_user_input` becomes `WaitingForInput`.
2. A matching answer output clears the pending state.
3. An `unavailable` output clears the pending state.
4. `turn_aborted` clears the pending state.

Existing tool-approval tests remain unchanged to verify both state machines
continue to work.

## Documentation

Update `docs/status-flow.md` to distinguish exact structured input requests
from the still-unimplemented natural-language confirmation heuristic.
