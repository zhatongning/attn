use std::collections::{BTreeMap, BTreeSet};
use std::sync::{mpsc, Arc};
use std::sync::mpsc::{Receiver, Sender};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{Emitter, LogicalSize, Manager, PhysicalPosition, PhysicalSize, Runtime, WebviewWindow};
#[cfg(desktop)]
use tauri_plugin_global_shortcut::ShortcutState;

use super::state::{Corner, DisplayFrame, PhysicalFrame, PlacementEffect, PlacementInput,
    PlacementMachine, PlacementSnapshot};
use super::store::{LoadOutcome, PlacementStore};

pub const PLACEMENT_CONFIRMED_EVENT: &str = "agent-session-inbox://placement-confirmed";
pub const PLACEMENT_UNCONFIRMED_EVENT: &str = "agent-session-inbox://placement-unconfirmed";
pub const PLACEMENT_PERSISTENCE_ERROR_EVENT: &str = "agent-session-inbox://placement-persistence-error";
const PANEL_WIDTH_LOGICAL: u32 = 420;

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

#[derive(Debug, Clone, Serialize)]
pub struct PlacementPersistenceError {
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
    SetHeight { generation: u64, size: LogicalSize<f64> },
    Confirm(PlacementSnapshot),
    ReportUnconfirmed(UnconfirmedPlacement),
    ReportPersistenceError(PlacementPersistenceError),
    BeginDrag,
}

trait WindowPort: Send + Sync + 'static {
    fn displays(&self, observed: PhysicalFrame, scale: f64) -> Result<Vec<DisplayFrame>, String>;
    fn scale_factor(&self) -> Result<f64, String>;
    fn dispatch(&self, effect: NativeEffect, feedback: Sender<WorkerMessage>) -> Result<(), String>;
}

struct NativeWindow<R: Runtime>(WebviewWindow<R>);

impl<R: Runtime> WindowPort for NativeWindow<R> {
    fn displays(&self, observed: PhysicalFrame, window_scale: f64) -> Result<Vec<DisplayFrame>, String> {
        let frame = |monitor: tauri::Monitor| DisplayFrame {
            x: monitor.position().x, y: monitor.position().y,
            width: monitor.size().width, height: monitor.size().height,
            scale_factor: monitor.scale_factor(),
        };
        let available = self.0.available_monitors().map_err(|error| error.to_string())?
            .into_iter().map(frame).collect();
        let current = self.0.current_monitor().ok().flatten().map(frame);
        let primary = self.0.primary_monitor().ok().flatten().map(frame);
        Ok(ordered_displays(observed, available, current, primary, window_scale))
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
                // Keep Size logical through runtime-wry's queued setter. Tao
                // converts it at execution using the then-current backing scale.
                NativeEffect::SetHeight { generation, size } =>
                    (Some(generation), window.set_size(size)),
                NativeEffect::Confirm(snapshot) =>
                    (None, window.app_handle().emit_to("main", PLACEMENT_CONFIRMED_EVENT, snapshot)),
                NativeEffect::ReportUnconfirmed(failure) =>
                    (None, window.app_handle().emit_to("main", PLACEMENT_UNCONFIRMED_EVENT, failure)),
                NativeEffect::ReportPersistenceError(failure) =>
                    (None, window.app_handle().emit_to("main", PLACEMENT_PERSISTENCE_ERROR_EVENT, failure)),
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
    current: Option<DisplayFrame>, primary: Option<DisplayFrame>, window_scale: f64,
) -> Vec<DisplayFrame> {
    if !window_scale.is_finite() || window_scale <= 0.0 {
        return Vec::new();
    }
    // Tao 0.30.8 uses each monitor's backing scale for monitor geometry,
    // but the window's scale for outer_position, Moved and set_position.
    let normalize = |display| monitor_in_window_space(display, window_scale);
    let available: Vec<_> = available.into_iter().filter_map(normalize).collect();
    let current = current.and_then(normalize);
    let primary = primary.and_then(normalize);
    let center_x = i64::from(observed.x) * 2 + i64::from(observed.width);
    let center_y = i64::from(observed.y) * 2 + i64::from(observed.height);
    let containing = available.iter().copied().find(|display| {
        center_x >= i64::from(display.x) * 2
            && center_x < (i64::from(display.x) + i64::from(display.width)) * 2
            && center_y >= i64::from(display.y) * 2
            && center_y < (i64::from(display.y) + i64::from(display.height)) * 2
    });
    let mut ordered = Vec::new();
    for display in current.into_iter().chain(containing).chain(primary).chain(available.iter().copied()) {
        // A current/primary value must still belong to the live inventory.
        if available.contains(&display) && !ordered.contains(&display) {
            ordered.push(display);
        }
    }
    ordered
}

fn monitor_in_window_space(display: DisplayFrame, window_scale: f64) -> Option<DisplayFrame> {
    if !display.scale_factor.is_finite() || display.scale_factor <= 0.0 {
        return None;
    }
    let position = PhysicalPosition::new(display.x, display.y)
        .to_logical::<f64>(display.scale_factor)
        .to_physical::<i32>(window_scale);
    let size = PhysicalSize::new(display.width, display.height)
        .to_logical::<f64>(display.scale_factor)
        .to_physical::<u32>(window_scale);
    Some(DisplayFrame {
        x: position.x, y: position.y, width: size.width, height: size.height,
        scale_factor: window_scale,
    })
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
        let path = window.app_handle().path().app_config_dir()
            .map_err(|error| error.to_string())?.join("placement.json");
        Self::with_port_and_store(Arc::new(NativeWindow(window)), PhysicalFrame {
            x: position.x, y: position.y, width: size.width, height: size.height,
        }, None, Duration::from_secs(3), Some(Arc::new(PlacementStore::new(path))))
    }

    #[cfg(test)]
    fn with_port(
        window: Arc<dyn WindowPort>, observed: PhysicalFrame,
        saved: Option<PlacementSnapshot>, watchdog: Duration,
    ) -> Result<Self, String> {
        Self::with_port_and_store(window, observed, saved, watchdog, None)
    }

