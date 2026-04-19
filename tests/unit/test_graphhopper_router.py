"""Tests for :mod:`lokidoki.maps.routing.graphhopper`."""
from __future__ import annotations

import asyncio
import json
from typing import Any

import pytest

from lokidoki.maps.routing import (
    LatLon,
    RouteRequest,
    RouterUnavailable,
)
from lokidoki.maps.routing import graphhopper as graphhopper_mod
from lokidoki.maps.routing.lifecycle import RouterLifecycle


@pytest.fixture(autouse=True)
def _clear_singleton():
    graphhopper_mod.set_router(None)
    yield
    graphhopper_mod.set_router(None)


def _mk_router() -> graphhopper_mod.GraphHopperRouter:
    router = graphhopper_mod.GraphHopperRouter(port=18002)
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
    def __init__(self, on_post, on_get=None) -> None:
        self._on_post = on_post
        self._on_get = on_get

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_: object) -> None:
        return None

    async def post(self, url: str, json: dict[str, Any]) -> _FakeResponse:
        return await self._on_post(url, json)

    async def get(self, url: str) -> _FakeResponse:
        assert self._on_get is not None
        return await self._on_get(url)


@pytest.fixture
def _patch_ensure(monkeypatch):
    async def _noop(self, region_id):  # noqa: ARG001
        self._process = object()
        self._active_region = region_id

    monkeypatch.setattr(graphhopper_mod.GraphHopperRouter, "ensure_started", _noop)
    monkeypatch.setattr(
        graphhopper_mod.GraphHopperRouter,
        "_pick_region",
        staticmethod(lambda _origin, _destination: "us-ct"),
    )


def test_route_maps_request_to_graphhopper_body(monkeypatch, _patch_ensure):
    captured: dict[str, Any] = {}

    async def on_post(url: str, body: dict[str, Any]) -> _FakeResponse:
        captured["url"] = url
        captured["body"] = body
        return _FakeResponse(200, {
            "paths": [{
                "time": 120_000.0,
                "distance": 5_000.0,
                "points": {"type": "LineString", "coordinates": [[-73.3, 41.1], [-73.0, 41.3]]},
                "instructions": [
                    {"text": "Head north.", "distance": 2500.0, "time": 60_000.0, "sign": 0, "interval": [0, 3]},
                    {"text": "Arrive.", "distance": 2500.0, "time": 60_000.0, "sign": 4, "interval": [3, 6]},
                ],
            }],
        })

    monkeypatch.setattr(
        graphhopper_mod.httpx,
        "AsyncClient",
        lambda **_kwargs: _FakeClient(on_post),
    )

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
    assert response.instructions_text[0] == "Head north."
    assert len(response.maneuvers) == 2
    body = captured["body"]
    assert body["profile"] == "car"
    assert body["instructions"] is True
    assert body["points_encoded"] is False
    assert body["algorithm"] == "alternative_route"
    assert body["alternative_route.max_paths"] == 3


def test_route_500_raises_router_unavailable(monkeypatch, _patch_ensure):
    async def on_post(url: str, body: dict[str, Any]) -> _FakeResponse:
        return _FakeResponse(502, {"error": "bad gateway"})

    monkeypatch.setattr(
        graphhopper_mod.httpx,
        "AsyncClient",
        lambda **_kwargs: _FakeClient(on_post),
    )

    router = _mk_router()
    req = RouteRequest(origin=LatLon(0, 0), destination=LatLon(1, 1))
    with pytest.raises(RouterUnavailable):
        asyncio.run(router.route(req))


def test_route_connection_refused_raises_router_unavailable(monkeypatch, _patch_ensure):
    import httpx as _httpx

    async def on_post(url: str, body: dict[str, Any]) -> _FakeResponse:
        raise _httpx.ConnectError("connection refused")

    monkeypatch.setattr(
        graphhopper_mod.httpx,
        "AsyncClient",
        lambda **_kwargs: _FakeClient(on_post),
    )

    router = _mk_router()
    req = RouteRequest(origin=LatLon(0, 0), destination=LatLon(1, 1))
    with pytest.raises(RouterUnavailable):
        asyncio.run(router.route(req))


def test_eta_returns_duration_and_distance(monkeypatch, _patch_ensure):
    async def on_post(url: str, body: dict[str, Any]) -> _FakeResponse:
        return _FakeResponse(200, {"paths": [{"time": 300_000.0, "distance": 10_000.0, "instructions": []}]})

    monkeypatch.setattr(
        graphhopper_mod.httpx,
        "AsyncClient",
        lambda **_kwargs: _FakeClient(on_post),
    )

    router = _mk_router()
    duration, distance = asyncio.run(router.eta(
        LatLon(41.1, -73.3), LatLon(41.2, -73.1),
    ))
    assert duration == 300.0
    assert distance == 10_000.0


def test_pick_region_rejects_uncovered_endpoints(tmp_path):
    from lokidoki.maps import store
    from lokidoki.maps.models import MapRegionState

    store.set_data_dir(tmp_path)
    try:
        state = MapRegionState(region_id="us-ct", valhalla_installed=True)
        store.upsert_state(state)
        with pytest.raises(RouterUnavailable):
            graphhopper_mod.GraphHopperRouter._pick_region(
                LatLon(41.2, -73.0),
                LatLon(34.0, -118.2),
            )
    finally:
        store.set_data_dir(None)


