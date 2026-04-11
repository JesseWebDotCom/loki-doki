"""Unit tests for the v2/orchestrator/skills adapters.

Each adapter is a thin wrapper around a v1 LokiDoki skill. These tests
swap the v1 singleton for a deterministic in-memory fake and assert that
the adapter:

  1. Pulls the right parameters out of a v2 payload.
  2. Walks the v1 fallback chain in the documented priority order.
  3. Translates the ``MechanismResult`` blob into the v2 ``output_text``
     contract.
  4. Degrades to a graceful error sentence when every mechanism fails.

Adapter swaps go through ``monkeypatch.setattr`` so the singleton is
automatically restored at end of test — otherwise a leftover fake would
leak into the integration regression suite that runs after these.
"""
from __future__ import annotations

from typing import Any

import pytest

from lokidoki.core.skill_executor import MechanismResult


# ---- helpers ---------------------------------------------------------------


class _RecordingFake:
    """Fake v1 skill that records every (method, params) call.

    Configure it with ``responses[method] = MechanismResult(...)`` and
    inspect ``calls`` after the adapter runs.
    """

    def __init__(self, responses: dict[str, MechanismResult] | None = None) -> None:
        self.responses: dict[str, MechanismResult] = dict(responses or {})
        self.calls: list[tuple[str, dict[str, Any]]] = []

    async def execute_mechanism(self, method: str, parameters: dict) -> MechanismResult:
        self.calls.append((method, dict(parameters)))
        if method in self.responses:
            return self.responses[method]
        return MechanismResult(success=False, error=f"no fake for {method}")


def _ok(data: dict[str, Any], **extra: Any) -> MechanismResult:
    return MechanismResult(success=True, data=data, **extra)


def _fail(error: str) -> MechanismResult:
    return MechanismResult(success=False, error=error)


def _install_fake(monkeypatch: pytest.MonkeyPatch, adapter_module, fake) -> None:
    """Swap an adapter's ``_SKILL`` singleton with auto-teardown."""
    monkeypatch.setattr(adapter_module, "_SKILL", fake, raising=True)


# ---- weather adapter -------------------------------------------------------


@pytest.mark.anyio
async def test_weather_adapter_uses_lead_field(monkeypatch):
    from v2.orchestrator.skills import weather as adapter

    fake = _RecordingFake({
        "open_meteo": _ok({"lead": "It's 22°C in Tokyo."}),
    })
    _install_fake(monkeypatch, adapter, fake)

    result = await adapter.handle({"chunk_text": "what's the weather in tokyo"})
    assert result["output_text"] == "It's 22°C in Tokyo."
    assert fake.calls[0][0] == "open_meteo"
    assert fake.calls[0][1]["location"] == "tokyo"


@pytest.mark.anyio
async def test_weather_adapter_falls_through_to_cache(monkeypatch):
    from v2.orchestrator.skills import weather as adapter

    fake = _RecordingFake({
        "open_meteo": _fail("network down"),
        "local_cache": _ok({"location": "Seattle", "temperature": 18, "condition": "rain"}),
    })
    _install_fake(monkeypatch, adapter, fake)

    result = await adapter.handle({"chunk_text": "weather in seattle"})
    assert "Seattle" in result["output_text"]
    assert [c[0] for c in fake.calls] == ["open_meteo", "local_cache"]


@pytest.mark.anyio
async def test_weather_adapter_graceful_failure_when_all_mechs_fail(monkeypatch):
    from v2.orchestrator.skills import weather as adapter

    fake = _RecordingFake({"open_meteo": _fail("dns"), "local_cache": _fail("miss")})
    _install_fake(monkeypatch, adapter, fake)

    result = await adapter.handle({"chunk_text": "weather in narnia"})
    assert result["success"] is False
    assert "couldn't reach" in result["output_text"].lower()


# ---- knowledge adapter -----------------------------------------------------


