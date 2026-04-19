"""Valhalla sidecar — manages the local routing subprocess + HTTP calls.

Lifecycle:

* :meth:`ValhallaRouter.ensure_started` spawns the Valhalla process on
  first use from the native tarball at
  ``.lokidoki/valhalla/valhalla_service`` (pinned in
  :data:`lokidoki.bootstrap.versions.VALHALLA_RUNTIME`). If the binary
  is absent, it raises :class:`ValhallaUnavailable` and the navigation
  skill falls back to remote OSRM. LokiDoki does not depend on Docker
  on any profile.
* :meth:`route` + :meth:`eta` POST to ``http://127.0.0.1:8002/route``.
* A single-flight lock serialises spawn attempts so concurrent callers
  don't race to start two processes.

The router never builds tiles — tiles arrive prebuilt as a region
artefact (Chunk 2). :func:`build_tiles.ensure_tiles` validates their
on-disk layout before the first route call.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import subprocess
from pathlib import Path
from typing import Any

import httpx

from lokidoki.maps import store
from lokidoki.maps.routing import (
    AvoidOpts,
    LatLon,
    Maneuver,
    RouteAlternate,
    RouteRequest,
    RouteResponse,
    RouterProfile,
    RouterProtocol,
    ValhallaUnavailable,
)
from lokidoki.maps.routing import build_tiles

log = logging.getLogger(__name__)

# Valhalla's default HTTP port. Baked into the config JSON we generate.
_DEFAULT_PORT = 8002
_HEALTH_TIMEOUT_S = 10.0
_REQUEST_TIMEOUT_S = 15.0
_SPAWN_LOCK = asyncio.Lock()

# Valhalla maneuver types → textual hint (used only if the narrative
# string is missing; Valhalla normally supplies ``instruction``).
_MANEUVER_FALLBACK = "Continue."


def _native_binary() -> Path | None:
    """Return the path to the extracted Valhalla CLI, or None.

    Bootstrap writes the tarball under ``.lokidoki/valhalla/`` next to
    the other runtime binaries. Until the offline-bundle pipeline
    publishes real artefacts this path is simply absent — callers get
    a :class:`ValhallaUnavailable` and the skill falls back to remote
    OSRM.
    """
    candidates = [
        Path(".lokidoki/valhalla/valhalla_service"),
        Path(".lokidoki/valhalla/bin/valhalla_service"),
    ]
    for candidate in candidates:
        if candidate.is_file() and os.access(candidate, os.X_OK):
            return candidate.resolve()
    return None


def _write_config(config_path: Path, tile_dir: Path) -> None:
    """Emit a minimal Valhalla JSON config pointing at ``tile_dir``.

    Valhalla reads every ``mjolnir.tile_dir`` entry at startup; we only
    point it at one region at a time (union-of-regions is deferred —
    see the chunk's Deferrals section). For a request that falls
    outside the union, the HTTP call returns 400 and the navigation
    skill's fallback to remote OSRM kicks in.
    """
    config: dict[str, Any] = {
        "mjolnir": {
            "tile_dir": str(tile_dir),
            "concurrency": 1,
            "data_processing": {"allow_alt_name": False},
        },
        "loki": {"actions": ["locate", "route", "sources_to_targets"]},
        "thor": {"logging": {"long_request": 110.0}},
        "odin": {"logging": {"long_request": 110.0}},
        "service_limits": {
            "auto": {"max_distance": 500000.0, "max_locations": 20},
            "pedestrian": {"max_distance": 250000.0, "max_locations": 20},
            "bicycle": {"max_distance": 500000.0, "max_locations": 20},
        },
        "httpd": {"service": {"listen": f"tcp://0.0.0.0:{_DEFAULT_PORT}"}},
    }
    config_path.parent.mkdir(parents=True, exist_ok=True)
    config_path.write_text(json.dumps(config, indent=2), encoding="utf-8")


class ValhallaRouter(RouterProtocol):
    """Singleton wrapper around the local Valhalla runtime.

    Instantiate via :func:`get_router`. The router is lazy — the
    subprocess starts on the first :meth:`route` / :meth:`eta` call and
    stays up for the lifetime of the FastAPI process.
    """

    def __init__(self, port: int = _DEFAULT_PORT) -> None:
        self._port = port
        self._base_url = f"http://127.0.0.1:{port}"
        self._process: subprocess.Popen[bytes] | None = None
        self._active_region: str | None = None

    # ── Lifecycle ────────────────────────────────────────────────

    async def ensure_started(self, region_id: str) -> None:
        """Spawn the sidecar if needed; validate tiles first.

        Re-entry is safe: holds :data:`_SPAWN_LOCK` while deciding
        whether to spawn, short-circuits when the process is already up
        AND already serving ``region_id``. Raises
        :class:`ValhallaUnavailable` when no spawn path works.
        """
        build_tiles.ensure_tiles(region_id)
        async with _SPAWN_LOCK:
            if self._process is not None and self._process.poll() is None \
                    and self._active_region == region_id:
                return
            # Region switch or first start: tear down and respawn against
            # the new tile dir. Running Valhalla can't swap tile_dir at
            # runtime without a SIGHUP handler the community builds
            # don't ship.
            await self._stop_locked()
            self._spawn_locked(region_id)
            await self._wait_healthy()
            self._active_region = region_id

    async def _stop_locked(self) -> None:
        if self._process is None:
            return
        try:
            self._process.terminate()
            try:
                await asyncio.wait_for(
                    asyncio.to_thread(self._process.wait),
                    timeout=5.0,
                )
            except asyncio.TimeoutError:
                self._process.kill()
        finally:
            self._process = None
            self._active_region = None

    def _spawn_locked(self, region_id: str) -> None:
        tile_dir = build_tiles.tile_dir(region_id)
        native = _native_binary()
        if native is None:
            raise ValhallaUnavailable(
                "Valhalla runtime not installed — expected "
                ".lokidoki/valhalla/valhalla_service (offline-bundle artefact)",
            )
        config_path = store.data_dir() / "maps" / "valhalla-config.json"
        _write_config(config_path, tile_dir)
        cmd = [str(native), "--config", str(config_path)]
        log.info("spawning Valhalla: %s", " ".join(cmd))
        try:
            self._process = subprocess.Popen(  # noqa: S603
                cmd,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
        except OSError as exc:
            raise ValhallaUnavailable(
                f"failed to spawn Valhalla: {exc}",
            ) from exc

    async def _wait_healthy(self) -> None:
        """Poll the status endpoint until 200 or timeout."""
        deadline = asyncio.get_event_loop().time() + _HEALTH_TIMEOUT_S
        async with httpx.AsyncClient(timeout=2.0) as client:
            while asyncio.get_event_loop().time() < deadline:
                if self._process is not None and self._process.poll() is not None:
                    raise ValhallaUnavailable(
                        f"Valhalla exited with code {self._process.returncode}",
                    )
                try:
                    resp = await client.get(f"{self._base_url}/status")
                    if resp.status_code == 200:
                        return
                except httpx.HTTPError:
                    pass
                await asyncio.sleep(0.25)
        raise ValhallaUnavailable("Valhalla did not become healthy in time")

    # ── Public API ───────────────────────────────────────────────

    async def route(self, request: RouteRequest) -> RouteResponse:
        region_id = self._pick_region(request.origin, request.destination)
        await self.ensure_started(region_id)
        body = self._build_body(request)
        try:
            async with httpx.AsyncClient(timeout=_REQUEST_TIMEOUT_S) as client:
                resp = await client.post(f"{self._base_url}/route", json=body)
        except httpx.HTTPError as exc:
            raise ValhallaUnavailable(f"Valhalla HTTP error: {exc}") from exc
        if resp.status_code >= 500:
            raise ValhallaUnavailable(
                f"Valhalla returned {resp.status_code}: {resp.text[:200]}",
            )
        if resp.status_code != 200:
            raise ValueError(
                f"Valhalla returned {resp.status_code}: {resp.text[:200]}",
            )
        return _parse_route(resp.json(), request.profile)

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

    # ── Helpers ──────────────────────────────────────────────────

    @staticmethod
    def _pick_region(origin: LatLon, destination: LatLon) -> str:
        """Pick an installed region whose bbox contains both endpoints.

        Cross-region routing is explicitly deferred (see chunk doc):
        when no single installed region covers both points, we raise
        :class:`ValhallaUnavailable` so the skill's fallback to remote
        OSRM fires.
        """
        from lokidoki.maps import catalog as _catalog

        for state in store.load_states():
            if not state.valhalla_installed:
                continue
            region = _catalog.get_region(state.region_id)
            if region is None or region.is_parent_only:
                continue
            min_lon, min_lat, max_lon, max_lat = region.bbox
            if (min_lat <= origin.lat <= max_lat
                    and min_lon <= origin.lon <= max_lon
                    and min_lat <= destination.lat <= max_lat
                    and min_lon <= destination.lon <= max_lon):
                return state.region_id
        raise ValhallaUnavailable(
            "no installed region covers both origin and destination",
        )

    @staticmethod
    def _build_body(req: RouteRequest) -> dict[str, Any]:
        locations: list[dict[str, Any]] = [
            {"lat": req.origin.lat, "lon": req.origin.lon, "type": "break"},
        ]
        for wp in req.waypoints:
            locations.append({"lat": wp.lat, "lon": wp.lon, "type": "through"})
        locations.append({
            "lat": req.destination.lat,
            "lon": req.destination.lon,
            "type": "break",
        })
        exclude: list[str] = []
        avoid = req.avoid or AvoidOpts()
        if avoid.highways:
            exclude.append("highway")
        if avoid.tolls:
            exclude.append("toll")
        if avoid.ferries:
            exclude.append("ferry")
        body: dict[str, Any] = {
            "locations": locations,
            "costing": req.profile,
            "directions_options": {"units": "kilometers"},
            "alternates": max(0, int(req.alternates)),
        }
        if exclude:
            body["exclude_polygons"] = []
            body["costing_options"] = {
                req.profile: {"exclude_" + kind: True for kind in exclude},
            }
        return body


def _parse_route(payload: dict[str, Any], profile: RouterProfile) -> RouteResponse:
    """Map a Valhalla JSON response onto :class:`RouteResponse`."""
    trip = payload.get("trip") or {}
    summary = trip.get("summary") or {}
    legs = trip.get("legs") or []
    maneuvers: list[Maneuver] = []
    instructions: list[str] = []
    geometry = ""

    for leg in legs:
        geometry = leg.get("shape") or geometry
        for m in leg.get("maneuvers") or []:
            instruction = (m.get("instruction") or _MANEUVER_FALLBACK).strip()
            instructions.append(instruction)
            maneuvers.append(Maneuver(
                instruction=instruction,
                distance_m=float(m.get("length", 0.0)) * 1000.0,
                duration_s=float(m.get("time", 0.0)),
                begin_shape_index=int(m.get("begin_shape_index", 0)),
                end_shape_index=int(m.get("end_shape_index", 0)),
                type=int(m.get("type", 0)),
            ))

    duration_s = float(summary.get("time", 0.0))
    distance_m = float(summary.get("length", 0.0)) * 1000.0

    alternates: list[RouteAlternate] = []
    for alt in payload.get("alternates") or []:
        alt_trip = (alt or {}).get("trip") or {}
        alt_summary = alt_trip.get("summary") or {}
        alt_legs = alt_trip.get("legs") or [{}]
        alternates.append(RouteAlternate(
            duration_s=float(alt_summary.get("time", 0.0)),
            distance_m=float(alt_summary.get("length", 0.0)) * 1000.0,
            geometry=(alt_legs[0].get("shape") if alt_legs else "") or "",
        ))

    return RouteResponse(
        duration_s=duration_s,
        distance_m=distance_m,
        geometry=geometry,
        maneuvers=tuple(maneuvers),
        instructions_text=tuple(instructions),
        alternates=tuple(alternates),
        profile=profile,
    )


_router: ValhallaRouter | None = None


def get_router() -> ValhallaRouter:
    """Return the process-wide :class:`ValhallaRouter` singleton."""
    global _router
    if _router is None:
        _router = ValhallaRouter()
    return _router


def set_router(router: ValhallaRouter | None) -> None:
    """Test hook — replace or clear the singleton."""
    global _router
    _router = router


__all__ = ["ValhallaRouter", "get_router", "set_router"]
