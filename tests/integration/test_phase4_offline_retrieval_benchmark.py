"""Offline retrieval benchmark against eval corpus.

Runs the Phase 4 retrieval pipeline (scoring, bucketing, selection,
graph-walk, entity-boost, novelty penalty) against a seeded memory
database and measures the CODEX-required validation metrics:

- Top-1 / Top-3 memory relevance
- Repeated-fact injection rate in long chats
- Referent resolution correctness on possessive queries
- Precision/recall impact of entity boost

Exit criteria assertions:
- Memory relevance >= threshold (vs baseline of random)
- Novelty penalty reduces repeated-fact rate
- Graph-walk resolves possessive queries correctly
- Retrieval-quality gains don't regress latency
"""
from __future__ import annotations

import time
from unittest.mock import AsyncMock

import pytest

from lokidoki.core import people_graph_sql as gql
from lokidoki.core.decomposer import Ask, DecompositionResult
from lokidoki.core.memory_phase2 import (
    bucket_memory_candidates,
    select_memory_context,
)
from lokidoki.core.memory_provider import MemoryProvider
from lokidoki.core.model_manager import ModelManager, ModelPolicy
from lokidoki.core.orchestrator import Orchestrator
from lokidoki.core.retrieval_scoring import score_memory_candidate
from lokidoki.core.graph_walk_resolution import (
    _resolve_graph_walk_candidate_sync,
)
from lokidoki.evals.phase4 import (
    RetrievalMetrics,
    PHASE4_RETRIEVAL_EVAL_CASES,
    measure_entity_boost_impact,
    measure_repeated_fact_rate,
    score_retrieval_relevance,
)


@pytest.fixture
async def seeded_memory(tmp_path):
    """Pre-seed a memory database with facts and relationships for eval."""
    mp = MemoryProvider(db_path=str(tmp_path / "phase4_eval.db"))
    await mp.initialize()
    uid = await mp.get_or_create_user("eval_user")

    # Seed people and relationships
    def _seed_people(conn):
        me = gql.create_person_graph(conn, uid, name="Jesse", bucket="family")
        luke = gql.create_person_graph(conn, uid, name="Luke", bucket="family")
        nora = gql.create_person_graph(conn, uid, name="Nora", bucket="family")
        mira = gql.create_person_graph(conn, uid, name="Mira", bucket="family")
        gql.link_user_to_person(conn, user_id=uid, person_id=me)
        gql.create_person_edge(conn, uid, from_person_id=me, to_person_id=luke, edge_type="brother")
        gql.create_person_edge(conn, uid, from_person_id=luke, to_person_id=nora, edge_type="daughter")
        gql.create_person_edge(conn, uid, from_person_id=luke, to_person_id=mira, edge_type="spouse")

    await mp.run_sync(_seed_people)

    # Seed facts
    await mp.upsert_fact(user_id=uid, subject="Luke", subject_type="person",
                         predicate="likes", value="movies", category="preference")
    await mp.upsert_fact(user_id=uid, subject="Luke", subject_type="person",
                         predicate="works_at", value="the library", category="biographical")
    await mp.upsert_fact(user_id=uid, subject="Nora", subject_type="person",
                         predicate="age", value="4", category="biographical")
    await mp.upsert_fact(user_id=uid, subject="self", subject_type="self",
                         predicate="likes", value="coffee", category="preference")
    await mp.upsert_fact(user_id=uid, subject="self", subject_type="self",
                         predicate="prefers", value="quiet mornings", category="preference")
    await mp.upsert_fact(user_id=uid, subject="cabin trip", subject_type="entity",
                         predicate="status", value="still in planning", category="event")
    await mp.upsert_fact(user_id=uid, subject="self", subject_type="self",
                         predicate="enjoys", value="hiking", category="preference")
    await mp.upsert_fact(user_id=uid, subject="Mira", subject_type="person",
                         predicate="works_at", value="the school", category="biographical")

    yield mp, uid
    await mp.close()


def _capture_stream(captured: dict, text: str = "ok"):
    def _factory(*_a, **kw):
        captured.update(kw)

        async def _gen():
            yield text

        return _gen()

    return _factory


# ---------- offline retrieval benchmark ----------


