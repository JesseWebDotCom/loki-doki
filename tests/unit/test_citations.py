"""Tests for C06 — citations end-to-end.

Verifies:
- Provider-backed skills populate sources via run_mechanisms / run_sources_parallel_scored.
- _collect_sources gathers deduplicated sources from RequestSpec.
- _render_sources_list formats sources for the combine prompt.
- _sanitize_citations cleans up LLM-emitted [src:N] markers.
- _stub_synthesize appends [src:N] markers for chunks with sources.
- COMBINE_PROMPT has sources_list slot.
- Citation accuracy: sources point to the correct skill.
"""
from __future__ import annotations

import pytest

from lokidoki.orchestrator.core.types import RequestChunkResult, RequestSpec
from lokidoki.orchestrator.fallbacks.llm_fallback import (
    _collect_sources,
    _render_sources_list,
    _sanitize_citations,
    _stub_synthesize,
    build_combine_prompt,
)
from lokidoki.orchestrator.fallbacks.prompts import COMBINE_PROMPT
from lokidoki.orchestrator.skills._runner import AdapterResult, run_mechanisms


def _make_spec(chunks: list[RequestChunkResult], **ctx) -> RequestSpec:
    return RequestSpec(
        trace_id="test-cite",
        original_request="test query",
        chunks=chunks,
        context=ctx,
    )


# ---------------------------------------------------------------------------
# Source propagation in run_mechanisms
# ---------------------------------------------------------------------------


class TestRunMechanismsSources:
    """run_mechanisms auto-populates sources from MechanismResult."""

    @pytest.mark.anyio
    async def test_source_url_propagated_to_sources_list(self):
        """When a v1 mechanism returns source_url, it ends up in sources."""
        from unittest.mock import AsyncMock, MagicMock
        from lokidoki.core.skill_executor import MechanismResult

        skill = MagicMock()
        result = MechanismResult(
            success=True,
            data={"lead": "test"},
            source_url="https://example.com/article",
            source_title="Example Article",
        )
        skill.execute_mechanism = AsyncMock(return_value=result)

        adapter_result = await run_mechanisms(
            skill,
            [("test_method", {})],
            on_success=lambda r, m: "test output",
            on_all_failed="failed",
        )
        assert adapter_result.success is True
        assert len(adapter_result.sources) == 1
        assert adapter_result.sources[0]["url"] == "https://example.com/article"
        assert adapter_result.sources[0]["title"] == "Example Article"

    @pytest.mark.anyio
    async def test_no_source_url_means_empty_sources(self):
        """When a v1 mechanism has no source_url, sources stays empty."""
        from unittest.mock import AsyncMock, MagicMock
        from lokidoki.core.skill_executor import MechanismResult

        skill = MagicMock()
        result = MechanismResult(success=True, data={"value": 42})
        skill.execute_mechanism = AsyncMock(return_value=result)

        adapter_result = await run_mechanisms(
            skill,
            [("calc", {})],
            on_success=lambda r, m: "42",
            on_all_failed="failed",
        )
        assert adapter_result.success is True
        assert adapter_result.sources == []

    @pytest.mark.anyio
    async def test_source_title_falls_back_to_url(self):
        """When source_title is empty, title defaults to URL."""
        from unittest.mock import AsyncMock, MagicMock
        from lokidoki.core.skill_executor import MechanismResult

        skill = MagicMock()
        result = MechanismResult(
            success=True,
            data={},
            source_url="https://example.com",
            source_title="",
        )
        skill.execute_mechanism = AsyncMock(return_value=result)

        adapter_result = await run_mechanisms(
            skill,
            [("test", {})],
            on_success=lambda r, m: "ok",
            on_all_failed="failed",
        )
        assert adapter_result.sources[0]["title"] == "https://example.com"


# ---------------------------------------------------------------------------
# _collect_sources
# ---------------------------------------------------------------------------


