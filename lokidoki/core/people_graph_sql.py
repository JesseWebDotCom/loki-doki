"""SQL helpers for the structured People graph domain."""
from __future__ import annotations

import hashlib
import json
import sqlite3
from typing import Optional


DEFAULT_REL_STATE = "active"
DEFAULT_INTERACTION = "normal"
DEFAULT_VISIBILITY = "full"


def _reconcile_snapshot(
    conn: sqlite3.Connection,
    *,
    person_id: int,
    viewer_user_id: int,
) -> Optional[dict]:
    row = conn.execute(
        "SELECT p.id, p.name, p.birth_date, p.bucket, p.living_status, p.owner_user_id, "
        "       COALESCE(po.relationship_state, 'active') AS relationship_state, "
        "       COALESCE(po.interaction_preference, 'normal') AS interaction_preference, "
        "       u.id AS linked_user_id, u.username AS linked_username, "
        "       pm.medium_path AS preferred_photo_path, "
        "       (SELECT COUNT(*) FROM facts f WHERE f.subject_ref_id = p.id) AS fact_count, "
        "       (SELECT COUNT(*) FROM person_events pe WHERE pe.person_id = p.id) AS event_count, "
        "       (SELECT COUNT(*) FROM person_media pm2 WHERE pm2.person_id = p.id) AS media_count, "
        "       (SELECT COUNT(*) FROM person_relationship_edges pre "
        "         WHERE pre.from_person_id = p.id OR pre.to_person_id = p.id) AS edge_count "
        "FROM people p "
        "LEFT JOIN person_overlays po "
        "  ON po.person_id = p.id AND po.viewer_user_id = ? "
        "LEFT JOIN person_user_links pul ON pul.person_id = p.id "
        "LEFT JOIN users u ON u.id = pul.user_id "
        "LEFT JOIN person_media pm ON pm.id = p.preferred_photo_id "
        "WHERE p.id = ?",
        (viewer_user_id, person_id),
    ).fetchone()
    return dict(row) if row else None


def _reconcile_score(candidate: dict) -> tuple[int, int, int]:
    linked_bonus = 100 if candidate.get("linked_user_id") else 0
    data_weight = sum(
        int(candidate.get(key) or 0)
        for key in ("fact_count", "event_count", "media_count", "edge_count")
    )
    stable_id = -int(candidate.get("id") or 0)
    return (linked_bonus, data_weight, stable_id)


def _ensure_overlay(conn: sqlite3.Connection, viewer_user_id: int, person_id: int) -> None:
    conn.execute(
        "INSERT OR IGNORE INTO person_overlays "
        "(viewer_user_id, person_id, relationship_state, interaction_preference, visibility_level) "
        "VALUES (?, ?, ?, ?, ?)",
        (
            viewer_user_id,
            person_id,
            DEFAULT_REL_STATE,
            DEFAULT_INTERACTION,
            DEFAULT_VISIBILITY,
        ),
    )


def _visible_people_where(is_admin: bool) -> str:
    if is_admin:
        return "1=1"
    return (
        "(p.owner_user_id = :viewer_user_id OR "
        " EXISTS (SELECT 1 FROM person_overlays pov "
        "         WHERE pov.viewer_user_id = :viewer_user_id "
        "           AND pov.person_id = p.id "
        "           AND pov.visibility_level != 'hidden'))"
    )


