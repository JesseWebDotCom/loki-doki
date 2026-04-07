"""HTTP-level tests for the PR3 memory routes."""
from __future__ import annotations

import pytest
from httpx import ASGITransport, AsyncClient

from lokidoki.auth.dependencies import current_user, get_memory
from lokidoki.auth.users import User
from lokidoki.core import memory_people_ops  # noqa: F401  bind methods
from lokidoki.core import memory_singleton
from lokidoki.core.memory_provider import MemoryProvider
from lokidoki.main import app


@pytest.fixture(autouse=True)
async def _isolated_memory(tmp_path):
    mp = MemoryProvider(db_path=str(tmp_path / "memapi.db"))
    await mp.initialize()
    uid = await mp.get_or_create_user("tester")
    memory_singleton.set_memory_provider(mp)

    fake = User(
        id=uid, username="tester", role="admin", status="active",
        last_password_auth_at=None,
    )

    async def _ovr_user():
        return fake

    async def _ovr_memory():
        return mp

    app.dependency_overrides[current_user] = _ovr_user
    app.dependency_overrides[get_memory] = _ovr_memory
    yield mp, uid
    app.dependency_overrides.clear()
    memory_singleton.set_memory_provider(None)
    await mp.close()


async def _client():
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


@pytest.mark.anyio
async def test_list_people_empty(_isolated_memory):
    async with await _client() as ac:
        r = await ac.get("/api/v1/memory/people")
    assert r.status_code == 200
    assert r.json() == {"people": []}


@pytest.mark.anyio
async def test_list_people_after_seed(_isolated_memory):
    mp, uid = _isolated_memory
    pid = await mp.find_or_create_person(uid, "Mark")
    await mp.upsert_fact(
        user_id=uid, subject="mark", subject_type="person", subject_ref_id=pid,
        predicate="location", value="Denver",
    )
    async with await _client() as ac:
        r = await ac.get("/api/v1/memory/people")
        assert r.status_code == 200
        people = r.json()["people"]
        assert len(people) == 1 and people[0]["name"] == "Mark"
        assert people[0]["fact_count"] == 1

        detail = await ac.get(f"/api/v1/memory/people/{pid}")
        assert detail.status_code == 200
        assert any(f["value"] == "Denver" for f in detail.json()["facts"])


@pytest.mark.anyio
async def test_get_unknown_person_404(_isolated_memory):
    async with await _client() as ac:
        r = await ac.get("/api/v1/memory/people/9999")
    assert r.status_code == 404


@pytest.mark.anyio
async def test_merge_people_endpoint(_isolated_memory):
    mp, uid = _isolated_memory
    src = await mp.find_or_create_person(uid, "Markie")
    dst = await mp.find_or_create_person(uid, "Mark")
    await mp.upsert_fact(
        user_id=uid, subject="markie", subject_type="person", subject_ref_id=src,
        predicate="location", value="Denver",
    )
    async with await _client() as ac:
        r = await ac.post(
            f"/api/v1/memory/people/{src}/merge", json={"into_id": dst}
        )
    assert r.status_code == 200
    assert r.json()["merged"] is True
    assert await mp.get_person(uid, src) is None


@pytest.mark.anyio
async def test_merge_into_self_400(_isolated_memory):
    mp, uid = _isolated_memory
    pid = await mp.find_or_create_person(uid, "Mark")
    async with await _client() as ac:
        r = await ac.post(
            f"/api/v1/memory/people/{pid}/merge", json={"into_id": pid}
        )
    assert r.status_code == 400


@pytest.mark.anyio
async def test_relationships_endpoint(_isolated_memory):
    mp, uid = _isolated_memory
    pid = await mp.find_or_create_person(uid, "Mark")
    await mp.add_relationship(uid, pid, "brother")
    async with await _client() as ac:
        r = await ac.get("/api/v1/memory/relationships")
    assert r.status_code == 200
    rels = r.json()["relationships"]
    assert len(rels) == 1 and rels[0]["relation"] == "brother"


@pytest.mark.anyio
async def test_conflicts_endpoint(_isolated_memory):
    mp, uid = _isolated_memory
    await mp.upsert_fact(
        user_id=uid, subject="self", predicate="favorite_color", value="blue"
    )
    await mp.upsert_fact(
        user_id=uid, subject="self", predicate="favorite_color", value="green"
    )
    async with await _client() as ac:
        r = await ac.get("/api/v1/memory/facts/conflicts")
    assert r.status_code == 200
    conflicts = r.json()["conflicts"]
    assert len(conflicts) == 1
    cands = conflicts[0]["candidates"]
    assert {c["value"] for c in cands} == {"blue", "green"}
