"""Gemma + LLM fallbacks for the v2 prototype."""
from __future__ import annotations

from v2.orchestrator.fallbacks.gemma_fallback import (
    GemmaDecision,
    build_combine_prompt,
    build_gemma_payload,
    build_resolve_prompt,
    build_split_prompt,
    decide_gemma,
    gemma_synthesize,
    gemma_synthesize_async,
)
from v2.orchestrator.fallbacks.ollama_client import (
    call_gemma,
    close_client,
    set_inference_client_factory,
)
from v2.orchestrator.fallbacks.prompts import PromptRenderError, list_templates, render_prompt

__all__ = [
    "GemmaDecision",
    "PromptRenderError",
    "build_combine_prompt",
    "build_gemma_payload",
    "build_resolve_prompt",
    "build_split_prompt",
    "call_gemma",
    "close_client",
    "decide_gemma",
    "gemma_synthesize",
    "gemma_synthesize_async",
    "list_templates",
    "render_prompt",
    "set_inference_client_factory",
]
