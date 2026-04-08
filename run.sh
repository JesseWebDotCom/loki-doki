#!/bin/bash

# LokiDoki Bootstrap Entry Point
# Ensures the bare minimum to serve the install wizard.

cd "$(dirname "$0")"

# ---------- Flag parsing ----------
# --rebuild / -r       force a fresh frontend build
# --no-build / -n      skip frontend build entirely (even if stale)
# --skip-clean         don't kill existing backend instances
# --help / -h          print usage
REBUILD=0
NO_BUILD=0
SKIP_CLEAN=0
for arg in "$@"; do
    case "$arg" in
        --rebuild|-r)   REBUILD=1 ;;
        --no-build|-n)  NO_BUILD=1 ;;
        --skip-clean)   SKIP_CLEAN=1 ;;
        --help|-h)
            cat <<EOF
LokiDoki run.sh — bootstrap entry point

Usage: ./run.sh [flags]

Flags:
  -r, --rebuild      Force a frontend rebuild even if dist/ looks current
  -n, --no-build     Skip the frontend build entirely (serve dist/ as-is)
      --skip-clean   Don't kill existing backend processes before launching
  -h, --help         Show this help and exit

Default behavior: rebuilds the frontend only if any source under
frontend/src, frontend/index.html, or frontend/package.json is newer
than frontend/dist/index.html.
EOF
            exit 0
            ;;
        *)
            echo "⚠️  unknown flag: $arg (try --help)"
            exit 1
            ;;
    esac
done

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

# ---------- Frontend build ----------
# Default behavior: rebuild iff any source file is newer than dist/index.html.
# --rebuild forces it; --no-build skips it.
build_frontend() {
    if [ ! -d frontend ]; then
        echo "⚠️  frontend/ directory not found — skipping build."
        return
    fi
    if ! command -v npm &> /dev/null; then
        echo "⚠️  'npm' not found — skipping frontend build."
        return
    fi
    pushd frontend > /dev/null
    if [ ! -d node_modules ]; then
        echo "📦 Installing frontend dependencies (first run)..."
        npm install --silent
    fi
    echo "🔨 Building frontend..."
    npm run build
    local rc=$?
    popd > /dev/null
    if [ $rc -ne 0 ]; then
        echo "❌ Frontend build failed."
        exit $rc
    fi
}

needs_rebuild() {
    local dist_marker="frontend/dist/index.html"
    [ -f "$dist_marker" ] || return 0
    # Any source file newer than the built marker?
    local newer
    newer=$(find frontend/src frontend/index.html frontend/package.json frontend/vite.config.* 2>/dev/null \
        -type f -newer "$dist_marker" -print -quit)
    [ -n "$newer" ]
}

if [ "$NO_BUILD" -eq 1 ]; then
    echo "⏭️  --no-build: skipping frontend build."
elif [ "$REBUILD" -eq 1 ]; then
    echo "♻️  --rebuild: forcing frontend rebuild."
    build_frontend
elif needs_rebuild; then
    echo "🔄 Frontend sources are newer than dist/ — rebuilding."
    build_frontend
else
    echo "✅ Frontend dist/ is up to date."
fi

# Kill ANY previous lokidoki backend instance, not just one on a specific
# port. We've been bitten by stale processes running out of an older
# clone (e.g. ~/Projects/loki-doki on port 8008) silently serving the
# frontend with out-of-date code. The match is intentionally broad:
#   - any uvicorn process whose command line mentions lokidoki/run.py/app.main
#   - anything listening on the dev ports we've used historically (8000, 8008)
# pgrep + lsof both swallow "no match" cleanly so this is safe to rerun.
if [ "$SKIP_CLEAN" -eq 0 ]; then
    echo "🧹 Cleaning up previous LokiDoki instances..."
    pgrep -f "uvicorn.*(lokidoki|app\\.main)" | xargs -r kill -9 2>/dev/null
    pgrep -f "loki-doki.*run\\.py" | xargs -r kill -9 2>/dev/null
    for port in 8000 8008; do
        lsof -ti:"$port" 2>/dev/null | xargs -r kill -9 2>/dev/null
    done
    sleep 0.3
fi

# Launch the bootstrap server
echo "💎 Initializing LokiDoki Bootstrap..."
uv run run.py
