"""Spawn the FastAPI application once the toolchain is installed.

Invoked by the ``spawn-app`` pipeline step. Releases the stdlib wizard
server's listening socket (handoff), launches ``uvicorn`` under the
``.venv`` interpreter that chunk 3 installed, and polls ``/api/health``
until the app is reachable on port 8000.
"""
from __future__ import annotations

import asyncio
import logging
import socket
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

from .context import StepContext
from .events import PipelineComplete, StepLog


_log = logging.getLogger(__name__)
_STEP_ID = "spawn-app"
_APP_PORT = 8000
_READY_TIMEOUT_S = 30.0
_POLL_INTERVAL_S = 0.5


async def spawn_fastapi_app(ctx: StepContext) -> str:
    """Launch uvicorn, poll health, emit ``PipelineComplete``. Return app URL."""
    host = "0.0.0.0" if ctx.profile.startswith("pi_") else "127.0.0.1"
    port = _APP_PORT
    project_root = ctx.data_dir.parent.resolve()
    interpreter = _resolve_interpreter(ctx, project_root)

    handoff = ctx.handoff
    if callable(handoff):
        ctx.emit(StepLog(step_id=_STEP_ID, line=f"releasing :{port} for FastAPI handoff"))
        try:
            handoff()
        except Exception as exc:  # noqa: BLE001 — handoff is best-effort
            ctx.emit(
                StepLog(step_id=_STEP_ID, line=f"handoff warning: {exc!r}")
            )
        await _wait_for_port_free(port, deadline_s=3.0)

    log_dir = ctx.data_dir / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    app_log_path = log_dir / "app.log"

    env = ctx.augmented_env()
    env.pop("VIRTUAL_ENV", None)

    creationflags = 0
    start_new_session = False
    if ctx.os_name == "Windows" or sys.platform == "win32":
        creationflags = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
    else:
        start_new_session = True

    ctx.emit(
        StepLog(
            step_id=_STEP_ID,
            line=f"spawning {interpreter} -m uvicorn lokidoki.main:app on {host}:{port}",
        )
    )
    app_log = app_log_path.open("ab", buffering=0)
    try:
        proc = subprocess.Popen(
            [
                str(interpreter),
                "-m",
                "uvicorn",
                "lokidoki.main:app",
                "--host",
                host,
                "--port",
                str(port),
            ],
            cwd=str(project_root),
            env=env,
            stdout=app_log,
            stderr=subprocess.STDOUT,
            start_new_session=start_new_session,
            creationflags=creationflags,
        )
    except Exception:
        app_log.close()
        raise

    probe_url = f"http://127.0.0.1:{port}/api/health"
    app_url = f"http://{'127.0.0.1' if host == '0.0.0.0' else host}:{port}"
    loop = asyncio.get_event_loop()
    deadline = loop.time() + _READY_TIMEOUT_S
    while loop.time() < deadline:
        if proc.poll() is not None:
            tail = _tail_file(app_log_path, n=20)
            for line in tail:
                ctx.emit(StepLog(step_id=_STEP_ID, line=f"[app] {line}"))
            raise RuntimeError(
                f"FastAPI exited before becoming ready (code {proc.returncode})"
            )
        if await loop.run_in_executor(None, _probe, probe_url):
            ctx.emit(
                StepLog(step_id=_STEP_ID, line=f"FastAPI ready at {app_url}")
            )
            ctx.emit(PipelineComplete(app_url=app_url))
            return app_url
        await asyncio.sleep(_POLL_INTERVAL_S)

    tail = _tail_file(app_log_path, n=20)
    for line in tail:
        ctx.emit(StepLog(step_id=_STEP_ID, line=f"[app] {line}"))
    raise RuntimeError(
        f"FastAPI did not answer {probe_url} within {_READY_TIMEOUT_S:.0f}s"
    )


def _resolve_interpreter(ctx: StepContext, project_root: Path) -> Path:
    venv_root = project_root / ".venv"
    if ctx.os_name == "Windows" or sys.platform == "win32":
        venv_py = venv_root / "Scripts" / "python.exe"
    else:
        venv_py = venv_root / "bin" / "python"
    if venv_py.exists():
        return venv_py
    return ctx.binary_path("python")


async def _wait_for_port_free(port: int, deadline_s: float) -> None:
    loop = asyncio.get_event_loop()
    stop = loop.time() + deadline_s
    while loop.time() < stop:
        if not _port_in_use(port):
            return
        await asyncio.sleep(0.1)


def _port_in_use(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(0.2)
        return sock.connect_ex(("127.0.0.1", port)) == 0


def _probe(url: str) -> bool:
    try:
        with urllib.request.urlopen(url, timeout=1.0) as resp:
            return 200 <= resp.status < 300
    except (urllib.error.URLError, ConnectionError, TimeoutError, OSError):
        return False


def _tail_file(path: Path, n: int) -> list[str]:
    try:
        with path.open("rb") as fp:
            fp.seek(0, 2)
            size = fp.tell()
            read = min(size, 16_000)
            fp.seek(size - read)
            data = fp.read()
    except OSError:
        return []
    return data.decode("utf-8", errors="replace").splitlines()[-n:]
