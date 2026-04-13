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
async def test_flight_status_uses_opensky(monkeypatch):
    from lokidoki.orchestrator.skills import travel

    fake = _FakeClient([
        _FakeResponse(200, {
            "states": [
                ["abc123", "AAL271 ", "United States", 0, 0, -73.0, 40.0, 10000, False, 250, 180, 0, None, 10100, "7000", False, 0],
            ]
        })
    ])
    monkeypatch.setattr(travel.httpx, "AsyncClient", lambda **kwargs: fake)

    result = await travel.get_flight_status({"chunk_text": "is AA 271 on time"})

    assert "AAL271" in result["output_text"]
    assert "10000" in result["output_text"]
