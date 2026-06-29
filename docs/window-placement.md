# Window Placement

Attn uses one floating panel window. It intentionally does not create one panel per display.

## macOS Desktop And Display Behavior

Attn configures the panel as visible on all macOS Spaces.
The panel is a single window, not one replica per Desktop or Display.

The macOS Dock `Options -> Assign To` menu may still show an assignment, but the panel window itself explicitly joins all Spaces so switching Desktops keeps it visible.

Recommended behavior:

| Scenario | Result |
| --- | --- |
| Switch Desktop/Space | The same panel remains visible. |
| Multiple displays | Attn keeps one panel window; it does not create display-specific replicas. |
| Use Dock `Assign To` | macOS can record the Dock assignment, but Attn still asks the panel window to join all Spaces. |

## Panel Position

The panel can be moved in two ways:

- Drag the panel header to place it manually. The position is persisted locally.
- Use the macOS app menu `Attn -> Position` to snap the panel to a corner of its current display.

The app-menu position commands move only the single main panel window.
They do not create or move secondary display replicas.
