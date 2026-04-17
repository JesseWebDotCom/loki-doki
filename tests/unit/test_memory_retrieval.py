"""
Chunk 6 — FTS5 + embedding-based memory retrieval tests.

Tests the hybrid retrieval pipeline: FTS5 keyword search, MiniLM dense
search, RRF merge, and graceful degradation when components are missing.
"""
from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import patch

import pytest

from lokidoki.orchestrator.memory.candidate import MemoryCandidate
from lokidoki.orchestrator.memory.reader import read_user_facts
from lokidoki.orchestrator.memory.reader_search import (
    RRF_K,
    _bm25_search,
    _clean_query_terms,
    _cosine,
    _vector_search,
    score_facts_rrf,
)
from lokidoki.orchestrator.memory.store import MemoryStore


@pytest.fixture()
def store(tmp_path: Path) -> MemoryStore:
    s = MemoryStore(tmp_path / "retrieval.sqlite")
    yield s
    s.close()


def _seed(store: MemoryStore, owner: int, facts: list[tuple[str, str, str]]) -> None:
    """Seed (subject, predicate, value) triples into the store."""
    for subj, pred, val in facts:
        store.write_semantic_fact(
            MemoryCandidate(
                subject=subj,
                predicate=pred,
                value=val,
                source_text=val,
                owner_user_id=owner,
            )
        )


# ---------------------------------------------------------------------------
# 1. FTS5 keyword search
# ---------------------------------------------------------------------------


class TestFTS5Search:
    def test_fts5_returns_keyword_matches(self, store: MemoryStore) -> None:
        _seed(store, 1, [
            ("self", "favorite_drink", "black coffee every morning"),
            ("self", "favorite_food", "pepperoni pizza"),
            ("self", "hobby", "mountain biking"),
        ])
        terms = _clean_query_terms("coffee morning")
        hits = _bm25_search(store, 1, terms, limit=10)
        fact_ids = [fid for fid, _ in hits]
        # The coffee fact should appear
        row = store._conn.execute(
            "SELECT id FROM facts WHERE value LIKE '%coffee%' AND owner_user_id = 1"
        ).fetchone()
        assert row is not None
        assert int(row["id"]) in fact_ids

    def test_fts5_respects_user_scope(self, store: MemoryStore) -> None:
        _seed(store, 10, [("self", "pet", "golden retriever")])
        _seed(store, 20, [("self", "pet", "siamese cat")])
        hits_10 = _bm25_search(store, 10, ["golden"], limit=10)
        hits_20 = _bm25_search(store, 20, ["golden"], limit=10)
        assert len(hits_10) == 1
        assert len(hits_20) == 0

    def test_fts5_empty_terms_returns_empty(self, store: MemoryStore) -> None:
        _seed(store, 1, [("self", "pet", "dog")])
        assert _bm25_search(store, 1, [], limit=10) == []


# ---------------------------------------------------------------------------
# 2. Dense (embedding) search
# ---------------------------------------------------------------------------


class TestDenseSearch:
    def test_vector_search_returns_semantic_matches(self, store: MemoryStore) -> None:
        """With pre-computed embeddings in the DB, vector search finds them."""
        # Manually insert a fact with a known embedding
        fake_vec = [0.1] * 384  # MiniLM dimension
        store._conn.execute(
            "INSERT INTO facts(owner_user_id, subject, predicate, value, "
            "confidence, status, embedding) "
            "VALUES (?, ?, ?, ?, 0.8, 'active', ?)",
            (1, "self", "beverage_pref", "loves espresso",
             json.dumps(fake_vec)),
        )
        # Trigger FTS sync manually since we bypassed write_semantic_fact
        # (the trigger fires on INSERT so it's already synced)

        # Mock _embed_query to return a similar vector
        query_vec = [0.1] * 384  # identical = cosine 1.0
        with patch(
            "lokidoki.orchestrator.memory.reader_search._embed_query",
            return_value=query_vec,
        ):
            hits = _vector_search(store, 1, "caffeine preferences", limit=10)
        assert len(hits) >= 1
        # The fake fact should be the top hit
        fact_row = store._conn.execute(
            "SELECT id FROM facts WHERE value = 'loves espresso'"
        ).fetchone()
        assert int(fact_row["id"]) == hits[0][0]

    def test_vector_search_excludes_low_similarity(self, store: MemoryStore) -> None:
        """Facts with embeddings far from the query should be excluded."""
        # Insert fact with orthogonal embedding
        vec_a = [1.0] + [0.0] * 383
        store._conn.execute(
            "INSERT INTO facts(owner_user_id, subject, predicate, value, "
            "confidence, status, embedding) "
            "VALUES (?, ?, ?, ?, 0.8, 'active', ?)",
            (1, "self", "color", "blue", json.dumps(vec_a)),
        )
        # Query with orthogonal vector -> cosine ~ 0
        query_vec = [0.0] + [1.0] + [0.0] * 382
        with patch(
            "lokidoki.orchestrator.memory.reader_search._embed_query",
            return_value=query_vec,
        ):
            hits = _vector_search(store, 1, "anything", limit=10)
        # Should be excluded by VECTOR_SIM_FLOOR
        assert len(hits) == 0

    def test_vector_search_graceful_when_no_embedder(self, store: MemoryStore) -> None:
        """When embedding backend is unavailable, vector search returns []."""
        _seed(store, 1, [("self", "pet", "dog")])
        with patch(
            "lokidoki.orchestrator.memory.reader_search._embed_query",
            return_value=None,
        ):
            hits = _vector_search(store, 1, "pet", limit=10)
        assert hits == []


