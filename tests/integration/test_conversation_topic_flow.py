"""Integration tests for conversation topic persistence across turns.

Verifies the complete multi-turn flow:
  Turn 1: User asks about a topic → entity + topic extracted
  Turn 2: Pronoun follow-up → entity resolved from session state,
           topic enriches the knowledge search query

This test exists because the "did he win" bug after a Masked Singer
conversation was never caught by existing tests — all multi-turn tests
were movie-specific and relied on the post-routing media resolver.
Knowledge queries go through the antecedent resolver (pre-routing) and
need conversation topic tracking in session state, which was missing.
"""
from __future__ import annotations

import pytest

from lokidoki.orchestrator.core.pipeline import run_pipeline_async
from lokidoki.orchestrator.core.types import ExecutionResult
from lokidoki.orchestrator.core.pipeline_hooks import (
    _extract_knowledge_query_entities,
    bridge_session_state_to_recent_entities,
    run_session_state_update,
)
from lokidoki.orchestrator.memory.store import MemoryStore
from lokidoki.orchestrator.skills.knowledge import _extract_query
from types import SimpleNamespace


def _make_context(store: MemoryStore, session_id: int) -> dict:
    return {
        "session_id": session_id,
        "memory_provider": SimpleNamespace(store=store),
        "memory_writes_enabled": True,
        "owner_user_id": 1,
    }


# ---------------------------------------------------------------------------
# Unit: knowledge query enrichment
# ---------------------------------------------------------------------------


class TestKnowledgeQueryEnrichment:
    """Verify _extract_query appends conversation_topic to short queries."""

    def test_enriches_short_query(self):
        payload = {
            "chunk_text": "did Corey Feldman win",
            "conversation_topic": "The Masked Singer",
        }
        assert _extract_query(payload) == "did Corey Feldman win The Masked Singer"

    def test_skips_long_query(self):
        payload = {
            "chunk_text": "what year did Corey Feldman appear on a television competition show",
            "conversation_topic": "The Masked Singer",
        }
        result = _extract_query(payload)
        assert "The Masked Singer" not in result

    def test_no_duplicate_when_topic_already_present(self):
        payload = {
            "chunk_text": "did Corey Feldman win The Masked Singer",
            "conversation_topic": "The Masked Singer",
        }
        result = _extract_query(payload)
        assert result.count("The Masked Singer") == 1

    def test_no_topic_no_enrichment(self):
        payload = {"chunk_text": "did Corey Feldman win"}
        assert _extract_query(payload) == "did Corey Feldman win"

    def test_explicit_query_param_takes_precedence(self):
        payload = {
            "chunk_text": "ignored",
            "params": {"query": "explicit query"},
            "conversation_topic": "The Masked Singer",
        }
        assert _extract_query(payload) == "explicit query"

    def test_complete_question_not_contaminated_by_stale_topic(self):
        """A fully-formed 5+ word query must not get a stale topic
        appended — "who is the active us president" + "what's happening"
        → garbled search results."""
        payload = {
            "chunk_text": "who is the active us president",
            "conversation_topic": "what's happening",
        }
        result = _extract_query(payload)
        assert "what's happening" not in result
        assert result == "who is the active us president"


# ---------------------------------------------------------------------------
# Unit: session state topic persistence
# ---------------------------------------------------------------------------


class TestSessionStateTopicPersistence:
    """Verify run_session_state_update persists conversation_topic."""

    def test_topic_stored_in_last_seen(self):
        store = MemoryStore(":memory:")
        sid = store.create_session(owner_user_id=1)
        ctx = {
            "session_id": sid,
            "memory_provider": SimpleNamespace(store=store),
            "conversation_topic": "The Masked Singer",
        }
        run_session_state_update(ctx, resolutions=[], executions=[])
        state = store.get_session_state(sid)
        last_seen = state.get("last_seen", {})
        assert "last_topic" in last_seen
        assert last_seen["last_topic"]["name"] == "The Masked Singer"

    def test_no_topic_no_write(self):
        store = MemoryStore(":memory:")
        sid = store.create_session(owner_user_id=1)
        ctx = {"session_id": sid, "memory_provider": SimpleNamespace(store=store)}
        run_session_state_update(ctx, resolutions=[], executions=[])
        state = store.get_session_state(sid)
        last_seen = state.get("last_seen", {})
        assert "last_topic" not in last_seen


