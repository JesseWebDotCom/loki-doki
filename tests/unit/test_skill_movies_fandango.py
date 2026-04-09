"""Tests for the multi-mechanism Fandango skill.

Each mechanism has its own happy-path test plus the relevant failure
modes (missing param, HTTP error, empty parse). Network is fully mocked
via ``httpx.AsyncClient`` patching — no real Fandango calls.
"""
import json
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from lokidoki.skills.movies_fandango import _parse as P
from lokidoki.skills.movies_fandango.skill import FandangoShowtimesSkill

FIXTURE_DIR = Path(__file__).parent.parent / "fixtures"
NAPI_FIXTURE = json.loads((FIXTURE_DIR / "fandango_napi_06461.json").read_text())


# ---------- fixtures + html samples -----------------------------------------

ZIP_PAGE_HTML = """
<html><body>
  <a href="/hoppers-2026-241416/movie-overview">Hoppers (2026)</a>
  <a href="/the-super-mario-galaxy-movie-2026-242307/movie-overview">The Super Mario Galaxy Movie (2026)</a>
  <a href="/hoppers-2026-241416/movie-overview?date=2026-04-08">Hoppers (2026)</a>
  <a href="/coming-soon">x</a>
</body></html>
"""

MOVIE_OVERVIEW_HTML = """
<html><body>
<script type="application/ld+json">
{"@context":"http://schema.org","@type":"Movie","name":"Hoppers (2026)",
 "duration":105,"contentRating":"PG","genre":"Animated,Comedy",
 "datePublished":"2026-03-06","description":"Talk to animals.",
 "director":[{"@type":"Person","name":"Daniel Chong"}],
 "aggregateRating":{"@type":"AggregateRating","ratingValue":94},
 "url":"https://www.fandango.com/hoppers-2026-241416/movie-overview",
 "image":"https://x/img.jpg"}
</script>
</body></html>
"""

THEATER_PAGE_HTML = """
<html><body>
<script type="application/ld+json">
{"@context":"http://schema.org","@type":"MovieTheater","name":"AMC Summit 16",
 "telephone":"205-555-0100",
 "address":{"@type":"PostalAddress","streetAddress":"321 Summit Blvd.",
            "addressLocality":"Birmingham","addressRegion":"AL","postalCode":"35243"},
 "url":"https://www.fandango.com/amc-summit-16-aahln/theater-page"}
</script>
<a href="/hoppers-2026-241416/movie-overview">Hoppers (2026)</a>
<a href="/the-drama-2026-243663/movie-overview">The Drama (2026)</a>
</body></html>
"""

THEATER_LIST_HTML = """
<html><body>
  <a href="/amc-summit-16-aahln/theater-page">AMC Summit 16</a>
  <a href="/regal-union-square-aabcd/theater-page">Regal Union Square</a>
</body></html>
"""

GLOBAL_PAGE_HTML = """
<html><body>
  <a href="/avatar-3-2026-999999/movie-overview">Avatar 3 (2026)</a>
  <a href="/dune-3-2027-888888/movie-overview">Dune Part Three (2027)</a>
</body></html>
"""

EMPTY_HTML = "<html><body>nothing here</body></html>"


def _mk_response(status_code: int, text: str) -> MagicMock:
    response = MagicMock()
    response.status_code = status_code
    response.text = text
    return response


def _patch_get(response):
    client = MagicMock()
    client.get = AsyncMock(return_value=response)
    cm = MagicMock()
    cm.__aenter__ = AsyncMock(return_value=client)
    cm.__aexit__ = AsyncMock(return_value=None)
    return cm


def _patch_async_client(response):
    return patch(
        "lokidoki.skills.movies_fandango.skill.httpx.AsyncClient",
        return_value=_patch_get(response),
    )


@pytest.fixture
def skill():
    return FandangoShowtimesSkill()


# ---------- parser unit tests -----------------------------------------------

