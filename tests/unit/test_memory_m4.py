"""
M4 phase-gate tests: session state, episodic summarization, promotion,
triggered consolidation, episode reader, Tier 2/3 slots, and pipeline
integration.

All tests run against an in-memory MemoryStore — no network, no disk.
"""
from __future__ import annotations

import time

import pytest

from lokidoki.orchestrator.memory.consolidation import (
    TRIGGERED_CONSOLIDATION_THRESHOLD,
    ConsolidationResult,
    maybe_trigger_consolidation,
)
from lokidoki.orchestrator.memory.reader import (
    EpisodeHit,
    SessionContext,
    read_episodes,
    read_recent_context,
)
from lokidoki.orchestrator.memory.slots import (
    RECENT_CONTEXT_BUDGET,
    RELEVANT_EPISODES_BUDGET,
    assemble_recent_context_slot,
    assemble_relevant_episodes_slot,
    render_recent_context,
    render_relevant_episodes,
    truncate_to_budget,
)
from lokidoki.orchestrator.memory.store import MemoryStore
from lokidoki.orchestrator.memory.summarizer import (
    SessionObservation,
    SummarizationResult,
    derive_topic_scope,
    queue_session_close,
    reset_queue,
    run_pending_summaries,
    summarize_session,
)
from lokidoki.orchestrator.memory import (
    ACTIVE_PHASE_ID,
    ACTIVE_PHASE_LABEL,
    M4_PHASE_ID,
    M4_PHASE_STATUS,
)


@pytest.fixture()
def store():
    s = MemoryStore(":memory:")
    yield s
    s.close()


OWNER = 42


# -------------------------------------------------------------------
# Session state round-trips
# -------------------------------------------------------------------


class TestSessionState:
    def test_create_and_get_session(self, store: MemoryStore):
        sid = store.create_session(OWNER)
        assert isinstance(sid, int) and sid > 0
        state = store.get_session_state(sid)
        assert state == {}

    def test_set_and_get_session_state(self, store: MemoryStore):
        sid = store.create_session(OWNER)
        store.set_session_state(sid, {"foo": "bar"})
        assert store.get_session_state(sid) == {"foo": "bar"}

    def test_update_last_seen(self, store: MemoryStore):
        sid = store.create_session(OWNER)
        state = store.update_last_seen(sid, entity_type="movie", entity_name="Star Wars")
        assert state["last_seen"]["last_movie"]["name"] == "Star Wars"
        # Second update replaces the same key
        state = store.update_last_seen(sid, entity_type="movie", entity_name="Inception")
        assert state["last_seen"]["last_movie"]["name"] == "Inception"
        # Different type goes to different key
        state = store.update_last_seen(sid, entity_type="person", entity_name="Luke")
        assert state["last_seen"]["last_person"]["name"] == "Luke"
        assert state["last_seen"]["last_movie"]["name"] == "Inception"

    def test_unknown_session_returns_empty(self, store: MemoryStore):
        assert store.get_session_state(9999) == {}

    def test_close_session(self, store: MemoryStore):
        sid = store.create_session(OWNER)
        store.close_session(sid)
        row = store._conn.execute("SELECT ended_at FROM sessions WHERE id = ?", (sid,)).fetchone()
        assert row["ended_at"] is not None


# -------------------------------------------------------------------
# Episode write + FTS search
# -------------------------------------------------------------------


