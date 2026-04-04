"""Account-level prompt policy and memory cache management."""

from __future__ import annotations

import json
import sqlite3
from typing import Any, Optional

from app.subsystems.character.models import DEFAULT_CORE_SAFETY_PROMPT


def get_account(conn: sqlite3.Connection, account_id: str) -> dict[str, Any]:
    """Return one account with its prompt policy."""
    row = conn.execute(
        """
        SELECT a.id, a.name, a.default_character_id, a.character_feature_enabled,
               p.core_safety_prompt, p.device_policy_prompt, p.scrub_flags_json, p.proactive_chatter_enabled
        FROM accounts a
        LEFT JOIN account_prompt_policy p ON p.account_id = a.id
        WHERE a.id = ?
        """,
        (account_id,),
    ).fetchone()
    if row is None:
        raise ValueError("Account not found.")
    return {
        "id": str(row["id"]),
        "name": str(row["name"]),
        "default_character_id": str(row["default_character_id"] or "lokidoki"),
        "character_feature_enabled": bool(row["character_feature_enabled"]),
        "core_safety_prompt": str(row["core_safety_prompt"] or ""),
        "device_policy_prompt": str(row["device_policy_prompt"] or ""),
        "scrub_flags": json.loads(str(row["scrub_flags_json"] or "{}")),
        "proactive_chatter_enabled": bool(row["proactive_chatter_enabled"]),
    }


def get_prompt_policy(conn: sqlite3.Connection, account_id: str) -> dict[str, Any]:
    """Return the account-level prompt policy."""
    account = get_account(conn, account_id)
    return {
        "account_id": account["id"],
        "core_safety_prompt": account["core_safety_prompt"],
        "device_policy_prompt": account["device_policy_prompt"],
        "scrub_flags": account["scrub_flags"],
        "proactive_chatter_enabled": account["proactive_chatter_enabled"],
    }


def update_prompt_policy(conn: sqlite3.Connection, account_id: str, values: dict[str, Any]) -> dict[str, Any]:
    """Persist the account-level prompt policy."""
    current = get_prompt_policy(conn, account_id)
    conn.execute(
        """
    INSERT INTO account_prompt_policy (account_id, core_safety_prompt, device_policy_prompt, scrub_flags_json, proactive_chatter_enabled, updated_at)
    VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(account_id) DO UPDATE SET
        core_safety_prompt = excluded.core_safety_prompt,
        device_policy_prompt = excluded.device_policy_prompt,
        scrub_flags_json = excluded.scrub_flags_json,
        proactive_chatter_enabled = excluded.proactive_chatter_enabled,
        updated_at = CURRENT_TIMESTAMP
        """,
        (
            account_id,
            str(values.get("core_safety_prompt", current["core_safety_prompt"])).strip(),
            str(values.get("device_policy_prompt", current["device_policy_prompt"])).strip(),
            json.dumps(extract_scrub_flags(str(values.get("device_policy_prompt", current["device_policy_prompt"])))),
            int(bool(values.get("proactive_chatter_enabled", current["proactive_chatter_enabled"]))),
        ),
    )
    conn.commit()
    return get_prompt_policy(conn, account_id)


def extract_scrub_flags(text: str) -> dict[str, Any]:
    """Extract structured scrub flags from device policy prose."""
    flags = {}
    lower_text = text.lower()

    # No profanity detections
    if any(phrase in lower_text for phrase in ["no profanity", "never use profanity", "no swearing", "don't swear", "blocking profanity"]):
        flags["no_profanity"] = True

    # No violence detections
    if any(phrase in lower_text for phrase in ["no violence", "never discuss violence", "non-violent", "block violence"]):
        flags["no_violence"] = True

    # No adult content detections
    if any(phrase in lower_text for phrase in ["no adult content", "no nsfw", "child-safe", "only family-friendly"]):
        flags["no_adult_content"] = True

    return flags
