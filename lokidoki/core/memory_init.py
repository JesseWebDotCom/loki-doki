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
    ("profile_media_id", "INTEGER"),
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
    # Memory taxonomy + temporal anchoring. `kind` lets the UI group facts
    # by type (preference vs event vs advice). `valid_from`/`valid_to`
    # turn supersede into a temporal range query — old beliefs aren't
    # destroyed, just bounded — so we can answer "what was true in March".
    ("kind", "TEXT NOT NULL DEFAULT 'fact'"),
    ("valid_from", "TEXT NOT NULL DEFAULT (datetime('now'))"),
    ("valid_to", "TEXT"),
)

PEOPLE_COLUMN_MIGRATIONS = (
    ("aliases", "TEXT NOT NULL DEFAULT '[]'"),
    ("bucket", "TEXT NOT NULL DEFAULT 'family'"),
    ("living_status", "TEXT NOT NULL DEFAULT 'unknown'"),
    ("birth_date", "TEXT"),
    ("death_date", "TEXT"),
    ("preferred_photo_id", "INTEGER"),
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


def _table_has_column(
    conn: sqlite3.Connection, table: str, column: str
) -> bool:
    try:
        cols = {r[1] for r in conn.execute(f"PRAGMA table_info({table})")}
    except sqlite3.OperationalError:
        return False
    return column in cols


def _drop_legacy_character_tables(conn: sqlite3.Connection) -> None:
    """Drop pre-Phase-1 character tables that don't match the new shape.

    Only drops if the table exists AND lacks the marker column we
    introduced this PR. Safe because the legacy tables shipped empty
    (never wired up to any route).
    """
    if _table_has_column(conn, "characters", "id") and not _table_has_column(
        conn, "characters", "source"
    ):
        conn.execute("DROP TABLE IF EXISTS characters")
    if _table_has_column(conn, "wakewords", "id") and not _table_has_column(
        conn, "wakewords", "is_global"
    ):
        conn.execute("DROP TABLE IF EXISTS wakewords")
    # `voices` legacy shape happens to match the new one — leave it.
    conn.commit()


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

    # One-shot cleanup: an earlier scratch implementation of the
    # character system left empty `characters`/`voices`/`wakewords`
    # tables in some dev DBs with a different shape (no `source`
    # column on characters, no `is_global`/`status` on wakewords).
    # CORE_SCHEMA's `CREATE TABLE IF NOT EXISTS` would no-op against
    # them and then `CREATE INDEX ... characters(source)` would crash
    # with "no such column: source". The legacy tables never held
    # real data, so we drop any that don't already match the new
    # shape and let CORE_SCHEMA recreate them clean.
    _drop_legacy_character_tables(conn)

    conn.executescript(CORE_SCHEMA)
    _add_columns(conn, "users", USER_COLUMN_MIGRATIONS)
    _add_columns(conn, "people", PEOPLE_COLUMN_MIGRATIONS)
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