@pytest.mark.anyio
async def test_knowledge_adapter_uses_lead(monkeypatch):
    from v2.orchestrator.skills import knowledge as adapter

    fake = _RecordingFake({
        "mediawiki_api": _ok({"title": "Copper", "lead": "Copper is a chemical element."}),
    })
    _install_fake(monkeypatch, adapter, fake)

    result = await adapter.handle({"chunk_text": "how much copper is in a us penny"})
    assert "Copper is a chemical element." in result["output_text"]
    assert fake.calls[0][0] == "mediawiki_api"


@pytest.mark.anyio
async def test_knowledge_adapter_falls_through_to_scraper(monkeypatch):
    from v2.orchestrator.skills import knowledge as adapter

    fake = _RecordingFake({
        "mediawiki_api": _fail("api down"),
        "web_scraper": _ok({"title": "X", "lead": "Scraped lead."}),
    })
    _install_fake(monkeypatch, adapter, fake)

    result = await adapter.handle({"chunk_text": "what is X"})
    assert result["output_text"] == "Scraped lead."
    assert [c[0] for c in fake.calls] == ["mediawiki_api", "web_scraper"]


# ---- showtimes adapter -----------------------------------------------------


@pytest.mark.anyio
async def test_showtimes_adapter_pulls_title_after_for(monkeypatch):
    from v2.orchestrator.skills import showtimes as adapter

    fake = _RecordingFake({
        "movie_showtimes": _ok({"lead": "Showtimes for inception: 7:00 PM."}),
    })
    _install_fake(monkeypatch, adapter, fake)

    result = await adapter.handle({"chunk_text": "Show me movie times for Inception in 06461"})
    assert "inception" in result["output_text"].lower()
    method, params = fake.calls[0]
    assert method == "movie_showtimes"
    assert params["query"] == "inception"
    assert params["zip"] == "06461"


@pytest.mark.anyio
async def test_showtimes_adapter_uses_default_zip_when_missing(monkeypatch):
    from v2.orchestrator.skills import showtimes as adapter

    fake = _RecordingFake({
        "movie_showtimes": _ok({"lead": "Showtimes for the dark knight: 9 PM."}),
    })
    _install_fake(monkeypatch, adapter, fake)

    result = await adapter.handle({"chunk_text": "movie times for the dark knight"})
    method, params = fake.calls[0]
    assert params["query"] == "the dark knight"
    assert params["zip"] == adapter._DEFAULT_ZIP


# ---- smarthome adapters ----------------------------------------------------


@pytest.mark.anyio
async def test_smarthome_control_device_imperative(monkeypatch):
    from v2.orchestrator.skills import smarthome as adapter

    fake = _RecordingFake({
        "local_state": _ok({"device_id": "living_room_light", "name": "Living Room Light", "state": "on"}),
    })
    _install_fake(monkeypatch, adapter, fake)

    result = await adapter.control_device({"chunk_text": "turn on the living room light"})
    assert "Living Room Light is now on." == result["output_text"]
    method, params = fake.calls[0]
    assert method == "local_state"
    assert params["device"] == "living room light"
    assert params["action"] == "on"


@pytest.mark.anyio
async def test_smarthome_get_device_state_question(monkeypatch):
    from v2.orchestrator.skills import smarthome as adapter

    fake = _RecordingFake({
        "local_state": _ok({
            "device_id": "garage_door",
            "name": "Garage Door",
            "state": "closed",
            "type": "cover",
        }),
    })
    _install_fake(monkeypatch, adapter, fake)

    result = await adapter.get_device_state({"chunk_text": "did i close the garage"})
    assert "Garage Door" in result["output_text"]
    assert "closed" in result["output_text"]
    method, params = fake.calls[0]
    assert params["device"] == "garage"
    assert params["action"] == "status"