class TestCollectSources:
    """_collect_sources gathers deduplicated sources from RequestSpec chunks."""

    def test_collects_from_sources_field(self):
        spec = _make_spec([
            RequestChunkResult(
                text="weather", role="primary_request",
                capability="get_weather", confidence=0.9,
                result={
                    "output_text": "75°F",
                    "sources": [
                        {"url": "https://openmeteo.com", "title": "Open-Meteo"},
                    ],
                },
            ),
        ])
        sources = _collect_sources(spec)
        assert len(sources) == 1
        assert sources[0]["url"] == "https://openmeteo.com"
        assert sources[0]["title"] == "Open-Meteo"

    def test_collects_from_legacy_source_url(self):
        spec = _make_spec([
            RequestChunkResult(
                text="wiki", role="primary_request",
                capability="knowledge_query", confidence=0.9,
                result={
                    "output_text": "info",
                    "source_url": "https://en.wikipedia.org/wiki/Test",
                    "source_title": "Test - Wikipedia",
                },
            ),
        ])
        sources = _collect_sources(spec)
        assert len(sources) == 1
        assert sources[0]["url"] == "https://en.wikipedia.org/wiki/Test"

    def test_deduplicates_by_url(self):
        spec = _make_spec([
            RequestChunkResult(
                text="q1", role="primary_request",
                capability="knowledge_query", confidence=0.9,
                result={
                    "output_text": "a",
                    "sources": [
                        {"url": "https://example.com", "title": "Example"},
                        {"url": "https://example.com", "title": "Example Dup"},
                    ],
                },
            ),
        ])
        sources = _collect_sources(spec)
        assert len(sources) == 1

    def test_multi_chunk_sources(self):
        spec = _make_spec([
            RequestChunkResult(
                text="weather", role="primary_request",
                capability="get_weather", confidence=0.9,
                result={
                    "output_text": "75°F",
                    "sources": [{"url": "https://openmeteo.com", "title": "Open-Meteo"}],
                },
            ),
            RequestChunkResult(
                text="wiki", role="primary_request",
                capability="knowledge_query", confidence=0.9,
                result={
                    "output_text": "info",
                    "sources": [{"url": "https://wiki.com", "title": "Wiki"}],
                },
            ),
        ])
        sources = _collect_sources(spec)
        assert len(sources) == 2

    def test_skips_failed_chunks(self):
        spec = _make_spec([
            RequestChunkResult(
                text="broken", role="primary_request",
                capability="get_weather", confidence=0.9,
                success=False,
                result={
                    "output_text": "",
                    "sources": [{"url": "https://should-not-appear.com", "title": "X"}],
                },
            ),
        ])
        sources = _collect_sources(spec)
        assert len(sources) == 0

    def test_skips_supporting_context(self):
        spec = _make_spec([
            RequestChunkResult(
                text="context", role="supporting_context",
                capability="direct_chat", confidence=0.5,
                result={
                    "output_text": "",
                    "sources": [{"url": "https://should-not-appear.com", "title": "X"}],
                },
            ),
        ])
        sources = _collect_sources(spec)
        assert len(sources) == 0

    def test_empty_url_skipped(self):
        spec = _make_spec([
            RequestChunkResult(
                text="q", role="primary_request",
                capability="knowledge_query", confidence=0.9,
                result={
                    "output_text": "a",
                    "sources": [{"url": "", "title": "No URL"}],
                },
            ),
        ])
        sources = _collect_sources(spec)
        assert len(sources) == 0


# ---------------------------------------------------------------------------
# _render_sources_list
# ---------------------------------------------------------------------------


class TestRenderSourcesList:
    def test_empty_sources(self):
        assert _render_sources_list([]) == ""

    def test_single_source(self):
        rendered = _render_sources_list([
            {"url": "https://example.com", "title": "Example"},
        ])
        assert "[src:1]" in rendered
        assert "Example" in rendered
        assert "https://example.com" in rendered

    def test_multiple_sources_indexed(self):
        rendered = _render_sources_list([
            {"url": "https://a.com", "title": "A"},
            {"url": "https://b.com", "title": "B"},
        ])
        assert "[src:1]" in rendered
        assert "[src:2]" in rendered


