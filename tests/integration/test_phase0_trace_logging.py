from __future__ import annotations

from unittest.mock import AsyncMock

import pytest

from lokidoki.core.decomposer import Ask, DecompositionResult
from lokidoki.core.memory_provider import MemoryProvider
from lokidoki.core.model_manager import ModelManager, ModelPolicy
from lokidoki.core.orchestrator import Orchestrator


def _stream(text: str):
    async def _gen(*_a, **_kw):
        yield text

    return _gen


@pytest.fixture
async def memory(tmp_path):
    mp = MemoryProvider(db_path=str(tmp_path / "phase0_trace.db"))
    await mp.initialize()
    yield mp
    await mp.close()


@pytest.mark.anyio
async def test_chat_turn_persists_complete_trace_record(memory):
    uid = await memory.get_or_create_user("default")
    sid = await memory.create_session(uid)

    decomp = DecompositionResult(
        is_course_correction=False,
        overall_reasoning_complexity="fast",
        short_term_memory={"sentiment": "neutral", "concern": ""},
        asks=[Ask(ask_id="ask_1", intent="direct_chat", distilled_query="Hello there")],
        model="gemma4:e2b",
        latency_ms=12.0,
    )
    mock_decomposer = AsyncMock()
    mock_decomposer.decompose = AsyncMock(return_value=decomp)

    mock_inference = AsyncMock()
    mock_inference.generate_stream = _stream("Hello back.")

    orch = Orchestrator(
        decomposer=mock_decomposer,
        inference_client=mock_inference,
        memory=memory,
        model_manager=ModelManager(
            inference_client=mock_inference,
            policy=ModelPolicy(platform="mac"),
        ),
    )

    async for _ in orch.process("Hello there", user_id=uid, session_id=sid):
        pass

    traces = await memory.list_chat_traces(uid, session_id=sid, limit=5)
    assert len(traces) == 1

    trace = traces[0]
    assert trace["response_lane_actual"]
    assert trace["response_spec_shadow_json"]["reply_mode"]
    assert trace["prompt_sizes_json"]["decomposition"]
    assert trace["phase_latencies_json"]["decomposition"] >= 0
    assert trace["decomposition_json"]["asks"][0]["distilled_query"] == "Hello there"
    assert "retrieved_memory_candidates_json" in trace
    assert "selected_injected_memories_json" in trace
    assert "skill_results_json" in trace
