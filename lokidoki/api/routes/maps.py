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
from dataclasses import asdict

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from lokidoki.auth.dependencies import require_admin
from lokidoki.auth.users import User
from lokidoki.maps import catalog, store
from lokidoki.maps.models import MapArchiveConfig, MapInstallProgress, MapRegionState

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

    async def _runner() -> None:
        try:
            await store.install_region(
                region_id, config, queue=queue, cancel_event=cancel_event,
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
    satellite: bool = False


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
            "satellite": region.satellite_size_mb,
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
        out.append({
            "region_id": st.region_id,
            "label": region.label if region else st.region_id,
            "config": asdict(cfg) if cfg else None,
            "state": asdict(st),
        })
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
    if body.satellite and not body.street:
        raise HTTPException(409, {"error": "satellite_requires_street"})

    config = MapArchiveConfig(
        region_id=region_id, street=body.street, satellite=body.satellite,
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
