"""Maps routes — region catalog, install pipeline, storage reporting.

Extends the Chunk 1 stub with the Chunk 2 surface:

* ``GET  /catalog``                 — tree of MapRegion entries.
* ``GET  /catalog/flat``            — flat list, same data.
* ``GET  /regions``                 — installed region state.
* ``PUT  /regions/{region_id}``     — upsert selection + start install.
* ``DELETE /regions/{region_id}``   — cancel install + remove from disk.
* ``GET  /regions/{region_id}/progress`` — SSE stream for in-flight install.
* ``GET  /storage``                 — aggregate bytes-on-disk per artifact.

Auth mirrors the archives router: admin-only for config changes,
anonymous reads are fine since the data is non-sensitive.
"""
from __future__ import annotations

import asyncio
import json
import re
from dataclasses import asdict
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel

from lokidoki.auth.dependencies import require_admin
from lokidoki.auth.users import User
from lokidoki.maps import catalog, store
from lokidoki.maps.geocode import fts_search, nominatim_fallback
from lokidoki.maps.geocode.fts_index import region_db_path
from lokidoki.maps.models import MapArchiveConfig, MapInstallProgress, MapRegionState
from lokidoki.maps.routing import (
    AvoidOpts,
    LatLon,
    LocalRouterUnavailable,
    RouteRequest,
    RouteResponse,
)
from lokidoki.maps.routing import valhalla as valhalla_mod
from lokidoki.maps.routing.online_fallback import OnlineOSRMRouter

# Tiles are long-lived, content-addressed artefacts; the browser may
# cache them hard. PMTiles does byte-range fetches — Starlette's
# FileResponse handles that automatically when given a path.
_TILE_CACHE_CONTROL = "public, max-age=86400, immutable"

router = APIRouter()


# ── Install task tracker ──────────────────────────────────────────

class _InstallTask:
    __slots__ = ("region_id", "task", "queue", "cancel_event")

    def __init__(
        self,
        region_id: str,
        task: asyncio.Task,
        queue: "asyncio.Queue[MapInstallProgress]",
        cancel_event: asyncio.Event,
    ) -> None:
        self.region_id = region_id
        self.task = task
        self.queue = queue
        self.cancel_event = cancel_event


_active: dict[str, _InstallTask] = {}


def _launch_install(region_id: str, config: MapArchiveConfig) -> _InstallTask:
    queue: asyncio.Queue[MapInstallProgress] = asyncio.Queue(maxsize=1024)
    cancel_event = asyncio.Event()

    # Chunk 5 routes the geocoder build into the install pipeline — it
    # needs the source .osm.pbf, so every street install now pulls the
    # PBF as well. The pbf is deleted after indexing by default.
    need_pbf = bool(config.street)

    async def _runner() -> None:
        try:
            await store.install_region(
                region_id, config, queue=queue,
                cancel_event=cancel_event, need_pbf=need_pbf,
            )
        except (asyncio.CancelledError, Exception):  # noqa: BLE001
            # store.install_region already emits an error / cancelled
            # event through the queue; just drop this task from the
            # tracker. The finally clause in the outer install guards
            # against leaking the .tmp dir.
            pass
        finally:
            _active.pop(region_id, None)

    task = asyncio.create_task(_runner())
    handle = _InstallTask(region_id, task, queue, cancel_event)
    _active[region_id] = handle
    return handle


# ── Request models ────────────────────────────────────────────────

class RegionSelection(BaseModel):
    street: bool = False


# ── Catalog ───────────────────────────────────────────────────────

def _region_payload(region) -> dict:
    """Serialise a :class:`MapRegion` for the API."""
    return {
        "region_id": region.region_id,
        "label": region.label,
        "parent_id": region.parent_id,
        "center": {"lat": region.center_lat, "lon": region.center_lon},
        "bbox": list(region.bbox),
        "sizes_mb": {
            "street": region.street_size_mb,
            "valhalla": region.valhalla_size_mb,
            "pbf": region.pbf_size_mb,
        },
        "downloadable": not region.is_parent_only,
        "pi_local_build_ok": region.pi_local_build_ok,
    }


