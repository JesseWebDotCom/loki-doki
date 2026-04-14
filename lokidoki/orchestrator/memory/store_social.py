"""Tier 5 — social (people + relationships) mixin for MemoryStore."""
from __future__ import annotations

from typing import Any

from lokidoki.orchestrator.memory.candidate import MemoryCandidate
from lokidoki.orchestrator.memory.predicates import (
    is_immediate_durable,
    is_single_value,
)
from lokidoki.orchestrator.memory.store_helpers import _now
from lokidoki.orchestrator.memory.tiers import Tier


class SocialMixin:
    """Tier 5 read/write methods."""

    def write_social_fact(self, candidate: MemoryCandidate):
        """Insert or update a Tier 5 row, supporting provisional handles."""
        from lokidoki.orchestrator.memory.store import WriteOutcome

        with self._lock:
            result = self._upsert_person(candidate)
            if result is None:
                return WriteOutcome(
                    accepted=False, tier=Tier.SOCIAL,
                    fact_id=None, person_id=None, superseded_id=None,
                    immediate_durable=False,
                    note=f"unsupported_subject:{candidate.subject}",
                )
            person_id, note = result
            self._link_relationship(candidate, person_id)
            return WriteOutcome(
                accepted=True, tier=Tier.SOCIAL,
                fact_id=None, person_id=person_id, superseded_id=None,
                immediate_durable=is_immediate_durable(5, candidate.predicate),
                note=note,
            )

    def _upsert_person(self, candidate: MemoryCandidate) -> tuple[int, str] | None:
        """Resolve or create the person row for the candidate subject.

        Returns ``(person_id, note)`` on success, or ``None`` for unsupported subjects.
        """
        subject = candidate.subject
        if subject.startswith("person:"):
            name = subject.split(":", 1)[1].strip()
            relation_hint = (
                candidate.value if candidate.predicate == "is_relation" else None
            )
            person_id = self._upsert_named_person(
                candidate.owner_user_id, name,
                relation_for_auto_merge=relation_hint,
            )
            return person_id, "person_upsert"
        if subject.startswith("handle:"):
            handle = subject.split(":", 1)[1].strip()
            person_id = self._upsert_provisional_handle(
                candidate.owner_user_id, handle,
            )
            return person_id, "handle_upsert"
        return None

    def _link_relationship(self, candidate: MemoryCandidate, person_id: int) -> None:
        """Insert a relationship row or upsert a fact row for this candidate."""
        if candidate.predicate == "is_relation":
            self._conn.execute(
                "INSERT OR IGNORE INTO relationships("
                "    owner_user_id, person_id, relation_label"
                ") VALUES (?, ?, ?)",
                (candidate.owner_user_id, person_id, candidate.value),
            )
        else:
            fact_candidate = candidate.model_copy(
                update={"subject": f"person:{person_id}"},
            )
            if is_single_value(candidate.predicate):
                self._supersede_single_value(fact_candidate)
            now = _now()
            self._conn.execute(
                "INSERT INTO facts("
                "    owner_user_id, subject, predicate, value,"
                "    confidence, status, observation_count, source_text,"
                "    created_at, updated_at"
                ") VALUES (?, ?, ?, ?, ?, 'active', 1, ?, ?, ?)"
                " ON CONFLICT(owner_user_id, subject, predicate, value)"
                " WHERE status = 'active'"
                " DO UPDATE SET"
                "    observation_count = facts.observation_count + 1,"
                "    confidence = MIN(1.0, facts.confidence + 0.05),"
                "    updated_at = excluded.updated_at",
                (candidate.owner_user_id, fact_candidate.subject,
                 candidate.predicate, candidate.value,
                 candidate.confidence, candidate.source_text,
                 now, now),
            )

    def _upsert_named_person(
        self, owner_user_id: int, name: str,
        *, relation_for_auto_merge: str | None = None,
    ) -> int:
        """Upsert a named person row with optional auto-merge."""
        existing = self._conn.execute(
            "SELECT id FROM people WHERE owner_user_id = ? AND name = ? AND provisional = 0",
            (owner_user_id, name),
        ).fetchone()
        if existing is not None:
            return int(existing["id"])
        if relation_for_auto_merge:
            promoted_id = self._maybe_promote_provisional_by_relation(
                owner_user_id, name=name, relation=relation_for_auto_merge,
            )
            if promoted_id is not None:
                return promoted_id
        cursor = self._conn.execute(
            "INSERT INTO people(owner_user_id, name, handle, provisional) VALUES (?, ?, NULL, 0)",
            (owner_user_id, name),
        )
        return int(cursor.lastrowid)

    def _maybe_promote_provisional_by_relation(
        self, owner_user_id: int, *, name: str, relation: str,
    ) -> int | None:
        """Promote a provisional handle row if exactly one matches the relation."""
        rows = self._conn.execute(
            "SELECT DISTINCT p.id, p.handle FROM people p "
            "JOIN relationships r ON r.owner_user_id = p.owner_user_id AND r.person_id = p.id "
            "WHERE p.owner_user_id = ? AND p.provisional = 1 "
            "AND p.handle IS NOT NULL AND r.relation_label = ?",
            (owner_user_id, relation),
        ).fetchall()
        if len(rows) != 1:
            return None
        target_id = int(rows[0]["id"])
        named_collision = self._conn.execute(
            "SELECT id FROM people WHERE owner_user_id = ? AND name = ? AND provisional = 0 AND id <> ?",
            (owner_user_id, name, target_id),
        ).fetchone()
        if named_collision is not None:
            return None
        self._conn.execute(
            "UPDATE people SET name = ?, provisional = 0, updated_at = ? WHERE id = ?",
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
            "INSERT INTO people(owner_user_id, name, handle, provisional) VALUES (?, NULL, ?, 1)",
            (owner_user_id, handle),
        )
        return int(cursor.lastrowid)

    def merge_provisional_handle(
        self, owner_user_id: int, *, handle: str, name: str,
    ) -> int | None:
        """Promote a provisional ``handle:`` row into a named row."""
        with self._lock:
            row = self._conn.execute(
                "SELECT id FROM people WHERE owner_user_id = ? AND handle = ? AND provisional = 1",
                (owner_user_id, handle),
            ).fetchone()
            if row is None:
                return None
            row_id = int(row["id"])
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
                "UPDATE people SET name = ?, provisional = 0, updated_at = ? WHERE id = ?",
                (name, _now(), row_id),
            )
            return row_id

    def get_people(
        self, owner_user_id: int, *, limit: int = 100,
    ) -> list[dict[str, Any]]:
        rows = self._conn.execute(
            "SELECT * FROM people WHERE owner_user_id = ? ORDER BY id LIMIT ?",
            (owner_user_id, limit),
        ).fetchall()
        return [dict(row) for row in rows]

    def get_relationships(
        self, owner_user_id: int, *, person_id: int | None = None,
        limit: int = 100,
    ) -> list[dict[str, Any]]:
        sql = "SELECT * FROM relationships WHERE owner_user_id = ?"
        params: list[Any] = [owner_user_id]
        if person_id is not None:
            sql += " AND person_id = ?"
            params.append(person_id)
        sql += " ORDER BY id LIMIT ?"
        params.append(limit)
        rows = self._conn.execute(sql, params).fetchall()
        return [dict(row) for row in rows]

    def list_people(self, owner_user_id: int) -> list[dict[str, Any]]:
        """UI-shaped people listing: adds fact_count and linked-user columns."""
        rows = self._conn.execute(
            "SELECT p.id, p.name, p.aliases, p.created_at, "
            "       u.id AS linked_user_id, u.username AS linked_username, "
            "       (SELECT COUNT(*) FROM facts f "
            "        WHERE f.owner_user_id = p.owner_user_id "
            "          AND f.subject_ref_id = p.id) AS fact_count "
            "FROM people p "
            "LEFT JOIN person_user_links pul ON pul.person_id = p.id "
            "LEFT JOIN users u ON u.id = pul.user_id "
            "WHERE p.owner_user_id = ? "
            "ORDER BY LOWER(p.name)",
            (owner_user_id,),
        ).fetchall()
        return [dict(row) for row in rows]

    def list_relationships(self, owner_user_id: int) -> list[dict[str, Any]]:
        """Relationship rows written by the gate-chain social-tier writer."""
        rows = self._conn.execute(
            "SELECT r.id, r.relation_label AS relation, r.confidence, "
            "       r.created_at, r.person_id, p.name AS person_name "
            "FROM relationships r "
            "JOIN people p ON p.id = r.person_id "
            "WHERE r.owner_user_id = ? "
            "ORDER BY r.id",
            (owner_user_id,),
        ).fetchall()
        return [dict(row) for row in rows]
