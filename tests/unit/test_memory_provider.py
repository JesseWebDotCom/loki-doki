"""MemoryProvider unit tests for PR1.

Coverage:
- user-scoping isolation (seed two users; assert reads/writes don't bleed)
- fact dedup-and-confirm bumps confidence on repeat
- distinct values for the same (subject, predicate) coexist (PR3 conflicts)
- FTS5/BM25 search ranks more-relevant facts higher
- search results are scoped to the calling user
"""
import asyncio
import pytest
from unittest.mock import AsyncMock, patch

from lokidoki.core.confidence import DEFAULT_CONFIDENCE
from lokidoki.core.memory_provider import MemoryProvider


@pytest.fixture
async def memory(tmp_path):
    mp = MemoryProvider(db_path=str(tmp_path / "provider.db"))
    await mp.initialize()
    yield mp
    await mp.close()


class TestEmbeddings:
    """Coverage for the bge-small embedder + hybrid retrieval."""

    @pytest.mark.anyio
    async def test_upsert_writes_vec_facts_row(self, memory):
        u = await memory.get_or_create_user("default")
        await memory.upsert_fact(
            user_id=u, subject="self", predicate="loves", value="raspberry pi"
        )

        def _check(conn):
            row = conn.execute(
                "SELECT vf.fact_id FROM vec_facts vf "
                "JOIN facts f ON f.id = vf.fact_id "
                "WHERE f.owner_user_id = ?",
                (u,),
            ).fetchone()
            return row

        row = await memory.run_sync(_check)
        # vec_facts may not exist if sqlite-vec failed to load — in
        # that case the test still passes (the provider degrades to
        # BM25-only and the row is simply absent).
        if memory.vec_enabled:
            assert row is not None

    @pytest.mark.anyio
    async def test_hybrid_search_returns_results_with_vectors(self, memory):
        u = await memory.get_or_create_user("default")
        await memory.upsert_fact(
            user_id=u, subject="self", predicate="loves", value="raspberry pi"
        )
        await memory.upsert_fact(
            user_id=u, subject="self", predicate="loves", value="kayaking"
        )
        results = await memory.search_facts(user_id=u, query="raspberry pi")
        assert len(results) >= 1
        assert results[0]["value"] == "raspberry pi"

    @pytest.mark.anyio
    async def test_backfill_embeds_pre_existing_facts(self, memory, tmp_path):
        """Facts written before the embedder existed must get embedded
        on the next provider startup. We simulate this by writing a row
        directly into facts (no vec_facts row), then closing + reopening
        the provider — initialize() should backfill it."""
        u = await memory.get_or_create_user("default")

        def _raw_insert(conn):
            conn.execute(
                "INSERT INTO facts (owner_user_id, subject, predicate, value) "
                "VALUES (?, 'self', 'enjoys', 'tea')",
                (u,),
            )
            conn.commit()
        await memory.run_sync(_raw_insert)

        # Confirm the row is present but has no vec_facts entry.
        def _missing(conn):
            return conn.execute(
                "SELECT COUNT(*) FROM facts f "
                "LEFT JOIN vec_facts vf ON vf.fact_id = f.id "
                "WHERE vf.fact_id IS NULL AND f.value = 'tea'"
            ).fetchone()[0]
        if memory.vec_enabled:
            assert (await memory.run_sync(_missing)) == 1

        await memory.close()

        # Reopen — initialize() runs backfill.
        mp2 = MemoryProvider(db_path=memory._db_path)
        await mp2.initialize()
        try:
            if mp2.vec_enabled:
                await asyncio.wait_for(mp2._background_backfill_task, timeout=5.0)

                async def _has_vec():
                    def _do(conn):
                        return conn.execute(
                            "SELECT COUNT(*) FROM vec_facts vf "
                            "JOIN facts f ON f.id = vf.fact_id "
                            "WHERE f.value = 'tea'"
                        ).fetchone()[0]
                    return await mp2.run_sync(_do)
                assert (await _has_vec()) == 1
        finally:
            await mp2.close()

    @pytest.mark.anyio
    async def test_initialize_schedules_backfill_in_background(self, tmp_path):
        mp = MemoryProvider(db_path=str(tmp_path / "provider-bg.db"))
        started = asyncio.Event()
        released = asyncio.Event()

        async def fake_backfill(*, max_rows: int):
            started.set()
            await released.wait()

        async def fake_backfill_messages(*, max_rows: int):
            started.set()
            await released.wait()

        with patch("lokidoki.core.memory_provider.open_and_migrate") as open_and_migrate, \
             patch("lokidoki.core.character_seed.run_seed") as run_seed:
            from lokidoki.core.memory_init import open_and_migrate as real_open_and_migrate

            conn, vec_loaded = real_open_and_migrate(str(tmp_path / "provider-bg-real.db"))
            open_and_migrate.return_value = (conn, vec_loaded)
            run_seed.return_value = None
            mp._backfill_embeddings = fake_backfill
            mp._backfill_message_embeddings = fake_backfill_messages

            await mp.initialize()
            if not vec_loaded:
                await mp.close()
                return

            assert mp._background_backfill_task is not None

            await asyncio.wait_for(started.wait(), timeout=1.0)
            released.set()
            await mp.close()


