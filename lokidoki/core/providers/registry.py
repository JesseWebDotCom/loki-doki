"""Resolve a :class:`ProviderSpec` from the active profile.

``PLATFORM_MODELS`` is the single source of truth for which engine
runs on which profile and which model names it should request. This
module translates that catalog into a concrete HTTP endpoint + model
pair the :class:`HTTPProvider` can consume.
"""
from __future__ import annotations

from .spec import ProviderSpec


# mlx + llama.cpp engines bind their OpenAI-compatible server to :11434.
# hailo-ollama is the exception — it owns :8000 because the upstream
# Hailo client expects Ollama's fixed port, and we mirror the same port
# in the wizard's :func:`run_app.app_port_for` (the FastAPI app on
# pi_hailo moves to :7860 to free :8000 for hailo-ollama).
_ENDPOINT_FOR_ENGINE = {
    "mlx": "http://127.0.0.1:11434",
    "llama_cpp_vulkan": "http://127.0.0.1:11434",
    "llama_cpp_cpu": "http://127.0.0.1:11434",
    "hailo_ollama": "http://127.0.0.1:8000",
}


# MLX serves text + vision from the same ``mlx_lm.server`` process. The
# llama.cpp profiles spawn a dedicated second llama-server instance on
# :11435 with ``--mmproj``; splitting the process keeps the text model's
# KV cache warm across modality switches. Hailo routes both paths
# through the same hailo-ollama process on :8000.
_VISION_ENDPOINT_FOR_ENGINE = {
    "mlx": "http://127.0.0.1:11434",
    "llama_cpp_vulkan": "http://127.0.0.1:11435",
    "llama_cpp_cpu": "http://127.0.0.1:11435",
    "hailo_ollama": "http://127.0.0.1:8000",
}


def resolve_llm_provider(profile: str) -> ProviderSpec:
    """Build a :class:`ProviderSpec` for ``profile`` using ``PLATFORM_MODELS``.

    Raises ``KeyError`` if the profile is unknown — callers should
    catch and render a UX-grade error instead of crashing.
    """
    from lokidoki.core.platform import PLATFORM_MODELS

    models = PLATFORM_MODELS[profile]
    engine = models["llm_engine"]
    if engine not in _ENDPOINT_FOR_ENGINE:
        raise ValueError(f"no endpoint mapping for engine {engine!r}")
    return ProviderSpec(
        name=engine,
        endpoint=_ENDPOINT_FOR_ENGINE[engine],
        model_fast=models["llm_fast"],
        model_thinking=models["llm_thinking"],
        api_style="openai_compat",
        vision_model=models.get("vision_model"),
        vision_endpoint=_VISION_ENDPOINT_FOR_ENGINE.get(engine),
    )
