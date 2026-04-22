"""Unit tests for llm_prompt_builder — response schema selection."""
from __future__ import annotations

import pytest

from lokidoki.orchestrator.core.types import (
    ConstraintResult,
    RequestChunkResult,
    RequestSpec,
)
from lokidoki.orchestrator.fallbacks.llm_prompt_builder import (
    _RICH_MODE_DIRECTIVE,
    _select_response_schema,
    build_combine_prompt,
)
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


def test_rich_override_injects_directive_for_direct_chat():
    """User picks Rich on the toggle for a plain chat turn — the
    direct_chat LLM prompt must get the rich-mode directive, otherwise
    the toggle does nothing and the response still reads as bare prose."""
    spec = RequestSpec(
        trace_id="t",
        original_request="hi",
        chunks=[
            RequestChunkResult(
                text="hi",
                role="primary_request",
                capability="direct_chat",
                confidence=0.3,
            ),
        ],
        context={
            "current_time": "3:42 PM",
            "user_name": "Luke",
            "user_mode_override": "rich",
        },
    )
    prompt = build_combine_prompt(spec)
    assert prompt.startswith(_RICH_MODE_DIRECTIVE)


def test_auto_direct_chat_injects_rich_directive():
    """Auto mode on a direct_chat turn now gets the rich directive so
    the LLM output matches the envelope's rich-by-default mode.
    Without this, Auto visibly produces 'simple' prose even though the
    backend planner allocated rich blocks."""
    spec = RequestSpec(
        trace_id="t",
        original_request="who is paul reubens",
        chunks=[
            RequestChunkResult(
                text="who is paul reubens",
                role="primary_request",
                capability="direct_chat",
                confidence=0.3,
            ),
        ],
        context={"current_time": "3:42 PM", "user_name": "Luke"},
    )
    prompt = build_combine_prompt(spec)
    assert prompt.startswith(_RICH_MODE_DIRECTIVE)


def test_auto_lone_web_search_skips_directive():
    """A pure web_search route renders as the search layout on the
    frontend — no rich directive, since we don't want prose headers
    draped over a results list."""
    spec = RequestSpec(
        trace_id="t",
        original_request="latest news",
        chunks=[
            RequestChunkResult(
                text="latest news",
                role="primary_request",
                capability="web_search",
                confidence=0.8,
            ),
        ],
        context={"current_time": "3:42 PM", "user_name": "Luke"},
    )
    prompt = build_combine_prompt(spec)
    assert not prompt.startswith(_RICH_MODE_DIRECTIVE)


def test_auto_lone_deterministic_skill_skips_directive():
    """Calculator / unit conversion / time skills produce literal
    verbatim answers; the rich directive would force headers + bullets
    around '2 + 2 = 4'. Keep those plain."""
    spec = RequestSpec(
        trace_id="t",
        original_request="2+2",
        chunks=[
            RequestChunkResult(
                text="2+2",
                role="primary_request",
                capability="compute_math",
                confidence=0.9,
            ),
        ],
        context={"current_time": "3:42 PM", "user_name": "Luke"},
    )
    prompt = build_combine_prompt(spec)
    assert not prompt.startswith(_RICH_MODE_DIRECTIVE)


def test_simple_override_skips_directive():
    """The user explicitly picked Simple on the toggle — no rich
    directive even if the capability would normally trigger rich."""
    spec = RequestSpec(
        trace_id="t",
        original_request="who is paul reubens",
        chunks=[
            RequestChunkResult(
                text="who is paul reubens",
                role="primary_request",
                capability="lookup_person_facts",
                confidence=0.8,
            ),
        ],
        context={
            "current_time": "3:42 PM",
            "user_name": "Luke",
            "user_mode_override": "standard",
        },
    )
    prompt = build_combine_prompt(spec)
    assert not prompt.startswith(_RICH_MODE_DIRECTIVE)