# ---------------------------------------------------------------------------
# _sanitize_citations
# ---------------------------------------------------------------------------


class TestSanitizeCitations:
    def test_valid_citations_preserved(self):
        assert _sanitize_citations("Info [src:1] here.", 2) == "Info [src:1] here."

    def test_out_of_range_dropped(self):
        assert _sanitize_citations("Info [src:5] here.", 2) == "Info  here."

    def test_zero_index_dropped(self):
        assert _sanitize_citations("Info [src:0] here.", 2) == "Info  here."

    def test_non_numeric_dropped(self):
        assert _sanitize_citations("Info [src:wikipedia] here.", 2) == "Info  here."

    def test_no_sources_strips_all(self):
        assert _sanitize_citations("Info [src:1] here.", 0) == "Info  here."

    def test_multiple_citations(self):
        result = _sanitize_citations("A [src:1] and B [src:2].", 2)
        assert "[src:1]" in result
        assert "[src:2]" in result

    def test_mixed_valid_invalid(self):
        result = _sanitize_citations("A [src:1] B [src:99] C [src:text].", 3)
        assert "[src:1]" in result
        assert "[src:99]" not in result
        assert "[src:text]" not in result


# ---------------------------------------------------------------------------
# _stub_synthesize with citations
# ---------------------------------------------------------------------------


class TestStubSynthesizeCitations:
    def test_stub_appends_citation_markers(self):
        spec = _make_spec([
            RequestChunkResult(
                text="weather", role="primary_request",
                capability="get_weather", confidence=0.9,
                result={
                    "output_text": "It's 75°F in Austin.",
                    "sources": [{"url": "https://openmeteo.com", "title": "Open-Meteo"}],
                },
            ),
        ])
        resp = _stub_synthesize(spec)
        assert "[src:1]" in resp.output_text
        assert "75°F" in resp.output_text

    def test_stub_no_markers_when_no_sources(self):
        spec = _make_spec([
            RequestChunkResult(
                text="calc", role="primary_request",
                capability="calculate", confidence=0.9,
                result={"output_text": "42", "sources": []},
            ),
        ])
        resp = _stub_synthesize(spec)
        assert "[src:" not in resp.output_text
        assert "42" in resp.output_text

    def test_stub_multi_chunk_correct_indices(self):
        spec = _make_spec([
            RequestChunkResult(
                text="weather", role="primary_request",
                capability="get_weather", confidence=0.9,
                result={
                    "output_text": "75°F",
                    "sources": [{"url": "https://openmeteo.com", "title": "Open-Meteo"}],
                },
            ),
            RequestChunkResult(
                text="wiki", role="primary_request",
                capability="knowledge_query", confidence=0.9,
                result={
                    "output_text": "Python is a language.",
                    "sources": [{"url": "https://wiki.com/Python", "title": "Python"}],
                },
            ),
        ])
        resp = _stub_synthesize(spec)
        assert "[src:1]" in resp.output_text
        assert "[src:2]" in resp.output_text

    def test_stub_failed_chunk_no_citation(self):
        spec = _make_spec([
            RequestChunkResult(
                text="weather", role="primary_request",
                capability="get_weather", confidence=0.9,
                success=False,
                result={
                    "output_text": "",
                    "sources": [{"url": "https://openmeteo.com", "title": "Open-Meteo"}],
                },
            ),
        ])
        resp = _stub_synthesize(spec)
        assert "[src:" not in resp.output_text


# ---------------------------------------------------------------------------
# Combine prompt has sources_list slot
# ---------------------------------------------------------------------------


