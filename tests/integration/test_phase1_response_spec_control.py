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
    mp = MemoryProvider(db_path=str(tmp_path / "phase1_response_spec.db"))
    await mp.initialize()
    yield mp
    await mp.close()


@pytest.mark.anyio
async def test_fact_sharing_turn_routes_to_social_ack_on_chat_path(memory):
    uid = await memory.get_or_create_user("default")
    sid = await memory.create_session(uid)

    decomp = DecompositionResult(
        overall_reasoning_complexity="fast",
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
    mock_inference = AsyncMock()
    mock_inference.generate_stream = _stream("Sounds like a great reset.")

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
    async for event in orch.process("I like hiking", user_id=uid, session_id=sid):
        events.append(event)

    done = next(e for e in events if e.phase == "synthesis" and e.status == "done")
    assert done.data["response"] == "Sounds like a great reset."

    traces = await memory.list_chat_traces(uid, session_id=sid, limit=1)
    assert traces[0]["response_lane_actual"] == "social_ack"
    assert traces[0]["response_spec_shadow_json"]["reply_mode"] == "social_ack"


@pytest.mark.anyio
async def test_mixed_grounded_and_reasoning_turn_routes_to_full_synthesis(memory):
    uid = await memory.get_or_create_user("default")
    sid = await memory.create_session(uid)

    asks = [
        Ask(
            ask_id="ask_1",
            intent="direct_chat",
            distilled_query="who is the president",
            requires_current_data=True,
        ),
        Ask(
            ask_id="ask_2",
            intent="direct_chat",
            distilled_query="what does that mean for the next election",
        ),
    ]
    decomp = DecompositionResult(
        overall_reasoning_complexity="thinking",
        asks=asks,
        model="gemma4:e2b",
    )
    mock_decomposer = AsyncMock()
    mock_decomposer.decompose = AsyncMock(return_value=decomp)
    captured = {}

    def _capture_stream(*_a, **kw):
        captured.update(kw)

        async def _gen():
            yield "Here’s the current answer and the likely implication."

        return _gen()

    mock_inference = AsyncMock()
    mock_inference.generate_stream = _capture_stream

    orch = Orchestrator(
        decomposer=mock_decomposer,
        inference_client=mock_inference,
        memory=memory,
        model_manager=ModelManager(
            inference_client=mock_inference,
            policy=ModelPolicy(platform="mac"),
        ),
    )

    async for _ in orch.process(
        "who is the president right now and what does that mean for the next election",
        user_id=uid,
        session_id=sid,
    ):
        pass

    traces = await memory.list_chat_traces(uid, session_id=sid, limit=1)
    assert traces[0]["response_lane_actual"] == "full_synthesis"
    assert traces[0]["response_spec_shadow_json"]["reply_mode"] == "full_synthesis"
    assert "SKILL_DATA:" in captured["prompt"]
