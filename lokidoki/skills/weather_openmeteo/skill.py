"""Open-Meteo weather skill — no API key required.

Two-step lookup: free geocoding endpoint resolves the location string
to lat/lon, then the forecast endpoint returns current conditions.
Both are public and rate-limited only by reasonable use.
"""
import logging

import httpx

from lokidoki.core.skill_executor import BaseSkill, MechanismResult

logger = logging.getLogger(__name__)

GEO_URL = "https://geocoding-api.open-meteo.com/v1/search"
FORECAST_URL = "https://api.open-meteo.com/v1/forecast"
# Open-Meteo's geocoder doesn't accept US zip codes — Zippopotam.us
# is a free, key-less postal-lookup service that returns lat/lon for
# US zips (and dozens of other countries) so we can hit the forecast
# endpoint without going through name resolution.
ZIPPOPOTAM_URL = "https://api.zippopotam.us/us/{zip}"


class OpenMeteoSkill(BaseSkill):
    def __init__(self) -> None:
        self._cache: dict[str, dict] = {}

    async def execute_mechanism(self, method: str, parameters: dict) -> MechanismResult:
        if method == "open_meteo":
            return await self._open_meteo(parameters)
        if method == "local_cache":
            return self._local_cache(parameters)
        raise ValueError(f"Unknown mechanism: {method}")

    async def _open_meteo(self, parameters: dict) -> MechanismResult:
        # Orchestrator already merges (decomposer params → user/global
        # config → distilled_query backstop) into ``parameters["location"]``
        # before we get here, so a single read is enough.
        raw_location = parameters.get("location")
        if not raw_location:
            return MechanismResult(success=False, error="Location parameter required")

        # The decomposer sometimes hands us a full sentence like
        # "the weather in seattle tomorrow" instead of just "seattle".
        # Open-Meteo's geocoder is permissive but still misses on
        # noisy strings, so we try the raw input first and then a
        # progressively stripped version. This is text-shape repair
        # of upstream output, not user-intent classification — fine
        # under CLAUDE.md.
        candidates = _location_candidates(raw_location)
        logger.info(
            "[weather_openmeteo] location=%r candidates=%r",
            raw_location, candidates,
        )

        try:
            async with httpx.AsyncClient(timeout=4.0) as client:
                hit = None
                tried: list[str] = []

                # US zip code path: Open-Meteo's name search ignores
                # zips, so 5-digit numeric inputs go straight to the
                # postal lookup. We don't try the name endpoint at
                # all in that case — it always returns 0 matches and
                # just wastes a round-trip.
                zip_match = _us_zip(raw_location)
                if zip_match:
                    z = await client.get(ZIPPOPOTAM_URL.format(zip=zip_match))
                    if z.status_code == 200:
                        body = z.json() or {}
                        places = body.get("places") or []
                        if places:
                            p = places[0]
                            hit = {
                                "name": p.get("place name", zip_match),
                                "country_code": body.get("country abbreviation", "US"),
                                "latitude": float(p.get("latitude")),
                                "longitude": float(p.get("longitude")),
                            }
                    if not hit:
                        tried.append(f"zip:{zip_match}")

                if not hit:
                    for cand in candidates:
                        geo = await client.get(
                            GEO_URL,
                            params={"name": cand, "count": 1, "format": "json"},
                        )
                        if geo.status_code != 200:
                            tried.append(f"{cand}({geo.status_code})")
                            continue
                        hits = (geo.json() or {}).get("results") or []
                        if hits:
                            hit = hits[0]
                            break
                        tried.append(cand)
                if not hit:
                    logger.warning(
                        "[weather_openmeteo] no geocode match. tried=%r", tried,
                    )
                    return MechanismResult(
                        success=False,
                        error=f"no geocode match for {raw_location!r}",
                    )
                lat, lon = hit["latitude"], hit["longitude"]
                pretty = hit.get("name", raw_location)
                country = hit.get("country_code") or hit.get("country") or ""

                fc = await client.get(
                    FORECAST_URL,
                    params={
                        "latitude": lat,
                        "longitude": lon,
                        "current": "temperature_2m,apparent_temperature,"
                                   "relative_humidity_2m,wind_speed_10m,weather_code",
                        "temperature_unit": "celsius",
                        "wind_speed_unit": "kmh",
                    },
                )
                if fc.status_code != 200:
                    return MechanismResult(
                        success=False, error=f"forecast {fc.status_code}"
                    )
                cur = (fc.json() or {}).get("current") or {}

            display = pretty + (f", {country}" if country else "")
            condition = _wmo_code(cur.get("weather_code"))
            temp = cur.get("temperature_2m")
            data = {
                "location": display,
                "temperature": temp,
                "feels_like": cur.get("apparent_temperature"),
                "humidity": cur.get("relative_humidity_2m"),
                "wind_speed": cur.get("wind_speed_10m"),
                "condition": condition,
                # Pre-formatted one-liner for the orchestrator's
                # verbatim fast-path. The decomposer marks weather
                # questions as response_shape="verbatim", which means
                # "use the skill's lead field directly and skip the
                # 9B model." Without this field, normal synthesis
                # runs on a compressed JSON blob and small models
                # tend to emit zero tokens.
                "lead": _format_lead(display, temp, condition),
            }
            self._cache[raw_location.lower()] = data
            return MechanismResult(
                success=True,
                data=data,
                source_url=f"https://open-meteo.com/?lat={lat}&lon={lon}",
                source_title=f"Open-Meteo — {data['location']}",
            )
        except Exception as e:
            return MechanismResult(success=False, error=str(e))

    def _local_cache(self, parameters: dict) -> MechanismResult:
        loc = (parameters.get("location") or "").lower()
        cached = self._cache.get(loc)
        if cached:
            return MechanismResult(success=True, data=cached)
        return MechanismResult(success=False, error="Cache miss")


