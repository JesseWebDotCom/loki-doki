"""User-scoped persistent memory provider.

Replaces the trio of ``SessionMemory`` (in-process JSON), ``BM25Index``
(in-memory inverted index), and ``SQLiteMemoryProvider`` (untyped flat
schema) deleted in this PR. Everything goes through one provider that:

- creates the schema on startup if missing (does NOT delete data/lokidoki.db)
- enforces user-scoping on every read and write
- keeps facts and messages searchable via FTS5 external-contentfrom typing import Optional, Union
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
from typing import Optional, Union

import asyncio
import os
import sqlite3

from lokidoki.core import memory_sql as sql
from lokidoki.core.memory_init import open_and_migrate


class MemoryProvider:
    """Single owner of all persistent memory state."""

    def __init__(self, db_path: str = "data/lokidoki.db"):
        self._db_path = db_path
        self._conn: Optional[sqlite3.Connection] = None
        self._lock = asyncio.Lock()
        self._vec_loaded = False

    # ---- lifecycle -------------------------------------------------------

    async def initialize(self) -> None:
        """Open the connection and ensure the schema exists. Idempotent."""
        os.makedirs(os.path.dirname(self._db_path) or ".", exist_ok=True)
        self._conn, self._vec_loaded = await asyncio.to_thread(
            open_and_migrate, self._db_path
        )
        # Idempotent character seeding + first-boot personality migration.
        # Lives outside open_and_migrate so the seed module can read
        # data/settings.json (a side effect that doesn't belong in the
        # pure schema layer).
        from lokidoki.core.character_seed import run_seed
        await asyncio.to_thread(run_seed, self._conn)
        # Backfill embeddings for any active facts that don't have a
        # vec_facts row yet. Idempotent — runs every startup but only
        # touches rows that have never been embedded. Bounded so a
        # cold start with thousands of facts doesn't pin the CPU; the
        # remainder rolls over into subsequent boots.
        if self._vec_loaded:
            try:
                await self._backfill_embeddings(max_rows=500)
                await self._backfill_message_embeddings(max_rows=500)
            except Exception:  # noqa: BLE001 — never block startup
                import logging
                logging.getLogger(__name__).exception(
                    "[memory] embedding backfill failed; continuing"
                )

    async def _backfill_embeddings(self, *, max_rows: int) -> None:
        """Embed up to ``max_rows`` active facts that have no vec_facts row.

        Reads + writes go through the same connection lock as the rest
        of the provider. Embedding inference happens outside the lock
        in a thread so the event loop stays responsive.
        """
        def _missing(conn):
            rows = conn.execute(
                "SELECT f.id, f.subject, f.predicate, f.value "
                "FROM facts f LEFT JOIN vec_facts vf ON vf.fact_id = f.id "
                "WHERE vf.fact_id IS NULL AND f.status IN ('active','ambiguous') "
                "LIMIT ?",
                (max_rows,),
            ).fetchall()
            return [dict(r) for r in rows]

        async with self._lock:
            rows = await asyncio.to_thread(_missing, self._conn)
        if not rows:
            return

        from lokidoki.core.embedder import get_embedder
        sentences = [f"{r['subject']} {r['predicate']} {r['value']}".strip() for r in rows]
        vectors = await asyncio.to_thread(
            lambda: get_embedder().embed_passages(sentences)
        )

        import json as _json

        def _write(conn):
            for r, vec in zip(rows, vectors):
                try:
                    conn.execute(
                        "INSERT INTO vec_facts (fact_id, embedding) VALUES (?, ?)",
                        (int(r["id"]), _json.dumps(vec)),
                    )
                except Exception:
                    continue
            conn.commit()

        async with self._lock:
            await asyncio.to_thread(_write, self._conn)
        import logging
        logging.getLogger(__name__).info(
            "[memory] backfilled %d fact embeddings", len(rows)
        )

    async def _backfill_message_embeddings(self, *, max_rows: int) -> None:
        """Embed up to ``max_rows`` user-role messages with no vec_messages row.

        Same shape as ``_backfill_embeddings`` but for the messages
        table. Only user-role rows are embedded — assistant turns
        never go in.
        """
        def _missing(conn):
            try:
                rows = conn.execute(
                    "SELECT m.id, m.content FROM messages m "
                    "LEFT JOIN vec_messages vm ON vm.message_id = m.id "
                    "WHERE vm.message_id IS NULL AND m.role = 'user' "
                    "AND m.content != '' LIMIT ?",
                    (max_rows,),
                ).fetchall()
            except sqlite3.OperationalError:
                return []
            return [dict(r) for r in rows]

        async with self._lock:
            rows = await asyncio.to_thread(_missing, self._conn)
        if not rows:
            return

        from lokidoki.core.embedder import get_embedder
        sentences = [r["content"] for r in rows]
        vectors = await asyncio.to_thread(
            lambda: get_embedder().embed_passages(sentences)
        )

        import json as _json

        def _write(conn):
            for r, vec in zip(rows, vectors):
                try:
                    conn.execute(
                        "INSERT INTO vec_messages (message_id, embedding) VALUES (?, ?)",
                        (int(r["id"]), _json.dumps(vec)),
                    )
                except Exception:
                    continue
            conn.commit()

        async with self._lock:
            await asyncio.to_thread(_write, self._conn)
        import logging
        logging.getLogger(__name__).info(
            "[memory] backfilled %d message embeddings", len(rows)
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

    async def create_session(
        self, user_id: int, title: str = "", project_id: Optional[int] = None
    ) -> int:
        async with self._lock:
            return await asyncio.to_thread(
                sql.create_session, self._conn, user_id, title, project_id
            )

    async def list_sessions(
        self, user_id: int, project_id: Optional[int] = None
    ) -> list[dict]:
        async with self._lock:
            rows = await asyncio.to_thread(
                sql.list_sessions, self._conn, user_id, project_id
            )
        return [dict(r) for r in rows]

    async def update_session_title(
        self, user_id: int, session_id: int, title: str
    ) -> bool:
        async with self._lock:
            return await asyncio.to_thread(
                sql.update_session_title, self._conn, user_id, session_id, title
            )

    async def move_session_to_project(
        self, user_id: int, session_id: int, project_id: Optional[int]
    ) -> bool:
        async with self._lock:
            return await asyncio.to_thread(
                sql.move_session_to_project,
                self._conn,
                user_id,
                session_id,
                project_id,
            )

    # ---- projects --------------------------------------------------------

    async def create_project(
        self,
        user_id: int,
        name: str,
        description: str = "",
        prompt: str = "",
        icon: str = "Folder",
        icon_color: str = "swatch-1",
    ) -> int:
        async with self._lock:
            return await asyncio.to_thread(
                sql.create_project,
                self._conn,
                user_id,
                name,
                description,
                prompt,
                icon,
                icon_color,
            )

    async def list_projects(self, user_id: int) -> list[dict]:
        async with self._lock:
            rows = await asyncio.to_thread(sql.list_projects, self._conn, user_id)
        return [dict(r) for r in rows]

    async def get_project(self, user_id: int, project_id: int) -> Optional[dict]:
        async with self._lock:
            row = await asyncio.to_thread(
                sql.get_project, self._conn, user_id, project_id
            )
        return dict(row) if row else None

    async def update_project(
        self,
        user_id: int,
        project_id: int,
        name: str,
        description: str,
        prompt: str,
        icon: str = "Folder",
        icon_color: str = "swatch-1",
    ) -> bool:
        async with self._lock:
            return await asyncio.to_thread(
                sql.update_project,
                self._conn,
                user_id,
                project_id,
                name,
                description,
                prompt,
                icon,
                icon_color,
            )

    async def delete_project(self, user_id: int, project_id: int) -> bool:
        async with self._lock:
            return await asyncio.to_thread(
                sql.delete_project, self._conn, user_id, project_id
            )

    # ---- messages --------------------------------------------------------

    async def add_message(
        self, *, user_id: int, session_id: int, role: str, content: str
    ) -> int:
        # Embed user-role messages so the verbatim semantic search
        # ("what did we decide about auth") works. Assistant turns are
        # NOT embedded — they dilute the index with model paraphrases
        # and we never search them. Embedding happens outside the DB
        # lock so the ~50ms inference doesn't block other writers.
        embedding: Optional[list] = None
        if self._vec_loaded and role == "user" and content.strip():
            try:
                from lokidoki.core.embedder import get_embedder
                embedding = await asyncio.to_thread(
                    lambda: get_embedder().embed_passages([content])[0]
                )
            except Exception:  # noqa: BLE001 — degrade silently
                embedding = None

        async with self._lock:
            return await asyncio.to_thread(
                lambda: sql.add_message(
                    self._conn,
                    user_id=user_id,
                    session_id=session_id,
                    role=role,
                    content=content,
                    embedding=embedding,
                )
            )

    async def get_messages(
        self, *, user_id: int, session_id: int, limit: Optional[int] = None
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
        """Hybrid BM25 + vector search over user-role messages.

        Falls back to BM25 only when vec_messages is unpopulated for
        this user (e.g. before the backfill catches up).
        """
        from lokidoki.core.memory_search import hybrid_search_messages

        if not query.strip():
            return []
        async with self._lock:
            return await asyncio.to_thread(
                lambda: hybrid_search_messages(
                    self._conn,
                    user_id=user_id,
                    query=query,
                    top_k=top_k,
                    vec_enabled=self._vec_loaded,
                )
            )

    # ---- facts -----------------------------------------------------------

    async def upsert_fact(
        self,
        *,
        user_id: int,
        subject: str,
        predicate: str,
        value: str,
        category: str = "general",
        source_message_id: Optional[int] = None,
        subject_type: str = "self",
        subject_ref_id: Optional[int] = None,
        project_id: Optional[int] = None,
        status: str = "active",
        ambiguity_group_id: Optional[int] = None,
        negates_previous: bool = False,
        kind: str = "fact",
    ) -> tuple[int, float, dict]:
        """Insert a fact OR confirm an existing matching row.

        Dedup-and-confirm: a fact is "the same" if (owner, subject,
        predicate, value) all match. On a match we bump confidence via
        ``update_confidence(..., confirmed=True)``. Different ``value``s
        for the same (owner, subject, predicate) coexist as separate
        rows so PR3's conflict UI has something to resolve.
        """
        # Compute the embedding outside the DB lock so we don't block
        # other writers during the ~50ms inference. ``embed_passages``
        # is sync; route through ``to_thread`` to keep the event loop
        # responsive. We embed a "subject predicate value" sentence so
        # the vector captures the full semantic context, not just the
        # value. Skipped when sqlite-vec failed to load — the SQL writer
        # treats embedding=None as "BM25-only for this row".
        embedding: Optional[list] = None
        if self._vec_loaded:
            try:
                from lokidoki.core.embedder import get_embedder
                sentence = f"{subject} {predicate} {value}".strip()
                embedding = await asyncio.to_thread(
                    lambda: get_embedder().embed_passages([sentence])[0]
                )
            except Exception:  # noqa: BLE001 — degrade, never crash a write
                embedding = None

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
                    project_id=project_id,
                    status=status,
                    ambiguity_group_id=ambiguity_group_id,
                    negates_previous=negates_previous,
                    kind=kind,
                    embedding=embedding,
                )
            )

    async def list_facts(
        self,
        user_id: int,
        limit: int = 100,
        project_id: Optional[int] = None,
    ) -> list[dict]:
        async with self._lock:
            rows = await asyncio.to_thread(
                sql.list_facts, self._conn, user_id, limit, project_id
            )
        return [dict(r) for r in rows]

    async def search_facts(
        self, *, user_id: int, query: str, top_k: int = 10, project_id: Optional[int] = None
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
                    project_id=project_id,
                )
            )
