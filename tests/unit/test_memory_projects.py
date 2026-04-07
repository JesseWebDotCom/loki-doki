"""MemoryProvider project CRUD + session-scoping tests."""
import pytest

from lokidoki.core.memory_provider import MemoryProvider


@pytest.fixture
async def memory(tmp_path):
    mp = MemoryProvider(db_path=str(tmp_path / "projects.db"))
    await mp.initialize()
    yield mp
    await mp.close()


class TestProjectCRUD:
    @pytest.mark.anyio
    async def test_create_and_list(self, memory):
        uid = await memory.get_or_create_user("default")
        pid = await memory.create_project(uid, "Alpha", "desc", "system prompt")
        assert pid > 0
        projects = await memory.list_projects(uid)
        assert len(projects) == 1
        assert projects[0]["name"] == "Alpha"
        assert projects[0]["prompt"] == "system prompt"
        # defaults populate icon + icon_color
        assert projects[0]["icon"] == "Folder"
        assert projects[0]["icon_color"] == "swatch-1"

    @pytest.mark.anyio
    async def test_create_with_icon_and_color(self, memory):
        uid = await memory.get_or_create_user("default")
        pid = await memory.create_project(
            uid, "Alpha", "d", "p", icon="Briefcase", icon_color="swatch-5"
        )
        got = await memory.get_project(uid, pid)
        assert got["icon"] == "Briefcase"
        assert got["icon_color"] == "swatch-5"

    @pytest.mark.anyio
    async def test_update_persists_icon_and_color(self, memory):
        uid = await memory.get_or_create_user("default")
        pid = await memory.create_project(uid, "Alpha", "", "")
        await memory.update_project(
            uid, pid, "Alpha", "", "", icon="Rocket", icon_color="swatch-7"
        )
        got = await memory.get_project(uid, pid)
        assert got["icon"] == "Rocket"
        assert got["icon_color"] == "swatch-7"

    @pytest.mark.anyio
    async def test_get_project(self, memory):
        uid = await memory.get_or_create_user("default")
        pid = await memory.create_project(uid, "Alpha", "d", "p")
        got = await memory.get_project(uid, pid)
        assert got and got["id"] == pid

    @pytest.mark.anyio
    async def test_update_project(self, memory):
        uid = await memory.get_or_create_user("default")
        pid = await memory.create_project(uid, "Alpha", "d", "p")
        ok = await memory.update_project(uid, pid, "Beta", "d2", "p2")
        assert ok
        got = await memory.get_project(uid, pid)
        assert got["name"] == "Beta" and got["prompt"] == "p2"

    @pytest.mark.anyio
    async def test_delete_project(self, memory):
        uid = await memory.get_or_create_user("default")
        pid = await memory.create_project(uid, "Alpha", "", "")
        assert await memory.delete_project(uid, pid)
        assert await memory.list_projects(uid) == []

    @pytest.mark.anyio
    async def test_project_user_scoped(self, memory):
        u1 = await memory.get_or_create_user("default")
        u2 = await memory.get_or_create_user("alice")
        pid = await memory.create_project(u1, "U1Project", "", "")
        # u2 cannot see or mutate it
        assert await memory.list_projects(u2) == []
        assert await memory.get_project(u2, pid) is None
        assert not await memory.update_project(u2, pid, "x", "x", "x")
        assert not await memory.delete_project(u2, pid)


class TestSessionProjectScoping:
    @pytest.mark.anyio
    async def test_create_session_with_project(self, memory):
        uid = await memory.get_or_create_user("default")
        pid = await memory.create_project(uid, "Alpha", "", "")
        sid = await memory.create_session(uid, "T", project_id=pid)
        sessions = await memory.list_sessions(uid, project_id=pid)
        assert len(sessions) == 1 and sessions[0]["id"] == sid
        assert sessions[0]["project_id"] == pid

    @pytest.mark.anyio
    async def test_move_session_to_project(self, memory):
        uid = await memory.get_or_create_user("default")
        pid = await memory.create_project(uid, "Alpha", "", "")
        sid = await memory.create_session(uid, "T")
        assert await memory.move_session_to_project(uid, sid, pid)
        sessions = await memory.list_sessions(uid, project_id=pid)
        assert len(sessions) == 1
        # move out (None)
        assert await memory.move_session_to_project(uid, sid, None)
        sessions = await memory.list_sessions(uid, project_id=pid)
        assert sessions == []

    @pytest.mark.anyio
    async def test_update_session_title(self, memory):
        uid = await memory.get_or_create_user("default")
        sid = await memory.create_session(uid, "Old")
        assert await memory.update_session_title(uid, sid, "New")
        sessions = await memory.list_sessions(uid)
        assert next(s for s in sessions if s["id"] == sid)["title"] == "New"

    @pytest.mark.anyio
    async def test_list_facts_filtered_by_project(self, memory):
        uid = await memory.get_or_create_user("default")
        p1 = await memory.create_project(uid, "Alpha", "", "")
        p2 = await memory.create_project(uid, "Beta", "", "")
        await memory.upsert_fact(
            user_id=uid, subject="self", predicate="likes", value="alpha-thing", project_id=p1
        )
        await memory.upsert_fact(
            user_id=uid, subject="self", predicate="likes", value="beta-thing", project_id=p2
        )
        await memory.upsert_fact(
            user_id=uid, subject="self", predicate="likes", value="global-thing"
        )

        all_facts = await memory.list_facts(uid)
        assert {f["value"] for f in all_facts} == {"alpha-thing", "beta-thing", "global-thing"}

        p1_facts = await memory.list_facts(uid, project_id=p1)
        assert {f["value"] for f in p1_facts} == {"alpha-thing"}

        p2_facts = await memory.list_facts(uid, project_id=p2)
        assert {f["value"] for f in p2_facts} == {"beta-thing"}

    @pytest.mark.anyio
    async def test_delete_project_unlinks_sessions(self, memory):
        """ON DELETE SET NULL: deleting a project must not cascade-delete sessions."""
        uid = await memory.get_or_create_user("default")
        pid = await memory.create_project(uid, "Alpha", "", "")
        sid = await memory.create_session(uid, "T", project_id=pid)
        await memory.delete_project(uid, pid)
        sessions = await memory.list_sessions(uid)
        assert any(s["id"] == sid for s in sessions), "session should survive project delete"
        survivor = next(s for s in sessions if s["id"] == sid)
        assert survivor["project_id"] is None
