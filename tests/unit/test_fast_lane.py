"""Unit tests for the fast-lane (Phase 1 mature pattern matcher)."""
from __future__ import annotations

from lokidoki.orchestrator.pipeline.fast_lane import check_fast_lane


def test_fast_lane_matches_canonical_greeting():
    result = check_fast_lane("hello")
    assert result.matched is True
    assert result.capability == "greeting_response"


def test_fast_lane_matches_punctuated_greeting():
    result = check_fast_lane("hello!")
    assert result.matched is True
    assert result.capability == "greeting_response"


def test_fast_lane_matches_thanks_variants():
    for variant in ("thanks", "thank you", "appreciate it", "got it"):
        assert check_fast_lane(variant).matched is True


def test_fast_lane_matches_time_query_variants():
    for variant in ("what time is it", "what's the time", "current time"):
        assert check_fast_lane(variant).capability == "get_current_time"


def test_fast_lane_matches_date_query_variants():
    for variant in ("what day is it", "what's the date", "what is today"):
        assert check_fast_lane(variant).capability == "get_current_date"


def test_fast_lane_matches_spelling_with_or_without_prefix():
    assert check_fast_lane("spell restaurant").capability == "spell_word"
    assert check_fast_lane("how do you spell restaurant").capability == "spell_word"
    assert check_fast_lane("how would you spell restaurant").capability == "spell_word"


def test_fast_lane_matches_math_word_operators():
    result = check_fast_lane("what is 6 times 4")
    assert result.matched is True
    assert result.response_text == "24"


def test_fast_lane_matches_math_percent_form():
    result = check_fast_lane("what is 15 percent of 80")
    assert result.matched is True
    assert result.response_text == "12"


def test_fast_lane_falls_through_on_compound_request():
    result = check_fast_lane("hello and what time is it")
    assert result.matched is False
    assert result.reason == "compound"


def test_fast_lane_falls_through_on_subordinate_clause():
    result = check_fast_lane("what time is it because im late")
    assert result.matched is False
    assert result.reason == "compound"


def test_fast_lane_falls_through_on_long_utterance():
    result = check_fast_lane("tell me a long elaborate story about a knight on a quest")
    assert result.matched is False
    assert result.reason == "too_long"


def test_fast_lane_returns_empty_reason_for_blank_input():
    result = check_fast_lane("   ")
    assert result.matched is False
    assert result.reason == "empty"
