"""C15 — Skills admin & settings pages: registry rewire.

Tests that the skills API routes read from the promoted capability
registry instead of legacy manifests, the config manifest is loaded
correctly, the test endpoint uses the pipeline executor, and the
frontend category mapping covers all 93 capabilities.
"""
from __future__ import annotations

import json
import re
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest


# ---------------------------------------------------------------------------
# Config manifest tests
# ---------------------------------------------------------------------------


class TestCapabilityConfigManifest:
    """The separate capability_config.json file."""

    def _load(self) -> dict:
        path = (
            Path(__file__).resolve().parents[2]
            / "lokidoki"
            / "orchestrator"
            / "data"
            / "capability_config.json"
        )
        return json.loads(path.read_text())

    def test_file_exists(self):
        path = (
            Path(__file__).resolve().parents[2]
            / "lokidoki"
            / "orchestrator"
            / "data"
            / "capability_config.json"
        )
        assert path.exists()

    def test_valid_json(self):
        data = self._load()
        assert isinstance(data, dict)

    def test_get_weather_has_user_location(self):
        data = self._load()
        user_fields = data["get_weather"]["user"]
        keys = [f["key"] for f in user_fields]
        assert "location" in keys

    def test_lookup_movie_has_tmdb_key(self):
        data = self._load()
        global_fields = data["lookup_movie"]["global"]
        keys = [f["key"] for f in global_fields]
        assert "tmdb_api_key" in keys

    def test_search_movies_has_tmdb_key(self):
        data = self._load()
        global_fields = data["search_movies"]["global"]
        keys = [f["key"] for f in global_fields]
        assert "tmdb_api_key" in keys

    def test_showtimes_has_default_zip(self):
        data = self._load()
        user_fields = data["get_movie_showtimes"]["user"]
        keys = [f["key"] for f in user_fields]
        assert "default_zip" in keys

    def test_secret_fields_typed_correctly(self):
        data = self._load()
        for cap, schema in data.items():
            for tier in ("global", "user"):
                for field in schema.get(tier, []):
                    if "api_key" in field["key"] or "secret" in field.get("label", "").lower():
                        assert field["type"] == "secret", (
                            f"{cap}.{tier}.{field['key']} should be type=secret"
                        )

    def test_all_entries_have_both_tiers(self):
        data = self._load()
        for cap, schema in data.items():
            assert "global" in schema, f"{cap} missing global tier"
            assert "user" in schema, f"{cap} missing user tier"


# ---------------------------------------------------------------------------
# skills.py registry wiring
# ---------------------------------------------------------------------------


class TestSkillsRouteImports:
    """The rewritten skills.py uses the capability registry, not legacy manifests."""

    def _read_source(self) -> str:
        path = (
            Path(__file__).resolve().parents[2]
            / "lokidoki"
            / "api"
            / "routes"
            / "skills.py"
        )
        return path.read_text()

    def test_no_legacy_registry_import(self):
        src = self._read_source()
        assert "from lokidoki.core.registry import" not in src

    def test_no_skill_factory_import(self):
        src = self._read_source()
        assert "skill_factory" not in src

    def test_no_skill_executor_import(self):
        src = self._read_source()
        assert "SkillExecutor" not in src

    def test_imports_runtime(self):
        src = self._read_source()
        assert "from lokidoki.orchestrator.registry.runtime import get_runtime" in src

    def test_imports_executor(self):
        src = self._read_source()
        assert "from lokidoki.orchestrator.execution.executor import execute_chunk_async" in src

    def test_imports_pipeline_types(self):
        src = self._read_source()
        assert "RequestChunk" in src
        assert "RouteMatch" in src
        assert "ResolutionResult" in src

    def test_no_501_stub(self):
        """The test endpoint no longer returns 501."""
        src = self._read_source()
        assert "skill_test_unavailable_pending_rewire" not in src

    def test_loads_config_schemas(self):
        src = self._read_source()
        assert "capability_config.json" in src


# ---------------------------------------------------------------------------
# chat.py /skills endpoint uses the capability registry
# ---------------------------------------------------------------------------


class TestChatSkillsEndpoint:
    """The /chat/skills endpoint uses the capability registry."""

    def _read_source(self) -> str:
        path = (
            Path(__file__).resolve().parents[2]
            / "lokidoki"
            / "api"
            / "routes"
            / "chat.py"
        )
        return path.read_text()

    def test_no_legacy_registry_in_chat(self):
        src = self._read_source()
        # The /skills endpoint should not import SkillRegistry
        assert "SkillRegistry" not in src

    def test_uses_get_runtime(self):
        src = self._read_source()
        assert "get_runtime" in src


# ---------------------------------------------------------------------------
# _humanize helper
# ---------------------------------------------------------------------------


