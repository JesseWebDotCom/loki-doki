"""Phase 7 unit tests: reranker module.

Tests the reranker interface, fake injection for testing, and
the rerank_facts helper that integrates with the fact pipeline.
"""
from __future__ import annotations

import pytest

from lokidoki.core.reranker import (
    rerank_facts,
    set_reranker_for_testing,
)


class _FakeReranker:
    """Deterministic reranker: scores by reverse length of passage."""

    def rerank(self, query, passages, top_k=5):
        scored = [(i, 100.0 - len(p)) for i, p in enumerate(passages)]
        scored.sort(key=lambda x: x[1], reverse=True)
        return scored[:top_k]


@pytest.fixture(autouse=True)
def _install_fake_reranker():
    set_reranker_for_testing(_FakeReranker())
    yield
    set_reranker_for_testing(None)


class TestRerankFacts:
    def test_reranks_by_fake_scorer(self):
        facts = [
            {"id": 1, "subject": "self", "predicate": "likes",
             "value": "long value that is many characters"},
            {"id": 2, "subject": "self", "predicate": "likes",
             "value": "short"},
            {"id": 3, "subject": "self", "predicate": "likes",
             "value": "medium value"},
        ]
        result = rerank_facts("test query", facts, top_k=3)
        # Fake reranker scores by shortest passage first.
        assert result[0]["value"] == "short"

    def test_empty_facts(self):
        result = rerank_facts("test", [])
        assert result == []

    def test_top_k_limits_output(self):
        facts = [
            {"id": i, "subject": "s", "predicate": "p", "value": f"v{i}"}
            for i in range(10)
        ]
        result = rerank_facts("test", facts, top_k=3)
        assert len(result) == 3

    def test_fallback_when_no_reranker(self):
        set_reranker_for_testing(None)
        facts = [
            {"id": 1, "subject": "s", "predicate": "p", "value": "a"},
            {"id": 2, "subject": "s", "predicate": "p", "value": "b"},
        ]
        # Should return original order when reranker is None.
        result = rerank_facts("test", facts, top_k=5)
        assert [f["id"] for f in result] == [1, 2]


class TestRerankerIntegrationWithScoring:
    """Ensure reranker output integrates cleanly with downstream scoring."""

    def test_reranked_facts_preserve_all_fields(self):
        facts = [
            {
                "id": 1, "subject": "self", "subject_type": "self",
                "predicate": "likes", "value": "music",
                "confidence": 0.8, "status": "active",
                "score": 0.5, "category": "general",
            },
            {
                "id": 2, "subject": "self", "subject_type": "self",
                "predicate": "dislikes", "value": "rain",
                "confidence": 0.7, "status": "active",
                "score": 0.3, "category": "general",
            },
        ]
        result = rerank_facts("test", facts)
        for f in result:
            assert "id" in f
            assert "confidence" in f
            assert "status" in f
            assert "score" in f

    def test_realistic_fact_values(self):
        """Realistic user-generated fact values."""
        facts = [
            {"id": 1, "subject": "self", "predicate": "mentioned",
             "value": "i really love hiking in the mountains on weekends"},
            {"id": 2, "subject": "self", "predicate": "likes",
             "value": "coffee"},
            {"id": 3, "subject": "Artie", "predicate": "is",
             "value": "my brother who lives in Connecticut"},
        ]
        result = rerank_facts("who is my brother", facts, top_k=2)
        assert len(result) == 2