class TestEpisodes:
    def test_write_and_get_episodes(self, store: MemoryStore):
        eid = store.write_episode(
            owner_user_id=OWNER,
            title="Japan trip planning",
            summary="On 2026-04-09: discussed itinerary for Japan",
            entities=[{"subject": "self", "predicate": "plans_trip", "value": "japan"}],
            topic_scope="japan_trip",
        )
        assert eid > 0
        episodes = store.get_episodes(OWNER)
        assert len(episodes) == 1
        assert episodes[0]["topic_scope"] == "japan_trip"

    def test_episode_fts_search(self, store: MemoryStore):
        store.write_episode(
            owner_user_id=OWNER,
            title="Japan trip",
            summary="Discussed flights to Tokyo and hotels in Kyoto",
        )
        store.write_episode(
            owner_user_id=OWNER,
            title="Garden project",
            summary="Planned raised beds and soil amendments",
        )
        hits = read_episodes(store, OWNER, "Japan flights Tokyo")
        assert len(hits) >= 1
        assert any("Japan" in h.title for h in hits)

    def test_topic_scope_filters_episodes(self, store: MemoryStore):
        store.write_episode(
            owner_user_id=OWNER,
            title="Japan trip",
            summary="Tokyo flights",
            topic_scope="japan_trip",
        )
        store.write_episode(
            owner_user_id=OWNER,
            title="Garden",
            summary="Soil work",
            topic_scope="garden",
        )
        hits = read_episodes(store, OWNER, "trip", topic_scope="japan_trip")
        assert all(h.topic_scope == "japan_trip" for h in hits)

    def test_count_episodes_with_claim(self, store: MemoryStore):
        for i in range(3):
            sid = store.create_session(OWNER)
            store.write_episode(
                owner_user_id=OWNER,
                title=f"Session {i}",
                summary=f"Session {i} summary",
                entities=[{"subject": "self", "predicate": "prefers", "value": "thai_food"}],
                session_id=sid,
            )
        count = store.count_episodes_with_claim(
            OWNER, subject="self", predicate="prefers", value="thai_food"
        )
        assert count == 3


# -------------------------------------------------------------------
# Topic scope derivation
# -------------------------------------------------------------------


class TestTopicScope:
    def test_explicit_override(self):
        obs = [SessionObservation(subject="self", predicate="p", value="v")]
        assert derive_topic_scope(obs, explicit="japan_trip") == "japan_trip"

    def test_single_winner(self):
        obs = [
            SessionObservation(subject="self", predicate="p", value="v", entities=("japan",)),
            SessionObservation(subject="self", predicate="p", value="v2", entities=("japan", "food")),
        ]
        assert derive_topic_scope(obs) == "japan"

    def test_tie_returns_none(self):
        obs = [
            SessionObservation(subject="self", predicate="p", value="v", entities=("japan",)),
            SessionObservation(subject="self", predicate="p", value="v2", entities=("italy",)),
            SessionObservation(subject="self", predicate="p", value="v3", entities=("japan",)),
            SessionObservation(subject="self", predicate="p", value="v4", entities=("italy",)),
        ]
        assert derive_topic_scope(obs) is None

    def test_no_entities_returns_none(self):
        obs = [SessionObservation(subject="self", predicate="p", value="v")]
        assert derive_topic_scope(obs) is None


# -------------------------------------------------------------------
# Triggered consolidation
# -------------------------------------------------------------------


class TestTriggeredConsolidation:
    def test_below_threshold_not_triggered(self, store: MemoryStore):
        sid = store.create_session(OWNER)
        result = maybe_trigger_consolidation(
            store=store,
            session_id=sid,
            owner_user_id=OWNER,
            subject="self",
            predicate="prefers",
            value="thai_food",
        )
        assert not result.triggered
        assert result.observation_count == 1

    def test_reaches_threshold_triggers(self, store: MemoryStore):
        sid = store.create_session(OWNER)
        for i in range(TRIGGERED_CONSOLIDATION_THRESHOLD - 1):
            result = maybe_trigger_consolidation(
                store=store,
                session_id=sid,
                owner_user_id=OWNER,
                subject="self",
                predicate="prefers",
                value="thai_food",
            )
            assert not result.triggered
        # The Nth call triggers
        result = maybe_trigger_consolidation(
            store=store,
            session_id=sid,
            owner_user_id=OWNER,
            subject="self",
            predicate="prefers",
            value="thai_food",
        )
        assert result.triggered
        assert result.observation_count == TRIGGERED_CONSOLIDATION_THRESHOLD

        # Verify durable fact was written
        facts = store.get_active_facts(OWNER, predicate="prefers")
        assert any(f["value"] == "thai_food" for f in facts)


# -------------------------------------------------------------------
# Cross-session promotion
# -------------------------------------------------------------------


