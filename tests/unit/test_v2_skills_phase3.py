"""C11 gate tests — Skills Phase 3: Finish V1 Ports.

Validates:
1. search_web is a first-class capability (registry + handler)
2. lookup_movie / search_movies via TMDB + Wikipedia fallback
3. lookup_relationship / list_family backed by people DB
4. TV episode detail handler (get_episode_detail)
5. All new capabilities registered and importable
6. People resolver covers new relationship capabilities
7. weather_owm and trivia_opentdb retirement decisions documented
"""
from __future__ import annotations

import importlib
import inspect

import pytest

from v2.orchestrator.registry.loader import build_handler_map, load_function_registry
from v2.orchestrator.skills._runner import AdapterResult


# ---- Gate: Every meaningful v1 surface ported, replaced, or retired ----------


class TestRegistryCompleteness:
    """All new Phase 3 capabilities are registered and importable."""

    def test_search_web_in_registry(self):
        items = load_function_registry()
        caps = {item["capability"] for item in items}
        assert "search_web" in caps

    def test_lookup_movie_in_registry(self):
        items = load_function_registry()
        caps = {item["capability"] for item in items}
        assert "lookup_movie" in caps

    def test_search_movies_in_registry(self):
        items = load_function_registry()
        caps = {item["capability"] for item in items}
        assert "search_movies" in caps

    def test_lookup_relationship_in_registry(self):
        items = load_function_registry()
        caps = {item["capability"] for item in items}
        assert "lookup_relationship" in caps

    def test_list_family_in_registry(self):
        items = load_function_registry()
        caps = {item["capability"] for item in items}
        assert "list_family" in caps

    def test_get_episode_detail_in_registry(self):
        items = load_function_registry()
        caps = {item["capability"] for item in items}
        assert "get_episode_detail" in caps

    def test_all_new_handlers_importable(self):
        """Every new handler's module_path + entry_point resolves."""
        new_handlers = {
            "skills.search.web",
            "skills.movies.lookup",
            "skills.movies.search",
            "skills.people.relationship",
            "skills.people.list_family",
            "skills.tv.episodes",
        }
        hmap = build_handler_map()
        failures: list[str] = []
        for handler_name in new_handlers:
            if handler_name not in hmap:
                failures.append(f"{handler_name}: not in handler map")
                continue
            module_path, attr_name = hmap[handler_name]
            try:
                module = importlib.import_module(module_path)
                if not hasattr(module, attr_name):
                    failures.append(f"{handler_name}: {module_path} missing '{attr_name}'")
            except ImportError as exc:
                failures.append(f"{handler_name}: import failed: {exc}")
        assert not failures, "\n".join(failures)


# ---- Gate: search_web first-class capability ---------------------------------


class TestSearchWeb:
    """search_web is a user-facing capability, not just an internal helper."""

    def test_search_web_handler_exists(self):
        from v2.orchestrator.skills.search_web import search_web
        assert callable(search_web)

    @pytest.mark.anyio
    async def test_search_web_missing_query(self):
        from v2.orchestrator.skills.search_web import search_web
        result = await search_web({"chunk_text": "", "params": {}})
        assert result["success"] is False
        assert "search" in result["output_text"].lower()

    @pytest.mark.anyio
    async def test_search_web_extracts_query_from_params(self, monkeypatch):
        from v2.orchestrator.skills import search_web as mod

        captured: list[str] = []

        async def fake_search(query, *, fallback_message):
            captured.append(query)
            return AdapterResult(output_text="found it", success=True).to_payload()

        monkeypatch.setattr(mod, "_search", fake_search)
        await mod.search_web({"params": {"query": "python 3.13"}, "chunk_text": "search web"})
        assert captured[0] == "python 3.13"

    @pytest.mark.anyio
    async def test_search_web_falls_back_to_chunk_text(self, monkeypatch):
        from v2.orchestrator.skills import search_web as mod

        captured: list[str] = []

        async def fake_search(query, *, fallback_message):
            captured.append(query)
            return AdapterResult(output_text="found it", success=True).to_payload()

        monkeypatch.setattr(mod, "_search", fake_search)
        await mod.search_web({"params": {}, "chunk_text": "raspberry pi specs"})
        assert captured[0] == "raspberry pi specs"


