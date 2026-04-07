"""Synchronous SQL helpers for the MemoryProvider.

These are plain functions that take a ``sqlite3.Connection`` and do one
focused operation. They live here so ``memory_provider.py`` stays under
the 250-line ceiling and so the SQL is easy to read in one place.

Every function is user-scoped: ``user_id`` is always part of the WHERE
clause for reads and the column list for writes. This is the single
choke point that enforces the multi-user isolation requirement from
PR1, so any new query MUST keep the same shape.
"""
from __future__ import annotations

import sqlite3

from lokidoki.core.confidence import DEFAULT_CONFIDENCE, update_confidence


def get_or_create_user(conn: sqlite3.Connection, username: str) -> int:
    row = conn.execute(
        "SELECT id FROM users WHERE username = ?", (username,)
    ).fetchone()
    if row:
        return int(row["id"])
    cur = conn.execute("INSERT INTO users (username) VALUES (?)", (username,))
    conn.commit()
    return int(cur.lastrowid)


def create_session(conn: sqlite3.Connection, user_id: int, title: str) -> int:
    cur = conn.execute(
        "INSERT INTO sessions (owner_user_id, title) VALUES (?, ?)",
        (user_id, title),
    )
    conn.commit()
    return int(cur.lastrowid)


def list_sessions(conn: sqlite3.Connection, user_id: int) -> list[sqlite3.Row]:
    return conn.execute(
        "SELECT id, title, created_at FROM sessions "
        "WHERE owner_user_id = ? ORDER BY id DESC",
        (user_id,),
    ).fetchall()


def add_message(
    conn: sqlite3.Connection,
    *,
    user_id: int,
    session_id: int,
    role: str,
    content: str,
) -> int:
    cur = conn.execute(
        "INSERT INTO messages (session_id, owner_user_id, role, content) "
        "VALUES (?, ?, ?, ?)",
        (session_id, user_id, role, content),
    )
    conn.commit()
    return int(cur.lastrowid)


def get_messages(
    conn: sqlite3.Connection,
    *,
    user_id: int,
    session_id: int,
    limit: int | None,
) -> list[sqlite3.Row]:
    if limit:
        rows = conn.execute(
            "SELECT id, role, content, created_at FROM messages "
            "WHERE owner_user_id = ? AND session_id = ? "
            "ORDER BY id DESC LIMIT ?",
            (user_id, session_id, limit),
        ).fetchall()
        return rows[::-1]
    return conn.execute(
        "SELECT id, role, content, created_at FROM messages "
        "WHERE owner_user_id = ? AND session_id = ? ORDER BY id ASC",
        (user_id, session_id),
    ).fetchall()


def upsert_fact(
    conn: sqlite3.Connection,
    *,
    user_id: int,
    subject: str,
    predicate: str,
    value: str,
    category: str,
    source_message_id: int | None,
    subject_type: str = "self",
    subject_ref_id: int | None = None,
) -> tuple[int, float]:
    """Insert OR confirm. See MemoryProvider.upsert_fact for the contract."""
    existing = conn.execute(
        "SELECT id, confidence FROM facts "
        "WHERE owner_user_id = ? AND subject = ? AND predicate = ? AND value = ?",
        (user_id, subject, predicate, value),
    ).fetchone()
    if existing:
        new_conf = update_confidence(float(existing["confidence"]), confirmed=True)
        conn.execute(
            "UPDATE facts SET confidence = ?, updated_at = datetime('now') "
            "WHERE id = ?",
            (new_conf, existing["id"]),
        )
        conn.commit()
        return int(existing["id"]), float(new_conf)

    cur = conn.execute(
        "INSERT INTO facts "
        "(owner_user_id, subject, subject_type, subject_ref_id, "
        "predicate, value, category, confidence, source_message_id) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (
            user_id, subject, subject_type, subject_ref_id,
            predicate, value, category,
            DEFAULT_CONFIDENCE, source_message_id,
        ),
    )
    conn.commit()
    # TODO(embeddings-perf): when sync-on-write embedding lands, write a
    # 384-dim vector to vec_facts here. PR3 ships BM25-only by design.
    return int(cur.lastrowid), DEFAULT_CONFIDENCE


def list_facts(
    conn: sqlite3.Connection, user_id: int, limit: int
) -> list[sqlite3.Row]:
    return conn.execute(
        "SELECT id, subject, predicate, value, category, confidence, "
        "       created_at, updated_at FROM facts "
        "WHERE owner_user_id = ? ORDER BY updated_at DESC LIMIT ?",
        (user_id, limit),
    ).fetchall()


def search_facts(
    conn: sqlite3.Connection, user_id: int, fts_query: str, top_k: int
) -> list[sqlite3.Row]:
    return conn.execute(
        "SELECT f.id, f.subject, f.predicate, f.value, f.category, "
        "       f.confidence, f.created_at, "
        "       bm25(facts_fts) AS score "
        "FROM facts_fts JOIN facts f ON f.id = facts_fts.rowid "
        "WHERE facts_fts MATCH ? AND f.owner_user_id = ? "
        "ORDER BY score LIMIT ?",
        (fts_query, user_id, top_k),
    ).fetchall()


def search_messages(
    conn: sqlite3.Connection, user_id: int, fts_query: str, top_k: int
) -> list[sqlite3.Row]:
    return conn.execute(
        "SELECT m.id, m.role, m.content, m.created_at, "
        "       bm25(messages_fts) AS score "
        "FROM messages_fts JOIN messages m ON m.id = messages_fts.rowid "
        "WHERE messages_fts MATCH ? AND m.owner_user_id = ? "
        "ORDER BY score LIMIT ?",
        (fts_query, user_id, top_k),
    ).fetchall()


def fts_escape(query: str) -> str:
    """Wrap user input as quoted FTS5 phrase tokens.

    Stops a stray ``"`` or operator like ``AND`` from crashing the
    parser. Whitespace-split, drop empties, re-join as quoted tokens —
    implicit AND, no injection surface.
    """
    tokens = [t.replace('"', '') for t in query.split() if t.strip()]
    if not tokens:
        return '""'
    return " ".join(f'"{t}"' for t in tokens)
