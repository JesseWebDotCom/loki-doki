"""
Triggered in-session consolidation (v1.2 fast-path).

When a candidate (a) is *not* on the immediate-durable list and (b) lands in
Tier 3 (episodic) for the third time within a single session OR within a
24-hour rolling window, the orchestrator fires an immediate consolidation
attempt that runs the same logic as the nightly reflect job's promotion step.

Triggered consolidation is *eligibility*, not *bypass* — the candidate must
still pass Layers 1 and 2.

Phase status: M0 — stub-only. M4 lands the real in-session frequency
counter (persisted to `sessions.session_state` so the rolling window
survives session boundaries within the same day).

See `docs/MEMORY_DESIGN.md` §3 Layer 3 (Triggered consolidation).
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class ConsolidationResult:
    triggered: bool
    observation_count: int
    reason: str


# Threshold for triggered consolidation. Tunable; v1.2 set this to 3 to
# match the cross-session promotion threshold. Tune in M4 against the recall
# corpus per `docs/MEMORY_DESIGN.md` §10 question 11.
TRIGGERED_CONSOLIDATION_THRESHOLD: int = 3


def maybe_trigger_consolidation(
    *,
    owner_user_id: int,
    subject_hash: str,
    predicate: str,
    counter_state: dict | None = None,
) -> ConsolidationResult:  # noqa: ARG001
    """No-op stub. M4 replaces with the in-session frequency counter."""
    return ConsolidationResult(
        triggered=False, observation_count=0, reason="m0_stub"
    )
