from __future__ import annotations

import pytest
from httpx import ASGITransport, AsyncClient

from lokidoki.auth.dependencies import require_admin
from lokidoki.auth.users import User
from lokidoki.core import memory_singleton
from lokidoki.core.memory_provider import MemoryProvider
from lokidoki.main import app


@pytest.fixture(autouse=True)
async def _fresh_memory(tmp_path):
    mp = MemoryProvider(db_path=str(tmp_path / "v2_dev_api.db"))
    await mp.initialize()
    memory_singleton.set_memory_provider(mp)
    yield mp
    app.dependency_overrides.clear()
    memory_singleton.set_memory_provider(None)
    await mp.close()


def _client():
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


@pytest.mark.anyio
async def test_v2_dev_endpoint_requires_admin_auth():
    async with _client() as ac:
        r = await ac.post("/api/v1/dev/v2/run", json={"message": "hello"})

    assert r.status_code == 409


async def _admin_override() -> User:
    return User(
        id=1,
        username="anakin",
        role="admin",
        status="active",
        last_password_auth_at=1,
    )


@pytest.mark.anyio
async def test_v2_dev_endpoint_runs_pipeline_for_admin(_fresh_memory):
    app.dependency_overrides[require_admin] = _admin_override
    await _fresh_memory.get_or_create_user("anakin")
    async with _client() as ac:
        response = await ac.post(
            "/api/v1/dev/v2/run",
            json={"message": "hello and how do you spell restaurant"},
        )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["response"]["output_text"].lower().startswith("hello")
    assert [chunk["text"] for chunk in body["chunks"]] == [
        "hello",
        "how do you spell restaurant",
    ]
    assert body["trace"]["steps"][0]["name"] == "normalize"
    assert body["trace"]["steps"][-1]["name"] == "combine"
    assert all("status" in step for step in body["trace"]["steps"])
    assert all("timing_ms" in step for step in body["trace"]["steps"])