@router.get("/catalog")
async def get_catalog_tree() -> dict:
    """Return the catalog organised by parent_id."""
    by_parent: dict[str | None, list[dict]] = {}
    for region in catalog.MAP_CATALOG.values():
        by_parent.setdefault(region.parent_id, []).append(_region_payload(region))

    def _build(parent_id: str | None) -> list[dict]:
        children = by_parent.get(parent_id, [])
        for entry in children:
            entry["children"] = _build(entry["region_id"])
        return children

    roots = _build(None)
    return {"regions": roots}


@router.get("/catalog/flat")
async def get_catalog_flat() -> dict:
    """Flat version of the catalog — easier for tests and CLI tools."""
    return {
        "regions": [_region_payload(r) for r in catalog.MAP_CATALOG.values()],
    }


# ── Regions (installed state) ─────────────────────────────────────

@router.get("/regions")
async def list_regions() -> list[dict]:
    """Return installed region states.

    A region appears here once at least one artifact has been installed.
    Chunk 1's stub returned ``[]`` unconditionally; Chunk 2 replaces
    that body with data from ``data/maps_state.json``.
    """
    states = store.load_states()
    configs_by_id = {c.region_id: c for c in store.load_configs()}
    out: list[dict] = []
    for st in states:
        cfg = configs_by_id.get(st.region_id)
        region = catalog.get_region(st.region_id)
        entry: dict = {
            "region_id": st.region_id,
            "label": region.label if region else st.region_id,
            "config": asdict(cfg) if cfg else None,
            "state": asdict(st),
        }
        # Chunk 3: bbox + center are required for the frontend coverage
        # resolver — returning them here avoids a second /catalog round
        # trip on every moveend.
        if region is not None:
            entry["bbox"] = list(region.bbox)
            entry["center"] = {"lat": region.center_lat, "lon": region.center_lon}
        out.append(entry)
    return out


@router.put("/regions/{region_id}")
async def upsert_region(
    region_id: str,
    body: RegionSelection,
    _: User = Depends(require_admin),
) -> dict:
    """Store the user's selection and (if non-empty) start an install."""
    region = catalog.get_region(region_id)
    if region is None:
        raise HTTPException(404, f"Unknown region: {region_id}")
    if region.is_parent_only:
        raise HTTPException(400, f"Region {region_id} is parent-only")

    config = MapArchiveConfig(
        region_id=region_id, street=body.street,
    )
    store.upsert_config(config)

    if not config.any_selected:
        # Pure deselect — persist config, let DELETE handle disk cleanup.
        return {"ok": True, "config": asdict(config), "installing": False}

    if region_id in _active:
        return {"ok": True, "config": asdict(config), "installing": True,
                "note": "install already in flight"}

    _launch_install(region_id, config)
    return {"ok": True, "config": asdict(config), "installing": True}


@router.delete("/regions/{region_id}")
async def delete_region(
    region_id: str,
    _: User = Depends(require_admin),
) -> dict:
    """Cancel any active install and wipe the region's disk footprint."""
    handle = _active.get(region_id)
    if handle is not None:
        handle.cancel_event.set()
        handle.task.cancel()
        _active.pop(region_id, None)

    store.remove_config(region_id)
    store.remove_state(region_id)
    store.delete_region_disk(region_id)
    return {"ok": True}


# ── SSE progress ──────────────────────────────────────────────────

