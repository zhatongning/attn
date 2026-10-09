use std::collections::VecDeque;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Corner {
    TopLeft,
    TopRight,
    BottomRight,
    BottomLeft,
}

impl Corner {
    fn next_clockwise(self) -> Self {
        match self {
            Self::TopLeft => Self::TopRight,
            Self::TopRight => Self::BottomRight,
            Self::BottomRight => Self::BottomLeft,
            Self::BottomLeft => Self::TopLeft,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct PhysicalFrame {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DisplayFrame {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub scale_factor: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct PlacementSnapshot {
    pub generation: u64,
    pub corner: Option<Corner>,
    pub frame: PhysicalFrame,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlacementInput {
    CyclePressed,
    CycleReleased,
    Snap(Corner),
    RestorePosition { x: i32, y: i32, corner: Option<Corner> },
    /// Dimensions are physical pixels, like the native Resized observation.
    ResizeRequested { width: u32, height: u32 },
    BeginDrag,
    Moved { x: i32, y: i32 },
    Resized { width: u32, height: u32 },
    TimedOut(u64),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlacementEffect {
    SetPosition { generation: u64, x: i32, y: i32 },
    SetHeight { generation: u64, height: u32 },
    Confirm(PlacementSnapshot),
    Persist(PlacementSnapshot),
    ReportUnconfirmed(u64),
    ScheduleWatchdog(u64),
}

#[derive(Debug, Clone, Copy)]
struct Target {
    generation: u64,
    corner: Option<Corner>,
    frame: PhysicalFrame,
    required_width: Option<u32>,
    required_height: Option<u32>,
    logical_size: Option<(u32, u32)>,
    display: Option<DisplayFrame>,
}

#[derive(Debug, Clone, Copy)]
struct PendingMove {
    generation: u64,
    x: i32,
    y: i32,
    from_restore: bool,
}

#[derive(Debug, Clone, Copy)]
struct PendingSize {
    generation: u64,
    width: u32,
    height: u32,
    logical_size: Option<(u32, u32)>,
}

/// Setters are requests. Only native observations (or a verified no-op) confirm.
pub struct PlacementMachine {
    observed: PhysicalFrame,
    confirmed: Option<PlacementSnapshot>,
    desired: Option<Target>,
    generation: u64,
    pending: VecDeque<PendingMove>,
    pending_sizes: VecDeque<PendingSize>,
    // Obsolete requests no longer block observed no-ops. Keep their coordinates
    // until an arrival is seen so truly late native moves cannot become manual.
    retired: VecDeque<PendingMove>,
    retired_sizes: VecDeque<PendingSize>,
    held: bool,
    dragging: bool,
    drag_moved: bool,
    drag_generation: u64,
    drag_interrupted: bool,
    waiting: bool,
    // Some(None) restores a free position. Some(Some(corner)) first restores
    // the display location, then anchors against the observed current size.
    restoring: Option<Option<Corner>>,
}

impl PlacementMachine {
    pub fn new(observed: PhysicalFrame, saved: Option<PlacementSnapshot>) -> Self {
        Self {
            observed,
            confirmed: saved,
            desired: None,
            generation: saved.map_or(0, |snapshot| snapshot.generation),
            pending: VecDeque::new(),
            pending_sizes: VecDeque::new(),
            retired: VecDeque::new(),
            retired_sizes: VecDeque::new(),
            held: false,
            dragging: false,
            drag_moved: false,
            drag_generation: 0,
            drag_interrupted: false,
            waiting: false,
            restoring: None,
        }
    }

    pub fn confirmed(&self) -> Option<PlacementSnapshot> {
        self.confirmed
    }

    pub fn observed(&self) -> PhysicalFrame {
        self.observed
    }

    pub fn requested_width(&self) -> u32 {
        self.desired.and_then(|target| target.required_width).unwrap_or(self.observed.width)
    }

    pub fn requested_logical_size(&self) -> Option<(u32, u32)> {
        self.desired.and_then(|target| target.logical_size)
    }

    /// Tag an accepted physical request with its exact IPC dimensions. Keep
    /// each superseded setter's dimensions too, for late-arrival provenance.
    pub fn remember_logical_size(&mut self, width: u32, height: u32) {
        if let Some(target) = self.desired.as_mut() {
            target.logical_size = Some((width, height));
            for pending in self.pending_sizes.iter_mut()
                .filter(|pending| pending.generation == target.generation)
            {
                pending.logical_size = target.logical_size;
            }
        }
    }

    pub fn size_dispatch_failed(&mut self, generation: u64) {
        // A rejected setter cannot produce a native resize observation. Keep
        // the desired size, but let the next explicit request issue a retry.
        self.pending_sizes.retain(|pending| pending.generation != generation);
    }

    /// Tao reports the whole virtual desktop using the window's current
    /// backing scale. When the window crosses displays, normalize outstanding
    /// intents to the scale of the next native observation before reducing it.
    pub fn rescale(&mut self, old_scale: f64, new_scale: f64) {
        if !old_scale.is_finite() || old_scale <= 0.0
            || !new_scale.is_finite() || new_scale <= 0.0 || old_scale == new_scale
        {
            return;
        }
        self.observed = rescale_frame(self.observed, old_scale, new_scale);
        if let Some(snapshot) = self.confirmed.as_mut() {
            snapshot.frame = rescale_frame(snapshot.frame, old_scale, new_scale);
        }
        if let Some(target) = self.desired.as_mut() {
            target.frame = rescale_frame(target.frame, old_scale, new_scale);
            target.required_width = target.required_width
                .map(|width| rescale_dimension(width, old_scale, new_scale));
            target.required_height = target.required_height
                .map(|height| rescale_dimension(height, old_scale, new_scale));
            if let Some((width, height)) = target.logical_size {
                // A satisfied corner no-op clears required dimensions but
                // keeps logical intent for late resize reconciliation. Its
                // frame must share that exact conversion, rather than scaling
                // an already-rounded observed dimension a second time.
                target.frame.width = logical_dimension(width, new_scale);
                target.frame.height = logical_dimension(height, new_scale);
                target.required_width = target.required_width.map(|_| logical_dimension(width, new_scale));
                target.required_height = target.required_height.map(|_| logical_dimension(height, new_scale));
            }
            if let Some(display) = target.display.as_mut() {
                *display = rescale_display(*display, old_scale, new_scale);
            }
        }
        for pending in self.pending.iter_mut().chain(self.retired.iter_mut()) {
            pending.x = rescale_coordinate(pending.x, old_scale, new_scale);
            pending.y = rescale_coordinate(pending.y, old_scale, new_scale);
        }
        for pending in self.pending_sizes.iter_mut().chain(self.retired_sizes.iter_mut()) {
            if let Some((width, height)) = pending.logical_size {
                pending.width = logical_dimension(width, new_scale);
                pending.height = logical_dimension(height, new_scale);
            } else {
                pending.width = rescale_dimension(pending.width, old_scale, new_scale);
                pending.height = rescale_dimension(pending.height, old_scale, new_scale);
            }
        }
    }

    pub fn reduce(
        &mut self,
        input: PlacementInput,
        displays: &[DisplayFrame],
    ) -> Vec<PlacementEffect> {
        match input {
            PlacementInput::CyclePressed => {
                if self.held {
                    return Vec::new();
                }
                self.held = true;
                let base = self.desired.and_then(|target| target.corner)
                    .or_else(|| self.confirmed.and_then(|snapshot| snapshot.corner))
                    .unwrap_or_else(|| nearest_corner(self.observed, self.display(displays)));
                self.snap(base.next_clockwise(), displays)
            }
            PlacementInput::CycleReleased => {
                self.held = false;
                Vec::new()
            }
            PlacementInput::Snap(corner) => self.snap(corner, displays),
            PlacementInput::RestorePosition { x, y, corner } => self.restore_position(x, y, corner, displays),
            PlacementInput::BeginDrag => {
                self.restoring = None;
                self.dragging = true;
                self.drag_moved = false;
                self.drag_generation = self.generation;
                // Drag interrupts position work, not an independently
                // accepted size setter. A click-only drag must still allow
                // the observed resize to reanchor the confirmed corner.
                self.drag_interrupted = self.waiting && !self.pending.is_empty();
                // A click alone must not erase the confirmed anchor.
                self.waiting = !self.pending_sizes.is_empty()
                    || self.desired.is_some_and(|target|
                        target.required_width.is_some() || target.required_height.is_some());
                Vec::new()
            }
            PlacementInput::ResizeRequested { width, height } => {
                self.generation += 1;
                let corner = if self.dragging && !self.drag_moved {
                    self.confirmed.and_then(|snapshot| snapshot.corner)
                } else {
                    self.desired.and_then(|target| target.corner)
                        .or_else(|| self.confirmed.and_then(|snapshot| snapshot.corner))
                };
                self.desired = Some(Target {
                    generation: self.generation,
                    corner,
                    frame: if self.restoring.is_some() {
                        self.desired.map_or(self.observed, |target| target.frame)
                    } else { self.observed },
                    required_width: Some(width),
                    required_height: Some(height),
                    logical_size: None,
                    display: self.desired.and_then(|target| target.display)
                        .or_else(|| self.display(displays).copied()),
                });
                self.waiting = true;
                self.reconcile(displays)
            }
            PlacementInput::Moved { x, y } => {
                let unchanged = self.observed.x == x && self.observed.y == y;
                self.observed.x = x;
                self.observed.y = y;
                // Consume an active matching request before a retired arrival,
                // using the oldest match within each queue.
                let arrival = if let Some(index) = self.pending.iter().position(|target| matches_position(x, y, target.x, target.y)) {
                    self.pending.remove(index)
                } else if let Some(index) = self.retired.iter().position(|target| matches_position(x, y, target.x, target.y)) {
                    self.retired.remove(index)
                } else { None };
                if let Some(target) = arrival {
                    if self.restoring.is_some() && self.ready_to_confirm()
                        && self.desired.is_some_and(|desired| desired.display.is_some_and(|display| displays.contains(&display)))
                        && self.pending.iter().all(|pending| matches_position(x, y, pending.x, pending.y))
                    {
                        // Resize may supersede the location generation with an
                        // identical position request. A real arrival at that
                        // location advances restoration once, without requiring
                        // another Moved event from a duplicate native setter.
                        let corner = self.restoring.take().expect("checked restoration");
                        if let Some(desired) = self.desired.as_mut() { desired.corner = corner; }
                        let effects = self.reconcile(displays);
                        if self.ready_to_confirm()
                            && self.pending.iter().all(|pending| matches_position(x, y, pending.x, pending.y))
                        {
                            return self.confirm();
                        }
                        return effects;
                    }
                    if self.dragging && !self.drag_moved && self.drag_interrupted
                        && target.generation <= self.drag_generation
                    {
                        return Vec::new();
                    }
                    if self.desired.is_some_and(|desired| desired.generation == target.generation
                        && (desired.corner.is_none()
                            || desired.display.is_some_and(|display| displays.contains(&display))))
                        && self.ready_to_confirm()
                    {
                        if self.restoring.is_some() {
                            return self.reconcile(displays);
                        }
                        return self.confirm();
                    }
                    return self.reconcile(displays);
                }
                if self.dragging {
                    if unchanged && !self.drag_moved {
                        return Vec::new();
                    }
                    self.drag_moved = true;
                    return self.confirm_manual();
                }
                if self.waiting || !self.pending.is_empty() {
                    return self.reconcile(displays);
                }
                if unchanged {
                    return Vec::new();
                }
                self.confirm_manual()
            }
            PlacementInput::Resized { width, height } => {
                let unchanged = self.observed.width == width && self.observed.height == height;
                self.observed.width = width;
                self.observed.height = height;
                let arrival = if let Some(index) = self.pending_sizes.iter()
                    .position(|pending| pending.width == width && pending.height == height)
                {
                    self.pending_sizes.remove(index)
                } else if let Some(index) = self.retired_sizes.iter()
                    .position(|pending| pending.width == width && pending.height == height)
                {
                    self.retired_sizes.remove(index)
                } else { None };
                if self.desired.is_some_and(|target|
                    (target.required_width.is_some() || target.required_height.is_some())
                    && target.required_width.is_none_or(|value| value == width)
                    && target.required_height.is_none_or(|value| value == height))
                {
                    // Tauri substitutes the current size for queued macOS
                    // callbacks. Observing the latest intent retires all older
                    // setters even if their intermediate events were coalesced.
                    // Retain provenance so a late obsolete arrival is corrected.
                    self.retired_sizes.extend(self.pending_sizes.drain(..));
                }
                if self.dragging && !self.drag_moved && self.drag_interrupted
                    && self.desired.is_some_and(|target| target.generation <= self.drag_generation)
                    && self.desired.is_none_or(|target|
                        target.required_width.is_none() && target.required_height.is_none())
                {
                    return Vec::new();
                }
                if self.desired.is_none() {
                    self.generation += 1;
                    self.desired = Some(Target {
                        generation: self.generation,
                        corner: self.confirmed.and_then(|snapshot| snapshot.corner),
                        frame: self.observed,
                        required_width: None,
                        required_height: None,
                        logical_size: None,
                        display: self.display(displays).copied(),
                    });
                } else if !self.waiting && !unchanged && arrival.is_none() {
                    self.generation += 1;
                    if let Some(target) = self.desired.as_mut() {
                        target.generation = self.generation;
                        target.required_width = None;
                        target.required_height = None;
                        target.logical_size = None;
                    }
                } else if arrival.is_some_and(|pending| pending.generation < self.generation) && !unchanged {
                    // A delayed native resize is still programmatic after a
                    // newer no-op confirmation. A subsequent corner command
                    // may have cleared satisfied size requirements; restore
                    // them from its last intended frame, not the stale arrival.
                    if let Some(target) = self.desired.as_mut() {
                        target.required_width.get_or_insert(target.frame.width);
                        target.required_height.get_or_insert(target.frame.height);
                    }
                    self.waiting = true;
                }
                self.reconcile(displays)
            }
            PlacementInput::TimedOut(generation) => {
                if self.waiting && self.desired.is_some_and(|target| target.generation == generation) {
                    vec![PlacementEffect::ReportUnconfirmed(generation)]
                } else {
                    Vec::new()
                }
            }
        }
    }

    fn display<'a>(&self, displays: &'a [DisplayFrame]) -> Option<&'a DisplayFrame> {
        display_containing(self.observed, displays)
            // The adapter supplies current/primary fallback first.
            .or_else(|| displays.first())
    }

    fn snap(&mut self, corner: Corner, displays: &[DisplayFrame]) -> Vec<PlacementEffect> {
        if self.restoring.take().is_some() {
            // An explicit corner command cancels restoration, including its
            // superseded location generations. Earlier ordinary corner moves
            // remain active and still prevent premature no-op confirmation.
            let retired = &mut self.retired;
            self.pending.retain(|pending| {
                if pending.from_restore {
                    retired.push_back(*pending);
                    false
                } else { true }
            });
        }
        self.dragging = false;
        self.drag_moved = false;
        self.generation += 1;
        self.desired = Some(Target {
            generation: self.generation,
            corner: Some(corner),
            frame: self.observed,
            // Rescaling may leave the last observed dimensions rounded
            // differently from exact logical intent. Preserve that intent
            // across a corner command until the native size is observed.
            required_width: self.desired.and_then(|target| target.required_width
                .or_else(|| target.logical_size.map(|_| target.frame.width)))
                .filter(|width| *width != self.observed.width || !self.pending_sizes.is_empty()),
            required_height: self.desired.and_then(|target| target.required_height
                .or_else(|| target.logical_size.map(|_| target.frame.height)))
                .filter(|height| *height != self.observed.height || !self.pending_sizes.is_empty()),
            logical_size: self.desired.and_then(|target| target.logical_size),
            display: self.display(displays).copied(),
        });
        self.reconcile(displays)
    }

    fn restore_position(&mut self, x: i32, y: i32, corner: Option<Corner>, displays: &[DisplayFrame]) -> Vec<PlacementEffect> {
        self.dragging = false;
        self.drag_moved = false;
        self.generation += 1;
        let saved_frame = PhysicalFrame { x, y, ..self.observed };
        let containing = display_containing(saved_frame, displays);
        let display = containing.or_else(|| displays.first()).copied();
        let frame = if containing.is_some() {
            saved_frame
        } else if let Some(display) = display {
            // Never dispatch the missing display's off-screen coordinates.
            corner_frame(corner.unwrap_or(Corner::TopLeft), self.observed, &display)
        } else {
            self.restoring = None;
            self.waiting = true;
            self.desired = None;
            return vec![PlacementEffect::ReportUnconfirmed(self.generation)];
        };
        self.restoring = Some(corner);
        self.desired = Some(Target {
            generation: self.generation, corner: None, frame,
            required_width: None,
            required_height: None, display,
            logical_size: None,
        });
        self.reconcile(displays)
    }

    fn reconcile(&mut self, displays: &[DisplayFrame]) -> Vec<PlacementEffect> {
        let Some(mut target) = self.desired else { return Vec::new(); };
        self.waiting = true;
        let requested_width = target.required_width.unwrap_or(self.observed.width);
        let requested_height = target.required_height.unwrap_or(self.observed.height);
        if requested_width != self.observed.width || requested_height != self.observed.height {
            if self.pending_sizes.iter().any(|pending|
                pending.width == requested_width && pending.height == requested_height)
            {
                return vec![PlacementEffect::ScheduleWatchdog(target.generation)];
            }
            self.pending_sizes.push_back(PendingSize {
                generation: target.generation, width: requested_width, height: requested_height,
                logical_size: target.logical_size,
            });
            return vec![
                PlacementEffect::SetHeight { generation: target.generation, height: requested_height },
                PlacementEffect::ScheduleWatchdog(target.generation),
            ];
        }
        if !self.pending_sizes.is_empty() {
            // An older setter can still arrive and undo an observed no-op.
            return vec![PlacementEffect::ScheduleWatchdog(target.generation)];
        }
        if let Some(corner) = self.restoring {
            if !target.display.is_some_and(|display| displays.contains(&display)) {
                let Some(display) = display_containing(target.frame, displays).or_else(|| displays.first()) else {
                    return vec![PlacementEffect::ReportUnconfirmed(target.generation)];
                };
                target.frame = corner_frame(corner.unwrap_or(Corner::TopLeft), self.observed, display);
                target.display = Some(*display);
            }
        }
        if let Some(corner) = target.corner {
            let display = target.display.as_ref()
                .and_then(|desired_display| displays.iter().find(|display| *display == desired_display))
                .or_else(|| self.display(displays));
            let Some(display) = display else {
                return vec![PlacementEffect::ReportUnconfirmed(target.generation)];
            };
            target.frame = corner_frame(corner, self.observed, display);
            target.display = Some(*display);
        } else {
            target.frame.width = self.observed.width;
            target.frame.height = self.observed.height;
        }
        let previous = self.desired.expect("reconciliation requires a desired target");
        if previous.frame.x != target.frame.x || previous.frame.y != target.frame.y {
            let display_changed = previous.display != target.display;
            let mut active = VecDeque::new();
            while let Some(pending) = self.pending.pop_front() {
                if display_changed || pending.generation == target.generation {
                    self.retired.push_back(pending);
                } else {
                    active.push_back(pending);
                }
            }
            self.pending = active;
        }
        self.desired = Some(target);
        if self.ready_to_confirm() && self.pending.is_empty() {
            if let Some(corner) = self.restoring.take() {
                if let Some(desired) = self.desired.as_mut() {
                    desired.corner = corner;
                }
                return self.reconcile(displays);
            }
            return self.confirm();
        }
        if !self.pending.iter().any(|pending| pending.generation == target.generation
            && pending.x == target.frame.x && pending.y == target.frame.y)
        {
            self.pending.push_back(PendingMove {
                generation: target.generation, x: target.frame.x, y: target.frame.y,
                from_restore: self.restoring.is_some(),
            });
        }
        vec![
            PlacementEffect::SetPosition { generation: target.generation, x: target.frame.x, y: target.frame.y },
            PlacementEffect::ScheduleWatchdog(target.generation),
        ]
    }

    fn ready_to_confirm(&self) -> bool {
        self.desired.is_some_and(|target| {
            matches_position(self.observed.x, self.observed.y, target.frame.x, target.frame.y)
                && self.observed.width == target.frame.width
                && self.observed.height == target.frame.height
                && target.required_width.is_none_or(|width| width == self.observed.width)
                && target.required_height.is_none_or(|height| height == self.observed.height)
                && self.pending_sizes.is_empty()
        })
    }

    fn confirm(&mut self) -> Vec<PlacementEffect> {
        let target = self.desired.expect("confirmation requires a desired target");
        let snapshot = PlacementSnapshot {
            generation: target.generation, corner: target.corner, frame: self.observed,
        };
        self.waiting = false;
        self.confirmed = Some(snapshot);
        // Every remaining request is superseded by this observed confirmation.
        // It remains a late-arrival guard, not an active positioning barrier.
        self.retired.extend(self.pending.drain(..));
        self.retired_sizes.extend(self.pending_sizes.drain(..));
        vec![PlacementEffect::Confirm(snapshot), PlacementEffect::Persist(snapshot)]
    }

    fn confirm_manual(&mut self) -> Vec<PlacementEffect> {
        self.restoring = None;
        self.generation += 1;
        self.desired = Some(Target {
            generation: self.generation, corner: None, frame: self.observed,
            // Manual movement supersedes position only. Outstanding native
            // size setters and exact logical dimensions keep their intent.
            required_height: self.desired.and_then(|target| target.required_height),
            required_width: self.desired.and_then(|target| target.required_width),
            logical_size: self.desired.and_then(|target| target.logical_size),
            display: None,
        });
        let snapshot = PlacementSnapshot {
            generation: self.generation, corner: None, frame: self.observed,
        };
        self.confirmed = Some(snapshot);
        self.retired.extend(self.pending.drain(..));
        let target = self.desired.expect("manual movement supplies a target");
        self.waiting = !self.pending_sizes.is_empty()
            || target.required_width.is_some_and(|width| width != self.observed.width)
            || target.required_height.is_some_and(|height| height != self.observed.height);
        // Persist this observed free position immediately, while retaining
        // the independent size intent until its own native observation.
        let mut effects = vec![PlacementEffect::Confirm(snapshot), PlacementEffect::Persist(snapshot)];
        if self.waiting {
            // Manual position confirmation must not complete the pending
            // resize. Give size reconciliation a newer generation so the
            // adapter/UI can retain and report its watchdog independently.
            self.generation += 1;
            self.desired.as_mut().expect("manual movement supplies a target").generation = self.generation;
            effects.push(PlacementEffect::ScheduleWatchdog(self.generation));
        }
        effects
    }
}

fn matches_position(x: i32, y: i32, target_x: i32, target_y: i32) -> bool {
    (i64::from(x) - i64::from(target_x)).abs() <= 2
        && (i64::from(y) - i64::from(target_y)).abs() <= 2
}

fn rescale_coordinate(value: i32, old_scale: f64, new_scale: f64) -> i32 {
    ((f64::from(value) / old_scale) * new_scale).round()
        .clamp(f64::from(i32::MIN), f64::from(i32::MAX)) as i32
}

fn rescale_dimension(value: u32, old_scale: f64, new_scale: f64) -> u32 {
    ((f64::from(value) / old_scale) * new_scale).round()
        .clamp(0.0, f64::from(u32::MAX)) as u32
}

fn logical_dimension(value: u32, scale: f64) -> u32 {
    (f64::from(value) * scale).round().clamp(0.0, f64::from(u32::MAX)) as u32
}

fn rescale_frame(frame: PhysicalFrame, old_scale: f64, new_scale: f64) -> PhysicalFrame {
    PhysicalFrame {
        x: rescale_coordinate(frame.x, old_scale, new_scale),
        y: rescale_coordinate(frame.y, old_scale, new_scale),
        width: rescale_dimension(frame.width, old_scale, new_scale),
        height: rescale_dimension(frame.height, old_scale, new_scale),
    }
}

fn rescale_display(display: DisplayFrame, old_scale: f64, new_scale: f64) -> DisplayFrame {
    DisplayFrame {
        x: rescale_coordinate(display.x, old_scale, new_scale),
        y: rescale_coordinate(display.y, old_scale, new_scale),
        width: rescale_dimension(display.width, old_scale, new_scale),
        height: rescale_dimension(display.height, old_scale, new_scale),
        scale_factor: new_scale,
    }
}

fn display_containing(frame: PhysicalFrame, displays: &[DisplayFrame]) -> Option<&DisplayFrame> {
    let center_x = i64::from(frame.x) * 2 + i64::from(frame.width);
    let center_y = i64::from(frame.y) * 2 + i64::from(frame.height);
    displays.iter().find(|display| {
        center_x >= i64::from(display.x) * 2
            && center_x < (i64::from(display.x) + i64::from(display.width)) * 2
            && center_y >= i64::from(display.y) * 2
            && center_y < (i64::from(display.y) + i64::from(display.height)) * 2
    })
}

fn corner_frame(corner: Corner, frame: PhysicalFrame, display: &DisplayFrame) -> PhysicalFrame {
    let margin = (16.0 * display.scale_factor).round() as i64;
    let left = i64::from(display.x) + margin;
    let top = i64::from(display.y) + margin;
    let right = (i64::from(display.x) + i64::from(display.width) - i64::from(frame.width) - margin).max(left);
    let bottom = (i64::from(display.y) + i64::from(display.height) - i64::from(frame.height) - margin).max(top);
    let (x, y) = match corner {
        Corner::TopLeft => (left, top),
        Corner::TopRight => (right, top),
        Corner::BottomRight => (right, bottom),
        Corner::BottomLeft => (left, bottom),
    };
    PhysicalFrame {
        x: x.clamp(i64::from(i32::MIN), i64::from(i32::MAX)) as i32,
        y: y.clamp(i64::from(i32::MIN), i64::from(i32::MAX)) as i32,
        ..frame
    }
}

fn nearest_corner(frame: PhysicalFrame, display: Option<&DisplayFrame>) -> Corner {
    let Some(display) = display else { return Corner::TopLeft; };
    [Corner::TopLeft, Corner::TopRight, Corner::BottomRight, Corner::BottomLeft]
        .into_iter()
        .min_by_key(|corner| {
            let target = corner_frame(*corner, frame, display);
            let dx = i128::from(frame.x) - i128::from(target.x);
            let dy = i128::from(frame.y) - i128::from(target.y);
            dx * dx + dy * dy
        })
        .expect("four corners are available")
}

#[cfg(test)]
mod tests {
    use super::*;

    const DISPLAYS: [DisplayFrame; 1] = [DisplayFrame {
        x: 0, y: 0, width: 1920, height: 1080, scale_factor: 1.0,
    }];
    const STRIP: PhysicalFrame = PhysicalFrame {
        x: 16, y: 16, width: 420, height: 50,
    };

    fn confirms(effects: &[PlacementEffect]) -> bool {
        effects.iter().any(|effect| matches!(effect, PlacementEffect::Confirm(_)))
    }

    // Catches treating setter acceptance, held repeat, or a stale move as confirmation.
    #[test]
    fn rapid_presses_confirm_only_the_latest_observed_target() {
        let mut machine = PlacementMachine::new(STRIP, None);
        assert!(machine.reduce(PlacementInput::CyclePressed, &DISPLAYS).contains(
            &PlacementEffect::SetPosition { generation: 1, x: 1484, y: 16 }
        ));
        assert!(machine.confirmed().is_none());
        assert!(machine.reduce(PlacementInput::CyclePressed, &DISPLAYS).is_empty());
        machine.reduce(PlacementInput::CycleReleased, &DISPLAYS);
        assert!(machine.reduce(PlacementInput::CyclePressed, &DISPLAYS).contains(
            &PlacementEffect::SetPosition { generation: 2, x: 1484, y: 1014 }
        ));
        let stale = machine.reduce(PlacementInput::Moved { x: 1484, y: 16 }, &DISPLAYS);
        assert!(!confirms(&stale));
        assert!(stale.contains(&PlacementEffect::SetPosition { generation: 2, x: 1484, y: 1014 }));
        let current = machine.reduce(PlacementInput::Moved { x: 1484, y: 1014 }, &DISPLAYS);
        assert!(current.contains(&PlacementEffect::Confirm(PlacementSnapshot {
            generation: 2, corner: Some(Corner::BottomRight),
            frame: PhysicalFrame { x: 1484, y: 1014, width: 420, height: 50 },
        })));
    }

    // Catches a stale move overwriting a target that was already confirmed first.
    #[test]
    fn latest_move_arriving_first_remains_confirmed_after_stale_move() {
        let mut machine = PlacementMachine::new(STRIP, None);
        machine.reduce(PlacementInput::CyclePressed, &DISPLAYS);
        machine.reduce(PlacementInput::CycleReleased, &DISPLAYS);
        machine.reduce(PlacementInput::CyclePressed, &DISPLAYS);
        assert!(confirms(&machine.reduce(PlacementInput::Moved { x: 1484, y: 1014 }, &DISPLAYS)));
        let latest = machine.confirmed();
        let stale = machine.reduce(PlacementInput::Moved { x: 1484, y: 16 }, &DISPLAYS);
        assert!(!confirms(&stale));
        assert!(stale.contains(&PlacementEffect::SetPosition { generation: 2, x: 1484, y: 1014 }));
        assert_eq!(machine.confirmed(), latest);
    }

    // Catches a resize reasserting the programmatic corner interrupted by a drag.
    #[test]
    fn no_movement_drag_resize_keeps_last_confirmed_anchor() {
        let saved = PlacementSnapshot { generation: 1, corner: Some(Corner::TopLeft), frame: STRIP };
        let mut machine = PlacementMachine::new(STRIP, Some(saved));
        machine.reduce(PlacementInput::CyclePressed, &DISPLAYS);
        machine.reduce(PlacementInput::BeginDrag, &DISPLAYS);
        let effects = machine.reduce(PlacementInput::Resized { width: 420, height: 252 }, &DISPLAYS);
        assert!(!effects.iter().any(|effect| matches!(effect, PlacementEffect::SetPosition { x: 1484, .. })));
        assert_eq!(machine.confirmed(), Some(saved));
    }

    // Catches suppressing an established bottom anchor after a click-only drag.
    #[test]
    fn confirmed_bottom_anchor_resizes_after_no_movement_drag() {
        let bottom = PhysicalFrame { x: 1484, y: 1014, width: 420, height: 50 };
        let mut machine = PlacementMachine::new(bottom, None);
        assert!(confirms(&machine.reduce(PlacementInput::Snap(Corner::BottomRight), &DISPLAYS)));
        machine.reduce(PlacementInput::BeginDrag, &DISPLAYS);
        let resized = machine.reduce(PlacementInput::Resized { width: 420, height: 252 }, &DISPLAYS);
        assert!(resized.contains(&PlacementEffect::SetPosition { generation: 2, x: 1484, y: 812 }));
        assert!(!confirms(&resized));
        assert!(confirms(&machine.reduce(PlacementInput::Moved { x: 1484, y: 812 }, &DISPLAYS)));
    }

    // Catches a click erasing a valid anchor without an actual drag observation.
    #[test]
    fn begin_drag_without_movement_preserves_anchor() {
        let saved = PlacementSnapshot { generation: 4, corner: Some(Corner::TopLeft), frame: STRIP };
        let mut machine = PlacementMachine::new(STRIP, Some(saved));
        assert!(machine.reduce(PlacementInput::BeginDrag, &DISPLAYS).is_empty());
        assert_eq!(machine.confirmed(), Some(saved));
        assert!(machine.reduce(PlacementInput::CyclePressed, &DISPLAYS).contains(
            &PlacementEffect::SetPosition { generation: 5, x: 1484, y: 16 }
        ));
    }

    // Catches stale programmatic moves overwriting a manual destination.
    #[test]
    fn delayed_drag_clears_anchor_and_stale_move_reasserts_free_position() {
        let mut machine = PlacementMachine::new(STRIP, None);
        machine.reduce(PlacementInput::CyclePressed, &DISPLAYS);
        machine.reduce(PlacementInput::BeginDrag, &DISPLAYS);
        let manual = machine.reduce(PlacementInput::Moved { x: 700, y: 400 }, &DISPLAYS);
        assert!(manual.contains(&PlacementEffect::Persist(PlacementSnapshot {
            generation: 2, corner: None,
            frame: PhysicalFrame { x: 700, y: 400, width: 420, height: 50 },
        })));
        let stale = machine.reduce(PlacementInput::Moved { x: 1484, y: 16 }, &DISPLAYS);
        assert!(!confirms(&stale));
        assert!(stale.contains(&PlacementEffect::SetPosition { generation: 2, x: 700, y: 400 }));
        machine.reduce(PlacementInput::Moved { x: 700, y: 400 }, &DISPLAYS);
        machine.reduce(PlacementInput::CycleReleased, &DISPLAYS);
        assert!(machine.reduce(PlacementInput::CyclePressed, &DISPLAYS).contains(
            &PlacementEffect::SetPosition { generation: 3, x: 1484, y: 16 }
        ));
    }

    // Catches snapping a click back toward the command that it interrupted.
    #[test]
    fn stale_programmatic_move_during_no_movement_drag_cannot_confirm() {
        let mut machine = PlacementMachine::new(STRIP, None);
        machine.reduce(PlacementInput::CyclePressed, &DISPLAYS);
        machine.reduce(PlacementInput::BeginDrag, &DISPLAYS);
        assert!(machine.reduce(PlacementInput::Moved { x: 1484, y: 16 }, &DISPLAYS).is_empty());
        assert!(machine.confirmed().is_none());
        machine.reduce(PlacementInput::CycleReleased, &DISPLAYS);
        assert!(machine.reduce(PlacementInput::CyclePressed, &DISPLAYS).contains(
            &PlacementEffect::SetPosition { generation: 2, x: 1484, y: 1014 }
        ));
    }

    // Catches positioning using requested size before the OS reports the actual height.
    #[test]
    fn bottom_anchor_uses_actual_resize_before_persisting() {
        let bottom = PhysicalFrame { x: 1484, y: 1014, width: 420, height: 50 };
        let saved = PlacementSnapshot { generation: 1, corner: Some(Corner::BottomRight), frame: bottom };
        let mut machine = PlacementMachine::new(bottom, Some(saved));
        let request = machine.reduce(PlacementInput::ResizeRequested { width: 420, height: 252 }, &DISPLAYS);
        assert!(request.contains(&PlacementEffect::SetHeight { generation: 2, height: 252 }));
        assert!(!request.iter().any(|effect| matches!(effect, PlacementEffect::SetPosition { .. } | PlacementEffect::Persist(_))));
        let resized = machine.reduce(PlacementInput::Resized { width: 420, height: 252 }, &DISPLAYS);
        assert!(resized.contains(&PlacementEffect::SetPosition { generation: 2, x: 1484, y: 812 }));
        assert!(!confirms(&resized));
        let moved = machine.reduce(PlacementInput::Moved { x: 1484, y: 812 }, &DISPLAYS);
        assert!(moved.contains(&PlacementEffect::Persist(PlacementSnapshot {
            generation: 2, corner: Some(Corner::BottomRight),
            frame: PhysicalFrame { x: 1484, y: 812, width: 420, height: 252 },
        })));
    }

    #[test]
    fn coalesced_latest_resize_retires_obsolete_sizes_and_guards_late_arrival() {
        let mut machine = PlacementMachine::new(STRIP, None);
        machine.reduce(PlacementInput::ResizeRequested { width: 420, height: 252 }, &DISPLAYS);
        machine.reduce(PlacementInput::ResizeRequested { width: 420, height: 420 }, &DISPLAYS);
        assert_eq!(machine.reduce(PlacementInput::TimedOut(2), &DISPLAYS),
            vec![PlacementEffect::ReportUnconfirmed(2)]);
        assert_eq!(machine.confirmed(), None, "timeout is not a native observation");
        // macOS Tauri can substitute the current size for both queued callbacks.
        let latest = machine.reduce(PlacementInput::Resized { width: 420, height: 420 }, &DISPLAYS);
        assert!(confirms(&latest), "latest native size must not await omitted 252 observation");
        let confirmed = machine.confirmed().unwrap();
        assert_eq!((confirmed.generation, confirmed.frame.height), (2, 420));
        assert!(machine.reduce(PlacementInput::TimedOut(2), &DISPLAYS).is_empty());
        let late = machine.reduce(PlacementInput::Resized { width: 420, height: 252 }, &DISPLAYS);
        assert!(!confirms(&late));
        assert_eq!(machine.confirmed(), Some(confirmed));
        assert!(late.contains(&PlacementEffect::SetHeight { generation: 2, height: 420 }));
        assert!(confirms(&machine.reduce(PlacementInput::Resized { width: 420, height: 420 }, &DISPLAYS)));
        assert!(confirms(&machine.reduce(PlacementInput::Snap(Corner::TopLeft), &DISPLAYS)));
    }

    #[test]
    fn coalesced_size_observation_unblocks_latest_bottom_corner_and_future_resize() {
        let mut machine = PlacementMachine::new(STRIP, None);
        machine.reduce(PlacementInput::ResizeRequested { width: 420, height: 252 }, &DISPLAYS);
        machine.reduce(PlacementInput::ResizeRequested { width: 420, height: 420 }, &DISPLAYS);
        machine.reduce(PlacementInput::Snap(Corner::BottomRight), &DISPLAYS);
        let size = machine.reduce(PlacementInput::Resized { width: 420, height: 420 }, &DISPLAYS);
        assert!(size.contains(&PlacementEffect::SetPosition { generation: 3, x: 1484, y: 644 }));
        assert!(!confirms(&size));
        assert!(confirms(&machine.reduce(PlacementInput::Moved { x: 1484, y: 644 }, &DISPLAYS)));
        machine.reduce(PlacementInput::ResizeRequested { width: 420, height: 252 }, &DISPLAYS);
        machine.reduce(PlacementInput::Resized { width: 420, height: 252 }, &DISPLAYS);
        assert!(confirms(&machine.reduce(PlacementInput::Moved { x: 1484, y: 812 }, &DISPLAYS)));
        assert_eq!(machine.confirmed().unwrap().generation, 4);
    }

    #[test]
    fn obsolete_resize_after_confirmed_corner_noop_reasserts_latest_size() {
        let mut machine = PlacementMachine::new(STRIP, None);
        machine.reduce(PlacementInput::ResizeRequested { width: 420, height: 252 }, &DISPLAYS);
        machine.reduce(PlacementInput::ResizeRequested { width: 420, height: 420 }, &DISPLAYS);
        machine.reduce(PlacementInput::Resized { width: 420, height: 420 }, &DISPLAYS);
        machine.reduce(PlacementInput::Snap(Corner::TopLeft), &DISPLAYS);
        let latest = machine.confirmed().unwrap();
        let late = machine.reduce(PlacementInput::Resized { width: 420, height: 252 }, &DISPLAYS);
        assert!(!confirms(&late), "a later corner no-op must retain obsolete size provenance");
        assert_eq!(machine.confirmed(), Some(latest));
        assert!(late.contains(&PlacementEffect::SetHeight { generation: 3, height: 420 }));
    }

    #[test]
    fn older_queued_resize_cannot_confirm_a_newer_noop_height() {
        let bottom = PhysicalFrame { x: 1484, y: 1014, width: 420, height: 50 };
        let saved = PlacementSnapshot { generation: 1, corner: Some(Corner::BottomRight), frame: bottom };
        let mut machine = PlacementMachine::new(bottom, Some(saved));
        assert!(machine.reduce(PlacementInput::ResizeRequested { width: 420, height: 420 }, &DISPLAYS)
            .contains(&PlacementEffect::SetHeight { generation: 2, height: 420 }));
        let no_op = machine.reduce(PlacementInput::ResizeRequested { width: 420, height: 50 }, &DISPLAYS);
        assert!(!confirms(&no_op));
        assert_eq!(machine.confirmed(), Some(saved));

        let stale = machine.reduce(PlacementInput::Resized { width: 420, height: 420 }, &DISPLAYS);
        assert!(!confirms(&stale));
        assert!(stale.contains(&PlacementEffect::SetHeight { generation: 3, height: 50 }));
        assert_eq!(machine.confirmed(), Some(saved));

        let restored = machine.reduce(PlacementInput::Resized { width: 420, height: 50 }, &DISPLAYS);
        assert!(confirms(&restored));
        assert_eq!(machine.confirmed().unwrap().generation, 3);
        assert_eq!(machine.confirmed().unwrap().frame.height, 50);
    }

    #[test]
    fn corner_command_during_queued_resize_preserves_latest_requested_height() {
        let mut machine = PlacementMachine::new(STRIP, None);
        machine.reduce(PlacementInput::ResizeRequested { width: 420, height: 420 }, &DISPLAYS);
        machine.reduce(PlacementInput::ResizeRequested { width: 420, height: 50 }, &DISPLAYS);
        assert!(!confirms(&machine.reduce(PlacementInput::Snap(Corner::BottomRight), &DISPLAYS)));
        let stale = machine.reduce(PlacementInput::Resized { width: 420, height: 420 }, &DISPLAYS);
        assert!(stale.contains(&PlacementEffect::SetHeight { generation: 3, height: 50 }));
        assert!(!confirms(&stale));
        machine.reduce(PlacementInput::Resized { width: 420, height: 50 }, &DISPLAYS);
        let moved = machine.reduce(PlacementInput::Moved { x: 1484, y: 1014 }, &DISPLAYS);
        assert!(confirms(&moved));
        assert_eq!(machine.confirmed().unwrap().frame.height, 50);
    }

    // Catches physical/logical coordinate mixing and ignoring negative display origins.
    #[test]
    fn negative_scaled_display_uses_physical_margin() {
        let displays = [DisplayFrame { x: -2560, y: -100, width: 2560, height: 1440, scale_factor: 2.0 }];
        let frame = PhysicalFrame { x: -2528, y: -68, width: 420, height: 50 };
        let mut machine = PlacementMachine::new(frame, None);
        assert!(machine.reduce(PlacementInput::CyclePressed, &displays).contains(
            &PlacementEffect::SetPosition { generation: 1, x: -452, y: -68 }
        ));
    }

    // Catches stale observations on another screen changing the latest target's display.
    #[test]
    fn stale_move_cannot_retarget_latest_command_to_another_display() {
        let displays = [DISPLAYS[0], DisplayFrame {
            x: -2560, y: -100, width: 2560, height: 1440, scale_factor: 2.0,
        }];
        let mut machine = PlacementMachine::new(STRIP, None);
        machine.reduce(PlacementInput::CyclePressed, &displays);
        machine.reduce(PlacementInput::BeginDrag, &displays);
        machine.reduce(PlacementInput::Moved { x: -1400, y: 200 }, &displays);
        machine.reduce(PlacementInput::CycleReleased, &displays);
        assert!(machine.reduce(PlacementInput::CyclePressed, &displays).contains(
            &PlacementEffect::SetPosition { generation: 3, x: -452, y: 1258 }
        ));
        let stale = machine.reduce(PlacementInput::Moved { x: 1484, y: 16 }, &displays);
        assert!(stale.contains(&PlacementEffect::SetPosition { generation: 3, x: -452, y: 1258 }));
        assert!(!confirms(&stale));
    }

    // Catches treating a manual mismatch larger than OS rounding as a target.
    #[test]
    fn target_tolerance_is_two_pixels_per_axis() {
        let mut accepted = PlacementMachine::new(STRIP, None);
        accepted.reduce(PlacementInput::CyclePressed, &DISPLAYS);
        let effects = accepted.reduce(PlacementInput::Moved { x: 1486, y: 18 }, &DISPLAYS);
        assert!(effects.contains(&PlacementEffect::Confirm(PlacementSnapshot {
            generation: 1, corner: Some(Corner::TopRight),
            frame: PhysicalFrame { x: 1486, y: 18, width: 420, height: 50 },
        })));
        let mut rejected = PlacementMachine::new(STRIP, None);
        rejected.reduce(PlacementInput::CyclePressed, &DISPLAYS);
        assert!(!confirms(&rejected.reduce(PlacementInput::Moved { x: 1487, y: 16 }, &DISPLAYS)));
        assert!(rejected.confirmed().is_none());
    }

    // Catches leaving a restored corner on a disconnected external monitor.
    #[test]
    fn removed_display_falls_back_to_supplied_monitor() {
        let frame = PhysicalFrame { x: -452, y: -68, width: 420, height: 50 };
        let saved = PlacementSnapshot { generation: 6, corner: Some(Corner::TopRight), frame };
        let mut machine = PlacementMachine::new(frame, Some(saved));
        assert!(machine.reduce(PlacementInput::Snap(Corner::TopRight), &DISPLAYS).contains(
            &PlacementEffect::SetPosition { generation: 7, x: 1484, y: 16 }
        ));
    }

    // Catches confirming a delayed target after its requested display disappears.
    #[test]
    fn delayed_move_on_removed_display_reasserts_available_fallback() {
        let external = DisplayFrame { x: -2560, y: -100, width: 2560, height: 1440, scale_factor: 2.0 };
        let frame = PhysicalFrame { x: -2528, y: -68, width: 420, height: 50 };
        let mut machine = PlacementMachine::new(frame, None);
        machine.reduce(PlacementInput::Snap(Corner::TopRight), &[external, DISPLAYS[0]]);
        let delayed = machine.reduce(PlacementInput::Moved { x: -452, y: -68 }, &DISPLAYS);
        assert!(!confirms(&delayed));
        assert!(!delayed.iter().any(|effect| matches!(effect, PlacementEffect::Persist(_))));
        assert!(delayed.contains(&PlacementEffect::SetPosition { generation: 1, x: 1484, y: 16 }));
        assert!(machine.confirmed().is_none());
        assert!(confirms(&machine.reduce(PlacementInput::Moved { x: 1484, y: 16 }, &DISPLAYS)));
    }

    // Catches saved display preference overriding the adapter's current/primary fallback.
    #[test]
    fn offscreen_observation_uses_first_display_before_saved_display() {
        let external = DisplayFrame { x: -2560, y: -100, width: 2560, height: 1440, scale_factor: 2.0 };
        let saved = PlacementSnapshot {
            generation: 4, corner: Some(Corner::TopLeft),
            frame: PhysicalFrame { x: -2528, y: -68, width: 420, height: 50 },
        };
        let observed = PhysicalFrame { x: 5000, y: 5000, width: 420, height: 50 };
        let mut machine = PlacementMachine::new(observed, Some(saved));
        let effects = machine.reduce(PlacementInput::Snap(Corner::TopRight), &[DISPLAYS[0], external]);
        assert!(effects.contains(&PlacementEffect::SetPosition { generation: 5, x: 1484, y: 16 }));
        assert!(!confirms(&effects));
    }

    // Catches persisting an unobserved timeout target or discarding late confirmation.
    #[test]
    fn timeout_preserves_last_confirmation_and_allows_late_event() {
        let saved = PlacementSnapshot { generation: 1, corner: Some(Corner::TopLeft), frame: STRIP };
        let mut machine = PlacementMachine::new(STRIP, Some(saved));
        machine.reduce(PlacementInput::CyclePressed, &DISPLAYS);
        assert_eq!(machine.reduce(PlacementInput::TimedOut(2), &DISPLAYS), vec![PlacementEffect::ReportUnconfirmed(2)]);
        assert_eq!(machine.confirmed(), Some(saved));
        assert!(machine.reduce(PlacementInput::TimedOut(1), &DISPLAYS).is_empty());
        assert!(confirms(&machine.reduce(PlacementInput::Moved { x: 1484, y: 16 }, &DISPLAYS)));
        assert!(machine.reduce(PlacementInput::TimedOut(2), &DISPLAYS).is_empty());
    }

    // Catches no-op requests waiting forever for native Moved that may never fire.
    #[test]
    fn observed_noop_confirms_only_when_no_older_move_is_pending() {
        let mut machine = PlacementMachine::new(STRIP, None);
        assert!(confirms(&machine.reduce(PlacementInput::Snap(Corner::TopLeft), &DISPLAYS)));
        machine.reduce(PlacementInput::Snap(Corner::TopRight), &DISPLAYS);
        let noop = machine.reduce(PlacementInput::Snap(Corner::TopLeft), &DISPLAYS);
        assert!(!confirms(&noop));
        assert!(!confirms(&machine.reduce(PlacementInput::Moved { x: 1484, y: 16 }, &DISPLAYS)));
        assert!(confirms(&machine.reduce(PlacementInput::Moved { x: 16, y: 16 }, &DISPLAYS)));
    }

    // Catches loss of deliberate quick press steps or wrong clockwise ordering.
    #[test]
    fn four_presses_return_clockwise_to_top_left() {
        let mut machine = PlacementMachine::new(STRIP, None);
        for (generation, x, y, corner) in [
            (1, 1484, 16, Corner::TopRight),
            (2, 1484, 1014, Corner::BottomRight),
            (3, 16, 1014, Corner::BottomLeft),
            (4, 16, 16, Corner::TopLeft),
        ] {
            assert!(machine.reduce(PlacementInput::CyclePressed, &DISPLAYS).contains(
                &PlacementEffect::SetPosition { generation, x, y }
            ));
            assert!(machine.reduce(PlacementInput::Moved { x, y }, &DISPLAYS).contains(
                &PlacementEffect::Confirm(PlacementSnapshot {
                    generation, corner: Some(corner), frame: PhysicalFrame { x, y, width: 420, height: 50 },
                })
            ));
            machine.reduce(PlacementInput::CycleReleased, &DISPLAYS);
        }
    }

    // Catches claiming placement success when there is no usable display.
    #[test]
    fn missing_display_reports_unconfirmed_without_position_request() {
        let mut machine = PlacementMachine::new(STRIP, None);
        assert_eq!(machine.reduce(PlacementInput::CyclePressed, &[]), vec![PlacementEffect::ReportUnconfirmed(1)]);
        assert!(machine.confirmed().is_none());
    }

    // Catches resize snapping a manually moved free panel back to its old anchor.
    #[test]
    fn free_manual_position_stays_free_on_resize() {
        let mut machine = PlacementMachine::new(STRIP, None);
        machine.reduce(PlacementInput::BeginDrag, &DISPLAYS);
        machine.reduce(PlacementInput::Moved { x: 600, y: 300 }, &DISPLAYS);
        machine.reduce(PlacementInput::ResizeRequested { width: 420, height: 252 }, &DISPLAYS);
        let resized = machine.reduce(PlacementInput::Resized { width: 420, height: 252 }, &DISPLAYS);
        assert!(!resized.iter().any(|effect| matches!(effect, PlacementEffect::SetPosition { .. })));
        assert!(resized.contains(&PlacementEffect::Persist(PlacementSnapshot {
            generation: 2, corner: None, frame: PhysicalFrame { x: 600, y: 300, width: 420, height: 252 },
        })));
    }

    #[test]
    fn restore_observes_saved_display_location_before_applying_corner() {
        let external = DisplayFrame { x: -1920, ..DISPLAYS[0] };
        let mut machine = PlacementMachine::new(STRIP, None);
        let request = machine.reduce(PlacementInput::RestorePosition {
            x: -1904, y: 500, corner: Some(Corner::BottomLeft),
        }, &[external, DISPLAYS[0]]);
        assert!(request.contains(&PlacementEffect::SetPosition { generation: 1, x: -1904, y: 500 }));
        assert!(!confirms(&request));
        assert_eq!(machine.confirmed(), None);
        let located = machine.reduce(PlacementInput::Moved { x: -1904, y: 500 }, &[external, DISPLAYS[0]]);
        assert!(located.contains(&PlacementEffect::SetPosition { generation: 1, x: -1904, y: 1014 }));
        assert!(!confirms(&located));
        let arrived = machine.reduce(PlacementInput::Moved { x: -1904, y: 1014 }, &[external, DISPLAYS[0]]);
        assert!(arrived.contains(&PlacementEffect::Persist(PlacementSnapshot {
            generation: 1, corner: Some(Corner::BottomLeft),
            frame: PhysicalFrame { x: -1904, y: 1014, ..STRIP },
        })));
    }

    #[test]
    fn restore_noop_confirms_from_current_dimensions_with_fresh_generation() {
        let frame = PhysicalFrame { x: -1904, y: 812, width: 420, height: 252 };
        let external = DisplayFrame { x: -1920, ..DISPLAYS[0] };
        let mut machine = PlacementMachine::new(frame, None);
        let restored = machine.reduce(PlacementInput::RestorePosition {
            x: -1904, y: 812, corner: Some(Corner::BottomLeft),
        }, &[external, DISPLAYS[0]]);
        assert!(restored.contains(&PlacementEffect::Confirm(PlacementSnapshot {
            generation: 1, corner: Some(Corner::BottomLeft), frame,
        })));
        assert!(!restored.iter().any(|effect| matches!(effect, PlacementEffect::SetPosition { .. })));
    }

    #[test]
    fn missing_restore_display_uses_supplied_fallback_without_offscreen_request() {
        let mut machine = PlacementMachine::new(STRIP, None);
        let restored = machine.reduce(PlacementInput::RestorePosition {
            x: -1904, y: 812, corner: Some(Corner::BottomLeft),
        }, &DISPLAYS);
        assert!(restored.contains(&PlacementEffect::SetPosition { generation: 1, x: 16, y: 1014 }));
        assert!(!confirms(&restored));
        assert!(machine.reduce(PlacementInput::RestorePosition {
            x: -1904, y: 812, corner: None,
        }, &[]).contains(&PlacementEffect::ReportUnconfirmed(2)));
    }

    #[test]
    fn newer_snap_supersedes_restore_without_confirming_stale_location() {
        let mut machine = PlacementMachine::new(STRIP, None);
        machine.reduce(PlacementInput::RestorePosition { x: 310, y: 205, corner: Some(Corner::BottomLeft) }, &DISPLAYS);
        machine.reduce(PlacementInput::Snap(Corner::TopRight), &DISPLAYS);
        let stale = machine.reduce(PlacementInput::Moved { x: 310, y: 205 }, &DISPLAYS);
        assert!(!confirms(&stale));
        assert!(stale.contains(&PlacementEffect::SetPosition { generation: 2, x: 1484, y: 16 }));
        assert!(confirms(&machine.reduce(PlacementInput::Moved { x: 1484, y: 16 }, &DISPLAYS)));
    }

    #[test]
    fn restore_free_position_retargets_when_display_disappears_before_observation() {
        let external = DisplayFrame { x: -1920, ..DISPLAYS[0] };
        let mut machine = PlacementMachine::new(STRIP, None);
        machine.reduce(PlacementInput::RestorePosition { x: -1904, y: 500, corner: None }, &[external, DISPLAYS[0]]);
        let missing = machine.reduce(PlacementInput::Moved { x: -1904, y: 500 }, &DISPLAYS);
        assert!(!confirms(&missing));
        assert!(missing.contains(&PlacementEffect::SetPosition { generation: 1, x: 16, y: 16 }));
        assert!(machine.confirmed().is_none());
        assert!(confirms(&machine.reduce(PlacementInput::Moved { x: 16, y: 16 }, &DISPLAYS)));
        assert_eq!(machine.confirmed().unwrap().corner, None);
    }

    #[test]
    fn resize_during_restore_uses_one_location_observation_before_bottom_snap() {
        let external = DisplayFrame { x: -1920, ..DISPLAYS[0] };
        let displays = [external, DISPLAYS[0]];
        let mut machine = PlacementMachine::new(STRIP, None);
        machine.reduce(PlacementInput::RestorePosition { x: -1904, y: 500, corner: Some(Corner::BottomLeft) }, &displays);
        machine.reduce(PlacementInput::ResizeRequested { width: 420, height: 252 }, &displays);
        machine.reduce(PlacementInput::Resized { width: 420, height: 252 }, &displays);
        let located = machine.reduce(PlacementInput::Moved { x: -1904, y: 500 }, &displays);
        assert!(located.contains(&PlacementEffect::SetPosition { generation: 2, x: -1904, y: 812 }));
        assert!(!confirms(&located));
        let arrived = machine.reduce(PlacementInput::Moved { x: -1904, y: 812 }, &displays);
        assert!(arrived.contains(&PlacementEffect::Confirm(PlacementSnapshot {
            generation: 2, corner: Some(Corner::BottomLeft),
            frame: PhysicalFrame { x: -1904, y: 812, width: 420, height: 252 },
        })));
    }

    #[test]
    fn satisfied_restore_requests_do_not_block_same_height_resize_and_late_moves_are_guarded() {
        let external = DisplayFrame { x: -1920, ..DISPLAYS[0] };
        let displays = [external, DISPLAYS[0]];
        let mut machine = PlacementMachine::new(STRIP, None);
        machine.reduce(PlacementInput::RestorePosition { x: -1904, y: 500, corner: Some(Corner::BottomLeft) }, &displays);
        machine.reduce(PlacementInput::ResizeRequested { width: 420, height: 252 }, &displays);
        machine.reduce(PlacementInput::Resized { width: 420, height: 252 }, &displays);
        machine.reduce(PlacementInput::Moved { x: -1904, y: 500 }, &displays);
        machine.reduce(PlacementInput::Moved { x: -1904, y: 812 }, &displays);
        let noop = machine.reduce(PlacementInput::ResizeRequested { width: 420, height: 252 }, &displays);
        assert!(noop.contains(&PlacementEffect::Persist(PlacementSnapshot {
            generation: 3, corner: Some(Corner::BottomLeft),
            frame: PhysicalFrame { x: -1904, y: 812, width: 420, height: 252 },
        })));
        assert!(!noop.iter().any(|effect| matches!(effect,
            PlacementEffect::SetPosition { .. } | PlacementEffect::ScheduleWatchdog(_))));
        assert!(machine.reduce(PlacementInput::TimedOut(3), &displays).is_empty());

        let confirmed = machine.confirmed();
        let late = machine.reduce(PlacementInput::Moved { x: -1904, y: 500 }, &displays);
        assert!(!confirms(&late));
        assert!(late.contains(&PlacementEffect::SetPosition { generation: 3, x: -1904, y: 812 }));
        assert_eq!(machine.confirmed(), confirmed);
        machine.reduce(PlacementInput::Moved { x: -1904, y: 812 }, &displays);
        machine.reduce(PlacementInput::BeginDrag, &displays);
        machine.reduce(PlacementInput::Moved { x: 310, y: 205 }, &displays);
        assert_eq!(machine.confirmed().unwrap().corner, None);
    }

    #[test]
    fn obsolete_offscreen_restore_request_cannot_block_observed_fallback_or_overwrite_it_later() {
        let external = DisplayFrame { x: -1920, ..DISPLAYS[0] };
        let mut machine = PlacementMachine::new(STRIP, None);
        machine.reduce(PlacementInput::RestorePosition { x: -1904, y: 500, corner: None }, &[external, DISPLAYS[0]]);
        let fallback = machine.reduce(PlacementInput::Moved { x: 16, y: 16 }, &DISPLAYS);
        assert!(fallback.contains(&PlacementEffect::Persist(PlacementSnapshot {
            generation: 1, corner: None, frame: STRIP,
        })));
        assert!(!fallback.iter().any(|effect| matches!(effect,
            PlacementEffect::SetPosition { .. } | PlacementEffect::ScheduleWatchdog(_))));
        assert!(machine.reduce(PlacementInput::TimedOut(1), &DISPLAYS).is_empty());

        let confirmed = machine.confirmed();
        let late = machine.reduce(PlacementInput::Moved { x: -1904, y: 500 }, &DISPLAYS);
        assert!(!confirms(&late));
        assert!(late.contains(&PlacementEffect::SetPosition { generation: 1, x: 16, y: 16 }));
        assert_eq!(machine.confirmed(), confirmed);
        assert!(confirms(&machine.reduce(PlacementInput::Moved { x: 16, y: 16 }, &DISPLAYS)));
    }

    #[test]
    fn explicit_observed_snap_retires_superseded_restore_without_blocking_noop_resize() {
        let mut machine = PlacementMachine::new(STRIP, None);
        machine.reduce(PlacementInput::RestorePosition {
            x: 310, y: 205, corner: Some(Corner::BottomLeft),
        }, &DISPLAYS);
        let snap = machine.reduce(PlacementInput::Snap(Corner::TopLeft), &DISPLAYS);
        assert!(snap.contains(&PlacementEffect::Persist(PlacementSnapshot {
            generation: 2, corner: Some(Corner::TopLeft), frame: STRIP,
        })));
        assert!(!snap.iter().any(|effect| matches!(effect,
            PlacementEffect::SetPosition { .. } | PlacementEffect::ScheduleWatchdog(_))));
        let resize = machine.reduce(PlacementInput::ResizeRequested { width: 420, height: 50 }, &DISPLAYS);
        assert!(resize.contains(&PlacementEffect::Persist(PlacementSnapshot {
            generation: 3, corner: Some(Corner::TopLeft), frame: STRIP,
        })));
        assert!(!resize.iter().any(|effect| matches!(effect,
            PlacementEffect::SetPosition { .. } | PlacementEffect::ScheduleWatchdog(_))));
        assert!(machine.reduce(PlacementInput::TimedOut(3), &DISPLAYS).is_empty());
        let confirmed = machine.confirmed();
        let late = machine.reduce(PlacementInput::Moved { x: 310, y: 205 }, &DISPLAYS);
        assert!(!confirms(&late));
        assert!(!late.iter().any(|effect| matches!(effect, PlacementEffect::Persist(_))));
        assert!(late.contains(&PlacementEffect::SetPosition { generation: 3, x: 16, y: 16 }));
        assert_eq!(machine.confirmed(), confirmed);
        assert!(confirms(&machine.reduce(PlacementInput::Moved { x: 16, y: 16 }, &DISPLAYS)));
    }

    #[test]
    fn canceled_restore_retires_only_its_requests_and_keeps_earlier_ordinary_snap_active() {
        let mut machine = PlacementMachine::new(STRIP, None);
        machine.reduce(PlacementInput::Snap(Corner::TopRight), &DISPLAYS);
        machine.reduce(PlacementInput::RestorePosition { x: 310, y: 205, corner: None }, &DISPLAYS);
        let snap = machine.reduce(PlacementInput::Snap(Corner::TopLeft), &DISPLAYS);
        assert!(!snap.iter().any(|effect| matches!(effect,
            PlacementEffect::Confirm(_) | PlacementEffect::Persist(_))));
        assert!(snap.contains(&PlacementEffect::SetPosition { generation: 3, x: 16, y: 16 }));
        assert_eq!(machine.confirmed(), None);

        let earlier = machine.reduce(PlacementInput::Moved { x: 1484, y: 16 }, &DISPLAYS);
        assert!(!earlier.iter().any(|effect| matches!(effect,
            PlacementEffect::Confirm(_) | PlacementEffect::Persist(_))));
        assert!(earlier.contains(&PlacementEffect::SetPosition { generation: 3, x: 16, y: 16 }));
        let latest = machine.reduce(PlacementInput::Moved { x: 16, y: 16 }, &DISPLAYS);
        assert!(latest.contains(&PlacementEffect::Persist(PlacementSnapshot {
            generation: 3, corner: Some(Corner::TopLeft), frame: STRIP,
        })));

        let confirmed = machine.confirmed();
        let canceled = machine.reduce(PlacementInput::Moved { x: 310, y: 205 }, &DISPLAYS);
        assert!(!canceled.iter().any(|effect| matches!(effect,
            PlacementEffect::Confirm(_) | PlacementEffect::Persist(_))));
        assert!(canceled.contains(&PlacementEffect::SetPosition { generation: 3, x: 16, y: 16 }));
        assert_eq!(machine.confirmed(), confirmed);
    }
}
