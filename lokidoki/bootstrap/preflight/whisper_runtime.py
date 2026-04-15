"""Warm Whisper STT weights.

``faster-whisper`` resolves its weights lazily from Hugging Face on first
use; this step seeds the HF cache at ``.lokidoki/huggingface`` by
instantiating ``WhisperModel`` once in a subprocess so the download
happens inside the wizard instead of the first chat turn.

``whisper.cpp`` has no lazy loader — we fetch the pinned GGML weight
file directly and verify SHA-256.
"""
from __future__ import annotations

import logging
from pathlib import Path

from ..context import StepContext
from ..events import StepLog
from ..versions import WHISPER


_log = logging.getLogger(__name__)
_STEP_ID = "install-whisper"


async def ensure_whisper_model(ctx: StepContext, model_name: str) -> None:
    """Dispatch per STT backend named in ``PLATFORM_MODELS[profile]["stt_model"]``."""
    if model_name.startswith("faster-whisper "):
        await _warm_faster_whisper(ctx, model_name.split(" ", 1)[1])
        return
    if model_name.startswith("whisper.cpp "):
        await _fetch_whisper_cpp(ctx, model_name)
        return
    raise RuntimeError(f"unsupported whisper model id {model_name!r}")


async def _warm_faster_whisper(ctx: StepContext, size_tag: str) -> None:
    py_bin = ctx.binary_path("python")
    if not py_bin.exists():
        raise RuntimeError(f"embedded python missing at {py_bin}")
    hf_home = ctx.data_dir / "huggingface"
    hf_home.mkdir(parents=True, exist_ok=True)

    project_root = ctx.data_dir.parent.resolve()
    env = ctx.augmented_env()
    env["HF_HOME"] = str(hf_home)
    env["PYTHONPATH"] = str(project_root)

    # Tolerate ImportError so the wizard can progress on a system where
    # the faster-whisper Python dep hasn't been added to pyproject yet
    # (it will be pulled in by the subsystem chunk that actually uses
    # STT). The subprocess exits 0 in both branches; a missing package
    # just logs a warning and leaves the cache empty.
    script = (
        "import sys\n"
        "try:\n"
        "    from faster_whisper import WhisperModel\n"
        "except ImportError:\n"
        "    print('faster-whisper not installed yet — skipping warm-up', file=sys.stderr)\n"
        "    sys.exit(0)\n"
        f"WhisperModel({size_tag!r}, device='cpu', compute_type='int8')\n"
        "print('faster-whisper cache seeded')\n"
    )
    cmd = [str(py_bin), "-c", script]
    ctx.emit(
        StepLog(
            step_id=_STEP_ID,
            line=f"warming faster-whisper cache for {size_tag} (HF_HOME={hf_home})",
        )
    )
    venv_python = project_root / ".venv" / ("Scripts/python.exe" if ctx.os_name == "Windows" else "bin/python")
    if venv_python.exists():
        cmd[0] = str(venv_python)
    rc = await ctx.run_streamed(cmd, _STEP_ID, cwd=project_root, env=env)
    if rc != 0:
        raise RuntimeError(f"faster-whisper warm-up failed (exit {rc})")


async def _fetch_whisper_cpp(ctx: StepContext, model_name: str) -> None:
    if model_name not in WHISPER:
        raise RuntimeError(f"no whisper.cpp entry for {model_name!r}")
    url, sha256 = WHISPER[model_name]
    target_dir = ctx.data_dir / "whisper"
    target_dir.mkdir(parents=True, exist_ok=True)
    dest = target_dir / _whisper_cpp_filename(model_name)
    if dest.exists():
        ctx.emit(StepLog(step_id=_STEP_ID, line=f"whisper.cpp weights already present: {dest.name}"))
        return
    ctx.emit(StepLog(step_id=_STEP_ID, line=f"downloading {url}"))
    await ctx.download(url, dest, _STEP_ID, sha256=sha256)
    ctx.emit(StepLog(step_id=_STEP_ID, line=f"whisper.cpp weights ready at {dest}"))


def _whisper_cpp_filename(model_name: str) -> str:
    """``"whisper.cpp base.en"`` → ``"ggml-base.en.bin"``."""
    variant = model_name.split(" ", 1)[1]
    return f"ggml-{variant}.bin"
