"""
memory storage layer — clean cutover from v1.

The memory store opens its **own** SQLite file at
``data/memory.sqlite`` (configurable per-instance) and writes to its
own tables. It imports zero v1 modules. v1's memory at
``lokidoki/core/memory_*`` and its SQLite file are untouched. A clean
cutover from v1 is "delete v1 modules, point the app at this store"
— no data migration is required because the two systems write to
different files.

Phase status: M1 — implements Tier 4 (semantic_self) and Tier 5 (social)
write paths. Reads land in M2 (Tier 4) and M3 (Tier 5). M2.5 added a
JSON-encoded ``embedding`` column populated lazily by the embedding
backend on insert; the reader fuses BM25 + subject-scan + vector via RRF.

Storage shape (M1 subset):

    facts(
        id, owner_user_id, subject, predicate, value,
        confidence, status, observation_count, source_text,
        created_at, updated_at, superseded_by
    )

    people(
        id, owner_user_id, name, handle, provisional,
        created_at, updated_at
    )

    relationships(
        id, owner_user_id, person_id, relation_label,
        created_at
    )

The schema mirrors v1's shape semantically so a future merge migration
is conceivable, but the rows live in a different file. M4–M6 add the
remaining tables via :func:`apply_memory_schema` against this same
file.
"""
from __future__ import annotations

import json
import logging
import sqlite3
import threading
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Iterable, Optional

from lokidoki.orchestrator.memory.candidate import MemoryCandidate
from lokidoki.orchestrator.memory.predicates import (
    SUPERSEDED_CONFIDENCE_FLOOR,
    is_immediate_durable,
    is_single_value,
)
from lokidoki.orchestrator.memory.tiers import Tier

log = logging.getLogger("lokidoki.orchestrator.memory.store")

# Default location for the memory file. The file lives under
# ``data/`` next to the rest of the pipeline state. Tests pass a
# ``:memory:`` connection or a tmp_path file instead.
DEFAULT_DB_PATH = Path("data/memory.sqlite")


# ---------------------------------------------------------------------------
# Core memory schema
# ---------------------------------------------------------------------------

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
    -- Lazy-populated on the write path so the BM25 + vector hybrid in
    -- the reader can fuse them via RRF without a side car table or
    -- sqlite-vec dependency. The column may be NULL for rows written
    -- before M2.5 shipped or for rows where the embedding backend
    -- failed.
    embedding TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_facts_uniq
    ON facts(owner_user_id, subject, predicate, value)
    WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_facts_owner_subject
    ON facts(owner_user_id, subject);

-- FTS5 virtual table for Tier 4 read path (M2). Indexes the value text
-- and the source_text so a query about "favorite color" can match either
-- the literal value or the original utterance phrasing. Triggers below
-- keep it in sync with the facts table including supersession.
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

-- The FTS triggers store a *humanized* form of the predicate alongside
-- the source_text so a query like "where do I live" stems to "live"
-- and matches the predicate "lives_in" (humanized to "lives in"). The
-- raw facts.source_text column is unchanged — only the FTS5 index
-- sees the enriched text. This is the M2 design fix that lets BM25
-- bridge user vocabulary and stored predicate identifiers without
-- substring-matching the user input.
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

-- M4: sessions + session_state for Tier 2 (active thread).
-- session_state is a JSON blob holding last-seen maps, in-session
-- consolidation counters, and any other per-session ephemera. The
-- column is nullable so a freshly inserted session row reads as the
-- empty dict.
CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_user_id INTEGER NOT NULL,
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    ended_at TEXT,
    session_state TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_owner_started
    ON sessions(owner_user_id, started_at DESC);

-- M4: Tier 3 episodic memory. Episodes are written by the out-of-band
-- session-close summarization job; they are time-anchored, summarized
-- past interactions with optional topic_scope tags. The summary text is
-- mirrored into episodes_fts via the triggers below so the M4 reader can
-- run BM25 over the summary alongside temporal-proximity scoring.
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

-- M5: Tier 7 procedural memory — behavior event log + user profile.
CREATE TABLE IF NOT EXISTS behavior_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_user_id INTEGER NOT NULL,
    at TEXT NOT NULL DEFAULT (datetime('now')),
    event_type TEXT NOT NULL,
    payload TEXT                         -- JSON
);

CREATE INDEX IF NOT EXISTS idx_behavior_events_owner_at
    ON behavior_events(owner_user_id, at DESC);