class TestMessageEmbeddings:
    """Coverage for vec_messages and hybrid message search."""

    @pytest.mark.anyio
    async def test_user_message_gets_embedded(self, memory):
        u = await memory.get_or_create_user("default")
        s = await memory.create_session(u)
        await memory.add_message(
            user_id=u, session_id=s, role="user", content="hello world"
        )
        if not memory.vec_enabled:
            return
        def _check(conn):
            return conn.execute(
                "SELECT COUNT(*) FROM vec_messages vm "
                "JOIN messages m ON m.id = vm.message_id "
                "WHERE m.owner_user_id = ?",
                (u,),
            ).fetchone()[0]
        assert (await memory.run_sync(_check)) == 1

    @pytest.mark.anyio
    async def test_assistant_message_not_embedded(self, memory):
        """Assistant turns dilute the index — never embed them."""
        u = await memory.get_or_create_user("default")
        s = await memory.create_session(u)
        await memory.add_message(
            user_id=u, session_id=s, role="assistant", content="some reply"
        )
        if not memory.vec_enabled:
            return
        def _check(conn):
            return conn.execute(
                "SELECT COUNT(*) FROM vec_messages vm "
                "JOIN messages m ON m.id = vm.message_id "
                "WHERE m.owner_user_id = ?",
                (u,),
            ).fetchone()[0]
        assert (await memory.run_sync(_check)) == 0

    @pytest.mark.anyio
    async def test_search_messages_returns_user_turn(self, memory):
        u = await memory.get_or_create_user("default")
        s = await memory.create_session(u)
        await memory.add_message(
            user_id=u, session_id=s, role="user",
            content="should we use postgres or sqlite for the auth db",
        )
        await memory.add_message(
            user_id=u, session_id=s, role="user", content="what time is it",
        )
        results = await memory.search_messages(
            user_id=u, query="postgres auth", top_k=5
        )
        assert len(results) >= 1
        assert "postgres" in results[0]["content"]

    @pytest.mark.anyio
    async def test_search_messages_excludes_other_users(self, memory):
        u1 = await memory.get_or_create_user("default")
        u2 = await memory.get_or_create_user("alice")
        s1 = await memory.create_session(u1)
        s2 = await memory.create_session(u2)
        await memory.add_message(user_id=u1, session_id=s1, role="user", content="alpha bravo")
        await memory.add_message(user_id=u2, session_id=s2, role="user", content="alpha bravo")
        u1_results = await memory.search_messages(user_id=u1, query="alpha bravo")
        assert len(u1_results) == 1


