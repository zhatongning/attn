# Window Placement

Attn uses one floating panel window. It intentionally does not create one panel per display.

## macOS Desktop And Display Assignment

Use the macOS Dock menu to decide where the panel appears:

1. Right-click the Attn Dock icon.
2. Open `Options`.
3. Choose one of the macOS `Assign To` options.

Recommended behavior:

| Dock assignment | Result |
| --- | --- |
| `All Desktops` | The single panel follows Desktop/Space changes on the assigned display. |
| `Desktop ... on Display ...` | The panel is scoped to that specific Desktop/Display assignment. |
| `None` | macOS decides the normal window ownership behavior. |

Attn does not force `visibleOnAllWorkspaces`.
That is deliberate: macOS should own Space and Display assignment so the panel follows the user's Dock configuration.

## Panel Position

The panel can be moved in two ways:

- Drag the panel header to place it manually. The position is persisted locally.
- Use the macOS app menu `Attn -> Position` to snap the panel to a corner of its current display.

The app-menu position commands move only the single main panel window.
They do not create or move secondary display replicas.
