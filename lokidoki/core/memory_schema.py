"""SQLite schema for the user-scoped memory store.

Why this lives in its own module
--------------------------------
The MemoryProvider only owns runtime state and queries. The DDL is large
enough that mixing it in would push that file over the 250-line cap from
CLAUDE.md, and keeping it isolated lets schema-only changes be reviewed
without churn in provider logic.

PR1 covers: users, people, relationships, facts, sessions, messages,
facts_fts (FTS5 external-content), messages_fts (FTS5 external-content),
and vec_facts (sqlite-vec vec0 virtual table). People and relationships
are created now even though the routes that read them ship in PR2 — the
storage shape needs to be stable from day one so we don't have to
migrate user data between PR1 and PR2.

FTS5 external-content design
----------------------------
We use ``content=`` external-content tables instead of stand-alone FTS5
tables. The base tables (``facts``, ``messages``) own the canonical
rows; the FTS shadow tables only store the inverted index. Trigger
``AFTER INSERT/UPDATE/DELETE`` on the base table keeps the index in
sync. This is the SQLite-recommended pattern when you also want
non-text columns and FKs on the base rows — see
https://sqlite.org/fts5.html#external_content_tables.

vec0 / sqlite-vec
-----------------
``vec_facts`` is a vec0 virtual table sized to 384 dims (matches the
embedding-model dimension we'll use in PR2). If sqlite-vec fails to
load at runtime the provider catches it, logs a warning, and the table
simply isn't created — search degrades to FTS5/BM25 only and the rest
of the schema works fine.
"""
from __future__ import annotations

EMBEDDING_DIM = 384  # TODO(embeddings-perf): wire to real model when sync-on-write becomes a bottleneck

