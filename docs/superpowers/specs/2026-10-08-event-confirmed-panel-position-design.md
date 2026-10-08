# Event-Confirmed Panel Position Cycling

Date: 2026-10-08

## Intent and scope

One configurable global shortcut moves Attn's **single** panel clockwise:
top-left → top-right → bottom-right → bottom-left → top-left. It works while
another application has focus. Each separate press advances one corner; repeated
`Pressed` events during a held key do not advance, and no time-based debounce
discards deliberate quick presses. The default candidate is
`Control-Shift-Command-Space`; registration, not a list of popular applications,
ultimately determines availability. Settings can record, clear, and restore this
shortcut independently of the existing expand/collapse shortcut.

The position shortcut moves a hidden panel without showing or activating Attn.
The first press after a manual drag advances from the nearest corner of the
panel's current display. A snapped bottom corner remains attached when the panel
switches among its 50 px strip, content height, and Settings height. Restart
restores a saved display position before reapplying the corner when that display
is still present; a missing display falls back to the available monitor rather
than leaving the window off-screen. Existing app-menu corner commands remain.

This design does not add a separate panel for each display, a position animation,
or four independent position shortcuts. It does not change the existing
expand/collapse behavior.

## Why the current work-in-progress cannot ship

The working tree contains an uncommitted first implementation of the UI,
shortcut registration, and placement. It passes unit suites but must be
replaced at the native placement seam before delivery. In pinned Tao 0.30.8,
`set_outer_position` schedules `setFrameTopLeftPoint` asynchronously, and
`set_inner_size` schedules `setContentSize` asynchronously. Tauri's setter
return does not establish that the macOS window moved or resized. Reading
`outer_position` immediately afterward can return the old frame, so publishing
that value as a confirmed corner is false. The old global-toggle deadlock also
rules out emitting WebView events from inside a `with_webview` callback.

## Chosen module and interface

A native **PanelPlacement** module owns the desired corner, the latest observed
physical frame, pending move/resize intents, and their monotonically increasing
generation. It is the only module that decides whether a move is confirmed or
manual. The small interface used by the shortcut, menu, and React is:

- `cycle()` and `snap(corner)` submit placement intents. They return acceptance,
  not a claim that the OS has completed movement.
- `resize(height)` submits the desired panel height. React no longer treats
  `setSize()` completion as a positioning barrier.
- `restore(savedPlacement)` supplies legacy position data only when native
  placement storage has no record. The module restores the display location
  before requesting a corner.
- `beginDrag()` marks a manual drag intent and initiates the existing native
  window drag in one command. It does not infer drag completion from
  `startDragging()` returning or from a DOM `pointerup`, either of which can
  precede the actual move or be absent.
- `placement-confirmed` publishes a generation, corner (or `null` after a
  manual move), and **observed** physical position and size. A distinct failure
  result reports unavailable monitor, dispatch failure, or unconfirmed timeout.

The module registers one listener for the main window's native `Moved` and
`Resized` events. The existing monitor/corner geometry is reused and expressed
in physical coordinates for matching observations, including negative monitor
origins and display scale factors. React owns display settings and shortcut
recording, not window-move classification. Native placement storage owns the
last confirmed corner and physical location; it writes atomically after
confirmation. `attn.panelPosition` is read once as a migration source when the
native record is absent, while `attn.statusPanelConfig` remains the source for
both shortcut preferences.

The native record is versioned (`version: 1`) at
`app_config_dir/placement.json` and contains the last confirmed physical
position and nullable corner. It is written through a temporary file in that
directory followed by an atomic rename. When the saved location is no longer
inside an available display, restoration chooses the current monitor, then
the primary monitor; if neither exists it reports an unavailable display and
does not claim a corner.

## State and event rules

| Input | Native state transition | Observable result |
| --- | --- | --- |
| Position `Pressed` while visible or hidden | Advance from the most recent **desired** corner if placement is pending; otherwise from the confirmed/nearest observed corner. Increment generation and request the target. | No focus, show, or immediate success event. |
| Repeated `Pressed` without `Released` | Keep the held-key latch set. | No additional step. |
| App-menu corner | Submit an explicit `snap` through the same module. | Confirmed event only after observation. |
| `Moved` matching a pending target | Mark the matching generation observed. If a newer target exists, continue toward it; otherwise confirm and persist it. | Publish only the latest confirmed target. |
| `Moved` from an active manual drag or otherwise unmatched after pending work settles | Clear the corner, update the observed display/position, and persist the free position. | No snap-back on the next resize; the next cycle uses its nearest corner. |
| Actual `Resized` event | Update observed dimensions. If corner-anchored, recompute the target from the **new observed height** and request a move if needed. | Bottom edge remains attached only after its move is observed. |
| Request already at observed target with no older pending move | Confirm without waiting for a `Moved` event that may never occur. | No stuck no-op operation. |

