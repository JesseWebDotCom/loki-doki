"""Decomposer — LLM-driven routing prior.

Runs a small fast Qwen call in parallel with the MiniLM router to emit
a ``capability_need`` enum value. The router treats it as a scoring
prior (bonus on the matching capability), not an override — so if the
LLM is unreachable or times out, MiniLM-only routing still works.

Public API:
    ``decompose_for_routing(raw_text)`` → :class:`RouteDecomposition`
    ``capability_boost(capability_need, capability)`` → float prior

The heavy multi-field decomposer prompt used for memory extraction
lives separately at ``lokidoki.core.prompts.decomposition`` — this
module intentionally uses a minimal routing-only prompt to stay under
~1.5KB and keep latency in the 200-400ms range on a Pi fast model.
"""
from __future__ import annotations

from lokidoki.orchestrator.decomposer.capability_map import (
    CAPABILITY_BOOSTS,
    capability_boost,
    capabilities_for_need,
)
from lokidoki.orchestrator.decomposer.client import decompose_for_routing
from lokidoki.orchestrator.decomposer.types import (
    CAPABILITY_NEEDS,
    RouteDecomposition,
)

__all__ = [
    "CAPABILITY_BOOSTS",
    "CAPABILITY_NEEDS",
    "RouteDecomposition",
    "capabilities_for_need",
    "capability_boost",
    "decompose_for_routing",
]
