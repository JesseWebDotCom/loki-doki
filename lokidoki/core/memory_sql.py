"""Synchronous SQL helpers for the MemoryProvider.

These are plain functions that take a ``sqlite3.Connection`` and do one
focused operation. They live here so ``memory_provider.py`` stays under
the 250-line ceiling and so the SQL is easy to read in one place.

Every function is user-scoped: ``user_id`` is always part of the WHERE
clause for reads and the column list for writes. This is the single
choke point that enforces the multi-user isolation requirement from
PR1, so any new query MUST keep the same shape.
"""
from __future__ import annotations

from __future__ import annotations
import sqlite3
from typing import Optional, Union

from lokidoki.core.confidence import DEFAULT_CONFIDENCE, update_confidence
from lokidoki.core.memory_contradiction import detect_and_resolve_contradiction


def get_or_create_user(conn: sqlite3.Connection, username: str) -> int:
    row = conn.execute(
        "SELECT id FROM users WHERE username = ?", (username,)
    ).fetchone()
    if row:
        return int(row["id"])
    cur = conn.execute("INSERT INTO users (username) VALUES (?)", (username,))
    conn.commit()
    return int(cur.lastrowid)


def create_session(
    conn: sqlite3.Connection, user_id: int, title: str, project_id: Optional[int] = None
) -> int:
    cur = conn.execute(
        "INSERT INTO sessions (owner_user_id, title, project_id) VALUES (?, ?, ?)",
        (user_id, title, project_id),
    )
    conn.commit()
    return int(cur.lastrowid)


def list_sessions(
    conn: sqlite3.Connection, user_id: int, project_id: Optional[int] = None
) -> list[sqlite3.Row]:
    if project_id is not None:
        return conn.execute(
            "SELECT id, title, project_id, created_at FROM sessions "
            "WHERE owner_user_id = ? AND project_id = ? ORDER BY id DESC",
            (user_id, project_id),
        ).fetchall()
    return conn.execute(
        "SELECT id, title, project_id, created_at FROM sessions "
        "WHERE owner_user_id = ? ORDER BY id DESC",
        (user_id,),
    ).fetchall()


def update_session_title(
    conn: sqlite3.Connection, user_id: int, session_id: int, title: str
) -> bool:
    cur = conn.execute(
        "UPDATE sessions SET title = ? WHERE id = ? AND owner_user_id = ?",
        (title, session_id, user_id),
    )
    conn.commit()
    return cur.rowcount > 0


def move_session_to_project(
    conn: sqlite3.Connection, user_id: int, session_id: int, project_id: Optional[int]
) -> bool:
    cur = conn.execute(
        "UPDATE sessions SET project_id = ? WHERE id = ? AND owner_user_id = ?",
        (project_id, session_id, user_id),
    )
    conn.commit()
    return cur.rowcount > 0


def add_message(
    conn: sqlite3.Connection,
    *,
    user_id: int,
    session_id: int,
    role: str,
    content: str,
) -> int:
    cur = conn.execute(
        "INSERT INTO messages (session_id, owner_user_id, role, content) "
        "VALUES (?, ?, ?, ?)",
        (session_id, user_id, role, content),
    )
    conn.commit()
    return int(cur.lastrowid)


def get_messages(
    conn: sqlite3.Connection,
    *,
    user_id: int,
    session_id: int,
    limit: int ,
) -> list[sqlite3.Row]:
    if limit:
        rows = conn.execute(
            "SELECT id, role, content, created_at FROM messages "
            "WHERE owner_user_id = ? AND session_id = ? "
            "ORDER BY id DESC LIMIT ?",
            (user_id, session_id, limit),
        ).fetchall()
        return rows[::-1]
    return conn.execute(
        "SELECT id, role, content, created_at FROM messages "
        "WHERE owner_user_id = ? AND session_id = ? ORDER BY id ASC",
        (user_id, session_id),
    ).fetchall()


