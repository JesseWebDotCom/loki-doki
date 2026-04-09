"""Unit tests for the Wikipedia-backed movies skill.

Focused on the bugs that bit us in real chat sessions:

1. Decomposer hands over a full natural-language question
   ("find the duration of the latest avatar movie") and the lead
   pattern stripper has to fully unwind it down to "avatar".
2. "latest" must mean *pick the most recent year*, not just drop
   the word and accept the first film hit Wikipedia ranks.
3. The latest-year picker must reject off-topic films Wikipedia's
   relevance ranker happens to surface (Hoppers 2026, etc.).
4. Runtime falls back to the infobox when the lead paragraph
   omits it (true for unreleased films like Avatar: Fire and Ash).
"""
import pytest
from unittest.mock import AsyncMock, MagicMock, patch

from lokidoki.skills.movies_wiki.skill import (
    WikiMoviesSkill,
    _query_candidates,
    _extract_runtime_min,
    _extract_year,
    _format_lead,
    _fetch_runtime_from_infobox,
    _scrape_runtime_from_page,
)


class TestQueryCandidates:
    def test_clean_title_passes_through(self):
        cands = _query_candidates("Inception")
        assert cands[0] == "Inception"

    def test_strips_how_long_is(self):
        cands = _query_candidates("how long is inception")
        assert "inception" in cands

    def test_unwinds_layered_lead_prefixes(self):
        # The bug: "find the duration of the latest avatar movie"
        # used to leave "the duration of avatar" because only one
        # lead pattern fired per call.
        cands = _query_candidates("find the duration of the latest avatar movie")
        assert "avatar" in cands, f"expected 'avatar' in {cands}"

    def test_strips_latest_filler(self):
        cands = _query_candidates("the latest avatar movie")
        assert "avatar" in cands

    def test_strips_trailing_movie_noun(self):
        cands = _query_candidates("avatar movie")
        assert "avatar" in cands

    def test_empty_input(self):
        assert _query_candidates("") == []
        assert _query_candidates("   ") == []


class TestExtractors:
    def test_runtime_minutes(self):
        assert _extract_runtime_min("with a running time of 192 minutes") == 192

    def test_runtime_hyphenated(self):
        assert _extract_runtime_min("the 162-minute epic") == 162

    def test_runtime_out_of_bounds_rejected(self):
        assert _extract_runtime_min("the 5 minute trailer") is None
        assert _extract_runtime_min("the 999 minute marathon") is None

    def test_runtime_missing(self):
        assert _extract_runtime_min("Avatar: Fire and Ash is an upcoming film") is None

    def test_year_extraction(self):
        assert _extract_year("a 2009 American epic science fiction film") == 2009

    def test_year_extraction_skips_old_dates(self):
        assert _extract_year("set in 1850 and released in 2022") == 2022


class TestFormatLead:
    def test_full_lead(self):
        out = _format_lead("Avatar", "2009", 162, "2009 film by James Cameron")
        assert "Avatar (2009)" in out
        assert "2h 42m" in out

    def test_no_runtime(self):
        out = _format_lead("Avatar: Fire and Ash", "2025", None, "2025 film")
        assert "Avatar: Fire and Ash (2025)" in out
        assert "runs" not in out


def _mk_resp(status: int, payload: dict) -> MagicMock:
    r = MagicMock()
    r.status_code = status
    r.json.return_value = payload
    return r


def _search_payload(titles: list[str]) -> dict:
    return {"query": {"search": [{"title": t} for t in titles]}}


def _summary_payload(title: str, extract: str, description: str = "film") -> dict:
    return {
        "title": title,
        "extract": extract,
        "description": description,
        "type": "standard",
        "content_urls": {"desktop": {"page": f"https://en.wikipedia.org/wiki/{title}"}},
    }


def _make_router(search_titles: list[str], summaries: dict[str, dict]):
    """Build an httpx.AsyncClient.get side_effect that routes by URL.

    The skill calls the search endpoint once per candidate query, then
    a summary endpoint per hit. Returning a fixed list with side_effect
    breaks as soon as the candidate count changes — route by URL
    instead so the mock is stable across reductions.
    """
    async def _get(url, *args, **kwargs):
        if "list=search" in str(kwargs.get("params", "")) or "api.php" in url:
            return _mk_resp(200, _search_payload(search_titles))
        # Summary endpoint: /page/summary/{Title_With_Underscores}
        for title, payload in summaries.items():
            if title.replace(" ", "_") in url:
                return _mk_resp(200, payload)
        return _mk_resp(404, {})
    return _get


