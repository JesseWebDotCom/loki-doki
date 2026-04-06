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

# Kill any existing server instances on port 8000 to ensure a clean start
echo "🧹 Cleaning up previous instances on port 8000..."
lsof -ti:8000 | xargs kill -9 2>/dev/null

# Launch the bootstrap server
echo "💎 Initializing LokiDoki Bootstrap..."
uv run run.py
