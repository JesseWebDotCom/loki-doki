"""Care Profile management for child and senior safety."""

from __future__ import annotations

import json
import sqlite3
from typing import Any


def care_profile_row(row: dict[str, Any] | sqlite3.Row) -> dict[str, Any]:
    """Return one care profile from a database row."""
    data = dict(row)
    return {
        "id": str(data["id"]),
        "label": str(data["label"]),
        "tone": str(data["tone"]),
        "vocabulary": str(data["vocabulary"]),
        "sentence_length": str(data["sentence_length"]),
        "response_style": str(data.get("response_style") or "balanced"),
        "blocked_topics": json.loads(str(data["blocked_topics_json"] or "[]")),
        "safe_messaging": bool(data["safe_messaging"]),
        "max_response_tokens": int(data["max_response_tokens"]),
        "builtin": bool(data["builtin"]),
    }


def list_care_profiles(conn: sqlite3.Connection) -> list[dict[str, Any]]:
    """Return care profiles for admin and user settings views."""
    rows = conn.execute(
        """
        SELECT id, label, tone, vocabulary, sentence_length, response_style, blocked_topics_json,
               safe_messaging, max_response_tokens, builtin
        FROM care_profiles
        ORDER BY builtin DESC, label COLLATE NOCASE ASC
        """
    ).fetchall()
    return [care_profile_row(row) for row in rows]


def get_care_profile_by_id(conn: sqlite3.Connection, profile_id: str) -> dict[str, Any]:
    """Return one care profile from its persistent ID."""
    row = conn.execute(
        """
        SELECT id, label, tone, vocabulary, sentence_length, response_style, blocked_topics_json,
               safe_messaging, max_response_tokens, builtin
        FROM care_profiles WHERE id = ?
        """,
        (profile_id,),
    ).fetchone()
    if row is None:
        raise ValueError(f"Care profile {profile_id!r} not found.")
    return care_profile_row(row)


def upsert_care_profile(conn: sqlite3.Connection, values: dict[str, Any]) -> dict[str, Any]:
    """Create or update one care profile."""
    profile_id = str(values.get("id") or "").strip()
    if not profile_id:
        raise ValueError("Care profile id is required.")
    blocked_topics = values.get("blocked_topics", [])
    conn.execute(
        """
        INSERT INTO care_profiles (
            id, label, tone, vocabulary, sentence_length, response_style, blocked_topics_json,
            safe_messaging, max_response_tokens, builtin, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(id) DO UPDATE SET
            label = excluded.label,
            tone = excluded.tone,
            vocabulary = excluded.vocabulary,
            sentence_length = excluded.sentence_length,
            response_style = excluded.response_style,
            blocked_topics_json = excluded.blocked_topics_json,
            safe_messaging = excluded.safe_messaging,
            max_response_tokens = excluded.max_response_tokens,
            updated_at = CURRENT_TIMESTAMP
        """,
        (
            profile_id,
            str(values.get("label") or profile_id).strip(),
            str(values.get("tone") or "").strip(),
            str(values.get("vocabulary") or "standard").strip(),
            str(values.get("sentence_length") or "medium").strip(),
            str(values.get("response_style") or "balanced").strip(),
            json.dumps(list(blocked_topics)),
            int(bool(values.get("safe_messaging", True))),
            int(values.get("max_response_tokens", 160)),
            int(bool(values.get("builtin", False))),
        ),
    )
    conn.commit()
    return get_care_profile_by_id(conn, profile_id)