def list_people_graph(
    conn: sqlite3.Connection,
    viewer_user_id: int,
    *,
    is_admin: bool,
    search: str = "",
    bucket: str = "all",
    relationship_state: str = "all",
    interaction_preference: str = "all",
) -> dict:
    params = {"viewer_user_id": viewer_user_id}
    where = [_visible_people_where(is_admin)]
    if search.strip():
        where.append("LOWER(p.name) LIKE :search")
        params["search"] = f"%{search.strip().lower()}%"
    if bucket != "all":
        where.append("p.bucket = :bucket")
        params["bucket"] = bucket
    if relationship_state != "all":
        where.append(
            "COALESCE(po.relationship_state, 'active') = :relationship_state"
        )
        params["relationship_state"] = relationship_state
    if interaction_preference != "all":
        where.append(
            "COALESCE(po.interaction_preference, 'normal') = :interaction_preference"
        )
        params["interaction_preference"] = interaction_preference

    rows = conn.execute(
        "SELECT p.id, p.owner_user_id, p.name, p.aliases, p.bucket, p.living_status, "
        "       p.birth_date, p.death_date, p.preferred_photo_id, p.created_at, "
        "       COALESCE(po.relationship_state, 'active') AS relationship_state, "
        "       COALESCE(po.interaction_preference, 'normal') AS interaction_preference, "
        "       COALESCE(po.visibility_level, CASE WHEN p.owner_user_id = :viewer_user_id THEN 'full' ELSE 'hidden' END) AS visibility_level, "
        "       po.last_interaction_at, po.last_mentioned_at, COALESCE(po.mention_score, 0) AS mention_score, "
        "       u.id AS linked_user_id, u.username AS linked_username, "
        "       pm.medium_path AS preferred_photo_path, "
        "       (SELECT event_date FROM person_events pe "
        "         WHERE pe.person_id = p.id AND pe.event_type = 'birthday' "
        "         ORDER BY pe.id DESC LIMIT 1) AS birthday, "
        "       (SELECT COUNT(*) FROM facts f WHERE f.subject_ref_id = p.id) AS fact_count "
        "FROM people p "
        "LEFT JOIN person_overlays po "
        "  ON po.person_id = p.id AND po.viewer_user_id = :viewer_user_id "
        "LEFT JOIN person_user_links pul ON pul.person_id = p.id "
        "LEFT JOIN users u ON u.id = pul.user_id "
        "LEFT JOIN person_media pm ON pm.id = p.preferred_photo_id "
        f"WHERE {' AND '.join(where)} "
        "ORDER BY LOWER(p.name)",
        params,
    ).fetchall()

    person_ids = [int(r["id"]) for r in rows]
    edges: list[sqlite3.Row] = []
    if person_ids:
        placeholders = ",".join("?" for _ in person_ids)
        edge_args = [*person_ids, *person_ids]
        edges = conn.execute(
            "SELECT e.id, e.from_person_id, fp.name AS from_person_name, "
            "       e.to_person_id, tp.name AS to_person_name, e.edge_type, "
            "       e.start_date, e.end_date, e.confidence, e.provenance, e.created_at "
            "FROM person_relationship_edges e "
            "JOIN people fp ON fp.id = e.from_person_id "
            "JOIN people tp ON tp.id = e.to_person_id "
            "WHERE (e.from_person_id IN (" + placeholders + ") "
            "   OR e.to_person_id IN (" + placeholders + ")) "
            "ORDER BY e.edge_type, e.id",
            edge_args,
        ).fetchall()

    return {
        "people": [dict(r) for r in rows],
        "edges": [dict(r) for r in edges],
    }


def get_person_detail(
    conn: sqlite3.Connection,
    viewer_user_id: int,
    person_id: int,
    *,
    is_admin: bool,
) -> Optional[dict]:
    payload = list_people_graph(
        conn,
        viewer_user_id,
        is_admin=is_admin,
    )
    person = next((p for p in payload["people"] if int(p["id"]) == person_id), None)
    if not person:
        return None
    media = conn.execute(
        "SELECT id, file_path, thumbnail_path, medium_path, original_filename, mime_type, "
        "       checksum, width, height, visibility_level, created_at "
        "FROM person_media WHERE person_id = ? ORDER BY id DESC",
        (person_id,),
    ).fetchall()
    events = conn.execute(
        "SELECT id, event_type, event_date, date_precision, label, value, source, created_at "
        "FROM person_events WHERE person_id = ? ORDER BY id DESC",
        (person_id,),
    ).fetchall()
    facts = conn.execute(
        "SELECT id, predicate, value, category, kind, status, confidence, created_at, updated_at "
        "FROM facts WHERE subject_ref_id = ? ORDER BY updated_at DESC",
        (person_id,),
    ).fetchall()
    edges = [
        e for e in payload["edges"]
        if int(e["from_person_id"]) == person_id or int(e["to_person_id"]) == person_id
    ]
    return {
        "person": person,
        "media": [dict(r) for r in media],
        "events": [dict(r) for r in events],
        "facts": [dict(r) for r in facts],
        "edges": edges,
    }


