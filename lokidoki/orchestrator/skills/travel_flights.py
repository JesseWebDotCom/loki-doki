"""Offline-first flight search adapter.

Curated airline KB for origin/destination pairs. Mechanism chain:
``local_routes`` → ``graceful_failure``.
"""
from __future__ import annotations

import re
from typing import Any

from lokidoki.orchestrator.skills._runner import AdapterResult


_FLIGHT_ROUTES: dict[tuple[str, str], list[str]] = {
    ("JFK", "LAX"): ["JetBlue", "Delta", "American", "Alaska"],
    ("LAX", "JFK"): ["JetBlue", "Delta", "American", "Alaska"],
    ("JFK", "LHR"): ["British Airways", "Delta", "American", "JetBlue"],
    ("LHR", "JFK"): ["British Airways", "Delta", "American", "Virgin Atlantic"],
    ("SFO", "JFK"): ["JetBlue", "Delta", "American", "United"],
    ("JFK", "SFO"): ["JetBlue", "Delta", "American", "United"],
    ("ORD", "LAX"): ["United", "American", "Spirit"],
    ("LAX", "ORD"): ["United", "American", "Spirit"],
    ("ATL", "LAX"): ["Delta", "American", "Spirit"],
    ("LAX", "ATL"): ["Delta", "American", "Spirit"],
    ("SFO", "LHR"): ["British Airways", "United", "Virgin Atlantic"],
    ("LHR", "SFO"): ["British Airways", "United", "Virgin Atlantic"],
    ("LAX", "NRT"): ["ANA", "Japan Airlines", "United", "Delta"],
    ("NRT", "LAX"): ["ANA", "Japan Airlines", "United", "Delta"],
    ("JFK", "CDG"): ["Air France", "Delta", "American"],
    ("CDG", "JFK"): ["Air France", "Delta", "American"],
}

_CITY_TO_IATA: dict[str, str] = {
    "new york": "JFK", "nyc": "JFK", "jfk": "JFK", "newark": "EWR",
    "los angeles": "LAX", "la": "LAX", "lax": "LAX",
    "san francisco": "SFO", "sf": "SFO", "sfo": "SFO",
    "chicago": "ORD", "ord": "ORD",
    "atlanta": "ATL", "atl": "ATL",
    "london": "LHR", "lhr": "LHR",
    "paris": "CDG", "cdg": "CDG",
    "tokyo": "NRT", "nrt": "NRT", "haneda": "HND",
    "boston": "BOS", "bos": "BOS",
    "seattle": "SEA", "sea": "SEA",
    "miami": "MIA", "mia": "MIA",
    "dallas": "DFW", "dfw": "DFW",
    "denver": "DEN", "den": "DEN",
}

_AIRPORT_RE = re.compile(r"\b([A-Z]{3})\b")


def _normalize(text: str) -> str:
    return re.sub(r"\s+", " ", str(text or "").lower().strip(" ?.!,"))


def _resolve_airport(text: str) -> str | None:
    if not text:
        return None
    upper = text.upper().strip()
    if upper in _CITY_TO_IATA.values():
        return upper
    match = _AIRPORT_RE.search(upper)
    if match and match.group(1) in _CITY_TO_IATA.values():
        return match.group(1)
    lower = _normalize(text)
    if lower in _CITY_TO_IATA:
        return _CITY_TO_IATA[lower]
    for city, iata in _CITY_TO_IATA.items():
        if city in lower:
            return iata
    return None


def _parse_flight_query(payload: dict[str, Any]) -> tuple[str | None, str | None]:
    params = payload.get("params") or {}
    origin = params.get("origin")
    dest = params.get("dest") or params.get("destination")
    if origin and dest:
        return _resolve_airport(str(origin)), _resolve_airport(str(dest))
    text = _normalize(payload.get("chunk_text") or "")
    match = re.search(r"from\s+(.+?)\s+to\s+(.+?)(?:\s+on|\s+for|\s+next|\s+tomorrow|$)", text)
    if match:
        return _resolve_airport(match.group(1)), _resolve_airport(match.group(2))
    match = re.search(r"(\b[a-z ]+\b)\s+to\s+(\b[a-z ]+\b)", text)
    if match:
        return _resolve_airport(match.group(1)), _resolve_airport(match.group(2))
    return None, None


def search_flights(payload: dict[str, Any]) -> dict[str, Any]:
    origin, dest = _parse_flight_query(payload)
    if not origin or not dest:
        return AdapterResult(
            output_text="Tell me both an origin and a destination airport (e.g. 'flights from JFK to LAX').",
            success=False,
            mechanism_used="local_routes",
            error="missing route",
        ).to_payload()
    carriers = _FLIGHT_ROUTES.get((origin, dest))
    if not carriers:
        return AdapterResult(
            output_text=(
                f"I don't have curated non-stop carriers for {origin}\u2192{dest}. "
                "I'd suggest checking Google Flights or Kayak for live availability."
            ),
            success=False,
            mechanism_used="local_routes",
            error="unknown route",
            data={"origin": origin, "dest": dest},
        ).to_payload()
    head = ", ".join(carriers[:-1]) + (f", and {carriers[-1]}" if len(carriers) > 1 else carriers[0])
    return AdapterResult(
        output_text=f"Non-stop carriers between {origin} and {dest}: {head}.",
        success=True,
        mechanism_used="local_routes",
        data={"origin": origin, "dest": dest, "carriers": carriers},
    ).to_payload()
