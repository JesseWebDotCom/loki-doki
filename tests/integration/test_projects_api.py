"""Integration tests for /api/v1/projects routes + session move semantics."""
import pytest
from httpx import AsyncClient, ASGITransport

from lokidoki.main import app
from lokidoki.core.memory_provider import MemoryProvider
from lokidoki.core import memory_singleton
from lokidoki.core import memory_user_ops  # noqa: F401  bind helpers
from lokidoki.auth.dependencies import current_user, get_memory
from lokidoki.auth.users import User


@pytest.fixture(autouse=True)
async def _isolated_memory(tmp_path):
    mp = MemoryProvider(db_path=str(tmp_path / "projects_api.db"))
    await mp.initialize()
    uid = await mp.get_or_create_user("tester")
    memory_singleton.set_memory_provider(mp)

    fake_user = User(
        id=uid, username="tester", role="admin", status="active",
        last_password_auth_at=None,
    )

    async def _override_user():
        return fake_user

    async def _override_memory():
        return mp

    app.dependency_overrides[current_user] = _override_user
    app.dependency_overrides[get_memory] = _override_memory
    yield mp
    app.dependency_overrides.clear()
    memory_singleton.set_memory_provider(None)
    await mp.close()


@pytest.mark.anyio
async def test_create_list_get_update_delete_project():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        # create
        r = await ac.post("/api/v1/projects", json={
            "name": "Alpha", "description": "d", "prompt": "p",
        })
        assert r.status_code == 200, r.text
        pid = r.json()["id"]

        # list
        r = await ac.get("/api/v1/projects")
        assert r.status_code == 200
        projects = r.json()["projects"]
        assert len(projects) == 1 and projects[0]["id"] == pid

        # get
        r = await ac.get(f"/api/v1/projects/{pid}")
        assert r.status_code == 200
        assert r.json()["name"] == "Alpha"

        # update
        r = await ac.patch(f"/api/v1/projects/{pid}", json={
            "name": "Beta", "description": "d2", "prompt": "p2",
        })
        assert r.status_code == 200

        r = await ac.get(f"/api/v1/projects/{pid}")
        assert r.json()["name"] == "Beta"
        assert r.json()["prompt"] == "p2"

        # delete
        r = await ac.delete(f"/api/v1/projects/{pid}")
        assert r.status_code == 200
        r = await ac.get(f"/api/v1/projects/{pid}")
        assert r.status_code == 404


@pytest.mark.anyio
async def test_get_unknown_project_404():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        r = await ac.get("/api/v1/projects/9999")
        assert r.status_code == 404


@pytest.mark.anyio
async def test_update_unknown_project_404():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        r = await ac.patch("/api/v1/projects/9999", json={
            "name": "x", "description": "x", "prompt": "x",
        })
        assert r.status_code == 404


@pytest.mark.anyio
async def test_delete_unknown_project_404():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        r = await ac.delete("/api/v1/projects/9999")
        assert r.status_code == 404


@pytest.mark.anyio
async def test_session_patch_move_into_and_out_of_project(_isolated_memory):
    """project_id=int moves in; project_id=0 unassigns (per chat.py convention)."""
    mp = _isolated_memory
    uid = await mp.get_or_create_user("tester")
    pid = await mp.create_project(uid, "Alpha", "", "")
    sid = await mp.create_session(uid, "T")

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        # move in
        r = await ac.patch(f"/api/v1/chat/sessions/{sid}", json={"project_id": pid})
        assert r.status_code == 200

        sessions = await mp.list_sessions(uid, project_id=pid)
        assert any(s["id"] == sid for s in sessions)

        # rename
        r = await ac.patch(f"/api/v1/chat/sessions/{sid}", json={"title": "Renamed"})
        assert r.status_code == 200
        sessions = await mp.list_sessions(uid)
        assert next(s for s in sessions if s["id"] == sid)["title"] == "Renamed"

        # move out (project_id=0 -> NULL per backend convention)
        r = await ac.patch(f"/api/v1/chat/sessions/{sid}", json={"project_id": 0})
        assert r.status_code == 200
        sessions = await mp.list_sessions(uid, project_id=pid)
        assert all(s["id"] != sid for s in sessions)


@pytest.mark.anyio
async def test_delete_project_unlinks_sessions_via_api(_isolated_memory):
    mp = _isolated_memory
    uid = await mp.get_or_create_user("tester")
    pid = await mp.create_project(uid, "Alpha", "", "")
    sid = await mp.create_session(uid, "T", project_id=pid)

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        r = await ac.delete(f"/api/v1/projects/{pid}")
        assert r.status_code == 200

    sessions = await mp.list_sessions(uid)
    survivor = next((s for s in sessions if s["id"] == sid), None)
    assert survivor is not None
    assert survivor["project_id"] is None