@router.get("/regions/{region_id}/progress")
async def region_progress(region_id: str, request: Request):
    """Server-sent events for an in-flight install.

    If no install is running for ``region_id``, the stream closes
    immediately. Clients that poll for a stream after the install
    finished should simply re-check ``GET /regions``.
    """

    async def _events():
        handle = _active.get(region_id)
        if handle is None:
            # Nothing to stream. Let the client close.
            yield f"data: {json.dumps({'status': 'idle', 'region_id': region_id})}\n\n"
            return

        while True:
            if await request.is_disconnected():
                return
            try:
                progress = await asyncio.wait_for(handle.queue.get(), timeout=1.0)
            except asyncio.TimeoutError:
                if handle.task.done() and handle.queue.empty():
                    return
                continue
            yield f"data: {json.dumps(asdict(progress))}\n\n"
            if progress.artifact in ("done", "error", "cancelled") \
                    or progress.error is not None:
                return

    return StreamingResponse(_events(), media_type="text/event-stream")


# ── Storage ───────────────────────────────────────────────────────

# ── Tile serving (Chunk 3) ────────────────────────────────────────

def _validate_region_id(region_id: str) -> None:
    """Reject anything that isn't a known, catalog-listed region.

    Defends against directory traversal (``../``, absolute paths) and
    confused-deputy access to regions that were never installed.
    """
    if catalog.get_region(region_id) is None:
        raise HTTPException(400, f"Unknown region: {region_id}")


# ── Glyph PBFs (offline-hardening chunk 1) ────────────────────────
#
# The MapLibre style references ``glyphs: /api/v1/maps/glyphs/{fontstack}/{range}.pbf``
# so every text layer resolves to this route instead of the Protomaps
# GitHub Pages CDN. The pinned basemaps-assets tarball is extracted by
# the ``install-glyphs`` bootstrap preflight into
# ``.lokidoki/tools/glyphs/<fontstack>/<range>.pbf``.

_FONTSTACK_RE = re.compile(r"^[A-Za-z0-9 ]+$")
_RANGE_RE = re.compile(r"^\d+-\d+$")
_GLYPHS_ROOT = Path(".lokidoki/tools/glyphs")


def _glyphs_dir() -> Path:
    """Resolve the on-disk glyph directory.

    Split out so tests can monkeypatch the path — the runtime install
    target is fixed by the bootstrap, but test fixtures need to write
    PBFs into ``tmp_path``.
    """
    return _GLYPHS_ROOT


@router.get("/glyphs/{fontstack}/{range_suffix}")
async def get_glyph_pbf(fontstack: str, range_suffix: str):
    """Serve a single glyph PBF for the given fontstack and codepoint range.

    ``range_suffix`` is the ``<start>-<end>.pbf`` tail of the MapLibre
    glyphs URL template. Both path components are validated against
    narrow regexes before being joined onto the on-disk glyph root to
    block directory traversal and junk input.
    """
    if not range_suffix.endswith(".pbf"):
        raise HTTPException(400, "glyph range must end in .pbf")
    range_stem = range_suffix[:-4]
    if not _FONTSTACK_RE.match(fontstack) or not _RANGE_RE.match(range_stem):
        raise HTTPException(400, "invalid glyph request")

    path = _glyphs_dir() / fontstack / f"{range_stem}.pbf"
    if not path.is_file():
        raise HTTPException(404, "glyph not installed")
    return FileResponse(
        path,
        media_type="application/x-protobuf",
        headers={"Cache-Control": _TILE_CACHE_CONTROL},
    )


@router.get("/tiles/{region_id}/streets.pmtiles")
async def get_streets_pmtiles(region_id: str):
    """Serve the region's vector basemap as a static PMTiles file.

    MapLibre's ``pmtiles://`` protocol issues ``Range`` requests for the
    directory + individual tile blobs — Starlette's ``FileResponse``
    honours those automatically when handed a filesystem path.
    """
    _validate_region_id(region_id)
    path = store.region_dir(region_id) / "streets.pmtiles"
    if not path.is_file():
        raise HTTPException(404, "streets.pmtiles not installed")
    return FileResponse(
        path,
        media_type="application/octet-stream",
        headers={
            "Accept-Ranges": "bytes",
            "Cache-Control": _TILE_CACHE_CONTROL,
        },
    )