class TestParsers:
    def test_movie_anchors_dedupe(self):
        results = P.extract_movie_anchors(ZIP_PAGE_HTML)
        assert [r["title"] for r in results] == [
            "Hoppers",
            "The Super Mario Galaxy Movie",
        ]
        assert results[0]["slug"] == "hoppers-2026-241416"
        assert results[0]["snippet"] == ""
        assert results[0]["url"].endswith("/hoppers-2026-241416/movie-overview")

    def test_movie_anchors_empty(self):
        assert P.extract_movie_anchors("<html></html>") == []

    def test_theater_anchors(self):
        results = P.extract_theater_anchors(THEATER_LIST_HTML)
        assert {r["slug"] for r in results} == {
            "amc-summit-16-aahln", "regal-union-square-aabcd",
        }
        assert results[0]["url"].endswith("/theater-page")

    def test_movie_details_from_jsonld(self):
        details = P.extract_movie_details(MOVIE_OVERVIEW_HTML)
        assert details["title"] == "Hoppers"
        assert details["runtime_minutes"] == 105
        assert details["content_rating"] == "PG"
        assert details["director"] == "Daniel Chong"
        assert details["audience_score"] == 94
        assert "Talk to animals" in details["synopsis"]

    def test_movie_details_h1_fallback(self):
        details = P.extract_movie_details("<h1>Some Title</h1>")
        assert details == {"title": "Some Title"}

    def test_movie_details_empty(self):
        assert P.extract_movie_details(EMPTY_HTML) == {}

    def test_theater_details(self):
        details = P.extract_theater_details(THEATER_PAGE_HTML)
        assert details["name"] == "AMC Summit 16"
        assert "Birmingham" in details["address"]
        assert details["telephone"] == "205-555-0100"

    def test_theater_details_empty(self):
        assert P.extract_theater_details(EMPTY_HTML) == {}

    def test_jsonld_movies_screening_event(self):
        html = """
        <script type="application/ld+json">
        [{"@type":"ScreeningEvent","name":"Avatar","startDate":"2026-04-08T19:00",
          "location":{"@type":"Place","name":"AMC Empire 25"}}]
        </script>"""
        results = P.extract_jsonld_movies(html)
        assert len(results) == 1
        assert "AMC Empire 25" in results[0]["snippet"]

    def test_jsonld_movies_skips_theater_event(self):
        html = '<script type="application/ld+json">{"@type":"TheaterEvent","name":"06461"}</script>'
        assert P.extract_jsonld_movies(html) == []

    def test_text_fallback(self):
        results = P.extract_text_fallback("<div>Hoppers 7:00pm 9:30pm</div>")
        assert results
        assert "7:00pm" in results[0]["snippet"]

    def test_extract_zip_variants(self):
        assert P.extract_zip("11201") == "11201"
        assert P.extract_zip("Brooklyn, NY 11201") == "11201"
        assert P.extract_zip("11201-2345") == "11201"
        assert P.extract_zip("") == ""
        assert P.extract_zip("nope") == ""

    def test_filter_terms(self):
        assert P.filter_terms("what time is the movie Hoppers playing") == ["hoppers"]
        assert "avatar" in P.filter_terms("tell me about the cast of Avatar")

    def test_matches_query(self):
        assert P.matches_query("anything", []) is True
        assert P.matches_query("Hoppers (2026)", ["hoppers"]) is True
        assert P.matches_query("Avatar", ["hoppers"]) is False


# ---------- mechanism: list_now_playing -------------------------------------

class TestListNowPlaying:
    @pytest.mark.anyio
    async def test_zip_success(self, skill):
        with _patch_async_client(_mk_response(200, ZIP_PAGE_HTML)):
            r = await skill.execute_mechanism(
                "list_now_playing",
                {"_config": {"default_zip": "06461"}, "date": "2026-04-08"},
            )
        assert r.success
        assert r.data["location"] == "06461"
        assert r.data["date"] == "2026-04-08"
        assert len(r.data["showtimes"]) == 2
        assert "06461" in r.source_url
        # Lead must list real titles so the 9B synthesizer has something
        # to grind on — not the previous "06461: Now playing" placeholder
        # that produced "Movie: Now playing Now playing Now playing".
        assert r.data["lead"].startswith("Now playing: ")
        assert "Hoppers" in r.data["lead"]
        assert "The Super Mario Galaxy Movie" in r.data["lead"]

    @pytest.mark.anyio
    async def test_city_state_success(self, skill):
        with _patch_async_client(_mk_response(200, ZIP_PAGE_HTML)):
            r = await skill.execute_mechanism(
                "list_now_playing", {"city": "New York", "state": "NY"},
            )
        assert r.success
        assert r.data["location"] == "new-york_ny"
        assert "new-york_ny_movietimes" in r.source_url

    @pytest.mark.anyio
    async def test_missing_zip_and_city(self, skill):
        r = await skill.execute_mechanism("list_now_playing", {})
        assert not r.success
        assert "ZIP" in r.error

    @pytest.mark.anyio
    async def test_http_error(self, skill):
        with _patch_async_client(_mk_response(503, "")):
            r = await skill.execute_mechanism(
                "list_now_playing", {"_config": {"default_zip": "06461"}},
            )
        assert not r.success
        assert "503" in r.error

    @pytest.mark.anyio
    async def test_empty_html(self, skill):
        with _patch_async_client(_mk_response(200, EMPTY_HTML)):
            r = await skill.execute_mechanism(
                "list_now_playing", {"_config": {"default_zip": "06461"}},
            )
        assert not r.success
        assert "no parseable" in r.error


