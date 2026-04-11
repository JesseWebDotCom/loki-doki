"""People DB adapter for the v2 prototype.

The prototype ships an in-memory family graph keyed by alias so the
people resolver can answer "text Sarah" / "call mom" deterministically
without depending on a real database. The shape mirrors what a real
PeopleDB row would look like (id, name, relationship, aliases).

CLAUDE.md forbids real personal names in tests/fixtures, so the seed
roster is built from pop-culture characters.
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


@dataclass(slots=True)
class PersonMatch:
    record: PersonRecord
    score: int
    matched_alias: str
    ambiguous: bool = False
    candidates: list[PersonRecord] = field(default_factory=list)


_DEFAULT_ROSTER: tuple[PersonRecord, ...] = (
    PersonRecord(
        id="person.padme",
        name="Padme",
        relationship="mother",
        aliases=["mom", "mother", "mama", "padme"],
        priority=10,
    ),
    PersonRecord(
        id="person.anakin",
        name="Anakin",
        relationship="father",
        aliases=["dad", "father", "papa", "anakin"],
        priority=10,
    ),
    PersonRecord(
        id="person.leia",
        name="Leia",
        relationship="sister",
        aliases=["sis", "leia"],
        priority=20,
    ),
    PersonRecord(
        id="person.luke",
        name="Luke",
        relationship="brother",
        aliases=["bro", "luke"],
        priority=20,
    ),
    PersonRecord(
        id="person.obiwan",
        name="Obi-Wan",
        relationship="mentor",
        aliases=["obi-wan", "obiwan", "ben"],
        priority=40,
    ),
    PersonRecord(
        id="person.han",
        name="Han Solo",
        relationship="friend",
        aliases=["han", "han solo"],
        priority=40,
    ),
)


class PeopleDBAdapter:
    """Alias-aware family graph lookup."""

    def __init__(self, records: Iterable[PersonRecord] | None = None) -> None:
        self._records: tuple[PersonRecord, ...] = tuple(records or _DEFAULT_ROSTER)

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

        # 2. Substring match (e.g. "Han Solo" → "han solo").
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
