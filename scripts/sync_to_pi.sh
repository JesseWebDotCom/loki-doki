#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/_pi_common.sh"

require_pi_host

echo "Syncing LokiDoki to $(ssh_target):$PI_REMOTE_DIR"
run_ssh "mkdir -p \"$PI_REMOTE_DIR\""

run_rsync \
  --exclude ".git/" \
  --exclude ".venv/" \
  --exclude ".uv/" \
  --exclude ".lokidoki/" \
  --exclude ".app-venv/" \
  --exclude "__pycache__/" \
  --exclude "*.pyc" \
  --exclude "app/ui/node_modules/" \
  --exclude "frontend/node_modules/" \
  --exclude ".pi.env" \
  "$ROOT_DIR/" "$(ssh_target):$PI_REMOTE_DIR/"

echo "Sync complete."
