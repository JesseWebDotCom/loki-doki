"""C12 gate tests — Skills Phases 4-8: Providers + Device + Polish.

Validates:
1. Phase 6: get_player_stats upgraded from stub to ESPN athlete search
2. Phase 6: substitute_ingredient expanded to 35+ entries
3. Phase 6: lookup_fact covers 40+ Wikidata properties
4. Phase 6: time_in_location covers 100+ cities
5. Phase 7: LLM skills carry source_title metadata
6. Phase 8: Source transparency — all API-backed skills expose source metadata
7. Phase 8: Registry maturity reflects actual provider backing
8. Phase 8: Offline policy — offline_capable field on relevant entries
"""
from __future__ import annotations

import asyncio
import importlib

import pytest

from v2.orchestrator.registry.loader import load_function_registry
from v2.orchestrator.skills._runner import AdapterResult


# ---- Phase 6: get_player_stats no longer a stub ---------------------------


class TestPlayerStats:
    """get_player_stats is a real handler, not a stub error."""

    def test_handler_exists_and_importable(self):
        mod = importlib.import_module("v2.orchestrator.skills.sports_api")
        fn = getattr(mod, "get_player_stats")
        assert asyncio.iscoroutinefunction(fn)

    def test_missing_player_returns_error(self):
        from v2.orchestrator.skills.sports_api import get_player_stats

        result = asyncio.run(
            get_player_stats({"chunk_text": "", "params": {}})
        )
        assert result["success"] is False
        assert "which player" in result["output_text"].lower()

    def test_registry_not_stub(self):
        items = load_function_registry()
        entry = next(i for i in items if i["capability"] == "get_player_stats")
        assert entry["maturity"] != "stub"
        assert "stub" not in entry["description"].lower()

    def test_registry_has_espn_mechanisms(self):
        items = load_function_registry()
        entry = next(i for i in items if i["capability"] == "get_player_stats")
        methods = [m["method"] for m in entry["mechanisms"]]
        assert "espn_athletes" in methods or "espn_search" in methods


# ---- Phase 6: substitute_ingredient expanded table -------------------------


class TestSubstituteIngredient:
    """Substitution table has broad coverage."""

    def test_table_has_35_plus_entries(self):
        from v2.orchestrator.skills.food import _SUBS

        assert len(_SUBS) >= 35

    def test_dairy_category(self):
        from v2.orchestrator.skills.food import _SUBS

        dairy = ["buttermilk", "butter", "heavy cream", "sour cream", "milk", "yogurt"]
        for item in dairy:
            assert item in _SUBS, f"Missing dairy substitution: {item}"

    def test_egg_substitute(self):
        from v2.orchestrator.skills.food import _SUBS

        assert "egg" in _SUBS
        assert "flax" in _SUBS["egg"].lower()

    def test_sweetener_substitutes(self):
        from v2.orchestrator.skills.food import _SUBS

        sweeteners = ["white sugar", "brown sugar", "honey"]
        for item in sweeteners:
            assert item in _SUBS, f"Missing sweetener substitution: {item}"

    def test_handler_finds_expanded_entries(self):
        from v2.orchestrator.skills.food import substitute_ingredient

        result = substitute_ingredient({"chunk_text": "soy sauce", "params": {}})
        assert result["success"] is True
        assert "coconut aminos" in result["output_text"].lower() or "tamari" in result["output_text"].lower()

    def test_registry_maturity_production(self):
        items = load_function_registry()
        entry = next(i for i in items if i["capability"] == "substitute_ingredient")
        assert entry["maturity"] == "production"


# ---- Phase 6: lookup_fact broader Wikidata properties ----------------------


