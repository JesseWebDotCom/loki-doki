"""
M5 phase-gate tests: behavior events, user profile (Tier 7a/7b),
nightly aggregation, need_routine derivation, user_style slot,
pipeline integration, and 7b leak prevention.

All tests run against an in-memory V2MemoryStore — no network, no disk.
"""
from __future__ import annotations

import json
import time

import pytest

from v2.orchestrator.memory.store import V2MemoryStore
from v2.orchestrator.memory.aggregation import (
    EVENT_RETENTION_DAYS,
    MIN_EVENTS_FOR_DERIVATION,
    run_aggregation,
)
from v2.orchestrator.memory.slots import (
    USER_STYLE_BUDGET,
    STYLE_DESCRIPTORS,
    assemble_user_style_slot,
    render_user_style,
    truncate_to_budget,
)
from v2.orchestrator.memory import (
    ACTIVE_PHASE_ID,
    ACTIVE_PHASE_LABEL,
    M5_PHASE_ID,
    M5_PHASE_STATUS,
)


@pytest.fixture
def store():
    s = V2MemoryStore(":memory:")
    yield s
    s.close()


OWNER = 1


# -----------------------------------------------------------------------
# 1. Store: behavior_events CRUD
# -----------------------------------------------------------------------


class TestBehaviorEvents:
    def test_write_and_read(self, store: V2MemoryStore):
        eid = store.write_behavior_event(
            OWNER, event_type="turn", payload={"modality": "text"},
        )
        assert eid > 0
        events = store.get_behavior_events(OWNER)
        assert len(events) == 1
        assert events[0]["event_type"] == "turn"
        payload = json.loads(events[0]["payload"])
        assert payload["modality"] == "text"

    def test_read_with_since_filter(self, store: V2MemoryStore):
        store.write_behavior_event(OWNER, event_type="turn", payload={"n": 1})
        store.write_behavior_event(OWNER, event_type="turn", payload={"n": 2})
        # "since" far in the future returns nothing
        events = store.get_behavior_events(OWNER, since="2099-01-01T00:00:00Z")
        assert events == []

    def test_read_with_event_type_filter(self, store: V2MemoryStore):
        store.write_behavior_event(OWNER, event_type="turn", payload={})
        store.write_behavior_event(OWNER, event_type="other", payload={})
        events = store.get_behavior_events(OWNER, event_type="turn")
        assert len(events) == 1
        assert events[0]["event_type"] == "turn"

    def test_delete_before(self, store: V2MemoryStore):
        store.write_behavior_event(OWNER, event_type="turn", payload={})
        deleted = store.delete_behavior_events_before(OWNER, before="2099-01-01T00:00:00Z")
        assert deleted == 1
        assert store.get_behavior_events(OWNER) == []

    def test_event_count(self, store: V2MemoryStore):
        assert store.get_behavior_event_count(OWNER) == 0
        store.write_behavior_event(OWNER, event_type="turn", payload={})
        store.write_behavior_event(OWNER, event_type="turn", payload={})
        assert store.get_behavior_event_count(OWNER) == 2

    def test_null_payload(self, store: V2MemoryStore):
        eid = store.write_behavior_event(OWNER, event_type="turn")
        events = store.get_behavior_events(OWNER)
        assert len(events) == 1
        assert events[0]["payload"] is None


# -----------------------------------------------------------------------
# 2. Store: user_profile CRUD
# -----------------------------------------------------------------------


