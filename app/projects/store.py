"""SQLite-backed project storage."""

from __future__ import annotations

import sqlite3
from typing import Any, Optional
from uuid import uuid4


def initialize_project_tables(conn: sqlite3.Connection) -> None:
    """Create projects table."""
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS projects (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            name TEXT NOT NULL,
            description TEXT NOT NULL DEFAULT '',
            instructions TEXT NOT NULL DEFAULT '',
            icon TEXT NOT NULL DEFAULT 'Folder',
            icon_color TEXT NOT NULL DEFAULT '#3b82f6',
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_projects_user
        ON projects(user_id, created_at DESC);
        """
    )


def list_projects(conn: sqlite3.Connection, user_id: str) -> list[dict[str, Any]]:
    """Return all projects for one user."""
    rows = conn.execute(
        """
        SELECT id, name, description, instructions, icon, icon_color, created_at, updated_at
        FROM projects
        WHERE user_id = ?
        ORDER BY created_at DESC
        """,
        (user_id,),
    ).fetchall()
    return [dict(row) for row in rows]


def get_project(conn: sqlite3.Connection, user_id: str, project_id: str) -> Optional[dict[str, Any]]:
    """Return one project summary for a user-owned project."""
    row = conn.execute(
        """
        SELECT id, name, description, instructions, icon, icon_color, created_at, updated_at
        FROM projects
        WHERE user_id = ? AND id = ?
        """,
        (user_id, project_id),
    ).fetchone()
    return dict(row) if row else None


def create_project(
    conn: sqlite3.Connection,
    user_id: str,
    name: str,
    description: str = "",
    instructions: str = "",
    icon: str = "Folder",
    icon_color: str = "#3b82f6",
) -> dict[str, Any]:
    """Create one project."""
    project_id = str(uuid4())
    conn.execute(
        """
        INSERT INTO projects (id, user_id, name, description, instructions, icon, icon_color)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (project_id, user_id, name, description, instructions, icon, icon_color),
    )
    conn.commit()
    project = get_project(conn, user_id, project_id)
    if project is None:
        raise ValueError("Project could not be created.")
    return project


def update_project(
    conn: sqlite3.Connection,
    user_id: str,
    project_id: str,
    name: Optional[str] = None,
    description: Optional[str] = None,
    instructions: Optional[str] = None,
    icon: Optional[str] = None,
    icon_color: Optional[str] = None,
) -> dict[str, Any]:
    """Update one user-owned project."""
    updates = []
    params = []
    if name is not None:
        updates.append("name = ?")
        params.append(name)
    if description is not None:
        updates.append("description = ?")
        params.append(description)
    if instructions is not None:
        updates.append("instructions = ?")
        params.append(instructions)
    if icon is not None:
        updates.append("icon = ?")
        params.append(icon)
    if icon_color is not None:
        updates.append("icon_color = ?")
        params.append(icon_color)

    if not updates:
        project = get_project(conn, user_id, project_id)
        if project is None:
            raise ValueError("Project not found.")
        return project

    updates.append("updated_at = CURRENT_TIMESTAMP")
    params.extend([project_id, user_id])
    
    cursor = conn.execute(
        f"UPDATE projects SET {', '.join(updates)} WHERE id = ? AND user_id = ?",
        params,
    )
    if cursor.rowcount == 0:
        raise ValueError("Project not found.")
    conn.commit()
    
    project = get_project(conn, user_id, project_id)
    if project is None:
        raise ValueError("Project not found.")
    return project


def delete_project(conn: sqlite3.Connection, user_id: str, project_id: str) -> None:
    """Delete one project and unassign it from its chats."""
    conn.execute(
        "UPDATE chat_sessions SET project_id = NULL WHERE project_id = ? AND user_id = ?",
        (project_id, user_id),
    )
    conn.execute(
        "DELETE FROM projects WHERE id = ? AND user_id = ?",
        (project_id, user_id),
    )
    conn.commit()
