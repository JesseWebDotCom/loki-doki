"""Chunk 6 — unit tests for :mod:`lokidoki.maps.routing.valhalla`.

Every HTTP call is monkeypatched, and spawn is stubbed out — these
tests never touch a real Valhalla process or a real network.
"""
from __future__ import annotations

import asyncio
from typing import Any

import pytest

from lokidoki.maps.routing import (
    AvoidOpts,
    LatLon,
    RouteRequest,
    ValhallaUnavailable,
)
from lokidoki.maps.routing import valhalla as valhalla_mod


@pytest.fixture(autouse=True)
def _clear_singleton():
    valhalla_mod.set_router(None)
    yield
    valhalla_mod.set_router(None)


def _mk_router() -> valhalla_mod.ValhallaRouter:
    router = valhalla_mod.ValhallaRouter(port=18002)
    # Pretend we already started — skips the spawn path entirely.
    router._process = object()  # type: ignore[assignment]
    router._active_region = "us-ct"
    return router


class _FakeResponse:
    def __init__(self, status_code: int, payload: dict[str, Any]) -> None:
        self.status_code = status_code
        self._payload = payload
        self.text = ""

    def json(self) -> dict[str, Any]:
        return self._payload


class _FakeClient:
    """Minimal async httpx.AsyncClient replacement for tests."""

    def __init__(self, on_post, on_get=None) -> None:
        self._on_post = on_post
        self._on_get = on_get
        self.last_body: dict[str, Any] | None = None
        self.last_url: str | None = None

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_: object) -> None:
        return None

    async def post(self, url: str, json: dict[str, Any]) -> _FakeResponse:
        self.last_url = url
        self.last_body = json
        return await self._on_post(url, json)

    async def get(self, url: str) -> _FakeResponse:
        self.last_url = url
        assert self._on_get is not None
        return await self._on_get(url)


@pytest.fixture
def _patch_ensure(monkeypatch):
    async def _noop(self, region_id):  # noqa: ARG001
        self._process = object()
        self._active_region = region_id

    monkeypatch.setattr(
        valhalla_mod.ValhallaRouter, "ensure_started", _noop,
    )

    def _pick(_origin, _destination):
        return "us-ct"

    monkeypatch.setattr(
        valhalla_mod.ValhallaRouter, "_pick_region", staticmethod(_pick),
    )


def test_route_maps_auto_profile_to_valhalla_body(monkeypatch, _patch_ensure):
    captured: dict[str, Any] = {}

    async def on_post(url: str, body: dict[str, Any]) -> _FakeResponse:
        captured["url"] = url
        captured["body"] = body
        return _FakeResponse(200, {
            "trip": {
                "summary": {"time": 120.0, "length": 5.0},
                "legs": [{
                    "shape": "polyline-here",
                    "maneuvers": [
                        {"instruction": "Head north.", "length": 2.5, "time": 60.0,
                         "begin_shape_index": 0, "end_shape_index": 3, "type": 1},
                        {"instruction": "Arrive.", "length": 2.5, "time": 60.0,
                         "begin_shape_index": 3, "end_shape_index": 6, "type": 4},
                    ],
                }],
            },
        })

    def _client_factory(**_kwargs):
        return _FakeClient(on_post)

    monkeypatch.setattr(valhalla_mod.httpx, "AsyncClient", _client_factory)

    router = _mk_router()
    req = RouteRequest(
        origin=LatLon(41.1, -73.3),
        destination=LatLon(41.3, -73.0),
        profile="auto",
        alternates=2,
    )

    response = asyncio.run(router.route(req))
    assert response.duration_s == 120.0
    assert response.distance_m == 5000.0
    assert response.profile == "auto"
    assert len(response.maneuvers) == 2
    assert response.instructions_text[0] == "Head north."
    # Body carries canonical Valhalla shape.
    body = captured["body"]
    assert body["costing"] == "auto"
    assert body["alternates"] == 2
    assert len(body["locations"]) == 2
    assert body["locations"][0]["type"] == "break"


