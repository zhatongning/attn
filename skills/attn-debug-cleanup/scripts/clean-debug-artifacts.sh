#!/usr/bin/env bash
set -euo pipefail

DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run)
      DRY_RUN=1
      ;;
    --help|-h)
      cat <<'HELP'
Usage: clean-debug-artifacts.sh [--dry-run]

Deletes rebuildable Rust/Tauri debug artifacts only when
src-tauri/target/debug is larger than 1GiB.

Environment:
  ATTN_REPO_ROOT                      Override repository root.
  ATTN_DEBUG_CLEAN_THRESHOLD_BYTES    Override threshold in bytes.
HELP
      exit 0
      ;;
    *)
      echo "unknown argument: $arg" >&2
      exit 2
      ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${ATTN_REPO_ROOT:-$(cd "$SCRIPT_DIR/../../.." && pwd)}"
DEBUG_DIR="$REPO_ROOT/src-tauri/target/debug"
THRESHOLD_BYTES="${ATTN_DEBUG_CLEAN_THRESHOLD_BYTES:-1073741824}"

if ! [[ "$THRESHOLD_BYTES" =~ ^[0-9]+$ ]]; then
  echo "ATTN_DEBUG_CLEAN_THRESHOLD_BYTES must be an integer byte count" >&2
  exit 2
fi

if [[ ! -d "$DEBUG_DIR" ]]; then
  echo "nothing to clean: src-tauri/target/debug does not exist"
  exit 0
fi

debug_size_bytes() {
  du -sk "$DEBUG_DIR" | awk '{ print $1 * 1024 }'
}

relpath() {
  local path="$1"
  printf '%s\n' "${path#$REPO_ROOT/}"
}

assert_cleanup_target() {
  local path="$1"
  case "$path" in
    "$DEBUG_DIR"/*) ;;
    *)
      echo "refusing to remove path outside src-tauri/target/debug: $path" >&2
      exit 3
      ;;
  esac
}

BEFORE_BYTES="$(debug_size_bytes)"
if (( BEFORE_BYTES <= THRESHOLD_BYTES )); then
  echo "nothing to clean: src-tauri/target/debug is ${BEFORE_BYTES} bytes (threshold ${THRESHOLD_BYTES} bytes)"
  exit 0
fi

TARGETS=(
  "$DEBUG_DIR/deps"
  "$DEBUG_DIR/incremental"
  "$DEBUG_DIR/build"
  "$DEBUG_DIR/.fingerprint"
  "$DEBUG_DIR/bundle/dmg"
  "$DEBUG_DIR/agent-session-inbox"
  "$DEBUG_DIR/agent-session-inbox.d"
)

FOUND=0
for target in "${TARGETS[@]}"; do
  if [[ -e "$target" ]]; then
    FOUND=1
    assert_cleanup_target "$target"
    if (( DRY_RUN )); then
      echo "dry run: would remove $(relpath "$target")"
    else
      rm -rf "$target"
      echo "removed $(relpath "$target")"
    fi
  fi
done

if (( ! FOUND )); then
  echo "nothing to clean: configured debug artifacts are already absent"
  exit 0
fi

if (( DRY_RUN )); then
  echo "dry run: src-tauri/target/debug is ${BEFORE_BYTES} bytes (threshold ${THRESHOLD_BYTES} bytes)"
  exit 0
fi

AFTER_BYTES="$(debug_size_bytes)"
echo "cleaned src-tauri/target/debug (${BEFORE_BYTES} bytes -> ${AFTER_BYTES} bytes)"
