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
    assert body["parsed"]["token_count"] >= 1
    assert len(body["extractions"]) == 2
    assert len(body["implementations"]) == 2
    assert len(body["resolutions"]) == 2
    assert body["request_spec"]["original_request"] == "hello and how do you spell restaurant"
    assert body["trace_summary"]["slowest_step_name"] in {step["name"] for step in body["trace"]["steps"]}
    route_step = next(step for step in body["trace"]["steps"] if step["name"] == "route")
    select_step = next(step for step in body["trace"]["steps"] if step["name"] == "select_implementation")
    assert route_step["details"]["chunks"][1]["capability"] == "spell_word"
    assert select_step["details"]["chunks"][1]["handler_name"] == "core.dictionary.spell"
    assert select_step["details"]["chunks"][1]["candidate_count"] == 2


@pytest.mark.anyio
async def test_v2_dev_endpoint_accepts_recent_context_for_media_resolution(_fresh_memory):
    app.dependency_overrides[require_admin] = _admin_override
    await _fresh_memory.get_or_create_user("anakin")
    async with _client() as ac:
        response = await ac.post(
            "/api/v1/dev/v2/run",
            json={
                "message": "what was that movie",
                "context": {
                    "recent_entities": [
                        {"type": "movie", "name": "Rogue One"},
                    ]
                },
            },
        )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["response"]["output_text"] == "Rogue One"
    assert body["resolutions"][0]["resolved_target"] == "Rogue One"
    assert body["resolutions"][0]["source"] == "recent_context"
    assert body["request_spec"]["supporting_context"] == ["movie:Rogue One"]


@pytest.mark.anyio
async def test_v2_dev_endpoint_marks_missing_media_context_unresolved(_fresh_memory):
    app.dependency_overrides[require_admin] = _admin_override
    await _fresh_memory.get_or_create_user("anakin")
    async with _client() as ac:
        response = await ac.post(
            "/api/v1/dev/v2/run",
            json={"message": "what was that movie"},
        )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["response"]["output_text"] == "I don't have a recent movie in context yet."
    assert body["resolutions"][0]["source"] == "unresolved_context"
    assert body["request_spec"]["chunks"][0]["success"] is False
    assert body["request_spec"]["chunks"][0]["unresolved"] == ["recent_media"]
    assert body["request_spec"]["chunks"][0]["error"] == "missing recent movie context"
    resolve_step = next(step for step in body["trace"]["steps"] if step["name"] == "resolve")
    assert resolve_step["details"]["chunks"][0]["candidate_values"] == []


@pytest.mark.anyio
async def test_v2_dev_endpoint_marks_ambiguous_media_context_unresolved(_fresh_memory):
    app.dependency_overrides[require_admin] = _admin_override
    await _fresh_memory.get_or_create_user("anakin")
    async with _client() as ac:
        response = await ac.post(
            "/api/v1/dev/v2/run",
            json={
                "message": "what was that movie",
                "context": {
                    "recent_entities": [
                        {"type": "movie", "name": "Rogue One"},
                        {"type": "movie", "name": "A New Hope"},
                    ]
                },
            },
        )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["response"]["output_text"] == "I found multiple recent movies: Rogue One, A New Hope."
    assert body["resolutions"][0]["source"] == "ambiguous_context"
    assert body["request_spec"]["chunks"][0]["success"] is False
    assert body["request_spec"]["chunks"][0]["unresolved"] == ["recent_media_ambiguous"]
    assert body["request_spec"]["chunks"][0]["error"] == "multiple recent movies match"
    resolve_step = next(step for step in body["trace"]["steps"] if step["name"] == "resolve")
    assert resolve_step["details"]["chunks"][0]["candidate_values"] == ["Rogue One", "A New Hope"]
