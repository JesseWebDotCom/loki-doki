"""Stdlib HTTP server wrapping the bootstrap pipeline.

Binds ``ThreadingHTTPServer`` (chunk 2: 127.0.0.1:7861) and serves the
plain HTML/CSS/JS wizard plus a small JSON API. The pipeline runs on a
dedicated asyncio loop in one background thread; HTTP handler threads
read history and subscribe to live events via thread-safe queues on the
``Pipeline`` object.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import secrets
import threading
from dataclasses import dataclass
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Callable, Optional
from urllib.parse import urlparse

from .context import StepContext
from .events import to_json
from .pipeline import Pipeline
from .steps import Step, build_steps


_log = logging.getLogger(__name__)

_UI_DIR = Path(__file__).parent / "ui"
_STATIC_TYPES: dict[str, str] = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
    ".json": "application/json",
    ".png": "image/png",
}

_PROFILE_LABEL: dict[str, str] = {
    "mac": "macOS (Apple Silicon)",
    "windows": "Windows",
    "linux": "Desktop Linux",
    "pi_cpu": "Raspberry Pi 5 (CPU)",
    "pi_hailo": "Raspberry Pi 5 (Hailo HAT)",
}


@dataclass
class BootstrapApp:
    """Shared state the request handler pulls from."""

    pipeline: Pipeline
    ctx: StepContext
    loop: asyncio.AbstractEventLoop
    config_path: Path


class _Handler(BaseHTTPRequestHandler):
    """One-request handler — reads ``server.app`` set by :func:`make_server`."""

    server_version = "LokiDokiBootstrap/0.1"

    # ------------------------------------------------------------------
    # helpers
    # ------------------------------------------------------------------
    @property
    def app(self) -> BootstrapApp:
        return self.server.app  # type: ignore[attr-defined]

    def log_message(self, format: str, *args) -> None:  # noqa: A002 — stdlib signature
        _log.debug("%s - %s", self.address_string(), format % args)

    def _send_json(self, status: HTTPStatus, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _send_status(self, status: HTTPStatus, message: str) -> None:
        self._send_json(status, {"ok": False, "error": message})

    def _read_body(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return {}
        raw = self.rfile.read(length)
        try:
            return json.loads(raw.decode("utf-8"))
        except json.JSONDecodeError:
            return {}

    # ------------------------------------------------------------------
    # routing
    # ------------------------------------------------------------------
    def do_GET(self) -> None:  # noqa: N802 — stdlib signature
        path = urlparse(self.path).path
        if path == "/":
            self.send_response(HTTPStatus.FOUND)
            self.send_header("Location", "/bootstrap")
            self.end_headers()
            return
        if path == "/bootstrap":
            self._serve_index()
            return
        if path.startswith("/bootstrap/"):
            self._serve_static(path[len("/bootstrap/"):])
            return
        if path == "/api/v1/health":
            self._send_json(HTTPStatus.OK, {"ok": True})
            return
        if path == "/api/v1/bootstrap/profile":
            self._send_json(
                HTTPStatus.OK,
                {
                    "profile": self.app.ctx.profile,
                    "label": _PROFILE_LABEL.get(
                        self.app.ctx.profile, self.app.ctx.profile
                    ),
                    "os": self.app.ctx.os_name,
                    "arch": self.app.ctx.arch,
                },
            )
            return
        if path == "/api/v1/bootstrap/events":
            self._serve_events()
            return
        if path == "/api/v1/bootstrap/steps":
            self._serve_steps()
            return
        self._send_status(HTTPStatus.NOT_FOUND, "not found")

    # ------------------------------------------------------------------
    # GET /api/v1/bootstrap/steps
    # ------------------------------------------------------------------
    def _serve_steps(self) -> None:
        # ``_steps_by_id`` is populated by ``Pipeline.run`` before any step
        # executes — so this endpoint returns the full ordered list the UI
        # pre-populates its tile grid from, including ``can_skip`` so the
        # skip button renders before the runner starts.
        steps_by_id = self.app.pipeline._steps_by_id  # noqa: SLF001 — co-located module
        payload = [
            {
                "id": step.id,
                "label": step.label,
                "can_skip": step.can_skip,
                "est_seconds": step.est_seconds,
                "category": step.category,
            }
            for step in steps_by_id.values()
        ]
        self._send_json(HTTPStatus.OK, {"steps": payload})

    def do_POST(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        if path == "/api/v1/bootstrap/retry":
            self._serve_retry()
            return
        if path == "/api/v1/bootstrap/skip":
            self._serve_skip()
            return
        if path == "/api/v1/bootstrap/setup":
            self._serve_setup()
            return
        self._send_status(HTTPStatus.NOT_FOUND, "not found")

    # ------------------------------------------------------------------
    # GET /bootstrap  /  /bootstrap/<file>
    # ------------------------------------------------------------------
    def _serve_index(self) -> None:
        index = _UI_DIR / "index.html"
        raw = index.read_text(encoding="utf-8")
        ctx = self.app.ctx
        inject = (
            f'<script id="bootstrap-data" type="application/json">'
            f"{json.dumps({'profile': ctx.profile, 'profile_label': _PROFILE_LABEL.get(ctx.profile, ctx.profile), 'os': ctx.os_name, 'arch': ctx.arch})}"
            f"</script>"
        )
        rendered = raw.replace("<!-- BOOTSTRAP_DATA -->", inject)
        body = rendered.encode("utf-8")
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _serve_static(self, relative: str) -> None:
        safe = (_UI_DIR / relative).resolve()
        try:
            safe.relative_to(_UI_DIR.resolve())
        except ValueError:
            self._send_status(HTTPStatus.FORBIDDEN, "forbidden")
            return
        if not safe.is_file():
            self._send_status(HTTPStatus.NOT_FOUND, "not found")
            return
        body = safe.read_bytes()
        self.send_response(HTTPStatus.OK)
        self.send_header(
            "Content-Type",
            _STATIC_TYPES.get(safe.suffix, "application/octet-stream"),
        )
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    # ------------------------------------------------------------------
    # GET /api/v1/bootstrap/events   (SSE)
    # ------------------------------------------------------------------
    def _serve_events(self) -> None:
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "keep-alive")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()
        try:
            for evt in self.app.pipeline.stream():
                payload = json.dumps(to_json(evt))
                self.wfile.write(f"data: {payload}\n\n".encode("utf-8"))
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass

    # ------------------------------------------------------------------
    # POST /api/v1/bootstrap/retry
    # ------------------------------------------------------------------
    def _serve_retry(self) -> None:
        body = self._read_body()
        step_id = body.get("step_id")
        if not isinstance(step_id, str) or not step_id:
            self._send_status(HTTPStatus.BAD_REQUEST, "step_id required")
            return
        future = asyncio.run_coroutine_threadsafe(
            self.app.pipeline.retry(step_id, self.app.ctx), self.app.loop
        )
        try:
            ok = future.result(timeout=600)
        except Exception as exc:  # noqa: BLE001
            self._send_status(HTTPStatus.INTERNAL_SERVER_ERROR, str(exc))
            return
        self._send_json(HTTPStatus.OK, {"ok": bool(ok), "step_id": step_id})

    # ------------------------------------------------------------------
    # POST /api/v1/bootstrap/skip
    # ------------------------------------------------------------------
    def _serve_skip(self) -> None:
        body = self._read_body()
        step_id = body.get("step_id")
        if not isinstance(step_id, str) or not step_id:
            self._send_status(HTTPStatus.BAD_REQUEST, "step_id required")
            return
        ok = self.app.pipeline.request_skip(step_id)
        if not ok:
            self._send_status(
                HTTPStatus.BAD_REQUEST,
                f"step {step_id!r} is unknown or not marked can_skip=True",
            )
            return
        self._send_json(HTTPStatus.OK, {"ok": True, "step_id": step_id})

    # ------------------------------------------------------------------
    # POST /api/v1/bootstrap/setup
    # ------------------------------------------------------------------
    def _serve_setup(self) -> None:
        body = self._read_body()
        username = body.get("admin_username")
        password = body.get("admin_password")
        app_name = body.get("app_name") or "LokiDoki"
        if not isinstance(username, str) or not username:
            self._send_status(HTTPStatus.BAD_REQUEST, "admin_username required")
            return
        if not isinstance(password, str) or len(password) < 8:
            self._send_status(
                HTTPStatus.BAD_REQUEST, "admin_password must be 8+ chars"
            )
            return
        salt = secrets.token_bytes(16)
        digest = hashlib.scrypt(
            password.encode("utf-8"), salt=salt, n=16384, r=8, p=1, dklen=64
        )
        config_path = self.app.config_path
        config_path.parent.mkdir(parents=True, exist_ok=True)
        config_path.write_text(
            json.dumps(
                {
                    "app_name": app_name,
                    "admin_username": username,
                    "admin_password_scrypt": digest.hex(),
                    "admin_password_salt": salt.hex(),
                    "scrypt_params": {"n": 16384, "r": 8, "p": 1, "dklen": 64},
                },
                indent=2,
            ),
            encoding="utf-8",
        )
        self._send_json(HTTPStatus.OK, {"ok": True})


def make_server(
    host: str,
    port: int,
    pipeline: Pipeline,
    ctx: StepContext,
    loop: asyncio.AbstractEventLoop,
    config_path: Path,
) -> ThreadingHTTPServer:
    """Build a ``ThreadingHTTPServer`` bound to ``(host, port)``."""
    server = ThreadingHTTPServer((host, port), _Handler)
    server.app = BootstrapApp(  # type: ignore[attr-defined]
        pipeline=pipeline, ctx=ctx, loop=loop, config_path=config_path
    )
    return server


def start_pipeline_loop(
    pipeline: Pipeline, steps: list[Step], ctx: StepContext
) -> tuple[asyncio.AbstractEventLoop, threading.Thread]:
    """Start a dedicated asyncio loop in a daemon thread and schedule ``run()``."""
    # Make the step list queryable via ``/api/v1/bootstrap/steps`` before
    # ``Pipeline.run`` rewrites it on the async loop — the HTTP server can
    # otherwise race the pipeline thread and serve an empty list.
    pipeline._steps_by_id = {s.id: s for s in steps}  # noqa: SLF001
    loop = asyncio.new_event_loop()

    def _runner() -> None:
        asyncio.set_event_loop(loop)
        try:
            loop.run_until_complete(pipeline.run(steps, ctx))
            # keep the loop alive so retry() can schedule work
            loop.run_forever()
        finally:
            loop.close()

    thread = threading.Thread(
        target=_runner, name="bootstrap-pipeline", daemon=True
    )
    thread.start()
    return loop, thread
