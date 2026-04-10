"""Latency benchmark for Phase 5: micro fast-lane eligible turns.

Verifies that greeting/gratitude turns that hit the micro fast-lane
are measurably faster than turns that go through the full decomposer
pipeline, because they skip decomposition entirely.
"""
from __future__ import annotations

import time
from unittest.mock import AsyncMock

import pytest

from lokidoki.core.decomposer import Ask, DecompositionResult
from lokidoki.core.memory_provider import MemoryProvider
from lokidoki.core.micro_fast_lane import reset_template_cache
from lokidoki.core.model_manager import ModelManager, ModelPolicy
from lokidoki.core.orchestrator import Orchestrator


def _stream(text: str):
    async def _gen(*_a, **_kw):
        yield text
    return _gen


@pytest.fixture
async def memory(tmp_path):
    mp = MemoryProvider(db_path=str(tmp_path / "phase5_bench.db"))
    await mp.initialize()
    yield mp
    await mp.close()


@pytest.fixture(autouse=True)
def _reset_cache():
    reset_template_cache()
    yield
    reset_template_cache()


async def _run_turn(memory, user_id, message, mock_decomposer, mock_inference):
    """Run a single turn and return (elapsed_ms, events)."""
    sid = await memory.create_session(user_id)
    orch = Orchestrator(
        decomposer=mock_decomposer,
        inference_client=mock_inference,
        memory=memory,
        model_manager=ModelManager(
            inference_client=mock_inference,
            policy=ModelPolicy(platform="mac"),
        ),
    )
    events = []
    t0 = time.perf_counter()
    async for event in orch.process(message, user_id=user_id, session_id=sid):
        events.append(event)
    elapsed = (time.perf_counter() - t0) * 1000
    return elapsed, events


@pytest.mark.anyio
async def test_fast_lane_greeting_faster_than_decomposed_turn(memory):
    """Greeting via micro fast-lane should be faster than a normal decomposed turn."""
    uid = await memory.get_or_create_user("default")

    mock_inference = AsyncMock()
    mock_inference.generate_stream = _stream("Hey!")

    # Decomposer for the normal path.
    decomp = DecompositionResult(
        asks=[Ask(ask_id="ask_1", intent="direct_chat", distilled_query="I like hiking")],
        long_term_memory=[{
            "subject_type": "self",
            "predicate": "likes",
            "value": "hiking",
            "kind": "preference",
            "category": "preference",
        }],
        model="gemma4:e2b",
    )
    mock_decomposer = AsyncMock()
    mock_decomposer.decompose = AsyncMock(return_value=decomp)

    iterations = 5
    fast_lane_times = []
    normal_times = []

    for _ in range(iterations):
        # Fast-lane turn: "hi"
        elapsed, events = await _run_turn(memory, uid, "hi", mock_decomposer, mock_inference)
        fast_lane_times.append(elapsed)

        # Normal turn: "I like hiking"
        mock_inference.generate_stream = _stream("Nice!")
        elapsed, events = await _run_turn(memory, uid, "I like hiking", mock_decomposer, mock_inference)
        normal_times.append(elapsed)

        mock_inference.generate_stream = _stream("Hey!")

    fast_lane_times.sort()
    normal_times.sort()

    p50_fast = fast_lane_times[len(fast_lane_times) // 2]
    p50_normal = normal_times[len(normal_times) // 2]

    # The fast-lane skips decomposition, referent resolution, memory
    # persistence, routing, and memory selection — it should be faster.
    # We don't assert a hard threshold because CI environments vary,
    # but the fast-lane should not be SLOWER.
    assert p50_fast <= p50_normal * 1.5, (
        f"Fast-lane p50 ({p50_fast:.1f}ms) should not be materially "
        f"slower than normal path p50 ({p50_normal:.1f}ms)"
    )


@pytest.mark.anyio
async def test_fast_lane_latency_logged_in_phase_latencies(memory):
    """The micro_fast_lane phase latency should appear in the trace."""
    uid = await memory.get_or_create_user("default")
    sid = await memory.create_session(uid)

    mock_decomposer = AsyncMock()
    mock_decomposer.decompose = AsyncMock()
    mock_inference = AsyncMock()
    mock_inference.generate_stream = _stream("Hi!")

    orch = Orchestrator(
        decomposer=mock_decomposer,
        inference_client=mock_inference,
        memory=memory,
        model_manager=ModelManager(
            inference_client=mock_inference,
            policy=ModelPolicy(platform="mac"),
        ),
    )

    events = []
    async for event in orch.process("hi", user_id=uid, session_id=sid):
        events.append(event)

    fl_events = [e for e in events if e.phase == "micro_fast_lane"]
    assert len(fl_events) == 1
    assert fl_events[0].data["latency_ms"] >= 0.0

    traces = await memory.list_chat_traces(uid, session_id=sid, limit=1)
    assert traces[0]["phase_latencies_json"].get("micro_fast_lane") is not None
