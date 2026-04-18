"""Navigation adapters — local-first Valhalla with remote OSRM fallback.

Chunk 6 of the offline-maps plan: :func:`get_directions` and
:func:`get_eta` try the locally-installed Valhalla sidecar before ever
hitting the network. The signature and return shape are
byte-identical to the pre-Chunk-6 OSRM-only implementation so no
caller, prompt template, or TTS formatter has to change.
"""
from __future__ import annotations

import logging
import re
from typing import Any

import httpx

from lokidoki.maps.routing import LatLon, LocalRouterUnavailable, RouteRequest
from lokidoki.maps.routing.online_fallback import OnlineOSRMRouter
from lokidoki.maps.routing.valhalla import get_router
from lokidoki.orchestrator.skills._runner import AdapterResult

log = logging.getLogger(__name__)

_NOMINATIM = "https://nominatim.openstreetmap.org/search"
_OVERPASS = "https://overpass-api.de/api/interpreter"


async def _geocode(place: str) -> tuple[float, float] | None:
    async with httpx.AsyncClient(timeout=6.0) as client:
        response = await client.get(_NOMINATIM, params={"q": place, "format": "jsonv2", "limit": 1}, headers={"User-Agent": "LokiDoki/0.2"})
    if response.status_code != 200:
        return None
    data = response.json()
    if not data:
        return None
    return float(data[0]["lat"]), float(data[0]["lon"])


def _format_duration(seconds: float) -> str:
    minutes = round(seconds / 60)
    if minutes >= 60:
        hours = minutes // 60
        remainder = minutes % 60
        return f"{hours}h {remainder}m" if remainder else f"{hours}h"
    return f"{minutes} min"


def _parse_origin_dest(text: str) -> tuple[str, str] | None:
    lower = text.lower()
    if " from " in lower and " to " in lower:
        after_from = text.lower().split(" from ", 1)[1]
        origin, dest = after_from.split(" to ", 1)
        return origin.strip(), dest.strip()
    if " to " in lower:
        origin = "Times Square, New York"
        dest = text.lower().split(" to ", 1)[1]
        return origin, dest.strip()
    return None


async def _route_local_first(request: RouteRequest):
    """Try the local Valhalla sidecar; fall back to remote OSRM.

    Returns ``(response, mechanism)`` where ``mechanism`` records which
    router actually served the request for the skill's provenance blob.
    """
    try:
        response = await get_router().route(request)
        return response, "valhalla"
    except LocalRouterUnavailable:
        response = await OnlineOSRMRouter().route(request)
        return response, "osrm"


async def get_directions(payload: dict[str, Any]) -> dict[str, Any]:
    text = str(payload.get("chunk_text") or "")
    parsed = _parse_origin_dest(text)
    if parsed is None:
        return AdapterResult(output_text="Tell me the origin and destination for directions.", success=False, error="missing route").to_payload()
    origin, dest = parsed
    origin_coords = await _geocode(origin)
    dest_coords = await _geocode(dest)
    if origin_coords is None or dest_coords is None:
        return AdapterResult(output_text="I couldn't geocode that route.", success=False, error="geocode failed").to_payload()
    request = RouteRequest(
        origin=LatLon(lat=origin_coords[0], lon=origin_coords[1]),
        destination=LatLon(lat=dest_coords[0], lon=dest_coords[1]),
        profile="auto",
    )
    try:
        response, mechanism = await _route_local_first(request)
    except LocalRouterUnavailable as exc:
        return AdapterResult(output_text="I couldn't get directions right now.", success=False, error=str(exc)).to_payload()
    except httpx.HTTPError as exc:
        return AdapterResult(output_text="I couldn't get directions right now.", success=False, error=str(exc)).to_payload()
    if response.duration_s <= 0 and response.distance_m <= 0:
        return AdapterResult(output_text="I couldn't find a route for that trip.", success=False, error="no route").to_payload()
    distance_miles = response.distance_m / 1609.344
    duration = _format_duration(response.duration_s)
    return AdapterResult(
        output_text=f"Driving from {origin.title()} to {dest.title()} is about {distance_miles:.1f} miles and takes {duration}.",
        success=True,
        mechanism_used=mechanism,
        data={"distance_miles": distance_miles, "duration_seconds": response.duration_s},
        source_url="https://www.openstreetmap.org/directions",
        source_title="OpenStreetMap / OSRM",
    ).to_payload()


async def get_eta(payload: dict[str, Any]) -> dict[str, Any]:
    result = await get_directions({"chunk_text": str(payload.get("chunk_text") or "").replace("how long will it take", "drive from Times Square, New York to")})
    return result


async def find_nearby(payload: dict[str, Any]) -> dict[str, Any]:
    text = str(payload.get("chunk_text") or "").lower()
    category = (payload.get("params") or {}).get("category")
    if not category:
        match = re.search(r"find (.+?) near", text)
        category = match.group(1) if match else "restaurant"
    location = (payload.get("params") or {}).get("location") or "Times Square, New York"
    coords = await _geocode(str(location))
    if coords is None:
        return AdapterResult(output_text="I couldn't resolve that location.", success=False, error="geocode failed").to_payload()
    lat, lon = coords
    query = f"""
[out:json];
node(around:1500,{lat},{lon})[amenity~"{category}"];
out 5;
"""
    async with httpx.AsyncClient(timeout=8.0) as client:
        response = await client.post(_OVERPASS, content=query, headers={"User-Agent": "LokiDoki/0.2"})
    if response.status_code != 200:
        return AdapterResult(output_text="I couldn't search nearby places right now.", success=False, error=f"http {response.status_code}").to_payload()
    elements = response.json().get("elements") or []
    if not elements:
        return AdapterResult(output_text=f"I couldn't find nearby {category}.", success=True).to_payload()
    names = []
    for item in elements[:5]:
        tags = item.get("tags") or {}
        if tags.get("name"):
            names.append(tags["name"])
    if not names:
        return AdapterResult(output_text=f"I found nearby {category}, but none had readable names.", success=True).to_payload()
    return AdapterResult(
        output_text=f"Nearby {category}: {', '.join(names)}.",
        success=True,
        mechanism_used="overpass",
        data={"names": names},
        source_url="https://www.openstreetmap.org/",
        source_title="OpenStreetMap / Overpass",
    ).to_payload()
