"""weather adapter — wraps lokidoki.skills.weather_openmeteo.

The OpenMeteoSkill exposes two mechanisms:

  - ``open_meteo`` — geocode + forecast over the live network
  - ``local_cache`` — instance-level cache from prior successful calls

Adapter walks them in that order and produces a single short
``output_text`` line for the combiner. The skill already pre-formats
a ``lead`` field — we use it verbatim when present.
"""
from __future__ import annotations

from typing import Any

from lokidoki.skills.weather_openmeteo.skill import OpenMeteoSkill

from lokidoki.orchestrator.skills._runner import AdapterResult, run_mechanisms
from lokidoki.orchestrator.skills._config import get_skill_config

# Process-singleton — the skill caches successful lookups in
# ``self._cache`` and we want that cache to survive across requests.
_SKILL = OpenMeteoSkill()


async def _extract_location(payload: dict[str, Any]) -> str:
    """Read the location from structured params (NER-derived in C05).

    Falls back to the configured default (DB or static) when the pipeline
    didn't extract a GPE/LOC entity for this chunk.
    """
    explicit = (payload.get("params") or {}).get("location")
    if explicit:
        return str(explicit)

    from lokidoki.orchestrator.skills._config import get_user_setting
    return await get_user_setting(
        payload,
        key="location",
        capability="get_weather",
        capability_key="default_location",
        default="your area",
    )


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
    """handler entry point."""
    location = await _extract_location(payload)
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
