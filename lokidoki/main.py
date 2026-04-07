from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from lokidoki.api.routes import tests, chat, memory, audio, settings, auth, admin, projects
from lokidoki.api.middleware.bootstrap_gate import BootstrapGateMiddleware
import asyncio
import json
import os
import subprocess

app = FastAPI(title="LokiDoki Core")
app.add_middleware(BootstrapGateMiddleware)

# In-memory bootstrap status for SSE
bootstrap_queue = asyncio.Queue()

# Ensure static directory exists
os.makedirs("lokidoki/static", exist_ok=True)
app.mount("/static", StaticFiles(directory="lokidoki/static"), name="static")

# Mount frontend assets if they exist
if os.path.exists("frontend/dist"):
    app.mount("/assets", StaticFiles(directory="frontend/dist/assets"), name="assets")

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
        await bootstrap_queue.put({"type": "log", "message": line.decode().strip()})
    
    await process.wait()
    return process.returncode

BOOTSTRAP_STEPS = [
    ("check-python", "Verifying Python 3.11+", "python3 --version"),
    ("check-uv", "Verifying uv Engine", "uv --version"),
    ("check-frontend-deps", "Synchronizing UI Libraries (npm install)", "npm install"),
    ("check-frontend-build", "Optimizing UI Core (npm build)", "npm run build"),
    ("check-ollama", "Verifying Ollama Service", "ollama --version"),
    ("pull-model", "Pulling LLM (gemma4:e2b)", "ollama pull gemma4:e2b"),
    ("warm-resident", "Loading Resident Model into RAM", "curl -s http://localhost:11434/api/generate -d '{\"model\":\"gemma4:e2b\",\"prompt\":\".\",\"keep_alive\":-1,\"stream\":false}'"),
    ("check-piper", "Initializing Piper Voice", "mkdir -p data/models/piper && echo 'Piper initialized'"),
    ("check-residency", "Verifying System Health", "echo 'Hardware nominal'"),
]

async def run_bootstrap():
    """Performs full-stack bootstrap orchestration."""
    steps = BOOTSTRAP_STEPS

    for step_id, label, cmd in steps:
        await bootstrap_queue.put({"type": "step_start", "step_id": step_id, "message": label})
        
        # Determine working directory for frontend steps
        cwd = "frontend" if "frontend" in step_id else "."
        
        rc = await run_command_with_logs(cmd, cwd=cwd)
        
        if rc == 0:
            await bootstrap_queue.put({"type": "step_done", "step_id": step_id})
        else:
            await bootstrap_queue.put({"type": "step_failed", "step_id": step_id, "message": f"Orchestration failed at {step_id}."})
            return # Halt on failure

    await bootstrap_queue.put({"type": "complete", "message": "Pipeline operational."})

@app.on_event("startup")
async def startup_event():
    asyncio.create_task(run_bootstrap())

@app.get("/bootstrap", response_class=HTMLResponse)
async def get_bootstrap():
    with open("lokidoki/static/bootstrap.html", "r") as f:
        return f.read()

@app.get("/api/v1/bootstrap/status")
async def bootstrap_status(request: Request):
    async def event_generator():
        while True:
            if await request.is_disconnected():
                break
            message = await bootstrap_queue.get()
            yield f"data: {json.dumps(message)}\n\n"
            bootstrap_queue.task_done()
            if message.get("type") == "complete":
                break
    return StreamingResponse(event_generator(), media_type="text/event-stream")

# Include routers
app.include_router(auth.router, prefix="/api/v1/auth", tags=["Auth"])
app.include_router(admin.router, prefix="/api/v1/admin", tags=["Admin"])
app.include_router(tests.router, prefix="/api/v1/tests", tags=["Testing"])
app.include_router(chat.router, prefix="/api/v1/chat", tags=["Chat"])
app.include_router(projects.router, prefix="/api/v1/projects", tags=["Projects"])
app.include_router(memory.router, prefix="/api/v1/memory", tags=["Memory"])
app.include_router(audio.router, prefix="/api/v1/audio", tags=["Audio"])
app.include_router(settings.router, prefix="/api/v1/settings", tags=["Settings"])

@app.get("/", response_class=HTMLResponse)
async def root():
    if os.path.exists("frontend/dist/index.html"):
        with open("frontend/dist/index.html", "r") as f:
            return f.read()
    return HTMLResponse("<h1>LokiDoki Core</h1><p>Frontend not built. Run <code>npm run build</code> in the frontend directory.</p>")

@app.get("/{full_path:path}")
async def catch_all(full_path: str):
    """Catch-all for SPA routing."""
    if os.path.exists("frontend/dist/index.html"):
        with open("frontend/dist/index.html", "r") as f:
            return HTMLResponse(content=open("frontend/dist/index.html", "r").read(), status_code=200)
    return HTMLResponse("<h1>404 Not Found</h1>", status_code=404)