# Subset of WMO weather interpretation codes — covers the common
# conditions any user would actually ask about. Unknowns return the
# raw code so the synthesis layer doesn't claim "clear sky" for
# something it doesn't recognize.
_WMO = {
    0: "clear sky",
    1: "mostly clear",
    2: "partly cloudy",
    3: "overcast",
    45: "fog",
    48: "freezing fog",
    51: "light drizzle",
    53: "drizzle",
    55: "heavy drizzle",
    61: "light rain",
    63: "rain",
    65: "heavy rain",
    71: "light snow",
    73: "snow",
    75: "heavy snow",
    80: "rain showers",
    81: "heavy rain showers",
    82: "violent rain showers",
    95: "thunderstorm",
    96: "thunderstorm with hail",
    99: "severe thunderstorm with hail",
}


def _format_lead(location: str, temp_c, condition: str) -> str:
    """Compose a one-line answer like the verbatim fast-path expects.

    Includes both Celsius and Fahrenheit so the answer is useful
    regardless of the user's locale, and mentions rain explicitly
    when the WMO code implies precipitation — that's the most common
    weather question and answering it directly avoids a follow-up.
    """
    if temp_c is None:
        return f"Currently {condition or 'unknown conditions'} in {location}."
    try:
        f = round(float(temp_c) * 9 / 5 + 32)
    except (TypeError, ValueError):
        f = None
    temp_str = f"{temp_c}°C" + (f" ({f}°F)" if f is not None else "")
    cond = (condition or "").lower()
    is_wet = any(w in cond for w in ("rain", "drizzle", "shower", "thunder"))
    is_snow = "snow" in cond
    if is_wet:
        tail = " — yes, expect rain."
    elif is_snow:
        tail = " — expect snow."
    elif cond:
        tail = f" — no rain right now ({cond})."
    else:
        tail = ""
    return f"It's {temp_str} in {location}{tail}"


def _us_zip(raw: str) -> str:
    """Return a normalized 5-digit US zip if ``raw`` is one, else ''.

    Accepts ``98101``, ``98101-1234``, and tolerates leading/trailing
    whitespace. Anything else returns the empty string. We deliberately
    don't probe other-country postal formats here — Zippopotam.us
    supports them but the heuristics get fuzzy fast.
    """
    import re

    s = (raw or "").strip()
    m = re.fullmatch(r"(\d{5})(?:-\d{4})?", s)
    return m.group(1) if m else ""


def _location_candidates(raw: str) -> list[str]:
    """Generate progressively-stripped versions of a location string.

    Decomposer output is not always a clean place name. We try the
    raw text first (which works fine when it IS clean), then a
    handful of cheap reductions: drop a leading "in/at/for", strip
    trailing time words like "tomorrow"/"today"/"now"/"this week",
    and finally fall back to the trailing run of capitalized words
    on the assumption that's the place name. Duplicates removed,
    order preserved.
    """
    import re

    raw = (raw or "").strip()
    if not raw:
        return []
    out: list[str] = [raw]

    lowered = raw.lower()
    # 1) Strip a leading preposition.
    for prep in ("in ", "at ", "for ", "near "):
        if lowered.startswith(prep):
            out.append(raw[len(prep):].strip())
            break

    # 2) Strip trailing time words.
    cleaned = re.sub(
        r"\b(today|tomorrow|tonight|now|this (?:week|weekend|morning|afternoon|evening))\b",
        "",
        lowered,
    ).strip(" ,.?!")
    if cleaned and cleaned != lowered:
        out.append(cleaned)

    # 3) Trailing run of capitalized words from the original (Title-Cased).
    caps = re.findall(r"\b[A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)*\b", raw)
    if caps:
        out.append(caps[-1])

    # Dedup preserving order.
    seen: set[str] = set()
    result: list[str] = []
    for c in out:
        c = c.strip()
        if c and c.lower() not in seen:
            seen.add(c.lower())
            result.append(c)
    return result


def _wmo_code(code) -> str:
    if code is None:
        return ""
    return _WMO.get(int(code), f"weather code {code}")
