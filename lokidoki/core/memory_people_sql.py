"""Sync SQL helpers for people / relationships / fact conflicts.

Split out of ``memory_sql.py`` so neither file blows the 250-line cap.
Every function is user-scoped (``owner_user_id`` is always part of the
WHERE clause). The async-facing wrappers live in
``memory_people_ops.py`` and bind themselves onto MemoryProvider at
import time.

Person identity
---------------
People are case-insensitively unique by display name *within* a user's
tenant. We store the canonical display form in ``people.name`` and
match on ``LOWER(name)`` for find-or-create. The schema's
``UNIQUE(owner_user_id, name)`` constraint protects against the rare
race where two find-or-create calls interleave on the same name.
"""
from __future__ import annotations

import sqlite3
from typing import Optional

from lokidoki.core.confidence import DEFAULT_CONFIDENCE


def find_people_by_name(
    conn: sqlite3.Connection, user_id: int, name: str
) -> list[sqlite3.Row]:
    """Return ALL people matching ``name`` case-insensitively for this user.

    Multiple "Artie" rows are allowed (brother-Artie, dog-Artie); the
    orchestrator picks one with disambiguation scoring.
    """
    norm = name.strip()
    if not norm:
        return []
    return conn.execute(
        "SELECT id, name, created_at FROM people "
        "WHERE owner_user_id = ? AND LOWER(name) = LOWER(?) "
        "ORDER BY id ASC",
        (user_id, norm),
    ).fetchall()


def create_person(
    conn: sqlite3.Connection, user_id: int, name: str
) -> int:
    """Unconditionally create a new people row. Returns the new id."""
    norm = name.strip()
    if not norm:
        raise ValueError("person name cannot be empty")
    cur = conn.execute(
        "INSERT INTO people (owner_user_id, name) VALUES (?, ?)",
        (user_id, norm),
    )
    conn.commit()
    return int(cur.lastrowid)


def find_or_create_person(
    conn: sqlite3.Connection, user_id: int, name: str
) -> int:
    """Legacy single-result helper.

    Used by code paths that don't need disambiguation (e.g. admin
    routes). Returns the FIRST matching row, or creates one. The
    orchestrator path uses ``find_people_by_name`` + scoring instead.
    """
    rows = find_people_by_name(conn, user_id, name)
    if rows:
        return int(rows[0]["id"])
    return create_person(conn, user_id, name)


def update_person_name(
    conn: sqlite3.Connection, user_id: int, person_id: int, name: str
) -> bool:
    norm = name.strip()
    if not norm:
        return False
    cur = conn.execute(
        "UPDATE people SET name = ? WHERE owner_user_id = ? AND id = ?",
        (norm, user_id, person_id),
    )
    # Re-point any facts whose subject text mirrored the old lowercase name.
    conn.execute(
        "UPDATE facts SET subject = LOWER(?) "
        "WHERE owner_user_id = ? AND subject_ref_id = ?",
        (norm, user_id, person_id),
    )
    conn.commit()
    return cur.rowcount > 0


def delete_person(
    conn: sqlite3.Connection, user_id: int, person_id: int
) -> bool:
    cur = conn.execute(
        "DELETE FROM people WHERE owner_user_id = ? AND id = ?",
        (user_id, person_id),
    )
    conn.commit()
    return cur.rowcount > 0


def list_people(conn: sqlite3.Connection, user_id: int) -> list[sqlite3.Row]:
    return conn.execute(
        "SELECT p.id, p.name, p.created_at, "
        "       (SELECT COUNT(*) FROM facts f "
        "        WHERE f.owner_user_id = p.owner_user_id "
        "          AND f.subject_ref_id = p.id) AS fact_count "
        "FROM people p "
        "WHERE p.owner_user_id = ? "
        "ORDER BY LOWER(p.name)",
        (user_id,),
    ).fetchall()


