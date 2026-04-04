"""Runtime context builder for skill routing and execution."""

from __future__ import annotations

import sqlite3
from typing import Any

from app import db
from app.skills.accounts import AccountManager


def build_skill_context(
    conn: sqlite3.Connection,
    current_user: dict[str, Any],
    profile: str,
) -> dict[str, Any]:
    """Build one effective execution context for the skill runtime."""
    shared_contexts = db.get_user_setting(conn, current_user["id"], "skill_shared_context", {})
    return {
        "user_id": current_user["id"],
        "username": current_user["username"],
        "display_name": current_user["display_name"],
        "profile": profile,
        "location": [34.0522, -118.2437],  # Default: Los Angeles, CA
        "shared_contexts": dict(shared_contexts),
        "accounts": AccountManager(conn),
    }
