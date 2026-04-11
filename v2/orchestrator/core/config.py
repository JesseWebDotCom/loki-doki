"""Tunable settings, thresholds, and feature flags for the v2 prototype."""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class V2Config:
    """Central configuration for the v2 request orchestrator."""

    # Routing confidence below this triggers Gemma fallback consideration.
    route_confidence_threshold: float = 0.55

    # Default per-handler timeout (seconds) used by the executor.
    handler_timeout_s: float = 4.0

    # Default per-handler retry count for transient errors.
    handler_retries: int = 1

    # Backoff between retries (seconds).
    handler_retry_backoff_s: float = 0.05

    # Fast-lane: max token count for an utterance to even be considered.
    fast_lane_max_tokens: int = 8

    # Fuzzy match score required for fast-lane lemma templates (0-100).
    fast_lane_fuzzy_threshold: int = 90

    # Whether the Gemma fallback is wired to a real model. When False,
    # the fallback synthesizer formats deterministically and tags the
    # trace with `gemma_used=False, gemma_reason="stub"`.
    gemma_enabled: bool = False

    # Ollama base URL + model tag for the Gemma fallback. The HTTP call
    # only fires when ``gemma_enabled`` is true; otherwise these values
    # are inert. The default model tag matches a small Gemma function
    # model that fits CLAUDE.md's "Skills-First, LLM-Last" budget.
    gemma_ollama_url: str = "http://localhost:11434"
    gemma_model: str = "gemma3:270m"

    # Hard cap on Gemma synthesis output tokens. Synthesis is supposed
    # to be a single short response, so the budget stays tight.
    gemma_num_predict: int = 256

    # Sampling temperature for Gemma synthesis. Zero = deterministic.
    gemma_temperature: float = 0.2


CONFIG = V2Config()
