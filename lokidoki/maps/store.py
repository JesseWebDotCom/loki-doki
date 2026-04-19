"""Map region config/state persistence + region install pipeline.

Two JSON files under the data directory:

  - ``maps_config.json`` — per-region admin selection.
  - ``maps_state.json``  — per-region on-disk reality (artifact flags + bytes).

``install_region`` is an async coroutine that downloads the source
OpenStreetMap PBF for a region (the only real network download), with
sha256 verification when the catalog carries one, and atomically
renames it into ``data/maps/<region_id>/``. Progress is published
through an :class:`asyncio.Queue` the SSE endpoint drains. Later
chunks layer local builds (PMTiles, routing graph, FTS geocoder) on
top of the downloaded PBF.

Follows the shape of :mod:`lokidoki.archives.store` — different content,
same lightweight JSON-file pattern.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import shutil
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable

import httpx

from .catalog import MapRegion, get_region
from .models import MapArchiveConfig, MapInstallProgress, MapRegionState

log = logging.getLogger(__name__)

_DATA_DIR: Path | None = None
_CHUNK_SIZE = 1024 * 1024  # 1 MB download chunks
_USER_AGENT = "LokiDoki/0.1 (offline-maps)"

# After the FTS5 geocoder index is built, the source .osm.pbf is
# multiple times larger than the index we just produced. Delete it by
# default to reclaim disk (users); keep it with LOKIDOKI_KEEP_PBF=1 so
# developers can rebuild without re-downloading.
_KEEP_PBF_ENV = "LOKIDOKI_KEEP_PBF"


def _keep_pbf() -> bool:
    """Return True if the source .osm.pbf should be retained post-index."""
    return os.environ.get(_KEEP_PBF_ENV, "").strip() in {"1", "true", "yes"}


# ── Directory layout ──────────────────────────────────────────────

def set_data_dir(path: Path | None) -> None:
    """Set the data directory root. Called once at startup."""
    global _DATA_DIR
    _DATA_DIR = path


def _data_dir() -> Path:
    if _DATA_DIR is not None:
        return _DATA_DIR
    return Path("data")


def data_dir() -> Path:
    """Public accessor for the maps data root — used by routes + tests."""
    return _data_dir()


def maps_root() -> Path:
    """Root directory for installed region artifacts."""
    return _data_dir() / "maps"


def region_dir(region_id: str) -> Path:
    """Per-region artifact directory."""
    return maps_root() / region_id


def _tmp_dir(region_id: str) -> Path:
    """In-flight download scratch dir — cleaned on cancel / next boot."""
    return region_dir(region_id) / ".tmp"


# ── Config persistence ────────────────────────────────────────────

def _config_path() -> Path:
    return _data_dir() / "maps_config.json"


def load_configs() -> list[MapArchiveConfig]:
    """Load all map region configs from disk."""
    path = _config_path()
    if not path.exists():
        return []
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
        return [MapArchiveConfig(**entry) for entry in raw]
    except (json.JSONDecodeError, TypeError, KeyError):
        log.warning("Corrupt maps_config.json — returning empty list")
        return []


def save_configs(configs: list[MapArchiveConfig]) -> None:
    """Persist all map region configs to disk."""
    path = _config_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps([asdict(c) for c in configs], indent=2),
        encoding="utf-8",
    )


def get_config(region_id: str) -> MapArchiveConfig | None:
    return next((c for c in load_configs() if c.region_id == region_id), None)


def upsert_config(config: MapArchiveConfig) -> None:
    configs = [c for c in load_configs() if c.region_id != config.region_id]
    configs.append(config)
    save_configs(configs)


def remove_config(region_id: str) -> None:
    configs = [c for c in load_configs() if c.region_id != region_id]
    save_configs(configs)


# ── State persistence ─────────────────────────────────────────────

def _state_path() -> Path:
    return _data_dir() / "maps_state.json"


def load_states() -> list[MapRegionState]:
    """Load all on-disk region states."""
    path = _state_path()
    if not path.exists():
        return []
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
        return [MapRegionState(**entry) for entry in raw]
    except (json.JSONDecodeError, TypeError, KeyError):
        log.warning("Corrupt maps_state.json — returning empty list")
        return []


def save_states(states: list[MapRegionState]) -> None:
    path = _state_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps([asdict(s) for s in states], indent=2),
        encoding="utf-8",
    )


def get_state(region_id: str) -> MapRegionState | None:
    return next((s for s in load_states() if s.region_id == region_id), None)


def upsert_state(state: MapRegionState) -> None:
    states = [s for s in load_states() if s.region_id != state.region_id]
    states.append(state)
    save_states(states)


def remove_state(region_id: str) -> None:
    states = [s for s in load_states() if s.region_id != region_id]
    save_states(states)


# ── Disk uninstall ────────────────────────────────────────────────

def delete_region_disk(region_id: str) -> None:
    """Remove the entire ``data/maps/<region_id>/`` tree.

    Safe to call when the directory does not exist.
    """
    d = region_dir(region_id)
    if d.exists():
        shutil.rmtree(d, ignore_errors=True)


def cleanup_stale_tmp() -> None:
    """Remove every ``data/maps/*/.tmp`` directory.

    Called at startup so a process crash mid-download doesn't leave
    partial files wasting disk. Never touches completed artifacts.
    """
    root = maps_root()
    if not root.exists():
        return
    for region in root.iterdir():
        if region.is_dir():
            tmp = region / ".tmp"
            if tmp.exists():
                shutil.rmtree(tmp, ignore_errors=True)


# ── Install pipeline ──────────────────────────────────────────────

def _final_path_for(region_id: str, artifact: str) -> Path:
    """Final on-disk destination for a given artifact."""
    d = region_dir(region_id)
    return {
        "pbf": d / "region.osm.pbf",
    }[artifact]


def _artifact_plan(
    region: MapRegion,
    config: MapArchiveConfig,
) -> list[tuple[str, str, int, str]]:
    """Return ``(artifact, url, size_bytes_hint, sha256)`` for each
    artifact this install needs to download.

    After the maps-local-build switch, the only real network download
    is the Geofabrik ``.osm.pbf`` — every other artifact (basemap,
    routing graph, geocoder) is produced locally by later build
    steps that consume the PBF on disk.
    """
    return [(
        "pbf",
        region.pbf_url_template,
        int(region.pbf_size_mb * 1024 * 1024),
        region.pbf_sha256,
    )]


async def _download_to(
    url: str,
    dest: Path,
    expected_sha256: str,
    progress_cb,
    cancel_event: asyncio.Event,
) -> int:
    """Stream ``url`` to ``dest`` with sha256 verification and progress.

    Returns the number of bytes written. On sha mismatch, the partial
    file is deleted and a ``ValueError`` is raised.
    """
    dest.parent.mkdir(parents=True, exist_ok=True)
    hasher = hashlib.sha256()
    downloaded = 0

    async with httpx.AsyncClient(
        timeout=httpx.Timeout(30.0, read=300.0),
        follow_redirects=True,
    ) as client:
        async with client.stream(
            "GET", url, headers={"User-Agent": _USER_AGENT},
        ) as resp:
            resp.raise_for_status()
            total = int(resp.headers.get("content-length", "0") or 0)
            progress_cb(0, total)
            with dest.open("wb") as f:
                async for chunk in resp.aiter_bytes(_CHUNK_SIZE):
                    if cancel_event.is_set():
                        raise asyncio.CancelledError()
                    f.write(chunk)
                    hasher.update(chunk)
                    downloaded += len(chunk)
                    progress_cb(downloaded, total or downloaded)

    if expected_sha256:
        actual = hasher.hexdigest()
        if actual.lower() != expected_sha256.lower():
            try:
                dest.unlink()
            except OSError:
                pass
            raise ValueError(
                f"sha256 mismatch for {dest.name}: "
                f"expected {expected_sha256[:12]}…, got {actual[:12]}…"
            )
    else:
        log.warning("sha256 check skipped for %s — no hash in catalog", dest.name)

    return downloaded


async def _build_geocoder_step(
    region_id: str,
    state: MapRegionState,
    emit,
    cancel_event: asyncio.Event,
) -> None:
    """Build the FTS5 geocoder index for ``region_id`` from the PBF on disk.

    Runs in a thread so the pyosmium stream does not block the event loop.
    Emits ``{artifact: "geocoder", phase: "indexing"|"ready"}`` events so
    the admin-panel SSE stream surfaces progress.
    """
    from .geocode.fts_index import build_index, region_db_path

    pbf_path = _final_path_for(region_id, "pbf")
    if not pbf_path.exists():
        return

    db_path = region_db_path(_data_dir(), region_id)
    if db_path.exists():
        db_path.unlink()

    await emit(MapInstallProgress(
        region_id=region_id, artifact="geocoder",
        bytes_done=0, bytes_total=0,
        phase="indexing",
    ))

    def _run() -> int:
        stats = build_index(pbf_path, db_path, region_id)
        return stats.total

    loop = asyncio.get_event_loop()
    try:
        total_rows = await loop.run_in_executor(None, _run)
    except Exception as exc:  # noqa: BLE001 — surfaced via SSE
        log.exception("geocoder build failed for %s", region_id)
        if db_path.exists():
            db_path.unlink()
        await emit(MapInstallProgress(
            region_id=region_id, artifact="geocoder",
            phase="complete", error=str(exc),
        ))
        raise

    if cancel_event.is_set():
        if db_path.exists():
            db_path.unlink()
        raise asyncio.CancelledError()

    state.geocoder_installed = True
    state.bytes_on_disk["geocoder"] = db_path.stat().st_size

    # Optional disk cleanup — default is to reclaim the PBF.
    if not _keep_pbf() and pbf_path.exists():
        pbf_path.unlink()
        state.pbf_installed = False
        state.bytes_on_disk.pop("pbf", None)

    await emit(MapInstallProgress(
        region_id=region_id, artifact="geocoder",
        bytes_done=total_rows, bytes_total=total_rows,
        phase="ready",
    ))


async def install_region(
    region_id: str,
    config: MapArchiveConfig,
    queue: "asyncio.Queue[MapInstallProgress] | None" = None,
    cancel_event: asyncio.Event | None = None,
    need_pbf: bool = False,
) -> MapRegionState:
    """Download the region's source PBF into ``data/maps/<region_id>/``.

    Files land first in ``data/maps/<region_id>/.tmp/`` then are
    ``os.replace``-d into the final path. Emits one
    :class:`MapInstallProgress` per chunk-size step on ``queue``.

    Later chunks add the local build steps that turn the PBF into a
    basemap, a routing graph, and an FTS geocoder. ``need_pbf`` is
    accepted for forward-compat with callers that will trigger the
    geocoder build once it is wired in.
    """
    region = get_region(region_id)
    if region is None:
        raise KeyError(f"unknown region: {region_id}")
    if region.is_parent_only:
        raise ValueError(f"region {region_id} is parent-only and has no artifacts")
    if not config.any_selected:
        raise ValueError(f"region {region_id} has no artifacts selected")

    cancel_event = cancel_event or asyncio.Event()

    async def _emit(progress: MapInstallProgress) -> None:
        if queue is not None:
            await queue.put(progress)

    plan = _artifact_plan(region, config)

    tmp = _tmp_dir(region_id)
    tmp.mkdir(parents=True, exist_ok=True)

    state = get_state(region_id) or MapRegionState(region_id=region_id)

    try:
        for artifact, url, size_hint, sha in plan:
            final = _final_path_for(region_id, artifact)
            tmp_path = tmp / final.name

            def _cb(done: int, total: int, artifact=artifact) -> None:
                if queue is not None:
                    try:
                        queue.put_nowait(MapInstallProgress(
                            region_id=region_id,
                            artifact=artifact,
                            bytes_done=done,
                            bytes_total=total or size_hint,
                            phase="downloading",
                        ))
                    except asyncio.QueueFull:
                        pass

            await _emit(MapInstallProgress(
                region_id=region_id, artifact=artifact,
                bytes_done=0, bytes_total=size_hint,
                phase="resolving",
            ))

            try:
                bytes_written = await _download_to(
                    url, tmp_path, sha, _cb, cancel_event,
                )
            except asyncio.CancelledError:
                await _emit(MapInstallProgress(
                    region_id=region_id, artifact=artifact,
                    phase="complete", error="cancelled",
                ))
                shutil.rmtree(tmp, ignore_errors=True)
                raise

            await _emit(MapInstallProgress(
                region_id=region_id, artifact=artifact,
                bytes_done=bytes_written, bytes_total=bytes_written,
                phase="verifying",
            ))

            final.parent.mkdir(parents=True, exist_ok=True)
            os.replace(tmp_path, final)

            setattr(state, f"{artifact}_installed", True)
            state.bytes_on_disk[artifact] = bytes_written

            await _emit(MapInstallProgress(
                region_id=region_id, artifact=artifact,
                bytes_done=bytes_written, bytes_total=bytes_written,
                phase="complete",
            ))

        # Drop the .tmp dir once every artifact landed.
        shutil.rmtree(tmp, ignore_errors=True)

        # Build the FTS5 address index if the PBF is on disk and the
        # caller asked for it. Later chunks fold PMTiles + Valhalla
        # builds in alongside this step.
        if need_pbf and state.pbf_installed:
            await _build_geocoder_step(region_id, state, _emit, cancel_event)

        state.installed_at = datetime.now(timezone.utc).isoformat()
        upsert_state(state)

        await _emit(MapInstallProgress(
            region_id=region_id, artifact="done",
            phase="complete",
        ))
        return state

    except asyncio.CancelledError:
        log.info("install for %s cancelled", region_id)
        raise
    except Exception as exc:  # noqa: BLE001 — we surface via SSE error
        log.exception("install failed for %s", region_id)
        shutil.rmtree(tmp, ignore_errors=True)
        await _emit(MapInstallProgress(
            region_id=region_id, artifact="error",
            phase="complete", error=str(exc),
        ))
        raise


def aggregate_storage(states: Iterable[MapRegionState]) -> dict[str, int]:
    """Sum ``bytes_on_disk`` across every region, bucketed by artifact."""
    totals: dict[str, int] = {
        "street": 0, "valhalla": 0,
        "pbf": 0, "geocoder": 0,
    }
    for st in states:
        for artifact, size in st.bytes_on_disk.items():
            totals[artifact] = totals.get(artifact, 0) + int(size)
    return totals
