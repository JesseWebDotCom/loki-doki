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

# Mode: production by default (build the UI, serve everything from one fast process on
# port 3000). `--dev` (or run-dev.sh) starts the Vite dev server + hot-reloading backend
# for local editing with HMR — heavy to load over the LAN.
MODE="prod"
[ "$1" = "--dev" ] && MODE="dev"

BACKEND_PID=""
FRONTEND_PID=""

kill_port() {
  lsof -ti ":$1" | xargs kill -9 2>/dev/null || true
}

# Install/refresh a workspace's dependencies when node_modules is missing OR the
# lockfile/package.json has changed since the last successful install (e.g. a
# `git pull` added a dependency). Gating only on "node_modules exists" is not
# enough: after pulling a commit that adds a package, the stale node_modules is
# missing it and the app fails at runtime with no obvious cause (observed: Vite
# could not resolve `hls.js` after it was added to package.json but the machine's
# node_modules predated it). A successful install stamps a marker we compare mtimes
# against; `bun install` is a fast no-op when everything is already satisfied.
ensure_deps() {
  dir="$1"
  [ -f "$dir/package.json" ] || return 0
  stamp="$dir/node_modules/.loki-install-stamp"
  if [ ! -d "$dir/node_modules" ] || [ ! -f "$stamp" ] \
     || [ "$dir/bun.lock" -nt "$stamp" ] || [ "$dir/package.json" -nt "$stamp" ]; then
    echo "Installing/refreshing dependencies in $(basename "$dir")..."
    (cd "$dir" && bun install) && touch "$stamp"
  fi
}

# Build the frontend bundle into frontend/dist for production, but only when it's
# missing or stale — so a production launch serves an up-to-date bundle without paying
# the (~1 min) build every time. Same "stamp vs inputs" idea as ensure_deps: rebuild
# when any source under src/ (or a build-config file) is newer than the last build's
# stamp. `bun run build` runs `tsc -b && vite build` plus its asset-copy prebuild hook,
# so we always go through it. A failed build aborts rather than serving a broken bundle.
ensure_frontend_build() {
  dir="$1"
  dist="$dir/dist"; index="$dist/index.html"; stamp="$dist/.loki-build-stamp"
  needs=0
  if [ ! -f "$index" ] || [ ! -f "$stamp" ]; then
    needs=1
  else
    if [ -n "$(find "$dir/src" -type f -newer "$stamp" -print -quit 2>/dev/null)" ]; then needs=1; fi
    for f in index.html package.json bun.lock vite.config.ts vite.config.js tsconfig.json tsconfig.app.json tailwind.config.ts; do
      [ -f "$dir/$f" ] && [ "$dir/$f" -nt "$stamp" ] && needs=1
    done
  fi
  if [ "$needs" -eq 1 ]; then
    echo "Building the frontend for production (this can take a minute)..."
    (cd "$dir" && bun run build) || { echo "Frontend production build failed (see above). Fix it, or use run-dev.sh."; exit 1; }
    touch "$stamp"   # stamp AFTER a clean build — vite empties dist, so recreate it last
  else
    echo "Frontend bundle is up to date."
  fi
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
  pkill -f "bun run src/index.ts"                  2>/dev/null || true  # backend (production)
  pkill -f "bun run start"                         2>/dev/null || true  # backend (production wrapper)
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

ensure_deps "$ROOT/backend"
ensure_deps "$ROOT/frontend"

# The `dev` script sets NODE_ENV=development itself; production `start` doesn't, so set
# it here — the backend serves frontend/dist only when NODE_ENV != development.
if [ "$MODE" = "dev" ]; then
  export NODE_ENV=development
  echo "Starting backend (dev, hot reload)..."
  (cd "$ROOT/backend" && bun run dev) &
  BACKEND_PID=$!
  echo "Starting frontend (Vite dev server)..."
  (cd "$ROOT/frontend" && bun run dev) &
  FRONTEND_PID=$!
  WEB_PORT=5173
else
  export NODE_ENV=production
  ensure_frontend_build "$ROOT/frontend"
  echo "Starting the app (production: one process serves the API + bundled UI)..."
  (cd "$ROOT/backend" && bun run start) &
  BACKEND_PID=$!
  FRONTEND_PID=""   # production serves the built UI from the backend process
  WEB_PORT=3000
fi

# Wait for the web port to bind, then open browser (Chrome if available, otherwise default)
while ! lsof -ti ":$WEB_PORT" &>/dev/null; do
  kill -0 "$BACKEND_PID" 2>/dev/null || { echo "Backend exited before binding port $WEB_PORT. Check data/logs/app.log."; exit 1; }
  sleep 0.2
done
open -na "Google Chrome" --args --new-window "http://localhost:$WEB_PORT" 2>/dev/null || open "http://localhost:$WEB_PORT"

# Supervise: a crashed server restarts automatically instead of taking the whole
# app down (previously one backend crash ended the script and killed everything).
# Capped at 5 restarts per 5-minute window per server so a genuine crash-loop
# stops instead of thrashing. Ctrl+C still exits via the EXIT trap.
# Wait for a port to actually clear (not just the PID to die — `bun run dev` spawns a
# grandchild for the real `--hot` listener, which can outlive the wrapper briefly).
# Restarting into a still-bound port crashes immediately with EADDRINUSE, and that
# crash-loops through the whole restart budget in seconds while every attempt re-runs
# the full boot sequence (previously observed: exactly this, on the Windows sibling).
wait_port_free() {
  port="$1"
  for _ in $(seq 1 20); do
    lsof -ti ":$port" &>/dev/null || return 0
    kill_port "$port"
    sleep 0.3
  done
  ! lsof -ti ":$port" &>/dev/null
}

if [ "$MODE" = "dev" ]; then BACKEND_CMD="bun run dev"; else BACKEND_CMD="bun run start"; fi

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
    if ! wait_port_free 3000; then
      echo "Port 3000 would not clear — giving up."
      break
    fi
    (cd "$ROOT/backend" && $BACKEND_CMD) &
    BACKEND_PID=$!
  fi
  # Production has no separate frontend process (the backend serves the bundle).
  if [ -n "$FRONTEND_PID" ] && ! kill -0 "$FRONTEND_PID" 2>/dev/null; then
    FRONTEND_RESTARTS=$((FRONTEND_RESTARTS + 1))
    if [ "$FRONTEND_RESTARTS" -gt 5 ]; then
      echo "Frontend is crash-looping (>5 restarts in 5 min) — giving up."
      break
    fi
    echo "Frontend exited — restarting it..."
    if ! wait_port_free 5173; then
      echo "Port 5173 would not clear — giving up."
      break
    fi
    (cd "$ROOT/frontend" && bun run dev) &
    FRONTEND_PID=$!
  fi
done