# ---------- mechanism: fandango_web (legacy) --------------------------------

class TestFandangoWebLegacy:
    @pytest.mark.anyio
    async def test_filters_to_query(self, skill):
        with _patch_async_client(_mk_response(200, ZIP_PAGE_HTML)):
            r = await skill.execute_mechanism(
                "fandango_web",
                {"query": "is Hoppers playing", "_config": {"default_zip": "06461"}},
            )
        assert r.success
        assert len(r.data["showtimes"]) == 1
        assert r.data["showtimes"][0]["title"] == "Hoppers"
        # Filtered legacy path must still produce a usable lead — the
        # synthesizer-eats-junk bug we hit before came from a lead like
        # "Hoppers: Now playing" being repeated. Assert the lead
        # actually mentions the matched title.
        assert "Hoppers" in r.data["lead"]

    @pytest.mark.anyio
    async def test_no_match_returns_top(self, skill):
        with _patch_async_client(_mk_response(200, ZIP_PAGE_HTML)):
            r = await skill.execute_mechanism(
                "fandango_web",
                {"query": "Nonexistent", "_config": {"default_zip": "06461"}},
            )
        assert r.success
        assert len(r.data["showtimes"]) == 2

    @pytest.mark.anyio
    async def test_requires_query(self, skill):
        r = await skill.execute_mechanism("fandango_web", {})
        assert not r.success
        assert "Query" in r.error


# ---------- mechanism: global_now_playing + coming_soon ---------------------

class TestGlobalAndComingSoon:
    @pytest.mark.anyio
    async def test_global_success(self, skill):
        with _patch_async_client(_mk_response(200, GLOBAL_PAGE_HTML)):
            r = await skill.execute_mechanism("global_now_playing", {})
        assert r.success
        assert len(r.data["movies"]) == 2
        assert r.source_url.endswith("/movies-in-theaters")
        # Lead is a list-style sentence with real titles, not a placeholder.
        assert r.data["lead"].startswith("Now playing: ")
        assert "Avatar 3" in r.data["lead"]

    @pytest.mark.anyio
    async def test_global_empty(self, skill):
        with _patch_async_client(_mk_response(200, EMPTY_HTML)):
            r = await skill.execute_mechanism("global_now_playing", {})
        assert not r.success

    @pytest.mark.anyio
    async def test_coming_soon_success(self, skill):
        with _patch_async_client(_mk_response(200, GLOBAL_PAGE_HTML)):
            r = await skill.execute_mechanism("coming_soon", {})
        assert r.success
        assert r.data["scope"] == "coming_soon"
        assert r.source_url.endswith("/movies-coming-soon")
        assert "Avatar 3" in r.data["lead"]

    @pytest.mark.anyio
    async def test_coming_soon_empty(self, skill):
        with _patch_async_client(_mk_response(200, EMPTY_HTML)):
            r = await skill.execute_mechanism("coming_soon", {})
        assert not r.success


# ---------- mechanism: movie_overview ---------------------------------------

