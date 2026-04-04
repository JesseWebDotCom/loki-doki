"""SQLite persistence for the skill system."""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Any, Optional, Union
from uuid import uuid4

from app.skills.types import AccountRecord, InstalledSkillRecord


def initialize_skill_tables(conn: sqlite3.Connection) -> None:
    """Create all skill-system tables if they do not already exist."""
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS installed_skills (
            skill_id TEXT PRIMARY KEY,
            version TEXT NOT NULL,
            title TEXT NOT NULL,
            domain TEXT NOT NULL,
            description TEXT NOT NULL,
            logo TEXT NOT NULL DEFAULT '',
            manifest_json TEXT NOT NULL,
            enabled INTEGER NOT NULL DEFAULT 0,
            system_skill INTEGER NOT NULL DEFAULT 0,
            load_type TEXT NOT NULL,
            source_type TEXT NOT NULL,
            source_ref TEXT NOT NULL,
            health_status TEXT NOT NULL DEFAULT 'ok',
            health_detail TEXT NOT NULL DEFAULT '',
            installed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            last_used_at TEXT
        );

        CREATE TABLE IF NOT EXISTS skill_accounts (
            id TEXT PRIMARY KEY,
            skill_id TEXT NOT NULL,
            label TEXT NOT NULL,
            config_json TEXT NOT NULL,
            context_json TEXT NOT NULL DEFAULT '{}',
            enabled INTEGER NOT NULL DEFAULT 1,
            is_default INTEGER NOT NULL DEFAULT 0,
            allowed_user_ids_json TEXT NOT NULL DEFAULT '[]',
            health_status TEXT NOT NULL DEFAULT 'ok',
            health_detail TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (skill_id) REFERENCES installed_skills(skill_id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS suppressed_repository_skills (
            skill_id TEXT PRIMARY KEY
        );
        """
    )
    _ensure_column(conn, "skill_accounts", "context_json", "TEXT NOT NULL DEFAULT '{}'")
    _ensure_column(conn, "installed_skills", "logo", "TEXT NOT NULL DEFAULT ''")
    conn.commit()


def upsert_installed_skill(
    conn: sqlite3.Connection,
    *,
    skill_id: str,
    version: str,
    title: str,
    domain: str,
    description: str,
    logo: str,
    manifest: dict[str, Any],
    enabled: bool,
    system: bool,
    load_type: str,
    source_type: str,
    source_ref: Path,
) -> None:
    """Insert or update one installed skill record."""
    conn.execute(
        """
        INSERT INTO installed_skills (
            skill_id, version, title, domain, description, logo, manifest_json, enabled,
            system_skill, load_type, source_type, source_ref, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(skill_id) DO UPDATE SET
            version = excluded.version,
            title = excluded.title,
            domain = excluded.domain,
            description = excluded.description,
            logo = excluded.logo,
            manifest_json = excluded.manifest_json,
            enabled = excluded.enabled,
            system_skill = excluded.system_skill,
            load_type = excluded.load_type,
            source_type = excluded.source_type,
            source_ref = excluded.source_ref,
            updated_at = CURRENT_TIMESTAMP
        """,
        (
            skill_id,
            version,
            title,
            domain,
            description,
            logo,
            json.dumps(manifest),
            int(enabled),
            int(system),
            load_type,
            source_type,
            str(source_ref),
        ),
    )
    conn.commit()


def list_installed_skills(conn: sqlite3.Connection) -> list[InstalledSkillRecord]:
    """Return all installed skills."""
    rows = conn.execute(
        """
        SELECT skill_id, version, title, domain, description, manifest_json, enabled,
               logo, system_skill, load_type, source_type, source_ref, health_status,
               health_detail, last_used_at
        FROM installed_skills
        ORDER BY system_skill DESC, title ASC
        """
    ).fetchall()
    return [_record_from_row(row) for row in rows]


def get_installed_skill(conn: sqlite3.Connection, skill_id: str) -> Optional[InstalledSkillRecord]:
    """Return one installed skill by id."""
    row = conn.execute(
        """
        SELECT skill_id, version, title, domain, description, manifest_json, enabled,
               logo, system_skill, load_type, source_type, source_ref, health_status,
               health_detail, last_used_at
        FROM installed_skills
        WHERE skill_id = ?
        """,
        (skill_id,),
    ).fetchone()
    if row is None:
        return None
    return _record_from_row(row)


def set_skill_enabled(conn: sqlite3.Connection, skill_id: str, enabled: bool) -> None:
    """Update the enabled state for one skill."""
    conn.execute(
        """
        UPDATE installed_skills
        SET enabled = ?, updated_at = CURRENT_TIMESTAMP
        WHERE skill_id = ?
        """,
        (int(enabled), skill_id),
    )
    conn.commit()


def delete_installed_skill(conn: sqlite3.Connection, skill_id: str) -> None:
    """Delete one installed skill record and dependent accounts."""
    conn.execute("DELETE FROM installed_skills WHERE skill_id = ?", (skill_id,))
    conn.commit()


def suppress_repository_skill(conn: sqlite3.Connection, skill_id: str) -> None:
    """Mark one repository skill as intentionally uninstalled."""
    conn.execute(
        "INSERT OR REPLACE INTO suppressed_repository_skills (skill_id) VALUES (?)",
        (skill_id,),
    )
    conn.commit()


def unsuppress_repository_skill(conn: sqlite3.Connection, skill_id: str) -> None:
    """Clear one repository-skill suppression record."""
    conn.execute("DELETE FROM suppressed_repository_skills WHERE skill_id = ?", (skill_id,))
    conn.commit()


def is_repository_skill_suppressed(conn: sqlite3.Connection, skill_id: str) -> bool:
    """Return whether one repository skill is intentionally suppressed."""
    row = conn.execute(
        "SELECT skill_id FROM suppressed_repository_skills WHERE skill_id = ?",
        (skill_id,),
    ).fetchone()
    return row is not None


def touch_skill_last_used(conn: sqlite3.Connection, skill_id: str) -> None:
    """Record when a skill was last used."""
    conn.execute(
        """
        UPDATE installed_skills
        SET last_used_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
        WHERE skill_id = ?
        """,
        (skill_id,),
    )
    conn.commit()


def replace_skill_health(
    conn: sqlite3.Connection,
    skill_id: str,
    status: str,
    detail: str,
) -> None:
    """Persist health status for one skill."""
    conn.execute(
        """
        UPDATE installed_skills
        SET health_status = ?, health_detail = ?, updated_at = CURRENT_TIMESTAMP
        WHERE skill_id = ?
        """,
        (status, detail, skill_id),
    )
    conn.commit()


def replace_skill_account_health(
    conn: sqlite3.Connection,
    skill_id: str,
    account_id: str,
    status: str,
    detail: str,
) -> None:
    """Persist health status for one skill account."""
    conn.execute(
        """
        UPDATE skill_accounts
        SET health_status = ?, health_detail = ?, updated_at = CURRENT_TIMESTAMP
        WHERE skill_id = ? AND id = ?
        """,
        (status, detail, skill_id, account_id),
    )
    conn.commit()


def list_skill_accounts(conn: sqlite3.Connection, skill_id: str) -> list[AccountRecord]:
    """Return all accounts for a skill."""
    rows = conn.execute(
        """
        SELECT id, skill_id, label, config_json, enabled, is_default,
               context_json, allowed_user_ids_json, health_status, health_detail
        FROM skill_accounts
        WHERE skill_id = ?
        ORDER BY is_default DESC, label ASC
        """,
        (skill_id,),
    ).fetchall()
    return [_account_from_row(row) for row in rows]


def get_skill_account(conn: sqlite3.Connection, skill_id: str, account_id: str) -> Optional[AccountRecord]:
    """Return one skill account."""
    row = conn.execute(
        """
        SELECT id, skill_id, label, config_json, enabled, is_default,
               context_json, allowed_user_ids_json, health_status, health_detail
        FROM skill_accounts
        WHERE skill_id = ? AND id = ?
        """,
        (skill_id, account_id),
    ).fetchone()
    if row is None:
        return None
    return _account_from_row(row)


def delete_skill_account(conn: sqlite3.Connection, skill_id: str, account_id: str) -> None:
    """Delete one skill account."""
    conn.execute(
        "DELETE FROM skill_accounts WHERE skill_id = ? AND id = ?",
        (skill_id, account_id),
    )
    conn.commit()


def set_skill_account_enabled(conn: sqlite3.Connection, skill_id: str, account_id: str, enabled: bool) -> None:
    """Update the enabled state for one skill account."""
    conn.execute(
        "UPDATE skill_accounts SET enabled = ?, updated_at = CURRENT_TIMESTAMP WHERE skill_id = ? AND id = ?",
        (int(enabled), skill_id, account_id),
    )
    conn.commit()



def get_skill_account(conn: sqlite3.Connection, skill_id: str, account_id: str) -> Optional[AccountRecord]:
    """Return one skill account."""
    row = conn.execute(
        """
        SELECT id, skill_id, label, config_json, enabled, is_default,
               context_json, allowed_user_ids_json, health_status, health_detail
        FROM skill_accounts
        WHERE skill_id = ? AND id = ?
        """,
        (skill_id, account_id),
    ).fetchone()
    if row is None:
        return None
    return _account_from_row(row)


def upsert_skill_account(
    conn: sqlite3.Connection,
    *,
    skill_id: str,
    label: str,
    config: dict[str, Any],
    enabled: bool = True,
    is_default: bool = False,
    context: Optional[dict[str, Any]] = None,
    allowed_user_ids: Optional[list[str]] = None,
    account_id: Optional[str] = None,
) -> str:
    """Insert or update one skill account record."""
    resolved_id = account_id or str(uuid4())
    if is_default:
        conn.execute("UPDATE skill_accounts SET is_default = 0 WHERE skill_id = ?", (skill_id,))
    conn.execute(
        """
        INSERT INTO skill_accounts (
            id, skill_id, label, config_json, context_json, enabled, is_default, allowed_user_ids_json,
            health_status, health_detail, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'unknown', 'Not tested yet.', CURRENT_TIMESTAMP)
        ON CONFLICT(id) DO UPDATE SET
            label = excluded.label,
            config_json = excluded.config_json,
            context_json = excluded.context_json,
            enabled = excluded.enabled,
            is_default = excluded.is_default,
            allowed_user_ids_json = excluded.allowed_user_ids_json,
            health_status = 'unknown',
            health_detail = 'Not tested yet.',
            updated_at = CURRENT_TIMESTAMP
        """,
        (
            resolved_id,
            skill_id,
            label,
            json.dumps(config),
            json.dumps(context or {}),
            int(enabled),
            int(is_default),
            json.dumps(allowed_user_ids or []),
        ),
    )
    conn.commit()
    return resolved_id


def _record_from_row(row: sqlite3.Row) -> InstalledSkillRecord:
    """Convert one row into an installed-skill record."""
    return InstalledSkillRecord(
        skill_id=row["skill_id"],
        version=row["version"],
        title=row["title"],
        domain=row["domain"],
        description=row["description"],
        logo=row["logo"],
        manifest=json.loads(row["manifest_json"]),
        enabled=bool(row["enabled"]),
        system=bool(row["system_skill"]),
        load_type=row["load_type"],
        source_type=row["source_type"],
        source_ref=row["source_ref"],
        health_status=row["health_status"],
        health_detail=row["health_detail"],
        last_used_at=row["last_used_at"],
    )


def _account_from_row(row: sqlite3.Row) -> AccountRecord:
    """Convert one row into a skill account record."""
    return AccountRecord(
        account_id=row["id"],
        skill_id=row["skill_id"],
        label=row["label"],
        config=json.loads(row["config_json"]),
        context=json.loads(row["context_json"] or "{}"),
        enabled=bool(row["enabled"]),
        is_default=bool(row["is_default"]),
        allowed_user_ids=tuple(json.loads(row["allowed_user_ids_json"])),
        health_status=row["health_status"],
        health_detail=row["health_detail"],
    )


def _ensure_column(conn: sqlite3.Connection, table: str, column: str, definition: str) -> None:
    """Add one SQLite column if it does not already exist."""
    rows = conn.execute(f"PRAGMA table_info({table})").fetchall()
    names = {row["name"] for row in rows}
    if column in names:
        return
    conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")
