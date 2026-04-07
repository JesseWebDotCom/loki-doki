"""Tests for PR3 people / relationships / conflicts on MemoryProvider."""
from __future__ import annotations

import pytest

from lokidoki.core.memory_provider import MemoryProvider
from lokidoki.core import memory_people_ops  # noqa: F401  bind methods


@pytest.fixture
async def memory(tmp_path):
    mp = MemoryProvider(db_path=str(tmp_path / "people.db"))
    await mp.initialize()
    yield mp
    await mp.close()


@pytest.fixture
async def user_id(memory):
    return await memory.get_or_create_user("alice")


class TestPeople:
    @pytest.mark.anyio
    async def test_find_or_create_is_idempotent(self, memory, user_id):
        a = await memory.find_or_create_person(user_id, "Mark")
        b = await memory.find_or_create_person(user_id, "Mark")
        assert a == b

    @pytest.mark.anyio
    async def test_find_or_create_is_case_insensitive(self, memory, user_id):
        a = await memory.find_or_create_person(user_id, "Mark")
        b = await memory.find_or_create_person(user_id, "mark")
        c = await memory.find_or_create_person(user_id, "MARK")
        assert a == b == c

    @pytest.mark.anyio
    async def test_people_are_user_scoped(self, memory):
        u1 = await memory.get_or_create_user("alice")
        u2 = await memory.get_or_create_user("bob")
        m1 = await memory.find_or_create_person(u1, "Mark")
        m2 = await memory.find_or_create_person(u2, "Mark")
        assert m1 != m2  # distinct rows even though name matches

    @pytest.mark.anyio
    async def test_list_people_includes_fact_count(self, memory, user_id):
        pid = await memory.find_or_create_person(user_id, "Mark")
        await memory.upsert_fact(
            user_id=user_id, subject="mark", subject_type="person",
            subject_ref_id=pid, predicate="location", value="Denver",
        )
        await memory.upsert_fact(
            user_id=user_id, subject="mark", subject_type="person",
            subject_ref_id=pid, predicate="job", value="plumber",
        )
        people = await memory.list_people(user_id)
        assert len(people) == 1
        assert people[0]["fact_count"] == 2


class TestPersonMerge:
    @pytest.mark.anyio
    async def test_merge_moves_facts_and_relationships(self, memory, user_id):
        src = await memory.find_or_create_person(user_id, "Markie")
        dst = await memory.find_or_create_person(user_id, "Mark")
        await memory.upsert_fact(
            user_id=user_id, subject="markie", subject_type="person",
            subject_ref_id=src, predicate="location", value="Denver",
        )
        await memory.add_relationship(user_id, src, "brother")

        ok = await memory.merge_people(user_id, src, dst)
        assert ok

        # source row gone, dst inherits the fact and the relationship
        assert await memory.get_person(user_id, src) is None
        dst_facts = await memory.list_facts_about_person(user_id, dst)
        assert any(f["value"] == "Denver" for f in dst_facts)
        rels = await memory.list_relationships(user_id)
        assert len(rels) == 1 and rels[0]["person_id"] == dst

    @pytest.mark.anyio
    async def test_merge_into_self_is_noop(self, memory, user_id):
        pid = await memory.find_or_create_person(user_id, "Mark")
        ok = await memory.merge_people(user_id, pid, pid)
        assert ok is False

    @pytest.mark.anyio
    async def test_cannot_merge_across_users(self, memory):
        u1 = await memory.get_or_create_user("alice")
        u2 = await memory.get_or_create_user("bob")
        p1 = await memory.find_or_create_person(u1, "Mark")
        p2 = await memory.find_or_create_person(u2, "Mark")
        # u1 trying to merge u2's person — both ids must be u1's, so no-op.
        ok = await memory.merge_people(u1, p1, p2)
        assert ok is False
        # Both people still exist on their respective owners.
        assert await memory.get_person(u1, p1) is not None
        assert await memory.get_person(u2, p2) is not None


class TestRelationships:
    @pytest.mark.anyio
    async def test_add_relationship_dedup_and_confirm(self, memory, user_id):
        pid = await memory.find_or_create_person(user_id, "Mark")
        a = await memory.add_relationship(user_id, pid, "brother")
        b = await memory.add_relationship(user_id, pid, "brother")
        assert a == b  # dedup; the same row gets confidence-bumped


class TestConflicts:
    @pytest.mark.anyio
    async def test_conflicts_returns_multivalue_groups(self, memory, user_id):
        await memory.upsert_fact(
            user_id=user_id, subject="self", predicate="favorite_color", value="blue",
        )
        await memory.upsert_fact(
            user_id=user_id, subject="self", predicate="favorite_color", value="green",
        )
        await memory.upsert_fact(
            user_id=user_id, subject="self", predicate="job", value="electrician",
        )
        rows = await memory.list_fact_conflicts(user_id)
        # Two candidates for favorite_color, none for job (single value).
        values = sorted({r["value"] for r in rows})
        assert values == ["blue", "green"]
