"""C04 — SSE streaming wrapper tests.

Validates that ``stream_pipeline_sse`` yields v1-frontend-compatible
SSE events with the correct phase names, data shapes, and error path.
"""
from __future__ import annotations

import asyncio
import json
from typing import Any
from unittest.mock import AsyncMock, patch

import pytest

from v2.orchestrator.core.streaming import (
    SSEEvent,
    _build_decomposition_data,
    _build_error_event,
    _build_routing_data,
    _build_synthesis_done,
    stream_pipeline_sse,
)
from v2.orchestrator.core.types import (
    TraceStep,
    TraceSummary,
)


# ---- SSEEvent unit tests ------------------------------------------------


class TestSSEEvent:
    def test_to_sse_format(self):
        event = SSEEvent(phase="synthesis", status="done", data={"response": "hi"})
        raw = event.to_sse()
        assert raw.startswith("data: ")
        assert raw.endswith("\n\n")
        payload = json.loads(raw[len("data: ") :].strip())
        assert payload["phase"] == "synthesis"
        assert payload["status"] == "done"
        assert payload["data"]["response"] == "hi"

    def test_to_sse_empty_data(self):
        event = SSEEvent(phase="routing", status="active")
        payload = json.loads(event.to_sse()[len("data: ") :].strip())
        assert payload["data"] == {}


# ---- phase data builder tests -------------------------------------------


class TestDecompositionData:
    def test_includes_asks_from_split_step(self):
        cache = {
            "split": TraceStep(
                name="split",
                timing_ms=2.0,
                details={"chunks": ["what is the weather", "play music"]},
            ),
            "signals": TraceStep(
                name="signals",
                timing_ms=1.0,
                details={"urgency": "low"},
            ),
        }
        data = _build_decomposition_data(cache, {"decomposition": 10.5})
        assert data["model"] == "v2-pipeline"
        assert data["latency_ms"] == 10.5
        assert len(data["asks"]) == 2
        assert data["asks"][0]["ask_id"] == "chunk_0"
        assert data["asks"][0]["distilled_query"] == "what is the weather"

    def test_missing_steps_still_returns_valid_data(self):
        data = _build_decomposition_data({}, {"decomposition": 3.0})
        assert data["model"] == "v2-pipeline"
        assert data["latency_ms"] == 3.0
        assert "asks" not in data


class TestRoutingData:
    def test_builds_routing_log(self):
        cache = {
            "route": TraceStep(
                name="route",
                timing_ms=5.0,
                details={
                    "chunks": [
                        {"chunk_index": 0, "capability": "weather_current", "confidence": 0.9},
                    ],
                },
            ),
            "execute": TraceStep(
                name="execute",
                timing_ms=20.0,
                details={
                    "chunks": [
                        {"chunk_index": 0, "capability": "weather_current", "success": True, "timing_ms": 18.5},
                    ],
                },
            ),
        }
        data = _build_routing_data(cache, {"routing": 30.0})
        assert data["skills_resolved"] == 1
        assert data["skills_failed"] == 0
        assert len(data["routing_log"]) == 1
        assert data["routing_log"][0]["status"] == "success"
        assert data["routing_log"][0]["intent"] == "weather_current"
        assert data["latency_ms"] == 30.0

    def test_mixed_success_failure(self):
        cache = {
            "route": TraceStep(
                name="route",
                details={
                    "chunks": [
                        {"chunk_index": 0, "capability": "a"},
                        {"chunk_index": 1, "capability": "b"},
                    ],
                },
            ),
            "execute": TraceStep(
                name="execute",
                details={
                    "chunks": [
                        {"chunk_index": 0, "success": True, "timing_ms": 10},
                        {"chunk_index": 1, "success": False, "timing_ms": 5},
                    ],
                },
            ),
        }
        data = _build_routing_data(cache, {"routing": 15.0})
        assert data["skills_resolved"] == 1
        assert data["skills_failed"] == 1

    def test_empty_steps(self):
        data = _build_routing_data({}, {"routing": 0})
        assert data["skills_resolved"] == 0
        assert data["routing_log"] == []


