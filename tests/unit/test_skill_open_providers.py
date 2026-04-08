"""Smoke tests for the keyless weather + movies skills.

These mock the network layer and assert that the skills produce the
same shape of result as their paid counterparts (TMDB / OWM) so the
synthesis layer can stay provider-agnostic.
"""
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from lokidoki.skills.weather_openmeteo.skill import OpenMeteoSkill
from lokidoki.skills.movies_wiki.skill import WikiMoviesSkill, _query_candidates


GEO_RESPONSE = {
    "results": [
        {"name": "Seattle", "country_code": "US", "latitude": 47.6, "longitude": -122.3}
    ]
}
FORECAST_RESPONSE = {
    "current": {
        "temperature_2m": 12.3,
        "apparent_temperature": 10.0,
        "relative_humidity_2m": 80,
        "wind_speed_10m": 5.0,
        "weather_code": 3,
    }
}


class TestOpenMeteo:
    @pytest.mark.anyio
    async def test_success(self):
        skill = OpenMeteoSkill()
        responses = [
            MagicMock(status_code=200, json=MagicMock(return_value=GEO_RESPONSE)),
            MagicMock(status_code=200, json=MagicMock(return_value=FORECAST_RESPONSE)),
        ]
        with patch("httpx.AsyncClient.get", new_callable=AsyncMock, side_effect=responses):
            res = await skill.execute_mechanism("open_meteo", {"location": "Seattle"})
        assert res.success
        assert res.data["location"] == "Seattle, US"
        assert res.data["temperature"] == 12.3
        assert res.data["condition"] == "overcast"

    @pytest.mark.anyio
    async def test_orchestrator_merges_config_into_location_param(self):
        # The orchestrator's run_skills resolves user config into the
        # ``location`` param BEFORE calling the skill. This test
        # confirms the skill itself only needs a single read.
        skill = OpenMeteoSkill()
        responses = [
            MagicMock(status_code=200, json=MagicMock(return_value=GEO_RESPONSE)),
            MagicMock(status_code=200, json=MagicMock(return_value=FORECAST_RESPONSE)),
        ]
        with patch("httpx.AsyncClient.get", new_callable=AsyncMock, side_effect=responses):
            res = await skill.execute_mechanism(
                "open_meteo", {"location": "Seattle"}
            )
        assert res.success

    @pytest.mark.anyio
    async def test_missing_location(self):
        skill = OpenMeteoSkill()
        res = await skill.execute_mechanism("open_meteo", {})
        assert res.success is False

    @pytest.mark.anyio
    async def test_us_zip_uses_zippopotam_fallback(self):
        skill = OpenMeteoSkill()
        zippo_response = MagicMock(
            status_code=200,
            json=MagicMock(return_value={
                "country abbreviation": "US",
                "places": [{
                    "place name": "Milford",
                    "latitude": "41.22",
                    "longitude": "-73.06",
                }],
            }),
        )
        forecast_response = MagicMock(
            status_code=200, json=MagicMock(return_value=FORECAST_RESPONSE)
        )
        with patch(
            "httpx.AsyncClient.get",
            new_callable=AsyncMock,
            side_effect=[zippo_response, forecast_response],
        ):
            res = await skill.execute_mechanism("open_meteo", {"location": "06461"})
        assert res.success
        assert res.data["location"] == "Milford, US"
        assert res.data["temperature"] == 12.3

    @pytest.mark.anyio
    async def test_no_geo_match(self):
        skill = OpenMeteoSkill()
        empty = MagicMock(status_code=200, json=MagicMock(return_value={"results": []}))
        with patch("httpx.AsyncClient.get", new_callable=AsyncMock, return_value=empty):
            res = await skill.execute_mechanism("open_meteo", {"location": "xyzzz"})
        assert res.success is False
        assert "no geocode match" in res.error


# Wikipedia search → summary fixtures. The skill makes a search call
# first, then a summary fetch on the top hit, so we feed the mock a
# matching pair via side_effect.
WIKI_SEARCH_RESPONSE = {
    "query": {
        "search": [
            {"title": "Inception"},
        ]
    }
}
WIKI_SUMMARY_RESPONSE = {
    "type": "standard",
    "title": "Inception",
    "description": "2010 film by Christopher Nolan",
    "extract": "Inception is a 2010 science fiction action film written and directed by Christopher Nolan. It has a running time of 148 minutes.",
    "content_urls": {"desktop": {"page": "https://en.wikipedia.org/wiki/Inception"}},
}


