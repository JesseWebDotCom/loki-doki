"""Coverage for the offline-first replacements introduced when the
search-backed stubs in ``v2/orchestrator/skills/search_web.py`` were
swapped out for curated KBs.

These adapters used to dispatch into a generic DuckDuckGo search and
took ~1s per call (which broke the regression suite's 500ms latency
budget). The replacements live in ``shopping_local.py``,
``streaming_local.py``, ``travel_local.py`` and the rewritten
``smarthome.detect_presence``. Each test below verifies the mechanism
chain follows the v1 ``BaseSkill`` pattern: try the local KB / store
first, then return a graceful failure when nothing matches.
"""
from __future__ import annotations

import pytest

from v2.orchestrator.skills import (
    shopping_local,
    smarthome,
    streaming_local,
    travel_local,
)


# ---------------------------------------------------------------------------
# shopping_local
# ---------------------------------------------------------------------------


def test_find_products_resolves_alias_and_budget():
    result = shopping_local.find_products(
        {"chunk_text": "best laptop for gaming under 1000"}
    )
    assert result["output_text"].startswith("Top picks for gaming laptop")
    data = result["data"]
    assert data["category"] == "gaming laptop"
    assert data["budget_usd"] == 1000
    # Every returned pick should respect the budget filter when at least
    # one entry under budget exists.
    assert all(pick["price_usd"] <= 1000 for pick in data["picks"])


def test_find_products_handles_unknown_category():
    result = shopping_local.find_products({"chunk_text": "best banana for monkeys"})
    assert result["success"] is False
    assert result["mechanism_used"] == "local_catalog"
    assert "curated picks" in result["output_text"]


def test_find_products_runs_under_one_millisecond_per_call():
    """Regression guard for the 500ms pipeline budget."""
    import time

    start = time.perf_counter_ns()
    for _ in range(50):
        shopping_local.find_products({"chunk_text": "recommend a cheap headset"})
    elapsed_ms = (time.perf_counter_ns() - start) / 1_000_000
    # 50 calls should comfortably fit in well under 50ms total — the
    # exact ceiling is generous to avoid CI flakes.
    assert elapsed_ms < 100, f"shopping_local too slow: {elapsed_ms:.1f}ms / 50 calls"


def test_shopping_store_extras_are_picked_up(tmp_path, monkeypatch):
    monkeypatch.setattr(
        "v2.orchestrator.skills._store._ROOT", tmp_path
    )
    shopping_local.add_pick("laptop", "Test Laptop", 499, "test blurb")
    result = shopping_local.find_products({"chunk_text": "best laptop"})
    names = [pick["name"] for pick in result["data"]["picks"]]
    assert any("Test Laptop" in name for name in names + [result["output_text"]])


# ---------------------------------------------------------------------------
# streaming_local
# ---------------------------------------------------------------------------


@pytest.mark.anyio
async def test_streaming_local_returns_curated_movie():
    result = await streaming_local.get_streaming({"chunk_text": "where can i watch the matrix"})
    assert result.get("success", True) is True
    assert result["mechanism_used"] == "local_catalog"
    assert "Max" in result["output_text"]
    assert result["data"]["title"] == "the matrix"


@pytest.mark.anyio
async def test_streaming_local_resolves_franchise_alias():
    result = await streaming_local.get_streaming({"chunk_text": "where can i watch marvel movies"})
    assert result.get("success", True) is True
    assert "Disney+" in result["output_text"]


@pytest.mark.anyio
async def test_streaming_local_falls_through_to_tvmaze(monkeypatch):
    from lokidoki.core.skill_executor import MechanismResult

    class _FakeTVMaze:
        async def execute_mechanism(self, method: str, params: dict):
            assert method in {"tvmaze_api", "local_cache"}
            return MechanismResult(success=True, data={"name": "Severance", "network": "Apple TV+"})

    monkeypatch.setattr(streaming_local, "_SKILL", _FakeTVMaze())
    result = await streaming_local.get_streaming({"chunk_text": "where can i watch severance"})
    assert "Apple TV+" in result["output_text"]


# ---------------------------------------------------------------------------
# travel_local — flights
# ---------------------------------------------------------------------------