class TestSynthesisDone:
    def test_builds_from_pipeline_result(self):
        class FakeResponse:
            output_text = "Hello there!"

        class FakeSpec:
            llm_model = "qwen2.5:3b"

        class FakeResult:
            response = FakeResponse()
            request_spec = FakeSpec()
            trace_summary = TraceSummary(total_timing_ms=123.456)
            executions = []

        data = _build_synthesis_done(FakeResult())
        assert data["response"] == "Hello there!"
        assert data["model"] == "qwen2.5:3b"
        assert data["latency_ms"] == 123.5
        assert data["tone"] == "neutral"
        assert data["sources"] == []
        assert data["platform"] == "v2"

    def test_fallback_model_when_none(self):
        class FakeResponse:
            output_text = "ok"

        class FakeSpec:
            llm_model = None

        class FakeResult:
            response = FakeResponse()
            request_spec = FakeSpec()
            trace_summary = TraceSummary(total_timing_ms=10.0)
            executions = []

        data = _build_synthesis_done(FakeResult())
        assert data["model"] == "v2-pipeline"


class TestErrorEvent:
    def test_matches_v1_error_shape(self):
        event = _build_error_event()
        assert event.phase == "synthesis"
        assert event.status == "done"
        assert event.data["error"] is True
        assert event.data["model"] == "error"
        assert event.data["latency_ms"] == 0
        assert event.data["tone"] == "neutral"
        assert isinstance(event.data["sources"], list)
        assert "Something went wrong" in event.data["response"]


# ---- integration tests (pipeline-level) ----------------------------------


def _parse_sse_events(raw_chunks: list[str]) -> list[dict[str, Any]]:
    """Parse raw SSE strings into dicts."""
    events = []
    for chunk in raw_chunks:
        for line in chunk.strip().split("\n"):
            if line.startswith("data: "):
                events.append(json.loads(line[len("data: ") :]))
    return events


@pytest.mark.anyio
async def test_stream_emits_v1_phases_for_normal_query():
    """A non-fast-lane query emits decomposition, routing, augmentation, synthesis."""
    events: list[str] = []
    async for chunk in stream_pipeline_sse("what is the weather in Austin"):
        events.append(chunk)

    parsed = _parse_sse_events(events)
    phases = [e["phase"] for e in parsed]

    # Must include the core v1 phases.
    assert "decomposition" in phases
    assert "routing" in phases
    assert "synthesis" in phases

    # Decomposition must have both active and done.
    decomp_statuses = [e["status"] for e in parsed if e["phase"] == "decomposition"]
    assert "active" in decomp_statuses
    assert "done" in decomp_statuses

    # Routing must have both active and done.
    route_statuses = [e["status"] for e in parsed if e["phase"] == "routing"]
    assert "active" in route_statuses
    assert "done" in route_statuses

    # Synthesis must end with done containing response text.
    synth_done = [e for e in parsed if e["phase"] == "synthesis" and e["status"] == "done"]
    assert len(synth_done) == 1
    assert "response" in synth_done[0]["data"]


@pytest.mark.anyio
async def test_stream_emits_micro_fast_lane_for_greeting():
    """A greeting query hits the fast lane and emits micro_fast_lane + synthesis."""
    events: list[str] = []
    async for chunk in stream_pipeline_sse("hello"):
        events.append(chunk)

    parsed = _parse_sse_events(events)
    phases = [e["phase"] for e in parsed]

    assert "micro_fast_lane" in phases
    fl = next(e for e in parsed if e["phase"] == "micro_fast_lane")
    assert fl["data"]["hit"] is True

    # Must still get synthesis done.
    synth_done = [e for e in parsed if e["phase"] == "synthesis" and e["status"] == "done"]
    assert len(synth_done) == 1
    assert synth_done[0]["data"]["response"]  # non-empty


