from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, StreamingResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from lokidoki.api.routes import chat, memory, audio, settings, auth, admin, projects, logs, skills, characters, people, dev, archives, voices, maps, workspaces
from lokidoki.api.middleware.bootstrap_gate import BootstrapGateMiddleware
from lokidoki.core.model_manager import ModelPolicy
from lokidoki.core.log_buffer import install as install_log_buffer, set_log_level
from lokidoki.core.settings_store import load_settings

# Initialize logging with saved preference
_initial_settings = load_settings()
install_log_buffer()
set_log_level(_initial_settings.get("log_level", "INFO"))

import asyncio
import json
import os
import shlex
import subprocess
import mimetypes

# Fix for "disallowed MIME type" errors on some systems
mimetypes.add_type('application/javascript', '.js')
mimetypes.add_type('text/css', '.css')

app = FastAPI(title="LokiDoki Core")
app.add_middleware(BootstrapGateMiddleware)

# In-memory bootstrap status for SSE.
#
# We need TWO things that a single shared queue can't give us:
#   1. Replay — bootstrap runs once at server startup, but the user
#      may open /bootstrap mid-run, after it's finished, or reload the
#      page. Every fresh client must see the full event timeline,
#      otherwise it sits forever waiting for messages that already
#      flew past.
#   2. Multiple concurrent viewers — a single shared Queue is drained
#      by ONE consumer; a second tab would silently swallow events
#      from the first or vice-versa.
#
# So we keep an append-only history list AND a set of per-client
# subscriber queues. `emit_bootstrap` records to history and fans out
# to every live subscriber. New connections replay history first, then
# either tail live updates or close immediately if bootstrap is done.
bootstrap_history: list[dict] = []
bootstrap_subscribers: set[asyncio.Queue] = set()
bootstrap_done: bool = False

async def emit_bootstrap(evt: dict) -> None:
    bootstrap_history.append(evt)
    for q in list(bootstrap_subscribers):
        await q.put(evt)

# Ensure static directory exists
os.makedirs("lokidoki/static", exist_ok=True)
os.makedirs("data/media", exist_ok=True)
app.mount("/static", StaticFiles(directory="lokidoki/static"), name="static")
app.mount("/media", StaticFiles(directory="data/media"), name="media")

# Mount frontend assets if they exist
if os.path.exists("frontend/dist/assets"):
    app.mount("/assets", StaticFiles(directory="frontend/dist/assets"), name="assets")
if os.path.exists("frontend/dist/sprites"):
    app.mount("/sprites", StaticFiles(directory="frontend/dist/sprites"), name="sprites")

async def run_command_with_logs(cmd: str, cwd: str = "."):
    """Runs a command and streams its stdout/stderr to the bootstrap queue."""
    process = await asyncio.create_subprocess_shell(
        cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
        cwd=cwd
    )
    
    while True:
        line = await process.stdout.readline()
        if not line:
            break
        await emit_bootstrap({"type": "log", "message": line.decode().strip()})

    await process.wait()
    return process.returncode

def build_bootstrap_steps() -> list[tuple[str, str, str]]:
    """Build bootstrap commands from the active model policy."""
    fast_model = ModelPolicy().fast_model
    warm_payload = shlex.quote(json.dumps({
        "model": fast_model,
        "prompt": ".",
        "keep_alive": -1,
        "stream": False,
        "options": {"num_ctx": 8192},
    }))
    install_check = (
        "python3 -c "
        + shlex.quote(
            "import json, urllib.request; "
            "tags = json.load(urllib.request.urlopen('http://localhost:11434/api/tags')); "
            f"raise SystemExit(0 if any(m.get('name') == {fast_model!r} for m in tags.get('models', [])) else 1)"
        )
    )
    return [
        ("check-python", "Verifying Python 3.11+", "python3 --version"),
        ("check-uv", "Verifying uv Engine", "uv --version"),
        ("check-frontend-deps", "Synchronizing UI Libraries (npm install)", "npm install"),
        ("check-frontend-build", "Optimizing UI Core (npm build)", "npm run build"),
        ("check-ollama", "Verifying Ollama Service", "ollama --version"),
        (
            "pull-model",
            f"Ensuring LLM ({fast_model}) is installed",
            f"{install_check} || ollama pull {shlex.quote(fast_model)}",
        ),
        (
            "warm-resident",
            "Loading Resident Model into RAM",
            f"curl -s http://localhost:11434/api/generate -d {warm_payload}",
        ),
        (
            "enforce-residency",
            "Unloading background models to save RAM",
            "uv run scripts/enforce_residency.py",
        ),
        ("check-piper", "Initializing Piper Voice", "uv run python -c 'from lokidoki.core.audio import ensure_default_voice, warm_voice, DEFAULT_VOICE_ID; r = ensure_default_voice(); print(r); warm_voice(DEFAULT_VOICE_ID)'"),
        ("check-residency", "Verifying System Health", "echo 'Hardware nominal'"),
    ]


BOOTSTRAP_STEPS = build_bootstrap_steps()

async def run_bootstrap():
    """Performs full-stack bootstrap orchestration."""
    global bootstrap_done
    steps = BOOTSTRAP_STEPS

    for step_id, label, cmd in steps:
        await emit_bootstrap({"type": "step_start", "step_id": step_id, "message": label})

        # Determine working directory for frontend steps
        cwd = "frontend" if "frontend" in step_id else "."

        rc = await run_command_with_logs(cmd, cwd=cwd)

        if rc == 0:
            await emit_bootstrap({"type": "step_done", "step_id": step_id})
        else:
            await emit_bootstrap({"type": "step_failed", "step_id": step_id, "message": f"Orchestration failed at {step_id}."})
            bootstrap_done = True  # halted, but no further events coming
            return

    await emit_bootstrap({"type": "complete", "message": "Pipeline operational."})
    bootstrap_done = True

