"""User-scoped persistent memory provider.

Replaces the trio of ``SessionMemory`` (in-process JSON), ``BM25Index``
(in-memory inverted index), and ``SQLiteMemoryProvider`` (untyped flat
schema) deleted in this PR. Everything goes through one provider that:

- creates the schema on startup if missing (does NOT delete data/lokidoki.db)
- enforces user-scoping on every read and write
- keeps facts and messages searchable via FTS5 external-content
- optionally writes 384-dim fact embeddings into a sqlite-vec ``vec0``
  table; if sqlite-vec fails to load at startup, we WARN and continue
  with FTS5/BM25-only search.

Concurrency model: SQLite is synchronous, FastAPI is async. We open
one connection per provider, guard it with a single ``asyncio.Lock``,
and push every blocking call through ``asyncio.to_thread``. The
provider is process-singleton (instantiated once at app startup), which
matches SQLite's "serialized" threading guidance.

PR2 wires real auth on top: this provider is now strictly multi-user
and exposes only generic user CRUD. The bootstrap wizard, PIN/password
hashing, and JWT cookie machinery live in ``lokidoki/auth/*``.

The actual SQL lives in ``memory_sql.py``; this file is just async
dispatch + lifecycle so it stays under the 250-line CLAUDE.md ceiling.
"""
from __future__ import annotations

import asyncio
import os
import sqlite3

from lokidoki.core import memory_sql as sql
from lokidoki.core.memory_init import open_and_migrate


class MemoryProvider:
    """Single owner of all persistent memory state."""

    def __init__(self, db_path: str = "data/lokidoki.db"):
        self._db_path = db_path
        self._conn: sqlite3.Connection | None = None
        self._lock = asyncio.Lock()
        self._vec_loaded = False

    # ---- lifecycle -------------------------------------------------------

    async def initialize(self) -> None:
        """Open the connection and ensure the schema exists. Idempotent."""
        os.makedirs(os.path.dirname(self._db_path) or ".", exist_ok=True)
        self._conn, self._vec_loaded = await asyncio.to_thread(
            open_and_migrate, self._db_path
        )

    async def close(self) -> None:
        if self._conn is not None:
            await asyncio.to_thread(self._conn.close)
            self._conn = None

    @property
    def vec_enabled(self) -> bool:
        return self._vec_loaded

    # ---- users -----------------------------------------------------------

    async def get_or_create_user(self, username: str) -> int:
        async with self._lock:
            return await asyncio.to_thread(sql.get_or_create_user, self._conn, username)

    async def count_users(self) -> int:
        async with self._lock:
            row = await asyncio.to_thread(
                lambda: self._conn.execute(
                    "SELECT COUNT(*) FROM users WHERE status != 'deleted'"
                ).fetchone()
            )
        return int(row[0])

    async def run_sync(self, fn):
        """Acquire lock and run a sync function with the connection."""
        async with self._lock:
            return await asyncio.to_thread(fn, self._conn)

    # Per-user sentiment / session helpers live in memory_user_ops.py
    # to keep this file under the 250-line cap. They're imported and
    # bound as bound methods at module load time below.

    # ---- sessions --------------------------------------------------------

    async def create_session(self, user_id: int, title: str = "") -> int:
        async with self._lock:
            return await asyncio.to_thread(sql.create_session, self._conn, user_id, title)

    async def list_sessions(self, user_id: int) -> list[dict]:
        async with self._lock:
            rows = await asyncio.to_thread(sql.list_sessions, self._conn, user_id)
        return [dict(r) for r in rows]

    # ---- messages --------------------------------------------------------

    async def add_message(
        self, *, user_id: int, session_id: int, role: str, content: str
    ) -> int:
        async with self._lock:
            return await asyncio.to_thread(
                lambda: sql.add_message(
                    self._conn,
                    user_id=user_id,
                    session_id=session_id,
                    role=role,
                    content=content,
                )
            )

    async def get_messages(
        self, *, user_id: int, session_id: int, limit: int | None = None
    ) -> list[dict]:
        async with self._lock:
            rows = await asyncio.to_thread(
                lambda: sql.get_messages(
                    self._conn, user_id=user_id, session_id=session_id, limit=limit
                )
            )
        return [dict(r) for r in rows]

    async def search_messages(
        self, *, user_id: int, query: str, top_k: int = 10
    ) -> list[dict]:
        if not query.strip():
            return []
        fts_query = sql.fts_escape(query)
        async with self._lock:
            rows = await asyncio.to_thread(
                sql.search_messages, self._conn, user_id, fts_query, top_k
            )
        return [dict(r) for r in rows]

    # ---- facts -----------------------------------------------------------

    async def upsert_fact(
        self,
        *,
        user_id: int,
        subject: str,
        predicate: str,
        value: str,
        category: str = "general",
        source_message_id: int | None = None,
        subject_type: str = "self",
        subject_ref_id: int | None = None,
    ) -> tuple[int, float]:
        """Insert a fact OR confirm an existing matching row.

        Dedup-and-confirm: a fact is "the same" if (owner, subject,
        predicate, value) all match. On a match we bump confidence via
        ``update_confidence(..., confirmed=True)``. Different ``value``s
        for the same (owner, subject, predicate) coexist as separate
        rows so PR3's conflict UI has something to resolve.
        """
        async with self._lock:
            return await asyncio.to_thread(
                lambda: sql.upsert_fact(
                    self._conn,
                    user_id=user_id,
                    subject=subject,
                    predicate=predicate,
                    value=value,
                    category=category,
                    source_message_id=source_message_id,
                    subject_type=subject_type,
                    subject_ref_id=subject_ref_id,
                )
            )

    async def list_facts(self, user_id: int, limit: int = 100) -> list[dict]:
        async with self._lock:
            rows = await asyncio.to_thread(sql.list_facts, self._conn, user_id, limit)
        return [dict(r) for r in rows]

    async def search_facts(
        self, *, user_id: int, query: str, top_k: int = 10
    ) -> list[dict]:
        """Hybrid BM25 + (optional) cosine search over facts, scoped to user.

        See ``memory_search.hybrid_search_facts`` for the blend rule.
        Falls back to BM25 only when no fact embeddings exist for this
        user, which is the PR3 default.
        """
        from lokidoki.core.memory_search import hybrid_search_facts

        if not query.strip():
            return []
        async with self._lock:
            return await asyncio.to_thread(
                lambda: hybrid_search_facts(
                    self._conn,
                    user_id=user_id,
                    query=query,
                    top_k=top_k,
                    vec_enabled=self._vec_loaded,
                )
            )
