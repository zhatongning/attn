# Event-Confirmed Panel Position Cycling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Attn one configurable global shortcut that cycles its single panel clockwise through four corners without guessing that an asynchronous macOS move or resize has completed.

**Architecture:** A native `PanelPlacement` module owns desired versus observed window geometry, move generations, drag provenance, and durable confirmed placement. The shortcut, menu, and React submit intents through its small interface; native `Moved`/`Resized` events confirm results, while React owns only shortcut settings, panel content, and legacy-position migration.

**Tech Stack:** Rust 2021, Tauri `=2.0.0`, Tao `0.30.8`, `tauri-plugin-global-shortcut = "=2.0.0"`, `serde_json`, existing `tempfile = "=3.14.0"`, React 19, TypeScript, Vitest, macOS AppKit.

**Spec:** `docs/superpowers/specs/2026-10-08-event-confirmed-panel-position-design.md`

## Global Constraints

- Position sequence: top-left → top-right → bottom-right → bottom-left → top-left; one step per separate `Pressed`, ignore held repeats until `Released`, with **no time-based keypress debounce**.
- Position default candidate: `shift+control+super+space` (`Control-Shift-Command-Space`); preserve the existing `shift+alt+super+space` expand/collapse binding and prefer any saved custom toggle over the new position default.
- Position shortcut is global and independently recordable, clearable, and restorable. A conflict preserves the other active binding and reports the native active value. Preserve the existing uncertain-unregister/restart-required behavior.
- A position action never calls `show`, `unhide`, or `set_focus`; hidden-window movement cannot activate Attn.
- Match a target to an observed physical frame within at most **2 px per axis**. A Tauri setter returning is only acceptance; only actual `Moved`/`Resized` (or a verified no-op without an older pending move) confirms placement.
- After **3 seconds** without confirmation, surface an unconfirmed status but do not persist the desired corner; a late valid event can reconcile it.
- Place the versioned native record at `app_config_dir/placement.json` with a same-directory temporary file and atomic rename. Native storage wins over legacy `attn.panelPosition`; when native storage is absent, migrate the legacy physical location once.
- Preserve the single main window and existing app-menu four-corner actions. After a manual drag, derive the next corner from the nearest corner of the observed display. Bottom anchors use the **observed** new height after resize.
- Never emit a WebView event from inside `with_webview` or while holding the placement state lock or a native window-event callback. Dispatch effects on a separate serialized executor; never synchronously wait for a window event on the main thread.
- Current `master` is a continuation branch. Preserve the unrelated untracked `main-BIHCWhv-.js`; the 11 tracked placement/shortcut files are uncommitted WIP, **not** a proven starting implementation. Replace unsafe immediate-read paths without resetting or staging unrelated work.
- Prefix terminal commands with `rtk`. Do not install or replace `/Applications/Attn.app` as part of this plan; an app-only bundle can be built for inspection, but runtime testing that interrupts the installed app and final replacement need a separate explicit delivery decision.

## Review Focus

- A setter returns while the frame is still old: it must not confirm, emit, or persist the target until the delayed native event. Exercise this in Task 1 and Task 2.
- Four fast taps, stale `Moved` events, and a held key: count distinct presses from the latest desired corner, but only confirm the newest observed target. Exercise this in Task 1 and Task 4.
- A header click without movement, a delayed manual `Moved`, and a stale programmatic move after a drag: only actual free movement clears the anchor; stale work cannot overwrite it. Exercise this in Task 1 and Task 2.
- A missing external display or fractional scale factor: restore onto an available monitor and classify a 2 px rounded target as snapped while a 3 px offset is not. Exercise this in Task 1 and Task 3.
- Corrupt or unwritable native placement storage: do not crash, overwrite the corrupt file silently, or claim persistence; leave the confirmed on-screen placement intact and expose the error. Exercise this in Task 3 and Task 5.

---

## File map and ownership

