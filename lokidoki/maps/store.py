"""Map region config/state persistence + region install pipeline.

Two JSON files under the data directory:

  - ``maps_config.json`` — per-region admin selection.
  - ``maps_state.json``  — per-region on-disk reality (artifact flags + bytes).

``install_region`` is an async coroutine that runs the full four-phase
local build pipeline for a region:

  1. ``downloading_pbf``    — stream the Geofabrik ``.osm.pbf`` onto disk.
  2. ``building_geocoder``  — build the FTS5 address index (runs first
     after the download so search is usable while the heavier builds
     are still going).
  3. ``building_streets``   — shell out to ``planetiler`` and produce
     ``streets.pmtiles``.
  4. ``building_routing``   — shell out to GraphHopper import and
     produce the local routing graph.

Every phase emits :class:`MapInstallProgress` events on an
:class:`asyncio.Queue` drained by the SSE endpoint, every phase is
cancellable, and any partial on-disk state is cleaned up on failure so
the final ``data/maps/<region>/`` tree never contains a half-built
artifact.

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

from lokidoki.bootstrap.context import StepContext
from lokidoki.bootstrap.preflight.openaddresses import ensure_openaddresses_for
from lokidoki.bootstrap.versions import OPENADDRESSES_REGIONS

from . import build as _build
from .catalog import MapRegion, get_region
from .models import MapArchiveConfig, MapInstallProgress, MapRegionState

log = logging.getLogger(__name__)

_DATA_DIR: Path | None = None
_CHUNK_SIZE = 1024 * 1024  # 1 MB download chunks
_USER_AGENT = "LokiDoki/0.1 (offline-maps)"

# After the full local build lands, the source .osm.pbf is many times
# larger than the artifacts we produced from it. Delete it by default
# to reclaim disk; keep it with LOKIDOKI_KEEP_PBF=1 so developers can
# rebuild without re-downloading.
_KEEP_PBF_ENV = "LOKIDOKI_KEEP_PBF"


def _keep_pbf() -> bool:
    """Return True if the source .osm.pbf should be retained post-build."""
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
        "street": d / "streets.pmtiles",
        "valhalla": d / "valhalla",
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


def _sha256_of(path: Path) -> str:
    hasher = hashlib.sha256()
    with path.open("rb") as fh:
        while chunk := fh.read(_CHUNK_SIZE):
            hasher.update(chunk)
    return hasher.hexdigest()


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
    if expected_sha256 and dest.exists():
        try:
            existing = _sha256_of(dest)
        except OSError:
            existing = ""
        if existing.lower() == expected_sha256.lower():
            size = dest.stat().st_size
            progress_cb(size, size)
            return size
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
    Emits ``{artifact: "geocoder", phase: "building_geocoder"|"ready"}``
    events so the admin-panel SSE stream surfaces progress. During the
    build, ``bytes_done`` is repurposed as "rows indexed so far". The
    PBF is left on disk for subsequent phases; :func:`install_region`
    drops it at the end of the pipeline.
    """
    from .geocode.fts_index import build_index, region_db_path
    from .geocode.oa_ingest import ingest_openaddresses

    pbf_path = _final_path_for(region_id, "pbf")
    if not pbf_path.exists():
        return

    db_path = region_db_path(_data_dir(), region_id)

    await emit(MapInstallProgress(
        region_id=region_id, artifact="geocoder",
        bytes_done=0, bytes_total=0,
        phase="building_geocoder",
    ))

    def _progress(rows_written: int, phase: str) -> None:
        if phase != "indexing":
            return
        loop.call_soon_threadsafe(
            asyncio.create_task,
            emit(MapInstallProgress(
                region_id=region_id,
                artifact="geocoder",
                bytes_done=rows_written,
                bytes_total=0,
                phase="building_geocoder",
            )),
        )

    def _oa_path() -> Path | None:
        pin = OPENADDRESSES_REGIONS.get(region_id)
        if pin is not None:
            candidate = region_dir(region_id) / str(pin["filename"])
            if candidate.exists():
                return candidate
        generic = region_dir(region_id) / "openaddresses.zip"
        if generic.exists():
            return generic
        return None

    def _run() -> int:
        stats = build_index(
            pbf_path, db_path, region_id,
            progress_cb=_progress,
        )
        total_rows = stats.total
        oa_zip = _oa_path()
        if oa_zip is None:
            return total_rows

        def _oa_progress(rows_written: int, phase: str) -> None:
            if phase != "indexing":
                return
            loop.call_soon_threadsafe(
                asyncio.create_task,
                emit(MapInstallProgress(
                    region_id=region_id,
                    artifact="geocoder",
                    bytes_done=rows_written,
                    bytes_total=0,
                    phase="building_geocoder_oa",
                )),
            )

        loop.call_soon_threadsafe(
            asyncio.create_task,
            emit(MapInstallProgress(
                region_id=region_id,
                artifact="geocoder",
                bytes_done=0,
                bytes_total=0,
                phase="building_geocoder_oa",
            )),
        )
        total_rows += ingest_openaddresses(
            oa_zip,
            db_path,
            region_id,
            progress_cb=_oa_progress,
        ).rows
        return total_rows

    loop = asyncio.get_event_loop()
    try:
        total_rows = await loop.run_in_executor(None, _run)
    except Exception:
        log.exception("geocoder build failed for %s", region_id)
        raise

    if cancel_event.is_set():
        raise asyncio.CancelledError()

    state.geocoder_installed = True
    state.bytes_on_disk["geocoder"] = db_path.stat().st_size

    await emit(MapInstallProgress(
        region_id=region_id, artifact="geocoder",
        bytes_done=total_rows, bytes_total=total_rows,
        phase="ready",
    ))


