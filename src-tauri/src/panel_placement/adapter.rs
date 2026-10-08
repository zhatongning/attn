use std::collections::{BTreeMap, BTreeSet};
use std::sync::{mpsc, Arc};
use std::sync::mpsc::{Receiver, Sender};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager, PhysicalPosition, PhysicalSize, Runtime, WebviewWindow};
#[cfg(desktop)]
use tauri_plugin_global_shortcut::ShortcutState;

use super::state::{Corner, DisplayFrame, PhysicalFrame, PlacementEffect, PlacementInput,
    PlacementMachine, PlacementSnapshot};

pub const PLACEMENT_CONFIRMED_EVENT: &str = "agent-session-inbox://placement-confirmed";
pub const PLACEMENT_UNCONFIRMED_EVENT: &str = "agent-session-inbox://placement-unconfirmed";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
pub struct LegacyPlacement {
    pub position: PhysicalPosition<i32>,
    pub corner: Option<Corner>,
}

/// An intent receipt, never a native arrival acknowledgement.
#[derive(Debug, Clone, Copy, Serialize)]
pub struct AcceptedPlacement {
    pub generation: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct UnconfirmedPlacement {
    pub generation: u64,
    pub reason: String,
}

type Receipt = Sender<Result<AcceptedPlacement, String>>;

enum WorkerMessage {
    Input(PlacementInput),
    ResizeLogical(u32, Receipt),
    Restore(Option<LegacyPlacement>),
    BeginDrag,
    DispatchFailed { generation: u64, reason: String },
    Shutdown,
    #[cfg(test)]
    Inspect(Sender<WorkerSnapshot>),
}

enum NativeEffect {
    SetPosition { generation: u64, x: i32, y: i32 },
    SetHeight { generation: u64, width: u32, height: u32 },
    Confirm(PlacementSnapshot),
    ReportUnconfirmed(UnconfirmedPlacement),
    BeginDrag,
}

trait WindowPort: Send + Sync + 'static {
    fn displays(&self, observed: PhysicalFrame) -> Result<Vec<DisplayFrame>, String>;
    fn scale_factor(&self) -> Result<f64, String>;
    fn dispatch(&self, effect: NativeEffect, feedback: Sender<WorkerMessage>) -> Result<(), String>;
}

struct NativeWindow<R: Runtime>(WebviewWindow<R>);

impl<R: Runtime> WindowPort for NativeWindow<R> {
    fn displays(&self, observed: PhysicalFrame) -> Result<Vec<DisplayFrame>, String> {
        let frame = |monitor: tauri::Monitor| DisplayFrame {
            x: monitor.position().x, y: monitor.position().y,
            width: monitor.size().width, height: monitor.size().height,
            scale_factor: monitor.scale_factor(),
        };
        let available = self.0.available_monitors().map_err(|error| error.to_string())?
            .into_iter().map(frame).collect();
        let current = self.0.current_monitor().ok().flatten().map(frame);
        let primary = self.0.primary_monitor().ok().flatten().map(frame);
        Ok(ordered_displays(observed, available, current, primary))
    }

    fn scale_factor(&self) -> Result<f64, String> {
        self.0.scale_factor().map_err(|error| error.to_string())
    }

    fn dispatch(&self, effect: NativeEffect, feedback: Sender<WorkerMessage>) -> Result<(), String> {
        let window = self.0.clone();
        // Called only from the worker. Wry queues this Task on the main loop,
        // so native event callbacks return before any setter or WebView emit.
        self.0.app_handle().run_on_main_thread(move || {
            let (generation, result) = match effect {
                NativeEffect::SetPosition { generation, x, y } =>
                    (Some(generation), window.set_position(PhysicalPosition::new(x, y))),
                NativeEffect::SetHeight { generation, width, height } =>
                    (Some(generation), window.set_size(PhysicalSize::new(width, height))),
                NativeEffect::Confirm(snapshot) =>
                    (None, window.app_handle().emit_to("main", PLACEMENT_CONFIRMED_EVENT, snapshot)),
                NativeEffect::ReportUnconfirmed(failure) =>
                    (None, window.app_handle().emit_to("main", PLACEMENT_UNCONFIRMED_EVENT, failure)),
                NativeEffect::BeginDrag => (None, window.start_dragging()),
            };
            if let Err(error) = result {
                if let Some(generation) = generation {
                    let _ = feedback.send(WorkerMessage::DispatchFailed {
                        generation, reason: format!("dispatch-failed: {error}"),
                    });
                } else {
                    eprintln!("panel placement native effect failed: {error}");
                }
            }
        }).map_err(|error| error.to_string())
    }
}

