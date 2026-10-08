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
    /// Height is physical pixels, like the native Resized observation.
    ResizeRequested(u32),
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
    required_height: Option<u32>,
    display: Option<DisplayFrame>,
}

#[derive(Debug, Clone, Copy)]
struct PendingMove {
    generation: u64,
    x: i32,
    y: i32,
}

/// Setters are requests. Only native observations (or a verified no-op) confirm.
pub struct PlacementMachine {
    observed: PhysicalFrame,
    confirmed: Option<PlacementSnapshot>,
    desired: Option<Target>,
    generation: u64,
    pending: VecDeque<PendingMove>,
    held: bool,
    dragging: bool,
    drag_moved: bool,
    drag_generation: u64,
    waiting: bool,
}

impl PlacementMachine {
    pub fn new(observed: PhysicalFrame, saved: Option<PlacementSnapshot>) -> Self {
        Self {
            observed,
            confirmed: saved,
            desired: None,
            generation: saved.map_or(0, |snapshot| snapshot.generation),
            pending: VecDeque::new(),
            held: false,
            dragging: false,
            drag_moved: false,
            drag_generation: 0,
            waiting: false,
        }
    }

    pub fn confirmed(&self) -> Option<PlacementSnapshot> {
        self.confirmed
    }

    pub fn observed(&self) -> PhysicalFrame {
        self.observed
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
            PlacementInput::BeginDrag => {
                self.dragging = true;
                self.drag_moved = false;
                self.drag_generation = self.generation;
                // A click alone must not erase the confirmed anchor.
                self.waiting = false;
                Vec::new()
            }
            PlacementInput::ResizeRequested(height) => {
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
                    frame: self.observed,
                    required_height: Some(height),
                    display: self.desired.and_then(|target| target.display)
                        .or_else(|| self.display(displays).copied()),
                });
                self.waiting = true;
                if self.observed.height == height {
                    return self.reconcile(displays);
                }
                vec![
                    PlacementEffect::SetHeight { generation: self.generation, height },
                    PlacementEffect::ScheduleWatchdog(self.generation),
                ]
            }
            PlacementInput::Moved { x, y } => {
                let unchanged = self.observed.x == x && self.observed.y == y;
                self.observed.x = x;
                self.observed.y = y;
                // Consume the oldest matching request, conservatively handling
                // repeated coordinates across multiple generations.
                if let Some(index) = self.pending.iter().position(|target| matches_position(x, y, target.x, target.y)) {
                    let target = self.pending.remove(index).expect("matched pending move");
                    if self.dragging && !self.drag_moved && target.generation <= self.drag_generation {
                        return Vec::new();
                    }
                    if self.desired.is_some_and(|desired| desired.generation == target.generation)
                        && self.ready_to_confirm()
                    {
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
                if self.dragging && !self.drag_moved
                    && self.desired.is_some_and(|target| target.generation <= self.drag_generation)
                {
                    return Vec::new();
                }
                if self.desired.is_none() {
                    self.generation += 1;
                    self.desired = Some(Target {
                        generation: self.generation,
                        corner: self.confirmed.and_then(|snapshot| snapshot.corner),
                        frame: self.observed,
                        required_height: None,
                        display: self.display(displays).copied(),
                    });
                } else if !self.waiting && !unchanged {
                    self.generation += 1;
                    if let Some(target) = self.desired.as_mut() {
                        target.generation = self.generation;
                        target.required_height = None;
                    }
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
            .or_else(|| self.confirmed.and_then(|saved| display_containing(saved.frame, displays)))
            // The adapter supplies current/primary fallback first.
            .or_else(|| displays.first())
    }

    fn snap(&mut self, corner: Corner, displays: &[DisplayFrame]) -> Vec<PlacementEffect> {
        self.dragging = false;
        self.drag_moved = false;
        self.generation += 1;
        self.desired = Some(Target {
            generation: self.generation,
            corner: Some(corner),
            frame: self.observed,
            required_height: self.desired.and_then(|target| target.required_height)
                .filter(|height| *height != self.observed.height),
            display: self.display(displays).copied(),
        });
        self.reconcile(displays)
    }

    fn reconcile(&mut self, displays: &[DisplayFrame]) -> Vec<PlacementEffect> {
        let Some(mut target) = self.desired else { return Vec::new(); };
        self.waiting = true;
        if let Some(height) = target.required_height.filter(|height| *height != self.observed.height) {
            return vec![
                PlacementEffect::SetHeight { generation: target.generation, height },
                PlacementEffect::ScheduleWatchdog(target.generation),
            ];
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
        self.desired = Some(target);
        if self.ready_to_confirm() && self.pending.is_empty() {
            return self.confirm();
        }
        if !self.pending.iter().any(|pending| pending.generation == target.generation
            && pending.x == target.frame.x && pending.y == target.frame.y)
        {
            self.pending.push_back(PendingMove {
                generation: target.generation, x: target.frame.x, y: target.frame.y,
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
                && target.required_height.is_none_or(|height| height == self.observed.height)
        })
    }

    fn confirm(&mut self) -> Vec<PlacementEffect> {
        let target = self.desired.expect("confirmation requires a desired target");
        let snapshot = PlacementSnapshot {
            generation: target.generation, corner: target.corner, frame: self.observed,
        };
        self.waiting = false;
        self.confirmed = Some(snapshot);
        vec![PlacementEffect::Confirm(snapshot), PlacementEffect::Persist(snapshot)]
    }

    fn confirm_manual(&mut self) -> Vec<PlacementEffect> {
        self.generation += 1;
        self.desired = Some(Target {
            generation: self.generation, corner: None, frame: self.observed, required_height: None,
            display: None,
        });
        self.confirm()
    }
}

fn matches_position(x: i32, y: i32, target_x: i32, target_y: i32) -> bool {
    (i64::from(x) - i64::from(target_x)).abs() <= 2
        && (i64::from(y) - i64::from(target_y)).abs() <= 2
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
        let request = machine.reduce(PlacementInput::ResizeRequested(252), &DISPLAYS);
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
        machine.reduce(PlacementInput::ResizeRequested(252), &DISPLAYS);
        let resized = machine.reduce(PlacementInput::Resized { width: 420, height: 252 }, &DISPLAYS);
        assert!(!resized.iter().any(|effect| matches!(effect, PlacementEffect::SetPosition { .. })));
        assert!(resized.contains(&PlacementEffect::Persist(PlacementSnapshot {
            generation: 2, corner: None, frame: PhysicalFrame { x: 600, y: 300, width: 420, height: 252 },
        })));
    }
}