- Create `src-tauri/src/panel_placement/state.rs`: pure corner geometry and placement transition logic; unit tests live alongside it.
- Create `src-tauri/src/panel_placement/adapter.rs`: serialized Tauri effect executor, main-window `Moved`/`Resized` observation, IPC commands, and the test fake for delayed setters.
- Create `src-tauri/src/panel_placement/store.rs`: versioned native placement persistence, corruption handling, and migration tests.
- Create `src-tauri/src/panel_placement/mod.rs`: the small external interface consumed by `lib.rs` and `panel_shortcut.rs`; do not expose reducer internals to React.
- Modify `src-tauri/src/lib.rs`: remove the WIP's direct corner move/instant-coordinate acknowledgement, route menu through `PanelPlacement`, register the window observer, and register placement IPC commands.
- Modify `src-tauri/src/panel_shortcut.rs`: preserve the composite toggle/position registrar and pressed/held rules, but route the position handler through `PanelPlacement::cycle()`.
- Modify `src/features/inbox/inboxApi.ts` and its tests: replace instant `anchor_panel_position` semantics with intent and confirmed-state commands/events; keep independent shortcut configuration wrappers.
- Modify `src/features/statusPanel/StatusPanelView.tsx` and its tests: keep WIP recording/config UI but remove physical-coordinate guesses, raw position persistence, and `setSize`-return anchoring. Subscribe before restore and use confirmed placement only.
- Modify `src/features/statusPanel/statusPanel.ts`, `panelShortcut.ts`, and their tests only as needed to finish the already-started independent position-shortcut contract without changing `panelOpen`.
- Modify `docs/window-placement.md` after native/React behavior matches this spec. Do not edit session classification or the user's untracked file.

### Task 1: Build the pure placement state machine

**Files:**
- Create: `src-tauri/src/panel_placement/state.rs`
- Create: `src-tauri/src/panel_placement/mod.rs`
- Modify: `src-tauri/src/lib.rs` (only the module declaration; retain the old WIP geometry temporarily so Task 1 compiles, and remove it when Task 2 rewires its callers)

**Interfaces:**
- Produces `Corner::{TopLeft,TopRight,BottomRight,BottomLeft}`, `PhysicalFrame { x:i32, y:i32, width:u32, height:u32 }`, and `DisplayFrame { x:i32, y:i32, width:u32, height:u32, scale_factor:f64 }`.
- Produces `PlacementSnapshot { generation:u64, corner:Option<Corner>, frame:PhysicalFrame }`.
- Produces `PlacementInput::{CyclePressed,CycleReleased,Snap(Corner),ResizeRequested(u32),BeginDrag,Moved { x:i32,y:i32 },Resized { width:u32,height:u32 },TimedOut(u64)}`.
- Produces `PlacementEffect::{SetPosition { generation:u64,x:i32,y:i32 },SetHeight { generation:u64,height:u32 },Confirm(PlacementSnapshot),Persist(PlacementSnapshot),ReportUnconfirmed(u64),ScheduleWatchdog(u64)}`.
- Produces `PlacementMachine::new(observed:PhysicalFrame, saved:Option<PlacementSnapshot>)` and `reduce(&mut self, input:PlacementInput, displays:&[DisplayFrame]) -> Vec<PlacementEffect>`. Callers must treat effects as requests, not OS confirmation.

- [ ] **Step 1: Write RED tests against the public reducer seam**

In `state.rs`, use literal frames, not the implementation's geometry helper, to assert outcomes:

