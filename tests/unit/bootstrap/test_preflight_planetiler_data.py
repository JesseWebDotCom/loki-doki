"""``ensure_planetiler_data`` pre-seeds Natural Earth + OSM water polygons.

Confirms both archives land at ``planetiler_sources`` with their pinned
sha256 verified. Network is fully mocked — no real download — and the
test inspects the ``ctx.download`` call list to verify each fetch passes
its corresponding pin.
"""
from __future__ import annotations

import asyncio
import hashlib
from pathlib import Path

import pytest

from lokidoki.bootstrap.context import StepContext
from lokidoki.bootstrap.events import Event
from lokidoki.bootstrap.preflight.planetiler_data import ensure_planetiler_data
from lokidoki.bootstrap.versions import NATURAL_EARTH, OSM_WATER_POLYGONS


def _ctx(tmp_path: Path, events: list[Event]) -> StepContext:
    return StepContext(
        data_dir=tmp_path,
        profile="mac",
        arch="arm64",
        os_name="Darwin",
        emit=events.append,
    )


def _patch_pins(monkeypatch: pytest.MonkeyPatch, ne: bytes, wp: bytes) -> tuple[str, str]:
    ne_sha = hashlib.sha256(ne).hexdigest()
    wp_sha = hashlib.sha256(wp).hexdigest()
    patched_ne = dict(NATURAL_EARTH)
    patched_ne["sha256"] = ne_sha
    patched_wp = dict(OSM_WATER_POLYGONS)
    patched_wp["sha256"] = wp_sha
    monkeypatch.setattr(
        "lokidoki.bootstrap.preflight.planetiler_data.NATURAL_EARTH", patched_ne
    )
    monkeypatch.setattr(
        "lokidoki.bootstrap.preflight.planetiler_data.OSM_WATER_POLYGONS", patched_wp
    )
    return ne_sha, wp_sha


def test_ensure_planetiler_data_downloads_both_archives(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    ne_payload = b"fake-natural-earth-sqlite-zip"
    wp_payload = b"fake-water-polygons-zip"
    ne_sha, wp_sha = _patch_pins(monkeypatch, ne_payload, wp_payload)

    download_calls: list[tuple] = []

    async def _fake_download(self, url, dest, step_id, sha256=None):  # noqa: ANN001
        download_calls.append((url, dest, step_id, sha256))
        dest.parent.mkdir(parents=True, exist_ok=True)
        if "natural" in url:
            dest.write_bytes(ne_payload)
        else:
            dest.write_bytes(wp_payload)

    monkeypatch.setattr(StepContext, "download", _fake_download)

    events: list[Event] = []
    ctx = _ctx(tmp_path, events)
    asyncio.run(ensure_planetiler_data(ctx))

    sources = tmp_path / "tools" / "planetiler" / "sources"
    assert ctx.binary_path("planetiler_sources") == sources
    ne_file = sources / NATURAL_EARTH["filename"]
    wp_file = sources / OSM_WATER_POLYGONS["filename"]
    assert ne_file.is_file() and ne_file.stat().st_size > 0
    assert wp_file.is_file() and wp_file.stat().st_size > 0

    # Exactly two downloads, each carrying its own pinned sha256.
    assert len(download_calls) == 2
    by_dest = {dest: (url, step_id, sha) for url, dest, step_id, sha in download_calls}
    assert by_dest[ne_file] == (
        NATURAL_EARTH["url_template"].format(filename=NATURAL_EARTH["filename"]),
        "install-planetiler-data",
        ne_sha,
    )
    assert by_dest[wp_file] == (
        OSM_WATER_POLYGONS["url_template"].format(filename=OSM_WATER_POLYGONS["filename"]),
        "install-planetiler-data",
        wp_sha,
    )


def test_ensure_planetiler_data_skips_when_present(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    sources = tmp_path / "tools" / "planetiler" / "sources"
    sources.mkdir(parents=True, exist_ok=True)
    (sources / NATURAL_EARTH["filename"]).write_bytes(b"\x00\x01\x02")
    (sources / OSM_WATER_POLYGONS["filename"]).write_bytes(b"\x03\x04\x05")

    download_calls: list[tuple] = []

    async def _fake_download(self, url, dest, step_id, sha256=None):  # noqa: ANN001
        download_calls.append((url, dest, step_id, sha256))

    monkeypatch.setattr(StepContext, "download", _fake_download)

    events: list[Event] = []
    ctx = _ctx(tmp_path, events)
    asyncio.run(ensure_planetiler_data(ctx))

    assert download_calls == []


def test_ensure_planetiler_data_only_downloads_missing_archive(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # One archive is present, the other must still be fetched.
    sources = tmp_path / "tools" / "planetiler" / "sources"
    sources.mkdir(parents=True, exist_ok=True)
    (sources / NATURAL_EARTH["filename"]).write_bytes(b"\x00\x01\x02")

    wp_payload = b"fake-water-polygons-zip"
    _patch_pins(monkeypatch, b"unused", wp_payload)

    download_calls: list[tuple] = []

    async def _fake_download(self, url, dest, step_id, sha256=None):  # noqa: ANN001
        download_calls.append((url, dest, step_id, sha256))
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(wp_payload)

    monkeypatch.setattr(StepContext, "download", _fake_download)

    events: list[Event] = []
    ctx = _ctx(tmp_path, events)
    asyncio.run(ensure_planetiler_data(ctx))

    assert len(download_calls) == 1
    url, dest, step_id, _sha = download_calls[0]
    assert dest == sources / OSM_WATER_POLYGONS["filename"]
    assert step_id == "install-planetiler-data"
    assert "water-polygons" in url