CREATE TABLE IF NOT EXISTS user_profile (
    owner_user_id INTEGER PRIMARY KEY,
    style TEXT,                          -- JSON, prompt-safe (sub-tier 7a)
    telemetry TEXT,                      -- JSON, prompt-forbidden (sub-tier 7b)
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- M6: Tier 6 affective memory — rolling sentiment per user+character pair.
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


@dataclass(frozen=True)
class WriteOutcome:
    """Result of a single write through the store."""

    accepted: bool
    tier: Tier | None
    fact_id: int | None
    person_id: int | None
    superseded_id: int | None
    immediate_durable: bool
    note: str = ""


class MemoryStore:
    """Thread-safe SQLite store for the memory subsystem.

    Designed for **clean cutover** from v1: no v1 imports, separate
    SQLite file by default, deterministic schema bootstrap.
    """

    def __init__(self, db_path: str | Path | None = None) -> None:
        self._lock = threading.RLock()
        if db_path is None:
            db_path = DEFAULT_DB_PATH
        if isinstance(db_path, Path):
            db_path.parent.mkdir(parents=True, exist_ok=True)
            self._db_uri: str | Path = db_path
        else:
            # Allow ":memory:" string for tests.
            self._db_uri = db_path
        self._conn = sqlite3.connect(
            str(self._db_uri),
            check_same_thread=False,
            isolation_level=None,  # autocommit; we manage transactions explicitly
        )
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA foreign_keys = ON;")
        self._bootstrap()

    def _bootstrap(self) -> None:
        with self._lock:
            self._conn.executescript(MEMORY_CORE_SCHEMA)

    def close(self) -> None:
        with self._lock:
            self._conn.close()

    # -------------------------------------------------------------------
    # Tier 4 — semantic_self facts
    # -------------------------------------------------------------------

    def write_semantic_fact(self, candidate: MemoryCandidate) -> WriteOutcome:
        """Insert or update a Tier 4 fact, applying single-value supersession."""
        with self._lock:
            superseded_id: int | None = None
            if is_single_value(candidate.predicate):
                superseded_id = self._supersede_single_value(candidate)

            existing = self._conn.execute(
                """
                SELECT id, observation_count, confidence
                FROM facts
                WHERE owner_user_id = ? AND subject = ? AND predicate = ? AND value = ?
                  AND status = 'active'
                """,
                (
                    candidate.owner_user_id,
                    candidate.subject,
                    candidate.predicate,
                    candidate.value,
                ),
            ).fetchone()

            now = _now()
            if existing is None:
                embedding_json = compute_fact_embedding(candidate)
                cursor = self._conn.execute(
                    """
                    INSERT INTO facts(
                        owner_user_id, subject, predicate, value,
                        confidence, status, observation_count, source_text,
                        embedding, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, 'active', 1, ?, ?, ?, ?)
                    """,
                    (
                        candidate.owner_user_id,
                        candidate.subject,
                        candidate.predicate,
                        candidate.value,
                        candidate.confidence,
                        candidate.source_text,
                        embedding_json,
                        now,
                        now,
                    ),
                )
                fact_id = int(cursor.lastrowid)
                return WriteOutcome(
                    accepted=True,
                    tier=Tier.SEMANTIC_SELF,
                    fact_id=fact_id,
                    person_id=None,
                    superseded_id=superseded_id,
                    immediate_durable=is_immediate_durable(4, candidate.predicate),
                    note="inserted",
                )

            new_count = int(existing["observation_count"]) + 1
            new_conf = min(1.0, float(existing["confidence"]) + 0.05)
            self._conn.execute(
                "UPDATE facts SET observation_count = ?, confidence = ?, updated_at = ? WHERE id = ?",
                (new_count, new_conf, now, int(existing["id"])),
            )
            return WriteOutcome(
                accepted=True,
                tier=Tier.SEMANTIC_SELF,
                fact_id=int(existing["id"]),
                person_id=None,
                superseded_id=superseded_id,
                immediate_durable=is_immediate_durable(4, candidate.predicate),
                note="updated",
            )

    def _supersede_single_value(self, candidate: MemoryCandidate) -> int | None:
        """Flip prior values for a single-value predicate to ``superseded``.

        Per design §5 v1.2: "New value writes at high confidence; prior
        value flips to `superseded` and drops to confidence floor 0.1."
        Returns the id of the row that was superseded (or None if no
        prior row existed).
        """
        prior = self._conn.execute(
            """
            SELECT id FROM facts
            WHERE owner_user_id = ? AND subject = ? AND predicate = ?
              AND value <> ? AND status = 'active'
            ORDER BY id DESC
            LIMIT 1
            """,
            (
                candidate.owner_user_id,
                candidate.subject,
                candidate.predicate,
                candidate.value,
            ),
        ).fetchone()
        if prior is None:
            return None
        prior_id = int(prior["id"])
        self._conn.execute(
            """
            UPDATE facts
            SET status = 'superseded',
                confidence = ?,
                updated_at = ?
            WHERE id = ?
            """,
            (SUPERSEDED_CONFIDENCE_FLOOR, _now(), prior_id),
        )
        return prior_id

    # -------------------------------------------------------------------
    # Tier 5 — social (people + relationships)
    # -------------------------------------------------------------------

    def write_social_fact(self, candidate: MemoryCandidate) -> WriteOutcome:
        """Insert or update a Tier 5 row, supporting provisional handles.

        Tier 5 facts come in two shapes:

        - ``person:Luke`` predicate=is_relation value=brother
          → ensures a `people` row for Luke and a `relationships` row.
        - ``handle:my boss`` predicate=is_relation value=boss
          → ensures a provisional `people` row with `name=NULL,
            handle="my boss", provisional=1` and a relationships row.
        - ``handle:my boss`` … followed later by ``person:Steve`` with
          the same handle context → see :meth:`merge_provisional_handle`.
        """
        with self._lock:
            subject = candidate.subject
            person_id: int | None = None
            note = ""
            if subject.startswith("person:"):
                name = subject.split(":", 1)[1].strip()
                # Auto-merge handle: if this is an `is_relation` write
                # for a named person, look for a provisional handle row
                # with the same relationship and promote it in place
                # instead of creating a duplicate. This is the M3.5
                # cross-turn merge for "my boss is being weird" then
                # later "my boss Steve approved it".
                relation_hint = (
                    candidate.value if candidate.predicate == "is_relation" else None
                )
                person_id = self._upsert_named_person(
                    candidate.owner_user_id,
                    name,
                    relation_for_auto_merge=relation_hint,
                )
                note = "person_upsert"
            elif subject.startswith("handle:"):
                handle = subject.split(":", 1)[1].strip()
                person_id = self._upsert_provisional_handle(
                    candidate.owner_user_id, handle
                )
                note = "handle_upsert"
            else:
                return WriteOutcome(
                    accepted=False,
                    tier=Tier.SOCIAL,
                    fact_id=None,
                    person_id=None,
                    superseded_id=None,
                    immediate_durable=False,
                    note=f"unsupported_subject:{subject}",
                )

            # Map predicates to relationship rows OR to facts rows
            # depending on what kind of social statement this is.
            if candidate.predicate == "is_relation":
                self._conn.execute(
                    """
                    INSERT OR IGNORE INTO relationships(
                        owner_user_id, person_id, relation_label
                    ) VALUES (?, ?, ?)
                    """,
                    (candidate.owner_user_id, person_id, candidate.value),
                )
            else:
                # Other Tier 5 predicates write into facts with a
                # subject prefix tied to the person id. Single-value
                # supersession applies as usual.
                fact_candidate = candidate.model_copy(
                    update={"subject": f"person:{person_id}"}
                )
                superseded_id: int | None = None
                if is_single_value(candidate.predicate):
                    superseded_id = self._supersede_single_value(fact_candidate)
                now = _now()
                self._conn.execute(
                    """
                    INSERT INTO facts(
                        owner_user_id, subject, predicate, value,
                        confidence, status, observation_count, source_text,
                        created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, 'active', 1, ?, ?, ?)
                    ON CONFLICT(owner_user_id, subject, predicate, value)
                    WHERE status = 'active'
                    DO UPDATE SET
                        observation_count = facts.observation_count + 1,
                        confidence = MIN(1.0, facts.confidence + 0.05),
                        updated_at = excluded.updated_at
                    """,
                    (
                        candidate.owner_user_id,
                        fact_candidate.subject,
                        candidate.predicate,
                        candidate.value,
                        candidate.confidence,
                        candidate.source_text,
                        now,
                        now,
                    ),
                )

            return WriteOutcome(
                accepted=True,
                tier=Tier.SOCIAL,
                fact_id=None,
                person_id=person_id,
                superseded_id=None,
                immediate_durable=is_immediate_durable(5, candidate.predicate),
                note=note,
            )

    def _upsert_named_person(
        self,
        owner_user_id: int,
        name: str,
        *,
        relation_for_auto_merge: str | None = None,
    ) -> int:
        """Upsert a named person row.

        When ``relation_for_auto_merge`` is provided AND no row already
        exists for ``(owner_user_id, name)``, the upsert first looks
        for a provisional handle row whose relationship label matches
        the incoming relation. If exactly one such row exists, the
        provisional row is **promoted** in place: name set, provisional
        flipped to 0, the existing handle and relationship edges
        preserved. This is the M3.5 auto-merge for utterances like
        *"my boss Steve approved it"* arriving after *"my boss is
        being weird"*.

        Per design §3 Layer 2 + §3 Gate 2 the auto-merge is **safe**
        because:
            - the resolution is single-candidate (no ambiguity)
            - the gate chain has already approved the candidate
            - a duplicate-named row would just create the same
              provisional/named pair the user manually merges later
        """
        existing = self._conn.execute(
            "SELECT id FROM people WHERE owner_user_id = ? AND name = ? AND provisional = 0",
            (owner_user_id, name),
        ).fetchone()
        if existing is not None:
            return int(existing["id"])

        if relation_for_auto_merge:
            promoted_id = self._maybe_promote_provisional_by_relation(
                owner_user_id, name=name, relation=relation_for_auto_merge
            )
            if promoted_id is not None:
                return promoted_id

        cursor = self._conn.execute(
            """
            INSERT INTO people(owner_user_id, name, handle, provisional)
            VALUES (?, ?, NULL, 0)
            """,
            (owner_user_id, name),
        )
        return int(cursor.lastrowid)

    def _maybe_promote_provisional_by_relation(
        self,
        owner_user_id: int,
        *,
        name: str,
        relation: str,
    ) -> int | None:
        """Look for a single provisional row whose relationships include
        ``relation``. If exactly one matches, promote it in place by
        setting its name and clearing the provisional flag, and return
        its id. If zero or multiple match, return None and the caller
        creates a fresh named row.
        """
        rows = self._conn.execute(
            """
            SELECT DISTINCT p.id, p.handle
            FROM people p
            JOIN relationships r
                ON r.owner_user_id = p.owner_user_id
               AND r.person_id = p.id
            WHERE p.owner_user_id = ?
              AND p.provisional = 1
              AND p.handle IS NOT NULL
              AND r.relation_label = ?
            """,
            (owner_user_id, relation),
        ).fetchall()
        if len(rows) != 1:
            return None
        target_id = int(rows[0]["id"])
        # Defensive: don't auto-merge if a *different* named row with
        # the same name already exists for this owner — that would
        # create cross-contamination. The caller's prior check on
        # (name=name, provisional=0) catches the same-name case, but
        # we re-check here to be safe across concurrent writes.
        named_collision = self._conn.execute(
            "SELECT id FROM people WHERE owner_user_id = ? AND name = ? AND provisional = 0 AND id <> ?",
            (owner_user_id, name, target_id),
        ).fetchone()
        if named_collision is not None:
            return None
        self._conn.execute(
            """
            UPDATE people
            SET name = ?, provisional = 0, updated_at = ?
            WHERE id = ?
            """,
            (name, _now(), target_id),
        )
        return target_id

    def _upsert_provisional_handle(self, owner_user_id: int, handle: str) -> int:
        existing = self._conn.execute(
            "SELECT id FROM people WHERE owner_user_id = ? AND handle = ? AND provisional = 1",
            (owner_user_id, handle),
        ).fetchone()
        if existing is not None:
            return int(existing["id"])
        cursor = self._conn.execute(
            """
            INSERT INTO people(owner_user_id, name, handle, provisional)
            VALUES (?, NULL, ?, 1)
            """,
            (owner_user_id, handle),
        )
        return int(cursor.lastrowid)

    def merge_provisional_handle(
        self,
        owner_user_id: int,
        *,
        handle: str,
        name: str,
    ) -> int | None:
        """Promote a provisional ``handle:`` row into a named row.

        Returns the merged row id, or None if no provisional row exists
        for that owner+handle.
        """
        with self._lock:
            row = self._conn.execute(
                "SELECT id FROM people WHERE owner_user_id = ? AND handle = ? AND provisional = 1",
                (owner_user_id, handle),
            ).fetchone()
            if row is None:
                return None
            row_id = int(row["id"])
            # If a named row already exists for that name, merge into it
            # by reassigning the relationships, then drop the provisional row.
            named = self._conn.execute(
                "SELECT id FROM people WHERE owner_user_id = ? AND name = ? AND provisional = 0",
                (owner_user_id, name),
            ).fetchone()
            if named is not None:
                target_id = int(named["id"])
                self._conn.execute(
                    "UPDATE relationships SET person_id = ? WHERE person_id = ?",
                    (target_id, row_id),
                )
                self._conn.execute("DELETE FROM people WHERE id = ?", (row_id,))
                return target_id
            self._conn.execute(
                """
                UPDATE people
                SET name = ?, provisional = 0, updated_at = ?
                WHERE id = ?
                """,
                (name, _now(), row_id),
            )
            return row_id

    # -------------------------------------------------------------------
    # Read helpers (M1 ships these for testing only — M2 builds the
    # real retrieval path on top)
    # -------------------------------------------------------------------

    def get_active_facts(
        self,
        owner_user_id: int,
        *,
        subject: str | None = None,
        predicate: str | None = None,
    ) -> list[dict[str, Any]]:
        sql = "SELECT * FROM facts WHERE owner_user_id = ? AND status = 'active'"
        params: list[Any] = [owner_user_id]
        if subject is not None:
            sql += " AND subject = ?"
            params.append(subject)
        if predicate is not None:
            sql += " AND predicate = ?"
            params.append(predicate)
        sql += " ORDER BY id"
        rows = self._conn.execute(sql, params).fetchall()
        return [dict(row) for row in rows]

    def get_superseded_facts(self, owner_user_id: int) -> list[dict[str, Any]]:
        rows = self._conn.execute(
            "SELECT * FROM facts WHERE owner_user_id = ? AND status = 'superseded' ORDER BY id",
            (owner_user_id,),
        ).fetchall()
        return [dict(row) for row in rows]

    def get_people(self, owner_user_id: int) -> list[dict[str, Any]]:
        rows = self._conn.execute(
            "SELECT * FROM people WHERE owner_user_id = ? ORDER BY id",
            (owner_user_id,),
        ).fetchall()
        return [dict(row) for row in rows]

    def get_relationships(
        self, owner_user_id: int, *, person_id: int | None = None
    ) -> list[dict[str, Any]]:
        sql = "SELECT * FROM relationships WHERE owner_user_id = ?"
        params: list[Any] = [owner_user_id]
        if person_id is not None:
            sql += " AND person_id = ?"
            params.append(person_id)
        sql += " ORDER BY id"
        rows = self._conn.execute(sql, params).fetchall()
        return [dict(row) for row in rows]

    # -------------------------------------------------------------------
    # Tier 2 — sessions + session_state (M4)
    # -------------------------------------------------------------------

    def create_session(self, owner_user_id: int) -> int:
        """Open a new session row for ``owner_user_id``. Returns its id."""
        with self._lock:
            cursor = self._conn.execute(
                "INSERT INTO sessions(owner_user_id, session_state) VALUES (?, ?)",
                (owner_user_id, json.dumps({})),
            )
            return int(cursor.lastrowid)

    def close_session(self, session_id: int) -> None:
        """Mark a session as closed by stamping ``ended_at``."""
        with self._lock:
            self._conn.execute(
                "UPDATE sessions SET ended_at = ? WHERE id = ?",
                (_now(), session_id),
            )

    def get_session_state(self, session_id: int) -> dict[str, Any]:
        """Return the session_state JSON for a session as a dict.

        Returns ``{}`` for an unknown session, a session with no state
        yet, or a session whose state column is corrupt — the M4
        consumers all treat the missing-state case as "no signal".
        """
        with self._lock:
            row = self._conn.execute(
                "SELECT session_state FROM sessions WHERE id = ?",
                (session_id,),
            ).fetchone()
        if row is None:
            return {}
        raw = row["session_state"]
        if not raw:
            return {}
        try:
            data = json.loads(raw)
        except (TypeError, ValueError):
            return {}
        return data if isinstance(data, dict) else {}

    def set_session_state(self, session_id: int, state: dict[str, Any]) -> None:
        """Replace the entire session_state for a session."""
        with self._lock:
            self._conn.execute(
                "UPDATE sessions SET session_state = ? WHERE id = ?",
                (json.dumps(state), session_id),
            )

    def update_last_seen(
        self,
        session_id: int,
        *,
        entity_type: str,
        entity_name: str,
    ) -> dict[str, Any]:
        """Record the most recent entity of ``entity_type`` for the session.

        The Tier 2 design (§2) calls for a per-type "last seen" map
        (``last_movie``, ``last_person``, ``last_location``…) that the
        pronoun resolver can consult on the next turn. This is the
        canonical writer; the pronoun resolver reads the map back via
        :meth:`get_session_state`.
        """
        if not entity_type or not entity_name:
            return self.get_session_state(session_id)
        key = f"last_{entity_type}"
        with self._lock:
            state = self.get_session_state(session_id)
            last_seen = state.get("last_seen") or {}
            if not isinstance(last_seen, dict):
                last_seen = {}
            last_seen[key] = {"name": entity_name, "at": _now()}
            state["last_seen"] = last_seen
            self.set_session_state(session_id, state)
            return state

    def bump_consolidation_counter(
        self,
        session_id: int,
        *,
        owner_user_id: int,
        subject: str,
        predicate: str,
    ) -> int:
        """Increment the in-session frequency counter for a (subject,predicate).

        Returns the post-increment count. The counter lives in
        ``session_state['consolidation']`` keyed by
        ``"{owner}:{subject}:{predicate}"`` so a single dict can hold
        every counter for the session, including 24h-rolling-window
        entries that survive a session close.
        """
        key = f"{owner_user_id}:{subject}:{predicate}"
        with self._lock:
            state = self.get_session_state(session_id)
            counters = state.get("consolidation") or {}
            if not isinstance(counters, dict):
                counters = {}
            entry = counters.get(key) or {"count": 0, "first_at": _now(), "last_at": _now()}
            if not isinstance(entry, dict):
                entry = {"count": 0, "first_at": _now(), "last_at": _now()}
            entry["count"] = int(entry.get("count", 0)) + 1
            entry["last_at"] = _now()
            counters[key] = entry
            state["consolidation"] = counters
            self.set_session_state(session_id, state)
            return int(entry["count"])

    # Maximum number of turns a last-seen entry survives before being
    # considered stale. Tunable; the design says "turn-distance > N drops
    # the entity" without pinning N. 5 is a reasonable default for a
    # conversational assistant — far enough to survive topical tangents,
    # close enough to prevent stale pronoun bindings.
    LAST_SEEN_MAX_TURN_DISTANCE: int = 5

    def decay_session_state(
        self,
        session_id: int,
        *,
        current_turn_index: int,
    ) -> dict[str, Any]:
        """Drop last-seen entries older than LAST_SEEN_MAX_TURN_DISTANCE turns.

        Each ``last_seen`` entry can optionally carry a ``turn`` integer;
        entries where ``current_turn_index - entry["turn"] > max_distance``
        are removed. Entries without a ``turn`` key are assumed to be
        current (added by the legacy ``update_last_seen`` which doesn't
        track turn index yet).

        Returns the updated state.
        """
        with self._lock:
            state = self.get_session_state(session_id)
            last_seen = state.get("last_seen")
            if not isinstance(last_seen, dict) or not last_seen:
                return state
            max_dist = self.LAST_SEEN_MAX_TURN_DISTANCE
            keys_to_drop: list[str] = []
            for key, entry in last_seen.items():
                if not isinstance(entry, dict):
                    keys_to_drop.append(key)
                    continue
                turn = entry.get("turn")
                if turn is not None and (current_turn_index - int(turn)) > max_dist:
                    keys_to_drop.append(key)
            for key in keys_to_drop:
                del last_seen[key]
            state["last_seen"] = last_seen
            self.set_session_state(session_id, state)
            return state

    def update_last_seen_with_turn(
        self,
        session_id: int,
        *,
        entity_type: str,
        entity_name: str,
        turn_index: int,
    ) -> dict[str, Any]:
        """Like ``update_last_seen`` but also records the turn index for decay."""
        if not entity_type or not entity_name:
            return self.get_session_state(session_id)
        key = f"last_{entity_type}"
        with self._lock:
            state = self.get_session_state(session_id)
            last_seen = state.get("last_seen") or {}
            if not isinstance(last_seen, dict):
                last_seen = {}
            last_seen[key] = {"name": entity_name, "at": _now(), "turn": turn_index}
            state["last_seen"] = last_seen
            self.set_session_state(session_id, state)
            return state

    def get_consolidation_counter(
        self,
        session_id: int,
        *,
        owner_user_id: int,
        subject: str,
        predicate: str,
    ) -> int:
        key = f"{owner_user_id}:{subject}:{predicate}"
        state = self.get_session_state(session_id)
        counters = state.get("consolidation") or {}
        if not isinstance(counters, dict):
            return 0
        entry = counters.get(key) or {}
        if not isinstance(entry, dict):
            return 0
        return int(entry.get("count", 0))

    # -------------------------------------------------------------------
    # Tier 3 — episodes (M4)
    # -------------------------------------------------------------------

    def write_episode(
        self,
        *,
        owner_user_id: int,
        title: str,
        summary: str,
        entities: list[dict[str, Any]] | None = None,
        sentiment: str | None = None,
        topic_scope: str | None = None,
        session_id: int | None = None,
        start_at: str | None = None,
        end_at: str | None = None,
        confidence: float = 0.5,
    ) -> int:
        """Insert an episode row. Returns the new id.

        Episodes are written by the out-of-band session-close
        summarization job (or directly by tests). The FTS5 trigger
        on the episodes table populates ``episodes_fts`` automatically
        from the ``title`` + ``summary`` columns.
        """
        with self._lock:
            cursor = self._conn.execute(
                """
                INSERT INTO episodes(
                    owner_user_id, session_id, title, summary,
                    start_at, end_at, sentiment, entities, topic_scope,
                    confidence
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    owner_user_id,
                    session_id,
                    title,
                    summary,
                    start_at or _now(),
                    end_at,
                    sentiment,
                    json.dumps(entities) if entities is not None else None,
                    topic_scope,
                    confidence,
                ),
            )
            return int(cursor.lastrowid)

    def get_episodes(
        self,
        owner_user_id: int,
        *,
        topic_scope: str | None = None,
        limit: int = 50,
    ) -> list[dict[str, Any]]:
        """Return the most recent episodes for an owner, newest first."""
        if topic_scope is not None:
            sql = (
                "SELECT * FROM episodes "
                "WHERE owner_user_id = ? AND topic_scope = ? "
                "ORDER BY start_at DESC, id DESC LIMIT ?"
            )
            params: tuple[Any, ...] = (owner_user_id, topic_scope, limit)
        else:
            sql = (
                "SELECT * FROM episodes "
                "WHERE owner_user_id = ? "
                "ORDER BY start_at DESC, id DESC LIMIT ?"
            )
            params = (owner_user_id, limit)
        rows = self._conn.execute(sql, params).fetchall()
        return [dict(row) for row in rows]

    def count_episodes_with_claim(
        self,
        owner_user_id: int,
        *,
        subject: str,
        predicate: str,
        value: str,
    ) -> int:
        """Count distinct sessions whose episodes hold a (subject,predicate,value) claim.

        Used by the M4 promotion engine: a claim emitted in 3+ separate
        sessions promotes from Tier 3 into Tier 4 / Tier 5 via the gate
        chain. The walk is intentionally cheap — JSON_EACH on the
        entities column would be ideal but we want this to work on
        sqlite builds without JSON1, so we scan + parse in Python.
        """
        rows = self._conn.execute(
            "SELECT session_id, entities FROM episodes "
            "WHERE owner_user_id = ? AND entities IS NOT NULL",
            (owner_user_id,),
        ).fetchall()
        sessions: set[int | None] = set()
        for row in rows:
            try:
                entities = json.loads(row["entities"] or "[]")
            except (TypeError, ValueError):
                continue
            if not isinstance(entities, list):
                continue
            for ent in entities:
                if not isinstance(ent, dict):
                    continue
                if (
                    str(ent.get("subject", "")) == subject
                    and str(ent.get("predicate", "")) == predicate
                    and str(ent.get("value", "")) == value
                ):
                    sessions.add(row["session_id"])
                    break
        return len(sessions)


    # -------------------------------------------------------------------
    # Tier 7 — procedural (behavior events + user profile) (M5)
    # -------------------------------------------------------------------

    def write_behavior_event(
        self,
        owner_user_id: int,
        *,
        event_type: str,
        payload: dict[str, Any] | None = None,
    ) -> int:
        """Append a behavior event row. Returns the new id."""
        with self._lock:
            cursor = self._conn.execute(
                "INSERT INTO behavior_events(owner_user_id, event_type, payload) VALUES (?, ?, ?)",
                (owner_user_id, event_type, json.dumps(payload) if payload else None),
            )
            return int(cursor.lastrowid)

    def get_behavior_events(
        self,
        owner_user_id: int,
        *,
        since: str | None = None,
        event_type: str | None = None,
        limit: int = 500,
    ) -> list[dict[str, Any]]:
        """Return behavior events, newest first.

        ``since`` is an ISO datetime string — only events at or after
        this timestamp are returned.
        """
        sql = "SELECT * FROM behavior_events WHERE owner_user_id = ?"
        params: list[Any] = [owner_user_id]
        if since:
            sql += " AND at >= ?"
            params.append(since)
        if event_type:
            sql += " AND event_type = ?"
            params.append(event_type)
        sql += " ORDER BY at DESC LIMIT ?"
        params.append(limit)
        rows = self._conn.execute(sql, params).fetchall()
        return [dict(row) for row in rows]

    def delete_behavior_events_before(
        self,
        owner_user_id: int,
        *,
        before: str,
    ) -> int:
        """Delete events older than ``before`` (ISO datetime). Returns count deleted."""
        with self._lock:
            cursor = self._conn.execute(
                "DELETE FROM behavior_events WHERE owner_user_id = ? AND at < ?",
                (owner_user_id, before),
            )
            return cursor.rowcount

    def get_user_profile(self, owner_user_id: int) -> dict[str, Any]:
        """Return the user profile as a dict with ``style`` and ``telemetry`` keys.

        Both are parsed from JSON. Returns empty dicts for missing profiles.
        """
        row = self._conn.execute(
            "SELECT style, telemetry, updated_at FROM user_profile WHERE owner_user_id = ?",
            (owner_user_id,),
        ).fetchone()
        if row is None:
            return {"style": {}, "telemetry": {}, "updated_at": None}
        style = {}
        telemetry = {}
        try:
            style = json.loads(row["style"] or "{}")
        except (TypeError, ValueError):
            pass
        try:
            telemetry = json.loads(row["telemetry"] or "{}")
        except (TypeError, ValueError):
            pass
        return {
            "style": style if isinstance(style, dict) else {},
            "telemetry": telemetry if isinstance(telemetry, dict) else {},
            "updated_at": row["updated_at"],
        }

    def set_user_style(self, owner_user_id: int, style: dict[str, Any]) -> None:
        """Upsert the prompt-safe style (Tier 7a) on the user profile."""
        with self._lock:
            existing = self._conn.execute(
                "SELECT owner_user_id FROM user_profile WHERE owner_user_id = ?",
                (owner_user_id,),
            ).fetchone()
            now = _now()
            if existing:
                self._conn.execute(
                    "UPDATE user_profile SET style = ?, updated_at = ? WHERE owner_user_id = ?",
                    (json.dumps(style), now, owner_user_id),
                )
            else:
                self._conn.execute(
                    "INSERT INTO user_profile(owner_user_id, style, updated_at) VALUES (?, ?, ?)",
                    (owner_user_id, json.dumps(style), now),
                )

    def set_user_telemetry(self, owner_user_id: int, telemetry: dict[str, Any]) -> None:
        """Upsert the prompt-forbidden telemetry (Tier 7b) on the user profile."""
        with self._lock:
            existing = self._conn.execute(
                "SELECT owner_user_id FROM user_profile WHERE owner_user_id = ?",
                (owner_user_id,),
            ).fetchone()
            now = _now()
            if existing:
                self._conn.execute(
                    "UPDATE user_profile SET telemetry = ?, updated_at = ? WHERE owner_user_id = ?",
                    (json.dumps(telemetry), now, owner_user_id),
                )
            else:
                self._conn.execute(
                    "INSERT INTO user_profile(owner_user_id, telemetry, updated_at) VALUES (?, ?, ?)",
                    (owner_user_id, json.dumps(telemetry), now),
                )

    def get_behavior_event_count(self, owner_user_id: int) -> int:
        """Return total behavior event count for an owner."""
        row = self._conn.execute(
            "SELECT COUNT(*) as cnt FROM behavior_events WHERE owner_user_id = ?",
            (owner_user_id,),
        ).fetchone()
        return int(row["cnt"]) if row else 0

    def is_telemetry_opted_out(self, owner_user_id: int) -> bool:
        """Check if telemetry collection is opted out for this user.

        Opt-out is stored as ``telemetry.opted_out = true`` in the profile.
        """
        profile = self.get_user_profile(owner_user_id)
        return bool(profile["telemetry"].get("opted_out", False))

    def set_telemetry_opt_out(self, owner_user_id: int, opted_out: bool) -> None:
        """Toggle the telemetry opt-out flag."""
        profile = self.get_user_profile(owner_user_id)
        telemetry = profile["telemetry"]
        telemetry["opted_out"] = opted_out
        self.set_user_telemetry(owner_user_id, telemetry)

    # -------------------------------------------------------------------
    # Tier 6 — affective (affect_window) (M6)
    # -------------------------------------------------------------------

    def write_affect_day(
        self,
        owner_user_id: int,
        *,
        character_id: str,
        day: str,
        sentiment_avg: float,
        notable_concerns: list[str] | None = None,
    ) -> None:
        """Upsert a single day's sentiment average into the affect window."""
        with self._lock:
            self._conn.execute(
                """
                INSERT INTO affect_window(owner_user_id, character_id, day, sentiment_avg, notable_concerns)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(owner_user_id, character_id, day)
                DO UPDATE SET sentiment_avg = excluded.sentiment_avg,
                             notable_concerns = excluded.notable_concerns
                """,
                (
                    owner_user_id,
                    character_id,
                    day,
                    sentiment_avg,
                    json.dumps(notable_concerns) if notable_concerns else None,
                ),
            )

    def get_affect_window(
        self,
        owner_user_id: int,
        *,
        character_id: str,
        days: int = 14,
    ) -> list[dict[str, Any]]:
        """Return up to ``days`` most recent affect_window rows for this character."""
        rows = self._conn.execute(
            """
            SELECT day, sentiment_avg, notable_concerns
            FROM affect_window
            WHERE owner_user_id = ? AND character_id = ?
            ORDER BY day DESC
            LIMIT ?
            """,
            (owner_user_id, character_id, days),
        ).fetchall()
        results: list[dict[str, Any]] = []
        for row in rows:
            concerns = None
            if row["notable_concerns"]:
                try:
                    concerns = json.loads(row["notable_concerns"])
                except (TypeError, ValueError):
                    concerns = None
            results.append({
                "day": row["day"],
                "sentiment_avg": row["sentiment_avg"],
                "notable_concerns": concerns,
            })
        return results

    def delete_affect_window(
        self,
        owner_user_id: int,
        *,
        character_id: str | None = None,
    ) -> int:
        """Wipe affect_window rows. If character_id given, only that character.

        Returns count deleted. This is the "forget my mood" operation.
        """
        with self._lock:
            if character_id:
                cursor = self._conn.execute(
                    "DELETE FROM affect_window WHERE owner_user_id = ? AND character_id = ?",
                    (owner_user_id, character_id),
                )
            else:
                cursor = self._conn.execute(
                    "DELETE FROM affect_window WHERE owner_user_id = ?",
                    (owner_user_id,),
                )
            return cursor.rowcount

    def is_sentiment_opted_out(self, owner_user_id: int) -> bool:
        """Check if sentiment persistence is opted out for this user."""
        profile = self.get_user_profile(owner_user_id)
        return bool(profile["telemetry"].get("sentiment_opted_out", False))

    def set_sentiment_opt_out(self, owner_user_id: int, opted_out: bool) -> None:
        """Toggle the sentiment persistence opt-out flag."""
        profile = self.get_user_profile(owner_user_id)
        telemetry = profile["telemetry"]
        telemetry["sentiment_opted_out"] = opted_out
        self.set_user_telemetry(owner_user_id, telemetry)

    # -------------------------------------------------------------------
    # Episodic compression (M6)
    # -------------------------------------------------------------------

    def get_stale_episodes(
        self,
        owner_user_id: int,
        *,
        older_than: str,
        max_recall_count: int = 0,
    ) -> list[dict[str, Any]]:
        """Return episodes older than ``older_than`` with recall_count <= max_recall_count."""
        rows = self._conn.execute(
            """
            SELECT id, title, summary, start_at, end_at, topic_scope, recall_count
            FROM episodes
            WHERE owner_user_id = ? AND start_at < ? AND recall_count <= ?
              AND superseded_by IS NULL
            ORDER BY start_at ASC
            """,
            (owner_user_id, older_than, max_recall_count),
        ).fetchall()
        return [dict(row) for row in rows]

    def compress_episodes(
        self,
        owner_user_id: int,
        *,
        episode_ids: list[int],
        compressed_title: str,
        compressed_summary: str,
        start_at: str,
        end_at: str,
    ) -> int:
        """Replace a set of stale episodes with a single compressed summary.

        Inserts the new compressed episode, then marks the originals as
        superseded. Returns the new episode id.
        """
        with self._lock:
            cursor = self._conn.execute(
                """
                INSERT INTO episodes(
                    owner_user_id, title, summary, start_at, end_at,
                    topic_scope, confidence, recall_count
                ) VALUES (?, ?, ?, ?, ?, 'compressed', 0.3, 0)
                """,
                (owner_user_id, compressed_title, compressed_summary, start_at, end_at),
            )
            new_id = int(cursor.lastrowid)
            for eid in episode_ids:
                self._conn.execute(
                    "UPDATE episodes SET superseded_by = ? WHERE id = ? AND owner_user_id = ?",
                    (new_id, eid, owner_user_id),
                )
            return new_id


def _now() -> str:
    return datetime.utcnow().isoformat(timespec="seconds") + "Z"


def _humanize_predicate(predicate: str) -> str:
    """Convert ``lives_in`` -> ``lives in`` for embedding text."""
    return predicate.replace("_", " ")


def compute_fact_embedding(candidate: MemoryCandidate) -> str | None:
    """Compute and serialize the embedding for a fact write candidate.

    The embedding text is the humanized predicate joined with the value
    and source_text — same shape that goes into the FTS5 index. We use
    the existing pipeline routing embedding backend so the same vector model
    is used for both routing and memory; this keeps dependencies small
    and means the hash-fallback path works under tests without
    fastembed installed.

    Returns a JSON-encoded list[float] string, or None when the
    embedding backend fails or returns an empty vector.
    """
    try:
        from lokidoki.orchestrator.routing.embeddings import get_embedding_backend
    except Exception as exc:  # noqa: BLE001
        log.debug("memory: embedding backend unavailable: %s", exc)
        return None
    text_parts = [
        _humanize_predicate(candidate.predicate),
        candidate.value,
    ]
    if candidate.source_text:
        text_parts.append(candidate.source_text)
    text = " ".join(p for p in text_parts if p).strip()
    if not text:
        return None
    try:
        backend = get_embedding_backend()
        vectors = backend.embed([text])
    except Exception as exc:  # noqa: BLE001 — embedding is best-effort
        log.warning("memory: embedding backend.embed failed: %s", exc)
        return None
    if not vectors or not vectors[0]:
        return None
    return json.dumps(vectors[0])


# ---------------------------------------------------------------------------
# Module-level singleton (lazy)
# ---------------------------------------------------------------------------

_GLOBAL_STORE: MemoryStore | None = None
_GLOBAL_LOCK = threading.Lock()


def get_default_store() -> MemoryStore:
    """Return the process-wide default store, creating it on first call.

    Tests typically construct their own ``MemoryStore(":memory:")`` so
    they don't share state with the runtime singleton.
    """
    global _GLOBAL_STORE
    with _GLOBAL_LOCK:
        if _GLOBAL_STORE is None:
            _GLOBAL_STORE = MemoryStore()
        return _GLOBAL_STORE


def reset_default_store(new_store: MemoryStore | None = None) -> None:
    """Replace the process-wide store. Used by tests and the dev tools."""
    global _GLOBAL_STORE
    with _GLOBAL_LOCK:
        if _GLOBAL_STORE is not None and _GLOBAL_STORE is not new_store:
            _GLOBAL_STORE.close()
        _GLOBAL_STORE = new_store