```rust
let displays = [DisplayFrame { x: 0, y: 0, width: 1920, height: 1080, scale_factor: 1.0 }];
let frame = PhysicalFrame { x: 16, y: 16, width: 420, height: 50 };
let mut machine = PlacementMachine::new(frame, None);
assert!(machine.reduce(PlacementInput::CyclePressed, &displays).contains(
    &PlacementEffect::SetPosition { generation: 1, x: 1484, y: 16 }
));
assert!(machine.confirmed().is_none());
assert!(!machine.reduce(PlacementInput::CyclePressed, &displays).iter()
    .any(|effect| matches!(effect, PlacementEffect::SetPosition { .. })));
machine.reduce(PlacementInput::CycleReleased, &displays);
assert!(machine.reduce(PlacementInput::CyclePressed, &displays).contains(
    &PlacementEffect::SetPosition { generation: 2, x: 1484, y: 1014 }
));
assert!(!machine.reduce(PlacementInput::Moved { x: 1484, y: 16 }, &displays)
    .iter().any(|effect| matches!(effect, PlacementEffect::Confirm(_))));
assert!(machine.reduce(PlacementInput::Moved { x: 1484, y: 1014 }, &displays)
    .iter().any(|effect| matches!(effect, PlacementEffect::Confirm(snapshot)
        if snapshot.generation == 2 && snapshot.corner == Some(Corner::BottomRight))));
```

Add separate literal tests for `BeginDrag` followed by no `Moved`, a delayed free `Moved` after a drag, a stale target event after that drag, actual `Resized { width:420,height:252 }` moving a bottom anchor to `y = 812`, negative monitor origin, a 2 px versus 3 px target mismatch, a removed external display, and `TimedOut(2)` preserving the last confirmed snapshot.

- [ ] **Step 2: Run RED**

Run `rtk cargo test --manifest-path src-tauri/Cargo.toml panel_placement::state::tests`. Expect compile/test failure for the missing module and reducer interface, not an unrelated Rust dependency error.

- [ ] **Step 3: Implement the smallest state transition**

Keep physical geometry and intent tracking in this one module. For a 1× monitor, compute right `x = monitor.x + monitor.width - frame.width - 16` and bottom `y = monitor.y + monitor.height - frame.height - 16`; convert the 16 logical-pixel margin with `round(16.0 * scale_factor)` for other displays. Use the display containing the observed frame center, else current/primary fallback provided by the adapter. The essential Pressed branch is:

```rust
if self.held { return Vec::new(); }
self.held = true;
let base = self.desired_corner.or(self.confirmed_corner)
    .unwrap_or_else(|| nearest_corner(self.observed, displays));
let target = base.next_clockwise();
self.desired_corner = Some(target);
self.generation += 1;
let requested = target_for(self.generation, target, self.observed, displays);
self.pending.push_back(requested);
vec![
    PlacementEffect::SetPosition {
        generation: self.generation, x: requested.x, y: requested.y,
    },
    PlacementEffect::ScheduleWatchdog(self.generation),
]
```

Make the internal target returned by `target_for` `Copy` so the queued value and request coordinates match. Keep past generation targets until their delayed `Moved` is classified. `Moved` confirms only the current desired generation; a superseded target schedules reassertion, not persistence. `Resized` uses its observed height before calculating a bottom target. An already-observed target confirms immediately only when no older movement is pending.

- [ ] **Step 4: Run GREEN and negative mutation checks**

Run `rtk cargo test --manifest-path src-tauri/Cargo.toml panel_placement::state::tests`. Then temporarily reverse the expected delayed-event order in a local test edit and verify that its test fails; restore the test with `apply_patch` and rerun GREEN. No test artifact may remain in the diff.

- [ ] **Step 5: Commit only this module's files and exact `lib.rs` hunk**

Use `rtk git diff --check`, stage `state.rs`, `mod.rs`, and only the module-declaration/geometry hunk of `lib.rs`; commit `feat: model confirmed panel placement transitions`. Do not stage the rest of the existing WIP in `lib.rs`.

### Task 2: Adapt native window events without reentrant setters

**Files:**
- Create: `src-tauri/src/panel_placement/adapter.rs`
- Modify: `src-tauri/src/panel_placement/mod.rs`
- Modify: `src-tauri/src/lib.rs` (setup/menu/command routing)
- Modify: `src-tauri/src/panel_shortcut.rs` (position handler only)