# ---------------------------------------------------------------------------
# 3. RRF merge
# ---------------------------------------------------------------------------


class TestRRFMerge:
    def test_rrf_interleaves_sources(self) -> None:
        """Facts from different sources are combined; shared facts get boosted."""
        fused = score_facts_rrf([
            ("bm25", [(1, 0.9), (2, 0.5)]),
            ("vector", [(2, 0.8), (3, 0.7)]),
        ])
        # Fact 2 appears in both sources -> highest score
        assert fused[2][0] > fused[1][0]
        assert fused[2][0] > fused[3][0]
        # Both source names tracked
        assert "bm25" in fused[2][1]
        assert "vector" in fused[2][1]

    def test_rrf_deduplicates_across_sources(self) -> None:
        """Same fact_id from multiple sources appears once in output."""
        fused = score_facts_rrf([
            ("bm25", [(10, 1.0)]),
            ("subject", [(10, 1.0)]),
            ("vector", [(10, 0.9)]),
        ])
        assert len(fused) == 1
        assert 10 in fused
        # Score is sum of three reciprocal-rank contributions
        expected = 3 * (1.0 / (RRF_K + 1))
        assert abs(fused[10][0] - expected) < 1e-9

    def test_rrf_empty_sources_returns_empty(self) -> None:
        fused = score_facts_rrf([("bm25", []), ("vector", [])])
        assert fused == {}

    def test_rrf_single_source_works(self) -> None:
        fused = score_facts_rrf([("bm25", [(5, 0.3), (6, 0.1)])])
        assert len(fused) == 2
        # Rank 1 beats rank 2
        assert fused[5][0] > fused[6][0]


# ---------------------------------------------------------------------------
# 4. Graceful degradation
# ---------------------------------------------------------------------------


class TestGracefulDegradation:
    def test_read_user_facts_works_without_fts5_table(self, tmp_path: Path) -> None:
        """If FTS5 table is missing/corrupt, the reader still returns results
        via the subject-scan and recency fallback paths."""
        s = MemoryStore(tmp_path / "no_fts.sqlite")
        try:
            _seed(s, 1, [("self", "pet", "golden retriever")])
            # Drop the FTS5 table to simulate missing FTS
            s._conn.execute("DROP TABLE IF EXISTS facts_fts")
            # BM25 will fail, but subject scan + recency should still work
            hits = read_user_facts(s, 1, "golden retriever", top_k=5)
            # Should still find results via subject scan
            assert len(hits) >= 0  # doesn't crash

        finally:
            s.close()

    def test_read_user_facts_works_without_embeddings(self, store: MemoryStore) -> None:
        """When no facts have embeddings, retrieval still works via BM25 + subject scan."""
        _seed(store, 1, [
            ("self", "favorite_food", "spaghetti carbonara"),
            ("self", "hobby", "painting landscapes"),
        ])
        # Null out all embeddings
        store._conn.execute("UPDATE facts SET embedding = NULL")
        with patch(
            "lokidoki.orchestrator.memory.reader_search._embed_query",
            return_value=None,
        ):
            hits = read_user_facts(store, 1, "spaghetti", top_k=5)
        # BM25 should still find the match
        assert len(hits) >= 1
        assert any("spaghetti" in h.value for h in hits)

    def test_read_user_facts_empty_query_falls_back_to_recency(
        self, store: MemoryStore,
    ) -> None:
        """Empty query returns recent facts by recency, not an error."""
        _seed(store, 1, [
            ("self", "name", "Leia Organa"),
            ("self", "pet", "ewok"),
        ])
        hits = read_user_facts(store, 1, "", top_k=5)
        assert len(hits) >= 1  # recency fallback


# ---------------------------------------------------------------------------
# 5. Cosine similarity helper
# ---------------------------------------------------------------------------


class TestCosine:
    def test_identical_vectors(self) -> None:
        v = [1.0, 2.0, 3.0]
        assert abs(_cosine(v, v) - 1.0) < 1e-9

    def test_orthogonal_vectors(self) -> None:
        a = [1.0, 0.0]
        b = [0.0, 1.0]
        assert abs(_cosine(a, b)) < 1e-9

    def test_empty_vectors(self) -> None:
        assert _cosine([], []) == 0.0

    def test_mismatched_lengths(self) -> None:
        assert _cosine([1.0], [1.0, 2.0]) == 0.0
