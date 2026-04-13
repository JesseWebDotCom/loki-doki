"""
M2.5 phase-gate tests for the v2 memory subsystem.

M2.5 adds embeddings as a third Reciprocal Rank Fusion source for the
Tier 4 read path so vocabulary mismatches that BM25 + the structured
subject scan can't bridge ("what do I eat" → "dietary restriction
vegetarian") still recall the right fact.

Each test corresponds to a deliverable from M2.5:

    1. facts.embedding column populated on write_semantic_fact insert
    2. Embedding helper uses the existing v2 routing embedding backend
    3. _vector_search returns cosine-similarity hits over active facts
    4. read_user_facts fuses BM25 + subject + vector via RRF
    5. Vector source can recall facts BM25 alone misses
    6. Cross-user isolation in the vector path
    7. Empty/missing query falls back gracefully
    8. The vector source is opt-in: never crashes the read path
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from lokidoki.orchestrator.memory.candidate import MemoryCandidate
from lokidoki.orchestrator.memory.reader import (
    VECTOR_SIM_FLOOR,
    _embed_query,
    _vector_search,
    read_user_facts,
)
from lokidoki.orchestrator.memory.store import (
    MemoryStore,
    compute_fact_embedding,
)


@pytest.fixture()
def store(tmp_path: Path) -> MemoryStore:
    s = MemoryStore(tmp_path / "v2_memory_m25.sqlite")
    yield s
    s.close()


# ----- Deliverable 1: facts.embedding column populated -----------------


def test_m25_embedding_column_exists(store: MemoryStore) -> None:
    cols = store._conn.execute("PRAGMA table_info(facts)").fetchall()
    column_names = {row[1] for row in cols}
    assert "embedding" in column_names


def test_m25_embedding_populated_on_insert(store: MemoryStore) -> None:
    store.write_semantic_fact(
        MemoryCandidate(
            subject="self",
            predicate="favorite_color",
            value="blue",
            source_text="my favorite color is blue",
            owner_user_id=1,
        )
    )
    rows = store._conn.execute(
        "SELECT id, embedding FROM facts WHERE owner_user_id = 1"
    ).fetchall()
    assert len(rows) == 1
    embedding = rows[0]["embedding"]
    assert embedding is not None
    parsed = json.loads(embedding)
    assert isinstance(parsed, list)
    assert len(parsed) > 0
    assert all(isinstance(x, (int, float)) for x in parsed)


def test_m25_compute_fact_embedding_returns_json_or_none() -> None:
    candidate = MemoryCandidate(
        subject="self",
        predicate="lives_in",
        value="Portland",
        source_text="I live in Portland",
        owner_user_id=1,
    )
    embedding = compute_fact_embedding(candidate)
    assert embedding is not None
    parsed = json.loads(embedding)
    assert isinstance(parsed, list)


def test_m25_compute_fact_embedding_humanizes_predicate() -> None:
    """The embedding text should bridge user vocabulary by humanizing
    the predicate (lives_in -> lives in). The output is a vector, but
    we can verify the helper doesn't crash on snake-case predicates."""
    candidate = MemoryCandidate(
        subject="self",
        predicate="has_dietary_restriction",
        value="vegan",
        source_text="vegan",
        owner_user_id=1,
    )
    embedding = compute_fact_embedding(candidate)
    assert embedding is not None


# ----- Deliverable 2+3: vector_search returns cosine hits --------------


def test_m25_embed_query_returns_vector() -> None:
    vec = _embed_query("favorite color")
    assert vec is not None
    assert len(vec) > 0


def test_m25_embed_query_handles_empty() -> None:
    assert _embed_query("") is None
    assert _embed_query("   ") is None


def test_m25_vector_search_returns_relevant_hits(store: MemoryStore) -> None:
    store.write_semantic_fact(
        MemoryCandidate(
            subject="self",
            predicate="has_dietary_restriction",
            value="vegetarian",
            source_text="vegetarian now",
            owner_user_id=1,
        )
    )
    hits = _vector_search(store, 1, "what do I eat", limit=10)
    assert len(hits) >= 1
    fact_id, score = hits[0]
    assert score >= VECTOR_SIM_FLOOR


def test_m25_vector_search_returns_empty_for_no_data(store: MemoryStore) -> None:
    hits = _vector_search(store, 999, "anything", limit=10)
    assert hits == []


def test_m25_vector_search_handles_empty_query(store: MemoryStore) -> None:
    store.write_semantic_fact(
        MemoryCandidate(
            subject="self",
            predicate="favorite_color",
            value="blue",
            source_text="my favorite color is blue",
            owner_user_id=1,
        )
    )
    assert _vector_search(store, 1, "", limit=10) == []


# ----- Deliverable 4+5: RRF fuses three sources, vec bridges vocab ----


def test_m25_read_user_facts_uses_three_rrf_sources(store: MemoryStore) -> None:
    """A direct query that all three sources can answer should produce
    a hit whose `sources` tuple includes both 'bm25' and 'vector'."""
    store.write_semantic_fact(
        MemoryCandidate(
            subject="self",
            predicate="favorite_color",
            value="blue",
            source_text="my favorite color is blue",
            owner_user_id=1,
        )
    )
    hits = read_user_facts(store, 1, "favorite color", top_k=3)
    assert len(hits) == 1
    assert "bm25" in hits[0].sources
    assert "vector" in hits[0].sources


