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

The panel can be moved in three ways:

- Drag the panel header to place it manually. Clicking the header without moving
  keeps the existing anchor. A delayed native move confirms a free position;
  releasing the mouse or returning from the drag command does not confirm it.
- Use the macOS app menu `Attn -> Position` to snap the panel to a corner of its current display.
- Use the global position shortcut (default `Control-Shift-Command-Space`) to move clockwise:
  top-left → top-right → bottom-right → bottom-left → top-left. It is configurable
  or disableable in Settings independently of the panel expand/collapse shortcut.
  Each press moves one corner; holding the keys does not repeatedly advance.

The app-menu position commands move only the single main panel window.
They do not create or move secondary display replicas.
The global position shortcut also moves only that window. It does not reveal or
focus Attn when the window is hidden. After a manual drag, the next press starts
from the nearest corner of the panel's current display. A corner-snapped panel
stays anchored after its actual native resize and reposition are observed. This
includes the 50 px strip, content height, and Settings height. React submits a
logical height; the native adapter converts it to physical pixels once.

Native placement owns the last confirmed physical location and nullable corner
in a versioned `placement.json` record in the app configuration directory. It
saves atomically after confirmation, including manual moves while hidden. On
restart that record has priority. React reads old `attn.panelPosition` and
`attn.panelCorner` values once as migration candidates and does not write either
key. Native restoration first restores the display position, then requests the
corner. If the saved display is absent, it uses the current or primary display.

Settings shows only the latest native `placement-confirmed` corner or free
position. All three placement listeners are ready before restore is requested.
Command completion reports acceptance; it does not prove a macOS window setter
finished. Older generations cannot replace a newer confirmed state. A missing
display, rejected dispatch, or three-second confirmation timeout produces an
unconfirmed warning while retaining the previous confirmed position. A storage
failure produces a separate warning and does not undo a confirmed on-screen
move. These warnings remain available when Settings is reopened.

The position shortcut and placement event handling do not show or activate a
hidden panel. `panelMode` still controls auto-collapse versus persistent display,
and expanding the panel still controls the shown rows; neither option denotes
whether native placement has been confirmed.

The automated native state-machine and frontend tests verify event ordering and
these contracts. Browser preview performs no native placement and displays an
unknown position. Unit tests and a successful build do not establish packaged
macOS behavior: actual rapid/held shortcuts, hidden focus, bottom anchoring,
manual dragging, and display restoration still require a packaged run.