class TestMovieOverview:
    @pytest.mark.anyio
    async def test_explicit_slug(self, skill):
        with _patch_async_client(_mk_response(200, MOVIE_OVERVIEW_HTML)):
            r = await skill.execute_mechanism(
                "movie_overview", {"slug": "hoppers-2026-241416"},
            )
        assert r.success
        assert r.data["title"] == "Hoppers"
        assert r.data["runtime_minutes"] == 105
        # Lead must include title, rating, runtime, and genre — the
        # synthesizer relies on this for the verbatim/grounded path.
        lead = r.data["lead"]
        assert "Hoppers" in lead
        assert "PG" in lead
        assert "105 min" in lead
        assert "Animated" in lead

    @pytest.mark.anyio
    async def test_query_resolves_via_listing(self, skill):
        # First call (listing) and second call (overview) both go through
        # the patched client; both responses come from the same mock so
        # configure side_effect to return ZIP page then overview page.
        # Three side-effects: the napi probe inside _list_now_playing
        # consumes the first slot (and fails parsing because the mock
        # doesn't return valid JSON), then the HTML scrape fallback
        # consumes the ZIP listing, then the overview page is fetched
        # for slug → details resolution.
        client = MagicMock()
        client.get = AsyncMock(side_effect=[
            _mk_response(503, ""),
            _mk_response(200, ZIP_PAGE_HTML),
            _mk_response(200, MOVIE_OVERVIEW_HTML),
        ])
        cm = MagicMock()
        cm.__aenter__ = AsyncMock(return_value=client)
        cm.__aexit__ = AsyncMock(return_value=None)
        with patch(
            "lokidoki.skills.movies_fandango.skill.httpx.AsyncClient",
            return_value=cm,
        ):
            r = await skill.execute_mechanism(
                "movie_overview",
                {"query": "Hoppers", "_config": {"default_zip": "06461"}},
            )
        assert r.success
        assert r.data["slug"] == "hoppers-2026-241416"

    @pytest.mark.anyio
    async def test_missing_slug_and_query(self, skill):
        r = await skill.execute_mechanism("movie_overview", {})
        assert not r.success
        assert "slug" in r.error or "query" in r.error

    @pytest.mark.anyio
    async def test_unparseable_overview(self, skill):
        with _patch_async_client(_mk_response(200, EMPTY_HTML)):
            r = await skill.execute_mechanism(
                "movie_overview", {"slug": "hoppers-2026-241416"},
            )
        assert not r.success


# ---------- mechanism: movie_showtimes --------------------------------------

class TestMovieShowtimes:
    @pytest.mark.anyio
    async def test_with_slug_returns_movie_meta(self, skill):
        with _patch_async_client(_mk_response(200, MOVIE_OVERVIEW_HTML)):
            r = await skill.execute_mechanism(
                "movie_showtimes", {"slug": "hoppers-2026-241416", "date": "2026-04-08"},
            )
        assert r.success
        assert r.data["movie"]["title"] == "Hoppers"
        assert r.data["date"] == "2026-04-08"
        # Lead must mention the actual movie title so the synthesizer
        # has something concrete to anchor on. The "JS-rendered" copy is
        # just a tail explaining why the time grid may be empty — it
        # must NOT be the entire lead.
        lead = r.data["lead"]
        assert "Hoppers" in lead, f"lead missing title: {lead!r}"
        assert lead.split(":", 1)[0].strip(), f"lead has no leading title: {lead!r}"

    @pytest.mark.anyio
    async def test_missing_slug(self, skill):
        r = await skill.execute_mechanism("movie_showtimes", {})
        assert not r.success


# ---------- mechanism: theater_page + theater_showtimes ---------------------

class TestTheaterMechanisms:
    @pytest.mark.anyio
    async def test_theater_page_success(self, skill):
        with _patch_async_client(_mk_response(200, THEATER_PAGE_HTML)):
            r = await skill.execute_mechanism(
                "theater_page", {"slug": "amc-summit-16-aahln"},
            )
        assert r.success
        assert r.data["theater"]["name"] == "AMC Summit 16"
        assert len(r.data["movies"]) == 2
        # Lead names the theater AND quantifies the listing.
        assert "AMC Summit 16" in r.data["lead"]
        assert "2 movies" in r.data["lead"]

    @pytest.mark.anyio
    async def test_theater_page_requires_slug(self, skill):
        r = await skill.execute_mechanism("theater_page", {})
        assert not r.success
        assert "slug" in r.error

    @pytest.mark.anyio
    async def test_theater_showtimes_success(self, skill):
        with _patch_async_client(_mk_response(200, THEATER_PAGE_HTML)):
            r = await skill.execute_mechanism(
                "theater_showtimes", {"slug": "amc-summit-16-aahln"},
            )
        assert r.success
        assert len(r.data["showtimes"]) == 2
        assert r.data["theater"]["name"] == "AMC Summit 16"
        assert "AMC Summit 16" in r.data["lead"]
        assert "2 movies" in r.data["lead"]

    @pytest.mark.anyio
    async def test_theater_showtimes_empty(self, skill):
        with _patch_async_client(_mk_response(200, EMPTY_HTML)):
            r = await skill.execute_mechanism(
                "theater_showtimes", {"slug": "amc-summit-16-aahln"},
            )
        assert not r.success


