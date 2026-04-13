"""Offline-first transit information adapter.

System + line lookup for the largest metros.
Mechanism chain: ``local_metro_kb`` → ``graceful_failure``.
"""
from __future__ import annotations

from typing import Any

from lokidoki.orchestrator.skills._runner import AdapterResult
from lokidoki.orchestrator.skills.travel_flights import _normalize


_TRANSIT_KB: dict[str, dict[str, Any]] = {
    "new york": {
        "system": "MTA Subway and Bus",
        "lines": ["1/2/3", "4/5/6", "7", "A/C/E", "B/D/F/M", "L", "N/Q/R/W"],
        "fare_usd": 2.90,
    },
    "los angeles": {
        "system": "LA Metro Rail and Bus",
        "lines": ["A (Blue)", "B (Red)", "C (Green)", "D (Purple)", "E (Expo)", "K (Crenshaw)"],
        "fare_usd": 1.75,
    },
    "san francisco": {
        "system": "BART, Muni Metro, and SF Muni",
        "lines": ["BART (Yellow/Blue/Green/Orange/Red)", "Muni K/L/M/N/T", "F-Market"],
        "fare_usd": 3.00,
    },
    "chicago": {
        "system": "CTA L Train and Bus",
        "lines": ["Red", "Blue", "Brown", "Green", "Orange", "Pink", "Purple", "Yellow"],
        "fare_usd": 2.50,
    },
    "boston": {
        "system": "MBTA Subway, Bus, and Commuter Rail",
        "lines": ["Red", "Orange", "Blue", "Green (B/C/D/E)", "Silver"],
        "fare_usd": 2.40,
    },
    "washington": {
        "system": "WMATA Metro and Metrobus",
        "lines": ["Red", "Orange", "Blue", "Silver", "Green", "Yellow"],
        "fare_usd": 2.25,
    },
    "london": {
        "system": "Transport for London (Tube, DLR, Overground)",
        "lines": ["Bakerloo", "Central", "Circle", "District", "Elizabeth", "Hammersmith & City", "Jubilee", "Metropolitan", "Northern", "Piccadilly", "Victoria", "Waterloo & City"],
        "fare_usd": 3.10,
    },
    "paris": {
        "system": "RATP M\u00e9tro, RER, and Bus",
        "lines": ["M1\u2013M14", "RER A\u2013E"],
        "fare_usd": 2.30,
    },
    "tokyo": {
        "system": "Tokyo Metro and Toei Subway",
        "lines": ["Ginza", "Marunouchi", "Hibiya", "Tozai", "Chiyoda", "Yurakucho", "Hanzomon", "Namboku", "Fukutoshin"],
        "fare_usd": 1.30,
    },
}


def _resolve_transit_city(payload: dict[str, Any]) -> str | None:
    params = payload.get("params") or {}
    explicit = params.get("location") or params.get("city")
    text = _normalize(str(explicit) if explicit else payload.get("chunk_text") or "")
    for city in _TRANSIT_KB:
        if city in text:
            return city
    return None


def get_transit(payload: dict[str, Any]) -> dict[str, Any]:
    city = _resolve_transit_city(payload)
    if not city:
        return AdapterResult(
            output_text=(
                "Tell me which city you want transit info for "
                "(e.g. New York, LA, Chicago, London, Paris, Tokyo)."
            ),
            success=False,
            mechanism_used="local_metro_kb",
            error="missing city",
        ).to_payload()
    info = _TRANSIT_KB[city]
    line_preview = ", ".join(info["lines"][:6])
    if len(info["lines"]) > 6:
        line_preview += f", +{len(info['lines']) - 6} more"
    return AdapterResult(
        output_text=(
            f"{city.title()} runs the {info['system']}. "
            f"Lines: {line_preview}. Base fare \u2248 ${info['fare_usd']:.2f}."
        ),
        success=True,
        mechanism_used="local_metro_kb",
        data={"city": city, **info},
    ).to_payload()
