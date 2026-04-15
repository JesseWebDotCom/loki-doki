"""Typed description of a configured LLM backend."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional


@dataclass(frozen=True)
class ProviderSpec:
    """Where to reach the LLM backend + which models to ask it for.

    Fields:
        name: Engine identifier — one of ``mlx``, ``llama_cpp_vulkan``,
            ``llama_cpp_cpu``, ``hailo_ollama``. Matches
            ``PLATFORM_MODELS[profile]["llm_engine"]``.
        endpoint: Base URL of the OpenAI-compatible server. No trailing
            slash — ``HTTPProvider`` appends ``/v1/…`` paths.
        model_fast: Model identifier for the non-thinking ("fast")
            path. Format is engine-specific: a GGUF spec like
            ``"Qwen/Qwen3-8B-GGUF:Q4_K_M"`` for llama.cpp, an HF repo
            slug like ``"mlx-community/Qwen3-8B-4bit"`` for MLX, or an
            Ollama tag like ``"qwen3:1.7b"`` for hailo-ollama.
        model_thinking: Same format, thinking/reasoning model.
        api_style: Wire style the endpoint speaks. Currently always
            ``"openai_compat"`` — MLX-LM's server, llama-server, and
            Ollama 0.1.37+ all expose ``/v1/chat/completions`` SSE. A
            future HTTPS-only or OpenRouter-style backend would add a
            new value here instead of branching inside the client.
        vision_model: Engine-specific identifier of the image-aware
            model. Same format rules as ``model_fast``. ``None`` when
            the profile's engine has no vision path wired yet.
        vision_endpoint: Base URL of the vision-capable server. On mac
            (MLX) this equals ``endpoint`` — vision + text share the
            same process. On llama.cpp profiles it is a distinct
            loopback port (``:11435``) so the text model's KV cache
            does not churn across modalities.
    """

    name: str
    endpoint: str
    model_fast: str
    model_thinking: str
    api_style: str = "openai_compat"
    vision_model: Optional[str] = None
    vision_endpoint: Optional[str] = None

    def model_for(self, complexity: str) -> str:
        """Pick ``model_fast`` or ``model_thinking`` from a complexity tag."""
        if complexity == "thinking":
            return self.model_thinking
        return self.model_fast
