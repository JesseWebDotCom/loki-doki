"""SQLite-backed workspace storage."""
from __future__ import annotations

import json
import logging
import re
import sqlite3

from lokidoki.orchestrator.response.mode import VALID_MODES
from lokidoki.orchestrator.workspace.types import Workspace

logger = logging.getLogger(__name__)

DEFAULT_WORKSPACE_ID = "default"
_ID_RE = re.compile(r"[^a-z0-9]+")
_MEMORY_SCOPES = {"global", "workspace"}


def ensure_workspace_schema(conn: sqlite3.Connection) -> None:
    """Create the workspace table when it does not exist yet."""
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS workspaces (
            owner_user_id INTEGER NOT NULL,
            id TEXT NOT NULL,
            name TEXT NOT NULL,
            persona_id TEXT NOT NULL,
            default_mode TEXT NOT NULL DEFAULT 'standard',
            attached_corpora TEXT NOT NULL DEFAULT '[]',
            tone_hint TEXT,
            memory_scope TEXT NOT NULL DEFAULT 'workspace',
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now')),
            PRIMARY KEY (owner_user_id, id)
        );

        CREATE INDEX IF NOT EXISTS idx_workspaces_owner_updated
            ON workspaces(owner_user_id, updated_at DESC, id ASC);
        """
    )
    conn.commit()


def ensure_default_workspace(
    conn: sqlite3.Connection,
    *,
    user_id: int,
) -> Workspace:
    """Ensure the canonical default workspace exists for ``user_id``."""
    ensure_workspace_schema(conn)
    row = conn.execute(
        """
        SELECT id, name, persona_id, default_mode, attached_corpora, tone_hint, memory_scope
        FROM workspaces
        WHERE owner_user_id = ? AND id = ?
        """,
        (user_id, DEFAULT_WORKSPACE_ID),
    ).fetchone()
    if row is None:
        conn.execute(
            """
            INSERT INTO workspaces(
                owner_user_id, id, name, persona_id, default_mode,
                attached_corpora, tone_hint, memory_scope
            ) VALUES (?, ?, ?, ?, 'standard', '[]', NULL, 'global')
            """,
            (user_id, DEFAULT_WORKSPACE_ID, "Default", "default"),
        )
        conn.commit()
        row = conn.execute(
            """
            SELECT id, name, persona_id, default_mode, attached_corpora, tone_hint, memory_scope
            FROM workspaces
            WHERE owner_user_id = ? AND id = ?
            """,
            (user_id, DEFAULT_WORKSPACE_ID),
        ).fetchone()
    return _row_to_workspace(row)


def list_workspaces(conn: sqlite3.Connection, *, user_id: int) -> list[Workspace]:
    """Return every workspace for ``user_id``."""
    ensure_default_workspace(conn, user_id=user_id)
    rows = conn.execute(
        """
        SELECT id, name, persona_id, default_mode, attached_corpora, tone_hint, memory_scope
        FROM workspaces
        WHERE owner_user_id = ?
        ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END, updated_at DESC, name COLLATE NOCASE
        """,
        (user_id, DEFAULT_WORKSPACE_ID),
    ).fetchall()
    return [_row_to_workspace(row) for row in rows]


def get_workspace(
    conn: sqlite3.Connection,
    *,
    user_id: int,
    workspace_id: str,
) -> Workspace | None:
    """Fetch one workspace for ``user_id``."""
    ensure_default_workspace(conn, user_id=user_id)
    row = conn.execute(
        """
        SELECT id, name, persona_id, default_mode, attached_corpora, tone_hint, memory_scope
        FROM workspaces
        WHERE owner_user_id = ? AND id = ?
        """,
        (user_id, workspace_id),
    ).fetchone()
    if row is None:
        return None
    return _row_to_workspace(row)


def create_workspace(
    conn: sqlite3.Connection,
    *,
    user_id: int,
    name: str,
    persona_id: str,
    default_mode: str = "standard",
    attached_corpora: tuple[str, ...] | list[str] = (),
    tone_hint: str | None = None,
    memory_scope: str = "workspace",
    workspace_id: str | None = None,
) -> Workspace:
    """Insert a new workspace and return it."""
    ensure_default_workspace(conn, user_id=user_id)
    normalized_id = _normalize_workspace_id(conn, user_id=user_id, name=name, workspace_id=workspace_id)
    payload = _normalize_payload(
        name=name,
        persona_id=persona_id,
        default_mode=default_mode,
        attached_corpora=attached_corpora,
        tone_hint=tone_hint,
        memory_scope=memory_scope,
    )
    conn.execute(
        """
        INSERT INTO workspaces(
            owner_user_id, id, name, persona_id, default_mode,
            attached_corpora, tone_hint, memory_scope, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        """,
        (
            user_id,
            normalized_id,
            payload["name"],
            payload["persona_id"],
            payload["default_mode"],
            payload["attached_corpora"],
            payload["tone_hint"],
            payload["memory_scope"],
        ),
    )
    conn.commit()
    return get_workspace(conn, user_id=user_id, workspace_id=normalized_id) or ensure_default_workspace(conn, user_id=user_id)


def update_workspace(
    conn: sqlite3.Connection,
    *,
    user_id: int,
    workspace_id: str,
    fields: dict[str, object],
) -> Workspace | None:
    """Update one workspace."""
    existing = get_workspace(conn, user_id=user_id, workspace_id=workspace_id)
    if existing is None:
        return None
    if workspace_id == DEFAULT_WORKSPACE_ID and "id" in fields:
        fields = {k: v for k, v in fields.items() if k != "id"}
    merged = _normalize_payload(
        name=str(fields.get("name", existing.name)),
        persona_id=str(fields.get("persona_id", existing.persona_id)),
        default_mode=str(fields.get("default_mode", existing.default_mode)),
        attached_corpora=fields.get("attached_corpora", existing.attached_corpora),
        tone_hint=fields.get("tone_hint", existing.tone_hint),
        memory_scope=str(fields.get("memory_scope", existing.memory_scope)),
    )
    conn.execute(
        """
        UPDATE workspaces
        SET name = ?, persona_id = ?, default_mode = ?, attached_corpora = ?,
            tone_hint = ?, memory_scope = ?, updated_at = datetime('now')
        WHERE owner_user_id = ? AND id = ?
        """,
        (
            merged["name"],
            merged["persona_id"],
            merged["default_mode"],
            merged["attached_corpora"],
            merged["tone_hint"],
            merged["memory_scope"],
            user_id,
            workspace_id,
        ),
    )
    conn.commit()
    return get_workspace(conn, user_id=user_id, workspace_id=workspace_id)


def delete_workspace(
    conn: sqlite3.Connection,
    *,
    user_id: int,
    workspace_id: str,
) -> bool:
    """Delete a workspace unless it is the default."""
    if workspace_id == DEFAULT_WORKSPACE_ID:
        raise ValueError("default_workspace_cannot_be_deleted")
    cur = conn.execute(
        "DELETE FROM workspaces WHERE owner_user_id = ? AND id = ?",
        (user_id, workspace_id),
    )
    conn.execute(
        """
        UPDATE sessions
        SET active_workspace_id = ?
        WHERE owner_user_id = ? AND active_workspace_id = ?
        """,
        (DEFAULT_WORKSPACE_ID, user_id, workspace_id),
    )
    conn.commit()
    return cur.rowcount > 0


def set_session_active_workspace(
    conn: sqlite3.Connection,
    *,
    user_id: int,
    session_id: int,
    workspace_id: str,
) -> Workspace:
    """Persist the active workspace on one chat session."""
    workspace = get_workspace(conn, user_id=user_id, workspace_id=workspace_id)
    if workspace is None:
        raise ValueError("workspace_not_found")
    cur = conn.execute(
        """
        UPDATE sessions
        SET active_workspace_id = ?
        WHERE id = ? AND owner_user_id = ?
        """,
        (workspace_id, session_id, user_id),
    )
    conn.commit()
    if cur.rowcount == 0:
        raise ValueError("session_not_found")
    return workspace


def get_session_active_workspace_id(
    conn: sqlite3.Connection,
    *,
    user_id: int,
    session_id: int,
) -> str:
    """Return the workspace id attached to ``session_id``."""
    ensure_default_workspace(conn, user_id=user_id)
    row = conn.execute(
        """
        SELECT active_workspace_id
        FROM sessions
        WHERE id = ? AND owner_user_id = ?
        """,
        (session_id, user_id),
    ).fetchone()
    if row is None:
        raise ValueError("session_not_found")
    workspace_id = row["active_workspace_id"] or DEFAULT_WORKSPACE_ID
    return str(workspace_id)


def list_workspace_session_ids(
    conn: sqlite3.Connection,
    *,
    user_id: int,
    workspace_id: str,
) -> tuple[int, ...]:
    """Return chat session ids attached to ``workspace_id``."""
    rows = conn.execute(
        """
        SELECT id
        FROM sessions
        WHERE owner_user_id = ? AND COALESCE(active_workspace_id, ?) = ?
        ORDER BY id ASC
        """,
        (user_id, DEFAULT_WORKSPACE_ID, workspace_id),
    ).fetchall()
    return tuple(int(row["id"]) for row in rows)


def row_to_workspace_dict(row: sqlite3.Row | None) -> dict[str, object] | None:
    """Serialize a workspace DB row to an API dict."""
    if row is None:
        return None
    return _row_to_workspace(row).to_dict()


def _row_to_workspace(row: sqlite3.Row) -> Workspace:
    corpora_raw = row["attached_corpora"] or "[]"
    try:
        corpora = json.loads(corpora_raw)
    except (TypeError, ValueError):
        corpora = []
    if not isinstance(corpora, list):
        corpora = []
    return Workspace(
        id=str(row["id"]),
        name=str(row["name"]),
        persona_id=str(row["persona_id"]),
        default_mode=str(row["default_mode"]),
        attached_corpora=tuple(str(item) for item in corpora if str(item).strip()),
        tone_hint=str(row["tone_hint"]).strip() if row["tone_hint"] else None,
        memory_scope=str(row["memory_scope"]),
    )


def _normalize_workspace_id(
    conn: sqlite3.Connection,
    *,
    user_id: int,
    name: str,
    workspace_id: str | None,
) -> str:
    raw = (workspace_id or name or "workspace").strip().lower()
    base = _ID_RE.sub("-", raw).strip("-") or "workspace"
    candidate = base
    suffix = 2
    while get_workspace(conn, user_id=user_id, workspace_id=candidate) is not None:
        candidate = f"{base}-{suffix}"
        suffix += 1
    return candidate


def _normalize_payload(
    *,
    name: str,
    persona_id: str,
    default_mode: str,
    attached_corpora,
    tone_hint,
    memory_scope: str,
) -> dict[str, object]:
    normalized_mode = default_mode if default_mode in VALID_MODES else "standard"
    normalized_scope = memory_scope if memory_scope in _MEMORY_SCOPES else "workspace"
    corpora = tuple(
        item.strip()
        for item in (
            attached_corpora if isinstance(attached_corpora, (list, tuple))
            else str(attached_corpora or "").split(",")
        )
        if isinstance(item, str) and item.strip()
    )
    return {
        "name": (name or "Workspace").strip() or "Workspace",
        "persona_id": (persona_id or "default").strip() or "default",
        "default_mode": normalized_mode,
        "attached_corpora": json.dumps(list(corpora)),
        "tone_hint": (str(tone_hint).strip() or None) if tone_hint is not None else None,
        "memory_scope": normalized_scope,
    }