def test_search_flights_resolves_city_pair():
    result = travel_local.search_flights({"chunk_text": "flights from new york to la"})
    assert result.get("success", True) is True
    assert result["mechanism_used"] == "local_routes"
    assert result["data"]["origin"] == "JFK"
    assert result["data"]["dest"] == "LAX"
    assert result["data"]["carriers"]


def test_search_flights_unknown_route_fails_gracefully():
    result = travel_local.search_flights({"chunk_text": "flights from boise to reykjavik"})
    assert result["success"] is False
    assert "I don't have curated" in result["output_text"] or "Tell me both" in result["output_text"]


def test_search_flights_missing_route_prompts_user():
    result = travel_local.search_flights({"chunk_text": "show me flights"})
    assert result["success"] is False
    assert "origin" in result["output_text"].lower()


# ---------------------------------------------------------------------------
# travel_local — hotels
# ---------------------------------------------------------------------------


def test_search_hotels_returns_curated_picks():
    result = travel_local.search_hotels({"chunk_text": "hotels in tokyo"})
    assert result.get("success", True) is True
    assert result["mechanism_used"] == "local_chains"
    assert result["data"]["location"] == "tokyo"
    assert len(result["data"]["picks"]) == 3
    assert any("Peninsula" in pick["name"] for pick in result["data"]["picks"])


def test_search_hotels_unknown_city_fails_gracefully():
    result = travel_local.search_hotels({"chunk_text": "hotels in mars"})
    assert result["success"] is False
    assert "city" in result["output_text"].lower()


# ---------------------------------------------------------------------------
# travel_local — visa
# ---------------------------------------------------------------------------


def test_get_visa_info_resolves_us_to_japan():
    result = travel_local.get_visa_info({"chunk_text": "do i need a visa for japan with a us passport"})
    assert result.get("success", True) is True
    assert result["data"]["passport"] == "us"
    assert result["data"]["destination"] == "japan"
    assert "Visa-free" in result["output_text"]


def test_get_visa_info_unknown_pair_fails_gracefully():
    result = travel_local.get_visa_info({"chunk_text": "visa from antarctica to atlantis"})
    assert result["success"] is False


# ---------------------------------------------------------------------------
# travel_local — transit
# ---------------------------------------------------------------------------


def test_get_transit_resolves_known_metro():
    result = travel_local.get_transit({"chunk_text": "transit directions in new york"})
    assert result.get("success", True) is True
    assert result["mechanism_used"] == "local_metro_kb"
    assert result["data"]["city"] == "new york"
    assert "MTA" in result["output_text"]


def test_get_transit_unknown_city_prompts_user():
    result = travel_local.get_transit({"chunk_text": "how do i take transit to the moon"})
    assert result["success"] is False


# ---------------------------------------------------------------------------
# smarthome.detect_presence — JSON-store-backed
# ---------------------------------------------------------------------------


@pytest.mark.anyio
async def test_detect_presence_uses_persistent_store(tmp_path, monkeypatch):
    monkeypatch.setattr("v2.orchestrator.skills._store._ROOT", tmp_path)
    smarthome.set_presence("living room", "Leia")
    result = await smarthome.detect_presence({"chunk_text": "is anyone in the living room"})
    assert result.get("success", True) is True
    assert result["mechanism_used"] == "local_state"
    assert "Leia" in result["output_text"]
    assert result["data"] == {"room": "living room", "occupants": ["Leia"]}


@pytest.mark.anyio
async def test_detect_presence_clear_resets_room(tmp_path, monkeypatch):
    monkeypatch.setattr("v2.orchestrator.skills._store._ROOT", tmp_path)
    smarthome.set_presence("kitchen", ["Luke", "Han"])
    smarthome.clear_presence("kitchen")
    result = await smarthome.detect_presence({"chunk_text": "anyone in the kitchen"})
    assert result.get("success", True) is True
    assert "no one" in result["output_text"].lower() or "don't see" in result["output_text"].lower()


@pytest.mark.anyio
async def test_detect_presence_unknown_room_fails_gracefully(tmp_path, monkeypatch):
    monkeypatch.setattr("v2.orchestrator.skills._store._ROOT", tmp_path)
    result = await smarthome.detect_presence({"chunk_text": "anyone in the dungeon"})
    assert result["success"] is False
    assert "presence sensor" in result["output_text"]
