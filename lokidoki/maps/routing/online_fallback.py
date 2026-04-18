"""Thin remote-OSRM wrapper used only when the local router is down.

Matches :class:`RouterProtocol` so callers can swap it in wherever the
Valhalla router would go. The implementation intentionally stays
simple — no alternates, no `avoid.*` flags — because OSRM's public
endpoint throttles aggressively and this path is meant for rare,
cross-region or runtime-unavailable requests.
"""
from __future__ import annotations

import logging
from typing import Any

import httpx

from lokidoki.maps.routing import (
    LatLon,
    LocalRouterUnavailable,
    Maneuver,
    RouteRequest,
    RouteResponse,
    RouterProfile,
)

log = logging.getLogger(__name__)

_OSRM_BASE = "https://router.project-osrm.org/route/v1"
_USER_AGENT = "LokiDoki/0.1 (offline-maps)"
_TIMEOUT_S = 6.0

# Valhalla profile → OSRM profile. OSRM only ships `driving`, `walking`,
# `cycling` on the public demo server.
_PROFILE_MAP: dict[RouterProfile, str] = {
    "auto": "driving",
    "pedestrian": "walking",
    "bicycle": "cycling",
}


class OnlineOSRMRouter:
    """OSRM-backed router used as a fallback when Valhalla is down."""

    async def route(self, request: RouteRequest) -> RouteResponse:
        profile = _PROFILE_MAP.get(request.profile, "driving")
        url = (
            f"{_OSRM_BASE}/{profile}/"
            f"{request.origin.lon},{request.origin.lat};"
            f"{request.destination.lon},{request.destination.lat}"
        )
        params: dict[str, Any] = {
            "overview": "full",
            "steps": "true",
            "geometries": "polyline",
        }
        if request.alternates > 0:
            params["alternatives"] = "true"
        try:
            async with httpx.AsyncClient(timeout=_TIMEOUT_S) as client:
                resp = await client.get(
                    url, params=params, headers={"User-Agent": _USER_AGENT},
                )
        except httpx.HTTPError as exc:
            raise LocalRouterUnavailable(
                f"remote OSRM unreachable: {exc}",
            ) from exc
        if resp.status_code != 200:
            raise LocalRouterUnavailable(
                f"remote OSRM returned {resp.status_code}",
            )
        payload = resp.json()
        routes = payload.get("routes") or []
        if not routes:
            raise LocalRouterUnavailable("remote OSRM returned no routes")
        primary = routes[0]
        maneuvers = _osrm_maneuvers(primary)
        alternates = tuple()
        return RouteResponse(
            duration_s=float(primary.get("duration", 0.0)),
            distance_m=float(primary.get("distance", 0.0)),
            geometry=str(primary.get("geometry", "")),
            maneuvers=maneuvers,
            instructions_text=tuple(m.instruction for m in maneuvers),
            alternates=alternates,
            profile=request.profile,
        )

    async def eta(
        self,
        origin: LatLon,
        destination: LatLon,
        profile: RouterProfile = "auto",
    ) -> tuple[float, float]:
        response = await self.route(
            RouteRequest(origin=origin, destination=destination, profile=profile),
        )
        return response.duration_s, response.distance_m


def _osrm_maneuvers(route: dict[str, Any]) -> tuple[Maneuver, ...]:
    """Flatten OSRM's legs/steps into our :class:`Maneuver` list.

    OSRM's public demo returns minimal instruction text — Valhalla's
    narrative is much richer. We use ``maneuver.type`` as a best-effort
    fallback when nothing else is present.
    """
    out: list[Maneuver] = []
    for leg in route.get("legs") or []:
        for step in leg.get("steps") or []:
            maneuver = step.get("maneuver") or {}
            instruction = step.get("name") or maneuver.get("type") or "Continue."
            out.append(Maneuver(
                instruction=str(instruction),
                distance_m=float(step.get("distance", 0.0)),
                duration_s=float(step.get("duration", 0.0)),
                begin_shape_index=0,
                end_shape_index=0,
                type=0,
            ))
    return tuple(out)


__all__ = ["OnlineOSRMRouter"]
