"""Travel adapters for direct provider-backed travel data."""
from __future__ import annotations

import re
from typing import Any

import httpx

from v2.orchestrator.skills._runner import AdapterResult

_OPENSKY = "https://opensky-network.org/api/states/all"


def _normalize_callsign(text: str) -> str:
    match = re.search(r"\b([A-Za-z]{2,3})\s*[- ]?\s*(\d{1,4})\b", text.upper())
    raw = "".join(match.groups()) if match else "".join(re.findall(r"[A-Za-z0-9]+", text.upper()))
    replacements = {"AA": "AAL", "UA": "UAL", "DL": "DAL"}
    for short, prefix in replacements.items():
        if raw.startswith(short) and not raw.startswith(prefix):
            return prefix + raw[len(short):]
    return raw


async def get_flight_status(payload: dict[str, Any]) -> dict[str, Any]:
    query = str((payload.get("params") or {}).get("flight_number") or payload.get("chunk_text") or "")
    callsign = _normalize_callsign(query)
    try:
        async with httpx.AsyncClient(timeout=8.0) as client:
            response = await client.get(_OPENSKY, headers={"User-Agent": "LokiDoki/0.2"})
    except httpx.HTTPError as exc:
        return AdapterResult(output_text="I couldn't look up that flight status right now.", success=False, error=str(exc)).to_payload()
    if response.status_code != 200:
        return AdapterResult(output_text="I couldn't look up that flight status right now.", success=False, error=f"http {response.status_code}").to_payload()
    for state in response.json().get("states") or []:
        state_callsign = str(state[1] or "").strip()
        if state_callsign == callsign:
            altitude = state[7]
            velocity = state[9]
            return AdapterResult(
                output_text=f"{state_callsign} is airborne at {altitude} meters, speed {velocity}.",
                success=True,
                mechanism_used="opensky",
                data={"callsign": state_callsign, "altitude_m": altitude, "velocity": velocity},
            ).to_payload()
    return AdapterResult(output_text=f"I couldn't find live OpenSky data for {callsign}.", success=False, error="flight not found").to_payload()