class _DummyProc:
    def __init__(self) -> None:
        self.returncode: int | None = None
        self.terminate_calls = 0
        self.kill_calls = 0

    def poll(self) -> int | None:
        return self.returncode

    def terminate(self) -> None:
        self.terminate_calls += 1
        self.returncode = 0

    def kill(self) -> None:
        self.kill_calls += 1
        self.returncode = -9

    def wait(self) -> int:
        return self.returncode if self.returncode is not None else 0

    def simulate_crash(self, code: int = 137) -> None:
        self.returncode = code


class _FakeRouter:
    def __init__(self) -> None:
        self._process: _DummyProc | None = None
        self._active_region: str | None = None
        self.spawn_count = 0
        self.stop_count = 0
        self.health_delay_s = 0.0

    def _spawn_locked(self, region_id: str) -> None:
        self.spawn_count += 1
        self._process = _DummyProc()

    async def _wait_healthy(self) -> None:
        if self.health_delay_s:
            await asyncio.sleep(self.health_delay_s)

    async def _stop_locked(self) -> None:
        self.stop_count += 1
        self._process = None
        self._active_region = None


@pytest.fixture
def _event_loop():
    loop = asyncio.new_event_loop()
    try:
        yield loop
    finally:
        loop.close()


def test_lifecycle_ensure_started_spawns_once_per_region(_event_loop):
    async def _go():
        router = _FakeRouter()
        lifecycle = RouterLifecycle(router, idle_timeout_s=60, watchdog_interval_s=60)
        await lifecycle.ensure_started("us-ct")
        await lifecycle.ensure_started("us-ct")
        assert router.spawn_count == 1
        if lifecycle._watchdog_task is not None:
            lifecycle._watchdog_task.cancel()

    _event_loop.run_until_complete(_go())


def test_lifecycle_region_switch_respawns(_event_loop):
    async def _go():
        router = _FakeRouter()
        lifecycle = RouterLifecycle(router, idle_timeout_s=60, watchdog_interval_s=60)
        await lifecycle.ensure_started("us-ct")
        await lifecycle.ensure_started("us-ma")
        assert router.spawn_count == 2
        assert router.stop_count == 1
        if lifecycle._watchdog_task is not None:
            lifecycle._watchdog_task.cancel()

    _event_loop.run_until_complete(_go())


def test_lifecycle_watchdog_shuts_down_after_idle(_event_loop):
    async def _go():
        router = _FakeRouter()
        lifecycle = RouterLifecycle(router, idle_timeout_s=0.1, watchdog_interval_s=0.05)
        await lifecycle.ensure_started("us-ct")
        await asyncio.sleep(0.5)
        assert router._process is None
        assert router.stop_count >= 1

    _event_loop.run_until_complete(_go())


def test_lifecycle_env_override(monkeypatch):
    monkeypatch.setenv("LOKIDOKI_ROUTER_IDLE_S", "42")
    lifecycle = RouterLifecycle(_FakeRouter())
    assert lifecycle.idle_timeout_s == 42


def test_lifecycle_env_override_falls_back_to_legacy_name(monkeypatch):
    monkeypatch.delenv("LOKIDOKI_ROUTER_IDLE_S", raising=False)
    monkeypatch.setenv("LOKIDOKI_VALHALLA_IDLE_S", "17")
    lifecycle = RouterLifecycle(_FakeRouter())
    assert lifecycle.idle_timeout_s == 17


def test_router_route_touches_lifecycle(monkeypatch, _patch_ensure):
    async def on_post(url: str, body: dict[str, Any]) -> _FakeResponse:
        return _FakeResponse(200, {"paths": [{"time": 60_000.0, "distance": 1_000.0, "instructions": []}]})

    monkeypatch.setattr(
        graphhopper_mod.httpx,
        "AsyncClient",
        lambda **_kwargs: _FakeClient(on_post),
    )

    router = _mk_router()
    assert router.lifecycle.last_request_at == 0.0
    req = RouteRequest(origin=LatLon(0, 0), destination=LatLon(1, 1))
    asyncio.run(router.route(req))
    assert router.lifecycle.last_request_at > 0.0


def test_parse_route_flattens_alternates():
    payload = {
        "paths": [
            {
                "time": 60_000.0,
                "distance": 1_000.0,
                "points": {"type": "LineString", "coordinates": [[0, 0], [1, 1]]},
                "instructions": [],
            },
            {
                "time": 90_000.0,
                "distance": 1_500.0,
                "points": {"type": "LineString", "coordinates": [[0, 0], [2, 2]]},
                "instructions": [],
            },
        ],
    }
    response = graphhopper_mod._parse_route(payload, "auto")
    assert len(response.alternates) == 1
    assert response.alternates[0].duration_s == 90.0
    assert response.alternates[0].distance_m == 1500.0
    assert json.loads(response.alternates[0].geometry)["type"] == "LineString"