fn ordered_displays(
    observed: PhysicalFrame, available: Vec<DisplayFrame>,
    current: Option<DisplayFrame>, primary: Option<DisplayFrame>,
) -> Vec<DisplayFrame> {
    let center_x = i64::from(observed.x) * 2 + i64::from(observed.width);
    let center_y = i64::from(observed.y) * 2 + i64::from(observed.height);
    let containing = available.iter().copied().find(|display| {
        center_x >= i64::from(display.x) * 2
            && center_x < (i64::from(display.x) + i64::from(display.width)) * 2
            && center_y >= i64::from(display.y) * 2
            && center_y < (i64::from(display.y) + i64::from(display.height)) * 2
    });
    let mut ordered = Vec::new();
    for display in containing.into_iter().chain(current).chain(primary).chain(available.iter().copied()) {
        // A current/primary value must still belong to the live inventory.
        if available.contains(&display) && !ordered.contains(&display) {
            ordered.push(display);
        }
    }
    ordered
}

struct ShutdownGuard(Sender<WorkerMessage>);

impl Drop for ShutdownGuard {
    fn drop(&mut self) { let _ = self.0.send(WorkerMessage::Shutdown); }
}

#[derive(Clone)]
pub struct PanelPlacement {
    sender: Sender<WorkerMessage>,
    _lifetime: Arc<ShutdownGuard>,
}

impl PanelPlacement {
    pub fn new<R: Runtime>(window: WebviewWindow<R>) -> Result<Self, String> {
        let position = window.outer_position().map_err(|error| error.to_string())?;
        let size = window.outer_size().map_err(|error| error.to_string())?;
        Self::with_port(Arc::new(NativeWindow(window)), PhysicalFrame {
            x: position.x, y: position.y, width: size.width, height: size.height,
        }, None, Duration::from_secs(3))
    }

    fn with_port(
        window: Arc<dyn WindowPort>, observed: PhysicalFrame,
        saved: Option<PlacementSnapshot>, watchdog: Duration,
    ) -> Result<Self, String> {
        let (sender, receiver) = mpsc::channel();
        let worker_sender = sender.clone();
        std::thread::Builder::new().name("panel-placement".into()).spawn(move || {
            PlacementWorker {
                machine: PlacementMachine::new(observed, saved), window,
                sender: worker_sender, deadlines: BTreeMap::new(), watchdog,
                reported_failures: BTreeSet::new(),
                persisted: None, legacy: None, restoration_requested: false,
            }.run(receiver);
        }).map_err(|error| format!("placement worker unavailable: {error}"))?;
        Ok(Self { _lifetime: Arc::new(ShutdownGuard(sender.clone())), sender })
    }

    fn enqueue(&self, message: WorkerMessage) -> Result<(), String> {
        self.sender.send(message).map_err(|_| "placement worker stopped".into())
    }

    #[cfg(desktop)]
    pub fn on_position_shortcut(&self, state: ShortcutState) -> Result<(), String> {
        self.enqueue(WorkerMessage::Input(match state {
            ShortcutState::Pressed => PlacementInput::CyclePressed,
            ShortcutState::Released => PlacementInput::CycleReleased,
        }))
    }

    pub fn snap(&self, corner: Corner) -> Result<(), String> {
        self.enqueue(WorkerMessage::Input(PlacementInput::Snap(corner)))
    }

    /// React heights are logical; the worker converts exactly once at the IPC seam.
    pub fn resize(&self, height: u32) -> Result<Receiver<Result<AcceptedPlacement, String>>, String> {
        let (sender, receiver) = mpsc::channel();
        self.enqueue(WorkerMessage::ResizeLogical(height, sender))?;
        Ok(receiver)
    }

    /// Task 3 replaces this idempotent staging seam with native storage/migration.
    /// Enqueueing legacy data currently neither moves nor confirms the window.
    pub fn restore(&self, legacy: Option<LegacyPlacement>) -> Result<(), String> {
        self.enqueue(WorkerMessage::Restore(legacy))
    }

