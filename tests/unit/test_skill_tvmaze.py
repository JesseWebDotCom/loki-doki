import pytest
from unittest.mock import AsyncMock, MagicMock, patch
from lokidoki.skills.tvshows_tvmaze.skill import TVMazeSkill


@pytest.fixture
def skill():
    return TVMazeSkill()


class TestTVMazeSkill:
    @pytest.mark.anyio
    async def test_tvmaze_api_success(self, skill):
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {
            "name": "Breaking Bad",
            "status": "Ended",
            "premiered": "2008-01-20",
            "rating": {"average": 9.5},
            "genres": ["Drama", "Crime"],
            "summary": "<p>A chemistry teacher turned meth maker.</p>",
            "network": {"name": "AMC"},
            "url": "https://www.tvmaze.com/shows/169/breaking-bad",
            "_embedded": {
                "episodes": [
                    {"season": 5, "number": 16, "name": "Felina", "airdate": "2013-09-29"},
                ]
            },
        }

        with patch("lokidoki.skills.tvshows_tvmaze.skill.httpx.AsyncClient") as mock_client:
            mock_client.return_value.__aenter__ = AsyncMock(return_value=MagicMock(get=AsyncMock(return_value=mock_response)))
            mock_client.return_value.__aexit__ = AsyncMock(return_value=None)
            result = await skill.execute_mechanism("tvmaze_api", {"query": "breaking bad"})

        assert result.success
        assert result.data["name"] == "Breaking Bad"
        assert result.data["rating"] == 9.5
        assert "Drama" in result.data["genres"]
        assert len(result.data["recent_episodes"]) == 1
        assert result.source_title == "TVMaze - Breaking Bad"

    @pytest.mark.anyio
    async def test_tvmaze_api_not_found(self, skill):
        mock_response = MagicMock()
        mock_response.status_code = 404

        with patch("lokidoki.skills.tvshows_tvmaze.skill.httpx.AsyncClient") as mock_client:
            mock_client.return_value.__aenter__ = AsyncMock(return_value=MagicMock(get=AsyncMock(return_value=mock_response)))
            mock_client.return_value.__aexit__ = AsyncMock(return_value=None)
            result = await skill.execute_mechanism("tvmaze_api", {"query": "xyznothing"})

        assert not result.success
        assert "not found" in result.error.lower()

    @pytest.mark.anyio
    async def test_local_cache_miss(self, skill):
        result = await skill.execute_mechanism("local_cache", {"query": "anything"})
        assert not result.success
        assert "Cache miss" in result.error

    @pytest.mark.anyio
    async def test_local_cache_hit_after_api(self, skill):
        # Simulate caching
        skill._cache["test show"] = {"name": "Test Show", "status": "Running"}
        result = await skill.execute_mechanism("local_cache", {"query": "test show"})
        assert result.success
        assert result.data["name"] == "Test Show"

    @pytest.mark.anyio
    async def test_missing_query(self, skill):
        result = await skill.execute_mechanism("tvmaze_api", {})
        assert not result.success
