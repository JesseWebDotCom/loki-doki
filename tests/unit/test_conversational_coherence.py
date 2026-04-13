"""Unit tests for C14.5 conversational coherence fixes.

Tests:
- Phase A: Conversation history rendering and prompt integration
- Phase B: Source metadata stripping from LLM payload
- Phase C: Definite phrase detection + media resolver on direct_chat
"""
from __future__ import annotations

import pytest


def _render_conversation_history(msgs):
    """Import render_conversation_history avoiding circular import."""
    # Import through slots first to break the cycle, then access the function.
    from lokidoki.orchestrator.memory import slots  # noqa: F401
    from lokidoki.orchestrator.memory.slot_renderers import render_conversation_history
    return render_conversation_history(msgs)


class TestRenderConversationHistory:
    """Phase A (RC0): conversation history slot rendering."""

    def test_empty_messages(self):
        assert _render_conversation_history([]) == ""

    def test_single_assistant_message(self):
        msgs = [{"role": "assistant", "content": "Hello!"}]
        result = _render_conversation_history(msgs)
        assert result == "assistant: Hello!"

    def test_excludes_trailing_user_turn(self):
        """The current user turn is already in the spec — don't duplicate it."""
        msgs = [
            {"role": "user", "content": "what's the weather?"},
            {"role": "assistant", "content": "It's sunny and 72F."},
            {"role": "user", "content": "great, thanks"},
        ]
        result = _render_conversation_history(msgs)
        assert "great, thanks" not in result
        assert "It's sunny" in result
        assert "what's the weather?" in result

    def test_respects_budget(self):
        # Each message is ~60 chars. With a 1500 budget, we get ~25 messages.
        msgs = [
            {"role": "user" if i % 2 == 0 else "assistant", "content": f"Message number {i:03d} " + "x" * 40}
            for i in range(50)
        ]
        result = _render_conversation_history(msgs)
        assert len(result) <= 1600  # allow some slack for the last line

    def test_truncates_long_individual_messages(self):
        msgs = [{"role": "assistant", "content": "word " * 100}]
        result = _render_conversation_history(msgs)
        assert "..." in result
        # Individual message should be truncated to ~250 chars
        assert len(result) < 300

    def test_preserves_order(self):
        msgs = [
            {"role": "user", "content": "first"},
            {"role": "assistant", "content": "second"},
            {"role": "user", "content": "third"},
            {"role": "assistant", "content": "fourth"},
        ]
        result = _render_conversation_history(msgs)
        lines = result.strip().split("\n")
        assert lines[0].startswith("user: first")
        assert lines[-1].startswith("assistant: fourth")

    def test_skips_empty_content(self):
        msgs = [
            {"role": "user", "content": "hello"},
            {"role": "assistant", "content": ""},
            {"role": "user", "content": ""},
            {"role": "assistant", "content": "hi there"},
        ]
        result = _render_conversation_history(msgs)
        assert "user: hello" in result
        assert "assistant: hi there" in result
        lines = [line for line in result.split("\n") if line.strip()]
        assert len(lines) == 2

    def test_only_user_message_excluded(self):
        """A single user message (current turn) results in empty output."""
        msgs = [{"role": "user", "content": "hello"}]
        assert _render_conversation_history(msgs) == ""


