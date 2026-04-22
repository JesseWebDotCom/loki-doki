"""Tests for structured markdown composition in the knowledge skill."""
from __future__ import annotations

import asyncio
from pathlib import Path
from unittest.mock import patch

from lokidoki.skills.knowledge.skill import (
    WikipediaSkill,
    _STRUCTURED_MARKDOWN_CHAR_CAP,
)


_FIXTURE = (
    Path(__file__).resolve().parents[1] / "fixtures" / "wiki" / "luke_skywalker.html"
)


class _MockResponse:
    def __init__(self, *, status_code: int = 200, json_data: dict | None = None, text: str = "") -> None:
        self.status_code = status_code
        self._json_data = json_data or {}
        self.text = text

    def json(self) -> dict:
        return self._json_data


class _MockAsyncClient:
    def __init__(self, responses: list[_MockResponse], **_: object) -> None:
        self._responses = responses

    async def __aenter__(self) -> _MockAsyncClient:
        return self

    async def __aexit__(self, exc_type, exc, tb) -> None:
        return None

    async def get(self, *_args, **_kwargs) -> _MockResponse:
        return self._responses.pop(0)


def _search_response(title: str = "Luke Skywalker") -> _MockResponse:
    return _MockResponse(
        json_data={"query": {"search": [{"title": title}]}},
    )


def _api_page_response(*, title: str, extract: str, pageprops: dict | None = None) -> _MockResponse:
    page: dict[str, object] = {
        "pageid": 1,
        "title": title,
        "extract": extract,
    }
    if pageprops is not None:
        page["pageprops"] = pageprops
    return _MockResponse(
        json_data={"query": {"pages": {"1": page}}},
    )


def test_web_scraper_structured_markdown_includes_lead_and_sections() -> None:
    html = _FIXTURE.read_text(encoding="utf-8")
    skill = WikipediaSkill()
    responses = [_search_response(), _MockResponse(text=html)]

    with patch(
        "lokidoki.skills.knowledge.skill.httpx.AsyncClient",
        side_effect=lambda **kwargs: _MockAsyncClient(responses, **kwargs),
    ):
        result = asyncio.run(skill.execute_mechanism("web_scraper", {"query": "Luke Skywalker"}))

    assert result.success is True
    structured = result.data["structured_markdown"]
    assert structured.startswith("Luke Skywalker is a Jedi Knight from Tatooine")
    assert "## Early life" in structured
    assert "## Galactic Civil War" in structured
    assert "## Jedi training" in structured
    assert "## Legacy" not in structured
    assert "## See also" not in structured
    assert "## References" not in structured


def test_web_scraper_structured_markdown_is_capped() -> None:
    long_paragraph = " ".join(
        ["Leia Organa leads the Alliance with resolve and discipline."] * 80
    )
    html = f"""
    <div id="mw-content-text">
      <p>Leia Organa is a leader in the Rebel Alliance.</p>
      <h2><span class="mw-headline">Leadership</span></h2>
      <p>{long_paragraph}</p>
      <h2><span class="mw-headline">Diplomacy</span></h2>
      <p>{long_paragraph}</p>
    </div>
    """
    skill = WikipediaSkill()
    responses = [_search_response("Leia Organa"), _MockResponse(text=html)]

    with patch(
        "lokidoki.skills.knowledge.skill.httpx.AsyncClient",
        side_effect=lambda **kwargs: _MockAsyncClient(responses, **kwargs),
    ):
        result = asyncio.run(skill.execute_mechanism("web_scraper", {"query": "Leia Organa"}))

    assert result.success is True
    assert len(result.data["structured_markdown"]) <= _STRUCTURED_MARKDOWN_CHAR_CAP + 3


def test_web_scraper_without_h2_uses_lead_only() -> None:
    html = """
    <div id="mw-content-text">
      <p>Padme Amidala is a senator from Naboo.</p>
    </div>
    """
    skill = WikipediaSkill()
    responses = [_search_response("Padme Amidala"), _MockResponse(text=html)]

    with patch(
        "lokidoki.skills.knowledge.skill.httpx.AsyncClient",
        side_effect=lambda **kwargs: _MockAsyncClient(responses, **kwargs),
    ):
        result = asyncio.run(skill.execute_mechanism("web_scraper", {"query": "Padme Amidala"}))

    assert result.success is True
    assert result.data["structured_markdown"] == "Padme Amidala is a senator from Naboo."


def test_mediawiki_api_salvages_disambiguation_intro() -> None:
    skill = WikipediaSkill()
    responses = [
        _search_response("Divine Intervention"),
        _api_page_response(
            title="Divine Intervention",
            extract=(
                "Divine intervention is an event that occurs when a deity becomes "
                "actively involved in changing some situation in human affairs.\n\n"
                "Divine Intervention may also refer to:"
            ),
            pageprops={"disambiguation": ""},
        ),
    ]

    with patch(
        "lokidoki.skills.knowledge.skill.httpx.AsyncClient",
        side_effect=lambda **kwargs: _MockAsyncClient(responses, **kwargs),
    ):
        result = asyncio.run(skill.execute_mechanism("mediawiki_api", {"query": "divine intervention"}))

    assert result.success is True
    assert result.data["lead"].endswith("human affairs.")
    assert "may also refer to" not in result.data["lead"].lower()
    assert "media" not in result.data


def test_web_scraper_salvages_disambiguation_intro() -> None:
    html = """
    <div id="mw-content-text">
      <p>Divine intervention is an event that occurs when a deity becomes actively involved in changing some situation in human affairs.</p>
      <p>Divine Intervention may also refer to:</p>
      <h2><span class="mw-headline">Music</span></h2>
      <ul><li>Divine Intervention (Slayer album)</li></ul>
    </div>
    """
    skill = WikipediaSkill()
    responses = [_search_response("Divine Intervention"), _MockResponse(text=html)]

    with patch(
        "lokidoki.skills.knowledge.skill.httpx.AsyncClient",
        side_effect=lambda **kwargs: _MockAsyncClient(responses, **kwargs),
    ):
        result = asyncio.run(skill.execute_mechanism("web_scraper", {"query": "divine intervention"}))

    assert result.success is True
    assert result.data["lead"].endswith("human affairs.")
    assert "may also refer to" not in result.data["lead"].lower()