class TestNewSchemaFields:
    """Coverage for the kind/valid_from/valid_to/entity additions."""

    @pytest.mark.anyio
    async def test_kind_defaults_to_fact(self, memory):
        u = await memory.get_or_create_user("default")
        await memory.upsert_fact(
            user_id=u, subject="self", predicate="likes", value="coffee"
        )
        rows = await memory.list_facts(u)
        assert rows[0]["kind"] == "fact"

    @pytest.mark.anyio
    async def test_kind_persisted_when_provided(self, memory):
        u = await memory.get_or_create_user("default")
        await memory.upsert_fact(
            user_id=u, subject="self", predicate="loves", value="halo",
            kind="preference",
        )
        rows = await memory.list_facts(u)
        assert rows[0]["kind"] == "preference"

    @pytest.mark.anyio
    async def test_valid_from_set_on_insert(self, memory):
        u = await memory.get_or_create_user("default")
        await memory.upsert_fact(
            user_id=u, subject="self", predicate="lives", value="austin"
        )
        rows = await memory.list_facts(u)
        assert rows[0]["valid_from"]  # non-empty timestamp string
        assert rows[0]["valid_to"] is None  # currently true

    @pytest.mark.anyio
    async def test_supersede_stamps_valid_to(self, memory):
        """negates_previous=True should both mark the loser superseded
        AND stamp valid_to so temporal queries can answer 'what was true
        before this correction?'."""
        u = await memory.get_or_create_user("default")
        await memory.upsert_fact(
            user_id=u, subject="self", predicate="name", value="Jess"
        )
        await memory.upsert_fact(
            user_id=u, subject="self", predicate="name", value="Jesse",
            negates_previous=True,
        )
        # Pull all rows directly so we see superseded ones too.
        def _all(conn):
            return [
                dict(r) for r in conn.execute(
                    "SELECT value, status, valid_to FROM facts "
                    "WHERE owner_user_id = ? ORDER BY id",
                    (u,),
                ).fetchall()
            ]
        rows = await memory.run_sync(_all)
        loser = next(r for r in rows if r["value"] == "Jess")
        winner = next(r for r in rows if r["value"] == "Jesse")
        assert loser["status"] == "superseded"
        assert loser["valid_to"]  # stamped
        assert winner["valid_to"] is None  # currently true

    @pytest.mark.anyio
    async def test_entity_subject_persisted_without_person_row(self, memory):
        """Entity facts (movies, books, places) carry subject_type='entity'
        and have NO subject_ref_id — they're not in the people table."""
        u = await memory.get_or_create_user("default")
        await memory.upsert_fact(
            user_id=u,
            subject="biodome",
            subject_type="entity",
            predicate="was",
            value="pretty good",
            kind="preference",
        )
        rows = await memory.list_facts(u)
        assert rows[0]["subject_type"] == "entity"
        assert rows[0]["subject"] == "biodome"
        assert rows[0]["subject_ref_id"] is None
        assert rows[0]["kind"] == "preference"