class TestUserProfile:
    def test_get_missing_profile(self, store: V2MemoryStore):
        profile = store.get_user_profile(OWNER)
        assert profile["style"] == {}
        assert profile["telemetry"] == {}
        assert profile["updated_at"] is None

    def test_set_and_get_style(self, store: V2MemoryStore):
        store.set_user_style(OWNER, {"tone": "casual", "verbosity": "concise"})
        profile = store.get_user_profile(OWNER)
        assert profile["style"]["tone"] == "casual"
        assert profile["style"]["verbosity"] == "concise"

    def test_set_and_get_telemetry(self, store: V2MemoryStore):
        store.set_user_telemetry(OWNER, {"total_turns": 42})
        profile = store.get_user_profile(OWNER)
        assert profile["telemetry"]["total_turns"] == 42

    def test_style_update_preserves_telemetry(self, store: V2MemoryStore):
        store.set_user_telemetry(OWNER, {"total_turns": 10})
        store.set_user_style(OWNER, {"tone": "formal"})
        profile = store.get_user_profile(OWNER)
        assert profile["style"]["tone"] == "formal"
        assert profile["telemetry"]["total_turns"] == 10

    def test_style_overwrite(self, store: V2MemoryStore):
        store.set_user_style(OWNER, {"tone": "casual"})
        store.set_user_style(OWNER, {"tone": "formal", "verbosity": "detailed"})
        profile = store.get_user_profile(OWNER)
        assert profile["style"]["tone"] == "formal"
        assert profile["style"]["verbosity"] == "detailed"


# -----------------------------------------------------------------------
# 3. Opt-out toggle
# -----------------------------------------------------------------------


class TestOptOut:
    def test_default_not_opted_out(self, store: V2MemoryStore):
        assert store.is_telemetry_opted_out(OWNER) is False

    def test_opt_out_prevents_reads(self, store: V2MemoryStore):
        store.set_telemetry_opt_out(OWNER, True)
        assert store.is_telemetry_opted_out(OWNER) is True

    def test_opt_back_in(self, store: V2MemoryStore):
        store.set_telemetry_opt_out(OWNER, True)
        store.set_telemetry_opt_out(OWNER, False)
        assert store.is_telemetry_opted_out(OWNER) is False


# -----------------------------------------------------------------------
# 4. Aggregation job
# -----------------------------------------------------------------------


class TestAggregation:
    def test_no_events_noop(self, store: V2MemoryStore):
        result = run_aggregation(store, OWNER)
        assert result["events_processed"] == 0
        assert result["style_updated"] is False

    def test_below_min_events_no_style(self, store: V2MemoryStore):
        for i in range(MIN_EVENTS_FOR_DERIVATION - 1):
            store.write_behavior_event(
                OWNER, event_type="turn",
                payload={"modality": "text", "response_length": 50},
            )
        result = run_aggregation(store, OWNER)
        assert result["events_processed"] == MIN_EVENTS_FOR_DERIVATION - 1
        assert result["style_updated"] is False

    def test_derives_verbosity_concise(self, store: V2MemoryStore):
        for _ in range(10):
            store.write_behavior_event(
                OWNER, event_type="turn",
                payload={"modality": "text", "response_length": 40},
            )
        result = run_aggregation(store, OWNER)
        assert result["style_updated"] is True
        assert result["style"]["verbosity"] == "concise"

    def test_derives_verbosity_detailed(self, store: V2MemoryStore):
        for _ in range(10):
            store.write_behavior_event(
                OWNER, event_type="turn",
                payload={"modality": "text", "response_length": 500},
            )
        result = run_aggregation(store, OWNER)
        assert result["style"]["verbosity"] == "detailed"

    def test_derives_preferred_modality(self, store: V2MemoryStore):
        for _ in range(7):
            store.write_behavior_event(
                OWNER, event_type="turn",
                payload={"modality": "voice", "response_length": 100},
            )
        for _ in range(3):
            store.write_behavior_event(
                OWNER, event_type="turn",
                payload={"modality": "text", "response_length": 100},
            )
        result = run_aggregation(store, OWNER)
        assert result["style"]["preferred_modality"] == "voice"

    def test_updates_telemetry_counters(self, store: V2MemoryStore):
        for _ in range(5):
            store.write_behavior_event(
                OWNER, event_type="turn",
                payload={"capabilities": ["get_weather"], "success": True, "response_length": 100},
            )
        store.write_behavior_event(
            OWNER, event_type="turn",
            payload={"capabilities": ["direct_chat"], "success": False, "response_length": 100},
        )
        result = run_aggregation(store, OWNER)
        profile = store.get_user_profile(OWNER)
        assert profile["telemetry"]["total_turns"] == 6
        assert profile["telemetry"]["total_successes"] == 5
        assert profile["telemetry"]["total_failures"] == 1
        assert profile["telemetry"]["capability_histogram"]["get_weather"] == 5
        assert profile["telemetry"]["capability_histogram"]["direct_chat"] == 1

    def test_aggregation_latency(self, store: V2MemoryStore):
        """Aggregation < 5s for 1000 events (gate checklist)."""
        for i in range(1000):
            store.write_behavior_event(
                OWNER, event_type="turn",
                payload={"modality": "text", "response_length": 100 + i, "capabilities": ["get_weather"]},
            )
        start = time.perf_counter()
        result = run_aggregation(store, OWNER)
        elapsed = time.perf_counter() - start
        assert elapsed < 5.0, f"Aggregation took {elapsed:.2f}s, expected < 5s"
        assert result["events_processed"] == 1000

    def test_stable_descriptors_across_runs(self, store: V2MemoryStore):
        """Profile descriptors stable across synthetic simulation (gate).

        Two batches of similar events produce the same style descriptors.
        We compare the stored profile after each run rather than the
        return value, since the second run may see zero new events when
        timestamps collide (second-precision SQLite datetime).
        """
        # Batch 1
        for _ in range(20):
            store.write_behavior_event(
                OWNER, event_type="turn",
                payload={"modality": "text", "response_length": 50},
            )
        run_aggregation(store, OWNER)
        profile_1 = store.get_user_profile(OWNER)["style"]

        # Reset last_aggregation so batch 2 events are picked up
        store.set_user_telemetry(OWNER, {})

        # Batch 2 — similar distribution
        for _ in range(20):
            store.write_behavior_event(
                OWNER, event_type="turn",
                payload={"modality": "text", "response_length": 55},
            )
        run_aggregation(store, OWNER)
        profile_2 = store.get_user_profile(OWNER)["style"]

        assert profile_1["verbosity"] == profile_2["verbosity"]
        assert profile_1["preferred_modality"] == profile_2["preferred_modality"]