class TestWikiMovies:
    @pytest.mark.anyio
    async def test_success(self):
        skill = WikiMoviesSkill()
        search = MagicMock(status_code=200, json=MagicMock(return_value=WIKI_SEARCH_RESPONSE))
        summary = MagicMock(status_code=200, json=MagicMock(return_value=WIKI_SUMMARY_RESPONSE))
        with patch(
            "httpx.AsyncClient.get",
            new_callable=AsyncMock,
            side_effect=[search, summary],
        ):
            res = await skill.execute_mechanism("wiki_api", {"query": "inception"})
        assert res.success
        assert res.data["title"] == "Inception"
        assert res.data["release_date"].startswith("2010")
        assert res.data["runtime_min"] == 148
        assert "2010 film" in (res.data["genre"] or "").lower()

    @pytest.mark.anyio
    async def test_no_results(self):
        skill = WikiMoviesSkill()
        empty = MagicMock(
            status_code=200,
            json=MagicMock(return_value={"query": {"search": []}}),
        )
        with patch("httpx.AsyncClient.get", new_callable=AsyncMock, return_value=empty):
            res = await skill.execute_mechanism("wiki_api", {"query": "xyzzznotamovie"})
        assert res.success is False

    @pytest.mark.anyio
    async def test_missing_query(self):
        skill = WikiMoviesSkill()
        res = await skill.execute_mechanism("wiki_api", {})
        assert res.success is False

    @pytest.mark.anyio
    async def test_skips_disambiguation_pages(self):
        """Wikipedia returns 200 for 'Avatar' with type=disambiguation —
        the skill must skip those and try the next hit, otherwise
        natural-language movie queries return junk like the Hindu deity.
        """
        skill = WikiMoviesSkill()
        search = MagicMock(
            status_code=200,
            json=MagicMock(return_value={
                "query": {"search": [
                    {"title": "Avatar"},  # disambiguation page
                    {"title": "Avatar (2009 film)"},  # actual film
                ]}
            }),
        )
        disambig = MagicMock(
            status_code=200,
            json=MagicMock(return_value={
                "type": "disambiguation",
                "title": "Avatar (disambiguation)",
                "description": "Topics referred to by the same term",
            }),
        )
        film = MagicMock(
            status_code=200,
            json=MagicMock(return_value={
                "type": "standard",
                "title": "Avatar (2009 film)",
                "description": "2009 film by James Cameron",
                "extract": "Avatar is a 2009 epic science fiction film co-produced and directed by James Cameron.",
                "content_urls": {"desktop": {"page": "https://en.wikipedia.org/wiki/Avatar_(2009_film)"}},
            }),
        )
        with patch(
            "httpx.AsyncClient.get",
            new_callable=AsyncMock,
            side_effect=[search, disambig, film],
        ):
            res = await skill.execute_mechanism("wiki_api", {"query": "Avatar"})
        assert res.success
        assert res.data["title"] == "Avatar"  # disambig suffix stripped
        assert "James Cameron" in res.data["overview"]

    @pytest.mark.anyio
    async def test_skips_non_film_topics(self):
        """A page whose description doesn't mention 'film' must be
        rejected — repro for "Avatar" matching the Hindu deity.
        """
        skill = WikiMoviesSkill()
        search = MagicMock(
            status_code=200,
            json=MagicMock(return_value={
                "query": {"search": [
                    {"title": "Avatar"},
                    {"title": "Avatar (2009 film)"},
                ]}
            }),
        )
        deity = MagicMock(
            status_code=200,
            json=MagicMock(return_value={
                "type": "standard",
                "title": "Avatar",
                "description": "Concept in Hinduism",
                "extract": "Avatar is a concept in Hinduism representing a material manifestation of a deity.",
            }),
        )
        film = MagicMock(
            status_code=200,
            json=MagicMock(return_value={
                "type": "standard",
                "title": "Avatar (2009 film)",
                "description": "2009 film by James Cameron",
                "extract": "Avatar is a 2009 epic film by James Cameron.",
                "content_urls": {"desktop": {"page": "https://en.wikipedia.org/wiki/Avatar_(2009_film)"}},
            }),
        )
        with patch(
            "httpx.AsyncClient.get",
            new_callable=AsyncMock,
            side_effect=[search, deity, film],
        ):
            res = await skill.execute_mechanism("wiki_api", {"query": "Avatar"})
        assert res.success
        assert "James Cameron" in res.data["overview"]
        assert res.data["title"] == "Avatar"

    @pytest.mark.anyio
    async def test_natural_language_query_reduces_and_succeeds(self):
        """Repro for 'how long is the latest avatar movie'.

        Each candidate triggers a fresh search call. We mock the first
        few searches as empty so the skill walks down the candidate
        list, then return a hit on a later candidate.
        """
        skill = WikiMoviesSkill()
        empty_search = MagicMock(
            status_code=200,
            json=MagicMock(return_value={"query": {"search": []}}),
        )
        good_search = MagicMock(
            status_code=200,
            json=MagicMock(return_value=WIKI_SEARCH_RESPONSE),
        )
        good_summary = MagicMock(
            status_code=200,
            json=MagicMock(return_value=WIKI_SUMMARY_RESPONSE),
        )
        with patch(
            "httpx.AsyncClient.get",
            new_callable=AsyncMock,
            side_effect=[empty_search, empty_search, good_search, good_summary],
        ) as mock_get:
            # Note: avoid "latest/newest/most recent" wording — that
            # flips the skill into want_latest mode which token-matches
            # the candidate against the hit title. The Inception fixture
            # would never match an avatar candidate, and this test is
            # exercising candidate-reduction, not the latest-year ranker.
            res = await skill.execute_mechanism(
                "wiki_api",
                {"query": "how long is the avatar movie"},
            )
        assert res.success is True
        assert mock_get.call_count >= 3

    @pytest.mark.anyio
    async def test_lead_includes_runtime_for_verbatim_fast_path(self):
        skill = WikiMoviesSkill()
        search = MagicMock(status_code=200, json=MagicMock(return_value=WIKI_SEARCH_RESPONSE))
        summary = MagicMock(status_code=200, json=MagicMock(return_value=WIKI_SUMMARY_RESPONSE))
        with patch(
            "httpx.AsyncClient.get",
            new_callable=AsyncMock,
            side_effect=[search, summary],
        ):
            res = await skill.execute_mechanism("wiki_api", {"query": "inception"})
        assert res.success
        lead = res.data["lead"]
        assert "Inception" in lead
        assert "2010" in lead
        assert "2h 28m" in lead


