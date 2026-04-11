"""
Layer 3 — promotion via recurrence.

Most candidates enter Tier 2 (session) or Tier 3 (episodic) on first
observation. They reach durable Tier 4/5 layers only via promotion when a
claim recurs across 3+ separate session-close summaries (or 3+ separate
sessions for behavior-derived signals).

The exception is the immediate-durable carve-out: predicates in
`predicates.IMMEDIATE_DURABLE_TIER{4,5}` write to the durable tier on first
observation, *as long as they pass Layers 1 and 2*.

Phase status: M0 — stub-only no-op called by Layer 2. M4 lands the real
cross-session promotion logic and triggered consolidation; M5 lands the
behavior-pattern aggregator.

See `docs/MEMORY_DESIGN.md` §3 Layer 3 and §5 reflect job.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class PromotionResult:
    promoted: bool
    target_tier: int | None
    reason: str


def consider_promotion(candidate: Any) -> PromotionResult:  # noqa: ARG001
    """No-op promotion stub. M4 replaces this with the real logic."""
    return PromotionResult(promoted=False, target_tier=None, reason="m0_stub")
