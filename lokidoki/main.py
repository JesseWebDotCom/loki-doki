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

async def run_bootstrap():
    """Performs the actual bootstrap checks and syncs."""
    steps = [
        ("check-python", "Verifying Python 3.11+ environment...", "python3 --version"),
        ("check-uv", "Checking for uv installation...", "uv --version"),
        ("check-deps", "Synchronizing dependencies via uv...", "uv sync"),
        ("check-ui", "Verifying frontend build status...", "ls frontend/dist || echo 'No build yet'"),
        ("check-models", "Ensuring Gemma 2B model residence...", "ollama list | grep gemma || echo 'Model not resident'"),
    ]

    for step_id, message, cmd in steps:
        await bootstrap_queue.put({"type": "step_start", "step_id": step_id, "message": message})
        await asyncio.sleep(1) # Visual pacing for the wizard
        
        try:
            process = await asyncio.create_subprocess_shell(
                cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE
            )
            stdout, stderr = await process.communicate()
            
            if process.returncode == 0:
                await bootstrap_queue.put({"type": "step_done", "step_id": step_id, "message": f"Successfully completed: {step_id}"})
            else:
                await bootstrap_queue.put({"type": "step_failed", "step_id": step_id, "message": f"Failed: {stderr.decode()}"})
        except Exception as e:
            await bootstrap_queue.put({"type": "step_failed", "step_id": step_id, "message": str(e)})

    await bootstrap_queue.put({"type": "complete", "message": "All systems operational."})

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

@app.get("/")
async def root():
    return {"message": "LokiDoki Core API is running"}
