"""Scoped memory reads and writes."""

from __future__ import annotations

import json
import sqlite3
from typing import Any


WRITE_THRESHOLD = 0.85
SQL_NOW = "STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now')"


def list_memory(
    conn: sqlite3.Connection,
    scope: str,
    user_id: str,
    *,
    chat_id: str | None = None,
    character_id: str | None = None,
) -> list[dict[str, Any]]:
    """Return memory rows for one explicit scope."""
    normalized = _normalize_scope(scope)
    if normalized == "session":
        return _list_session_memory(conn, _require_chat_id(chat_id))
    if normalized == "person":
        return _list_person_memory(conn, user_id, character_id=character_id)
    return _list_household_memory(conn)


def write_memory(
    conn: sqlite3.Connection,
    scope: str | None = None,
    key: str = "",
    value: str = "",
    user_id: str = "",
    *,
    chat_id: str | None = None,
    character_id: str | None = None,
    source: str = "extracted",
    category: str | None = None,
    confidence: float = 1.0,
) -> bool:
    """Persist one memory row when it passes scope-specific validation."""
    normalized = _normalize_scope(scope or category or "person")
    cleaned_key = key.strip()
    cleaned_value = value.strip()
    if not cleaned_key or not cleaned_value:
        return False
    if normalized != "session" and confidence < WRITE_THRESHOLD:
        return False
    if normalized == "session":
        _write_session_memory(conn, _require_chat_id(chat_id), cleaned_key, cleaned_value)
        return True
    if normalized == "person":
        _write_person_memory(
            conn,
            user_id,
            _require_character_id(character_id),
            cleaned_key,
            cleaned_value,
            confidence,
            source,
        )
        return True
    _write_household_memory(conn, cleaned_key, cleaned_value, user_id, source)
    return True


def delete_memory(
    conn: sqlite3.Connection,
    scope: str,
    key: str,
    user_id: str,
    *,
    chat_id: str | None = None,
    character_id: str | None = None,
) -> None:
    """Delete one scoped memory row."""
    normalized = _normalize_scope(scope)
    cleaned_key = key.strip()
    if normalized == "session":
        conn.execute(
            "DELETE FROM mem_session_context WHERE session_id = ? AND key = ?",
            (_require_chat_id(chat_id), cleaned_key),
        )
        conn.commit()
        return
    if normalized == "person":
        target_character = _require_character_id(character_id)
        conn.execute(
            """
            DELETE FROM mem_char_user_memory
            WHERE user_id = ? AND character_id = ? AND key = ?
            """,
            (user_id, target_character, cleaned_key),
        )
        _enqueue_sync(
            conn,
            table_name="mem_char_user_memory",
            operation="delete",
            payload={
                "scope": "person",
                "user_id": user_id,
                "character_id": target_character,
                "key": cleaned_key,
            },
        )
        conn.commit()
        return
    conn.execute("DELETE FROM mem_household_context WHERE key = ?", (cleaned_key,))
    _enqueue_sync(
        conn,
        table_name="mem_household_context",
        operation="delete",
        payload={"scope": "household", "key": cleaned_key, "user_id": user_id},
    )
    conn.commit()


def list_user_memory(conn: sqlite3.Connection, user_id: str) -> list[dict[str, Any]]:
    """Return all person-scoped memory rows for one user."""
    return _list_person_memory(conn, user_id)


def delete_user_memory(
    conn: sqlite3.Connection,
    user_id: str,
    character_id: str,
    key: str,
) -> None:
    """Delete one person-scoped memory fact."""
    delete_memory(conn, "person", key, user_id, character_id=character_id)


def list_household_memory(conn: sqlite3.Connection) -> list[dict[str, Any]]:
    """Return all shared household memory rows."""
    return _list_household_memory(conn)


def delete_household_memory(conn: sqlite3.Connection, key: str, *, user_id: str = "") -> None:
    """Delete one household memory fact."""
    delete_memory(conn, "household", key, user_id or "system")


def clear_session_memory(conn: sqlite3.Connection, chat_id: str) -> None:
    """Remove all session-scoped memory for one chat."""
    conn.execute("DELETE FROM mem_session_context WHERE session_id = ?", (chat_id,))


def _list_session_memory(conn: sqlite3.Connection, chat_id: str) -> list[dict[str, Any]]:
    rows = conn.execute(
        """
        SELECT session_id, key, value, updated_at
        FROM mem_session_context
        WHERE session_id = ?
        ORDER BY
            CASE
                WHEN key = 'summary:session' THEN 0
                WHEN key = 'summary:latest_user' THEN 1
                ELSE 2
            END,
            key ASC
        """,
        (chat_id,),
    ).fetchall()
    return [
        {
            "scope": "session",
            "chat_id": row["session_id"],
            "key": row["key"],
            "value": row["value"],
            "updated_at": row["updated_at"],
        }
        for row in rows
    ]


