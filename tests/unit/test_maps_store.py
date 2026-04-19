"""Store + install-pipeline tests — offline-maps Chunk 2, maps-local-build Chunk 3.

Downloads are monkey-patched with an in-process stub that writes a
fixed payload, so these tests never hit the network and run quickly.
``install_region`` now runs the full four-phase local build pipeline
when ``need_pbf=True`` — the download-only path (``need_pbf=False``)
stays for cheap tests that only care about the network stage.
"""
from __future__ import annotations

import asyncio
import hashlib

import pytest

from lokidoki.maps import catalog, store
from lokidoki.maps.models import MapArchiveConfig, MapInstallProgress


@pytest.fixture(autouse=True)
def _tmp_data_dir(tmp_path):
    store.set_data_dir(tmp_path)
    yield
    store.set_data_dir(None)


def _patch_download(monkeypatch, payload: bytes, *, raise_cancel: bool = False):
    """Replace :func:`store._download_to` with an in-process writer.

    If ``raise_cancel`` is True the stub raises :class:`asyncio.CancelledError`
    after creating an empty file, simulating mid-flight cancellation.
    """

    async def _fake(url, dest, expected_sha256, progress_cb, cancel_event):
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(payload)
        if raise_cancel:
            raise asyncio.CancelledError()
        if expected_sha256:
            actual = hashlib.sha256(payload).hexdigest()
            if actual != expected_sha256.lower():
                try:
                    dest.unlink()
                except OSError:
                    pass
                raise ValueError(
                    f"sha256 mismatch expected {expected_sha256} got {actual}"
                )
        progress_cb(len(payload), len(payload))
        return len(payload)

    monkeypatch.setattr(store, "_download_to", _fake)


def test_load_empty():
    assert store.load_configs() == []
    assert store.load_states() == []


def test_config_round_trip():
    cfg = MapArchiveConfig(region_id="us-ct", street=True)
    store.upsert_config(cfg)
    assert store.get_config("us-ct") == cfg
    store.remove_config("us-ct")
    assert store.get_config("us-ct") is None


def test_install_region_downloads_pbf(monkeypatch):
    _patch_download(monkeypatch, payload=b"fake-pbf-bytes")

    async def _run():
        return await store.install_region(
            "us-ct",
            MapArchiveConfig(region_id="us-ct", street=True),
        )

    state = asyncio.run(_run())

    region_dir = store.region_dir("us-ct")
    assert (region_dir / "region.osm.pbf").exists()
    # .tmp must be cleaned up on success.
    assert not (region_dir / ".tmp").exists()

    assert state.pbf_installed is True
    assert state.bytes_on_disk["pbf"] == len(b"fake-pbf-bytes")


def test_install_region_sha256_mismatch_deletes_tmp(monkeypatch):
    # Catalog SHAs are empty today so verification is skipped. Simulate a
    # populated catalog by monkey-patching the region entry with a hash
    # that *won't* match our fake payload.
    original = catalog.MAP_CATALOG["us-ri"]

    bad = catalog.MapRegion(
        **{**original.__dict__, "pbf_sha256": "deadbeef" * 8},
    )
    monkeypatch.setitem(catalog.MAP_CATALOG, "us-ri", bad)

    async def _fake(url, dest, expected_sha256, progress_cb, cancel_event):
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(b"fake-payload")
        if expected_sha256:
            actual = hashlib.sha256(b"fake-payload").hexdigest()
            if actual != expected_sha256.lower():
                dest.unlink(missing_ok=True)
                raise ValueError("sha mismatch")
        return len(b"fake-payload")

    monkeypatch.setattr(store, "_download_to", _fake)

    async def _run():
        await store.install_region(
            "us-ri",
            MapArchiveConfig(region_id="us-ri", street=True),
        )

    with pytest.raises(ValueError):
        asyncio.run(_run())

    region_dir = store.region_dir("us-ri")
    # .tmp must be cleaned up, and nothing must have been installed.
    assert not (region_dir / ".tmp").exists()
    assert not (region_dir / "region.osm.pbf").exists()


def test_install_region_cancellation_cleans_tmp(monkeypatch):
    _patch_download(monkeypatch, payload=b"x", raise_cancel=True)

    async def _run():
        await store.install_region(
            "us-de",
            MapArchiveConfig(region_id="us-de", street=True),
        )

    with pytest.raises(asyncio.CancelledError):
        asyncio.run(_run())

    region_dir = store.region_dir("us-de")
    assert not (region_dir / ".tmp").exists()


def test_install_region_rejects_parent_only():
    """Continents must fail fast — they have no artifacts to fetch."""
    async def _run():
        await store.install_region(
            "na", MapArchiveConfig(region_id="na", street=True),
        )

    with pytest.raises(ValueError):
        asyncio.run(_run())


