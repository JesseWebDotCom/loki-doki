"""Capability-based routing: registry category lookup + active-skill picker.

The orchestrator's knowledge_source upgrade path resolves a capability
("web_search", "encyclopedia") to whichever active skill the user has
installed for it, instead of hardcoding skill IDs. These tests cover
the two seams that make that work.
"""
from __future__ import annotations

import json

import pytest

from lokidoki.core.decomposer import Ask
from lokidoki.core.orchestrator_skills import _ask_query, pick_active_skill_intent
from lokidoki.core.registry import SkillRegistry


@pytest.fixture
def category_skills_dir(tmp_path):
    """Four skills: encyclopedia, web_search, datetime, and one no-category."""
    enc = tmp_path / "alpha_wiki"
    enc.mkdir()
    (enc / "manifest.json").write_text(json.dumps({
        "skill_id": "alpha_wiki",
        "name": "Alpha Wiki",
        "intents": ["search_knowledge"],
        "categories": ["encyclopedia"],
        "parameters": {},
        "mechanisms": [{"method": "api", "priority": 1, "timeout_ms": 1000,
                        "requires_internet": True}],
    }))
    (enc / "__init__.py").write_text("")

    web = tmp_path / "beta_search"
    web.mkdir()
    (web / "manifest.json").write_text(json.dumps({
        "skill_id": "beta_search",
        "name": "Beta Search",
        "intents": ["search_web", "search_news"],
        "categories": ["web_search"],
        "parameters": {},
        "mechanisms": [{"method": "api", "priority": 1, "timeout_ms": 1000,
                        "requires_internet": True}],
    }))
    (web / "__init__.py").write_text("")

    dt = tmp_path / "delta_datetime"
    dt.mkdir()
    (dt / "manifest.json").write_text(json.dumps({
        "skill_id": "delta_datetime",
        "name": "Delta DateTime",
        "intents": ["get_datetime"],
        "categories": ["datetime"],
        "parameters": {},
        "mechanisms": [{"method": "clock", "priority": 1, "timeout_ms": 100,
                        "requires_internet": False}],
    }))
    (dt / "__init__.py").write_text("")

    misc = tmp_path / "gamma_misc"
    misc.mkdir()
    (misc / "manifest.json").write_text(json.dumps({
        "skill_id": "gamma_misc",
        "name": "Gamma",
        "intents": ["do_thing"],
        "parameters": {},
        "mechanisms": [{"method": "noop", "priority": 1, "timeout_ms": 100,
                        "requires_internet": False}],
    }))
    (misc / "__init__.py").write_text("")

    return tmp_path


def test_registry_indexes_skills_by_category(category_skills_dir):
    reg = SkillRegistry(skills_dir=str(category_skills_dir))
    reg.scan()

    enc = reg.get_skills_by_category("encyclopedia")
    web = reg.get_skills_by_category("web_search")
    dt = reg.get_skills_by_category("datetime")
    none = reg.get_skills_by_category("nonexistent")

    assert [sid for sid, _ in enc] == ["alpha_wiki"]
    assert [sid for sid, _ in web] == ["beta_search"]
    assert [sid for sid, _ in dt] == ["delta_datetime"]
    assert none == []


@pytest.mark.anyio
async def test_pick_active_skill_intent_returns_first_intent(category_skills_dir):
    """Without a memory provider the picker returns the first intent of
    the first installed skill in the category — that is the path the
    orchestrator falls back to when the user is anonymous."""
    reg = SkillRegistry(skills_dir=str(category_skills_dir))
    reg.scan()

    web = await pick_active_skill_intent("web_search", reg, memory=None, user_id=None)
    enc = await pick_active_skill_intent("encyclopedia", reg, memory=None, user_id=None)
    dt = await pick_active_skill_intent("datetime", reg, memory=None, user_id=None)
    miss = await pick_active_skill_intent("voice", reg, memory=None, user_id=None)

    assert web == "beta_search.search_web"
    assert enc == "alpha_wiki.search_knowledge"
    assert dt == "delta_datetime.get_datetime"
    assert miss is None


@pytest.mark.anyio
async def test_pick_active_skill_intent_handles_no_registry():
    assert await pick_active_skill_intent("web_search", None, memory=None, user_id=None) is None


@pytest.mark.anyio
async def test_real_skill_directory_exposes_capability_routing():
    """The real lokidoki/skills/ tree must declare web_search and
    encyclopedia categories so production routing keeps working without
    further config. Catches the regression where someone strips the
    `categories` key from a manifest during a refactor."""
    reg = SkillRegistry()
    reg.scan()
    web = await pick_active_skill_intent("web_search", reg, memory=None, user_id=None)
    enc = await pick_active_skill_intent("encyclopedia", reg, memory=None, user_id=None)
    dt = await pick_active_skill_intent("datetime", reg, memory=None, user_id=None)
    media = await pick_active_skill_intent("current_media", reg, memory=None, user_id=None)
    assert web == "search_ddg.search_web"
    assert enc == "knowledge_wiki.search_knowledge"
    assert dt == "datetime_local.get_datetime"
    # current_media has multiple registered providers (movies_showtimes,
    # movies_fandango). pick_active_skill_intent returns the first
    # enabled one in registry scan order; either is a valid production
    # answer, the user toggles which is active via skill_config.
    assert media in {
        "movies_showtimes.get_showtimes",
        "movies_fandango.get_showtimes",
    }


def test_encyclopedic_query_prefers_named_anchor():
    ask = Ask(
        ask_id="ask_000",
        intent="direct_chat",
        distilled_query="who is Arthur Miller",
        capability_need="encyclopedic",
        referent_type="person",
        referent_anchor="Arthur Miller",
    )

    assert _ask_query(ask) == "Arthur Miller"
