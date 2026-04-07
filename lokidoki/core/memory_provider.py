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

PR1 only seeds a single ``default`` user with id=1. PR2 adds the real
auth flow. All bootstrap-gate / PIN / session-token concerns are
explicitly out of scope here — see TODO(auth-PR2) markers.

The actual SQL lives in ``memory_sql.py``; this file is just async
dispatch + lifecycle so it stays under the 250-line CLAUDE.md ceiling.
"""
from __future__ import annotations

import asyncio
import logging
import os
import sqlite3

from lokidoki.core import memory_sql as sql
from lokidoki.core.memory_schema import (
    CORE_SCHEMA,
    EMBEDDING_DIM,
    FTS_SCHEMA,
    vec_schema,
)

logger = logging.getLogger(__name__)

DEFAULT_USERNAME = "default"  # TODO(auth-PR2): replace with real users


class MemoryProvider:
    """Single owner of all persistent memory state."""

    def __init__(self, db_path: str = "data/lokidoki.db"):
        self._db_path = db_path
        self._conn: sqlite3.Connection | None = None
        self._lock = asyncio.Lock()
        self._vec_loaded = False

    # ---- lifecycle -------------------------------------------------------

    async def initialize(self) -> None:
        """Open the connection and ensure the schema exists.

        Idempotent: safe to call on every app start. Will NOT delete an
        existing database file — only adds missing tables.
        """
        os.makedirs(os.path.dirname(self._db_path) or ".", exist_ok=True)
        await asyncio.to_thread(self._open_and_migrate)
        await self._ensure_default_user()

    def _open_and_migrate(self) -> None:
        conn = sqlite3.connect(self._db_path, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        conn.execute("PRAGMA journal_mode = WAL")

        # Try to load sqlite-vec. Any failure (extension loading
        # disabled, missing dylib, version mismatch) → warn and degrade.
        try:
            import sqlite_vec  # noqa: WPS433
            conn.enable_load_extension(True)
            sqlite_vec.load(conn)
            conn.enable_load_extension(False)
            self._vec_loaded = True
        except Exception as exc:
            logger.warning(
                "sqlite-vec failed to load (%s); continuing with FTS5/BM25 only",
                exc,
            )
            self._vec_loaded = False

        conn.executescript(CORE_SCHEMA)
        conn.executescript(FTS_SCHEMA)
        if self._vec_loaded:
            try:
                conn.executescript(vec_schema(EMBEDDING_DIM))
            except sqlite3.Error as exc:
                logger.warning("vec_facts creation failed (%s); disabling vec", exc)
                self._vec_loaded = False
        conn.commit()
        self._conn = conn

    async def close(self) -> None:
        if self._conn is not None:
            await asyncio.to_thread(self._conn.close)
            self._conn = None

    @property
    def vec_enabled(self) -> bool:
        return self._vec_loaded

    # ---- users -----------------------------------------------------------

    async def _ensure_default_user(self) -> None:
        """Seed a single default user (id=1) if the users table is empty.

        TODO(auth-PR2): drop this and gate on bootstrap wizard.
        """
        async with self._lock:
            row = await asyncio.to_thread(
                lambda: self._conn.execute("SELECT COUNT(*) FROM users").fetchone()
            )
            if row[0] == 0:
                await asyncio.to_thread(
                    lambda: self._conn.execute(
                        "INSERT INTO users (username, role) VALUES (?, 'admin')",
                        (DEFAULT_USERNAME,),
                    )
                )
                await asyncio.to_thread(self._conn.commit)

    async def get_or_create_user(self, username: str) -> int:
        async with self._lock:
            return await asyncio.to_thread(sql.get_or_create_user, self._conn, username)

    async def default_user_id(self) -> int:
        return await self.get_or_create_user(DEFAULT_USERNAME)

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
                )
            )

    async def list_facts(self, user_id: int, limit: int = 100) -> list[dict]:
        async with self._lock:
            rows = await asyncio.to_thread(sql.list_facts, self._conn, user_id, limit)
        return [dict(r) for r in rows]

    async def search_facts(
        self, *, user_id: int, query: str, top_k: int = 10
    ) -> list[dict]:
        """FTS5/BM25 ranked search over facts.value, scoped to user."""
        if not query.strip():
            return []
        fts_query = sql.fts_escape(query)
        async with self._lock:
            rows = await asyncio.to_thread(
                sql.search_facts, self._conn, user_id, fts_query, top_k
            )
        return [dict(r) for r in rows]
