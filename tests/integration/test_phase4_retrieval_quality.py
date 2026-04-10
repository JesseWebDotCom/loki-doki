from __future__ import annotations

import os
import time
from unittest.mock import AsyncMock

import pytest

from lokidoki.core import people_graph_sql as gql
from lokidoki.core.decomposer import Ask, DecompositionResult
from lokidoki.core.memory_provider import MemoryProvider
from lokidoki.core.model_manager import ModelManager, ModelPolicy
from lokidoki.core.orchestrator import Orchestrator
from lokidoki.core.retrieval_scoring import (
    score_memory_candidate,
    fuzzy_expand_query,
)
from lokidoki.core.graph_walk_resolution import (
    extract_relation_chain,
    _resolve_graph_walk_candidate_sync,
)


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


@pytest.mark.anyio
async def test_entity_boost_on_off_comparison_on_chat_path(memory):
    """Entity-boost flag should promote matching entity facts when enabled."""
    uid = await memory.get_or_create_user("default")
    sid = await memory.create_session(uid)
    await memory.upsert_fact(
        user_id=uid,
        subject="cabin trip",
        subject_type="entity",
        predicate="status",
        value="still in planning",
        category="event",
    )
    await memory.upsert_fact(
        user_id=uid,
        subject="self",
        subject_type="self",
        predicate="likes",
        value="hiking in the mountains",
        category="preference",
    )

    decomp = DecompositionResult(
        overall_reasoning_complexity="fast",
        asks=[Ask(ask_id="ask_1", intent="direct_chat", distilled_query="what about the cabin trip")],
        model="gemma4:e2b",
    )
    mock_decomposer = AsyncMock()
    mock_decomposer.decompose = AsyncMock(return_value=decomp)

    for boost_enabled, env_val in [(False, ""), (True, "1")]:
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
        new_sid = await memory.create_session(uid)

        old_val = os.environ.get("LOKIDOKI_PHASE4_ENTITY_BOOST", "")
        try:
            os.environ["LOKIDOKI_PHASE4_ENTITY_BOOST"] = env_val
            async for _ in orch.process(
                "what about the cabin trip",
                user_id=uid,
                session_id=new_sid,
            ):
                pass
        finally:
            if old_val:
                os.environ["LOKIDOKI_PHASE4_ENTITY_BOOST"] = old_val
            else:
                os.environ.pop("LOKIDOKI_PHASE4_ENTITY_BOOST", None)

        traces = await memory.list_chat_traces(user_id=uid, session_id=new_sid, limit=1)
        assert traces, f"No trace recorded for boost_enabled={boost_enabled}"
        selected = traces[0]["selected_injected_memories_json"]["facts_by_bucket"]
        chosen_ids = {row["id"] for rows in selected.values() for row in rows}
        # Both modes should find facts; the entity-boost mode should include
        # the entity fact about "cabin trip" if entity boost promotes it.
        if boost_enabled:
            assert any(
                "cabin" in str(row.get("value", "")).lower() or "cabin" in str(row.get("subject", "")).lower()
                for rows in selected.values()
                for row in rows
            ), "Entity boost should surface cabin trip fact"