    pub fn begin_drag(&self) -> Result<(), String> {
        self.enqueue(WorkerMessage::BeginDrag)
    }

    pub fn on_window_event(&self, event: &tauri::WindowEvent) -> Result<(), String> {
        let input = match event {
            tauri::WindowEvent::Moved(position) => PlacementInput::Moved { x: position.x, y: position.y },
            tauri::WindowEvent::Resized(size) => PlacementInput::Resized { width: size.width, height: size.height },
            _ => return Ok(()),
        };
        // No getters, setters, emit, state lock, or receive on the native callback.
        self.enqueue(WorkerMessage::Input(input))
    }
}

struct PlacementWorker {
    // Single worker ownership makes reducer transitions serialized without a lock.
    machine: PlacementMachine,
    window: Arc<dyn WindowPort>,
    sender: Sender<WorkerMessage>,
    deadlines: BTreeMap<u64, Instant>,
    reported_failures: BTreeSet<u64>,
    watchdog: Duration,
    // In-memory sink only; Task 3 owns durable persistence.
    persisted: Option<PlacementSnapshot>,
    legacy: Option<LegacyPlacement>,
    restoration_requested: bool,
}

impl PlacementWorker {
    fn run(mut self, receiver: Receiver<WorkerMessage>) {
        loop {
            self.expire_watchdogs();
            let next = self.deadlines.values().min().copied();
            let message = match next {
                Some(deadline) => match receiver.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
                    Ok(message) => message,
                    Err(mpsc::RecvTimeoutError::Timeout) => continue,
                    Err(mpsc::RecvTimeoutError::Disconnected) => break,
                },
                None => match receiver.recv() { Ok(message) => message, Err(_) => break },
            };
            match message {
                WorkerMessage::Input(input) => { self.transition(input); }
                WorkerMessage::ResizeLogical(height, receipt) => {
                    let result = self.window.scale_factor().and_then(|scale| {
                        let physical = (f64::from(height) * scale).round();
                        if !scale.is_finite() || scale <= 0.0 || physical > f64::from(u32::MAX) {
                            return Err("invalid physical panel height".into());
                        }
                        self.transition(PlacementInput::ResizeRequested(physical as u32))
                            .map(|generation| AcceptedPlacement { generation })
                            .ok_or_else(|| "resize intent produced no generation".into())
                    });
                    let _ = receipt.send(result);
                }
                WorkerMessage::Restore(legacy) => {
                    if !self.restoration_requested {
                        self.legacy = legacy;
                        self.restoration_requested = true;
                    }
                }
                WorkerMessage::BeginDrag => {
                    self.transition(PlacementInput::BeginDrag);
                    if let Err(error) = self.window.dispatch(NativeEffect::BeginDrag, self.sender.clone()) {
                        eprintln!("panel drag dispatch failed: {error}");
                    }
                }
                WorkerMessage::DispatchFailed { generation, reason } => self.report(generation, reason),
                WorkerMessage::Shutdown => break,
                #[cfg(test)]
                WorkerMessage::Inspect(sender) => {
                    let _ = sender.send(WorkerSnapshot {
                        confirmed: self.machine.confirmed(), persisted: self.persisted, legacy: self.legacy,
                    });
                }
            }
        }
    }

    fn transition(&mut self, input: PlacementInput) -> Option<u64> {
        let displays = self.window.displays(self.machine.observed()).unwrap_or_else(|error| {
            eprintln!("panel displays unavailable: {error}"); Vec::new()
        });
        let effects = self.machine.reduce(input, &displays);
        let mut generation = None;
        for effect in effects {
            let native = match effect {
                PlacementEffect::SetPosition { generation: value, x, y } => {
                    generation = Some(value);
                    NativeEffect::SetPosition { generation: value, x, y }
                }
                PlacementEffect::SetHeight { generation: value, height } => {
                    generation = Some(value);
                    NativeEffect::SetHeight { generation: value, width: self.machine.observed().width, height }
                }
                PlacementEffect::Confirm(snapshot) => {
                    generation = Some(snapshot.generation);
                    self.deadlines.retain(|value, _| *value > snapshot.generation);
                    NativeEffect::Confirm(snapshot)
                }
                PlacementEffect::Persist(snapshot) => { self.persisted = Some(snapshot); continue; }
                PlacementEffect::ReportUnconfirmed(value) => {
                    generation = Some(value);
                    self.report(value, if displays.is_empty() { "display-unavailable" } else { "unconfirmed-timeout" }.into());
                    continue;
                }
                PlacementEffect::ScheduleWatchdog(value) => {
                    generation = Some(value);
                    // Late observations still reassert the desired geometry,
                    // but a failed generation must not arm another failure.
                    if !self.reported_failures.contains(&value) {
                        self.deadlines.entry(value).or_insert_with(|| Instant::now() + self.watchdog);
                    }
                    continue;
                }
            };
            let setter_generation = match &native {
                NativeEffect::SetPosition { generation, .. } | NativeEffect::SetHeight { generation, .. } => Some(*generation),
                _ => None,
            };
            if let Err(error) = self.window.dispatch(native, self.sender.clone()) {
                if let Some(value) = setter_generation {
                    self.report(value, format!("dispatch-failed: {error}"));
                } else {
                    eprintln!("panel placement event dispatch failed: {error}");
                }
            }
        }
        generation
    }

    fn report(&mut self, generation: u64, reason: String) {
        self.deadlines.remove(&generation);
        if !self.reported_failures.insert(generation) {
            return;
        }
        eprintln!("panel placement generation {generation} unconfirmed: {reason}");
        if let Err(error) = self.window.dispatch(
            NativeEffect::ReportUnconfirmed(UnconfirmedPlacement { generation, reason }), self.sender.clone(),
        ) {
            eprintln!("panel placement failure event unavailable: {error}");
        }
    }

    fn expire_watchdogs(&mut self) {
        let expired: Vec<_> = self.deadlines.iter().filter_map(|(generation, deadline)|
            (*deadline <= Instant::now()).then_some(*generation)).collect();
        for generation in expired {
            self.deadlines.remove(&generation);
            self.transition(PlacementInput::TimedOut(generation));
        }
    }
}

