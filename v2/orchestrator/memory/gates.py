"""
Layer 1 — structural gate chain for the v2 memory write path.

Five independent gates, each of which can deny a write candidate. The chain
is short-circuit: reject on first failure. No retries. Rejected candidates
get appended to the regression corpus so they can be inspected without
polluting durable storage.

Phase status: M0 — interface only. Each gate currently returns a "not yet
implemented" sentinel. M1 fills in the real logic per `docs/MEMORY_DESIGN.md`
§3.

Gate ordering (must not be reordered without updating §3 of the design doc):
    1. clause_shape   — parse-tree non-interrogative
    2. subject        — self / resolved person / known entity
    3. predicate      — closed enum per tier
    4. schema         — strict Pydantic validation
    5. intent         — assertive_chat / self_disclosure / correction allowed
"""
from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Any


class GateName(str, Enum):
    CLAUSE_SHAPE = "clause_shape"
    SUBJECT = "subject"
    PREDICATE = "predicate"
    SCHEMA = "schema"
    INTENT = "intent"


@dataclass(frozen=True)
class GateResult:
    """Outcome of a single gate evaluation."""

    gate: GateName
    passed: bool
    reason: str = ""


@dataclass(frozen=True)
class GateChainResult:
    """Outcome of running the full gate chain on a candidate."""

    accepted: bool
    failed_at: GateName | None
    results: tuple[GateResult, ...]


# --- M0: stub-only signatures. Real implementations land in M1. ---


def gate_clause_shape(candidate: Any, parse_doc: Any) -> GateResult:  # noqa: ARG001
    """Gate 1 — non-interrogative parse-tree check. Implemented in M1."""
    return GateResult(GateName.CLAUSE_SHAPE, passed=False, reason="not_implemented")


def gate_subject(candidate: Any, resolved_people: Any) -> GateResult:  # noqa: ARG001
    """Gate 2 — subject resolves to self / known person / known entity."""
    return GateResult(GateName.SUBJECT, passed=False, reason="not_implemented")


def gate_predicate(candidate: Any) -> GateResult:  # noqa: ARG001
    """Gate 3 — predicate is in the closed tier-specific enum."""
    return GateResult(GateName.PREDICATE, passed=False, reason="not_implemented")


def gate_schema(candidate: Any) -> GateResult:  # noqa: ARG001
    """Gate 4 — strict Pydantic schema validation. No repair loop."""
    return GateResult(GateName.SCHEMA, passed=False, reason="not_implemented")


def gate_intent(candidate: Any, decomposed_intent: str | None) -> GateResult:  # noqa: ARG001
    """Gate 5 — intent is one of the write-allowing labels."""
    return GateResult(GateName.INTENT, passed=False, reason="not_implemented")


def run_gate_chain(
    candidate: Any,
    *,
    parse_doc: Any = None,
    resolved_people: Any = None,
    decomposed_intent: str | None = None,
) -> GateChainResult:
    """Run all five gates in order. M0 stub — always denies with reason 'm0_stub'.

    M1 will replace this with the real chain. Until then, no candidate ever
    reaches the durable layer through the v2 path — by design, since the
    write path is not yet built.
    """
    stub_results = tuple(
        GateResult(name, passed=False, reason="m0_stub")
        for name in (
            GateName.CLAUSE_SHAPE,
            GateName.SUBJECT,
            GateName.PREDICATE,
            GateName.SCHEMA,
            GateName.INTENT,
        )
    )
    return GateChainResult(
        accepted=False,
        failed_at=GateName.CLAUSE_SHAPE,
        results=stub_results,
    )
