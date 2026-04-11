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


CONFIG = V2Config()
