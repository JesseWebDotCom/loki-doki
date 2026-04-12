from __future__ import annotations

import pytest
from httpx import ASGITransport, AsyncClient

from lokidoki.auth.dependencies import current_user, get_memory, require_admin
from lokidoki.auth.users import User
from lokidoki.core import memory_singleton
from lokidoki.core import people_graph_sql as gql
from lokidoki.core.memory_provider import MemoryProvider
from lokidoki.main import app


@pytest.fixture(autouse=True)
async def _isolated_memory(tmp_path):
    mp = MemoryProvider(db_path=str(tmp_path / "admin-reset.db"))
    await mp.initialize()
    admin_id = await mp.get_or_create_user("admin")
    memory_singleton.set_memory_provider(mp)

    fake_admin = User(
        id=admin_id,
        username="admin",
        role="admin",
        status="active",
        last_password_auth_at=None,
    )

    async def _ovr_user():
        return fake_admin

    async def _ovr_memory():
        return mp

    app.dependency_overrides[current_user] = _ovr_user
    app.dependency_overrides[require_admin] = _ovr_user
    app.dependency_overrides[get_memory] = _ovr_memory
    yield mp, admin_id
    app.dependency_overrides.clear()
    memory_singleton.set_memory_provider(None)
    await mp.close()


async def _client():
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


@pytest.mark.anyio
async def test_reset_people_wipes_people_but_keeps_messages_and_users(_isolated_memory):
    mp, admin_id = _isolated_memory

    def _seed(conn):
        person_id = gql.create_person_graph(conn, admin_id, name="Luke", bucket="family")
        gql.create_person_event(conn, person_id=person_id, event_type="birthday", event_date="1977-05-25")
        conn.execute(
            "INSERT INTO facts (owner_user_id, subject, subject_type, subject_ref_id, predicate, value, kind, category) "
            "VALUES (?, ?, 'person', ?, 'likes', 'movies', 'fact', 'preference')",
            (admin_id, "luke", person_id),
        )
        conn.execute(
            "INSERT INTO sessions (owner_user_id, title) VALUES (?, ?)",
            (admin_id, "Chat"),
        )
        session_id = int(conn.execute("SELECT id FROM sessions ORDER BY id DESC LIMIT 1").fetchone()[0])
        conn.execute(
            "INSERT INTO messages (session_id, owner_user_id, role, content) VALUES (?, ?, 'user', ?)",
            (session_id, admin_id, "hello there"),
        )
        conn.commit()

    await mp.run_sync(_seed)

    async with await _client() as ac:
        response = await ac.post("/api/v1/admin/reset-people")
    assert response.status_code == 200
    assert response.json()["ok"] is True

    def _counts(conn):
        return {
            "users": conn.execute("SELECT COUNT(*) FROM users").fetchone()[0],
            "people": conn.execute("SELECT COUNT(*) FROM people").fetchone()[0],
            "facts": conn.execute("SELECT COUNT(*) FROM facts").fetchone()[0],
            "messages": conn.execute("SELECT COUNT(*) FROM messages").fetchone()[0],
        }

    counts = await mp.run_sync(_counts)
    assert counts["users"] == 1
    assert counts["people"] == 0
    assert counts["facts"] == 0
    assert counts["messages"] == 1


@pytest.mark.anyio
async def test_reset_everything_wipes_users_projects_and_memory(_isolated_memory):
    mp, admin_id = _isolated_memory
    second_user_id = await mp.get_or_create_user("leia")

    def _seed(conn):
        conn.execute(
            "INSERT INTO projects (owner_user_id, name, description, prompt) VALUES (?, ?, '', '')",
            (admin_id, "Project X"),
        )
        conn.execute(
            "INSERT INTO skill_config_global (skill_id, key, value) VALUES ('weather', 'api_key', 'abc')"
        )
        person_id = gql.create_person_graph(conn, admin_id, name="Padme", bucket="family")
        conn.execute(
            "INSERT INTO facts (owner_user_id, subject, subject_type, subject_ref_id, predicate, value, kind, category) "
            "VALUES (?, ?, 'person', ?, 'was born', '1979', 'fact', 'biographical')",
            (admin_id, "padme", person_id),
        )
        conn.execute(
            "INSERT INTO sessions (owner_user_id, title) VALUES (?, ?)",
            (second_user_id, "Alt chat"),
        )
        conn.commit()

    await mp.run_sync(_seed)

    async with await _client() as ac:
        response = await ac.post("/api/v1/admin/reset-everything")
    assert response.status_code == 200
    assert response.json()["ok"] is True

    def _counts(conn):
        return {
            "users": conn.execute("SELECT COUNT(*) FROM users").fetchone()[0],
            "projects": conn.execute("SELECT COUNT(*) FROM projects").fetchone()[0],
            "people": conn.execute("SELECT COUNT(*) FROM people").fetchone()[0],
            "facts": conn.execute("SELECT COUNT(*) FROM facts").fetchone()[0],
            "sessions": conn.execute("SELECT COUNT(*) FROM sessions").fetchone()[0],
            "skill_config_global": conn.execute("SELECT COUNT(*) FROM skill_config_global").fetchone()[0],
        }

    counts = await mp.run_sync(_counts)
    assert counts["users"] == 0
    assert counts["projects"] == 0
    assert counts["people"] == 0
    assert counts["facts"] == 0
    assert counts["sessions"] == 0
    assert counts["skill_config_global"] == 0

    builtin_count = await mp.run_sync(
        lambda conn: conn.execute(
            "SELECT COUNT(*) FROM characters WHERE source = 'builtin'"
        ).fetchone()[0]
    )
    assert builtin_count >= 1