def test_install_region_rejects_empty_selection():
    async def _run():
        await store.install_region(
            "us-ct", MapArchiveConfig(region_id="us-ct"),
        )

    with pytest.raises(ValueError):
        asyncio.run(_run())


def test_aggregate_storage_buckets_by_artifact():
    from lokidoki.maps.models import MapRegionState

    a = MapRegionState(region_id="us-ct", street_installed=True,
                       bytes_on_disk={"street": 100, "valhalla": 50})
    b = MapRegionState(region_id="us-ri", street_installed=True,
                       bytes_on_disk={"street": 20, "pbf": 400})
    totals = store.aggregate_storage([a, b])
    assert totals["street"] == 120
    assert totals["valhalla"] == 50
    assert totals["pbf"] == 400


def test_cleanup_stale_tmp():
    # Force an orphaned .tmp dir under the store's maps root.
    region_dir = store.region_dir("us-ny")
    (region_dir / ".tmp").mkdir(parents=True)
    (region_dir / ".tmp" / "partial.pbf").write_bytes(b"123")
    (region_dir / "region.osm.pbf").write_bytes(b"already-installed")

    store.cleanup_stale_tmp()

    assert not (region_dir / ".tmp").exists()
    # Installed artifacts must never be touched.
    assert (region_dir / "region.osm.pbf").exists()


# ── Chunk 3: full local-build pipeline ───────────────────────────

def _drain(queue: asyncio.Queue) -> list[MapInstallProgress]:
    events: list[MapInstallProgress] = []
    while not queue.empty():
        events.append(queue.get_nowait())
    return events


def _stub_geocoder(monkeypatch) -> None:
    """Replace the pyosmium-backed geocoder build with a file-dropping stub.

    The real :func:`lokidoki.maps.geocode.fts_index.build_index` requires
    a parseable ``.osm.pbf`` and a working pyosmium install. For store-
    level tests we only care that the step runs and records a file size.
    """
    from lokidoki.maps.geocode.fts_index import IndexStats

    def _fake(pbf_path, db_path, region_id):
        db_path.write_bytes(b"fake-geocoder-db")
        return IndexStats(addresses=1, settlements=2, postcodes=3)

    monkeypatch.setattr(
        "lokidoki.maps.geocode.fts_index.build_index", _fake,
    )


def _stub_build_steps(monkeypatch) -> dict:
    """Replace ``run_planetiler`` and ``run_valhalla`` with file-drop stubs.

    Returns a dict the caller can inspect to assert the stubs were
    actually hit (a regression in the store plumbing would silently
    skip them otherwise).
    """
    calls = {"planetiler": 0, "valhalla": 0}

    async def _fake_planetiler(pbf, out_pmtiles, *, region_id, emit, cancel_event):
        calls["planetiler"] += 1
        out_pmtiles.write_bytes(b"fake-pmtiles")
        await emit(MapInstallProgress(
            region_id=region_id, artifact="street",
            bytes_done=0, bytes_total=100, phase="building_streets",
        ))
        await emit(MapInstallProgress(
            region_id=region_id, artifact="street",
            bytes_done=100, bytes_total=100, phase="ready",
        ))

    async def _fake_valhalla(pbf, out_dir, *, region_id, emit, cancel_event):
        calls["valhalla"] += 1
        out_dir.mkdir(parents=True, exist_ok=True)
        (out_dir / "tile-0.gph").write_bytes(b"fake-tile")
        await emit(MapInstallProgress(
            region_id=region_id, artifact="valhalla",
            bytes_done=0, bytes_total=10, phase="building_routing",
        ))
        await emit(MapInstallProgress(
            region_id=region_id, artifact="valhalla",
            bytes_done=10, bytes_total=10, phase="ready",
        ))

    monkeypatch.setattr(store._build, "run_planetiler", _fake_planetiler)
    monkeypatch.setattr(store._build, "run_valhalla", _fake_valhalla)
    return calls