# ---------- mechanism: local_cache ------------------------------------------

class TestLocalCache:
    @pytest.mark.anyio
    async def test_cache_round_trip(self, skill):
        with _patch_async_client(_mk_response(200, ZIP_PAGE_HTML)):
            await skill.execute_mechanism(
                "fandango_web",
                {"query": "Hoppers", "_config": {"default_zip": "06461"}},
            )
        cached = await skill.execute_mechanism("local_cache", {"query": "hoppers"})
        assert cached.success
        assert cached.data["showtimes"][0]["title"] == "Hoppers"

    @pytest.mark.anyio
    async def test_cache_miss(self, skill):
        r = await skill.execute_mechanism("local_cache", {"query": "missing"})
        assert not r.success

    @pytest.mark.anyio
    async def test_cache_no_query(self, skill):
        r = await skill.execute_mechanism("local_cache", {})
        assert not r.success


# ---------- mechanism: napi_theaters_with_showtimes -------------------------

def _patch_napi(payload, *, fail=False):
    """Patch the skill's napi JSON fetcher to return ``payload``.

    The mechanism calls ``self._fetch_json`` which itself wraps
    ``httpx.AsyncClient``; mocking the helper directly keeps the test
    focused on parsing + mechanism wiring instead of header plumbing.
    """
    async def fake(self, url, referer=""):
        if fail:
            from lokidoki.core.skill_executor import MechanismResult
            return None, MechanismResult(success=False, error="Fandango napi HTTP 503")
        return payload, None
    return patch.object(FandangoShowtimesSkill, "_fetch_json", new=fake)


