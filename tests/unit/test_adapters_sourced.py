from __future__ import annotations

from lokidoki.core.skill_executor import MechanismResult
from lokidoki.orchestrator.adapters.knowledge import WikipediaAdapter
from lokidoki.orchestrator.adapters.news import NewsAdapter
from lokidoki.orchestrator.adapters.search import DuckDuckGoAdapter
from lokidoki.orchestrator.adapters.weather_openmeteo import OpenMeteoAdapter


def test_wikipedia_adapter_happy_path():
    output = WikipediaAdapter().adapt(
        MechanismResult(
            success=True,
            data={
                "title": "Anakin Skywalker",
                "lead": "Anakin Skywalker is a Jedi Knight. He later becomes Darth Vader.",
                "url": "https://example.test/anakin",
            },
        )
    )
    assert output.summary_candidates[0].startswith("Anakin Skywalker is a Jedi Knight")
    assert len(output.facts) == 2
    assert output.sources[0].url == "https://example.test/anakin"


def test_wikipedia_adapter_gracefully_handles_empty_data():
    output = WikipediaAdapter().adapt(MechanismResult(success=True, data={}))
    assert output.summary_candidates == ()
    assert output.raw == {}


def test_search_adapter_happy_path_caps_sources():
    rows = [f"result snippet {idx}" for idx in range(10)]
    output = DuckDuckGoAdapter().adapt(
        MechanismResult(
            success=True,
            data={"heading": "Padme Amidala", "abstract": "A queen and senator.", "results": rows},
            source_url="https://duckduckgo.com/?q=padme",
            source_title="Padme Amidala",
        )
    )
    assert output.summary_candidates == ("A queen and senator.",)
    assert len(output.sources) == 8
    assert output.sources[0].url == "https://duckduckgo.com/?q=padme"


def test_search_adapter_does_not_invent_urls():
    output = DuckDuckGoAdapter().adapt(
        MechanismResult(
            success=True,
            data={"results": ["offline snippet"]},
        )
    )
    assert output.sources[0].url is None


def test_news_adapter_happy_path_caps_at_five():
    headlines = [
        {
            "title": f"Headline {idx}",
            "link": f"https://example.test/{idx}",
            "published": f"2026-04-2{idx}T10:00:00Z",
            "source": "Galactic News",
        }
        for idx in range(6)
    ]
    output = NewsAdapter().adapt(
        MechanismResult(success=True, data={"headlines": headlines})
    )
    assert output.summary_candidates[0].startswith("Headline 0")
    assert len(output.facts) == 5
    assert len(output.sources) == 5


def test_news_adapter_gracefully_handles_empty_data():
    output = NewsAdapter().adapt(MechanismResult(success=True, data={}))
    assert output.summary_candidates == ()
    assert output.raw == {}


def test_weather_adapter_happy_path():
    output = OpenMeteoAdapter().adapt(
        MechanismResult(
            success=True,
            data={
                "lead": "It's 20°C in Brooklyn — no rain right now.",
                "location": "Brooklyn, US",
                "temperature": 20,
                "feels_like": 19,
                "humidity": 40,
                "wind_speed": 12,
                "condition": "clear sky",
            },
        )
    )
    assert output.summary_candidates == ("It's 20°C in Brooklyn — no rain right now.",)
    assert "Current: 20°C" in output.facts
    assert output.sources[0].url == "https://open-meteo.com"


def test_weather_adapter_gracefully_handles_empty_data():
    output = OpenMeteoAdapter().adapt(MechanismResult(success=True, data={}))
    assert output.summary_candidates == ()
    assert output.raw == {}