async def _build_streets_step(
    region_id: str,
    state: MapRegionState,
    emit,
    cancel_event: asyncio.Event,
) -> None:
    """Run planetiler to produce ``streets.pmtiles`` from the PBF on disk.

    On success, flips ``state.street_installed`` and records the file
    size. On failure / cancellation, :func:`lokidoki.maps.build.run_planetiler`
    cleans its scratch file; this helper re-raises so the outer
    try/except in :func:`install_region` can emit the terminal event.
    """
    pbf_path = _final_path_for(region_id, "pbf")
    out = _final_path_for(region_id, "street")
    await _build.run_planetiler(
        pbf_path, out,
        region_id=region_id, emit=emit, cancel_event=cancel_event,
    )
    state.street_installed = True
    state.bytes_on_disk["street"] = out.stat().st_size


async def _build_graphhopper_step(
    region_id: str,
    state: MapRegionState,
    emit,
    cancel_event: asyncio.Event,
) -> None:
    """Run GraphHopper import to produce the routing graph cache.

    On success, flips ``state.valhalla_installed`` and records the
    recursive byte size of the routing directory.
    """
    pbf_path = _final_path_for(region_id, "pbf")
    out_dir = _final_path_for(region_id, "valhalla")
    await _build.run_graphhopper_import(
        pbf_path, out_dir,
        region_id=region_id, emit=emit, cancel_event=cancel_event,
    )
    total = 0
    for path in out_dir.rglob("*"):
        if path.is_file():
            total += path.stat().st_size
    state.valhalla_installed = True
    state.bytes_on_disk["valhalla"] = total


async def _download_openaddresses_step(
    region_id: str,
    state: MapRegionState,
    emit,
    cancel_event: asyncio.Event,
) -> None:
    """Download the pinned OpenAddresses ZIP for ``region_id`` if configured."""
    if cancel_event.is_set():
        raise asyncio.CancelledError()
    if region_id not in OPENADDRESSES_REGIONS:
        return

    await emit(MapInstallProgress(
        region_id=region_id,
        artifact="openaddresses",
        phase="downloading_openaddresses",
    ))

    ctx = StepContext(
        data_dir=_data_dir(),
        profile="maps-install",
        arch="unknown",
        os_name="Linux",
        emit=lambda _event: None,
    )
    path = await ensure_openaddresses_for(region_id, ctx)
    if cancel_event.is_set():
        raise asyncio.CancelledError()

    state.openaddresses_installed = True
    state.bytes_on_disk["openaddresses"] = path.stat().st_size
    await emit(MapInstallProgress(
        region_id=region_id,
        artifact="openaddresses",
        bytes_done=path.stat().st_size,
        bytes_total=path.stat().st_size,
        phase="ready",
    ))


def _cleanup_partial_artifacts(region_id: str, state: MapRegionState) -> None:
    """Remove any half-written streets/routing outputs.

    Called from the error / cancel path so a failed install never
    leaves the impression in ``data/maps/<region>/`` that an artifact
    is ready. ``state`` is mutated so subsequent callers (SSE error
    event, caller's state inspection) see a consistent story.
    """
    street = _final_path_for(region_id, "street")
    if street.exists() and not state.street_installed:
        try:
            street.unlink()
        except OSError:
            pass
    # planetiler's own scratch file.
    scratch_street = street.with_name(f"{street.stem}.partial{street.suffix}")
    if scratch_street.exists():
        try:
            scratch_street.unlink()
        except OSError:
            pass

    valhalla = _final_path_for(region_id, "valhalla")
    if valhalla.exists() and not state.valhalla_installed:
        shutil.rmtree(valhalla, ignore_errors=True)
    scratch_valhalla = valhalla.with_suffix(".partial")
    if scratch_valhalla.exists():
        shutil.rmtree(scratch_valhalla, ignore_errors=True)
    scratch_valhalla_json = valhalla.parent / f"{valhalla.name}.partial.json"
    if scratch_valhalla_json.exists():
        try:
            scratch_valhalla_json.unlink()
        except OSError:
            pass


