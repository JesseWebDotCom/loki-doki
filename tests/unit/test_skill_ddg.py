import pytest
import json
from unittest.mock import AsyncMock, patch, MagicMock
from lokidoki.skills.search_ddg.skill import DuckDuckGoSkill


@pytest.fixture
def skill():
    return DuckDuckGoSkill()


class TestDuckDuckGoSkill:
    @pytest.mark.anyio
    async def test_ddg_api_success(self, skill):
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {
            "Heading": "Python",
            "AbstractText": "Python is a programming language.",
            "AbstractURL": "https://en.wikipedia.org/wiki/Python",
            "RelatedTopics": [
                {"Text": "Python 3 - latest version"},
                {"Text": "CPython - reference implementation"},
            ],
        }

        with patch("lokidoki.skills.search_ddg.skill.httpx.AsyncClient") as mock_client:
            mock_client.return_value.__aenter__ = AsyncMock(return_value=MagicMock(get=AsyncMock(return_value=mock_response)))
            mock_client.return_value.__aexit__ = AsyncMock(return_value=None)
            result = await skill.execute_mechanism("ddg_api", {"query": "python"})

        assert result.success
        assert result.data["heading"] == "Python"
        assert "Python is a programming language" in result.data["abstract"]
        assert result.source_url == "https://en.wikipedia.org/wiki/Python"

    @pytest.mark.anyio
    async def test_ddg_api_no_results(self, skill):
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {
            "Heading": "",
            "AbstractText": "",
            "RelatedTopics": [],
        }

        with patch("lokidoki.skills.search_ddg.skill.httpx.AsyncClient") as mock_client:
            mock_client.return_value.__aenter__ = AsyncMock(return_value=MagicMock(get=AsyncMock(return_value=mock_response)))
            mock_client.return_value.__aexit__ = AsyncMock(return_value=None)
            result = await skill.execute_mechanism("ddg_api", {"query": "xyznothing"})

        assert not result.success

    @pytest.mark.anyio
    async def test_ddg_api_missing_query(self, skill):
        result = await skill.execute_mechanism("ddg_api", {})
        assert not result.success
        assert "Query parameter required" in result.error

    @pytest.mark.anyio
    async def test_unknown_mechanism_raises(self, skill):
        with pytest.raises(ValueError, match="Unknown mechanism"):
            await skill.execute_mechanism("unknown", {"query": "test"})
