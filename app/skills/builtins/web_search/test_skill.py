import pytest
from unittest.mock import MagicMock, patch

from app.skills.builtins.web_search.skill import WebSearchSkill
from app.subsystems.text.web_search import WebSearchResult

@pytest.fixture
def skill():
    return WebSearchSkill()

@pytest.fixture
def emit_progress():
    return MagicMock()

@pytest.mark.asyncio
async def test_web_search_success(skill, emit_progress):
    # Mock the internal search_web function
    mock_result = WebSearchResult(
        query="test query",
        source="duckduckgo",
        context="[{\"title\": \"Example\", \"url\": \"http://example.com\", \"snippet\": \"A snippet\"}]"
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

@pytest.mark.asyncio
async def test_web_search_empty(skill, emit_progress):
    # Mock search returning no results
    mock_result = WebSearchResult(
        query="nonexistent",
        source="duckduckgo",
        context="[]"
    )
    
    from app.subsystems.text.web_search import SEARCH_EMPTY
    mock_result.context = SEARCH_EMPTY
    
    with patch("app.skills.builtins.web_search.skill.search_web", return_value=mock_result):
        result = await skill.execute(
            "search", 
            {}, 
            emit_progress, 
            query="nonexistent"
        )
        
        assert result["ok"] is False
        assert "unavailable" in result["errors"][0].lower()