# ---- Gate: Movie lookup/search surface --------------------------------------


class TestMovieAdapters:
    """lookup_movie and search_movies use TMDB + Wiki fallback."""

    def test_movies_module_exists(self):
        mod = importlib.import_module("v2.orchestrator.skills.movies")
        assert hasattr(mod, "lookup_movie")
        assert hasattr(mod, "search_movies")

    @pytest.mark.anyio
    async def test_lookup_movie_missing_title(self):
        from v2.orchestrator.skills.movies import lookup_movie
        result = await lookup_movie({"chunk_text": "", "params": {}})
        assert result["success"] is False
        assert "movie" in result["output_text"].lower()

    @pytest.mark.anyio
    async def test_search_movies_missing_query(self):
        from v2.orchestrator.skills.movies import search_movies
        result = await search_movies({"chunk_text": "", "params": {}})
        assert result["success"] is False
        assert "movie" in result["output_text"].lower()

    @pytest.mark.anyio
    async def test_lookup_movie_reads_params_title(self, monkeypatch):
        """lookup_movie prefers params['movie_title'] over chunk_text."""
        from lokidoki.core.skill_executor import MechanismResult
        from v2.orchestrator.skills import movies as mod

        calls: list[dict] = []

        class FakeWiki:
            async def execute_mechanism(self, method, params):
                calls.append(params)
                return MechanismResult(
                    success=True,
                    data={"lead": "Inception (2010).", "title": "Inception"},
                    source_url="https://en.wikipedia.org/wiki/Inception",
                    source_title="Wikipedia — Inception",
                )

        monkeypatch.setattr(mod, "_WIKI", FakeWiki())
        result = await mod.lookup_movie({"params": {"movie_title": "Inception"}, "chunk_text": "tell me about inception"})
        assert calls[0]["query"] == "Inception"
        assert result["success"] is True

    @pytest.mark.anyio
    async def test_search_movies_reads_params_query(self, monkeypatch):
        from lokidoki.core.skill_executor import MechanismResult
        from v2.orchestrator.skills import movies as mod

        calls: list[dict] = []

        class FakeWiki:
            async def execute_mechanism(self, method, params):
                calls.append(params)
                return MechanismResult(
                    success=True,
                    data={"lead": "The Matrix (1999).", "title": "The Matrix"},
                )

        monkeypatch.setattr(mod, "_WIKI", FakeWiki())
        await mod.search_movies({"params": {"query": "matrix"}, "chunk_text": ""})
        assert calls[0]["query"] == "matrix"

    def test_movies_uses_tmdb_and_wiki_skills(self):
        """Movies adapter imports both TMDBSkill and WikiMoviesSkill."""
        source = inspect.getsource(importlib.import_module("v2.orchestrator.skills.movies"))
        assert "TMDBSkill" in source
        assert "WikiMoviesSkill" in source


# ---- Gate: Relationship / family query surface -------------------------------