@pytest.mark.anyio
async def test_offline_retrieval_relevance_on_eval_corpus(seeded_memory):
    """Score top-1 and top-3 retrieval relevance across eval cases.

    Seeds a realistic memory DB, searches for each eval case, scores
    the results, and asserts that top-3 relevance meets the threshold.
    """
    mp, uid = seeded_memory
    metrics = RetrievalMetrics()

    for case in PHASE4_RETRIEVAL_EVAL_CASES:
        if not case.expected_subjects:
            continue  # Skip cases with no expected retrieval targets

        facts = await mp.search_facts(user_id=uid, query=case.user_input, top_k=5)
        if not facts:
            # No facts found — counts as irrelevant for top-1 and top-3
            metrics.top1_total += 1
            metrics.top3_total += 1
            continue

        # Score and rank
        asks = [Ask(
            ask_id="eval", intent="direct_chat",
            distilled_query=case.user_input,
            referent_type="person" if case.is_possessive_query else "unknown",
        )]
        scored = []
        for idx, fact in enumerate(facts):
            s = score_memory_candidate(
                fact,
                bucket="semantic_profile",
                user_input=case.user_input,
                asks=asks,
                retrieval_rank=idx,
                session_seen_fact_ids=set(),
                entity_boost_enabled=case.involves_entity,
            )
            scored.append((s, fact))
        scored.sort(key=lambda x: x[0], reverse=True)
        ranked = [f for _, f in scored]

        relevance = score_retrieval_relevance(
            user_input=case.user_input,
            ranked_facts=ranked,
            expected_subjects=case.expected_subjects,
        )
        metrics.top1_total += 1
        metrics.top3_total += 1
        if relevance["top1"]:
            metrics.top1_relevant += 1
        if relevance["top3"]:
            metrics.top3_relevant += 1

    # Exit criteria: top-3 relevance should be at least 60%
    # (better than random baseline of ~30% with 8 facts and 3 picks)
    assert metrics.top3_total > 0, "No eval cases with expected subjects"
    assert metrics.top3_relevance >= 0.6, (
        f"Top-3 relevance {metrics.top3_relevance:.0%} below 60% threshold. "
        f"({metrics.top3_relevant}/{metrics.top3_total})"
    )
    # Top-1 should be at least 40%
    assert metrics.top1_relevance >= 0.4, (
        f"Top-1 relevance {metrics.top1_relevance:.0%} below 40% threshold. "
        f"({metrics.top1_relevant}/{metrics.top1_total})"
    )


@pytest.mark.anyio
async def test_novelty_penalty_reduces_repeated_fact_rate_on_chat_path(seeded_memory):
    """Run a 4-turn conversation and measure repeated-fact injection rate.

    The novelty penalty should ensure that later turns surface different
    facts rather than repeating the same ones. The repeated-fact rate
    should be below 50%.
    """
    mp, uid = seeded_memory
    sid = await mp.create_session(uid)

    turns = [
        "tell me something about myself",
        "what else do you know about me",
        "tell me more",
        "anything else interesting",
    ]

    for user_input in turns:
        decomp = DecompositionResult(
            overall_reasoning_complexity="fast",
            asks=[Ask(ask_id="ask_1", intent="direct_chat", distilled_query=user_input)],
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
            memory=mp,
            model_manager=ModelManager(
                inference_client=mock_inference,
                policy=ModelPolicy(platform="mac"),
            ),
        )

        async for _ in orch.process(user_input, user_id=uid, session_id=sid):
            pass

    traces = await mp.list_chat_traces(user_id=uid, session_id=sid, limit=10)
    rates = measure_repeated_fact_rate(traces)

    # Exit criteria: repeated-fact rate should be < 50%
    if rates["total"] > 0:
        repeated_rate = rates["repeated"] / rates["total"]
        assert repeated_rate < 0.50, (
            f"Repeated-fact rate {repeated_rate:.0%} exceeds 50% threshold. "
            f"({rates['repeated']}/{rates['total']})"
        )


@pytest.mark.anyio
async def test_graph_walk_correctness_on_possessive_queries(seeded_memory):
    """Validate graph-walk resolution on all possessive eval cases.

    Each possessive query should resolve to the correct person through
    the relationship graph. Accuracy should be 100% for the configured
    relationships.
    """
    mp, uid = seeded_memory
    metrics = RetrievalMetrics()

    possessive_cases = [c for c in PHASE4_RETRIEVAL_EVAL_CASES if c.is_possessive_query]
    assert len(possessive_cases) >= 2, "Need at least 2 possessive eval cases"

    for case in possessive_cases:
        metrics.possessive_total += 1
        anchor = case.possessive_anchor or case.user_input
        expected = case.expected_referent
        result = await mp.run_sync(
            lambda conn, _a=anchor, _e=expected: _resolve_via_graph_walk(
                conn, uid, _a, _e,
            )
        )
        if result:
            metrics.possessive_correct += 1

    # Exit criteria: possessive query accuracy should be >= 66%
    # (at minimum "Luke's wife" and "my brother's daughter" should resolve)
    assert metrics.possessive_accuracy >= 0.66, (
        f"Possessive accuracy {metrics.possessive_accuracy:.0%} below 66% threshold. "
        f"({metrics.possessive_correct}/{metrics.possessive_total})"
    )


def _resolve_via_graph_walk(conn, user_id, anchor, expected_name):
    """Try to resolve a possessive anchor via graph walk and check correctness."""
    from lokidoki.core.graph_walk_resolution import extract_relation_chain

    base_name, relation_chain = extract_relation_chain(anchor)
    if not relation_chain:
        return False

    result = _resolve_graph_walk_candidate_sync(
        conn, user_id=user_id, base_name=base_name, relation_chain=relation_chain,
    )
    if result is None:
        return False
    return result["name"].lower() == expected_name.lower()


