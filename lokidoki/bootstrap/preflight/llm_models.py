"""Download LLM weights into ``.lokidoki/models/llm/``.

Two formats are supported depending on the engine:

- **GGUF** (``llama_cpp_*``) — a single file per quantisation inside a
  Hugging Face GGUF repo. The model id in ``PLATFORM_MODELS`` is
  ``"<repo_id>:<quantisation>"`` (e.g. ``"Qwen/Qwen3-8B-GGUF:Q4_K_M"``);
  optionally pinned to a commit via ``"<repo_id>@<sha>:<quant>"``.
- **MLX** (``mlx``) — a sharded repo of safetensors + config files, so
  we use ``huggingface_hub.snapshot_download`` under the embedded
  Python. The model id is the full HF repo slug (e.g.
  ``"mlx-community/Qwen3-8B-4bit"``).
"""
from __future__ import annotations

import logging
import shlex
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from ..context import StepContext
from ..events import StepLog


_log = logging.getLogger(__name__)


@dataclass(frozen=True)
class GgufRef:
    repo_id: str
    filename: str  # resolved GGUF filename (e.g. ``qwen3-8b-q4_k_m.gguf``)
    revision: Optional[str] = None  # commit sha if the model string pinned one


def parse_gguf_spec(model_id: str) -> GgufRef:
    """Parse ``"<repo_id>[@<sha>]:<quantisation>"`` into a :class:`GgufRef`.

    The quantisation segment (``Q4_K_M``) is mapped into the conventional
    HF GGUF filename ``<basename>-<quant-lower>.gguf`` — e.g.
    ``"Qwen/Qwen3-8B-GGUF:Q4_K_M"`` → ``Qwen3-8B-Q4_K_M.gguf``. Most
    GGUF repos on HF follow this pattern; if a given repo names its
    files differently the caller can override by using
    ``"<repo>:<filename>"`` (i.e. passing the literal filename after the
    colon).
    """
    if ":" not in model_id:
        raise ValueError(f"expected '<repo>:<quant>' form, got {model_id!r}")
    repo_part, quant = model_id.rsplit(":", 1)
    revision: Optional[str] = None
    if "@" in repo_part:
        repo_part, revision = repo_part.split("@", 1)
    # If the caller supplied a filename (contains ".gguf") use it as-is.
    if quant.lower().endswith(".gguf"):
        filename = quant
    else:
        basename = repo_part.split("/")[-1]
        if basename.upper().endswith("-GGUF"):
            basename = basename[: -len("-GGUF")]
        filename = f"{basename}-{quant}.gguf"
    return GgufRef(repo_id=repo_part, filename=filename, revision=revision)


def gguf_dest_path(ctx: StepContext, ref: GgufRef) -> Path:
    return ctx.data_dir / "models" / "llm" / ref.repo_id / ref.filename


async def pull_gguf(ctx: StepContext, step_id: str, model_id: str) -> Path:
    """Download a single GGUF quantisation from Hugging Face.

    Returns the on-disk path. Idempotent: if the file already exists we
    skip the download — HF does not publish a stable per-file digest we
    could re-verify against, so we trust the cached file's size.
    """
    ref = parse_gguf_spec(model_id)
    dest = gguf_dest_path(ctx, ref)
    if dest.exists() and dest.stat().st_size > 0:
        ctx.emit(
            StepLog(step_id=step_id, line=f"gguf already present: {dest}")
        )
        return dest

    revision = ref.revision or "main"
    url = (
        f"https://huggingface.co/{ref.repo_id}/resolve/{revision}/{ref.filename}"
        "?download=true"
    )
    ctx.emit(StepLog(step_id=step_id, line=f"downloading {url}"))
    await ctx.download(url, dest, step_id)  # no sha256 — HF does not publish one per file
    ctx.emit(StepLog(step_id=step_id, line=f"gguf ready at {dest}"))
    return dest


async def pull_mlx(ctx: StepContext, step_id: str, repo_id: str) -> Path:
    """Snapshot an MLX repo into ``.lokidoki/models/llm/<repo>/``.

    MLX repos ship sharded safetensors + config files; ``snapshot_download``
    is the canonical way to materialise them locally with retries and
    hashing. We drive it via the embedded Python so the download happens
    in the same venv ``mlx_lm`` runs under.
    """
    venv_python = _venv_python(ctx)
    if not venv_python.exists():
        raise RuntimeError(f"venv python missing at {venv_python}")

    dest = ctx.data_dir / "models" / "llm" / repo_id
    dest.mkdir(parents=True, exist_ok=True)
    hf_home = ctx.data_dir / "huggingface"
    hf_home.mkdir(parents=True, exist_ok=True)

    env = ctx.augmented_env()
    env["HF_HOME"] = str(hf_home)

    script = (
        "from huggingface_hub import snapshot_download\n"
        f"path = snapshot_download(repo_id={repo_id!r}, local_dir={str(dest)!r})\n"
        "print(f'snapshot ready at {path}')\n"
    )
    cmd = [str(venv_python), "-c", script]
    ctx.emit(
        StepLog(step_id=step_id, line=f"huggingface snapshot_download {repo_id} → {dest}")
    )
    rc = await ctx.run_streamed(cmd, step_id, env=env)
    if rc != 0:
        raise RuntimeError(f"snapshot_download failed for {repo_id} (exit {rc})")
    return dest


def _venv_python(ctx: StepContext) -> Path:
    project_root = ctx.data_dir.parent.resolve()
    if ctx.os_name == "Windows":
        return project_root / ".venv" / "Scripts" / "python.exe"
    return project_root / ".venv" / "bin" / "python"


# quiet unused-import for tools that scan imports
_ = shlex