#[tauri::command]
pub async fn resize_panel(state: tauri::State<'_, PanelPlacement>, height: u32) -> Result<AcceptedPlacement, String> {
    let receipt = state.resize(height)?;
    tauri::async_runtime::spawn_blocking(move || receipt.recv()
        .map_err(|_| "placement worker stopped before accepting resize".to_owned())?)
        .await.map_err(|error| format!("resize acceptance worker failed: {error}"))?
}

#[tauri::command]
pub fn restore_panel_placement(state: tauri::State<'_, PanelPlacement>, legacy: Option<LegacyPlacement>) -> Result<(), String> {
    state.restore(legacy)
}

#[tauri::command]
pub fn begin_panel_drag(state: tauri::State<'_, PanelPlacement>) -> Result<(), String> {
    state.begin_drag()
}

#[cfg(test)]
struct WorkerSnapshot {
    confirmed: Option<PlacementSnapshot>,
    persisted: Option<PlacementSnapshot>,
    legacy: Option<LegacyPlacement>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    const STRIP: PhysicalFrame = PhysicalFrame {
        x: 16, y: 16, width: 420, height: 50,
    };
    const DISPLAY: DisplayFrame = DisplayFrame {
        x: 0, y: 0, width: 1920, height: 1080, scale_factor: 1.0,
    };

    #[derive(Default)]
    struct Calls {
        positions: Vec<(i32, i32)>,
        heights: Vec<(u32, u32)>,
        confirmed: Vec<PlacementSnapshot>,
        unconfirmed: Vec<UnconfirmedPlacement>,
        drags: usize,
    }

    struct DeferredWindow {
        calls: Mutex<Calls>,
        displays: Vec<DisplayFrame>,
        scale: f64,
        reject_position: bool,
    }

    impl WindowPort for DeferredWindow {
        fn displays(&self, observed: PhysicalFrame) -> Result<Vec<DisplayFrame>, String> {
            Ok(ordered_displays(observed, self.displays.clone(), None, None))
        }

        fn scale_factor(&self) -> Result<f64, String> { Ok(self.scale) }

