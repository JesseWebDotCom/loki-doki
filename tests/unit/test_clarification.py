"""Tests for the cross-skill clarification state machine."""
from __future__ import annotations

import time

import pytest

from lokidoki.core.clarification import (
    ClarificationCache,
    PendingClarification,
    resolve_choice,
)


THEATERS = [
    "Cinemark Connecticut Post 14 and IMAX",
    "AMC Marquis 16",
    "AMC Danbury 16",
    "Apple Cinemas Brass Mill",
    "Cinemark North Haven and XD",
]


# ---------- resolve_choice -------------------------------------------------


class TestResolveChoiceOrdinal:
    def test_word_ordinal_first(self):
        assert resolve_choice("first", THEATERS) == THEATERS[0]

    def test_word_ordinal_with_filler(self):
        # Filler words ("the", "one", "please") must not block the
        # ordinal match — common natural-speech phrasing.
        assert resolve_choice("the second one", THEATERS) == THEATERS[1]
        assert resolve_choice("third please", THEATERS) == THEATERS[2]
        assert resolve_choice("number 4", THEATERS) == THEATERS[3]

    def test_digit_ordinal(self):
        assert resolve_choice("1", THEATERS) == THEATERS[0]
        assert resolve_choice("#3", THEATERS) == THEATERS[2]

    def test_ordinal_out_of_range_returns_none(self):
        assert resolve_choice("seventh", THEATERS) is None
        assert resolve_choice("99", THEATERS) is None


class TestResolveChoiceNameMatching:
    def test_exact_match(self):
        assert resolve_choice("AMC Marquis 16", THEATERS) == "AMC Marquis 16"

    def test_case_and_whitespace_insensitive(self):
        assert resolve_choice("  amc   MARQUIS  16  ", THEATERS) == "AMC Marquis 16"

    def test_user_says_short_name(self):
        # The user almost never repeats the full Fandango name —
        # "AMC Marquis" should still resolve to "AMC Marquis 16".
        assert resolve_choice("AMC Marquis", THEATERS) == "AMC Marquis 16"

    def test_user_elaborates(self):
        # Reverse direction: option contained in input.
        assert (
            resolve_choice("the cinemark connecticut post one", THEATERS)
            == "Cinemark Connecticut Post 14 and IMAX"
        )

    def test_single_token_disambiguates(self):
        # Only one theater contains the word "marquis" — token match
        # should land on it even though "AMC" alone wouldn't.
        assert resolve_choice("marquis", THEATERS) == "AMC Marquis 16"
        assert resolve_choice("danbury", THEATERS) == "AMC Danbury 16"

    def test_ambiguous_substring_returns_none(self):
        # Two theaters start with "AMC" and two contain "Cinemark".
        # The matcher must NOT guess; the orchestrator decides what
        # to do (re-ask, fall through, etc.).
        assert resolve_choice("AMC", THEATERS) is None
        # "Cinemark" alone matches both Cinemark theaters — they're
        # the same length-class, so the shortest-option tiebreak fails.
        assert resolve_choice("Cinemark", THEATERS) is None

    def test_no_match_returns_none(self):
        assert resolve_choice("the regal cinema", THEATERS) is None
        assert resolve_choice("", THEATERS) is None
        assert resolve_choice("   ", THEATERS) is None


class TestResolveChoiceEdgeCases:
    def test_empty_options(self):
        assert resolve_choice("first", []) is None

    def test_ordinal_takes_precedence_over_substring(self):
        # If the user says "first" and an option literally contains
        # the word "first", the ordinal interpretation must win
        # (because the user almost certainly meant the first item).
        opts = ["The First Cinema", "AMC Marquis 16", "Regal"]
        assert resolve_choice("first", opts) == "The First Cinema"  # both interpretations agree
        # Now flip the order so ordinal and substring disagree:
        opts = ["AMC Marquis 16", "The First Cinema", "Regal"]
        assert resolve_choice("first", opts) == "AMC Marquis 16"  # ordinal wins → index 0


# ---------- ClarificationCache --------------------------------------------


