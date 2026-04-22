"""Local SQLite FTS helpers for chat transcript search."""
from __future__ import annotations

import sqlite3
from typing import Any


def _normalize_query(query: str) -> str:
    return " ".join(query.strip().split())


def _search_rows(
    conn: sqlite3.Connection,
    *,
    user_id: int,
    query: str,
    session_id: int | None,
    limit: int,
    offset: int,
) -> list[dict[str, Any]]:
    normalized = _normalize_query(query)
    if not normalized:
        return []

    session_clause = "AND m.session_id = ? " if session_id is not None else ""
    params: list[Any] = [user_id, normalized]
    if session_id is not None:
        params.append(session_id)
    params.extend([limit, offset])

    rows = conn.execute(
        """
        SELECT
            m.id AS message_id,
            m.session_id,
            s.title AS session_title,
            m.role,
            m.created_at,
            snippet(messages_fts, 0, '[', ']', ' … ', 12) AS snippet,
            bm25(messages_fts) AS rank
        FROM messages_fts
        JOIN messages AS m
          ON m.id = messages_fts.rowid
        JOIN sessions AS s
          ON s.id = m.session_id
        WHERE m.owner_user_id = ?
          AND messages_fts MATCH ?
          """ + session_clause + """
        ORDER BY rank, m.created_at DESC
        LIMIT ? OFFSET ?
        """,
        tuple(params),
    ).fetchall()

    return [
        {
            "message_id": int(row["message_id"]),
            "session_id": int(row["session_id"]),
            "session_title": row["session_title"] or "Untitled chat",
            "role": row["role"],
            "created_at": row["created_at"],
            "snippet": row["snippet"] or "",
        }
        for row in rows
    ]


def find_in_chat(
    conn: sqlite3.Connection,
    *,
    user_id: int,
    session_id: int,
    query: str,
    limit: int = 20,
    offset: int = 0,
) -> list[dict[str, Any]]:
    """Search message content inside one chat session."""
    return _search_rows(
        conn,
        user_id=user_id,
        query=query,
        session_id=session_id,
        limit=limit,
        offset=offset,
    )


def search_all_chats(
    conn: sqlite3.Connection,
    *,
    user_id: int,
    query: str,
    limit: int = 50,
    offset: int = 0,
) -> list[dict[str, Any]]:
    """Search message content across every session for one user."""
    return _search_rows(
        conn,
        user_id=user_id,
        query=query,
        session_id=None,
        limit=limit,
        offset=offset,
    )
