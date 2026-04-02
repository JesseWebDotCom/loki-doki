#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "Syncing project to Pi..."
"$SCRIPT_DIR/sync_to_pi.sh"

echo "Restarting LokiDoki on Pi..."
"$SCRIPT_DIR/run_on_pi.sh" restart

echo "Validating Pi bootstrap and app endpoints..."
"$SCRIPT_DIR/run_on_pi.sh" validate

echo "Pi sync + restart complete."