class TestQueryCandidates:
    """Direct unit tests on the reduction helper.

    These cover the realistic decomposer phrasings the skill sees in
    production. Each line is a regression test for a real failure
    mode the integration test class above can't easily express.
    """

    def test_clean_title_unchanged(self):
        cands = _query_candidates("Inception")
        assert cands[0] == "Inception"

    def test_strips_how_long_is(self):
        cands = _query_candidates("how long is the latest avatar movie")
        # The reduced form should not contain "how long is".
        assert any("avatar" in c.lower() and "how long" not in c.lower() for c in cands)

    def test_strips_the_latest(self):
        cands = _query_candidates("how long is the latest avatar movie")
        # And it should eventually drop "the latest" too.
        assert any("the latest" not in c.lower() for c in cands)

    def test_strips_trailing_movie(self):
        cands = _query_candidates("avatar movie")
        assert "avatar" in cands

    def test_strips_tell_me_about(self):
        cands = _query_candidates("tell me about the movie inception")
        assert any(c.lower() == "inception" for c in cands)

    def test_when_did_x_come_out(self):
        cands = _query_candidates("when did the matrix come out")
        # Stripping "when did" leaves "the matrix come out" — not perfect
        # but good enough for iTunes to match "the matrix".
        assert any("matrix" in c.lower() and "when did" not in c.lower() for c in cands)

    def test_dedup_preserves_order(self):
        cands = _query_candidates("Inception")
        assert len(cands) == len(set(c.lower() for c in cands))

    def test_empty_input(self):
        assert _query_candidates("") == []
        assert _query_candidates("   ") == []
