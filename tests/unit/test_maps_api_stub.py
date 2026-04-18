"""Maps router stub tests — Chunk 1 of the offline-maps plan.

The stub contract is narrow: GET /api/v1/maps/regions returns a 200 with
an empty JSON array. Chunk 2 replaces the body with installed regions
read from disk.

We mount the router on a bare FastAPI app so these tests exercise the
route itself, not the app-wide bootstrap gate (which would otherwise
return 409 when the users table is empty).
"""
from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient

from lokidoki.api.routes import maps


def _client() -> TestClient:
    app = FastAPI()
    app.include_router(maps.router, prefix="/api/v1/maps", tags=["Maps"])
    return TestClient(app)


def test_list_regions_returns_empty_array():
    client = _client()
    response = client.get("/api/v1/maps/regions")
    assert response.status_code == 200, response.text
    assert response.json() == []


def test_list_regions_content_type_json():
    client = _client()
    response = client.get("/api/v1/maps/regions")
    assert response.headers["content-type"].startswith("application/json")
