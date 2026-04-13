"""
Layer 1 — structural gate chain for the memory write path.

Five independent gates, each of which can deny a write candidate. The chain
is short-circuit: reject on first failure. No retries. Rejected candidates
get logged to the regression corpus so they can be inspected without
polluting durable storage.

Phase status: M1 — real implementations for all five gates. The president
bug (`"who is the current president"`) dies at Gate 1 because the WH-fronted
question is denied before any further evaluation.

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
from typing import Any, Iterable


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


# Import all gate implementations from gate_rules and re-export them so
# existing ``from lokidoki.orchestrator.memory.gates import …`` keeps working.
from lokidoki.orchestrator.memory.gate_rules import (  # noqa: E402
    WRITE_ALLOWING_INTENTS,
    WRITE_DENYING_INTENTS,
    gate_clause_shape,
    gate_intent,
    gate_predicate,
    gate_schema,
    gate_subject,
)


# ---------------------------------------------------------------------------
# Chain runner
# ---------------------------------------------------------------------------


def _run_validated_gates(
    candidate: Any,
    schema_result: GateResult,
    *,
    parse_doc: Any,
    resolved_people: Iterable[str] | None,
    known_entities: Iterable[str] | None,
    decomposed_intent: str | None,
) -> GateChainResult:
    """Run gates 1, 2, 3, (4 trace), 5 against a pre-validated candidate."""
    results: list[GateResult] = []

    g1 = gate_clause_shape(candidate, parse_doc)
    results.append(g1)
    if not g1.passed:
        return GateChainResult(False, GateName.CLAUSE_SHAPE, tuple(results))

    g2 = gate_subject(candidate, resolved_people, known_entities=known_entities)
    results.append(g2)
    if not g2.passed:
        return GateChainResult(False, GateName.SUBJECT, tuple(results))

    g3 = gate_predicate(candidate)
    results.append(g3)
    if not g3.passed:
        return GateChainResult(False, GateName.PREDICATE, tuple(results))

    results.append(schema_result)  # Gate 4 already passed — record for trace.

    g5 = gate_intent(candidate, decomposed_intent)
    results.append(g5)
    if not g5.passed:
        return GateChainResult(False, GateName.INTENT, tuple(results))

    return GateChainResult(accepted=True, failed_at=None, results=tuple(results))


def run_gate_chain(
    raw_candidate: Any,
    *,
    parse_doc: Any = None,
    resolved_people: Iterable[str] | None = None,
    known_entities: Iterable[str] | None = None,
    decomposed_intent: str | None = None,
) -> GateChainResult:
    """Run all five gates in order, short-circuiting on the first failure.

    The order is intentional: cheap structural checks first (Gate 1
    works on the parse tree we already have), strict validation in the
    middle (Gate 4 might allocate a Pydantic model), intent last (it's
    the cheapest but also the least authoritative).
    """
    # Gate 4 runs first — we need a validated candidate for the other gates.
    schema_result, candidate = gate_schema(raw_candidate)
    if not schema_result.passed:
        return GateChainResult(
            accepted=False,
            failed_at=GateName.SCHEMA,
            results=(schema_result,),
        )
    return _run_validated_gates(
        candidate,
        schema_result,
        parse_doc=parse_doc,
        resolved_people=resolved_people,
        known_entities=known_entities,
        decomposed_intent=decomposed_intent,
    )


__all__ = [
    "GateChainResult",
    "GateName",
    "GateResult",
    "WRITE_ALLOWING_INTENTS",
    "WRITE_DENYING_INTENTS",
    "gate_clause_shape",
    "gate_intent",
    "gate_predicate",
    "gate_schema",
    "gate_subject",
    "run_gate_chain",
]
