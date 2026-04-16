"""PR2 auth + admin + bootstrap-gate integration tests."""
from __future__ import annotations

import pytest
from httpx import ASGITransport, AsyncClient

from lokidoki.auth import passwords
from lokidoki.core import memory_singleton, memory_user_ops  # noqa: F401
from lokidoki.core.memory_provider import MemoryProvider
from lokidoki.main import app


@pytest.fixture(autouse=True)
async def _fresh_memory(tmp_path):
    mp = MemoryProvider(db_path=str(tmp_path / "auth_api.db"))
    await mp.initialize()
    memory_singleton.set_memory_provider(mp)
    passwords.reset_rate_limit()
    yield mp
    app.dependency_overrides.clear()
    memory_singleton.set_memory_provider(None)
    await mp.close()


def _client():
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


@pytest.mark.anyio
async def test_bootstrap_gate_blocks_when_no_users():
    async with _client() as ac:
        r = await ac.get("/api/v1/chat/skills")
    assert r.status_code == 409
    assert r.json() == {"error": "needs_bootstrap"}


@pytest.mark.anyio
async def test_me_returns_409_when_no_users():
    async with _client() as ac:
        r = await ac.get("/api/v1/auth/me")
    assert r.status_code == 409


@pytest.mark.anyio
async def test_bootstrap_creates_first_admin_then_409():
    async with _client() as ac:
        r = await ac.post(
            "/api/v1/auth/bootstrap",
            json={"username": "alice", "pin": "1234", "password": "test-pass-1"},
        )
        assert r.status_code == 200, r.text
        assert r.json()["role"] == "admin"
        # second bootstrap rejected
        r2 = await ac.post(
            "/api/v1/auth/bootstrap",
            json={"username": "bob", "pin": "1234", "password": "test-pass-1"},
        )
        assert r2.status_code == 409


@pytest.mark.anyio
async def test_login_success_and_me():
    async with _client() as ac:
        await ac.post(
            "/api/v1/auth/bootstrap",
            json={"username": "alice", "pin": "1234", "password": "test-pass-1"},
        )
        # logging out clears cookie so login is exercised cleanly
        await ac.post("/api/v1/auth/logout")
        r = await ac.post(
            "/api/v1/auth/login", json={"username": "alice", "pin": "1234"}
        )
        assert r.status_code == 200
        me = await ac.get("/api/v1/auth/me")
        assert me.status_code == 200
        assert me.json()["username"] == "alice"


@pytest.mark.anyio
async def test_login_wrong_pin_and_rate_limit():
    async with _client() as ac:
        await ac.post(
            "/api/v1/auth/bootstrap",
            json={"username": "alice", "pin": "1234", "password": "test-pass-1"},
        )
        await ac.post("/api/v1/auth/logout")
        for _ in range(5):
            r = await ac.post(
                "/api/v1/auth/login", json={"username": "alice", "pin": "0000"}
            )
            assert r.status_code == 401
        # 6th attempt should be rate-limited (429)
        r = await ac.post(
            "/api/v1/auth/login", json={"username": "alice", "pin": "0000"}
        )
        assert r.status_code == 429


@pytest.mark.anyio
async def test_admin_user_mgmt_full_flow():
    async with _client() as ac:
        await ac.post(
            "/api/v1/auth/bootstrap",
            json={"username": "alice", "pin": "1234", "password": "test-pass-1"},
        )
        # admin freshness was stamped during bootstrap
        r = await ac.post(
            "/api/v1/admin/users",
            json={"username": "kid", "pin": "5678", "role": "user"},
        )
        assert r.status_code == 200, r.text
        kid_id = r.json()["id"]

        r = await ac.get("/api/v1/admin/users")
        assert r.status_code == 200
        names = {u["username"] for u in r.json()["users"]}
        assert {"alice", "kid"} <= names

        for action in ("disable", "enable", "promote", "demote"):
            rr = await ac.post(f"/api/v1/admin/users/{kid_id}/{action}")
            assert rr.status_code == 200, (action, rr.text)

        rr = await ac.post(
            f"/api/v1/admin/users/{kid_id}/reset-pin", json={"new_pin": "9999"}
        )
        assert rr.status_code == 200

        rr = await ac.post(f"/api/v1/admin/users/{kid_id}/delete")
        assert rr.status_code == 200


