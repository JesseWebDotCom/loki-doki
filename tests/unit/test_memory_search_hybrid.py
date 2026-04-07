"""Hybrid fact search: BM25-only when vec_facts is empty.

PR3 ships without a real embedder, so the blend path is exercised
through the fallback. The cosine arm has its own placeholder
implementation that we'll fill in once embeddings land — these tests
just pin the BM25 contract and the no-vector fallback.
"""
from __future__ import annotations

import pytest

from lokidoki.core.memory_provider import MemoryProvider


@pytest.fixture
async def memory(tmp_path):
    mp = MemoryProvider(db_path=str(tmp_path / "search.db"))
    await mp.initialize()
    yield mp
    await mp.close()


@pytest.mark.anyio
async def test_hybrid_falls_back_to_bm25_with_no_vectors(memory):
    uid = await memory.get_or_create_user("alice")
    await memory.upsert_fact(
        user_id=uid, subject="self", predicate="likes", value="raspberry pi single board"
    )
    await memory.upsert_fact(
        user_id=uid, subject="self", predicate="likes", value="apple pie"
    )
    results = await memory.search_facts(user_id=uid, query="raspberry pi")
    assert results, "expected BM25 fallback to return rows"
    assert "raspberry pi" in results[0]["value"]


@pytest.mark.anyio
async def test_hybrid_search_is_user_scoped(memory):
    u1 = await memory.get_or_create_user("alice")
    u2 = await memory.get_or_create_user("bob")
    await memory.upsert_fact(
        user_id=u1, subject="self", predicate="likes", value="raspberry pi"
    )
    await memory.upsert_fact(
        user_id=u2, subject="self", predicate="likes", value="raspberry pi"
    )
    r1 = await memory.search_facts(user_id=u1, query="raspberry")
    r2 = await memory.search_facts(user_id=u2, query="raspberry")
    assert len(r1) == 1 and len(r2) == 1
    assert r1[0]["id"] != r2[0]["id"]


@pytest.mark.anyio
async def test_hybrid_search_returns_score_field(memory):
    uid = await memory.get_or_create_user("alice")
    await memory.upsert_fact(
        user_id=uid, subject="self", predicate="likes", value="hiking trails"
    )
    results = await memory.search_facts(user_id=uid, query="hiking")
    assert results[0]["score"] is not None
    # Blended score is "higher is better" by construction.
    assert isinstance(results[0]["score"], float)
