"""Async people / relationships / conflict helpers bound to MemoryProvider.

Lives outside ``memory_provider.py`` so the provider stays under the
250-line ceiling. Mirrors the binding pattern in ``memory_user_ops``:
each function is attached to the MemoryProvider class at import time
so callers can write ``mp.find_or_create_person(...)`` naturally.
"""
from __future__ import annotations

from lokidoki.core import memory_people_sql as psql
from lokidoki.core.memory_provider import MemoryProvider


async def find_or_create_person(
    self: MemoryProvider, user_id: int, name: str
) -> int:
    async with self._lock:
        return await self._run_thread_unlocked(
            psql.find_or_create_person, user_id, name
        )


async def list_people(self: MemoryProvider, user_id: int) -> list[dict]:
    async with self._lock:
        rows = await self._run_thread_unlocked(psql.list_people, user_id)
    return [dict(r) for r in rows]


async def get_person(
    self: MemoryProvider, user_id: int, person_id: int
) -> dict :
    async with self._lock:
        row = await self._run_thread_unlocked(
            psql.get_person, user_id, person_id
        )
    return dict(row) if row else None


async def list_facts_about_person(
    self: MemoryProvider, user_id: int, person_id: int
) -> list[dict]:
    async with self._lock:
        rows = await self._run_thread_unlocked(
            psql.list_facts_about_person, user_id, person_id
        )
    return [dict(r) for r in rows]


async def merge_people(
    self: MemoryProvider,
    user_id: int,
    source_id: int,
    into_id: int,
) -> bool:
    async with self._lock:
        return await self._run_thread_unlocked(
            psql.merge_people, user_id, source_id, into_id
        )


async def add_relationship(
    self: MemoryProvider,
    user_id: int,
    person_id: int,
    relation: str,
) -> int:
    async with self._lock:
        return await self._run_thread_unlocked(
            psql.upsert_relationship, user_id, person_id, relation
        )


async def list_relationships(
    self: MemoryProvider, user_id: int
) -> list[dict]:
    async with self._lock:
        rows = await self._run_thread_unlocked(
            psql.list_relationships, user_id
        )
    return [dict(r) for r in rows]


async def list_fact_conflicts(
    self: MemoryProvider, user_id: int
) -> list[dict]:
    async with self._lock:
        rows = await self._run_thread_unlocked(
            psql.list_fact_conflicts, user_id
        )
    return [dict(r) for r in rows]


async def _run_thread_unlocked(self: MemoryProvider, fn, *args):
    """Run a sync helper in a thread with the connection.

    Lock is the caller's responsibility — these helpers are only used
    by methods on this module, which already hold ``self._lock``.
    """
    import asyncio

    return await asyncio.to_thread(fn, self._conn, *args)


# Bind everything onto MemoryProvider as methods (side-effect import).
MemoryProvider._run_thread_unlocked = _run_thread_unlocked       # type: ignore[attr-defined]
MemoryProvider.find_or_create_person = find_or_create_person     # type: ignore[attr-defined]
MemoryProvider.list_people = list_people                          # type: ignore[attr-defined]
MemoryProvider.get_person = get_person                            # type: ignore[attr-defined]
MemoryProvider.list_facts_about_person = list_facts_about_person  # type: ignore[attr-defined]
MemoryProvider.merge_people = merge_people                        # type: ignore[attr-defined]
MemoryProvider.add_relationship = add_relationship                # type: ignore[attr-defined]
MemoryProvider.list_relationships = list_relationships            # type: ignore[attr-defined]
MemoryProvider.list_fact_conflicts = list_fact_conflicts          # type: ignore[attr-defined]
