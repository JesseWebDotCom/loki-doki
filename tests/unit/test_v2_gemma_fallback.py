"""Unit tests for the v2 Gemma fallback decision + stub synthesizer."""
from __future__ import annotations

from v2.orchestrator.core.types import RequestChunkResult, RequestSpec
from v2.orchestrator.fallbacks.gemma_fallback import build_gemma_payload, decide_gemma, gemma_synthesize


def _spec(chunks: list[RequestChunkResult], supporting: list[str] | None = None) -> RequestSpec:
    return RequestSpec(
        trace_id="trace-1",
        original_request="test",
        chunks=chunks,
        supporting_context=supporting or [],
    )


def test_decide_gemma_skips_clean_single_chunk():
    chunk = RequestChunkResult(
        text="hello",
        role="primary_request",
        capability="greeting_response",
        confidence=0.95,
        result={"output_text": "Hello."},
    )
    decision = decide_gemma(_spec([chunk]))
    assert decision.needed is False


def test_decide_gemma_triggers_on_unresolved():
    chunk = RequestChunkResult(
        text="what was that movie",
        role="primary_request",
        capability="recall_recent_media",
        confidence=0.9,
        unresolved=["recent_media"],
        success=False,
    )
    decision = decide_gemma(_spec([chunk]))
    assert decision.needed is True
    assert decision.reason == "unresolved_chunk"


def test_decide_gemma_triggers_on_low_confidence():
    chunk = RequestChunkResult(
        text="vague request",
        role="primary_request",
        capability="direct_chat",
        confidence=0.3,
    )
    decision = decide_gemma(_spec([chunk]))
    assert decision.needed is True
    assert decision.reason == "low_confidence"


def test_decide_gemma_triggers_on_supporting_context_chunk():
    primary = RequestChunkResult(
        text="what time is it",
        role="primary_request",
        capability="get_current_time",
        confidence=0.95,
        result={"output_text": "3:42 PM"},
    )
    supporting = RequestChunkResult(
        text="because im late",
        role="supporting_context",
        capability="",
        confidence=0.0,
    )
    decision = decide_gemma(_spec([primary, supporting]))
    assert decision.needed is True
    assert decision.reason == "supporting_context"


def test_gemma_synthesize_handles_missing_recent_movie():
    chunk = RequestChunkResult(
        text="what was that movie",
        role="primary_request",
        capability="recall_recent_media",
        confidence=0.9,
        unresolved=["recent_media"],
        success=False,
    )
    response = gemma_synthesize(_spec([chunk]))
    assert "don't have a recent movie" in response.output_text.lower()


def test_gemma_synthesize_lists_ambiguous_movie_candidates():
    chunk = RequestChunkResult(
        text="what was that movie",
        role="primary_request",
        capability="recall_recent_media",
        confidence=0.9,
        unresolved=["recent_media_ambiguous"],
        success=False,
        params={"candidates": ["Rogue One", "A New Hope"]},
    )
    response = gemma_synthesize(_spec([chunk]))
    assert "Rogue One" in response.output_text
    assert "A New Hope" in response.output_text


def test_build_gemma_payload_serialises_chunks_and_context():
    chunk = RequestChunkResult(
        text="hello",
        role="primary_request",
        capability="greeting_response",
        confidence=0.99,
    )
    spec = _spec([chunk])
    spec.context = {"recent_entities": []}
    payload = build_gemma_payload(spec)
    assert payload["original_request"] == "test"
    assert payload["chunks"][0]["capability"] == "greeting_response"
    assert "recent_entities" in payload["context_keys"]
