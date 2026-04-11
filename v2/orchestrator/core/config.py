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
    # are inert.
    #
    # Default model is ``qwen3:4b-instruct-2507-q4_K_M`` (Alibaba, 4B
    # instruct variant). Selected via two bake-off rounds across 11
    # candidates (scripts/bench_v2_gemma_models.py + the 84-prompt
    # regression-fixture corpus mode). On the 84-prompt corpus
    # qwen3-instruct beats phi4-mini on every dimension:
    #
    #   metric                qwen3-instruct   phi4-mini
    #   ----------------------------------------------
    #   quality (84-prompt)   98 / 100         96 / 100
    #   issue rate            10 / 84 (12%)    23 / 84 (27%)
    #   avg warm latency      565 ms           852 ms
    #   p95 warm latency      1059 ms          1811 ms
    #   avg response length   28 words         40 words
    #   disk size             2.5 GB           2.5 GB
    #
    # The original 9-prompt curated set picked phi4-mini because none
    # of those prompts asked for real-time data — phi4-mini refuses
    # those, qwen3-instruct refuses fewer of them. Full report:
    # docs/benchmarks/v2-gemma-bakeoff-2026-04-11.md
    #
    # IMPORTANT: must be the ``-instruct-2507`` variant. The default
    # ``qwen3:4b`` tag is the *thinking* variant which leaks its
    # entire reasoning monologue into the response and pushes latency
    # past 3.5s. Confirmed via Ollama issue ollama/ollama#12917.
    #
    # Override with ``LOKI_GEMMA_MODEL`` and ``LOKI_OLLAMA_URL`` env
    # vars without touching code:
    #   LOKI_GEMMA_MODEL=phi4-mini    # tied on small set, slower at scale
    #   LOKI_GEMMA_MODEL=gemma4:e4b   # highest quality, 4x larger on disk
    #   LOKI_GEMMA_MODEL=llama3.2:3b  # smallest, fastest, RAM-budget
    gemma_ollama_url: str = field(
        default_factory=lambda: os.environ.get("LOKI_OLLAMA_URL", "http://localhost:11434")
    )
    gemma_model: str = field(
        default_factory=lambda: os.environ.get(
            "LOKI_GEMMA_MODEL", "qwen3:4b-instruct-2507-q4_K_M"
        )
    )

    # Hard cap on Gemma synthesis output tokens. Synthesis is supposed
    # to be a single short response, so the budget stays tight.
    gemma_num_predict: int = 256

    # Sampling temperature for Gemma synthesis. Zero = deterministic.
    gemma_temperature: float = 0.2


CONFIG = V2Config()
