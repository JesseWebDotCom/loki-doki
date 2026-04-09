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

-- Per-skill configuration.
--
-- Two tiers, same shape:
--   * skill_config_global: admin-set values that apply to every user
--     (e.g. an OpenWeatherMap API key the admin pays for).
--   * skill_config_user: per-user overrides or personal inputs
--     (e.g. each user's default zip code, or a user's own API key that
--     shadows the admin's global one).
--
-- Lookup at skill-execute time merges {global ← user} so user values
-- always win. Values are stored as TEXT; numeric/bool fields declared
-- in a skill's manifest config_schema are JSON-decoded in the Python
-- layer, never parsed in SQL.
CREATE TABLE IF NOT EXISTS skill_config_global (
    skill_id TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (skill_id, key)
);

CREATE TABLE IF NOT EXISTS skill_config_user (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    skill_id TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, skill_id, key)
);
CREATE INDEX IF NOT EXISTS idx_skill_cfg_user ON skill_config_user(user_id, skill_id);

-- Cross-skill result cache. The SkillExecutor checks this table BEFORE
-- calling a mechanism and writes successful results AFTER. Skills don't
-- touch it directly — they declare a default TTL in their manifest and
-- the executor handles read/write/expiry transparently.
--
-- key:
--   sha1 over (skill_id, mechanism, canonical_json(parameters_minus_config)).
--   Stripping _config keeps secrets out of the key and lets two users on
--   the same ZIP share a row.
-- expires_at:
--   ISO-8601 UTC instant. Reads compare against datetime('now'). A NULL
--   expires_at means "never expires" — currently unused but reserved for
--   ref-data caches (TMDB title metadata, wiki summaries) we may add later.
-- value:
--   JSON-encoded SkillResult.data. We do NOT store source_url/title here
--   because the executor stamps those from the live MechanismResult; on a
--   cache hit they're rebuilt from the parallel cached_meta JSON column.
-- cached_meta:
--   JSON of {source_url, source_title, mechanism_used} so a hit can
--   reconstitute a full SkillResult identical to the live path.
CREATE TABLE IF NOT EXISTS skill_result_cache (
    cache_key TEXT PRIMARY KEY,
    skill_id TEXT NOT NULL,
    mechanism TEXT NOT NULL,
    value TEXT NOT NULL,
    cached_meta TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_skill_cache_skill ON skill_result_cache(skill_id, mechanism);
CREATE INDEX IF NOT EXISTS idx_skill_cache_expiry ON skill_result_cache(expires_at);

-- Manual enable/disable toggles, distinct from the auto-disabled
-- "missing required config" state. Both tiers default to "enabled"
-- when no row exists, so admins/users only need to write a row when
-- they want to override the default. The orchestrator AND-merges:
--   effective = admin_toggle AND user_toggle AND config_satisfied
CREATE TABLE IF NOT EXISTS skill_enabled_global (
    skill_id TEXT PRIMARY KEY,
    enabled INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS skill_enabled_user (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    skill_id TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, skill_id)
);

CREATE TABLE IF NOT EXISTS user_sentiment (
    owner_user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    sentiment TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Per-turn sentiment log. user_sentiment above is a single-row JSON
-- snapshot of the latest decomposer output; this table is the time
-- series so the synthesizer can reason about an emotional ARC ("user
-- has been frustrated for three turns") instead of just the current
-- turn's reading. Append-only, indexed by owner+time, never edited.
CREATE TABLE IF NOT EXISTS sentiment_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    sentiment TEXT NOT NULL,
    concern TEXT NOT NULL DEFAULT '',
    source_message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sentiment_log_owner ON sentiment_log(owner_user_id, created_at DESC);

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
    subject TEXT NOT NULL,                  -- 'self' or lowercased person/entity name (also indexed by FTS)
    subject_type TEXT NOT NULL DEFAULT 'self',  -- 'self' | 'person' | 'entity'
    subject_ref_id INTEGER REFERENCES people(id) ON DELETE CASCADE, -- people.id when subject_type='person'; NULL for self/entity
    predicate TEXT NOT NULL,                -- e.g. 'likes', 'is_named'
    value TEXT NOT NULL,                    -- e.g. 'Incredibles', 'Jesse'
    kind TEXT NOT NULL DEFAULT 'fact',      -- 'fact'|'preference'|'event'|'advice'|'relationship' (memory taxonomy)
    category TEXT NOT NULL DEFAULT 'general',
    confidence REAL NOT NULL DEFAULT 0.6,
    observation_count INTEGER NOT NULL DEFAULT 1,
    last_observed_at TEXT NOT NULL DEFAULT (datetime('now')),
    status TEXT NOT NULL DEFAULT 'active',
        -- 'pending' | 'active' | 'ambiguous' | 'rejected' | 'superseded'
    ambiguity_group_id INTEGER REFERENCES ambiguity_groups(id) ON DELETE SET NULL,
    source_message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
    valid_from TEXT NOT NULL DEFAULT (datetime('now')),  -- when this claim became true
    valid_to TEXT,                                       -- when superseded; NULL = currently true
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

-- Character system (see docs/CHARACTER_SYSTEM.md §3).
--
-- voices/wakewords use string PKs because they map 1:1 to on-disk
-- model identifiers (e.g. "en_US-lessac-medium", a Piper voice id).
-- Characters reference them via nullable FK so a character can be
-- created before its assets are installed; the provisioner backfills.
CREATE TABLE IF NOT EXISTS voices (
    id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    is_global INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'missing',  -- 'installed' | 'missing' | 'downloading'
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS wakewords (
    id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    file_path TEXT NOT NULL DEFAULT '',
    is_global INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'missing',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS characters (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    phonetic_name TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    behavior_prompt TEXT NOT NULL DEFAULT '',
    avatar_style TEXT NOT NULL DEFAULT 'bottts',  -- 'avataaars'|'bottts'|'toon-head'
    avatar_seed TEXT NOT NULL DEFAULT '',
    avatar_config TEXT NOT NULL DEFAULT '{}',     -- JSON blob, parsed in Python
    voice_id TEXT REFERENCES voices(id) ON DELETE SET NULL,
    wakeword_id TEXT REFERENCES wakewords(id) ON DELETE SET NULL,
    source TEXT NOT NULL DEFAULT 'user',           -- 'builtin' | 'admin' | 'user'
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_characters_source ON characters(source);

-- Per-user pointer at the active character. Mirrors the
-- skill_enabled_user / skill_config_user shape: the catalog
-- (`characters`) is admin-managed and global, but each user picks
-- their own active character. ON DELETE SET NULL on the FK means
-- deleting a character doesn't orphan the row — `get_active_*`
-- falls back to a builtin in code.
CREATE TABLE IF NOT EXISTS character_settings_user (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    active_character_id INTEGER REFERENCES characters(id) ON DELETE SET NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Per-user overrides on top of a catalog character row. Same merge
-- direction as skill_config: catalog ← user_overrides, user wins.
-- All override columns are nullable; NULL means "use the catalog
-- value". A row exists only if a user has actually customized
-- something for that character.
--
-- We deliberately do NOT allow overriding `source` or `id` (those
-- are catalog identity) or `voice_id`/`wakeword_id` (those bind to
-- on-disk assets that the admin provisions — letting users point at
-- arbitrary files would break the asset budget rules in §5).
CREATE TABLE IF NOT EXISTS character_overrides_user (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
    name TEXT,
    phonetic_name TEXT,
    description TEXT,
    behavior_prompt TEXT,
    avatar_style TEXT,
    avatar_seed TEXT,
    avatar_config TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, character_id)
);
CREATE INDEX IF NOT EXISTS idx_char_overrides_user ON character_overrides_user(user_id);

-- Two-tier enable toggles for characters, mirroring
-- skill_enabled_global / skill_enabled_user. Both default to
-- "enabled" when no row exists, so admins/users only need to write
-- a row when they want to override the default. Resolution at read
-- time AND-merges:
--   visible = global_enabled AND user_enabled
-- Disabling a character globally hides it from every user without
-- destroying the catalog row (so it can be re-enabled later). Per-
-- user rows let admins restrict specific characters away from
-- specific users (e.g. an "after-hours only" persona).
CREATE TABLE IF NOT EXISTS character_enabled_global (
    character_id INTEGER PRIMARY KEY REFERENCES characters(id) ON DELETE CASCADE,
    enabled INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS character_enabled_user (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
    enabled INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, character_id)
);
CREATE INDEX IF NOT EXISTS idx_char_enabled_user ON character_enabled_user(user_id);
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
    """vec0 virtual table DDL for fact AND message embeddings.

    Two virtual tables, both 384-dim:
      - ``vec_facts``    : one row per row in ``facts``
      - ``vec_messages`` : one row per user-role row in ``messages``
                           (assistant turns are not embedded — they
                           dilute the index and we don't search them)

    Separate function so the provider can choose not to call it when
    sqlite-vec failed to load at runtime.
    """
    return f"""
    CREATE VIRTUAL TABLE IF NOT EXISTS vec_facts USING vec0(
        fact_id INTEGER PRIMARY KEY,
        embedding FLOAT[{dim}]
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS vec_messages USING vec0(
        message_id INTEGER PRIMARY KEY,
        embedding FLOAT[{dim}]
    );
    """