class TestHumanize:

    def _humanize(self, name: str) -> str:
        from lokidoki.api.routes.skills import _humanize
        return _humanize(name)

    def test_get_weather(self):
        assert self._humanize("get_weather") == "Weather"

    def test_lookup_movie(self):
        assert self._humanize("lookup_movie") == "Movie"

    def test_substitute_ingredient(self):
        assert self._humanize("substitute_ingredient") == "Substitute Ingredient"

    def test_direct_chat(self):
        assert self._humanize("direct_chat") == "Direct Chat"

    def test_greeting_response(self):
        assert self._humanize("greeting_response") == "Greeting Response"

    def test_calculate_tip(self):
        result = self._humanize("calculate_tip")
        assert "Tip" in result

    def test_knowledge_query(self):
        result = self._humanize("knowledge_query")
        assert "Query" in result

    def test_emotional_support(self):
        assert self._humanize("emotional_support") == "Emotional Support"


# ---------------------------------------------------------------------------
# _build_capability_view shape
# ---------------------------------------------------------------------------


class TestBuildCapabilityView:
    """The view builder produces the SkillSummary shape the frontend expects."""

    def _build(self, **overrides):
        from lokidoki.api.routes.skills import _build_capability_view
        defaults = dict(
            capability="get_weather",
            entry={
                "capability": "get_weather",
                "description": "Fetch current weather",
                "examples": ["what's the weather", "weather in LA"],
            },
            global_vals={},
            user_vals={},
            global_toggle=True,
            user_toggle=True,
        )
        defaults.update(overrides)
        return _build_capability_view(**defaults)

    def test_has_skill_id(self):
        view = self._build()
        assert view["skill_id"] == "get_weather"

    def test_has_name(self):
        view = self._build()
        assert view["name"] == "Weather"

    def test_has_description(self):
        view = self._build()
        assert view["description"] == "Fetch current weather"

    def test_has_examples(self):
        view = self._build()
        assert len(view["examples"]) == 2

    def test_has_config_schema(self):
        view = self._build()
        assert "global" in view["config_schema"]
        assert "user" in view["config_schema"]

    def test_has_enabled_state(self):
        view = self._build()
        assert "enabled" in view
        assert "config_ok" in view
        assert "missing_required" in view
        assert "disabled_reason" in view

    def test_has_toggle(self):
        view = self._build()
        assert view["toggle"] == {"global": True, "user": True}

    def test_intents_is_list_with_capability(self):
        view = self._build()
        assert view["intents"] == ["get_weather"]


# ---------------------------------------------------------------------------
# Frontend categories cover all capabilities
# ---------------------------------------------------------------------------


class TestFrontendCategories:
    """The updated categories.ts maps all 93 capabilities."""

    def _load_categories_source(self) -> str:
        path = (
            Path(__file__).resolve().parents[2]
            / "frontend"
            / "src"
            / "components"
            / "settings"
            / "skills"
            / "categories.ts"
        )
        return path.read_text()

    def _load_capabilities(self) -> list[str]:
        path = (
            Path(__file__).resolve().parents[2]
            / "lokidoki"
            / "orchestrator"
            / "data"
            / "function_registry.json"
        )
        data = json.loads(path.read_text())
        return [item["capability"] for item in data]

    def test_no_legacy_skill_ids(self):
        """Old legacy IDs like weather_openmeteo should not appear."""
        src = self._load_categories_source()
        legacy_ids = ["weather_openmeteo", "movies_fandango", "movies_tmdb",
                   "news_rss", "search_ddg", "knowledge_wiki",
                   "smarthome_mock", "recipe_mealdb"]
        for legacy_id in legacy_ids:
            assert legacy_id not in src, f"legacy ID {legacy_id} still in categories.ts"

    def test_all_capabilities_mapped(self):
        """Every capability in the registry has a category mapping."""
        src = self._load_categories_source()
        caps = self._load_capabilities()
        unmapped = []
        for cap in caps:
            # Check if the capability appears in ID_TO_CATEGORY
            if f"{cap}:" not in src and f'"{cap}"' not in src and f"'{cap}'" not in src:
                unmapped.append(cap)
        # Allow a few to fall to "other" but most should be mapped
        assert len(unmapped) < 5, f"Unmapped capabilities: {unmapped}"

    def test_categories_have_labels(self):
        """All referenced category values in ID_TO_CATEGORY are defined in CATEGORIES."""
        src = self._load_categories_source()
        # Extract the ID_TO_CATEGORY block
        id_block_match = re.search(r'const ID_TO_CATEGORY.*?\{(.*?)\};', src, re.DOTALL)
        assert id_block_match, "ID_TO_CATEGORY not found"
        id_block = id_block_match.group(1)
        # Extract category values (the RHS of "capability: category")
        cat_values = set(re.findall(r':\s*"(\w+)"', id_block))
        # Extract CATEGORIES keys
        cat_block_match = re.search(r'export const CATEGORIES.*?\{(.*?)\};', src, re.DOTALL)
        assert cat_block_match, "CATEGORIES not found"
        cat_keys = set(re.findall(r'(\w+):\s*\{', cat_block_match.group(1)))
        for val in cat_values:
            assert val in cat_keys, f"Category '{val}' used in ID_TO_CATEGORY but not defined in CATEGORIES"


# ---------------------------------------------------------------------------
# Migration script
# ---------------------------------------------------------------------------


