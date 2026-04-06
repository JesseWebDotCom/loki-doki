#!/bin/bash

# LokiDoki Bootstrap Entry Point
# Ensures the bare minimum to serve the install wizard.

cd "$(dirname "$0")"

# Check for uv
if ! command -v uv &> /dev/null; then
    echo "Error: 'uv' not found. Install: curl -LsSf https://astral.sh/uv/install.sh | sh"
    exit 1
fi

# Launch the bootstrap server
# uv run handles the initial environment sync if needed
echo "💎 Initializing LokiDoki Bootstrap..."
uv run run.py
