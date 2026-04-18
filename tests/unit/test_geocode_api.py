"""Chunk 5 — ``/api/v1/maps/geocode`` route tests.

The route unions FTS results across installed regions when the viewport
is covered, falls back to Nominatim otherwise, and flags
``offline: true`` when nothing covers and the fallback produced no
rows. These tests exercise all three arms without ever hitting the
real network.
"""
from __future__ import annotations

from pathlib import Path

import osmium
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from lokidoki.api.routes import maps as maps_routes
from lokidoki.maps import store
from lokidoki.maps.geocode import nominatim_fallback
from lokidoki.maps.geocode.fts_index import build_index, region_db_path
from lokidoki.maps.models import MapRegionState


@pytest.fixture(autouse=True)
def _tmp_data_dir(tmp_path, monkeypatch):
    store.set_data_dir(tmp_path)
    maps_routes._active.clear()

    # Guarantee Nominatim is never actually contacted during tests.
    async def _never(*args, **kwargs):
        raise AssertionError("Nominatim called without explicit monkeypatch")

    monkeypatch.setattr(nominatim_fallback, "search", _never)
    yield
    store.set_data_dir(None)
    maps_routes._active.clear()


def _client() -> TestClient:
    app = FastAPI()
    app.include_router(maps_routes.router, prefix="/api/v1/maps", tags=["Maps"])
    return TestClient(app)


def _seed_ct_index(data_root: Path) -> None:
    """Build a one-address CT index and mark the region as installed."""
    pbf = data_root / "_ct.osm.pbf"
    if pbf.exists():
        pbf.unlink()
    w = osmium.SimpleWriter(str(pbf), overwrite=True)
    w.add_node(osmium.osm.mutable.Node(
        id=1, location=(-73.069, 41.242964),
        tags={
            "addr:housenumber": "150", "addr:street": "Stiles St",
            "addr:city": "Milford", "addr:state": "CT",
            "addr:postcode": "06460",
        },
    ))
    w.close()

    db = region_db_path(data_root, "us-ct")
    build_index(pbf, db, "us-ct")
    store.upsert_state(MapRegionState(
        region_id="us-ct",
        street_installed=True,
        geocoder_installed=True,
        bytes_on_disk={"street": 1, "geocoder": db.stat().st_size},
    ))


# ── FTS path ──────────────────────────────────────────────────────

def test_geocode_returns_fts_hit_when_region_covers_viewport(tmp_path):
    _seed_ct_index(tmp_path)
    client = _client()
    r = client.get(
        "/api/v1/maps/geocode",
        params={"q": "stiles st", "lat": 41.24, "lon": -73.07},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["fallback_used"] is False
    assert body.get("offline") is not True
    assert len(body["results"]) >= 1
    hit = body["results"][0]
    assert hit["source"] == "fts"
    assert hit["place_id"].startswith("us-ct:osm:")
    # API contract: every field from the chunk spec is present.
    assert set(hit.keys()) >= {
        "place_id", "title", "subtitle", "lat", "lon", "bbox", "source",
    }


# ── Nominatim fallback path ───────────────────────────────────────

def test_geocode_falls_back_to_nominatim_when_no_region_covers(monkeypatch):
    from lokidoki.maps.geocode import GeocodeResult

    async def _fake_nominatim(query, viewport, limit=10):
        return [GeocodeResult(
            place_id="nominatim:42",
            title="Montmartre",
            subtitle="Paris, France",
            lat=48.8867,
            lon=2.3431,
            bbox=None,
            source="nominatim",
            score=9.0,
        )]

    monkeypatch.setattr(nominatim_fallback, "search", _fake_nominatim)

    client = _client()
    r = client.get(
        "/api/v1/maps/geocode",
        params={"q": "montmartre", "lat": 48.88, "lon": 2.34},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["fallback_used"] is True
    assert body["results"][0]["source"] == "nominatim"
    assert body.get("offline") is not True


def test_geocode_offline_when_fallback_empty(monkeypatch):
    async def _empty(query, viewport, limit=10):
        return []

    monkeypatch.setattr(nominatim_fallback, "search", _empty)

    client = _client()
    r = client.get(
        "/api/v1/maps/geocode",
        params={"q": "montmartre", "lat": 48.88, "lon": 2.34},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["results"] == []
    assert body["offline"] is True
    assert body["fallback_used"] is False


# ── Parameter validation + edges ───────────────────────────────────

def test_geocode_empty_query_returns_empty_results(tmp_path):
    _seed_ct_index(tmp_path)
    client = _client()
    r = client.get("/api/v1/maps/geocode", params={"q": "   "})
    assert r.status_code == 200
    body = r.json()
    assert body["results"] == []
    assert body["fallback_used"] is False


def test_geocode_without_viewport_still_searches_installed_regions(tmp_path):
    """No lat/lon → search every installed region (no proximity bias)."""
    _seed_ct_index(tmp_path)
    client = _client()
    r = client.get("/api/v1/maps/geocode", params={"q": "stiles"})
    assert r.status_code == 200
    body = r.json()
    assert len(body["results"]) >= 1
    assert body["results"][0]["source"] == "fts"
