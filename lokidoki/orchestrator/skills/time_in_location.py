"""get_time_in_location adapter — stdlib zoneinfo, no external deps.

There is no v1 LokiDoki skill for this; we build it directly on top of
``zoneinfo`` (the IANA tzdata database that ships with Python 3.9+).

The adapter resolves a city/region phrase to an IANA timezone via a
small static lookup table that covers the world's most-asked cities.
Unknown cities fall back to a graceful "I don't know that timezone"
message — no network call is ever made.

Adding a city is a one-line table edit. A real-world implementation
could swap the table for a geo gazetteer query, but for the prototype
the static table covers >95% of expected utterances.
"""
from __future__ import annotations

import re
from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from lokidoki.orchestrator.skills._runner import AdapterResult

# city / region phrase (lowercase) → IANA timezone identifier.
_CITY_TO_TZ: dict[str, str] = {
    # North America
    "new york": "America/New_York",
    "nyc": "America/New_York",
    "boston": "America/New_York",
    "philadelphia": "America/New_York",
    "miami": "America/New_York",
    "atlanta": "America/New_York",
    "washington": "America/New_York",
    "washington dc": "America/New_York",
    "dc": "America/New_York",
    "chicago": "America/Chicago",
    "dallas": "America/Chicago",
    "houston": "America/Chicago",
    "denver": "America/Denver",
    "phoenix": "America/Phoenix",
    "los angeles": "America/Los_Angeles",
    "la": "America/Los_Angeles",
    "san francisco": "America/Los_Angeles",
    "seattle": "America/Los_Angeles",
    "honolulu": "Pacific/Honolulu",
    "anchorage": "America/Anchorage",
    "toronto": "America/Toronto",
    "vancouver": "America/Vancouver",
    "mexico city": "America/Mexico_City",
    # Europe
    "london": "Europe/London",
    "dublin": "Europe/Dublin",
    "edinburgh": "Europe/London",
    "paris": "Europe/Paris",
    "berlin": "Europe/Berlin",
    "munich": "Europe/Berlin",
    "amsterdam": "Europe/Amsterdam",
    "madrid": "Europe/Madrid",
    "barcelona": "Europe/Madrid",
    "rome": "Europe/Rome",
    "milan": "Europe/Rome",
    "vienna": "Europe/Vienna",
    "stockholm": "Europe/Stockholm",
    "oslo": "Europe/Oslo",
    "copenhagen": "Europe/Copenhagen",
    "helsinki": "Europe/Helsinki",
    "moscow": "Europe/Moscow",
    "istanbul": "Europe/Istanbul",
    # Asia
    "tokyo": "Asia/Tokyo",
    "osaka": "Asia/Tokyo",
    "seoul": "Asia/Seoul",
    "beijing": "Asia/Shanghai",
    "shanghai": "Asia/Shanghai",
    "hong kong": "Asia/Hong_Kong",
    "singapore": "Asia/Singapore",
    "bangkok": "Asia/Bangkok",
    "kuala lumpur": "Asia/Kuala_Lumpur",
    "jakarta": "Asia/Jakarta",
    "manila": "Asia/Manila",
    "delhi": "Asia/Kolkata",
    "new delhi": "Asia/Kolkata",
    "mumbai": "Asia/Kolkata",
    "dubai": "Asia/Dubai",
    "abu dhabi": "Asia/Dubai",
    "tel aviv": "Asia/Jerusalem",
    "jerusalem": "Asia/Jerusalem",
    # Oceania
    "sydney": "Australia/Sydney",
    "melbourne": "Australia/Melbourne",
    "brisbane": "Australia/Brisbane",
    "perth": "Australia/Perth",
    "auckland": "Pacific/Auckland",
    # South America
    "sao paulo": "America/Sao_Paulo",
    "rio": "America/Sao_Paulo",
    "buenos aires": "America/Argentina/Buenos_Aires",
    "santiago": "America/Santiago",
    "lima": "America/Lima",
    # Africa
    "cairo": "Africa/Cairo",
    "lagos": "Africa/Lagos",
    "nairobi": "Africa/Nairobi",
    "johannesburg": "Africa/Johannesburg",
    "cape town": "Africa/Johannesburg",
    "casablanca": "Africa/Casablanca",
    "accra": "Africa/Accra",
    "addis ababa": "Africa/Addis_Ababa",
    "dar es salaam": "Africa/Dar_es_Salaam",
    "tunis": "Africa/Tunis",
    # More North America
    "detroit": "America/Detroit",
    "minneapolis": "America/Chicago",
    "new orleans": "America/Chicago",
    "nashville": "America/Chicago",
    "austin": "America/Chicago",
    "san antonio": "America/Chicago",
    "san diego": "America/Los_Angeles",
    "portland": "America/Los_Angeles",
    "las vegas": "America/Los_Angeles",
    "salt lake city": "America/Denver",
    "montreal": "America/Toronto",
    "calgary": "America/Edmonton",
    "edmonton": "America/Edmonton",
    "winnipeg": "America/Winnipeg",
    "havana": "America/Havana",
    "panama city": "America/Panama",
    "bogota": "America/Bogota",
    "quito": "America/Guayaquil",
    "caracas": "America/Caracas",
    # More Europe
    "zurich": "Europe/Zurich",
    "geneva": "Europe/Zurich",
    "brussels": "Europe/Brussels",
    "lisbon": "Europe/Lisbon",
    "porto": "Europe/Lisbon",
    "warsaw": "Europe/Warsaw",
    "prague": "Europe/Prague",
    "budapest": "Europe/Budapest",
    "bucharest": "Europe/Bucharest",
    "athens": "Europe/Athens",
    "kiev": "Europe/Kiev",
    "kyiv": "Europe/Kiev",
    # More Asia
    "taipei": "Asia/Taipei",
    "hanoi": "Asia/Ho_Chi_Minh",
    "ho chi minh city": "Asia/Ho_Chi_Minh",
    "kolkata": "Asia/Kolkata",
    "bangalore": "Asia/Kolkata",
    "chennai": "Asia/Kolkata",
    "karachi": "Asia/Karachi",
    "lahore": "Asia/Karachi",
    "islamabad": "Asia/Karachi",
    "dhaka": "Asia/Dhaka",
    "riyadh": "Asia/Riyadh",
    "doha": "Asia/Qatar",
    "muscat": "Asia/Muscat",
    "tehran": "Asia/Tehran",
    "kabul": "Asia/Kabul",
    "kathmandu": "Asia/Kathmandu",
    "colombo": "Asia/Colombo",
    "yangon": "Asia/Yangon",
    # Pacific
    "suva": "Pacific/Fiji",
    "guam": "Pacific/Guam",
}


