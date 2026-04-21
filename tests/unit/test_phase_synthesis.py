"""Tests for ``run_synthesis_phase`` post the adapter cutover.

Focus: the synthesis phase reads sources and facts from
``execution.adapter_output`` (via ``_apply_adapter_outputs_to_spec``) and
stitches them onto the ``RequestSpec`` so downstream consumers
(``_collect_sources``, the deterministic combiner, streaming event
emitter) no longer need per-skill dict-shape knowledge.
"""
from __future__ import annotations

import pytest

from lokidoki.orchestrator.adapters.base import AdapterOutput, Source
from lokidoki.orchestrator.core.pipeline_phases import (
    _apply_adapter_outputs_to_spec,
    run_synthesis_phase,
)
from lokidoki.orchestrator.core.types import (
    ExecutionResult,
    RequestChunkResult,
    RequestSpec,
    TraceData,
)
from lokidoki.orchestrator.fallbacks.llm_prompt_builder import _collect_sources
from lokidoki.orchestrator.registry.runtime import get_runtime
from lokidoki.orchestrator.response import BlockState, BlockType, ResponseEnvelope


def _exec(idx: int, capability: str, adapter_output: AdapterOutput) -> ExecutionResult:
    return ExecutionResult(
        chunk_index=idx,
        capability=capability,
        output_text="",
        success=True,
        adapter_output=adapter_output,
    )


def _make_spec(chunks=None) -> RequestSpec:
    return RequestSpec(
        trace_id="t-synth",
        original_request="test turn",
        chunks=list(chunks or []),
    )


class TestApplyAdapterOutputsToSpec:
    """``_apply_adapter_outputs_to_spec`` is the sole source for sources/facts."""

    def test_populates_adapter_sources_in_order(self):
        spec = _make_spec()
        executions = [
            _exec(
                0,
                "knowledge_query",
                AdapterOutput(
                    sources=(
                        Source(title="Padme", url="https://example.test/padme", kind="web"),
                    ),
                ),
            ),
            _exec(
                1,
                "search_web",
                AdapterOutput(
                    sources=(
                        Source(title="Yoda", url="https://example.test/yoda", kind="web"),
                    ),
                ),
            ),
        ]

        _apply_adapter_outputs_to_spec(spec, executions)

        urls = [entry["url"] for entry in spec.adapter_sources]
        assert urls == ["https://example.test/padme", "https://example.test/yoda"]

    def test_appends_facts_to_supporting_context(self):
        spec = _make_spec()
        executions = [
            _exec(
                0,
                "knowledge_query",
                AdapterOutput(
                    sources=(),
                    facts=("Obi-Wan trained Anakin.", "Yoda trained Luke."),
                ),
            ),
        ]

        _apply_adapter_outputs_to_spec(spec, executions)

        assert "Obi-Wan trained Anakin." in spec.supporting_context
        assert "Yoda trained Luke." in spec.supporting_context

    def test_preserves_existing_supporting_context(self):
        spec = _make_spec()
        spec.supporting_context = ["pre-existing context"]
        executions = [
            _exec(
                0,
                "knowledge_query",
                AdapterOutput(facts=("new fact",)),
            ),
        ]

        _apply_adapter_outputs_to_spec(spec, executions)

        assert spec.supporting_context[0] == "pre-existing context"
        assert "new fact" in spec.supporting_context

    def test_no_successful_adapters_leaves_spec_clean(self):
        spec = _make_spec()
        spec.supporting_context = []

        _apply_adapter_outputs_to_spec(spec, [])

        assert spec.adapter_sources == []
        assert spec.supporting_context == []