def _error_code(exc: BaseException) -> str:
    """Map a raised exception onto the string the admin UI surfaces.

    Kept narrow on purpose: the UI branches on three codes, everything
    else is ``<tool> failed: <last-stderr-line>`` verbatim.
    """
    if isinstance(exc, _build.ToolchainMissing):
        return "toolchain_missing"
    if isinstance(exc, _build.BuildOutOfMemory):
        return "out_of_memory"
    return str(exc)


async def install_region(
    region_id: str,
    config: MapArchiveConfig,
    queue: "asyncio.Queue[MapInstallProgress] | None" = None,
    cancel_event: asyncio.Event | None = None,
    need_pbf: bool = False,
) -> MapRegionState:
    """Run the four-phase local install pipeline for ``region_id``.

    Phase 1 (``downloading_pbf``) always runs. Phases 2–4 (geocoder,
    planetiler, routing) only run when ``need_pbf`` is True — that
    keeps the PBF-only test harness cheap while letting the API
    caller opt into the full build.

    Emits one :class:`MapInstallProgress` per phase transition on
    ``queue``. On any failure the ``.tmp/`` dir is wiped, any
    partially-written final artifacts are removed, and a terminal
    ``{artifact: "error", phase: "complete", error: <code>}`` event is
    emitted before the exception re-raises. ``cancel_event`` honours
    cancellation between phases and inside each build subprocess.
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
        if queue is None:
            return
        try:
            queue.put_nowait(progress)
        except asyncio.QueueFull:
            log.warning(
                "progress queue full for %s; dropping %s/%s event",
                region_id, progress.artifact, progress.phase,
            )

    plan = _artifact_plan(region, config)

    tmp = _tmp_dir(region_id)
    tmp.mkdir(parents=True, exist_ok=True)

    state = get_state(region_id) or MapRegionState(region_id=region_id)

    try:
        # ── Phase 1: downloading_pbf ────────────────────────────
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

            bytes_written = await _download_to(
                url, tmp_path, sha, _cb, cancel_event,
            )

            await _emit(MapInstallProgress(
                region_id=region_id, artifact=artifact,
                bytes_done=bytes_written, bytes_total=bytes_written,
                phase="verifying",
            ))

            final.parent.mkdir(parents=True, exist_ok=True)
            os.replace(tmp_path, final)

            setattr(state, f"{artifact}_installed", True)
            state.bytes_on_disk[artifact] = bytes_written

        shutil.rmtree(tmp, ignore_errors=True)

        # ── Phases 2–4: local builds on top of the PBF ──────────
        if need_pbf and state.pbf_installed:
            if cancel_event.is_set():
                raise asyncio.CancelledError()
            await _build_geocoder_step(region_id, state, _emit, cancel_event)

            if region_id.startswith("us-") and region_id in OPENADDRESSES_REGIONS:
                if cancel_event.is_set():
                    raise asyncio.CancelledError()
                try:
                    await _download_openaddresses_step(
                        region_id, state, _emit, cancel_event,
                    )
                except Exception:  # noqa: BLE001 - OA is additive only
                    log.exception(
                        "openaddresses download failed for %s; continuing",
                        region_id,
                    )

            if cancel_event.is_set():
                raise asyncio.CancelledError()
            await _build_streets_step(region_id, state, _emit, cancel_event)

            if cancel_event.is_set():
                raise asyncio.CancelledError()
            await _build_graphhopper_step(region_id, state, _emit, cancel_event)

            # Drop the source PBF unless the dev override says to keep it.
            pbf_path = _final_path_for(region_id, "pbf")
            if not _keep_pbf() and pbf_path.exists():
                pbf_path.unlink()
                state.pbf_installed = False
                state.bytes_on_disk.pop("pbf", None)

        state.installed_at = datetime.now(timezone.utc).isoformat()
        upsert_state(state)

        await _emit(MapInstallProgress(
            region_id=region_id, artifact="done",
            phase="complete",
        ))
        return state

    except asyncio.CancelledError:
        log.info("install for %s cancelled", region_id)
        shutil.rmtree(tmp, ignore_errors=True)
        _cleanup_partial_artifacts(region_id, state)
        await _emit(MapInstallProgress(
            region_id=region_id, artifact="cancelled",
            phase="complete", error="cancelled",
        ))
        raise
    except Exception as exc:  # noqa: BLE001 — we surface via SSE error
        log.exception("install failed for %s", region_id)
        shutil.rmtree(tmp, ignore_errors=True)
        _cleanup_partial_artifacts(region_id, state)
        await _emit(MapInstallProgress(
            region_id=region_id, artifact="error",
            phase="complete", error=_error_code(exc),
        ))
        raise


def aggregate_storage(states: Iterable[MapRegionState]) -> dict[str, int]:
    """Sum ``bytes_on_disk`` across every region, bucketed by artifact."""
    totals: dict[str, int] = {
        "street": 0, "valhalla": 0,
        "pbf": 0, "geocoder": 0,
        "openaddresses": 0,
    }
    for st in states:
        for artifact, size in st.bytes_on_disk.items():
            totals[artifact] = totals.get(artifact, 0) + int(size)
    return totals
