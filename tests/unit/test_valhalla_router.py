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
from lokidoki.maps.routing.lifecycle import ValhallaLifecycle


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


# ── Chunk 6 — lifecycle tests ────────────────────────────────────


class _DummyProc:
    """Minimal ``subprocess.Popen``-compatible stub for lifecycle tests."""

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
    """Stand-in for :class:`ValhallaRouter` — records spawn attempts."""

    def __init__(self) -> None:
        self._process: _DummyProc | None = None
        self._active_region: str | None = None
        self.spawn_count = 0
        self.stop_count = 0
        self.health_delay_s = 0.0
        self.spawn_delay_s = 0.0

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


def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


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
        lifecycle = ValhallaLifecycle(
            router, idle_timeout_s=60, watchdog_interval_s=60,
        )
        await lifecycle.ensure_started("us-ct")
        await lifecycle.ensure_started("us-ct")
        await lifecycle.ensure_started("us-ct")
        assert router.spawn_count == 1
        assert router._active_region == "us-ct"
        # Stop the watchdog so the loop can close cleanly.
        if lifecycle._watchdog_task is not None:
            lifecycle._watchdog_task.cancel()

    _event_loop.run_until_complete(_go())


def test_lifecycle_region_switch_respawns(_event_loop):
    async def _go():
        router = _FakeRouter()
        lifecycle = ValhallaLifecycle(
            router, idle_timeout_s=60, watchdog_interval_s=60,
        )
        await lifecycle.ensure_started("us-ct")
        await lifecycle.ensure_started("us-ma")
        assert router.spawn_count == 2
        assert router.stop_count == 1
        assert router._active_region == "us-ma"
        if lifecycle._watchdog_task is not None:
            lifecycle._watchdog_task.cancel()

    _event_loop.run_until_complete(_go())


def test_lifecycle_concurrent_first_calls_share_one_spawn(_event_loop):
    async def _go():
        router = _FakeRouter()
        router.health_delay_s = 0.05  # force the race window open
        lifecycle = ValhallaLifecycle(
            router, idle_timeout_s=60, watchdog_interval_s=60,
        )
        await asyncio.gather(*[
            lifecycle.ensure_started("us-ct") for _ in range(5)
        ])
        assert router.spawn_count == 1, (
            "concurrent first-callers must share one cold-start"
        )
        if lifecycle._watchdog_task is not None:
            lifecycle._watchdog_task.cancel()

    _event_loop.run_until_complete(_go())


def test_lifecycle_watchdog_shuts_down_after_idle(_event_loop):
    async def _go():
        router = _FakeRouter()
        lifecycle = ValhallaLifecycle(
            router, idle_timeout_s=0.1, watchdog_interval_s=0.05,
        )
        await lifecycle.ensure_started("us-ct")
        assert router._process is not None
        # Wait longer than idle_timeout + watchdog_interval so the
        # watchdog has a chance to fire at least once.
        await asyncio.sleep(0.5)
        assert router._process is None
        assert router._active_region is None
        assert router.stop_count >= 1

    _event_loop.run_until_complete(_go())


def test_lifecycle_touch_keeps_process_warm(_event_loop):
    async def _go():
        router = _FakeRouter()
        lifecycle = ValhallaLifecycle(
            router, idle_timeout_s=0.25, watchdog_interval_s=0.05,
        )
        await lifecycle.ensure_started("us-ct")
        # Tap touch() repeatedly — faster than the idle ceiling — so
        # the watchdog never sees an expired clock.
        for _ in range(10):
            lifecycle.touch()
            await asyncio.sleep(0.05)
        assert router._process is not None, (
            "touch() must keep the sidecar warm while requests arrive"
        )
        if lifecycle._watchdog_task is not None:
            lifecycle._watchdog_task.cancel()

    _event_loop.run_until_complete(_go())


def test_lifecycle_detects_crash_and_respawns(_event_loop):
    async def _go():
        router = _FakeRouter()
        lifecycle = ValhallaLifecycle(
            router, idle_timeout_s=60, watchdog_interval_s=60,
        )
        await lifecycle.ensure_started("us-ct")
        assert router.spawn_count == 1
        # Valhalla died on its own — simulate by flipping the Popen
        # returncode. The next ensure_started must notice and respawn.
        assert router._process is not None
        router._process.simulate_crash(137)
        await lifecycle.ensure_started("us-ct")
        assert router.spawn_count == 2
        if lifecycle._watchdog_task is not None:
            lifecycle._watchdog_task.cancel()

    _event_loop.run_until_complete(_go())


def test_lifecycle_env_override(monkeypatch):
    monkeypatch.setenv("LOKIDOKI_VALHALLA_IDLE_S", "42")
    router = _FakeRouter()
    lifecycle = ValhallaLifecycle(router)
    assert lifecycle.idle_timeout_s == 42


def test_lifecycle_env_override_invalid_falls_back(monkeypatch):
    monkeypatch.setenv("LOKIDOKI_VALHALLA_IDLE_S", "not-a-number")
    router = _FakeRouter()
    lifecycle = ValhallaLifecycle(router)
    assert lifecycle.idle_timeout_s == 900  # documented default


def test_router_route_touches_lifecycle(monkeypatch, _patch_ensure):
    async def on_post(url: str, body: dict[str, Any]) -> _FakeResponse:
        return _FakeResponse(200, {
            "trip": {"summary": {"time": 60.0, "length": 1.0}, "legs": []},
        })

    monkeypatch.setattr(
        valhalla_mod.httpx, "AsyncClient",
        lambda **_kwargs: _FakeClient(on_post),
    )

    router = _mk_router()
    # Baseline — no touch yet.
    assert router.lifecycle.last_request_at == 0.0
    req = RouteRequest(origin=LatLon(0, 0), destination=LatLon(1, 1))
    asyncio.run(router.route(req))
    assert router.lifecycle.last_request_at > 0.0


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
