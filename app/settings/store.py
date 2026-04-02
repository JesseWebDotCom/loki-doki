"""Settings access helpers."""

from __future__ import annotations

import sqlite3
from typing import Any

from app.chats import store as chat_store
from app import db


CHAT_HISTORY_KEY = "chat_history"
VOICE_PREFERENCES_KEY = "voice_preferences"
WAKEWORD_PREFERENCES_KEY = "wakeword_preferences"
DEFAULT_VOICE_PREFERENCES = {
    "reply_enabled": True,
    "voice_source": "browser",
    "browser_voice_uri": "",
    "piper_voice_id": "en_US-lessac-medium",
    "barge_in_enabled": False,
}
DEFAULT_WAKEWORD_PREFERENCES = {
    "enabled": False,
    "model_id": "loki_doki",
    "threshold": 0.35,
}


def load_chat_history(conn: sqlite3.Connection, user_id: str) -> list[dict[str, Any]]:
    """Return the active chat history for a user."""
    active_chat = chat_store.ensure_active_chat(conn, user_id)
    return chat_store.load_chat_history(conn, user_id, str(active_chat["id"]))


def save_chat_history(
    conn: sqlite3.Connection,
    user_id: str,
    messages: list[dict[str, Any]],
) -> None:
    """Persist the active chat history for a user."""
    active_chat = chat_store.ensure_active_chat(conn, user_id)
    chat_store.save_chat_history(conn, user_id, str(active_chat["id"]), messages)


def load_voice_preferences(conn: sqlite3.Connection, user_id: str) -> dict[str, Any]:
    """Return saved voice preferences for a user."""
    stored = db.get_user_setting(conn, user_id, VOICE_PREFERENCES_KEY, DEFAULT_VOICE_PREFERENCES)
    normalized = {
        **DEFAULT_VOICE_PREFERENCES,
        **stored,
    }
    if normalized["piper_voice_id"] == "en_US-cori-medium":
        normalized["piper_voice_id"] = "en_US-lessac-medium"
    return normalized


def save_voice_preferences(conn: sqlite3.Connection, user_id: str, preferences: dict[str, Any]) -> None:
    """Persist voice preferences for a user."""
    db.set_user_setting(
        conn,
        user_id,
        VOICE_PREFERENCES_KEY,
        load_voice_preferences(
            conn,
            user_id,
        )
        | {
            **DEFAULT_VOICE_PREFERENCES,
            **preferences,
        },
    )


def load_wakeword_preferences(conn: sqlite3.Connection, user_id: str) -> dict[str, Any]:
    """Return saved wakeword preferences for a user."""
    stored = db.get_user_setting(conn, user_id, WAKEWORD_PREFERENCES_KEY, DEFAULT_WAKEWORD_PREFERENCES)
    normalized = {
        **DEFAULT_WAKEWORD_PREFERENCES,
        **stored,
    }
    normalized["enabled"] = bool(normalized["enabled"])
    normalized["model_id"] = str(normalized["model_id"] or "loki_doki")
    try:
        normalized["threshold"] = float(normalized["threshold"])
    except (TypeError, ValueError):
        normalized["threshold"] = DEFAULT_WAKEWORD_PREFERENCES["threshold"]
    return normalized


def save_wakeword_preferences(conn: sqlite3.Connection, user_id: str, preferences: dict[str, Any]) -> None:
    """Persist wakeword preferences for a user."""
    db.set_user_setting(
        conn,
        user_id,
        WAKEWORD_PREFERENCES_KEY,
        load_wakeword_preferences(conn, user_id)
        | {
            **DEFAULT_WAKEWORD_PREFERENCES,
            **preferences,
        },
    )