def create_person_graph(
    conn: sqlite3.Connection,
    creator_user_id: int,
    *,
    name: str,
    bucket: str = "family",
    living_status: str = "unknown",
    birth_date: Optional[str] = None,
    death_date: Optional[str] = None,
    aliases: Optional[list[str]] = None,
) -> int:
    cur = conn.execute(
        "INSERT INTO people (owner_user_id, name, bucket, living_status, birth_date, death_date, aliases) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        (
            creator_user_id,
            name.strip(),
            bucket,
            living_status,
            birth_date,
            death_date,
            json.dumps(aliases or []),
        ),
    )
    person_id = int(cur.lastrowid)
    _ensure_overlay(conn, creator_user_id, person_id)
    conn.execute(
        "UPDATE person_overlays SET visibility_level = 'full' WHERE viewer_user_id = ? AND person_id = ?",
        (creator_user_id, person_id),
    )
    conn.commit()
    return person_id


def patch_person_graph(
    conn: sqlite3.Connection,
    person_id: int,
    *,
    name: Optional[str] = None,
    bucket: Optional[str] = None,
    living_status: Optional[str] = None,
    birth_date: Optional[str] = None,
    death_date: Optional[str] = None,
    aliases: Optional[list[str]] = None,
) -> bool:
    sets: list[str] = []
    args: list[object] = []
    if name is not None:
        sets.append("name = ?")
        args.append(name.strip())
    if bucket is not None:
        sets.append("bucket = ?")
        args.append(bucket)
    if living_status is not None:
        sets.append("living_status = ?")
        args.append(living_status)
    if birth_date is not None:
        sets.append("birth_date = ?")
        args.append(birth_date)
    if death_date is not None:
        sets.append("death_date = ?")
        args.append(death_date)
    if aliases is not None:
        sets.append("aliases = ?")
        args.append(json.dumps(aliases))
    if not sets:
        return False
    args.append(person_id)
    cur = conn.execute(
        f"UPDATE people SET {', '.join(sets)} WHERE id = ?",
        args,
    )
    conn.commit()
    return cur.rowcount > 0


def set_person_overlay(
    conn: sqlite3.Connection,
    viewer_user_id: int,
    person_id: int,
    *,
    relationship_state: Optional[str] = None,
    interaction_preference: Optional[str] = None,
    visibility_level: Optional[str] = None,
) -> bool:
    _ensure_overlay(conn, viewer_user_id, person_id)
    sets = ["updated_at = datetime('now')"]
    args: list[object] = []
    if relationship_state is not None:
        sets.append("relationship_state = ?")
        args.append(relationship_state)
    if interaction_preference is not None:
        sets.append("interaction_preference = ?")
        args.append(interaction_preference)
    if visibility_level is not None:
        sets.append("visibility_level = ?")
        args.append(visibility_level)
    args.extend([viewer_user_id, person_id])
    cur = conn.execute(
        f"UPDATE person_overlays SET {', '.join(sets)} "
        "WHERE viewer_user_id = ? AND person_id = ?",
        args,
    )
    conn.commit()
    return cur.rowcount > 0


def create_person_edge(
    conn: sqlite3.Connection,
    creator_user_id: int,
    *,
    from_person_id: int,
    to_person_id: int,
    edge_type: str,
    provenance: str = "manual",
    confidence: float = 0.6,
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
) -> int:
    cur = conn.execute(
        "INSERT INTO person_relationship_edges "
        "(creator_user_id, from_person_id, to_person_id, edge_type, start_date, end_date, confidence, provenance) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (
            creator_user_id,
            from_person_id,
            to_person_id,
            edge_type,
            start_date,
            end_date,
            confidence,
            provenance,
        ),
    )
    conn.commit()
    return int(cur.lastrowid)


# ---- relation string → edge_type mapping ----------------------------------

_SIBLING_TERMS = frozenset({
    "brother", "sister", "sibling", "half-brother", "half-sister",
    "step-brother", "step-sister", "stepsister", "stepbrother",
    "twin", "bro", "sis",
})
_PARENT_TERMS = frozenset({
    "mother", "father", "parent", "mom", "dad", "mama", "papa",
    "step-mom", "step-dad", "stepmom", "stepdad", "step-mother",
    "step-father", "stepmother", "stepfather",
})
_CHILD_TERMS = frozenset({
    "son", "daughter", "child", "kid", "step-son", "step-daughter",
    "stepson", "stepdaughter",
})
_SPOUSE_TERMS = frozenset({
    "spouse", "wife", "husband", "partner", "fiancé", "fiancée",
    "fiance", "fiancee", "ex", "ex-wife", "ex-husband",
})
_GRANDPARENT_TERMS = frozenset({
    "grandmother", "grandfather", "grandparent", "grandma", "grandpa",
    "nana", "nanny", "granny", "pop-pop", "abuela", "abuelo",
})
_GRANDCHILD_TERMS = frozenset({
    "grandson", "granddaughter", "grandchild", "grandkid",
})


