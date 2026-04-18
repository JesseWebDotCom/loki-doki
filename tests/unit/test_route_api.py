"""Chunk 6 — tests for ``POST /api/v1/maps/route`` + ``GET /eta``.

The local Valhalla router is monkeypatched to return a canned
:class:`RouteResponse`, and the online OSRM fallback is monkeypatched
to raise so we can assert the local path is preferred.
"""
from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from lokidoki.api.routes import maps as maps_routes
from lokidoki.maps import store
from lokidoki.maps.routing import (
    LocalRouterUnavailable,
    Maneuver,
    RouteAlternate,
    RouteResponse,
)
from lokidoki.maps.routing import valhalla as valhalla_mod


@pytest.fixture(autouse=True)
def _tmp_data_dir(tmp_path):
    store.set_data_dir(tmp_path)
    valhalla_mod.set_router(None)
    yield
    store.set_data_dir(None)
    valhalla_mod.set_router(None)


def _client() -> TestClient:
    app = FastAPI()
    app.include_router(maps_routes.router, prefix="/api/v1/maps", tags=["Maps"])
    return TestClient(app)


class _FakeRouter:
    def __init__(self, response: RouteResponse | None = None, raise_unavailable: bool = False):
        self._response = response
        self._raise = raise_unavailable
        self.calls = 0

    async def route(self, request):  # noqa: ARG002
        self.calls += 1
        if self._raise:
            raise LocalRouterUnavailable("test")
        assert self._response is not None
        return self._response

    async def eta(self, origin, destination, profile="auto"):  # noqa: ARG002
        if self._raise:
            raise LocalRouterUnavailable("test")
        assert self._response is not None
        return self._response.duration_s, self._response.distance_m


def _make_response() -> RouteResponse:
    return RouteResponse(
        duration_s=600.0,
        distance_m=10_000.0,
        geometry="poly",
        maneuvers=(
            Maneuver(instruction="Head north.", distance_m=1000.0, duration_s=60.0,
                     begin_shape_index=0, end_shape_index=3, type=1),
            Maneuver(instruction="Arrive.", distance_m=0.0, duration_s=0.0,
                     begin_shape_index=3, end_shape_index=3, type=4),
        ),
        instructions_text=("Head north.", "Arrive."),
        alternates=(
            RouteAlternate(duration_s=720.0, distance_m=11_000.0, geometry="alt"),
        ),
        profile="auto",
    )


def test_post_route_returns_local_shape(monkeypatch):
    fake = _FakeRouter(response=_make_response())
    monkeypatch.setattr(valhalla_mod, "get_router", lambda: fake)

    client = _client()
    r = client.post("/api/v1/maps/route", json={
        "origin": {"lat": 41.1, "lon": -73.3},
        "destination": {"lat": 41.3, "lon": -73.0},
        "profile": "auto",
        "alternates": 1,
    })
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["mechanism_used"] == "valhalla"
    assert body["routes"][0]["duration_s"] == 600.0
    assert body["routes"][0]["distance_m"] == 10_000.0
    assert len(body["routes"][0]["legs"][0]["steps"]) == 2
    assert body["instructions_text"] == ["Head north.", "Arrive."]
    assert body["alternates"][0]["duration_s"] == 720.0


def test_post_route_falls_back_to_osrm(monkeypatch):
    fake_local = _FakeRouter(raise_unavailable=True)
    monkeypatch.setattr(valhalla_mod, "get_router", lambda: fake_local)

    from lokidoki.maps.routing import online_fallback

    class _FakeOSRM:
        async def route(self, request):  # noqa: ARG002
            return _make_response()

        async def eta(self, origin, destination, profile="auto"):  # noqa: ARG002
            return 600.0, 10_000.0

    monkeypatch.setattr(online_fallback, "OnlineOSRMRouter", _FakeOSRM)
    monkeypatch.setattr(maps_routes, "OnlineOSRMRouter", _FakeOSRM)

    client = _client()
    r = client.post("/api/v1/maps/route", json={
        "origin": {"lat": 41.1, "lon": -73.3},
        "destination": {"lat": 41.3, "lon": -73.0},
        "profile": "auto",
    })
    assert r.status_code == 200, r.text
    assert r.json()["mechanism_used"] == "osrm"


def test_post_route_unknown_profile_is_400(monkeypatch):
    fake = _FakeRouter(response=_make_response())
    monkeypatch.setattr(valhalla_mod, "get_router", lambda: fake)

    client = _client()
    r = client.post("/api/v1/maps/route", json={
        "origin": {"lat": 41.1, "lon": -73.3},
        "destination": {"lat": 41.3, "lon": -73.0},
        "profile": "spaceship",
    })
    assert r.status_code == 400


def test_post_route_avoid_highways_propagates(monkeypatch):
    captured_request = {}

    class _CaptureRouter:
        async def route(self, request):
            captured_request["avoid"] = request.avoid
            return _make_response()

        async def eta(self, *a, **k):  # pragma: no cover — unused
            raise NotImplementedError

    monkeypatch.setattr(valhalla_mod, "get_router", lambda: _CaptureRouter())

    client = _client()
    r = client.post("/api/v1/maps/route", json={
        "origin": {"lat": 41.1, "lon": -73.3},
        "destination": {"lat": 41.3, "lon": -73.0},
        "profile": "auto",
        "avoid": {"highways": True, "tolls": False, "ferries": True},
    })
    assert r.status_code == 200, r.text
    avoid = captured_request["avoid"]
    assert avoid.highways is True
    assert avoid.tolls is False
    assert avoid.ferries is True


def test_eta_endpoint_returns_duration_and_distance(monkeypatch):
    fake = _FakeRouter(response=_make_response())
    monkeypatch.setattr(valhalla_mod, "get_router", lambda: fake)

    client = _client()
    r = client.get(
        "/api/v1/maps/eta",
        params={
            "o_lat": 41.1, "o_lon": -73.3,
            "d_lat": 41.3, "d_lon": -73.0,
            "profile": "auto",
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["duration_s"] == 600.0
    assert body["distance_m"] == 10_000.0
    assert body["mechanism_used"] == "valhalla"


def test_eta_unknown_profile_is_400(monkeypatch):
    fake = _FakeRouter(response=_make_response())
    monkeypatch.setattr(valhalla_mod, "get_router", lambda: fake)

    client = _client()
    r = client.get(
        "/api/v1/maps/eta",
        params={"o_lat": 0, "o_lon": 0, "d_lat": 1, "d_lon": 1, "profile": "helicopter"},
    )
    assert r.status_code == 400
