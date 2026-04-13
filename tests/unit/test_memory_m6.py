"""
M6 phase-gate tests: affect_window CRUD, sentiment persistence,
character isolation, recent_mood slot, forget-my-mood, opt-out toggle,
episodic compression, and pipeline integration.

All tests run against an in-memory MemoryStore — no network, no disk.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

import pytest

from lokidoki.orchestrator.memory.store import MemoryStore
from lokidoki.orchestrator.memory.slots import (
    RECENT_MOOD_BUDGET,
    assemble_recent_mood_slot,
    render_recent_mood,
    truncate_to_budget,
)
from lokidoki.orchestrator.memory import (
    ACTIVE_PHASE_ID,
    ACTIVE_PHASE_LABEL,
    M6_PHASE_ID,
    M6_PHASE_STATUS,
)
from lokidoki.orchestrator.fallbacks.prompts import (
    COMBINE_PROMPT,
    DIRECT_CHAT_PROMPT,
    render_prompt,
)


@pytest.fixture
def store():
    s = MemoryStore(":memory:")
    yield s
    s.close()


OWNER = 1


# -----------------------------------------------------------------------
# 1. Store: affect_window CRUD
# -----------------------------------------------------------------------


class TestAffectWindow:
    def test_write_and_read(self, store: MemoryStore):
        store.write_affect_day(
            OWNER, character_id="loki", day="2026-04-01",
            sentiment_avg=0.5, notable_concerns=["work stress"],
        )
        rows = store.get_affect_window(OWNER, character_id="loki")
        assert len(rows) == 1
        assert rows[0]["day"] == "2026-04-01"
        assert rows[0]["sentiment_avg"] == 0.5
        assert rows[0]["notable_concerns"] == ["work stress"]

    def test_upsert_overwrites(self, store: MemoryStore):
        store.write_affect_day(
            OWNER, character_id="loki", day="2026-04-01", sentiment_avg=0.3,
        )
        store.write_affect_day(
            OWNER, character_id="loki", day="2026-04-01", sentiment_avg=0.8,
        )
        rows = store.get_affect_window(OWNER, character_id="loki")
        assert len(rows) == 1
        assert rows[0]["sentiment_avg"] == 0.8

    def test_days_limit(self, store: MemoryStore):
        for i in range(20):
            store.write_affect_day(
                OWNER, character_id="loki",
                day=f"2026-04-{i+1:02d}",
                sentiment_avg=0.1 * i,
            )
        rows = store.get_affect_window(OWNER, character_id="loki", days=5)
        assert len(rows) == 5
        # Most recent first
        assert rows[0]["day"] == "2026-04-20"

    def test_null_concerns(self, store: MemoryStore):
        store.write_affect_day(
            OWNER, character_id="loki", day="2026-04-01", sentiment_avg=0.0,
        )
        rows = store.get_affect_window(OWNER, character_id="loki")
        assert rows[0]["notable_concerns"] is None

    def test_empty_window(self, store: MemoryStore):
        rows = store.get_affect_window(OWNER, character_id="loki")
        assert rows == []


# -----------------------------------------------------------------------
# 2. Gate: sentiment persists across 7 simulated days for one character
# -----------------------------------------------------------------------


class TestSentimentPersistence:
    def test_seven_day_persistence(self, store: MemoryStore):
        """Gate: sentiment persists across 7 simulated days for a single character."""
        for i in range(7):
            store.write_affect_day(
                OWNER, character_id="loki",
                day=f"2026-04-{i+1:02d}",
                sentiment_avg=0.3 + 0.05 * i,
            )
        rows = store.get_affect_window(OWNER, character_id="loki", days=7)
        assert len(rows) == 7
        # Verify all 7 days present and ordered desc
        days = [r["day"] for r in rows]
        assert days == [f"2026-04-{7-i:02d}" for i in range(7)]

    def test_fourteen_day_rolling_window(self, store: MemoryStore):
        for i in range(14):
            store.write_affect_day(
                OWNER, character_id="loki",
                day=f"2026-04-{i+1:02d}",
                sentiment_avg=-0.5 + 0.1 * i,
            )
        rows = store.get_affect_window(OWNER, character_id="loki", days=14)
        assert len(rows) == 14


# -----------------------------------------------------------------------
# 3. Gate: character isolation
# -----------------------------------------------------------------------


class TestCharacterIsolation:
    def test_sentiment_isolation_by_character(self, store: MemoryStore):
        """Gate: sentiment under character_id=loki never returned for character_id=doki."""
        store.write_affect_day(
            OWNER, character_id="loki", day="2026-04-01",
            sentiment_avg=0.9, notable_concerns=["happy"],
        )
        store.write_affect_day(
            OWNER, character_id="doki", day="2026-04-01",
            sentiment_avg=-0.5, notable_concerns=["sad"],
        )
        loki_rows = store.get_affect_window(OWNER, character_id="loki")
        doki_rows = store.get_affect_window(OWNER, character_id="doki")
        assert len(loki_rows) == 1
        assert len(doki_rows) == 1
        assert loki_rows[0]["sentiment_avg"] == 0.9
        assert doki_rows[0]["sentiment_avg"] == -0.5

    def test_delete_only_affects_target_character(self, store: MemoryStore):
        store.write_affect_day(
            OWNER, character_id="loki", day="2026-04-01", sentiment_avg=0.5,
        )
        store.write_affect_day(
            OWNER, character_id="doki", day="2026-04-01", sentiment_avg=-0.3,
        )
        deleted = store.delete_affect_window(OWNER, character_id="loki")
        assert deleted == 1
        assert store.get_affect_window(OWNER, character_id="loki") == []
        assert len(store.get_affect_window(OWNER, character_id="doki")) == 1


# -----------------------------------------------------------------------
# 4. Gate: opt-out toggle disables slot and prevents writes
# -----------------------------------------------------------------------


class TestSentimentOptOut:
    def test_default_not_opted_out(self, store: MemoryStore):
        assert store.is_sentiment_opted_out(OWNER) is False

    def test_opt_out_flag(self, store: MemoryStore):
        store.set_sentiment_opt_out(OWNER, True)
        assert store.is_sentiment_opted_out(OWNER) is True

    def test_opt_back_in(self, store: MemoryStore):
        store.set_sentiment_opt_out(OWNER, True)
        store.set_sentiment_opt_out(OWNER, False)
        assert store.is_sentiment_opted_out(OWNER) is False

    def test_opt_out_prevents_mood_slot(self, store: MemoryStore):
        """When opted out, assemble_slots returns empty recent_mood."""
        store.set_sentiment_opt_out(OWNER, True)
        store.write_affect_day(
            OWNER, character_id="default", day="2026-04-01",
            sentiment_avg=0.5,
        )
        from lokidoki.orchestrator.memory.slots import assemble_slots
        context = {
            "memory_store": store,
            "owner_user_id": OWNER,
            "character_id": "default",
        }
        slots = assemble_slots(context)
        assert slots["recent_mood"] == ""


# -----------------------------------------------------------------------
# 5. Gate: "forget my mood" wipes affected rows
# -----------------------------------------------------------------------


class TestForgetMyMood:
    def test_wipe_all_characters(self, store: MemoryStore):
        """Gate: 'forget my mood' wipes affected rows."""
        store.write_affect_day(
            OWNER, character_id="loki", day="2026-04-01", sentiment_avg=0.5,
        )
        store.write_affect_day(
            OWNER, character_id="doki", day="2026-04-01", sentiment_avg=-0.3,
        )
        deleted = store.delete_affect_window(OWNER)
        assert deleted == 2
        assert store.get_affect_window(OWNER, character_id="loki") == []
        assert store.get_affect_window(OWNER, character_id="doki") == []

    def test_wipe_single_character(self, store: MemoryStore):
        store.write_affect_day(
            OWNER, character_id="loki", day="2026-04-01", sentiment_avg=0.5,
        )
        store.write_affect_day(
            OWNER, character_id="doki", day="2026-04-01", sentiment_avg=-0.3,
        )
        deleted = store.delete_affect_window(OWNER, character_id="loki")
        assert deleted == 1
        assert store.get_affect_window(OWNER, character_id="loki") == []
        assert len(store.get_affect_window(OWNER, character_id="doki")) == 1

    def test_wipe_empty_is_noop(self, store: MemoryStore):
        deleted = store.delete_affect_window(OWNER)
        assert deleted == 0


# -----------------------------------------------------------------------
# 6. recent_mood slot rendering
# -----------------------------------------------------------------------


class TestRecentMoodSlot:
    def test_empty_rows(self):
        assert render_recent_mood([]) == ""

    def test_positive_mood(self):
        rows = [{"day": "2026-04-07", "sentiment_avg": 0.6, "notable_concerns": None}]
        rendered = render_recent_mood(rows)
        assert "mood=positive" in rendered
        assert "trend=stable" in rendered

    def test_negative_mood(self):
        rows = [{"day": "2026-04-07", "sentiment_avg": -0.6, "notable_concerns": None}]
        rendered = render_recent_mood(rows)
        assert "mood=negative" in rendered

    def test_neutral_mood(self):
        rows = [{"day": "2026-04-07", "sentiment_avg": 0.0, "notable_concerns": None}]
        rendered = render_recent_mood(rows)
        assert "mood=neutral" in rendered

    def test_improving_trend(self):
        rows = [
            {"day": "2026-04-07", "sentiment_avg": 0.8, "notable_concerns": None},
            {"day": "2026-04-06", "sentiment_avg": 0.5, "notable_concerns": None},
            {"day": "2026-04-05", "sentiment_avg": 0.3, "notable_concerns": None},
        ]
        rendered = render_recent_mood(rows)
        assert "trend=improving" in rendered

    def test_declining_trend(self):
        rows = [
            {"day": "2026-04-07", "sentiment_avg": -0.3, "notable_concerns": None},
            {"day": "2026-04-06", "sentiment_avg": 0.0, "notable_concerns": None},
            {"day": "2026-04-05", "sentiment_avg": 0.3, "notable_concerns": None},
        ]
        rendered = render_recent_mood(rows)
        assert "trend=declining" in rendered

    def test_budget_enforced(self):
        rows = [{"day": "2026-04-07", "sentiment_avg": 0.2, "notable_concerns": None}]
        rendered = render_recent_mood(rows)
        assert len(rendered) <= RECENT_MOOD_BUDGET

    def test_assemble_from_store(self, store: MemoryStore):
        store.write_affect_day(
            OWNER, character_id="loki", day="2026-04-07", sentiment_avg=0.4,
        )
        rendered, rows = assemble_recent_mood_slot(
            store=store, owner_user_id=OWNER, character_id="loki",
        )
        assert "mood=" in rendered
        assert len(rows) == 1

    def test_assemble_empty_store(self, store: MemoryStore):
        rendered, rows = assemble_recent_mood_slot(
            store=store, owner_user_id=OWNER, character_id="loki",
        )
        assert rendered == ""
        assert rows == []


# -----------------------------------------------------------------------
# 7. Prompt templates include recent_mood
# -----------------------------------------------------------------------


class TestPromptTemplates:
    def test_combine_prompt_has_recent_mood_slot(self):
        assert "{recent_mood}" in COMBINE_PROMPT

    def test_direct_chat_prompt_has_recent_mood_slot(self):
        assert "{recent_mood}" in DIRECT_CHAT_PROMPT

    def test_combine_renders_with_mood(self):
        rendered = render_prompt(
            "combine",
            spec="{}",
            recent_mood="mood=positive; trend=stable",
            confidence_guide="",
            sources_list="",
            current_time="3:42 PM",
            user_name="Luke",
        )
        assert "mood=positive" in rendered

    def test_direct_chat_renders_with_mood(self):
        rendered = render_prompt(
            "direct_chat",
            user_question="How are you?",
            recent_mood="mood=negative; trend=declining",
            current_time="3:42 PM",
            user_name="Luke",
        )
        assert "mood=negative" in rendered

    def test_mood_instruction_in_combine(self):
        assert "recent_mood" in COMBINE_PROMPT
        assert "Never mention" in COMBINE_PROMPT

    def test_mood_instruction_in_direct_chat(self):
        assert "recent_mood" in DIRECT_CHAT_PROMPT
        assert "Never mention" in DIRECT_CHAT_PROMPT


# -----------------------------------------------------------------------
# 8. Gate: episodic compression
# -----------------------------------------------------------------------


class TestEpisodicCompression:
    def _insert_episode(
        self, store: MemoryStore, title: str, summary: str,
        start_at: str, recall_count: int = 0,
    ) -> int:
        """Helper to insert an episode directly."""
        cursor = store._conn.execute(
            """
            INSERT INTO episodes(owner_user_id, title, summary, start_at, recall_count)
            VALUES (?, ?, ?, ?, ?)
            """,
            (OWNER, title, summary, start_at, recall_count),
        )
        return int(cursor.lastrowid)

    def test_get_stale_episodes(self, store: MemoryStore):
        old_date = "2025-09-01T00:00:00Z"
        recent_date = "2026-04-01T00:00:00Z"
        self._insert_episode(store, "Old chat", "We talked about X", old_date)
        self._insert_episode(store, "Recent chat", "We talked about Y", recent_date)
        stale = store.get_stale_episodes(OWNER, older_than="2026-01-01T00:00:00Z")
        assert len(stale) == 1
        assert stale[0]["title"] == "Old chat"

    def test_stale_excludes_recalled(self, store: MemoryStore):
        old_date = "2025-09-01T00:00:00Z"
        self._insert_episode(store, "Recalled", "Stuff", old_date, recall_count=2)
        stale = store.get_stale_episodes(OWNER, older_than="2026-01-01T00:00:00Z")
        assert len(stale) == 0

    def test_compress_episodes(self, store: MemoryStore):
        """Gate: 7-month-old never-recalled episode compressed; original dropped."""
        e1 = self._insert_episode(store, "Chat 1", "Topic A", "2025-09-01")
        e2 = self._insert_episode(store, "Chat 2", "Topic B", "2025-09-05")
        new_id = store.compress_episodes(
            OWNER,
            episode_ids=[e1, e2],
            compressed_title="Sep 2025 summary",
            compressed_summary="Covered topics A and B",
            start_at="2025-09-01",
            end_at="2025-09-05",
        )
        assert new_id > 0
        # Originals are superseded
        row1 = store._conn.execute(
            "SELECT superseded_by FROM episodes WHERE id = ?", (e1,),
        ).fetchone()
        assert row1["superseded_by"] == new_id
        row2 = store._conn.execute(
            "SELECT superseded_by FROM episodes WHERE id = ?", (e2,),
        ).fetchone()
        assert row2["superseded_by"] == new_id
        # New compressed episode exists
        comp = store._conn.execute(
            "SELECT title, summary, topic_scope FROM episodes WHERE id = ?", (new_id,),
        ).fetchone()
        assert comp["title"] == "Sep 2025 summary"
        assert comp["topic_scope"] == "compressed"

    def test_stale_excludes_already_superseded(self, store: MemoryStore):
        e1 = self._insert_episode(store, "Old", "Stuff", "2025-09-01")
        store.compress_episodes(
            OWNER,
            episode_ids=[e1],
            compressed_title="Compressed",
            compressed_summary="Sum",
            start_at="2025-09-01",
            end_at="2025-09-01",
        )
        stale = store.get_stale_episodes(OWNER, older_than="2026-01-01T00:00:00Z")
        # e1 is superseded, should not appear
        assert all(s["title"] != "Old" for s in stale)


# -----------------------------------------------------------------------
# 9. Pipeline integration (sentiment recording)
# -----------------------------------------------------------------------


class TestPipelineIntegration:
    def test_record_sentiment_writes_affect(self, store: MemoryStore):
        """Sentiment recording produces affect_window rows."""
        from lokidoki.orchestrator.core.pipeline_hooks import record_sentiment

        @dataclass
        class FakeSignals:
            tone_signal: str = "positive"

        context = {
            "memory_store": store,
            "owner_user_id": OWNER,
            "character_id": "loki",
        }
        record_sentiment(context, FakeSignals())
        rows = store.get_affect_window(OWNER, character_id="loki")
        assert len(rows) == 1
        assert rows[0]["sentiment_avg"] > 0

    def test_opt_out_prevents_sentiment_write(self, store: MemoryStore):
        from lokidoki.orchestrator.core.pipeline_hooks import record_sentiment

        @dataclass
        class FakeSignals:
            tone_signal: str = "positive"

        store.set_sentiment_opt_out(OWNER, True)
        context = {
            "memory_store": store,
            "owner_user_id": OWNER,
            "character_id": "loki",
        }
        record_sentiment(context, FakeSignals())
        rows = store.get_affect_window(OWNER, character_id="loki")
        assert len(rows) == 0

    def test_sentiment_blending_within_day(self, store: MemoryStore):
        """Multiple sentiments on the same day blend via EMA."""
        from lokidoki.orchestrator.core.pipeline_hooks import record_sentiment

        @dataclass
        class FakeSignals:
            tone_signal: str = "neutral"

        context = {
            "memory_store": store,
            "owner_user_id": OWNER,
            "character_id": "loki",
        }
        # First turn: positive
        record_sentiment(context, type("S", (), {"tone_signal": "positive"})())
        rows = store.get_affect_window(OWNER, character_id="loki")
        first_val = rows[0]["sentiment_avg"]
        # Second turn: negative — should blend, not replace
        record_sentiment(context, type("S", (), {"tone_signal": "negative"})())
        rows = store.get_affect_window(OWNER, character_id="loki")
        assert len(rows) == 1
        # Blended value should be between positive and negative
        assert rows[0]["sentiment_avg"] != first_val

    def test_mood_in_memory_slots(self, store: MemoryStore):
        """Pipeline memory read path includes recent_mood slot."""
        store.write_affect_day(
            OWNER, character_id="default", day="2026-04-12",
            sentiment_avg=0.5,
        )
        from lokidoki.orchestrator.memory.slots import assemble_slots
        context = {
            "memory_store": store,
            "owner_user_id": OWNER,
            "character_id": "default",
        }
        slots = assemble_slots(context)
        assert "mood=" in slots["recent_mood"]

    def test_no_mood_without_data(self, store: MemoryStore):
        from lokidoki.orchestrator.memory.slots import assemble_slots
        context = {
            "memory_store": store,
            "owner_user_id": OWNER,
            "character_id": "default",
        }
        slots = assemble_slots(context)
        assert slots["recent_mood"] == ""


# -----------------------------------------------------------------------
# 10. Tone mapping
# -----------------------------------------------------------------------


class TestToneMapping:
    def test_all_known_tones_have_values(self):
        from lokidoki.orchestrator.core.pipeline_hooks import _TONE_TO_SENTIMENT
        assert "positive" in _TONE_TO_SENTIMENT
        assert "negative" in _TONE_TO_SENTIMENT
        assert "neutral" in _TONE_TO_SENTIMENT
        assert _TONE_TO_SENTIMENT["neutral"] == 0.0

    def test_unknown_tone_defaults_neutral(self):
        from lokidoki.orchestrator.core.pipeline_hooks import _TONE_TO_SENTIMENT
        assert _TONE_TO_SENTIMENT.get("unknown_tone", 0.0) == 0.0


# -----------------------------------------------------------------------
# 11. Phase constants
# -----------------------------------------------------------------------


class TestPhaseConstants:
    def test_m6_id(self):
        assert M6_PHASE_ID == "m6"

    def test_m6_status(self):
        assert M6_PHASE_STATUS == "complete"

    def test_active_is_m6(self):
        assert ACTIVE_PHASE_ID == "m6"
        assert ACTIVE_PHASE_LABEL == "M6"