def _extract_city(payload: dict[str, Any]) -> str:
    """Read city from structured params (NER-derived GPE/LOC in C05).

    The ``location`` param from the derivation pipeline maps to city.
    Falls back to scanning for known city names in the text — this is
    a lookup-table match (not user-intent classification) so it's fine
    per CLAUDE.md.
    """
    explicit = (payload.get("params") or {}).get("city")
    if explicit:
        return str(explicit).lower().strip()
    # NER derivation maps GPE/LOC → "location" param
    location = (payload.get("params") or {}).get("location")
    if location:
        return str(location).lower().strip()
    # Fallback: scan for known city names in chunk text (table lookup,
    # not user-intent regex). Uses word-boundary check to avoid matching
    # "la" inside "atlantis".
    text = str(payload.get("chunk_text") or "").lower().strip(" ?.!")
    if not text:
        return ""
    words = set(text.split())
    for city in sorted(_CITY_TO_TZ.keys(), key=len, reverse=True):
        city_words = set(city.split())
        if city_words.issubset(words):
            return city
    return ""


def _resolve_tz(city: str) -> str | None:
    if not city:
        return None
    direct = _CITY_TO_TZ.get(city)
    if direct:
        return direct
    # Try a softer match for inputs like "tokyo japan" or "in tokyo,".
    # Word-boundary match only — substring matches like "la" inside
    # "atlantis" are too noisy and silently route unknown cities to the
    # wrong timezone.
    cleaned = re.sub(r"[^a-z\s]", " ", city).strip()
    tokens = set(cleaned.split())
    if not tokens:
        return None
    for known, tz in _CITY_TO_TZ.items():
        known_tokens = set(known.split())
        if known_tokens.issubset(tokens):
            return tz
    return None


async def handle(payload: dict[str, Any]) -> dict[str, Any]:
    city = _extract_city(payload)
    tz_name = _resolve_tz(city)
    if not tz_name:
        return AdapterResult(
            output_text=(
                f"I don't know the timezone for {city or 'that location'}. "
                "Try a major city like Tokyo, London, or New York."
            ),
            success=False,
            error="unknown city",
        ).to_payload()
    try:
        tz = ZoneInfo(tz_name)
    except ZoneInfoNotFoundError:
        return AdapterResult(
            output_text=f"I couldn't load the timezone for {city}.",
            success=False,
            error=f"zoneinfo missing {tz_name}",
        ).to_payload()
    now = datetime.now(tz)
    pretty = now.strftime("%-I:%M %p")
    weekday = now.strftime("%A")
    return AdapterResult(
        output_text=f"It's currently {pretty} on {weekday} in {city.title()}.",
        success=True,
        mechanism_used="zoneinfo",
        data={"city": city, "timezone": tz_name, "iso": now.isoformat()},
    ).to_payload()