def relation_to_edge_type(relation: str) -> tuple[str, bool]:
    """Map a freeform relation string to a graph edge_type.

    Returns ``(edge_type, is_inverted)`` where ``is_inverted`` is True
    when the edge should point *from* the related person *to* the user's
    self-person (e.g. "mother" means that person is a parent of the user,
    so the edge is ``parent_person → user`` with ``edge_type='mother'``).

    The original relation string is preserved as the edge_type so it
    remains human-readable in the graph. Directionality is handled by
    ``is_inverted`` so the graph topology is correct for traversal.
    """
    key = relation.strip().lower()
    # Preserve the original label but determine directionality.
    label = relation.strip() or key
    if key in _PARENT_TERMS:
        # "my mother" → she is parent of me → edge from her to me
        return label, True
    if key in _GRANDPARENT_TERMS:
        return label, True
    if key in _CHILD_TERMS:
        # "my son" → I am parent of him → edge from me to him
        return label, False
    if key in _GRANDCHILD_TERMS:
        return label, False
    # Siblings, spouses, friends, coworkers, etc. — not inverted.
    return label, False


def upsert_person_edge(
    conn: sqlite3.Connection,
    creator_user_id: int,
    *,
    from_person_id: int,
    to_person_id: int,
    edge_type: str,
    provenance: str = "conversation",
    confidence: float = 0.6,
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
) -> int:
    """Insert a graph edge or bump confidence if it already exists.

    Dedup key is ``(from_person_id, to_person_id, edge_type)``.
    """
    existing = conn.execute(
        "SELECT id, confidence FROM person_relationship_edges "
        "WHERE from_person_id = ? AND to_person_id = ? AND edge_type = ?",
        (from_person_id, to_person_id, edge_type),
    ).fetchone()
    if existing:
        from lokidoki.core.confidence import update_confidence

        new_conf = update_confidence(float(existing["confidence"]), confirmed=True)
        conn.execute(
            "UPDATE person_relationship_edges SET confidence = ? WHERE id = ?",
            (new_conf, existing["id"]),
        )
        conn.commit()
        return int(existing["id"])
    cur = conn.execute(
        "INSERT INTO person_relationship_edges "
        "(creator_user_id, from_person_id, to_person_id, edge_type, "
        "start_date, end_date, confidence, provenance) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (creator_user_id, from_person_id, to_person_id, edge_type,
         start_date, end_date, confidence, provenance),
    )
    conn.commit()
    return int(cur.lastrowid)


def ensure_user_self_person(
    conn: sqlite3.Connection, *, user_id: int
) -> int:
    """Return the user's linked person_id, creating one if needed.

    First tries auto-linking by name match. If that fails, creates a
    self-person using the user's username as the name and links it.
    """
    linked = _get_or_autolink_person(conn, user_id)
    if linked is not None:
        return linked
    row = conn.execute("SELECT username FROM users WHERE id = ?", (user_id,)).fetchone()
    name = (row["username"] if row else "Me").strip() or "Me"
    person_id = create_person_graph(conn, user_id, name=name, bucket="family", living_status="living")
    link_user_to_person(conn, user_id=user_id, person_id=person_id)
    return person_id


def _try_auto_link_user(conn: sqlite3.Connection, user_id: int) -> Optional[int]:
    """Try to auto-link a user to their person node by name match.

    Looks for a person owned by this user whose name contains the
    user's username. If exactly one match is found, links them.
    Returns the linked person_id or None.
    """
    row = conn.execute("SELECT username FROM users WHERE id = ?", (user_id,)).fetchone()
    if not row:
        return None
    username = (row["username"] or "").strip().lower()
    if not username or len(username) < 2:
        return None
    # Find people whose name contains the username.
    candidates = conn.execute(
        "SELECT id, name FROM people WHERE owner_user_id = ? AND LOWER(name) LIKE ?",
        (user_id, f"%{username}%"),
    ).fetchall()
    if len(candidates) == 1:
        person_id = int(candidates[0]["id"])
        link_user_to_person(conn, user_id=user_id, person_id=person_id)
        return person_id
    return None


