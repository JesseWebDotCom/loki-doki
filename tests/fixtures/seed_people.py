"""Test-only seed roster for the v2 in-memory PeopleDBAdapter.

CLAUDE.md forbids real personal names in tests, so the seed is built
from pop-culture characters. This module lives under ``tests/`` so it
can never be imported by the production runtime — the live dev tool
pipeline must never see these identities.

Used by:
- ``tests/unit/test_resolvers.py`` — passed explicitly to
  ``PeopleDBAdapter(records=SEED_ROSTER)`` in unit cases that exercise
  alias / family-relation lookups.
- ``tests/integration/conftest.py`` — monkeypatched into
  ``lokidoki.orchestrator.adapters.people_db._DEFAULT_ROSTER`` for the
  integration session so the regression fixture cases that test
  ``lookup_person_birthday`` and friends have data to bind against
  without the production default leaking these names.
"""
from __future__ import annotations

from lokidoki.orchestrator.adapters.people_db import PersonRecord


SEED_ROSTER: tuple[PersonRecord, ...] = (
    PersonRecord(
        id="person.padme",
        name="Padme",
        relationship="mother",
        aliases=["mom", "mother", "mama", "mommy", "padme"],
        priority=10,
        birthday="April 22",
    ),
    PersonRecord(
        id="person.anakin",
        name="Anakin",
        relationship="father",
        aliases=["dad", "father", "papa", "daddy", "anakin"],
        priority=10,
        birthday="August 15",
    ),
    PersonRecord(
        id="person.leia",
        name="Leia",
        relationship="sister",
        aliases=["sis", "sister", "leia"],
        priority=20,
        birthday="June 12",
    ),
    PersonRecord(
        id="person.luke",
        name="Luke",
        relationship="brother",
        aliases=["bro", "brother", "luke"],
        priority=20,
        birthday="September 25",
    ),
    PersonRecord(
        id="person.obiwan",
        name="Obi-Wan",
        relationship="mentor",
        aliases=["obi-wan", "obiwan", "ben"],
        priority=40,
        birthday="March 20",
    ),
    PersonRecord(
        id="person.han",
        name="Han Solo",
        relationship="friend",
        aliases=["han", "han solo"],
        priority=40,
        birthday="July 13",
    ),
)