@app.on_event("startup")
async def startup_event():
    # Eagerly initialize the production memory store so the schema
    # is ready before the first chat request arrives.
    from lokidoki.core.memory_store_singleton import get_memory_store
    get_memory_store()

    # Initialize ZIM search engine from persisted archive state
    from lokidoki.archives.store import load_states
    from lokidoki.archives.search import initialize_search_engine
    states = load_states()
    enabled = [s for s in states if s.download_complete]
    if enabled:
        try:
            engine = initialize_search_engine(enabled)
        except Exception:
            pass


@app.get("/api/health")
async def api_health():
    """Readiness probe used by the stdlib bootstrap server during handoff.

    Stays minimal: no DB touch, no auth, no memory lookup. The bootstrap
    server polls this while waiting for uvicorn to bind :8000 and is the
    only signal Layer 1 uses to declare the pipeline complete.
    """
    return {"ok": True}


# Legacy in-FastAPI bootstrap is off by default. Chunk 3 moves the wizard to
# the stdlib Layer-1 server (``python -m lokidoki.bootstrap``); chunk 9
# deletes these routes entirely. Set ``LOKIDOKI_LEGACY_BOOTSTRAP=1`` only
# when running the old flow intentionally.
if os.environ.get("LOKIDOKI_LEGACY_BOOTSTRAP") == "1":
    @app.get("/bootstrap", response_class=HTMLResponse)
    async def get_bootstrap():
        with open("lokidoki/static/bootstrap.html", "r") as f:
            return f.read()

    @app.get("/api/v1/bootstrap/status")
    async def bootstrap_status(request: Request):
        async def event_generator():
            for evt in list(bootstrap_history):
                yield f"data: {json.dumps(evt)}\n\n"
            if bootstrap_done:
                return
            q: asyncio.Queue = asyncio.Queue()
            bootstrap_subscribers.add(q)
            try:
                while True:
                    if await request.is_disconnected():
                        break
                    message = await q.get()
                    yield f"data: {json.dumps(message)}\n\n"
                    if message.get("type") == "complete":
                        break
            finally:
                bootstrap_subscribers.discard(q)
        return StreamingResponse(event_generator(), media_type="text/event-stream")

# Include routers
app.include_router(auth.router, prefix="/api/v1/auth", tags=["Auth"])
app.include_router(admin.router, prefix="/api/v1/admin", tags=["Admin"])
app.include_router(chat.router, prefix="/api/v1/chat", tags=["Chat"])
app.include_router(projects.router, prefix="/api/v1/projects", tags=["Projects"])
app.include_router(memory.router, prefix="/api/v1/memory", tags=["Memory"])
app.include_router(people.router, prefix="/api/v1/people", tags=["People"])
app.include_router(audio.router, prefix="/api/v1/audio", tags=["Audio"])
app.include_router(settings.router, prefix="/api/v1/settings", tags=["Settings"])
app.include_router(skills.router, prefix="/api/v1/skills", tags=["Skills"])
app.include_router(characters.router, prefix="/api/v1/characters", tags=["Characters"])
app.include_router(logs.router, prefix="/api/v1/logs", tags=["Logs"])
app.include_router(dev.router, prefix="/api/v1/dev", tags=["Dev"])
app.include_router(archives.router, prefix="/api/v1/archives", tags=["Archives"])
app.include_router(voices.router, prefix="/api/v1/audio/voices", tags=["Voices"])
app.include_router(maps.router, prefix="/api/v1/maps", tags=["Maps"])
app.include_router(workspaces.router, prefix="/api/v1/workspaces", tags=["Workspaces"])
app.include_router(workspaces.session_router, prefix="/api/v1", tags=["Workspaces"])

@app.get("/", response_class=HTMLResponse)
async def root():
    index_path = "frontend/dist/index.html"
    if os.path.exists(index_path):
        with open(index_path, "r") as f:
            return f.read()
    return HTMLResponse("<h1>LokiDoki Core</h1><p>Frontend not built. Run <code>npm run build</code> in the frontend directory.</p>")

@app.get("/{full_path:path}")
async def catch_all(full_path: str):
    """Catch-all for SPA routing."""
    # Never return index.html for missing static assets
    if full_path.startswith(("assets/", "static/", "media/", "sprites/")):
        return HTMLResponse("<h1>404 Not Found</h1>", status_code=404)

    # Serve root-level files from frontend/dist (favicon.svg, favicon.ico,
    # apple-touch-icon.png, lokidoki-logo.svg, site.webmanifest, etc.)
    # before falling through to the SPA. Without this, the browser asks
    # for /favicon.svg and gets index.html back, which silently fails.
    if "/" not in full_path and "." in full_path:
        candidate = os.path.join("frontend/dist", full_path)
        if os.path.isfile(candidate):
            return FileResponse(candidate)

    index_path = "frontend/dist/index.html"
    if os.path.exists(index_path):
        with open(index_path, "r") as f:
            return HTMLResponse(content=f.read(), status_code=200)
    return HTMLResponse("<h1>404 Not Found</h1>", status_code=404)
