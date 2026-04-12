"""
Layer 3 — promotion via recurrence.

Most candidates enter Tier 2 (session) or Tier 3 (episodic) on first
observation. They reach durable Tier 4/5 layers only via promotion when a
claim recurs across 3+ separate session-close summaries (or 3+ separate
sessions for behavior-derived signals).

The exception is the immediate-durable carve-out: predicates in
`predicates.IMMEDIATE_DURABLE_TIER{4,5}` write to the durable tier on first
observation, *as long as they pass Layers 1 and 2*.

Phase status: M4 — `run_cross_session_promotion` walks recently written
episodes and promotes claims that have appeared in 3+ separate sessions
into Tier 4/5 via the gate chain. ``consider_promotion`` remains the
per-write-path no-op pass-through called by Layer 2 (its real job lives
in the out-of-band reflect job, not on the synchronous write path).

See `docs/MEMORY_DESIGN.md` §3 Layer 3 and §5 reflect job.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:  # pragma: no cover
    from v2.orchestrator.memory.store import V2MemoryStore
    from v2.orchestrator.memory.summarizer import SessionObservation


# Cross-session promotion threshold: a claim must appear in this many
# distinct sessions before the reflect job promotes it from Tier 3
# (episodic) into Tier 4 / Tier 5 (durable). v1.2 sets this to 3 to
# match the in-session triggered-consolidation threshold so the two
# mechanisms compose without overlap. See `docs/MEMORY_DESIGN.md` §3
# Layer 3 (Promotion via recurrence).
PROMOTION_THRESHOLD: int = 3


@dataclass(frozen=True)
class PromotionResult:
    promoted: bool
    target_tier: int | None
    reason: str


def consider_promotion(candidate: Any) -> PromotionResult:  # noqa: ARG001
    """Per-write no-op pass-through.

    The real promotion engine runs out-of-band in
    :func:`run_cross_session_promotion`, which the session-close
    summarizer invokes after writing the new episode. The on-write
    path stays a no-op so M1's latency profile is preserved.
    """
    return PromotionResult(
        promoted=False, target_tier=None, reason="cross_session_only"
    )


def run_cross_session_promotion(
    *,
    store: "V2MemoryStore",
    owner_user_id: int,
    observations: list["SessionObservation"],
) -> list[dict[str, Any]]:
    """Promote claims that have now appeared in PROMOTION_THRESHOLD+ sessions.

    For every observation in the just-closed session, count how many
    distinct sessions contain that exact ``(subject, predicate, value)``
    triple in their ``episodes.entities`` payload. When the count
    reaches the threshold, run the candidate through the writer's
    full gate chain so the durable Tier 4/5 row is created. Returns
    the list of successfully promoted claim summaries (one dict per
    promoted row) for inclusion in the SummarizationResult.

    The promotion is **eligibility, not bypass** — every promoted
    candidate still has to pass Gates 1–5 in the writer.
    """
    # Local import to avoid a circular dependency: writer → store →
    # promotion → writer would dead-lock at module load time.
    from v2.orchestrator.memory.candidate import MemoryCandidate
    from v2.orchestrator.memory.writer import process_candidate

    promoted: list[dict[str, Any]] = []
    seen_keys: set[tuple[str, str, str]] = set()
    for obs in observations:
        key = (obs.subject, obs.predicate, obs.value)
        if key in seen_keys:
            continue
        seen_keys.add(key)
        session_count = store.count_episodes_with_claim(
            owner_user_id,
            subject=obs.subject,
            predicate=obs.predicate,
            value=obs.value,
        )
        if session_count < PROMOTION_THRESHOLD:
            continue
        # Build a synthetic candidate and run it through the writer.
        # The writer's gate chain will reject any candidate that
        # shouldn't actually land in a durable tier.
        candidate = MemoryCandidate(
            subject=obs.subject,
            predicate=obs.predicate,
            value=obs.value,
            owner_user_id=owner_user_id,
            source_text=obs.source_text or f"promotion via {session_count} sessions",
        )
        decision = process_candidate(candidate, store=store)
        if decision.accepted:
            promoted.append(
                {
                    "subject": obs.subject,
                    "predicate": obs.predicate,
                    "value": obs.value,
                    "session_count": session_count,
                    "tier": int(decision.target_tier) if decision.target_tier else None,
                }
            )
    return promoted
