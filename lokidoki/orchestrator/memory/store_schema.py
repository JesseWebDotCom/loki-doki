"""Core memory schema — all CREATE TABLE / INDEX / TRIGGER statements.

Extracted from store.py to keep the main module under the 300-line ceiling.
The schema is applied once during ``MemoryStore._bootstrap()``.
"""
from __future__ import annotations

MEMORY_CORE_SCHEMA: str = """
CREATE TABLE IF NOT EXISTS facts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_user_id INTEGER NOT NULL,
    subject TEXT NOT NULL,
    predicate TEXT NOT NULL,
    value TEXT NOT NULL,
    confidence REAL NOT NULL DEFAULT 0.7,
    status TEXT NOT NULL DEFAULT 'active',
    observation_count INTEGER NOT NULL DEFAULT 1,
    source_text TEXT,
    superseded_by INTEGER,
    -- M2.5: pre-computed embedding stored as a JSON array of floats.
    embedding TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_facts_uniq
    ON facts(owner_user_id, subject, predicate, value)
    WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_facts_owner_subject
    ON facts(owner_user_id, subject);

CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts USING fts5(
    value,
    source_text,
    subject UNINDEXED,
    predicate UNINDEXED,
    owner_user_id UNINDEXED,
    status UNINDEXED,
    content='facts',
    content_rowid='id',
    tokenize='porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS facts_fts_ai AFTER INSERT ON facts BEGIN
    INSERT INTO facts_fts(rowid, value, source_text, subject, predicate, owner_user_id, status)
    VALUES (
        new.id,
        new.value,
        REPLACE(new.predicate, '_', ' ') || ' ' || COALESCE(new.source_text, ''),
        new.subject,
        new.predicate,
        new.owner_user_id,
        new.status
    );
END;

CREATE TRIGGER IF NOT EXISTS facts_fts_ad AFTER DELETE ON facts BEGIN
    INSERT INTO facts_fts(facts_fts, rowid, value, source_text, subject, predicate, owner_user_id, status)
    VALUES (
        'delete',
        old.id,
        old.value,
        REPLACE(old.predicate, '_', ' ') || ' ' || COALESCE(old.source_text, ''),
        old.subject,
        old.predicate,
        old.owner_user_id,
        old.status
    );
END;

CREATE TRIGGER IF NOT EXISTS facts_fts_au AFTER UPDATE ON facts BEGIN
    INSERT INTO facts_fts(facts_fts, rowid, value, source_text, subject, predicate, owner_user_id, status)
    VALUES (
        'delete',
        old.id,
        old.value,
        REPLACE(old.predicate, '_', ' ') || ' ' || COALESCE(old.source_text, ''),
        old.subject,
        old.predicate,
        old.owner_user_id,
        old.status
    );
    INSERT INTO facts_fts(rowid, value, source_text, subject, predicate, owner_user_id, status)
    VALUES (
        new.id,
        new.value,
        REPLACE(new.predicate, '_', ' ') || ' ' || COALESCE(new.source_text, ''),
        new.subject,
        new.predicate,
        new.owner_user_id,
        new.status
    );
END;

CREATE TABLE IF NOT EXISTS people (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_user_id INTEGER NOT NULL,
    name TEXT,
    handle TEXT,
    provisional INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_people_owner_name
    ON people(owner_user_id, name) WHERE name IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_people_owner_handle
    ON people(owner_user_id, handle) WHERE handle IS NOT NULL;

CREATE TABLE IF NOT EXISTS relationships (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_user_id INTEGER NOT NULL,
    person_id INTEGER NOT NULL,
    relation_label TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (person_id) REFERENCES people(id) ON DELETE CASCADE,
    UNIQUE (owner_user_id, person_id, relation_label)
);

CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_user_id INTEGER NOT NULL,
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    ended_at TEXT,
    session_state TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_owner_started
    ON sessions(owner_user_id, started_at DESC);

CREATE TABLE IF NOT EXISTS episodes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_user_id INTEGER NOT NULL,
    session_id INTEGER,
    title TEXT NOT NULL,
    summary TEXT NOT NULL,
    start_at TEXT NOT NULL,
    end_at TEXT,
    sentiment TEXT,
    entities TEXT,
    topic_scope TEXT,
    confidence REAL NOT NULL DEFAULT 0.5,
    superseded_by INTEGER,
    recall_count INTEGER NOT NULL DEFAULT 0,
    last_recalled_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE SET NULL,
    FOREIGN KEY (superseded_by) REFERENCES episodes(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_episodes_owner_start
    ON episodes(owner_user_id, start_at DESC);

CREATE INDEX IF NOT EXISTS idx_episodes_topic_scope
    ON episodes(owner_user_id, topic_scope) WHERE topic_scope IS NOT NULL;

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

CREATE TABLE IF NOT EXISTS behavior_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_user_id INTEGER NOT NULL,
    at TEXT NOT NULL DEFAULT (datetime('now')),
    event_type TEXT NOT NULL,
    payload TEXT
);

CREATE INDEX IF NOT EXISTS idx_behavior_events_owner_at
    ON behavior_events(owner_user_id, at DESC);

CREATE TABLE IF NOT EXISTS user_profile (
    owner_user_id INTEGER PRIMARY KEY,
    style TEXT,
    telemetry TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS affect_window (
    owner_user_id INTEGER NOT NULL,
    character_id TEXT NOT NULL,
    day TEXT NOT NULL,
    sentiment_avg REAL NOT NULL,
    notable_concerns TEXT,
    PRIMARY KEY (owner_user_id, character_id, day)
);

CREATE INDEX IF NOT EXISTS idx_affect_recent
    ON affect_window(owner_user_id, character_id, day DESC);
"""
