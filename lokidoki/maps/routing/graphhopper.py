"""GraphHopper sidecar — manages the local routing subprocess + HTTP calls."""
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
    LatLon,
    Maneuver,
    RouteAlternate,
    RouteRequest,
    RouteResponse,
    RouterProfile,
    RouterProtocol,
    RouterUnavailable,
)
from lokidoki.maps.routing import build_tiles
from lokidoki.maps.routing.lifecycle import RouterLifecycle

log = logging.getLogger(__name__)

_DEFAULT_PORT = 8002
_HEALTH_TIMEOUT_S = 10.0
_REQUEST_TIMEOUT_S = 15.0
_PROFILE_MAP: dict[RouterProfile, str] = {
    "auto": "car",
    "bicycle": "bike",
    "pedestrian": "foot",
}
_SIGN_TO_MANEUVER = {
    -98: 0,
    -8: 6,
    -7: 6,
    -6: 6,
    -3: 3,
    -2: 3,
    -1: 2,
    0: 0,
    1: 1,
    2: 1,
    3: 1,
    4: 4,
    5: 5,
    6: 6,
    7: 6,
    8: 6,
}


def _jar_path() -> Path:
    return Path(".lokidoki/tools/graphhopper/graphhopper.jar").resolve()


def _java_path() -> Path:
    suffix = "java.exe" if os.name == "nt" else "java"
    embedded = Path(".lokidoki/tools/jre/bin") / suffix
    return embedded.resolve()


def _config_template_path() -> Path:
    return Path(__file__).with_name("graphhopper_config_template.yml")


def _write_config(config_path: Path, pbf_path: Path, graph_cache_dir: Path) -> None:
    config_path.parent.mkdir(parents=True, exist_ok=True)
    config_path.write_text(
        _config_template_path().read_text(encoding="utf-8").format(
            pbf_path=str(pbf_path),
            graph_cache_dir=str(graph_cache_dir),
        ),
        encoding="utf-8",
    )


def _heap_mb() -> int:
    from lokidoki.maps.build import _PLANETILER_HEAP_MB, _runtime_profile

    return _PLANETILER_HEAP_MB[_runtime_profile()]