# ---------------------------------------------------------------------------
# Unit: knowledge_query entity extraction from free-text output
# ---------------------------------------------------------------------------


class TestKnowledgeQueryEntityExtraction:
    """Verify _extract_knowledge_query_entities parses output text."""

    def test_extracts_person_from_actor_description(self):
        store = MemoryStore(":memory:")
        sid = store.create_session(owner_user_id=1)
        execution = ExecutionResult(
            chunk_index=0,
            capability="knowledge_query",
            output_text="Corey Feldman is an American actor, activist, and musician.",
            success=True,
        )
        _extract_knowledge_query_entities(store, sid, [execution], set())
        state = store.get_session_state(sid)
        last_seen = state.get("last_seen", {})
        assert "last_person" in last_seen
        assert last_seen["last_person"]["name"] == "Corey Feldman"

    def test_extracts_topic_as_second_proper_noun(self):
        store = MemoryStore(":memory:")
        sid = store.create_session(owner_user_id=1)
        execution = ExecutionResult(
            chunk_index=0,
            capability="knowledge_query",
            output_text="Corey Feldman was on The Masked Singer in 2024.",
            success=True,
        )
        _extract_knowledge_query_entities(store, sid, [execution], set())
        state = store.get_session_state(sid)
        last_seen = state.get("last_seen", {})
        assert "last_person" in last_seen
        assert "last_topic" in last_seen
        assert last_seen["last_topic"]["name"] == "The Masked Singer"

    def test_non_person_entity_stored_as_entity(self):
        store = MemoryStore(":memory:")
        sid = store.create_session(owner_user_id=1)
        execution = ExecutionResult(
            chunk_index=0,
            capability="knowledge_query",
            output_text="Python was first released in 1991.",
            success=True,
        )
        _extract_knowledge_query_entities(store, sid, [execution], set())
        state = store.get_session_state(sid)
        last_seen = state.get("last_seen", {})
        assert "last_entity" in last_seen
        assert last_seen["last_entity"]["name"] == "Python"

    def test_skips_already_stored_chunks(self):
        store = MemoryStore(":memory:")
        sid = store.create_session(owner_user_id=1)
        execution = ExecutionResult(
            chunk_index=0,
            capability="knowledge_query",
            output_text="Corey Feldman is an American actor.",
            success=True,
        )
        _extract_knowledge_query_entities(store, sid, [execution], {0})
        state = store.get_session_state(sid)
        assert state.get("last_seen", {}) == {}

    def test_skips_failed_executions(self):
        store = MemoryStore(":memory:")
        sid = store.create_session(owner_user_id=1)
        execution = ExecutionResult(
            chunk_index=0,
            capability="knowledge_query",
            output_text="Some output",
            success=False,
        )
        _extract_knowledge_query_entities(store, sid, [execution], set())
        state = store.get_session_state(sid)
        assert state.get("last_seen", {}) == {}

    def test_skips_non_knowledge_capabilities(self):
        store = MemoryStore(":memory:")
        sid = store.create_session(owner_user_id=1)
        execution = ExecutionResult(
            chunk_index=0,
            capability="lookup_movie",
            output_text="Avatar is a 2009 film.",
            success=True,
        )
        _extract_knowledge_query_entities(store, sid, [execution], set())
        state = store.get_session_state(sid)
        # Should be skipped because lookup_movie is handled by pass 2
        assert state.get("last_seen", {}) == {}


# ---------------------------------------------------------------------------
# Unit: bridge hook re-populates topic
# ---------------------------------------------------------------------------


class TestBridgeTopicReload:
    """Verify bridge_session_state_to_recent_entities loads topic."""

    def test_topic_loaded_into_recent_entities(self):
        store = MemoryStore(":memory:")
        sid = store.create_session(owner_user_id=1)
        store.update_last_seen(sid, entity_type="topic", entity_name="The Masked Singer")
        ctx = {"session_id": sid, "memory_provider": SimpleNamespace(store=store)}
        bridge_session_state_to_recent_entities(ctx)
        entities = ctx.get("recent_entities", [])
        topics = [e for e in entities if e.get("type") == "topic"]
        assert len(topics) == 1
        assert topics[0]["name"] == "The Masked Singer"

    def test_person_and_topic_both_loaded(self):
        store = MemoryStore(":memory:")
        sid = store.create_session(owner_user_id=1)
        store.update_last_seen(sid, entity_type="person", entity_name="Corey Feldman")
        store.update_last_seen(sid, entity_type="topic", entity_name="The Masked Singer")
        ctx = {"session_id": sid, "memory_provider": SimpleNamespace(store=store)}
        bridge_session_state_to_recent_entities(ctx)
        entities = ctx.get("recent_entities", [])
        types = {e["type"] for e in entities}
        assert "person" in types
        assert "topic" in types