class TestConversationHistoryInPrompt:
    """Phase A: conversation_history wired into LLM prompts."""

    def test_combine_prompt_has_conversation_history_slot(self):
        from lokidoki.orchestrator.fallbacks.prompts import COMBINE_PROMPT
        assert "{conversation_history}" in COMBINE_PROMPT

    def test_direct_chat_prompt_has_conversation_history_slot(self):
        from lokidoki.orchestrator.fallbacks.prompts import DIRECT_CHAT_PROMPT
        assert "{conversation_history}" in DIRECT_CHAT_PROMPT

    def test_conversation_history_instruction_in_combine(self):
        from lokidoki.orchestrator.fallbacks.prompts import COMBINE_PROMPT
        assert "conversation_history" in COMBINE_PROMPT
        assert "Never quote it verbatim" in COMBINE_PROMPT

    def test_conversation_history_instruction_in_direct_chat(self):
        from lokidoki.orchestrator.fallbacks.prompts import DIRECT_CHAT_PROMPT
        assert "conversation_history" in DIRECT_CHAT_PROMPT

    def test_extract_memory_slots_includes_conversation_history(self):
        from lokidoki.orchestrator.core.types import RequestSpec
        from lokidoki.orchestrator.fallbacks.llm_prompt_builder import _extract_memory_slots

        spec = RequestSpec(
            trace_id="test-trace",
            original_request="test",
            chunks=[],
            context={
                "memory_slots": {},
                "conversation_history": [
                    {"role": "user", "content": "hello"},
                    {"role": "assistant", "content": "hi there"},
                ],
            },
        )
        slots = _extract_memory_slots(spec)
        assert "conversation_history" in slots
        assert "hi there" in slots["conversation_history"]


class TestMetadataStripping:
    """Phase B (RC4): source metadata stripped from LLM payload."""

    def test_source_url_stripped(self):
        from lokidoki.orchestrator.fallbacks.llm_prompt_builder import _sanitize_result

        result = {
            "output_text": "The weather is sunny.",
            "source_url": "https://openmeteo.com/forecast",
            "source_title": "Open-Meteo",
            "source_type": "api",
        }
        sanitized = _sanitize_result(result)
        assert "output_text" in sanitized
        assert "source_url" not in sanitized
        assert "source_title" not in sanitized
        assert "source_type" not in sanitized

    def test_mechanism_stripped(self):
        from lokidoki.orchestrator.fallbacks.llm_prompt_builder import _sanitize_result

        result = {
            "output_text": "Inception (2010)",
            "mechanism": "wiki_api",
            "mechanisms_tried": ["wiki_api", "local_cache"],
        }
        sanitized = _sanitize_result(result)
        assert "mechanism" not in sanitized
        assert "mechanisms_tried" not in sanitized

    def test_none_result_passthrough(self):
        from lokidoki.orchestrator.fallbacks.llm_prompt_builder import _sanitize_result
        assert _sanitize_result(None) is None

    def test_content_fields_preserved(self):
        from lokidoki.orchestrator.fallbacks.llm_prompt_builder import _sanitize_result

        result = {
            "output_text": "Sunny, 72F",
            "data": {"temp": 72, "conditions": "sunny"},
            "sources": [{"url": "http://example.com", "title": "Weather"}],
        }
        sanitized = _sanitize_result(result)
        assert sanitized["output_text"] == "Sunny, 72F"
        assert sanitized["data"]["temp"] == 72
        assert sanitized["sources"][0]["url"] == "http://example.com"

    def test_build_llm_payload_sanitizes_results(self):
        from lokidoki.orchestrator.core.types import RequestChunkResult, RequestSpec
        from lokidoki.orchestrator.fallbacks.llm_prompt_builder import build_llm_payload

        spec = RequestSpec(
            trace_id="test-trace",
            original_request="weather",
            chunks=[
                RequestChunkResult(
                    text="weather",
                    role="primary_request",
                    capability="get_weather",
                    confidence=0.9,
                    success=True,
                    result={
                        "output_text": "Sunny",
                        "source_url": "https://leak.example.com",
                        "source_title": "LeakySource",
                    },
                ),
            ],
            context={},
        )
        payload = build_llm_payload(spec)
        chunk_result = payload["chunks"][0]["result"]
        assert "output_text" in chunk_result
        assert "source_url" not in chunk_result
        assert "source_title" not in chunk_result