        // Setters deliberately do not update any observed window frame.
        fn dispatch(&self, effect: NativeEffect, _: Sender<WorkerMessage>) -> Result<(), String> {
            let mut calls = self.calls.lock().unwrap();
            match effect {
                NativeEffect::SetPosition { x, y, .. } => {
                    if self.reject_position { return Err("setter rejected".into()); }
                    calls.positions.push((x, y));
                }
                NativeEffect::SetHeight { width, height, .. } => calls.heights.push((width, height)),
                NativeEffect::Confirm(snapshot) => calls.confirmed.push(snapshot),
                NativeEffect::ReportUnconfirmed(failure) => calls.unconfirmed.push(failure),
                NativeEffect::BeginDrag => calls.drags += 1,
            }
            Ok(())
        }
    }

    fn setup(frame: PhysicalFrame, saved: Option<PlacementSnapshot>) -> (PanelPlacement, Arc<DeferredWindow>) {
        setup_window(frame, saved, vec![DISPLAY], 1.0, false, Duration::from_secs(3))
    }

    fn setup_window(
        frame: PhysicalFrame, saved: Option<PlacementSnapshot>, displays: Vec<DisplayFrame>,
        scale: f64, reject_position: bool, watchdog: Duration,
    ) -> (PanelPlacement, Arc<DeferredWindow>) {
        let window = Arc::new(DeferredWindow {
            calls: Mutex::new(Calls::default()), displays, scale, reject_position,
        });
        let placement = PanelPlacement::with_port(window.clone(), frame, saved, watchdog).unwrap();
        (placement, window)
    }

    fn inspect(placement: &PanelPlacement) -> WorkerSnapshot {
        let (sender, receiver) = mpsc::channel();
        placement.sender.send(WorkerMessage::Inspect(sender)).unwrap();
        receiver.recv_timeout(Duration::from_secs(2)).unwrap()
    }

    fn moved(placement: &PanelPlacement, x: i32, y: i32) {
        placement.on_window_event(&tauri::WindowEvent::Moved(PhysicalPosition::new(x, y))).unwrap();
        inspect(placement);
    }

    #[test]
    fn setter_acceptance_is_not_confirmation_or_persistence() {
        let (placement, window) = setup(STRIP, None);
        placement.on_position_shortcut(ShortcutState::Pressed).unwrap();
        let state = inspect(&placement);
        assert_eq!(window.calls.lock().unwrap().positions, vec![(1484, 16)]);
        assert!(window.calls.lock().unwrap().confirmed.is_empty());
        assert_eq!(state.confirmed, None);
        assert_eq!(state.persisted, None);
        moved(&placement, 1484, 16);
        let state = inspect(&placement);
        let confirmed = window.calls.lock().unwrap().confirmed.clone();
        assert_eq!(confirmed.len(), 1);
        assert_eq!(confirmed[0].generation, 1);
        assert_eq!(confirmed[0].frame.x, 1484);
        assert_eq!(state.confirmed, Some(confirmed[0]));
        assert_eq!(state.persisted, Some(confirmed[0]));
    }

    #[test]
    fn held_and_reverse_order_moves_confirm_only_latest_generation() {
        let (placement, window) = setup(STRIP, None);
        placement.on_position_shortcut(ShortcutState::Pressed).unwrap();
        placement.on_position_shortcut(ShortcutState::Pressed).unwrap();
        placement.on_position_shortcut(ShortcutState::Released).unwrap();
        placement.on_position_shortcut(ShortcutState::Pressed).unwrap();
        inspect(&placement);
        assert_eq!(window.calls.lock().unwrap().positions, vec![(1484, 16), (1484, 1014)]);
        moved(&placement, 1484, 16);
        assert!(window.calls.lock().unwrap().confirmed.is_empty());
        moved(&placement, 1484, 1014);
        assert_eq!(window.calls.lock().unwrap().confirmed.iter().map(|s| s.generation).collect::<Vec<_>>(), vec![2]);
    }

    #[test]
    fn bottom_reanchor_waits_for_observed_physical_height() {
        let bottom = PhysicalFrame { x: 1484, y: 1014, ..STRIP };
        let saved = PlacementSnapshot { generation: 1, corner: Some(Corner::BottomRight), frame: bottom };
        let (placement, window) = setup(bottom, Some(saved));
        let receipt = placement.resize(252).unwrap().recv_timeout(Duration::from_secs(2)).unwrap().unwrap();
        assert_eq!(receipt.generation, 2);
        let state = inspect(&placement);
        assert_eq!(state.confirmed, Some(saved));
        assert_eq!(window.calls.lock().unwrap().heights, vec![(420, 252)]);
        assert!(window.calls.lock().unwrap().positions.is_empty());
        placement.on_window_event(&tauri::WindowEvent::Resized(PhysicalSize::new(420, 252))).unwrap();
        inspect(&placement);
        assert_eq!(window.calls.lock().unwrap().positions, vec![(1484, 812)]);
        assert!(window.calls.lock().unwrap().confirmed.is_empty());
        moved(&placement, 1484, 812);
        assert_eq!(window.calls.lock().unwrap().confirmed[0].frame.height, 252);
    }