Native setters may queue AppKit work after returning. The module records an
intent **before** calling them; a setter return never completes the intent.
Delayed observations for superseded generations do not overwrite a newer
desired corner or persisted position. On an observation of a superseded target,
the module reasserts the latest intent if necessary. Matching uses a physical
tolerance of at most **2 px per axis** solely for OS rounding; it must not turn
an arbitrary manual location into a confirmed corner. State is updated under
its own lock, but window setters and WebView events execute after releasing
that lock and returning from the native window-event callback. Its pure
transition returns effects for a separate executor to dispatch; it does not
recursively call a Tauri setter from inside `Moved`/`Resized`. The global hotkey
callback never blocks the main thread waiting for a native event.
If a hidden window has no current monitor, the last confirmed monitor frame
may supply its placement geometry; if that display is gone, the normal fallback
applies without making the window visible.

A manual drag intent takes precedence over an older pending programmatic move.
If the header is only clicked and the window does not move, the saved anchor
remains. Starting a new explicit position command ends a no-movement drag
intent without relying on `pointerup`. If a stale programmatic move lands after
a manual move, it is recognized by its pending target and cannot persist as a
manual destination; the latest intent is reapplied to converge. This ordering
must be tested with adversarial event sequences, not assumed from callback
timing.

No display, rejected setter, or absent native confirmation may be reported as
success. After **3 seconds** without the expected native event, a watchdog
reports the generation as unconfirmed in Settings and logs it; this is not a
keypress debounce. The desired target remains available for reconciliation
if the native event arrives later or the next position request retries it,
while the previously confirmed placement remains recoverable. Timeout never
persists the desired target as a confirmed position.

## Startup, configuration, and persistence

1. Native setup keeps the existing expand/collapse default. It does **not**
   pre-register the new position default ahead of a saved custom toggle.
2. React loads the existing shortcut config and serially reconciles the saved
   toggle, then the saved position key. The native registrar rejects duplicate
   bindings and preserves the other active shortcut on conflict. An uncertain
   unregister state retains the existing restart-required behavior.
3. React subscribes to placement events before it requests restoration. The
   native placement record, if present, has priority; otherwise a one-time
   legacy `attn.panelPosition` value and any saved corner are supplied. A
   restoration command is idempotent under StrictMode remount.
4. Native storage records each observed free-position `Moved` event during a
   manual drag; the latest event supersedes earlier ones. A snapped position is
   stored only after the latest target is confirmed through `Moved`/`Resized`
   (or a verified no-op), not at an intermediate resize before bottom-edge
   repositioning. An event sent to a hidden WebView is not the sole means of
   retaining position through process exit. Failure to write storage is
   surfaced as a persistence error without reverting an already confirmed
   on-screen move.

## Verification and delivery boundary

The pure placement state machine is exercised through the same interface as
production with an adapter that returns from `setPosition`/`setSize` **before**
delivering `Moved`/`Resized`. Tests cover four-step cycles, quick presses,
held-key repeat suppression, out-of-order and missing events, no-op targets,
manual click versus delayed drag, stale programmatic moves, mixed-scale and
offset monitors, bottom anchoring after actual resize, restart/missing-display
fallback, hidden movement without activation, and old-toggle-key priority.
Frontend tests cover independent configuration, conflicts, migration and
confirmed-state display. The complete Rust and frontend suites, TypeScript
build, native `cargo check`, and diff scope must pass.

Packaged macOS testing must then demonstrate actual single/rapid/held
keystrokes, four corners, drag followed by a press, hide without focus theft,
bottom-edge attachment across panel heights, and restart on the same display.
A browser preview or mocked setter is not evidence for these OS behaviors.
The current uncommitted build is not to be installed. Replacing
`/Applications/Attn.app` requires a separate explicit delivery decision and a
recoverable backup.