    fn with_port_and_store(
        window: Arc<dyn WindowPort>, observed: PhysicalFrame,
        saved: Option<PlacementSnapshot>, watchdog: Duration, store: Option<Arc<PlacementStore>>,
    ) -> Result<Self, String> {
        let initial_scale = window.scale_factor()?;
        let (sender, receiver) = mpsc::channel();
        let worker_sender = sender.clone();
        std::thread::Builder::new().name("panel-placement".into()).spawn(move || {
            let placement_active = store.is_none();
            let loaded = store.as_ref().map_or(Ok(LoadOutcome::Missing), |store|
                store.load().map_err(|error| error.to_string()));
            PlacementWorker {
                machine: PlacementMachine::new(observed, saved), window,
                observed_scale: initial_scale,
                sender: worker_sender, deadlines: BTreeMap::new(), watchdog,
                reported_failures: BTreeSet::new(),
                persisted: None, legacy: None, restoration_requested: false,
                store, loaded, placement_active,
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

    /// Keep React's logical height intact until the worker's scale snapshot.
    pub fn resize(&self, height: u32) -> Result<Receiver<Result<AcceptedPlacement, String>>, String> {
        let (sender, receiver) = mpsc::channel();
        self.enqueue(WorkerMessage::ResizeLogical(height, sender))?;
        Ok(receiver)
    }

    /// Called after event subscription. Native storage takes priority; legacy
    /// coordinates are only a one-time Missing/Corrupt migration source.
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
    observed_scale: f64,
    sender: Sender<WorkerMessage>,
    deadlines: BTreeMap<u64, Instant>,
    reported_failures: BTreeSet<u64>,
    watchdog: Duration,
    // Updated only after the serialized durable write succeeds.
    persisted: Option<PlacementSnapshot>,
    legacy: Option<LegacyPlacement>,
    restoration_requested: bool,
    store: Option<Arc<PlacementStore>>,
    loaded: Result<LoadOutcome, String>,
    // Startup observations update dimensions, but cannot overwrite a native
    // record before subscribed restoration or an explicit placement/drag intent.
    placement_active: bool,
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
                WorkerMessage::Input(input) => {
                    if matches!(input, PlacementInput::Snap(_) | PlacementInput::CyclePressed) {
                        self.placement_active = true;
                    }
                    self.transition(input);
                }
                WorkerMessage::ResizeLogical(height, receipt) => {
                    let result = self.window.scale_factor().and_then(|scale| {
                        let physical_height = (f64::from(height) * scale).round();
                        let physical_width = (f64::from(PANEL_WIDTH_LOGICAL) * scale).round();
                        if !scale.is_finite() || scale <= 0.0
                            || physical_height > f64::from(u32::MAX)
                            || physical_width > f64::from(u32::MAX)
                        {
                            return Err("invalid physical panel size".into());
                        }
                        self.transition_at_scale(PlacementInput::ResizeRequested {
                            width: physical_width as u32, height: physical_height as u32,
                        }, scale, Some((PANEL_WIDTH_LOGICAL, height)))
                            .map(|generation| AcceptedPlacement { generation })
                            .ok_or_else(|| "resize intent produced no generation".into())
                    });
                    let _ = receipt.send(result);
                }
                WorkerMessage::Restore(legacy) => {
                    if !self.restoration_requested {
                        self.restoration_requested = true;
                        self.restore(legacy);
                    }
                }
                WorkerMessage::BeginDrag => {
                    self.placement_active = true;
                    self.transition(PlacementInput::BeginDrag);
                    if let Err(error) = self.window.dispatch(NativeEffect::BeginDrag, self.sender.clone()) {
                        eprintln!("panel drag dispatch failed: {error}");
                    }
                }
                WorkerMessage::DispatchFailed { generation, reason } => {
                    self.machine.size_dispatch_failed(generation);
                    self.report(generation, reason);
                }
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
        let scale = self.window.scale_factor().unwrap_or(self.observed_scale);
        self.transition_at_scale(input, scale, None)
    }

    fn transition_at_scale(
        &mut self, input: PlacementInput, scale: f64, logical_size: Option<(u32, u32)>,
    ) -> Option<u64> {
        if scale.is_finite() && scale > 0.0 && scale != self.observed_scale {
            self.machine.rescale(self.observed_scale, scale);
            self.observed_scale = scale;
        }
        let display_frame = match input {
            PlacementInput::RestorePosition { x, y, .. } => PhysicalFrame { x, y, ..self.machine.observed() },
            _ => self.machine.observed(),
        };
        let displays = self.window.displays(display_frame, self.observed_scale).unwrap_or_else(|error| {
            eprintln!("panel displays unavailable: {error}"); Vec::new()
        });
        let effects = self.machine.reduce(input, &displays);
        if let Some((width, height)) = logical_size {
            self.machine.remember_logical_size(width, height);
        }
        let mut generation = None;
        for effect in effects {
            let native = match effect {
                PlacementEffect::SetPosition { generation: value, x, y } => {
                    generation = Some(value);
                    NativeEffect::SetPosition { generation: value, x, y }
                }
                PlacementEffect::SetHeight { generation: value, height } => {
                    generation = Some(value);
                    NativeEffect::SetHeight { generation: value,
                        size: self.machine.requested_logical_size()
                            .map(|(width, height)| LogicalSize::new(f64::from(width), f64::from(height)))
                            .unwrap_or_else(|| LogicalSize::new(
                                f64::from(self.machine.requested_width()) / self.observed_scale,
                                f64::from(height) / self.observed_scale)),
                    }
                }
                PlacementEffect::Confirm(snapshot) => {
                    generation = Some(snapshot.generation);
                    self.deadlines.retain(|value, _| *value > snapshot.generation);
                    if !self.placement_active { continue; }
                    NativeEffect::Confirm(snapshot)
                }
                PlacementEffect::Persist(snapshot) => {
                    if !self.placement_active { continue; }
                    // Both transition effects and fsync/rename run on this
                    // worker, so no late background write can race a new drag.
                    let result = self.store.as_ref().map_or(Ok(()), |store|
                        store.save_confirmed_at_scale(&snapshot, self.observed_scale));
                    match result {
                        Ok(()) => self.persisted = Some(snapshot),
                        Err(error) => self.report_persistence_error(snapshot.generation, error.to_string()),
                    }
                    continue;
                }
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
            let size_generation = match &native {
                NativeEffect::SetHeight { generation, .. } => Some(*generation),
                _ => None,
            };
            if let Err(error) = self.window.dispatch(native, self.sender.clone()) {
                if let Some(value) = size_generation {
                    self.machine.size_dispatch_failed(value);
                }
                if let Some(value) = setter_generation {
                    self.report(value, format!("dispatch-failed: {error}"));
                } else {
                    eprintln!("panel placement event dispatch failed: {error}");
                }
            }
        }
        generation
    }

    fn restore(&mut self, legacy: Option<LegacyPlacement>) {
        match self.loaded.clone() {
            Ok(LoadOutcome::Stored(record)) => {
                self.placement_active = true;
                // Convert before monitor selection using the same scale that
                // will normalize live display geometry and reduce restoration.
                let scale = self.window.scale_factor().unwrap_or(self.observed_scale);
                let position = PhysicalPosition::new(record.position.x, record.position.y);
                let position = if let Some(saved_scale) = record.scale_factor {
                    position.to_logical::<f64>(saved_scale).to_physical::<i32>(scale)
                } else {
                    self.report_persistence_error(0,
                        "legacy placement coordinate scale unavailable; restoring best-effort, same-display recovery cannot be guaranteed".into());
                    position
                };
                self.transition_at_scale(PlacementInput::RestorePosition {
                    x: position.x, y: position.y, corner: record.corner,
                }, scale, None);
            }
            Ok(outcome) => {
                self.placement_active = true;
                if let LoadOutcome::Corrupt(reason) = outcome {
                    self.report_persistence_error(0, format!("placement record corrupt: {reason}"));
                }
                self.legacy = legacy;
                if let Some(value) = legacy {
                    self.transition(PlacementInput::RestorePosition {
                        x: value.position.x, y: value.position.y, corner: value.corner,
                    });
                } else {
                    self.transition(PlacementInput::Snap(Corner::TopRight));
                }
            }
            Err(reason) => {
                // An unreadable record is neither Missing nor Corrupt. Do not
                // silently replace a potentially valid native record with legacy.
                self.report_persistence_error(0, reason);
            }
        }
    }

    fn report_persistence_error(&self, generation: u64, reason: String) {
        eprintln!("panel placement generation {generation} persistence failed: {reason}");
        if let Err(error) = self.window.dispatch(
            NativeEffect::ReportPersistenceError(PlacementPersistenceError { generation, reason }), self.sender.clone(),
        ) {
            eprintln!("panel placement persistence failure event unavailable: {error}");
        }
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
    use crate::panel_placement::store::{LoadOutcome, PlacementStore};

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
        persistence_errors: Vec<(u64, String)>,
        drags: usize,
    }

    struct DeferredWindow {
        calls: Mutex<Calls>,
        displays: Vec<DisplayFrame>,
        scale: Mutex<f64>,
        reject_position: bool,
        reject_size: Mutex<bool>,
        current: Mutex<Option<DisplayFrame>>,
        primary: Option<DisplayFrame>,
        consume_confirmation: bool,
    }

    impl WindowPort for DeferredWindow {
        fn displays(&self, observed: PhysicalFrame, scale: f64) -> Result<Vec<DisplayFrame>, String> {
            Ok(ordered_displays(observed, self.displays.clone(),
                *self.current.lock().unwrap(), self.primary, scale))
        }

        fn scale_factor(&self) -> Result<f64, String> { Ok(*self.scale.lock().unwrap()) }

        // Setters deliberately do not update any observed window frame.
        fn dispatch(&self, effect: NativeEffect, _: Sender<WorkerMessage>) -> Result<(), String> {
            let mut calls = self.calls.lock().unwrap();
            match effect {
                NativeEffect::SetPosition { x, y, .. } => {
                    if self.reject_position { return Err("setter rejected".into()); }
                    calls.positions.push((x, y));
                }
                NativeEffect::SetHeight { size, .. } => {
                    if *self.reject_size.lock().unwrap() { return Err("size setter rejected".into()); }
                    let physical = size.to_physical::<u32>(*self.scale.lock().unwrap());
                    calls.heights.push((physical.width, physical.height));
                }
                NativeEffect::Confirm(snapshot) => {
                    if self.consume_confirmation { calls.confirmed.push(snapshot); }
                }
                NativeEffect::ReportUnconfirmed(failure) => calls.unconfirmed.push(failure),
                NativeEffect::ReportPersistenceError(failure) => calls.persistence_errors.push((failure.generation, failure.reason)),
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
            calls: Mutex::new(Calls::default()), displays, scale: Mutex::new(scale), reject_position,
            reject_size: Mutex::new(false),
            current: Mutex::new(None), primary: None, consume_confirmation: true,
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
    fn accepted_resize_before_click_only_drag_reanchors_after_native_resize() {
        let bottom = PhysicalFrame { x: 1484, y: 1014, ..STRIP };
        let saved = PlacementSnapshot { generation: 1, corner: Some(Corner::BottomRight), frame: bottom };
        let (placement, window) = setup(bottom, Some(saved));
        let receipt = placement.resize(252).unwrap().recv_timeout(Duration::from_secs(2)).unwrap().unwrap();
        placement.begin_drag().unwrap();
        assert_eq!(inspect(&placement).confirmed, Some(saved));
        placement.on_window_event(&tauri::WindowEvent::Resized(PhysicalSize::new(420, 252))).unwrap();
        assert_eq!(inspect(&placement).persisted, None);
        assert_eq!(window.calls.lock().unwrap().positions, vec![(1484, 812)],
            "a header click must not cancel the accepted bottom resize");
        moved(&placement, 1484, 812);
        let confirmed = inspect(&placement).persisted.unwrap();
        assert_eq!((confirmed.generation, confirmed.corner, confirmed.frame.height),
            (receipt.generation, Some(Corner::BottomRight), 252));
    }

    #[test]
    fn accepted_resize_survives_manual_drag_and_delayed_native_size() {
        let bottom = PhysicalFrame { x: 1484, y: 1014, ..STRIP };
        let saved = PlacementSnapshot { generation: 1, corner: Some(Corner::BottomRight), frame: bottom };
        let (placement, window) = setup(bottom, Some(saved));
        placement.resize(252).unwrap().recv_timeout(Duration::from_secs(2)).unwrap().unwrap();
        placement.begin_drag().unwrap();
        moved(&placement, 700, 400);
        let manual = inspect(&placement).persisted.unwrap();
        assert_eq!((manual.corner, manual.frame.height), (None, 50));
        placement.on_window_event(&tauri::WindowEvent::Resized(PhysicalSize::new(420, 252))).unwrap();
        let confirmed = inspect(&placement).persisted.unwrap();
        assert_eq!(confirmed.frame, PhysicalFrame { x: 700, y: 400, width: 420, height: 252 },
            "manual position must retain the accepted size after its native arrival");
        assert_eq!(confirmed.corner, None);
        assert_eq!(window.calls.lock().unwrap().heights, vec![(420, 252)]);
        assert!(window.calls.lock().unwrap().positions.is_empty());
    }

    #[test]
    fn click_only_drag_keeps_size_intent_through_unmatched_resize_observation() {
        let bottom = PhysicalFrame { x: 1484, y: 1014, ..STRIP };
        let saved = PlacementSnapshot { generation: 1, corner: Some(Corner::BottomRight), frame: bottom };
        let (placement, window) = setup(bottom, Some(saved));
        placement.resize(252).unwrap().recv_timeout(Duration::from_secs(2)).unwrap().unwrap();
        placement.begin_drag().unwrap();
        placement.on_window_event(&tauri::WindowEvent::Resized(PhysicalSize::new(420, 300))).unwrap();
        assert_eq!(inspect(&placement).persisted, None);
        assert!(window.calls.lock().unwrap().positions.is_empty(),
            "an unrelated size observation cannot replace the accepted size during a header click");
        placement.on_window_event(&tauri::WindowEvent::Resized(PhysicalSize::new(420, 252))).unwrap();
        inspect(&placement);
        assert_eq!(window.calls.lock().unwrap().positions.last(), Some(&(1484, 812)));
        moved(&placement, 1484, 812);
        assert_eq!(inspect(&placement).persisted.unwrap().frame.height, 252);
    }

    #[test]
    fn manual_position_confirmation_keeps_pending_resize_watchdog_and_late_recovery() {
        let (placement, window) = setup_window(STRIP, None, vec![DISPLAY], 1.0,
            false, Duration::from_millis(100));
        placement.resize(252).unwrap().recv_timeout(Duration::from_secs(2)).unwrap().unwrap();
        placement.begin_drag().unwrap();
        moved(&placement, 700, 400);
        let manual = inspect(&placement).persisted.unwrap();
        wait_for_failures(&window, 1);
        let failed_generation = window.calls.lock().unwrap().unconfirmed[0].generation;
        assert!(failed_generation > manual.generation,
            "pending size failure must remain newer than the confirmed manual position");
        assert_eq!(inspect(&placement).persisted, Some(manual));
        placement.on_window_event(&tauri::WindowEvent::Resized(PhysicalSize::new(420, 252))).unwrap();
        let resized = inspect(&placement).persisted.unwrap();
        assert_eq!(resized.generation, failed_generation);
        assert_eq!(resized.frame, PhysicalFrame { x: 700, y: 400, width: 420, height: 252 });
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
    fn coalesced_latest_resize_confirms_and_late_obsolete_size_is_reasserted() {
        let (placement, window) = setup(STRIP, None);
        placement.resize(252).unwrap().recv_timeout(Duration::from_secs(2)).unwrap().unwrap();
        let latest = placement.resize(420).unwrap().recv_timeout(Duration::from_secs(2)).unwrap().unwrap();
        assert_eq!(inspect(&placement).persisted, None);
        placement.on_window_event(&tauri::WindowEvent::Resized(PhysicalSize::new(420, 420))).unwrap();
        let confirmed = inspect(&placement).persisted.expect("latest OS size should confirm despite coalescing");
        assert_eq!((confirmed.generation, confirmed.frame.height), (latest.generation, 420));
        placement.on_window_event(&tauri::WindowEvent::Resized(PhysicalSize::new(420, 252))).unwrap();
        assert_eq!(inspect(&placement).persisted, Some(confirmed));
        assert_eq!(window.calls.lock().unwrap().heights.last(), Some(&(420, 420)));
        placement.on_window_event(&tauri::WindowEvent::Resized(PhysicalSize::new(420, 420))).unwrap();
        assert_eq!(inspect(&placement).persisted, Some(confirmed));
    }

    #[test]
    fn obsolete_resize_after_manual_size_change_reasserts_current_intent() {
        let (placement, window) = setup(STRIP, None);
        placement.resize(252).unwrap().recv_timeout(Duration::from_secs(2)).unwrap().unwrap();
        placement.resize(420).unwrap().recv_timeout(Duration::from_secs(2)).unwrap().unwrap();
        placement.on_window_event(&tauri::WindowEvent::Resized(PhysicalSize::new(420, 420))).unwrap();
        inspect(&placement);
        placement.on_window_event(&tauri::WindowEvent::Resized(PhysicalSize::new(420, 300))).unwrap();
        let latest = inspect(&placement).persisted.unwrap();
        assert_eq!(latest.frame.height, 300);
        placement.on_window_event(&tauri::WindowEvent::Resized(PhysicalSize::new(420, 252))).unwrap();
        assert_eq!(inspect(&placement).persisted, Some(latest));
        assert_eq!(window.calls.lock().unwrap().heights.last(), Some(&(420, 300)),
            "reassertion must use current reducer intent rather than an old logical IPC cache");
        placement.on_window_event(&tauri::WindowEvent::Resized(PhysicalSize::new(420, 300))).unwrap();
        assert_eq!(inspect(&placement).persisted, Some(latest));
    }

    // Emulates runtime-wry's queued Size and Tao's conversion at execution;
    // setter execution deliberately emits no native observation.
    struct QueuedSizeWindow {
        inner: Arc<DeferredWindow>,
        sizes: Mutex<Vec<tauri::Size>>,
        scales: Mutex<std::collections::VecDeque<f64>>,
    }

    impl WindowPort for QueuedSizeWindow {
        fn displays(&self, observed: PhysicalFrame, scale: f64) -> Result<Vec<DisplayFrame>, String> {
            self.inner.displays(observed, scale)
        }

        fn scale_factor(&self) -> Result<f64, String> {
            self.scales.lock().unwrap().pop_front().map(Ok)
                .unwrap_or_else(|| self.inner.scale_factor())
        }

        fn dispatch(&self, effect: NativeEffect, feedback: Sender<WorkerMessage>) -> Result<(), String> {
            if let NativeEffect::SetHeight { size, .. } = &effect {
                self.sizes.lock().unwrap().push((*size).into());
            }
            self.inner.dispatch(effect, feedback)
        }
    }

    fn queued_size_setup() -> (PanelPlacement, Arc<QueuedSizeWindow>) {
        let inner = Arc::new(DeferredWindow {
            calls: Mutex::new(Calls::default()),
            displays: vec![DisplayFrame { width: 3840, height: 2160, scale_factor: 2.0, ..DISPLAY }],
            scale: Mutex::new(2.0), reject_position: false, reject_size: Mutex::new(false),
            current: Mutex::new(None), primary: None, consume_confirmation: true,
        });
        let window = Arc::new(QueuedSizeWindow {
            inner, sizes: Mutex::new(Vec::new()), scales: Mutex::new(std::collections::VecDeque::new()),
        });
        let placement = PanelPlacement::with_port(window.clone(),
            PhysicalFrame { x: 32, y: 32, width: 840, height: 100 }, None,
            Duration::from_secs(3)).unwrap();
        (placement, window)
    }

    #[test]
    fn queued_resize_keeps_logical_size_when_execution_crosses_from_2x_to_1x() {
        let (placement, window) = queued_size_setup();
        placement.resize(252).unwrap().recv_timeout(Duration::from_secs(2)).unwrap().unwrap();
        assert_eq!(inspect(&placement).persisted, None);
        *window.inner.scale.lock().unwrap() = 1.0;
        let executed = window.sizes.lock().unwrap().remove(0).to_physical::<u32>(1.0);
        assert_eq!(executed, PhysicalSize::new(420, 252), "queued logical request must survive execution DPI change");
        assert_eq!(inspect(&placement).persisted, None, "setter return is not native confirmation");
        placement.on_window_event(&tauri::WindowEvent::Resized(executed)).unwrap();
        let snapshot = inspect(&placement).persisted.unwrap();
        assert_eq!((snapshot.frame.width, snapshot.frame.height), (420, 252));
    }

    #[test]
    fn one_resize_uses_a_coherent_scale_for_conversion_and_reduction() {
        let (placement, window) = queued_size_setup();
        // The first getter sees 2x. A subsequent getter would see 1x; combining
        // them invents a size change for an actual logical-height no-op.
        window.scales.lock().unwrap().extend([2.0, 1.0]);
        placement.resize(50).unwrap().recv_timeout(Duration::from_secs(2)).unwrap().unwrap();
        let confirmed = inspect(&placement).persisted.expect("coherent verified no-op must confirm");
        assert_eq!(confirmed.frame, PhysicalFrame { x: 32, y: 32, width: 840, height: 100 });
        assert!(window.sizes.lock().unwrap().is_empty());
    }

    #[test]
    fn resize_display_geometry_uses_the_same_snapshot_as_size_conversion() {
        let (_, window) = queued_size_setup();
        let frame = PhysicalFrame { x: 2968, y: 32, width: 840, height: 100 };
        let saved = PlacementSnapshot { generation: 1, corner: Some(Corner::TopRight), frame };
        let placement = PanelPlacement::with_port(window.clone(), frame, Some(saved), Duration::from_secs(3)).unwrap();
        *window.inner.scale.lock().unwrap() = 1.0;
        window.scales.lock().unwrap().extend([2.0, 1.0]);
        placement.resize(50).unwrap().recv_timeout(Duration::from_secs(2)).unwrap().unwrap();
        let snapshot = inspect(&placement).persisted.expect("display bounds must use the request's 2x snapshot");
        assert_eq!(snapshot.frame, frame);
        assert!(window.inner.calls.lock().unwrap().positions.is_empty());
        assert!(window.sizes.lock().unwrap().is_empty());
    }

    #[test]
    fn queued_obsolete_resize_crossing_scale_reasserts_latest_confirmed_size() {
        let (placement, window) = queued_size_setup();
        placement.resize(252).unwrap().recv_timeout(Duration::from_secs(2)).unwrap().unwrap();
        placement.resize(420).unwrap().recv_timeout(Duration::from_secs(2)).unwrap().unwrap();
        *window.inner.scale.lock().unwrap() = 1.0;
        let latest = window.sizes.lock().unwrap().remove(1).to_physical::<u32>(1.0);
        assert_eq!(latest, PhysicalSize::new(420, 420));
        assert_eq!(inspect(&placement).persisted, None);
        placement.on_window_event(&tauri::WindowEvent::Resized(latest)).unwrap();
        inspect(&placement);
        placement.snap(Corner::TopLeft).unwrap();
        let confirmed = inspect(&placement).persisted.unwrap();
        assert_eq!(confirmed.corner, Some(Corner::TopLeft));
        let late = window.sizes.lock().unwrap().remove(0).to_physical::<u32>(1.0);
        assert_eq!(late, PhysicalSize::new(420, 252));
        placement.on_window_event(&tauri::WindowEvent::Resized(late)).unwrap();
        assert_eq!(inspect(&placement).persisted, Some(confirmed));
        let reasserted = window.sizes.lock().unwrap().remove(0).to_physical::<u32>(1.0);
        assert_eq!(reasserted, latest);
        assert_eq!(inspect(&placement).persisted, Some(confirmed));
        placement.on_window_event(&tauri::WindowEvent::Resized(reasserted)).unwrap();
        assert_eq!(inspect(&placement).persisted, Some(confirmed));
    }

    #[test]
    fn fractional_crossing_after_corner_noop_reconciles_late_obsolete_size() {
        let (placement, window) = queued_size_setup();
        *window.inner.scale.lock().unwrap() = 1.25;
        placement.resize(252).unwrap().recv_timeout(Duration::from_secs(2)).unwrap().unwrap();
        placement.resize(54).unwrap().recv_timeout(Duration::from_secs(2)).unwrap().unwrap();
        let latest = window.sizes.lock().unwrap().remove(1).to_physical::<u32>(1.25);
        assert_eq!(latest, PhysicalSize::new(525, 68));
        placement.on_window_event(&tauri::WindowEvent::Resized(latest)).unwrap();
        inspect(&placement);
        placement.snap(Corner::TopLeft).unwrap();
        inspect(&placement);
        moved(&placement, 20, 20);
        let confirmed = inspect(&placement).persisted.unwrap();
        assert_eq!(confirmed.corner, Some(Corner::TopLeft));
        assert_eq!(confirmed.frame.height, 68);

        // No latest-size observation at the new scale: the old setter executes
        // first after crossing, then native observation must confirm the exact
        // reasserted logical 54 rather than rescaling rounded physical 68.
        *window.inner.scale.lock().unwrap() = 1.5;
        let obsolete = window.sizes.lock().unwrap().remove(0).to_physical::<u32>(1.5);
        assert_eq!(obsolete, PhysicalSize::new(630, 378));
        placement.on_window_event(&tauri::WindowEvent::Resized(obsolete)).unwrap();
        assert_eq!(inspect(&placement).persisted, Some(confirmed));
        let reasserted = window.sizes.lock().unwrap().remove(0).to_physical::<u32>(1.5);
        assert_eq!(reasserted, PhysicalSize::new(630, 81));
        placement.on_window_event(&tauri::WindowEvent::Resized(reasserted)).unwrap();
        inspect(&placement);
        moved(&placement, 24, 24);
        let snapshot = inspect(&placement).persisted.unwrap();
        assert_eq!(snapshot.frame, PhysicalFrame { x: 24, y: 24, width: 630, height: 81 },
            "exact logical size observation must retire the pending size and confirm the corner");
        assert_eq!(snapshot.generation, confirmed.generation);
        assert!(window.sizes.lock().unwrap().is_empty(), "no duplicate size retry after arrival");
    }

    #[test]
    fn second_snap_after_fractional_crossing_preserves_exact_logical_size() {
        let (placement, window) = queued_size_setup();
        *window.inner.scale.lock().unwrap() = 1.25;
        placement.resize(252).unwrap().recv_timeout(Duration::from_secs(2)).unwrap().unwrap();
        placement.resize(54).unwrap().recv_timeout(Duration::from_secs(2)).unwrap().unwrap();
        let latest = window.sizes.lock().unwrap().remove(1).to_physical::<u32>(1.25);
        placement.on_window_event(&tauri::WindowEvent::Resized(latest)).unwrap();
        inspect(&placement);
        placement.snap(Corner::TopLeft).unwrap();
        inspect(&placement);
        moved(&placement, 20, 20);
        let confirmed = inspect(&placement).persisted.unwrap();
        assert_eq!(confirmed.frame.height, 68);

        // The new Snap precedes any new-scale size observation. Rescaling the
        // old observed 68 gives 82, but the preserved logical intent gives 81.
        *window.inner.scale.lock().unwrap() = 1.5;
        placement.snap(Corner::TopLeft).unwrap();
        inspect(&placement);
        let obsolete = window.sizes.lock().unwrap().remove(0).to_physical::<u32>(1.5);
        placement.on_window_event(&tauri::WindowEvent::Resized(obsolete)).unwrap();
        assert_eq!(inspect(&placement).persisted, Some(confirmed));
        let reasserted = window.sizes.lock().unwrap().remove(0).to_physical::<u32>(1.5);
        assert_eq!(reasserted, PhysicalSize::new(630, 81));
        placement.on_window_event(&tauri::WindowEvent::Resized(reasserted)).unwrap();
        inspect(&placement);
        moved(&placement, 24, 24);
        let snapshot = inspect(&placement).persisted.unwrap();
        assert_eq!(snapshot.frame, PhysicalFrame { x: 24, y: 24, width: 630, height: 81 },
            "the second Snap must preserve exact logical dimensions until native arrival");
        assert_eq!(snapshot.generation, confirmed.generation + 1);
        assert!(window.sizes.lock().unwrap().is_empty());
    }

    #[test]
    fn queued_fractional_scale_resize_confirms_exact_logical_intent_after_crossing() {
        let (placement, window) = queued_size_setup();
        *window.inner.scale.lock().unwrap() = 1.25;
        placement.resize(54).unwrap().recv_timeout(Duration::from_secs(2)).unwrap().unwrap();
        *window.inner.scale.lock().unwrap() = 1.5;
        let executed = window.sizes.lock().unwrap().remove(0).to_physical::<u32>(1.5);
        assert_eq!(executed, PhysicalSize::new(630, 81));
        placement.on_window_event(&tauri::WindowEvent::Resized(executed)).unwrap();
        let snapshot = inspect(&placement).persisted.expect("rounding physical dimensions must not change logical intent");
        assert_eq!((snapshot.frame.width, snapshot.frame.height), (630, 81));
    }

    #[test]
    fn deferred_stale_resize_reasserts_latest_height_without_persisting_old_size() {
        let bottom = PhysicalFrame { x: 1484, y: 1014, ..STRIP };
        let saved = PlacementSnapshot { generation: 1, corner: Some(Corner::BottomRight), frame: bottom };
        let (placement, window) = setup(bottom, Some(saved));
        assert_eq!(placement.resize(420).unwrap().recv_timeout(Duration::from_secs(2)).unwrap().unwrap().generation, 2);
        assert_eq!(placement.resize(50).unwrap().recv_timeout(Duration::from_secs(2)).unwrap().unwrap().generation, 3);
        assert_eq!(inspect(&placement).confirmed, Some(saved));
        placement.on_window_event(&tauri::WindowEvent::Resized(PhysicalSize::new(420, 420))).unwrap();
        assert_eq!(inspect(&placement).confirmed, Some(saved));
        assert_eq!(window.calls.lock().unwrap().heights.last(), Some(&(420, 50)));
        placement.on_window_event(&tauri::WindowEvent::Resized(PhysicalSize::new(420, 50))).unwrap();
        let snapshot = inspect(&placement).confirmed.unwrap();
        assert_eq!((snapshot.generation, snapshot.frame.height), (3, 50));
        assert!(window.calls.lock().unwrap().confirmed.iter().all(|value| value.frame.height != 420));
    }

    #[test]
    fn rejected_size_setter_does_not_prevent_a_later_explicit_retry() {
        let (placement, window) = setup(STRIP, None);
        *window.reject_size.lock().unwrap() = true;
        placement.resize(252).unwrap().recv_timeout(Duration::from_secs(2)).unwrap().unwrap();
        inspect(&placement);
        assert!(window.calls.lock().unwrap().heights.is_empty());
        assert_eq!(window.calls.lock().unwrap().unconfirmed.len(), 1);
        *window.reject_size.lock().unwrap() = false;
        placement.resize(252).unwrap().recv_timeout(Duration::from_secs(2)).unwrap().unwrap();
        inspect(&placement);
        assert_eq!(window.calls.lock().unwrap().heights, vec![(420, 252)]);
        placement.on_window_event(&tauri::WindowEvent::Resized(PhysicalSize::new(420, 252))).unwrap();
        assert_eq!(inspect(&placement).confirmed.unwrap().frame.height, 252);
    }

    #[test]
    fn resize_restores_420_logical_width_and_waits_for_observed_size() {
        let frame = PhysicalFrame { width: 560, ..STRIP };
        let (placement, window) = setup(frame, None);
        let receipt = placement.resize(252).unwrap().recv_timeout(Duration::from_secs(2)).unwrap().unwrap();
        assert_eq!(window.calls.lock().unwrap().heights, vec![(420, 252)]);
        assert_eq!(inspect(&placement).confirmed, None);
        placement.on_window_event(&tauri::WindowEvent::Resized(PhysicalSize::new(420, 252))).unwrap();
        assert_eq!(inspect(&placement).confirmed.unwrap().generation, receipt.generation);
        assert_eq!(inspect(&placement).confirmed.unwrap().frame.width, 420);
    }

    #[test]
    fn mixed_scale_current_display_wins_over_overlapping_foreign_physical_rectangle() {
        // Tao's macOS monitor coordinates use each monitor's own backing
        // scale; the window event and setter use the window's current scale.
        let primary_raw = DisplayFrame { x: 0, y: 0, width: 3840, height: 2160, scale_factor: 2.0 };
        let external_raw = DisplayFrame { x: 1440, y: 0, width: 1920, height: 1080, scale_factor: 1.0 };
        let current_scale = 1.0;
        let observed = PhysicalFrame { x: 1500, y: 200, width: 420, height: 50 };
        let normalized = ordered_displays(observed, vec![primary_raw, external_raw],
            Some(external_raw), Some(primary_raw), current_scale);
        assert_eq!(normalized[0], external_raw);
        assert_eq!(normalized[1], DisplayFrame {
            x: 0, y: 0, width: 1920, height: 1080, scale_factor: 1.0,
        });
        let mut machine = PlacementMachine::new(observed, None);
        assert!(machine.reduce(PlacementInput::Snap(Corner::BottomRight), &normalized).contains(
            &PlacementEffect::SetPosition { generation: 1, x: 2924, y: 1014 }));
    }

    #[test]
    fn crossing_from_2x_primary_to_1x_external_uses_new_window_scale_and_current_monitor() {
        let primary_raw = DisplayFrame { x: 0, y: 0, width: 2880, height: 1800, scale_factor: 2.0 };
        let external_raw = DisplayFrame { x: 1440, y: 0, width: 1920, height: 1080, scale_factor: 1.0 };
        let window = Arc::new(DeferredWindow {
            calls: Mutex::new(Calls::default()), displays: vec![primary_raw, external_raw],
            scale: Mutex::new(2.0), reject_position: false, reject_size: Mutex::new(false),
            current: Mutex::new(Some(primary_raw)), primary: Some(primary_raw),
            consume_confirmation: true,
        });
        let frame = PhysicalFrame { x: 32, y: 32, width: 840, height: 100 };
        let placement = PanelPlacement::with_port(window.clone(), frame, None, Duration::from_secs(3)).unwrap();
        placement.begin_drag().unwrap();
        inspect(&placement);
        *window.current.lock().unwrap() = Some(external_raw);
        *window.scale.lock().unwrap() = 1.0;
        moved(&placement, 1500, 200);
        let free = inspect(&placement).confirmed.unwrap();
        assert_eq!(free.frame, PhysicalFrame { x: 1500, y: 200, width: 420, height: 50 });
        assert_eq!(free.corner, None);
        placement.snap(Corner::TopRight).unwrap();
        inspect(&placement);
        assert_eq!(window.calls.lock().unwrap().positions.last(), Some(&(2924, 16)));
        moved(&placement, 2924, 16);
        let snapped = inspect(&placement).confirmed.unwrap();
        assert_eq!(snapped.corner, Some(Corner::TopRight));
        assert_eq!(snapped.frame.width, 420);
    }

    #[test]
    fn delayed_setter_after_scale_change_reasserts_original_display_in_current_units() {
        let primary_raw = DisplayFrame { x: 0, y: 0, width: 2880, height: 1800, scale_factor: 2.0 };
        let external_raw = DisplayFrame { x: 1440, y: 0, width: 1920, height: 1080, scale_factor: 1.0 };
        let window = Arc::new(DeferredWindow {
            calls: Mutex::new(Calls::default()), displays: vec![primary_raw, external_raw],
            scale: Mutex::new(2.0), reject_position: false, reject_size: Mutex::new(false),
            current: Mutex::new(Some(primary_raw)), primary: Some(primary_raw),
            consume_confirmation: true,
        });
        let frame = PhysicalFrame { x: 32, y: 32, width: 840, height: 100 };
        let placement = PanelPlacement::with_port(window.clone(), frame, None, Duration::from_secs(3)).unwrap();
        placement.snap(Corner::TopRight).unwrap();
        inspect(&placement);
        assert_eq!(window.calls.lock().unwrap().positions, vec![(2008, 32)]);
        // A delayed setter executes after the window's scale changed from 2
        // to 1, so its physical 2008 is interpreted as 2008 logical points.
        *window.current.lock().unwrap() = Some(external_raw);
        *window.scale.lock().unwrap() = 1.0;
        moved(&placement, 2008, 32);
        assert_eq!(inspect(&placement).confirmed, None);
        assert_eq!(window.calls.lock().unwrap().positions.last(), Some(&(1004, 16)));
        *window.current.lock().unwrap() = Some(primary_raw);
        *window.scale.lock().unwrap() = 2.0;
        moved(&placement, 2008, 32);
        assert_eq!(inspect(&placement).confirmed.unwrap().corner, Some(Corner::TopRight));
    }

    #[test]
    fn logical_height_is_converted_once_but_native_resize_is_already_physical() {
        let scaled = PhysicalFrame { x: 32, y: 32, width: 840, height: 100 };
        let (placement, window) = setup_window(scaled, None,
            vec![DisplayFrame { width: 3840, height: 2160, scale_factor: 2.0, ..DISPLAY }],
            2.0, false, Duration::from_secs(3));
        placement.resize(252).unwrap().recv_timeout(Duration::from_secs(2)).unwrap().unwrap();
        assert_eq!(window.calls.lock().unwrap().heights, vec![(840, 504)]);
        placement.on_window_event(&tauri::WindowEvent::Resized(PhysicalSize::new(840, 504))).unwrap();
        inspect(&placement);
        assert_eq!(window.calls.lock().unwrap().confirmed[0].frame.width, 840);
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
    fn ordered_displays_prefer_current_then_observed_then_primary() {
        let other = DisplayFrame { x: -1920, ..DISPLAY };
        let far = DisplayFrame { x: 4000, ..DISPLAY };
        assert_eq!(ordered_displays(STRIP, vec![other, DISPLAY, far], Some(other), Some(far), 1.0), vec![other, DISPLAY, far]);
        let offscreen = PhysicalFrame { x: 8000, ..STRIP };
        assert_eq!(ordered_displays(offscreen, vec![far, DISPLAY, other], Some(other), Some(DISPLAY), 1.0), vec![other, DISPLAY, far]);
    }

    #[test]
    fn legacy_restore_is_idempotent_and_waits_for_observed_location() {
        let (placement, window) = setup(STRIP, None);
        let legacy = LegacyPlacement { position: PhysicalPosition::new(310, 205), corner: Some(Corner::BottomLeft) };
        placement.restore(Some(legacy)).unwrap();
        placement.restore(Some(legacy)).unwrap();
        let state = inspect(&placement);
        assert_eq!(state.legacy, Some(legacy));
        assert_eq!(state.confirmed, None);
        assert_eq!(state.persisted, None);
        assert_eq!(window.calls.lock().unwrap().positions, vec![(310, 205)]);
        moved(&placement, 310, 205);
        assert_eq!(window.calls.lock().unwrap().positions, vec![(310, 205), (16, 1014)]);
        assert_eq!(inspect(&placement).persisted, None);
        moved(&placement, 16, 1014);
        assert_eq!(inspect(&placement).persisted.unwrap().corner, Some(Corner::BottomLeft));
    }

    fn setup_store(
        frame: PhysicalFrame, store: Arc<PlacementStore>, displays: Vec<DisplayFrame>,
        current: Option<DisplayFrame>, primary: Option<DisplayFrame>, consume_confirmation: bool,
    ) -> (PanelPlacement, Arc<DeferredWindow>) {
        setup_store_at_scale(frame, store, displays, current, primary, consume_confirmation, 1.0)
    }

    fn setup_store_at_scale(
        frame: PhysicalFrame, store: Arc<PlacementStore>, displays: Vec<DisplayFrame>,
        current: Option<DisplayFrame>, primary: Option<DisplayFrame>, consume_confirmation: bool, scale: f64,
    ) -> (PanelPlacement, Arc<DeferredWindow>) {
        let window = Arc::new(DeferredWindow {
            calls: Mutex::new(Calls::default()), displays, scale: Mutex::new(scale), reject_position: false,
            reject_size: Mutex::new(false),
            current: Mutex::new(current), primary, consume_confirmation,
        });
        let placement = PanelPlacement::with_port_and_store(
            window.clone(), frame, None, Duration::from_secs(3), Some(store),
        ).unwrap();
        (placement, window)
    }

    #[test]
    fn mixed_dpi_restart_restores_saved_display_in_startup_window_coordinates() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("placement.json");
        let primary = DisplayFrame { width: 2880, height: 1800, scale_factor: 2.0, ..DISPLAY };
        let external = DisplayFrame { x: 1440, ..DISPLAY };
        let inventory = vec![primary, external];
        let frame = PhysicalFrame { x: 1456, y: 16, ..STRIP };
        let store = Arc::new(PlacementStore::new(path.clone()));
        let (first, _) = setup_store(frame, store.clone(), inventory.clone(), Some(external), Some(primary), true);
        first.snap(Corner::TopLeft).unwrap();
        assert_eq!(inspect(&first).persisted.unwrap().frame, frame);
        drop(first);

        let restarted_store = Arc::new(PlacementStore::new(path));
        let startup = PhysicalFrame { x: 32, y: 32, width: 840, height: 100 };
        let (restarted, window) = setup_store_at_scale(startup, restarted_store.clone(), inventory,
            Some(primary), Some(primary), true, 2.0);
        restarted.restore(None).unwrap();
        assert_eq!(inspect(&restarted).persisted, None);
        assert_eq!(window.calls.lock().unwrap().positions, vec![(2912, 32)],
            "saved 1x external x1456 must restore beyond the 2x primary ending at x2880");
        // Crossing onto the external changes the observation plane back to 1x.
        *window.scale.lock().unwrap() = 1.0;
        *window.current.lock().unwrap() = Some(external);
        moved(&restarted, 1456, 16);
        let confirmed = inspect(&restarted).persisted.unwrap();
        assert_eq!((confirmed.corner, confirmed.frame), (Some(Corner::TopLeft), frame));
        assert!(matches!(restarted_store.load().unwrap(), LoadOutcome::Stored(record)
            if record.position.x == 1456 && record.scale_factor == Some(1.0)));
    }

    #[test]
    fn mixed_dpi_restart_from_2x_external_to_1x_startup_saves_observed_scale() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("placement.json");
        let primary = DisplayFrame { width: 1440, height: 900, ..DISPLAY };
        let external = DisplayFrame { x: 2880, width: 3840, height: 2160, scale_factor: 2.0, ..DISPLAY };
        let inventory = vec![primary, external];
        let frame = PhysicalFrame { x: 2912, y: 32, width: 840, height: 100 };
        let store = Arc::new(PlacementStore::new(path.clone()));
        let (first, _) = setup_store_at_scale(frame, store.clone(), inventory.clone(),
            Some(external), Some(primary), true, 2.0);
        first.snap(Corner::TopLeft).unwrap();
        assert_eq!(inspect(&first).persisted.unwrap().frame, frame);
        assert!(matches!(store.load().unwrap(), LoadOutcome::Stored(record)
            if record.scale_factor == Some(2.0) && record.position.x == 2912));
        drop(first);

        let restarted_store = Arc::new(PlacementStore::new(path));
        let (restarted, window) = setup_store(STRIP, restarted_store.clone(), inventory,
            Some(primary), Some(primary), true);
        restarted.restore(None).unwrap();
        assert_eq!(inspect(&restarted).persisted, None);
        assert_eq!(window.calls.lock().unwrap().positions, vec![(1456, 16)]);
        *window.scale.lock().unwrap() = 2.0;
        *window.current.lock().unwrap() = Some(external);
        moved(&restarted, 2912, 32);
        assert_eq!(inspect(&restarted).persisted.unwrap().frame, frame);
        assert!(matches!(restarted_store.load().unwrap(), LoadOutcome::Stored(record)
            if record.scale_factor == Some(2.0) && record.position.x == 2912));
    }

    #[test]
    fn scale_less_v1_restores_best_effort_and_reports_unrecoverable_basis() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("placement.json");
        let bytes = br#"{"version":1,"position":{"x":1456,"y":16},"corner":null}"#;
        std::fs::write(&path, bytes).unwrap();
        let store = Arc::new(PlacementStore::new(path.clone()));
        let primary = DisplayFrame { width: 2880, height: 1800, scale_factor: 2.0, ..DISPLAY };
        let external = DisplayFrame { x: 1440, ..DISPLAY };
        let (placement, window) = setup_store_at_scale(
            PhysicalFrame { x: 32, y: 32, width: 840, height: 100 }, store.clone(),
            vec![primary, external], Some(primary), Some(primary), true, 2.0);
        placement.restore(None).unwrap();
        assert_eq!(inspect(&placement).persisted, None);
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
        let calls = window.calls.lock().unwrap();
        assert_eq!(calls.positions, vec![(1456, 16)]);
        assert_eq!(calls.persistence_errors.len(), 1);
        assert!(calls.persistence_errors[0].1.contains("same-display recovery cannot be guaranteed"));
        drop(calls);
        moved(&placement, 1456, 16);
        assert_eq!(inspect(&placement).persisted.unwrap().corner, None);
        assert!(matches!(store.load().unwrap(), LoadOutcome::Stored(record)
            if record.scale_factor == Some(2.0) && record.position.x == 1456));
    }

    #[test]
    fn unsupported_native_record_is_preserved_until_explicit_migration_is_observed() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("placement.json");
        let bytes = br#"{"version":2,"position":{"x":1456,"y":16},"corner":null}"#;
        std::fs::write(&path, bytes).unwrap();
        let store = Arc::new(PlacementStore::new(path.clone()));
        let (placement, window) = setup_store(STRIP, store.clone(), vec![DISPLAY], None, Some(DISPLAY), true);
        placement.restore(Some(LegacyPlacement { position: PhysicalPosition::new(310, 205), corner: None })).unwrap();
        assert_eq!(inspect(&placement).persisted, None);
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
        assert!(window.calls.lock().unwrap().persistence_errors[0].1.contains("unsupported placement version 2"));
        moved(&placement, 310, 205);
        assert!(matches!(store.load().unwrap(), LoadOutcome::Stored(record)
            if record.position.x == 310 && record.scale_factor == Some(1.0)));
    }

    #[test]
    fn native_record_beats_legacy_and_restores_negative_monitor_before_corner() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("placement.json");
        let seed = PlacementSnapshot { generation: 77, corner: Some(Corner::BottomLeft),
            frame: PhysicalFrame { x: -1904, y: 500, width: 800, height: 600 } };
        PlacementStore::new(path.clone()).save_confirmed(&seed).unwrap();
        let store = Arc::new(PlacementStore::new(path));
        let frame = PhysicalFrame { height: 252, ..STRIP };
        let (placement, window) = setup_store(frame, store.clone(),
            vec![DISPLAY, DisplayFrame { x: -1920, ..DISPLAY }], Some(DISPLAY), Some(DISPLAY), true);
        placement.restore(Some(LegacyPlacement { position: PhysicalPosition::new(310, 205), corner: None })).unwrap();
        placement.restore(None).unwrap();
        let snapshot = inspect(&placement);
        assert_eq!(snapshot.legacy, None);
        assert_eq!(snapshot.confirmed, None);
        assert_eq!(window.calls.lock().unwrap().positions, vec![(-1904, 500)]);
        moved(&placement, -1904, 500);
        assert_eq!(window.calls.lock().unwrap().positions, vec![(-1904, 500), (-1904, 812)]);
        assert_eq!(inspect(&placement).persisted, None);
        assert!(matches!(store.load().unwrap(), LoadOutcome::Stored(record) if record.position.y == 500));
        moved(&placement, -1904, 812);
        let confirmed = inspect(&placement).confirmed.unwrap();
        assert_eq!(confirmed.generation, 1);
        assert_eq!(confirmed.frame, PhysicalFrame { x: -1904, y: 812, width: 420, height: 252 });
        assert!(matches!(store.load().unwrap(), LoadOutcome::Stored(record)
            if record.position.y == 812 && record.corner == Some(Corner::BottomLeft)));
        placement.restore(Some(LegacyPlacement { position: PhysicalPosition::new(1, 2), corner: None })).unwrap();
        inspect(&placement);
        assert_eq!(window.calls.lock().unwrap().positions.len(), 2);
    }

    #[test]
    fn missing_and_corrupt_native_storage_migrate_only_after_confirmation() {
        for corrupt in [false, true] {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("placement.json");
            if corrupt { std::fs::write(&path, b"{invalid").unwrap(); }
            let store = Arc::new(PlacementStore::new(path.clone()));
            let (placement, window) = setup_store(STRIP, store.clone(), vec![DISPLAY], None, Some(DISPLAY), true);
            let legacy = LegacyPlacement { position: PhysicalPosition::new(310, 205), corner: None };
            placement.restore(Some(legacy)).unwrap();
            placement.restore(Some(LegacyPlacement { position: PhysicalPosition::new(1, 2), corner: None })).unwrap();
            assert_eq!(inspect(&placement).legacy, Some(legacy));
            assert_eq!(window.calls.lock().unwrap().positions, vec![(310, 205)]);
            if corrupt { assert_eq!(std::fs::read(&path).unwrap(), b"{invalid"); }
            else { assert!(!path.exists()); }
            moved(&placement, 310, 205);
            assert!(matches!(store.load().unwrap(), LoadOutcome::Stored(record)
                if record.position.x == 310 && record.corner == None));
            if corrupt { assert_eq!(window.calls.lock().unwrap().persistence_errors.len(), 1); }
        }
    }

    #[test]
    fn missing_monitor_uses_current_then_primary_fallback_without_offscreen_claim() {
        for current in [Some(DisplayFrame { x: 4000, ..DISPLAY }), None] {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("placement.json");
            PlacementStore::new(path.clone()).save_confirmed(&PlacementSnapshot {
                generation: 8, corner: Some(Corner::BottomLeft),
                frame: PhysicalFrame { x: -1904, y: 812, ..STRIP },
            }).unwrap();
            let far = DisplayFrame { x: 4000, ..DISPLAY };
            let store = Arc::new(PlacementStore::new(path));
            let (placement, window) = setup_store(STRIP, store, vec![DISPLAY, far], current, Some(DISPLAY), true);
            placement.restore(None).unwrap();
            assert_eq!(inspect(&placement).confirmed, None);
            let target = if current.is_some() { (4016, 1014) } else { (16, 1014) };
            assert_eq!(window.calls.lock().unwrap().positions, vec![target]);
            moved(&placement, target.0, target.1);
            assert_eq!(inspect(&placement).confirmed.unwrap().corner, Some(Corner::BottomLeft));
        }
    }

    #[test]
    fn native_restore_noop_confirms_without_moved_and_keeps_current_dimensions() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("placement.json");
        PlacementStore::new(path.clone()).save_confirmed(&PlacementSnapshot {
            generation: 99, corner: Some(Corner::BottomLeft),
            frame: PhysicalFrame { x: -1904, y: 812, width: 600, height: 400 },
        }).unwrap();
        let frame = PhysicalFrame { x: -1904, y: 812, width: 420, height: 252 };
        let store = Arc::new(PlacementStore::new(path));
        let (placement, window) = setup_store(frame, store, vec![DisplayFrame { x: -1920, ..DISPLAY }], None, None, true);
        placement.restore(None).unwrap();
        let snapshot = inspect(&placement).persisted.unwrap();
        assert_eq!(snapshot.frame, frame);
        assert_eq!(snapshot.generation, 1);
        assert!(window.calls.lock().unwrap().positions.is_empty());
        assert_eq!(window.calls.lock().unwrap().confirmed.len(), 1);
    }

    #[test]
    fn hidden_confirmation_persists_without_frontend_listener() {
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(PlacementStore::new(dir.path().join("placement.json")));
        let (placement, window) = setup_store(STRIP, store.clone(), vec![DISPLAY], None, None, false);
        placement.snap(Corner::BottomLeft).unwrap();
        inspect(&placement);
        assert_eq!(store.load().unwrap(), LoadOutcome::Missing);
        moved(&placement, 16, 1014);
        assert!(window.calls.lock().unwrap().confirmed.is_empty());
        assert!(matches!(store.load().unwrap(), LoadOutcome::Stored(record)
            if record.position.y == 1014 && record.corner == Some(Corner::BottomLeft)));
    }

    #[test]
    fn rejected_directory_write_reports_storage_error_without_reverting_confirmation() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("placement.json");
        std::fs::create_dir(&path).unwrap();
        let store = Arc::new(PlacementStore::new(path.clone()));
        let (placement, window) = setup_store(STRIP, store, vec![DISPLAY], None, None, true);
        placement.snap(Corner::BottomLeft).unwrap();
        moved(&placement, 16, 1014);
        let state = inspect(&placement);
        assert_eq!(state.confirmed.unwrap().frame.y, 1014);
        assert_eq!(state.persisted, None);
        let calls = window.calls.lock().unwrap();
        assert!(calls.unconfirmed.is_empty());
        assert_eq!(calls.confirmed.len(), 1);
        assert_eq!(calls.persistence_errors.last().unwrap().0, 1);
        assert!(path.is_dir());
    }

    #[test]
    fn absent_native_and_legacy_defaults_once_to_top_right_after_subscription() {
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(PlacementStore::new(dir.path().join("placement.json")));
        let (placement, window) = setup_store(STRIP, store.clone(), vec![DISPLAY], None, None, true);
        assert!(window.calls.lock().unwrap().positions.is_empty());
        placement.restore(None).unwrap();
        placement.restore(None).unwrap();
        assert_eq!(inspect(&placement).confirmed, None);
        assert_eq!(window.calls.lock().unwrap().positions, vec![(1484, 16)]);
        assert_eq!(store.load().unwrap(), LoadOutcome::Missing);
        moved(&placement, 1484, 16);
        assert_eq!(inspect(&placement).confirmed.unwrap().corner, Some(Corner::TopRight));
        assert!(matches!(store.load().unwrap(), LoadOutcome::Stored(record)
            if record.position.x == 1484 && record.corner == Some(Corner::TopRight)));
    }

    #[test]
    fn stale_native_event_cannot_overwrite_latest_durable_free_drag() {
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(PlacementStore::new(dir.path().join("placement.json")));
        let (placement, window) = setup_store(STRIP, store.clone(), vec![DISPLAY], None, None, false);
        placement.snap(Corner::TopRight).unwrap();
        placement.begin_drag().unwrap();
        moved(&placement, 310, 205);
        moved(&placement, 320, 215);
        moved(&placement, 1484, 16);
        assert_eq!(window.calls.lock().unwrap().positions.last(), Some(&(320, 215)));
        assert!(matches!(store.load().unwrap(), LoadOutcome::Stored(record)
            if record.position.x == 320 && record.position.y == 215 && record.corner == None));
    }

    #[test]
    fn storage_read_error_does_not_accept_legacy_as_missing_or_corrupt() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("placement.json");
        std::fs::create_dir(&path).unwrap();
        let store = Arc::new(PlacementStore::new(path));
        let (placement, window) = setup_store(STRIP, store, vec![DISPLAY], None, None, true);
        placement.restore(Some(LegacyPlacement { position: PhysicalPosition::new(310, 205), corner: None })).unwrap();
        placement.restore(None).unwrap();
        assert_eq!(inspect(&placement).legacy, None);
        assert_eq!(inspect(&placement).confirmed, None);
        let calls = window.calls.lock().unwrap();
        assert!(calls.positions.is_empty());
        assert_eq!(calls.persistence_errors.len(), 1);
    }

    #[test]
    fn startup_native_resize_cannot_replace_corrupt_record_before_restore() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("placement.json");
        std::fs::write(&path, b"{invalid").unwrap();
        let store = Arc::new(PlacementStore::new(path.clone()));
        let (placement, window) = setup_store(STRIP, store, vec![DISPLAY], None, None, true);
        placement.on_window_event(&tauri::WindowEvent::Resized(PhysicalSize::new(420, 252))).unwrap();
        inspect(&placement);
        assert_eq!(std::fs::read(&path).unwrap(), b"{invalid");
        assert!(window.calls.lock().unwrap().confirmed.is_empty());
        placement.restore(Some(LegacyPlacement { position: PhysicalPosition::new(310, 205), corner: None })).unwrap();
        inspect(&placement);
        assert_eq!(std::fs::read(&path).unwrap(), b"{invalid");
        moved(&placement, 310, 205);
        assert_eq!(inspect(&placement).persisted.unwrap().frame.height, 252);
    }
}