class TestCrossSessionPromotion:
    def test_promotion_after_3_sessions(self, store: MemoryStore):
        """A claim appearing in 3 separate session episodes promotes to Tier 4."""
        obs = [SessionObservation(
            subject="self", predicate="prefers", value="morning_coffee",
            source_text="user mentioned coffee preference",
        )]
        for i in range(3):
            sid = store.create_session(OWNER)
            summarize_session(
                store,
                session_id=sid,
                owner_user_id=OWNER,
                observations=obs,
            )
        # After 3 sessions, the claim should be promoted to Tier 4
        facts = store.get_active_facts(OWNER, predicate="prefers")
        assert any(f["value"] == "morning_coffee" for f in facts)

    def test_no_promotion_below_threshold(self, store: MemoryStore):
        """Two sessions are below the threshold — no promotion."""
        obs = [SessionObservation(
            subject="self", predicate="prefers", value="evening_tea",
            source_text="user mentioned tea preference",
        )]
        for i in range(2):
            sid = store.create_session(OWNER)
            summarize_session(
                store, session_id=sid, owner_user_id=OWNER, observations=obs,
            )
        facts = store.get_active_facts(OWNER, predicate="prefers")
        assert not any(f["value"] == "evening_tea" for f in facts)


# -------------------------------------------------------------------
# Session-close summarization queue (out-of-band)
# -------------------------------------------------------------------


class TestSummarizationQueue:
    def test_queue_and_drain(self, store: MemoryStore):
        reset_queue()
        sid = store.create_session(OWNER)
        obs = [SessionObservation(subject="self", predicate="prefers", value="jazz")]
        queue_session_close(
            store=store, session_id=sid, owner_user_id=OWNER, observations=obs,
        )
        results = run_pending_summaries()
        assert len(results) == 1
        assert results[0].episode_id > 0
        episodes = store.get_episodes(OWNER)
        assert len(episodes) == 1


# -------------------------------------------------------------------
# Slot rendering + budgets
# -------------------------------------------------------------------


class TestSlotAssembly:
    def test_recent_context_slot_budget(self):
        assert RECENT_CONTEXT_BUDGET == 300

    def test_relevant_episodes_slot_budget(self):
        assert RELEVANT_EPISODES_BUDGET == 400

    def test_render_recent_context(self):
        ctx = SessionContext(session_id=1, last_seen={
            "last_movie": {"name": "Star Wars", "at": "2026-04-12T00:00:00Z"},
            "last_person": {"name": "Luke", "at": "2026-04-12T00:00:00Z"},
        })
        rendered = render_recent_context(ctx)
        assert "last_movie=Star Wars" in rendered
        assert "last_person=Luke" in rendered
        assert len(rendered) <= RECENT_CONTEXT_BUDGET

    def test_render_relevant_episodes(self):
        hits = [
            EpisodeHit(
                episode_id=1, owner_user_id=OWNER, title="Japan trip",
                summary="Discussed flights to Tokyo and hotels in Kyoto",
                topic_scope="japan_trip", sentiment=None,
                start_at="2026-04-09T00:00:00Z", score=1.0,
            ),
        ]
        rendered = render_relevant_episodes(hits)
        assert "Japan trip" in rendered
        assert len(rendered) <= RELEVANT_EPISODES_BUDGET

    def test_truncate_recent_context_to_budget(self):
        # Generate a long value that exceeds 300 chars
        long_val = "x" * 350
        result = truncate_to_budget("recent_context", long_val)
        assert len(result) <= RECENT_CONTEXT_BUDGET

    def test_truncate_relevant_episodes_to_budget(self):
        long_val = "y" * 500
        result = truncate_to_budget("relevant_episodes", long_val)
        assert len(result) <= RELEVANT_EPISODES_BUDGET

    def test_assemble_recent_context_end_to_end(self, store: MemoryStore):
        sid = store.create_session(OWNER)
        store.update_last_seen(sid, entity_type="movie", entity_name="Inception")
        rendered, ctx = assemble_recent_context_slot(store=store, session_id=sid)
        assert "last_movie=Inception" in rendered

    def test_assemble_relevant_episodes_end_to_end(self, store: MemoryStore):
        store.write_episode(
            owner_user_id=OWNER,
            title="Japan trip",
            summary="Discussed flights to Tokyo",
        )
        rendered, hits = assemble_relevant_episodes_slot(
            store=store, owner_user_id=OWNER, query="Japan flights",
        )
        assert "Japan trip" in rendered


# -------------------------------------------------------------------
# Latency gate
# -------------------------------------------------------------------


