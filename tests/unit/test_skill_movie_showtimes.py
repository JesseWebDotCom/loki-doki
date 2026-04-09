import pytest
from unittest.mock import AsyncMock, MagicMock, patch

from lokidoki.skills.movies_showtimes.skill import MovieShowtimesSkill


def _mk_response(status_code: int, text: str) -> MagicMock:
    response = MagicMock()
    response.status_code = status_code
    response.text = text
    return response


@pytest.fixture
def skill():
    return MovieShowtimesSkill()


class TestMovieShowtimesSkill:
    @pytest.mark.anyio
    async def test_ddg_showtimes_success(self, skill):
        html = """
        <html><body>
          <a class="result__a" href="//example.com/amc">Avatar showtimes at AMC Empire 25</a>
          <a class="result__snippet">7:00pm, 9:45pm tonight in New York, NY.</a>
          <a class="result__a" href="//example.com/regal">Avatar showtimes at Regal Union Square</a>
          <a class="result__snippet">6:30pm and 10:00pm today.</a>
        </body></html>
        """
        response = _mk_response(200, html)

        with patch("lokidoki.skills.movies_showtimes.skill.httpx.AsyncClient") as mock_client:
            mock_client.return_value.__aenter__ = AsyncMock(
                return_value=MagicMock(post=AsyncMock(return_value=response))
            )
            mock_client.return_value.__aexit__ = AsyncMock(return_value=None)
            result = await skill.execute_mechanism(
                "ddg_showtimes",
                {"query": "Avatar tonight", "_config": {"default_location": "New York, NY"}},
            )

        assert result.success is True
        assert len(result.data["showtimes"]) == 2
        assert "New York, NY" in result.data["search_query"]
        # Lead must carry both the theater AND a concrete time — without
        # the time, the synthesizer has nothing useful to render and
        # falls back to filler. Asserting on theater alone misses the
        # "lead is a placeholder" failure mode we hit with Fandango.
        lead = result.data["lead"]
        assert "AMC Empire 25" in lead
        assert "7:00pm" in lead, f"lead missing concrete showtime: {lead!r}"
        assert "duckduckgo.com" in result.source_url
        assert "Avatar+tonight+showtimes+New+York" in result.source_url

    @pytest.mark.anyio
    async def test_requires_query(self, skill):
        result = await skill.execute_mechanism("ddg_showtimes", {})
        assert result.success is False
        assert "Query" in result.error

    @pytest.mark.anyio
    async def test_local_cache_hit(self, skill):
        skill._cache["avatar tonight"] = {
            "lead": "Cached showtimes",
            "showtimes": [{"title": "Avatar", "snippet": "7:00pm", "url": "https://example.com"}],
        }
        result = await skill.execute_mechanism("local_cache", {"query": "avatar tonight"})
        assert result.success is True
        # Cache must round-trip the lead so the verbatim fast-path keeps
        # working on cached results.
        assert result.data["lead"] == "Cached showtimes"
        assert result.data["showtimes"][0]["snippet"] == "7:00pm"

    @pytest.mark.anyio
    async def test_local_cache_miss(self, skill):
        result = await skill.execute_mechanism("local_cache", {"query": "missing"})
        assert result.success is False

    @pytest.mark.anyio
    async def test_rejects_promotional_results_without_concrete_times(self, skill):
        html = """
        <html><body>
          <a class="result__a" href="//example.com/fandango">Find Showtimes Near You - Skip the Lines at the Theater</a>
          <a class="result__snippet">Find movies, showtimes, and theaters near you. Buy tickets fast and reserve your seats with Fandango in 06461.</a>
        </body></html>
        """
        response = _mk_response(200, html)

        with patch("lokidoki.skills.movies_showtimes.skill.httpx.AsyncClient") as mock_client:
            mock_client.return_value.__aenter__ = AsyncMock(
                return_value=MagicMock(post=AsyncMock(return_value=response))
            )
            mock_client.return_value.__aexit__ = AsyncMock(return_value=None)
            result = await skill.execute_mechanism(
                "ddg_showtimes",
                {"query": "Avatar tonight", "_config": {"default_location": "Milford, CT"}},
            )

        assert result.success is False
        assert "No showtimes found" in result.error
