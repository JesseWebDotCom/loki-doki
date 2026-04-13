"""SQLite-backed PeopleDB adapter for the orchestrator.

Reads the same ``people`` / ``relationships`` tables that the legacy
LokiDoki memory subsystem writes to, but exposes the pipeline's
``PeopleDBAdapter`` interface so the resolver can use it as a drop-in
replacement for the in-memory stub.

The adapter is **read-only** with respect to the rest of the codebase
— must never mutate the legacy database. Per CLAUDE.md, the pipeline
prototype is allowed to *consume* lokidoki primitives but must not
modify them.
"""
from __future__ import annotations

import json
import sqlite3
from typing import Iterable

from lokidoki.orchestrator.adapters.people_db import PersonMatch, PersonRecord

try:
    from rapidfuzz import fuzz
except ImportError:  # pragma: no cover
    fuzz = None


# Bucket → priority. Lower wins. Mirrors the in-memory adapter so the
# resolver behaves the same way.
_BUCKET_PRIORITY: dict[str, int] = {
    "family": 10,
    "friend": 30,
    "coworker": 40,
    "celebrity": 80,
    "other": 60,
}


class LokiPeopleDBAdapter:
    """Read-only PeopleDB adapter backed by the legacy SQLite memory.

    Constructed with a sqlite3 connection (the test fixture passes a
    temp DB; production wiring would pass the singleton MemoryProvider's
    connection). The viewer scope ensures we never leak rows the user
    is not supposed to see.
    """

    def __init__(
        self,
        connection: sqlite3.Connection,
        *,
        viewer_user_id: int,
    ) -> None:
        self._conn = connection
        self._viewer_user_id = viewer_user_id

    # ---- public API mirrors PeopleDBAdapter ---------------------------------

    def all(self) -> tuple[PersonRecord, ...]:
        return tuple(self._iter_records())

    def resolve(self, mention: str) -> PersonMatch | None:
        if not mention or not mention.strip():
            return None
        needle = mention.strip().lower()

        records = list(self._iter_records())
        if not records:
            return None

        # 1. Exact match on name or alias.
        exact = [
            record
            for record in records
            if needle == record.name.lower()
            or any(needle == alias.lower() for alias in record.aliases)
        ]
        if exact:
            return self._rank(needle, exact, score=100)

        # 2. Substring match.
        substring = [
            record
            for record in records
            if needle in record.name.lower()
            or any(needle in alias.lower() for alias in record.aliases)
        ]
        if substring:
            return self._rank(needle, substring, score=85)

        # 3. Fuzzy fallback.
        if fuzz is None:
            return None

        scored: list[tuple[int, PersonRecord]] = []
        for record in records:
            pool = [record.name.lower(), *(alias.lower() for alias in record.aliases)]
            best = max(fuzz.ratio(needle, candidate) for candidate in pool)
            if best >= 80:
                scored.append((best, record))
        if not scored:
            return None
        scored.sort(key=lambda item: (-item[0], item[1].priority))
        top_score, top_record = scored[0]
        return self._rank(needle, [top_record], score=top_score)

    # ---- internals ----------------------------------------------------------

    def _iter_records(self) -> Iterable[PersonRecord]:
        rows = self._conn.execute(
            "SELECT p.id, p.name, p.aliases, p.bucket, "
            "       COALESCE(("
            "          SELECT relation FROM relationships r "
            "          WHERE r.owner_user_id = p.owner_user_id "
            "            AND r.person_id = p.id "
            "          ORDER BY r.confidence DESC, r.id ASC LIMIT 1"
            "       ), p.bucket) AS relationship "
            "FROM people p "
            "WHERE p.owner_user_id = ?",
            (self._viewer_user_id,),
        ).fetchall()

        for row in rows:
            aliases = _parse_aliases(row["aliases"] if isinstance(row, sqlite3.Row) else row[2])
            name = row["name"] if isinstance(row, sqlite3.Row) else row[1]
            person_id = row["id"] if isinstance(row, sqlite3.Row) else row[0]
            bucket = row["bucket"] if isinstance(row, sqlite3.Row) else row[3]
            relationship = row["relationship"] if isinstance(row, sqlite3.Row) else row[4]
            yield PersonRecord(
                id=f"loki.person.{person_id}",
                name=name,
                relationship=str(relationship or bucket or "person"),
                aliases=aliases,
                priority=_BUCKET_PRIORITY.get(str(bucket or "other"), 60),
            )

    def _rank(
        self,
        needle: str,
        candidates: list[PersonRecord],
        *,
        score: int,
    ) -> PersonMatch:
        ordered = sorted(candidates, key=lambda r: (r.priority, r.name.lower()))
        winner = ordered[0]
        matched_alias = needle if needle == winner.name.lower() else _best_alias(needle, winner)
        return PersonMatch(
            record=winner,
            score=score,
            matched_alias=matched_alias,
            ambiguous=len(ordered) > 1,
            candidates=ordered,
        )


def _parse_aliases(raw: object) -> list[str]:
    if not raw:
        return []
    if isinstance(raw, list):
        return [str(item).strip() for item in raw if str(item).strip()]
    try:
        parsed = json.loads(str(raw))
    except (TypeError, ValueError):
        return []
    if not isinstance(parsed, list):
        return []
    return [str(item).strip() for item in parsed if str(item).strip()]


def _best_alias(needle: str, record: PersonRecord) -> str:
    for alias in record.aliases:
        if alias.lower() == needle:
            return alias
    return record.name