def _get_or_autolink_person(conn: sqlite3.Connection, user_id: int) -> Optional[int]:
    """Get the user's linked person, trying auto-link if none exists."""
    linked = get_linked_person_id(conn, user_id)
    if linked is not None:
        return linked
    return _try_auto_link_user(conn, user_id)


def list_relationships_from_edges(
    conn: sqlite3.Connection, user_id: int
) -> list[dict]:
    """Return relationships in the legacy shape from graph edges.

    Returns dicts with keys: id, relation, confidence, created_at,
    person_id, person_name — same shape as the old
    ``memory_people_sql.list_relationships()``.
    """
    linked = _get_or_autolink_person(conn, user_id)
    if linked is None:
        return []
    rows = conn.execute(
        "SELECT e.id, e.edge_type, e.confidence, e.created_at, "
        "       e.from_person_id, e.to_person_id, "
        "       fp.name AS from_name, tp.name AS to_name "
        "FROM person_relationship_edges e "
        "JOIN people fp ON fp.id = e.from_person_id "
        "JOIN people tp ON tp.id = e.to_person_id "
        "WHERE e.from_person_id = ? OR e.to_person_id = ? "
        "ORDER BY e.edge_type, e.id",
        (linked, linked),
    ).fetchall()
    result: list[dict] = []
    for r in rows:
        from_id = int(r["from_person_id"])
        to_id = int(r["to_person_id"])
        if from_id == linked:
            person_id = to_id
            person_name = r["to_name"]
        else:
            person_id = from_id
            person_name = r["from_name"]
        result.append({
            "id": int(r["id"]),
            "relation": r["edge_type"],
            "confidence": float(r["confidence"]),
            "created_at": r["created_at"],
            "person_id": person_id,
            "person_name": person_name,
        })
    return result


def create_person_event(
    conn: sqlite3.Connection,
    *,
    person_id: int,
    event_type: str,
    event_date: Optional[str],
    date_precision: str = "exact",
    label: str = "",
    value: str = "",
    source: str = "manual",
) -> int:
    cur = conn.execute(
        "INSERT INTO person_events "
        "(person_id, event_type, event_date, date_precision, label, value, source) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        (person_id, event_type, event_date, date_precision, label, value, source),
    )
    conn.commit()
    return int(cur.lastrowid)


def link_user_to_person(
    conn: sqlite3.Connection, *, user_id: int, person_id: int
) -> bool:
    conn.execute(
        "INSERT INTO person_user_links (user_id, person_id) VALUES (?, ?) "
        "ON CONFLICT(user_id) DO UPDATE SET person_id = excluded.person_id",
        (user_id, person_id),
    )
    conn.commit()
    return True


def get_linked_person_id(conn: sqlite3.Connection, user_id: int) -> Optional[int]:
    row = conn.execute(
        "SELECT person_id FROM person_user_links WHERE user_id = ?",
        (user_id,),
    ).fetchone()
    return int(row["person_id"]) if row else None


def create_person_media_row(
    conn: sqlite3.Connection,
    *,
    person_id: int,
    file_path: str,
    thumbnail_path: str,
    medium_path: str,
    original_filename: str,
    mime_type: str,
    checksum: str,
    width: Optional[int] = None,
    height: Optional[int] = None,
    source: str = "upload",
    visibility_level: str = "full",
) -> int:
    existing = conn.execute(
        "SELECT id FROM person_media WHERE person_id = ? AND checksum = ?",
        (person_id, checksum),
    ).fetchone()
    if existing:
        return int(existing["id"])
    cur = conn.execute(
        "INSERT INTO person_media "
        "(person_id, file_path, thumbnail_path, medium_path, original_filename, mime_type, checksum, width, height, source, visibility_level) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (
            person_id,
            file_path,
            thumbnail_path,
            medium_path,
            original_filename,
            mime_type,
            checksum,
            width,
            height,
            source,
            visibility_level,
        ),
    )
    conn.commit()
    return int(cur.lastrowid)