def get_person(
    conn: sqlite3.Connection, user_id: int, person_id: int
) -> sqlite3.Row :
    return conn.execute(
        "SELECT id, name, created_at FROM people "
        "WHERE owner_user_id = ? AND id = ?",
        (user_id, person_id),
    ).fetchone()


def list_facts_about_person(
    conn: sqlite3.Connection, user_id: int, person_id: int
) -> list[sqlite3.Row]:
    return conn.execute(
        "SELECT id, subject, subject_type, subject_ref_id, predicate, value, "
        "       category, confidence, observation_count, last_observed_at, "
        "       status, ambiguity_group_id, source_message_id, "
        "       created_at, updated_at FROM facts "
        "WHERE owner_user_id = ? AND subject_ref_id = ? "
        "AND status IN ('active','ambiguous') "
        "ORDER BY updated_at DESC",
        (user_id, person_id),
    ).fetchall()


def count_recent_session_refs(
    conn: sqlite3.Connection, user_id: int, person_id: int, since_message_id: int
) -> int:
    """How many facts about this person were observed in the recent window.

    Used by disambiguation scoring as a co-occurrence signal.
    """
    row = conn.execute(
        "SELECT COUNT(*) FROM facts "
        "WHERE owner_user_id = ? AND subject_ref_id = ? "
        "AND source_message_id IS NOT NULL AND source_message_id >= ?",
        (user_id, person_id, since_message_id),
    ).fetchone()
    return int(row[0]) if row else 0


def merge_people(
    conn: sqlite3.Connection,
    user_id: int,
    source_id: int,
    into_id: int,
) -> bool:
    """Move all facts/relationships from ``source_id`` to ``into_id``.

    Both ids must belong to ``user_id`` (defense in depth — the route
    layer also checks). Returns True if the merge happened.
    """
    if source_id == into_id:
        return False
    target = conn.execute(
        "SELECT id, name FROM people WHERE owner_user_id = ? AND id = ?",
        (user_id, into_id),
    ).fetchone()
    src = conn.execute(
        "SELECT id, name FROM people WHERE owner_user_id = ? AND id = ?",
        (user_id, source_id),
    ).fetchone()
    if not target or not src:
        return False

    target_subject = target["name"].strip().lower()
    conn.execute(
        "UPDATE facts SET subject_ref_id = ?, subject = ? "
        "WHERE owner_user_id = ? AND subject_ref_id = ?",
        (into_id, target_subject, user_id, source_id),
    )
    # Relationships: collapse onto the target person, ignoring duplicates
    # that would violate the UNIQUE(owner, person, relation) constraint.
    conn.execute(
        "UPDATE OR IGNORE relationships SET person_id = ? "
        "WHERE owner_user_id = ? AND person_id = ?",
        (into_id, user_id, source_id),
    )
    conn.execute(
        "DELETE FROM relationships WHERE owner_user_id = ? AND person_id = ?",
        (user_id, source_id),
    )
    conn.execute(
        "DELETE FROM people WHERE owner_user_id = ? AND id = ?",
        (user_id, source_id),
    )
    conn.commit()
    return True


def upsert_relationship(
    conn: sqlite3.Connection,
    user_id: int,
    person_id: int,
    relation: str,
) -> int:
    """Insert OR confirm a (user, person, relation) triple.

    Mirrors ``upsert_fact``: a repeat statement bumps confidence rather
    than inserting a duplicate row.
    """
    existing = conn.execute(
        "SELECT id, confidence FROM relationships "
        "WHERE owner_user_id = ? AND person_id = ? AND relation = ?",
        (user_id, person_id, relation),
    ).fetchone()
    if existing:
        from lokidoki.core.confidence import update_confidence

        new_conf = update_confidence(float(existing["confidence"]), confirmed=True)
        conn.execute(
            "UPDATE relationships SET confidence = ? WHERE id = ?",
            (new_conf, existing["id"]),
        )
        conn.commit()
        return int(existing["id"])
    cur = conn.execute(
        "INSERT INTO relationships "
        "(owner_user_id, person_id, relation, confidence) VALUES (?, ?, ?, ?)",
        (user_id, person_id, relation, DEFAULT_CONFIDENCE),
    )
    conn.commit()
    return int(cur.lastrowid)


