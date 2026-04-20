"""OpenAddresses integration points in the maps install pipeline."""
from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from lokidoki.maps import store
from lokidoki.maps.models import MapArchiveConfig


@pytest.fixture(autouse=True)
def _tmp_data_dir(tmp_path: Path):
    store.set_data_dir(tmp_path)
    yield
    store.set_data_dir(None)


def _patch_download(monkeypatch: pytest.MonkeyPatch, payload: bytes) -> None:
    async def _fake(url, dest, expected_sha256, progress_cb, cancel_event):  # noqa: ANN001
        del url, expected_sha256, cancel_event
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(payload)
        progress_cb(len(payload), len(payload))
        return len(payload)

    monkeypatch.setattr(store, "_download_to", _fake)


def _stub_local_builds(monkeypatch: pytest.MonkeyPatch) -> None:
    async def _fake_geocoder(region_id, state, emit, cancel_event):  # noqa: ANN001
        del cancel_event
        state.geocoder_installed = True
        state.bytes_on_disk["geocoder"] = 9
        await emit(store.MapInstallProgress(
            region_id=region_id,
            artifact="geocoder",
            phase="building_geocoder",
        ))
        await emit(store.MapInstallProgress(
            region_id=region_id,
            artifact="geocoder",
            bytes_done=9,
            bytes_total=9,
            phase="ready",
        ))

    async def _fake_streets(pbf, out_pmtiles, *, region_id, emit, cancel_event):  # noqa: ANN001
        del pbf, cancel_event
        out_pmtiles.write_bytes(b"pmtiles")
        await emit(store.MapInstallProgress(
            region_id=region_id,
            artifact="street",
            phase="building_streets",
        ))
        await emit(store.MapInstallProgress(
            region_id=region_id,
            artifact="street",
            bytes_done=7,
            bytes_total=7,
            phase="ready",
        ))

    async def _fake_graphhopper(pbf, out_dir, *, region_id, emit, cancel_event):  # noqa: ANN001
        del pbf, cancel_event
        out_dir.mkdir(parents=True, exist_ok=True)
        (out_dir / "graph-cache").write_bytes(b"routing")
        await emit(store.MapInstallProgress(
            region_id=region_id,
            artifact="valhalla",
            phase="building_routing",
        ))
        await emit(store.MapInstallProgress(
            region_id=region_id,
            artifact="valhalla",
            bytes_done=7,
            bytes_total=7,
            phase="ready",
        ))

    monkeypatch.setattr(store, "_build_geocoder_step", _fake_geocoder)
    monkeypatch.setattr(store._build, "run_planetiler", _fake_streets)
    monkeypatch.setattr(store._build, "run_graphhopper_import", _fake_graphhopper)


def test_install_region_downloads_openaddresses_and_emits_phases(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _patch_download(monkeypatch, b"fake-pbf")
    _stub_local_builds(monkeypatch)

    oa_bytes = b"PK\x03\x04openaddresses"

    async def _fake_oa(region_id, ctx):  # noqa: ANN001
        path = ctx.data_dir / "maps" / region_id / "us-ct.openaddresses.zip"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(oa_bytes)
        return path

    monkeypatch.setattr(
        "lokidoki.maps.store.ensure_openaddresses_for",
        _fake_oa,
    )
    monkeypatch.setattr(
        "lokidoki.maps.store.OPENADDRESSES_REGIONS",
        {
            "us-ct": {
                "url": "https://example.test/us-ct.zip",
                "sha256": "a" * 64,
                "size_bytes": len(oa_bytes),
                "filename": "us-ct.openaddresses.zip",
            }
        },
    )

    queue: asyncio.Queue = asyncio.Queue()

    async def _run():
        return await store.install_region(
            "us-ct",
            MapArchiveConfig(region_id="us-ct", street=True),
            queue=queue,
            need_pbf=True,
        )

    state = asyncio.run(_run())
    events = []
    while not queue.empty():
        events.append(queue.get_nowait())

    oa_events = [
        (event.artifact, event.phase)
        for event in events
        if event.artifact == "openaddresses"
    ]
    assert oa_events == [
        ("openaddresses", "downloading_openaddresses"),
        ("openaddresses", "ready"),
    ]
    assert state.openaddresses_installed is True
    assert state.bytes_on_disk["openaddresses"] == len(oa_bytes)