class TestNapiParser:
    """parse_napi_theaters() against the saved live fixture."""

    def test_drops_expired_by_default(self):
        parsed = P.parse_napi_theaters(NAPI_FIXTURE)
        # Fixture has a mix of expired and live showtimes per movie.
        # Every surfaced showtime must be live (no expired flag) and
        # every movie must have at least one time, otherwise the lead
        # builder produces empty rows.
        for mv in parsed["movies"]:
            assert mv["theaters"], f"{mv['title']} kept with no theaters"
            for th in mv["theaters"]:
                assert th["times"], f"{mv['title']} @ {th['name']} empty"

    def test_keeps_expired_when_disabled(self):
        live_only = P.parse_napi_theaters(NAPI_FIXTURE)
        with_expired = P.parse_napi_theaters(NAPI_FIXTURE, drop_expired=False)
        # The fixture intentionally includes expired entries; the
        # full grid must contain strictly more showtime rows than the
        # filtered grid.
        live_count = sum(len(t["times"]) for mv in live_only["movies"] for t in mv["theaters"])
        full_count = sum(len(t["times"]) for mv in with_expired["movies"] for t in mv["theaters"])
        assert full_count > live_count

    def test_movie_centric_dedupe_across_theaters(self):
        # "The Drama (2026)" appears at both theaters in the fixture —
        # the movie-centric view should collapse it into a single entry
        # whose theaters list contains both venues.
        parsed = P.parse_napi_theaters(NAPI_FIXTURE)
        drama = next((m for m in parsed["movies"] if m["title"].startswith("The Drama")), None)
        assert drama is not None
        names = {t["name"] for t in drama["theaters"]}
        assert len(names) >= 2, f"expected dedupe across theaters, got {names}"

    def test_slug_extracted_from_mop_uri(self):
        parsed = P.parse_napi_theaters(NAPI_FIXTURE)
        for mv in parsed["movies"]:
            if mv["slug"]:
                # Slug should look like "title-year-id" — never contain
                # leading slashes or trailing /movie-overview.
                assert "/" not in mv["slug"]
                assert "movie-overview" not in mv["slug"]
                assert mv["url"].endswith(f"{mv['slug']}/movie-overview")

    def test_empty_payload_returns_empty_lists(self):
        assert P.parse_napi_theaters({}) == {"theaters": [], "movies": []}
        assert P.parse_napi_theaters(None) == {"theaters": [], "movies": []}  # type: ignore[arg-type]

    def test_lead_includes_real_times(self):
        parsed = P.parse_napi_theaters(NAPI_FIXTURE)
        lead = P.build_napi_lead(parsed, "06461")
        # Markdown header on its own line, then a blank line, then
        # theater-grouped bullets. The header is the *no-preference*
        # form because no preferred_theater was passed.
        assert lead.startswith("**Now playing in 06461**")
        assert "\n\n- " in lead, f"expected markdown bullet list, got: {lead!r}"
        # Time strings must appear nested under theaters.
        import re
        assert re.search(r"\d{1,2}:\d{2}\s?(AM|PM)", lead), f"no times in lead: {lead}"

    def test_lead_pins_preferred_theater_at_top(self):
        parsed = P.parse_napi_theaters(NAPI_FIXTURE)
        # The fixture has "Cinemark Connecticut Post 14 and IMAX" and
        # "AMC Marquis 16". A substring of the second one should pin
        # AMC to the highlighted block, even though Cinemark comes
        # first in the parsed list.
        lead = P.build_napi_lead(parsed, "06461", preferred_theater="amc marquis")
        assert "**AMC Marquis 16**" in lead
        # Header switches to "Tonight in" when a preference is honored.
        assert lead.startswith("**Tonight in 06461**")
        # AMC's highlighted block must appear before any "Also nearby"
        # section, and the highlighted block must come before Cinemark.
        amc_pos = lead.index("**AMC Marquis 16**")
        cinemark_pos = lead.index("Cinemark Connecticut Post 14 and IMAX")
        assert amc_pos < cinemark_pos
        assert "**Also nearby**" in lead

    def test_lead_no_truncation(self):
        # Synthesize a parsed payload with 30 theaters; every one must
        # appear in the lead — no "+N more" cap.
        parsed = {
            "theaters": [
                {
                    "name": f"Theater {i}",
                    "movies": [{"title": "Foo", "times": ["7:00 PM"]}],
                }
                for i in range(30)
            ],
            "movies": [],
        }
        lead = P.build_napi_lead(parsed, "X")
        for i in range(30):
            assert f"Theater {i}" in lead, f"theater {i} truncated from lead"
        assert "more" not in lead.lower() or "+" not in lead

    def test_times_deduped_and_sorted(self):
        # Build a synthetic payload where one movie has the same
        # 7:00 PM slot listed twice (different format variants — the
        # real-world cause is Standard vs Dolby vs IMAX) plus one
        # later slot. The parser must collapse the duplicate AND
        # return chronological order regardless of input order.
        payload = {
            "theaters": [{
                "name": "T", "id": "1", "sluggedName": "t",
                "movies": [{
                    "title": "Mario", "mopURI": "/mario-1/movie-overview",
                    "variants": [
                        {"amenityGroups": [{"showtimes": [
                            {"ticketingDate": "2026-04-08+19:00", "screenReaderTime": "7:00 PM"},
                        ]}]},
                        {"amenityGroups": [{"showtimes": [
                            {"ticketingDate": "2026-04-08+22:30", "screenReaderTime": "10:30 PM"},
                            {"ticketingDate": "2026-04-08+19:00", "screenReaderTime": "7:00 PM"},
                        ]}]},
                    ],
                }],
            }],
        }
        parsed = P.parse_napi_theaters(payload)
        assert len(parsed["theaters"]) == 1
        times = parsed["theaters"][0]["movies"][0]["times"]
        assert times == ["7:00 PM", "10:30 PM"], f"unexpected: {times}"

    def test_lead_unmatched_preference_falls_back_to_default(self):
        parsed = P.parse_napi_theaters(NAPI_FIXTURE)
        lead = P.build_napi_lead(parsed, "06461", preferred_theater="nonexistent")
        # No match → no highlight, default header.
        assert "🎬" not in lead
        assert lead.startswith("**Now playing in 06461**")
        # Must contain at least one HH:MM time string from the fixture —
        # this is the whole reason the rewrite exists.
        import re
        assert re.search(r"\d{1,2}:\d{2}\s?(AM|PM|a|p)", lead), f"no times in lead: {lead}"


