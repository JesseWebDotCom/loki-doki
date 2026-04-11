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

    Multiple "Luke" rows are allowed (brother-Luke, dog-Luke); the
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
        "SELECT p.id, p.name, p.aliases, p.created_at, "
        "       u.id AS linked_user_id, u.username AS linked_username, "
        "       (SELECT COUNT(*) FROM facts f "
        "        WHERE f.owner_user_id = p.owner_user_id "
        "          AND f.subject_ref_id = p.id) AS fact_count "
        "FROM people p "
        "LEFT JOIN person_user_links pul ON pul.person_id = p.id "
        "LEFT JOIN users u ON u.id = pul.user_id "
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
    # Relationships: collapse onto the target person in both tables.
    # Legacy table (kept for backwards compat during transition):
    conn.execute(
        "UPDATE OR IGNORE relationships SET person_id = ? "
        "WHERE owner_user_id = ? AND person_id = ?",
        (into_id, user_id, source_id),
    )
    conn.execute(
        "DELETE FROM relationships WHERE owner_user_id = ? AND person_id = ?",
        (user_id, source_id),
    )
    # Graph edges: repoint source → into for both directions.
    conn.execute(
        "UPDATE OR IGNORE person_relationship_edges "
        "SET from_person_id = ? WHERE from_person_id = ?",
        (into_id, source_id),
    )
    conn.execute(
        "UPDATE OR IGNORE person_relationship_edges "
        "SET to_person_id = ? WHERE to_person_id = ?",
        (into_id, source_id),
    )
    # Remove self-loops created by the merge.
    conn.execute(
        "DELETE FROM person_relationship_edges "
        "WHERE from_person_id = to_person_id"
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
    """Insert OR confirm a relationship as a graph edge.

    Delegates to ``people_graph_sql.upsert_person_edge`` after mapping
    the freeform relation string to an edge_type and resolving the
    user's self-person node.
    """
    from lokidoki.core.people_graph_sql import (
        ensure_user_self_person,
        relation_to_edge_type,
        upsert_person_edge,
    )

    self_person_id = ensure_user_self_person(conn, user_id=user_id)
    edge_type, is_inverted = relation_to_edge_type(relation)
    if is_inverted:
        from_id, to_id = person_id, self_person_id
    else:
        from_id, to_id = self_person_id, person_id

    return upsert_person_edge(
        conn, user_id,
        from_person_id=from_id,
        to_person_id=to_id,
        edge_type=edge_type,
        provenance="conversation",
    )


def set_primary_relationship(
    conn: sqlite3.Connection,
    user_id: int,
    person_id: int,
    relation: str,
) -> int:
    """Replace ALL existing edges between user and ``person_id`` with one.

    Used by the Memory UI's relationship dropdown. ``relation=''``
    clears every edge for the person and returns 0.
    """
    from lokidoki.core.people_graph_sql import (
        ensure_user_self_person,
        relation_to_edge_type,
    )

    self_person_id = ensure_user_self_person(conn, user_id=user_id)
    # Delete all edges between user's self-person and this person.
    conn.execute(
        "DELETE FROM person_relationship_edges "
        "WHERE (from_person_id = ? AND to_person_id = ?) "
        "   OR (from_person_id = ? AND to_person_id = ?)",
        (self_person_id, person_id, person_id, self_person_id),
    )
    if not relation.strip():
        conn.commit()
        return 0
    edge_type, is_inverted = relation_to_edge_type(relation)
    if is_inverted:
        from_id, to_id = person_id, self_person_id
    else:
        from_id, to_id = self_person_id, person_id
    cur = conn.execute(
        "INSERT INTO person_relationship_edges "
        "(creator_user_id, from_person_id, to_person_id, edge_type, "
        "confidence, provenance) VALUES (?, ?, ?, ?, ?, ?)",
        (user_id, from_id, to_id, edge_type, DEFAULT_CONFIDENCE, "manual"),
    )
    conn.commit()
    return int(cur.lastrowid)


def delete_relationship(
    conn: sqlite3.Connection, user_id: int, rel_id: int
) -> bool:
    """Delete a graph edge by ID (scoped to edges the user created)."""
    cur = conn.execute(
        "DELETE FROM person_relationship_edges "
        "WHERE creator_user_id = ? AND id = ?",
        (user_id, rel_id),
    )
    conn.commit()
    return cur.rowcount > 0


def list_relationships(
    conn: sqlite3.Connection, user_id: int
) -> list[dict]:
    """List relationships from graph edges in the legacy dict shape."""
    from lokidoki.core.people_graph_sql import list_relationships_from_edges

    return list_relationships_from_edges(conn, user_id)


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
