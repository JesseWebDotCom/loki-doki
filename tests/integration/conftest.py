"""Integration-suite conftest — make v2 skill adapters hermetic.

The v2 skill adapters under ``v2/orchestrator/skills/`` wrap real v1
LokiDoki skills (Open-Meteo, Wikipedia, Fandango, dictionaryapi.dev,
Google News RSS, TheMealDB, icanhazdadjoke, TVMaze). Those provider
calls are great for development but make the regression suite slow,
flaky, and dependent on internet access.

This conftest installs lightweight in-memory fakes that satisfy the
``BaseSkill.execute_mechanism`` contract and return deterministic
``MechanismResult`` objects. Each fake is keyed on the mechanism name
the matching adapter calls, so adapter routing logic still runs
end-to-end — only the network round-trip is replaced.
"""
from __future__ import annotations

from typing import Any

import pytest

from lokidoki.core.skill_executor import MechanismResult


# ---- fakes -----------------------------------------------------------------


class _FakeWeather:
    """Drop-in replacement for OpenMeteoSkill."""

    async def execute_mechanism(self, method: str, parameters: dict[str, Any]) -> MechanismResult:
        location = parameters.get("location") or "your area"
        if method == "open_meteo":
            return MechanismResult(
                success=True,
                data={
                    "location": location,
                    "temperature": 22,
                    "feels_like": 21,
                    "humidity": 60,
                    "wind_speed": 5,
                    "condition": "clear sky",
                    "lead": f"Weather in {location}: 22°C (72°F), clear sky, no rain right now.",
                },
                source_url="https://open-meteo.com/?fake",
                source_title="Open-Meteo (test fake)",
            )
        if method == "local_cache":
            return MechanismResult(success=False, error="cache miss")
        return MechanismResult(success=False, error=f"unknown mechanism {method}")


class _FakeKnowledge:
    """Stand-in for both Wikipedia and DuckDuckGo skills used by knowledge.py.

    The v2 knowledge_query adapter runs Wikipedia and web search in
    parallel as two distinct sources (``_WIKI`` and ``_DDG``). The fake
    satisfies both shapes by handling the union of their mechanism names
    so the same instance can be patched in for either singleton.
    """

    async def execute_mechanism(self, method: str, parameters: dict[str, Any]) -> MechanismResult:
        query = parameters.get("query") or ""
        if method in ("mediawiki_api", "web_scraper"):
            return MechanismResult(
                success=True,
                data={
                    "title": query.title(),
                    "lead": f"{query.title()} — a test summary about {query}.",
                    "extract": f"{query.title()} is a topic. This is a fake Wikipedia extract for the test suite.",
                    "sections": [],
                    "url": "https://en.wikipedia.org/wiki/Fake",
                },
                source_url="https://en.wikipedia.org/wiki/Fake",
                source_title=f"Wikipedia (fake) — {query.title()}",
            )
        if method in ("ddg_api", "ddg_scraper"):
            return MechanismResult(
                success=True,
                data={
                    "query": query,
                    "snippet": f"Fake DDG snippet about {query} for the test suite.",
                    "results": [
                        {
                            "title": f"{query.title()} (fake)",
                            "url": "https://duckduckgo.com/fake",
                            "snippet": f"Fake DDG snippet about {query}.",
                        }
                    ],
                },
                source_url="https://duckduckgo.com/fake",
                source_title=f"DuckDuckGo (fake) — {query}",
            )
        return MechanismResult(success=False, error=f"unknown mechanism {method}")


class _FakeShowtimes:
    async def execute_mechanism(self, method: str, parameters: dict[str, Any]) -> MechanismResult:
        title = parameters.get("query") or "the requested movie"
        if method in ("movie_showtimes", "napi_theaters_with_showtimes"):
            return MechanismResult(
                success=True,
                data={
                    "lead": f"Showtimes for {title} (fake): 4:30 PM, 7:00 PM, and 9:45 PM.",
                    "showtimes": [
                        {
                            "title": title,
                            "theaters": [
                                {"name": "Test Cinema", "times": ["4:30 PM", "7:00 PM", "9:45 PM"]}
                            ],
                        }
                    ],
                },
                source_url="https://www.fandango.com/fake",
                source_title=f"Fandango (fake) — {title}",
            )
        if method == "local_cache":
            return MechanismResult(success=False, error="cache miss")
        return MechanismResult(success=False, error=f"unknown mechanism {method}")


class _FakeDictionary:
    async def execute_mechanism(self, method: str, parameters: dict[str, Any]) -> MechanismResult:
        word = parameters.get("word") or parameters.get("query") or ""
        if method == "dictionaryapi_dev":
            return MechanismResult(
                success=True,
                data={
                    "word": word,
                    "phonetic": "/fake/",
                    "meanings": [
                        {
                            "part_of_speech": "noun",
                            "definitions": [f"a fake definition of {word} for the test suite"],
                        }
                    ],
                },
                source_url="https://dictionaryapi.dev/fake",
                source_title="dictionaryapi.dev (fake)",
            )
        return MechanismResult(success=False, error=f"unknown mechanism {method}")


class _FakeNews:
    async def execute_mechanism(self, method: str, parameters: dict[str, Any]) -> MechanismResult:
        topic = parameters.get("topic") or "top"
        if method == "google_news_rss":
            return MechanismResult(
                success=True,
                data={
                    "topic": topic,
                    "headlines": [
                        {
                            "title": f"Fake top story about {topic}",
                            "link": "https://news.example.com/1",
                            "source": "TestPress",
                        },
                        {"title": "Second fake story", "link": "https://news.example.com/2", "source": "TestPress"},
                    ],
                },
                source_url="https://news.google.com/?fake",
                source_title=f"Google News (fake) — {topic}",
            )
        return MechanismResult(success=False, error=f"unknown mechanism {method}")