@router.get("/storage")
async def get_storage() -> dict:
    """Aggregate bytes-on-disk per artifact across all installed regions."""
    states = store.load_states()
    totals = store.aggregate_storage(states)
    return {
        "totals": totals,
        "total_bytes": sum(totals.values()),
        "regions": [asdict(s) for s in states],
    }


# ── Geocoding (Chunk 5) ───────────────────────────────────────────

def _viewport_covered_by(region, lat: float, lon: float) -> bool:
    """True iff (lat, lon) falls inside the region's bbox.

    Catalog bboxes are (minLon, minLat, maxLon, maxLat).
    """
    min_lon, min_lat, max_lon, max_lat = region.bbox
    return (min_lat <= lat <= max_lat) and (min_lon <= lon <= max_lon)


def _regions_for_viewport(lat: float | None, lon: float | None) -> list[str]:
    """Return installed region ids whose bbox contains (lat, lon).

    When no viewport is supplied, every installed region with a
    geocoder index is returned so callers see the union.
    """
    installed = [
        st for st in store.load_states()
        if st.geocoder_installed
    ]
    if lat is None or lon is None:
        return [st.region_id for st in installed]
    covering: list[str] = []
    for st in installed:
        region = catalog.get_region(st.region_id)
        if region is None or region.is_parent_only:
            continue
        if _viewport_covered_by(region, lat, lon):
            covering.append(st.region_id)
    return covering


@router.get("/geocode")
async def geocode(
    q: str,
    lat: float | None = None,
    lon: float | None = None,
    limit: int = 10,
) -> dict:
    """Union FTS results across covering regions; fall back to Nominatim.

    ``lat`` / ``lon`` bias ranking and decide which installed regions
    can serve the query. When nothing covers the viewport and the
    network is unreachable, ``offline: true`` tells the frontend to
    show the out-of-coverage banner.
    """
    q = q.strip()
    if not q:
        return {"results": [], "fallback_used": False}

    viewport = (lat, lon) if lat is not None and lon is not None else None
    region_ids = _regions_for_viewport(lat, lon)

    if region_ids:
        hits = await fts_search.search(
            q, viewport, region_ids,
            data_root=store.data_dir(),
            limit=limit,
        )
        return {
            "results": [_geocode_payload(h) for h in hits],
            "fallback_used": False,
        }

    # No installed region covers this viewport — try Nominatim.
    fallback = await nominatim_fallback.search(q, viewport, limit=limit)
    if fallback:
        return {
            "results": [_geocode_payload(h) for h in fallback],
            "fallback_used": True,
        }

    return {
        "results": [],
        "fallback_used": False,
        "offline": True,
    }


def _geocode_payload(result) -> dict:
    """Serialise a :class:`GeocodeResult` for the API response."""
    return {
        "place_id": result.place_id,
        "title": result.title,
        "subtitle": result.subtitle,
        "lat": result.lat,
        "lon": result.lon,
        "bbox": list(result.bbox) if result.bbox else None,
        "source": result.source,
    }


# ── Routing (Chunk 6) ─────────────────────────────────────────────

_VALID_PROFILES = {"auto", "pedestrian", "bicycle"}


class _Coord(BaseModel):
    lat: float
    lon: float


class _AvoidOpts(BaseModel):
    highways: bool = False
    tolls: bool = False
    ferries: bool = False


class RouteBody(BaseModel):
    origin: _Coord
    destination: _Coord
    waypoints: list[_Coord] | None = None
    profile: str = "auto"
    alternates: int = 0
    avoid: _AvoidOpts | None = None


