import pytest
from unittest.mock import AsyncMock, patch, MagicMock
from lokidoki.skills.knowledge_wiki.skill import WikipediaSkill
from lokidoki.core.skill_executor import MechanismResult


WIKI_API_RESPONSE = {
    "query": {
        "pages": {
            "12345": {
                "pageid": 12345,
                "title": "Raspberry Pi",
                "extract": "The Raspberry Pi is a series of small single-board computers.",
            }
        }
    }
}

WIKI_SEARCH_RESPONSE = {
    "query": {
        "search": [
            {"title": "Raspberry Pi", "snippet": "A series of single-board computers"}
        ]
    }
}

WIKI_HTML_BODY = """
<html><body>
<div id="mw-content-text">
<p>The Raspberry Pi is a series of small single-board computers developed in the UK.</p>
<p>It was released in 2012.</p>
<h2><span class="mw-headline">History</span></h2>
<p>This paragraph is after the first h2 and should NOT be in the lead.</p>
<h2><span class="mw-headline">Hardware</span></h2>
</div>
</body></html>
"""


class TestWikipediaSkill:
    @pytest.mark.anyio
    async def test_mediawiki_api_success(self):
        """Test successful MediaWiki JSON API call."""
        skill = WikipediaSkill()
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = WIKI_API_RESPONSE

        with patch("httpx.AsyncClient.get", new_callable=AsyncMock, return_value=mock_response):
            result = await skill.execute_mechanism("mediawiki_api", {"query": "Raspberry Pi"})

        assert result.success is True
        assert "Raspberry Pi" in result.data["title"]
        assert "single-board" in result.data["lead"]
        assert result.data["sections"] == []
        assert result.data["url"].endswith("Raspberry_Pi")
        assert result.source_url != ""
        assert result.source_title != ""

    @pytest.mark.anyio
    async def test_mediawiki_api_no_results(self):
        """Test handling when no Wikipedia pages match."""
        skill = WikipediaSkill()
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {"query": {"pages": {"-1": {"missing": ""}}}}

        with patch("httpx.AsyncClient.get", new_callable=AsyncMock, return_value=mock_response):
            result = await skill.execute_mechanism("mediawiki_api", {"query": "xyznonexistent"})

        assert result.success is False

    @pytest.mark.anyio
    async def test_mediawiki_api_missing_query(self):
        """Test that missing query parameter fails gracefully."""
        skill = WikipediaSkill()
        result = await skill.execute_mechanism("mediawiki_api", {})

        assert result.success is False
        assert "query" in result.error.lower()

    @pytest.mark.anyio
    async def test_web_scraper_success(self):
        """Test web scraper fallback mechanism."""
        skill = WikipediaSkill()

        # Mock search response then page response
        mock_search = MagicMock()
        mock_search.status_code = 200
        mock_search.json.return_value = WIKI_SEARCH_RESPONSE

        mock_page = MagicMock()
        mock_page.status_code = 200
        mock_page.text = WIKI_HTML_BODY

        with patch("httpx.AsyncClient.get", new_callable=AsyncMock, side_effect=[mock_search, mock_page]):
            result = await skill.execute_mechanism("web_scraper", {"query": "Raspberry Pi"})

        assert result.success is True
        assert "single-board computers" in result.data["lead"]
        assert "after the first h2" not in result.data["lead"]
        assert result.data["sections"] == ["History", "Hardware"]
        assert result.source_url != ""

    @pytest.mark.anyio
    async def test_web_scraper_no_search_results(self):
        """Test scraper when search yields no results."""
        skill = WikipediaSkill()
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {"query": {"search": []}}

        with patch("httpx.AsyncClient.get", new_callable=AsyncMock, return_value=mock_response):
            result = await skill.execute_mechanism("web_scraper", {"query": "xyznonexistent"})

        assert result.success is False

    @pytest.mark.anyio
    async def test_unknown_mechanism(self):
        """Test that unknown mechanisms raise ValueError."""
        skill = WikipediaSkill()
        with pytest.raises(ValueError, match="Unknown mechanism"):
            await skill.execute_mechanism("unknown", {})

    @pytest.mark.anyio
    async def test_mediawiki_api_caches_result(self):
        """Test that API results are cached."""
        skill = WikipediaSkill()
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = WIKI_API_RESPONSE

        with patch("httpx.AsyncClient.get", new_callable=AsyncMock, return_value=mock_response):
            await skill.execute_mechanism("mediawiki_api", {"query": "Raspberry Pi"})

        assert "raspberry pi" in skill._cache
