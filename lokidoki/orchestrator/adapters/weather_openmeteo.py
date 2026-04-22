"""Response adapter for Open-Meteo weather payloads."""
from __future__ import annotations

from lokidoki.core.skill_executor import MechanismResult
from lokidoki.orchestrator.adapters.base import AdapterOutput, Source


class OpenMeteoAdapter:
    skill_id = "weather_openmeteo"

    def adapt(self, result: MechanismResult) -> AdapterOutput:
        data = result.data or {}
        lead = str(data.get("lead") or "").strip()
        location = str(data.get("location") or "").strip()
        temp = data.get("temperature")
        feels_like = data.get("feels_like")
        humidity = data.get("humidity")
        wind_speed = data.get("wind_speed")
        condition = str(data.get("condition") or "").strip()
        if not lead and not location and temp is None:
            return AdapterOutput(raw=data)

        facts: list[str] = []
        if temp is not None:
            facts.append(f"Current: {temp}°C")
        if feels_like is not None:
            facts.append(f"Feels like: {feels_like}°C")
        if humidity is not None:
            facts.append(f"Humidity: {humidity}%")
        if wind_speed is not None:
            facts.append(f"Wind: {wind_speed} km/h")
        if condition:
            facts.append(f"Condition: {condition}")

        source = Source(title="Open-Meteo", url="https://open-meteo.com", kind="web")
        return AdapterOutput(
            summary_candidates=(lead,) if lead else (),
            facts=tuple(facts),
            sources=(source,),
            raw=data,
        )
