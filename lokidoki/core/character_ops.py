"""CRUD + per-user resolution for the character system (Phase 1).

Two-tier shape, mirroring `skill_config_global` / `skill_config_user`:

- ``characters`` is the **admin-managed global catalog**. Builtin and
  admin-source rows live here. Users do not write to this table.
- ``character_overrides_user`` holds **per-user field overrides** that
  shadow the catalog row at read time (catalog ← overrides, user
  wins). NULL columns mean "use the catalog value".
- ``character_settings_user`` holds the **per-user active pointer**.
  Each user picks their own active character independently.

The orchestrator and route layers consume the resolved view via
``resolve_character_for_user`` so they never have to know whether a
field came from the catalog or an override.

Schema lives in ``memory_schema.py``; this module owns query shapes,
the catalog/override merge, and the copy-on-write rule for builtins.
"""
from __future__ import annotations

import json
import sqlite3
from typing import Any

VALID_SOURCES = {"builtin", "admin", "user"}
VALID_STYLES = {"avataaars", "bottts", "toon-head"}

# Fields a user is allowed to override on top of a catalog row. Voice
# and wakeword are intentionally excluded — those bind to on-disk
# assets controlled by the admin asset budget (see schema comment).
USER_OVERRIDABLE = (
    "name",
    "phonetic_name",
    "description",
    "behavior_prompt",
    "avatar_style",
    "avatar_seed",
    "avatar_config",
)

# Fields the admin route can mutate on a catalog row.
_CATALOG_UPDATABLE = {
    "name",
    "phonetic_name",
    "description",
    "behavior_prompt",
    "avatar_style",
    "avatar_seed",
    "voice_id",
    "wakeword_id",
}


def _validate_source(source: str) -> None:
    if source not in VALID_SOURCES:
        raise ValueError(f"invalid source: {source!r}")


def _validate_style(style: str) -> None:
    if style not in VALID_STYLES:
        raise ValueError(f"invalid avatar_style: {style!r}")


# ====================================================================
# Catalog (admin-managed)
# ====================================================================

