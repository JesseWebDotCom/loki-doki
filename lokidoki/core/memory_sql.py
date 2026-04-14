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
import json
import sqlite3
from typing import Optional, Union

from lokidoki.core.confidence import update_confidence


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
    embedding: Optional[list] = None,
) -> int:
    cur = conn.execute(
        "INSERT INTO messages (session_id, owner_user_id, role, content) "
        "VALUES (?, ?, ?, ?)",
        (session_id, user_id, role, content),
    )
    message_id = int(cur.lastrowid)
    # Optional vector write — only user-role messages get embedded
    # (the provider gates this), and only when sqlite-vec is loaded.
    # Failure here is non-fatal; search degrades to FTS5-only.
    if embedding is not None:
        try:
            import json as _json
            conn.execute(
                "INSERT INTO vec_messages (message_id, embedding) VALUES (?, ?)",
                (message_id, _json.dumps(embedding)),
            )
        except sqlite3.Error:
            pass
    conn.commit()
    return message_id


def add_chat_trace(
    conn: sqlite3.Connection,
    *,
    user_id: int,
    session_id: int,
    user_message_id: Optional[int],
    response_lane_actual: str,
    response_lane_planned: str,
    shadow_disagrees: bool,
    decomposition: dict,
    referent_resolution: dict,
    retrieved_memory_candidates: dict,
    selected_injected_memories: dict,
    skill_results: dict,
    prompt_sizes: dict,
    response_spec_shadow: dict,
    phase_latencies: dict,
) -> int:
    cur = conn.execute(
        "INSERT INTO chat_traces ("
        "owner_user_id, session_id, user_message_id, response_lane_actual, "
        "response_lane_planned, shadow_disagrees, decomposition_json, "
        "referent_resolution_json, retrieved_memory_candidates_json, "
        "selected_injected_memories_json, skill_results_json, prompt_sizes_json, "
        "response_spec_shadow_json, phase_latencies_json"
        ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (
            user_id,
            session_id,
            user_message_id,
            response_lane_actual,
            response_lane_planned,
            1 if shadow_disagrees else 0,
            json.dumps(decomposition),
            json.dumps(referent_resolution),
            json.dumps(retrieved_memory_candidates),
            json.dumps(selected_injected_memories),
            json.dumps(skill_results),
            json.dumps(prompt_sizes),
            json.dumps(response_spec_shadow),
            json.dumps(phase_latencies),
        ),
    )
    conn.commit()
    return int(cur.lastrowid)


def list_chat_traces(
    conn: sqlite3.Connection,
    *,
    user_id: int,
    session_id: Optional[int],
    limit: int,
) -> list[sqlite3.Row]:
    if session_id is None:
        return conn.execute(
            "SELECT * FROM chat_traces WHERE owner_user_id = ? "
            "ORDER BY id DESC LIMIT ?",
            (user_id, limit),
        ).fetchall()
    return conn.execute(
        "SELECT * FROM chat_traces WHERE owner_user_id = ? AND session_id = ? "
        "ORDER BY id DESC LIMIT ?",
        (user_id, session_id, limit),
    ).fetchall()


def get_messages(
    conn: sqlite3.Connection,
    *,
    user_id: int,
    session_id: int,
    limit: int ,
) -> list[sqlite3.Row]:
    # We join with chat_traces so the frontend can recover the 'steps' UI (planning, 
    # routing, etc) for historical turns. For a user message, the trace is 
    # directly linked. For an assistant message, we look for the trace attached 
    # to the preceding user message in the same session.
    query = """
        SELECT m.id, m.role, m.content, m.created_at,
               t.decomposition_json, t.referent_resolution_json, 
               t.skill_results_json, t.phase_latencies_json,
               t.response_lane_actual, t.prompt_sizes_json,
               t.response_spec_shadow_json
        FROM messages m
        LEFT JOIN chat_traces t ON (
            (m.role = 'user' AND t.user_message_id = m.id) OR
            (m.role = 'assistant' AND t.user_message_id = (
                SELECT id FROM messages 
                WHERE session_id = m.session_id AND id < m.id AND role = 'user' 
                ORDER BY id DESC LIMIT 1
            ))
        )
        WHERE m.owner_user_id = ? AND m.session_id = ?
    """
    if limit:
        rows = conn.execute(query + " ORDER BY m.id DESC LIMIT ?", (user_id, session_id, limit)).fetchall()
        return rows[::-1]
    return conn.execute(query + " ORDER BY m.id ASC", (user_id, session_id)).fetchall()