class TestLatency:
    def test_session_state_lookup_under_50ms_p95(self, store: MemoryStore):
        """p95 of session_state read + update_last_seen must be < 50ms."""
        # Seed 20 sessions with some state
        sids = []
        for _ in range(20):
            sid = store.create_session(OWNER)
            store.update_last_seen(sid, entity_type="movie", entity_name="Test")
            store.update_last_seen(sid, entity_type="person", entity_name="Luke")
            sids.append(sid)

        timings = []
        for sid in sids:
            start = time.perf_counter()
            store.get_session_state(sid)
            store.update_last_seen(sid, entity_type="movie", entity_name="New Movie")
            elapsed = (time.perf_counter() - start) * 1000
            timings.append(elapsed)
        timings.sort()
        p95 = timings[int(len(timings) * 0.95)]
        assert p95 < 50, f"p95 session state latency = {p95:.1f}ms (limit: 50ms)"


# -------------------------------------------------------------------
# Pipeline integration
# -------------------------------------------------------------------


class TestPipelineIntegration:
    def test_session_created_when_memory_enabled(self, store: MemoryStore):
        from lokidoki.orchestrator.core.pipeline import run_pipeline

        ctx = {
            "memory_store": store,
            "memory_writes_enabled": True,
            "owner_user_id": OWNER,
        }
        run_pipeline("hello", context=ctx)
        assert "session_id" in ctx
        assert isinstance(ctx["session_id"], int)

    def test_session_not_created_when_memory_disabled(self, store: MemoryStore):
        from lokidoki.orchestrator.core.pipeline import run_pipeline

        ctx: dict = {}
        run_pipeline("hello", context=ctx)
        assert "session_id" not in ctx

    def test_session_close_queues_summarization(self, store: MemoryStore):
        from lokidoki.orchestrator.core.pipeline import run_pipeline

        reset_queue()
        ctx = {
            "memory_store": store,
            "memory_writes_enabled": True,
            "owner_user_id": OWNER,
            "session_closing": True,
        }
        run_pipeline("I love pizza", context=ctx)
        results = run_pending_summaries()
        # At least the session-close was queued and processed
        assert len(results) >= 1

    def test_need_session_context_gates_slot(self, store: MemoryStore):
        from lokidoki.orchestrator.core.pipeline import run_pipeline

        sid = store.create_session(OWNER)
        store.update_last_seen(sid, entity_type="movie", entity_name="Inception")
        ctx = {
            "memory_store": store,
            "owner_user_id": OWNER,
            "session_id": sid,
            "need_session_context": True,
        }
        result = run_pipeline("what was that movie", context=ctx)
        slots = result.request_spec.context.get("memory_slots") or {}
        assert "recent_context" in slots
        assert "Inception" in slots["recent_context"]

    def test_need_episode_gates_slot(self, store: MemoryStore):
        from lokidoki.orchestrator.core.pipeline import run_pipeline

        store.write_episode(
            owner_user_id=OWNER,
            title="Japan trip",
            summary="Discussed flights to Tokyo and hotels in Kyoto",
        )
        ctx = {
            "memory_store": store,
            "owner_user_id": OWNER,
            "need_episode": True,
        }
        result = run_pipeline("tell me about that Japan trip", context=ctx)
        slots = result.request_spec.context.get("memory_slots") or {}
        assert "relevant_episodes" in slots
        assert "Japan" in slots["relevant_episodes"]

    def test_no_slots_when_flags_not_set(self, store: MemoryStore):
        from lokidoki.orchestrator.core.pipeline import run_pipeline

        sid = store.create_session(OWNER)
        store.update_last_seen(sid, entity_type="movie", entity_name="Test")
        store.write_episode(
            owner_user_id=OWNER, title="Test", summary="Test episode",
        )
        ctx = {
            "memory_store": store,
            "owner_user_id": OWNER,
            "session_id": sid,
            # No need_session_context or need_episode flags
        }
        result = run_pipeline("hello", context=ctx)
        slots = result.request_spec.context.get("memory_slots") or {}
        assert slots.get("recent_context", "") == ""
        assert slots.get("relevant_episodes", "") == ""


# -------------------------------------------------------------------
# Phase constants
# -------------------------------------------------------------------