def set_preferred_person_media(
    conn: sqlite3.Connection, *, person_id: int, media_id: int
) -> bool:
    cur = conn.execute(
        "UPDATE people SET preferred_photo_id = ? WHERE id = ?",
        (media_id, person_id),
    )
    conn.commit()
    return cur.rowcount > 0


def set_user_profile_media(
    conn: sqlite3.Connection, *, user_id: int, media_id: int
) -> bool:
    cur = conn.execute(
        "UPDATE users SET profile_media_id = ? WHERE id = ?",
        (media_id, user_id),
    )
    conn.commit()
    return cur.rowcount > 0


def merge_graph_people(
    conn: sqlite3.Connection,
    *,
    source_id: int,
    into_id: int,
) -> bool:
    if source_id == into_id:
        return False
    src = conn.execute("SELECT id, preferred_photo_id FROM people WHERE id = ?", (source_id,)).fetchone()
    dst = conn.execute("SELECT id, preferred_photo_id FROM people WHERE id = ?", (into_id,)).fetchone()
    if not src or not dst:
        return False
    conn.execute(
        "UPDATE facts SET subject_ref_id = ?, subject = (SELECT LOWER(name) FROM people WHERE id = ?) "
        "WHERE subject_ref_id = ?",
        (into_id, into_id, source_id),
    )
    conn.execute(
        "UPDATE OR IGNORE person_overlays SET person_id = ? WHERE person_id = ?",
        (into_id, source_id),
    )
    conn.execute("DELETE FROM person_overlays WHERE person_id = ?", (source_id,))
    conn.execute(
        "UPDATE OR IGNORE person_user_links SET person_id = ? WHERE person_id = ?",
        (into_id, source_id),
    )
    conn.execute(
        "UPDATE person_events SET person_id = ? WHERE person_id = ?",
        (into_id, source_id),
    )
    conn.execute(
        "UPDATE OR IGNORE person_media SET person_id = ? WHERE person_id = ?",
        (into_id, source_id),
    )
    conn.execute(
        "UPDATE OR IGNORE person_relationship_edges SET from_person_id = ? WHERE from_person_id = ?",
        (into_id, source_id),
    )
    conn.execute(
        "UPDATE OR IGNORE person_relationship_edges SET to_person_id = ? WHERE to_person_id = ?",
        (into_id, source_id),
    )
    conn.execute(
        "DELETE FROM person_relationship_edges WHERE from_person_id = to_person_id"
    )
    conn.execute(
        "UPDATE OR IGNORE relationships SET person_id = ? WHERE person_id = ?",
        (into_id, source_id),
    )
    conn.execute("DELETE FROM relationships WHERE person_id = ?", (source_id,))
    if dst["preferred_photo_id"] is None and src["preferred_photo_id"] is not None:
        conn.execute(
            "UPDATE people SET preferred_photo_id = ? WHERE id = ?",
            (src["preferred_photo_id"], into_id),
        )
    conn.execute("DELETE FROM people WHERE id = ?", (source_id,))
    conn.commit()
    return True


def list_reconcile_candidates(
    conn: sqlite3.Connection,
    *,
    viewer_user_id: int,
    is_admin: bool,
) -> list[dict]:
    rows = conn.execute(
        "SELECT id, name, birth_date, owner_user_id FROM people ORDER BY LOWER(name), id"
    ).fetchall()
    groups: dict[tuple[str, str], list[dict]] = {}
    for row in rows:
        name_key = (row["name"] or "").strip().lower()
        birth_key = (row["birth_date"] or "").strip()
        if not name_key:
            continue
        groups.setdefault((name_key, birth_key), []).append(dict(row))
    out: list[dict] = []
    for (_, _), people in groups.items():
        if len(people) < 2:
            continue
        if not is_admin and not any(int(p["owner_user_id"]) == viewer_user_id for p in people):
            continue
        snapshots = [
            _reconcile_snapshot(conn, person_id=int(person["id"]), viewer_user_id=viewer_user_id)
            for person in people
        ]
        candidates = [candidate for candidate in snapshots if candidate]
        if len(candidates) < 2:
            continue
        suggested_target = max(candidates, key=_reconcile_score)
        suggestion_reason = (
            "linked to an app user"
            if suggested_target.get("linked_user_id")
            else "has the richest existing profile"
        )
        out.append(
            {
                "label": people[0]["name"],
                "suggested_target_id": int(suggested_target["id"]),
                "suggestion_reason": suggestion_reason,
                "candidates": candidates,
            }
        )
    return out


