"""Maps API tests — Chunk 2 of the offline-maps plan.

Supersedes the minimal stub test from Chunk 1. We mount the maps
router on a bare FastAPI app so these tests never trip the bootstrap
gate middleware, then override ``require_admin`` for the endpoints
that demand admin auth.
"""
from __future__ import annotations

import asyncio

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from lokidoki.api.routes import maps as maps_routes
from lokidoki.auth.dependencies import require_admin
from lokidoki.auth.users import User
from lokidoki.maps import store
from lokidoki.maps.models import MapRegionState


@pytest.fixture(autouse=True)
def _tmp_data_dir(tmp_path):
    store.set_data_dir(tmp_path)
    # Clear any install tasks leaked by another test.
    maps_routes._active.clear()
    yield
    store.set_data_dir(None)
    maps_routes._active.clear()


def _admin_override() -> User:
    return User(
        id=1, username="padme", role="admin",
        status="active", last_password_auth_at=1,
    )


def _client(with_admin: bool = True) -> TestClient:
    app = FastAPI()
    app.include_router(maps_routes.router, prefix="/api/v1/maps", tags=["Maps"])
    if with_admin:
        app.dependency_overrides[require_admin] = _admin_override
    return TestClient(app)


# ── Catalog + empty-state ─────────────────────────────────────────

def test_catalog_tree_has_continents_at_root():
    client = _client()
    r = client.get("/api/v1/maps/catalog")
    assert r.status_code == 200, r.text
    roots = {entry["region_id"] for entry in r.json()["regions"]}
    assert {"na", "eu", "as"}.issubset(roots)


def test_catalog_flat_includes_every_seed_region():
    client = _client()
    r = client.get("/api/v1/maps/catalog/flat")
    regions = r.json()["regions"]
    us_states = [e for e in regions if e["parent_id"] == "us"]
    assert len(us_states) >= 50


def test_list_regions_empty_before_any_install():
    client = _client()
    r = client.get("/api/v1/maps/regions")
    assert r.status_code == 200
    assert r.json() == []


def test_storage_zero_before_any_install():
    client = _client()
    r = client.get("/api/v1/maps/storage")
    assert r.status_code == 200
    body = r.json()
    assert body["total_bytes"] == 0
    assert body["regions"] == []


# ── Selection validation ─────────────────────────────────────────

def test_put_region_conflicts_when_satellite_without_street(monkeypatch):
    client = _client()
    r = client.put("/api/v1/maps/regions/us-ct",
                   json={"street": False, "satellite": True})
    assert r.status_code == 409, r.text
    body = r.json()
    # FastAPI wraps structured error in detail.
    assert body["detail"]["error"] == "satellite_requires_street"


def test_put_region_unknown_region_404():
    client = _client()
    r = client.put("/api/v1/maps/regions/not-real",
                   json={"street": True, "satellite": False})
    assert r.status_code == 404


def test_put_region_parent_only_rejected():
    client = _client()
    r = client.put("/api/v1/maps/regions/na",
                   json={"street": True, "satellite": False})
    assert r.status_code == 400


def test_put_region_persists_config_and_launches_install(monkeypatch):
    """A valid PUT persists the config and kicks off a tracked install."""

    async def _noop(*args, **kwargs):
        return None

    # Replace the download so no network is touched.
    async def _fake(url, dest, expected_sha256, progress_cb, cancel_event):
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(b"payload")
        return 7

    monkeypatch.setattr(store, "_download_to", _fake)

    client = _client()
    r = client.put("/api/v1/maps/regions/us-ct",
                   json={"street": True, "satellite": False})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["installing"] is True
    assert body["config"]["street"] is True
    # Config row should be persisted even before the install finishes.
    cfg = store.get_config("us-ct")
    assert cfg is not None and cfg.street is True


# ── Delete ──────────────────────────────────────────────────────

def test_delete_region_cleans_disk():
    # Seed some fake artifacts on disk + state row.
    region_dir = store.region_dir("us-de")
    region_dir.mkdir(parents=True)
    (region_dir / "streets.pmtiles").write_bytes(b"data")
    store.upsert_state(MapRegionState(
        region_id="us-de", street_installed=True,
        bytes_on_disk={"street": 4},
    ))

    client = _client()
    r = client.delete("/api/v1/maps/regions/us-de")
    assert r.status_code == 200

    assert not region_dir.exists()
    assert store.get_state("us-de") is None


# ── Storage aggregation ─────────────────────────────────────────

def test_storage_aggregates_by_artifact_type():
    store.upsert_state(MapRegionState(
        region_id="us-ct", street_installed=True,
        bytes_on_disk={"street": 100, "valhalla": 50},
    ))
    store.upsert_state(MapRegionState(
        region_id="us-ri", street_installed=True, satellite_installed=True,
        bytes_on_disk={"street": 30, "satellite": 400, "valhalla": 15},
    ))

    client = _client()
    r = client.get("/api/v1/maps/storage")
    assert r.status_code == 200
    body = r.json()
    assert body["totals"]["street"] == 130
    assert body["totals"]["satellite"] == 400
    assert body["totals"]["valhalla"] == 65
    assert body["total_bytes"] == 595


# ── Progress SSE idle path ──────────────────────────────────────

def test_progress_stream_idle_when_no_install():
    client = _client()
    with client.stream("GET", "/api/v1/maps/regions/us-ct/progress") as r:
        assert r.status_code == 200
        chunks = [chunk for chunk in r.iter_text() if chunk.strip()]
    body = "\n".join(chunks)
    assert "idle" in body
    assert "us-ct" in body
