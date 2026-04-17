"""Unit coverage for LLM prompt templates."""
from __future__ import annotations

import json

import pytest

from lokidoki.orchestrator.core.types import RequestChunkResult, RequestSpec
from lokidoki.orchestrator.fallbacks.llm_fallback import (
    build_combine_prompt,
    build_resolve_prompt,
    build_split_prompt,
)
from lokidoki.orchestrator.fallbacks.prompts import (
    PromptRenderError,
    RESPONSE_SCHEMA_COMPARISON,
    list_templates,
    render_prompt,
)


def test_list_templates_exposes_all_four_families():
    assert set(list_templates()) == {"split", "resolve", "combine", "direct_chat"}


def test_render_prompt_split_substitutes_utterance():
    prompt = render_prompt(
        "split",
        utterance="hello and turn off the lights",
        current_time="3:42 PM",
        user_name="Luke",
    )
    assert "hello and turn off the lights" in prompt
    assert "JSON list" in prompt


def test_render_prompt_resolve_requires_all_slots():
    with pytest.raises(PromptRenderError):
        render_prompt("resolve", chunk_text="text mom", capability="send_text_message")


def test_render_prompt_resolve_with_full_slots():
    prompt = render_prompt(
        "resolve",
        chunk_text="text mom",
        capability="send_text_message",
        unresolved=json.dumps(["person:mom"]),
        context=json.dumps({"recent": []}),
        current_time="3:42 PM",
        user_name="Luke",
    )
    assert "text mom" in prompt
    assert "send_text_message" in prompt
    assert "person:mom" in prompt


def test_render_prompt_unknown_template_raises():
    with pytest.raises(PromptRenderError):
        render_prompt("nonexistent", foo="bar")


def test_build_split_prompt_helper_renders_split_template():
    prompt = build_split_prompt("scary and gory")
    assert "scary and gory" in prompt
    assert "primary_request" in prompt


def test_build_resolve_prompt_helper_serializes_context():
    prompt = build_resolve_prompt(
        chunk_text="text Anakin",
        capability="send_text_message",
        unresolved=["person:Anakin"],
        context={"recent_entities": [{"type": "person", "name": "Padme"}]},
    )
    assert "Anakin" in prompt
    assert "Padme" in prompt
    assert "send_text_message" in prompt


def test_build_combine_prompt_serialises_request_spec_payload():
    spec = RequestSpec(
        trace_id="trace-x",
        original_request="hello and what time is it",
        chunks=[
            RequestChunkResult(
                text="hello",
                role="primary_request",
                capability="greeting_response",
                confidence=0.95,
                result={"output_text": "Hello."},
            ),
            RequestChunkResult(
                text="what time is it",
                role="primary_request",
                capability="get_current_time",
                confidence=0.92,
                result={"output_text": "3:42 PM"},
            ),
        ],
        context={"current_time": "3:42 PM", "user_name": "Luke"},
    )
    prompt = build_combine_prompt(spec)
    assert "hello" in prompt
    assert "what time is it" in prompt
    # The serialized payload must be valid JSON embedded in the prompt.
    assert "USER REQUEST" in prompt
    # Extract JSON after the "USER REQUEST (at <time>):\n" line.
    # Find the opening brace of the JSON payload.
    marker_idx = prompt.index("USER REQUEST")
    json_start = prompt.index("{", marker_idx)
    json_blob = prompt[json_start:]
    parsed = json.loads(json_blob)
    assert parsed["original_request"] == "hello and what time is it"
    assert parsed["trace_id"] == "trace-x"


def test_render_combine_with_response_schema_includes_format_block():
    prompt = render_prompt(
        "combine",
        spec='{"chunks":[]}',
        current_time="3:42 PM",
        user_name="Luke",
        character_name="LokiDoki",
        behavior_prompt="",
        confidence_guide="",
        response_schema=RESPONSE_SCHEMA_COMPARISON,
    )
    assert "RESPONSE FORMAT — Comparison:" in prompt
    assert "State the winner" in prompt


def test_render_combine_with_empty_response_schema_matches_baseline():
    """Empty response_schema preserves the current generic output."""
    prompt = render_prompt(
        "combine",
        spec='{"chunks":[]}',
        current_time="3:42 PM",
        user_name="Luke",
        character_name="LokiDoki",
        behavior_prompt="",
        confidence_guide="",
        response_schema="",
    )
    assert "RESPONSE FORMAT" not in prompt


def test_render_direct_chat_with_response_schema():
    prompt = render_prompt(
        "direct_chat",
        user_question="what is Docker?",
        current_time="3:42 PM",
        user_name="Luke",
        character_name="LokiDoki",
        behavior_prompt="",
        response_schema=RESPONSE_SCHEMA_COMPARISON,
    )
    assert "RESPONSE FORMAT — Comparison:" in prompt
