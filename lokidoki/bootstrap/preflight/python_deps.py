"""Run ``uv sync --frozen`` with the embedded interpreter.

Emits every line of uv output as :class:`StepLog` and keeps a rolling
tail so a nonzero exit propagates the last ten lines into the step
failure log.
"""
from __future__ import annotations

import asyncio
import logging
from collections import deque
from pathlib import Path

from ..context import StepContext
from ..events import StepLog


_log = logging.getLogger(__name__)
_STEP_ID = "sync-python-deps"
_TAIL_LINES = 10


async def sync_python_deps(ctx: StepContext) -> None:
    """Sync locked Python dependencies into ``<project>/.venv``."""
    uv_bin = ctx.binary_path("uv")
    py_bin = ctx.binary_path("python")
    if not uv_bin.exists():
        raise RuntimeError(f"uv is missing at {uv_bin} — did install-uv run?")
    if not py_bin.exists():
        raise RuntimeError(
            f"embedded python is missing at {py_bin} — did embed-python run?"
        )

    project_root = ctx.data_dir.parent.resolve()
    venv_dir = project_root / ".venv"

    env = ctx.augmented_env()
    env["UV_PYTHON"] = str(py_bin)
    env["UV_PROJECT_ENVIRONMENT"] = str(venv_dir)
    env.pop("VIRTUAL_ENV", None)

    cmd = [str(uv_bin), "sync", "--frozen"]
    ctx.emit(StepLog(step_id=_STEP_ID, line=f"running: {' '.join(cmd)}"))

    tail: deque[str] = deque(maxlen=_TAIL_LINES)
    rc = await _run_with_tail(cmd, project_root, env, ctx, tail)
    if rc != 0:
        tail_text = "\n".join(tail) if tail else "<no output>"
        raise RuntimeError(f"uv sync failed (exit {rc}):\n{tail_text}")


async def _run_with_tail(
    cmd: list[str],
    cwd: Path,
    env: dict[str, str],
    ctx: StepContext,
    tail: "deque[str]",
) -> int:
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
        cwd=str(cwd),
        env=env,
    )
    assert proc.stdout is not None
    while True:
        raw = await proc.stdout.readline()
        if not raw:
            break
        line = raw.decode("utf-8", errors="replace").rstrip("\r\n")
        if line:
            ctx.emit(StepLog(step_id=_STEP_ID, line=line))
            tail.append(line)
    return await proc.wait()
