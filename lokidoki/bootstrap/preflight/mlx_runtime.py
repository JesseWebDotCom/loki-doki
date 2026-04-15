"""Verify ``mlx_lm`` is importable and launch its OpenAI-compatible server.

MLX is Python-only — there is no prebuilt binary to fetch. ``uv sync``
from chunk 3 installed ``mlx-lm`` via pyproject (gated to arm64 macOS).
This preflight just proves the import works under the embedded Python
and, during warm-up, spawns ``python -m mlx_lm server`` so Layer 2 can
hit ``POST /v1/chat/completions`` the same way it hits llama-server on
other profiles.
"""
from __future__ import annotations

import asyncio
import logging
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

from ..context import StepContext
from ..events import StepLog
from ..versions import MLX_LM


_log = logging.getLogger(__name__)
_STEP_ID = "install-llm-engine"
_WARM_STEP_ID = "warm-resident-llm"


def _venv_python(ctx: StepContext) -> Path:
    project_root = ctx.data_dir.parent.resolve()
    if ctx.os_name == "Windows":
        return project_root / ".venv" / "Scripts" / "python.exe"
    return project_root / ".venv" / "bin" / "python"


async def ensure_mlx(ctx: StepContext) -> None:
    """Confirm ``mlx_lm`` is available under the embedded Python environment."""
    if ctx.os_name != "Darwin":
        raise RuntimeError(
            f"MLX is macOS-only; {ctx.os_name} profiles must use llama.cpp"
        )
    py_bin = _venv_python(ctx)
    if not py_bin.exists():
        raise RuntimeError(f"venv python missing at {py_bin} — did sync-python-deps run?")

    script = (
        "import mlx_lm, sys\n"
        "print(f'mlx_lm {mlx_lm.__version__}')\n"
    )
    ctx.emit(StepLog(step_id=_STEP_ID, line="probing mlx_lm import"))
    rc = await ctx.run_streamed([str(py_bin), "-c", script], _STEP_ID)
    if rc != 0:
        raise RuntimeError(
            "mlx_lm import failed. MLX requires macOS 13.5+ on Apple Silicon. "
            "Re-run the wizard after upgrading macOS or running ``uv sync --frozen``."
        )
    ctx.emit(StepLog(step_id=_STEP_ID, line=f"mlx_lm ready (pinned {MLX_LM['version']})"))


async def start_mlx_server(
    ctx: StepContext,
    model_id: str,
    *,
    port: int = 11434,
    ready_timeout_s: float = 180.0,
) -> int:
    """Launch ``python -m mlx_lm server`` in the background."""
    py_bin = _venv_python(ctx)
    if not py_bin.exists():
        raise RuntimeError(f"venv python missing at {py_bin}")

    cmd = [
        str(py_bin),
        "-m", "mlx_lm", "server",
        "--model", model_id,
        "--host", "127.0.0.1",
        "--port", str(port),
    ]
    log_dir = ctx.data_dir / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    log_path = log_dir / "llm.log"

    env = ctx.augmented_env()
    env["HF_HOME"] = str(ctx.data_dir / "huggingface")

    ctx.emit(
        StepLog(step_id=_WARM_STEP_ID, line=f"starting mlx_lm server: {' '.join(cmd)}")
    )

    kwargs: dict = {
        "stdout": open(log_path, "ab"),
        "stderr": subprocess.STDOUT,
        "env": env,
    }
    if sys.platform == "win32":
        kwargs["creationflags"] = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
    else:
        kwargs["start_new_session"] = True

    subprocess.Popen(cmd, **kwargs)  # noqa: S603 — paths validated above

    await _wait_for_models(f"http://127.0.0.1:{port}/v1/models", ready_timeout_s)
    ctx.emit(StepLog(step_id=_WARM_STEP_ID, line=f"mlx_lm server healthy on :{port}"))
    return port


async def _wait_for_models(url: str, timeout_s: float) -> None:
    deadline = time.monotonic() + timeout_s
    loop = asyncio.get_event_loop()
    while time.monotonic() < deadline:
        try:
            ok = await loop.run_in_executor(None, _probe, url)
        except Exception:  # noqa: BLE001 — mlx-lm is slow to allocate KV
            ok = False
        if ok:
            return
        await asyncio.sleep(1.0)
    raise RuntimeError(f"mlx_lm server did not report ready at {url} within {timeout_s:.0f}s")


def _probe(url: str) -> bool:
    try:
        with urllib.request.urlopen(url, timeout=2) as resp:
            return 200 <= resp.status < 500
    except urllib.error.URLError:
        return False
