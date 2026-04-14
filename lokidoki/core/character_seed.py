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
MIGRATION_FLAG = "character_personality_migrated_v1"

# Three builtin personas, one per DiceBear style we ship. Seeded
# idempotently by ``name`` so reboots refresh the spec without
# duplicating rows or breaking per-user overrides (which FK on id,
# not name). Editing one of these in the admin UI triggers
# copy-on-write into a new ``admin``-source row, so the canonical
# builtin spec stays whatever this list says.
#
# ``avatar_seed`` mirrors the DiceBear playground URL the user
# picked (e.g. https://api.dicebear.com/9.x/bottts/svg?seed=Ryker)
# so the rendered identity matches that exact preview.
BUILTIN_SPECS: tuple[dict, ...] = (
    {
        "name": "Loki",
        "description": "Mischievous helper bot.",
        "behavior_prompt": (
            "You are LokiDoki, a friendly local assistant. Be concise, "
            "warm, and a little playful. Speak in plain language."
        ),
        "avatar_style": "bottts",
        "avatar_seed": "Ryker",
        # ``baseColor`` is the bottts schema's body-tint option;
        # passing a 1-element array forces the seed PRNG to always
        # pick this hue.
        "avatar_config": {"baseColor": ["b6e832"]},
    },
    {
        "name": "Kingston",
        "description": "Cartoon companion with a soft voice.",
        "behavior_prompt": (
            "You are Kingston, a cheerful cartoon companion. Speak "
            "in a warm, encouraging tone. Keep answers short and "
            "use everyday language."
        ),
        "avatar_style": "toon-head",
        "avatar_seed": "Kingston",
        "avatar_config": {},
    },
    {
        "name": "Luis",
        "description": "Friendly human-style assistant.",
        "behavior_prompt": (
            "You are Luis, a thoughtful human-style assistant. Be "
            "approachable and clear. Prefer plain answers over jargon."
        ),
        "avatar_style": "avataaars",
        "avatar_seed": "Luis",
        "avatar_config": {},
    },
)


def seed_builtin_if_missing(conn: sqlite3.Connection) -> int:
    """Insert any BUILTIN_SPECS rows that don't yet exist. Returns the
    first builtin's id (used as the personality-migration anchor).

    **Insert-if-missing only.** Existing builtin rows (matched by
    ``(source='builtin', name)``) are left completely untouched so
    admin edits to a builtin survive reboots. New builtins added to
    BUILTIN_SPECS in code still get created on the next boot.

    To re-apply a spec on demand (escape hatch for "I broke Loki,
    give me the original back"), the admin UI calls
    ``reset_builtin_to_spec`` via the dedicated route.
    """
    first_id: int | None = None
    for spec in BUILTIN_SPECS:
        existing = conn.execute(
            "SELECT id FROM characters WHERE source = 'builtin' AND name = ?",
            (spec["name"],),
        ).fetchone()
        if existing is None:
            cid = ops.create_character(
                conn,
                name=spec["name"],
                description=spec["description"],
                behavior_prompt=spec["behavior_prompt"],
                avatar_style=spec["avatar_style"],
                avatar_seed=spec["avatar_seed"],
                avatar_config=spec["avatar_config"],
                source="builtin",
            )
        else:
            cid = int(existing["id"])
        if first_id is None:
            first_id = cid
    assert first_id is not None
    return first_id


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
