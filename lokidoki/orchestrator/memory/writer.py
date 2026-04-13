"""
Memory writer — orchestrates the write path.

The writer is the only public entry point for landing a candidate in the
durable store. It runs Layer 1 (gate chain), Layer 2 (tier classifier),
the immediate-durable carve-out, and the store call. Layer 3 (promotion)
is wired but a no-op in M1; M4 plugs in the real promotion logic.

Phase status: M1 — fully wired for Tier 4 and Tier 5. Tiers 2/3/6/7
return ``WriterDecision(accepted=False, reason="tier_not_active_in_m1")``
since their write surfaces don't exist yet.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Iterable

from lokidoki.orchestrator.memory.candidate import (
    CandidateRejection,
    MemoryCandidate,
)
from lokidoki.orchestrator.memory.classifier import classify_candidate
from lokidoki.orchestrator.memory.gates import GateChainResult, run_gate_chain
from lokidoki.orchestrator.memory.predicates import is_immediate_durable
from lokidoki.orchestrator.memory.promotion import consider_promotion
from lokidoki.orchestrator.memory.store import MemoryStore, WriteOutcome, get_default_store
from lokidoki.orchestrator.memory.tiers import Tier


@dataclass(frozen=True)
class WriterDecision:
    """The full audit trail of a single write attempt."""

    accepted: bool
    candidate: MemoryCandidate | None
    gate_result: GateChainResult | None
    classification: str
    target_tier: Tier | None
    write_outcome: WriteOutcome | None
    rejection: CandidateRejection | None
    reason: str = ""


@dataclass
class WriteRunResult:
    """Aggregated outcome for a turn that produced N candidates."""

    accepted: list[WriterDecision] = field(default_factory=list)
    rejected: list[WriterDecision] = field(default_factory=list)

    @property
    def total(self) -> int:
        return len(self.accepted) + len(self.rejected)


def _rejection_from_chain(raw: Any, chain: GateChainResult) -> WriterDecision:
    """Build a rejection ``WriterDecision`` from a failed gate chain."""
    rejection_reason = ""
    if chain.failed_at is not None:
        failing = next(
            (r for r in chain.results if r.gate.value == chain.failed_at.value),
            None,
        )
        rejection_reason = failing.reason if failing else "gate_failed"
    validated = raw if isinstance(raw, MemoryCandidate) else _try_validate(raw)
    rejection = CandidateRejection(
        candidate=validated,
        raw=raw if isinstance(raw, dict) else {},
        failed_gate=chain.failed_at.value if chain.failed_at else "unknown",
        reason=rejection_reason,
        source_text=getattr(validated, "source_text", "") or "",
    )
    return WriterDecision(
        accepted=False,
        candidate=validated,
        gate_result=chain,
        classification="",
        target_tier=None,
        write_outcome=None,
        rejection=rejection,
        reason=f"denied_at_{chain.failed_at.value if chain.failed_at else 'unknown'}",
    )


def _rejection_inactive_tier(
    candidate: MemoryCandidate,
    chain,
    classification,
) -> "WriterDecision":
    """Return a rejection decision for tiers not yet active in M1."""
    return WriterDecision(
        accepted=False,
        candidate=candidate,
        gate_result=chain,
        classification=classification.reason,
        target_tier=classification.target_tier,
        write_outcome=None,
        rejection=CandidateRejection(
            candidate=candidate,
            raw={},
            failed_gate="store_dispatch",
            reason="tier_not_active_in_m1",
            source_text=candidate.source_text,
        ),
        reason="tier_not_active_in_m1",
    )


def _dispatch_to_store(
    candidate: MemoryCandidate,
    chain,
    classification,
    store: MemoryStore | None,
) -> WriterDecision:
    """Write the candidate to the appropriate tier store.

    Returns a rejection decision for inactive tiers, or the final accepted/
    rejected outcome from the store call.
    """
    backing_store = store or get_default_store()
    if classification.target_tier == Tier.SEMANTIC_SELF:
        outcome = backing_store.write_semantic_fact(candidate)
    elif classification.target_tier == Tier.SOCIAL:
        outcome = backing_store.write_social_fact(candidate)
    else:
        return _rejection_inactive_tier(candidate, chain, classification)
    immediate = is_immediate_durable(int(classification.target_tier), candidate.predicate)
    return WriterDecision(
        accepted=outcome.accepted,
        candidate=candidate,
        gate_result=chain,
        classification=classification.reason,
        target_tier=classification.target_tier,
        write_outcome=outcome,
        rejection=None,
        reason="immediate_durable" if immediate else "stored",
    )


def process_candidate(
    raw: Any,
    *,
    parse_doc: Any = None,
    resolved_people: Iterable[str] | None = None,
    known_entities: Iterable[str] | None = None,
    decomposed_intent: str | None = None,
    store: MemoryStore | None = None,
) -> WriterDecision:
    """Run a single candidate through the full write path."""
    chain = run_gate_chain(
        raw,
        parse_doc=parse_doc,
        resolved_people=resolved_people,
        known_entities=known_entities,
        decomposed_intent=decomposed_intent,
    )
    if not chain.accepted:
        return _rejection_from_chain(raw, chain)

    candidate: MemoryCandidate = (
        raw if isinstance(raw, MemoryCandidate) else MemoryCandidate.model_validate(raw)
    )
    classification = classify_candidate(candidate)
    if classification.target_tier is None:
        return _rejection_no_tier(candidate, chain, classification)

    # Layer 3 promotion stub. Currently always a no-op pass-through —
    # M4 wires the real recurrence promotion. The immediate-durable
    # carve-out is implemented inline below since it doesn't need a
    # promotion engine to function.
    consider_promotion(candidate)
    return _dispatch_to_store(candidate, chain, classification, store)


def _rejection_no_tier(
    candidate: MemoryCandidate,
    chain,
    classification,
) -> "WriterDecision":
    """Return a rejection decision when the classifier found no target tier."""
    return WriterDecision(
        accepted=False,
        candidate=candidate,
        gate_result=chain,
        classification=classification.reason,
        target_tier=None,
        write_outcome=None,
        rejection=CandidateRejection(
            candidate=candidate,
            raw={},
            failed_gate="classifier",
            reason="no_target_tier",
            source_text=candidate.source_text,
        ),
        reason="no_target_tier",
    )


def process_candidates(
    raw_candidates: Iterable[Any],
    *,
    parse_doc: Any = None,
    resolved_people: Iterable[str] | None = None,
    known_entities: Iterable[str] | None = None,
    decomposed_intent: str | None = None,
    store: MemoryStore | None = None,
) -> WriteRunResult:
    """Run the full write path on a turn's worth of candidates.

    Intra-turn deduplication is applied before the gate chain so a
    decomposer or extractor that emits the same triple twice doesn't
    inflate confidence twice.
    """
    result = WriteRunResult()
    seen: set[tuple[int, str, str, str]] = set()
    for raw in raw_candidates:
        # Cheap intra-turn dedupe — only fires when the raw is already a
        # MemoryCandidate or a dict with the right shape.
        key = _dedupe_key(raw)
        if key is not None:
            if key in seen:
                continue
            seen.add(key)
        decision = process_candidate(
            raw,
            parse_doc=parse_doc,
            resolved_people=resolved_people,
            known_entities=known_entities,
            decomposed_intent=decomposed_intent,
            store=store,
        )
        if decision.accepted:
            result.accepted.append(decision)
        else:
            result.rejected.append(decision)
    return result


def _try_validate(raw: Any) -> MemoryCandidate | None:
    if isinstance(raw, MemoryCandidate):
        return raw
    if not isinstance(raw, dict):
        return None
    try:
        return MemoryCandidate.model_validate(raw)
    except Exception:  # noqa: BLE001 — schema gate already records the failure
        return None


def _dedupe_key(raw: Any) -> tuple[int, str, str, str] | None:
    if isinstance(raw, MemoryCandidate):
        return (raw.owner_user_id, raw.subject, raw.predicate, raw.value)
    if isinstance(raw, dict):
        try:
            return (
                int(raw.get("owner_user_id", 0)),
                str(raw["subject"]),
                str(raw["predicate"]),
                str(raw["value"]),
            )
        except (KeyError, TypeError, ValueError):
            return None
    return None
