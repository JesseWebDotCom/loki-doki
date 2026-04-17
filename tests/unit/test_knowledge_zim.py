"""Test ZIM-first mechanism in the knowledge skill."""
from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, patch, MagicMock

import pytest

from lokidoki.skills.knowledge.skill import WikipediaSkill
from lokidoki.archives.search import ZimArticle


@pytest.fixture
def skill():
    return WikipediaSkill()


def _mock_article() -> ZimArticle:
    return ZimArticle(
        source_id="wikipedia",
        title="Alan Turing",
        path="A/Alan_Turing",
        snippet="Alan Mathison Turing was an English mathematician and computer scientist.",
        url="https://en.wikipedia.org/wiki/Alan_Turing",
        source_label="Wikipedia",
    )


def test_zim_local_returns_result_when_engine_loaded(skill):
    """ZIM mechanism should return success when engine has results."""
    mock_engine = MagicMock()
    mock_engine.loaded_sources = ["wikipedia"]
    mock_engine.search = AsyncMock(return_value=[_mock_article()])

    with patch("lokidoki.archives.search.get_search_engine", return_value=mock_engine):
        result = asyncio.run(skill.execute_mechanism("zim_local", {"query": "Alan Turing"}))

    assert result.success is True
    assert result.data["title"] == "Alan Turing"
    assert "offline" in result.source_title.lower()


def test_zim_local_fails_when_no_engine(skill):
    """ZIM mechanism should fail gracefully when no engine is initialized."""
    with patch("lokidoki.archives.search.get_search_engine", return_value=None):
        result = asyncio.run(skill.execute_mechanism("zim_local", {"query": "test"}))

    assert result.success is False
    assert "No ZIM" in result.error


def test_zim_local_fails_when_no_results(skill):
    """ZIM mechanism should fail when engine returns empty results."""
    mock_engine = MagicMock()
    mock_engine.loaded_sources = ["wikipedia"]
    mock_engine.search = AsyncMock(return_value=[])

    with patch("lokidoki.archives.search.get_search_engine", return_value=mock_engine):
        result = asyncio.run(skill.execute_mechanism("zim_local", {"query": "nonexistent topic xyz"}))

    assert result.success is False


def test_zim_local_fails_without_query(skill):
    """ZIM mechanism should fail when query is missing."""
    result = asyncio.run(skill.execute_mechanism("zim_local", {}))
    assert result.success is False
    assert "Query" in result.error


def test_zim_mechanism_is_priority_zero():
    """Verify zim_local is the highest priority mechanism in the manifest."""
    import json
    from pathlib import Path

    manifest_path = Path(__file__).parents[2] / "lokidoki" / "skills" / "knowledge" / "manifest.json"
    manifest = json.loads(manifest_path.read_text())
    mechanisms = manifest["mechanisms"]

    zim = next(m for m in mechanisms if m["method"] == "zim_local")
    assert zim["priority"] == 0
    assert zim["requires_internet"] is False

    # Verify it's the lowest priority number (tried first)
    priorities = [m["priority"] for m in mechanisms]
    assert zim["priority"] == min(priorities)


def test_existing_mechanisms_unchanged():
    """mediawiki_api and web_scraper should still exist with their original priorities."""
    import json
    from pathlib import Path

    manifest_path = Path(__file__).parents[2] / "lokidoki" / "skills" / "knowledge" / "manifest.json"
    manifest = json.loads(manifest_path.read_text())
    mechanisms = {m["method"]: m for m in manifest["mechanisms"]}

    assert "mediawiki_api" in mechanisms
    assert mechanisms["mediawiki_api"]["priority"] == 1
    assert mechanisms["mediawiki_api"]["requires_internet"] is True

    assert "web_scraper" in mechanisms
    assert mechanisms["web_scraper"]["priority"] == 2