class TestNapiMechanism:
    @pytest.mark.anyio
    async def test_success_returns_real_showtimes(self, skill):
        with _patch_napi(NAPI_FIXTURE):
            r = await skill.execute_mechanism(
                "napi_theaters_with_showtimes",
                {"_config": {"default_zip": "06461"}, "date": "2026-04-08"},
            )
        assert r.success, r.error
        assert r.data["location"] == "06461"
        assert r.data["date"] == "2026-04-08"
        # Each movie entry must carry a populated theaters list and a
        # snippet that the synthesizer can dump verbatim.
        assert r.data["showtimes"]
        for mv in r.data["showtimes"]:
            assert mv["theaters"]
            assert mv["snippet"], f"empty snippet for {mv['title']}"
        # Multi-theater fixture with no preferred_theater → lead is the
        # numbered clarification picker, not the rich napi lead.
        assert "theater" in r.data["lead"].lower()

    @pytest.mark.anyio
    async def test_missing_zip(self, skill):
        with _patch_napi(NAPI_FIXTURE):
            r = await skill.execute_mechanism("napi_theaters_with_showtimes", {})
        assert not r.success
        assert "ZIP" in r.error

    @pytest.mark.anyio
    async def test_napi_http_error(self, skill):
        with _patch_napi(NAPI_FIXTURE, fail=True):
            r = await skill.execute_mechanism(
                "napi_theaters_with_showtimes",
                {"_config": {"default_zip": "06461"}},
            )
        assert not r.success
        assert "503" in r.error

    @pytest.mark.anyio
    async def test_empty_payload_treated_as_failure(self, skill):
        with _patch_napi({"theaters": []}):
            r = await skill.execute_mechanism(
                "napi_theaters_with_showtimes",
                {"_config": {"default_zip": "06461"}},
            )
        assert not r.success
        assert "no live showtimes" in r.error

    @pytest.mark.anyio
    async def test_list_now_playing_prefers_napi_over_html(self, skill):
        # When both paths are wired, list_now_playing must hand back
        # the napi result (which has real `theaters` and per-movie
        # snippets with times) instead of the title-only HTML scrape.
        with _patch_napi(NAPI_FIXTURE):
            r = await skill.execute_mechanism(
                "list_now_playing",
                {"_config": {"default_zip": "06461"}, "date": "2026-04-08"},
            )
        assert r.success
        assert r.data.get("theaters"), "list_now_playing did not delegate to napi"
        assert any(mv.get("snippet") for mv in r.data["showtimes"])


# ---------- regression: grounded fast-path lead handling --------------------

class TestGroundedLeadFormatting:
    """Regression guard for the wall-of-text bug.

    The grounded fast-path used to unconditionally append the first
    two showtime snippets onto the skill's lead. With the rich
    Markdown lead from build_napi_lead — which already lists every
    movie + theater + time — that produced a duplicated tail like
    'Apple Cinemas Brass Mill: 9:50 PM · AMC Danbury 16: 10:30 PM'
    glued to the end of an already-comprehensive lead. The fix is
    that _format_grounded_result skips the append when the lead
    already contains a HH:MM time string.
    """

    def test_lead_with_times_is_not_double_printed(self):
        from lokidoki.core.orchestrator_skills import _format_grounded_result
        data = {
            "lead": "**Now playing in 06461:**\n\n- **Hoppers (2026)** — AMC: 7:30 PM",
            "showtimes": [
                {"title": "Hoppers (2026)", "snippet": "AMC: 7:30 PM"},
                {"title": "Project Hail Mary", "snippet": "Cinemark: 8:00 PM"},
            ],
        }
        text = _format_grounded_result(data)
        # Snippets must NOT be appended after the lead — the lead is
        # already comprehensive.
        assert text.count("AMC: 7:30 PM") == 1, f"snippet appended to rich lead: {text!r}"
        assert "Cinemark: 8:00 PM" not in text

    def test_legacy_title_only_lead_still_gets_snippet_append(self):
        # Old-style lead with no time strings — preserve the legacy
        # behavior so other skills that haven't been migrated still
        # produce useful grounded output.
        from lokidoki.core.orchestrator_skills import _format_grounded_result
        data = {
            "lead": "Now playing: A, B, C",
            "showtimes": [{"title": "A", "snippet": "Theater X: 7:30 PM"}],
        }
        text = _format_grounded_result(data)
        assert "Theater X: 7:30 PM" in text


# ---------- dispatch --------------------------------------------------------

class TestDispatch:
    @pytest.mark.anyio
    async def test_unknown_mechanism_raises(self, skill):
        with pytest.raises(ValueError):
            await skill.execute_mechanism("bogus", {})
