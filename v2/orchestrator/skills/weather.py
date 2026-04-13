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
from v2.orchestrator.skills._config import get_skill_config

# Process-singleton — the v1 skill caches successful lookups in
# ``self._cache`` and we want that cache to survive across requests.
_SKILL = OpenMeteoSkill()


def _default_location() -> str:
    return get_skill_config("get_weather", "default_location", "your area")


def _extract_location(payload: dict[str, Any]) -> str:
    """Read the location from structured params (NER-derived in C05).

    Falls back to the configured default when the pipeline didn't
    extract a GPE/LOC entity for this chunk.
    """
    explicit = (payload.get("params") or {}).get("location")
    if explicit:
        return str(explicit)
    return _default_location()


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
        location = _default_location()
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
