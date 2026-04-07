"""Connection lifecycle + idempotent schema migrations.

Extracted from ``memory_provider.py`` so that file stays under the
250-line CLAUDE.md ceiling. Every PR can drop new column migrations
into one of the ``*_COLUMN_MIGRATIONS`` tuples without touching the
provider's runtime methods.
"""
from __future__ import annotations

import logging
import sqlite3

from lokidoki.core.memory_schema import (
    CORE_SCHEMA,
    EMBEDDING_DIM,
    FTS_SCHEMA,
    vec_schema,
)

logger = logging.getLogger(__name__)

# PR2 user-table additions.
USER_COLUMN_MIGRATIONS = (
    ("password_hash", "TEXT"),
    ("status", "TEXT NOT NULL DEFAULT 'active'"),
    ("last_password_auth_at", "INTEGER"),
)

# PR3 facts-table additions. SQLite ALTER ADD COLUMN cannot include FK
# constraints, so subject_ref_id is added as a plain INTEGER on
# pre-PR3 DBs — fresh DBs still get the FK from CORE_SCHEMA.
FACT_COLUMN_MIGRATIONS = (
    ("subject_type", "TEXT NOT NULL DEFAULT 'self'"),
    ("subject_ref_id", "INTEGER"),
    ("project_id", "INTEGER"),
    ("observation_count", "INTEGER NOT NULL DEFAULT 1"),
    ("last_observed_at", "TEXT NOT NULL DEFAULT (datetime('now'))"),
    ("status", "TEXT NOT NULL DEFAULT 'active'"),
    ("ambiguity_group_id", "INTEGER"),
)

SESSION_COLUMN_MIGRATIONS = (
    ("project_id", "INTEGER"),
)

# Projects gain icon + icon_color so the UI can render a per-project
# avatar. icon_color stores a CSS-var token (e.g. "swatch-1") rather
# than a raw hex so theming controls the actual color.
PROJECT_COLUMN_MIGRATIONS = (
    ("icon", "TEXT NOT NULL DEFAULT 'Folder'"),
    ("icon_color", "TEXT NOT NULL DEFAULT 'swatch-1'"),
)

RELATIONSHIP_COLUMN_MIGRATIONS = (
    ("confidence", "REAL NOT NULL DEFAULT 0.6"),
)


def _add_columns(
    conn: sqlite3.Connection, table: str, migrations: tuple
) -> None:
    for col, decl in migrations:
        try:
            conn.execute(f"ALTER TABLE {table} ADD COLUMN {col} {decl}")
        except sqlite3.OperationalError as exc:
            if "duplicate column" not in str(exc).lower():
                raise


def open_and_migrate(db_path: str) -> tuple[sqlite3.Connection, bool]:
    """Open ``db_path``, apply all schemas, return ``(conn, vec_loaded)``.

    Idempotent — safe on every app start. Will NOT delete an existing
    database file; only adds missing tables and columns.
    """
    conn = sqlite3.connect(db_path, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")

    vec_loaded = False
    try:
        import sqlite_vec  # noqa: WPS433

        conn.enable_load_extension(True)
        sqlite_vec.load(conn)
        conn.enable_load_extension(False)
        vec_loaded = True
    except Exception as exc:  # noqa: BLE001 — degrade, don't crash
        logger.warning(
            "sqlite-vec failed to load (%s); continuing with FTS5/BM25 only",
            exc,
        )

    conn.executescript(CORE_SCHEMA)
    _add_columns(conn, "users", USER_COLUMN_MIGRATIONS)
    _add_columns(conn, "facts", FACT_COLUMN_MIGRATIONS)
    _add_columns(conn, "relationships", RELATIONSHIP_COLUMN_MIGRATIONS)
    _add_columns(conn, "sessions", SESSION_COLUMN_MIGRATIONS)
    # `projects` table may not exist yet on very old DBs; CORE_SCHEMA
    # creates it idempotently above, so this ALTER is always safe.
    _add_columns(conn, "projects", PROJECT_COLUMN_MIGRATIONS)
    # Indexes that depend on migrated columns must run AFTER _add_columns
    # so pre-projects DBs can upgrade without crashing on missing columns.
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_facts_project ON facts(project_id)"
    )
    conn.executescript(FTS_SCHEMA)
    if vec_loaded:
        try:
            conn.executescript(vec_schema(EMBEDDING_DIM))
        except sqlite3.Error as exc:
            logger.warning(
                "vec_facts creation failed (%s); disabling vec", exc
            )
            vec_loaded = False
    conn.commit()
    return conn, vec_loaded