def test_m25_vector_source_bridges_vocabulary_mismatch(store: MemoryStore) -> None:
    """The case M2 alone couldn't handle: the user asks 'what do I eat'
    against a stored fact 'has_dietary_restriction=vegetarian'. BM25
    misses entirely (no token overlap with the predicate or value),
    but the vector source bridges the semantic gap."""
    store.write_semantic_fact(
        MemoryCandidate(
            subject="self",
            predicate="has_dietary_restriction",
            value="vegetarian",
            source_text="vegetarian now",
            owner_user_id=1,
        )
    )
    hits = read_user_facts(store, 1, "what do I eat", top_k=3)
    assert len(hits) >= 1
    assert hits[0].predicate == "has_dietary_restriction"
    assert hits[0].value.lower() == "vegetarian"
    # The hit must have come from the vector source (BM25 misses).
    assert "vector" in hits[0].sources


def test_m25_recall_corpus_bridges_dietary_query(tmp_path: Path) -> None:
    """The M2 corpus case that was originally a vocabulary stretch is
    now solvable end-to-end thanks to the vector source. We rerun the
    case here against a fresh store using the original problematic
    query phrasing."""
    store = MemoryStore(tmp_path / "m25_corpus_bridge.sqlite")
    try:
        store.write_semantic_fact(
            MemoryCandidate(
                subject="self",
                predicate="has_dietary_restriction",
                value="vegetarian",
                source_text="vegetarian now",
                owner_user_id=27,
            )
        )
        # Query is the *original* M2-stretching phrasing.
        hits = read_user_facts(store, 27, "what do I eat", top_k=3)
        assert len(hits) >= 1
        assert hits[0].predicate == "has_dietary_restriction"
    finally:
        store.close()


# ----- Deliverable 6: cross-user isolation in vector path -------------


def test_m25_vector_search_cross_user_isolation(store: MemoryStore) -> None:
    store.write_semantic_fact(
        MemoryCandidate(
            subject="self",
            predicate="favorite_food",
            value="sushi",
            source_text="I love sushi",
            owner_user_id=42,
        )
    )
    store.write_semantic_fact(
        MemoryCandidate(
            subject="self",
            predicate="favorite_food",
            value="ramen",
            source_text="I love ramen",
            owner_user_id=99,
        )
    )
    hits_42 = _vector_search(store, 42, "Japanese food", limit=10)
    hits_99 = _vector_search(store, 99, "Japanese food", limit=10)
    facts_42 = {row["id"] for row in store._conn.execute(
        "SELECT id FROM facts WHERE owner_user_id = 42"
    ).fetchall()}
    facts_99 = {row["id"] for row in store._conn.execute(
        "SELECT id FROM facts WHERE owner_user_id = 99"
    ).fetchall()}
    for fact_id, _ in hits_42:
        assert fact_id in facts_42
    for fact_id, _ in hits_99:
        assert fact_id in facts_99


# ----- Deliverable 7+8: graceful fallback when backend fails -----------


def test_m25_vector_search_handles_corrupt_embedding(
    store: MemoryStore, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A row with a malformed embedding JSON should be silently skipped."""
    store.write_semantic_fact(
        MemoryCandidate(
            subject="self",
            predicate="favorite_color",
            value="blue",
            source_text="blue",
            owner_user_id=1,
        )
    )
    store._conn.execute("UPDATE facts SET embedding = 'not-json' WHERE owner_user_id = 1")
    # Should not raise.
    hits = _vector_search(store, 1, "blue color", limit=10)
    assert hits == []


def test_m25_read_user_facts_still_works_when_embedding_missing(
    store: MemoryStore,
) -> None:
    """A row with NULL embedding should still be findable via BM25."""
    store.write_semantic_fact(
        MemoryCandidate(
            subject="self",
            predicate="favorite_color",
            value="blue",
            source_text="my favorite color is blue",
            owner_user_id=1,
        )
    )
    store._conn.execute("UPDATE facts SET embedding = NULL WHERE owner_user_id = 1")
    hits = read_user_facts(store, 1, "favorite color", top_k=3)
    assert len(hits) == 1
    # BM25 should be the only source.
    assert "bm25" in hits[0].sources
    assert "vector" not in hits[0].sources


def test_m25_pipeline_end_to_end_vocab_bridge(tmp_path: Path) -> None:
    """End-to-end through the dev pipeline: write a dietary restriction
    on turn 1, recall via the vocabulary-mismatching query on turn 2."""
    from lokidoki.orchestrator.core.pipeline import run_pipeline

    test_store = MemoryStore(tmp_path / "m25_e2e.sqlite")
    try:
        # Turn 1 — write via M1.
        run_pipeline(
            "I'm allergic to peanuts",
            context={
                "memory_writes_enabled": True,
                "memory_store": test_store,
                "owner_user_id": 5,
            },
        )
        # Turn 2 — recall with a paraphrase that BM25 alone would miss.
        result = run_pipeline(
            "what foods should I avoid",
            context={
                "memory_store": test_store,
                "owner_user_id": 5,
                "need_preference": True,
            },
        )
        slots = (result.request_spec.context or {}).get("memory_slots") or {}
        assert "peanuts" in slots.get("user_facts", "").lower()
    finally:
        test_store.close()
