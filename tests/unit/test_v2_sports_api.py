from __future__ import annotations

from typing import Any

import pytest


class _FakeResponse:
    def __init__(self, status_code: int, payload: Any) -> None:
        self.status_code = status_code
        self._payload = payload

    def json(self) -> Any:
        return self._payload


class _FakeClient:
    def __init__(self, responses: list[_FakeResponse]) -> None:
        self._responses = responses

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return None

    async def get(self, url: str, **kwargs: Any) -> _FakeResponse:
        return self._responses.pop(0)


@pytest.mark.anyio
async def test_sports_score_uses_espn_scoreboard(monkeypatch):
    from v2.orchestrator.skills import sports_api

    fake = _FakeClient([
        _FakeResponse(200, {
            "events": [
                {
                    "name": "Los Angeles Lakers at Boston Celtics",
                    "competitions": [{
                        "competitors": [
                            {"team": {"displayName": "Los Angeles Lakers"}, "score": "101"},
                            {"team": {"displayName": "Boston Celtics"}, "score": "99"},
                        ],
                        "status": {"type": {"description": "Final"}},
                    }],
                }
            ]
        })
    ])
    monkeypatch.setattr(sports_api.httpx, "AsyncClient", lambda **kwargs: fake)

    result = await sports_api.get_score({"chunk_text": "what is the score of the Lakers game"})

    assert "101" in result["output_text"]
    assert "99" in result["output_text"]


@pytest.mark.anyio
async def test_sports_standings_uses_espn_standings(monkeypatch):
    from v2.orchestrator.skills import sports_api

    fake = _FakeClient([
        _FakeResponse(200, {
            "children": [{
                "standings": {
                    "entries": [
                        {"team": {"displayName": "Boston Celtics"}, "stats": [{"name": "wins", "value": 55}, {"name": "losses", "value": 20}]}
                    ]
                }
            }]
        })
    ])
    monkeypatch.setattr(sports_api.httpx, "AsyncClient", lambda **kwargs: fake)

    result = await sports_api.get_standings({"chunk_text": "NBA standings"})

    assert "Boston Celtics" in result["output_text"]


@pytest.mark.anyio
async def test_sports_schedule_uses_espn_scoreboard(monkeypatch):
    from v2.orchestrator.skills import sports_api

    fake = _FakeClient([
        _FakeResponse(200, {
            "events": [
                {
                    "name": "New York Yankees vs Boston Red Sox",
                    "date": "2026-04-12T19:00Z",
                }
            ]
        })
    ])
    monkeypatch.setattr(sports_api.httpx, "AsyncClient", lambda **kwargs: fake)

    result = await sports_api.get_schedule({"chunk_text": "when do the Yankees play next"})

    assert "Yankees" in result["output_text"]
    assert "2026-04-12" in result["output_text"]
