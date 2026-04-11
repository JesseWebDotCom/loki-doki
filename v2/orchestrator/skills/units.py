"""v2 unit-conversion adapter — wraps lokidoki.skills.unit_conversion.

The v2 fast lane already handles common conversions inline. This
adapter covers the routed path (compound utterances) and pulls
deterministic offline conversions from the v1 lookup tables, which
support a wider unit catalog than the fast-lane matcher.
"""
from __future__ import annotations

import re
from typing import Any

from lokidoki.skills.unit_conversion.skill import UnitConversionSkill

from v2.orchestrator.skills._runner import AdapterResult, run_mechanisms

_SKILL = UnitConversionSkill()

_CONVERT_RE = re.compile(
    r"(?:convert\s+)?(?P<value>-?\d+(?:\.\d+)?)\s*"
    r"(?P<from>[a-zA-Z°]+)\s+(?:to|in|into)\s+"
    r"(?P<to>[a-zA-Z°]+)"
)


def _parse_request(payload: dict[str, Any]) -> tuple[float, str, str] | None:
    explicit = payload.get("params") or {}
    if explicit.get("value") and explicit.get("from_unit") and explicit.get("to_unit"):
        try:
            return (
                float(explicit["value"]),
                str(explicit["from_unit"]),
                str(explicit["to_unit"]),
            )
        except (TypeError, ValueError):
            return None
    chunk_text = str(payload.get("chunk_text") or "").lower()
    match = _CONVERT_RE.search(chunk_text)
    if match:
        try:
            return (
                float(match.group("value")),
                match.group("from"),
                match.group("to"),
            )
        except ValueError:
            return None
    return None


def _format_success(result, method: str) -> str:
    data = result.data or {}
    value = data.get("result")
    to_unit = data.get("to_unit") or ""
    if isinstance(value, float) and value.is_integer():
        value = int(value)
    return f"{value} {to_unit}".strip()


async def handle(payload: dict[str, Any]) -> dict[str, Any]:
    parsed = _parse_request(payload)
    if parsed is None:
        return AdapterResult(
            output_text="I couldn't parse that conversion.",
            success=False,
            error="missing value/from/to",
        ).to_payload()
    value, from_unit, to_unit = parsed
    attempts = [
        (
            "table_lookup",
            {"value": value, "from_unit": from_unit, "to_unit": to_unit},
        )
    ]
    result = await run_mechanisms(
        _SKILL,
        attempts,
        on_success=_format_success,
        on_all_failed="I couldn't convert those units.",
    )
    return result.to_payload()