**Interfaces:**
- Consumes `PlacementMachine::reduce`, `PlacementInput`, `PlacementEffect`, `Corner`, and `PhysicalFrame` from Task 1.
- Produces `PanelPlacement::on_position_shortcut(state: ShortcutState)`, `snap(corner)`, `resize(height)`, `restore(legacy)`, `begin_drag()`, and `on_window_event(&tauri::WindowEvent)`. Both Pressed and Released reach the placement module; it owns the sole held-key latch. These methods accept intents and never return “arrived” from a setter result.
- Produces Tauri commands `resize_panel(height:u32)`, `restore_panel_placement(legacy:Option<LegacyPlacement>)`, and `begin_panel_drag()`. Menu corner IDs and the position shortcut call the same module.
- Keeps `PanelPlacement` state locked only for reducer transitions. A serialized executor performs returned `SetPosition`/`SetHeight` and `emit_to` effects after the lock **and** native event callback have returned.

- [ ] **Step 1: Write a deferred-adapter RED test**

Build a test adapter whose setters record calls but never mutate its frame; call `placement.on_position_shortcut(ShortcutState::Pressed)` and assert there is no `placement-confirmed`, `Persist`, or updated confirmed snapshot. Then inject `placement.on_window_event(&WindowEvent::Moved(PhysicalPosition::new(1484, 16)))` and assert exactly one generation-1 confirmation with the event's coordinates. Add a reverse-order test: two presses with a release between, deliver generation 1's move after generation 2 was requested, then deliver generation 2; only generation 2 may confirm. Model `setSize()` returning while the old height remains and inject `Resized` later; a bottom re-anchor must use the new observed height.

```rust
placement.on_position_shortcut(ShortcutState::Pressed).unwrap();
assert_eq!(fake_window.requested_positions(), vec![(1484, 16)]);
assert!(fake_events.confirmed().is_empty());
fake_window.deliver_moved(1484, 16);
assert_eq!(fake_events.confirmed()[0].generation, 1);
assert_eq!(fake_events.confirmed()[0].frame.x, 1484);
```

Test `begin_drag()` with no movement (anchor retained), followed by a delayed unmatched `Moved` (anchor cleared), and a stale programmatic `Moved` after manual movement (manual location is not overwritten). Test hidden state by asserting the adapter records no `show`, `unhide`, or `set_focus` operation.

- [ ] **Step 2: Run RED**

Run `rtk cargo test --manifest-path src-tauri/Cargo.toml panel_placement::adapter::tests`. Expect failure for the missing adapter/observer, not a Tauri fixture panic.

- [ ] **Step 3: Wire one native observation stream**

Register `main.on_window_event` once in `lib.rs`, feeding only `WindowEvent::Moved(position)` and `WindowEvent::Resized(size)` to `PanelPlacement`. Route existing menu IDs through `snap(Corner)` and both `Pressed` and `Released` from the WIP position hotkey through `on_position_shortcut`; remove its redundant atomic latch. Replace direct `window.set_position(...); window.outer_position()` acknowledgements and `anchor_panel_position` with accepted intents. Dispatch effects by FIFO channel on a worker so the event callback does not recursively call a setter; capture generation before dispatch:

```rust
let effects = {
    let mut machine = state.lock().unwrap();
    machine.reduce(input, &displays)
};
for effect in effects {
    effect_sender.send(effect).map_err(|_| "placement worker stopped")?;
}
```

Use a single worker with a nearest-deadline `recv_timeout` to feed `TimedOut(generation)` after 3 seconds; do not create one sleeping thread per hotkey press. On dispatch rejection, report the generation as unconfirmed. Never wait on that channel from the hotkey callback or `on_window_event`.

- [ ] **Step 4: Run GREEN and native crate check**

Run `rtk cargo test --manifest-path src-tauri/Cargo.toml panel_placement::adapter::tests`, then `rtk cargo check --manifest-path src-tauri/Cargo.toml`. The mocked setter returning before `Moved` must still leave confirmation empty. Preserve the prior `with_webview` reveal path exclusively for the **separate** expand/collapse shortcut; do not emit inside it.