@pytest.mark.anyio
async def test_admin_reset_memory_wipes_facts_keeps_users(_fresh_memory):
    mp = _fresh_memory
    async with _client() as ac:
        await ac.post(
            "/api/v1/auth/bootstrap",
            json={"username": "alice", "pin": "1234", "password": "test-pass-1"},
        )
        # Seed some memory state we expect to be wiped.
        uid = await mp.get_or_create_user("alice")
        pid = await mp.create_person(uid, "Luke")
        await mp.add_relationship(uid, pid, "brother")
        await mp.upsert_fact(
            user_id=uid, subject="luke", predicate="loves", value="movies",
            subject_type="person", subject_ref_id=pid, category="preference",
        )

        # Sanity: facts/people exist before reset.
        assert len(await mp.list_facts(uid)) >= 1
        assert len(await mp.list_people(uid)) >= 1

        r = await ac.post("/api/v1/admin/reset-memory")
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["ok"] is True
        assert "facts" in body["wiped"]

        # Memory tables empty.
        assert await mp.list_facts(uid) == []
        assert await mp.list_people(uid) == []
        assert await mp.list_relationships(uid) == []

        # User survives — admin still logged in.
        me = await ac.get("/api/v1/auth/me")
        assert me.status_code == 200
        assert me.json()["username"] == "alice"


@pytest.mark.anyio
async def test_non_admin_cannot_hit_admin_routes():
    async with _client() as ac:
        await ac.post(
            "/api/v1/auth/bootstrap",
            json={"username": "alice", "pin": "1234", "password": "test-pass-1"},
        )
        # alice creates a child
        r = await ac.post(
            "/api/v1/admin/users",
            json={"username": "kid", "pin": "5678", "role": "user"},
        )
        assert r.status_code == 200
        await ac.post("/api/v1/auth/logout")
        # log in as kid
        r = await ac.post(
            "/api/v1/auth/login", json={"username": "kid", "pin": "5678"}
        )
        assert r.status_code == 200
        rr = await ac.get("/api/v1/admin/users")
        assert rr.status_code == 403


@pytest.mark.anyio
async def test_user_isolation_facts(_fresh_memory):
    mp = _fresh_memory
    async with _client() as ac:
        await ac.post(
            "/api/v1/auth/bootstrap",
            json={"username": "alice", "pin": "1234", "password": "test-pass-1"},
        )
        # create a second user
        r = await ac.post(
            "/api/v1/admin/users",
            json={"username": "bob", "pin": "1111", "role": "user"},
        )
        bob_id = r.json()["id"]
        # alice owns id=1. ``prefers`` is the Tier-4 predicate that maps
        # to "likes" semantically — the closed enum in
        # lokidoki.orchestrator.memory.predicates rejects raw "likes".
        await mp.upsert_fact(
            user_id=1, subject="self", predicate="prefers", value="hiking"
        )
        await mp.upsert_fact(
            user_id=bob_id, subject="self", predicate="prefers", value="kayaking"
        )
        r = await ac.get("/api/v1/memory/facts")
        vals = {f["value"] for f in r.json()["facts"]}
        assert vals == {"hiking"}
        await ac.post("/api/v1/auth/logout")
        await ac.post("/api/v1/auth/login", json={"username": "bob", "pin": "1111"})
        r = await ac.get("/api/v1/memory/facts")
        vals = {f["value"] for f in r.json()["facts"]}
        assert vals == {"kayaking"}


@pytest.mark.anyio
async def test_admin_freshness_expires(_fresh_memory):
    """An admin without recent password auth gets 403 from admin routes."""
    mp = _fresh_memory
    async with _client() as ac:
        await ac.post(
            "/api/v1/auth/bootstrap",
            json={"username": "alice", "pin": "1234", "password": "test-pass-1"},
        )
        # Force-clear last_password_auth_at to simulate stale session
        await mp.run_sync(
            lambda c: (c.execute(
                "UPDATE users SET last_password_auth_at = NULL WHERE id = 1"
            ), c.commit())
        )
        r = await ac.get("/api/v1/admin/users")
        assert r.status_code == 403
        # challenge re-stamps freshness
        r = await ac.post(
            "/api/v1/auth/challenge-admin", json={"password": "test-pass-1"}
        )
        assert r.status_code == 200
        r = await ac.get("/api/v1/admin/users")
        assert r.status_code == 200
