"""Character access control: global + per-user enable toggles.

Split out of ``character_ops`` because access is a distinct duty
from storage (catalog CRUD + overrides + active pointer all live in
``character_ops``; this module owns *who can use what*).

Resolution model mirrors ``skill_enabled_*``:

  visible = global_enabled AND user_enabled

Both default to ``True`` when no row exists, so admins only write
rows to *override* the default. Disabling a character globally hides
it from every user without destroying the catalog row. Per-user
rows let admins restrict a specific character away from a specific
user. The orchestrator's active-character resolution honors this
via ``filter_visible_ids`` so a user can never end up with a
disabled active character.
"""
from __future__ import annotations

import sqlite3


# ---- global tier --------------------------------------------------------

def set_global_enabled(
    conn: sqlite3.Connection, character_id: int, enabled: bool
) -> None:
    conn.execute(
        "INSERT INTO character_enabled_global (character_id, enabled) "
        "VALUES (?, ?) "
        "ON CONFLICT(character_id) DO UPDATE SET "
        "enabled = excluded.enabled, updated_at = datetime('now')",
        (character_id, 1 if enabled else 0),
    )
    conn.commit()


def get_global_enabled(
    conn: sqlite3.Connection, character_id: int
) -> bool:
    row = conn.execute(
        "SELECT enabled FROM character_enabled_global WHERE character_id = ?",
        (character_id,),
    ).fetchone()
    if row is None:
        return True
    return bool(row["enabled"])


# ---- user tier ----------------------------------------------------------

def set_user_enabled(
    conn: sqlite3.Connection,
    user_id: int,
    character_id: int,
    enabled: bool | None,
) -> None:
    """Set or clear a per-user override.

    ``enabled=None`` deletes the row, restoring inherit-from-global
    behavior. This is the "reset to default" path the admin UI uses
    when an admin wants to stop forcing a value for a user.
    """
    if enabled is None:
        conn.execute(
            "DELETE FROM character_enabled_user "
            "WHERE user_id = ? AND character_id = ?",
            (user_id, character_id),
        )
    else:
        conn.execute(
            "INSERT INTO character_enabled_user "
            "(user_id, character_id, enabled) VALUES (?, ?, ?) "
            "ON CONFLICT(user_id, character_id) DO UPDATE SET "
            "enabled = excluded.enabled, updated_at = datetime('now')",
            (user_id, character_id, 1 if enabled else 0),
        )
    conn.commit()


def get_user_override(
    conn: sqlite3.Connection, user_id: int, character_id: int
) -> bool | None:
    """Return the user's explicit override, or None if inherit-from-global."""
    row = conn.execute(
        "SELECT enabled FROM character_enabled_user "
        "WHERE user_id = ? AND character_id = ?",
        (user_id, character_id),
    ).fetchone()
    if row is None:
        return None
    return bool(row["enabled"])


# ---- resolution ---------------------------------------------------------

def is_visible_to_user(
    conn: sqlite3.Connection, user_id: int, character_id: int
) -> bool:
    if not get_global_enabled(conn, character_id):
        return False
    override = get_user_override(conn, user_id, character_id)
    if override is not None:
        return override
    return True


def filter_visible_ids(
    conn: sqlite3.Connection, user_id: int, character_ids: list[int]
) -> set[int]:
    """Return the subset of ``character_ids`` visible to ``user_id``.

    Single query per tier — avoids N+1 when listing the catalog.
    """
    if not character_ids:
        return set()
    placeholders = ",".join("?" * len(character_ids))
    global_disabled = {
        int(r["character_id"])
        for r in conn.execute(
            f"SELECT character_id FROM character_enabled_global "
            f"WHERE enabled = 0 AND character_id IN ({placeholders})",
            character_ids,
        )
    }
    user_rows = {
        int(r["character_id"]): bool(r["enabled"])
        for r in conn.execute(
            f"SELECT character_id, enabled FROM character_enabled_user "
            f"WHERE user_id = ? AND character_id IN ({placeholders})",
            [user_id, *character_ids],
        )
    }
    visible: set[int] = set()
    for cid in character_ids:
        if cid in global_disabled:
            continue
        if cid in user_rows and not user_rows[cid]:
            continue
        visible.add(cid)
    return visible


def list_user_access_matrix(
    conn: sqlite3.Connection, user_id: int
) -> list[dict]:
    """Return one row per catalog character with effective access state.

    Powers the admin "per-user access" matrix UI. Each entry includes:
      - ``character_id``, ``name``, ``source``
      - ``global_enabled`` (the admin tier)
      - ``user_override`` (None | True | False — None means inherit)
      - ``effective`` (the AND-merged result)
    """
    chars = list(
        conn.execute(
            "SELECT id, name, source FROM characters ORDER BY id ASC"
        ).fetchall()
    )
    if not chars:
        return []
    ids = [int(c["id"]) for c in chars]
    placeholders = ",".join("?" * len(ids))
    global_map = {
        int(r["character_id"]): bool(r["enabled"])
        for r in conn.execute(
            f"SELECT character_id, enabled FROM character_enabled_global "
            f"WHERE character_id IN ({placeholders})",
            ids,
        )
    }
    user_map = {
        int(r["character_id"]): bool(r["enabled"])
        for r in conn.execute(
            f"SELECT character_id, enabled FROM character_enabled_user "
            f"WHERE user_id = ? AND character_id IN ({placeholders})",
            [user_id, *ids],
        )
    }
    out: list[dict] = []
    for c in chars:
        cid = int(c["id"])
        g_enabled = global_map.get(cid, True)
        u_override = user_map.get(cid)  # None if no row
        effective = g_enabled and (u_override if u_override is not None else True)
        out.append(
            {
                "character_id": cid,
                "name": c["name"],
                "source": c["source"],
                "global_enabled": g_enabled,
                "user_override": u_override,
                "effective": effective,
            }
        )
    return out
