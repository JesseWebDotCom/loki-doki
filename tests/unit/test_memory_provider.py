"""MemoryProvider unit tests for PR1.

Coverage:
- user-scoping isolation (seed two users; assert reads/writes don't bleed)
- fact dedup-and-confirm bumps confidence on repeat
- distinct values for the same (subject, predicate) coexist (PR3 conflicts)
- FTS5/BM25 search ranks more-relevant facts higher
- search results are scoped to the calling user
"""
import pytest

from lokidoki.core.confidence import DEFAULT_CONFIDENCE
from lokidoki.core.memory_provider import MemoryProvider


@pytest.fixture
async def memory(tmp_path):
    mp = MemoryProvider(db_path=str(tmp_path / "provider.db"))
    await mp.initialize()
    yield mp
    await mp.close()


class TestUserScoping:
    @pytest.mark.anyio
    async def test_default_user_seeded(self, memory):
        uid = await memory.default_user_id()
        assert uid == 1  # PR1 default user is always id=1

    @pytest.mark.anyio
    async def test_two_users_facts_are_isolated(self, memory):
        u1 = await memory.default_user_id()
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
        u1 = await memory.default_user_id()
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
        u1 = await memory.default_user_id()
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
        uid = await memory.default_user_id()
        id1, c1 = await memory.upsert_fact(
            user_id=uid, subject="self", predicate="likes", value="hiking"
        )
        id2, c2 = await memory.upsert_fact(
            user_id=uid, subject="self", predicate="likes", value="hiking"
        )
        assert id1 == id2, "dedup should re-use the existing fact row"
        assert c1 == DEFAULT_CONFIDENCE
        assert c2 > c1, "confirmation must increase confidence"

    @pytest.mark.anyio
    async def test_distinct_values_coexist_for_conflict_ui(self, memory):
        """PR3's conflict UI needs the storage layer to keep both rows."""
        uid = await memory.default_user_id()
        id1, _ = await memory.upsert_fact(
            user_id=uid, subject="Billy", predicate="favorite_movie", value="Incredibles"
        )
        id2, _ = await memory.upsert_fact(
            user_id=uid, subject="Billy", predicate="favorite_movie", value="Cars"
        )
        assert id1 != id2
        facts = await memory.list_facts(uid)
        assert {f["value"] for f in facts} == {"Incredibles", "Cars"}


class TestFTS5Search:
    @pytest.mark.anyio
    async def test_more_relevant_fact_ranks_higher(self, memory):
        uid = await memory.default_user_id()
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
        uid = await memory.default_user_id()
        await memory.upsert_fact(
            user_id=uid, subject="self", predicate="likes", value="hiking AND camping",
        )
        results = await memory.search_facts(user_id=uid, query="AND camping")
        assert isinstance(results, list)  # didn't raise