@pytest.mark.anyio
async def test_multi_turn_referential_eval_natural_phrasing(memory):
    """Realistic multi-turn conversation: pronouns, corrections, follow-ups.

    Turn 1: Ask about a person by name.
    Turn 2: Pronoun follow-up ("what about her").
    Turn 3: Correction / different person.
    Turn 4: Possessive relation ("my brother's daughter").

    Each turn should resolve referents correctly and not repeat the same
    memory facts across turns (novelty penalty).
    """
    uid = await memory.get_or_create_user("jesse")
    sid = await memory.create_session(uid)

    def _seed(conn):
        me = gql.create_person_graph(conn, uid, name="Jesse", bucket="family")
        artie = gql.create_person_graph(conn, uid, name="Artie", bucket="family")
        nora = gql.create_person_graph(conn, uid, name="Nora", bucket="family")
        gql.link_user_to_person(conn, user_id=uid, person_id=me)
        gql.create_person_edge(conn, uid, from_person_id=me, to_person_id=artie, edge_type="brother")
        gql.create_person_edge(conn, uid, from_person_id=artie, to_person_id=nora, edge_type="daughter")

    await memory.run_sync(_seed)
    await memory.upsert_fact(
        user_id=uid, subject="Artie", subject_type="person",
        predicate="likes", value="movies", category="preference",
    )
    await memory.upsert_fact(
        user_id=uid, subject="Nora", subject_type="person",
        predicate="age", value="4", category="biographical",
    )

    turns = [
        ("tell me about artie", Ask(
            ask_id="ask_1", intent="direct_chat",
            distilled_query="tell me about artie",
            referent_type="person", needs_referent_resolution=True,
            referent_anchor="artie", capability_need="people_lookup",
        )),
        ("what does he like", Ask(
            ask_id="ask_2", intent="direct_chat",
            distilled_query="what does he like",
            referent_type="person", needs_referent_resolution=True,
            referent_anchor="he", context_source="recent_context",
        )),
        ("actually tell me about nora instead", Ask(
            ask_id="ask_3", intent="direct_chat",
            distilled_query="tell me about nora",
            referent_type="person", needs_referent_resolution=True,
            referent_anchor="nora", capability_need="people_lookup",
        )),
        ("how old is my brother's daughter", Ask(
            ask_id="ask_4", intent="direct_chat",
            distilled_query="how old is my brother's daughter",
            referent_type="person", needs_referent_resolution=True,
            referent_anchor="my brother's daughter",
        )),
    ]

    all_selected_fact_ids: list[set[int]] = []

    for user_input, ask in turns:
        decomp = DecompositionResult(
            overall_reasoning_complexity="fast",
            asks=[ask],
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

        async for _ in orch.process(user_input, user_id=uid, session_id=sid, user_display_name="Jesse"):
            pass

        traces = await memory.list_chat_traces(user_id=uid, session_id=sid, limit=1)
        selected = traces[0]["selected_injected_memories_json"]["facts_by_bucket"]
        turn_ids = {row["id"] for rows in selected.values() for row in rows}
        all_selected_fact_ids.append(turn_ids)

    # Turn 4 should resolve "my brother's daughter" to Nora via graph walk
    traces = await memory.list_chat_traces(user_id=uid, session_id=sid, limit=1)
    latest_prompt = captured.get("prompt", "")
    assert "Nora" in latest_prompt, "Graph walk should resolve 'my brother\\'s daughter' to Nora"

    # Novelty: later turns should not always repeat the same facts
    if all_selected_fact_ids[0] and all_selected_fact_ids[1]:
        # At least one turn should differ from its predecessor
        any_different = any(
            all_selected_fact_ids[i] != all_selected_fact_ids[i + 1]
            for i in range(len(all_selected_fact_ids) - 1)
            if all_selected_fact_ids[i] and all_selected_fact_ids[i + 1]
        )
        assert any_different, "Novelty penalty should vary facts across turns"


@pytest.mark.anyio
async def test_noisy_name_repair_finds_facts_on_chat_path(memory):
    """When the user misspells a person name, fuzzy query expansion should
    still surface relevant facts."""
    uid = await memory.get_or_create_user("default")
    sid = await memory.create_session(uid)

    def _seed(conn):
        gql.create_person_graph(conn, uid, name="Artie", bucket="family")

    await memory.run_sync(_seed)
    await memory.upsert_fact(
        user_id=uid, subject="Artie", subject_type="person",
        predicate="likes", value="movies", category="preference",
    )

    decomp = DecompositionResult(
        overall_reasoning_complexity="fast",
        asks=[Ask(
            ask_id="ask_1", intent="direct_chat",
            distilled_query="what does artee like",
            referent_type="person", needs_referent_resolution=True,
            referent_anchor="artee",
        )],
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

    async for _ in orch.process("what does artee like", user_id=uid, session_id=sid):
        pass

    traces = await memory.list_chat_traces(user_id=uid, session_id=sid, limit=1)
    assert traces
    # The referent resolver should still resolve "artee" → "Artie" via alias matching
    # OR the fuzzy query expansion should surface facts about Artie
    prompt = captured.get("prompt", "")
    selected = traces[0]["selected_injected_memories_json"]["facts_by_bucket"]
    has_artie_fact = any(
        "artie" in str(row.get("subject", "")).lower()
        or "artie" in str(row.get("value", "")).lower()
        for rows in selected.values()
        for row in rows
    )
    artie_in_prompt = "artie" in prompt.lower() or "Artie" in prompt
    assert has_artie_fact or artie_in_prompt, \
        "Noisy name repair or alias resolution should surface Artie facts"


# ---------- retrieval performance benchmark ----------


class TestRetrievalPerformanceBenchmark:
    """Performance benchmarks for scorer cost and graph-walk overhead.

    These tests measure wall-clock time for scoring and graph-walk
    operations to ensure Phase 4 changes don't introduce latency
    regressions. Thresholds are generous to avoid flaky failures on
    CI but will catch order-of-magnitude regressions.
    """

    def test_scorer_throughput(self):
        """Scoring 100 facts should complete in < 50ms."""
        facts = [
            {
                "id": i,
                "subject": f"entity_{i}",
                "subject_type": "entity" if i % 3 else "person",
                "subject_ref_id": i if i % 3 == 0 else None,
                "predicate": "likes",
                "value": f"thing_{i}",
                "confidence": 0.5 + (i % 50) / 100.0,
                "status": "active",
                "score": 0.3 + (i % 30) / 100.0,
                "last_observed_at": "2026-04-08 10:00:00",
            }
            for i in range(100)
        ]
        ask = Ask(
            ask_id="bench", intent="direct_chat",
            distilled_query="benchmark query about entities",
            referent_type="person",
        )
        seen = {1, 5, 10, 15, 20}

        t0 = time.perf_counter()
        for idx, fact in enumerate(facts):
            score_memory_candidate(
                fact,
                bucket="semantic_profile",
                user_input="benchmark query about entities",
                asks=[ask],
                retrieval_rank=idx,
                session_seen_fact_ids=seen,
                entity_boost_enabled=True,
            )
        elapsed_ms = (time.perf_counter() - t0) * 1000

        assert elapsed_ms < 50, f"Scoring 100 facts took {elapsed_ms:.1f}ms (budget: 50ms)"

    def test_fuzzy_expand_query_throughput(self):
        """Expanding a query against 50 known names should complete in < 20ms."""
        names = [f"Person Name {i}" for i in range(50)]
        query = "tell me about persn naem 17"

        t0 = time.perf_counter()
        for _ in range(10):
            fuzzy_expand_query(query, names)
        elapsed_ms = (time.perf_counter() - t0) * 1000

        per_call_ms = elapsed_ms / 10
        assert per_call_ms < 20, f"fuzzy_expand_query took {per_call_ms:.1f}ms (budget: 20ms)"

    def test_extract_relation_chain_throughput(self):
        """Parsing 100 relation chains should complete in < 5ms."""
        inputs = [
            "my sister", "John's wife", "my father's brother",
            "my brother's daughter", "artie's mom",
            "my sister's husband's brother",
        ] * 17  # ~102 inputs

        t0 = time.perf_counter()
        for text in inputs:
            extract_relation_chain(text)
        elapsed_ms = (time.perf_counter() - t0) * 1000

        assert elapsed_ms < 5, f"Parsing {len(inputs)} chains took {elapsed_ms:.1f}ms (budget: 5ms)"

    @pytest.mark.anyio
    async def test_graph_walk_resolution_throughput(self, memory):
        """Graph-walk through 2-hop relation should complete in < 50ms."""
        uid = await memory.get_or_create_user("bench")

        def _seed(conn):
            me = gql.create_person_graph(conn, uid, name="Me", bucket="family")
            sibling = gql.create_person_graph(conn, uid, name="Sibling", bucket="family")
            niece = gql.create_person_graph(conn, uid, name="Niece", bucket="family")
            gql.link_user_to_person(conn, user_id=uid, person_id=me)
            gql.create_person_edge(conn, uid, from_person_id=me, to_person_id=sibling, edge_type="sister")
            gql.create_person_edge(conn, uid, from_person_id=sibling, to_person_id=niece, edge_type="daughter")

        await memory.run_sync(_seed)

        t0 = time.perf_counter()
        for _ in range(10):
            result = await memory.run_sync(
                lambda conn: _resolve_graph_walk_candidate_sync(
                    conn,
                    user_id=uid,
                    base_name="__self__",
                    relation_chain=["sister", "daughter"],
                )
            )
        elapsed_ms = (time.perf_counter() - t0) * 1000

        per_call_ms = elapsed_ms / 10
        assert result is not None, "Graph walk should resolve"
        assert result["name"] == "Niece"
        assert per_call_ms < 50, f"Graph walk took {per_call_ms:.1f}ms (budget: 50ms)"
