#!/bin/bash

# LokiDoki Bootstrap Loader
# Primary entry point for localized agentic services.

# Ensure we are in the project root
cd "$(dirname "$0")"

# Check if uv is installed
if ! command -v uv &> /dev/null; then
    echo "Error: 'uv' is not installed. Please install it with: curl -LsSf https://astral.sh/uv/install.sh | sh"
    exit 1
fi

# Execute the bootstrap script using uv
# This automatically handles dependency sync based on pyproject.toml
echo "🚀 Bootstrapping LokiDoki Core..."
uv run run.py