class TestPeopleRelationships:
    """lookup_relationship and list_family backed by people DB."""

    def test_module_exists(self):
        mod = importlib.import_module("v2.orchestrator.skills.people_relationships")
        assert hasattr(mod, "lookup_relationship")
        assert hasattr(mod, "list_family")

    @pytest.mark.anyio
    async def test_lookup_relationship_empty_db(self):
        from v2.orchestrator.skills.people_relationships import lookup_relationship
        result = await lookup_relationship({"chunk_text": "who is my brother", "params": {}})
        assert result["success"] is False

    @pytest.mark.anyio
    async def test_list_family_empty_db(self):
        from v2.orchestrator.skills.people_relationships import list_family
        result = await list_family({"chunk_text": "list my family", "params": {}})
        assert result["success"] is False

    @pytest.mark.anyio
    async def test_lookup_relationship_with_data(self, monkeypatch):
        from v2.orchestrator.adapters.people_db import PeopleDBAdapter, PersonRecord
        from v2.orchestrator.skills import people_relationships as mod

        records = [
            PersonRecord(id="1", name="Luke Skywalker", relationship="brother", priority=10),
            PersonRecord(id="2", name="Leia Organa", relationship="sister", priority=10),
        ]
        monkeypatch.setattr(mod, "_get_adapter", lambda p: PeopleDBAdapter(records))
        result = await mod.lookup_relationship({"chunk_text": "who is my brother", "params": {"relation": "brother"}})
        assert result["success"] is True
        assert "Luke" in result["output_text"]

    @pytest.mark.anyio
    async def test_list_family_with_data(self, monkeypatch):
        from v2.orchestrator.adapters.people_db import PeopleDBAdapter, PersonRecord
        from v2.orchestrator.skills import people_relationships as mod

        records = [
            PersonRecord(id="1", name="Luke Skywalker", relationship="brother", priority=10),
            PersonRecord(id="2", name="Leia Organa", relationship="sister", priority=10),
            PersonRecord(id="3", name="Anakin Skywalker", relationship="father", priority=10),
        ]
        monkeypatch.setattr(mod, "_get_adapter", lambda p: PeopleDBAdapter(records))
        result = await mod.list_family({"chunk_text": "list my family", "params": {}})
        assert result["success"] is True
        assert "Luke" in result["output_text"]
        assert "Leia" in result["output_text"]
        assert "Anakin" in result["output_text"]
        assert result["data"]["count"] == 3

    @pytest.mark.anyio
    async def test_lookup_relationship_no_match(self, monkeypatch):
        from v2.orchestrator.adapters.people_db import PeopleDBAdapter, PersonRecord
        from v2.orchestrator.skills import people_relationships as mod

        records = [
            PersonRecord(id="1", name="Luke Skywalker", relationship="brother", priority=10),
        ]
        monkeypatch.setattr(mod, "_get_adapter", lambda p: PeopleDBAdapter(records))
        result = await mod.lookup_relationship({"chunk_text": "who is my cousin", "params": {"relation": "cousin"}})
        assert result["success"] is False
        assert "cousin" in result["output_text"]


# ---- Gate: TV episode detail surface -----------------------------------------


class TestTVEpisodeDetail:
    """get_episode_detail provides season/episode info."""

    def test_handler_exists(self):
        from v2.orchestrator.skills.tv_show import get_episode_detail
        assert callable(get_episode_detail)

    @pytest.mark.anyio
    async def test_episode_detail_missing_show(self):
        from v2.orchestrator.skills.tv_show import get_episode_detail
        result = await get_episode_detail({"chunk_text": "", "params": {}})
        assert result["success"] is False
        assert "episodes" in result["output_text"].lower() or "show" in result["output_text"].lower()

    @pytest.mark.anyio
    async def test_episode_detail_formats_correctly(self, monkeypatch):
        from lokidoki.core.skill_executor import MechanismResult
        from v2.orchestrator.skills import tv_show as mod

        class FakeSkill:
            async def execute_mechanism(self, method, params):
                return MechanismResult(
                    success=True,
                    data={
                        "name": "Breaking Bad",
                        "recent_episodes": [
                            {"season": 5, "number": 15, "name": "Granite State", "airdate": "2013-09-22"},
                            {"season": 5, "number": 16, "name": "Felina", "airdate": "2013-09-29"},
                        ],
                    },
                )

        monkeypatch.setattr(mod, "_SKILL", FakeSkill())
        result = await mod.get_episode_detail({"chunk_text": "breaking bad episodes", "params": {"query": "breaking bad"}})
        assert result["success"] is True
        assert "S5E16" in result["output_text"]
        assert "Felina" in result["output_text"]
        assert "2013-09-29" in result["output_text"]

    @pytest.mark.anyio
    async def test_episode_detail_no_episodes(self, monkeypatch):
        from lokidoki.core.skill_executor import MechanismResult
        from v2.orchestrator.skills import tv_show as mod

        class FakeSkill:
            async def execute_mechanism(self, method, params):
                return MechanismResult(success=True, data={"name": "New Show", "recent_episodes": []})

        monkeypatch.setattr(mod, "_SKILL", FakeSkill())
        result = await mod.get_episode_detail({"chunk_text": "new show episodes", "params": {"query": "new show"}})
        assert result["success"] is True
        assert "no episode" in result["output_text"].lower()