@pytest.mark.anyio
async def test_smarthome_get_indoor_temperature_reads_thermostat(monkeypatch):
    from v2.orchestrator.skills import smarthome as adapter

    fake = _RecordingFake({
        "local_state": _ok({
            "device_id": "thermostat",
            "name": "Thermostat",
            "type": "climate",
            "state": "on",
            "temperature": 22,
        }),
    })
    _install_fake(monkeypatch, adapter, fake)

    result = await adapter.get_indoor_temperature({"chunk_text": "how warm is it inside"})
    assert "22" in result["output_text"]
    assert "°C" in result["output_text"] or "C" in result["output_text"]
    method, params = fake.calls[0]
    assert params["device"] == "thermostat"


@pytest.mark.anyio
async def test_smarthome_detect_presence_uses_overlay_table():
    from v2.orchestrator.skills import smarthome as adapter

    adapter.set_presence("kitchen", "no one")
    result = await adapter.detect_presence({"chunk_text": "is anyone in the kitchen"})
    assert "kitchen" in result["output_text"]
    assert "don't see anyone" in result["output_text"].lower() or "no one" in result["output_text"].lower()

    adapter.set_presence("kitchen", "Luke")
    result = await adapter.detect_presence({"chunk_text": "is anyone in the kitchen"})
    assert "Luke" in result["output_text"]
    # restore
    adapter.set_presence("kitchen", "no one")


# ---- dictionary adapter ----------------------------------------------------


@pytest.mark.anyio
async def test_dictionary_adapter_extracts_word_from_define_prefix(monkeypatch):
    from v2.orchestrator.skills import dictionary as adapter

    fake = _RecordingFake({
        "dictionaryapi_dev": _ok({
            "word": "ephemeral",
            "phonetic": "/ɪˈfɛmərəl/",
            "meanings": [
                {"part_of_speech": "adjective", "definitions": ["lasting for a very short time"]}
            ],
        }),
    })
    _install_fake(monkeypatch, adapter, fake)

    result = await adapter.handle({"chunk_text": "define ephemeral"})
    assert "ephemeral" in result["output_text"]
    assert "lasting for a very short time" in result["output_text"]
    method, params = fake.calls[0]
    assert params["word"] == "ephemeral"


# ---- news adapter ----------------------------------------------------------


@pytest.mark.anyio
async def test_news_adapter_returns_top_headline(monkeypatch):
    from v2.orchestrator.skills import news as adapter

    fake = _RecordingFake({
        "google_news_rss": _ok({
            "topic": "tech",
            "headlines": [
                {"title": "Big tech merger announced", "source": "TestPress"},
                {"title": "Other story", "source": "TestPress"},
            ],
        }),
    })
    _install_fake(monkeypatch, adapter, fake)

    result = await adapter.handle({"chunk_text": "what's happening in tech news"})
    assert "Big tech merger announced" in result["output_text"]
    method, params = fake.calls[0]
    assert params["topic"] == "tech"


# ---- recipes adapter -------------------------------------------------------


@pytest.mark.anyio
async def test_recipes_adapter_returns_first_recipe_with_ingredients(monkeypatch):
    from v2.orchestrator.skills import recipes as adapter

    fake = _RecordingFake({
        "themealdb": _ok({
            "query": "lasagna",
            "recipes": [
                {"name": "Lasagna", "ingredients": ["pasta", "tomato", "cheese"]},
            ],
        }),
    })
    _install_fake(monkeypatch, adapter, fake)

    result = await adapter.handle({"chunk_text": "recipe for lasagna"})
    assert "Lasagna" in result["output_text"]
    assert "pasta" in result["output_text"]


# ---- jokes adapter ---------------------------------------------------------


@pytest.mark.anyio
async def test_jokes_adapter_returns_joke(monkeypatch):
    from v2.orchestrator.skills import jokes as adapter

    fake = _RecordingFake({
        "icanhazdadjoke": _ok({"joke": "Why don't eggs tell jokes? They'd crack each other up."}),
    })
    _install_fake(monkeypatch, adapter, fake)

    result = await adapter.handle({"chunk_text": "tell me a joke"})
    assert "eggs" in result["output_text"]