class GraphHopperRouter(RouterProtocol):
    """Singleton wrapper around the local GraphHopper runtime."""

    def __init__(
        self,
        port: int = _DEFAULT_PORT,
        *,
        lifecycle: RouterLifecycle | None = None,
    ) -> None:
        self._port = port
        self._base_url = f"http://127.0.0.1:{port}"
        self._process: subprocess.Popen[bytes] | None = None
        self._active_region: str | None = None
        self._lifecycle = lifecycle or RouterLifecycle(self)

    @property
    def lifecycle(self) -> RouterLifecycle:
        return self._lifecycle

    async def ensure_started(self, region_id: str) -> None:
        build_tiles.ensure_tiles(region_id)
        await self._lifecycle.ensure_started(region_id)

    async def _stop_locked(self) -> None:
        if self._process is None:
            return
        try:
            self._process.terminate()
            try:
                await asyncio.wait_for(
                    asyncio.to_thread(self._process.wait),
                    timeout=10.0,
                )
            except asyncio.TimeoutError:
                self._process.kill()
        finally:
            self._process = None
            self._active_region = None

    def _spawn_locked(self, region_id: str) -> None:
        jar_path = _jar_path()
        java_bin = _java_path()
        if not jar_path.is_file():
            raise RouterUnavailable(
                "GraphHopper runtime not installed — expected "
                ".lokidoki/tools/graphhopper/graphhopper.jar",
            )
        if not java_bin.is_file():
            raise RouterUnavailable(
                "Temurin JRE not installed — re-run ./run.sh --maps-tools-only",
            )
        graph_cache_dir = build_tiles.ensure_tiles(region_id)
        placeholder_pbf = graph_cache_dir.parent / ".graphhopper-server.osm.pbf"
        placeholder_pbf.touch(exist_ok=True)
        config_path = store.data_dir() / "maps" / "graphhopper-config.yml"
        _write_config(
            config_path,
            pbf_path=placeholder_pbf,
            graph_cache_dir=graph_cache_dir,
        )
        cmd = [
            str(java_bin),
            f"-Xmx{_heap_mb()}m",
            "-jar",
            str(jar_path),
            "server",
            str(config_path),
        ]
        log.info("spawning GraphHopper: %s", " ".join(cmd))
        try:
            self._process = subprocess.Popen(  # noqa: S603
                cmd,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
        except OSError as exc:
            raise RouterUnavailable(f"failed to spawn GraphHopper: {exc}") from exc

    async def _wait_healthy(self) -> None:
        deadline = asyncio.get_event_loop().time() + _HEALTH_TIMEOUT_S
        async with httpx.AsyncClient(timeout=2.0) as client:
            while asyncio.get_event_loop().time() < deadline:
                if self._process is not None and self._process.poll() is not None:
                    raise RouterUnavailable(
                        f"GraphHopper exited with code {self._process.returncode}",
                    )
                try:
                    resp = await client.get(self._base_url)
                    if resp.status_code < 500:
                        return
                except httpx.HTTPError:
                    pass
                await asyncio.sleep(0.25)
        raise RouterUnavailable("GraphHopper did not become healthy in time")

    async def route(self, request: RouteRequest) -> RouteResponse:
        region_id = self._pick_region(request.origin, request.destination)
        await self.ensure_started(region_id)
        body = self._build_body(request)
        try:
            async with httpx.AsyncClient(timeout=_REQUEST_TIMEOUT_S) as client:
                resp = await client.post(f"{self._base_url}/route", json=body)
        except httpx.HTTPError as exc:
            raise RouterUnavailable(f"GraphHopper HTTP error: {exc}") from exc
        if resp.status_code >= 500:
            raise RouterUnavailable(
                f"GraphHopper returned {resp.status_code}: {resp.text[:200]}",
            )
        if resp.status_code != 200:
            raise ValueError(
                f"GraphHopper returned {resp.status_code}: {resp.text[:200]}",
            )
        self._lifecycle.touch()
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

    @staticmethod
    def _pick_region(origin: LatLon, destination: LatLon) -> str:
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
        raise RouterUnavailable("no installed region covers both origin and destination")

    @staticmethod
    def _build_body(req: RouteRequest) -> dict[str, Any]:
        points = [[req.origin.lon, req.origin.lat]]
        points.extend([[wp.lon, wp.lat] for wp in req.waypoints])
        points.append([req.destination.lon, req.destination.lat])
        body: dict[str, Any] = {
            "points": points,
            "profile": _PROFILE_MAP[req.profile],
            "instructions": True,
            "points_encoded": False,
        }
        if req.alternates > 0:
            body["algorithm"] = "alternative_route"
            body["alternative_route.max_paths"] = max(2, req.alternates + 1)
        return body


def _parse_route(payload: dict[str, Any], profile: RouterProfile) -> RouteResponse:
    paths = payload.get("paths") or []
    if not paths:
        raise ValueError("GraphHopper returned no paths")
    primary = paths[0]
    instructions = primary.get("instructions") or []
    maneuvers = tuple(_parse_instruction(item) for item in instructions)
    alternates = tuple(_parse_alternate(path) for path in paths[1:])
    return RouteResponse(
        duration_s=float(primary.get("time", 0.0)) / 1000.0,
        distance_m=float(primary.get("distance", 0.0)),
        geometry=_geometry_text(primary.get("points")),
        maneuvers=maneuvers,
        instructions_text=tuple(m.instruction for m in maneuvers),
        alternates=alternates,
        profile=profile,
    )


def _parse_instruction(item: dict[str, Any]) -> Maneuver:
    interval = item.get("interval") or [0, 0]
    begin, end = (list(interval) + [0, 0])[:2]
    sign = int(item.get("sign", 0))
    return Maneuver(
        instruction=str(item.get("text") or "Continue."),
        distance_m=float(item.get("distance", 0.0)),
        duration_s=float(item.get("time", 0.0)) / 1000.0,
        begin_shape_index=int(begin),
        end_shape_index=int(end),
        type=_SIGN_TO_MANEUVER.get(sign, 0),
    )


def _parse_alternate(path: dict[str, Any]) -> RouteAlternate:
    return RouteAlternate(
        duration_s=float(path.get("time", 0.0)) / 1000.0,
        distance_m=float(path.get("distance", 0.0)),
        geometry=_geometry_text(path.get("points")),
    )


def _geometry_text(points: Any) -> str:
    if isinstance(points, str):
        return points
    if isinstance(points, dict):
        return json.dumps(points, separators=(",", ":"))
    if isinstance(points, list):
        return json.dumps(points, separators=(",", ":"))
    return ""


_router: GraphHopperRouter | None = None


def get_router() -> GraphHopperRouter:
    """Return the process-wide :class:`GraphHopperRouter` singleton."""
    global _router
    if _router is None:
        _router = GraphHopperRouter()
    return _router


def set_router(router: GraphHopperRouter | None) -> None:
    """Test hook — replace or clear the singleton."""
    global _router
    _router = router


ValhallaRouter = GraphHopperRouter


__all__ = [
    "GraphHopperRouter",
    "ValhallaRouter",
    "get_router",
    "set_router",
]
