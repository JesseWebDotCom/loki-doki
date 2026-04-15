"""Download the MLX vision model snapshot on mac.

MLX-LM's server from chunk 5 handles vision-capable models natively —
if a request carries image content it dispatches to the VL codepath. So
the mac preflight is a pure snapshot download; no second process, no
separate endpoint. ``snapshot_download`` is driven under the embedded
venv python so the shards end up in the same HF cache layout ``mlx_lm``
expects when it loads the weights on first request.
"""
from __future__ import annotations

import logging
from pathlib import Path

from ..context import StepContext
from ..events import StepLog


_log = logging.getLogger(__name__)
_STEP_ID = "install-vision"


def mlx_vision_dest(ctx: StepContext, repo_id: str) -> Path:
    return ctx.data_dir / "models" / "vision" / repo_id


async def ensure_vision_mlx(ctx: StepContext, repo_id: str) -> Path:
    """Snapshot the MLX vision repo into ``.lokidoki/models/vision/<repo>/``."""
    dest = mlx_vision_dest(ctx, repo_id)
    shard_sentinel = next(dest.glob("*.safetensors"), None) if dest.exists() else None
    if shard_sentinel is not None:
        ctx.emit(StepLog(step_id=_STEP_ID, line=f"mlx vision already present at {dest}"))
        return dest

    venv_python = _venv_python(ctx)
    if not venv_python.exists():
        raise RuntimeError(f"venv python missing at {venv_python}")

    dest.mkdir(parents=True, exist_ok=True)
    hf_home = ctx.data_dir / "huggingface"
    hf_home.mkdir(parents=True, exist_ok=True)

    env = ctx.augmented_env()
    env["HF_HOME"] = str(hf_home)

    script = (
        "from huggingface_hub import snapshot_download\n"
        f"path = snapshot_download(repo_id={repo_id!r}, local_dir={str(dest)!r})\n"
        "print(f'mlx vision snapshot ready at {path}')\n"
    )
    ctx.emit(
        StepLog(step_id=_STEP_ID, line=f"huggingface snapshot_download {repo_id} → {dest}")
    )
    rc = await ctx.run_streamed([str(venv_python), "-c", script], _STEP_ID, env=env)
    if rc != 0:
        raise RuntimeError(f"snapshot_download failed for {repo_id} (exit {rc})")
    return dest


def _venv_python(ctx: StepContext) -> Path:
    project_root = ctx.data_dir.parent.resolve()
    if ctx.os_name == "Windows":
        return project_root / ".venv" / "Scripts" / "python.exe"
    return project_root / ".venv" / "bin" / "python"