class TestClarificationCache:
    def test_round_trip(self):
        cache = ClarificationCache()
        pending = PendingClarification(
            field="theater", options=THEATERS,
            skill_id="movies_fandango",
            intent="movies_fandango.get_showtimes",
            original_params={"date": "2026-04-08"},
        )
        cache.set(42, pending)
        got = cache.get(42)
        assert got is not None
        assert got.options == THEATERS
        assert got.original_params == {"date": "2026-04-08"}

    def test_ttl_expiry(self):
        cache = ClarificationCache()
        pending = PendingClarification(
            field="theater", options=THEATERS,
            skill_id="x", intent="x.y", original_params={},
            ttl_seconds=0,  # already expired
        )
        cache.set(1, pending)
        # A zero-TTL entry created in the past tick should be filtered
        # on the next read. Sleep just enough to push past the boundary.
        time.sleep(0.001)
        assert cache.get(1) is None

    def test_clear(self):
        cache = ClarificationCache()
        cache.set(7, PendingClarification(
            field="x", options=["a"], skill_id="s", intent="i", original_params={},
        ))
        cache.clear(7)
        assert cache.get(7) is None

    def test_session_isolation(self):
        cache = ClarificationCache()
        cache.set(1, PendingClarification(
            field="theater", options=["A"], skill_id="s", intent="i", original_params={},
        ))
        cache.set(2, PendingClarification(
            field="movie", options=["B"], skill_id="s", intent="i", original_params={},
        ))
        assert cache.get(1).field == "theater"
        assert cache.get(2).field == "movie"


# ---------- skill-side: clarification emission ----------------------------


