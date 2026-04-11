"""v2 weather adapter — wraps lokidoki.skills.weather_openmeteo.

The v1 OpenMeteoSkill exposes two mechanisms:

  - ``open_meteo`` — geocode + forecast over the live network
  - ``local_cache`` — instance-level cache from prior successful calls

Adapter walks them in that order and produces a single short
``output_text`` line for the v2 combiner. The v1 skill already pre-formats
a ``lead`` field — we use it verbatim when present.
"""
from __future__ import annotations

from typing import Any

from lokidoki.skills.weather_openmeteo.skill import OpenMeteoSkill

from v2.orchestrator.skills._runner import AdapterResult, run_mechanisms

# Process-singleton — the v1 skill caches successful lookups in
# ``self._cache`` and we want that cache to survive across requests.
_SKILL = OpenMeteoSkill()


_DEFAULT_LOCATION = "your area"


def _extract_location(payload: dict[str, Any]) -> str:
    """Pull a location string out of the v2 payload.

    The v2 routing layer doesn't yet do typed parameter extraction, so
    the location lives inside ``chunk_text``. We try a couple of common
    surface forms — only when one of them matches do we return a
    location. Otherwise we fall back to ``_DEFAULT_LOCATION`` rather
    than handing the whole chunk to the v1 geocoder, which would mangle
    "is it going to rain" into a literal place lookup.
    """
    explicit = (payload.get("params") or {}).get("location")
    if explicit:
        return str(explicit)
    chunk_text = str(payload.get("chunk_text") or "").strip(" ?.!")
    if not chunk_text:
        return _DEFAULT_LOCATION
    lower = chunk_text.lower()
    for marker in (" in ", " for ", " at "):
        if marker in lower:
            tail = chunk_text[lower.index(marker) + len(marker):].strip()
            if tail:
                return tail
    return _DEFAULT_LOCATION


def _format_success(result, method: str) -> str:
    data = result.data or {}
    lead = str(data.get("lead") or "").strip()
    if lead:
        return lead
    location = data.get("location") or "your area"
    temp = data.get("temperature")
    condition = data.get("condition") or "unknown conditions"
    if temp is not None:
        try:
            f = round(float(temp) * 9 / 5 + 32)
            temp_str = f"{temp}°C ({f}°F)"
        except (TypeError, ValueError):
            temp_str = f"{temp}°"
        return f"It's {temp_str} and {condition} in {location}."
    return f"Currently {condition} in {location}."


async def handle(payload: dict[str, Any]) -> dict[str, Any]:
    """v2 handler entry point."""
    location = _extract_location(payload)
    if not location:
        location = _DEFAULT_LOCATION
    attempts = [
        ("open_meteo", {"location": location}),
        ("local_cache", {"location": location}),
    ]
    result = await run_mechanisms(
        _SKILL,
        attempts,
        on_success=_format_success,
        on_all_failed=(
            f"I couldn't reach the weather service for {location} right now. "
            "Try again in a moment."
        ),
    )
    return result.to_payload()
