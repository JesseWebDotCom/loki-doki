"""DuckDuckGo-backed web search helpers for live-information routes."""

from __future__ import annotations

from dataclasses import dataclass
import json
import logging
import re
import typing
from typing import Any, Optional, Union
import urllib.error
import urllib.request


LOGGER = logging.getLogger(__name__)
SEARCH_EMPTY = "SEARCH_EMPTY"
SEARCH_ERROR = "SEARCH_ERROR"
WEATHER_HOST = "https://wttr.in"
WEATHER_REQUEST_TIMEOUT_SECONDS = 10
WEATHER_REQUEST_ATTEMPTS = 2


@dataclass(frozen=True)
class WebSearchResult:
    """Resolved web search context for one query."""

    query: str
    context: str
    source: str
    metadata: Optional[dict[str, str]] = None


def search_web(query: str) -> WebSearchResult:
    """Return live web context for a query using DDGS with graceful fallback."""
    query_lower = query.lower()
    weather = _weather_result(query_lower)
    if weather is not None:
        return weather
    
    ddgs = _load_ddgs()
    if ddgs is None:
        return WebSearchResult(
            query=query,
            context=SEARCH_ERROR,
            source="ddgs_unavailable",
        )
    try:
        with ddgs(timeout=10) as client:
            region = _search_region(query_lower)
            search_queries, metadata = _search_queries(query)
            results: list[dict[str, str]] = []
            used_query = query
            for candidate in search_queries:
                candidate_lower = candidate.lower()
                results = _news_results(client, candidate, candidate_lower, region)
                if not results:
                    results = _text_results(client, candidate, region)
                if results:
                    used_query = candidate
                    break
    except Exception as exc:  # pragma: no cover - library/runtime edge cases
        LOGGER.warning("DuckDuckGo search failed for %r: %s", query, exc)
        return WebSearchResult(query=query, context=SEARCH_ERROR, source="duckduckgo")
    if not results:
        return WebSearchResult(query=query, context=SEARCH_EMPTY, source="duckduckgo")
    return WebSearchResult(
        query=used_query,
        context=_format_results(used_query, results),
        source="duckduckgo",
        metadata=metadata,
    )


def _weather_result(query_lower: str) -> Optional[WebSearchResult]:
    """Return a wttr.in response for weather prompts when available."""
    if "weather" not in query_lower and "forecast" not in query_lower and "temperature" not in query_lower:
        return None
    location = _weather_location(query_lower)
    url = f"{WEATHER_HOST}/{location}?format=j1"
    payload = _weather_payload(url, location)
    if not payload:
        return None
    try:
        weather_data = json.loads(payload)
    except json.JSONDecodeError as exc:
        LOGGER.warning("wttr.in returned invalid JSON for %r: %s", location, exc)
        return None
    return _format_weather_result(location, weather_data)


def _weather_payload(url: str, location: str) -> str:
    """Return one wttr.in payload, retrying once for transient upstream failures."""
    last_error: Optional[Exception] = None
    for attempt in range(1, WEATHER_REQUEST_ATTEMPTS + 1):
        try:
            with urllib.request.urlopen(url, timeout=WEATHER_REQUEST_TIMEOUT_SECONDS) as response:
                return response.read().decode("utf-8", errors="ignore").strip()
        except (urllib.error.URLError, TimeoutError) as exc:
            last_error = exc
            if attempt >= WEATHER_REQUEST_ATTEMPTS:
                break
    if last_error is not None:
        LOGGER.warning("wttr.in weather lookup failed for %r after %s attempts: %s", location, WEATHER_REQUEST_ATTEMPTS, last_error)
    return ""


def _search_queries(query: str) -> tuple[list[str], Optional[dict[str, str]]]:
    """Return progressively stronger search query variants."""
    age_variants = _person_age_queries(query)
    if age_variants:
        return age_variants["queries"], age_variants["metadata"]
    office_holder_variants = _office_holder_queries(query)
    if office_holder_variants:
        return office_holder_variants["queries"], office_holder_variants["metadata"]
    return [query], None


def _load_ddgs():
    """Import the DDGS client with compatibility for older package names."""
    try:
        from ddgs import DDGS
        return DDGS
    except ImportError:
        try:
            from duckduckgo_search import DDGS
            return DDGS
        except ImportError:
            LOGGER.warning("Neither ddgs nor duckduckgo_search is installed.")
            return None


def _search_region(query_lower: str) -> str:
    """Return the search region tuned to the query text."""
    if "ontario" in query_lower or "canada" in query_lower:
        return "ca-en"
    return "us-en"


def _format_results(query: str, results: list[dict[str, str]]) -> str:
    """Format top search results into compact LLM context with URLs for citation."""
    parts: list[str] = []
    for index, result in enumerate(results[:5], start=1):
        title = str(result.get("title", "No Title")).strip()
        url = str(result.get("href", result.get("link", "No URL"))).strip()
        snippet = str(result.get("body", result.get("snippet", "No Body"))).strip()
        parts.append(f"Source [{index}]: {title}\nURL: {url}\nSnippet: {snippet[:800]}")
    return f"WEB SEARCH RESULTS FOR '{query.upper()}':\n" + "\n---\n".join(parts)


def _news_results(client, query: str, query_lower: str, region: str) -> list[dict[str, str]]:
    """Return news results unless the query is weather-specific."""
    if "weather" in query_lower or "forecast" in query_lower or "temperature" in query_lower:
        return []
    try:
        return list(client.news(query, region=region, max_results=5))
    except Exception as exc:  # pragma: no cover - library/runtime edge cases
        LOGGER.warning("DuckDuckGo news search failed for %r: %s", query, exc)
        return []