# ---------------------------------------------------------------------------
# Integration: multi-turn person follow-up with topic context
# ---------------------------------------------------------------------------


class TestMultiTurnPersonFollowUp:
    """End-to-end test: person entity + topic persist across turns.

    Simulates the Corey Feldman / Masked Singer flow by injecting
    session state directly (avoids needing real search results).
    """

    @pytest.mark.anyio
    async def test_knowledge_query_extracts_entity_from_output(self):
        """knowledge_query output like 'Corey Feldman is an American actor'
        should have the subject entity extracted and stored in session state."""
        store = MemoryStore(":memory:")
        sid = store.create_session(owner_user_id=1)
        ctx = _make_context(store, sid)

        result = await run_pipeline_async("who is Corey Feldman", context=dict(ctx))
        state = store.get_session_state(sid)
        last_seen = state.get("last_seen", {})
        # The knowledge_query execution output should have been parsed
        # for proper noun phrases. If the search succeeded, the entity
        # should be tracked.
        if result.executions and result.executions[0].success:
            assert len(last_seen) > 0

    @pytest.mark.anyio
    async def test_topic_stored_after_antecedent_extraction(self):
        """When conversation_topic is set by the antecedent resolver,
        it should be persisted to session state for the next turn."""
        store = MemoryStore(":memory:")
        sid = store.create_session(owner_user_id=1)
        ctx = _make_context(store, sid)

        # Simulate turn 2 by pre-loading session state + conversation history
        store.update_last_seen(sid, entity_type="person", entity_name="Corey Feldman")
        ctx["conversation_history"] = [
            {"role": "user", "content": "what year was he on the masked singer"},
            {"role": "assistant", "content": "Corey Feldman was on The Masked Singer in 2024."},
        ]

        # Turn 3: "did he win" — antecedent resolver should extract topic
        result = await run_pipeline_async("did he win", context=dict(ctx))

        # Verify the antecedent resolver stored the topic in context
        # (the pipeline result doesn't directly expose context, but
        # session state should now have it)
        state = store.get_session_state(sid)
        last_seen = state.get("last_seen", {})
        assert "last_topic" in last_seen
        assert "Masked Singer" in last_seen["last_topic"]["name"]

    @pytest.mark.anyio
    async def test_pronoun_resolved_from_session_state(self):
        """'his' resolves to the person from session state.

        PipelineResult.chunks contains the ORIGINAL chunks (pre-resolution).
        The resolved text is used internally for routing and execution.
        We verify resolution happened by checking that the route went to
        knowledge_query (WH-question promotion on resolved text) rather
        than staying as direct_chat.
        """
        store = MemoryStore(":memory:")
        sid = store.create_session(owner_user_id=1)
        ctx = _make_context(store, sid)

        # Pre-load session state with person entity
        store.update_last_seen(sid, entity_type="person", entity_name="Corey Feldman")

        result = await run_pipeline_async("what is his birthday", context=dict(ctx))

        # The resolved text "what is Corey Feldman's birthday" should
        # trigger WH-question promotion to knowledge_query
        assert result.routes[0].capability == "knowledge_query"

    @pytest.mark.anyio
    async def test_topic_bridges_to_next_turn(self):
        """Topic persisted in turn N is available in turn N+1 via bridge."""
        store = MemoryStore(":memory:")
        sid = store.create_session(owner_user_id=1)

        # Simulate: topic was stored in a previous turn
        store.update_last_seen(sid, entity_type="person", entity_name="Corey Feldman")
        store.update_last_seen(sid, entity_type="topic", entity_name="The Masked Singer")

        ctx = _make_context(store, sid)

        # Bridge should load both into recent_entities
        bridge_session_state_to_recent_entities(ctx)
        entities = ctx.get("recent_entities", [])
        types = {e["type"] for e in entities}
        names = {e["name"] for e in entities}
        assert "person" in types
        assert "topic" in types
        assert "Corey Feldman" in names
        assert "The Masked Singer" in names