def _list_person_memory(
    conn: sqlite3.Connection,
    user_id: str,
    *,
    character_id: str | None = None,
) -> list[dict[str, Any]]:
    params: list[str] = [user_id]
    where = "WHERE m.user_id = ?"
    if character_id:
        where += " AND m.character_id = ?"
        params.append(character_id)
    rows = conn.execute(
        f"""
        SELECT
            m.character_id,
            COALESCE(cc.name, mc.name, m.character_id) AS character_name,
            m.key,
            m.value,
            m.confidence,
            m.source,
            m.updated_at
        FROM mem_char_user_memory m
        LEFT JOIN character_catalog cc ON cc.character_id = m.character_id
        LEFT JOIN mem_characters mc ON mc.id = m.character_id
        {where}
        ORDER BY m.updated_at DESC, m.character_id ASC, m.key ASC
        """,
        tuple(params),
    ).fetchall()
    return [dict(row) | {"scope": "person"} for row in rows]


def _list_household_memory(conn: sqlite3.Connection) -> list[dict[str, Any]]:
    rows = conn.execute(
        """
        SELECT key, value, updated_at, node_id
        FROM mem_household_context
        ORDER BY updated_at DESC, key ASC
        """
    ).fetchall()
    return [dict(row) | {"scope": "household"} for row in rows]


def _write_session_memory(conn: sqlite3.Connection, chat_id: str, key: str, value: str) -> None:
    conn.execute(
        f"""
        INSERT INTO mem_session_context (session_id, key, value, updated_at)
        VALUES (?, ?, ?, {SQL_NOW})
        ON CONFLICT(session_id, key) DO UPDATE SET
            value = excluded.value,
            updated_at = {SQL_NOW}
        """,
        (chat_id, key, value),
    )
    conn.commit()


def _write_person_memory(
    conn: sqlite3.Connection,
    user_id: str,
    character_id: str,
    key: str,
    value: str,
    confidence: float,
    source: str,
) -> None:
    conn.execute(
        f"""
        INSERT INTO mem_char_user_memory (
            character_id, user_id, key, value, confidence, source, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, {SQL_NOW})
        ON CONFLICT(character_id, user_id, key) DO UPDATE SET
            value = excluded.value,
            confidence = MAX(mem_char_user_memory.confidence, excluded.confidence),
            source = excluded.source,
            updated_at = {SQL_NOW}
        """,
        (character_id, user_id, key, value, confidence, source),
    )
    _enqueue_sync(
        conn,
        table_name="mem_char_user_memory",
        operation="upsert",
        payload={
            "scope": "person",
            "user_id": user_id,
            "character_id": character_id,
            "key": key,
            "value": value,
            "confidence": confidence,
            "source": source,
        },
    )
    conn.commit()


def _write_household_memory(
    conn: sqlite3.Connection,
    key: str,
    value: str,
    user_id: str,
    source: str,
) -> None:
    conn.execute(
        f"""
        INSERT INTO mem_household_context (key, value, node_id, updated_at)
        VALUES (?, ?, 'master', {SQL_NOW})
        ON CONFLICT(key) DO UPDATE SET
            value = excluded.value,
            updated_at = {SQL_NOW}
        """,
        (key, value),
    )
    _enqueue_sync(
        conn,
        table_name="mem_household_context",
        operation="upsert",
        payload={
            "scope": "household",
            "user_id": user_id,
            "key": key,
            "value": value,
            "source": source,
        },
    )
    conn.commit()


def _enqueue_sync(
    conn: sqlite3.Connection,
    *,
    table_name: str,
    operation: str,
    payload: dict[str, Any],
) -> None:
    conn.execute(
        f"""
        INSERT INTO memory_sync_queue (table_name, operation, payload_json, timestamp)
        VALUES (?, ?, ?, {SQL_NOW})
        """,
        (table_name, operation, json.dumps(payload, sort_keys=True)),
    )


def _normalize_scope(scope: str) -> str:
    normalized = scope.strip().lower()
    if normalized in {"user", "person"}:
        return "person"
    if normalized not in {"session", "person", "household"}:
        raise ValueError("Unsupported memory scope.")
    return normalized


def _require_chat_id(chat_id: str | None) -> str:
    cleaned = str(chat_id or "").strip()
    if not cleaned:
        raise ValueError("chat_id is required for session memory.")
    return cleaned


def _require_character_id(character_id: str | None) -> str:
    cleaned = str(character_id or "").strip()
    if not cleaned:
        raise ValueError("character_id is required for person memory.")
    return cleaned
