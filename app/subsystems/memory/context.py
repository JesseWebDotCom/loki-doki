"""Prompt-context assembly helpers for the memory subsystem."""

from __future__ import annotations

import sqlite3


from app.subsystems.memory.ambient import get_ambient_context


L1_MAX_WORDS = 800
SESSION_MAX_WORDS = 240


def get_l1_context(
    conn: sqlite3.Connection,
    user_id: str,
    character_id: str | None = None,
    location: Optional[str] = None,
) -> str:
    """Return bounded long-term memory context for prompt injection."""
    sections: list[tuple[str, list[str]]] = []
    
    # 0. Ambient Context (Time, Date, Weather, History)
    ambient = get_ambient_context(conn, user_id, character_id, location=location)
    
    # 1. Household/Memory Facts
    household_lines = _household_lines(conn)
    if household_lines:
        sections.append(("Household Facts", household_lines))
    if character_id:
        person_lines = _person_lines(conn, user_id, character_id)
        if person_lines:
            sections.append(("Person Facts", person_lines))
        evolution_lines = _evolution_lines(conn, user_id, character_id)
        if evolution_lines:
            sections.append(("Relationship State", evolution_lines))
            
    # 2. Reflection Insights (L5)
    reflection_lines = _reflection_lines(conn, user_id, character_id)
    if reflection_lines:
        sections.append(("Insights", reflection_lines))

    # Render long-term block
    l1_block = _render_block("memory_context", sections, L1_MAX_WORDS)
    
    # Prepend ambient block
    return (ambient + "\n\n" + l1_block).strip()


def get_session_context(conn: sqlite3.Connection, chat_id: str) -> str:
    """Return bounded session-only memory for one active chat."""
    rows = conn.execute(
        """
        SELECT key, value
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
    lines = [_format_session_line(str(row["key"]), str(row["value"])) for row in rows]
    return _render_block("session_context", [("Current Session", lines)], SESSION_MAX_WORDS)


def _household_lines(conn: sqlite3.Connection) -> list[str]:
    rows = conn.execute(
        """
        SELECT key, value
        FROM mem_household_context
        ORDER BY updated_at DESC, key ASC
        """
    ).fetchall()
    return [f"{row['key']}: {row['value']}" for row in rows]


def _person_lines(
    conn: sqlite3.Connection,
    user_id: str,
    character_id: str,
) -> list[str]:
    rows = conn.execute(
        """
        SELECT key, value
        FROM mem_char_user_memory
        WHERE user_id = ? AND character_id = ?
        ORDER BY confidence DESC, updated_at DESC, key ASC
        """,
        (user_id, character_id),
    ).fetchall()
    return [f"{row['key']}: {row['value']}" for row in rows]


def _evolution_lines(
    conn: sqlite3.Connection,
    user_id: str,
    character_id: str,
) -> list[str]:
    row = conn.execute(
        """
        SELECT state_json
        FROM mem_char_evolution_state
        WHERE user_id = ? AND character_id = ?
        """,
        (user_id, character_id),
    ).fetchone()
    if row is None:
        return []
    state = str(row["state_json"] or "").strip()
    return [state] if state and state != "{}" else []


def _render_block(
    block_name: str,
    sections: list[tuple[str, list[str]]],
    max_words: int,
) -> str:
    if not sections:
        return ""
    lines = [f"<{block_name}>"]
    used_words = 0
    for heading, values in sections:
        heading_words = _word_count(heading)
        if used_words + heading_words > max_words:
            break
        lines.append(f"{heading}:")
        used_words += heading_words
        for value in values:
            entry = f" - {value}"
            entry_words = _word_count(entry)
            if used_words + entry_words > max_words:
                break
            lines.append(entry)
            used_words += entry_words
    lines.append(f"</{block_name}>")
    return "\n".join(lines) if len(lines) > 2 else ""


def _reflection_lines(
    conn: sqlite3.Connection,
    user_id: str,
    character_id: str | None,
) -> list[str]:
    """Fetch high-level character insights for this user."""
    if not character_id:
        return []
    rows = conn.execute(
        """
        SELECT insight FROM mem_reflection_cache
        WHERE user_id = ? AND character_id = ?
        ORDER BY importance_score DESC, created_at DESC
        LIMIT 5
        """,
        (user_id, character_id)
    ).fetchall()
    return [str(row["insight"]) for row in rows]


def _word_count(value: str) -> int:
    return len(value.split())


def _format_session_line(key: str, value: str) -> str:
    if key == "summary:session":
        return f"Session Summary: {value}"
    if key == "summary:latest_user":
        return f"Latest User Goal: {value}"
    if key.startswith("recent:") and key.count(":") >= 2:
        role = key.rsplit(":", 1)[-1]
        return f"Recent {role.title()} Turn: {value}"
    return f"{key}: {value}"