def test_route_propagates_avoid_flags(monkeypatch, _patch_ensure):
    captured: dict[str, Any] = {}

    async def on_post(url: str, body: dict[str, Any]) -> _FakeResponse:
        captured["body"] = body
        return _FakeResponse(200, {"trip": {"summary": {"time": 0, "length": 0}, "legs": []}})

    monkeypatch.setattr(
        valhalla_mod.httpx, "AsyncClient",
        lambda **_kwargs: _FakeClient(on_post),
    )

    router = _mk_router()
    req = RouteRequest(
        origin=LatLon(41.1, -73.3),
        destination=LatLon(41.3, -73.0),
        profile="bicycle",
        avoid=AvoidOpts(highways=True, ferries=True),
    )
    asyncio.run(router.route(req))

    opts = captured["body"]["costing_options"]["bicycle"]
    assert opts.get("exclude_highway") is True
    assert opts.get("exclude_ferry") is True
    assert "exclude_toll" not in opts


def test_route_500_raises_valhalla_unavailable(monkeypatch, _patch_ensure):
    async def on_post(url: str, body: dict[str, Any]) -> _FakeResponse:
        return _FakeResponse(502, {"error": "bad gateway"})

    monkeypatch.setattr(
        valhalla_mod.httpx, "AsyncClient",
        lambda **_kwargs: _FakeClient(on_post),
    )

    router = _mk_router()
    req = RouteRequest(origin=LatLon(0, 0), destination=LatLon(1, 1))
    with pytest.raises(ValhallaUnavailable):
        asyncio.run(router.route(req))


def test_route_connection_refused_raises_valhalla_unavailable(monkeypatch, _patch_ensure):
    import httpx as _httpx

    async def on_post(url: str, body: dict[str, Any]) -> _FakeResponse:
        raise _httpx.ConnectError("connection refused")

    monkeypatch.setattr(
        valhalla_mod.httpx, "AsyncClient",
        lambda **_kwargs: _FakeClient(on_post),
    )

    router = _mk_router()
    req = RouteRequest(origin=LatLon(0, 0), destination=LatLon(1, 1))
    with pytest.raises(ValhallaUnavailable):
        asyncio.run(router.route(req))


def test_eta_returns_duration_and_distance(monkeypatch, _patch_ensure):
    async def on_post(url: str, body: dict[str, Any]) -> _FakeResponse:
        return _FakeResponse(200, {
            "trip": {"summary": {"time": 300.0, "length": 10.0}, "legs": []},
        })

    monkeypatch.setattr(
        valhalla_mod.httpx, "AsyncClient",
        lambda **_kwargs: _FakeClient(on_post),
    )

    router = _mk_router()
    duration, distance = asyncio.run(router.eta(
        LatLon(41.1, -73.3), LatLon(41.2, -73.1),
    ))
    assert duration == 300.0
    assert distance == 10000.0


def test_pick_region_rejects_uncovered_endpoints(monkeypatch, tmp_path):
    from lokidoki.maps import store
    from lokidoki.maps.models import MapRegionState

    store.set_data_dir(tmp_path)
    try:
        # CT covers roughly (-73.7, 40.9, -71.8, 42.1). Origin inside,
        # destination far outside → must raise.
        state = MapRegionState(region_id="us-ct", valhalla_installed=True)
        store.upsert_state(state)

        origin = LatLon(41.2, -73.0)
        dest = LatLon(34.0, -118.2)  # Los Angeles
        with pytest.raises(ValhallaUnavailable):
            valhalla_mod.ValhallaRouter._pick_region(origin, dest)
    finally:
        store.set_data_dir(None)


def test_parse_route_flattens_alternates():
    payload = {
        "trip": {
            "summary": {"time": 60.0, "length": 1.0},
            "legs": [{"shape": "x", "maneuvers": []}],
        },
        "alternates": [
            {"trip": {
                "summary": {"time": 90.0, "length": 1.5},
                "legs": [{"shape": "alt-shape"}],
            }},
        ],
    }
    response = valhalla_mod._parse_route(payload, "auto")
    assert len(response.alternates) == 1
    assert response.alternates[0].duration_s == 90.0
    assert response.alternates[0].distance_m == 1500.0
    assert response.alternates[0].geometry == "alt-shape"