def _serialise_route(response: RouteResponse) -> dict:
    """Shape the :class:`RouteResponse` into the JSON the API returns.

    Wraps the response in an OSRM-looking ``routes[0].legs[0].steps[]``
    envelope so any downstream client written against OSRM keeps working
    unchanged — plus the Valhalla-native fields
    (``instructions_text``, ``alternates``) the Directions panel wants.
    """
    steps = [
        {
            "instruction": m.instruction,
            "distance": m.distance_m,
            "duration": m.duration_s,
            "type": m.type,
            "begin_shape_index": m.begin_shape_index,
            "end_shape_index": m.end_shape_index,
        }
        for m in response.maneuvers
    ]
    return {
        "routes": [
            {
                "duration_s": response.duration_s,
                "distance_m": response.distance_m,
                "geometry": response.geometry,
                "profile": response.profile,
                "legs": [{"steps": steps}],
            },
        ],
        "instructions_text": list(response.instructions_text),
        "alternates": [
            {
                "duration_s": a.duration_s,
                "distance_m": a.distance_m,
                "geometry": a.geometry,
            }
            for a in response.alternates
        ],
    }


def _build_route_request(body: RouteBody) -> RouteRequest:
    if body.profile not in _VALID_PROFILES:
        raise HTTPException(400, f"Unknown profile: {body.profile}")
    waypoints = tuple(
        LatLon(lat=w.lat, lon=w.lon) for w in (body.waypoints or [])
    )
    avoid = AvoidOpts(
        highways=body.avoid.highways if body.avoid else False,
        tolls=body.avoid.tolls if body.avoid else False,
        ferries=body.avoid.ferries if body.avoid else False,
    )
    return RouteRequest(
        origin=LatLon(lat=body.origin.lat, lon=body.origin.lon),
        destination=LatLon(lat=body.destination.lat, lon=body.destination.lon),
        profile=body.profile,  # type: ignore[arg-type]
        waypoints=waypoints,
        alternates=max(0, int(body.alternates)),
        avoid=avoid,
    )


async def _resolve_route(request: RouteRequest) -> tuple[RouteResponse, str]:
    """Try the local Valhalla router first; fall back to remote OSRM.

    Returns ``(response, mechanism)`` where ``mechanism`` is either
    ``"valhalla"`` or ``"osrm"``. The second return is surfaced in the
    response JSON so the client can show which path served the route.
    """
    try:
        response = await valhalla_mod.get_router().route(request)
        return response, "valhalla"
    except LocalRouterUnavailable:
        response = await OnlineOSRMRouter().route(request)
        return response, "osrm"


@router.post("/route")
async def post_route(body: RouteBody) -> dict:
    """Compute a route — local Valhalla first, remote OSRM on fallback.

    ``_resolve_route`` drives the Valhalla router, which hooks into
    :class:`lokidoki.maps.routing.lifecycle.ValhallaLifecycle`. First
    call cold-starts the sidecar; every successful call resets the idle
    clock so the watchdog only fires during real silence. No additional
    wiring is needed here — the touch is inside ``ValhallaRouter.route``.
    """
    request = _build_route_request(body)
    try:
        response, mechanism = await _resolve_route(request)
    except LocalRouterUnavailable as exc:
        raise HTTPException(503, f"no router available: {exc}") from exc
    payload = _serialise_route(response)
    payload["mechanism_used"] = mechanism
    return payload


@router.get("/eta")
async def get_eta(
    o_lat: float,
    o_lon: float,
    d_lat: float,
    d_lon: float,
    profile: str = "auto",
) -> dict:
    """Thin ETA endpoint — returns only duration + distance."""
    if profile not in _VALID_PROFILES:
        raise HTTPException(400, f"Unknown profile: {profile}")
    request = RouteRequest(
        origin=LatLon(lat=o_lat, lon=o_lon),
        destination=LatLon(lat=d_lat, lon=d_lon),
        profile=profile,  # type: ignore[arg-type]
    )
    try:
        response, mechanism = await _resolve_route(request)
    except LocalRouterUnavailable as exc:
        raise HTTPException(503, f"no router available: {exc}") from exc
    return {
        "duration_s": response.duration_s,
        "distance_m": response.distance_m,
        "profile": response.profile,
        "mechanism_used": mechanism,
    }


# Keep ``region_db_path`` reachable for tests and any future callers
# that need to resolve the per-region geocoder file without repeating
# the path logic.
__all__ = ["router", "region_db_path"]
