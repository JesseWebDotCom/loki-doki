import pytest
import json
import os
from lokidoki.core.registry import SkillRegistry


@pytest.fixture
def skills_dir(tmp_path):
    """Create a temporary skills directory with test manifests."""
    # Skill 1: datetime_local
    dt_dir = tmp_path / "datetime_local"
    dt_dir.mkdir()
    (dt_dir / "manifest.json").write_text(json.dumps({
        "skill_id": "datetime_local",
        "name": "Local Date & Time",
        "is_searchable": False,
        "intents": ["get_datetime", "get_timezone"],
        "parameters": {},
        "mechanisms": [
            {"method": "system_clock", "priority": 1, "timeout_ms": 500, "requires_internet": False}
        ]
    }))
    (dt_dir / "__init__.py").write_text("")

    # Skill 2: weather_owm
    weather_dir = tmp_path / "weather_owm"
    weather_dir.mkdir()
    (weather_dir / "manifest.json").write_text(json.dumps({
        "skill_id": "weather_owm",
        "name": "OpenWeatherMap",
        "is_searchable": True,
        "search_config": {"corpus_target": "response_body", "budget_tokens": 1000},
        "intents": ["get_weather", "get_forecast"],
        "parameters": {"location": {"type": "string", "required": True}},
        "mechanisms": [
            {"method": "owm_api", "priority": 1, "timeout_ms": 3000, "requires_internet": True},
            {"method": "local_cache", "priority": 2, "timeout_ms": 500, "requires_internet": False}
        ]
    }))
    (weather_dir / "__init__.py").write_text("")

    # Skill 3: disabled skill (no manifest)
    broken_dir = tmp_path / "broken_skill"
    broken_dir.mkdir()
    (broken_dir / "__init__.py").write_text("")

    return tmp_path


@pytest.fixture
def registry(skills_dir):
    return SkillRegistry(skills_dir=str(skills_dir))


class TestSkillRegistry:
    def test_scan_discovers_skills_with_manifests(self, registry):
        """Test that scanning finds skills that have manifest.json."""
        registry.scan()
        assert len(registry.skills) == 2
        assert "datetime_local" in registry.skills
        assert "weather_owm" in registry.skills

    def test_scan_ignores_dirs_without_manifest(self, registry):
        """Test that directories without manifest.json are skipped."""
        registry.scan()
        assert "broken_skill" not in registry.skills

    def test_get_all_intents(self, registry):
        """Test aggregation of all intents across registered skills."""
        registry.scan()
        intents = registry.get_all_intents()
        assert "datetime_local.get_datetime" in intents
        assert "datetime_local.get_timezone" in intents
        assert "weather_owm.get_weather" in intents
        assert "weather_owm.get_forecast" in intents

    def test_get_skill_by_intent(self, registry):
        """Test looking up a skill by its qualified intent."""
        registry.scan()
        skill = registry.get_skill_by_intent("weather_owm.get_weather")
        assert skill is not None
        assert skill["skill_id"] == "weather_owm"

    def test_get_skill_by_intent_returns_none_for_unknown(self, registry):
        """Test that unknown intents return None."""
        registry.scan()
        assert registry.get_skill_by_intent("nonexistent.do_thing") is None

    def test_get_mechanisms_ordered_by_priority(self, registry):
        """Test that mechanisms are returned in priority order."""
        registry.scan()
        mechs = registry.get_mechanisms("weather_owm")
        assert len(mechs) == 2
        assert mechs[0]["method"] == "owm_api"
        assert mechs[1]["method"] == "local_cache"

    def test_get_intent_map_for_prompt(self, registry):
        """Test generation of token-efficient intent map for LLM prompt."""
        registry.scan()
        intent_map = registry.get_intent_map_string()
        assert "datetime_local" in intent_map
        assert "get_datetime" in intent_map
        assert "weather_owm" in intent_map

    def test_rescan_updates_skills(self, registry, skills_dir):
        """Test that rescanning picks up new skills."""
        registry.scan()
        assert len(registry.skills) == 2

        # Add a new skill
        new_dir = skills_dir / "new_skill"
        new_dir.mkdir()
        (new_dir / "manifest.json").write_text(json.dumps({
            "skill_id": "new_skill",
            "name": "New Skill",
            "is_searchable": False,
            "intents": ["do_new_thing"],
            "parameters": {},
            "mechanisms": []
        }))

        registry.scan()
        assert len(registry.skills) == 3
        assert "new_skill" in registry.skills

    def test_manifest_has_required_fields(self, registry):
        """Test that loaded manifests contain required schema fields."""
        registry.scan()
        for skill_id, manifest in registry.skills.items():
            assert "skill_id" in manifest
            assert "intents" in manifest
            assert "mechanisms" in manifest