    #[test]
    fn logical_height_is_converted_once_but_native_resize_is_already_physical() {
        let (placement, window) = setup_window(STRIP, None, vec![DisplayFrame { scale_factor: 2.0, ..DISPLAY }], 2.0, false, Duration::from_secs(3));
        placement.resize(252).unwrap().recv_timeout(Duration::from_secs(2)).unwrap().unwrap();
        assert_eq!(window.calls.lock().unwrap().heights, vec![(420, 504)]);
        placement.on_window_event(&tauri::WindowEvent::Resized(PhysicalSize::new(420, 504))).unwrap();
        inspect(&placement);
        assert_eq!(window.calls.lock().unwrap().confirmed[0].frame.height, 504);
    }

    #[test]
    fn click_only_drag_retains_anchor_and_delayed_manual_move_clears_it() {
        let saved = PlacementSnapshot { generation: 4, corner: Some(Corner::TopLeft), frame: STRIP };
        let (placement, window) = setup(STRIP, Some(saved));
        placement.begin_drag().unwrap();
        assert_eq!(inspect(&placement).confirmed, Some(saved));
        assert_eq!(window.calls.lock().unwrap().drags, 1);
        moved(&placement, 310, 205);
        let snapshot = inspect(&placement).confirmed.unwrap();
        assert_eq!(snapshot.corner, None);
        assert_eq!((snapshot.frame.x, snapshot.frame.y), (310, 205));
    }

    #[test]
    fn stale_programmatic_move_does_not_overwrite_manual_destination() {
        let (placement, window) = setup(STRIP, None);
        placement.on_position_shortcut(ShortcutState::Pressed).unwrap();
        placement.begin_drag().unwrap();
        moved(&placement, 310, 205);
        let manual = inspect(&placement).persisted.unwrap();
        moved(&placement, 1484, 16);
        assert_eq!(inspect(&placement).persisted, Some(manual));
        assert_eq!(window.calls.lock().unwrap().positions.last(), Some(&(310, 205)));
    }

    #[test]
    fn unavailable_display_and_rejected_dispatch_never_confirm() {
        let (placement, window) = setup_window(STRIP, None, vec![], 1.0, false, Duration::from_secs(3));
        placement.snap(Corner::TopRight).unwrap();
        inspect(&placement);
        assert_eq!(window.calls.lock().unwrap().unconfirmed[0].generation, 1);
        assert!(window.calls.lock().unwrap().confirmed.is_empty());
        let (placement, window) = setup_window(STRIP, None, vec![DISPLAY], 1.0, true, Duration::from_secs(3));
        placement.snap(Corner::TopRight).unwrap();
        inspect(&placement);
        assert_eq!(window.calls.lock().unwrap().unconfirmed[0].generation, 1);
        assert!(window.calls.lock().unwrap().confirmed.is_empty());
    }

    #[test]
    fn rejected_dispatch_reports_once_without_later_timeout_duplicate() {
        let (placement, window) = setup_window(STRIP, None, vec![DISPLAY], 1.0, true, Duration::from_millis(10));
        placement.snap(Corner::TopRight).unwrap();
        inspect(&placement);
        std::thread::sleep(Duration::from_millis(30));
        inspect(&placement);
        assert_eq!(window.calls.lock().unwrap().unconfirmed.len(), 1);
    }

    fn wait_for_failures(window: &DeferredWindow, count: usize) {
        let limit = Instant::now() + Duration::from_secs(2);
        while window.calls.lock().unwrap().unconfirmed.len() < count {
            assert!(Instant::now() < limit);
            std::thread::yield_now();
        }
    }

