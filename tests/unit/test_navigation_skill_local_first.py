"""Chunk 6 — the navigation skill must prefer the local Valhalla router.

These tests monkeypatch both routers and verify:

  * ``get_directions`` tries the local router first and never touches
    remote OSRM when the local call succeeds.
  * When the local router raises :class:`LocalRouterUnavailable`, the
    skill falls back to the remote OSRM wrapper.
  * The adapter payload's ``mechanism_used`` + ``data`` fields are the
    same shape pre- and post-Chunk-6 so downstream callers are
    unaffected.
"""
from __future__ import annotations

import asyncio

import pytest

from lokidoki.maps.routing import (
    LocalRouterUnavailable,
    Maneuver,
    RouteResponse,
)
from lokidoki.maps.routing import valhalla as valhalla_mod
from lokidoki.orchestrator.skills import navigation


@pytest.fixture(autouse=True)
def _clear_router():
    valhalla_mod.set_router(None)
    yield
    valhalla_mod.set_router(None)


def _fake_response() -> RouteResponse:
    return RouteResponse(
        duration_s=1800.0,
        distance_m=32_186.88,  # 20 miles
        geometry="x",
        maneuvers=(
            Maneuver(instruction="Head north.", distance_m=100.0, duration_s=60.0,
                     begin_shape_index=0, end_shape_index=1, type=1),
        ),
        instructions_text=("Head north.",),
        alternates=(),
        profile="auto",
    )


def _patch_geocode(monkeypatch, coords=(40.758, -73.985)):
    async def _fake_geocode(_place):
        return coords

    monkeypatch.setattr(navigation, "_geocode", _fake_geocode)


def test_get_directions_uses_local_router_when_available(monkeypatch):
    _patch_geocode(monkeypatch)

    called = {"local": 0, "remote": 0}

    class _Local:
        async def route(self, _request):
            called["local"] += 1
            return _fake_response()

        async def eta(self, *a, **k):  # pragma: no cover — unused
            raise NotImplementedError

    class _Remote:
        async def route(self, _request):
            called["remote"] += 1
            return _fake_response()

    monkeypatch.setattr(navigation, "get_router", lambda: _Local())
    monkeypatch.setattr(navigation, "OnlineOSRMRouter", lambda: _Remote())

    payload = asyncio.run(navigation.get_directions({
        "chunk_text": "how do I drive from Brooklyn to Manhattan",
    }))

    assert payload["success"] is True
    assert payload["mechanism_used"] == "valhalla"
    assert called["local"] == 1
    assert called["remote"] == 0
    # Data shape must be unchanged — downstream prompt templates depend on it.
    assert "distance_miles" in payload["data"]
    assert "duration_seconds" in payload["data"]
    assert payload["data"]["duration_seconds"] == 1800.0


def test_get_directions_falls_back_to_remote_when_local_unavailable(monkeypatch):
    _patch_geocode(monkeypatch)

    called = {"local": 0, "remote": 0}

    class _Local:
        async def route(self, _request):
            called["local"] += 1
            raise LocalRouterUnavailable("no tiles for that area")

        async def eta(self, *a, **k):  # pragma: no cover — unused
            raise NotImplementedError

    class _Remote:
        async def route(self, _request):
            called["remote"] += 1
            return _fake_response()

    monkeypatch.setattr(navigation, "get_router", lambda: _Local())
    monkeypatch.setattr(navigation, "OnlineOSRMRouter", lambda: _Remote())

    payload = asyncio.run(navigation.get_directions({
        "chunk_text": "drive from foo to bar",
    }))

    assert payload["success"] is True
    assert payload["mechanism_used"] == "osrm"
    assert called["local"] == 1
    assert called["remote"] == 1


def test_get_eta_delegates_to_get_directions(monkeypatch):
    _patch_geocode(monkeypatch)

    class _Local:
        async def route(self, _request):
            return _fake_response()

        async def eta(self, *a, **k):  # pragma: no cover — unused
            raise NotImplementedError

    monkeypatch.setattr(navigation, "get_router", lambda: _Local())
    monkeypatch.setattr(navigation, "OnlineOSRMRouter", lambda: None)

    payload = asyncio.run(navigation.get_eta({
        "chunk_text": "how long will it take Brooklyn",
    }))
    assert payload["success"] is True
    assert payload["mechanism_used"] == "valhalla"


def test_get_directions_returns_graceful_error_when_both_fail(monkeypatch):
    _patch_geocode(monkeypatch)

    class _Local:
        async def route(self, _request):
            raise LocalRouterUnavailable("no local")

        async def eta(self, *a, **k):  # pragma: no cover — unused
            raise NotImplementedError

    class _Remote:
        async def route(self, _request):
            raise LocalRouterUnavailable("remote also down")

    monkeypatch.setattr(navigation, "get_router", lambda: _Local())
    monkeypatch.setattr(navigation, "OnlineOSRMRouter", lambda: _Remote())

    payload = asyncio.run(navigation.get_directions({
        "chunk_text": "drive from foo to bar",
    }))
    assert payload["success"] is False
