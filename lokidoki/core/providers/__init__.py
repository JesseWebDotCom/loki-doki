"""Provider abstraction over per-profile LLM backends.

Every profile's engine (MLX, llama.cpp Vulkan, llama.cpp CPU,
hailo-ollama) exposes an OpenAI-compatible ``/v1/chat/completions``
endpoint. :class:`HTTPProvider` speaks that single wire protocol; the
registry builds a :class:`ProviderSpec` from :data:`PLATFORM_MODELS` so
application code never branches on engine or profile.
"""
from .client import ChatChunk, HTTPProvider
from .registry import resolve_llm_provider
from .spec import ProviderSpec

__all__ = [
    "ChatChunk",
    "HTTPProvider",
    "ProviderSpec",
    "resolve_llm_provider",
]
