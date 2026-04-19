"""``ensure_world_overview`` builds the global z0–z7 basemap.

All four shapes are exercised against a fully-mocked ``StepContext``
— no real planetiler run, no real download:

* Happy path: Monaco is fetched with the pinned sha, planetiler is
  invoked with ``--maxzoom=7`` and explicit per-file source paths, and
  the output is large enough to pass the smoke test.
* Skip-when-present: an existing ``world-overview.pmtiles`` above the
  skip threshold short-circuits the build — no download, no subprocess.
* Tiny-output-fails: when the planetiler run leaves a suspiciously
  small file, the preflight raises and removes the partial so the
  next run retries cleanly.
* Command-shape: the combined-source build never passes ``--download``
  (the offline-hardening rule), and every source-path arg points at
  the pre-seeded ``planetiler_sources`` directory.
"""
from __future__ import annotations

import asyncio
import hashlib
from pathlib import Path

import pytest

from lokidoki.bootstrap.context import StepContext
from lokidoki.bootstrap.events import Event
from lokidoki.bootstrap.preflight.world_overview import (
    _SMOKE_MIN_BYTES,
    ensure_world_overview,
)
from lokidoki.bootstrap.versions import (
    MONACO_PBF,
    NATURAL_EARTH,
    OSM_WATER_POLYGONS,
)


def _ctx(tmp_path: Path, events: list[Event]) -> StepContext:
    return StepContext(
        data_dir=tmp_path,
        profile="mac",
        arch="arm64",
        os_name="Darwin",
        emit=events.append,
    )


def _seed_upstream_artifacts(tmp_path: Path) -> tuple[Path, Path, Path, Path]:
    """Create the java binary + planetiler jar + NE / WP source files.

    Mirrors the on-disk layout earlier preflights leave behind. Returns
    ``(java_bin, jar_path, sources_dir, out_pmtiles)`` for assertions.
    """
    java_bin = tmp_path / "tools" / "jre" / "bin" / "java"
    java_bin.parent.mkdir(parents=True, exist_ok=True)
    java_bin.write_text("#!/bin/sh\nexit 0\n")
    java_bin.chmod(0o755)

    jar_path = tmp_path / "tools" / "planetiler" / "planetiler.jar"
    jar_path.parent.mkdir(parents=True, exist_ok=True)
    jar_path.write_bytes(b"fake-jar")

    sources_dir = tmp_path / "tools" / "planetiler" / "sources"
    sources_dir.mkdir(parents=True, exist_ok=True)
    (sources_dir / NATURAL_EARTH["filename"]).write_bytes(b"\x00\x01\x02")
    (sources_dir / OSM_WATER_POLYGONS["filename"]).write_bytes(b"\x03\x04\x05")

    out_pmtiles = tmp_path / "tools" / "planetiler" / "world-overview.pmtiles"
    return java_bin, jar_path, sources_dir, out_pmtiles


