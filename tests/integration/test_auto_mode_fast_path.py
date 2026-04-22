"""Integration coverage for the Auto-mode structured knowledge stub."""
from __future__ import annotations

import asyncio

import pytest

from lokidoki.orchestrator.adapters.base import AdapterOutput, Source
from lokidoki.orchestrator.core.pipeline_phases import run_synthesis_phase
from lokidoki.orchestrator.core.types import ExecutionResult, RequestChunkResult, RequestSpec, TraceData
from lokidoki.orchestrator.decomposer.types import RouteDecomposition
from lokidoki.orchestrator.fallbacks.llm_fallback import LLMDecision
from lokidoki.orchestrator.registry.runtime import get_runtime


def _make_spec() -> RequestSpec:
    return RequestSpec(
        trace_id="t-auto-stub",
        original_request="who is luke skywalker",
        chunks=[
            RequestChunkResult(
                text="who is luke skywalker",
                role="primary_request",
                capability="knowledge_query",
                confidence=0.96,
                success=True,
                result={"output_text": "Luke Skywalker is a Jedi Knight."},
            ),
        ],
    )


def _knowledge_execution(*, structured_markdown: str | None) -> ExecutionResult:
    lead = (
        "Luke Skywalker is a Jedi Knight from Tatooine and a hero of the Rebel Alliance."
    )
    data = {
        "title": "Luke Skywalker",
        "lead": lead,
        "url": "https://en.wikipedia.org/wiki/Luke_Skywalker",
    }
    if structured_markdown is not None:
        data["structured_markdown"] = structured_markdown
    return ExecutionResult(
        chunk_index=0,
        capability="knowledge_query",
        output_text=lead,
        success=True,
        raw_result={"data": data},
        adapter_output=AdapterOutput(
            summary_candidates=(lead,),
            facts=("Luke helped defeat the Empire.",),
            sources=(
                Source(
                    title="Luke Skywalker",
                    url="https://en.wikipedia.org/wiki/Luke_Skywalker",
                    kind="web",
                ),
            ),
        ),
    )


def _drain(queue: asyncio.Queue) -> list[dict]:
    events: list[dict] = []
    while not queue.empty():
        event = queue.get_nowait()
        events.append({
            "phase": event.phase,
            "status": event.status,
            "data": event.data,
        })
    return events


@pytest.mark.anyio
async def test_auto_mode_uses_structured_stub_without_llm(monkeypatch) -> None:
    llm_calls = 0

    async def _fake_llm(_spec):
        nonlocal llm_calls
        llm_calls += 1
        return None

    monkeypatch.setattr(
        "lokidoki.orchestrator.core.pipeline_phases.run_memory_read_path",
        lambda raw_text, ctx: {},
    )
    monkeypatch.setattr(
        "lokidoki.orchestrator.core.pipeline_phases.llm_synthesize_async",
        _fake_llm,
    )
    monkeypatch.setattr(
        "lokidoki.orchestrator.core.pipeline_phases.decide_llm",
        lambda spec: LLMDecision(needed=True, reason="should have been bypassed"),
    )

    queue: asyncio.Queue = asyncio.Queue()
    safe_context = {
        "_sse_queue": queue,
        "response_shape": "verbatim",
        "route_decomposition": RouteDecomposition(capability_need="encyclopedic"),
        "user_mode_override": None,
    }
    structured = (
        "Luke Skywalker is a Jedi Knight from Tatooine and a hero of the Rebel Alliance.\n\n"
        "## Early life\n\n"
        "Luke was raised by Owen and Beru Lars on their moisture farm.\n\n"
        "## Galactic Civil War\n\n"
        "Luke joined the Rebel Alliance and destroyed the first Death Star."
    )

    trace = TraceData(trace_id="t-auto")
    response, envelope = await run_synthesis_phase(
        trace,
        safe_context,
        "who is luke skywalker",
        _make_spec(),
        [_knowledge_execution(structured_markdown=structured)],
        None,
        get_runtime(),
    )

    assert llm_calls == 0
    combine_step = next(step for step in trace.steps if step.name == "combine")
    assert combine_step.details["mode"] == "structured_stub"
    assert combine_step.timing_ms < 200
    assert response.output_text == structured
    assert envelope.spoken_text == (
        "Luke Skywalker is a Jedi Knight from Tatooine and a hero of the Rebel Alliance."
    )
    summary = next(block for block in envelope.blocks if block.id == "summary")
    assert summary.content == structured
    assert len(envelope.source_surface) == 1

    events = _drain(queue)
    summary_patches = [
        event for event in events
        if event["phase"] == "block_patch" and event["data"].get("block_id") == "summary"
    ]
    source_events = [event for event in events if event["phase"] == "source_add"]
    assert len(summary_patches) == 1
    assert summary_patches[0]["data"]["delta"] == structured
    assert len(source_events) == 1


