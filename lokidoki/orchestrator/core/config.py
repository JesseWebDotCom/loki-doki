"""Tunable settings, thresholds, and feature flags for the pipeline."""
from __future__ import annotations

import os
from dataclasses import dataclass, field


def _default_llm_enabled() -> bool:
    """Decide whether LLM should run by default in this process.

    Production should always run with LLM on so the user gets a real
    LLM answer when no skill matches or when a skill returns empty.
    Tests need a hermetic, deterministic stub path so CI doesn't depend
    on Ollama / a downloaded model. The override precedence is:

      1. Explicit ``LOKI_LLM_ENABLED`` env var (``0/1/true/false``).
      2. Pytest run detected via ``PYTEST_CURRENT_TEST`` or
         ``PYTEST_VERSION`` → off.
      3. Otherwise → on.
    """
    explicit = os.environ.get("LOKI_LLM_ENABLED")
    if explicit is not None:
        return explicit.strip().lower() in {"1", "true", "yes", "on"}
    if "PYTEST_CURRENT_TEST" in os.environ or "PYTEST_VERSION" in os.environ:
        return False
    return True


@dataclass(frozen=True, slots=True)
class PipelineConfig:
    """Central configuration for the request orchestrator."""

    # Routing confidence below this triggers LLM fallback consideration.
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

    # Whether the LLM fallback is wired to a real model.
    #
    # Defaults ON for production so the user always gets a real LLM
    # answer when ``decide_llm`` says LLM is needed. Defaults OFF
    # under pytest so the deterministic stub synthesizer keeps CI
    # hermetic. Override with ``LOKI_LLM_ENABLED=0`` or ``=1``.
    llm_enabled: bool = field(default_factory=_default_llm_enabled)

    # LLM endpoint URL + model tag for the LLM fallback. The HTTP call
    # only fires when ``llm_enabled`` is true; otherwise these values
    # are inert.
    #
    # Default model is ``qwen3:4b-instruct-2507-q4_K_M`` (Alibaba, 4B
    # instruct variant). Selected via two bake-off rounds across 11
    # candidates (scripts/bench_llm_models.py + the 84-prompt
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
    # docs/benchmarks/v2-llm-bakeoff-2026-04-11.md
    #
    # IMPORTANT: must be the ``-instruct-2507`` variant. The default
    # ``qwen3:4b`` tag is the *thinking* variant which leaks its
    # entire reasoning monologue into the response and pushes latency
    # past 3.5s. Confirmed via Ollama issue ollama/ollama#12917.
    #
    # Override with ``LOKI_LLM_MODEL`` and ``LOKI_LLM_ENDPOINT`` (or
    # legacy ``LOKI_OLLAMA_URL``) env vars without touching code:
    #   LOKI_LLM_MODEL=phi4-mini    # tied on small set, slower at scale
    #   LOKI_LLM_MODEL=gemma4:e4b   # highest quality, 4x larger on disk
    #   LOKI_LLM_MODEL=llama3.2:3b  # smallest, fastest, RAM-budget
    llm_endpoint: str = field(
        default_factory=lambda: os.environ.get(
            "LOKI_LLM_ENDPOINT",
            os.environ.get("LOKI_OLLAMA_URL", "http://localhost:11434"),
        )
    )
    llm_model: str = field(
        default_factory=lambda: os.environ.get(
            "LOKI_LLM_MODEL", None
        )
    )

    def __post_init__(self):
        """Lazy-load the default model from the platform policy if not set."""
        if self.llm_model is None:
            # We import ModelPolicy here to avoid a circular dependency if
            # model_manager ever imports config (though it currently doesn't).
            from lokidoki.core.model_manager import ModelPolicy
            # Use object.__setattr__ because the dataclass is frozen.
            object.__setattr__(self, "llm_model", ModelPolicy().fast_model)

    # Hard cap on LLM synthesis output tokens. Synthesis is supposed
    # to be a single short response, so the budget stays tight.
    llm_num_predict: int = 256

    # Sampling temperature for LLM synthesis. Zero = deterministic.
    llm_temperature: float = 0.2


CONFIG = PipelineConfig()
