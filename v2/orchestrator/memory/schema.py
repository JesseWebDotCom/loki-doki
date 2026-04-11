"""
v2 memory schema — drafted in M0, applied incrementally per phase.

This module is the **single source of truth** for the v2 memory database
shape. It deliberately lives under `v2/orchestrator/memory/` and not under
`lokidoki/core/`, so a v1 → v2 cutover never has to disentangle two
authoritative schema files. The v1 file (`lokidoki/core/memory_schema.py`)
remains read-only during the cutover and is deleted in the same change that
deletes the v1 memory modules.

Phase status: M0 — drafted but **not yet applied to dev or prod**. M0 only
verifies the migrations apply cleanly to a scratch SQLite file (see
`apply_v2_memory_schema` and the corresponding test in
`tests/unit/test_v2_memory_m0.py`). Each later phase applies the relevant
table:

    M1 → no schema change (uses v1 facts/people via shared SQLite)
    M3 → people.handle, people.provisional, idx_people_owner_handle
    M4 → sessions.session_state, episodes, episodes_fts, vec_episodes
    M5 → behavior_events, user_profile
    M6 → messages.sentiment, affect_window

See `docs/MEMORY_DESIGN.md` §6 for the rationale.
"""
from __future__ import annotations

import sqlite3
from typing import Final

# ---------------------------------------------------------------------------
# Column-level migrations against existing v1 tables.
#
# These ALTER statements are non-destructive — they only add columns. They
# are guarded by a column-presence check at apply time so re-running is a
# no-op.
# ---------------------------------------------------------------------------

ADD_COLUMN_MIGRATIONS: Final[tuple[tuple[str, str, str, str], ...]] = (
    # (table, column, type, default-clause-or-empty)
    ("people", "handle", "TEXT", ""),
    ("people", "provisional", "INTEGER", "DEFAULT 0"),
    ("sessions", "session_state", "TEXT", ""),
    ("messages", "sentiment", "TEXT", ""),
)

INDEX_MIGRATIONS: Final[tuple[str, ...]] = (
    # Hot-path index for in-session provisional handle lookups (Tier 5).
    "CREATE INDEX IF NOT EXISTS idx_people_owner_handle "
    "ON people(owner_user_id, handle) WHERE handle IS NOT NULL;",
)

# ---------------------------------------------------------------------------
# New tables — Tier 3 (episodic), Tier 6 (affective), Tier 7 (procedural).
# ---------------------------------------------------------------------------

EPISODES_SCHEMA: Final[str] = """
CREATE TABLE IF NOT EXISTS episodes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_user_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    summary TEXT NOT NULL,
    start_at TEXT NOT NULL,
    end_at TEXT,
    sentiment TEXT,
    entities TEXT,           -- JSON array of entity refs
    topic_scope TEXT,        -- nullable thread tag, e.g. "japan_trip"
    confidence REAL NOT NULL DEFAULT 0.5,
    superseded_by INTEGER,
    recall_count INTEGER NOT NULL DEFAULT 0,
    last_recalled_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (superseded_by) REFERENCES episodes(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_episodes_owner_start ON episodes(owner_user_id, start_at);
CREATE INDEX IF NOT EXISTS idx_episodes_topic_scope ON episodes(owner_user_id, topic_scope) WHERE topic_scope IS NOT NULL;
"""

EPISODES_FTS_SCHEMA: Final[str] = """
CREATE VIRTUAL TABLE IF NOT EXISTS episodes_fts USING fts5(
    title,
    summary,
    content='episodes',
    content_rowid='id',
    tokenize='porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS episodes_fts_ai AFTER INSERT ON episodes BEGIN
    INSERT INTO episodes_fts(rowid, title, summary) VALUES (new.id, new.title, new.summary);
END;

CREATE TRIGGER IF NOT EXISTS episodes_fts_ad AFTER DELETE ON episodes BEGIN
    INSERT INTO episodes_fts(episodes_fts, rowid, title, summary)
    VALUES('delete', old.id, old.title, old.summary);
END;

CREATE TRIGGER IF NOT EXISTS episodes_fts_au AFTER UPDATE ON episodes BEGIN
    INSERT INTO episodes_fts(episodes_fts, rowid, title, summary)
    VALUES('delete', old.id, old.title, old.summary);
    INSERT INTO episodes_fts(rowid, title, summary) VALUES (new.id, new.title, new.summary);
END;
"""

