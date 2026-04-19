"""Tile-serving routes — Chunk 3 of the offline-maps plan.

Covers:

* Range-aware streams of ``streets.pmtiles`` (MapLibre's PMTiles
  protocol issues byte-range reads for the directory + tile blobs).
* 404 when the region has been selected but not yet installed.
* Directory-traversal rejection — ``region_id`` must match the static
  catalog, not a filesystem path.
* World-overview tile route (``/tiles/_overview/streets.pmtiles``) —
  404 when the bootstrap artifact is missing, 200 + Range support when
  present. The literal ``_overview`` segment must win over the
  parameterised ``/tiles/{region_id}/`` route.
"""
from __future__ import annotations

from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from lokidoki.api.routes import maps as maps_routes
from lokidoki.auth.dependencies import require_admin
from lokidoki.auth.users import User
from lokidoki.maps import store


@pytest.fixture(autouse=True)
def _tmp_data_dir(tmp_path):
    store.set_data_dir(tmp_path)
    maps_routes._active.clear()
    yield
    store.set_data_dir(None)
    maps_routes._active.clear()


def _admin_override() -> User:
    return User(
        id=1, username="padme", role="admin",
        status="active", last_password_auth_at=1,
    )


def _client() -> TestClient:
    app = FastAPI()
    app.include_router(maps_routes.router, prefix="/api/v1/maps", tags=["Maps"])
    app.dependency_overrides[require_admin] = _admin_override
    return TestClient(app)


def _write_fake_pmtiles(region_id: str, size_bytes: int) -> bytes:
    """Write deterministic bytes to ``streets.pmtiles`` for ``region_id``."""
    payload = (b"\xAB\xCD" * ((size_bytes // 2) + 1))[:size_bytes]
    path = store.region_dir(region_id) / "streets.pmtiles"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(payload)
    return payload


# ── streets.pmtiles ───────────────────────────────────────────────

def test_streets_pmtiles_served_with_range_support():
    payload = _write_fake_pmtiles("us-ct", 2 * 1024 * 1024)
    client = _client()
    r = client.get(
        "/api/v1/maps/tiles/us-ct/streets.pmtiles",
        headers={"Range": "bytes=0-15"},
    )
    assert r.status_code == 206, r.text
    assert r.content == payload[:16]
    # Starlette sets Content-Range on partial responses — surface it in
    # the assertion so a regression in FileResponse range handling is
    # immediately obvious.
    assert r.headers.get("content-range", "").startswith("bytes 0-15/")


def test_streets_pmtiles_full_body_without_range():
    payload = _write_fake_pmtiles("us-ct", 1024)
    client = _client()
    r = client.get("/api/v1/maps/tiles/us-ct/streets.pmtiles")
    assert r.status_code == 200, r.text
    assert r.content == payload
    assert r.headers.get("accept-ranges") == "bytes"
    assert "immutable" in r.headers.get("cache-control", "")


def test_streets_pmtiles_404_when_region_missing():
    # Region is valid in the catalog but nothing is on disk.
    client = _client()
    r = client.get("/api/v1/maps/tiles/us-ct/streets.pmtiles")
    assert r.status_code == 404


def test_directory_traversal_rejected():
    # An unknown region id (here a traversal attempt) must not resolve
    # to the parent directory. Starlette's path matcher rejects the
    # encoded slash in `..%2Fetc` with 404 before our validator runs —
    # that's equivalent safety, so accept either.
    client = _client()
    r = client.get("/api/v1/maps/tiles/..%2Fetc/streets.pmtiles")
    assert r.status_code in (400, 404)
    # Non-traversal but not-in-catalog ids go straight to our validator.
    r2 = client.get("/api/v1/maps/tiles/not-a-real-region/streets.pmtiles")
    assert r2.status_code == 400


# ── world-overview pmtiles ────────────────────────────────────────

@pytest.fixture
def overview_pmtiles_path(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> Path:
    path = tmp_path / "tools" / "planetiler" / "world-overview.pmtiles"
    path.parent.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(maps_routes, "_overview_pmtiles_path", lambda: path)
    return path


def test_overview_pmtiles_404_when_missing(overview_pmtiles_path: Path):
    # Fixture only prepares the directory; no file on disk.
    client = _client()
    r = client.get("/api/v1/maps/tiles/_overview/streets.pmtiles")
    assert r.status_code == 404, r.text
    assert "--maps-tools-only" in r.json()["detail"]


def test_overview_pmtiles_served_full_body(overview_pmtiles_path: Path):
    payload = (b"\xDE\xAD\xBE\xEF" * 256)
    overview_pmtiles_path.write_bytes(payload)
    client = _client()
    r = client.get("/api/v1/maps/tiles/_overview/streets.pmtiles")
    assert r.status_code == 200, r.text
    assert r.content == payload
    assert r.headers.get("accept-ranges") == "bytes"
    assert r.headers.get("content-type") == "application/octet-stream"
    assert "immutable" in r.headers.get("cache-control", "")


def test_overview_pmtiles_served_with_range_support(
    overview_pmtiles_path: Path,
):
    payload = bytes(range(256)) * 16  # 4 KB of deterministic bytes.
    overview_pmtiles_path.write_bytes(payload)
    client = _client()
    r = client.get(
        "/api/v1/maps/tiles/_overview/streets.pmtiles",
        headers={"Range": "bytes=0-15"},
    )
    assert r.status_code == 206, r.text
    assert r.content == payload[:16]
    assert r.headers.get("content-range", "").startswith("bytes 0-15/")