@pytest.mark.anyio
async def test_rich_mode_keeps_llm_synthesis(monkeypatch) -> None:
    llm_calls = 0

    async def _fake_llm(_spec):
        nonlocal llm_calls
        llm_calls += 1
        from lokidoki.orchestrator.core.types import ResponseObject

        return ResponseObject(output_text="## Key facts\n\nLuke is a Jedi with a longer synthesized answer.")

    monkeypatch.setattr(
        "lokidoki.orchestrator.core.pipeline_phases.run_memory_read_path",
        lambda raw_text, ctx: {},
    )
    monkeypatch.setattr(
        "lokidoki.orchestrator.core.pipeline_phases.llm_synthesize_async",
        _fake_llm,
    )
    monkeypatch.setattr(
        "lokidoki.orchestrator.core.pipeline_phases.decide_llm",
        lambda spec: LLMDecision(needed=True, reason="rich mode"),
    )

    structured = (
        "Luke Skywalker is a Jedi Knight.\n\n## Early life\n\nLuke grew up on Tatooine."
    )
    response, envelope = await run_synthesis_phase(
        TraceData(trace_id="t-rich"),
        {
            "response_shape": "verbatim",
            "route_decomposition": RouteDecomposition(capability_need="encyclopedic"),
            "user_mode_override": "rich",
        },
        "who is luke skywalker",
        _make_spec(),
        [_knowledge_execution(structured_markdown=structured)],
        None,
        get_runtime(),
    )

    assert llm_calls == 1
    assert response.output_text != structured
    summary = next(block for block in envelope.blocks if block.id == "summary")
    assert summary.content == response.output_text


@pytest.mark.anyio
async def test_auto_mode_knowledge_miss_falls_through_to_llm(monkeypatch) -> None:
    llm_calls = 0

    async def _fake_llm(_spec):
        nonlocal llm_calls
        llm_calls += 1
        from lokidoki.orchestrator.core.types import ResponseObject

        return ResponseObject(output_text="Fallback synthesis for a knowledge miss.")

    monkeypatch.setattr(
        "lokidoki.orchestrator.core.pipeline_phases.run_memory_read_path",
        lambda raw_text, ctx: {},
    )
    monkeypatch.setattr(
        "lokidoki.orchestrator.core.pipeline_phases.llm_synthesize_async",
        _fake_llm,
    )
    monkeypatch.setattr(
        "lokidoki.orchestrator.core.pipeline_phases.decide_llm",
        lambda spec: LLMDecision(needed=True, reason="knowledge miss"),
    )

    response, _envelope = await run_synthesis_phase(
        TraceData(trace_id="t-miss"),
        {
            "response_shape": "verbatim",
            "route_decomposition": RouteDecomposition(capability_need="encyclopedic"),
            "user_mode_override": None,
        },
        "who is luke skywalker",
        _make_spec(),
        [_knowledge_execution(structured_markdown=None)],
        None,
        get_runtime(),
    )

    assert llm_calls == 1
    assert response.output_text == "Fallback synthesis for a knowledge miss."


@pytest.mark.anyio
async def test_deep_mode_keeps_llm_synthesis(monkeypatch) -> None:
    llm_calls = 0

    async def _fake_llm(_spec):
        nonlocal llm_calls
        llm_calls += 1
        from lokidoki.orchestrator.core.types import ResponseObject

        return ResponseObject(output_text="Deep-mode synthesis stays on the LLM path.")

    monkeypatch.setattr(
        "lokidoki.orchestrator.core.pipeline_phases.run_memory_read_path",
        lambda raw_text, ctx: {},
    )
    monkeypatch.setattr(
        "lokidoki.orchestrator.core.pipeline_phases.llm_synthesize_async",
        _fake_llm,
    )
    monkeypatch.setattr(
        "lokidoki.orchestrator.core.pipeline_phases.decide_llm",
        lambda spec: LLMDecision(needed=True, reason="deep mode"),
    )

    response, _envelope = await run_synthesis_phase(
        TraceData(trace_id="t-deep"),
        {
            "response_shape": "verbatim",
            "reasoning_complexity": "thinking",
            "route_decomposition": RouteDecomposition(capability_need="encyclopedic"),
            "user_mode_override": "deep",
        },
        "who is luke skywalker",
        _make_spec(),
        [_knowledge_execution(structured_markdown="Luke Skywalker is a Jedi Knight.")],
        None,
        get_runtime(),
    )

    assert llm_calls == 1
    assert response.output_text == "Deep-mode synthesis stays on the LLM path."
