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
            source TEXT NOT NULL DEFAULT 'extracted',
            node_id TEXT NOT NULL DEFAULT 'master',
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
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
        -- Assumes sqlite-vec extension is loaded by the core app connections.
        CREATE TABLE IF NOT EXISTS mem_archival_content (
            id TEXT PRIMARY KEY,
            source TEXT NOT NULL,
            content TEXT NOT NULL,
            timestamp TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

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