def test_install_region_runs_local_build(monkeypatch):
    """The four phases fire in order and every artefact flag flips on success."""
    _patch_download(monkeypatch, payload=b"fake-pbf")
    _stub_geocoder(monkeypatch)
    calls = _stub_build_steps(monkeypatch)

    queue: asyncio.Queue = asyncio.Queue()

    async def _run():
        return await store.install_region(
            "us-ct",
            MapArchiveConfig(region_id="us-ct", street=True),
            queue=queue,
            need_pbf=True,
        )

    state = asyncio.run(_run())
    events = _drain(queue)
    phases = [e.phase for e in events]

    # All four top-level phases are visible in the event stream.
    assert "downloading" in phases
    assert "indexing" in phases
    assert "building_streets" in phases
    assert "building_routing" in phases
    # The install ends with a terminal "complete" event (artifact="done").
    assert events[-1].artifact == "done"
    assert events[-1].phase == "complete"

    # Stub build steps were actually invoked.
    assert calls == {"planetiler": 1, "valhalla": 1}

    # State reflects every artifact the pipeline produced.
    assert state.geocoder_installed is True
    assert state.street_installed is True
    assert state.valhalla_installed is True
    # PBF is dropped post-build by default (keeps disk bounded).
    assert state.pbf_installed is False

    region_dir = store.region_dir("us-ct")
    assert (region_dir / "streets.pmtiles").exists()
    assert (region_dir / "valhalla").is_dir()
    assert not (region_dir / "region.osm.pbf").exists()


def test_install_region_planetiler_failure_cleans_partial(monkeypatch):
    """A planetiler failure surfaces as an error event and leaves no half-file."""
    _patch_download(monkeypatch, payload=b"fake-pbf")
    _stub_geocoder(monkeypatch)

    async def _boom(pbf, out_pmtiles, *, region_id, emit, cancel_event):
        # The real wrapper would clean its own .partial file; simulate
        # that and raise the same way.
        raise store._build.BuildFailed("planetiler failed (exit 3): oom-ish")

    async def _unreachable(*args, **kwargs):
        raise AssertionError("valhalla must not run after a streets failure")

    monkeypatch.setattr(store._build, "run_planetiler", _boom)
    monkeypatch.setattr(store._build, "run_valhalla", _unreachable)

    queue: asyncio.Queue = asyncio.Queue()

    async def _run():
        await store.install_region(
            "us-ri",
            MapArchiveConfig(region_id="us-ri", street=True),
            queue=queue,
            need_pbf=True,
        )

    with pytest.raises(store._build.BuildFailed):
        asyncio.run(_run())

    events = _drain(queue)
    terminal = events[-1]
    assert terminal.artifact == "error"
    assert terminal.phase == "complete"
    assert "planetiler" in (terminal.error or "")

    region_dir = store.region_dir("us-ri")
    assert not (region_dir / "streets.pmtiles").exists()
    assert not (region_dir / "valhalla").exists()


def test_install_region_toolchain_missing_surfaces_code(monkeypatch):
    """Missing binary maps onto the ``toolchain_missing`` error code."""
    _patch_download(monkeypatch, payload=b"fake-pbf")
    _stub_geocoder(monkeypatch)

    async def _missing(*args, **kwargs):
        raise store._build.ToolchainMissing(
            "planetiler not available — re-run ./run.sh --maps-tools-only",
        )

    monkeypatch.setattr(store._build, "run_planetiler", _missing)

    queue: asyncio.Queue = asyncio.Queue()

    async def _run():
        await store.install_region(
            "us-de",
            MapArchiveConfig(region_id="us-de", street=True),
            queue=queue,
            need_pbf=True,
        )

    with pytest.raises(store._build.ToolchainMissing):
        asyncio.run(_run())

    events = _drain(queue)
    assert events[-1].error == "toolchain_missing"


def test_install_region_oom_surfaces_code(monkeypatch):
    """OOM errors get the dedicated ``out_of_memory`` code."""
    _patch_download(monkeypatch, payload=b"fake-pbf")
    _stub_geocoder(monkeypatch)

    async def _oom(*args, **kwargs):
        raise store._build.BuildOutOfMemory("killed by OS")

    monkeypatch.setattr(store._build, "run_planetiler", _oom)

    queue: asyncio.Queue = asyncio.Queue()

    async def _run():
        await store.install_region(
            "us-nh",
            MapArchiveConfig(region_id="us-nh", street=True),
            queue=queue,
            need_pbf=True,
        )

    with pytest.raises(store._build.BuildOutOfMemory):
        asyncio.run(_run())

    events = _drain(queue)
    assert events[-1].error == "out_of_memory"


def test_install_region_keeps_pbf_when_env_set(monkeypatch):
    """``LOKIDOKI_KEEP_PBF=1`` preserves the source file for rebuilds."""
    monkeypatch.setenv("LOKIDOKI_KEEP_PBF", "1")
    _patch_download(monkeypatch, payload=b"fake-pbf")
    _stub_geocoder(monkeypatch)
    _stub_build_steps(monkeypatch)

    async def _run():
        return await store.install_region(
            "us-vt",
            MapArchiveConfig(region_id="us-vt", street=True),
            need_pbf=True,
        )

    state = asyncio.run(_run())

    region_dir = store.region_dir("us-vt")
    assert (region_dir / "region.osm.pbf").exists()
    assert state.pbf_installed is True