class TestCombinePromptSourcesSlot:
    def test_sources_list_slot_in_template(self):
        assert "{sources_list}" in COMBINE_PROMPT

    def test_sources_list_rendered_in_prompt(self):
        spec = _make_spec([
            RequestChunkResult(
                text="query", role="primary_request",
                capability="knowledge_query", confidence=0.9,
                result={
                    "output_text": "answer",
                    "sources": [{"url": "https://example.com", "title": "Example"}],
                },
            ),
        ])
        prompt = build_combine_prompt(spec)
        assert "[src:1]" in prompt
        assert "Example" in prompt
        assert "https://example.com" in prompt

    def test_empty_sources_list_no_noise(self):
        spec = _make_spec([
            RequestChunkResult(
                text="calc", role="primary_request",
                capability="calculate", confidence=0.9,
                result={"output_text": "42", "sources": []},
            ),
        ])
        prompt = build_combine_prompt(spec)
        assert "sources_list:" in prompt
        # The sources_list value should be empty (no actual source entries).
        # The template instruction mentions [src:N] generically, so we
        # check there's no *numbered* source entry like "[src:1]".
        assert "[src:1]" not in prompt

    def test_cite_instruction_in_template(self):
        assert "cite relevant sources" in COMBINE_PROMPT.lower()


# ---------------------------------------------------------------------------
# Citation accuracy: sources point to the right skill
# ---------------------------------------------------------------------------


class TestCitationAccuracy:
    """Sources must accurately attribute to the skill that produced them."""

    def test_weather_source_on_weather_chunk(self):
        spec = _make_spec([
            RequestChunkResult(
                text="weather in Austin",
                role="primary_request",
                capability="get_weather",
                confidence=0.9,
                result={
                    "output_text": "75°F in Austin.",
                    "sources": [{"url": "https://openmeteo.com", "title": "Open-Meteo"}],
                },
            ),
        ])
        sources = _collect_sources(spec)
        assert len(sources) == 1
        assert sources[0]["url"] == "https://openmeteo.com"
        # The stub synthesizer appends [src:1] to the weather chunk
        resp = _stub_synthesize(spec)
        assert "[src:1]" in resp.output_text
        assert "75°F" in resp.output_text

    def test_knowledge_source_on_knowledge_chunk(self):
        spec = _make_spec([
            RequestChunkResult(
                text="what is Python",
                role="primary_request",
                capability="knowledge_query",
                confidence=0.9,
                result={
                    "output_text": "Python is a programming language.",
                    "sources": [
                        {"url": "https://en.wikipedia.org/wiki/Python", "title": "Python - Wikipedia"},
                    ],
                },
            ),
        ])
        sources = _collect_sources(spec)
        assert len(sources) == 1
        assert "wikipedia" in sources[0]["url"]
        resp = _stub_synthesize(spec)
        assert "[src:1]" in resp.output_text

    def test_mixed_skills_correct_attribution(self):
        """Each chunk's [src:N] points to that chunk's source, not another's."""
        spec = _make_spec([
            RequestChunkResult(
                text="weather", role="primary_request",
                capability="get_weather", confidence=0.9,
                result={
                    "output_text": "75°F",
                    "sources": [{"url": "https://openmeteo.com", "title": "Open-Meteo"}],
                },
            ),
            RequestChunkResult(
                text="what is Python", role="primary_request",
                capability="knowledge_query", confidence=0.9,
                result={
                    "output_text": "A language.",
                    "sources": [{"url": "https://wiki.com/Python", "title": "Python"}],
                },
            ),
        ])
        sources = _collect_sources(spec)
        assert sources[0]["url"] == "https://openmeteo.com"
        assert sources[1]["url"] == "https://wiki.com/Python"
        resp = _stub_synthesize(spec)
        # Weather chunk gets [src:1], knowledge gets [src:2]
        parts = resp.output_text.split()
        # Find index of [src:1] — should be near "75°F"
        src1_pos = resp.output_text.index("[src:1]")
        src2_pos = resp.output_text.index("[src:2]")
        weather_pos = resp.output_text.index("75°F")
        language_pos = resp.output_text.index("language")
        assert src1_pos > weather_pos, "[src:1] should follow weather text"
        assert src2_pos > language_pos, "[src:2] should follow knowledge text"