- [ ] **Step 5: Commit the native adapter scope**

Stage exact `adapter.rs`, `mod.rs`, `lib.rs`, and `panel_shortcut.rs` paths/hunks only; verify `rtk git diff --cached --check`; commit `feat: confirm panel moves from native window events`. Keep temporary compatibility only if necessary for the existing frontend WIP, and do not call it a shipped feature until Task 5 replaces that bridge.

### Task 3: Persist only observed placement and migrate old coordinates

**Files:**
- Create: `src-tauri/src/panel_placement/store.rs`
- Modify: `src-tauri/src/panel_placement/mod.rs`
- Modify: `src-tauri/src/panel_placement/adapter.rs`
- Test: in `store.rs` and `adapter.rs`

**Interfaces:**
- Consumes `PlacementSnapshot` from Task 1 and `PanelPlacement` from Task 2.
- Produces `PlacementStore::load() -> Result<LoadOutcome, StoreError>` and `save_confirmed(&PlacementSnapshot) -> Result<(), StoreError>`, with `LoadOutcome::{Stored(PlacementRecord),Missing,Corrupt(String)}`. The durable record does not encode runtime generation or window dimensions; restoration reconstructs them from the current native window and starts a fresh generation.
- Produces `PlacementRecord { version:1, position:{x:i32,y:i32}, corner:Option<Corner> }` at `app.path().app_config_dir()?.join("placement.json")`. A corrupt/version-unsupported record is preserved, reported, and may fall back to the frontend-supplied legacy position; it is not treated as an empty valid record.

- [ ] **Step 1: Write RED storage and restore tests**

Use the existing `tempfile = "=3.14.0"` dependency. A test writes a confirmed bottom-left snapshot and asserts a load returns the same physical coordinates and corner. A corrupt file is left byte-for-byte intact after `load()`, and a rejected directory write returns `StoreError` without modifying the machine's confirmed frame.

```rust
let dir = tempfile::tempdir().unwrap();
let path = dir.path().join("placement.json");
let store = PlacementStore::new(path.clone());
let snapshot = PlacementSnapshot {
    generation: 7, corner: Some(Corner::BottomLeft),
    frame: PhysicalFrame { x: -1904, y: 812, width: 420, height: 252 },
};
store.save_confirmed(&snapshot).unwrap();
assert!(matches!(store.load().unwrap(), LoadOutcome::Stored(record)
    if record.version == 1 && record.position.x == -1904
        && record.position.y == 812 && record.corner == Some(Corner::BottomLeft)));
std::fs::write(&path, b"{invalid").unwrap();
assert!(matches!(store.load().unwrap(), LoadOutcome::Corrupt(_)));
assert_eq!(std::fs::read(&path).unwrap(), b"{invalid");
```

Add adapter tests that restore `x = -1904` onto a still-connected negative-origin monitor **before** requesting bottom-left, select current then primary when that monitor is absent, and confirm an already-in-place restoration without a `Moved` event. Ensure a hidden move persists natively even when no frontend listener consumes the event.

- [ ] **Step 2: Run RED**

Run `rtk cargo test --manifest-path src-tauri/Cargo.toml panel_placement::store::tests`. Expect missing `PlacementStore`/`LoadOutcome` or behavioral failures.

- [ ] **Step 3: Implement atomic persistence and one-time migration**

Create the app-config directory, serialize a `version: 1` record with `serde_json`, write to `tempfile::NamedTempFile::new_in(parent)`, `write_all`, `as_file().sync_all()`, then `persist(path)` on the same filesystem. Read into `LoadOutcome` without deleting a corrupt file. Apply the native record before any legacy value; accept a legacy value only for `Missing` or a reported `Corrupt` outcome and replace it only after an observed confirmation. Use physical location to select the containing display; if absent, use current then primary and avoid an off-screen claim.

```rust
let mut temp = tempfile::NamedTempFile::new_in(parent)?;
serde_json::to_writer(&mut temp, &record)?;
temp.as_file().sync_all()?;
temp.persist(&self.path).map_err(|error| error.error)?;
```