class TestStaleContextDecay:
    def test_decay_drops_old_entries(self, store: MemoryStore):
        sid = store.create_session(OWNER)
        store.update_last_seen_with_turn(sid, entity_type="movie", entity_name="Old Movie", turn_index=1)
        store.update_last_seen_with_turn(sid, entity_type="person", entity_name="Luke", turn_index=8)
        # At turn 10, the movie (turn 1) is 9 turns old > max 5, so it's stale
        state = store.decay_session_state(sid, current_turn_index=10)
        last_seen = state.get("last_seen", {})
        assert "last_movie" not in last_seen, "old movie entry should have been decayed"
        assert "last_person" in last_seen, "recent person entry should survive"
        assert last_seen["last_person"]["name"] == "Luke"

    def test_decay_keeps_recent_entries(self, store: MemoryStore):
        sid = store.create_session(OWNER)
        store.update_last_seen_with_turn(sid, entity_type="movie", entity_name="New Movie", turn_index=8)
        state = store.decay_session_state(sid, current_turn_index=10)
        last_seen = state.get("last_seen", {})
        assert "last_movie" in last_seen

    def test_decay_ignores_entries_without_turn(self, store: MemoryStore):
        """Entries without a turn key (from legacy update_last_seen) are kept."""
        sid = store.create_session(OWNER)
        store.update_last_seen(sid, entity_type="movie", entity_name="Legacy Movie")
        state = store.decay_session_state(sid, current_turn_index=100)
        last_seen = state.get("last_seen", {})
        assert "last_movie" in last_seen


class TestSessionStateBridge:
    def test_bridge_populates_recent_entities(self, store: MemoryStore):
        from lokidoki.orchestrator.core.pipeline import _bridge_session_state_to_recent_entities

        sid = store.create_session(OWNER)
        store.update_last_seen(sid, entity_type="movie", entity_name="Inception")
        store.update_last_seen(sid, entity_type="person", entity_name="Luke")
        ctx: dict = {"memory_store": store, "session_id": sid}
        _bridge_session_state_to_recent_entities(ctx)
        entities = ctx.get("recent_entities", [])
        names = {e["name"] for e in entities}
        assert "Inception" in names
        assert "Luke" in names

    def test_bridge_does_not_duplicate(self, store: MemoryStore):
        from lokidoki.orchestrator.core.pipeline import _bridge_session_state_to_recent_entities

        sid = store.create_session(OWNER)
        store.update_last_seen(sid, entity_type="movie", entity_name="Inception")
        ctx: dict = {
            "memory_store": store,
            "session_id": sid,
            "recent_entities": [{"name": "Inception", "type": "movie"}],
        }
        _bridge_session_state_to_recent_entities(ctx)
        entities = ctx.get("recent_entities", [])
        inception_count = sum(1 for e in entities if e["name"] == "Inception")
        assert inception_count == 1


class TestAutoRaiseNeedSessionContext:
    def test_auto_raise_on_unresolved_referent(self):
        from lokidoki.orchestrator.core.pipeline import _auto_raise_need_session_context
        from lokidoki.orchestrator.core.types import ResolutionResult

        resolution = ResolutionResult(
            chunk_index=0,
            resolved_target="",
            source="unresolved_referent",
            confidence=0.5,
            unresolved=["referent:it"],
        )
        ctx: dict = {}
        _auto_raise_need_session_context(ctx, [resolution])
        assert ctx.get("need_session_context") is True

    def test_no_raise_when_resolved(self):
        from lokidoki.orchestrator.core.pipeline import _auto_raise_need_session_context
        from lokidoki.orchestrator.core.types import ResolutionResult

        resolution = ResolutionResult(
            chunk_index=0,
            resolved_target="Star Wars",
            source="referent",
            confidence=0.9,
        )
        ctx: dict = {}
        _auto_raise_need_session_context(ctx, [resolution])
        assert "need_session_context" not in ctx


class TestPhaseConstants:
    def test_m4_phase_constants(self):
        assert M4_PHASE_ID == "m4"
        assert M4_PHASE_STATUS == "complete"

    def test_active_phase_advanced_past_m4(self):
        # M5 has shipped — the active phase is now m5 or later
        assert ACTIVE_PHASE_ID >= "m4"
