"""SQLite table definitions for the memory subsystem."""

import logging
import sqlite3

LOGGER = logging.getLogger(__name__)


def initialize_memory_tables(conn: sqlite3.Connection) -> None:
    """Create tracking tables for Household and Character memory layers."""
    conn.executescript(
        """
        -- Household Memory Constraints
        CREATE TABLE IF NOT EXISTS mem_entities (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            type TEXT NOT NULL,
            summary TEXT NOT NULL DEFAULT '',
            embedding BLOB,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS mem_relationships (
            entity_a TEXT NOT NULL,
            entity_b TEXT NOT NULL,
            relation_type TEXT NOT NULL,
            since TEXT NOT NULL DEFAULT '',
            notes TEXT NOT NULL DEFAULT '',
            PRIMARY KEY (entity_a, entity_b),
            FOREIGN KEY (entity_a) REFERENCES mem_entities(id) ON DELETE CASCADE,
            FOREIGN KEY (entity_b) REFERENCES mem_entities(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS mem_events (
            id TEXT PRIMARY KEY,
            date TEXT NOT NULL,
            title TEXT NOT NULL,
            notes TEXT NOT NULL DEFAULT '',
            importance INTEGER NOT NULL DEFAULT 1,
            embedding BLOB
        );

        CREATE TABLE IF NOT EXISTS mem_entity_traits (
            entity_id TEXT NOT NULL,
            key TEXT NOT NULL,
            value TEXT NOT NULL,
            confidence REAL NOT NULL DEFAULT 1.0,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (entity_id, key),
            FOREIGN KEY (entity_id) REFERENCES mem_entities(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS mem_recurring_dates (
            entity_id TEXT NOT NULL,
            label TEXT NOT NULL,
            month INTEGER NOT NULL,
            day INTEGER NOT NULL,
            remind_days_before INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (entity_id, label),
            FOREIGN KEY (entity_id) REFERENCES mem_entities(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS mem_household_context (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            node_id TEXT NOT NULL DEFAULT 'master',
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS mem_emotional_context (
            entity_id TEXT NOT NULL,
            state TEXT NOT NULL,
            intensity INTEGER NOT NULL DEFAULT 3,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            expires_at TEXT NOT NULL,
            last_confirmed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (entity_id, state),
            FOREIGN KEY (entity_id) REFERENCES mem_entities(id) ON DELETE CASCADE
        );

        -- Character Memory Constraints
        CREATE TABLE IF NOT EXISTS mem_characters (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            franchise TEXT NOT NULL DEFAULT '',
            base_persona_prompt TEXT NOT NULL DEFAULT ''
        );

        CREATE TABLE IF NOT EXISTS mem_char_user_memory (
            character_id TEXT NOT NULL,
            user_id TEXT NOT NULL,
            key TEXT NOT NULL,
            value TEXT NOT NULL,
            confidence REAL NOT NULL DEFAULT 1.0,
            importance INTEGER NOT NULL DEFAULT 1,
            source TEXT NOT NULL DEFAULT 'extracted',
            node_id TEXT NOT NULL DEFAULT 'master',
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            expires_at TEXT,
            PRIMARY KEY (character_id, user_id, key)
        );

        CREATE TABLE IF NOT EXISTS mem_char_world_knowledge (
            character_id TEXT NOT NULL,
            fact TEXT NOT NULL,
            source TEXT NOT NULL,
            fetched_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            expires_at TEXT NOT NULL,
            PRIMARY KEY (character_id, fact)
        );

        -- Evolution block, stored as JSON
        CREATE TABLE IF NOT EXISTS mem_char_evolution_state (
            character_id TEXT NOT NULL,
            user_id TEXT NOT NULL,
            state_json TEXT NOT NULL DEFAULT '{}',
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (character_id, user_id)
        );

        CREATE TABLE IF NOT EXISTS mem_char_cross_awareness (
            user_id TEXT NOT NULL,
            char_a TEXT NOT NULL,
            char_b TEXT NOT NULL,
            fact TEXT NOT NULL,
            PRIMARY KEY (user_id, char_a, char_b, fact)
        );

        -- L3 Archival Block (Master Node Only)
        -- Assumed to be loaded by the core app connections.
        CREATE TABLE IF NOT EXISTS mem_archival_content (
            id TEXT PRIMARY KEY,
            user_id TEXT DEFAULT 'system',
            character_id TEXT DEFAULT 'system',
            source TEXT NOT NULL,
            content TEXT NOT NULL,
            importance INTEGER NOT NULL DEFAULT 1,
            confidence REAL NOT NULL DEFAULT 1.0,
            timestamp TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        -- FTS5 Keyword Search for Archival Content
        CREATE VIRTUAL TABLE IF NOT EXISTS mem_archival_fts USING fts5(
            id UNINDEXED,
            content,
            content='mem_archival_content'
        );

        -- L5 Reflection Layer
        CREATE TABLE IF NOT EXISTS mem_reflection_cache (
            id TEXT PRIMARY KEY,
            character_id TEXT NOT NULL,
            user_id TEXT NOT NULL,
            insight TEXT NOT NULL,
            basis_memory_ids TEXT NOT NULL, -- Comma-separated list of IDs
            importance_score INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        -- Memory Importance Queue (Compounding Confidence)
        CREATE TABLE IF NOT EXISTS memory_importance_queue (
            id TEXT PRIMARY KEY,
            candidate_text TEXT NOT NULL,
            character_id TEXT NOT NULL,
            user_id TEXT NOT NULL,
            confidence REAL NOT NULL DEFAULT 0.0,
            surface_count INTEGER NOT NULL DEFAULT 1,
            first_seen TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            last_seen TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        -- Triggers to keep FTS in sync with mem_archival_content
        CREATE TRIGGER IF NOT EXISTS trg_archival_ai AFTER INSERT ON mem_archival_content BEGIN
            INSERT INTO mem_archival_fts(id, content) VALUES (new.id, new.content);
        END;
        CREATE TRIGGER IF NOT EXISTS trg_archival_ad AFTER DELETE ON mem_archival_content BEGIN
            INSERT INTO mem_archival_fts(mem_archival_fts, id, content) VALUES('delete', old.id, old.content);
        END;
        CREATE TRIGGER IF NOT EXISTS trg_archival_au AFTER UPDATE ON mem_archival_content BEGIN
            INSERT INTO mem_archival_fts(mem_archival_fts, id, content) VALUES('delete', old.id, old.content);
            INSERT INTO mem_archival_fts(id, content) VALUES (new.id, new.content);
        END;

        -- Session Memory (Short-term conversation facts)
        CREATE TABLE IF NOT EXISTS mem_session_context (
            session_id TEXT NOT NULL,
            key TEXT NOT NULL,
            value TEXT NOT NULL,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (session_id, key)
        );

        CREATE INDEX IF NOT EXISTS idx_mem_session_context_updated
        ON mem_session_context(session_id, updated_at DESC);

        -- Sync Queue for Multi-Node Replication
        CREATE TABLE IF NOT EXISTS memory_sync_queue (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            table_name TEXT NOT NULL,
            operation TEXT NOT NULL,
            payload_json TEXT NOT NULL,
            timestamp TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE INDEX IF NOT EXISTS idx_memory_sync_queue_timestamp
        ON memory_sync_queue(timestamp DESC, id DESC);
        """
    )
    _ensure_column(conn, "mem_char_user_memory", "importance", "INTEGER NOT NULL DEFAULT 1")
    _ensure_column(conn, "mem_char_user_memory", "expires_at", "TEXT")


def _ensure_column(conn: sqlite3.Connection, table_name: str, column_name: str, ddl: str) -> None:
    """Add one column to one table if it is missing."""
    columns = {
        str(row["name"])
        for row in conn.execute(f"PRAGMA table_info({table_name})").fetchall()
    }
    if column_name in columns:
        return
    conn.execute(f"ALTER TABLE {table_name} ADD COLUMN {column_name} {ddl}")

    # Virtual Vector Table for Semantic Search (768 dims for nomic-embed-text)
    try:
        conn.execute(
            """
            CREATE VIRTUAL TABLE IF NOT EXISTS vec_archival USING vec0(
                id TEXT PRIMARY KEY,
                embedding FLOAT[768]
            );
            """
        )
    except sqlite3.OperationalError as exc:
        if "no such module" in str(exc):
            LOGGER.info(
                "sqlite-vec extension not loaded — skipping vec_archival table."
            )
        else:
            raise
