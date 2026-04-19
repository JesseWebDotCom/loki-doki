"""Maps router surface-shape tests.

Originally the Chunk 1 stub contract was narrow: ``GET /api/v1/maps/regions``
returned a hard-coded empty array. Chunk 2 replaced that stub with real
disk-backed region state, so these tests now pin the route to an isolated
empty data directory to preserve the "no regions installed" smoke.
"""
from __future__ import annotations

from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from lokidoki.api.routes import maps
from lokidoki.maps import store


@pytest.fixture(autouse=True)
def _isolated_data_dir(tmp_path: Path):
    store.set_data_dir(tmp_path)
    yield
    store.set_data_dir(None)


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
