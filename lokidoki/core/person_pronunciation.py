"""Per-person pronunciation overrides for name parts.

Supports two levels:
  * **Individual**: first, middle, suffix, nickname, full — tied to one person_id.
  * **Family (last name)**: a last-name fix on any person propagates to every
    person who shares that last name, unless individually overridden.

At TTS time ``collect_person_pronunciation_fixes()`` gathers all overrides
for a user's people graph and returns a flat ``{written: spoken}`` dict
that merges into the global pronunciation_fixes pipeline.
"""
from __future__ import annotations

import sqlite3
from typing import Any, Optional

VALID_NAME_PARTS = ("first", "middle", "last", "suffix", "nickname", "full")


# ---- CRUD (run via MemoryProvider.run_sync) -------------------------------


def list_person_pronunciations(
    conn: sqlite3.Connection, person_id: int
) -> list[dict[str, Any]]:
    rows = conn.execute(
        "SELECT id, person_id, name_part, written, spoken, updated_at "
        "FROM person_pronunciation WHERE person_id = ? ORDER BY name_part",
        (person_id,),
    ).fetchall()
    return [dict(r) for r in rows]


def set_person_pronunciation(
    conn: sqlite3.Connection,
    person_id: int,
    name_part: str,
    written: str,
    spoken: str,
) -> int:
    """Upsert a pronunciation override. Returns the row id."""
    cur = conn.execute(
        "INSERT INTO person_pronunciation (person_id, name_part, written, spoken, updated_at) "
        "VALUES (?, ?, ?, ?, datetime('now')) "
        "ON CONFLICT(person_id, name_part) DO UPDATE SET "
        "written = excluded.written, spoken = excluded.spoken, "
        "updated_at = excluded.updated_at",
        (person_id, name_part, written.strip(), spoken.strip()),
    )
    conn.commit()
    return cur.lastrowid or 0


def delete_person_pronunciation(
    conn: sqlite3.Connection, person_id: int, name_part: str
) -> bool:
    cur = conn.execute(
        "DELETE FROM person_pronunciation WHERE person_id = ? AND name_part = ?",
        (person_id, name_part),
    )
    conn.commit()
    return cur.rowcount > 0


# ---- collection for TTS --------------------------------------------------


def collect_person_pronunciation_fixes(
    conn: sqlite3.Connection, owner_user_id: int
) -> dict[str, str]:
    """Gather all person pronunciation overrides for one user's people graph.

    Returns a flat ``{written_lower: spoken}`` dict ready to merge into the
    global pronunciation fixes.

    Last-name fixes propagate to every person sharing that last name.
    Individual-level fixes (first, middle, etc.) override family-level for
    their specific written form.
    """
    rows = conn.execute(
        "SELECT pp.person_id, pp.name_part, pp.written, pp.spoken "
        "FROM person_pronunciation pp "
        "JOIN people p ON p.id = pp.person_id "
        "WHERE p.owner_user_id = ?",
        (owner_user_id,),
    ).fetchall()

    if not rows:
        return {}

    # Two passes: family-level last names first, then individual overrides on top.
    fixes: dict[str, str] = {}
    for r in rows:
        written = str(r["written"]).strip().lower()
        if written:
            fixes[written] = str(r["spoken"]).strip()

    return fixes
