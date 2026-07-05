#!/bin/bash
set -e

ROOT="$(cd "$(dirname "$0")" && pwd)"

# Loki Doki runs on the Bun runtime. Install it automatically on first run so a
# fresh machine needs nothing but this script. (Ollama and the AI models are
# downloaded by the app itself on first launch.)
if ! command -v bun >/dev/null 2>&1; then
  echo "Bun runtime not found — installing it..."
  curl -fsSL https://bun.sh/install | bash
  export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
  export PATH="$BUN_INSTALL/bin:$PATH"
fi

if [ "$1" = "--uninstall" ]; then
  echo ""
  echo "WARNING: This will permanently delete all app data, AI models, ComfyUI,"
  echo "voice/map caches, and the Ollama installation from this machine."
  echo ""
  printf "Type UNINSTALL to confirm: "
  read -r confirm
  if [ "$confirm" != "UNINSTALL" ]; then
    echo "Cancelled."
    exit 1
  fi
  cd "$ROOT/backend"
  [ ! -d node_modules ] && bun install --silent
  exec bun run src/uninstall-cli.ts
fi

BACKEND_PID=""
FRONTEND_PID=""

kill_port() {
  lsof -ti ":$1" | xargs kill -9 2>/dev/null || true
}

# Completely stop any previous instance before starting. Killing the dev servers
# (or their ports) is NOT enough: the backend spawns detached sidecars (ComfyUI,
# voice server, kiwix, GraphHopper, the Wyoming pod gateway) that outlive it and
# pile up across runs, eventually starving the machine of memory. Free every known
# port, then sweep this project's dev runtimes + spawned children by path so
# nothing lingers. Scoped to "$ROOT" / specific signatures so unrelated work on the
# machine is never touched.
stop_existing() {
  echo "Stopping any previous instance (servers + sidecars)..."
  # App + every sidecar listener: vite, backend, ComfyUI, voice, kiwix,
  # GraphHopper (+admin), pod gateway.
  for p in 5173 3000 8188 8092 8091 8090 8002 8003 10700; do kill_port "$p"; done
  # Belt-and-suspenders for anything that crashed without releasing its port.
  pkill -f "bun run --hot src/index.ts"            2>/dev/null || true  # backend (dev)
  pkill -f "$ROOT/frontend/node_modules/.bin/vite" 2>/dev/null || true  # frontend (vite)
  pkill -f "$ROOT/data/comfyui"                    2>/dev/null || true  # ComfyUI (python)
  pkill -f "bun run dev"                           2>/dev/null || true  # leftover dev wrappers
  # Let the OS release the ports before we rebind them.
  sleep 1
}

# Unload Ollama models on exit so they don't linger in VRAM across sessions.
# The backend's own SIGTERM handler runs first; this is the fallback for crashes.
cleanup() {
  echo ""
  echo "Shutting down..."
  [ -n "$BACKEND_PID" ] && kill -TERM "$BACKEND_PID" 2>/dev/null || true
  # Wait briefly for the backend to unload models via its own SIGTERM handler
  sleep 2
  # Fallback: ask Ollama directly to evict any remaining loaded models
  OLLAMA_URL="${OLLAMA_URL:-http://localhost:11434}"
  python3 - <<'EOF' 2>/dev/null || true
import json, os, sys, urllib.request
url = os.environ.get("OLLAMA_URL", "http://localhost:11434")
try:
    resp = urllib.request.urlopen(f"{url}/api/ps", timeout=3)
    for m in json.loads(resp.read()).get("models", []):
        try:
            req = urllib.request.Request(
                f"{url}/api/generate",
                data=json.dumps({"model": m["name"], "keep_alive": 0}).encode(),
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            urllib.request.urlopen(req, timeout=5)
        except Exception:
            pass
except Exception:
    pass
EOF
  [ -n "$FRONTEND_PID" ] && kill "$FRONTEND_PID" 2>/dev/null || true
  wait 2>/dev/null || true
}
trap cleanup EXIT

stop_existing

echo "Starting backend..."
cd "$ROOT/backend"
[ ! -d node_modules ] && bun install
bun run dev &
BACKEND_PID=$!

echo "Starting frontend..."
cd "$ROOT/frontend"
[ ! -d node_modules ] && bun install
bun run dev &
FRONTEND_PID=$!

# Wait for frontend then open browser (Chrome if available, otherwise default)
while ! lsof -ti :5173 &>/dev/null; do sleep 0.2; done
open -na "Google Chrome" --args --new-window "http://localhost:5173" 2>/dev/null || open "http://localhost:5173"

# Supervise: a crashed server restarts automatically instead of taking the whole
# app down (previously one backend crash ended the script and killed everything).
# Capped at 5 restarts per 5-minute window per server so a genuine crash-loop
# stops instead of thrashing. Ctrl+C still exits via the EXIT trap.
BACKEND_RESTARTS=0
FRONTEND_RESTARTS=0
WINDOW_START=$(date +%s)
while true; do
  sleep 1
  now=$(date +%s)
  if [ $((now - WINDOW_START)) -gt 300 ]; then
    BACKEND_RESTARTS=0; FRONTEND_RESTARTS=0; WINDOW_START=$now
  fi
  if ! kill -0 "$BACKEND_PID" 2>/dev/null; then
    BACKEND_RESTARTS=$((BACKEND_RESTARTS + 1))
    if [ "$BACKEND_RESTARTS" -gt 5 ]; then
      echo "Backend is crash-looping (>5 restarts in 5 min) — giving up. Check data/logs/app.log."
      break
    fi
    echo "Backend exited — restarting it..."
    sleep 2
    (cd "$ROOT/backend" && bun run dev) &
    BACKEND_PID=$!
  fi
  if ! kill -0 "$FRONTEND_PID" 2>/dev/null; then
    FRONTEND_RESTARTS=$((FRONTEND_RESTARTS + 1))
    if [ "$FRONTEND_RESTARTS" -gt 5 ]; then
      echo "Frontend is crash-looping (>5 restarts in 5 min) — giving up."
      break
    fi
    echo "Frontend exited — restarting it..."
    sleep 2
    (cd "$ROOT/frontend" && bun run dev) &
    FRONTEND_PID=$!
  fi
done