def upsert_fact(
    conn: sqlite3.Connection,
    *,
    user_id: int,
    subject: str,
    predicate: str,
    value: str,
    category: str,
    source_message_id: Optional[int],
    subject_type: str = "self",
    subject_ref_id: Optional[int] = None,
    project_id: Optional[int] = None,
    status: str = "active",
    ambiguity_group_id: Optional[int] = None,
    negates_previous: bool = False,
    kind: str = "fact",
) -> tuple[int, float, dict]:
    """Insert OR confirm OR revise. Returns (fact_id, confidence, report).

    The report describes any contradiction handling that happened, so the
    orchestrator can surface it via silent confirmation / clarification.
    """
    existing = conn.execute(
        "SELECT id, confidence, observation_count FROM facts "
        "WHERE owner_user_id = ? AND subject = ? AND predicate = ? AND value = ? "
        "AND status != 'rejected'",
        (user_id, subject, predicate, value),
    ).fetchone()
    if existing:
        new_conf = update_confidence(float(existing["confidence"]), confirmed=True)
        conn.execute(
            "UPDATE facts SET confidence = ?, observation_count = observation_count + 1, "
            "last_observed_at = datetime('now'), updated_at = datetime('now'), "
            "status = CASE WHEN status='rejected' THEN 'active' ELSE status END "
            "WHERE id = ?",
            (new_conf, existing["id"]),
        )
        conn.commit()
        return int(existing["id"]), float(new_conf), {
            "action": "confirmed", "loser_id": None, "loser_value": None, "margin": 0.0,
        }

    # No exact match — check for a contradicting same-(subject, predicate)
    # row before inserting. The contradiction handler updates the loser
    # in-place and returns a report we propagate to the caller.
    report = detect_and_resolve_contradiction(
        conn,
        user_id=user_id,
        subject=subject,
        subject_ref_id=subject_ref_id,
        predicate=predicate,
        new_value=value,
        negates_previous=negates_previous,
    )

    cur = conn.execute(
        "INSERT INTO facts "
        "(owner_user_id, subject, subject_type, subject_ref_id, "
        "predicate, value, kind, category, confidence, source_message_id, project_id, "
        "status, ambiguity_group_id) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (
            user_id, subject, subject_type, subject_ref_id,
            predicate, value, kind, category,
            DEFAULT_CONFIDENCE, source_message_id, project_id,
            status, ambiguity_group_id,
        ),
    )
    conn.commit()
    return int(cur.lastrowid), DEFAULT_CONFIDENCE, report


_FACT_COLS = (
    "id, subject, subject_type, subject_ref_id, predicate, value, kind, category, "
    "confidence, observation_count, last_observed_at, status, "
    "ambiguity_group_id, source_message_id, valid_from, valid_to, "
    "created_at, updated_at"
)


def list_facts(
    conn: sqlite3.Connection,
    user_id: int,
    limit: int,
    project_id: Optional[int] = None,
    include_statuses: tuple = ("active", "ambiguous"),
) -> list[sqlite3.Row]:
    placeholders = ",".join("?" * len(include_statuses))
    if project_id is not None:
        return conn.execute(
            f"SELECT {_FACT_COLS} FROM facts "
            f"WHERE owner_user_id = ? AND project_id = ? AND status IN ({placeholders}) "
            "ORDER BY updated_at DESC LIMIT ?",
            (user_id, project_id, *include_statuses, limit),
        ).fetchall()
    return conn.execute(
        f"SELECT {_FACT_COLS} FROM facts "
        f"WHERE owner_user_id = ? AND status IN ({placeholders}) "
        "ORDER BY updated_at DESC LIMIT ?",
        (user_id, *include_statuses, limit),
    ).fetchall()


