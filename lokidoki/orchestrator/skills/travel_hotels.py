"""Offline-first hotel search adapter.

Curated hotel-chain KB by location and optional star rating.
Mechanism chain: ``local_chains`` → ``graceful_failure``.
"""
from __future__ import annotations

from typing import Any

from lokidoki.orchestrator.skills._runner import AdapterResult
from lokidoki.orchestrator.skills.travel_flights import _normalize


_HOTEL_KB: dict[str, list[tuple[str, int, str]]] = {
    "new york": [
        ("Pod 51 Hotel", 3, "best budget — Midtown East"),
        ("citizenM New York Times Square", 4, "best mid-range — Times Square"),
        ("The Plaza", 5, "iconic luxury — Central Park South"),
    ],
    "los angeles": [
        ("Freehand Los Angeles", 3, "best budget — Downtown"),
        ("The Hoxton Downtown LA", 4, "best mid-range — Downtown"),
        ("The Beverly Hills Hotel", 5, "iconic luxury — Beverly Hills"),
    ],
    "san francisco": [
        ("HI San Francisco Downtown", 2, "best hostel — SoMa"),
        ("Hotel Zeppelin", 4, "best mid-range — Union Square"),
        ("Fairmont San Francisco", 5, "luxury — Nob Hill"),
    ],
    "chicago": [
        ("Found Hotel Chicago River North", 3, "best budget — River North"),
        ("The Robey", 4, "best mid-range — Wicker Park"),
        ("The Langham Chicago", 5, "luxury — Riverfront"),
    ],
    "london": [
        ("Premier Inn London County Hall", 3, "best budget — South Bank"),
        ("The Hoxton Holborn", 4, "best mid-range — Central"),
        ("The Savoy", 5, "iconic luxury — Strand"),
    ],
    "paris": [
        ("Generator Paris", 2, "best hostel — 10th arrondissement"),
        ("Hotel des Grands Boulevards", 4, "best mid-range — 2nd"),
        ("Le Meurice", 5, "luxury — 1st arrondissement"),
    ],
    "tokyo": [
        ("UNPLAN Shinjuku", 3, "best budget — Shinjuku"),
        ("Hotel Gracery Shinjuku", 4, "best mid-range — Shinjuku"),
        ("The Peninsula Tokyo", 5, "luxury — Marunouchi"),
    ],
}


def _resolve_hotel_location(payload: dict[str, Any]) -> str | None:
    params = payload.get("params") or {}
    explicit = params.get("location")
    if explicit:
        candidate = _normalize(str(explicit))
        for city in _HOTEL_KB:
            if city in candidate:
                return city
    text = _normalize(payload.get("chunk_text") or "")
    for city in _HOTEL_KB:
        if city in text:
            return city
    return None


def search_hotels(payload: dict[str, Any]) -> dict[str, Any]:
    location = _resolve_hotel_location(payload)
    if not location:
        return AdapterResult(
            output_text="Which city should I look up hotels in?",
            success=False,
            mechanism_used="local_chains",
            error="missing location",
        ).to_payload()
    picks = _HOTEL_KB[location]
    body = "; ".join(f"{name} ({stars}\u2605) \u2014 {blurb}" for name, stars, blurb in picks)
    return AdapterResult(
        output_text=f"Hotel picks for {location.title()}: {body}.",
        success=True,
        mechanism_used="local_chains",
        data={
            "location": location,
            "picks": [
                {"name": name, "stars": stars, "blurb": blurb}
                for name, stars, blurb in picks
            ],
        },
    ).to_payload()
