"""Async people / relationships / conflict helpers bound to MemoryProvider.

Lives outside ``memory_provider.py`` so the provider stays under the
250-line ceiling. Mirrors the binding pattern in ``memory_user_ops``:
each function is attached to the MemoryProvider class at import time
so callers can write ``mp.find_or_create_person(...)`` naturally.
"""
from __future__ import annotations

from typing import Optional

from lokidoki.core import memory_people_sql as psql
from lokidoki.core import memory_sql as sql
from lokidoki.core.memory_provider import MemoryProvider


async def find_or_create_person(
    self: MemoryProvider, user_id: int, name: str
) -> int:
    async with self._lock:
        return await self._run_thread_unlocked(
            psql.find_or_create_person, user_id, name
        )


async def find_people_by_name(
    self: MemoryProvider, user_id: int, name: str
) -> list[dict]:
    async with self._lock:
        rows = await self._run_thread_unlocked(
            psql.find_people_by_name, user_id, name
        )
    return [dict(r) for r in rows]


async def create_person(self: MemoryProvider, user_id: int, name: str) -> int:
    async with self._lock:
        return await self._run_thread_unlocked(psql.create_person, user_id, name)


async def update_person_name(
    self: MemoryProvider, user_id: int, person_id: int, name: str
) -> bool:
    async with self._lock:
        return await self._run_thread_unlocked(
            psql.update_person_name, user_id, person_id, name
        )


async def delete_person(
    self: MemoryProvider, user_id: int, person_id: int
) -> bool:
    async with self._lock:
        return await self._run_thread_unlocked(
            psql.delete_person, user_id, person_id
        )


async def create_ambiguity_group(
    self: MemoryProvider,
    user_id: int,
    raw_name: str,
    candidate_person_ids: list[int],
) -> int:
    async with self._lock:
        return await self._run_thread_unlocked(
            psql.create_ambiguity_group, user_id, raw_name, candidate_person_ids
        )


async def get_ambiguity_group(
    self: MemoryProvider, user_id: int, group_id: int
) -> Optional[dict]:
    async with self._lock:
        row = await self._run_thread_unlocked(
            psql.get_ambiguity_group, user_id, group_id
        )
    return dict(row) if row else None


async def resolve_ambiguity_group(
    self: MemoryProvider, user_id: int, group_id: int, person_id: int
) -> bool:
    async with self._lock:
        return await self._run_thread_unlocked(
            psql.resolve_ambiguity_group, user_id, group_id, person_id
        )


async def list_unresolved_ambiguity_groups(
    self: MemoryProvider, user_id: int
) -> list[dict]:
    async with self._lock:
        rows = await self._run_thread_unlocked(
            psql.list_unresolved_ambiguity_groups, user_id
        )
    return [dict(r) for r in rows]


async def count_recent_session_refs(
    self: MemoryProvider, user_id: int, person_id: int, since_message_id: int
) -> int:
    async with self._lock:
        return await self._run_thread_unlocked(
            psql.count_recent_session_refs, user_id, person_id, since_message_id
        )


# --- fact mutation helpers --------------------------------------------------


async def get_fact(self: MemoryProvider, user_id: int, fact_id: int) -> Optional[dict]:
    async with self._lock:
        row = await self._run_thread_unlocked(sql.get_fact, user_id, fact_id)
    return dict(row) if row else None


async def confirm_fact(
    self: MemoryProvider, user_id: int, fact_id: int
) -> Optional[float]:
    async with self._lock:
        return await self._run_thread_unlocked(sql.confirm_fact, user_id, fact_id)


async def reject_fact(self: MemoryProvider, user_id: int, fact_id: int) -> bool:
    async with self._lock:
        return await self._run_thread_unlocked(sql.reject_fact, user_id, fact_id)


async def delete_fact(self: MemoryProvider, user_id: int, fact_id: int) -> bool:
    async with self._lock:
        return await self._run_thread_unlocked(sql.delete_fact, user_id, fact_id)


async def patch_fact(
    self: MemoryProvider,
    user_id: int,
    fact_id: int,
    **fields,
) -> bool:
    async with self._lock:
        def _go(conn):
            return sql.patch_fact(conn, user_id, fact_id, **fields)
        import asyncio
        return await asyncio.to_thread(_go, self._conn)


async def list_facts_by_status(
    self: MemoryProvider,
    user_id: int,
    statuses: tuple,
    limit: int = 500,
) -> list[dict]:
    async with self._lock:
        rows = await self._run_thread_unlocked(
            sql.list_facts_by_status, user_id, statuses, limit
        )
    return [dict(r) for r in rows]


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


async def set_primary_relationship(
    self: MemoryProvider,
    user_id: int,
    person_id: int,
    relation: str,
) -> int:
    async with self._lock:
        return await self._run_thread_unlocked(
            psql.set_primary_relationship, user_id, person_id, relation
        )


async def delete_relationship(
    self: MemoryProvider, user_id: int, rel_id: int
) -> bool:
    async with self._lock:
        return await self._run_thread_unlocked(
            psql.delete_relationship, user_id, rel_id
        )


async def list_relationships(
    self: MemoryProvider, user_id: int
) -> list[dict]:
    async with self._lock:
        rows = await self._run_thread_unlocked(
            psql.list_relationships, user_id
        )
    # list_relationships now returns plain dicts from graph edges.
    return [dict(r) if not isinstance(r, dict) else r for r in rows]


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
MemoryProvider.find_people_by_name = find_people_by_name          # type: ignore[attr-defined]
MemoryProvider.create_person = create_person                      # type: ignore[attr-defined]
MemoryProvider.update_person_name = update_person_name            # type: ignore[attr-defined]
MemoryProvider.delete_person = delete_person                      # type: ignore[attr-defined]
MemoryProvider.create_ambiguity_group = create_ambiguity_group    # type: ignore[attr-defined]
MemoryProvider.get_ambiguity_group = get_ambiguity_group          # type: ignore[attr-defined]
MemoryProvider.resolve_ambiguity_group = resolve_ambiguity_group  # type: ignore[attr-defined]
MemoryProvider.list_unresolved_ambiguity_groups = list_unresolved_ambiguity_groups  # type: ignore[attr-defined]
MemoryProvider.count_recent_session_refs = count_recent_session_refs  # type: ignore[attr-defined]
MemoryProvider.get_fact = get_fact                                # type: ignore[attr-defined]
MemoryProvider.confirm_fact = confirm_fact                        # type: ignore[attr-defined]
MemoryProvider.reject_fact = reject_fact                          # type: ignore[attr-defined]
MemoryProvider.delete_fact = delete_fact                          # type: ignore[attr-defined]
MemoryProvider.patch_fact = patch_fact                            # type: ignore[attr-defined]
MemoryProvider.list_facts_by_status = list_facts_by_status        # type: ignore[attr-defined]
MemoryProvider.set_primary_relationship = set_primary_relationship  # type: ignore[attr-defined]
MemoryProvider.delete_relationship = delete_relationship          # type: ignore[attr-defined]
