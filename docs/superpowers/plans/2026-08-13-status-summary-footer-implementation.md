# Status Summary Footer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move session counters to the bottom-right of the expanded Attn panel while retaining them in the collapsed strip.

**Architecture:** Keep the existing counter values and footer container. Render one counter instance conditionally in the header for collapsed mode and one in the footer for expanded mode, then use the footer's flex layout to keep controls on the left and counters on the right. Do not change panel height calculations or status-model behavior.

**Tech Stack:** React 19, TypeScript, CSS, Vitest, Testing Library

---

### Task 1: Lock the expanded and collapsed counter placement

**Files:**
- Modify: `src/features/statusPanel/StatusPanelView.test.tsx`
- Test: `src/features/statusPanel/StatusPanelView.test.tsx`

- [ ] **Step 1: Add a failing placement test**

Add assertions that persistent expanded mode has no `.panel-header .panel-counters`, has `.panel-footer .panel-counters`, and that the compact initial mode has the opposite placement:

```tsx
expect(document.querySelector(".panel-header .panel-counters")).toBeNull();
expect(document.querySelector(".panel-footer .panel-counters")).not.toBeNull();

expect(document.querySelector(".panel-header .panel-counters")).not.toBeNull();
expect(document.querySelector(".panel-footer")).toBeNull();
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
rtk npm test -- --run src/features/statusPanel/StatusPanelView.test.tsx -t "places counters|starts collapsed"
```

Expected: the expanded placement assertion fails because counters are still in the header.

### Task 2: Render counters in the correct container

**Files:**
- Modify: `src/features/statusPanel/StatusPanelView.tsx:571`
- Modify: `src/App.css:119`
- Modify: `src/App.css:527`

- [ ] **Step 1: Add a local counter renderer and conditional placement**

Use one local renderer so both placements share the same accessible label and values:

```tsx
function sessionCounters() {
  return (
    <div className="panel-counters" aria-label="Session counters">
      <span>{model.interventionCount} {model.copy.alertsLabel}</span>
      <span>{model.workingCount} {model.copy.workingLabel}</span>
    </div>
  );
}
```

Render `{!panelOpen ? sessionCounters() : null}` in the header and `{sessionCounters()}` as the last child of the expanded footer.

- [ ] **Step 2: Keep counters at the footer's right edge**

Update CSS so `.panel-counters` remains an inline flex group and uses `margin-left: auto`; keep `.panel-footer` as the existing flex row with a stable minimum width for feedback and hidden-row controls.

- [ ] **Step 3: Run the focused tests and verify GREEN**

Run:

```bash
rtk npm test -- --run src/features/statusPanel/StatusPanelView.test.tsx -t "places counters|starts collapsed"
```

Expected: both counter-placement tests pass.

### Task 3: Verify compatibility and the diagnosed stability behavior

**Files:**
- Verify: `src/features/statusPanel/StatusPanelView.test.tsx`
- Verify: `scripts/codexSessionsDevSource.test.mjs`
- Verify: `src-tauri/src/inbox_store.rs`

- [ ] **Step 1: Run the full component suite**

```bash
rtk npm test -- --run src/features/statusPanel/StatusPanelView.test.tsx
```

Expected: all component tests pass, including footer feedback and hidden-row behavior.

- [ ] **Step 2: Re-run the focused running-stability tests**

```bash
rtk npm test -- --run scripts/codexSessionsDevSource.test.mjs -t "retains a Desktop running row through a degraded missing SQLite snapshot and reconfirms idle after recovery"
rtk cargo test --manifest-path src-tauri/Cargo.toml keeps_a_recent_desktop_running_row_through_a_degraded_missing_snapshot
```

Expected: preview and native Desktop snapshot stabilization tests pass.

- [ ] **Step 3: Run repository verification**

```bash
rtk npm test
rtk npm run test:rust
rtk npm run build
rtk git diff --check
```

Expected: frontend tests, Rust tests, and production build exit successfully; diff check reports no whitespace errors.

No commit or branch creation is included because the repository has no resolvable `origin/master`, the current worktree already contains overlapping user changes, and the user did not request a commit.
