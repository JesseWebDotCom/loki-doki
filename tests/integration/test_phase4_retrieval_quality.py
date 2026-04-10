from __future__ import annotations

from unittest.mock import AsyncMock

import pytest

from lokidoki.core import people_graph_sql as gql
from lokidoki.core.decomposer import Ask, DecompositionResult
from lokidoki.core.memory_provider import MemoryProvider
from lokidoki.core.model_manager import ModelManager, ModelPolicy
from lokidoki.core.orchestrator import Orchestrator


@pytest.fixture
async def memory(tmp_path):
    mp = MemoryProvider(db_path=str(tmp_path / "phase4_retrieval_quality.db"))
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
async def test_long_conversation_applies_session_seen_novelty_penalty_on_chat_path(memory):
    uid = await memory.get_or_create_user("default")
    sid = await memory.create_session(uid)
    await memory.upsert_fact(
        user_id=uid,
        subject="self",
        subject_type="self",
        predicate="likes",
        value="coffee",
        category="preference",
    )
    await memory.upsert_fact(
        user_id=uid,
        subject="self",
        subject_type="self",
        predicate="likes",
        value="tea",
        category="preference",
    )
    await memory.upsert_fact(
        user_id=uid,
        subject="self",
        subject_type="self",
        predicate="likes",
        value="cocoa",
        category="preference",
    )

    decomp = DecompositionResult(
        overall_reasoning_complexity="fast",
        long_term_memory=[
            {
                "subject_type": "self",
                "predicate": "mentioned",
                "value": "self profile followup",
                "kind": "fact",
                "category": "preference",
            }
        ],
        asks=[Ask(ask_id="ask_1", intent="direct_chat", distilled_query="tell me something about me")],
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

    async for _ in orch.process("tell me something about me", user_id=uid, session_id=sid):
        pass
    async for _ in orch.process("tell me something else about me", user_id=uid, session_id=sid):
        pass

    traces = await memory.list_chat_traces(user_id=uid, session_id=sid, limit=2)
    latest = traces[0]["selected_injected_memories_json"]["facts_by_bucket"]
    prior = traces[1]["selected_injected_memories_json"]["facts_by_bucket"]
    latest_ids = {row["id"] for rows in latest.values() for row in rows}
    prior_ids = {row["id"] for rows in prior.values() for row in rows}

    assert prior_ids
    assert latest_ids
    assert latest_ids != prior_ids


@pytest.mark.anyio
async def test_possessive_relation_query_uses_graph_walk_on_chat_path(memory):
    uid = await memory.get_or_create_user("jesse")
    sid = await memory.create_session(uid)

    def _seed(conn):
        me = gql.create_person_graph(conn, uid, name="Jesse", bucket="family")
        artie = gql.create_person_graph(conn, uid, name="Artie", bucket="family")
        nora = gql.create_person_graph(conn, uid, name="Nora", bucket="family")
        gql.link_user_to_person(conn, user_id=uid, person_id=me)
        gql.create_person_edge(
            conn,
            uid,
            from_person_id=me,
            to_person_id=artie,
            edge_type="brother",
        )
        gql.create_person_edge(
            conn,
            uid,
            from_person_id=artie,
            to_person_id=nora,
            edge_type="daughter",
        )

    await memory.run_sync(_seed)

    decomp = DecompositionResult(
        overall_reasoning_complexity="fast",
        asks=[
            Ask(
                ask_id="ask_1",
                intent="direct_chat",
                distilled_query="how is my brother's daughter doing",
                referent_type="person",
                needs_referent_resolution=True,
                referent_anchor="my brother's daughter",
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
        "how is my brother's daughter doing",
        user_id=uid,
        session_id=sid,
        user_display_name="Jesse",
    ):
        pass

    assert "Nora" in captured["prompt"]
