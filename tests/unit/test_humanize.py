"""Tests for the humanize formatting helpers used by the synthesis prompt."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from lokidoki.core.humanize import (
    _fact_phrase,
    aggregate_sentiment_arc,
    format_memory_block,
    relative_time,
)


NOW = datetime(2026, 4, 8, 12, 0, 0, tzinfo=timezone.utc)


def _ts(delta: timedelta) -> str:
    """SQLite-style 'YYYY-MM-DD HH:MM:SS' string at NOW + delta."""
    dt = NOW + delta
    return dt.strftime("%Y-%m-%d %H:%M:%S")


class TestRelativeTime:
    def test_just_now(self):
        assert relative_time(_ts(timedelta(seconds=-30)), now=NOW) == "just now"

    def test_minutes_ago(self):
        assert relative_time(_ts(timedelta(minutes=-5)), now=NOW) == "5 minutes ago"

    def test_one_hour_ago(self):
        assert relative_time(_ts(timedelta(hours=-1)), now=NOW) == "1 hour ago"

    def test_yesterday(self):
        assert relative_time(_ts(timedelta(days=-1)), now=NOW) == "yesterday"

    def test_days_ago(self):
        assert relative_time(_ts(timedelta(days=-3)), now=NOW) == "3 days ago"

    def test_last_week(self):
        assert relative_time(_ts(timedelta(days=-9)), now=NOW) == "last week"

    def test_weeks_ago(self):
        assert relative_time(_ts(timedelta(days=-21)), now=NOW) == "3 weeks ago"

    def test_last_month(self):
        assert relative_time(_ts(timedelta(days=-45)), now=NOW) == "last month"

    def test_months_ago(self):
        assert relative_time(_ts(timedelta(days=-120)), now=NOW) == "4 months ago"

    def test_invalid_returns_empty(self):
        assert relative_time("not a date", now=NOW) == ""
        assert relative_time(None, now=NOW) == ""

    def test_future_returns_just_now(self):
        # We don't lie about the future — if a clock skewed the data,
        # call it "just now" rather than emitting "-3 days ago".
        assert relative_time(_ts(timedelta(seconds=30)), now=NOW) == "just now"


class TestFactPhrase:
    def test_self_fact(self):
        assert (
            _fact_phrase({
                "subject": "self", "subject_type": "self",
                "predicate": "loves", "value": "coffee",
            })
            == "you loves coffee"
        )

    def test_person_fact(self):
        assert (
            _fact_phrase({
                "subject": "luke", "subject_type": "person",
                "predicate": "loves", "value": "movies",
            })
            == "luke loves movies"
        )

    def test_entity_fact(self):
        assert (
            _fact_phrase({
                "subject": "biodome", "subject_type": "entity",
                "predicate": "was", "value": "pretty good",
            })
            == "biodome was pretty good"
        )

    def test_underscore_predicate_normalized(self):
        assert (
            _fact_phrase({
                "subject": "self", "subject_type": "self",
                "predicate": "is_named", "value": "Jesse",
            })
            == "you is named Jesse"
        )

    def test_empty_when_predicate_or_value_missing(self):
        assert _fact_phrase({"subject": "self", "predicate": "", "value": "x"}) == ""
        assert _fact_phrase({"subject": "self", "predicate": "p", "value": ""}) == ""


class TestFormatMemoryBlock:
    def test_facts_only(self):
        block = format_memory_block(
            facts=[{
                "subject": "biodome", "subject_type": "entity",
                "predicate": "was", "value": "pretty good",
                "valid_from": _ts(timedelta(days=-3)),
            }],
            past_messages=[],
            now=NOW,
        )
        assert "FACTS:" in block
        assert "3 days ago" in block
        assert "biodome was pretty good" in block
        assert "FROM_OLDER_SESSIONS" not in block

    def test_messages_only(self):
        block = format_memory_block(
            facts=[],
            past_messages=[{
                "id": 1, "content": "what is the movie with ryan reynolds",
                "created_at": _ts(timedelta(days=-5)),
            }],
            now=NOW,
        )
        assert "FROM_OLDER_SESSIONS" in block
        assert "5 days ago" in block
        assert "ryan reynolds" in block
        assert "FACTS:" not in block

    def test_both_sources(self):
        block = format_memory_block(
            facts=[{
                "subject": "self", "subject_type": "self",
                "predicate": "loves", "value": "coffee",
                "valid_from": _ts(timedelta(days=-1)),
            }],
            past_messages=[{
                "id": 1, "content": "biodome was pretty good",
                "created_at": _ts(timedelta(days=-2)),
            }],
            now=NOW,
        )
        assert "FACTS:" in block
        assert "FROM_OLDER_SESSIONS" in block
        assert "yesterday" in block
        assert "2 days ago" in block

    def test_empty_returns_empty_string(self):
        assert format_memory_block(facts=[], past_messages=[], now=NOW) == ""

    def test_long_message_truncated(self):
        long = "x" * 200
        block = format_memory_block(
            facts=[],
            past_messages=[{"id": 1, "content": long, "created_at": _ts(timedelta(days=-1))}],
            now=NOW,
        )
        assert "..." in block
        assert "x" * 200 not in block

    def test_caps_respected(self):
        many_facts = [
            {
                "subject": "self", "subject_type": "self",
                "predicate": "p", "value": f"v{i}",
                "valid_from": _ts(timedelta(days=-i - 1)),
            }
            for i in range(20)
        ]
        block = format_memory_block(
            facts=many_facts, past_messages=[], now=NOW, max_facts=3
        )
        # Three lines under FACTS: header
        lines = [l for l in block.split("\n") if l.startswith("- ")]
        assert len(lines) == 3


class TestAggregateSentimentArc:
    def test_empty_returns_empty(self):
        assert aggregate_sentiment_arc([]) == ""

    def test_dominant_sentiment(self):
        rows = [
            {"sentiment": "frustrated"},
            {"sentiment": "frustrated"},
            {"sentiment": "frustrated"},
            {"sentiment": "neutral"},
        ]
        assert aggregate_sentiment_arc(rows) == "frustrated"

    def test_single_off_mood_not_an_arc(self):
        """A single frustrated turn is noise, not a trend."""
        rows = [
            {"sentiment": "frustrated"},
            {"sentiment": "neutral"},
            {"sentiment": "neutral"},
        ]
        assert aggregate_sentiment_arc(rows) == ""

    def test_neutral_not_returned(self):
        rows = [{"sentiment": "neutral"}, {"sentiment": "neutral"}]
        assert aggregate_sentiment_arc(rows) == ""

    def test_window_respected(self):
        # 5 frustrated rows outside the window, 1 happy in the window:
        # not enough happy occurrences to qualify.
        rows = [{"sentiment": "happy"}] + [{"sentiment": "frustrated"}] * 5
        assert aggregate_sentiment_arc(rows, window=1) == ""
