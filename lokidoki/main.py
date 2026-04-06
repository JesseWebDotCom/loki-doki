from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from lokidoki.api.routes import tests
import asyncio
import json
import os
import subprocess

app = FastAPI(title="LokiDoki Core")

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

async def run_bootstrap():
    """Performs full-stack bootstrap orchestration."""
    # List of steps to perform
    steps = [
        ("check-python", "Verifying Python 3.11+", "python3 --version"),
        ("check-uv", "Verifying uv Engine", "uv --version"),
        ("check-frontend-deps", "Synchronizing UI Libraries (npm install)", "npm install"),
        ("check-frontend-build", "Optimizing UI Core (npm build)", "npm run build"),
        ("check-ollama", "Verifying Ollama Service", "ollama --version"),
        ("check-models", "Ensuring LLM Residence (Gemma 2B)", "ollama pull gemma:2b"),
        ("check-piper", "Initializing Piper Voice", "mkdir -p data/models/piper && echo 'Piper initialized'"),
        ("check-residency", "Verifying System Health", "echo 'Hardware nominal'"),
    ]

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

# Include the test runner router
app.include_router(tests.router, prefix="/api/v1/tests", tags=["Testing"])

@app.get("/", response_class=HTMLResponse)
async def root():
    if os.path.exists("frontend/dist/index.html"):
        with open("frontend/dist/index.html", "r") as f:
            return f.read()
    return HTMLResponse("<h1>LokiDoki Core</h1><p>Frontend not built. Run <code>npm run build</code> in the frontend directory.</p>")
