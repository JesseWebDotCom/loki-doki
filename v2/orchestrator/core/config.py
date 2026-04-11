"""Tunable settings, thresholds, and feature flags for the v2 prototype."""
from __future__ import annotations

import os
from dataclasses import dataclass, field


def _default_gemma_enabled() -> bool:
    """Decide whether Gemma should run by default in this process.

    Production should always run with Gemma on so the user gets a real
    LLM answer when no skill matches or when a skill returns empty.
    Tests need a hermetic, deterministic stub path so CI doesn't depend
    on Ollama / a downloaded model. The override precedence is:

      1. Explicit ``LOKI_GEMMA_ENABLED`` env var (``0/1/true/false``).
      2. Pytest run detected via ``PYTEST_CURRENT_TEST`` or
         ``PYTEST_VERSION`` → off.
      3. Otherwise → on.
    """
    explicit = os.environ.get("LOKI_GEMMA_ENABLED")
    if explicit is not None:
        return explicit.strip().lower() in {"1", "true", "yes", "on"}
    if "PYTEST_CURRENT_TEST" in os.environ or "PYTEST_VERSION" in os.environ:
        return False
    return True


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

    # Whether the Gemma fallback is wired to a real model.
    #
    # Defaults ON for production so the user always gets a real LLM
    # answer when ``decide_gemma`` says Gemma is needed. Defaults OFF
    # under pytest so the deterministic stub synthesizer keeps CI
    # hermetic. Override with ``LOKI_GEMMA_ENABLED=0`` or ``=1``.
    gemma_enabled: bool = field(default_factory=_default_gemma_enabled)

    # Ollama base URL + model tag for the Gemma fallback. The HTTP call
    # only fires when ``gemma_enabled`` is true; otherwise these values
    # are inert. ``gemma4:e4b`` is the canonical model across the v2
    # prototype — it's the 8B (~5.1B effective) Gemma-4 family checkpoint
    # and produces the strongest synthesis quality of the locally
    # available options. Override with ``LOKI_GEMMA_MODEL`` and
    # ``LOKI_OLLAMA_URL`` env vars without touching code.
    gemma_ollama_url: str = field(
        default_factory=lambda: os.environ.get("LOKI_OLLAMA_URL", "http://localhost:11434")
    )
    gemma_model: str = field(
        default_factory=lambda: os.environ.get("LOKI_GEMMA_MODEL", "gemma4:e4b")
    )

    # Hard cap on Gemma synthesis output tokens. Synthesis is supposed
    # to be a single short response, so the budget stays tight.
    gemma_num_predict: int = 256

    # Sampling temperature for Gemma synthesis. Zero = deterministic.
    gemma_temperature: float = 0.2


CONFIG = V2Config()
