"""Tier 3 — episodes mixin for MemoryStore (M4 + M6 compression)."""
from __future__ import annotations

import json
from typing import Any

from lokidoki.orchestrator.memory.store_helpers import _now


class EpisodesMixin:
    """Tier 3 episode write/read/compression methods."""

    def write_episode(
        self, *,
        owner_user_id: int, title: str, summary: str,
        entities: list[dict[str, Any]] | None = None,
        sentiment: str | None = None,
        topic_scope: str | None = None,
        session_id: int | None = None,
        start_at: str | None = None,
        end_at: str | None = None,
        confidence: float = 0.5,
    ) -> int:
        """Insert an episode row. Returns the new id."""
        with self._lock:
            cursor = self._conn.execute(
                "INSERT INTO episodes("
                "    owner_user_id, session_id, title, summary,"
                "    start_at, end_at, sentiment, entities, topic_scope,"
                "    confidence"
                ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (owner_user_id, session_id, title, summary,
                 start_at or _now(), end_at, sentiment,
                 json.dumps(entities) if entities is not None else None,
                 topic_scope, confidence),
            )
            return int(cursor.lastrowid)

    def get_episodes(
        self, owner_user_id: int, *,
        topic_scope: str | None = None, limit: int = 50,
    ) -> list[dict[str, Any]]:
        """Return the most recent episodes, newest first."""
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
        self, owner_user_id: int, *,
        subject: str, predicate: str, value: str,
    ) -> int:
        """Count distinct sessions whose episodes hold a claim."""
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

    def get_stale_episodes(
        self, owner_user_id: int, *,
        older_than: str, max_recall_count: int = 0,
    ) -> list[dict[str, Any]]:
        """Return episodes older than ``older_than`` with low recall count."""
        rows = self._conn.execute(
            "SELECT id, title, summary, start_at, end_at, topic_scope, recall_count "
            "FROM episodes "
            "WHERE owner_user_id = ? AND start_at < ? AND recall_count <= ? "
            "AND superseded_by IS NULL ORDER BY start_at ASC",
            (owner_user_id, older_than, max_recall_count),
        ).fetchall()
        return [dict(row) for row in rows]

    def compress_episodes(
        self, owner_user_id: int, *,
        episode_ids: list[int],
        compressed_title: str, compressed_summary: str,
        start_at: str, end_at: str,
    ) -> int:
        """Replace stale episodes with a single compressed summary. Returns new id."""
        with self._lock:
            cursor = self._conn.execute(
                "INSERT INTO episodes("
                "    owner_user_id, title, summary, start_at, end_at,"
                "    topic_scope, confidence, recall_count"
                ") VALUES (?, ?, ?, ?, ?, 'compressed', 0.3, 0)",
                (owner_user_id, compressed_title, compressed_summary,
                 start_at, end_at),
            )
            new_id = int(cursor.lastrowid)
            for eid in episode_ids:
                self._conn.execute(
                    "UPDATE episodes SET superseded_by = ? "
                    "WHERE id = ? AND owner_user_id = ?",
                    (new_id, eid, owner_user_id),
                )
            return new_id