def list_user_graph_relations(
    conn: sqlite3.Connection,
    *,
    user_id: int,
) -> list[str]:
    """Build a human-readable list of the user's relationships from graph edges.

    Returns lines like ``"- brother: Luke"`` for injection into the
    synthesis prompt's GRAPH_RELATIONSHIPS block. Handles both freeform
    edge_types (``brother``, ``coworker``) and structural parent-chain
    sibling inference.
    """
    linked = _get_or_autolink_person(conn, user_id)
    if linked is None:
        # No linked person and auto-link failed. Fall back to listing
        # ALL edges created by this user so relationships still appear
        # in the synthesis prompt.
        rows = conn.execute(
            "SELECT e.edge_type, fp.name AS from_name, tp.name AS to_name "
            "FROM person_relationship_edges e "
            "JOIN people fp ON fp.id = e.from_person_id "
            "JOIN people tp ON tp.id = e.to_person_id "
            "WHERE e.creator_user_id = ? "
            "ORDER BY e.edge_type, e.id",
            (user_id,),
        ).fetchall()
        seen = set()
        lines: list[str] = []
        for r in rows:
            key = (r["from_name"], r["to_name"], r["edge_type"])
            rev = (r["to_name"], r["from_name"], r["edge_type"])
            if key in seen or rev in seen:
                continue
            seen.add(key)
            lines.append(f"- {r['edge_type']}: {r['from_name']} → {r['to_name']}")
        return lines

    person_name_row = conn.execute(
        "SELECT name FROM people WHERE id = ?", (linked,)
    ).fetchone()
    if not person_name_row:
        return []

    lines: list[str] = []
    seen_person_ids: set[int] = set()

    # Outgoing edges: user → other person.
    outgoing = conn.execute(
        "SELECT e.edge_type, e.to_person_id, p.name "
        "FROM person_relationship_edges e "
        "JOIN people p ON p.id = e.to_person_id "
        "WHERE e.from_person_id = ? "
        "ORDER BY e.edge_type, e.id",
        (linked,),
    ).fetchall()
    parent_terms_low = {t.lower() for t in _PARENT_TERMS}
    child_terms_low = {t.lower() for t in _CHILD_TERMS}
    for row in outgoing:
        edge_type = (row["edge_type"] or "").strip()
        name = (row["name"] or "").strip()
        pid = int(row["to_person_id"])
        seen_person_ids.add(pid)
        if not name or name.startswith("@") or name.lower().startswith("unnamed"):
            continue
        # Invert structural labels for outgoing edges:
        # outgoing "parent" edge → I am parent of target → target is my child
        # outgoing "child" edge → I am child of target → target is my parent
        et_low = edge_type.lower()
        if et_low in parent_terms_low or et_low == "parent":
            label = "child (son/daughter)"
        elif et_low in child_terms_low or et_low == "child":
            label = "parent (mother/father)"
        else:
            label = edge_type
        lines.append(f"- {label}: {name}")

    # Incoming edges: other person → user (these are inverted relations
    # like "mother" → edge from mother to user).
    incoming = conn.execute(
        "SELECT e.edge_type, e.from_person_id, p.name "
        "FROM person_relationship_edges e "
        "JOIN people p ON p.id = e.from_person_id "
        "WHERE e.to_person_id = ? "
        "ORDER BY e.edge_type, e.id",
        (linked,),
    ).fetchall()
    for row in incoming:
        edge_type = (row["edge_type"] or "").strip()
        name = (row["name"] or "").strip()
        pid = int(row["from_person_id"])
        if pid in seen_person_ids:
            continue
        seen_person_ids.add(pid)
        if not name or name.startswith("@") or name.lower().startswith("unnamed"):
            continue
        # Add clarifying synonyms for structural types.
        et_low = edge_type.lower()
        if et_low == "parent" or et_low in parent_terms_low:
            label = f"{edge_type} (mother/father)"
        elif et_low == "child" or et_low in child_terms_low:
            label = f"{edge_type} (son/daughter)"
        elif et_low == "spouse" or et_low in {t.lower() for t in _SPOUSE_TERMS}:
            label = f"{edge_type} (wife/husband)"
        else:
            label = edge_type
        lines.append(f"- {label}: {name}")

    # Sibling inference via shared parents. Find parents of the user
    # (edges where the user is a "child" of someone, OR someone is a
    # parent-type of the user via an incoming edge).
    parent_terms_low = {t.lower() for t in _PARENT_TERMS}
    parent_ids: list[int] = []
    # Outgoing "child" edges from user → parent.
    for row in outgoing:
        et = (row["edge_type"] or "").strip().lower()
        if et == "child" or et in _CHILD_TERMS:
            parent_ids.append(int(row["to_person_id"]))
    # Incoming parent-type edges from parent → user.
    for row in incoming:
        et = (row["edge_type"] or "").strip().lower()
        if et in parent_terms_low or et == "parent":
            parent_ids.append(int(row["from_person_id"]))
    parent_ids = sorted(set(parent_ids))

    if parent_ids:
        placeholders = ",".join("?" for _ in parent_ids)
        # Find other children of the same parents (siblings).
        sibling_rows = list(
            conn.execute(
                "SELECT DISTINCT p.id, p.name FROM person_relationship_edges e "
                "JOIN people p ON p.id = e.from_person_id "
                "WHERE e.edge_type = 'child' AND e.to_person_id IN (" + placeholders + ") "
                "AND e.from_person_id != ?",
                (*parent_ids, linked),
            ).fetchall()
        )
        # Also check for parent-type incoming edges to those same parents.
        for pid in parent_ids:
            sibling_rows.extend(
                conn.execute(
                    "SELECT DISTINCT p.id, p.name FROM person_relationship_edges e "
                    "JOIN people p ON p.id = e.to_person_id "
                    "WHERE LOWER(e.edge_type) IN ('parent', " + ",".join("?" for _ in parent_terms_low) + ") "
                    "AND e.from_person_id = ? AND e.to_person_id != ?",
                    (*parent_terms_low, pid, linked),
                ).fetchall()
            )
        for sibling in sibling_rows:
            sid = int(sibling["id"])
            sname = (sibling["name"] or "").strip()
            if sid in seen_person_ids:
                continue
            seen_person_ids.add(sid)
            if not sname or sname.startswith("@") or sname.lower().startswith("unnamed"):
                continue
            lines.append(f"- sibling (sister/brother): {sname}")

    return lines


