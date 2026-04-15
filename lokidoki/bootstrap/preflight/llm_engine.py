"""Dispatcher — pick the right engine + weight puller for the active profile.

Every profile's engine string comes from
``PLATFORM_MODELS[profile]["llm_engine"]``. The wizard's step runners
delegate here so the step list (``install-llm-engine``, ``pull-llm-*``,
``warm-resident-llm``) is the same across profiles.
"""
from __future__ import annotations

import logging
from pathlib import Path

from ..context import StepContext
from ..events import StepLog
from .llama_cpp_runtime import (
    ensure_llama_cpp,
    llama_server_path,
    start_llama_server,
)
from .llm_models import gguf_dest_path, parse_gguf_spec, pull_gguf, pull_mlx
from .mlx_runtime import ensure_mlx, start_mlx_server


_log = logging.getLogger(__name__)
_STEP_ID_INSTALL = "install-llm-engine"
_STEP_ID_WARM = "warm-resident-llm"


def _engine(ctx: StepContext) -> str:
    from lokidoki.core.platform import PLATFORM_MODELS

    return PLATFORM_MODELS[ctx.profile]["llm_engine"]


def _model(ctx: StepContext, key: str) -> str:
    from lokidoki.core.platform import PLATFORM_MODELS

    return PLATFORM_MODELS[ctx.profile][key]


async def ensure_llm_engine(ctx: StepContext) -> None:
    """Install the LLM engine binary / verify the Python backend is ready."""
    engine = _engine(ctx)
    ctx.emit(StepLog(step_id=_STEP_ID_INSTALL, line=f"engine={engine}"))
    if engine == "mlx":
        await ensure_mlx(ctx)
    elif engine in {"llama_cpp_vulkan", "llama_cpp_cpu"}:
        await ensure_llama_cpp(ctx)
    elif engine == "hailo_ollama":
        # chunk 7 owns this path; leave a breadcrumb instead of crashing
        ctx.emit(
            StepLog(
                step_id=_STEP_ID_INSTALL,
                line="hailo_ollama install deferred to the pi_hailo chunk",
            )
        )
    else:
        raise ValueError(f"unknown llm_engine {engine!r}")


async def pull_llm_weights(ctx: StepContext, slot: str, step_id: str) -> Path:
    """Pull either ``llm_fast`` or ``llm_thinking`` weights for the active engine.

    Returns the on-disk location so ``warm-resident-llm`` can pass it
    to the server launcher.
    """
    if slot not in ("llm_fast", "llm_thinking"):
        raise ValueError(f"slot must be llm_fast / llm_thinking, got {slot!r}")
    engine = _engine(ctx)
    model_id = _model(ctx, slot)

    if engine == "mlx":
        return await pull_mlx(ctx, step_id, model_id)

    if engine in {"llama_cpp_vulkan", "llama_cpp_cpu"}:
        return await pull_gguf(ctx, step_id, model_id)

    if engine == "hailo_ollama":
        # hailo-ollama pulls weights via its own CLI in chunk 7; until
        # then emit an informational skip.
        ctx.emit(StepLog(step_id=step_id, line=f"{slot} pull deferred to hailo chunk"))
        return ctx.data_dir / "hef"  # returned path is unused on this profile

    raise ValueError(f"unknown llm_engine {engine!r}")


async def warm_resident_llm(ctx: StepContext) -> None:
    """Launch the per-engine server and verify it responds on ``/v1/models``."""
    engine = _engine(ctx)
    fast_model = _model(ctx, "llm_fast")

    if engine == "mlx":
        await start_mlx_server(ctx, fast_model)
        return

    if engine in {"llama_cpp_vulkan", "llama_cpp_cpu"}:
        # pull_llm_weights ran first and placed the GGUF here.
        ref = parse_gguf_spec(fast_model)
        weight_path = gguf_dest_path(ctx, ref)
        if not weight_path.exists():
            raise RuntimeError(f"fast model weights missing at {weight_path}")
        await start_llama_server(ctx, weight_path)
        return

    if engine == "hailo_ollama":
        ctx.emit(StepLog(step_id=_STEP_ID_WARM, line="hailo_ollama warm deferred to chunk 7"))
        return

    raise ValueError(f"unknown llm_engine {engine!r}")


# re-export path resolver so steps.py can check server liveness
__all__ = [
    "ensure_llm_engine",
    "pull_llm_weights",
    "warm_resident_llm",
    "llama_server_path",
]
