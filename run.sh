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

# Clean up any stale Layer 1 server, the FastAPI app, and any background
# model servers prior wizard runs left detached via start_new_session=True.
# Without this, every ./run.sh leaks an mlx_lm / llama-server / hailo-ollama
# holding multi-GB of resident memory until reboot.
# (BSD xargs has no -r, so we avoid it and check for empty PID lists explicitly.)
kill_pattern() {
    pids=$(pgrep -f "$1" 2>/dev/null)
    [ -n "$pids" ] && kill -9 $pids 2>/dev/null
    return 0
}
kill_port() {
    pids=$(lsof -ti:"$1" 2>/dev/null)
    [ -n "$pids" ] && kill -9 $pids 2>/dev/null
    return 0
}
kill_pattern "lokidoki.bootstrap"
kill_pattern "uvicorn lokidoki.main"
kill_pattern "mlx_lm[. ]server"
kill_pattern "llama-server"
kill_pattern "hailo-ollama"
kill_port 8000
kill_port 11434
kill_port 11435

exec "$PY" -m lokidoki.bootstrap "$@"