# ---- tv_show adapter -------------------------------------------------------


@pytest.mark.anyio
async def test_tv_show_adapter_includes_network_and_rating(monkeypatch):
    from v2.orchestrator.skills import tv_show as adapter

    fake = _RecordingFake({
        "tvmaze_api": _ok({
            "name": "Breaking Bad",
            "status": "Ended",
            "network": "AMC",
            "rating": 9.5,
        }),
    })
    _install_fake(monkeypatch, adapter, fake)

    result = await adapter.handle({"chunk_text": "tell me about the tv show breaking bad"})
    assert "Breaking Bad" in result["output_text"]
    assert "AMC" in result["output_text"]
    assert "9.5" in result["output_text"]


# ---- calculator + units adapters -------------------------------------------


@pytest.mark.anyio
async def test_calculator_adapter_evaluates_expression(monkeypatch):
    from v2.orchestrator.skills import calculator as adapter

    fake = _RecordingFake({
        "safe_eval": _ok({"expression": "6*4", "normalized": "6*4", "result": 24}),
    })
    _install_fake(monkeypatch, adapter, fake)

    result = await adapter.handle({"chunk_text": "6*4"})
    assert result["output_text"] == "24"
    method, params = fake.calls[0]
    assert params["expression"] == "6*4"


@pytest.mark.anyio
async def test_units_adapter_parses_convert_phrasing(monkeypatch):
    from v2.orchestrator.skills import units as adapter

    fake = _RecordingFake({
        "table_lookup": _ok({
            "value": 10.0,
            "from_unit": "miles",
            "to_unit": "km",
            "result": 16.09,
            "category": "length",
        }),
    })
    _install_fake(monkeypatch, adapter, fake)

    result = await adapter.handle({"chunk_text": "convert 10 miles to km"})
    assert "16" in result["output_text"]
    assert "km" in result["output_text"]


# ---- get_time_in_location (zoneinfo, no v1 dep) ----------------------------


@pytest.mark.anyio
async def test_time_in_location_resolves_known_city():
    from v2.orchestrator.skills import time_in_location as adapter

    result = await adapter.handle({"chunk_text": "what time is it in tokyo"})
    assert "Tokyo" in result["output_text"]
    assert "data" in result and result["data"]["timezone"] == "Asia/Tokyo"


@pytest.mark.anyio
async def test_time_in_location_unknown_city_graceful():
    from v2.orchestrator.skills import time_in_location as adapter

    result = await adapter.handle({"chunk_text": "what time is it in atlantis"})
    assert result["success"] is False
    assert "don't know" in result["output_text"].lower()


# ---- LLM-backed handlers (stub fallback path) ------------------------------


@pytest.mark.anyio
async def test_llm_skills_return_stub_when_gemma_disabled():
    from v2.orchestrator.skills import llm_skills

    # CONFIG.gemma_enabled defaults to False in tests, so every call
    # should return its deterministic stub immediately.
    result = await llm_skills.generate_email({"chunk_text": "write a refund email"})
    assert "Subject" in result["output_text"]

    result = await llm_skills.code_assistance({"chunk_text": "write a python scraper"})
    assert "```" in result["output_text"]

    result = await llm_skills.summarize_text({"chunk_text": "summarize this article"})
    assert "summary" in result["output_text"].lower()

    result = await llm_skills.create_plan({"chunk_text": "plan a 3 day trip"})
    assert "Day" in result["output_text"]

    result = await llm_skills.weigh_options({"chunk_text": "should i invest or save"})
    assert "options" in result["output_text"].lower()

    result = await llm_skills.emotional_support({"chunk_text": "i feel stuck in life"})
    assert "hear you" in result["output_text"].lower()