def get_user_profile(conn: sqlite3.Connection, user_id: int) -> dict:
    row = conn.execute(
        "SELECT u.profile_media_id, pm.medium_path AS profile_photo_path, "
        "       pul.person_id, p.name AS person_name "
        "FROM users u "
        "LEFT JOIN person_user_links pul ON pul.user_id = u.id "
        "LEFT JOIN people p ON p.id = pul.person_id "
        "LEFT JOIN person_media pm ON pm.id = u.profile_media_id "
        "WHERE u.id = ?",
        (user_id,),
    ).fetchone()
    return dict(row) if row else {
        "profile_media_id": None,
        "profile_photo_path": None,
        "person_id": None,
        "person_name": None,
    }


def list_profile_photo_options(
    conn: sqlite3.Connection, *, user_id: int
) -> list[sqlite3.Row]:
    person_id = get_linked_person_id(conn, user_id)
    if person_id is None:
        return []
    return conn.execute(
        "SELECT id, file_path, thumbnail_path, medium_path, original_filename, created_at "
        "FROM person_media WHERE person_id = ? AND visibility_level != 'hidden' "
        "ORDER BY id DESC",
        (person_id,),
    ).fetchall()


def record_gedcom_import_job(
    conn: sqlite3.Connection, *, admin_user_id: int, filename: str, summary: dict
) -> int:
    cur = conn.execute(
        "INSERT INTO gedcom_import_jobs (admin_user_id, filename, summary_json) VALUES (?, ?, ?)",
        (admin_user_id, filename, json.dumps(summary)),
    )
    conn.commit()
    return int(cur.lastrowid)


def record_gedcom_export_job(
    conn: sqlite3.Connection, *, admin_user_id: int, summary: dict
) -> int:
    cur = conn.execute(
        "INSERT INTO gedcom_export_jobs (admin_user_id, summary_json) VALUES (?, ?)",
        (admin_user_id, json.dumps(summary)),
    )
    conn.commit()
    return int(cur.lastrowid)


def sha1_bytes(data: bytes) -> str:
    return hashlib.sha1(data).hexdigest()
