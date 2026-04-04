import pytest
from unittest.mock import MagicMock, AsyncMock, patch

from app.skills.builtins.web_search.skill import WebSearchSkill
from app.subsystems.text.web_search import WebSearchResult, SEARCH_EMPTY

@pytest.fixture
def skill():
    s = WebSearchSkill()
    s.manifest = {
        "id": "web_search",
        "actions": {
            "search": {}
        }
    }
    return s

@pytest.fixture
def emit_progress():
    return AsyncMock()

@pytest.mark.asyncio
async def test_web_search_success(skill, emit_progress):
    # Mock the internal search_web function with the expected text-based context format
    mock_context = "Title: Example\nURL: http://example.com\nSnippet: A snippet"
    mock_result = WebSearchResult(
        query="test query",
        source="duckduckgo",
        context=mock_context
    )
    
    with patch("app.skills.builtins.web_search.skill.search_web", return_value=mock_result):
        result = await skill.execute(
            "search", 
            {}, 
            emit_progress, 
            query="test query", 
            num_results=1
        )
        
        assert result["ok"] is True
        assert result["data"]["query"] == "test query"
        assert result["data"]["results"][0]["title"] == "Example"
        assert result["data"]["results"][0]["url"] == "http://example.com"
        assert result["meta"]["source"] == "duckduckgo"
        emit_progress.assert_called_with("Searching the web...")

@pytest.mark.asyncio
async def test_web_search_empty(skill, emit_progress):
    # Mock search returning no results
    mock_result = WebSearchResult(
        query="nonexistent",
        source="duckduckgo",
        context=SEARCH_EMPTY
    )
    
    with patch("app.skills.builtins.web_search.skill.search_web", return_value=mock_result):
        result = await skill.execute(
            "search", 
            {}, 
            emit_progress, 
            query="nonexistent"
        )
        
        assert result["ok"] is False
        assert "unavailable" in result["errors"][0].lower()
