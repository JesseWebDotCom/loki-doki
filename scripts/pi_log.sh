#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/_pi_common.sh"

FOLLOW="${1:-}"
require_pi_host

if [[ "$FOLLOW" == "--follow" || "$FOLLOW" == "-f" ]]; then
  run_ssh "touch \"$(remote_log_file)\" && tail -n 200 -f \"$(remote_log_file)\""
else
  run_ssh "if [[ -f \"$(remote_log_file)\" ]]; then tail -n 200 \"$(remote_log_file)\"; else echo 'No Pi run log yet.'; fi"
fi
