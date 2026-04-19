"""Env-gated Java-stack maps smoke test.

This intentionally exercises the real install path against the current
FastAPI maps router: download the CT PBF, build the geocoder, generate
``streets.pmtiles`` with planetiler, import the routing graph with
GraphHopper, then confirm ``/api/v1/maps/route`` returns maneuvers.

Skipped by default. Opt in with ``LOKIDOKI_MAPS_SMOKE=1`` after running
``./run.sh --maps-tools-only`` or a full bootstrap.
"""
from __future__ import annotations

import json
import os
import time
import asyncio
from pathlib import Path

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from lokidoki.api.routes import maps as maps_routes
from lokidoki.auth.dependencies import require_admin
from lokidoki.auth.users import User
from lokidoki.maps import store
from lokidoki.maps.routing import valhalla as valhalla_mod

_REGION_ID = "us-ct"
_TOOLS_ROOT = Path(".lokidoki/tools")
_SMOKE_ENABLED = os.environ.get("LOKIDOKI_MAPS_SMOKE", "").strip() == "1"
_SMOKE_MARK = pytest.mark.skipif(
    not _SMOKE_ENABLED,
    reason="set LOKIDOKI_MAPS_SMOKE=1 to run the real maps smoke test",
)


def _admin_override() -> User:
    return User(
        id=1,
        username="leia",
        role="admin",
        status="active",
        last_password_auth_at=1,
    )


def _app() -> FastAPI:
    app = FastAPI()
    app.include_router(maps_routes.router, prefix="/api/v1/maps", tags=["Maps"])
    app.dependency_overrides[require_admin] = _admin_override
    return app


async def _wait_for_install_events(region_id: str, *, timeout_s: float = 300.0) -> list[dict]:
    """Drain the queue that powers the SSE progress endpoint until completion."""
    handle = maps_routes._active.get(region_id)
    assert handle is not None, f"expected active install handle for {region_id}"
    events: list[dict] = []
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        remaining = max(0.1, deadline - time.monotonic())
        progress = await asyncio.wait_for(handle.queue.get(), timeout=remaining)
        payload = json.loads(json.dumps(progress.__dict__))
        events.append(payload)
        if payload["phase"] == "complete":
            return events
    pytest.fail(f"timed out waiting for install completion for {region_id}")
    return events


def _require_bootstrap_tools() -> None:
    java_bin = _TOOLS_ROOT / "jre" / "bin" / ("java.exe" if os.name == "nt" else "java")
    planetiler_jar = _TOOLS_ROOT / "planetiler" / "planetiler.jar"
    graphhopper_jar = _TOOLS_ROOT / "graphhopper" / "graphhopper.jar"
    missing = [path for path in (java_bin, planetiler_jar, graphhopper_jar) if not path.exists()]
    if missing:
        formatted = ", ".join(str(path) for path in missing)
        pytest.fail(
            "maps smoke requires bootstrap-installed Java tools; missing "
            f"{formatted}. Run ./run.sh --maps-tools-only first."
        )


@pytest.fixture(autouse=True)
def _tmp_data_dir(tmp_path):
    store.set_data_dir(tmp_path)
    maps_routes._active.clear()
    valhalla_mod.set_router(None)
    yield tmp_path
    store.set_data_dir(None)
    maps_routes._active.clear()
    valhalla_mod.set_router(None)


def _client() -> AsyncClient:
    return AsyncClient(transport=ASGITransport(_app()), base_url="http://test")


@_SMOKE_MARK
@pytest.mark.anyio
async def test_maps_java_smoke_installs_ct_and_routes():
    _require_bootstrap_tools()
    async with _client() as client:
        response = await client.put(
            f"/api/v1/maps/regions/{_REGION_ID}",
            json={"street": True},
        )
        assert response.status_code == 200, response.text
        assert response.json()["installing"] is True

        started = time.monotonic()
        events = await _wait_for_install_events(_REGION_ID)
        elapsed_s = time.monotonic() - started

        assert events, "expected install progress events"
        phases = [event.get("phase") for event in events if event.get("phase")]
        assert "building_geocoder" in phases
        assert "building_streets" in phases
        assert "building_routing" in phases

        terminal = events[-1]
        assert terminal["phase"] == "complete"
        assert terminal["artifact"] == "done", terminal
        assert not terminal.get("error"), terminal

        region_dir = store.region_dir(_REGION_ID)
        assert (region_dir / "streets.pmtiles").is_file()
        assert (region_dir / "valhalla" / "graph-cache").is_dir()

        route = await client.post(
            "/api/v1/maps/route",
            json={
                "origin": {"lat": 41.7658, "lon": -72.6734},
                "destination": {"lat": 41.7621, "lon": -72.7420},
                "profile": "auto",
                "alternates": 1,
            },
        )
        assert route.status_code == 200, route.text
        body = route.json()
        assert body["routes"], body
        assert body["routes"][0]["legs"], body
        assert body["routes"][0]["legs"][0]["steps"], body
        assert body["routes"][0]["legs"][0]["steps"][0]["instruction"]
        assert elapsed_s > 0
