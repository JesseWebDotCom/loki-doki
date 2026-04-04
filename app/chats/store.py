"""SQLite-backed chat session storage."""

from __future__ import annotations

import json
import sqlite3
from typing import Any, Optional
from uuid import uuid4


ACTIVE_CHAT_KEY = "active_chat_id"
LEGACY_CHAT_HISTORY_KEY = "chat_history"
DEFAULT_CHAT_TITLE = "New chat"
_DEFAULT_TITLE_MARKERS = {"", DEFAULT_CHAT_TITLE.lower()}


def initialize_chat_tables(conn: sqlite3.Connection) -> None:
    """Create chat tables and migrate legacy history when needed."""
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS chat_sessions (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            character_id TEXT NOT NULL DEFAULT 'lokidoki',
            project_id TEXT,
            title TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            last_message_at TEXT,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS chat_messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            chat_id TEXT NOT NULL,
            position INTEGER NOT NULL,
            role TEXT NOT NULL,
            content TEXT NOT NULL,
            payload_json TEXT NOT NULL DEFAULT '{}',
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (chat_id) REFERENCES chat_sessions(id) ON DELETE CASCADE,
            UNIQUE(chat_id, position)
        );
        """
    )
    _ensure_chat_sessions_column(conn, "character_id", "TEXT NOT NULL DEFAULT 'lokidoki'")
    _ensure_chat_sessions_column(conn, "project_id", "TEXT")
    conn.executescript(
        """
        CREATE INDEX IF NOT EXISTS idx_chat_sessions_user_char
        ON chat_sessions(user_id, character_id, COALESCE(last_message_at, updated_at) DESC, created_at DESC);

        CREATE INDEX IF NOT EXISTS idx_chat_messages_chat_position
        ON chat_messages(chat_id, position ASC);
        """
    )
    _migrate_legacy_histories(conn)
    _ensure_each_user_has_chat(conn)


def _ensure_chat_sessions_column(conn: sqlite3.Connection, column_name: str, ddl: str) -> None:
    """Add one column to chat_sessions if it is missing."""
    columns = {
        str(row["name"])
        for row in conn.execute("PRAGMA table_info(chat_sessions)").fetchall()
    }
    if column_name in columns:
        return
    conn.execute(f"ALTER TABLE chat_sessions ADD COLUMN {column_name} {ddl}")


def list_chat_summaries(conn: sqlite3.Connection, user_id: str) -> list[dict[str, Any]]:
    """Return saved chats for one user ordered newest-first."""
    rows = conn.execute(
        """
        SELECT
            chat_sessions.id,
            chat_sessions.title,
            chat_sessions.project_id,
            chat_sessions.created_at,
            chat_sessions.updated_at,
            chat_sessions.last_message_at,
            COUNT(chat_messages.id) AS message_count
        FROM chat_sessions
        LEFT JOIN chat_messages ON chat_messages.chat_id = chat_sessions.id
        WHERE chat_sessions.user_id = ?
        GROUP BY chat_sessions.id
        ORDER BY COALESCE(chat_sessions.last_message_at, chat_sessions.updated_at, chat_sessions.created_at) DESC,
                 chat_sessions.rowid DESC
        """,
        (user_id,),
    ).fetchall()
    return [dict(row) for row in rows]


def ensure_active_chat(conn: sqlite3.Connection, user_id: str) -> dict[str, Any]:
    """Return the active chat for one user, creating a blank chat if needed."""
    active_chat_id = _active_chat_id(conn, user_id)
    if active_chat_id:
        active_chat = get_chat_summary(conn, user_id, active_chat_id)
        if active_chat is not None:
            return active_chat
    chats = list_chat_summaries(conn, user_id)
    if chats:
        _set_active_chat_id(conn, user_id, str(chats[0]["id"]))
        conn.commit()
        return chats[0]
    created = _create_chat(conn, user_id, DEFAULT_CHAT_TITLE)
    _set_active_chat_id(conn, user_id, created["id"])
    conn.commit()
    return created


def resolve_chat(conn: sqlite3.Connection, user_id: str, requested_chat_id: Optional[str]) -> dict[str, Any]:
    """Return the requested chat or the active chat when none was specified."""
    if requested_chat_id:
        chat = get_chat_summary(conn, user_id, requested_chat_id)
        if chat is None:
            raise ValueError("Chat not found.")
        _set_active_chat_id(conn, user_id, requested_chat_id)
        conn.commit()
        return chat
    return ensure_active_chat(conn, user_id)


def get_chat_summary(conn: sqlite3.Connection, user_id: str, chat_id: str) -> Optional[dict[str, Any]]:
    """Return one chat summary for a user-owned chat."""
    rows = conn.execute(
        """
        SELECT
            chat_sessions.id,
            chat_sessions.title,
            chat_sessions.project_id,
            chat_sessions.created_at,
            chat_sessions.updated_at,
            chat_sessions.last_message_at,
            COUNT(chat_messages.id) AS message_count
        FROM chat_sessions
        LEFT JOIN chat_messages ON chat_messages.chat_id = chat_sessions.id
        WHERE chat_sessions.user_id = ? AND chat_sessions.id = ?
        GROUP BY chat_sessions.id
        """,
        (user_id, chat_id),
    ).fetchall()
    return None if not rows else dict(rows[0])


def create_chat(conn: sqlite3.Connection, user_id: str, title: str = DEFAULT_CHAT_TITLE, character_id: str = "lokidoki", project_id: Optional[str] = None) -> dict[str, Any]:
    """Create one blank chat and make it active."""
    created = _create_chat(conn, user_id, title, character_id, project_id)
    _set_active_chat_id(conn, user_id, created["id"])
    conn.commit()
    return created


def rename_chat(conn: sqlite3.Connection, user_id: str, chat_id: str, title: str) -> dict[str, Any]:
    """Rename one user-owned chat."""
    cleaned_title = _normalize_title(title)
    cursor = conn.execute(
        """
        UPDATE chat_sessions
        SET title = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND user_id = ?
        """,
        (cleaned_title, chat_id, user_id),
    )
    if cursor.rowcount == 0:
        raise ValueError("Chat not found.")
    conn.commit()
    chat = get_chat_summary(conn, user_id, chat_id)
    if chat is None:
        raise ValueError("Chat not found.")
    return chat


def delete_chat(conn: sqlite3.Connection, user_id: str, chat_id: str) -> dict[str, Any]:
    """Delete one chat and return the next active chat state."""
    existing = get_chat_summary(conn, user_id, chat_id)
    if existing is None:
        raise ValueError("Chat not found.")
    conn.execute("DELETE FROM mem_session_context WHERE session_id = ?", (chat_id,))
    conn.execute("DELETE FROM chat_sessions WHERE id = ? AND user_id = ?", (chat_id, user_id))
    chats = list_chat_summaries(conn, user_id)
    active_chat_id = _active_chat_id(conn, user_id)
    if not chats:
        created = _create_chat(conn, user_id, DEFAULT_CHAT_TITLE)
        chats = [created]
        active_chat_id = created["id"]
    elif active_chat_id == chat_id or not active_chat_id:
        active_chat_id = str(chats[0]["id"])
    _set_active_chat_id(conn, user_id, active_chat_id)
    conn.commit()
    return {
        "active_chat_id": active_chat_id,
        "chats": list_chat_summaries(conn, user_id),
        "history": load_chat_history(conn, user_id, active_chat_id),
    }


def load_chat_history(conn: sqlite3.Connection, user_id: str, chat_id: str) -> list[dict[str, Any]]:
    """Return saved messages for one user-owned chat."""
    if get_chat_summary(conn, user_id, chat_id) is None:
        raise ValueError("Chat not found.")
    rows = conn.execute(
        """
        SELECT role, content, payload_json
        FROM chat_messages
        WHERE chat_id = ?
        ORDER BY position ASC, id ASC
        """,
        (chat_id,),
    ).fetchall()
    history: list[dict[str, Any]] = []
    for row in rows:
        try:
            payload = json.loads(row["payload_json"])
        except json.JSONDecodeError:
            payload = {"role": row["role"], "content": row["content"]}
        if not isinstance(payload, dict):
            payload = {"role": row["role"], "content": row["content"]}
        payload["role"] = str(payload.get("role") or row["role"])
        payload["content"] = str(payload.get("content") or row["content"])
        history.append(payload)
    return history


def save_chat_history(
    conn: sqlite3.Connection,
    user_id: str,
    chat_id: str,
    messages: list[dict[str, Any]],
) -> None:
    """Persist the full message history for one chat."""
    chat = get_chat_summary(conn, user_id, chat_id)
    if chat is None:
        raise ValueError("Chat not found.")
    conn.execute("DELETE FROM chat_messages WHERE chat_id = ?", (chat_id,))
    payloads: list[tuple[str, int, str, str, str]] = []
    for index, message in enumerate(messages):
        role = str(message.get("role") or "").strip()
        content = str(message.get("content") or "")
        if role not in {"user", "assistant", "system"}:
            continue
        payloads.append((chat_id, index, role, content, json.dumps(message)))
    if payloads:
        conn.executemany(
            """
            INSERT INTO chat_messages (chat_id, position, role, content, payload_json)
            VALUES (?, ?, ?, ?, ?)
            """,
            payloads,
        )
        conn.execute(
            """
            UPDATE chat_sessions
            SET updated_at = CURRENT_TIMESTAMP, last_message_at = CURRENT_TIMESTAMP
            WHERE id = ? AND user_id = ?
            """,
            (chat_id, user_id),
        )
    else:
        conn.execute(
            """
            UPDATE chat_sessions
            SET updated_at = CURRENT_TIMESTAMP, last_message_at = NULL
            WHERE id = ? AND user_id = ?
            """,
            (chat_id, user_id),
        )
    _sync_session_context(conn, chat_id, messages)
    _autotitle_if_needed(conn, user_id, chat_id, messages)
    _set_active_chat_id(conn, user_id, chat_id)
    conn.commit()


def append_chat_message(
    conn: sqlite3.Connection,
    user_id: str,
    chat_id: str,
    message: dict[str, Any],
) -> None:
    """Append one chat message and refresh session memory."""
    history = load_chat_history(conn, user_id, chat_id)
    history.append(message)
    save_chat_history(conn, user_id, chat_id, history)


def replace_chat_message(
    conn: sqlite3.Connection,
    user_id: str,
    chat_id: str,
    message_index: int,
    message: dict[str, Any],
) -> None:
    """Replace one chat message by index and refresh session memory."""
    history = load_chat_history(conn, user_id, chat_id)
    if message_index < 0 or message_index >= len(history):
        raise ValueError("Chat message not found.")
    history[message_index] = message
    save_chat_history(conn, user_id, chat_id, history)


def _ensure_each_user_has_chat(conn: sqlite3.Connection) -> None:
    """Create one blank chat for any user without chats."""
    rows = conn.execute("SELECT id FROM users").fetchall()
    for row in rows:
        user_id = str(row["id"])
        chat_count = conn.execute(
            "SELECT COUNT(*) AS count FROM chat_sessions WHERE user_id = ?",
            (user_id,),
        ).fetchone()
        if int(chat_count["count"]) > 0:
            if not _active_chat_id(conn, user_id):
                first_chat = list_chat_summaries(conn, user_id)[0]
                _set_active_chat_id(conn, user_id, str(first_chat["id"]))
            continue
        created = _create_chat(conn, user_id, DEFAULT_CHAT_TITLE)
        _set_active_chat_id(conn, user_id, created["id"])


def _migrate_legacy_histories(conn: sqlite3.Connection) -> None:
    """Move legacy single-chat history blobs into chat tables."""
    rows = conn.execute(
        "SELECT id FROM users ORDER BY created_at ASC, rowid ASC"
    ).fetchall()
    for row in rows:
        user_id = str(row["id"])
        chat_count = conn.execute(
            "SELECT COUNT(*) AS count FROM chat_sessions WHERE user_id = ?",
            (user_id,),
        ).fetchone()
        if int(chat_count["count"]) > 0:
            continue
        legacy_row = conn.execute(
            "SELECT value_json FROM user_settings WHERE user_id = ? AND key = ?",
            (user_id, LEGACY_CHAT_HISTORY_KEY),
        ).fetchone()
        if not legacy_row:
            continue
        try:
            history = json.loads(legacy_row["value_json"])
        except json.JSONDecodeError:
            history = []
        if not isinstance(history, list) or not history:
            continue
        created = _create_chat(conn, user_id, _legacy_chat_title(history))
        save_chat_history(conn, user_id, created["id"], history)


def _create_chat(conn: sqlite3.Connection, user_id: str, title: str, character_id: str = "lokidoki", project_id: Optional[str] = None) -> dict[str, Any]:
    """Insert one chat row without committing."""
    chat_id = str(uuid4())
    cleaned_title = _normalize_title(title)
    conn.execute(
        """
        INSERT INTO chat_sessions (id, user_id, character_id, project_id, title)
        VALUES (?, ?, ?, ?, ?)
        """,
        (chat_id, user_id, character_id, project_id, cleaned_title),
    )
    chat = get_chat_summary(conn, user_id, chat_id)
    if chat is None:
        raise ValueError("Chat could not be created.")
    return chat


def _autotitle_if_needed(
    conn: sqlite3.Connection,
    user_id: str,
    chat_id: str,
    messages: list[dict[str, Any]],
) -> None:
    """Replace the default title with the first user message when available."""
    chat = get_chat_summary(conn, user_id, chat_id)
    if chat is None:
        return
    current_title = str(chat.get("title") or "").strip().lower()
    if current_title not in _DEFAULT_TITLE_MARKERS:
        return
    first_user_message = next(
        (
            str(message.get("content") or "").strip()
            for message in messages
            if str(message.get("role") or "") == "user" and str(message.get("content") or "").strip()
        ),
        "",
    )
    if not first_user_message:
        return
    conn.execute(
        """
        UPDATE chat_sessions
        SET title = ?
        WHERE id = ? AND user_id = ?
        """,
        (_title_from_message(first_user_message), chat_id, user_id),
    )


def _legacy_chat_title(history: list[dict[str, Any]]) -> str:
    """Build a reasonable chat title from migrated history."""
    first_user_message = next(
        (
            str(message.get("content") or "").strip()
            for message in history
            if isinstance(message, dict) and str(message.get("role") or "") == "user" and str(message.get("content") or "").strip()
        ),
        "",
    )
    return _title_from_message(first_user_message) if first_user_message else "Previous chat"


def _title_from_message(message: str) -> str:
    """Generate a compact title from user text."""
    cleaned = " ".join(message.split()).strip()
    if not cleaned:
        return DEFAULT_CHAT_TITLE
    return cleaned[:57].rstrip() + "..." if len(cleaned) > 60 else cleaned


def _normalize_title(title: str) -> str:
    """Normalize one user-supplied chat title."""
    cleaned = " ".join(str(title).split()).strip()
    return cleaned[:80] if cleaned else DEFAULT_CHAT_TITLE


def _sync_session_context(
    conn: sqlite3.Connection,
    chat_id: str,
    messages: list[dict[str, Any]],
) -> None:
    """Mirror compact session state into session-scoped memory rows."""
    conn.execute("DELETE FROM mem_session_context WHERE session_id = ?", (chat_id,))
    for key, value in _session_memory_entries(messages):
        conn.execute(
            """
            INSERT INTO mem_session_context (session_id, key, value, updated_at)
            VALUES (?, ?, ?, STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now'))
            """,
            (chat_id, key, value),
        )


def _session_memory_entries(messages: list[dict[str, Any]]) -> list[tuple[str, str]]:
    """Build compact session-memory rows from recent chat history."""
    normalized = _normalized_session_messages(messages)[-6:]
    if not normalized:
        return []
    entries: list[tuple[str, str]] = []
    summary = _session_summary(normalized)
    if summary:
        entries.append(("summary:session", summary[:500]))
    latest_user = _latest_message_by_role(normalized, "user")
    if latest_user:
        entries.append(("summary:latest_user", latest_user[:240]))
    for index, message in enumerate(normalized):
        entries.append((f"recent:{index:02d}:{message['role']}", message["content"][:280]))
    return entries


def _normalized_session_messages(messages: list[dict[str, Any]]) -> list[dict[str, str]]:
    """Return recent normalized chat turns eligible for session memory."""
    normalized: list[dict[str, str]] = []
    for message in messages:
        role = str(message.get("role") or "").strip()
        content = " ".join(str(message.get("content") or "").split()).strip()
        if role not in {"user", "assistant", "system"} or not content:
            continue
        normalized.append({"role": role, "content": content})
    return normalized


def _session_summary(messages: list[dict[str, str]]) -> str:
    """Summarize the recent session in one compact sentence block."""
    user_messages = [message["content"] for message in messages if message["role"] == "user"]
    assistant_messages = [message["content"] for message in messages if message["role"] == "assistant"]
    parts: list[str] = []
    if user_messages[:-1]:
        earlier = " | ".join(_short_session_text(message, 80) for message in user_messages[-3:-1])
        if earlier:
            parts.append(f"Recent user context: {earlier}")
    if user_messages:
        parts.append(f"Latest user request: {_short_session_text(user_messages[-1], 120)}")
    if assistant_messages:
        parts.append(f"Latest assistant reply: {_short_session_text(assistant_messages[-1], 120)}")
    return " ".join(parts)


def _latest_message_by_role(messages: list[dict[str, str]], role: str) -> str:
    """Return the latest normalized message content for one role."""
    for message in reversed(messages):
        if message["role"] == role:
            return message["content"]
    return ""


def _short_session_text(value: str, limit: int) -> str:
    """Trim one session-memory sentence to a compact preview."""
    cleaned = " ".join(value.split()).strip()
    if len(cleaned) <= limit:
        return cleaned
    return cleaned[: limit - 3].rstrip() + "..."


def _active_chat_id(conn: sqlite3.Connection, user_id: str) -> str:
    """Return the stored active chat id or an empty string."""
    row = conn.execute(
        "SELECT value_json FROM user_settings WHERE user_id = ? AND key = ?",
        (user_id, ACTIVE_CHAT_KEY),
    ).fetchone()
    if not row:
        return ""
    try:
        value = json.loads(row["value_json"])
    except json.JSONDecodeError:
        return ""
    return str(value or "")


def _set_active_chat_id(conn: sqlite3.Connection, user_id: str, chat_id: str) -> None:
    """Persist the active chat id without committing."""
    conn.execute(
        """
        INSERT INTO user_settings (user_id, key, value_json)
        VALUES (?, ?, ?)
        ON CONFLICT(user_id, key) DO UPDATE SET value_json = excluded.value_json
        """,
        (user_id, ACTIVE_CHAT_KEY, json.dumps(chat_id)),
    )