class TestUserScoping:
    @pytest.mark.anyio
    async def test_default_user_seeded(self, memory):
        uid = await memory.get_or_create_user("default")
        assert uid == 1  # PR1 default user is always id=1

    @pytest.mark.anyio
    async def test_two_users_facts_are_isolated(self, memory):
        u1 = await memory.get_or_create_user("default")
        u2 = await memory.get_or_create_user("alice")
        assert u1 != u2

        await memory.upsert_fact(
            user_id=u1, subject="self", predicate="likes", value="hiking"
        )
        await memory.upsert_fact(
            user_id=u2, subject="self", predicate="likes", value="kayaking"
        )

        u1_facts = await memory.list_facts(u1)
        u2_facts = await memory.list_facts(u2)
        assert {f["value"] for f in u1_facts} == {"hiking"}
        assert {f["value"] for f in u2_facts} == {"kayaking"}

    @pytest.mark.anyio
    async def test_two_users_messages_are_isolated(self, memory):
        u1 = await memory.get_or_create_user("default")
        u2 = await memory.get_or_create_user("alice")
        s1 = await memory.create_session(u1)
        s2 = await memory.create_session(u2)
        await memory.add_message(user_id=u1, session_id=s1, role="user", content="hello u1")
        await memory.add_message(user_id=u2, session_id=s2, role="user", content="hello u2")

        # u1 cannot read s2 even by guessing the session id.
        cross = await memory.get_messages(user_id=u1, session_id=s2)
        assert cross == []
        own = await memory.get_messages(user_id=u1, session_id=s1)
        assert len(own) == 1 and own[0]["content"] == "hello u1"

    @pytest.mark.anyio
    async def test_fact_search_is_user_scoped(self, memory):
        u1 = await memory.get_or_create_user("default")
        u2 = await memory.get_or_create_user("alice")
        await memory.upsert_fact(
            user_id=u1, subject="self", predicate="likes", value="raspberry pi"
        )
        await memory.upsert_fact(
            user_id=u2, subject="self", predicate="likes", value="raspberry pi"
        )

        u1_results = await memory.search_facts(user_id=u1, query="raspberry")
        assert len(u1_results) == 1
        assert u1_results[0]["id"] != (
            await memory.search_facts(user_id=u2, query="raspberry")
        )[0]["id"]


class TestFactDedupAndConfirm:
    @pytest.mark.anyio
    async def test_repeat_confirms_existing_row(self, memory):
        uid = await memory.get_or_create_user("default")
        id1, c1, _ = await memory.upsert_fact(
            user_id=uid, subject="self", predicate="likes", value="hiking"
        )
        id2, c2, _ = await memory.upsert_fact(
            user_id=uid, subject="self", predicate="likes", value="hiking"
        )
        assert id1 == id2, "dedup should re-use the existing fact row"
        assert c1 == DEFAULT_CONFIDENCE
        assert c2 > c1, "confirmation must increase confidence"

    @pytest.mark.anyio
    async def test_distinct_values_coexist_for_conflict_ui(self, memory):
        """PR3's conflict UI needs the storage layer to keep both rows."""
        uid = await memory.get_or_create_user("default")
        id1, _, _ = await memory.upsert_fact(
            user_id=uid, subject="Billy", predicate="favorite_movie", value="Incredibles"
        )
        id2, _, _ = await memory.upsert_fact(
            user_id=uid, subject="Billy", predicate="favorite_movie", value="Cars"
        )
        assert id1 != id2
        facts = await memory.list_facts(uid)
        assert {f["value"] for f in facts} == {"Incredibles", "Cars"}


class TestFTS5Search:
    @pytest.mark.anyio
    async def test_more_relevant_fact_ranks_higher(self, memory):
        uid = await memory.get_or_create_user("default")
        await memory.upsert_fact(
            user_id=uid, subject="self", predicate="likes",
            value="raspberry pi single board computers",
        )
        await memory.upsert_fact(
            user_id=uid, subject="self", predicate="likes", value="apple pie",
        )
        await memory.upsert_fact(
            user_id=uid, subject="self", predicate="likes", value="hiking trails",
        )

        results = await memory.search_facts(user_id=uid, query="raspberry pi")
        assert results, "FTS5 returned no rows for an obvious match"
        assert "raspberry pi" in results[0]["value"]

    @pytest.mark.anyio
    async def test_search_handles_fts_operator_in_query(self, memory):
        """A bare ``AND`` from a user must not crash the FTS5 parser."""
        uid = await memory.get_or_create_user("default")
        await memory.upsert_fact(
            user_id=uid, subject="self", predicate="likes", value="hiking AND camping",
        )
        results = await memory.search_facts(user_id=uid, query="AND camping")
        assert isinstance(results, list)  # didn't raise