@pytest.mark.anyio
async def test_stream_ordering_decomp_before_routing():
    """Decomposition done must arrive before routing active."""
    events: list[str] = []
    async for chunk in stream_pipeline_sse("what is the weather in Austin"):
        events.append(chunk)

    parsed = _parse_sse_events(events)
    phase_status = [(e["phase"], e["status"]) for e in parsed]

    decomp_done_idx = next(
        i for i, ps in enumerate(phase_status) if ps == ("decomposition", "done")
    )
    route_active_idx = next(
        i for i, ps in enumerate(phase_status) if ps == ("routing", "active")
    )
    assert decomp_done_idx < route_active_idx


@pytest.mark.anyio
async def test_stream_synthesis_is_last_event():
    """The final event must be synthesis done."""
    events: list[str] = []
    async for chunk in stream_pipeline_sse("tell me a joke"):
        events.append(chunk)

    parsed = _parse_sse_events(events)
    last = parsed[-1]
    assert last["phase"] == "synthesis"
    assert last["status"] == "done"


@pytest.mark.anyio
async def test_stream_error_path_emits_graceful_event():
    """Pipeline crash yields a graceful error event matching v1's shape."""
    with patch(
        "v2.orchestrator.core.pipeline.run_pipeline_async",
        new_callable=AsyncMock,
        side_effect=RuntimeError("kaboom"),
    ):
        events: list[str] = []
        async for chunk in stream_pipeline_sse("anything"):
            events.append(chunk)

    parsed = _parse_sse_events(events)
    assert len(parsed) >= 1
    error = parsed[-1]
    assert error["phase"] == "synthesis"
    assert error["status"] == "done"
    assert error["data"]["error"] is True
    assert error["data"]["model"] == "error"


@pytest.mark.anyio
async def test_stream_decomposition_data_shape():
    """Decomposition done event has v1-compatible data fields."""
    events: list[str] = []
    async for chunk in stream_pipeline_sse("what is the capital of France"):
        events.append(chunk)

    parsed = _parse_sse_events(events)
    decomp = next(
        (e for e in parsed if e["phase"] == "decomposition" and e["status"] == "done"),
        None,
    )
    assert decomp is not None
    data = decomp["data"]
    assert "model" in data
    assert "latency_ms" in data
    assert isinstance(data["latency_ms"], (int, float))


@pytest.mark.anyio
async def test_stream_routing_data_shape():
    """Routing done event has v1-compatible skills_resolved/skills_failed."""
    events: list[str] = []
    async for chunk in stream_pipeline_sse("what is the weather in Austin"):
        events.append(chunk)

    parsed = _parse_sse_events(events)
    routing = next(
        (e for e in parsed if e["phase"] == "routing" and e["status"] == "done"),
        None,
    )
    assert routing is not None
    data = routing["data"]
    assert "skills_resolved" in data
    assert "skills_failed" in data
    assert "routing_log" in data
    assert isinstance(data["routing_log"], list)


@pytest.mark.anyio
async def test_stream_synthesis_data_has_required_fields():
    """Synthesis done event has all fields the frontend requires."""
    events: list[str] = []
    async for chunk in stream_pipeline_sse("hello"):
        events.append(chunk)

    parsed = _parse_sse_events(events)
    synth = next(
        e for e in parsed if e["phase"] == "synthesis" and e["status"] == "done"
    )
    data = synth["data"]
    for field in ("response", "model", "latency_ms", "tone", "sources"):
        assert field in data, f"missing field: {field}"


@pytest.mark.anyio
async def test_trace_listener_wiring_via_context():
    """Pipeline respects _trace_listener in context (the mechanism streaming.py uses)."""
    from v2.orchestrator.core.pipeline import run_pipeline_async

    received: list[str] = []
    context = {"_trace_listener": lambda step: received.append(step.name)}
    await run_pipeline_async("hello", context=context)

    assert "normalize" in received
    assert len(received) >= 3  # at least normalize, signals, fast_lane


@pytest.mark.anyio
async def test_all_events_are_valid_json():
    """Every SSE chunk is parseable as valid JSON."""
    async for chunk in stream_pipeline_sse("spell restaurant"):
        assert chunk.startswith("data: ")
        assert chunk.endswith("\n\n")
        payload = json.loads(chunk[len("data: ") :].strip())
        assert "phase" in payload
        assert "status" in payload
        assert "data" in payload
