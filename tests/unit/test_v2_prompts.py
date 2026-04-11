"""Unit coverage for v2 Gemma prompt templates."""
from __future__ import annotations

import json

import pytest

from v2.orchestrator.core.types import RequestChunkResult, RequestSpec
from v2.orchestrator.fallbacks.gemma_fallback import (
    build_combine_prompt,
    build_resolve_prompt,
    build_split_prompt,
)
from v2.orchestrator.fallbacks.prompts import PromptRenderError, list_templates, render_prompt


def test_list_templates_exposes_all_three_families():
    assert set(list_templates()) == {"split", "resolve", "combine"}


def test_render_prompt_split_substitutes_utterance():
    prompt = render_prompt("split", utterance="hello and turn off the lights")
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
    )
    prompt = build_combine_prompt(spec)
    assert "hello" in prompt
    assert "what time is it" in prompt
    assert "RequestSpec" in prompt
    # The serialized payload must be valid JSON embedded in the prompt.
    json_blob = prompt.split("RequestSpec (JSON):", 1)[1].strip()
    parsed = json.loads(json_blob)
    assert parsed["original_request"] == "hello and what time is it"
    assert parsed["trace_id"] == "trace-x"
