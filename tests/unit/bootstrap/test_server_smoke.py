"""Smoke test: bootstrap server answers health / index / SSE."""
from __future__ import annotations

import asyncio
import platform
import socket
import threading
import time
import urllib.request
from pathlib import Path

import pytest

from lokidoki.bootstrap.context import StepContext
from lokidoki.bootstrap.pipeline import Pipeline
from lokidoki.bootstrap.server import make_server, start_pipeline_loop
from lokidoki.bootstrap.steps import Step


def _find_free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _tiny_steps() -> list[Step]:
    async def _short(ctx: StepContext) -> None:
        await asyncio.sleep(0.05)

    return [Step(id="hello", label="Hello", run=_short)]


@pytest.fixture
def running_server(tmp_path: Path):
    pipeline = Pipeline()
    ctx = StepContext(
        data_dir=tmp_path,
        profile="mac",
        arch=platform.machine() or "arm64",
        os_name=platform.system(),
        emit=pipeline.emit,
    )
    steps = _tiny_steps()
    loop, pipeline_thread = start_pipeline_loop(pipeline, steps, ctx)
    port = _find_free_port()
    server = make_server(
        "127.0.0.1", port, pipeline, ctx, loop,
        config_path=tmp_path / "bootstrap_config.json",
    )

    serve_thread = threading.Thread(target=server.serve_forever, daemon=True)
    serve_thread.start()
    try:
        yield port
    finally:
        server.shutdown()
        server.server_close()
        loop.call_soon_threadsafe(loop.stop)
        serve_thread.join(timeout=2)
        pipeline_thread.join(timeout=2)


def test_health(running_server: int) -> None:
    resp = urllib.request.urlopen(
        f"http://127.0.0.1:{running_server}/api/v1/health", timeout=5
    )
    body = resp.read().decode("utf-8")
    assert resp.status == 200
    assert '"ok"' in body and "true" in body


def test_index_html(running_server: int) -> None:
    resp = urllib.request.urlopen(
        f"http://127.0.0.1:{running_server}/bootstrap", timeout=5
    )
    body = resp.read().decode("utf-8")
    assert resp.status == 200
    assert "LokiDoki" in body
    assert "bootstrap-data" in body  # injected profile payload present


def test_sse_emits_step_start(running_server: int) -> None:
    deadline = time.time() + 5
    req = urllib.request.Request(
        f"http://127.0.0.1:{running_server}/api/v1/bootstrap/events"
    )
    with urllib.request.urlopen(req, timeout=5) as stream:
        buffer = b""
        while time.time() < deadline:
            chunk = stream.read(256)
            if not chunk:
                break
            buffer += chunk
            if b"step_start" in buffer:
                break
    assert b"step_start" in buffer