# ---- Gate: People resolver covers new capabilities ---------------------------


class TestPeopleResolverWiring:
    """lookup_relationship and list_family are resolved by the people resolver."""

    def test_lookup_relationship_in_people_capabilities(self):
        from v2.orchestrator.resolution.people_resolver import PEOPLE_CAPABILITIES
        assert "lookup_relationship" in PEOPLE_CAPABILITIES

    def test_list_family_in_people_capabilities(self):
        from v2.orchestrator.resolution.people_resolver import PEOPLE_CAPABILITIES
        assert "list_family" in PEOPLE_CAPABILITIES


# ---- Gate: Derivations cover new capabilities --------------------------------


class TestDerivationsWiring:
    """New capabilities wired into NER derivations and social flags."""

    def test_social_capabilities_include_relationships(self):
        from v2.orchestrator.pipeline.derivations import _SOCIAL_CAPABILITIES
        assert "lookup_relationship" in _SOCIAL_CAPABILITIES
        assert "list_family" in _SOCIAL_CAPABILITIES

    def test_capability_params_include_relationships(self):
        from v2.orchestrator.pipeline.derivations import _CAPABILITY_PARAMS
        assert "lookup_relationship" in _CAPABILITY_PARAMS
        assert "list_family" in _CAPABILITY_PARAMS

    def test_capability_params_include_movies(self):
        from v2.orchestrator.pipeline.derivations import _CAPABILITY_PARAMS
        assert "lookup_movie" in _CAPABILITY_PARAMS

    def test_capability_params_include_episodes(self):
        from v2.orchestrator.pipeline.derivations import _CAPABILITY_PARAMS
        assert "get_episode_detail" in _CAPABILITY_PARAMS


# ---- Gate: No v1 skill in "mystery missing" state ---------------------------


class TestRetirementDocumented:
    """weather_owm and trivia_opentdb are explicitly retired, not mystery missing."""

    def test_weather_owm_not_in_registry_as_active(self):
        """weather_owm is intentionally retired — Open-Meteo is the sole provider."""
        items = load_function_registry()
        caps = {item["capability"] for item in items if item.get("enabled", True)}
        assert "get_weather_owm" not in caps, "weather_owm should be retired"

    def test_trivia_not_in_registry(self):
        """trivia_opentdb never ported — retired."""
        items = load_function_registry()
        caps = {item["capability"] for item in items}
        assert "trivia" not in caps, "trivia should be retired"

    def test_open_meteo_is_sole_weather_provider(self):
        """get_weather uses Open-Meteo (no OWM fallback)."""
        source = inspect.getsource(importlib.import_module("v2.orchestrator.skills.weather"))
        assert "OpenMeteoSkill" in source
        assert "WeatherSkill" not in source  # OWM's class name


# ---- Gate: Multi-provider domains separate -----------------------------------


class TestMultiProviderSeparation:
    """Multi-provider domains have separate standalone skills."""

    def test_movies_uses_separate_providers(self):
        """Movies adapter wraps TMDB and Wiki as separate providers."""
        from v2.orchestrator.skills import movies
        assert hasattr(movies, "_TMDB")
        assert hasattr(movies, "_WIKI")

    def test_knowledge_uses_separate_sources(self):
        """Knowledge adapter wraps Wikipedia and DDG as separate sources."""
        from v2.orchestrator.skills import knowledge
        assert hasattr(knowledge, "_WIKI")
        assert hasattr(knowledge, "_DDG")