def test_happy_path_downloads_monaco_and_runs_planetiler(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    java_bin, jar_path, sources_dir, out_pmtiles = _seed_upstream_artifacts(
        tmp_path
    )

    monaco_payload = b"fake-monaco-pbf-bytes"
    monaco_sha = hashlib.sha256(monaco_payload).hexdigest()
    patched_monaco = dict(MONACO_PBF)
    patched_monaco["sha256"] = monaco_sha
    monkeypatch.setattr(
        "lokidoki.bootstrap.preflight.world_overview.MONACO_PBF", patched_monaco
    )

    download_calls: list[tuple] = []

    async def _fake_download(self, url, dest, step_id, sha256=None):  # noqa: ANN001
        download_calls.append((url, dest, step_id, sha256))
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(monaco_payload)

    seen_cmds: list[list[str]] = []

    async def _fake_run_streamed(self, cmd, step_id, cwd=None, env=None):  # noqa: ANN001
        seen_cmds.append(list(cmd))
        # Simulate planetiler producing a healthy pmtiles at the
        # ``--output=`` path (the partial scratch file).
        scratch = Path([a for a in cmd if a.startswith("--output=")][0].split("=", 1)[1])
        scratch.parent.mkdir(parents=True, exist_ok=True)
        scratch.write_bytes(b"X" * (_SMOKE_MIN_BYTES + 1))
        return 0

    monkeypatch.setattr(StepContext, "download", _fake_download)
    monkeypatch.setattr(StepContext, "run_streamed", _fake_run_streamed)

    events: list[Event] = []
    ctx = _ctx(tmp_path, events)
    asyncio.run(ensure_world_overview(ctx))

    # Monaco pbf landed with the pinned sha.
    monaco_path = sources_dir / MONACO_PBF["filename"]
    assert len(download_calls) == 1
    dl_url, dl_dest, dl_step, dl_sha = download_calls[0]
    assert dl_dest == monaco_path
    assert dl_step == "build-world-overview"
    assert dl_sha == monaco_sha
    assert dl_url == MONACO_PBF["url_template"].format(
        filename=MONACO_PBF["filename"]
    )

    # Planetiler ran once with --maxzoom=7 and explicit source paths.
    assert len(seen_cmds) == 1
    cmd = seen_cmds[0]
    assert cmd[0] == str(java_bin)
    assert "-jar" in cmd and str(jar_path) in cmd
    assert f"--osm-path={monaco_path}" in cmd
    ne = sources_dir / NATURAL_EARTH["filename"]
    wp = sources_dir / OSM_WATER_POLYGONS["filename"]
    assert f"--natural_earth_path={ne}" in cmd
    assert f"--water_polygons_path={wp}" in cmd
    assert "--maxzoom=7" in cmd
    assert any(a.startswith(f"--output=") and "world-overview" in a for a in cmd)

    # Final atomic rename landed the pmtiles.
    assert out_pmtiles.is_file()
    assert out_pmtiles.stat().st_size >= _SMOKE_MIN_BYTES


def test_skip_when_present_above_threshold(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _, _, _, out_pmtiles = _seed_upstream_artifacts(tmp_path)
    out_pmtiles.write_bytes(b"Z" * (2 * 1024 * 1024))  # > 1 MB skip threshold

    download_calls: list[tuple] = []
    seen_cmds: list[list[str]] = []

    async def _fake_download(self, url, dest, step_id, sha256=None):  # noqa: ANN001
        download_calls.append((url, dest, step_id, sha256))

    async def _fake_run_streamed(self, cmd, step_id, cwd=None, env=None):  # noqa: ANN001
        seen_cmds.append(list(cmd))
        return 0

    monkeypatch.setattr(StepContext, "download", _fake_download)
    monkeypatch.setattr(StepContext, "run_streamed", _fake_run_streamed)

    events: list[Event] = []
    ctx = _ctx(tmp_path, events)
    asyncio.run(ensure_world_overview(ctx))

    assert download_calls == []
    assert seen_cmds == []


def test_tiny_output_is_treated_as_corrupt(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _, _, _, out_pmtiles = _seed_upstream_artifacts(tmp_path)

    # Pre-seed Monaco so the download step is skipped — keeps the test
    # focused on the post-build smoke guard.
    sources_dir = tmp_path / "tools" / "planetiler" / "sources"
    (sources_dir / MONACO_PBF["filename"]).write_bytes(b"seeded-monaco")

    async def _fake_download(self, url, dest, step_id, sha256=None):  # noqa: ANN001
        raise AssertionError("download should not run when monaco is seeded")

    async def _fake_run_streamed(self, cmd, step_id, cwd=None, env=None):  # noqa: ANN001
        # Planetiler "succeeds" but leaves a tiny scratch — simulate a
        # truncated / aborted build.
        scratch = Path([a for a in cmd if a.startswith("--output=")][0].split("=", 1)[1])
        scratch.parent.mkdir(parents=True, exist_ok=True)
        scratch.write_bytes(b"tiny")
        return 0

    monkeypatch.setattr(StepContext, "download", _fake_download)
    monkeypatch.setattr(StepContext, "run_streamed", _fake_run_streamed)

    events: list[Event] = []
    ctx = _ctx(tmp_path, events)
    with pytest.raises(RuntimeError, match="suspiciously small"):
        asyncio.run(ensure_world_overview(ctx))

    # Partial must have been removed, final must not exist.
    scratch = out_pmtiles.with_name(
        f"{out_pmtiles.stem}.partial{out_pmtiles.suffix}"
    )
    assert not scratch.exists()
    assert not out_pmtiles.exists()


def test_command_never_contains_download_flag(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Offline-hardening rule: the world-overview preflight must never
    # ask planetiler to fetch anything from upstream. Belt-and-braces
    # check on the emitted command, mirroring the audit in the
    # offline-hardening chunk 2 tests.
    _seed_upstream_artifacts(tmp_path)

    sources_dir = tmp_path / "tools" / "planetiler" / "sources"
    (sources_dir / MONACO_PBF["filename"]).write_bytes(b"seeded-monaco")

    seen_cmds: list[list[str]] = []

    async def _fake_download(self, url, dest, step_id, sha256=None):  # noqa: ANN001
        raise AssertionError("download should not run when monaco is seeded")

    async def _fake_run_streamed(self, cmd, step_id, cwd=None, env=None):  # noqa: ANN001
        seen_cmds.append(list(cmd))
        scratch = Path([a for a in cmd if a.startswith("--output=")][0].split("=", 1)[1])
        scratch.parent.mkdir(parents=True, exist_ok=True)
        scratch.write_bytes(b"X" * (_SMOKE_MIN_BYTES + 1))
        return 0

    monkeypatch.setattr(StepContext, "download", _fake_download)
    monkeypatch.setattr(StepContext, "run_streamed", _fake_run_streamed)

    events: list[Event] = []
    ctx = _ctx(tmp_path, events)
    asyncio.run(ensure_world_overview(ctx))

    assert len(seen_cmds) == 1
    flat = " ".join(seen_cmds[0])
    assert "--download" not in flat, flat