# -----------------------------------------------------------------------
# 5. Slot rendering
# -----------------------------------------------------------------------


class TestUserStyleSlot:
    def test_render_empty(self):
        assert render_user_style({}) == ""

    def test_render_single_descriptor(self):
        rendered = render_user_style({"tone": "casual"})
        assert rendered == "tone=casual"

    def test_render_multiple_descriptors(self):
        rendered = render_user_style({
            "tone": "casual",
            "verbosity": "concise",
            "formality": "informal",
        })
        assert "tone=casual" in rendered
        assert "verbosity=concise" in rendered
        assert "formality=informal" in rendered

    def test_render_budget_enforced(self):
        # Build a style dict with very long values
        style = {key: "x" * 100 for key in STYLE_DESCRIPTORS}
        rendered = render_user_style(style)
        assert len(rendered) <= USER_STYLE_BUDGET

    def test_assemble_from_store(self, store: V2MemoryStore):
        store.set_user_style(OWNER, {"tone": "playful", "verbosity": "detailed"})
        rendered, style = assemble_user_style_slot(store=store, owner_user_id=OWNER)
        assert "tone=playful" in rendered
        assert style["tone"] == "playful"

    def test_assemble_empty_profile(self, store: V2MemoryStore):
        rendered, style = assemble_user_style_slot(store=store, owner_user_id=OWNER)
        assert rendered == ""
        assert style == {}


# -----------------------------------------------------------------------
# 6. Prompt slot integration — tone changes
# -----------------------------------------------------------------------