class TestLatestPicker:
    @pytest.mark.anyio
    async def test_picks_most_recent_avatar(self):
        """Searching 'latest avatar' should return the highest-year
        Avatar film, not the first hit Wikipedia ranks (which used
        to be the 2009 original or even The Last Airbender).
        """
        skill = WikiMoviesSkill()
        router = _make_router(
            ["Avatar (2009 film)", "Avatar: The Way of Water", "Avatar: Fire and Ash"],
            {
                "Avatar (2009 film)": _summary_payload(
                    "Avatar (2009 film)",
                    "Avatar is a 2009 American epic science fiction film running 162 minutes.",
                    "2009 film by James Cameron",
                ),
                "Avatar: The Way of Water": _summary_payload(
                    "Avatar: The Way of Water",
                    "Avatar: The Way of Water is a 2022 American epic film 192 minutes long.",
                    "2022 film by James Cameron",
                ),
                "Avatar: Fire and Ash": _summary_payload(
                    "Avatar: Fire and Ash",
                    "Avatar: Fire and Ash is an upcoming 2025 American epic science fiction film.",
                    "2025 film by James Cameron",
                ),
            },
        )

        with patch("httpx.AsyncClient.get", new_callable=AsyncMock, side_effect=router):
            result = await skill.execute_mechanism(
                "wiki_api", {"query": "how long is the latest avatar movie"},
            )

        assert result.success is True
        assert result.data["title"] == "Avatar: Fire and Ash"
        assert result.data["release_date"].startswith("2025")
        # The "latest" path is the most user-visible — assert the lead
        # actually names the chosen film, not the wrong one or a stub.
        assert "Avatar: Fire and Ash" in result.data["lead"]
        assert "Hoppers" not in result.data["lead"]

    @pytest.mark.anyio
    async def test_rejects_off_topic_film_in_latest_mode(self):
        """When 'latest' is set, a 2026 unrelated film must NOT win
        on year alone — title has to mention the candidate token.
        Reproduces the Hoppers (2026) bug.
        """
        skill = WikiMoviesSkill()
        router = _make_router(
            ["Hoppers (film)", "Avatar (2009 film)", "Avatar: Fire and Ash"],
            {
                "Hoppers (film)": _summary_payload(
                    "Hoppers (film)",
                    "Hoppers is a 2026 American animated comedy film.",
                    "2026 film by Daniel Chong",
                ),
                "Avatar (2009 film)": _summary_payload(
                    "Avatar (2009 film)",
                    "Avatar is a 2009 American epic science fiction film.",
                    "2009 film by James Cameron",
                ),
                "Avatar: Fire and Ash": _summary_payload(
                    "Avatar: Fire and Ash",
                    "Avatar: Fire and Ash is an upcoming 2025 film.",
                    "2025 film by James Cameron",
                ),
            },
        )

        with patch("httpx.AsyncClient.get", new_callable=AsyncMock, side_effect=router):
            result = await skill.execute_mechanism(
                "wiki_api", {"query": "the latest avatar movie"},
            )

        assert result.success is True
        assert "Hoppers" not in result.data["title"]
        assert "Avatar" in result.data["title"]
        # Lead must reflect the corrected title — the original Hoppers
        # bug surfaced because the synthesizer saw a wrong-film lead.
        assert "Avatar" in result.data["lead"]
        assert "Hoppers" not in result.data["lead"]

    @pytest.mark.anyio
    async def test_non_latest_takes_first_film_hit(self):
        skill = WikiMoviesSkill()
        router = _make_router(
            ["Inception"],
            {
                "Inception": _summary_payload(
                    "Inception",
                    "Inception is a 2010 science fiction action film 148 minutes long.",
                    "2010 film by Christopher Nolan",
                ),
            },
        )
        with patch("httpx.AsyncClient.get", new_callable=AsyncMock, side_effect=router):
            result = await skill.execute_mechanism("wiki_api", {"query": "Inception"})

        assert result.success is True
        assert result.data["title"] == "Inception"
        assert result.data["runtime_min"] == 148
        # Lead is the verbatim fast-path payload — assert it carries the
        # title, year, and a human-formatted runtime so the user gets a
        # complete answer without needing the synthesizer to embellish.
        lead = result.data["lead"]
        assert "Inception" in lead, f"lead missing title: {lead!r}"
        assert "2010" in lead, f"lead missing year: {lead!r}"
        assert "2h 28m" in lead, f"lead missing formatted runtime: {lead!r}"

    @pytest.mark.anyio
    async def test_runtime_falls_back_to_infobox_wikitext(self):
        """When the lead paragraph omits running time (true for
        unreleased films like Avatar: Fire and Ash), the skill must
        pull it from the infobox section-0 wikitext.
        """
        skill = WikiMoviesSkill()
        infobox_wikitext = (
            "{{Infobox film\n"
            "| name = Avatar: Fire and Ash\n"
            "| director = James Cameron\n"
            "| running time = 195 minutes\n"
            "}}\n"
        )

        async def router(url, *args, **kwargs):
            params = kwargs.get("params") or {}
            if params.get("action") == "parse":
                return _mk_resp(200, {"parse": {"wikitext": {"*": infobox_wikitext}}})
            if params.get("list") == "search":
                return _mk_resp(200, _search_payload(["Avatar: Fire and Ash"]))
            if "Avatar:_Fire_and_Ash" in url:
                return _mk_resp(200, _summary_payload(
                    "Avatar: Fire and Ash",
                    "Avatar: Fire and Ash is an upcoming 2025 film by James Cameron.",
                    "2025 film by James Cameron",
                ))
            return _mk_resp(404, {})

        with patch("httpx.AsyncClient.get", new_callable=AsyncMock, side_effect=router):
            result = await skill.execute_mechanism(
                "wiki_api", {"query": "avatar fire and ash"},
            )

        assert result.success is True
        assert result.data["runtime_min"] == 195
        assert "3h 15m" in result.data["lead"]

    @pytest.mark.anyio
    async def test_infobox_accepts_runtime_alias(self):
        """Real Wikipedia films use BOTH ``| running time =`` and the
        shorter ``| runtime =`` — Avatar: Fire and Ash uses the latter.
        Both must be parsed.
        """
        wikitext = (
            "{{Infobox film\n"
            "| name = Avatar: Fire and Ash\n"
            "| runtime = 197 minutes<ref>{{cite web}}</ref>\n"
            "}}"
        )
        resp = MagicMock()
        resp.status_code = 200
        resp.json.return_value = {"parse": {"wikitext": {"*": wikitext}}}
        with patch("httpx.AsyncClient.get", new_callable=AsyncMock, return_value=resp):
            assert await _fetch_runtime_from_infobox("Avatar:_Fire_and_Ash") == 197

    @pytest.mark.anyio
    async def test_runtime_falls_back_to_page_scrape(self):
        """When the wikitext infobox doesn't include a literal
        ``running time = NNN minutes`` field (templated infoboxes),
        the skill must scrape the rendered HTML for the right-column
        infobox row.
        """
        infobox_html = """
        <table class="infobox vevent">
          <tr><th scope="row">Directed by</th><td>James Cameron</td></tr>
          <tr><th scope="row">Running time</th><td>192 minutes</td></tr>
        </table>
        """
        page_resp = MagicMock()
        page_resp.status_code = 200
        page_resp.text = infobox_html

        async def router(url, *args, **kwargs):
            params = kwargs.get("params") or {}
            if params.get("action") == "parse":
                # Wikitext has no running time line — forces scrape.
                return _mk_resp(200, {"parse": {"wikitext": {"*": "{{Infobox film}}"}}})
            if params.get("list") == "search":
                return _mk_resp(200, _search_payload(["Avatar: Fire and Ash"]))
            if "Avatar:_Fire_and_Ash" in url and "/wiki/" in url:
                return page_resp
            if "Avatar:_Fire_and_Ash" in url:
                return _mk_resp(200, _summary_payload(
                    "Avatar: Fire and Ash",
                    "Avatar: Fire and Ash is an upcoming 2025 film.",
                    "2025 film by James Cameron",
                ))
            return _mk_resp(404, {})

        skill = WikiMoviesSkill()
        with patch("httpx.AsyncClient.get", new_callable=AsyncMock, side_effect=router):
            result = await skill.execute_mechanism(
                "wiki_api", {"query": "avatar fire and ash"},
            )

        assert result.success is True
        assert result.data["runtime_min"] == 192

    @pytest.mark.anyio
    async def test_scrape_runtime_unit(self):
        """Direct unit test for the HTML scraper helper."""
        html = """
        <table class="infobox">
          <tr><th>Directed by</th><td>X</td></tr>
          <tr><th>Running time</th><td>148 minutes<sup>[1]</sup></td></tr>
        </table>
        """
        resp = MagicMock()
        resp.status_code = 200
        resp.text = html
        with patch("httpx.AsyncClient.get", new_callable=AsyncMock, return_value=resp):
            assert await _scrape_runtime_from_page("Inception") == 148

    @pytest.mark.anyio
    async def test_missing_query_fails(self):
        skill = WikiMoviesSkill()
        result = await skill.execute_mechanism("wiki_api", {})
        assert result.success is False
