"""SQLite-backed shared state helpers for local skills."""

from __future__ import annotations

import json
import sqlite3
from typing import Any


def initialize_skill_state_tables(conn: sqlite3.Connection) -> None:
    """Create the generic skill-state table when missing."""
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS skill_state (
            scope TEXT NOT NULL,
            owner_id TEXT NOT NULL,
            state_key TEXT NOT NULL,
            value_json TEXT NOT NULL,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (scope, owner_id, state_key)
        )
        """
    )
    conn.commit()


def get_state(
    conn: sqlite3.Connection,
    *,
    scope: str,
    owner_id: str,
    state_key: str,
    default: Any,
) -> Any:
    """Return one JSON skill-state value."""
    row = conn.execute(
        """
        SELECT value_json
        FROM skill_state
        WHERE scope = ? AND owner_id = ? AND state_key = ?
        """,
        (scope, owner_id, state_key),
    ).fetchone()
    if row is None:
        return default
    return json.loads(row["value_json"])


def set_state(
    conn: sqlite3.Connection,
    *,
    scope: str,
    owner_id: str,
    state_key: str,
    value: Any,
) -> None:
    """Persist one JSON skill-state value."""
    conn.execute(
        """
        INSERT INTO skill_state (scope, owner_id, state_key, value_json, updated_at)
        VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(scope, owner_id, state_key) DO UPDATE SET
            value_json = excluded.value_json,
            updated_at = CURRENT_TIMESTAMP
        """,
        (scope, owner_id, state_key, json.dumps(value)),
    )
    conn.commit()
