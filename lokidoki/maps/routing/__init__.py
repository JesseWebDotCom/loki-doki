"""Offline routing subsystem — local sidecar per region.

This package wraps the local GraphHopper runtime that serves driving /
walking / cycling directions against the on-device routing graph under
``data/maps/<region>/valhalla/graph-cache``. The rest of the app only
imports the dataclasses and :class:`RouterProtocol` from this module;
concrete routers live in :mod:`.graphhopper`, :mod:`.valhalla`
(compatibility shim), and :mod:`.online_fallback`.

Return shape is intentionally a superset of the OSRM response the
navigation skill used to consume, so ``get_directions()`` /
``get_eta()`` can swap from remote OSRM to the local sidecar without
changing downstream prompt or TTS templates.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal, Protocol, runtime_checkable

RouterProfile = Literal["auto", "pedestrian", "bicycle"]


class LocalRouterUnavailable(Exception):
    """Raised when no local routing runtime can serve the request.

    The navigation skill catches this and falls back to remote OSRM so
    the user still gets directions when the Pi has network but no
    installed region covers the origin / destination.
    """


class RouterUnavailable(LocalRouterUnavailable):
    """Raised when the local routing sidecar cannot be spawned or reached.

    Subclass of :class:`LocalRouterUnavailable` so the skill's try /
    except can treat every local-runtime failure uniformly.
    """


ValhallaUnavailable = RouterUnavailable


@dataclass(frozen=True, slots=True)
class LatLon:
    lat: float
    lon: float


@dataclass(frozen=True, slots=True)
class AvoidOpts:
    highways: bool = False
    tolls: bool = False
    ferries: bool = False


@dataclass(frozen=True, slots=True)
class RouteRequest:
    origin: LatLon
    destination: LatLon
    profile: RouterProfile = "auto"
    waypoints: tuple[LatLon, ...] = ()
    alternates: int = 0
    avoid: AvoidOpts = field(default_factory=AvoidOpts)


@dataclass(frozen=True, slots=True)
class Maneuver:
    """One turn-by-turn instruction — local router maneuver, normalised.

    Indices point into the encoded polyline so the frontend can draw
    a per-step highlight without re-geocoding.
    """

    instruction: str
    distance_m: float
    duration_s: float
    begin_shape_index: int
    end_shape_index: int
    type: int = 0


@dataclass(frozen=True, slots=True)
class RouteAlternate:
    duration_s: float
    distance_m: float
    geometry: str


@dataclass(frozen=True, slots=True)
class RouteResponse:
    """Primary result shape returned by every router implementation.

    ``legs`` mirrors OSRM's ``routes[0].legs[0].steps[]`` shape so the
    navigation skill's formatter keeps working unchanged. ``maneuvers``
    is the richer local-router-native list the Directions panel renders.
    ``instructions_text`` is flattened maneuver narrative for a one-shot
    TTS readout.
    """

    duration_s: float
    distance_m: float
    geometry: str
    maneuvers: tuple[Maneuver, ...] = ()
    instructions_text: tuple[str, ...] = ()
    alternates: tuple[RouteAlternate, ...] = ()
    profile: RouterProfile = "auto"


@runtime_checkable
class RouterProtocol(Protocol):
    """Protocol every concrete router satisfies."""

    async def route(self, request: RouteRequest) -> RouteResponse:
        ...

    async def eta(
        self,
        origin: LatLon,
        destination: LatLon,
        profile: RouterProfile = "auto",
    ) -> tuple[float, float]:
        ...


def __getattr__(name: str):
    """Lazy re-export of :class:`RouterLifecycle`.

    Importing the lifecycle eagerly would create a cycle — ``lifecycle``
    doesn't import from this package, but keeping the import lazy lets
    downstream callers grab the symbol via ``from lokidoki.maps.routing
    import RouterLifecycle`` without paying the cost on every import.
    """
    if name in {"RouterLifecycle", "ValhallaLifecycle"}:
        from lokidoki.maps.routing.lifecycle import RouterLifecycle
        return RouterLifecycle
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


__all__ = [
    "AvoidOpts",
    "LatLon",
    "LocalRouterUnavailable",
    "Maneuver",
    "RouteAlternate",
    "RouteRequest",
    "RouteResponse",
    "RouterProfile",
    "RouterProtocol",
    "RouterLifecycle",
    "RouterUnavailable",
    "ValhallaLifecycle",
    "ValhallaUnavailable",
]