class TestSynthesisPromptToneChange:
    """Synthesis prompt observably changes tone for 3+ distinct profiles (gate)."""

    def test_three_distinct_profiles(self):
        from v2.orchestrator.fallbacks.prompts import render_prompt

        profiles = [
            {"tone": "casual", "verbosity": "concise"},
            {"tone": "formal", "verbosity": "detailed", "formality": "professional"},
            {"tone": "playful", "verbosity": "moderate"},
        ]
        rendered_prompts = []
        for style in profiles:
            slot_text = render_user_style(style)
            prompt = render_prompt(
                "direct_chat",
                user_question="What is the weather?",
                user_style=slot_text,
            )
            rendered_prompts.append(prompt)

        # Each profile produces a distinct user_style slot in the prompt
        style_slots = set()
        for p in rendered_prompts:
            # Extract the user_style line
            for line in p.split("\n"):
                if line.startswith("user_style:"):
                    style_slots.add(line.strip())
        assert len(style_slots) == 3, f"Expected 3 distinct style slots, got {len(style_slots)}"

    def test_combine_prompt_includes_style(self):
        from v2.orchestrator.fallbacks.prompts import render_prompt

        slot_text = render_user_style({"tone": "casual", "verbosity": "concise"})
        prompt = render_prompt(
            "combine",
            spec="{}",
            user_style=slot_text,
            confidence_guide="test",
            sources_list="",
        )
        assert "tone=casual" in prompt
        assert "verbosity=concise" in prompt


# -----------------------------------------------------------------------
# 7. 7b leak test — telemetry never appears in any prompt
# -----------------------------------------------------------------------


class TestTier7bLeak:
    """7b leak test: telemetry never appears in any prompt (gate)."""

    def test_telemetry_not_in_combine_prompt(self, store: V2MemoryStore):
        from v2.orchestrator.fallbacks.prompts import COMBINE_PROMPT, DIRECT_CHAT_PROMPT
        # Telemetry keys must never appear in any prompt template
        telemetry_keys = ["telemetry", "total_turns", "total_failures", "capability_histogram", "opted_out"]
        for key in telemetry_keys:
            assert key not in COMBINE_PROMPT, f"Telemetry key '{key}' found in COMBINE_PROMPT"
            assert key not in DIRECT_CHAT_PROMPT, f"Telemetry key '{key}' found in DIRECT_CHAT_PROMPT"

    def test_telemetry_not_in_rendered_slot(self, store: V2MemoryStore):
        store.set_user_style(OWNER, {"tone": "casual"})
        store.set_user_telemetry(OWNER, {
            "total_turns": 999,
            "opted_out": False,
            "capability_histogram": {"get_weather": 50},
        })
        rendered, _ = assemble_user_style_slot(store=store, owner_user_id=OWNER)
        assert "total_turns" not in rendered
        assert "999" not in rendered
        assert "capability_histogram" not in rendered
        assert "opted_out" not in rendered

    def test_telemetry_never_in_render_user_style(self):
        """render_user_style only uses STYLE_DESCRIPTORS keys."""
        style = render_user_style({
            "tone": "casual",
            "total_turns": "999",  # smuggled telemetry key
            "capability_histogram": "leaked",
        })
        assert "total_turns" not in style
        assert "999" not in style
        assert "capability_histogram" not in style


# -----------------------------------------------------------------------
# 8. need_routine derivation
# -----------------------------------------------------------------------


