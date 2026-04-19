"""Store + install-pipeline tests — offline-maps Chunk 2, maps-local-build Chunk 2.

Downloads are monkey-patched with an in-process stub that writes a
fixed payload, so these tests never hit the network and run quickly.
After the maps-local-build switch the install pipeline is PBF-only —
every other artefact is produced by the local build steps added in
later chunks.
"""
from __future__ import annotations

import asyncio
import hashlib

import pytest

from lokidoki.maps import catalog, store
from lokidoki.maps.models import MapArchiveConfig


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