def _text_results(client, query: str, region: str) -> list[dict[str, str]]:
    """Return text search results."""
    try:
        return list(client.text(query, region=region, max_results=5))
    except Exception as exc:  # pragma: no cover - library/runtime edge cases
        LOGGER.warning("DuckDuckGo text search failed for %r: %s", query, exc)
        return []


def _person_age_queries(query: str) -> Optional[dict[str, object]]:
    """Return better search variants for age-related person lookups."""
    normalized = " ".join(query.strip().split())
    match = re.match(r"(?i)^how old is (?P<name>.+?)(?:\?|$)", normalized)
    if not match:
        return None
    name = match.group("name").strip(" .?!")
    if len(name) < 3:
        return None
    return {
        "queries": [
            f"\"{name}\" age",
            f"\"{name}\" born",
            f"\"{name}\" date of birth",
            f"{name} biography age",
            normalized,
        ],
        "metadata": {
            "kind": "person_age",
            "name": name,
        },
    }


def _office_holder_queries(query: str) -> Optional[dict[str, object]]:
    """Return better search variants for current office-holder lookups."""
    normalized = " ".join(query.strip().lower().split())
    if normalized in {
        "who is president",
        "who is the president",
        "who is current president",
        "who is the current president",
    }:
        return {
            "queries": [
                "current president of the united states",
                "president of the united states",
                "white house president",
                normalized,
            ],
            "metadata": {
                "kind": "office_holder",
                "office": "President of the United States",
            },
        }
    return None


def _weather_location(query_lower: str) -> str:
    """Infer a simple location segment for wttr.in."""
    if " in " not in query_lower:
        return "local"
    location = query_lower.split(" in ", 1)[1].split(",")[0].strip()
    return location.replace(" ", "+") or "local"


def _format_weather_result(location: str, payload: dict[str, object]) -> Optional[WebSearchResult]:
    """Convert wttr.in JSON into compact weather context and structured fields."""
    current_conditions = payload.get("current_condition")
    weather_days = payload.get("weather")
    if not isinstance(current_conditions, list) or not current_conditions:
        return None
    if not isinstance(weather_days, list) or not weather_days:
        return None
    current = current_conditions[0]
    today = weather_days[0]
    if not isinstance(current, dict) or not isinstance(today, dict):
        return None
    description = _weather_description(current)
    metadata = {
        "location": location.replace("+", " "),
        "current_temp_f": _string_value(current.get("temp_F")),
        "feels_like_f": _string_value(current.get("FeelsLikeF")),
        "high_temp_f": _string_value(today.get("maxtempF")),
        "low_temp_f": _string_value(today.get("mintempF")),
        "chance_of_rain": _representative_precip(today, "chanceofrain"),
        "peak_chance_of_rain": _chance_of_rain(today),
        "chance_of_snow": _chance_of_precip(today, "chanceofsnow"),
        "chance_of_sleet": _chance_of_precip(today, "chanceofsleet"),
        "wind_mph": _string_value(current.get("windspeedMiles")),
        "wind_direction": _string_value(current.get("winddir16Point")),
        "description": description,
    }
    context = (
        f"LIVE WEATHER DATA for {metadata['location']}:\n"
        f"Conditions: {description}\n"
        f"Current temp: {metadata['current_temp_f']} F\n"
        f"Feels like: {metadata['feels_like_f']} F\n"
        f"High: {metadata['high_temp_f']} F\n"
        f"Low: {metadata['low_temp_f']} F\n"
        f"Chance of rain: {metadata['chance_of_rain']}%\n"
        f"Peak rain chance: {metadata['peak_chance_of_rain']}%\n"
        f"Wind: {metadata['wind_mph']} mph {metadata['wind_direction']}"
    )
    return WebSearchResult(
        query=f"weather in {metadata['location']}",
        context=context,
        source="wttr.in",
        metadata=metadata,
    )


def _weather_description(current: dict[str, object]) -> str:
    """Return the current weather description from wttr.in payloads."""
    descriptions = current.get("weatherDesc")
    if not isinstance(descriptions, list) or not descriptions:
        return "Unknown conditions"
    first = descriptions[0]
    if not isinstance(first, dict):
        return "Unknown conditions"
    return _string_value(first.get("value")) or "Unknown conditions"


def _chance_of_rain(day: dict[str, object]) -> str:
    """Return the highest hourly chance of rain for the day."""
    return _chance_of_precip(day, "chanceofrain")


def _representative_precip(day: dict[str, object], field: str) -> str:
    """Return a less misleading daily precipitation figure than the peak hourly value."""
    hourly = day.get("hourly")
    if not isinstance(hourly, list) or not hourly:
        return "0"
    chances: list[int] = []
    for item in hourly:
        if not isinstance(item, dict):
            continue
        raw_value = _string_value(item.get(field))
        if raw_value.isdigit():
            chances.append(int(raw_value))
    if not chances:
        return "0"
    return str(round(sum(chances) / len(chances)))


def _chance_of_precip(day: dict[str, object], field: str) -> str:
    """Return the highest hourly chance for one wttr.in precipitation field."""
    hourly = day.get("hourly")
    if not isinstance(hourly, list) or not hourly:
        return "0"
    chances: list[int] = []
    for item in hourly:
        if not isinstance(item, dict):
            continue
        raw_value = _string_value(item.get(field))
        if raw_value.isdigit():
            chances.append(int(raw_value))
    if not chances:
        return "0"
    return str(max(chances))


def _string_value(value: object) -> str:
    """Return a compact string for scalar payload values."""
    if value is None:
        return ""
    return str(value).strip()
