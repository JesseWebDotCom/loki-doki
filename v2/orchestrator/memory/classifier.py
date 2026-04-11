"""
Layer 2 — tier classifier.

Routes a candidate that has *already* passed Layer 1 (gates) into one of the
six writable tiers: session, episodic, social, semantic, emotional, procedural.

The classifier is a **router**, not a gatekeeper. It cannot deny — Layer 1
already approved the write. It can only pick the destination.

Phase status: M0 — stub-only. M1 implements both candidate variants behind a
feature flag and bakes them off:
    - deterministic ruleset over the gate-chain output
    - constrained-decoding small model

See `docs/MEMORY_DESIGN.md` §3 Layer 2.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from v2.orchestrator.memory.tiers import Tier


@dataclass(frozen=True)
class ClassificationResult:
    target_tier: Tier | None
    confidence: float
    reason: str


def classify_candidate(candidate: Any) -> ClassificationResult:  # noqa: ARG001
    """Pick the destination tier for an already-gated candidate.

    M0 stub — always returns `None`. Real implementations land in M1.
    """
    return ClassificationResult(target_tier=None, confidence=0.0, reason="m0_stub")
