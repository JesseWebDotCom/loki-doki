"""Generic live web-search-backed adapters built on DuckDuckGo."""
from __future__ import annotations

from typing import Any

from lokidoki.skills.search.skill import DuckDuckGoSkill

from lokidoki.orchestrator.skills._runner import AdapterResult, run_mechanisms

_SKILL = DuckDuckGoSkill()


def _best_text(data: dict[str, Any]) -> str:
    abstract = str(data.get("abstract") or "").strip()
    results = data.get("results") or []
    if abstract:
        return abstract
    if results:
        return " ".join(str(item).strip() for item in results[:3] if str(item).strip())
    return ""


async def _search(query: str, *, fallback_message: str) -> dict[str, Any]:
    result = await run_mechanisms(
        _SKILL,
        [
            ("ddg_api", {"query": query}),
            ("ddg_scraper", {"query": query}),
        ],
        on_success=lambda mechanism_result, method: _best_text(mechanism_result.data or {}) or fallback_message,
        on_all_failed=fallback_message,
    )
    return result.to_payload()


async def find_products(payload: dict[str, Any]) -> dict[str, Any]:
    query = str((payload.get("params") or {}).get("category") or payload.get("chunk_text") or "").strip()
    return await _search(f"best {query}", fallback_message="I couldn't find product recommendations right now.")


async def get_streaming(payload: dict[str, Any]) -> dict[str, Any]:
    query = str((payload.get("params") or {}).get("title") or payload.get("chunk_text") or "").strip()
    return await _search(f"where to stream {query}", fallback_message="I couldn't find streaming availability right now.")


async def search_flights(payload: dict[str, Any]) -> dict[str, Any]:
    query = str(payload.get("chunk_text") or "").strip()
    return await _search(f"flights {query}", fallback_message="I couldn't find flight search results right now.")


async def get_flight_status(payload: dict[str, Any]) -> dict[str, Any]:
    query = str((payload.get("params") or {}).get("flight_number") or payload.get("chunk_text") or "").strip()
    return await _search(f"{query} flight status", fallback_message="I couldn't find that flight status right now.")


async def search_hotels(payload: dict[str, Any]) -> dict[str, Any]:
    query = str(payload.get("chunk_text") or "").strip()
    return await _search(f"hotels {query}", fallback_message="I couldn't find hotel search results right now.")


async def get_visa_info(payload: dict[str, Any]) -> dict[str, Any]:
    query = str(payload.get("chunk_text") or "").strip()
    return await _search(f"visa requirements {query}", fallback_message="I couldn't find visa information right now.")


async def look_up_symptom(payload: dict[str, Any]) -> dict[str, Any]:
    query = str((payload.get("params") or {}).get("symptom") or payload.get("chunk_text") or "").strip()
    return await _search(f"site:medlineplus.gov {query}", fallback_message="I couldn't look up that symptom right now.")


async def check_medication(payload: dict[str, Any]) -> dict[str, Any]:
    query = str(payload.get("chunk_text") or "").strip()
    return await _search(f"site:dailymed.nlm.nih.gov {query}", fallback_message="I couldn't look up that medication right now.")


async def lookup_fact(payload: dict[str, Any]) -> dict[str, Any]:
    query = str(payload.get("chunk_text") or "").strip()
    return await _search(query, fallback_message="I couldn't find that person fact right now.")


async def search_web(payload: dict[str, Any]) -> dict[str, Any]:
    """First-class web search capability — exposes DDG as a user-facing skill."""
    query = str((payload.get("params") or {}).get("query") or payload.get("chunk_text") or "").strip()
    if not query:
        return AdapterResult(
            output_text="What would you like me to search for?",
            success=False,
            error="missing query",
        ).to_payload()
    return await _search(query, fallback_message="I couldn't find web search results right now.")


async def get_transit(payload: dict[str, Any]) -> dict[str, Any]:
    query = str(payload.get("chunk_text") or "").strip()
    return await _search(f"transit directions {query}", fallback_message="I couldn't find transit directions right now.")