# sqlite-vec virtual table for episode embeddings. Optional — backfilled
# async by the same path that backfills facts/messages in v1. The CREATE
# statement is fenced so apply() can skip it if sqlite_vec isn't loaded.
VEC_EPISODES_SCHEMA: Final[str] = """
CREATE VIRTUAL TABLE IF NOT EXISTS vec_episodes USING vec0(
    embedding float[384]
);
"""

AFFECT_WINDOW_SCHEMA: Final[str] = """
CREATE TABLE IF NOT EXISTS affect_window (
    owner_user_id INTEGER NOT NULL,
    character_id TEXT NOT NULL,
    day TEXT NOT NULL,                  -- YYYY-MM-DD
    sentiment_avg REAL NOT NULL,
    notable_concerns TEXT,              -- JSON array
    PRIMARY KEY (owner_user_id, character_id, day)
);

CREATE INDEX IF NOT EXISTS idx_affect_recent
    ON affect_window(owner_user_id, character_id, day DESC);
"""

BEHAVIOR_EVENTS_SCHEMA: Final[str] = """
CREATE TABLE IF NOT EXISTS behavior_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_user_id INTEGER NOT NULL,
    at TEXT NOT NULL DEFAULT (datetime('now')),
    event_type TEXT NOT NULL,
    payload TEXT                         -- JSON
);

CREATE INDEX IF NOT EXISTS idx_behavior_events_owner_at
    ON behavior_events(owner_user_id, at DESC);
"""

USER_PROFILE_SCHEMA: Final[str] = """
CREATE TABLE IF NOT EXISTS user_profile (
    owner_user_id INTEGER PRIMARY KEY,
    style TEXT,                          -- JSON, prompt-safe (sub-tier 7a)
    telemetry TEXT,                      -- JSON, prompt-forbidden (sub-tier 7b)
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
"""

# ---------------------------------------------------------------------------
# Stub tables — only needed when applying migrations to a scratch SQLite
# file that does not already contain the v1 tables. In production these are
# the v1 tables and we never touch their definitions; the column-level
# migrations above run against the existing v1 schema.
# ---------------------------------------------------------------------------

V1_STUB_TABLES_FOR_SCRATCH: Final[str] = """
CREATE TABLE IF NOT EXISTS people (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_user_id INTEGER NOT NULL,
    name TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_user_id INTEGER NOT NULL,
    started_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL,
    role TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
"""


def _column_exists(conn: sqlite3.Connection, table: str, column: str) -> bool:
    cursor = conn.execute(f"PRAGMA table_info({table});")
    return any(row[1] == column for row in cursor.fetchall())


def apply_column_migrations(conn: sqlite3.Connection) -> list[str]:
    """Apply non-destructive ALTER TABLE migrations. Returns the columns that
    were actually added (skipping ones that already exist)."""
    added: list[str] = []
    for table, column, col_type, default_clause in ADD_COLUMN_MIGRATIONS:
        if _column_exists(conn, table, column):
            continue
        suffix = f" {default_clause}" if default_clause else ""
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {col_type}{suffix};")
        added.append(f"{table}.{column}")
    return added


def apply_v2_memory_schema(
    conn: sqlite3.Connection,
    *,
    create_v1_stubs: bool = False,
    enable_vec: bool = False,
) -> dict[str, list[str]]:
    """Apply the full v2 memory schema to `conn`.

    M0 calls this against a scratch SQLite file from a test, with
    `create_v1_stubs=True` so the column migrations have something to ALTER.
    Production phases call it with `create_v1_stubs=False` once the
    real v1 schema is already present.

    Returns a dict mapping each section to the list of statements (or
    columns) that were applied — useful for assertions in tests.
    """
    applied: dict[str, list[str]] = {
        "stubs": [],
        "added_columns": [],
        "indexes": [],
        "tables": [],
    }

    if create_v1_stubs:
        conn.executescript(V1_STUB_TABLES_FOR_SCRATCH)
        applied["stubs"].append("v1_stub_tables")

    applied["added_columns"] = apply_column_migrations(conn)

    for stmt in INDEX_MIGRATIONS:
        conn.execute(stmt)
        applied["indexes"].append(stmt.split("\n", 1)[0])

    for label, schema in (
        ("episodes", EPISODES_SCHEMA),
        ("episodes_fts", EPISODES_FTS_SCHEMA),
        ("affect_window", AFFECT_WINDOW_SCHEMA),
        ("behavior_events", BEHAVIOR_EVENTS_SCHEMA),
        ("user_profile", USER_PROFILE_SCHEMA),
    ):
        conn.executescript(schema)
        applied["tables"].append(label)

    if enable_vec:
        conn.executescript(VEC_EPISODES_SCHEMA)
        applied["tables"].append("vec_episodes")

    conn.commit()
    return applied