Emit a persistence error separately from placement confirmation; an already observed on-screen move must not be reversed by a filesystem failure. Serialize writes so a late older snapshot cannot overwrite the latest free-drag or snapped state.

- [ ] **Step 4: Run GREEN and crate suite**

Run focused store/adapter tests, then `rtk cargo test --manifest-path src-tauri/Cargo.toml`. Check the corrupt-file and write-failure tests by name rather than interpreting an error as a placement failure.

- [ ] **Step 5: Commit the persistence scope**

Stage exact `store.rs`, `mod.rs`, and affected `adapter.rs` hunks; `rtk git diff --cached --check`; commit `feat: persist confirmed panel placement natively`.

### Task 4: Reconcile both global shortcuts without stealing an existing binding

**Files:**
- Modify: `src-tauri/src/panel_shortcut.rs`
- Modify: `src-tauri/src/lib.rs` (native setup only)
- Modify: `src/features/statusPanel/panelShortcut.ts`, `statusPanel.ts`, and their tests only if the WIP's default/normalization still diverges

**Interfaces:**
- Consumes `PanelPlacement::on_position_shortcut(state: ShortcutState)` from Task 2. Does not use `with_webview` for position movement.
- Produces `configure_position_shortcut(shortcut: Option<String>) -> Result<PanelShortcutUpdate, PanelShortcutError>` alongside the existing `configure_panel_shortcut`; each action has a distinct active state under one registration lock.
- Keeps `DEFAULT_POSITION_CYCLE_SHORTCUT = "shift+control+super+space"` in TypeScript. Native setup registers only the old expand/collapse default; frontend startup reconciles saved toggle **before** position.

- [ ] **Step 1: Write RED tests for conflicts, held events, and priority**

In `panel_shortcut.rs`, use the existing fake registrar to assert that position cannot claim the toggle's active combination and a failed position registration does not unregister toggle. The reducer from Task 1 owns the only held latch: a position no-op Apply must not alter it, and `Pressed, Pressed, Released, Pressed` forwarded through Task 2's interface yields exactly two placement requests. In a frontend component test, pre-save `panelToggleShortcut: "shift+control+super+space"`; assert startup invokes `configure_panel_shortcut` before `configure_position_shortcut` and reports a position conflict while leaving toggle active.

```rust
placement.on_position_shortcut(ShortcutState::Pressed).unwrap();
apply_action_shortcut_update(
    &mut registrations, ShortcutAction::Position,
    Some("shift+control+super+space"), &mut fake_registrar,
).unwrap();
placement.on_position_shortcut(ShortcutState::Pressed).unwrap();
assert_eq!(fake_window.requested_positions().len(), 1);
assert!(fake_registrar.operations.is_empty());
```

- [ ] **Step 2: Run RED**

Run `rtk cargo test --manifest-path src-tauri/Cargo.toml position_shortcut_` and `rtk npm test -- --run src/features/statusPanel/StatusPanelView.test.tsx -t "position shortcut"`. A newly added case must fail for the behavior it protects; do not count already-green WIP tests as proof of TDD.

- [ ] **Step 3: Retain the safe WIP and replace its unsafe edge**

Keep the current composite native registrar's register-new-before-unregister-old and uncertain-state rules if the tests confirm them. Remove any native setup pre-registration of the new default. Forward position `Pressed` and `Released` to `PanelPlacement::on_position_shortcut`; remove all registration-manager state that separately gates a held position key. Call neither `show` nor `set_focus`. Reconcile the two saved preferences in component order through the existing promise queue, and keep per-action requested/active/error presentation; a partial Settings failure commits the successful action but preserves the failed action's prior active value.

- [ ] **Step 4: Run GREEN**

Run both focused suites, full `rtk cargo test --manifest-path src-tauri/Cargo.toml`, and `rtk npm run build`. Verify no Rust handler performs a placement setter or Tauri event emission while holding a global-shortcut registration mutex.

