"""v2 holiday adapters backed by Nager.Date public holidays."""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date
import re
from typing import Any

import httpx

from lokidoki.core.skill_executor import MechanismResult
from v2.orchestrator.skills._runner import AdapterResult, run_mechanisms

API = "https://date.nager.at/api/v3/PublicHolidays/{year}/{country}"

_COUNTRY_ALIASES = {
    "us": "US",
    "usa": "US",
    "united states": "US",
    "america": "US",
    "japan": "JP",
    "jp": "JP",
    "australia": "AU",
    "au": "AU",
    "canada": "CA",
    "ca": "CA",
    "uk": "GB",
    "united kingdom": "GB",
    "britain": "GB",
    "england": "GB",
}

_HOLIDAY_PREFIXES = (
    "what day is ",
    "when is ",
    "what date is ",
    "what day does ",
    "when does ",
)


@dataclass(slots=True)
class _NagerDateSkill:
    async def execute_mechanism(self, method: str, parameters: dict[str, Any]) -> MechanismResult:
        if method != "nager_public_holidays":
            raise ValueError(f"Unknown mechanism: {method}")
        country = str(parameters.get("country") or "US").upper()
        year = int(parameters.get("year") or date.today().year)
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                response = await client.get(
                    API.format(year=year, country=country),
                    headers={"User-Agent": "LokiDoki/0.2"},
                )
        except httpx.HTTPError as exc:
            return MechanismResult(success=False, error=f"network error: {exc}")
        if response.status_code != 200:
            return MechanismResult(success=False, error=f"http {response.status_code}")
        try:
            payload = response.json()
        except ValueError as exc:
            return MechanismResult(success=False, error=f"bad json: {exc}")
        holidays = [
            {
                "name": item.get("localName") or item.get("name") or "",
                "date": item.get("date") or "",
                "global": bool(item.get("global", True)),
            }
            for item in payload
            if isinstance(item, dict)
        ]
        return MechanismResult(
            success=True,
            data={"country": country, "year": year, "holidays": holidays},
            source_url=API.format(year=year, country=country),
            source_title=f"Nager.Date {country} holidays {year}",
        )


_SKILL = _NagerDateSkill()


def _extract_country(text: str, explicit: dict[str, Any]) -> str:
    value = explicit.get("country")
    if value:
        return _COUNTRY_ALIASES.get(str(value).lower().strip(), str(value).upper().strip())
    lower = text.lower()
    for alias, code in sorted(_COUNTRY_ALIASES.items(), key=lambda item: len(item[0]), reverse=True):
        if alias in lower:
            return code
    return "US"


def _extract_year(text: str, explicit: dict[str, Any]) -> int:
    if explicit.get("year"):
        try:
            return int(explicit["year"])
        except (TypeError, ValueError):
            pass
    lower = text.lower()
    today = date.today()
    if "next year" in lower:
        return today.year + 1
    match = re.search(r"\b(20\d{2})\b", lower)
    if match:
        return int(match.group(1))
    return today.year


def _normalize_holiday_name(raw: str) -> str:
    value = raw.lower().strip(" ?.!,'\"")
    for prefix in _HOLIDAY_PREFIXES:
        if value.startswith(prefix):
            value = value[len(prefix):].strip()
            break
    for suffix in (" this year", " next year", " in the us", " in usa", " in japan", " in australia"):
        if value.endswith(suffix):
            value = value[: -len(suffix)].strip()
    return value


def _match_holiday(holidays: list[dict[str, Any]], requested_name: str) -> dict[str, Any] | None:
    query = _normalize_holiday_name(requested_name)
    if not query:
        return None
    compact_query = re.sub(r"[^a-z0-9]+", "", query)
    for item in holidays:
        name = str(item.get("name") or "")
        compact_name = re.sub(r"[^a-z0-9]+", "", name.lower())
        if compact_query == compact_name or compact_query in compact_name or compact_name in compact_query:
            return item
    return None


async def _fetch(country: str, year: int) -> AdapterResult:
    return await run_mechanisms(
        _SKILL,
        [("nager_public_holidays", {"country": country, "year": year})],
        on_success=lambda result, method: "",
        on_all_failed="I couldn't look up holidays right now.",
    )


async def get_holiday(payload: dict[str, Any]) -> dict[str, Any]:
    explicit = payload.get("params") or {}
    text = str(payload.get("chunk_text") or "")
    country = _extract_country(text, explicit)
    year = _extract_year(text, explicit)
    holiday_name = str(explicit.get("name") or text)
    result = await _fetch(country, year)
    if not result.success:
        return result.to_payload()
    holidays = (result.data or {}).get("holidays") or []
    holiday = _match_holiday(holidays, holiday_name)
    if holiday is None:
        return AdapterResult(
            output_text=f"I couldn't find that holiday in {country} for {year}.",
            success=False,
            source_url=result.source_url,
            source_title=result.source_title,
            data=result.data,
            error="holiday not found",
        ).to_payload()
    return AdapterResult(
        output_text=f"{holiday['name']} is on {holiday['date']} in {country} for {year}.",
        success=True,
        mechanism_used="nager_public_holidays",
        source_url=result.source_url,
        source_title=result.source_title,
        data={"holiday": holiday, **(result.data or {})},
    ).to_payload()


async def list_holidays(payload: dict[str, Any]) -> dict[str, Any]:
    explicit = payload.get("params") or {}
    text = str(payload.get("chunk_text") or "")
    country = _extract_country(text, explicit)
    year = _extract_year(text, explicit)
    result = await _fetch(country, year)
    if not result.success:
        return result.to_payload()
    holidays = (result.data or {}).get("holidays") or []
    if not holidays:
        return AdapterResult(
            output_text=f"I couldn't find any holidays for {country} in {year}.",
            success=False,
            source_url=result.source_url,
            source_title=result.source_title,
            data=result.data,
            error="no holidays found",
        ).to_payload()
    preview = ", ".join(f"{item['name']} ({item['date']})" for item in holidays[:5])
    extra = len(holidays) - min(len(holidays), 5)
    suffix = f" Plus {extra} more." if extra > 0 else ""
    return AdapterResult(
        output_text=f"Holidays in {country} for {year}: {preview}.{suffix}",
        success=True,
        mechanism_used="nager_public_holidays",
        source_url=result.source_url,
        source_title=result.source_title,
        data=result.data,
    ).to_payload()


__all__ = [
    "get_holiday",
    "list_holidays",
    "_extract_country",
    "_extract_year",
    "_match_holiday",
]
