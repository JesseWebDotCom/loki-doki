"""Download vision weights + mmproj, spawn a dedicated llama-server on :11435.

llama.cpp serves vision as a second process: the text-model instance on
:11434 keeps its KV cache warm while vision requests hit a separate
instance on :11435 loaded with ``--mmproj``. Keeping the two processes
separate avoids expensive model swaps on every modality flip.

Two files must land on disk per profile:

- the GGUF language weights (``*Q4_K_M.gguf``)
- the matching visual projector (``mmproj-*.gguf``)

Both live under ``.lokidoki/models/vision/<repo_id>/``. The projector
filename is pinned in :data:`lokidoki.bootstrap.versions.VISION_MMPROJ`;
the weights filename is derived from the same mapping so llama-server's
``--mmproj`` flag can resolve both neighbours from one directory.
"""
from __future__ import annotations

import asyncio
import logging
import subprocess
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path

from ..context import StepContext
from ..events import StepLog
from ..versions import VISION_MMPROJ
from .llama_cpp_runtime import llama_server_path
from .llm_models import parse_gguf_spec


_log = logging.getLogger(__name__)
_STEP_ID = "install-vision"
_PULL_STEP_ID = "pull-vision-model"

VISION_PORT = 11435


@dataclass(frozen=True)
class VisionGgufRef:
    """Where the two files for a GGUF-format vision model live."""

    repo_id: str
    revision: str
    weights: Path
    mmproj: Path
    weights_filename: str
    mmproj_filename: str


def vision_llama_cpp_dest(ctx: StepContext, repo_id: str) -> Path:
    return ctx.data_dir / "models" / "vision" / repo_id


def resolve_vision_gguf(ctx: StepContext, model_ref: str) -> VisionGgufRef:
    """Parse ``"<repo>[@<sha>]:<quant>"`` and cross-check the mmproj table."""
    if model_ref not in VISION_MMPROJ:
        raise KeyError(
            f"no VISION_MMPROJ entry for {model_ref!r}; "
            "add the weights + mmproj filenames in bootstrap/versions.py"
        )
    entry = VISION_MMPROJ[model_ref]
    gguf_ref = parse_gguf_spec(model_ref)
    dest_dir = vision_llama_cpp_dest(ctx, gguf_ref.repo_id)
    return VisionGgufRef(
        repo_id=gguf_ref.repo_id,
        revision=gguf_ref.revision or "main",
        weights=dest_dir / entry["weights_filename"],
        mmproj=dest_dir / entry["mmproj_filename"],
        weights_filename=entry["weights_filename"],
        mmproj_filename=entry["mmproj_filename"],
    )


async def ensure_vision_llama_cpp(ctx: StepContext, model_ref: str) -> VisionGgufRef:
    """Download weights + mmproj, then spawn a vision-only llama-server on :11435."""
    ref = resolve_vision_gguf(ctx, model_ref)
    await _download_file(
        ctx,
        filename=ref.weights_filename,
        repo_id=ref.repo_id,
        revision=ref.revision,
        dest=ref.weights,
    )
    await _download_file(
        ctx,
        filename=ref.mmproj_filename,
        repo_id=ref.repo_id,
        revision=ref.revision,
        dest=ref.mmproj,
    )
    await _start_vision_server(ctx, ref)
    return ref


async def _download_file(
    ctx: StepContext,
    *,
    filename: str,
    repo_id: str,
    revision: str,
    dest: Path,
) -> None:
    if dest.exists() and dest.stat().st_size > 0:
        ctx.emit(StepLog(step_id=_PULL_STEP_ID, line=f"vision file already present: {dest}"))
        return
    url = (
        f"https://huggingface.co/{repo_id}/resolve/{revision}/{filename}"
        "?download=true"
    )
    ctx.emit(StepLog(step_id=_PULL_STEP_ID, line=f"downloading {url}"))
    await ctx.download(url, dest, _PULL_STEP_ID)
    ctx.emit(StepLog(step_id=_PULL_STEP_ID, line=f"vision file ready at {dest}"))


async def _start_vision_server(ctx: StepContext, ref: VisionGgufRef) -> None:
    """Spawn a second llama-server bound to :11435 with the vision mmproj.

    Idempotent — if the port already answers we skip the spawn so repeat
    runs of ``install-vision`` / ``pull-vision-model`` don't double-fork.
    """
    if await _probe_ready(f"http://127.0.0.1:{VISION_PORT}/health"):
        ctx.emit(
            StepLog(
                step_id=_STEP_ID,
                line=f"vision llama-server already live on :{VISION_PORT}",
            )
        )
        return

    binary = llama_server_path(ctx)
    if not binary.exists():
        raise RuntimeError(f"llama-server is not installed at {binary}")
    if not ref.weights.exists() or not ref.mmproj.exists():
        raise RuntimeError(
            f"vision weights missing: weights={ref.weights} mmproj={ref.mmproj}"
        )

    cmd = [
        str(binary),
        "--model", str(ref.weights),
        "--mmproj", str(ref.mmproj),
        "--host", "127.0.0.1",
        "--port", str(VISION_PORT),
        "--ctx-size", "8192",
    ]
    if ctx.profile != "pi_cpu":
        cmd += ["-ngl", "999"]

    log_dir = ctx.data_dir / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    log_path = log_dir / "llm.log"

    ctx.emit(
        StepLog(
            step_id=_STEP_ID,
            line=f"starting vision llama-server: {' '.join(cmd)}",
        )
    )

    kwargs: dict = {
        "stdout": open(log_path, "ab"),
        "stderr": subprocess.STDOUT,
        "cwd": str(binary.parent),
    }
    if sys.platform == "win32":
        kwargs["creationflags"] = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
    else:
        kwargs["start_new_session"] = True

    subprocess.Popen(cmd, **kwargs)  # noqa: S603 — path validated above

    await _wait_for_health(f"http://127.0.0.1:{VISION_PORT}/health", 180.0)
    ctx.emit(
        StepLog(step_id=_STEP_ID, line=f"vision llama-server healthy on :{VISION_PORT}")
    )


async def _wait_for_health(url: str, timeout_s: float) -> None:
    deadline = time.monotonic() + timeout_s
    loop = asyncio.get_event_loop()
    while time.monotonic() < deadline:
        try:
            ok = await loop.run_in_executor(None, _probe, url)
        except Exception:  # noqa: BLE001 — transient startup conditions
            ok = False
        if ok:
            return
        await asyncio.sleep(0.5)
    raise RuntimeError(f"vision llama-server did not report ready at {url} within {timeout_s:.0f}s")


async def _probe_ready(url: str) -> bool:
    loop = asyncio.get_event_loop()
    try:
        return await loop.run_in_executor(None, _probe, url)
    except Exception:  # noqa: BLE001
        return False


def _probe(url: str) -> bool:
    try:
        with urllib.request.urlopen(url, timeout=2) as resp:
            return 200 <= resp.status < 500
    except urllib.error.URLError:
        return False