- [ ] **Step 5: Commit exact registration/config files**

Stage only `panel_shortcut.rs`, the setup hunk of `lib.rs`, and the intended shortcut config/tests; commit `feat: configure one global panel position shortcut`. Keep the user's unrelated untracked file outside the index.

### Task 5: Replace the unsafe frontend placement bridge

**Files:**
- Modify: `src/features/inbox/inboxApi.ts`
- Modify: `src/features/inbox/inboxApi.test.ts`
- Modify: `src/features/statusPanel/StatusPanelView.tsx`
- Modify: `src/features/statusPanel/StatusPanelView.test.tsx`
- Modify: `docs/window-placement.md`

**Interfaces:**
- Consumes `restore_panel_placement`, `resize_panel`, `begin_panel_drag`, and `placement-confirmed`/failure events from Tasks 2–3.
- Produces `restorePanelPlacement(legacy: LegacyPlacement | null): Promise<PlacementSnapshot | null>`, `resizePanel(height: number): Promise<{ generation: number }>`, and `beginPanelDrag(): Promise<void>` in `inboxApi.ts`. The nullable restore result supports a browser-preview no-op; these promises report acceptance/current state, never prove that a window setter completed.
- Produces `PlacementConfirmed { generation:number, corner:PanelCorner|null, position:{x:number,y:number}, size:{width:number,height:number} }`. Frontend stores shortcut preferences as before; native storage owns placement after migration.

- [ ] **Step 1: Write RED frontend tests at the real caller**

Use the component's Tauri invoke/listen mocks. Defer the listener registration promise and assert `restore_panel_placement` is not called before `placement-confirmed` and failure listeners exist. Seed legacy `attn.panelPosition` with `{x:-1904,y:812}` and assert it is passed once when native storage is absent. Have `resize_panel` resolve `{generation:11}` while no native event fires; assert the UI does not write a new `attn.panelCorner` or `attn.panelPosition`. Deliver `placement-confirmed` generation 11 and assert the localized position status changes to the confirmed corner; a stale generation 10 must not override it. Click the header without a `Moved` event and assert no free-position confirmation; deliver delayed manual `placement-confirmed` with `corner:null` and assert the free state.

```ts
expect(invoke).toHaveBeenCalledWith("restore_panel_placement", {
  legacy: { position: { x: -1904, y: 812 }, corner: null },
});
await act(async () => placementHandler?.({
  payload: { generation: 11, corner: "bottom-left",
    position: { x: -1904, y: 812 }, size: { width: 420, height: 252 } },
}));
expect(screen.getByRole("status", { name: "Panel position" }).textContent)
  .toContain("Bottom Left");
```

Also test preview no-op, StrictMode cleanup of late listener registration, hidden-window event consumption without `show`/`setFocus`, malformed localStorage, and native storage error presentation without loss of an already confirmed move.

- [ ] **Step 2: Run RED**

Run `rtk npm test -- --run src/features/inbox/inboxApi.test.ts src/features/statusPanel/StatusPanelView.test.tsx -t "placement|position"`. Expect failures for the old `anchor_panel_position`, `onMoved` persistence, and `setSize`-return assumption.

- [ ] **Step 3: Implement the new frontend interface**

Remove the WIP's `anchorPanelPosition`, `lastAnchoredPositionRef`, `pendingProgrammaticMovesRef`, and frontend classification in `onMoved`. The panel height effect calls `resizePanel(height)`; only the native confirmed event updates displayed placement state. Read the existing `attn.panelPosition` and optional WIP `attn.panelCorner` once for `restorePanelPlacement`; do not keep writing those legacy keys. Replace direct `startDragging()` with `beginPanelDrag()` while retaining the existing skip rules for buttons/inputs. Keep the WIP's independent position shortcut recorder and partial-apply behavior, but never label a requested move “confirmed” because an IPC promise resolved.