def list_relationships(
    conn: sqlite3.Connection, user_id: int
) -> list[sqlite3.Row]:
    return conn.execute(
        "SELECT r.id, r.relation, r.confidence, r.created_at, "
        "       p.id AS person_id, p.name AS person_name "
        "FROM relationships r "
        "JOIN people p ON p.id = r.person_id "
        "WHERE r.owner_user_id = ? "
        "ORDER BY r.relation, LOWER(p.name)",
        (user_id,),
    ).fetchall()


def create_ambiguity_group(
    conn: sqlite3.Connection,
    user_id: int,
    raw_name: str,
    candidate_person_ids: list[int],
) -> int:
    import json as _json

    cur = conn.execute(
        "INSERT INTO ambiguity_groups "
        "(owner_user_id, raw_name, candidate_person_ids) VALUES (?, ?, ?)",
        (user_id, raw_name, _json.dumps(candidate_person_ids)),
    )
    conn.commit()
    return int(cur.lastrowid)


def get_ambiguity_group(
    conn: sqlite3.Connection, user_id: int, group_id: int
) -> Optional[sqlite3.Row]:
    return conn.execute(
        "SELECT id, raw_name, candidate_person_ids, resolved_person_id, resolved_at "
        "FROM ambiguity_groups WHERE owner_user_id = ? AND id = ?",
        (user_id, group_id),
    ).fetchone()


def resolve_ambiguity_group(
    conn: sqlite3.Connection,
    user_id: int,
    group_id: int,
    person_id: int,
) -> bool:
    """Bind every fact in the group to ``person_id`` and mark resolved."""
    person = conn.execute(
        "SELECT name FROM people WHERE owner_user_id = ? AND id = ?",
        (user_id, person_id),
    ).fetchone()
    if not person:
        return False
    subject = person["name"].strip().lower()
    cur = conn.execute(
        "UPDATE facts SET subject_ref_id = ?, subject = ?, "
        "subject_type = 'person', status = 'active', "
        "ambiguity_group_id = NULL, updated_at = datetime('now') "
        "WHERE owner_user_id = ? AND ambiguity_group_id = ?",
        (person_id, subject, user_id, group_id),
    )
    conn.execute(
        "UPDATE ambiguity_groups SET resolved_person_id = ?, "
        "resolved_at = datetime('now') WHERE owner_user_id = ? AND id = ?",
        (person_id, user_id, group_id),
    )
    conn.commit()
    return cur.rowcount >= 0


def list_unresolved_ambiguity_groups(
    conn: sqlite3.Connection, user_id: int
) -> list[sqlite3.Row]:
    return conn.execute(
        "SELECT id, raw_name, candidate_person_ids, created_at "
        "FROM ambiguity_groups WHERE owner_user_id = ? AND resolved_person_id IS NULL "
        "ORDER BY id DESC",
        (user_id,),
    ).fetchall()


def list_fact_conflicts(
    conn: sqlite3.Connection, user_id: int
) -> list[sqlite3.Row]:
    """Rows where (subject, predicate) has multiple distinct values.

    Returns one row per conflicting fact (not per group), so the
    frontend can render each candidate with its own confidence and id.
    """
    return conn.execute(
        "SELECT f.id, f.subject, f.subject_type, f.subject_ref_id, "
        "       f.predicate, f.value, f.confidence, f.updated_at "
        "FROM facts f "
        "JOIN ( "
        "    SELECT subject, predicate "
        "    FROM facts "
        "    WHERE owner_user_id = ? "
        "    GROUP BY subject, predicate "
        "    HAVING COUNT(DISTINCT value) > 1 "
        ") c ON c.subject = f.subject AND c.predicate = f.predicate "
        "WHERE f.owner_user_id = ? "
        "ORDER BY f.subject, f.predicate, f.confidence DESC",
        (user_id, user_id),
    ).fetchall()