def list_facts_by_status(
    conn: sqlite3.Connection,
    user_id: int,
    statuses: tuple,
    limit: int = 500,
) -> list[sqlite3.Row]:
    placeholders = ",".join("?" * len(statuses))
    return conn.execute(
        f"SELECT {_FACT_COLS} FROM facts "
        f"WHERE owner_user_id = ? AND status IN ({placeholders}) "
        "ORDER BY updated_at DESC LIMIT ?",
        (user_id, *statuses, limit),
    ).fetchall()


def get_fact(conn: sqlite3.Connection, user_id: int, fact_id: int) -> Optional[sqlite3.Row]:
    return conn.execute(
        f"SELECT {_FACT_COLS} FROM facts WHERE owner_user_id = ? AND id = ?",
        (user_id, fact_id),
    ).fetchone()


def confirm_fact(conn: sqlite3.Connection, user_id: int, fact_id: int) -> Optional[float]:
    row = conn.execute(
        "SELECT confidence FROM facts WHERE owner_user_id = ? AND id = ?",
        (user_id, fact_id),
    ).fetchone()
    if not row:
        return None
    new_conf = update_confidence(float(row["confidence"]), confirmed=True)
    conn.execute(
        "UPDATE facts SET confidence = ?, observation_count = observation_count + 1, "
        "last_observed_at = datetime('now'), updated_at = datetime('now'), "
        "status = CASE WHEN status='rejected' THEN 'active' ELSE status END "
        "WHERE id = ?",
        (new_conf, fact_id),
    )
    conn.commit()
    return new_conf


def reject_fact(conn: sqlite3.Connection, user_id: int, fact_id: int) -> bool:
    cur = conn.execute(
        "UPDATE facts SET status = 'rejected', "
        "confidence = MAX(?, confidence * 0.3), updated_at = datetime('now') "
        "WHERE owner_user_id = ? AND id = ?",
        (MIN_CONF_FLOOR, user_id, fact_id),
    )
    conn.commit()
    return cur.rowcount > 0


def delete_fact(conn: sqlite3.Connection, user_id: int, fact_id: int) -> bool:
    cur = conn.execute(
        "DELETE FROM facts WHERE owner_user_id = ? AND id = ?",
        (user_id, fact_id),
    )
    conn.commit()
    return cur.rowcount > 0


def patch_fact(
    conn: sqlite3.Connection,
    user_id: int,
    fact_id: int,
    *,
    value: Optional[str] = None,
    predicate: Optional[str] = None,
    subject: Optional[str] = None,
    subject_ref_id: Optional[int] = None,
    subject_type: Optional[str] = None,
    status: Optional[str] = None,
) -> bool:
    sets = []
    args: list = []
    if value is not None:
        sets.append("value = ?"); args.append(value)
    if predicate is not None:
        sets.append("predicate = ?"); args.append(predicate)
    if subject is not None:
        sets.append("subject = ?"); args.append(subject)
    if subject_ref_id is not None:
        sets.append("subject_ref_id = ?"); args.append(subject_ref_id)
    if subject_type is not None:
        sets.append("subject_type = ?"); args.append(subject_type)
    if status is not None:
        sets.append("status = ?"); args.append(status)
    if not sets:
        return False
    sets.append("updated_at = datetime('now')")
    args.extend([user_id, fact_id])
    cur = conn.execute(
        f"UPDATE facts SET {', '.join(sets)} WHERE owner_user_id = ? AND id = ?",
        args,
    )
    conn.commit()
    return cur.rowcount > 0


MIN_CONF_FLOOR = 0.05