class TestDefinitePhraseDetection:
    """Phase C (RC2): definite phrase triggers need_session_context."""

    def test_the_original_is_definite(self):
        from lokidoki.orchestrator.pipeline.derivations import _has_definite_phrase
        assert _has_definite_phrase(["the original"]) is True

    def test_the_sequel_is_definite(self):
        from lokidoki.orchestrator.pipeline.derivations import _has_definite_phrase
        assert _has_definite_phrase(["the sequel"]) is True

    def test_the_first_one_is_definite(self):
        from lokidoki.orchestrator.pipeline.derivations import _has_definite_phrase
        assert _has_definite_phrase(["the first one"]) is True

    def test_that_newer_one_is_definite(self):
        from lokidoki.orchestrator.pipeline.derivations import _has_definite_phrase
        assert _has_definite_phrase(["that newer one"]) is True

    def test_pronoun_not_definite(self):
        from lokidoki.orchestrator.pipeline.derivations import _has_definite_phrase
        assert _has_definite_phrase(["it"]) is False

    def test_long_phrase_not_definite(self):
        from lokidoki.orchestrator.pipeline.derivations import _has_definite_phrase
        assert _has_definite_phrase(["the one we saw last week at the cinema"]) is False

    def test_empty_references(self):
        from lokidoki.orchestrator.pipeline.derivations import _has_definite_phrase
        assert _has_definite_phrase([]) is False


class TestMediaResolverDirectChat:
    """Phase C (RC3): media resolver fires for context-needing direct_chat."""

    def test_direct_chat_skipped_by_default(self):
        from lokidoki.orchestrator.core.types import ChunkExtraction, RequestChunk, RouteMatch
        from lokidoki.orchestrator.adapters import MovieContextAdapter, ConversationMemoryAdapter

        chunk = RequestChunk(index=0, text="the original")
        extraction = ChunkExtraction(chunk_index=0)
        route = RouteMatch(chunk_index=0, capability="direct_chat", confidence=0.5)
        adapter = MovieContextAdapter(ConversationMemoryAdapter(None))

        from lokidoki.orchestrator.resolution.media_resolver import resolve_media
        result = resolve_media(chunk, extraction, route, adapter)
        assert result is None

    def test_direct_chat_with_context_and_definite(self):
        from lokidoki.orchestrator.core.types import ChunkExtraction, RequestChunk, RouteMatch
        from lokidoki.orchestrator.adapters import MovieContextAdapter, ConversationMemoryAdapter

        chunk = RequestChunk(index=0, text="tell me about the original")
        extraction = ChunkExtraction(chunk_index=0)
        route = RouteMatch(chunk_index=0, capability="direct_chat", confidence=0.5)
        adapter = MovieContextAdapter(ConversationMemoryAdapter(None))

        from lokidoki.orchestrator.resolution.media_resolver import resolve_media
        result = resolve_media(
            chunk, extraction, route, adapter,
            need_session_context=True,
        )
        # No recent movies, so it should return unresolved
        assert result is not None
        assert "recent_media" in result.unresolved

    def test_definite_phrase_detection(self):
        from lokidoki.orchestrator.resolution.media_resolver import _has_definite_phrase

        assert _has_definite_phrase("tell me about the original") is True
        assert _has_definite_phrase("the sequel was better") is True
        assert _has_definite_phrase("hello world") is False
        assert _has_definite_phrase("what about that movie") is True


class TestLLMAlwaysSynthesizes:
    """LLM synthesis always needed for conversational responses."""

    def test_decide_llm_always_needed(self):
        from lokidoki.orchestrator.core.types import RequestChunkResult, RequestSpec
        from lokidoki.orchestrator.fallbacks.llm_fallback import decide_llm

        spec = RequestSpec(
            trace_id="test-trace",
            original_request="what's the weather",
            chunks=[
                RequestChunkResult(
                    text="what's the weather",
                    role="primary_request",
                    capability="get_weather",
                    confidence=0.95,
                    success=True,
                    result={"output_text": "Sunny, 72F"},
                ),
            ],
            context={},
        )
        decision = decide_llm(spec)
        assert decision.needed is True
        assert decision.reason == "synthesis"