class _FakeRecipes:
    async def execute_mechanism(self, method: str, parameters: dict[str, Any]) -> MechanismResult:
        query = parameters.get("query") or ""
        if method == "themealdb":
            return MechanismResult(
                success=True,
                data={
                    "query": query,
                    "recipes": [
                        {
                            "name": f"Test {query.title()}",
                            "ingredients": ["flour", "sugar", "eggs", "butter"],
                        }
                    ],
                },
                source_url="https://themealdb.com/fake",
                source_title="TheMealDB (fake)",
            )
        return MechanismResult(success=False, error=f"unknown mechanism {method}")


class _FakeJokes:
    async def execute_mechanism(self, method: str, parameters: dict[str, Any]) -> MechanismResult:
        if method == "icanhazdadjoke":
            return MechanismResult(
                success=True,
                data={"joke": "Why don't scientists trust atoms? Because they make up everything."},
                source_url="https://icanhazdadjoke.com/fake",
                source_title="icanhazdadjoke (fake)",
            )
        return MechanismResult(success=False, error=f"unknown mechanism {method}")


class _FakeTVShow:
    async def execute_mechanism(self, method: str, parameters: dict[str, Any]) -> MechanismResult:
        query = parameters.get("query") or ""
        if method in ("tvmaze_api",):
            return MechanismResult(
                success=True,
                data={
                    "name": query.title(),
                    "status": "Ended",
                    "premiered": "1990-01-01",
                    "rating": 8.5,
                    "genres": ["Comedy"],
                    "summary": "A fake show summary.",
                    "network": "TestNet",
                    "recent_episodes": [],
                },
                source_url="https://tvmaze.com/fake",
                source_title=f"TVMaze (fake) — {query.title()}",
            )
        if method == "local_cache":
            return MechanismResult(success=False, error="cache miss")
        return MechanismResult(success=False, error=f"unknown mechanism {method}")


# ---- pytest hook -----------------------------------------------------------


@pytest.fixture(scope="session", autouse=True)
def _patch_v2_skill_singletons() -> None:
    """Replace network-backed v2 adapter singletons with deterministic fakes.

    Session-scoped + autouse so every integration test in this directory
    sees the fakes; no individual test needs to opt in. The patches are
    written directly to the adapter modules' ``_SKILL`` attribute and
    held for the entire session — adapter functions read the attribute
    at call time so the swap is observed everywhere.
    """
    from lokidoki.orchestrator.skills import (
        dictionary as dictionary_skill,
        jokes as jokes_skill,
        knowledge as knowledge_skill,
        news as news_skill,
        recipes as recipes_skill,
        showtimes as showtimes_skill,
        tv_show as tv_show_skill,
        weather as weather_skill,
    )

    # The knowledge adapter is the only v2 skill that holds *two* singletons
    # (_WIKI for Wikipedia, _DDG for web search) because it runs the two
    # sources in parallel and scores them. Every other adapter still owns a
    # single _SKILL singleton. Track originals as (module, attr_name) tuples
    # so the restore step puts the right symbol back.
    single_skill_modules = (
        weather_skill,
        showtimes_skill,
        dictionary_skill,
        news_skill,
        recipes_skill,
        jokes_skill,
        tv_show_skill,
    )
    originals: list[tuple[Any, str, Any]] = [
        (module, "_SKILL", module._SKILL) for module in single_skill_modules
    ]
    originals.append((knowledge_skill, "_WIKI", knowledge_skill._WIKI))
    originals.append((knowledge_skill, "_DDG", knowledge_skill._DDG))

    weather_skill._SKILL = _FakeWeather()
    showtimes_skill._SKILL = _FakeShowtimes()
    dictionary_skill._SKILL = _FakeDictionary()
    news_skill._SKILL = _FakeNews()
    recipes_skill._SKILL = _FakeRecipes()
    jokes_skill._SKILL = _FakeJokes()
    tv_show_skill._SKILL = _FakeTVShow()
    # One fake satisfies both knowledge sources — see _FakeKnowledge.
    fake_knowledge = _FakeKnowledge()
    knowledge_skill._WIKI = fake_knowledge
    knowledge_skill._DDG = fake_knowledge

    yield

    for module, attr_name, original in originals:
        setattr(module, attr_name, original)


@pytest.fixture(scope="session", autouse=True)
def _seed_v2_people_db_for_integration():
    """Inject the pop-culture seed roster into the in-memory PeopleDBAdapter.

    The production default of ``lokidoki.orchestrator.adapters.people_db._DEFAULT_ROSTER``
    is intentionally empty so the live dev tool pipeline never surfaces
    fictional people to the user. The integration regression suite still
    needs a deterministic family graph to test the people resolver +
    ``lookup_person_birthday`` routing — without it the regression
    fixtures that resolve "mom" / "sister" / "brother" would fall to the
    "missing person" branch and the assertions would fail.

    Session-scoped + autouse so the seed is in place for every test
    that runs through ``run_pipeline_async``.
    """
    from lokidoki.orchestrator.adapters import people_db

    from tests.fixtures.seed_people import SEED_ROSTER

    original = people_db._DEFAULT_ROSTER
    people_db._DEFAULT_ROSTER = SEED_ROSTER
    try:
        yield
    finally:
        people_db._DEFAULT_ROSTER = original
