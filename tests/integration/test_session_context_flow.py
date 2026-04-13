"""Integration tests for session context flow and movie routing.

Verifies:
- Movie queries with conversational phrasing route to movie capabilities
- Session state persists between pipeline calls with same session_id
- Pronoun references ("who's in it") resolve to the movie from context
- The recent_context memory slot is populated for pronoun queries
"""
from __future__ import annotations

import asyncio

import pytest

from lokidoki.orchestrator.core.pipeline import run_pipeline_async
from lokidoki.orchestrator.memory.store import MemoryStore


def _make_context(store: MemoryStore, session_id: int) -> dict:
    return {
        "session_id": session_id,
        "memory_store": store,
        "memory_writes_enabled": True,
        "owner_user_id": 1,
    }


class TestMovieRouting:
    """Movie queries with conversational phrasing route to movie skills."""

    @pytest.mark.anyio
    async def test_have_you_seen_routes_to_lookup(self):
        r = await run_pipeline_async("have you seen the movie inception")
        assert r.routes[0].capability == "lookup_movie"

    @pytest.mark.anyio
    async def test_who_is_in_routes_to_lookup(self):
        r = await run_pipeline_async("who's in the movie inception")
        assert r.routes[0].capability == "lookup_movie"

    @pytest.mark.anyio
    async def test_when_did_come_out_routes_to_lookup(self):
        r = await run_pipeline_async("when did the matrix come out")
        assert r.routes[0].capability == "lookup_movie"

    @pytest.mark.anyio
    async def test_pronoun_query_routes_to_recall(self):
        r = await run_pipeline_async("who's in it")
        assert r.routes[0].capability == "recall_recent_media"

    @pytest.mark.anyio
    async def test_whats_it_about_routes_to_recall(self):
        r = await run_pipeline_async("what's it about")
        assert r.routes[0].capability == "recall_recent_media"


class TestSessionContextPersistence:
    """Session state persists between turns with the same session_id."""

    @pytest.mark.anyio
    async def test_movie_recorded_in_session_state(self):
        store = MemoryStore(":memory:")
        sid = store.create_session(owner_user_id=1)
        ctx = _make_context(store, sid)
        await run_pipeline_async("have you seen the movie inception", context=dict(ctx))
        state = store.get_session_state(sid)
        last_seen = state.get("last_seen", {})
        assert "last_movie" in last_seen
        assert last_seen["last_movie"]["name"] == "inception"

    @pytest.mark.anyio
    async def test_session_state_survives_second_turn(self):
        store = MemoryStore(":memory:")
        sid = store.create_session(owner_user_id=1)
        ctx = _make_context(store, sid)
        await run_pipeline_async("tell me about the movie avatar", context=dict(ctx))
        # Second turn — session state should still have the movie
        r2 = await run_pipeline_async("who's in it", context=dict(ctx))
        state = store.get_session_state(sid)
        last_seen = state.get("last_seen", {})
        assert "last_movie" in last_seen


class TestPronounResolution:
    """Pronoun 'it' resolves to the movie from the previous turn."""

    @pytest.mark.anyio
    async def test_it_resolves_to_previous_movie(self):
        store = MemoryStore(":memory:")
        sid = store.create_session(owner_user_id=1)
        ctx = _make_context(store, sid)
        await run_pipeline_async("have you seen the movie inception", context=dict(ctx))
        r2 = await run_pipeline_async("who's in it", context=dict(ctx))
        res = r2.resolutions[0]
        assert res.resolved_target == "inception"
        assert res.source == "recent_context"

    @pytest.mark.anyio
    async def test_recent_context_slot_populated(self):
        store = MemoryStore(":memory:")
        sid = store.create_session(owner_user_id=1)
        ctx = _make_context(store, sid)
        await run_pipeline_async("tell me about the movie avatar", context=dict(ctx))
        r2 = await run_pipeline_async("what's it about", context=dict(ctx))
        slots = r2.request_spec.context.get("memory_slots", {})
        assert "last_movie" in slots.get("recent_context", "")

    @pytest.mark.anyio
    async def test_explicit_title_not_pronoun_resolved(self):
        """When the user names a movie explicitly, don't use media resolver."""
        r = await run_pipeline_async("have you seen the movie inception")
        res = r.resolutions[0]
        # Should resolve from chunk text, not from media context
        assert res.source == "chunk_entity"
        assert "inception" in res.resolved_target.lower()