class TestLookupFactProperties:
    """Wikidata property map covers 40+ fact types."""

    def test_property_count(self):
        from v2.orchestrator.skills.people_facts import _FACT_TO_PROPERTY

        assert len(_FACT_TO_PROPERTY) >= 40

    def test_identity_properties(self):
        from v2.orchestrator.skills.people_facts import _FACT_TO_PROPERTY

        for fact in ["nationality", "birthday", "birthplace", "occupation"]:
            assert fact in _FACT_TO_PROPERTY, f"Missing identity property: {fact}"

    def test_career_properties(self):
        from v2.orchestrator.skills.people_facts import _FACT_TO_PROPERTY

        for fact in ["education", "employer", "award", "political party"]:
            assert fact in _FACT_TO_PROPERTY, f"Missing career property: {fact}"

    def test_personal_properties(self):
        from v2.orchestrator.skills.people_facts import _FACT_TO_PROPERTY

        for fact in ["spouse", "child", "father", "mother", "height"]:
            assert fact in _FACT_TO_PROPERTY, f"Missing personal property: {fact}"

    def test_death_properties(self):
        from v2.orchestrator.skills.people_facts import _FACT_TO_PROPERTY

        assert "died" in _FACT_TO_PROPERTY or "death date" in _FACT_TO_PROPERTY

    def test_aliases_mapped(self):
        """Common phrasings like 'born in' and 'married to' map correctly."""
        from v2.orchestrator.skills.people_facts import _FACT_TO_PROPERTY

        assert _FACT_TO_PROPERTY.get("born in") == "P19"  # birthplace
        assert _FACT_TO_PROPERTY.get("married to") == "P26"  # spouse


# ---- Phase 6: time_in_location expanded city table -------------------------


class TestTimeInLocationCities:
    """City-to-timezone table has 100+ entries with global coverage."""

    def test_city_count(self):
        from v2.orchestrator.skills.time_in_location import _CITY_TO_TZ

        assert len(_CITY_TO_TZ) >= 100

    def test_all_continents_covered(self):
        from v2.orchestrator.skills.time_in_location import _CITY_TO_TZ

        tz_prefixes = {tz.split("/")[0] for tz in _CITY_TO_TZ.values()}
        for continent in ["America", "Europe", "Asia", "Africa", "Australia", "Pacific"]:
            assert continent in tz_prefixes, f"Missing continent: {continent}"

    def test_new_cities_resolve(self):
        """Newly added cities produce valid timezone lookups."""
        from v2.orchestrator.skills.time_in_location import _resolve_tz

        new_cities = ["zurich", "prague", "taipei", "bogota", "casablanca", "dhaka"]
        for city in new_cities:
            assert _resolve_tz(city) is not None, f"Failed to resolve: {city}"

    def test_handler_new_city(self):
        from v2.orchestrator.skills.time_in_location import handle

        result = asyncio.run(
            handle({"chunk_text": "zurich", "params": {"city": "zurich"}})
        )
        assert result["success"] is True
        assert "zurich" in result["output_text"].lower()


# ---- Phase 7: LLM skill contract ------------------------------------------


class TestLLMSkillContract:
    """LLM skills carry source_title and follow the contract."""

    def test_stub_has_source_title(self):
        from v2.orchestrator.skills.llm_skills import generate_email

        result = asyncio.run(
            generate_email({"chunk_text": "write a refund email"})
        )
        assert result.get("source_title")
        assert "llm" in result["source_title"].lower()

    def test_all_handlers_are_async(self):
        from v2.orchestrator.skills import llm_skills

        handlers = [
            llm_skills.generate_email,
            llm_skills.code_assistance,
            llm_skills.summarize_text,
            llm_skills.create_plan,
            llm_skills.weigh_options,
            llm_skills.emotional_support,
        ]
        for fn in handlers:
            assert asyncio.iscoroutinefunction(fn), f"{fn.__name__} is not async"

    def test_empty_request_fails(self):
        from v2.orchestrator.skills.llm_skills import code_assistance

        result = asyncio.run(
            code_assistance({"chunk_text": ""})
        )
        assert result["success"] is False

    def test_contract_docstring(self):
        import v2.orchestrator.skills.llm_skills as mod

        assert "LLM Skill Contract" in (mod.__doc__ or "")
        assert "Phase 7" in (mod.__doc__ or "")


# ---- Phase 8: Source transparency ------------------------------------------


