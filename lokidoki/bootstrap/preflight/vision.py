"""Dispatcher — install the vision model in the format the active engine wants.

Every profile's engine comes from ``PLATFORM_MODELS[profile]["llm_engine"]``;
we branch on that so the step runner is identical across profiles. The
Hailo path is stubbed here and filled in by chunk 7 — the HEF weights
need dedicated plumbing that lives alongside ``hailo-ollama``.
"""
from __future__ import annotations

import logging

from ..context import StepContext
from ..events import StepLog
from .vision_llama_cpp import ensure_vision_llama_cpp
from .vision_mlx import ensure_vision_mlx


_log = logging.getLogger(__name__)
_STEP_ID = "install-vision"


async def ensure_vision(ctx: StepContext) -> None:
    """Route to the per-engine vision installer for ``ctx.profile``."""
    from lokidoki.core.platform import PLATFORM_MODELS

    models = PLATFORM_MODELS[ctx.profile]
    engine = models["llm_engine"]
    vision_model = models["vision_model"]
    ctx.emit(StepLog(step_id=_STEP_ID, line=f"engine={engine} vision={vision_model}"))

    if engine == "mlx":
        await ensure_vision_mlx(ctx, vision_model)
        return
    if engine in {"llama_cpp_vulkan", "llama_cpp_cpu"}:
        await ensure_vision_llama_cpp(ctx, vision_model)
        return
    if engine == "hailo_ollama":
        ctx.emit(
            StepLog(
                step_id=_STEP_ID,
                line="hailo vision (.hef) install deferred to the pi_hailo chunk",
            )
        )
        return
    raise ValueError(f"unknown llm_engine {engine!r}")
