"""Unit tests for the LLM fallback decision + stub synthesizer."""
from __future__ import annotations

from lokidoki.orchestrator.core.types import RequestChunkResult, RequestSpec
from lokidoki.orchestrator.fallbacks.llm_fallback import build_llm_payload, decide_llm, llm_synthesize


def _spec(chunks: list[RequestChunkResult], supporting: list[str] | None = None) -> RequestSpec:
    return RequestSpec(
        trace_id="trace-1",
        original_request="test",
        chunks=chunks,
        supporting_context=supporting or [],
    )


def test_decide_llm_always_needed_for_clean_single_chunk():
    """Even a clean, high-confidence skill result goes through LLM
    synthesis so the reply is conversational."""
    chunk = RequestChunkResult(
        text="hello",
        role="primary_request",
        capability="greeting_response",
        confidence=0.95,
        result={"output_text": "Hello."},
    )
    decision = decide_llm(_spec([chunk]))
    assert decision.needed is True
    assert decision.reason == "synthesis"


def test_decide_llm_triggers_on_unresolved():
    chunk = RequestChunkResult(
        text="what was that movie",
        role="primary_request",
        capability="recall_recent_media",
        confidence=0.9,
        unresolved=["recent_media"],
        success=False,
    )
    decision = decide_llm(_spec([chunk]))
    assert decision.needed is True
    assert decision.reason == "unresolved_chunk"


def test_decide_llm_triggers_on_low_confidence():
    # Use a non-direct_chat capability so we exercise the confidence
    # branch instead of the direct_chat short-circuit. Provide a real
    # output_text so we don't trip the empty_output branch first.
    chunk = RequestChunkResult(
        text="vague request",
        role="primary_request",
        capability="knowledge_query",
        confidence=0.3,
        success=True,
        result={"output_text": "Some Wikipedia answer"},
    )
    decision = decide_llm(_spec([chunk]))
    assert decision.needed is True
    assert decision.reason == "low_confidence"


def test_decide_llm_always_runs_for_direct_chat():
    """direct_chat has no real backend — it must always hand off to LLM."""
    chunk = RequestChunkResult(
        text="what does json stand for",
        role="primary_request",
        capability="direct_chat",
        confidence=0.95,  # even high confidence must not bypass LLM
        success=True,
        result={"output_text": "what does json stand for"},
    )
    decision = decide_llm(_spec([chunk]))
    assert decision.needed is True
    assert decision.reason == "direct_chat"


def test_decide_llm_triggers_on_empty_output():
    """A skill that returns success=True with no output_text must hand
    off to LLM — a blank response is a dead end for the user."""
    chunk = RequestChunkResult(
        text="what's the score of the knicks game",
        role="primary_request",
        capability="get_score",
        confidence=0.9,
        success=True,
        result={"output_text": "   "},  # whitespace-only counts as empty
    )
    decision = decide_llm(_spec([chunk]))
    assert decision.needed is True
    assert decision.reason == "empty_output"


def test_decide_llm_triggers_on_missing_output_text_key():
    """Same as empty_output but the key is missing entirely."""
    chunk = RequestChunkResult(
        text="weather in atlantis",
        role="primary_request",
        capability="get_weather",
        confidence=0.9,
        success=True,
        result={},
    )
    decision = decide_llm(_spec([chunk]))
    assert decision.needed is True
    assert decision.reason == "empty_output"


def test_decide_llm_needed_when_output_text_is_present():
    """Even healthy skill output goes through LLM synthesis for
    conversational framing."""
    chunk = RequestChunkResult(
        text="what time is it",
        role="primary_request",
        capability="get_current_time",
        confidence=0.95,
        success=True,
        result={"output_text": "3:42 PM"},
    )
    decision = decide_llm(_spec([chunk]))
    assert decision.needed is True
    assert decision.reason == "synthesis"


def test_decide_llm_triggers_at_threshold_boundary():
    """A route at exactly the confidence threshold must still trigger LLM."""
    from lokidoki.orchestrator.core.config import CONFIG

    chunk = RequestChunkResult(
        text="borderline request",
        role="primary_request",
        capability="knowledge_query",
        confidence=CONFIG.route_confidence_threshold,
        success=True,
        result={"output_text": "Some borderline answer"},
    )
    decision = decide_llm(_spec([chunk]))
    assert decision.needed is True
    assert decision.reason == "low_confidence"


def test_decide_llm_triggers_on_supporting_context_chunk():
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
    decision = decide_llm(_spec([primary, supporting]))
    assert decision.needed is True
    assert decision.reason == "supporting_context"


def test_llm_synthesize_handles_missing_recent_movie():
    chunk = RequestChunkResult(
        text="what was that movie",
        role="primary_request",
        capability="recall_recent_media",
        confidence=0.9,
        unresolved=["recent_media"],
        success=False,
    )
    response = llm_synthesize(_spec([chunk]))
    assert "don't have a recent movie" in response.output_text.lower()


def test_combiner_does_not_mirror_direct_chat_input():
    """Defensive guard: even the deterministic combiner must not echo
    the user's input back when a chunk routes to direct_chat."""
    from lokidoki.orchestrator.pipeline.combiner import combine_request_spec

    user_words = "what does json stand for"
    chunk = RequestChunkResult(
        text=user_words,
        role="primary_request",
        capability="direct_chat",
        confidence=0.55,
        success=True,
        result={"output_text": user_words},
    )
    response = combine_request_spec(_spec([chunk]))
    assert response.output_text != user_words
    assert "built-in answer" in response.output_text.lower()


def test_llm_synthesize_does_not_mirror_direct_chat_input():
    """When LLM is disabled and direct_chat falls through to the stub,
    the synthesizer must NOT echo the user's words back at them."""
    user_words = "what does json stand for"
    chunk = RequestChunkResult(
        text=user_words,
        role="primary_request",
        capability="direct_chat",
        confidence=0.55,
        success=True,
        result={"output_text": user_words},  # the echo handler's output
    )
    response = llm_synthesize(_spec([chunk]))
    assert response.output_text != user_words
    assert "built-in answer" in response.output_text.lower()


def test_llm_synthesize_lists_ambiguous_movie_candidates():
    chunk = RequestChunkResult(
        text="what was that movie",
        role="primary_request",
        capability="recall_recent_media",
        confidence=0.9,
        unresolved=["recent_media_ambiguous"],
        success=False,
        params={"candidates": ["Rogue One", "A New Hope"]},
    )
    response = llm_synthesize(_spec([chunk]))
    assert "Rogue One" in response.output_text
    assert "A New Hope" in response.output_text


def test_build_llm_payload_serialises_chunks_and_context():
    chunk = RequestChunkResult(
        text="hello",
        role="primary_request",
        capability="greeting_response",
        confidence=0.99,
    )
    spec = _spec([chunk])
    spec.context = {"recent_entities": []}
    payload = build_llm_payload(spec)
    assert payload["original_request"] == "test"
    assert payload["chunks"][0]["capability"] == "greeting_response"
    assert "recent_entities" in payload["context_keys"]
