import httpx

from lokidoki.core.skill_executor import BaseSkill, MechanismResult

OWM_BASE_URL = "https://api.openweathermap.org/data/2.5/weather"


class WeatherSkill(BaseSkill):
    """Fetches weather data from OpenWeatherMap with local cache fallback."""

    def __init__(self, api_key: str = ""):
        self._api_key = api_key
        self._cache: dict[str, dict] = {}

    async def execute_mechanism(self, method: str, parameters: dict) -> MechanismResult:
        if method == "owm_api":
            return await self._owm_api(parameters)
        elif method == "local_cache":
            return self._local_cache(parameters)
        raise ValueError(f"Unknown mechanism: {method}")

    async def _owm_api(self, parameters: dict) -> MechanismResult:
        # Per-call config tier (orchestrator merges global+user before
        # calling). Falls back to the value baked in at __init__ time
        # so unit tests that pass api_key= directly still work.
        cfg = parameters.get("_config") or {}
        api_key = cfg.get("owm_api_key") or self._api_key
        # Orchestrator already resolved decomposer-param → user
        # config → backstop into params["location"], so a single read
        # is enough here.
        location = parameters.get("location")
        if not location:
            return MechanismResult(success=False, error="Location parameter required")
        if not api_key:
            return MechanismResult(success=False, error="OWM API key not configured")

        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                response = await client.get(
                    OWM_BASE_URL,
                    params={"q": location, "appid": api_key, "units": "metric"},
                )

            if response.status_code != 200:
                return MechanismResult(success=False, error=f"OWM API error: {response.status_code}")

            data = response.json()
            from lokidoki.skills.weather_openmeteo.skill import _format_lead
            display = data.get("name", location)
            temp = data["main"]["temp"]
            condition = data["weather"][0]["description"]
            weather = {
                "location": display,
                "temperature": temp,
                "feels_like": data["main"]["feels_like"],
                "humidity": data["main"]["humidity"],
                "condition": condition,
                "wind_speed": data["wind"]["speed"],
                # Pre-formatted one-liner so the orchestrator's
                # verbatim fast-path can return it directly without
                # a synthesis round-trip. See weather_openmeteo for
                # the full rationale.
                "lead": _format_lead(display, temp, condition),
            }

            # Cache the result
            self._cache[location.lower()] = weather

            return MechanismResult(
                success=True,
                data=weather,
                source_url=f"https://openweathermap.org/city",
                source_title=f"OpenWeatherMap - {weather['location']}",
            )
        except Exception as e:
            return MechanismResult(success=False, error=str(e))

    def _local_cache(self, parameters: dict) -> MechanismResult:
        location = parameters.get("location", "").lower()
        cached = self._cache.get(location)
        if cached:
            return MechanismResult(success=True, data=cached)
        return MechanismResult(success=False, error="Cache miss")
