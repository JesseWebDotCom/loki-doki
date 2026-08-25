#!/bin/bash
# Dev launcher for MaiPai Home: Vite dev server (port 5173) + hot-reloading backend, for
# local editing with instant HMR. Thin wrapper around run.sh --dev so there's a single
# supervisor implementation.
#
# For normal/remote use, prefer ./run.sh (production: builds the UI and serves the whole
# app from one fast process on port 3000). The dev server ships ~18 MB of unbundled
# modules and is slow to load over the LAN.
set -e
ROOT="$(cd "$(dirname "$0")" && pwd)"
exec "$ROOT/run.sh" --dev "$@"
