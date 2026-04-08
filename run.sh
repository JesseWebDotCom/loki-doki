#!/bin/bash

# LokiDoki Bootstrap Entry Point
# Ensures the bare minimum to serve the install wizard.

cd "$(dirname "$0")"

# Ensure uv is installed
if ! command -v uv &> /dev/null; then
    echo "📦 'uv' not found. Installing automatically..."
    curl -LsSf https://astral.sh/uv/install.sh | sh
    # Source the env to ensure uv is in the current session path
    source $HOME/.local/bin/env 2>/dev/null || export PATH="$HOME/.local/bin:$PATH"
fi

# Verify Python 3.11+ (Minimal check as uv handles most env logic)
PYTHON_VERSION=$(python3 -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')
if [[ $(echo "$PYTHON_VERSION < 3.11" | bc -l) -eq 1 ]]; then
    echo "❌ Error: Python 3.11 or higher is required. Found: $PYTHON_VERSION"
    exit 1
fi

# Ensure we aren't inheriting a mismatched virtualenv from the parent shell
unset VIRTUAL_ENV

# Kill ANY previous lokidoki backend instance, not just one on a specific
# port. We've been bitten by stale processes running out of an older
# clone (e.g. ~/Projects/loki-doki on port 8008) silently serving the
# frontend with out-of-date code. The match is intentionally broad:
#   - any uvicorn process whose command line mentions lokidoki/run.py/app.main
#   - anything listening on the dev ports we've used historically (8000, 8008)
# pgrep + lsof both swallow "no match" cleanly so this is safe to rerun.
echo "🧹 Cleaning up previous LokiDoki instances..."
pgrep -f "uvicorn.*(lokidoki|app\\.main)" | xargs -r kill -9 2>/dev/null
pgrep -f "loki-doki.*run\\.py" | xargs -r kill -9 2>/dev/null
for port in 8000 8008; do
    lsof -ti:"$port" 2>/dev/null | xargs -r kill -9 2>/dev/null
done
sleep 0.3

# Launch the bootstrap server
echo "💎 Initializing LokiDoki Bootstrap..."
uv run run.py