CORE_SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    pin_hash TEXT,                          -- bcrypt hash of PIN (PR2)
    password_hash TEXT,                     -- bcrypt hash of admin password (nullable)
    role TEXT NOT NULL DEFAULT 'user',      -- 'admin' | 'user'
    status TEXT NOT NULL DEFAULT 'active',  -- 'active' | 'disabled' | 'deleted'
    last_password_auth_at INTEGER,          -- unix seconds; admin freshness window
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS app_secrets (
    name TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_sentiment (
    owner_user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    sentiment TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS people (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
    -- NOTE: deliberately NO UNIQUE on (owner_user_id, name). Multiple
    -- people can share a first name (brother Artie, dog Artie, celebrity
    -- Artie Lange). Disambiguation lives in the orchestrator.
);
CREATE INDEX IF NOT EXISTS idx_people_owner ON people(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_people_owner_name ON people(owner_user_id, name);

CREATE TABLE IF NOT EXISTS relationships (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
    relation TEXT NOT NULL,                 -- e.g. 'brother', 'coworker'
    confidence REAL NOT NULL DEFAULT 0.6,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(owner_user_id, person_id, relation)
);
CREATE INDEX IF NOT EXISTS idx_relationships_owner ON relationships(owner_user_id);

CREATE TABLE IF NOT EXISTS ambiguity_groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    raw_name TEXT NOT NULL,
    candidate_person_ids TEXT NOT NULL,    -- JSON array of people.id
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    resolved_person_id INTEGER REFERENCES people(id) ON DELETE SET NULL,
    resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_ambig_owner ON ambiguity_groups(owner_user_id);

CREATE TABLE IF NOT EXISTS clarification_state (
    owner_user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    last_asked_at TEXT,
    turns_since_ask INTEGER NOT NULL DEFAULT 99
);

CREATE TABLE IF NOT EXISTS facts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    subject TEXT NOT NULL,                  -- 'self' or lowercased person name (also indexed by FTS)
    subject_type TEXT NOT NULL DEFAULT 'self',  -- 'self' | 'person'  (PR3)
    subject_ref_id INTEGER REFERENCES people(id) ON DELETE CASCADE, -- people.id when subject_type='person'
    predicate TEXT NOT NULL,                -- e.g. 'likes', 'is_named'
    value TEXT NOT NULL,                    -- e.g. 'Incredibles', 'Jesse'
    category TEXT NOT NULL DEFAULT 'general',
    confidence REAL NOT NULL DEFAULT 0.6,
    observation_count INTEGER NOT NULL DEFAULT 1,
    last_observed_at TEXT NOT NULL DEFAULT (datetime('now')),
    status TEXT NOT NULL DEFAULT 'active',
        -- 'pending' | 'active' | 'ambiguous' | 'rejected' | 'superseded'
    ambiguity_group_id INTEGER REFERENCES ambiguity_groups(id) ON DELETE SET NULL,
    source_message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL
    -- NOTE: deliberately NOT UNIQUE on (owner, subject, predicate, value).
    -- Conflicting rows with same (owner, subject, predicate) and DIFFERENT
    -- value must coexist so PR3's conflict UI has something to resolve.
    -- Dedup-and-confirm is enforced in MemoryProvider.upsert_fact, not in
    -- a UNIQUE constraint.
);
CREATE INDEX IF NOT EXISTS idx_facts_owner ON facts(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_facts_owner_spv ON facts(owner_user_id, subject, predicate, value);
CREATE INDEX IF NOT EXISTS idx_facts_person ON facts(owner_user_id, subject_ref_id);

CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL DEFAULT '',
    project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sessions_owner ON sessions(owner_user_id);
-- idx_sessions_project is created in memory_init AFTER project_id column
-- migration so pre-projects DBs can upgrade cleanly.

CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    prompt TEXT NOT NULL DEFAULT '',
    icon TEXT NOT NULL DEFAULT 'Folder',           -- lucide-react icon name
    icon_color TEXT NOT NULL DEFAULT 'swatch-1',   -- token from --ld-swatch-N
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_projects_owner ON projects(owner_user_id);

CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL,                     -- 'user' | 'assistant'
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
CREATE INDEX IF NOT EXISTS idx_messages_owner ON messages(owner_user_id);
"""

FTS_SCHEMA = """
-- External-content FTS5 over facts.value (search the actual claim text).
CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts USING fts5(
    value,
    subject UNINDEXED,
    owner_user_id UNINDEXED,
    content='facts',
    content_rowid='id',
    tokenize='porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS facts_ai AFTER INSERT ON facts BEGIN
    INSERT INTO facts_fts(rowid, value, subject, owner_user_id)
    VALUES (new.id, new.value, new.subject, new.owner_user_id);
END;
CREATE TRIGGER IF NOT EXISTS facts_ad AFTER DELETE ON facts BEGIN
    INSERT INTO facts_fts(facts_fts, rowid, value, subject, owner_user_id)
    VALUES('delete', old.id, old.value, old.subject, old.owner_user_id);
END;
CREATE TRIGGER IF NOT EXISTS facts_au AFTER UPDATE ON facts BEGIN
    INSERT INTO facts_fts(facts_fts, rowid, value, subject, owner_user_id)
    VALUES('delete', old.id, old.value, old.subject, old.owner_user_id);
    INSERT INTO facts_fts(rowid, value, subject, owner_user_id)
    VALUES (new.id, new.value, new.subject, new.owner_user_id);
END;

-- External-content FTS5 over messages.content for transcript search.
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
    content,
    role UNINDEXED,
    owner_user_id UNINDEXED,
    content='messages',
    content_rowid='id',
    tokenize='porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(rowid, content, role, owner_user_id)
    VALUES (new.id, new.content, new.role, new.owner_user_id);
END;
CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, content, role, owner_user_id)
    VALUES('delete', old.id, old.content, old.role, old.owner_user_id);
END;
CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, content, role, owner_user_id)
    VALUES('delete', old.id, old.content, old.role, old.owner_user_id);
    INSERT INTO messages_fts(rowid, content, role, owner_user_id)
    VALUES (new.id, new.content, new.role, new.owner_user_id);
END;
"""


def vec_schema(dim: int = EMBEDDING_DIM) -> str:
    """vec0 virtual table DDL for fact embeddings.

    Separate function so the provider can choose not to call it when
    sqlite-vec failed to load at runtime.
    """
    return f"""
    CREATE VIRTUAL TABLE IF NOT EXISTS vec_facts USING vec0(
        fact_id INTEGER PRIMARY KEY,
        embedding FLOAT[{dim}]
    );
    """
