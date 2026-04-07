"""Idempotent builtin-character seeding + first-boot personality migration.

Runs once on app startup. Two responsibilities:

1. Ensure the catalog has at least one ``builtin`` character so the
   per-user active-character fallback (``get_active_character_id``)
   always resolves to *something*. Without this, a fresh DB has no
   character at all and the orchestrator's behavior_prompt injection
   silently no-ops.

2. Preserve the user's existing Tier-2 personality text from
   ``data/settings.json`` (the legacy ``user_prompt`` field). This
   gets seeded into the default user's override row on the builtin
   character so day-1 users don't lose their tuning when the
   character system replaces the old "Bot Personality" field. We
   only do this once — gated by an `app_secrets` row so re-runs are
   no-ops.
"""
from __future__ import annotations

import json
import os
import sqlite3

from lokidoki.core import character_ops as ops

SETTINGS_FILE = "data/settings.json"
DEFAULT_BUILTIN_NAME = "Loki"
DEFAULT_BUILTIN_PROMPT = (
    "You are LokiDoki, a friendly local assistant. Be concise, warm, "
    "and a little playful. Speak in plain language."
)
MIGRATION_FLAG = "character_personality_migrated_v1"


def seed_builtin_if_missing(conn: sqlite3.Connection) -> int:
    """Ensure at least one builtin character exists. Returns its id."""
    row = conn.execute(
        "SELECT id FROM characters WHERE source = 'builtin' "
        "ORDER BY id ASC LIMIT 1"
    ).fetchone()
    if row is not None:
        return int(row["id"])
    return ops.create_character(
        conn,
        name=DEFAULT_BUILTIN_NAME,
        description="The default LokiDoki personality.",
        behavior_prompt=DEFAULT_BUILTIN_PROMPT,
        avatar_style="bottts",
        avatar_seed="loki-default",
        source="builtin",
    )


def _migration_done(conn: sqlite3.Connection) -> bool:
    row = conn.execute(
        "SELECT value FROM app_secrets WHERE name = ?", (MIGRATION_FLAG,)
    ).fetchone()
    return row is not None


def _mark_migration_done(conn: sqlite3.Connection) -> None:
    conn.execute(
        "INSERT OR REPLACE INTO app_secrets (name, value) VALUES (?, ?)",
        (MIGRATION_FLAG, "1"),
    )
    conn.commit()


def migrate_legacy_user_prompt(conn: sqlite3.Connection) -> None:
    """One-shot: copy legacy ``user_prompt`` into a per-user override.

    Targets user_id=1 (the bootstrap admin / default user). If the
    legacy file is missing, the field is empty, or the migration has
    already run, this is a no-op.
    """
    if _migration_done(conn):
        return
    if not os.path.exists(SETTINGS_FILE):
        _mark_migration_done(conn)
        return
    try:
        with open(SETTINGS_FILE, "r") as f:
            data = json.load(f)
    except (json.JSONDecodeError, OSError):
        _mark_migration_done(conn)
        return
    legacy = (data.get("user_prompt") or "").strip()
    if not legacy:
        _mark_migration_done(conn)
        return
    builtin_id = seed_builtin_if_missing(conn)
    user_row = conn.execute(
        "SELECT id FROM users ORDER BY id ASC LIMIT 1"
    ).fetchone()
    if user_row is None:
        # No users yet — bootstrap hasn't run. Defer; the next startup
        # after bootstrap will retry because we don't set the flag.
        return
    ops.set_user_override(
        conn,
        user_id=int(user_row["id"]),
        character_id=builtin_id,
        behavior_prompt=legacy,
    )
    _mark_migration_done(conn)


def run_seed(conn: sqlite3.Connection) -> None:
    """Top-level entry point. Idempotent — safe to call on every boot."""
    seed_builtin_if_missing(conn)
    migrate_legacy_user_prompt(conn)