class TestSourceTransparency:
    """API-backed skills expose source_url or source_title on success."""

    def test_health_symptom_has_source(self):
        """MedlinePlus results carry source_url."""
        from v2.orchestrator.skills.health import look_up_symptom

        # We can't hit the real API in tests, but verify the code path
        # sets source fields by checking the AdapterResult construction
        import inspect

        src = inspect.getsource(look_up_symptom)
        assert "source_url" in src
        assert "source_title" in src

    def test_health_medication_has_source(self):
        from v2.orchestrator.skills.health import check_medication

        import inspect

        src = inspect.getsource(check_medication)
        assert "source_url" in src
        assert "source_title" in src

    def test_navigation_directions_has_source(self):
        from v2.orchestrator.skills.navigation import get_directions

        import inspect

        src = inspect.getsource(get_directions)
        assert "source_url" in src
        assert "OpenStreetMap" in src or "OSRM" in src

    def test_navigation_nearby_has_source(self):
        from v2.orchestrator.skills.navigation import find_nearby

        import inspect

        src = inspect.getsource(find_nearby)
        assert "source_url" in src

    def test_food_nutrition_has_source(self):
        from v2.orchestrator.skills.food import get_nutrition

        import inspect

        src = inspect.getsource(get_nutrition)
        assert "source_url" in src
        assert "Open Food Facts" in src

    def test_travel_flight_has_source(self):
        from v2.orchestrator.skills.travel import get_flight_status

        import inspect

        src = inspect.getsource(get_flight_status)
        assert "source_url" in src
        assert "OpenSky" in src

    def test_sports_scores_have_source(self):
        from v2.orchestrator.skills.sports_api import get_score

        import inspect

        src = inspect.getsource(get_score)
        assert "source_url" in src
        assert "ESPN" in src

    def test_sports_standings_have_source(self):
        from v2.orchestrator.skills.sports_api import get_standings

        import inspect

        src = inspect.getsource(get_standings)
        assert "source_url" in src

    def test_sports_schedule_has_source(self):
        from v2.orchestrator.skills.sports_api import get_schedule

        import inspect

        src = inspect.getsource(get_schedule)
        assert "source_url" in src


# ---- Phase 8: Registry maturity correctness --------------------------------


class TestRegistryMaturity:
    """Maturity levels match actual provider backing."""

    def test_real_api_skills_not_local_only(self):
        """Skills with real API backends should not be marked local_only."""
        items = load_function_registry()
        real_api_skills = [
            "get_stock_price",
            "get_stock_info",
            "get_nutrition",
        ]
        for cap in real_api_skills:
            entry = next((i for i in items if i["capability"] == cap), None)
            assert entry is not None, f"Missing capability: {cap}"
            assert entry["maturity"] != "local_only", (
                f"{cap} uses a real API but is still marked local_only"
            )

    def test_offline_capable_field_exists(self):
        """Skills that were upgraded should have offline_capable field."""
        items = load_function_registry()
        caps_with_offline = [
            "substitute_ingredient",
            "get_player_stats",
            "get_stock_price",
            "get_nutrition",
        ]
        for cap in caps_with_offline:
            entry = next((i for i in items if i["capability"] == cap), None)
            assert entry is not None, f"Missing capability: {cap}"
            assert "offline_capable" in entry, (
                f"{cap} should have offline_capable field"
            )

    def test_offline_capable_correct(self):
        """substitute_ingredient is offline, API-backed skills are not."""
        items = load_function_registry()
        sub = next(i for i in items if i["capability"] == "substitute_ingredient")
        assert sub["offline_capable"] is True
        stock = next(i for i in items if i["capability"] == "get_stock_price")
        assert stock["offline_capable"] is False


# ---- Phase 4/5: Provider stubs documented ----------------------------------


class TestProviderDocumentation:
    """Local-only skills acknowledge their prototype status."""

    def test_streaming_local_has_catalog_docs(self):
        import v2.orchestrator.skills.streaming_local as mod

        assert "curated" in (mod.__doc__ or "").lower()

    def test_shopping_has_catalog_docs(self):
        import v2.orchestrator.skills.shopping_local as mod

        assert "curated" in (mod.__doc__ or "").lower()

    def test_device_store_persistence(self):
        """Device skills use JSON store (not in-memory) for dev persistence."""
        from v2.orchestrator.skills._store import _path

        path = _path("test_persistence_check")
        assert path.suffix == ".json"