def search_facts(
    conn: sqlite3.Connection,
    user_id: int,
    fts_query: str,
    top_k: int,
    project_id: Optional[int] = None,
) -> list[sqlite3.Row]:
    if project_id is not None:
        return conn.execute(
            "SELECT f.id, f.subject, f.predicate, f.value, f.category, "
            "       f.confidence, f.last_observed_at, f.status, f.created_at, "
            "       bm25(facts_fts) * (CASE WHEN f.project_id = ? THEN 0.5 ELSE 1.0 END) AS score "
            "FROM facts_fts JOIN facts f ON f.id = facts_fts.rowid "
            "WHERE facts_fts MATCH ? AND f.owner_user_id = ? "
            "AND f.status IN ('active','ambiguous') "
            "ORDER BY score LIMIT ?",
            (project_id, fts_query, user_id, top_k),
        ).fetchall()
    return conn.execute(
        "SELECT f.id, f.subject, f.predicate, f.value, f.category, "
        "       f.confidence, f.last_observed_at, f.status, f.created_at, "
        "       bm25(facts_fts) AS score "
        "FROM facts_fts JOIN facts f ON f.id = facts_fts.rowid "
        "WHERE facts_fts MATCH ? AND f.owner_user_id = ? "
        "AND f.status IN ('active','ambiguous') "
        "ORDER BY score LIMIT ?",
        (fts_query, user_id, top_k),
    ).fetchall()


_PROJECT_COLS = "id, name, description, prompt, icon, icon_color, created_at"


def create_project(
    conn: sqlite3.Connection,
    user_id: int,
    name: str,
    description: str = "",
    prompt: str = "",
    icon: str = "Folder",
    icon_color: str = "swatch-1",
) -> int:
    cur = conn.execute(
        "INSERT INTO projects (owner_user_id, name, description, prompt, icon, icon_color) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        (user_id, name, description, prompt, icon, icon_color),
    )
    conn.commit()
    return int(cur.lastrowid)


def list_projects(conn: sqlite3.Connection, user_id: int) -> list[sqlite3.Row]:
    return conn.execute(
        f"SELECT {_PROJECT_COLS} FROM projects "
        "WHERE owner_user_id = ? ORDER BY name ASC",
        (user_id,),
    ).fetchall()


def get_project(
    conn: sqlite3.Connection, user_id: int, project_id: int
) -> Optional[sqlite3.Row]:
    return conn.execute(
        f"SELECT {_PROJECT_COLS} FROM projects "
        "WHERE id = ? AND owner_user_id = ?",
        (project_id, user_id),
    ).fetchone()


def update_project(
    conn: sqlite3.Connection,
    user_id: int,
    project_id: int,
    name: str,
    description: str,
    prompt: str,
    icon: str = "Folder",
    icon_color: str = "swatch-1",
) -> bool:
    cur = conn.execute(
        "UPDATE projects SET name = ?, description = ?, prompt = ?, "
        "icon = ?, icon_color = ? "
        "WHERE id = ? AND owner_user_id = ?",
        (name, description, prompt, icon, icon_color, project_id, user_id),
    )
    conn.commit()
    return cur.rowcount > 0


def delete_project(conn: sqlite3.Connection, user_id: int, project_id: int) -> bool:
    # NOTE: ON DELETE SET NULL on sessions and facts handles the cleanup
    cur = conn.execute(
        "DELETE FROM projects WHERE id = ? AND owner_user_id = ?",
        (project_id, user_id),
    )
    conn.commit()
    return cur.rowcount > 0


def search_messages(
    conn: sqlite3.Connection, user_id: int, fts_query: str, top_k: int
) -> list[sqlite3.Row]:
    return conn.execute(
        "SELECT m.id, m.role, m.content, m.created_at, "
        "       bm25(messages_fts) AS score "
        "FROM messages_fts JOIN messages m ON m.id = messages_fts.rowid "
        "WHERE messages_fts MATCH ? AND m.owner_user_id = ? "
        "ORDER BY score LIMIT ?",
        (fts_query, user_id, top_k),
    ).fetchall()


def fts_escape(query: str) -> str:
    """Wrap user input as quoted FTS5 phrase tokens.

    Stops a stray ``"`` or operator like ``AND`` from crashing the
    parser. Whitespace-split, drop empties, re-join as quoted tokens —
    implicit AND, no injection surface.
    """
    tokens = [t.replace('"', '') for t in query.split() if t.strip()]
    if not tokens:
        return '""'
    return " ".join(f'"{t}"' for t in tokens)