def get_message(
    conn: sqlite3.Connection,
    *,
    user_id: int,
    message_id: int,
) -> Optional[sqlite3.Row]:
    return conn.execute(
        "SELECT m.id, m.session_id, m.role, m.content, m.created_at, "
        "       t.decomposition_json, t.referent_resolution_json, "
        "       t.skill_results_json, t.phase_latencies_json "
        "FROM messages m "
        "LEFT JOIN chat_traces t ON (t.user_message_id = m.id) "
        "WHERE m.owner_user_id = ? AND m.id = ?",
        (user_id, message_id),
    ).fetchone()


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
            "SELECT f.id, f.subject, f.subject_type, f.predicate, f.value, f.category, "
            "       f.confidence, f.last_observed_at, f.status, f.created_at, "
            "       bm25(facts_fts) * (CASE WHEN f.project_id = ? THEN 0.5 ELSE 1.0 END) AS score "
            "FROM facts_fts JOIN facts f ON f.id = facts_fts.rowid "
            "WHERE facts_fts MATCH ? AND f.owner_user_id = ? "
            "AND f.status IN ('active','ambiguous') "
            "ORDER BY score LIMIT ?",
            (project_id, fts_query, user_id, top_k),
        ).fetchall()
    return conn.execute(
        "SELECT f.id, f.subject, f.subject_type, f.predicate, f.value, f.category, "
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
    # The unified facts/sessions schema in store_schema.py has no FK
    # REFERENCES to projects (so MemoryStore can run against DBs without
    # the legacy parent tables), so we have to null project_id ourselves
    # to preserve the prior ON DELETE SET NULL semantics.
    conn.execute(
        "UPDATE sessions SET project_id = NULL "
        "WHERE project_id = ? AND owner_user_id = ?",
        (project_id, user_id),
    )
    conn.execute(
        "UPDATE facts SET project_id = NULL "
        "WHERE project_id = ? AND owner_user_id = ?",
        (project_id, user_id),
    )
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


# ---- Phase 7: fact telemetry ----------------------------------------


def record_fact_retrieval(
    conn: sqlite3.Connection, fact_ids: list[int]
) -> None:
    """Bump retrieve_count and last_retrieved_at for each candidate fact.

    Per-row errors (e.g. FK violation if a non-fact ID slips through)
    are caught and skipped — telemetry must never crash the pipeline.
    """
    if not fact_ids:
        return
    for fid in fact_ids:
        try:
            conn.execute(
                "INSERT INTO fact_telemetry (fact_id, retrieve_count, last_retrieved_at) "
                "VALUES (?, 1, datetime('now')) "
                "ON CONFLICT(fact_id) DO UPDATE SET "
                "retrieve_count = retrieve_count + 1, "
                "last_retrieved_at = datetime('now')",
                (fid,),
            )
        except sqlite3.Error:
            continue
    conn.commit()


def record_fact_injection(
    conn: sqlite3.Connection, fact_ids: list[int]
) -> None:
    """Bump inject_count and last_injected_at for each injected fact.

    Per-row errors are caught and skipped — same rationale as
    ``record_fact_retrieval``.
    """
    if not fact_ids:
        return
    for fid in fact_ids:
        try:
            conn.execute(
                "INSERT INTO fact_telemetry (fact_id, inject_count, last_injected_at) "
                "VALUES (?, 1, datetime('now')) "
                "ON CONFLICT(fact_id) DO UPDATE SET "
                "inject_count = inject_count + 1, "
                "last_injected_at = datetime('now')",
                (fid,),
            )
        except sqlite3.Error:
            continue
    conn.commit()


def get_fact_telemetry(
    conn: sqlite3.Connection, fact_id: int
) -> Optional[sqlite3.Row]:
    return conn.execute(
        "SELECT * FROM fact_telemetry WHERE fact_id = ?", (fact_id,)
    ).fetchone()


# ---- Phase 7: experiment assignments --------------------------------


def get_experiment_arm(
    conn: sqlite3.Connection, user_id: int, experiment_id: str
) -> Optional[str]:
    row = conn.execute(
        "SELECT arm FROM experiment_assignments "
        "WHERE user_id = ? AND experiment_id = ?",
        (user_id, experiment_id),
    ).fetchone()
    return row["arm"] if row else None


def set_experiment_arm(
    conn: sqlite3.Connection, user_id: int, experiment_id: str, arm: str
) -> None:
    conn.execute(
        "INSERT INTO experiment_assignments (user_id, experiment_id, arm) "
        "VALUES (?, ?, ?) "
        "ON CONFLICT(user_id, experiment_id) DO UPDATE SET arm = ?, assigned_at = datetime('now')",
        (user_id, experiment_id, arm, arm),
    )
    conn.commit()


def list_all_chat_traces(
    conn: sqlite3.Connection,
    *,
    limit: int = 10000,
) -> list[sqlite3.Row]:
    """All traces across all users, newest first. For eval scripts only."""
    return conn.execute(
        "SELECT * FROM chat_traces ORDER BY id DESC LIMIT ?",
        (limit,),
    ).fetchall()


def list_fact_telemetry_all(
    conn: sqlite3.Connection,
    *,
    limit: int = 10000,
) -> list[sqlite3.Row]:
    """All fact_telemetry rows joined with basic fact info."""
    return conn.execute(
        "SELECT ft.fact_id, ft.retrieve_count, ft.inject_count, "
        "       ft.last_retrieved_at, ft.last_injected_at, "
        "       f.subject, f.predicate, f.value, f.confidence, f.status "
        "FROM fact_telemetry ft JOIN facts f ON f.id = ft.fact_id "
        "ORDER BY ft.inject_count DESC LIMIT ?",
        (limit,),
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


# ---- message feedback ---------------------------------------------------

def upsert_message_feedback(
    conn: sqlite3.Connection,
    *,
    user_id: int,
    message_id: int,
    rating: int,
    comment: str = "",
    tags: list[str] = [],
    prompt: Optional[str] = None,
    response: Optional[str] = None,
    trace: Optional[str] = None,
) -> int:
    """Insert or update feedback for a message. Returns the feedback row id."""
    tags_json = json.dumps(tags)
    cur = conn.execute(
        "INSERT INTO message_feedback ("
        "owner_user_id, message_id, rating, comment, tags, "
        "snapshot_prompt, snapshot_response, trace_json"
        ") VALUES (?, ?, ?, ?, ?, ?, ?, ?) "
        "ON CONFLICT (owner_user_id, message_id) DO UPDATE SET "
        "rating = excluded.rating, comment = excluded.comment, "
        "tags = excluded.tags, snapshot_prompt = excluded.snapshot_prompt, "
        "snapshot_response = excluded.snapshot_response, "
        "trace_json = excluded.trace_json",
        (user_id, message_id, rating, comment, tags_json, prompt, response, trace),
    )
    conn.commit()
    return int(cur.lastrowid)


def get_message_feedback(
    conn: sqlite3.Connection,
    *,
    user_id: int,
    message_id: int,
) -> Optional[sqlite3.Row]:
    return conn.execute(
        "SELECT id, rating, comment, tags, snapshot_prompt, snapshot_response, trace_json, created_at "
        "FROM message_feedback "
        "WHERE owner_user_id = ? AND message_id = ?",
        (user_id, message_id),
    ).fetchone()


def list_message_feedback(
    conn: sqlite3.Connection,
    *,
    user_id: Optional[int] = None,
    rating: Optional[int] = None,
    limit: int = 100,
) -> list[sqlite3.Row]:
    args = []
    where_clauses = []
    if user_id is not None:
        where_clauses.append("mf.owner_user_id = ?")
        args.append(user_id)
    if rating is not None:
        where_clauses.append("mf.rating = ?")
        args.append(rating)

    where_sql = ""
    if where_clauses:
        where_sql = "WHERE " + " AND ".join(where_clauses)

    query = f"""
        SELECT mf.id, mf.message_id, mf.rating, mf.comment, mf.tags, 
               mf.snapshot_prompt, mf.snapshot_response, mf.trace_json, mf.created_at, 
               m.content, m.session_id, u.username
        FROM message_feedback mf 
        JOIN messages m ON m.id = mf.message_id 
        JOIN users u ON u.id = mf.owner_user_id
        {where_sql}
        ORDER BY mf.created_at DESC LIMIT ?
    """
    args.append(limit)
    return conn.execute(query, args).fetchall()


def delete_message_feedback(
    conn: sqlite3.Connection,
    *,
    feedback_id: Optional[int] = None,
    user_id: Optional[int] = None,
) -> int:
    """Delete specific feedback OR all feedback for a user (or all if both None)."""
    if feedback_id is not None:
        cur = conn.execute(
            "DELETE FROM message_feedback WHERE id = ?", (feedback_id,)
        )
    elif user_id is not None:
        cur = conn.execute(
            "DELETE FROM message_feedback WHERE owner_user_id = ?", (user_id,)
        )
    else:
        cur = conn.execute("DELETE FROM message_feedback")
    conn.commit()
    return cur.rowcount