    #[test]
    fn timeout_then_late_native_events_does_not_report_generation_twice() {
        let (placement, window) = setup_window(STRIP, None, vec![DISPLAY], 1.0, false, Duration::from_millis(10));
        placement.snap(Corner::TopRight).unwrap();
        wait_for_failures(&window, 1);
        assert_eq!(window.calls.lock().unwrap().unconfirmed[0].generation, 1);

        // Both unmatched observations reconcile generation 1 and request another
        // watchdog. The target must still converge without repeating its failure.
        moved(&placement, 310, 205);
        placement.on_window_event(&tauri::WindowEvent::Resized(PhysicalSize::new(420, 50))).unwrap();
        inspect(&placement);
        assert_eq!(window.calls.lock().unwrap().positions.last(), Some(&(1484, 16)));
        std::thread::sleep(Duration::from_millis(30));
        assert_eq!(inspect(&placement).persisted, None);
        assert_eq!(window.calls.lock().unwrap().unconfirmed.len(), 1);

        moved(&placement, 1484, 16);
        assert_eq!(inspect(&placement).persisted.unwrap().generation, 1);
        assert_eq!(window.calls.lock().unwrap().confirmed.len(), 1);
    }

    #[test]
    fn timeout_then_late_dispatch_failure_does_not_report_generation_twice() {
        let (placement, window) = setup_window(STRIP, None, vec![DISPLAY], 1.0, false, Duration::from_millis(10));
        placement.snap(Corner::TopRight).unwrap();
        wait_for_failures(&window, 1);
        placement.sender.send(WorkerMessage::DispatchFailed {
            generation: 1, reason: "dispatch-failed: delayed rejection".into(),
        }).unwrap();
        assert_eq!(inspect(&placement).persisted, None);
        assert_eq!(window.calls.lock().unwrap().unconfirmed.len(), 1);

        // A later, distinct generation still gets its own failure report.
        placement.snap(Corner::BottomRight).unwrap();
        wait_for_failures(&window, 2);
        assert_eq!(window.calls.lock().unwrap().unconfirmed.iter()
            .map(|failure| failure.generation).collect::<Vec<_>>(), vec![1, 2]);
    }

    #[test]
    fn hidden_position_path_only_requests_geometry_without_reveal_operations() {
        let (placement, window) = setup(STRIP, None);
        placement.snap(Corner::BottomLeft).unwrap();
        inspect(&placement);
        let calls = window.calls.lock().unwrap();
        assert_eq!(calls.positions, vec![(16, 1014)]);
        assert!(calls.heights.is_empty());
        assert_eq!(calls.drags, 0);
        assert!(calls.confirmed.is_empty());
    }

    #[test]
    fn single_worker_reports_missing_event_without_persisting_target() {
        let (placement, window) = setup_window(STRIP, None, vec![DISPLAY], 1.0, false, Duration::from_millis(20));
        placement.snap(Corner::TopRight).unwrap();
        let limit = Instant::now() + Duration::from_secs(2);
        while window.calls.lock().unwrap().unconfirmed.is_empty() {
            assert!(Instant::now() < limit);
            std::thread::yield_now();
        }
        assert_eq!(window.calls.lock().unwrap().unconfirmed[0].generation, 1);
        assert_eq!(inspect(&placement).persisted, None);
    }

    #[test]
    fn ordered_displays_prefer_observed_then_current_then_primary() {
        let other = DisplayFrame { x: -1920, scale_factor: 2.0, ..DISPLAY };
        let far = DisplayFrame { x: 4000, ..DISPLAY };
        assert_eq!(ordered_displays(STRIP, vec![other, DISPLAY, far], Some(other), Some(far)), vec![DISPLAY, other, far]);
        let offscreen = PhysicalFrame { x: 8000, ..STRIP };
        assert_eq!(ordered_displays(offscreen, vec![far, DISPLAY, other], Some(other), Some(DISPLAY)), vec![other, DISPLAY, far]);
    }

    #[test]
    fn restore_staging_is_idempotent_and_never_claims_confirmation() {
        let (placement, window) = setup(STRIP, None);
        let legacy = LegacyPlacement { position: PhysicalPosition::new(310, 205), corner: Some(Corner::BottomLeft) };
        placement.restore(Some(legacy)).unwrap();
        placement.restore(Some(legacy)).unwrap();
        let state = inspect(&placement);
        assert_eq!(state.legacy, Some(legacy));
        assert_eq!(state.confirmed, None);
        assert_eq!(state.persisted, None);
        assert!(window.calls.lock().unwrap().positions.is_empty());
    }
}
