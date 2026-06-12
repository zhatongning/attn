---
name: attn-debug-cleanup
description: Use when working in agent-session-inbox and Rust/Tauri debug build artifacts look too large, especially src-tauri/target/debug or deps exceeds 1G or Finder reports tens of GB.
---

# Attn Debug Cleanup

## Overview

This project can safely discard Rust/Tauri debug build caches when `src-tauri/target/debug` grows past 1GiB. The cleanup script preserves the runnable debug app and removes only rebuildable artifacts.

## Quick Start

```bash
npm run clean:debug
```

For an inspection-only pass:

```bash
npm run clean:debug -- --dry-run
```

## Rules

- Run from `/Users/edy/sofdev/agent-session-inbox` or set `ATTN_REPO_ROOT`.
- The script exits without deleting when `src-tauri/target/debug` is at or below 1GiB.
- It preserves `src-tauri/target/debug/attn` and `src-tauri/target/debug/bundle/macos/Attn.app`.
- It may remove only these rebuildable targets:
  - `src-tauri/target/debug/deps`
  - `src-tauri/target/debug/incremental`
  - `src-tauri/target/debug/build`
  - `src-tauri/target/debug/.fingerprint`
  - `src-tauri/target/debug/bundle/dmg`
  - `src-tauri/target/debug/agent-session-inbox`
  - `src-tauri/target/debug/agent-session-inbox.d`

## Workflow

1. Check size when the debug directory looks large:
   ```bash
   du -sh src-tauri/target/debug src-tauri/target/debug/deps 2>/dev/null
   ```
2. Run the gated cleanup:
   ```bash
   npm run clean:debug
   ```
3. Verify the result:
   ```bash
   du -sh . src-tauri/target/debug 2>/dev/null
   npm test -- scripts/cleanDebugArtifacts.test.mjs
   ```

## Notes

Future `cargo test`, `npm run test:rust`, or `npm run tauri -- build --debug` commands will regenerate some of these caches. That is expected.
