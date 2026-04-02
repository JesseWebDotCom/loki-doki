"""User character settings and prompt overrides management."""

from __future__ import annotations

import json
import sqlite3
from typing import Any

from app.subsystems.character.care import get_care_profile_by_id


def get_user_settings(conn: sqlite3.Connection, user_id: str) -> dict[str, Any]:
    """Return user character settings plus care profile and prompt overrides."""
    row = conn.execute(
        """
        SELECT s.user_id, s.care_profile_id, s.character_enabled,
               s.active_character_id, s.assigned_character_id, s.can_select_character,
               s.user_prompt, s.base_prompt_hash, s.compiled_prompt_hash,
               s.compiled_base_prompt, o.admin_prompt, o.blocked_topics_json,
               cp.label AS care_profile_label
        FROM user_character_settings s
        LEFT JOIN user_prompt_overrides o ON o.user_id = s.user_id
        LEFT JOIN care_profiles cp ON cp.id = s.care_profile_id
        WHERE s.user_id = ?
        """,
        (user_id,),
    ).fetchone()
    if row is None:
        raise ValueError("User character settings were not found.")
    customizations = conn.execute(
        "SELECT character_id, custom_prompt FROM user_character_customizations WHERE user_id = ?",
        (user_id,),
    ).fetchall()
    return {
        "user_id": user_id,
        "care_profile_id": str(row["care_profile_id"] or "standard"),
        "care_profile_label": str(row["care_profile_label"] or "Standard"),
        "character_enabled": bool(row["character_enabled"]),
        "active_character_id": str(row["active_character_id"] or "lokidoki"),
        "assigned_character_id": str(row["assigned_character_id"] or ""),
        "can_select_character": bool(row["can_select_character"]),
        "user_prompt": str(row["user_prompt"] or ""),
        "base_prompt_hash": str(row["base_prompt_hash"] or ""),
        "compiled_prompt_hash": str(row["compiled_prompt_hash"] or ""),
        "compiled_base_prompt": str(row["compiled_base_prompt"] or ""),
        "admin_prompt": str(row["admin_prompt"] or ""),
        "blocked_topics": json.loads(row["blocked_topics_json"] or "[]"),
        "character_customizations": {
            str(item["character_id"]): str(item["custom_prompt"] or "")
            for item in customizations
        },
    }


def update_user_settings(conn: sqlite3.Connection, user_id: str, values: dict[str, Any]) -> dict[str, Any]:
    """Persist user-controlled character settings."""
    current = get_user_settings(conn, user_id)
    next_assigned_character_id = str(values.get("assigned_character_id", current["assigned_character_id"]) or "").strip()
    next_can_select_character = bool(values.get("can_select_character", current["can_select_character"]))
    next_character_id = str(values.get("active_character_id", current["active_character_id"]) or "").strip() or None
    
    if next_assigned_character_id and not next_can_select_character:
        next_character_id = next_assigned_character_id
    elif "assigned_character_id" in values and next_assigned_character_id:
        next_character_id = next_assigned_character_id
        
    conn.execute(
        """
        UPDATE user_character_settings
        SET care_profile_id = ?, character_enabled = ?,
            active_character_id = ?, assigned_character_id = ?, can_select_character = ?,
            user_prompt = ?, base_prompt_hash = '',
            compiled_prompt_hash = '', compiled_base_prompt = ''
        WHERE user_id = ?
        """,
        (
            str(values.get("care_profile_id", current["care_profile_id"])).strip() or current["care_profile_id"],
            int(bool(values.get("character_enabled", current["character_enabled"]))),
            next_character_id,
            next_assigned_character_id or None,
            int(next_can_select_character),
            str(values.get("user_prompt", current["user_prompt"])).strip(),
            user_id,
        ),
    )
    for character_id, custom_prompt in dict(values.get("character_customizations", {})).items():
        conn.execute(
            """
            INSERT INTO user_character_customizations (user_id, character_id, custom_prompt, updated_at)
            VALUES (?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(user_id, character_id) DO UPDATE SET
                custom_prompt = excluded.custom_prompt,
                updated_at = CURRENT_TIMESTAMP
            """,
            (user_id, str(character_id), str(custom_prompt).strip()),
        )
    conn.commit()
    return get_user_settings(conn, user_id)


def update_user_overrides(conn: sqlite3.Connection, user_id: str, values: dict[str, Any]) -> dict[str, Any]:
    """Persist admin-controlled prompt overrides for one user."""
    conn.execute(
        """
        INSERT INTO user_prompt_overrides (user_id, admin_prompt, blocked_topics_json, updated_at)
        VALUES (?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(user_id) DO UPDATE SET
            admin_prompt = excluded.admin_prompt,
            blocked_topics_json = excluded.blocked_topics_json,
            updated_at = CURRENT_TIMESTAMP
        """,
        (
            user_id,
            str(values.get("admin_prompt", "")).strip(),
            json.dumps(list(values.get("blocked_topics", []))),
        ),
    )
    conn.execute(
        """
        UPDATE user_character_settings
        SET compiled_prompt_hash = '', compiled_base_prompt = '', base_prompt_hash = ''
        WHERE user_id = ?
        """,
        (user_id,),
    )
    conn.commit()
    return get_user_settings(conn, user_id)
