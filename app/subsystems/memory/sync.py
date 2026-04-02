"""Replication helpers for the memory subsystem."""

from __future__ import annotations

import sqlite3
from typing import Any


def sync_delta(conn: sqlite3.Connection, _node_id: str, watermark: str) -> dict[str, Any]:
    """Return replicated memory rows updated after one watermark."""
    household = conn.execute(
        """
        SELECT key, value, node_id, updated_at
        FROM mem_household_context
        WHERE updated_at > ?
        ORDER BY updated_at ASC, key ASC
        """,
        (watermark,),
    ).fetchall()
    person = conn.execute(
        """
        SELECT character_id, user_id, key, value, confidence, source, node_id, updated_at
        FROM mem_char_user_memory
        WHERE updated_at > ?
        ORDER BY updated_at ASC, character_id ASC, key ASC
        """,
        (watermark,),
    ).fetchall()
    evolution = conn.execute(
        """
        SELECT character_id, user_id, state_json, updated_at
        FROM mem_char_evolution_state
        WHERE updated_at > ?
        ORDER BY updated_at ASC, character_id ASC
        """,
        (watermark,),
    ).fetchall()
    return {
        "watermark": get_latest_watermark(conn),
        "household_context": [dict(row) for row in household],
        "person_memories": [dict(row) for row in person],
        "evolution_state": [dict(row) for row in evolution],
    }


def get_latest_watermark(conn: sqlite3.Connection) -> str:
    """Return the latest replication watermark across memory tables."""
    row = conn.execute(
        """
        SELECT MAX(value) AS watermark
        FROM (
            SELECT COALESCE(MAX(updated_at), '') AS value FROM mem_household_context
            UNION ALL
            SELECT COALESCE(MAX(updated_at), '') AS value FROM mem_char_user_memory
            UNION ALL
            SELECT COALESCE(MAX(updated_at), '') AS value FROM mem_char_evolution_state
            UNION ALL
            SELECT COALESCE(MAX(timestamp), '') AS value FROM memory_sync_queue
        )
        """
    ).fetchone()
    return "" if row is None else str(row["watermark"] or "")
