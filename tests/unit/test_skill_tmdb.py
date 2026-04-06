import pytest
from unittest.mock import AsyncMock, MagicMock, patch
from lokidoki.skills.movies_tmdb.skill import TMDBSkill


@pytest.fixture
def skill():
    return TMDBSkill(api_key="test_key")


@pytest.fixture
def skill_no_key():
    return TMDBSkill()


class TestTMDBSkill:
    @pytest.mark.anyio
    async def test_tmdb_api_success(self, skill):
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {
            "results": [{
                "id": 550,
                "title": "Fight Club",
                "release_date": "1999-10-15",
                "overview": "An insomniac office worker...",
                "vote_average": 8.4,
                "vote_count": 25000,
            }]
        }

        with patch("lokidoki.skills.movies_tmdb.skill.httpx.AsyncClient") as mock_client:
            mock_client.return_value.__aenter__ = AsyncMock(return_value=MagicMock(get=AsyncMock(return_value=mock_response)))
            mock_client.return_value.__aexit__ = AsyncMock(return_value=None)
            result = await skill.execute_mechanism("tmdb_api", {"query": "fight club"})

        assert result.success
        assert result.data["title"] == "Fight Club"
        assert result.data["rating"] == 8.4
        assert "themoviedb.org/movie/550" in result.source_url

    @pytest.mark.anyio
    async def test_tmdb_no_api_key(self, skill_no_key):
        result = await skill_no_key.execute_mechanism("tmdb_api", {"query": "test"})
        assert not result.success
        assert "API key" in result.error

    @pytest.mark.anyio
    async def test_tmdb_no_results(self, skill):
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {"results": []}

        with patch("lokidoki.skills.movies_tmdb.skill.httpx.AsyncClient") as mock_client:
            mock_client.return_value.__aenter__ = AsyncMock(return_value=MagicMock(get=AsyncMock(return_value=mock_response)))
            mock_client.return_value.__aexit__ = AsyncMock(return_value=None)
            result = await skill.execute_mechanism("tmdb_api", {"query": "xyznothing"})

        assert not result.success

    @pytest.mark.anyio
    async def test_cache_hit(self, skill):
        skill._cache["inception"] = {"title": "Inception", "rating": 8.8}
        result = await skill.execute_mechanism("local_cache", {"query": "inception"})
        assert result.success
        assert result.data["title"] == "Inception"

    @pytest.mark.anyio
    async def test_cache_miss(self, skill):
        result = await skill.execute_mechanism("local_cache", {"query": "nothing"})
        assert not result.success
