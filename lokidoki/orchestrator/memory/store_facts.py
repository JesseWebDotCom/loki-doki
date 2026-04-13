"""Tier 4 — semantic_self facts (mixin for MemoryStore)."""
from __future__ import annotations

import json
import logging
from typing import Any

from lokidoki.orchestrator.memory.candidate import MemoryCandidate
from lokidoki.orchestrator.memory.predicates import (
    SUPERSEDED_CONFIDENCE_FLOOR,
    is_immediate_durable,
    is_single_value,
)
from lokidoki.orchestrator.memory.store_helpers import _humanize_predicate, _now
from lokidoki.orchestrator.memory.tiers import Tier

log = logging.getLogger("lokidoki.orchestrator.memory.store")


class FactsMixin:
    """Tier 4 read/write methods."""

    def write_semantic_fact(self, candidate: MemoryCandidate):
        """Insert or update a Tier 4 fact, applying single-value supersession."""
        from lokidoki.orchestrator.memory.store import WriteOutcome

        with self._lock:
            superseded_id: int | None = None
            if is_single_value(candidate.predicate):
                superseded_id = self._supersede_single_value(candidate)

            existing = self._conn.execute(
                "SELECT id, observation_count, confidence FROM facts "
                "WHERE owner_user_id = ? AND subject = ? AND predicate = ? AND value = ? "
                "AND status = 'active'",
                (candidate.owner_user_id, candidate.subject,
                 candidate.predicate, candidate.value),
            ).fetchone()

            if existing is None:
                return self._insert_fact(candidate, superseded_id)
            return self._update_fact(existing, candidate, superseded_id)

    def _insert_fact(self, candidate: MemoryCandidate, superseded_id: int | None):
        """Insert a brand-new active facts row and return a WriteOutcome."""
        from lokidoki.orchestrator.memory.store import WriteOutcome

        now = _now()
        embedding_json = compute_fact_embedding(candidate)
        cursor = self._conn.execute(
            "INSERT INTO facts("
            "    owner_user_id, subject, predicate, value,"
            "    confidence, status, observation_count, source_text,"
            "    embedding, created_at, updated_at"
            ") VALUES (?, ?, ?, ?, ?, 'active', 1, ?, ?, ?, ?)",
            (
                candidate.owner_user_id, candidate.subject,
                candidate.predicate, candidate.value,
                candidate.confidence, candidate.source_text,
                embedding_json, now, now,
            ),
        )
        return WriteOutcome(
            accepted=True, tier=Tier.SEMANTIC_SELF,
            fact_id=int(cursor.lastrowid), person_id=None,
            superseded_id=superseded_id,
            immediate_durable=is_immediate_durable(4, candidate.predicate),
            note="inserted",
        )

    def _update_fact(self, existing, candidate: MemoryCandidate, superseded_id: int | None):
        """Bump observation_count / confidence on an existing row; return WriteOutcome."""
        from lokidoki.orchestrator.memory.store import WriteOutcome

        now = _now()
        new_count = int(existing["observation_count"]) + 1
        new_conf = min(1.0, float(existing["confidence"]) + 0.05)
        self._conn.execute(
            "UPDATE facts SET observation_count = ?, confidence = ?, updated_at = ? WHERE id = ?",
            (new_count, new_conf, now, int(existing["id"])),
        )
        return WriteOutcome(
            accepted=True, tier=Tier.SEMANTIC_SELF,
            fact_id=int(existing["id"]), person_id=None,
            superseded_id=superseded_id,
            immediate_durable=is_immediate_durable(4, candidate.predicate),
            note="updated",
        )

    def _supersede_single_value(self, candidate: MemoryCandidate) -> int | None:
        """Flip prior values for a single-value predicate to ``superseded``."""
        prior = self._conn.execute(
            "SELECT id FROM facts "
            "WHERE owner_user_id = ? AND subject = ? AND predicate = ? "
            "AND value <> ? AND status = 'active' ORDER BY id DESC LIMIT 1",
            (candidate.owner_user_id, candidate.subject,
             candidate.predicate, candidate.value),
        ).fetchone()
        if prior is None:
            return None
        prior_id = int(prior["id"])
        self._conn.execute(
            "UPDATE facts SET status = 'superseded', confidence = ?, updated_at = ? WHERE id = ?",
            (SUPERSEDED_CONFIDENCE_FLOOR, _now(), prior_id),
        )
        return prior_id

    def get_active_facts(
        self,
        owner_user_id: int,
        *,
        subject: str | None = None,
        predicate: str | None = None,
        limit: int = 200,
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
        if limit:
            sql += " LIMIT ?"
            params.append(limit)
        rows = self._conn.execute(sql, params).fetchall()
        return [dict(row) for row in rows]

    def get_superseded_facts(
        self, owner_user_id: int, *, limit: int = 200,
    ) -> list[dict[str, Any]]:
        sql = "SELECT * FROM facts WHERE owner_user_id = ? AND status = 'superseded' ORDER BY id"
        params: list[Any] = [owner_user_id]
        if limit:
            sql += " LIMIT ?"
            params.append(limit)
        rows = self._conn.execute(sql, params).fetchall()
        return [dict(row) for row in rows]


def compute_fact_embedding(candidate: MemoryCandidate) -> str | None:
    """Compute and serialize the embedding for a fact write candidate."""
    try:
        from lokidoki.orchestrator.routing.embeddings import get_embedding_backend
    except Exception as exc:  # noqa: BLE001
        log.debug("memory: embedding backend unavailable: %s", exc)
        return None
    text_parts = [_humanize_predicate(candidate.predicate), candidate.value]
    if candidate.source_text:
        text_parts.append(candidate.source_text)
    text = " ".join(p for p in text_parts if p).strip()
    if not text:
        return None
    try:
        backend = get_embedding_backend()
        vectors = backend.embed([text])
    except Exception as exc:  # noqa: BLE001
        log.warning("memory: embedding backend.embed failed: %s", exc)
        return None
    if not vectors or not vectors[0]:
        return None
    return json.dumps(vectors[0])