class TestCollectSourcesPrefersAdapterSources:
    """``_collect_sources`` reads the adapter-aggregated list when present."""

    def test_adapter_sources_override_per_chunk_result(self):
        chunk = RequestChunkResult(
            text="padme",
            role="primary_request",
            capability="knowledge_query",
            confidence=0.9,
            success=True,
            result={
                "output_text": "...",
                "sources": [
                    {"url": "https://stale.test/padme", "title": "stale legacy"},
                ],
            },
        )
        spec = _make_spec(chunks=[chunk])
        spec.adapter_sources = [
            {"url": "https://example.test/padme", "title": "Padme", "type": "web"},
        ]

        sources = _collect_sources(spec)

        # The adapter source wins; the legacy per-chunk source is ignored
        # entirely because the adapter output is the canonical shape now.
        assert [src["url"] for src in sources] == ["https://example.test/padme"]

    def test_adapter_sources_dedupe_by_url(self):
        spec = _make_spec()
        spec.adapter_sources = [
            {"url": "https://example.test/leia", "title": "First"},
            {"url": "https://example.test/leia", "title": "Duplicate"},
        ]

        sources = _collect_sources(spec)

        assert len(sources) == 1
        assert sources[0]["title"] == "First"

    def test_empty_adapter_sources_falls_back_to_chunk_results(self):
        chunk = RequestChunkResult(
            text="obi-wan",
            role="primary_request",
            capability="knowledge_query",
            confidence=0.9,
            success=True,
            result={
                "output_text": "...",
                "sources": [
                    {"url": "https://example.test/obiwan", "title": "Obi-Wan"},
                ],
            },
        )
        spec = _make_spec(chunks=[chunk])
        # adapter_sources left empty — fast-lane / pre-cutover shape.

        sources = _collect_sources(spec)

        assert [src["url"] for src in sources] == ["https://example.test/obiwan"]

    def test_adapter_sources_without_url_are_dropped(self):
        """Legacy behavior preserved: only citable (URL-bearing) sources survive."""
        spec = _make_spec()
        spec.adapter_sources = [
            {"url": "", "title": "offline snippet"},
            {"url": "https://example.test/han", "title": "Han"},
        ]

        sources = _collect_sources(spec)

        assert [src["url"] for src in sources] == ["https://example.test/han"]


@pytest.mark.anyio
async def test_run_synthesis_phase_stitches_adapter_sources_onto_spec(monkeypatch):
    """End-to-end: synthesis phase writes adapter_sources before the LLM decision."""
    spec = _make_spec(chunks=[
        RequestChunkResult(
            text="who is luke",
            role="primary_request",
            capability="knowledge_query",
            confidence=0.9,
            success=True,
            result={"output_text": "Luke is a Jedi."},
        ),
    ])
    executions = [
        _exec(
            0,
            "knowledge_query",
            AdapterOutput(
                summary_candidates=("Luke is a Jedi.",),
                facts=("Luke trained with Yoda.",),
                sources=(
                    Source(title="Luke", url="https://example.test/luke", kind="web"),
                ),
            ),
        ),
    ]

    # Stub the LLM decider to keep this unit-test hermetic.
    monkeypatch.setattr(
        "lokidoki.orchestrator.core.pipeline_phases.run_memory_read_path",
        lambda raw_text, ctx: {},
    )

    from lokidoki.orchestrator.fallbacks.llm_fallback import LLMDecision

    monkeypatch.setattr(
        "lokidoki.orchestrator.core.pipeline_phases.decide_llm",
        lambda s: LLMDecision(needed=False, reason="unit test"),
    )

    trace = TraceData(trace_id="t-synth-envelope")
    response, envelope = await run_synthesis_phase(
        trace, {}, "who is luke", spec, executions, None, get_runtime(),
    )

    assert response.output_text  # non-empty from deterministic combiner
    assert spec.adapter_sources == [
        {
            "title": "Luke",
            "url": "https://example.test/luke",
            "type": "web",
        }
    ]
    assert "Luke trained with Yoda." in spec.supporting_context

    # Envelope: planner allocated summary + sources (media absent); the
    # summary is filled with the combined response text; sources block
    # mirrors spec.adapter_sources; source_surface is populated too.
    assert isinstance(envelope, ResponseEnvelope)
    assert envelope.request_id == "t-synth-envelope"
    assert envelope.mode == "standard"
    assert envelope.status == "complete"

    block_ids = [block.id for block in envelope.blocks]
    assert "summary" in block_ids
    assert "sources" in block_ids
    assert "media" not in block_ids

    summary_block = next(b for b in envelope.blocks if b.id == "summary")
    assert summary_block.type is BlockType.summary
    assert summary_block.state is BlockState.ready
    assert summary_block.content == response.output_text

    sources_block = next(b for b in envelope.blocks if b.id == "sources")
    assert sources_block.state is BlockState.ready
    assert sources_block.items == spec.adapter_sources
    assert envelope.source_surface == spec.adapter_sources