```ts
const accepted = await resizePanel(nextHeight);
if (accepted.generation < latestRequestedGenerationRef.current) return;
latestRequestedGenerationRef.current = accepted.generation;
// Only placement-confirmed may update the displayed physical placement.
```

Update `docs/window-placement.md` with the clockwise sequence, hidden behavior, manual drag, confirmed bottom anchor, and failure boundary. Keep `StatusPanelConfig.panelMode` and `expanded` meanings unchanged.

- [ ] **Step 4: Run GREEN and full frontend build**

Run the focused tests, `rtk npm test -- --run`, and `rtk npm run build`. Confirm no component code treats `setSize`, `setPosition`, or `outerPosition` return as a native completion signal.

- [ ] **Step 5: Commit the frontend/docs scope**

Stage exact frontend files and `docs/window-placement.md`; verify `rtk git diff --cached --check`; commit `feat: show only confirmed panel position`. Preserve old source/status work already committed and do not stage `main-BIHCWhv-.js`.

### Task 6: Close the reviewed resize-event and mixed-DPI scale races

This is the user-approved follow-up to the final review at `8c62260`, not a
change to the feature's interaction design. The two remaining Important
findings and their original evidence are recorded in this plan's SDD ledger.

**Files:** `src-tauri/src/panel_placement/state.rs` and
`src-tauri/src/panel_placement/adapter.rs`, including their existing tests.
Expand ownership only for a directly necessary interface or regression test;
preserve the unrelated untracked file and existing shortcut/frontend behavior.

- [ ] **Step 1: Reproduce the two failures before changing production code**

Trace the native event and setter path, including Tauri's current-size
substitution for queued `Resized` callbacks and Tao's conversion at setter
execution. Add behavior tests through the existing reducer and deferred native
adapter: request sizes `252` then `420` and deliver only the latest observed
size; after that confirmation, a late obsolete size must reassert the latest
intent rather than persist the stale frame. Cover a queued setter that crosses
from 2× to 1×, as well as scale values changing between the calls made for
one logical resize request. Record the failing assertions and distinguish an
unconfirmed timeout from a successful OS observation.

- [ ] **Step 2: Fix intent retirement and coherent scale conversion**

Retire superseded size requests without treating every intermediate native
observation as mandatory. Keep late-arrival provenance sufficient to reconcile
an obsolete setter without persisting its frame; a missing/coalesced old event
cannot permanently block future size or corner confirmation. Preserve logical
dimensions until one coherent scale snapshot converts an individual request,
and use that same scale for the reducer and display geometry participating in
that transition. Reconcile a queued native setter executing after a display
scale change; setter return alone must never confirm or persist.

- [ ] **Step 3: Verify and commit the scoped repair**

Run focused reducer/adapter tests, the complete Rust and frontend suites,
`cargo check`, frontend build, and `git diff --check`. Self-review the exact
diff for stale generations, late observations, repeat dispatch, callback
reentrancy, and hidden-window focus. Commit only the scoped files and report
the RED/GREEN evidence. No app launch, install, replacement, or push.

## Final verification and delivery gate

After Tasks 1–6, run fresh `rtk cargo test --manifest-path src-tauri/Cargo.toml`, `rtk cargo check --manifest-path src-tauri/Cargo.toml`, `rtk npm test -- --run`, `rtk npm run build`, `rtk git diff --check`, and an app-only `rtk npm run tauri build -- --bundles app --ci`. If `rustfmt` is unavailable, record that limitation and manually inspect touched Rust formatting; do not claim a formatting check passed.

Review the complete feature diff against `ef0a95a` and all WIP replacements, with particular attention to event reentrancy, confirmed-vs-requested UI, physical/display coordinate conversion, stale generations, storage failures, and no hidden-window focus theft. A build and mocked tests are not packaged macOS proof. Before a manual run that would conflict with the already installed App's global shortcuts, ask for the separate delivery/temporary-stop decision. Never overwrite `/Applications/Attn.app` as a normal plan step; after separate authorization, retain a timestamped backup and compare build, installed, and running executable hashes.
