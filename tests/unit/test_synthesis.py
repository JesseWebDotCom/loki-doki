"""Tests for confidence-aware synthesis in the combine prompt.

Verifies:
- High-confidence + structural source renders trust annotation.
- Low-confidence renders warning annotation.
- All-low-confidence / all-direct_chat allows "I don't know" path.
- Combine prompt no longer says "mention each successful chunk's result".
"""
from __future__ import annotations

from lokidoki.orchestrator.core.types import RequestChunkResult, RequestSpec
from lokidoki.orchestrator.fallbacks.llm_fallback import (
    _build_confidence_guide,
    build_combine_prompt,
)
from lokidoki.orchestrator.fallbacks.prompts import COMBINE_PROMPT


def _make_spec(chunks: list[RequestChunkResult], **ctx) -> RequestSpec:
    return RequestSpec(
        trace_id="test-synth",
        original_request="test query",
        chunks=chunks,
        context=ctx,
    )


class TestConfidenceGuide:
    """_build_confidence_guide annotates chunks by confidence + source."""

    def test_high_confidence_structural_source(self):
        spec = _make_spec([
            RequestChunkResult(
                text="turn off the lights",
                role="primary_request",
                capability="toggle_device",
                confidence=0.92,
                params={"source": "home_assistant"},
                result={"output_text": "Done."},
            ),
        ])
        guide = _build_confidence_guide(spec)
        assert "high confidence" in guide
        assert "structural source" in guide
        assert "trust this result" in guide

    def test_high_confidence_non_structural_source(self):
        spec = _make_spec([
            RequestChunkResult(
                text="what time is it",
                role="primary_request",
                capability="get_current_time",
                confidence=0.88,
                params={"source": "api"},
                result={"output_text": "3:42 PM"},
            ),
        ])
        guide = _build_confidence_guide(spec)
        assert "high confidence" in guide
        assert "structural source" not in guide
        assert "use this result" in guide

    def test_low_confidence_warns(self):
        spec = _make_spec([
            RequestChunkResult(
                text="tell me about cats",
                role="primary_request",
                capability="web_search",
                confidence=0.45,
                result={"output_text": "Some result"},
            ),
        ])
        guide = _build_confidence_guide(spec)
        assert "low confidence" in guide
        assert "may not be relevant" in guide

    def test_borderline_confidence_at_threshold_warns(self):
        """confidence == threshold (0.55) counts as low per decide_llm."""
        spec = _make_spec([
            RequestChunkResult(
                text="something borderline",
                role="primary_request",
                capability="trivia",
                confidence=0.55,
                result={"output_text": "Maybe."},
            ),
        ])
        guide = _build_confidence_guide(spec)
        assert "low confidence" in guide

    def test_mixed_confidence_chunks(self):
        spec = _make_spec([
            RequestChunkResult(
                text="turn off lights",
                role="primary_request",
                capability="toggle_device",
                confidence=0.92,
                params={"source": "home_assistant"},
                result={"output_text": "Done."},
            ),
            RequestChunkResult(
                text="what about cats",
                role="primary_request",
                capability="web_search",
                confidence=0.40,
                result={"output_text": "Cats are cool."},
            ),
        ])
        guide = _build_confidence_guide(spec)
        assert "trust this result" in guide
        assert "may not be relevant" in guide

    def test_supporting_context_excluded(self):
        spec = _make_spec([
            RequestChunkResult(
                text="because I'm tired",
                role="supporting_context",
                capability="",
                confidence=0.0,
            ),
        ])
        guide = _build_confidence_guide(spec)
        assert "No chunks to evaluate" in guide

    def test_no_primary_chunks(self):
        spec = _make_spec([])
        guide = _build_confidence_guide(spec)
        assert "No chunks to evaluate" in guide


class TestCombinePromptNoParrot:
    """The 'mention each successful chunk' instruction is gone."""

    def test_no_mention_each_instruction(self):
        assert "mention each" not in COMBINE_PROMPT.lower()
        assert "Mention each" not in COMBINE_PROMPT

    def test_combine_prompt_has_confidence_guide_slot(self):
        assert "{confidence_guide}" in COMBINE_PROMPT


class TestIDontKnowPath:
    """All-low-confidence or all-direct_chat specs allow 'NEED_SEARCH' fallback."""

    def test_combine_prompt_has_search_fallback_instruction(self):
        assert "NEED_SEARCH" in COMBINE_PROMPT
        assert "never guess" in COMBINE_PROMPT.lower()

    def test_all_direct_chat_renders_direct_template(self):
        """When all chunks are direct_chat, we get the direct_chat template
        which already says 'if you don't know, use NEED_SEARCH'."""
        spec = _make_spec([
            RequestChunkResult(
                text="what is love",
                role="primary_request",
                capability="direct_chat",
                confidence=0.3,
                result={"output_text": "what is love"},
            ),
        ])
        prompt = build_combine_prompt(spec)
        # direct_chat template includes the NEED_SEARCH instruction
        assert "need_search" in prompt.lower()

    def test_all_low_confidence_combine_includes_search_instruction(self):
        spec = _make_spec([
            RequestChunkResult(
                text="obscure query",
                role="primary_request",
                capability="web_search",
                confidence=0.3,
                result={"output_text": "Some guess"},
            ),
        ])
        prompt = build_combine_prompt(spec)
        assert "NEED_SEARCH" in prompt
        assert "low confidence" in prompt


class TestConfidenceGuideInRenderedPrompt:
    """Confidence guide is rendered into the final combine prompt."""

    def test_confidence_guide_rendered(self):
        spec = _make_spec([
            RequestChunkResult(
                text="turn off lights",
                role="primary_request",
                capability="toggle_device",
                confidence=0.92,
                params={"source": "home_assistant"},
                result={"output_text": "Done."},
            ),
        ])
        prompt = build_combine_prompt(spec)
        assert "structural source" in prompt
        assert "trust this result" in prompt