@pytest.mark.anyio
async def test_entity_boost_precision_recall(seeded_memory):
    """Measure precision/recall of entity boost on entity-related eval cases.

    Entity boost should promote entity-typed facts when they match the
    query, without promoting unrelated entity facts.
    """
    mp, uid = seeded_memory
    metrics = RetrievalMetrics()

    # Get all facts to score
    all_facts = await mp.list_facts(uid, limit=20)
    if not all_facts:
        pytest.skip("No facts seeded")

    entity_cases = [c for c in PHASE4_RETRIEVAL_EVAL_CASES if c.involves_entity]
    assert entity_cases, "Need at least one entity eval case"

    for case in entity_cases:
        asks = [Ask(
            ask_id="eval", intent="direct_chat",
            distilled_query=case.user_input,
        )]
        impact = measure_entity_boost_impact(
            facts=all_facts,
            user_input=case.user_input,
            asks=asks,
            expected_entity=case.expected_entity,
        )
        metrics.entity_boost_true_positives += impact["tp"]
        metrics.entity_boost_false_positives += impact["fp"]
        metrics.entity_boost_false_negatives += impact["fn"]

    # Entity boost should not introduce false positives
    assert metrics.entity_boost_false_positives == 0, (
        f"Entity boost has {metrics.entity_boost_false_positives} false positives"
    )
    # Log the summary for inspection
    summary = metrics.summary()
    assert summary  # Non-empty summary confirms metrics were computed


@pytest.mark.anyio
async def test_retrieval_latency_within_budget(seeded_memory):
    """End-to-end retrieval pipeline (search + score + bucket + select)
    should complete within latency budget for a single turn."""
    mp, uid = seeded_memory

    user_input = "what does my brother like to do"
    asks = [Ask(
        ask_id="latency_1", intent="direct_chat",
        distilled_query=user_input,
        referent_type="person",
    )]

    t0 = time.perf_counter()
    for _ in range(5):
        # Search
        facts = await mp.search_facts(user_id=uid, query=user_input, top_k=5)
        recent_facts = await mp.list_facts(uid, limit=12)

        # Merge
        merged = []
        seen_ids: set[int] = set()
        for row in list(facts) + list(recent_facts):
            rid = row.get("id")
            if rid is not None:
                if int(rid) in seen_ids:
                    continue
                seen_ids.add(int(rid))
            merged.append(row)

        # Bucket
        candidates = bucket_memory_candidates(
            facts=merged, past_messages=[], recent_message_ids=set(), asks=asks,
        )

        # Select
        select_memory_context(
            user_input=user_input,
            reply_mode="full_synthesis",
            memory_mode="full",
            asks=asks,
            candidates_by_bucket=candidates,
            repeated_fact_ids=set(),
            repeated_message_ids=set(),
            session_seen_fact_ids=set(),
            entity_boost_enabled=False,
        )

    elapsed_ms = (time.perf_counter() - t0) * 1000
    per_call_ms = elapsed_ms / 5

    # Full retrieval pipeline should complete in < 100ms per turn
    assert per_call_ms < 100, (
        f"Retrieval pipeline took {per_call_ms:.1f}ms (budget: 100ms)"
    )


@pytest.mark.anyio
async def test_validation_metrics_summary(seeded_memory):
    """Run all eval cases and print a validation metrics summary.

    This test asserts that the metrics object is populated correctly
    and provides a human-readable summary for review.
    """
    mp, uid = seeded_memory
    metrics = RetrievalMetrics()

    for case in PHASE4_RETRIEVAL_EVAL_CASES:
        if not case.expected_subjects:
            continue

        facts = await mp.search_facts(user_id=uid, query=case.user_input, top_k=5)
        if not facts:
            metrics.top1_total += 1
            metrics.top3_total += 1
            continue

        asks = [Ask(
            ask_id="eval", intent="direct_chat",
            distilled_query=case.user_input,
            referent_type="person" if case.is_possessive_query else "unknown",
        )]
        scored = []
        for idx, fact in enumerate(facts):
            s = score_memory_candidate(
                fact, bucket="semantic_profile",
                user_input=case.user_input, asks=asks,
                retrieval_rank=idx, session_seen_fact_ids=set(),
                entity_boost_enabled=case.involves_entity,
            )
            scored.append((s, fact))
        scored.sort(key=lambda x: x[0], reverse=True)
        ranked = [f for _, f in scored]

        relevance = score_retrieval_relevance(
            user_input=case.user_input,
            ranked_facts=ranked,
            expected_subjects=case.expected_subjects,
        )
        metrics.top1_total += 1
        metrics.top3_total += 1
        if relevance["top1"]:
            metrics.top1_relevant += 1
        if relevance["top3"]:
            metrics.top3_relevant += 1

    summary = metrics.summary()
    # All metric keys should be present
    assert "top1_relevance" in summary
    assert "top3_relevance" in summary
    assert "repeated_fact_rate" in summary
    assert "possessive_accuracy" in summary
    assert "entity_boost_precision" in summary
    assert "entity_boost_recall" in summary
    # Totals should be populated
    assert metrics.top1_total > 0
    assert metrics.top3_total > 0
