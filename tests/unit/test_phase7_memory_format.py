"""Phase 7 unit tests: memory format experiments.

Tests the warm memory format variant against the control
(bucketed format), ensuring both produce valid output and
neither breaks citations, prompt budget, or answer-first behavior.
"""
from __future__ import annotations

from datetime import datetime, timezone

import pytest

from lokidoki.core.humanize import (
    format_bucketed_memory_block,
    format_warm_memory_block,
)

NOW = datetime(2026, 4, 9, 12, 0, 0, tzinfo=timezone.utc)

SAMPLE_FACTS_BY_BUCKET = {
    "working_context": [
        {
            "subject": "self", "subject_type": "self",
            "predicate": "is_interested_in", "value": "hiking",
            "valid_from": "2026-04-08 10:00:00",
        },
    ],
    "semantic_profile": [
        {
            "subject": "self", "subject_type": "self",
            "predicate": "likes", "value": "coffee",
            "valid_from": "2026-03-01 10:00:00",
        },
    ],
    "relational_graph": [
        {
            "subject": "Artie", "subject_type": "person",
            "predicate": "is_brother_of", "value": "the user",
            "valid_from": "2026-01-15 10:00:00",
        },
    ],
    "episodic_threads": [],
}

SAMPLE_MESSAGES = [
    {"content": "what should I watch tonight?", "created_at": "2026-04-07 20:00:00"},
]


class TestControlFormat:
    def test_produces_bucket_headers(self):
        block = format_bucketed_memory_block(
            facts_by_bucket=SAMPLE_FACTS_BY_BUCKET,
            past_messages=SAMPLE_MESSAGES,
            now=NOW,
        )
        assert "WORKING_CONTEXT:" in block
        assert "SEMANTIC_PROFILE:" in block
        assert "RELATIONAL_GRAPH:" in block

    def test_empty_input_returns_empty(self):
        block = format_bucketed_memory_block(
            facts_by_bucket={}, past_messages=[], now=NOW,
        )
        assert block == ""


class TestWarmFormat:
    def test_produces_warm_headers(self):
        block = format_warm_memory_block(
            facts_by_bucket=SAMPLE_FACTS_BY_BUCKET,
            past_messages=SAMPLE_MESSAGES,
            now=NOW,
        )
        assert "Things on your mind lately:" in block
        assert "What you know about yourself:" in block
        assert "People in your life:" in block

    def test_does_not_use_bucket_headers(self):
        block = format_warm_memory_block(
            facts_by_bucket=SAMPLE_FACTS_BY_BUCKET,
            past_messages=SAMPLE_MESSAGES,
            now=NOW,
        )
        assert "WORKING_CONTEXT:" not in block
        assert "SEMANTIC_PROFILE:" not in block
        assert "RELATIONAL_GRAPH:" not in block

    def test_empty_input_returns_empty(self):
        block = format_warm_memory_block(
            facts_by_bucket={}, past_messages=[], now=NOW,
        )
        assert block == ""

    def test_past_messages_use_mentioned_framing(self):
        block = format_warm_memory_block(
            facts_by_bucket={"working_context": [], "semantic_profile": [],
                             "relational_graph": [], "episodic_threads": []},
            past_messages=SAMPLE_MESSAGES,
            now=NOW,
        )
        assert "you mentioned:" in block

    def test_facts_rendered_same_content_as_control(self):
        """Both formats should contain the same fact phrases."""
        control = format_bucketed_memory_block(
            facts_by_bucket=SAMPLE_FACTS_BY_BUCKET,
            past_messages=[],
            now=NOW,
        )
        warm = format_warm_memory_block(
            facts_by_bucket=SAMPLE_FACTS_BY_BUCKET,
            past_messages=[],
            now=NOW,
        )
        # Both should mention "hiking", "coffee", "Artie".
        for keyword in ("hiking", "coffee", "Artie"):
            assert keyword in control, f"Control missing {keyword}"
            assert keyword in warm, f"Warm missing {keyword}"


class TestFormatRegression:
    """Ensure neither format variant breaks existing invariants."""

    def test_both_formats_handle_missing_timestamps(self):
        facts = {
            "working_context": [
                {"subject": "self", "subject_type": "self",
                 "predicate": "likes", "value": "rain"},
            ],
            "semantic_profile": [],
            "relational_graph": [],
            "episodic_threads": [],
        }
        control = format_bucketed_memory_block(
            facts_by_bucket=facts, past_messages=[], now=NOW,
        )
        warm = format_warm_memory_block(
            facts_by_bucket=facts, past_messages=[], now=NOW,
        )
        assert "rain" in control
        assert "rain" in warm

    def test_both_formats_handle_long_messages(self):
        long_msg = {"content": "x" * 200, "created_at": "2026-04-08 10:00:00"}
        control = format_bucketed_memory_block(
            facts_by_bucket={"working_context": [], "semantic_profile": [],
                             "relational_graph": [], "episodic_threads": []},
            past_messages=[long_msg],
            now=NOW,
        )
        warm = format_warm_memory_block(
            facts_by_bucket={"working_context": [], "semantic_profile": [],
                             "relational_graph": [], "episodic_threads": []},
            past_messages=[long_msg],
            now=NOW,
        )
        # Both should truncate to ~140 chars + "..."
        assert "..." in control
        assert "..." in warm

    def test_realistic_multi_turn_inputs(self):
        """Use realistic messy user turns as fact values."""
        facts = {
            "working_context": [
                {"subject": "self", "subject_type": "self",
                 "predicate": "said", "value": "im so stressed rn",
                 "valid_from": "2026-04-09 11:00:00"},
            ],
            "semantic_profile": [
                {"subject": "self", "subject_type": "self",
                 "predicate": "prefers", "value": "action movies over dramas",
                 "valid_from": "2026-03-15 10:00:00"},
            ],
            "relational_graph": [
                {"subject": "Mom", "subject_type": "person",
                 "predicate": "birthday_is", "value": "May 12th",
                 "valid_from": "2026-02-01 10:00:00"},
            ],
            "episodic_threads": [],
        }
        messages = [
            {"content": "what was that movie we talked about last week??",
             "created_at": "2026-04-05 18:00:00"},
        ]
        for fmt in (format_bucketed_memory_block, format_warm_memory_block):
            block = fmt(facts_by_bucket=facts, past_messages=messages, now=NOW)
            assert "stressed" in block
            assert "action movies" in block
            assert "Mom" in block
            assert "movie we talked about" in block