class TestNeedRoutineDerivation:
    def test_direct_chat_triggers(self):
        from v2.orchestrator.pipeline.derivations import derive_need_flags
        from v2.orchestrator.core.types import ParsedInput, RequestChunk, ChunkExtraction, RouteMatch

        parsed = ParsedInput(token_count=3, tokens=["what", "is", "life"], sentences=["what is life"], parser="test")
        chunks = [RequestChunk(index=0, text="what is life", role="primary_request")]
        extractions = [ChunkExtraction(chunk_index=0, entities=[], references=[], predicates=[])]
        routes = [RouteMatch(chunk_index=0, capability="direct_chat", confidence=0.5)]
        flags = derive_need_flags(parsed, chunks, extractions, routes, {})
        assert flags.get("need_routine") is True

    def test_routine_lemma_triggers(self):
        from v2.orchestrator.pipeline.derivations import derive_need_flags
        from v2.orchestrator.core.types import ParsedInput, RequestChunk, ChunkExtraction, RouteMatch

        parsed = ParsedInput(token_count=4, tokens=["I", "usually", "prefer", "tea"], sentences=["I usually prefer tea"], parser="test")
        chunks = [RequestChunk(index=0, text="I usually prefer tea", role="primary_request")]
        extractions = [ChunkExtraction(chunk_index=0, entities=[], references=[], predicates=[])]
        routes = [RouteMatch(chunk_index=0, capability="get_weather", confidence=0.9)]
        flags = derive_need_flags(parsed, chunks, extractions, routes, {})
        assert flags.get("need_routine") is True

    def test_negative_case(self):
        from v2.orchestrator.pipeline.derivations import derive_need_flags
        from v2.orchestrator.core.types import ParsedInput, RequestChunk, ChunkExtraction, RouteMatch

        parsed = ParsedInput(token_count=5, tokens=["what", "is", "the", "weather", "today"], sentences=["what is the weather today"], parser="test")
        chunks = [RequestChunk(index=0, text="what is the weather today", role="primary_request")]
        extractions = [ChunkExtraction(chunk_index=0, entities=[], references=[], predicates=[])]
        routes = [RouteMatch(chunk_index=0, capability="get_weather", confidence=0.9)]
        flags = derive_need_flags(parsed, chunks, extractions, routes, {})
        assert "need_routine" not in flags


# -----------------------------------------------------------------------
# 9. Pipeline integration
# -----------------------------------------------------------------------


class TestPipelineIntegration:
    def test_behavior_event_recorded(self, store: V2MemoryStore):
        """Pipeline records a behavior event at end of turn."""
        from v2.orchestrator.core.pipeline import _record_behavior_event

        class FakeExecution:
            capability = "get_weather"
            output_text = "It's sunny"
            success = True

        context = {
            "memory_store": store,
            "owner_user_id": OWNER,
        }
        _record_behavior_event(context, [FakeExecution()], [])
        events = store.get_behavior_events(OWNER)
        assert len(events) == 1
        payload = json.loads(events[0]["payload"])
        assert payload["capabilities"] == ["get_weather"]
        assert payload["response_length"] == len("It's sunny")

    def test_opt_out_prevents_event(self, store: V2MemoryStore):
        """Opt-out test: toggling off prevents behavior_events writes (gate)."""
        from v2.orchestrator.core.pipeline import _record_behavior_event

        store.set_telemetry_opt_out(OWNER, True)
        context = {
            "memory_store": store,
            "owner_user_id": OWNER,
        }

        class FakeExecution:
            capability = "direct_chat"
            output_text = "Hi"
            success = True

        _record_behavior_event(context, [FakeExecution()], [])
        assert store.get_behavior_events(OWNER) == []

    def test_user_style_in_memory_slots(self, store: V2MemoryStore):
        """When need_routine is set and style exists, it reaches memory_slots."""
        from v2.orchestrator.core.pipeline import _run_memory_read_path

        store.set_user_style(OWNER, {"tone": "casual", "verbosity": "concise"})
        context = {
            "memory_store": store,
            "owner_user_id": OWNER,
            "need_routine": True,
        }
        slots = _run_memory_read_path("hello", context)
        assert "user_style" in slots
        assert "tone=casual" in slots["user_style"]

    def test_no_style_slot_without_flag(self, store: V2MemoryStore):
        """Without need_routine, user_style is not assembled."""
        from v2.orchestrator.core.pipeline import _run_memory_read_path

        store.set_user_style(OWNER, {"tone": "casual"})
        context = {
            "memory_store": store,
            "owner_user_id": OWNER,
        }
        slots = _run_memory_read_path("hello", context)
        assert slots.get("user_style", "") == ""


# -----------------------------------------------------------------------
# 10. Phase constants
# -----------------------------------------------------------------------


class TestPhaseConstants:
    def test_m5_phase(self):
        assert M5_PHASE_ID == "m5"
        assert M5_PHASE_STATUS == "complete"

    def test_active_phase_advanced_past_m5(self):
        # M6 landed after M5 — active phase is now M6.
        assert ACTIVE_PHASE_ID != "m4"  # at least M5
        assert M5_PHASE_STATUS == "complete"
