"""People DB adapter for the pipeline.

In-memory alias-aware family graph used by the people resolver. The
shape mirrors a real PeopleDB row (id, name, relationship, aliases) so
this adapter is a drop-in for the SQLite-backed
:class:`lokidoki.orchestrator.adapters.loki_people_db.LokiPeopleDBAdapter`.

**The default constructor returns an EMPTY roster.** Live runtime code
paths must either inject real records or wire the SQLite adapter — the
in-memory adapter must never invent test/seed identities, because the
dev tool surfaces resolver output directly to the user. Tests that
need a deterministic roster import :data:`tests.fixtures.seed_people.SEED_ROSTER`
explicitly.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Iterable

try:
    from rapidfuzz import fuzz
except ImportError:  # pragma: no cover
    fuzz = None


@dataclass(slots=True)
class PersonRecord:
    id: str
    name: str
    relationship: str
    aliases: list[str] = field(default_factory=list)
    priority: int = 50  # lower wins; family relationships < coworkers
    birthday: str | None = None  # human-readable, e.g. "June 12"


@dataclass(slots=True)
class PersonMatch:
    record: PersonRecord
    score: int
    matched_alias: str
    ambiguous: bool = False
    candidates: list[PersonRecord] = field(default_factory=list)


# Production default is an EMPTY roster. The integration test suite
# replaces this at session start with a seed roster (see
# ``tests/integration/conftest.py``) so the regression fixture cases
# that exercise the people resolver still have data to bind against.
# The default is read inside ``__init__`` so monkeypatching this module
# attribute is sufficient — no need to monkeypatch the class itself.
_DEFAULT_ROSTER: tuple[PersonRecord, ...] = ()


class PeopleDBAdapter:
    """Alias-aware family graph lookup."""

    def __init__(self, records: Iterable[PersonRecord] | None = None) -> None:
        # ``records is None`` (not falsy) so callers can deliberately
        # construct an empty adapter without falling through to the
        # module default.
        if records is None:
            records = _DEFAULT_ROSTER
        self._records: tuple[PersonRecord, ...] = tuple(records)

    def all(self) -> tuple[PersonRecord, ...]:
        return self._records

    def resolve(self, mention: str) -> PersonMatch | None:
        if not mention or not mention.strip():
            return None
        needle = mention.strip().lower()

        # 1. Exact alias match.
        exact = [
            record
            for record in self._records
            if needle == record.name.lower() or needle in (alias.lower() for alias in record.aliases)
        ]
        if exact:
            return self._rank(needle, exact, score=100)

        # 2. Substring match (e.g. "Han Solo" → "han solo"). Require the
        # needle to be at least 3 characters so a single-letter pronoun
        # like "i" cannot accidentally match "anakin" / "leia" / etc.
        if len(needle) >= 3:
            substring = [
                record
                for record in self._records
                if needle in record.name.lower()
                or any(needle in alias.lower() for alias in record.aliases)
            ]
            if substring:
                return self._rank(needle, substring, score=85)

        # 3. Fuzzy fallback.
        if fuzz is not None:
            scored: list[tuple[int, PersonRecord]] = []
            for record in self._records:
                pool = [record.name.lower(), *(alias.lower() for alias in record.aliases)]
                best = max(fuzz.ratio(needle, candidate) for candidate in pool)
                if best >= 80:
                    scored.append((best, record))
            if scored:
                scored.sort(key=lambda item: (-item[0], item[1].priority))
                top = scored[0]
                return self._rank(needle, [top[1]], score=top[0])

        return None

    def _rank(self, needle: str, candidates: list[PersonRecord], *, score: int) -> PersonMatch:
        ordered = sorted(candidates, key=lambda record: (record.priority, record.name.lower()))
        winner = ordered[0]
        matched_alias = needle if needle == winner.name.lower() else self._best_alias(needle, winner)
        return PersonMatch(
            record=winner,
            score=score,
            matched_alias=matched_alias,
            ambiguous=len(ordered) > 1,
            candidates=ordered,
        )

    @staticmethod
    def _best_alias(needle: str, record: PersonRecord) -> str:
        for alias in record.aliases:
            if alias.lower() == needle:
                return alias
        return record.name
