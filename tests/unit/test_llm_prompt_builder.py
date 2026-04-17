"""Unit tests for llm_prompt_builder — response schema selection."""
from __future__ import annotations

import pytest

from lokidoki.orchestrator.core.types import (
    ConstraintResult,
    RequestChunkResult,
    RequestSpec,
)
from lokidoki.orchestrator.fallbacks.llm_prompt_builder import _select_response_schema
from lokidoki.orchestrator.fallbacks.prompts import (
    RESPONSE_SCHEMA_COMPARISON,
    RESPONSE_SCHEMA_RECOMMENDATION,
    RESPONSE_SCHEMA_TROUBLESHOOTING,
    RESPONSE_SCHEMA_UTILITY,
)


def _make_spec(
    *,
    chunks: list[RequestChunkResult] | None = None,
    constraints: ConstraintResult | None = None,
) -> RequestSpec:
    ctx: dict = {"current_time": "3:42 PM", "user_name": "Luke"}
    if constraints is not None:
        ctx["constraints"] = constraints
    return RequestSpec(
        trace_id="t",
        original_request="test",
        chunks=chunks or [],
        context=ctx,
    )


def test_comparison_from_constraints():
    spec = _make_spec(constraints=ConstraintResult(is_comparison=True))
    assert _select_response_schema(spec) == RESPONSE_SCHEMA_COMPARISON


def test_recommendation_from_constraints():
    spec = _make_spec(constraints=ConstraintResult(is_recommendation=True))
    assert _select_response_schema(spec) == RESPONSE_SCHEMA_RECOMMENDATION


def test_comparison_from_capability():
    spec = _make_spec(chunks=[
        RequestChunkResult(
            text="phi4 vs gemma 4",
            role="primary_request",
            capability="compare_models",
            confidence=0.8,
        ),
    ])
    assert _select_response_schema(spec) == RESPONSE_SCHEMA_COMPARISON


def test_troubleshooting_from_capability():
    spec = _make_spec(chunks=[
        RequestChunkResult(
            text="wifi won't connect",
            role="primary_request",
            capability="troubleshoot_network",
            confidence=0.8,
        ),
    ])
    assert _select_response_schema(spec) == RESPONSE_SCHEMA_TROUBLESHOOTING


def test_direct_chat_returns_utility():
    spec = _make_spec(chunks=[
        RequestChunkResult(
            text="what is Docker",
            role="primary_request",
            capability="direct_chat",
            confidence=0.3,
        ),
    ])
    assert _select_response_schema(spec) == RESPONSE_SCHEMA_UTILITY


def test_no_signal_returns_empty():
    spec = _make_spec(chunks=[
        RequestChunkResult(
            text="turn on lights",
            role="primary_request",
            capability="home_automation",
            confidence=0.9,
        ),
    ])
    assert _select_response_schema(spec) == ""


def test_constraints_take_priority_over_capability():
    """Constraint signals override route-based heuristics."""
    spec = _make_spec(
        constraints=ConstraintResult(is_recommendation=True),
        chunks=[
            RequestChunkResult(
                text="phi4 vs gemma 4",
                role="primary_request",
                capability="compare_models",
                confidence=0.8,
            ),
        ],
    )
    assert _select_response_schema(spec) == RESPONSE_SCHEMA_RECOMMENDATION
