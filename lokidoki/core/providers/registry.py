"""Resolve a :class:`ProviderSpec` from the active profile.

``PLATFORM_MODELS`` is the single source of truth for which engine
runs on which profile and which model names it should request. This
module translates that catalog into a concrete HTTP endpoint + model
pair the :class:`HTTPProvider` can consume.
"""
from __future__ import annotations

from .spec import ProviderSpec


# Every engine we ship binds its OpenAI-compatible server to loopback
# on the same port. Keeping one port simplifies both the wizard's
# health check and the Layer 2 provider — Layer 1 decides which engine
# is live, Layer 2 just speaks OpenAI to ``:11434``.
_ENDPOINT_FOR_ENGINE = {
    "mlx": "http://127.0.0.1:11434",
    "llama_cpp_vulkan": "http://127.0.0.1:11434",
    "llama_cpp_cpu": "http://127.0.0.1:11434",
    "hailo_ollama": "http://127.0.0.1:11434",
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
    )