def create_character(
    conn: sqlite3.Connection,
    *,
    name: str,
    description: str = "",
    phonetic_name: str = "",
    behavior_prompt: str = "",
    avatar_style: str = "bottts",
    avatar_seed: str = "",
    avatar_config: dict[str, Any] | None = None,
    voice_id: str | None = None,
    wakeword_id: str | None = None,
    source: str = "user",
) -> int:
    _validate_source(source)
    _validate_style(avatar_style)
    cur = conn.execute(
        """
        INSERT INTO characters (
            name, phonetic_name, description, behavior_prompt,
            avatar_style, avatar_seed, avatar_config,
            voice_id, wakeword_id, source
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            name,
            phonetic_name,
            description,
            behavior_prompt,
            avatar_style,
            avatar_seed,
            json.dumps(avatar_config or {}),
            voice_id,
            wakeword_id,
            source,
        ),
    )
    conn.commit()
    return int(cur.lastrowid)


def get_character(conn: sqlite3.Connection, cid: int) -> sqlite3.Row | None:
    return conn.execute(
        "SELECT * FROM characters WHERE id = ?", (cid,)
    ).fetchone()


def list_characters(conn: sqlite3.Connection) -> list[sqlite3.Row]:
    return list(
        conn.execute("SELECT * FROM characters ORDER BY id ASC").fetchall()
    )


def update_character(
    conn: sqlite3.Connection, cid: int, **fields: Any
) -> None:
    """Mutate a catalog row in place. Admin-only at the route layer.

    Does NOT enforce the builtin copy-on-write rule — callers that
    want that semantics use ``edit_character_cow``. The split exists
    so internal seeding/migration code can mutate builtins directly.
    """
    if not fields:
        return
    if "avatar_style" in fields:
        _validate_style(fields["avatar_style"])
    sets: list[str] = []
    vals: list[Any] = []
    for key, value in fields.items():
        if key == "avatar_config":
            sets.append("avatar_config = ?")
            vals.append(json.dumps(value or {}))
        elif key in _CATALOG_UPDATABLE:
            sets.append(f"{key} = ?")
            vals.append(value)
        else:
            raise ValueError(f"field not updatable: {key}")
    sets.append("updated_at = datetime('now')")
    vals.append(cid)
    conn.execute(
        f"UPDATE characters SET {', '.join(sets)} WHERE id = ?", vals
    )
    conn.commit()


def delete_character(conn: sqlite3.Connection, cid: int) -> None:
    row = get_character(conn, cid)
    if row is None:
        return
    if row["source"] == "builtin":
        raise ValueError("builtin characters cannot be deleted")
    conn.execute("DELETE FROM characters WHERE id = ?", (cid,))
    conn.commit()


def edit_character_cow(
    conn: sqlite3.Connection, cid: int, **fields: Any
) -> int:
    """Edit-with-copy-on-write for the admin playground.

    Builtin rows clone into a new admin-source row with the requested
    fields applied; admin/user rows update in place.
    """
    row = get_character(conn, cid)
    if row is None:
        raise ValueError(f"character {cid} not found")
    if row["source"] != "builtin":
        update_character(conn, cid, **fields)
        return cid
    base = dict(row)
    base.update(fields)
    return create_character(
        conn,
        name=base["name"],
        description=base.get("description", ""),
        phonetic_name=base.get("phonetic_name", ""),
        behavior_prompt=base.get("behavior_prompt", ""),
        avatar_style=base.get("avatar_style", "bottts"),
        avatar_seed=base.get("avatar_seed", ""),
        avatar_config=json.loads(base.get("avatar_config") or "{}"),
        voice_id=base.get("voice_id"),
        wakeword_id=base.get("wakeword_id"),
        source="admin",
    )


# ====================================================================
# Per-user overrides
# ====================================================================

def set_user_override(
    conn: sqlite3.Connection,
    user_id: int,
    character_id: int,
    **fields: Any,
) -> None:
    """UPSERT per-user override fields onto a catalog character.

    Passing a value of ``None`` for a field clears that override
    (falls back to catalog). Any field not in ``USER_OVERRIDABLE`` is
    rejected.
    """
    if not fields:
        return
    if "avatar_style" in fields and fields["avatar_style"] is not None:
        _validate_style(fields["avatar_style"])
    # Ensure a row exists.
    conn.execute(
        "INSERT OR IGNORE INTO character_overrides_user "
        "(user_id, character_id) VALUES (?, ?)",
        (user_id, character_id),
    )
    sets: list[str] = []
    vals: list[Any] = []
    for key, value in fields.items():
        if key not in USER_OVERRIDABLE:
            raise ValueError(f"field not user-overridable: {key}")
        if key == "avatar_config" and value is not None:
            sets.append("avatar_config = ?")
            vals.append(json.dumps(value))
        else:
            sets.append(f"{key} = ?")
            vals.append(value)
    sets.append("updated_at = datetime('now')")
    vals.extend([user_id, character_id])
    conn.execute(
        f"UPDATE character_overrides_user SET {', '.join(sets)} "
        "WHERE user_id = ? AND character_id = ?",
        vals,
    )
    conn.commit()


def clear_user_overrides(
    conn: sqlite3.Connection, user_id: int, character_id: int
) -> None:
    conn.execute(
        "DELETE FROM character_overrides_user "
        "WHERE user_id = ? AND character_id = ?",
        (user_id, character_id),
    )
    conn.commit()


def get_user_override(
    conn: sqlite3.Connection, user_id: int, character_id: int
) -> sqlite3.Row | None:
    return conn.execute(
        "SELECT * FROM character_overrides_user "
        "WHERE user_id = ? AND character_id = ?",
        (user_id, character_id),
    ).fetchone()


def resolve_character_for_user(
    conn: sqlite3.Connection, user_id: int, character_id: int
) -> dict | None:
    """Return the catalog row merged with this user's overrides.

    The result is a plain dict (not a Row) so callers can pass it to
    JSON serializers without losing the merged shape. Adds two extra
    keys callers find useful:
      - ``avatar_config`` is JSON-decoded to a dict.
      - ``has_user_overrides`` flags whether any override row exists.
    """
    base = get_character(conn, character_id)
    if base is None:
        return None
    out = dict(base)
    override = get_user_override(conn, user_id, character_id)
    if override is not None:
        for key in USER_OVERRIDABLE:
            val = override[key] if key in override.keys() else None
            if val is not None:
                out[key] = val
        out["has_user_overrides"] = True
    else:
        out["has_user_overrides"] = False
    try:
        out["avatar_config"] = json.loads(out.get("avatar_config") or "{}")
    except (TypeError, json.JSONDecodeError):
        out["avatar_config"] = {}
    return out


# ====================================================================
# Per-user active pointer
# ====================================================================

def set_active_character(
    conn: sqlite3.Connection, user_id: int, cid: int | None
) -> None:
    conn.execute(
        "INSERT INTO character_settings_user (user_id, active_character_id) "
        "VALUES (?, ?) "
        "ON CONFLICT(user_id) DO UPDATE SET "
        "active_character_id = excluded.active_character_id, "
        "updated_at = datetime('now')",
        (user_id, cid),
    )
    conn.commit()


def get_active_character_id(
    conn: sqlite3.Connection, user_id: int
) -> int | None:
    """Resolve a user's active character id, honoring access tiers.

    Falls back when the picked character is invisible (globally
    disabled or user-denied) or when none has been picked. Falls back
    to the first *visible* builtin; if no visible character exists at
    all, returns the first visible character of any source. Returns
    ``None`` only on a totally empty catalog.
    """
    from lokidoki.core import character_access as access

    row = conn.execute(
        "SELECT active_character_id FROM character_settings_user "
        "WHERE user_id = ?",
        (user_id,),
    ).fetchone()
    if row and row["active_character_id"] is not None:
        cid = int(row["active_character_id"])
        if access.is_visible_to_user(conn, user_id, cid):
            return cid
        # picked character was disabled out from under the user — fall through
    all_ids = [
        int(r["id"])
        for r in conn.execute(
            "SELECT id FROM characters WHERE source = 'builtin' "
            "ORDER BY id ASC"
        ).fetchall()
    ]
    visible_builtin = access.filter_visible_ids(conn, user_id, all_ids)
    for cid in all_ids:
        if cid in visible_builtin:
            return cid
    # No visible builtin — try any character.
    other_ids = [
        int(r["id"])
        for r in conn.execute(
            "SELECT id FROM characters ORDER BY id ASC"
        ).fetchall()
    ]
    visible = access.filter_visible_ids(conn, user_id, other_ids)
    for cid in other_ids:
        if cid in visible:
            return cid
    return None


def list_visible_characters_for_user(
    conn: sqlite3.Connection, user_id: int
) -> list[dict]:
    """List catalog rows visible to ``user_id`` with overrides merged in.

    Honors the global + per-user enable tiers from
    ``character_access`` so the user-facing picker only ever sees
    characters the admin has authorized.
    """
    from lokidoki.core import character_access as access

    rows = list_characters(conn)
    ids = [int(r["id"]) for r in rows]
    visible = access.filter_visible_ids(conn, user_id, ids)
    out: list[dict] = []
    for r in rows:
        cid = int(r["id"])
        if cid not in visible:
            continue
        merged = resolve_character_for_user(conn, user_id, cid)
        if merged is not None:
            out.append(merged)
    return out


def get_active_character_for_user(
    conn: sqlite3.Connection, user_id: int
) -> dict | None:
    cid = get_active_character_id(conn, user_id)
    if cid is None:
        return None
    return resolve_character_for_user(conn, user_id, cid)
