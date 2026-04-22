"""Tests for local chat transcript search."""
from __future__ import annotations

import pytest
from httpx import ASGITransport, AsyncClient

from lokidoki.api.routes.chat import router  # noqa: F401
from lokidoki.auth.dependencies import current_user, get_memory
from lokidoki.auth.users import User
from lokidoki.core import memory_singleton
from lokidoki.core.memory_provider import MemoryProvider
from lokidoki.main import app
from lokidoki.orchestrator.memory.chat_search import find_in_chat, search_all_chats


@pytest.fixture
async def memory(tmp_path):
    provider = MemoryProvider(db_path=str(tmp_path / "chat-search.db"))
    await provider.initialize()
    uid = await provider.get_or_create_user("luke")
    memory_singleton.set_memory_provider(provider)

    fake_user = User(
        id=uid,
        username="luke",
        role="admin",
        status="active",
        last_password_auth_at=None,
    )

    async def _override_user():
        return fake_user

    async def _override_memory():
        return provider

    app.dependency_overrides[current_user] = _override_user
    app.dependency_overrides[get_memory] = _override_memory
    yield provider, uid
    app.dependency_overrides.clear()
    memory_singleton.set_memory_provider(None)
    await provider.close()


@pytest.mark.anyio
async def test_find_in_chat_excludes_other_sessions(memory):
    provider, user_id = memory
    first_session = await provider.create_session(user_id, "Jedi Council")
    second_session = await provider.create_session(user_id, "Pod Racing")

    await provider.add_message(
        user_id=user_id,
        session_id=first_session,
        role="user",
        content="Luke asked about hyperdrive safety checks.",
    )
    await provider.add_message(
        user_id=user_id,
        session_id=second_session,
        role="user",
        content="Anakin tuned the pod racer engine.",
    )

    rows = await provider.run_sync(
        lambda conn: find_in_chat(
            conn,
            user_id=user_id,
            session_id=first_session,
            query="hyperdrive",
        )
    )

    assert len(rows) == 1
    assert rows[0]["session_id"] == first_session
    assert "hyperdrive" in rows[0]["snippet"].lower()


@pytest.mark.anyio
async def test_search_all_chats_returns_session_titles(memory):
    provider, user_id = memory
    session_id = await provider.create_session(user_id, "Holocron Notes")
    await provider.add_message(
        user_id=user_id,
        session_id=session_id,
        role="assistant",
        content="Leia saved the rebellion with the plans.",
    )

    rows = await provider.run_sync(
        lambda conn: search_all_chats(
            conn,
            user_id=user_id,
            query="rebellion",
        )
    )

    assert len(rows) == 1
    assert rows[0]["session_title"] == "Holocron Notes"
    assert rows[0]["message_id"] > 0


@pytest.mark.anyio
async def test_backfill_populates_fts_for_existing_rows(tmp_path):
    db_path = tmp_path / "backfill.db"
    provider = MemoryProvider(db_path=str(db_path))
    await provider.initialize()
    user_id = await provider.get_or_create_user("padme")
    session_id = await provider.create_session(user_id, "Senate")
    await provider.add_message(
        user_id=user_id,
        session_id=session_id,
        role="user",
        content="Padme briefed the senate on Naboo.",
    )
    await provider.close()

    provider = MemoryProvider(db_path=str(db_path))
    await provider.initialize()
    try:
      rows = await provider.run_sync(
          lambda conn: find_in_chat(
              conn,
              user_id=user_id,
              session_id=session_id,
              query="Naboo",
          )
      )
      assert len(rows) == 1
      assert "naboo" in rows[0]["snippet"].lower()
    finally:
      await provider.close()


@pytest.mark.anyio
async def test_search_endpoints_return_results(memory):
    provider, user_id = memory
    session_id = await provider.create_session(user_id, "Clone Wars")
    await provider.add_message(
        user_id=user_id,
        session_id=session_id,
        role="assistant",
        content="Ahsoka tracked the missing convoy.",
    )

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        in_session = await client.get(
            f"/api/v1/chat/sessions/{session_id}/search",
            params={"q": "convoy"},
        )
        assert in_session.status_code == 200
        assert in_session.json()["results"][0]["session_id"] == session_id

        cross_chat = await client.get(
            "/api/v1/chat/search",
            params={"q": "Ahsoka"},
        )
        assert cross_chat.status_code == 200
        assert cross_chat.json()["results"][0]["session_title"] == "Clone Wars"