class TestSkillClarificationEmission:
    """End-to-end check that the fandango skill emits the right shape."""

    @pytest.mark.anyio
    async def test_multi_theater_no_pref_emits_clarification(self):
        # Three theaters, no preferred_theater, no `theater` ask param
        # → skill must emit needs_clarification with all three names.
        from unittest.mock import patch
        from lokidoki.skills.movies_fandango.skill import FandangoShowtimesSkill

        payload = {
            "theaters": [
                {
                    "name": "Cinemark Connecticut Post 14 and IMAX",
                    "id": "1", "sluggedName": "ccp14",
                    "movies": [{"title": "Hoppers", "mopURI": "/hop/movie-overview",
                                "variants": [{"amenityGroups": [{"showtimes": [
                                    {"ticketingDate": "2026-04-08+19:00",
                                     "screenReaderTime": "7:00 PM"},
                                ]}]}]}],
                },
                {
                    "name": "AMC Marquis 16",
                    "id": "2", "sluggedName": "amc-marquis",
                    "movies": [{"title": "Hoppers", "mopURI": "/hop/movie-overview",
                                "variants": [{"amenityGroups": [{"showtimes": [
                                    {"ticketingDate": "2026-04-08+19:30",
                                     "screenReaderTime": "7:30 PM"},
                                ]}]}]}],
                },
                {
                    "name": "AMC Danbury 16",
                    "id": "3", "sluggedName": "amc-danbury",
                    "movies": [{"title": "Hoppers", "mopURI": "/hop/movie-overview",
                                "variants": [{"amenityGroups": [{"showtimes": [
                                    {"ticketingDate": "2026-04-08+20:00",
                                     "screenReaderTime": "8:00 PM"},
                                ]}]}]}],
                },
            ],
        }

        async def fake_fetch(self, url, referer=""):
            return payload, None

        skill = FandangoShowtimesSkill()
        with patch.object(FandangoShowtimesSkill, "_fetch_json", new=fake_fetch):
            r = await skill.execute_mechanism(
                "napi_theaters_with_showtimes",
                {"_config": {"default_zip": "06461"}, "date": "2026-04-08"},
            )
        assert r.success
        clarif = r.data.get("needs_clarification")
        assert clarif is not None, "skill failed to emit clarification on multi-theater result"
        assert clarif["field"] == "theater"
        assert "AMC Marquis 16" in clarif["options"]
        assert "Cinemark Connecticut Post 14 and IMAX" in clarif["options"]
        # The lead must be the speakable form, not the rich Markdown
        # bullet list — this is the question the TTS layer will read.
        assert "theater" in r.data["lead"].lower() or "number" in r.data["lead"].lower()

    @pytest.mark.anyio
    async def test_explicit_theater_param_filters_and_skips_clarification(self):
        # When the orchestrator (or a future decomposer) injects
        # `theater=AMC Marquis`, the skill must filter to that theater
        # and produce a normal lead — NO clarification block.
        from unittest.mock import patch
        from lokidoki.skills.movies_fandango.skill import FandangoShowtimesSkill

        payload = {
            "theaters": [
                {"name": "Cinemark Connecticut Post 14 and IMAX",
                 "id": "1", "sluggedName": "ccp14",
                 "movies": [{"title": "Hoppers", "mopURI": "/h/movie-overview",
                             "variants": [{"amenityGroups": [{"showtimes": [
                                 {"ticketingDate": "2026-04-08+19:00", "screenReaderTime": "7:00 PM"},
                             ]}]}]}]},
                {"name": "AMC Marquis 16",
                 "id": "2", "sluggedName": "amc-m",
                 "movies": [{"title": "Hoppers", "mopURI": "/h/movie-overview",
                             "variants": [{"amenityGroups": [{"showtimes": [
                                 {"ticketingDate": "2026-04-08+19:30", "screenReaderTime": "7:30 PM"},
                             ]}]}]}]},
            ],
        }

        async def fake_fetch(self, url, referer=""):
            return payload, None

        skill = FandangoShowtimesSkill()
        with patch.object(FandangoShowtimesSkill, "_fetch_json", new=fake_fetch):
            r = await skill.execute_mechanism(
                "napi_theaters_with_showtimes",
                {"_config": {"default_zip": "06461"}, "theater": "AMC Marquis"},
            )
        assert r.success
        assert "needs_clarification" not in r.data
        # Filtered to the one matching theater
        assert len(r.data["theaters"]) == 1
        assert r.data["theaters"][0]["name"] == "AMC Marquis 16"
        # Lead names the chosen theater
        assert "AMC Marquis 16" in r.data["lead"]

    @pytest.mark.anyio
    async def test_preferred_theater_skips_clarification(self):
        # When preferred_theater is set in config and matches a theater,
        # no clarification is emitted (the user has already told us).
        from unittest.mock import patch
        from lokidoki.skills.movies_fandango.skill import FandangoShowtimesSkill

        payload = {
            "theaters": [
                {"name": "Cinemark Connecticut Post 14 and IMAX",
                 "id": "1", "sluggedName": "ccp14",
                 "movies": [{"title": "Hoppers", "mopURI": "/h/movie-overview",
                             "variants": [{"amenityGroups": [{"showtimes": [
                                 {"ticketingDate": "2026-04-08+19:00", "screenReaderTime": "7:00 PM"},
                             ]}]}]}]},
                {"name": "AMC Marquis 16",
                 "id": "2", "sluggedName": "amc-m",
                 "movies": [{"title": "Hoppers", "mopURI": "/h/movie-overview",
                             "variants": [{"amenityGroups": [{"showtimes": [
                                 {"ticketingDate": "2026-04-08+19:30", "screenReaderTime": "7:30 PM"},
                             ]}]}]}]},
            ],
        }

        async def fake_fetch(self, url, referer=""):
            return payload, None

        skill = FandangoShowtimesSkill()
        with patch.object(FandangoShowtimesSkill, "_fetch_json", new=fake_fetch):
            r = await skill.execute_mechanism(
                "napi_theaters_with_showtimes",
                {"_config": {"default_zip": "06461",
                             "preferred_theater": "cinemark connecticut post"}},
            )
        assert r.success
        assert "needs_clarification" not in r.data

    @pytest.mark.anyio
    async def test_single_theater_skips_clarification(self):
        from unittest.mock import patch
        from lokidoki.skills.movies_fandango.skill import FandangoShowtimesSkill

        payload = {
            "theaters": [
                {"name": "Only Theater", "id": "1", "sluggedName": "only",
                 "movies": [{"title": "X", "mopURI": "/x/movie-overview",
                             "variants": [{"amenityGroups": [{"showtimes": [
                                 {"ticketingDate": "2026-04-08+19:00", "screenReaderTime": "7:00 PM"},
                             ]}]}]}]},
            ],
        }

        async def fake_fetch(self, url, referer=""):
            return payload, None

        skill = FandangoShowtimesSkill()
        with patch.object(FandangoShowtimesSkill, "_fetch_json", new=fake_fetch):
            r = await skill.execute_mechanism(
                "napi_theaters_with_showtimes",
                {"_config": {"default_zip": "06461"}},
            )
        assert r.success
        assert "needs_clarification" not in r.data
