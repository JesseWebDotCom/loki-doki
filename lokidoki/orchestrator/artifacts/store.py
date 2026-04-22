"""SQLite-backed immutable artifact storage."""
from __future__ import annotations

from datetime import UTC, datetime
import sqlite3
from uuid import uuid4

from lokidoki.orchestrator.artifacts.types import (
    Artifact,
    ArtifactKind,
    ArtifactVersion,
)
from lokidoki.orchestrator.artifacts.validator import validate_artifact_content


def init_artifact_store(conn: sqlite3.Connection) -> None:
    """Create artifact tables if they do not already exist."""

    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS artifacts (
            id TEXT PRIMARY KEY,
            kind TEXT NOT NULL,
            title TEXT NOT NULL,
            chat_turn_id TEXT NOT NULL
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS artifact_versions (
            artifact_id TEXT NOT NULL,
            version INTEGER NOT NULL,
            content BLOB NOT NULL,
            size_bytes INTEGER NOT NULL,
            created_at TEXT NOT NULL,
            PRIMARY KEY (artifact_id, version),
            FOREIGN KEY (artifact_id) REFERENCES artifacts(id)
        )
        """
    )
    conn.commit()


def _now_iso() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat()


def create_artifact(
    conn: sqlite3.Connection,
    *,
    kind: ArtifactKind,
    title: str,
    content: str,
    chat_turn_id: str,
) -> Artifact:
    """Create a new artifact with immutable version 1."""

    init_artifact_store(conn)
    artifact_id = f"artifact-{uuid4().hex}"
    created_at = _now_iso()
    size_bytes = validate_artifact_content(kind=kind, title=title, content=content)
    conn.execute(
        "INSERT INTO artifacts (id, kind, title, chat_turn_id) VALUES (?, ?, ?, ?)",
        (artifact_id, kind.value, title, chat_turn_id),
    )
    conn.execute(
        """
        INSERT INTO artifact_versions
            (artifact_id, version, content, size_bytes, created_at)
        VALUES (?, ?, ?, ?, ?)
        """,
        (artifact_id, 1, content, size_bytes, created_at),
    )
    conn.commit()
    return Artifact(
        id=artifact_id,
        kind=kind,
        title=title,
        versions=[
            ArtifactVersion(
                version=1,
                content=content,
                created_at=created_at,
                size_bytes=size_bytes,
            )
        ],
        chat_turn_id=chat_turn_id,
    )


def append_version(
    conn: sqlite3.Connection, *, artifact_id: str, content: str
) -> Artifact:
    """Append a new immutable version to an existing artifact."""

    artifact = load_artifact(conn, artifact_id)
    if artifact is None:
        raise KeyError(f"artifact not found: {artifact_id}")
    next_version = artifact.versions[-1].version + 1 if artifact.versions else 1
    created_at = _now_iso()
    size_bytes = validate_artifact_content(
        kind=artifact.kind,
        title=artifact.title,
        content=content,
    )
    conn.execute(
        """
        INSERT INTO artifact_versions
            (artifact_id, version, content, size_bytes, created_at)
        VALUES (?, ?, ?, ?, ?)
        """,
        (artifact_id, next_version, content, size_bytes, created_at),
    )
    conn.commit()
    return load_artifact(conn, artifact_id) or artifact


def load_artifact(conn: sqlite3.Connection, artifact_id: str) -> Artifact | None:
    """Load artifact metadata and all versions."""

    artifact_row = conn.execute(
        "SELECT id, kind, title, chat_turn_id FROM artifacts WHERE id = ?",
        (artifact_id,),
    ).fetchone()
    if artifact_row is None:
        return None
    version_rows = conn.execute(
        """
        SELECT version, content, created_at, size_bytes
        FROM artifact_versions
        WHERE artifact_id = ?
        ORDER BY version ASC
        """,
        (artifact_id,),
    ).fetchall()
    return Artifact(
        id=str(artifact_row["id"]),
        kind=ArtifactKind(str(artifact_row["kind"])),
        title=str(artifact_row["title"]),
        versions=[
            ArtifactVersion(
                version=int(row["version"]),
                content=str(row["content"]),
                created_at=str(row["created_at"]),
                size_bytes=int(row["size_bytes"]),
            )
            for row in version_rows
        ],
        chat_turn_id=str(artifact_row["chat_turn_id"]),
    )

