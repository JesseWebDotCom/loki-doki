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
    linked = get_linked_person_id(conn, user_id)
    if linked is None:
        return []
    person_name_row = conn.execute("SELECT name FROM people WHERE id = ?", (linked,)).fetchone()
    if not person_name_row:
        return []
    lines: list[str] = []
    direct = conn.execute(
        "SELECT e.edge_type, e.to_person_id, p.name "
        "FROM person_relationship_edges e "
        "JOIN people p ON p.id = e.to_person_id "
        "WHERE e.from_person_id = ? "
        "ORDER BY e.id",
        (linked,),
    ).fetchall()
    for row in direct:
        edge_type = (row["edge_type"] or "").strip()
        if edge_type in {"spouse", "partner"}:
            lines.append(f"- {edge_type}: {row['name']}")
        elif edge_type == "parent":
            lines.append(f"- child: {row['name']}")
        elif edge_type == "child":
            lines.append(f"- parent: {row['name']}")
    parent_ids = [
        int(r["to_person_id"])
        for r in conn.execute(
            "SELECT to_person_id FROM person_relationship_edges WHERE from_person_id = ? AND edge_type = 'child'",
            (linked,),
        ).fetchall()
    ]
    parent_ids.extend(
        int(r["from_person_id"])
        for r in conn.execute(
            "SELECT from_person_id FROM person_relationship_edges WHERE to_person_id = ? AND edge_type = 'parent'",
            (linked,),
        ).fetchall()
    )
    parent_ids = sorted(set(parent_ids))
    if parent_ids:
        placeholders = ",".join("?" for _ in parent_ids)
        sibling_rows = list(
            conn.execute(
                "SELECT DISTINCT p.id, p.name FROM person_relationship_edges e "
                "JOIN people p ON p.id = e.from_person_id "
                "WHERE e.edge_type = 'child' AND e.to_person_id IN (" + placeholders + ") "
                "AND e.from_person_id != ?",
                (*parent_ids, linked),
            ).fetchall()
        )
        sibling_rows.extend(
            conn.execute(
                "SELECT DISTINCT p.id, p.name FROM person_relationship_edges e "
                "JOIN people p ON p.id = e.to_person_id "
                "WHERE e.edge_type = 'parent' AND e.from_person_id IN (" + placeholders + ") "
                "AND e.to_person_id != ?",
                (*parent_ids, linked),
            ).fetchall()
        )
        seen_ids: set[int] = set()
        siblings = []
        for sibling in sibling_rows:
            sibling_id = int(sibling["id"])
            if sibling_id in seen_ids:
                continue
            seen_ids.add(sibling_id)
            siblings.append(sibling)
        for sibling in siblings:
            lines.append(f"- sibling: {sibling['name']}")
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
