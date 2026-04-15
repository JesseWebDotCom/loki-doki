#!/bin/bash
# LokiDoki Layer 0 — thin interpreter probe. The real installer is the
# stdlib wizard at `python -m lokidoki.bootstrap`; this script only makes
# sure a Python 3.8+ interpreter is available so Layer 1 can start.
cd "$(dirname "$0")"

# Prefer the embedded interpreter once chunk 3 has installed one.
if [ -x .lokidoki/python/bin/python3 ]; then
    PY=.lokidoki/python/bin/python3
elif command -v python3 >/dev/null 2>&1; then
    PY=python3
else
    echo "LokiDoki needs a Python interpreter."
    case "$(uname -s)" in
        Darwin) echo "Install Xcode Command Line Tools: xcode-select --install" ;;
        Linux)  echo "Install python3 from your distribution's package manager." ;;
        *)      echo "Install Python 3.8 or newer and re-run ./run.sh" ;;
    esac
    exit 1
fi

"$PY" -c 'import sys; sys.exit(0 if sys.version_info >= (3,8) else 1)' || {
    echo "Python 3.8+ required"
    exit 1
}

# arm64 check on mac — Intel Macs are unsupported per docs/bootstrap_rewrite/PLAN.md.
if [ "$(uname -s)" = "Darwin" ] && [ "$(uname -m)" != "arm64" ]; then
    echo "LokiDoki requires an Apple Silicon (arm64) Mac. Intel Macs are not supported."
    exit 1
fi

unset VIRTUAL_ENV

# Clean up any stale Layer 1 server and anything holding :8000.
pgrep -f "lokidoki.bootstrap" 2>/dev/null | xargs -r kill -9 2>/dev/null
lsof -ti:8000 2>/dev/null | xargs -r kill -9 2>/dev/null

exec "$PY" -m lokidoki.bootstrap "$@"
