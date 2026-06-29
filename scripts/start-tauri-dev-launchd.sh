#!/bin/zsh

set -euo pipefail

ROOT_DIR="/Users/edy/sofdev/agent-session-inbox"
LOG_DIR="${HOME}/Library/Logs/agent-session-inbox"
PATH="/Users/edy/.nvm/versions/node/v22.12.0/bin:/Users/edy/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

mkdir -p "${LOG_DIR}"
cd "${ROOT_DIR}"

exec /Users/edy/.nvm/versions/node/v22.12.0/bin/npm run tauri dev
