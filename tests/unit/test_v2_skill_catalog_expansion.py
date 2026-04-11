from __future__ import annotations

from typing import Any

import pytest

from lokidoki.core.skill_executor import MechanismResult
from v2.orchestrator.registry.runtime import get_runtime
from v2.orchestrator.routing.router import route_chunk
from v2.orchestrator.core.types import RequestChunk


class _RecordingFake:
    def __init__(self, responses: dict[str, MechanismResult] | None = None) -> None:
        self.responses = dict(responses or {})
        self.calls: list[tuple[str, dict[str, Any]]] = []

    async def execute_mechanism(self, method: str, parameters: dict[str, Any]) -> MechanismResult:
        self.calls.append((method, dict(parameters)))
        if method in self.responses:
            return self.responses[method]
        return MechanismResult(success=False, error=f"no fake for {method}")


def _ok(data: dict[str, Any], **extra: Any) -> MechanismResult:
    return MechanismResult(success=True, data=data, **extra)


@pytest.mark.anyio
async def test_holidays_adapter_get_holiday_matches_name(monkeypatch):
    from v2.orchestrator.skills import holidays as adapter

    fake = _RecordingFake({
        "nager_public_holidays": _ok({
            "country": "US",
            "year": 2026,
            "holidays": [
                {"name": "Thanksgiving Day", "date": "2026-11-26"},
                {"name": "Christmas Day", "date": "2026-12-25"},
            ],
        }),
    })
    monkeypatch.setattr(adapter, "_SKILL", fake, raising=True)

    result = await adapter.get_holiday({"chunk_text": "what day is thanksgiving this year"})

    assert "2026-11-26" in result["output_text"]
    method, params = fake.calls[0]
    assert method == "nager_public_holidays"
    assert params["country"] == "US"


@pytest.mark.anyio
async def test_holidays_adapter_lists_holidays(monkeypatch):
    from v2.orchestrator.skills import holidays as adapter

    fake = _RecordingFake({
        "nager_public_holidays": _ok({
            "country": "JP",
            "year": 2026,
            "holidays": [
                {"name": "New Year's Day", "date": "2026-01-01"},
                {"name": "Foundation Day", "date": "2026-02-11"},
            ],
        }),
    })
    monkeypatch.setattr(adapter, "_SKILL", fake, raising=True)

    result = await adapter.list_holidays({"chunk_text": "list holidays in japan this year"})

    assert "New Year's Day" in result["output_text"]
    assert "Foundation Day" in result["output_text"]


@pytest.mark.anyio
async def test_finance_adapter_converts_currency(monkeypatch):
    from v2.orchestrator.skills import finance as adapter

    fake = _RecordingFake({
        "frankfurter_latest": _ok({
            "amount": 200.0,
            "base": "EUR",
            "target": "USD",
            "rate": 1.08,
            "converted_amount": 216.0,
            "date": "2026-04-11",
        }),
    })
    monkeypatch.setattr(adapter, "_SKILL", fake, raising=True)

    result = await adapter.convert_currency({"chunk_text": "how much is 200 euros in dollars"})

    assert "216" in result["output_text"]
    method, params = fake.calls[0]
    assert method == "frankfurter_latest"
    assert params["from_currency"] == "EUR"
    assert params["to_currency"] == "USD"


@pytest.mark.anyio
async def test_finance_adapter_reads_exchange_rate(monkeypatch):
    from v2.orchestrator.skills import finance as adapter

    fake = _RecordingFake({
        "frankfurter_latest": _ok({
            "base": "GBP",
            "target": "USD",
            "rate": 1.24,
            "date": "2026-04-11",
        }),
    })
    monkeypatch.setattr(adapter, "_SKILL", fake, raising=True)

    result = await adapter.get_exchange_rate({"chunk_text": "what's the gbp to usd rate right now"})

    assert "1 GBP = 1.24 USD" in result["output_text"]


@pytest.mark.anyio
async def test_news_adapter_builds_briefing(monkeypatch):
    from v2.orchestrator.skills import news as adapter

    fake = _RecordingFake({
        "google_news_rss": _ok({
            "topic": "top",
            "headlines": [
                {"title": "Story one", "source": "AP"},
                {"title": "Story two", "source": "Reuters"},
                {"title": "Story three", "source": "BBC"},
            ],
        }),
    })
    monkeypatch.setattr(adapter, "_SKILL", fake, raising=True)

    result = await adapter.get_briefing({"chunk_text": "give me my morning briefing"})

    assert "Story one" in result["output_text"]
    assert "Story two" in result["output_text"]
    assert "Story three" in result["output_text"]


@pytest.mark.anyio
async def test_news_adapter_searches_news(monkeypatch):
    from v2.orchestrator.skills import news as adapter

    fake = _RecordingFake({
        "google_news_rss": _ok({
            "topic": "ai",
            "headlines": [
                {"title": "Recent AI story", "source": "NPR"},
            ],
        }),
    })
    monkeypatch.setattr(adapter, "_SKILL", fake, raising=True)

    result = await adapter.search_news({"chunk_text": "recent AI news"})

    assert "Recent AI story" in result["output_text"]
    method, params = fake.calls[0]
    assert method == "google_news_rss"
    assert params["query"] == "ai"


def test_calculator_tip_handler_parses_bill_and_split():
    from v2.orchestrator.skills import calculator as adapter

    result = adapter.calculate_tip({"chunk_text": "what's a 20% tip on $120 split 4 ways"})

    assert "24" in result["output_text"]
    assert "36" in result["output_text"]
    assert "4 ways" in result["output_text"]


@pytest.mark.anyio
async def test_time_until_handles_holiday_lookup(monkeypatch):
    from v2.orchestrator.skills import holidays as holidays_adapter
    from v2.orchestrator.skills import time_until as adapter

    fake = _RecordingFake({
        "nager_public_holidays": _ok({
            "country": "US",
            "year": 2026,
            "holidays": [
                {"name": "Christmas Day", "date": "2026-12-25"},
            ],
        }),
    })
    monkeypatch.setattr(holidays_adapter, "_SKILL", fake, raising=True)

    result = await adapter.handle({"chunk_text": "how long until christmas"})

    assert "Christmas Day" in result["output_text"]
    assert "day" in result["output_text"]


def test_function_registry_contains_new_v2_skills():
    runtime = get_runtime()

    for capability in (
        "get_holiday",
        "list_holidays",
        "time_until",
        "calculate_tip",
        "convert_currency",
        "get_exchange_rate",
        "get_briefing",
        "search_news",
        "create_event",
        "set_alarm",
        "search_contacts",
        "create_note",
        "play_music",
        "get_directions",
        "get_streaming",
        "get_nutrition",
        "translate",
        "greet",
        "get_stock_price",
        "get_score",
    ):
        assert capability in runtime.capabilities


def test_router_can_match_currency_conversion_phrase():
    runtime = get_runtime()
    chunk = RequestChunk(text="how much is 200 euros in dollars", index=0)

    match = route_chunk(chunk, runtime)

    assert match.capability == "convert_currency"
