from __future__ import annotations

from unittest.mock import AsyncMock

import pytest

from lokidoki.core.decomposer import Ask, DecompositionResult
from lokidoki.core.memory_provider import MemoryProvider
from lokidoki.core.model_manager import ModelManager, ModelPolicy
from lokidoki.core.orchestrator import Orchestrator


@pytest.fixture
async def memory(tmp_path):
    mp = MemoryProvider(db_path=str(tmp_path / "phase2_memory_context.db"))
    await mp.initialize()
    yield mp
    await mp.close()


def _capture_stream(captured: dict, text: str = "ok"):
    def _factory(*_a, **kw):
        captured.update(kw)

        async def _gen():
            yield text

        return _gen()

    return _factory


@pytest.mark.anyio
async def test_relationship_turn_prefers_relational_memory_on_chat_path(memory):
    uid = await memory.get_or_create_user("default")
    sid = await memory.create_session(uid)
    artie_id = await memory.create_person(uid, "Artie")
    await memory.add_relationship(uid, artie_id, "brother")
    await memory.upsert_fact(
        user_id=uid,
        subject="artie",
        subject_type="person",
        subject_ref_id=artie_id,
        predicate="likes",
        value="movies",
        category="preference",
    )
    await memory.upsert_fact(
        user_id=uid,
        subject="self",
        subject_type="self",
        predicate="likes",
        value="coffee",
        category="preference",
    )

    decomp = DecompositionResult(
        overall_reasoning_complexity="fast",
        asks=[
            Ask(
                ask_id="ask_1",
                intent="direct_chat",
                distilled_query="what does my brother like again",
                referent_type="person",
                referent_scope=["person"],
            )
        ],
        model="gemma4:e2b",
    )
    mock_decomposer = AsyncMock()
    mock_decomposer.decompose = AsyncMock(return_value=decomp)
    captured = {}
    mock_inference = AsyncMock()
    mock_inference.generate_stream = _capture_stream(captured)

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
        "what does my brother like again",
        user_id=uid,
        session_id=sid,
    ):
        pass

    prompt = captured["prompt"]
    assert "RELATIONAL_GRAPH:" in prompt
    assert "artie likes movies" in prompt.lower()
    assert "you likes coffee" not in prompt.lower()


@pytest.mark.anyio
async def test_older_session_recall_uses_episodic_memory_on_chat_path(memory):
    uid = await memory.get_or_create_user("default")
    old_sid = await memory.create_session(uid)
    await memory.add_message(
        user_id=uid,
        session_id=old_sid,
        role="user",
        content="Let's revisit the cabin trip packing list next weekend.",
    )
    sid = await memory.create_session(uid)

    decomp = DecompositionResult(
        overall_reasoning_complexity="fast",
        asks=[Ask(ask_id="ask_1", intent="direct_chat", distilled_query="what were we saying about the cabin trip")],
        model="gemma4:e2b",
    )
    mock_decomposer = AsyncMock()
    mock_decomposer.decompose = AsyncMock(return_value=decomp)
    captured = {}
    mock_inference = AsyncMock()
    mock_inference.generate_stream = _capture_stream(captured)

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
        "what were we saying about the cabin trip",
        user_id=uid,
        session_id=sid,
    ):
        pass

    prompt = captured["prompt"]
    assert "EPISODIC_THREADS:" in prompt
    assert "cabin trip packing list" in prompt.lower()


@pytest.mark.anyio
async def test_unrelated_turn_does_not_surface_irrelevant_names_on_chat_path(memory):
    uid = await memory.get_or_create_user("default")
    sid = await memory.create_session(uid)
    artie_id = await memory.create_person(uid, "Artie")
    await memory.add_relationship(uid, artie_id, "brother")
    await memory.upsert_fact(
        user_id=uid,
        subject="artie",
        subject_type="person",
        subject_ref_id=artie_id,
        predicate="likes",
        value="movies",
        category="preference",
    )

    decomp = DecompositionResult(
        overall_reasoning_complexity="fast",
        asks=[Ask(ask_id="ask_1", intent="direct_chat", distilled_query="tell me something fun about space")],
        model="gemma4:e2b",
    )
    mock_decomposer = AsyncMock()
    mock_decomposer.decompose = AsyncMock(return_value=decomp)
    captured = {}
    mock_inference = AsyncMock()
    mock_inference.generate_stream = _capture_stream(captured)

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
        "tell me something fun about space",
        user_id=uid,
        session_id=sid,
    ):
        pass

    prompt = captured["prompt"].lower()
    assert "artie" not in prompt
    assert "relational_graph:" not in prompt
